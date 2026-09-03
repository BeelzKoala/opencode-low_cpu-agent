use anyhow::{Context, Result};
use ast_grep_core::{Node, tree_sitter::StrDoc};
use ast_grep_language::{Language, LanguageExt, SupportLang};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Instant,
};

const PROTOCOL: &str = "context-planner-v1";
const REQUEST_PROTOCOL: &str = "context-plan-request-v1";
const BACKEND: &str = "ast-grep-0.45.1";
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 32;
const MAX_EVIDENCE_LINES: usize = 64;

type SgNode<'a> = Node<'a, StrDoc<SupportLang>>;

#[derive(Debug, Deserialize)]
struct Request {
    protocol: String,
    root: String,
    #[serde(default)]
    budget_bytes: Option<usize>,
    files: Vec<FileRequest>,
}

#[derive(Debug, Clone, Deserialize)]
struct FileRequest {
    file: String,
    evidence_lines: Vec<usize>,
    #[serde(default)]
    critical: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct CandidateRange {
    start_byte: usize,
    end_byte: usize,
    start_line: usize,
    end_line: usize,
}

#[derive(Debug, Clone, Serialize)]
struct Candidate {
    level: &'static str,
    structural: bool,
    ranges: Vec<CandidateRange>,
    raw_bytes: usize,
    covered_lines: Vec<usize>,
}

#[derive(Debug, Serialize)]
struct FilePlan {
    file: String,
    critical: bool,
    language: Option<String>,
    parse_status: &'static str,
    candidates: Vec<Candidate>,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    backend: &'static str,
    authority: &'static str,
    budget_bytes: usize,
    files_total: usize,
    parsed_files: usize,
    fallback_files: usize,
    elapsed_ms: f64,
    files: Vec<FilePlan>,
}

fn canonical_candidate(root: &Path, relative_file: &str) -> Result<PathBuf> {
    let rel = Path::new(relative_file);
    anyhow::ensure!(!rel.is_absolute(), "absolute file paths are not allowed");
    let candidate = fs::canonicalize(root.join(rel))
        .with_context(|| format!("cannot resolve {relative_file}"))?;
    anyhow::ensure!(candidate.starts_with(root), "path escapes project root");
    Ok(candidate)
}

fn has_parse_errors(root: &SgNode<'_>) -> bool {
    root.dfs().any(|node| node.is_error() || node.is_missing())
}

fn node_covers_line(node: &SgNode<'_>, line0: usize) -> bool {
    let start = node.start_pos().line();
    let end = node.end_pos().line();
    start <= line0 && line0 <= end
}

fn deepest_named_node_on_line<'a>(root: &SgNode<'a>, line0: usize) -> Option<SgNode<'a>> {
    root.dfs()
        .filter(|node| node.is_named())
        .filter(|node| node_covers_line(node, line0))
        .min_by_key(|node| {
            let range = node.range();
            range.end.saturating_sub(range.start)
        })
}

fn is_symbol_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_definition"
            | "class_definition"
            | "struct_specifier"
            | "class_specifier"
            | "function_declaration"
            | "function_expression"
            | "arrow_function"
            | "method_definition"
            | "class_declaration"
            | "class"
            | "function_item"
            | "impl_item"
            | "trait_item"
            | "struct_item"
            | "enum_item"
            | "method_declaration"
            | "type_declaration"
            | "constructor_declaration"
            | "interface_declaration"
    )
}

fn is_statement_kind(kind: &str) -> bool {
    kind.contains("statement")
        || kind.contains("assignment")
        || kind == "variable_declarator"
        || kind == "variable_declaration"
        || kind == "lexical_declaration"
        || kind == "let_declaration"
        || kind == "short_var_declaration"
        || kind == "use_declaration"
        || kind == "use_item"
        || kind.contains("import")
        || kind.contains("declaration")
}

fn enclosing_statement<'a>(node: &SgNode<'a>) -> SgNode<'a> {
    for candidate in std::iter::once(node.clone()).chain(node.ancestors()) {
        if is_statement_kind(candidate.kind().as_ref()) {
            return candidate;
        }
    }
    node.clone()
}

fn enclosing_owner<'a>(node: &SgNode<'a>) -> Option<SgNode<'a>> {
    for candidate in std::iter::once(node.clone()).chain(node.ancestors()) {
        if is_symbol_kind(candidate.kind().as_ref()) {
            if let Some(parent) = candidate.parent() {
                if parent.kind().as_ref() == "decorated_definition" {
                    return Some(parent);
                }
            }
            return Some(candidate);
        }
        if candidate.kind().as_ref() == "decorated_definition" {
            return Some(candidate);
        }
    }
    None
}

