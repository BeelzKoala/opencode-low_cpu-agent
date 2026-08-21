use anyhow::{Context, Result};
use ast_grep_core::{tree_sitter::StrDoc, Node};
use ast_grep_language::{Language, LanguageExt, SupportLang};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Instant,
};

const PROTOCOL: &str = "evidence-distiller-v2";
const BACKEND: &str = "ast-grep-0.45.1";

const DEFAULT_BUDGET_BYTES: usize = 3_000;
const MAX_BUDGET_BYTES: usize = 64 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

const MAX_REPORTED_LINES_PER_RECORD: usize = 8;
const MAX_MATCH_TEXT_CHARS: usize = 160;
const MAX_ANCHOR_CHARS: usize = 200;
const MAX_SYMBOL_NAME_CHARS: usize = 120;

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

    // Optional 0-based UTF-8 byte column within `line`.
    // This is a point location, not a full match span.
    #[serde(default)]
    column: Option<usize>,

    // Preferred precise location:
    // absolute UTF-8 byte offsets in the file, half-open [start_byte, end_byte).
    #[serde(default)]
    start_byte: Option<usize>,
    #[serde(default)]
    end_byte: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct RecordKey {
    file: String,
    symbol_kind: String,
    symbol_name: String,
    start_line: usize,
    end_line: usize,
    role: String,
    node_kind: String,
    match_text: String,
    anchor: String,
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

    // Smallest named AST node that covers the match.
    node_kind: String,

    // Exact rg match text when precise byte span is supplied.
    // Falls back to node text for legacy line/column-only hits.
    match_text: String,

    // Structural context:
    // call -> callee, assignment -> target, import -> imported source/path,
    // definition -> defined name, reference -> matched node.
    anchor: String,

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
    mapped_hits: usize,
    exact_span_hits: usize,
    anchored_hits: usize,
    lossy_hits: usize,
    unresolved_hits: usize,

    structural_records_total: usize,
    structural_records_shown: usize,

    parsed_files: usize,
    unsupported_files: Vec<String>,
    errors: Vec<FileError>,

    budget_bytes: usize,
    output_record_bytes: usize,

    location_complete: bool,
    anchor_complete: bool,
    distill_complete: bool,

    // Only true when structural output can safely replace the bounded raw evidence.
    // Integration MUST fall back to raw unless this is true.
    safe_for_replacement: bool,

    truncated: bool,

    elapsed_ms: f64,

    records: Vec<Record>,
}

#[derive(Debug)]
struct TextValue {
    text: String,
    truncated: bool,
}

#[derive(Debug)]
struct ResolvedHit {
    node_start: usize,
    node_end: usize,
    exact_span: bool,
    exact_match_start: Option<usize>,
    exact_match_end: Option<usize>,
}

#[derive(Debug, Default)]
struct SourceStats {
    mapped_hits: usize,
    exact_span_hits: usize,
    anchored_hits: usize,
    lossy_hits: usize,
}

struct Classification {
    role: &'static str,
    anchor: TextValue,
}

fn compact_text(text: &str, max_chars: usize) -> TextValue {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let total = compact.chars().count();

    if total <= max_chars {
        return TextValue {
            text: compact,
            truncated: false,
        };
    }

    let prefix: String = compact.chars().take(max_chars).collect();

    TextValue {
        text: format!("{prefix}…"),
        truncated: true,
    }
}

fn is_symbol_kind(kind: &str) -> bool {
    matches!(
        kind,
        // Python / C / C++
        "function_definition"
            | "class_definition"
            | "struct_specifier"
            | "class_specifier"
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
            // Go / Java / C# / Kotlin-ish grammars
            | "method_declaration"
            | "type_declaration"
            | "constructor_declaration"
            | "interface_declaration"
    )
}

fn range_contains(outer: std::ops::Range<usize>, inner: std::ops::Range<usize>) -> bool {
    outer.start <= inner.start && outer.end >= inner.end
}

fn node_covers_line(node: &SgNode<'_>, line0: usize) -> bool {
    let start = node.start_pos().line();
    let end = node.end_pos().line();

    start <= line0 && line0 <= end
}

