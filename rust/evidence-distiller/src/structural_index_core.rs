use anyhow::{Context, Result};
use ast_grep_core::{Node, tree_sitter::StrDoc};
use ast_grep_language::{Language, LanguageExt, SupportLang};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::Instant,
};

const PROTOCOL: &str = "structural-ir-v2";
const BACKEND: &str = "ast-grep-0.45.1";
const AUTHORITY: &str = "hypothesis";

const MAX_FILES: usize = 16;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FACTS_PER_FILE: usize = 512;
const MAX_NAME_CHARS: usize = 160;
const MAX_SIGNATURE_CHARS: usize = 320;

type SgNode<'a> = Node<'a, StrDoc<SupportLang>>;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    files: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    backend: &'static str,
    authority: &'static str,
    complete: bool,
    files_requested: usize,
    files_parsed: usize,
    facts_total: usize,
    truncated_files: Vec<String>,
    unsupported_files: Vec<String>,
    errors: Vec<FileError>,
    files: Vec<IndexedFile>,
    elapsed_ms: f64,
}

#[derive(Debug, Serialize)]
struct FileError {
    file: String,
    reason: String,
}

#[derive(Debug, Serialize)]
struct IndexedFile {
    file: String,
    language: String,
    complete: bool,
    facts: Vec<Fact>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct Fact {
    pub(crate) role: &'static str,
    pub(crate) node_kind: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,

    // Lexical AST containment only. Useful for retrieval/ranking.
    // Never sufficient for semantic symbol identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) owner: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) qualified_name: Option<String>,

    pub(crate) signature: String,

    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) start_byte: usize,
    pub(crate) end_byte: usize,

    // Structural facts may rank/localize candidates but can never authorize
    // semantic identity on their own.
    pub(crate) authority: &'static str,
}

fn safe_rel(raw: &str) -> Option<String> {
    let path = Path::new(raw);

    if raw.is_empty() || path.is_absolute() {
        return None;
    }

    let mut parts = Vec::new();

    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let text = value.to_str()?;
                if text.is_empty() {
                    return None;
                }
                parts.push(text);
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

fn canonical_candidate(root: &Path, rel: &str) -> Result<PathBuf> {
    let candidate =
        fs::canonicalize(root.join(rel)).with_context(|| format!("cannot resolve {rel}"))?;

    anyhow::ensure!(candidate.starts_with(root), "path escapes project root");

    let meta = fs::metadata(&candidate).with_context(|| format!("cannot stat {rel}"))?;

    anyhow::ensure!(meta.is_file(), "not a regular file");

    anyhow::ensure!(
        meta.len() <= MAX_FILE_BYTES,
        "file exceeds {MAX_FILE_BYTES} bytes"
    );

    Ok(candidate)
}

fn compact(raw: &str, max_chars: usize) -> String {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");

    if normalized.chars().count() <= max_chars {
        return normalized;
    }

    normalized.chars().take(max_chars).collect()
}

fn node_text(node: &SgNode<'_>, max_chars: usize) -> String {
    compact(node.text().as_ref(), max_chars)
}

fn has_parse_errors(root: &SgNode<'_>) -> bool {
    root.clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
}

fn declaration_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_definition"
            | "class_definition"
            | "function_declaration"
            | "generator_function_declaration"
            | "method_definition"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "function_signature"
            | "method_signature"
    )
}

fn function_variable(node: &SgNode<'_>) -> bool {
    if node.kind().as_ref() != "variable_declarator" {
        return false;
    }

    node.field("value")
        .map(|value| {
            matches!(
                value.kind().as_ref(),
                "arrow_function" | "function_expression" | "generator_function"
            )
        })
        .unwrap_or(false)
}

fn declaration_name(node: &SgNode<'_>) -> Option<String> {
    node.field("name")
        .map(|name| node_text(&name, MAX_NAME_CHARS))
        .filter(|name| !name.is_empty())
}

fn call_name(node: &SgNode<'_>) -> Option<String> {
    node.field("function")
        .or_else(|| node.field("callee"))
        .or_else(|| node.field("constructor"))
        .map(|value| node_text(&value, MAX_NAME_CHARS))
        .filter(|name| !name.is_empty())
}

fn is_test_declaration(name: &str) -> bool {
    name.starts_with("test_") || name == "Test" || name.starts_with("Test")
}

fn is_test_call(name: &str) -> bool {
    let normalized = name.trim();

    matches!(normalized, "test" | "it" | "describe" | "suite")
        || normalized.starts_with("test.")
        || normalized.starts_with("it.")
        || normalized.starts_with("describe.")
        || normalized.starts_with("suite.")
}

