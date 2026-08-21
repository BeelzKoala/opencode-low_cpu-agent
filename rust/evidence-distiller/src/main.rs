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

const PROTOCOL: &str = "evidence-distiller-v3";
const BACKEND: &str = "ast-grep-0.45.1";

const DEFAULT_BUDGET_BYTES: usize = 32 * 1024;
const MAX_BUDGET_BYTES: usize = 64 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

const MAX_REPORTED_LINES_PER_RECORD: usize = 8;
const MAX_SUBJECT_TEXT_CHARS: usize = 320;
const MAX_STATEMENT_TEXT_CHARS: usize = 500;
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
struct GroupKey {
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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct VariantKey {
    subject_text: String,
    statement_text: String,
}

#[derive(Debug, Default)]
struct VariantAggregate {
    hit_count: usize,
    queries: BTreeSet<usize>,
    lines: BTreeSet<usize>,
}

#[derive(Debug, Default)]
struct GroupAggregate {
    hit_count: usize,
    queries: BTreeSet<usize>,
    lines: BTreeSet<usize>,
    variants: BTreeMap<VariantKey, VariantAggregate>,
}

#[derive(Debug, Serialize)]
struct Variant {
    subject_text: String,
    statement_text: String,
    hit_count: usize,
    queries: Vec<usize>,
    hit_lines: Vec<usize>,
    lines_truncated: bool,
}

#[derive(Debug, Serialize)]
struct Group {
    // The group header intentionally preserves the strongest part of v2:
    // file/scope/role/anchor/count/line provenance. v3 adds witness variants
    // underneath instead of discarding occurrence-level differences.
    file: String,
    symbol_kind: String,
    symbol_name: String,
    start_line: usize,
    end_line: usize,
    role: String,
    node_kind: String,
    match_text: String,
    anchor: String,
    hit_count: usize,
    queries: Vec<usize>,
    hit_lines: Vec<usize>,
    lines_truncated: bool,
    variants: Vec<Variant>,
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
    witness_hits: usize,
    lossy_hits: usize,
    unresolved_hits: usize,

    groups_total: usize,
    groups_shown: usize,
    variants_total: usize,
    variants_shown: usize,
    variant_diversity: f64,

    parsed_files: usize,
    unsupported_files: Vec<String>,
    errors: Vec<FileError>,

    budget_bytes: usize,
    output_group_bytes: usize,

    location_complete: bool,
    anchor_complete: bool,
    witness_complete: bool,
    distill_complete: bool,
    ir_complete: bool,

    // v2 is retained as the grouping/index layer inside every v3 group.
    // The added variants preserve the differences that v2 collapsed.
    v2_grouping_preserved: bool,

    // Structural IR is not raw surrounding context. The TS packer decides
    // whether and how much raw context to sample beside these witnesses.
    context_complete: bool,
    context_omitted: bool,

    truncated: bool,
    elapsed_ms: f64,
    groups: Vec<Group>,
}

#[derive(Debug, Clone)]
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
    witness_hits: usize,
    lossy_hits: usize,
}

struct Classification {
    role: &'static str,
    anchor: TextValue,
    subject: TextValue,
    statement: TextValue,
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
}

fn nearest_statement_text(
    node: &SgNode<'_>,
    symbol: Option<&SgNode<'_>>,
    fallback: &TextValue,
) -> TextValue {
    let stop_id = symbol.map(|s| s.node_id());
    let mut current = Some(node.clone());

    while let Some(candidate) = current {
        if Some(candidate.node_id()) == stop_id {
            break;
        }

        if is_statement_kind(candidate.kind().as_ref()) {
            if let Some(text) = node_text(&candidate, MAX_STATEMENT_TEXT_CHARS) {
                return text;
            }
        }

        current = candidate.parent();
    }

    fallback.clone()
}

fn definition_header_text(node: &SgNode<'_>) -> Option<TextValue> {
    let raw = node.text();
    let first_line = raw.as_ref().lines().next()?.trim();

    if first_line.is_empty() {
        return None;
    }

    Some(compact_text(first_line, MAX_SUBJECT_TEXT_CHARS))
}