fn deepest_named_node_on_line<'a>(
    root: &SgNode<'a>,
    line0: usize,
) -> Option<SgNode<'a>> {
    root.dfs()
        .filter(|node| node.is_named())
        .filter(|node| node_covers_line(node, line0))
        .min_by_key(|node| {
            let range = node.range();
            range.end.saturating_sub(range.start)
        })
}

fn deepest_named_node_covering_span<'a>(
    root: &SgNode<'a>,
    start: usize,
    end: usize,
) -> Option<SgNode<'a>> {
    if start >= end {
        return None;
    }

    root.dfs()
        .filter(|node| node.is_named())
        .filter(|node| {
            let range = node.range();
            range.start <= start && range.end >= end
        })
        .min_by_key(|node| {
            let range = node.range();
            range.end.saturating_sub(range.start)
        })
}

fn line_start_byte(source: &str, line1: usize) -> Option<usize> {
    if line1 == 0 {
        return None;
    }

    if line1 == 1 {
        return Some(0);
    }

    let mut current_line = 1usize;

    for (idx, byte) in source.bytes().enumerate() {
        if byte == b'\n' {
            current_line += 1;

            if current_line == line1 {
                return Some(idx + 1);
            }
        }
    }

    None
}

fn line_end_byte(source: &str, line_start: usize) -> usize {
    let bytes = source.as_bytes();

    for (offset, byte) in bytes[line_start..].iter().enumerate() {
        if *byte == b'\n' {
            return line_start + offset;
        }
    }

    source.len()
}

fn resolve_hit<'a>(
    source: &str,
    root: &SgNode<'a>,
    hit: &Hit,
) -> Option<ResolvedHit> {
    if let (Some(start), Some(end)) = (hit.start_byte, hit.end_byte) {
        if start < end && end <= source.len() {
            let node = deepest_named_node_covering_span(root, start, end)?;

            let range = node.range();

            return Some(ResolvedHit {
                node_start: range.start,
                node_end: range.end,
                exact_span: true,
                exact_match_start: Some(start),
                exact_match_end: Some(end),
            });
        }

        return None;
    }

    if let Some(column) = hit.column {
        let start = line_start_byte(source, hit.line)?;
        let end = line_end_byte(source, start);

        let point = start.checked_add(column)?;

        if point >= end || point >= source.len() {
            return None;
        }

        let point_end = point.saturating_add(1).min(source.len());

        let node = deepest_named_node_covering_span(root, point, point_end)?;

        let range = node.range();

        return Some(ResolvedHit {
            node_start: range.start,
            node_end: range.end,
            exact_span: false,
            exact_match_start: None,
            exact_match_end: None,
        });
    }

    if hit.line == 0 {
        return None;
    }

    let node = deepest_named_node_on_line(root, hit.line - 1)?;
    let range = node.range();

    Some(ResolvedHit {
        node_start: range.start,
        node_end: range.end,
        exact_span: false,
        exact_match_start: None,
        exact_match_end: None,
    })
}

fn find_node_by_exact_range<'a>(
    root: &SgNode<'a>,
    start: usize,
    end: usize,
) -> Option<SgNode<'a>> {
    root.dfs()
        .filter(|node| node.is_named())
        .find(|node| {
            let range = node.range();
            range.start == start && range.end == end
        })
}

fn enclosing_symbol<'a>(node: &SgNode<'a>) -> Option<SgNode<'a>> {
    std::iter::once(node.clone())
        .chain(node.ancestors())
        .find(|candidate| is_symbol_kind(candidate.kind().as_ref()))
}

fn first_named_child_text(node: &SgNode<'_>, limit: usize) -> Option<TextValue> {
    node.children()
        .find(|child| child.is_named())
        .and_then(|child| node_text(&child, limit))
}

