use anyhow::{Context, Result};
use ast_grep_language::{Language, SupportLang};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

use crate::structural_index_core::{Fact, extract_source};

const PROTOCOL: &str = "retrieval-ranker-v1";
const AUTHORITY: &str = "routing_only";

const MAX_FILES: usize = 32;
const MAX_RESULTS: usize = 32;
const MAX_QUERY_CHARS: usize = 1024;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

// Prevent a legal request from turning into 32 × 2 MiB of tokenized input.
const MAX_TOTAL_SOURCE_BYTES: usize = 8 * 1024 * 1024;

const BM25_K1: f64 = 1.2;
const RRF_K: f64 = 60.0;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    query: String,
    files: Vec<CandidateInput>,

    #[serde(default)]
    max_results: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct CandidateInput {
    file: String,

    // 1-based rank produced by the existing exact/rg retrieval channel.
    #[serde(default)]
    exact_rank: Option<usize>,
}

#[derive(Debug)]
struct Document {
    file: String,
    exact_rank: Option<usize>,
    structural_complete: bool,
    fields: Fields,
}

#[derive(Debug, Default)]
struct Fields {
    path: Vec<String>,
    symbols: Vec<String>,
    signatures: Vec<String>,
    comments: Vec<String>,
    code: Vec<String>,
    tests: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    authority: &'static str,

    query_terms: Vec<String>,

    files_requested: usize,
    files_scored: usize,
    total_source_bytes: usize,

    degraded_files: Vec<DegradedFile>,
    errors: Vec<FileError>,

    results: Vec<RankedResult>,
}

#[derive(Debug, Serialize)]
struct FileError {
    file: String,
    reason: String,
}

#[derive(Debug, Serialize)]
struct DegradedFile {
    file: String,
    reason: String,
}

#[derive(Debug, Serialize)]
struct RankedResult {
    rank: usize,
    file: String,

    rrf_score: f64,
    bm25f_score: f64,

    exact_rank: Option<usize>,
    bm25_rank: Option<usize>,

    structural_complete: bool,

    matched_terms: BTreeMap<&'static str, Vec<String>>,
}

#[derive(Clone, Copy)]
struct FieldConfig {
    weight: f64,
    b: f64,
}

// Initial generic defaults, NOT benchmark-tuned.
// Change only against a retrieval corpus.
const FIELD_CONFIGS: [(&str, FieldConfig); 6] = [
    (
        "path",
        FieldConfig {
            weight: 1.5,
            b: 0.20,
        },
    ),
    (
        "symbols",
        FieldConfig {
            weight: 3.0,
            b: 0.30,
        },
    ),
    (
        "signatures",
        FieldConfig {
            weight: 2.0,
            b: 0.50,
        },
    ),
    (
        "comments",
        FieldConfig {
            weight: 1.0,
            b: 0.75,
        },
    ),
    (
        "code",
        FieldConfig {
            weight: 0.5,
            b: 0.75,
        },
    ),
    (
        "tests",
        FieldConfig {
            weight: 2.5,
            b: 0.30,
        },
    ),
];

fn safe_rel(raw: &str) -> Option<String> {
    let path = Path::new(raw);

    if raw.is_empty() || path.is_absolute() {
        return None;
    }

    let mut parts = Vec::new();

    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let part = value.to_str()?;

                if part.is_empty() {
                    return None;
                }

                parts.push(part.to_string());
            }

            Component::CurDir => {}

            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return None;
            }
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn resolve_file(root: &Path, rel: &str) -> Result<PathBuf> {
    let path = fs::canonicalize(root.join(rel)).with_context(|| format!("cannot resolve {rel}"))?;

    anyhow::ensure!(path.starts_with(root), "path escapes project root");

    let meta = fs::metadata(&path).with_context(|| format!("cannot stat {rel}"))?;

    anyhow::ensure!(meta.is_file(), "not a regular file");

    anyhow::ensure!(
        meta.len() <= MAX_FILE_BYTES,
        "file exceeds {MAX_FILE_BYTES} bytes"
    );

    Ok(path)
}

fn push_piece(out: &mut Vec<String>, raw: &str) {
    let raw = raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '$');

    if raw.chars().count() < 2 {
        return;
    }

    let whole = raw.to_lowercase();

    let mut parts = Vec::<String>::new();
    let mut current = String::new();
    let mut previous_lowercase = false;

    for ch in raw.chars() {
        if matches!(ch, '_' | '-' | '.' | '/' | ':') {
            if !current.is_empty() {
                parts.push(current.clone());
                current.clear();
            }

            previous_lowercase = false;
            continue;
        }

        if ch.is_uppercase() && previous_lowercase && !current.is_empty() {
            parts.push(current.clone());
            current.clear();
        }

        for lower in ch.to_lowercase() {
            current.push(lower);
        }

        previous_lowercase = ch.is_lowercase();
    }

    if !current.is_empty() {
        parts.push(current);
    }

    // Preserve the whole identifier/path token once.
    out.push(whole.clone());

    // Add components only if they provide extra information.
    if parts.len() > 1 {
        for part in parts {
            if part.chars().count() >= 2 && part != whole {
                out.push(part);
            }
        }
    }
}