fn classification_from_owner(
    role: &'static str,
    anchor: TextValue,
    owner: &SgNode<'_>,
    symbol: Option<&SgNode<'_>>,
    definition_header: bool,
) -> Option<Classification> {
    let subject = if definition_header {
        definition_header_text(owner)?
    } else {
        node_text(owner, MAX_SUBJECT_TEXT_CHARS)?
    };

    let statement = if definition_header {
        subject.clone()
    } else {
        nearest_statement_text(owner, symbol, &subject)
    };

    Some(Classification {
        role,
        anchor,
        subject,
        statement,
    })
}

fn classify_with_witness(
    node: &SgNode<'_>,
    symbol: Option<&SgNode<'_>>,
) -> Option<Classification> {
    if let Some(symbol) = symbol {
        if let Some(name) = symbol.field("name") {
            if range_contains(name.range(), node.range()) {
                let anchor = node_text(&name, MAX_ANCHOR_CHARS)?;
                return classification_from_owner(
                    "definition",
                    anchor,
                    symbol,
                    None,
                    true,
                );
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

        if k.contains("import") || k == "use_declaration" || k == "use_item" {
            let anchor = field_text(
                &candidate,
                &["source", "module", "path", "name"],
                MAX_ANCHOR_CHARS,
            )
            .or_else(|| node_text(&candidate, MAX_ANCHOR_CHARS))?;

            return classification_from_owner(
                "import",
                anchor,
                &candidate,
                symbol,
                false,
            );
        }

        if k.contains("call") || k.contains("invocation") {
            let anchor = field_text(
                &candidate,
                &["function", "callee"],
                MAX_ANCHOR_CHARS,
            )
            .or_else(|| first_named_child_text(&candidate, MAX_ANCHOR_CHARS))?;

            return classification_from_owner(
                "call",
                anchor,
                &candidate,
                symbol,
                false,
            );
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
            .or_else(|| first_named_child_text(&candidate, MAX_ANCHOR_CHARS))?;

            return classification_from_owner(
                "assignment",
                anchor,
                &candidate,
                symbol,
                false,
            );
        }

        if k.contains("declaration") || k.contains("definition") {
            let anchor = field_text(&candidate, &["name"], MAX_ANCHOR_CHARS)
                .or_else(|| node_text(node, MAX_ANCHOR_CHARS))?;

            return classification_from_owner(
                "definition",
                anchor,
                &candidate,
                symbol,
                true,
            );
        }

        current = candidate.parent();
    }

    let anchor = node_text(node, MAX_ANCHOR_CHARS)?;
    let subject = node_text(node, MAX_SUBJECT_TEXT_CHARS)?;
    let statement = nearest_statement_text(node, symbol, &subject);

    Some(Classification {
        role: "reference",
        anchor,
        subject,
        statement,
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
    aggregates: &mut BTreeMap<GroupKey, GroupAggregate>,
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
            classify_with_witness(&node, symbol.as_ref())
        else {
            continue;
        };

        stats.anchored_hits += 1;
        stats.witness_hits += 1;

        let (
            symbol_kind,
            symbol_name,
            start_line,
            end_line,
            symbol_name_truncated,
        ) = symbol_descriptor(symbol.as_ref(), line_count);

        if match_value.truncated
            || classification.anchor.truncated
            || classification.subject.truncated
            || classification.statement.truncated
            || symbol_name_truncated
        {
            stats.lossy_hits += 1;
        }

        let group_key = GroupKey {
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

        let variant_key = VariantKey {
            subject_text: classification.subject.text,
            statement_text: classification.statement.text,
        };

        let group = aggregates.entry(group_key).or_default();
        group.hit_count += 1;
        group.queries.insert(hit.query);
        group.lines.insert(hit.line);

        let variant = group.variants.entry(variant_key).or_default();
        variant.hit_count += 1;
        variant.queries.insert(hit.query);
        variant.lines.insert(hit.line);
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

    let mut aggregates: BTreeMap<GroupKey, GroupAggregate> = BTreeMap::new();

    let mut unsupported_files = Vec::new();
    let mut errors = Vec::new();
    let mut parsed_files = 0usize;

    let mut mapped_hits = 0usize;
    let mut exact_span_hits = 0usize;
    let mut anchored_hits = 0usize;
    let mut witness_hits = 0usize;
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
                witness_hits += stats.witness_hits;
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

    let total_groups = aggregates.len();

    let mut all_groups: Vec<Group> = aggregates
        .into_iter()
        .map(|(key, aggregate)| {
            let mut group_lines: Vec<usize> = aggregate
                .lines
                .iter()
                .copied()
                .take(MAX_REPORTED_LINES_PER_RECORD)
                .collect();
            group_lines.sort_unstable();

            let mut variants: Vec<Variant> = aggregate
                .variants
                .into_iter()
                .map(|(variant_key, variant_aggregate)| {
                    let mut lines: Vec<usize> = variant_aggregate
                        .lines
                        .iter()
                        .copied()
                        .take(MAX_REPORTED_LINES_PER_RECORD)
                        .collect();
                    lines.sort_unstable();

                    Variant {
                        subject_text: variant_key.subject_text,
                        statement_text: variant_key.statement_text,
                        hit_count: variant_aggregate.hit_count,
                        queries: variant_aggregate.queries.into_iter().collect(),
                        hit_lines: lines,
                        lines_truncated: variant_aggregate.lines.len()
                            > MAX_REPORTED_LINES_PER_RECORD,
                    }
                })
                .collect();

            variants.sort_by(|a, b| {
                b.hit_count
                    .cmp(&a.hit_count)
                    .then_with(|| a.statement_text.cmp(&b.statement_text))
                    .then_with(|| a.subject_text.cmp(&b.subject_text))
            });

            Group {
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
                hit_lines: group_lines,
                lines_truncated: aggregate.lines.len()
                    > MAX_REPORTED_LINES_PER_RECORD,
                variants,
            }
        })
        .collect();

    // Preserve the v2 summary ordering at the group level: repeated structural
    // facts first. v3 variants then preserve differences inside each group.
    all_groups.sort_by(|a, b| {
        b.hit_count
            .cmp(&a.hit_count)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.start_line.cmp(&b.start_line))
            .then_with(|| a.role.cmp(&b.role))
            .then_with(|| a.anchor.cmp(&b.anchor))
    });

    let total_variants: usize = all_groups.iter().map(|g| g.variants.len()).sum();
    let variant_diversity = if raw_hits > 0 {
        total_variants as f64 / raw_hits as f64
    } else {
        0.0
    };

    let mut groups = Vec::new();
    let mut group_bytes = 0usize;
    let mut shown_variants = 0usize;
    let mut truncated = false;

    for group in all_groups {
        let encoded = serde_json::to_vec(&group)?;

        if group_bytes + encoded.len() > budget {
            truncated = true;
            continue;
        }

        group_bytes += encoded.len();
        shown_variants += group.variants.len();
        groups.push(group);
    }

    let unresolved_hits = raw_hits.saturating_sub(mapped_hits);

    let location_complete = raw_hits > 0 && exact_span_hits == raw_hits;

    let anchor_complete =
        raw_hits > 0 && anchored_hits == raw_hits && lossy_hits == 0;

    let witness_complete =
        raw_hits > 0 && witness_hits == raw_hits && lossy_hits == 0;

    let distill_complete =
        unsupported_files.is_empty()
            && errors.is_empty()
            && unresolved_hits == 0;

    let ir_complete =
        distill_complete
            && location_complete
            && anchor_complete
            && witness_complete
            && !truncated
            && groups.len() == total_groups
            && shown_variants == total_variants;

    let representation = if groups.is_empty() {
        "none"
    } else {
        "evidence_ir"
    };

    let response = Response {
        protocol: PROTOCOL,
        backend: BACKEND,
        representation,

        raw_hits,
        mapped_hits,
        exact_span_hits,
        anchored_hits,
        witness_hits,
        lossy_hits,
        unresolved_hits,

        groups_total: total_groups,
        groups_shown: groups.len(),
        variants_total: total_variants,
        variants_shown: shown_variants,
        variant_diversity,

        parsed_files,
        unsupported_files,
        errors,

        budget_bytes: budget,
        output_group_bytes: group_bytes,

        location_complete,
        anchor_complete,
        witness_complete,
        distill_complete,
        ir_complete,

        v2_grouping_preserved: true,
        context_complete: false,
        context_omitted: true,

        truncated,

        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,

        groups,
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
    ) -> (SourceStats, BTreeMap<GroupKey, GroupAggregate>) {
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
        aggregates: &BTreeMap<GroupKey, GroupAggregate>,
        anchor: &str,
    ) -> usize {
        aggregates
            .iter()
            .filter(|(key, _)| key.anchor == anchor)
            .map(|(_, value)| value.hit_count)
            .sum()
    }

    fn variants_for_anchor<'a>(
        aggregates: &'a BTreeMap<GroupKey, GroupAggregate>,
        anchor: &str,
    ) -> Vec<(&'a VariantKey, &'a VariantAggregate)> {
        aggregates
            .iter()
            .filter(|(key, _)| key.anchor == anchor)
            .flat_map(|(_, group)| group.variants.iter())
            .collect()
    }

    #[test]
    fn python_preserves_v2_grouping_but_keeps_witness_variants() {
        let source = r#"
def load():
    a = requests.get(URL_A)
    b = requests.get(URL_B)
    return requests.get(FALLBACK)
"#;

        let hits = vec![
            exact_hit("sample.py", source, "requests.get", 1, 1),
            exact_hit("sample.py", source, "requests.get", 2, 1),
            exact_hit("sample.py", source, "requests.get", 3, 1),
        ];

        let (stats, aggregates) =
            distill_for_test("sample.py", source, SupportLang::Python, hits);

        assert_eq!(stats.mapped_hits, 3);
        assert_eq!(stats.exact_span_hits, 3);
        assert_eq!(stats.anchored_hits, 3);
        assert_eq!(stats.witness_hits, 3);
        assert_eq!(stats.lossy_hits, 0);

        // v2's useful grouping remains: one scope/role/anchor group with 3 hits.
        assert_eq!(count_for_anchor(&aggregates, "requests.get"), 3);

        // v3 strengthens it by keeping the three occurrence-level witnesses.
        let variants = variants_for_anchor(&aggregates, "requests.get");
        assert_eq!(variants.len(), 3);

        let statements: BTreeSet<_> = variants
            .iter()
            .map(|(key, _)| key.statement_text.as_str())
            .collect();

        assert!(statements.contains("a = requests.get(URL_A)"));
        assert!(statements.contains("b = requests.get(URL_B)"));
        assert!(statements.contains("return requests.get(FALLBACK)"));
    }

    #[test]
    fn repeated_identical_witnesses_are_compressed_not_deleted() {
        let source = r#"
def load():
    requests.get(DEFAULT_URL)
    requests.get(DEFAULT_URL)
    requests.get(DEFAULT_URL)
"#;

        let hits = vec![
            exact_hit("sample.py", source, "requests.get", 1, 1),
            exact_hit("sample.py", source, "requests.get", 2, 1),
            exact_hit("sample.py", source, "requests.get", 3, 1),
        ];

        let (_, aggregates) =
            distill_for_test("sample.py", source, SupportLang::Python, hits);

        let variants = variants_for_anchor(&aggregates, "requests.get");
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].1.hit_count, 3);
        assert_eq!(variants[0].0.subject_text, "requests.get(DEFAULT_URL)");
        assert_eq!(variants[0].0.statement_text, "requests.get(DEFAULT_URL)");
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
    fn typescript_call_anchors_and_witnesses_are_preserved() {
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
        assert_eq!(stats.witness_hits, 2);
        assert_eq!(count_for_anchor(&aggregates, "client.fetch"), 1);
        assert_eq!(count_for_anchor(&aggregates, "axios.get"), 1);
    }

    #[test]
    fn rust_call_anchors_and_witnesses_are_preserved() {
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
        assert_eq!(stats.witness_hits, 2);
        assert_eq!(count_for_anchor(&aggregates, "client.fetch"), 1);
        assert_eq!(count_for_anchor(&aggregates, "http::get"), 1);
    }

    #[test]
    fn go_call_anchors_and_witnesses_are_preserved() {
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
        assert_eq!(stats.witness_hits, 2);
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