fn declaration_signature(source: &str, node: &SgNode<'_>) -> String {
    let range = node.range();

    let header_end = node
        .field("body")
        .map(|body| body.range().start)
        .unwrap_or(range.end)
        .min(range.end);

    source
        .get(range.start..header_end)
        .map(|text| compact(text, MAX_SIGNATURE_CHARS))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| node_text(node, MAX_SIGNATURE_CHARS))
}

fn fact_for_node(source: &str, node: &SgNode<'_>) -> Option<Fact> {
    if !node.is_named() {
        return None;
    }

    let kind = node.kind();
    let kind = kind.as_ref();
    let range = node.range();

    let (role, name, signature) = if declaration_kind(kind) || function_variable(node) {
        let name = declaration_name(node);

        let role = if name.as_deref().map(is_test_declaration).unwrap_or(false) {
            "test_declaration"
        } else {
            "declaration"
        };

        (role, name, declaration_signature(source, node))
    } else if matches!(
        kind,
        "import_statement"
            | "import_from_statement"
            | "import_declaration"
            | "use_declaration"
            | "use_item"
    ) {
        ("import", None, node_text(node, MAX_SIGNATURE_CHARS))
    } else if kind == "comment" {
        ("comment", None, node_text(node, MAX_SIGNATURE_CHARS))
    } else if matches!(kind, "call" | "call_expression" | "new_expression") {
        let name = call_name(node);

        let role = if name.as_deref().map(is_test_call).unwrap_or(false) {
            "test_call"
        } else {
            "call"
        };

        (role, name, node_text(node, MAX_SIGNATURE_CHARS))
    } else {
        return None;
    };

    if signature.is_empty() {
        return None;
    }

    Some(Fact {
        role,
        node_kind: kind.to_string(),
        name,
        owner: None,
        qualified_name: None,
        signature,
        start_line: node.start_pos().line() + 1,
        end_line: node.end_pos().line() + 1,
        start_byte: range.start,
        end_byte: range.end,
        authority: AUTHORITY,
    })
}

fn structural_owner(fact: &Fact) -> bool {
    matches!(fact.role, "declaration" | "test_declaration") && fact.name.is_some()
}

fn enrich_lexical_context(facts: &mut [Fact]) {
    let snapshot = facts.to_vec();

    for (index, fact) in facts.iter_mut().enumerate() {
        let mut containers = snapshot
            .iter()
            .enumerate()
            .filter(|(candidate_index, candidate)| {
                *candidate_index != index
                    && structural_owner(candidate)
                    && candidate.start_byte <= fact.start_byte
                    && fact.end_byte <= candidate.end_byte
                    && (candidate.start_byte < fact.start_byte
                        || fact.end_byte < candidate.end_byte)
            })
            .map(|(_, candidate)| candidate)
            .collect::<Vec<_>>();

        // Largest lexical range first: outer -> inner.
        containers.sort_by(|a, b| {
            let a_span = a.end_byte.saturating_sub(a.start_byte);
            let b_span = b.end_byte.saturating_sub(b.start_byte);

            b_span
                .cmp(&a_span)
                .then_with(|| a.start_byte.cmp(&b.start_byte))
                .then_with(|| a.end_byte.cmp(&b.end_byte))
        });

        let parts = containers
            .iter()
            .filter_map(|candidate| candidate.name.as_deref())
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>();

        if !parts.is_empty() {
            fact.owner = Some(parts.join("::"));
        }

        if structural_owner(fact) {
            if let Some(name) = fact.name.as_deref() {
                fact.qualified_name = Some(match fact.owner.as_deref() {
                    Some(owner) => format!("{owner}::{name}"),
                    None => name.to_string(),
                });
            }
        }
    }
}

pub(crate) fn extract_source(source: &str, lang: SupportLang) -> Result<(Vec<Fact>, bool)> {
    let ast = lang.ast_grep(source);
    let root = ast.root();

    anyhow::ensure!(
        !has_parse_errors(&root),
        "structural parse contains ERROR or missing nodes"
    );

    let mut facts = Vec::new();
    let mut truncated = false;

    for node in root.dfs() {
        let Some(fact) = fact_for_node(source, &node) else {
            continue;
        };

        if facts.len() >= MAX_FACTS_PER_FILE {
            truncated = true;
            break;
        }

        facts.push(fact);
    }

    facts.sort_by(|a, b| {
        a.start_byte
            .cmp(&b.start_byte)
            .then_with(|| a.role.cmp(b.role))
            .then_with(|| a.name.cmp(&b.name))
    });

    enrich_lexical_context(&mut facts);

    Ok((facts, truncated))
}