fn line_starts(source: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (idx, byte) in source.bytes().enumerate() {
        if byte == b'\n' && idx + 1 < source.len() {
            starts.push(idx + 1);
        }
    }
    starts
}

fn line_range(
    source: &str,
    starts: &[usize],
    start_line: usize,
    end_line: usize,
) -> Option<CandidateRange> {
    if start_line == 0 || end_line < start_line || start_line > starts.len() {
        return None;
    }
    let end_line = end_line.min(starts.len());
    let start_byte = starts[start_line - 1];
    let end_byte = if end_line < starts.len() {
        starts[end_line]
    } else {
        source.len()
    };
    Some(CandidateRange {
        start_byte,
        end_byte,
        start_line,
        end_line,
    })
}

fn merge_ranges(mut ranges: Vec<CandidateRange>) -> Vec<CandidateRange> {
    ranges.sort_by_key(|r| (r.start_byte, r.end_byte));
    let mut out: Vec<CandidateRange> = Vec::new();
    for range in ranges {
        if let Some(last) = out.last_mut() {
            if range.start_byte <= last.end_byte {
                last.end_byte = last.end_byte.max(range.end_byte);
                last.end_line = last.end_line.max(range.end_line);
                continue;
            }
        }
        out.push(range);
    }
    out
}

fn node_range(node: &SgNode<'_>) -> CandidateRange {
    let range = node.range();
    CandidateRange {
        start_byte: range.start,
        end_byte: range.end,
        start_line: node.start_pos().line() + 1,
        end_line: node.end_pos().line() + 1,
    }
}

fn raw_bytes(ranges: &[CandidateRange]) -> usize {
    ranges
        .iter()
        .map(|r| r.end_byte.saturating_sub(r.start_byte))
        .sum()
}

fn covers_all(ranges: &[CandidateRange], evidence: &[usize]) -> bool {
    evidence.iter().all(|line| {
        ranges
            .iter()
            .any(|r| r.start_line <= *line && *line <= r.end_line)
    })
}

fn candidate(
    level: &'static str,
    structural: bool,
    ranges: Vec<CandidateRange>,
    evidence: &[usize],
) -> Option<Candidate> {
    let ranges = merge_ranges(ranges);
    if ranges.is_empty() || !covers_all(&ranges, evidence) {
        return None;
    }
    Some(Candidate {
        level,
        structural,
        raw_bytes: raw_bytes(&ranges),
        ranges,
        covered_lines: evidence.to_vec(),
    })
}

fn line_candidate(
    source: &str,
    starts: &[usize],
    evidence: &[usize],
    radius: usize,
    level: &'static str,
) -> Option<Candidate> {
    let total = starts.len().max(1);
    let ranges = evidence
        .iter()
        .filter_map(|line| {
            let start = line.saturating_sub(radius).max(1);
            let end = line.saturating_add(radius).min(total);
            line_range(source, starts, start, end)
        })
        .collect();
    candidate(level, false, ranges, evidence)
}

fn structural_candidate<'a>(
    root: &SgNode<'a>,
    evidence: &[usize],
    level: &'static str,
) -> Option<Candidate> {
    let mut ranges = Vec::new();
    for line in evidence {
        let node = deepest_named_node_on_line(root, line.saturating_sub(1))?;
        let selected = match level {
            "statement" => enclosing_statement(&node),
            "owner" => enclosing_owner(&node)?,
            _ => return None,
        };
        ranges.push(node_range(&selected));
    }
    candidate(level, true, ranges, evidence)
}

fn dedupe_candidates(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let key = candidate
            .ranges
            .iter()
            .map(|r| format!("{}:{}", r.start_byte, r.end_byte))
            .collect::<Vec<_>>()
            .join(",");
        if seen.insert(key) {
            out.push(candidate);
        }
    }
    out
}

