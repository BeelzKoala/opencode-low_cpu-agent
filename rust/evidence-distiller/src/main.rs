use anyhow::{Context, Result};
use ast_grep_core::{
    tree_sitter::StrDoc,
    Node,
};
use ast_grep_language::{
    Language,
    LanguageExt,
    SupportLang,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Instant,
};

const PROTOCOL: &str = "evidence-distiller-v1";
const BACKEND: &str = "ast-grep-0.45.1";
const DEFAULT_BUDGET_BYTES: usize = 3_000;
const MAX_BUDGET_BYTES: usize = 64 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REPORTED_LINES_PER_RECORD: usize = 8;

type SgNode<'a> = Node<'a, StrDoc<SupportLang>>;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    hits: Vec<Hit>,
    #[serde(default)]
    budget_bytes: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct Hit {
    file: String,

    // 1-based source line from rg.
    line: usize,

    // Query index from the compound search.
    #[serde(default)]
    query: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct RecordKey {
    file: String,
    symbol_kind: String,
    symbol_name: String,
    start_line: usize,
    end_line: usize,
    role: String,
}

#[derive(Debug, Default)]
struct Aggregate {
    hit_count: usize,
    queries: BTreeSet<usize>,
    lines: BTreeSet<usize>,
}

#[derive(Debug, Serialize)]
struct Record {
    file: String,
    symbol_kind: String,
    symbol_name: String,
    start_line: usize,
    end_line: usize,
    role: String,
    hit_count: usize,
    queries: Vec<usize>,
    hit_lines: Vec<usize>,
    lines_truncated: bool,
}

#[derive(Debug, Serialize)]
struct FileError {
    file: String,
    error: String,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    backend: &'static str,
    representation: &'static str,

    raw_hits: usize,
    structural_records_total: usize,
    structural_records_shown: usize,

    parsed_files: usize,
    unsupported_files: Vec<String>,
    errors: Vec<FileError>,

    budget_bytes: usize,
    output_record_bytes: usize,

    distill_complete: bool,
    truncated: bool,

    elapsed_ms: f64,

    records: Vec<Record>,
}

fn normalize_name(text: &str) -> String {
    let compact = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if compact.len() <= 100 {
        compact
    } else {
        format!("{}…", &compact[..100])
    }
}

fn is_symbol_kind(kind: &str) -> bool {
    matches!(
        kind,

        // Python
        "function_definition"
            | "class_definition"

        // JavaScript / TypeScript
        | "function_declaration"
        | "function_expression"
        | "arrow_function"
        | "method_definition"
        | "class_declaration"
        | "class"

        // Rust
        | "function_item"
        | "impl_item"
        | "trait_item"
        | "struct_item"
        | "enum_item"

        // Go
        | "function_declaration"
        | "method_declaration"
        | "type_declaration"

        // Java / C# / Kotlin-ish grammars
        | "method_declaration"
        | "constructor_declaration"
        | "class_declaration"
        | "interface_declaration"

        // C / C++
        | "function_definition"
        | "struct_specifier"
        | "class_specifier"
    )
}

fn node_covers_line(node: &SgNode<'_>, line0: usize) -> bool {
    let start = node.start_pos().line();
    let end = node.end_pos().line();

    start <= line0 && line0 <= end
}

fn deepest_named_node_on_line<'a>(
    root: &'a SgNode<'a>,
    line0: usize,
) -> Option<SgNode<'a>> {
    root
        .dfs()
        .filter(|node| node.is_named())
        .filter(|node| node_covers_line(node, line0))
        .min_by_key(|node| {
            let range = node.range();
            range.end.saturating_sub(range.start)
        })
}

fn enclosing_symbol<'a>(
    node: &SgNode<'a>,
) -> Option<SgNode<'a>> {
    std::iter::once(node.clone())
        .chain(node.ancestors())
        .find(|candidate| is_symbol_kind(candidate.kind().as_ref()))
}

fn range_contains(
    outer: std::ops::Range<usize>,
    inner: std::ops::Range<usize>,
) -> bool {
    outer.start <= inner.start && outer.end >= inner.end
}