fn classify_with_anchor(
    node: &SgNode<'_>,
    symbol: Option<&SgNode<'_>>,
) -> Option<Classification> {
    if let Some(symbol) = symbol {
        if let Some(name) = symbol.field("name") {
            if range_contains(name.range(), node.range()) {
                let anchor = node_text(&name, MAX_ANCHOR_CHARS)?;

                return Some(Classification {
                    role: "definition",
                    anchor,
                });
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
            let anchor = field_text(
                &candidate,
                &["source", "module", "path", "name"],
                MAX_ANCHOR_CHARS,
            )
            .or_else(|| node_text(&candidate, MAX_ANCHOR_CHARS))?;

            return Some(Classification {
                role: "import",
                anchor,
            });
        }

        if k.contains("call") || k.contains("invocation") {
            let anchor =
                field_text(&candidate, &["function", "callee"], MAX_ANCHOR_CHARS)
                    .or_else(|| {
                        first_named_child_text(&candidate, MAX_ANCHOR_CHARS)
                    })?;

            return Some(Classification {
                role: "call",
                anchor,
            });
        }

        if k.contains("assignment")
            || k == "variable_declarator"
            || k == "let_declaration"
            || k == "short_var_declaration"
        {
            let anchor = field_text(
                &candidate,
                &["left", "name", "pattern", "declarator"],
                MAX_ANCHOR_CHARS,
            )
            .or_else(|| {
                first_named_child_text(&candidate, MAX_ANCHOR_CHARS)
            })?;

            return Some(Classification {
                role: "assignment",
                anchor,
            });
        }

        if k.contains("declaration") || k.contains("definition") {
            let anchor =
                field_text(&candidate, &["name"], MAX_ANCHOR_CHARS)
                    .or_else(|| node_text(node, MAX_ANCHOR_CHARS))?;

            return Some(Classification {
                role: "definition",
                anchor,
            });
        }

        current = candidate.parent();
    }

    let anchor = node_text(node, MAX_ANCHOR_CHARS)?;

    Some(Classification {
        role: "reference",
        anchor,
    })
}

fn field_text(node: &SgNode<'_>, names: &[&str], limit: usize) -> Option<TextValue> {
    for name in names {
        if let Some(value) = node.field(name) {
            let text = compact_text(value.text().as_ref(), limit);

            if !text.text.is_empty() {
                return Some(text);
            }
        }
    }

    None
}

fn node_text(node: &SgNode<'_>, limit: usize) -> Option<TextValue> {
    let text = compact_text(node.text().as_ref(), limit);

    if text.text.is_empty() {
        None
    } else {
        Some(text)
    }
}


fn symbol_descriptor(
    symbol: Option<&SgNode<'_>>,
    source_line_count: usize,
) -> (String, String, usize, usize, bool) {
    let Some(symbol) = symbol else {
        return (
            "module".to_string(),
            "<module>".to_string(),
            1,
            source_line_count.max(1),
            false,
        );
    };

    let kind = symbol.kind().to_string();

    let name_value = symbol
        .field("name")
        .and_then(|node| node_text(&node, MAX_SYMBOL_NAME_CHARS));

    let (name, truncated) = match name_value {
        Some(value) => (value.text, value.truncated),
        None => (
            format!("<{}@{}>", kind, symbol.start_pos().line() + 1),
            false,
        ),
    };

    (
        kind,
        name,
        symbol.start_pos().line() + 1,
        symbol.end_pos().line() + 1,
        truncated,
    )
}

fn exact_match_text(
    source: &str,
    start: usize,
    end: usize,
) -> Option<TextValue> {
    if start >= end || end > source.len() {
        return None;
    }

    let bytes = &source.as_bytes()[start..end];
    let text = String::from_utf8_lossy(bytes);

    let value = compact_text(text.as_ref(), MAX_MATCH_TEXT_CHARS);

    if value.text.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn has_parse_errors(root: &SgNode<'_>) -> bool {
    root.dfs()
        .any(|node| node.is_error() || node.is_missing())
}

fn distill_source_ast_grep(
    relative_file: &str,
    source: &str,
    lang: SupportLang,
    hits: &[Hit],
    aggregates: &mut BTreeMap<RecordKey, Aggregate>,
) -> Result<SourceStats> {
    let ast = lang.ast_grep(source);
    let root = ast.root();

    anyhow::ensure!(
        !has_parse_errors(&root),
        "tree-sitter parse contains ERROR or missing nodes"
    );

    let line_count = source.lines().count();
    let mut stats = SourceStats::default();

    for hit in hits {
        let Some(resolved) = resolve_hit(source, &root, hit) else {
            continue;
        };

        let Some(node) = find_node_by_exact_range(
            &root,
            resolved.node_start,
            resolved.node_end,
        ) else {
            continue;
        };

        stats.mapped_hits += 1;

        if resolved.exact_span {
            stats.exact_span_hits += 1;
        }

        let match_value = if let (Some(start), Some(end)) = (
            resolved.exact_match_start,
            resolved.exact_match_end,
        ) {
            exact_match_text(source, start, end)
                .or_else(|| node_text(&node, MAX_MATCH_TEXT_CHARS))
        } else {
            node_text(&node, MAX_MATCH_TEXT_CHARS)
        };

        let Some(match_value) = match_value else {
            continue;
        };

        let symbol = enclosing_symbol(&node);

        let Some(classification) =
            classify_with_anchor(&node, symbol.as_ref())
        else {
            continue;
        };

        stats.anchored_hits += 1;

        let (
            symbol_kind,
            symbol_name,
            start_line,
            end_line,
            symbol_name_truncated,
        ) = symbol_descriptor(symbol.as_ref(), line_count);

        if match_value.truncated
            || classification.anchor.truncated
            || symbol_name_truncated
        {
            stats.lossy_hits += 1;
        }

        let key = RecordKey {
            file: relative_file.to_string(),
            symbol_kind,
            symbol_name,
            start_line,
            end_line,
            role: classification.role.to_string(),
            node_kind: node.kind().to_string(),
            match_text: match_value.text,
            anchor: classification.anchor.text,
        };

        let entry = aggregates.entry(key).or_default();

        entry.hit_count += 1;
        entry.queries.insert(hit.query);
        entry.lines.insert(hit.line);
    }

    Ok(stats)
}

fn canonical_candidate(root: &Path, relative_file: &str) -> Result<PathBuf> {
    let rel = Path::new(relative_file);

    anyhow::ensure!(
        !rel.is_absolute(),
        "absolute file paths are not allowed"
    );

    let candidate = fs::canonicalize(root.join(rel))
        .with_context(|| format!("cannot resolve {relative_file}"))?;

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
        serde_json::from_str(&input).context("invalid request JSON")?;

    let project_root =
        fs::canonicalize(&request.root).context("cannot resolve project root")?;

    anyhow::ensure!(
        project_root.is_dir(),
        "project root is not a directory"
    );

    let budget = request
        .budget_bytes
        .unwrap_or(DEFAULT_BUDGET_BYTES)
        .clamp(512, MAX_BUDGET_BYTES);

    let raw_hits = request.hits.len();

    let mut by_file: BTreeMap<String, Vec<Hit>> = BTreeMap::new();

    for hit in &request.hits {
        by_file
            .entry(hit.file.clone())
            .or_default()
            .push(hit.clone());
    }

    let mut aggregates: BTreeMap<RecordKey, Aggregate> = BTreeMap::new();

    let mut unsupported_files = Vec::new();
    let mut errors = Vec::new();
    let mut parsed_files = 0usize;

    let mut mapped_hits = 0usize;
    let mut exact_span_hits = 0usize;
    let mut anchored_hits = 0usize;
    let mut lossy_hits = 0usize;

    for (relative_file, hits) in by_file {
        let candidate = match canonical_candidate(&project_root, &relative_file)
        {
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
                    "file exceeds {MAX_FILE_BYTES} bytes"
                ),
            });
            continue;
        }

        let Some(lang) = SupportLang::from_path(&candidate) else {
            unsupported_files.push(relative_file);
            continue;
        };

        let source = match fs::read_to_string(&candidate) {
            Ok(source) => source,
            Err(error) => {
                errors.push(FileError {
                    file: relative_file,
                    error: error.to_string(),
                });
                continue;
            }
        };

        match distill_source_ast_grep(
            &relative_file,
            &source,
            lang,
            &hits,
            &mut aggregates,
        ) {
            Ok(stats) => {
                parsed_files += 1;
                mapped_hits += stats.mapped_hits;
                exact_span_hits += stats.exact_span_hits;
                anchored_hits += stats.anchored_hits;
                lossy_hits += stats.lossy_hits;
            }

            Err(error) => {
                errors.push(FileError {
                    file: relative_file,
                    error: error.to_string(),
                });
            }
        }
    }

    let total_records = aggregates.len();

    let mut all_records: Vec<Record> = aggregates
        .into_iter()
        .map(|(key, aggregate)| {
            let mut lines: Vec<usize> = aggregate
                .lines
                .iter()
                .copied()
                .take(MAX_REPORTED_LINES_PER_RECORD)
                .collect();

            lines.sort_unstable();

            Record {
                file: key.file,
                symbol_kind: key.symbol_kind,
                symbol_name: key.symbol_name,
                start_line: key.start_line,
                end_line: key.end_line,
                role: key.role,
                node_kind: key.node_kind,
                match_text: key.match_text,
                anchor: key.anchor,
                hit_count: aggregate.hit_count,
                queries: aggregate.queries.into_iter().collect(),
                lines_truncated: aggregate.lines.len()
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
            .then_with(|| a.start_line.cmp(&b.start_line))
            .then_with(|| a.role.cmp(&b.role))
            .then_with(|| a.anchor.cmp(&b.anchor))
            .then_with(|| a.match_text.cmp(&b.match_text))
    });

    let mut records = Vec::new();
    let mut record_bytes = 0usize;
    let mut truncated = false;

    for record in all_records {
        let encoded = serde_json::to_vec(&record)?;

        if record_bytes + encoded.len() > budget {
            truncated = true;
            continue;
        }

        record_bytes += encoded.len();
        records.push(record);
    }

    let unresolved_hits = raw_hits.saturating_sub(mapped_hits);

    let location_complete =
        raw_hits > 0 && exact_span_hits == raw_hits;

    let anchor_complete =
        raw_hits > 0
            && anchored_hits == raw_hits
            && lossy_hits == 0;

    let distill_complete =
        unsupported_files.is_empty()
            && errors.is_empty()
            && unresolved_hits == 0;

    let safe_for_replacement =
        distill_complete
            && location_complete
            && anchor_complete
            && !truncated;

    let representation = if records.is_empty() {
        "none"
    } else {
        "structural"
    };

    let response = Response {
        protocol: PROTOCOL,
        backend: BACKEND,
        representation,

        raw_hits,
        mapped_hits,
        exact_span_hits,
        anchored_hits,
        lossy_hits,
        unresolved_hits,

        structural_records_total: total_records,
        structural_records_shown: records.len(),

        parsed_files,
        unsupported_files,
        errors,

        budget_bytes: budget,
        output_record_bytes: record_bytes,

        location_complete,
        anchor_complete,
        distill_complete,
        safe_for_replacement,

        truncated,

        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,

        records,
    };

    serde_json::to_writer(io::stdout(), &response)?;
    println!();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact_hit(
        file: &str,
        source: &str,
        needle: &str,
        occurrence: usize,
        query: usize,
    ) -> Hit {
        assert!(occurrence >= 1);

        let mut from = 0usize;
        let mut found = None;

        for _ in 0..occurrence {
            let rel = source[from..]
                .find(needle)
                .unwrap_or_else(|| panic!("needle not found: {needle}"));

            let start = from + rel;
            let end = start + needle.len();

            found = Some((start, end));
            from = end;
        }

        let (start, end) = found.unwrap();

        let line = source.as_bytes()[..start]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count()
            + 1;

        Hit {
            file: file.to_string(),
            line,
            query,
            column: None,
            start_byte: Some(start),
            end_byte: Some(end),
        }
    }

    fn distill_for_test(
        file: &str,
        source: &str,
        lang: SupportLang,
        hits: Vec<Hit>,
    ) -> (SourceStats, BTreeMap<RecordKey, Aggregate>) {
        let mut aggregates = BTreeMap::new();

        let stats = distill_source_ast_grep(
            file,
            source,
            lang,
            &hits,
            &mut aggregates,
        )
        .unwrap();

        (stats, aggregates)
    }

    fn count_for_anchor(
        aggregates: &BTreeMap<RecordKey, Aggregate>,
        anchor: &str,
    ) -> usize {
        aggregates
            .iter()
            .filter(|(key, _)| key.anchor == anchor)
            .map(|(_, value)| value.hit_count)
            .sum()
    }

    #[test]
    fn python_preserves_distinct_callees_and_aggregates_repeats() {
        let source = r#"
import requests
import httpx

requests.get(url)
requests.get(url2)
httpx.post(url3)
"#;

        let hits = vec![
            exact_hit("sample.py", source, "requests.get", 1, 1),
            exact_hit("sample.py", source, "requests.get", 2, 1),
            exact_hit("sample.py", source, "httpx.post", 1, 1),
        ];

        let (stats, aggregates) =
            distill_for_test("sample.py", source, SupportLang::Python, hits);

        assert_eq!(stats.mapped_hits, 3);
        assert_eq!(stats.exact_span_hits, 3);
        assert_eq!(stats.anchored_hits, 3);
        assert_eq!(stats.lossy_hits, 0);

        assert_eq!(count_for_anchor(&aggregates, "requests.get"), 2);
        assert_eq!(count_for_anchor(&aggregates, "httpx.post"), 1);
    }

    #[test]
    fn precise_span_disambiguates_multiple_calls_on_one_line() {
        let source = "result = foo(bar(), baz())\n";

        let hits = vec![
            exact_hit("sample.py", source, "foo", 1, 1),
            exact_hit("sample.py", source, "bar", 1, 1),
            exact_hit("sample.py", source, "baz", 1, 1),
        ];

        let (stats, aggregates) =
            distill_for_test("sample.py", source, SupportLang::Python, hits);

        assert_eq!(stats.exact_span_hits, 3);

        assert_eq!(count_for_anchor(&aggregates, "foo"), 1);
        assert_eq!(count_for_anchor(&aggregates, "bar"), 1);
        assert_eq!(count_for_anchor(&aggregates, "baz"), 1);
    }

    #[test]
    fn typescript_call_anchors_are_preserved() {
        let source = r#"
function run() {
  client.fetch(url);
  axios.get(url);
}
"#;

        let hits = vec![
            exact_hit("sample.ts", source, "client.fetch", 1, 1),
            exact_hit("sample.ts", source, "axios.get", 1, 1),
        ];

        let (stats, aggregates) = distill_for_test(
            "sample.ts",
            source,
            SupportLang::TypeScript,
            hits,
        );

        assert_eq!(stats.exact_span_hits, 2);
        assert_eq!(count_for_anchor(&aggregates, "client.fetch"), 1);
        assert_eq!(count_for_anchor(&aggregates, "axios.get"), 1);
    }

    #[test]
    fn rust_call_anchors_are_preserved() {
        let source = r#"
fn run() {
    client.fetch(url);
    http::get(url);
}
"#;

        let hits = vec![
            exact_hit("sample.rs", source, "client.fetch", 1, 1),
            exact_hit("sample.rs", source, "http::get", 1, 1),
        ];

        let (stats, aggregates) =
            distill_for_test("sample.rs", source, SupportLang::Rust, hits);

        assert_eq!(stats.exact_span_hits, 2);
        assert_eq!(count_for_anchor(&aggregates, "client.fetch"), 1);
        assert_eq!(count_for_anchor(&aggregates, "http::get"), 1);
    }

    #[test]
    fn go_call_anchors_are_preserved() {
        let source = r#"
package sample

func run() {
    client.Fetch(url)
    http.Get(url)
}
"#;

        let hits = vec![
            exact_hit("sample.go", source, "client.Fetch", 1, 1),
            exact_hit("sample.go", source, "http.Get", 1, 1),
        ];

        let (stats, aggregates) =
            distill_for_test("sample.go", source, SupportLang::Go, hits);

        assert_eq!(stats.exact_span_hits, 2);
        assert_eq!(count_for_anchor(&aggregates, "client.Fetch"), 1);
        assert_eq!(count_for_anchor(&aggregates, "http.Get"), 1);
    }

    #[test]
    fn line_only_hit_is_not_exact_span() {
        let source = "foo()\n";
        let ast = SupportLang::Python.ast_grep(source);
        let root = ast.root();

        let hit = Hit {
            file: "sample.py".to_string(),
            line: 1,
            query: 1,
            column: None,
            start_byte: None,
            end_byte: None,
        };

        let resolved = resolve_hit(source, &root, &hit).unwrap();

        assert!(!resolved.exact_span);
    }

    #[test]
    fn parse_errors_are_rejected() {
        let source = "def broken(:\n    pass\n";

        let mut aggregates = BTreeMap::new();

        let hit = Hit {
            file: "broken.py".to_string(),
            line: 1,
            query: 1,
            column: None,
            start_byte: Some(4),
            end_byte: Some(10),
        };

        let result = distill_source_ast_grep(
            "broken.py",
            source,
            SupportLang::Python,
            &[hit],
            &mut aggregates,
        );

        assert!(result.is_err());
    }
}