fn plan_file(root: &Path, request: &FileRequest) -> Result<FilePlan> {
    anyhow::ensure!(!request.file.is_empty(), "file is empty");
    let mut evidence = request
        .evidence_lines
        .iter()
        .copied()
        .filter(|line| *line > 0)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    anyhow::ensure!(!evidence.is_empty(), "evidence lines are empty");
    anyhow::ensure!(
        evidence.len() <= MAX_EVIDENCE_LINES,
        "too many evidence lines"
    );
    evidence.sort_unstable();

    let candidate_path = canonical_candidate(root, &request.file)?;
    let metadata = fs::metadata(&candidate_path)?;
    anyhow::ensure!(metadata.is_file(), "candidate is not a file");
    anyhow::ensure!(metadata.len() <= MAX_FILE_BYTES, "file too large");
    let source = fs::read_to_string(&candidate_path)
        .with_context(|| format!("cannot read {} as UTF-8", request.file))?;
    let starts = line_starts(&source);
    anyhow::ensure!(
        evidence.iter().all(|line| *line <= starts.len().max(1)),
        "evidence line out of range"
    );

    let mut candidates = Vec::new();
    if let Some(c) = line_candidate(&source, &starts, &evidence, 0, "anchor") {
        candidates.push(c);
    }
    if let Some(c) = line_candidate(&source, &starts, &evidence, 1, "window1") {
        candidates.push(c);
    }
    if let Some(c) = line_candidate(&source, &starts, &evidence, 2, "window2") {
        candidates.push(c);
    }

    let mut language = None;
    let mut parse_status = "unsupported";
    if let Some(lang) = SupportLang::from_path(&candidate_path) {
        language = candidate_path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_string);
        let ast = lang.ast_grep(&source);
        let ast_root = ast.root();
        if has_parse_errors(&ast_root) {
            parse_status = "parse_error";
        } else {
            parse_status = "parsed";
            if let Some(c) = structural_candidate(&ast_root, &evidence, "statement") {
                candidates.push(c);
            }
            if let Some(c) = structural_candidate(&ast_root, &evidence, "owner") {
                candidates.push(c);
            }
        }
    }

    Ok(FilePlan {
        file: request.file.clone(),
        critical: request.critical,
        language,
        parse_status,
        candidates: dedupe_candidates(candidates),
    })
}

fn main() -> Result<()> {
    let started = Instant::now();
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("failed to read stdin")?;
    let request: Request = serde_json::from_str(&input).context("invalid request JSON")?;
    anyhow::ensure!(
        request.protocol == REQUEST_PROTOCOL,
        "request protocol mismatch"
    );
    anyhow::ensure!(!request.files.is_empty(), "files are empty");
    anyhow::ensure!(request.files.len() <= MAX_FILES, "too many files");

    let project_root = fs::canonicalize(&request.root).context("cannot resolve project root")?;
    anyhow::ensure!(project_root.is_dir(), "project root is not a directory");

    let mut files = Vec::new();
    let mut parsed_files = 0usize;
    let mut fallback_files = 0usize;
    for file in &request.files {
        let plan = plan_file(&project_root, file)?;
        if plan.parse_status == "parsed" {
            parsed_files += 1;
        } else {
            fallback_files += 1;
        }
        files.push(plan);
    }
    files.sort_by(|a, b| a.file.cmp(&b.file));

    let response = Response {
        protocol: PROTOCOL,
        backend: BACKEND,
        authority: "representation_only",
        budget_bytes: request.budget_bytes.unwrap_or(0),
        files_total: files.len(),
        parsed_files,
        fallback_files,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        files,
    };
    serde_json::to_writer(io::stdout(), &response)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("context-planner-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn python_emits_structural_candidates_and_preserves_anchor_coverage() {
        let root = temp_root();
        let source = "from x import y\n\n@bp.get('/export')\ndef export():\n    value = y()\n    return value\n";
        fs::write(root.join("sample.py"), source).unwrap();
        let plan = plan_file(
            &root,
            &FileRequest {
                file: "sample.py".into(),
                evidence_lines: vec![3, 4, 5],
                critical: true,
            },
        )
        .unwrap();
        assert_eq!(plan.parse_status, "parsed");
        assert!(plan.candidates.iter().any(|c| c.level == "anchor"));
        assert!(plan.candidates.iter().any(|c| c.level == "statement"));
        assert!(plan.candidates.iter().any(|c| c.level == "owner"));
        for c in &plan.candidates {
            assert!(covers_all(&c.ranges, &[3, 4, 5]));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsupported_language_keeps_bounded_line_fallbacks() {
        let root = temp_root();
        fs::write(root.join("sample.unknown"), "a\nb\nc\nd\n").unwrap();
        let plan = plan_file(
            &root,
            &FileRequest {
                file: "sample.unknown".into(),
                evidence_lines: vec![2],
                critical: true,
            },
        )
        .unwrap();
        assert_eq!(plan.parse_status, "unsupported");
        assert!(plan.candidates.iter().any(|c| c.level == "anchor"));
        assert!(plan.candidates.iter().any(|c| c.level == "window1"));
        assert!(!plan.candidates.iter().any(|c| c.structural));
        fs::remove_dir_all(root).unwrap();
    }
}