fn classify_role(
    node: &SgNode<'_>,
    symbol: Option<&SgNode<'_>>,
) -> &'static str {
    if let Some(symbol) = symbol {
        if let Some(name) = symbol.field("name") {
            if range_contains(name.range(), node.range()) {
                return "definition";
            }
        }
    }

    let stop_id = symbol.map(|s| s.node_id());
    let mut current = Some(node.clone());

    while let Some(candidate) = current {
        if Some(candidate.node_id()) == stop_id {
            break;
        }

        let kind = candidate.kind();
        let k = kind.as_ref();

        if k.contains("import")
            || k == "use_declaration"
            || k == "use_item"
        {
            return "import";
        }

        if k.contains("call")
            || k.contains("invocation")
        {
            return "call";
        }

        if k.contains("assignment")
            || k == "variable_declarator"
            || k == "let_declaration"
            || k == "short_var_declaration"
        {
            return "assignment";
        }

        if k.contains("declaration")
            || k.contains("definition")
        {
            return "definition";
        }

        current = candidate.parent();
    }

    "reference"
}

fn symbol_descriptor(
    symbol: Option<&SgNode<'_>>,
    source_line_count: usize,
) -> (String, String, usize, usize) {
    let Some(symbol) = symbol else {
        return (
            "module".to_string(),
            "<module>".to_string(),
            1,
            source_line_count.max(1),
        );
    };

    let kind = symbol.kind().to_string();

    let name = symbol
        .field("name")
        .map(|n| normalize_name(n.text().as_ref()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            format!(
                "<{}@{}>",
                kind,
                symbol.start_pos().line() + 1
            )
        });

    (
        kind,
        name,
        symbol.start_pos().line() + 1,
        symbol.end_pos().line() + 1,
    )
}

// This boundary is deliberate.
//
// Today:
//   all supported languages -> ast-grep/tree-sitter.
//
// Future:
//   Python -> optional Ruff specialized backend
//   others -> ast-grep/tree-sitter.
//
// JSON protocol above this function must not change when Ruff is added.
fn distill_file_ast_grep(
    relative_file: &str,
    source: &str,
    lang: SupportLang,
    hits: &[Hit],
    aggregates: &mut BTreeMap<RecordKey, Aggregate>,
) {
    let ast = lang.ast_grep(source);
    let root = ast.root();
    let line_count = source.lines().count();

    for hit in hits {
        if hit.line == 0 {
            continue;
        }

        let line0 = hit.line - 1;

        let Some(node) =
            deepest_named_node_on_line(&root, line0)
        else {
            continue;
        };

        let symbol = enclosing_symbol(&node);
        let role = classify_role(&node, symbol.as_ref());

        let (
            symbol_kind,
            symbol_name,
            start_line,
            end_line,
        ) = symbol_descriptor(
            symbol.as_ref(),
            line_count,
        );

        let key = RecordKey {
            file: relative_file.to_string(),
            symbol_kind,
            symbol_name,
            start_line,
            end_line,
            role: role.to_string(),
        };

        let entry = aggregates.entry(key).or_default();
        entry.hit_count += 1;
        entry.queries.insert(hit.query);
        entry.lines.insert(hit.line);
    }
}

fn canonical_candidate(
    root: &Path,
    relative_file: &str,
) -> Result<PathBuf> {
    let rel = Path::new(relative_file);

    anyhow::ensure!(
        !rel.is_absolute(),
        "absolute file paths are not allowed"
    );

    let candidate = fs::canonicalize(root.join(rel))
        .with_context(|| {
            format!("cannot resolve {}", relative_file)
        })?;

    anyhow::ensure!(
        candidate.starts_with(root),
        "path escapes project root"
    );

    Ok(candidate)
}