// IMPORTANT: no dedup here.
// BM25F requires real occurrence counts.
fn tokenize_terms(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        if ch.is_alphanumeric() || matches!(ch, '_' | '$' | '-' | '.' | '/' | ':') {
            current.push(ch);
        } else if !current.is_empty() {
            push_piece(&mut out, &current);
            current.clear();
        }
    }

    if !current.is_empty() {
        push_piece(&mut out, &current);
    }

    out
}

// A query term contributes once to BM25F; document TF remains non-deduplicated.
fn query_terms(text: &str) -> Vec<String> {
    let mut terms = tokenize_terms(text);

    terms.sort();
    terms.dedup();

    terms
}

fn append_terms(target: &mut Vec<String>, text: &str) {
    target.extend(tokenize_terms(text));
}

fn build_fields(file: &str, source: &str, facts: &[Fact]) -> Fields {
    let mut fields = Fields::default();

    append_terms(&mut fields.path, file);
    append_terms(&mut fields.code, source);

    for fact in facts {
        match fact.role {
            "declaration" => {
                if let Some(name) = fact.name.as_deref() {
                    append_terms(&mut fields.symbols, name);
                }

                if let Some(name) = fact.qualified_name.as_deref() {
                    append_terms(&mut fields.symbols, name);
                }

                append_terms(&mut fields.signatures, &fact.signature);
            }

            "test_declaration" => {
                if let Some(name) = fact.name.as_deref() {
                    append_terms(&mut fields.tests, name);
                    append_terms(&mut fields.symbols, name);
                }

                if let Some(name) = fact.qualified_name.as_deref() {
                    append_terms(&mut fields.tests, name);
                }

                append_terms(&mut fields.signatures, &fact.signature);
            }

            "test_call" => {
                if let Some(name) = fact.name.as_deref() {
                    append_terms(&mut fields.tests, name);
                }
            }

            "comment" => {
                append_terms(&mut fields.comments, &fact.signature);
            }

            _ => {}
        }
    }

    fields
}

fn field<'a>(fields: &'a Fields, name: &str) -> &'a [String] {
    match name {
        "path" => &fields.path,
        "symbols" => &fields.symbols,
        "signatures" => &fields.signatures,
        "comments" => &fields.comments,
        "code" => &fields.code,
        "tests" => &fields.tests,
        _ => &[],
    }
}

fn term_frequency(tokens: &[String], term: &str) -> usize {
    tokens.iter().filter(|token| token.as_str() == term).count()
}

fn contains_term(fields: &Fields, term: &str) -> bool {
    FIELD_CONFIGS
        .iter()
        .any(|(name, _)| field(fields, name).iter().any(|value| value == term))
}

fn average_field_lengths(docs: &[Document]) -> HashMap<&'static str, f64> {
    let mut result = HashMap::new();

    for (name, _) in FIELD_CONFIGS {
        let total = docs
            .iter()
            .map(|doc| field(&doc.fields, name).len())
            .sum::<usize>();

        result.insert(name, (total as f64 / docs.len().max(1) as f64).max(1.0));
    }

    result
}

fn bm25f_scores(docs: &[Document], query: &[String]) -> Vec<f64> {
    if docs.is_empty() || query.is_empty() {
        return vec![0.0; docs.len()];
    }

    let averages = average_field_lengths(docs);
    let document_count = docs.len() as f64;

    let mut result = vec![0.0; docs.len()];

    for term in query {
        let document_frequency = docs
            .iter()
            .filter(|doc| contains_term(&doc.fields, term))
            .count() as f64;

        if document_frequency == 0.0 {
            continue;
        }

        let idf =
            (1.0 + (document_count - document_frequency + 0.5) / (document_frequency + 0.5)).ln();

        for (doc_index, doc) in docs.iter().enumerate() {
            let mut weighted_tf = 0.0;

            for (field_name, config) in FIELD_CONFIGS {
                let tokens = field(&doc.fields, field_name);

                let tf = term_frequency(tokens, term) as f64;

                if tf == 0.0 {
                    continue;
                }

                let avg_len = *averages.get(field_name).unwrap_or(&1.0);

                let field_len = tokens.len() as f64;

                let normalization = 1.0 - config.b + config.b * (field_len / avg_len);

                weighted_tf += config.weight * tf / normalization.max(0.01);
            }

            if weighted_tf > 0.0 {
                result[doc_index] +=
                    idf * ((BM25_K1 + 1.0) * weighted_tf / (BM25_K1 + weighted_tf));
            }
        }
    }

    result
}