pub fn run_cli() -> Result<()> {
    let started = Instant::now();

    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .context("failed to read stdin")?;

    let request: Request = serde_json::from_str(&raw).context("invalid request JSON")?;

    let root = fs::canonicalize(&request.root).context("cannot resolve project root")?;

    anyhow::ensure!(root.is_dir(), "project root is not a directory");

    let mut requested = request.files;

    requested.sort();
    requested.dedup();

    anyhow::ensure!(
        !requested.is_empty() && requested.len() <= MAX_FILES,
        "file count must be within 1..={MAX_FILES}"
    );

    let files_requested = requested.len();

    let mut indexed = Vec::new();
    let mut unsupported_files = Vec::new();
    let mut truncated_files = Vec::new();
    let mut errors = Vec::new();
    let mut facts_total = 0usize;

    for raw_rel in requested {
        let Some(rel) = safe_rel(&raw_rel) else {
            errors.push(FileError {
                file: raw_rel,
                reason: "invalid_relative_path".to_string(),
            });
            continue;
        };

        let candidate = match canonical_candidate(&root, &rel) {
            Ok(path) => path,
            Err(error) => {
                errors.push(FileError {
                    file: rel,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        let Some(lang) = SupportLang::from_path(&candidate) else {
            unsupported_files.push(rel);
            continue;
        };

        let source = match fs::read_to_string(&candidate) {
            Ok(source) => source,
            Err(error) => {
                errors.push(FileError {
                    file: rel,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        let (facts, truncated) = match extract_source(&source, lang) {
            Ok(value) => value,
            Err(error) => {
                errors.push(FileError {
                    file: rel,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        if truncated {
            truncated_files.push(rel.clone());
        }

        facts_total += facts.len();

        indexed.push(IndexedFile {
            file: rel,
            language: format!("{lang:?}").to_lowercase(),
            complete: !truncated,
            facts,
        });
    }

    indexed.sort_by(|a, b| a.file.cmp(&b.file));
    unsupported_files.sort();
    truncated_files.sort();

    let response = Response {
        protocol: PROTOCOL,
        backend: BACKEND,
        authority: AUTHORITY,
        complete: errors.is_empty()
            && unsupported_files.is_empty()
            && truncated_files.is_empty()
            && indexed.len() == files_requested,
        files_requested,
        files_parsed: indexed.len(),
        facts_total,
        truncated_files,
        unsupported_files,
        errors,
        files: indexed,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    };

    serde_json::to_writer(io::stdout(), &response)?;
    println!();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_extracts_structural_fields() {
        let source = r#"
from service import handle

def helper(value):
    return handle(value)

def test_helper():
    assert helper(1)
"#;

        let (facts, truncated) = extract_source(source, SupportLang::Python).unwrap();

        assert!(!truncated);

        assert!(
            facts.iter().any(|f| {
                f.role == "import" && f.signature.contains("from service import handle")
            })
        );

        assert!(
            facts
                .iter()
                .any(|f| { f.role == "declaration" && f.name.as_deref() == Some("helper") })
        );

        assert!(
            facts.iter().any(|f| {
                f.role == "test_declaration" && f.name.as_deref() == Some("test_helper")
            })
        );

        assert!(
            facts
                .iter()
                .any(|f| { f.role == "call" && f.name.as_deref() == Some("handle") })
        );

        assert!(facts.iter().all(|f| f.authority == "hypothesis"));
    }

    #[test]
    fn typescript_extracts_functions_arrow_and_test_call() {
        let source = r#"
import { value } from "./value";

export function run() {
    return value();
}

const arrow = () => value();

test("run", () => run());
"#;

        let (facts, truncated) = extract_source(source, SupportLang::TypeScript).unwrap();

        assert!(!truncated);

        assert!(
            facts
                .iter()
                .any(|f| { f.role == "declaration" && f.name.as_deref() == Some("run") })
        );

        assert!(
            facts
                .iter()
                .any(|f| { f.role == "declaration" && f.name.as_deref() == Some("arrow") })
        );

        assert!(
            facts
                .iter()
                .any(|f| { f.role == "test_call" && f.name.as_deref() == Some("test") })
        );

        assert!(facts.iter().any(|f| { f.role == "import" }));
    }

    #[test]
    fn invalid_source_never_becomes_structural_evidence() {
        let source = "def broken(:\n    pass\n";

        assert!(extract_source(source, SupportLang::Python).is_err());
    }
}