fn main() -> Result<()> {
    let started = Instant::now();

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("failed to read stdin")?;

    let request: Request =
        serde_json::from_str(&input)
            .context("invalid request JSON")?;

    let project_root =
        fs::canonicalize(&request.root)
            .context("cannot resolve project root")?;

    anyhow::ensure!(
        project_root.is_dir(),
        "project root is not a directory"
    );

    let budget = request
        .budget_bytes
        .unwrap_or(DEFAULT_BUDGET_BYTES)
        .clamp(512, MAX_BUDGET_BYTES);

    let mut by_file:
        BTreeMap<String, Vec<Hit>> =
        BTreeMap::new();

    for hit in &request.hits {
        by_file
            .entry(hit.file.clone())
            .or_default()
            .push(hit.clone());
    }

    let mut aggregates:
        BTreeMap<RecordKey, Aggregate> =
        BTreeMap::new();

    let mut unsupported_files = Vec::new();
    let mut errors = Vec::new();
    let mut parsed_files = 0usize;

    for (relative_file, hits) in by_file {
        let candidate = match canonical_candidate(
            &project_root,
            &relative_file,
        ) {
            Ok(path) => path,
            Err(error) => {
                errors.push(FileError {
                    file: relative_file,
                    error: error.to_string(),
                });
                continue;
            }
        };

        let metadata = match fs::metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(FileError {
                    file: relative_file,
                    error: error.to_string(),
                });
                continue;
            }
        };

        if metadata.len() > MAX_FILE_BYTES {
            errors.push(FileError {
                file: relative_file,
                error: format!(
                    "file exceeds {} bytes",
                    MAX_FILE_BYTES
                ),
            });
            continue;
        }

        let Some(lang) =
            SupportLang::from_path(&candidate)
        else {
            unsupported_files.push(relative_file);
            continue;
        };

        let source =
            match fs::read_to_string(&candidate) {
                Ok(source) => source,
                Err(error) => {
                    errors.push(FileError {
                        file: relative_file,
                        error: error.to_string(),
                    });
                    continue;
                }
            };

        parsed_files += 1;

        distill_file_ast_grep(
            &relative_file,
            &source,
            lang,
            &hits,
            &mut aggregates,
        );
    }

    let total_records = aggregates.len();

    let mut all_records: Vec<Record> =
        aggregates
            .into_iter()
            .map(|(key, aggregate)| {
                let mut lines:
                    Vec<usize> =
                    aggregate.lines
                        .iter()
                        .copied()
                        .take(
                            MAX_REPORTED_LINES_PER_RECORD
                        )
                        .collect();

                lines.sort_unstable();

                Record {
                    file: key.file,
                    symbol_kind: key.symbol_kind,
                    symbol_name: key.symbol_name,
                    start_line: key.start_line,
                    end_line: key.end_line,
                    role: key.role,
                    hit_count: aggregate.hit_count,
                    queries:
                        aggregate.queries
                            .into_iter()
                            .collect(),
                    lines_truncated:
                        aggregate.lines.len()
                            > MAX_REPORTED_LINES_PER_RECORD,
                    hit_lines: lines,
                }
            })
            .collect();

    // Most repeated structural facts first.
    // Tie-breakers keep output deterministic.
    all_records.sort_by(|a, b| {
        b.hit_count
            .cmp(&a.hit_count)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| {
                a.start_line.cmp(&b.start_line)
            })
            .then_with(|| a.role.cmp(&b.role))
    });

    let mut records = Vec::new();
    let mut record_bytes = 0usize;
    let mut truncated = false;

    for record in all_records {
        let encoded =
            serde_json::to_vec(&record)?;

        if record_bytes + encoded.len() > budget {
            truncated = true;
            continue;
        }

        record_bytes += encoded.len();
        records.push(record);
    }

    let representation =
        if records.is_empty() {
            "none"
        } else {
            "structural"
        };

    let distill_complete =
        !truncated
            && unsupported_files.is_empty()
            && errors.is_empty();

    let response = Response {
        protocol: PROTOCOL,
        backend: BACKEND,
        representation,

        raw_hits: request.hits.len(),
        structural_records_total: total_records,
        structural_records_shown: records.len(),

        parsed_files,
        unsupported_files,
        errors,

        budget_bytes: budget,
        output_record_bytes: record_bytes,

        distill_complete,
        truncated,

        elapsed_ms:
            started.elapsed().as_secs_f64()
                * 1000.0,

        records,
    };

    serde_json::to_writer(
        io::stdout(),
        &response,
    )?;

    println!();

    Ok(())
}