fn ranked_positions(docs: &[Document], scores: &[f64]) -> Vec<Option<usize>> {
    let mut order = scores
        .iter()
        .enumerate()
        .filter(|(_, score)| **score > 0.0)
        .map(|(index, score)| (index, *score))
        .collect::<Vec<_>>();

    order.sort_by(|(left_i, left_score), (right_i, right_score)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| docs[*left_i].file.cmp(&docs[*right_i].file))
    });

    let mut ranks = vec![None; docs.len()];

    for (position, (index, _)) in order.into_iter().enumerate() {
        ranks[index] = Some(position + 1);
    }

    ranks
}

fn rrf(rank: Option<usize>) -> f64 {
    match rank {
        Some(rank) => 1.0 / (RRF_K + rank as f64),
        None => 0.0,
    }
}

fn matched_terms(query: &[String], fields: &Fields) -> BTreeMap<&'static str, Vec<String>> {
    let mut result = BTreeMap::new();

    for (name, _) in FIELD_CONFIGS {
        let values = field(fields, name);

        let mut matched = query
            .iter()
            .filter(|term| values.iter().any(|value| value == *term))
            .cloned()
            .collect::<Vec<_>>();

        matched.sort();
        matched.dedup();

        if !matched.is_empty() {
            result.insert(name, matched);
        }
    }

    result
}

pub fn run_cli() -> Result<()> {
    let mut raw = String::new();

    io::stdin()
        .read_to_string(&mut raw)
        .context("failed to read stdin")?;

    let request: Request = serde_json::from_str(&raw).context("invalid request JSON")?;

    anyhow::ensure!(!request.query.trim().is_empty(), "query must not be empty");

    anyhow::ensure!(
        request.query.chars().count() <= MAX_QUERY_CHARS,
        "query exceeds {MAX_QUERY_CHARS} characters"
    );

    anyhow::ensure!(
        !request.files.is_empty() && request.files.len() <= MAX_FILES,
        "file count must be within 1..={MAX_FILES}"
    );

    let root = fs::canonicalize(&request.root).context("cannot resolve project root")?;

    anyhow::ensure!(root.is_dir(), "project root is not a directory");

    let terms = query_terms(&request.query);

    anyhow::ensure!(!terms.is_empty(), "query has no usable terms");

    let files_requested = request.files.len();

    let mut exact_ranks = BTreeSet::new();
    let mut seen_files = BTreeSet::new();

    let mut docs = Vec::new();
    let mut errors = Vec::new();
    let mut degraded_files = Vec::new();

    let mut total_source_bytes = 0usize;

    for candidate in request.files {
        let Some(rel) = safe_rel(&candidate.file) else {
            errors.push(FileError {
                file: candidate.file,
                reason: "invalid_relative_path".to_string(),
            });
            continue;
        };

        if !seen_files.insert(rel.clone()) {
            errors.push(FileError {
                file: rel,
                reason: "duplicate_candidate".to_string(),
            });
            continue;
        }

        if let Some(rank) = candidate.exact_rank {
            if rank == 0 || rank > MAX_FILES {
                errors.push(FileError {
                    file: rel,
                    reason: "invalid_exact_rank".to_string(),
                });
                continue;
            }

            if !exact_ranks.insert(rank) {
                errors.push(FileError {
                    file: rel,
                    reason: "duplicate_exact_rank".to_string(),
                });
                continue;
            }
        }

        let path = match resolve_file(&root, &rel) {
            Ok(path) => path,
            Err(error) => {
                errors.push(FileError {
                    file: rel,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) => {
                errors.push(FileError {
                    file: rel,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        total_source_bytes += source.len();

        anyhow::ensure!(
            total_source_bytes <= MAX_TOTAL_SOURCE_BYTES,
            "request exceeds {MAX_TOTAL_SOURCE_BYTES} total source bytes"
        );

        let mut structural_complete = false;
        let mut facts = Vec::new();

        if let Some(lang) = SupportLang::from_path(&path) {
            match extract_source(&source, lang) {
                Ok((parsed, truncated)) => {
                    structural_complete = !truncated;
                    facts = parsed;

                    if truncated {
                        degraded_files.push(DegradedFile {
                            file: rel.clone(),
                            reason: "structural_fact_limit".to_string(),
                        });
                    }
                }

                Err(error) => {
                    // Routing can still use path/code lexical fields.
                    // Structural failure never becomes semantic evidence.
                    degraded_files.push(DegradedFile {
                        file: rel.clone(),
                        reason: format!("structural_parse_failed: {error}"),
                    });
                }
            }
        } else {
            degraded_files.push(DegradedFile {
                file: rel.clone(),
                reason: "unsupported_structural_language".to_string(),
            });
        }

        let fields = build_fields(&rel, &source, &facts);

        docs.push(Document {
            file: rel,
            exact_rank: candidate.exact_rank,
            structural_complete,
            fields,
        });
    }

    docs.sort_by(|a, b| a.file.cmp(&b.file));

    let bm25_scores = bm25f_scores(&docs, &terms);

    let bm25_ranks = ranked_positions(&docs, &bm25_scores);

    let mut results = docs
        .iter()
        .enumerate()
        .map(|(index, doc)| {
            // RRF fuses independent retrieval channels only.
            //
            // Do NOT feed symbol/path/test ranks again here:
            // those fields already contribute inside BM25F.
            let score = rrf(doc.exact_rank) + rrf(bm25_ranks[index]);

            RankedResult {
                rank: 0,
                file: doc.file.clone(),
                rrf_score: score,
                bm25f_score: bm25_scores[index],
                exact_rank: doc.exact_rank,
                bm25_rank: bm25_ranks[index],
                structural_complete: doc.structural_complete,
                matched_terms: matched_terms(&terms, &doc.fields),
            }
        })
        .filter(|result| result.rrf_score > 0.0 || result.bm25f_score > 0.0)
        .collect::<Vec<_>>();

    results.sort_by(|left, right| {
        right
            .rrf_score
            .partial_cmp(&left.rrf_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                right
                    .bm25f_score
                    .partial_cmp(&left.bm25f_score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.file.cmp(&right.file))
    });

    let max_results = request
        .max_results
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);

    results.truncate(max_results);

    for (index, result) in results.iter_mut().enumerate() {
        result.rank = index + 1;
    }

    degraded_files.sort_by(|a, b| a.file.cmp(&b.file));
    errors.sort_by(|a, b| a.file.cmp(&b.file));

    let response = Response {
        protocol: PROTOCOL,
        authority: AUTHORITY,
        query_terms: terms,
        files_requested,
        files_scored: docs.len(),
        total_source_bytes,
        degraded_files,
        errors,
        results,
    };

    serde_json::to_writer(io::stdout(), &response)?;

    println!();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(
        file: &str,
        symbols: &str,
        signatures: &str,
        comments: &str,
        code: &str,
        tests: &str,
    ) -> Document {
        Document {
            file: file.to_string(),
            exact_rank: None,
            structural_complete: true,
            fields: Fields {
                path: tokenize_terms(file),
                symbols: tokenize_terms(symbols),
                signatures: tokenize_terms(signatures),
                comments: tokenize_terms(comments),
                code: tokenize_terms(code),
                tests: tokenize_terms(tests),
            },
        }
    }

    #[test]
    fn tokenizer_preserves_document_term_frequency() {
        let tokens = tokenize_terms("shipping shipping shipping");

        assert_eq!(
            tokens
                .iter()
                .filter(|token| token.as_str() == "shipping")
                .count(),
            3
        );
    }

    #[test]
    fn tokenizer_splits_snake_and_camel_identifiers() {
        let tokens = tokenize_terms("getNodeFromPath shipping_fee");

        for expected in [
            "getnodefrompath",
            "get",
            "node",
            "from",
            "path",
            "shipping_fee",
            "shipping",
            "fee",
        ] {
            assert!(
                tokens.iter().any(|token| token == expected),
                "missing {expected}: {tokens:?}"
            );
        }
    }

    #[test]
    fn bm25f_uses_real_term_frequency() {
        let docs = vec![
            doc("a.py", "shipping", "", "", "shipping", ""),
            doc("b.py", "shipping shipping shipping", "", "", "shipping", ""),
        ];

        let query = query_terms("shipping");
        let scores = bm25f_scores(&docs, &query);

        assert!(scores[1] > scores[0], "{scores:?}");
    }

    #[test]
    fn bm25f_prefers_structural_relevance() {
        let docs = vec![
            doc(
                "shop/checkout.py",
                "checkout_total",
                "def checkout_total subtotal",
                "",
                "subtotal shipping",
                "",
            ),
            doc(
                "shop/pricing.py",
                "shipping_fee",
                "def shipping_fee subtotal",
                "free shipping threshold",
                "shipping eligible subtotal",
                "test_free_shipping",
            ),
        ];

        let query = query_terms("free shipping subtotal");

        let scores = bm25f_scores(&docs, &query);

        assert!(scores[1] > scores[0], "{scores:?}");
    }

    #[test]
    fn rrf_is_monotonic() {
        assert!(rrf(Some(1)) > rrf(Some(2)));
        assert_eq!(rrf(None), 0.0);
    }
}
