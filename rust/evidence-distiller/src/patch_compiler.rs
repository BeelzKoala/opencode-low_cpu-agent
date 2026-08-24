use anyhow::{Context, Result};
use ast_grep_core::{Pattern, matcher::MatcherExt};
use ast_grep_language::{Language, LanguageExt, SupportLang};
use opencode_evidence_distiller::impact_index_core::{
    SymbolClosureBinding, resolve_symbol_closure,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    ops::Range,
    path::{Component, Path, PathBuf},
};

const PROTOCOL: &str = "patch-compiler-v1";
const MUTATION_PROTOCOL: &str = "mutation-plan-v1";
const EDIT_PROTOCOL: &str = "edit-script-v2";
const HANDOFF_PROTOCOL: &str = "scout-handoff-v1";
const MAX_MUTATIONS: usize = 4;
const MAX_LOWERED_EDITS: usize = 4;
const MAX_CHANGED_FILES: usize = 2;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_FRAGMENT_BYTES: usize = 16 * 1024;
const MAX_NODE_REPLACEMENT_BYTES: usize = 4 * 1024;
const MAX_CHECK_BYTES: usize = 4 * 1024;
const MAX_EVIDENCE_DISTANCE_LINES: usize = 96;
const MAX_RENAME_OCCURRENCES: usize = 16;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    handoff: String,
    mutation_protocol: String,
    mutations: Vec<Mutation>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Mutation {
    file: String,
    kind: String,
    symbol: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    replacement: Option<String>,
    #[serde(default)]
    new_name: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScoutHandoff {
    protocol: String,
    #[serde(rename = "search_protocol")]
    _search_protocol: String,
    status: String,
    #[serde(default)]
    blocking_reasons: Vec<String>,
    #[serde(default)]
    partial_reasons: Vec<String>,
    #[serde(default)]
    files: Vec<HandoffFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct HandoffFile {
    file: String,
    #[serde(default)]
    evidence_lines: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct Edit {
    file: String,
    kind: String,
    before: String,
    after: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct Postcondition {
    file: String,
    kind: String,
    value: String,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    mutation_protocol: String,
    edit_protocol: &'static str,
    ok: bool,
    reason: Option<String>,
    mutation_index: Option<usize>,
    mutations_requested: usize,
    mutations_effective: usize,
    dropped_noops: usize,
    dropped_duplicates: usize,
    lowered_edits: usize,
    changed_files: Vec<String>,
    checks_generated: usize,
    edits: Vec<Edit>,
    checks: Vec<Postcondition>,
}

impl Response {
    fn rejected(
        request: &Request,
        reason: impl Into<String>,
        mutation_index: Option<usize>,
    ) -> Self {
        Self {
            protocol: PROTOCOL,
            mutation_protocol: request.mutation_protocol.clone(),
            edit_protocol: EDIT_PROTOCOL,
            ok: false,
            reason: Some(reason.into()),
            mutation_index,
            mutations_requested: request.mutations.len(),
            mutations_effective: 0,
            dropped_noops: 0,
            dropped_duplicates: 0,
            lowered_edits: 0,
            changed_files: Vec::new(),
            checks_generated: 0,
            edits: Vec::new(),
            checks: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct AllowedFile {
    rel: String,
    path: PathBuf,
    source: String,
    evidence_lines: Vec<usize>,
}

fn normalize_rel(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn safe_rel(raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > 4096
        || raw.chars().any(char::is_control)
        || Path::new(raw).is_absolute()
    {
        return None;
    }
    let rel = normalize_rel(Path::new(raw.trim_start_matches("./")))?;
    if rel == ".git"
        || rel.starts_with(".git/")
        || rel == ".opencode"
        || rel.starts_with(".opencode/")
    {
        return None;
    }
    Some(rel)
}

fn safe_existing_file(root: &Path, rel: &str) -> Option<PathBuf> {
    let canonical_root = fs::canonicalize(root).ok()?;
    let candidate = fs::canonicalize(canonical_root.join(rel)).ok()?;
    if candidate == canonical_root || !candidate.starts_with(&canonical_root) {
        return None;
    }
    let meta = fs::metadata(&candidate).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    Some(candidate)
}

fn load_handoff(root: &Path, raw: &str) -> Result<ScoutHandoff> {
    anyhow::ensure!(
        !raw.is_empty() && !Path::new(raw).is_absolute(),
        "handoff_path_invalid"
    );
    let rel =
        normalize_rel(Path::new(raw.trim_start_matches("./"))).context("handoff_path_invalid")?;
    anyhow::ensure!(
        rel.starts_with(".opencode/scout-handoffs/"),
        "handoff_path_invalid"
    );
    let candidate = fs::canonicalize(root.join(&rel)).context("handoff_unavailable")?;
    let handoff_root = fs::canonicalize(root.join(".opencode/scout-handoffs"))
        .context("handoff_root_unavailable")?;
    anyhow::ensure!(candidate.starts_with(&handoff_root), "handoff_path_escape");
    serde_json::from_slice(&fs::read(candidate).context("handoff_read_failed")?)
        .context("handoff_json_invalid")
}

fn nearest_evidence_distance(line: usize, evidence: &[usize]) -> Option<usize> {
    evidence
        .iter()
        .copied()
        .filter(|value| *value > 0)
        .map(|value| value.abs_diff(line))
        .min()
}

fn line_for_byte(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte.min(text.len())]
        .iter()
        .filter(|value| **value == b'\n')
        .count()
        + 1
}

fn count_exact(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.match_indices(needle).take(2).count()
}

fn is_definition_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_definition"
            | "function_declaration"
            | "function_item"
            | "method_definition"
            | "method_declaration"
            | "method_signature"
    )
}

fn symbol_target_ranges(
    file: &AllowedFile,
    symbol: &str,
) -> std::result::Result<(Range<usize>, Range<usize>), &'static str> {
    let lang = SupportLang::from_path(&file.path).ok_or("language_unsupported")?;
    let ast = lang.ast_grep(&file.source);
    let root = ast.root();
    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return Err("source_syntax_invalid");
    }

    let mut found = Vec::new();
    for node in root.dfs().filter(|node| node.is_named()) {
        if !is_definition_kind(node.kind().as_ref()) {
            continue;
        }
        let Some(name) = node.field("name") else {
            continue;
        };
        if name.text().as_ref() != symbol {
            continue;
        }
        let Some(body) = node.field("body") else {
            continue;
        };
        let line = node.start_pos().line() + 1;
        let Some(distance) = nearest_evidence_distance(line, &file.evidence_lines) else {
            return Err("evidence_anchor_missing");
        };
        if distance <= MAX_EVIDENCE_DISTANCE_LINES {
            found.push((node.range(), body.range()));
            if found.len() > 1 {
                return Err("symbol_ambiguous");
            }
        }
    }
    found.into_iter().next().ok_or("symbol_not_found")
}

fn apply_range(text: &str, outer: Range<usize>, inner: Range<usize>, replacement: &str) -> String {
    let relative_start = inner.start - outer.start;
    let relative_end = inner.end - outer.start;
    let base = &text[outer.clone()];
    let mut out = String::with_capacity(base.len() + replacement.len());
    out.push_str(&base[..relative_start]);
    out.push_str(replacement);
    out.push_str(&base[relative_end..]);
    out
}

fn line_indent(source: &str, byte: usize) -> String {
    let line_start = source[..byte.min(source.len())]
        .rfind('\n')
        .map(|idx| idx + 1)
        .unwrap_or(0);
    source[line_start..byte.min(source.len())]
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .collect()
}

fn format_body(source: &str, body_range: &Range<usize>, body: &str) -> String {
    let current = &source[body_range.clone()];
    let trimmed = body.trim();
    let base_indent = line_indent(source, body_range.start);
    if current.trim_start().starts_with('{') && current.trim_end().ends_with('}') {
        let inner_indent = format!("{base_indent}    ");
        if trimmed.is_empty() {
            return "{}".to_string();
        }
        let joined = trimmed
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join(&format!("\n{inner_indent}"));
        format!("{{\n{inner_indent}{joined}\n{base_indent}}}")
    } else {
        trimmed
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join(&format!("\n{base_indent}"))
    }
}

fn compile_replace_body(
    file: &AllowedFile,
    mutation: &Mutation,
) -> std::result::Result<Option<Edit>, &'static str> {
    let body = mutation
        .body
        .as_deref()
        .ok_or("mutation_contract_invalid")?;
    if body.len() > MAX_BODY_BYTES || body.contains('\0') {
        return Err("mutation_contract_invalid");
    }
    let (def_range, body_range) = symbol_target_ranges(file, &mutation.symbol)?;
    let replacement_body = format_body(&file.source, &body_range, body);
    let before = file.source[def_range.clone()].to_string();
    let after = apply_range(&file.source, def_range, body_range, &replacement_body);
    if before == after {
        return Ok(None);
    }
    Ok(Some(Edit {
        file: file.rel.clone(),
        kind: "replace_exact".to_string(),
        before,
        after,
    }))
}

fn compile_replace_expr(
    file: &AllowedFile,
    mutation: &Mutation,
) -> std::result::Result<Option<Edit>, &'static str> {
    let before_pattern = mutation
        .before
        .as_deref()
        .ok_or("mutation_contract_invalid")?;
    let after_fragment = mutation
        .after
        .as_deref()
        .ok_or("mutation_contract_invalid")?;
    if before_pattern.is_empty()
        || before_pattern.len() > MAX_FRAGMENT_BYTES
        || after_fragment.len() > MAX_FRAGMENT_BYTES
        || before_pattern.contains('\0')
        || after_fragment.contains('\0')
    {
        return Err("mutation_contract_invalid");
    }
    if before_pattern == after_fragment {
        return Ok(None);
    }
    let (def_range, _) = symbol_target_ranges(file, &mutation.symbol)?;
    let lang = SupportLang::from_path(&file.path).ok_or("language_unsupported")?;
    let pattern =
        Pattern::try_new(before_pattern, lang).map_err(|_| "expression_pattern_invalid")?;
    let ast = lang.ast_grep(&file.source);
    let root = ast.root();
    let mut matched = Vec::new();
    for node in root.dfs().filter(|node| node.is_named()) {
        let range = node.range();
        if range.start < def_range.start || range.end > def_range.end {
            continue;
        }
        if pattern.match_node(node.clone()).is_some() {
            matched.push(range);
            if matched.len() > 1 {
                return Err("expression_ambiguous");
            }
        }
    }
    let Some(expr_range) = matched.into_iter().next() else {
        return Err("expression_not_found");
    };
    let before = file.source[def_range.clone()].to_string();
    let after = apply_range(&file.source, def_range, expr_range, after_fragment);
    if before == after {
        return Ok(None);
    }
    Ok(Some(Edit {
        file: file.rel.clone(),
        kind: "replace_exact".to_string(),
        before,
        after,
    }))
}

fn format_node_replacement(source: &str, node_range: &Range<usize>, replacement: &str) -> String {
    let trimmed = replacement.trim();

    if trimmed.is_empty() {
        return String::new();
    }

    if !trimmed.contains('\n') {
        return trimmed.to_string();
    }

    let base_indent = line_indent(source, node_range.start);

    let mut lines = trimmed.lines();
    let mut out = String::new();

    if let Some(first) = lines.next() {
        out.push_str(first.trim_end());
    }

    for line in lines {
        out.push('\n');
        out.push_str(&base_indent);
        out.push_str(line.trim_end());
    }

    out
}

fn compile_replace_node(
    file: &AllowedFile,
    mutation: &Mutation,
) -> std::result::Result<Option<Edit>, &'static str> {
    let before_pattern = mutation
        .before
        .as_deref()
        .ok_or("mutation_contract_invalid")?;

    let replacement = mutation
        .replacement
        .as_deref()
        .ok_or("mutation_contract_invalid")?;

    if before_pattern.is_empty()
        || before_pattern.len() > MAX_FRAGMENT_BYTES
        || replacement.len() > MAX_NODE_REPLACEMENT_BYTES
        || before_pattern.contains('\0')
        || replacement.contains('\0')
    {
        return Err("mutation_contract_invalid");
    }

    if before_pattern == replacement {
        return Ok(None);
    }

    let (def_range, _) = symbol_target_ranges(file, &mutation.symbol)?;

    let lang = SupportLang::from_path(&file.path).ok_or("language_unsupported")?;

    let pattern = Pattern::try_new(before_pattern, lang).map_err(|_| "node_pattern_invalid")?;

    let ast = lang.ast_grep(&file.source);
    let root = ast.root();

    let mut matched = Vec::new();

    for node in root.dfs().filter(|node| node.is_named()) {
        let range = node.range();

        if (range.start < def_range.start || range.end > def_range.end) {
            continue;
        }

        if pattern.match_node(node.clone()).is_some() {
            matched.push(range);

            if matched.len() > 1 {
                return Err("node_ambiguous");
            }
        }
    }

    let Some(node_range) = matched.into_iter().next() else {
        return Err("node_not_found");
    };

    let formatted = format_node_replacement(&file.source, &node_range, replacement);

    let before = file.source[def_range.clone()].to_string();

    let after = apply_range(&file.source, def_range, node_range, &formatted);

    if before == after {
        return Ok(None);
    }

    Ok(Some(Edit {
        file: file.rel.clone(),
        kind: "replace_exact".to_string(),
        before,
        after,
    }))
}

fn valid_ascii_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn line_bounds(source: &str, byte: usize) -> (usize, usize) {
    let start = source[..byte.min(source.len())]
        .rfind('\n')
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let end = source[byte.min(source.len())..]
        .find('\n')
        .map(|idx| byte.min(source.len()) + idx)
        .unwrap_or(source.len());
    (start, end)
}

#[derive(Debug, Clone)]
struct RenameDef {
    def: Range<usize>,
    body: Range<usize>,
    name: Range<usize>,
    params_shadow_symbol: bool,
}

#[derive(Debug)]
struct RenameFacts {
    root: Range<usize>,
    defs: Vec<RenameDef>,
    classes: Vec<Range<usize>>,
    declarations: Vec<Range<usize>>,
    parameter_bindings: Vec<Range<usize>>,
    candidates: Vec<(Range<usize>, usize)>,
    member_receivers: BTreeMap<(usize, usize), String>,
    unsupported_scopes: Vec<Range<usize>>,
    hard_unsupported_binding: bool,
}

fn range_contains(outer: &Range<usize>, inner: &Range<usize>) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

fn same_range(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start == b.start && a.end == b.end
}

fn is_class_kind(kind: &str) -> bool {
    matches!(
        kind,
        "class_definition" | "class_declaration" | "abstract_class_declaration"
    )
}

fn is_unsupported_rename_scope_kind(kind: &str) -> bool {
    matches!(
        kind,
        "lambda"
            | "lambda_expression"
            | "arrow_function"
            | "function_expression"
            | "generator_expression"
            | "list_comprehension"
            | "set_comprehension"
            | "dictionary_comprehension"
    )
}

fn lexical_binding_field_kind(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "shorthand_property_identifier_pattern"
            | "object_pattern"
            | "array_pattern"
            | "tuple_pattern"
            | "list_pattern"
    )
}

fn owner_def_index(defs: &[RenameDef], range: &Range<usize>) -> Option<usize> {
    defs.iter()
        .enumerate()
        .filter(|(_, def)| range_contains(&def.body, range))
        .min_by_key(|(_, def)| def.body.end.saturating_sub(def.body.start))
        .map(|(idx, _)| idx)
}

fn enclosing_class(classes: &[Range<usize>], range: &Range<usize>) -> Option<Range<usize>> {
    classes
        .iter()
        .filter(|body| range_contains(body, range))
        .min_by_key(|body| body.end.saturating_sub(body.start))
        .cloned()
}

fn scan_rename_facts(
    file: &AllowedFile,
    symbol: &str,
) -> std::result::Result<RenameFacts, &'static str> {
    let lang = SupportLang::from_path(&file.path).ok_or("language_unsupported")?;
    let ast = lang.ast_grep(&file.source);
    let root = ast.root();

    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return Err("source_syntax_invalid");
    }

    let mut defs = Vec::new();
    let mut classes = Vec::new();
    let mut declaration_keys = BTreeSet::<(usize, usize)>::new();
    let mut parameter_bindings = Vec::<Range<usize>>::new();
    let mut candidates = Vec::new();
    let mut member_receivers = BTreeMap::<(usize, usize), String>::new();
    let mut unsupported_scopes = Vec::new();
    let mut hard_unsupported_binding = false;

    for node in root.clone().dfs().filter(|node| node.is_named()) {
        let kind = node.kind().as_ref().to_string();

        if node.is_named_leaf() && node.text().as_ref() == symbol {
            candidates.push((node.range(), node.start_pos().line() + 1));
        }

        if is_definition_kind(&kind) {
            if let (Some(name), Some(body)) = (node.field("name"), node.field("body")) {
                let mut params_shadow_symbol = false;

                if let Some(params) = node.field("parameters") {
                    for child in params.dfs().filter(|child| child.is_named_leaf()) {
                        if child.text().as_ref() != symbol {
                            continue;
                        }

                        params_shadow_symbol = true;
                        parameter_bindings.push(child.range());
                    }
                }

                if name.text().as_ref() == symbol {
                    let range = name.range();
                    declaration_keys.insert((range.start, range.end));
                }

                defs.push(RenameDef {
                    def: node.range(),
                    body: body.range(),
                    name: name.range(),
                    params_shadow_symbol,
                });
            }
        }

        if is_class_kind(&kind) {
            if let Some(body) = node.field("body") {
                classes.push(body.range());
            }
        }

        if is_unsupported_rename_scope_kind(&kind) {
            let mentions_symbol = node
                .clone()
                .dfs()
                .filter(|child| child.is_named_leaf())
                .any(|child| child.text().as_ref() == symbol);

            if mentions_symbol {
                unsupported_scopes.push(node.range());
            }
        }

        if matches!(
            kind.as_str(),
            "global_statement"
                | "nonlocal_statement"
                | "import_statement"
                | "import_from_statement"
        ) {
            let mentions_symbol = node
                .clone()
                .dfs()
                .filter(|child| child.is_named_leaf())
                .any(|child| child.text().as_ref() == symbol);

            if mentions_symbol {
                hard_unsupported_binding = true;
            }
        }

        let binding_fields: &[&str] = match kind.as_str() {
            "assignment" | "augmented_assignment" | "assignment_expression" => &["left"],

            "variable_declarator" => &["name"],

            "named_expression" => &["name"],

            "for_statement" | "for_in_statement" => &["left"],

            "catch_clause" => &["parameter"],

            "with_item" => &["alias"],

            "import_specifier" => &["alias", "name"],

            "namespace_import" => &["name"],

            _ => &[],
        };

        for field_name in binding_fields {
            let Some(field) = node.field(field_name) else {
                continue;
            };

            if !lexical_binding_field_kind(field.kind().as_ref()) {
                continue;
            }

            for leaf in field.dfs().filter(|child| child.is_named_leaf()) {
                if leaf.text().as_ref() == symbol {
                    let range = leaf.range();
                    declaration_keys.insert((range.start, range.end));
                }
            }
        }

        let member_fields = match kind.as_str() {
            "attribute" => Some(("object", "attribute")),
            "member_expression" => Some(("object", "property")),
            _ => None,
        };

        if let Some((object_field, property_field)) = member_fields {
            if let (Some(object), Some(property)) =
                (node.field(object_field), node.field(property_field))
            {
                if property.text().as_ref() == symbol {
                    let range = property.range();
                    member_receivers.insert(
                        (range.start, range.end),
                        object.text().as_ref().trim().to_string(),
                    );
                }
            }
        }
    }

    let declarations = declaration_keys
        .into_iter()
        .map(|(start, end)| start..end)
        .collect();

    Ok(RenameFacts {
        root: root.range(),
        defs,
        classes,
        declarations,
        parameter_bindings,
        candidates,
        member_receivers,
        unsupported_scopes,
        hard_unsupported_binding,
    })
}

fn unique_exact_pos(source: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }

    let mut matches = source.match_indices(needle);
    let first = matches.next()?.0;

    if matches.next().is_some() {
        None
    } else {
        Some(first)
    }
}

fn is_ident_byte(value: u8) -> bool {
    value == b'_' || value.is_ascii_alphanumeric()
}

fn identifier_tokens(text: &str) -> Vec<(usize, usize, &str)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];

        if b == b'_' || b.is_ascii_alphabetic() {
            let start = i;
            i += 1;

            while i < bytes.len() && is_ident_byte(bytes[i]) {
                i += 1;
            }

            out.push((start, i, &text[start..i]));
        } else {
            i += 1;
        }
    }

    out
}

fn rewrite_python_from_import(
    witness: &str,
    spec: &str,
    source_symbol: &str,
    local_symbol: &str,
    new_name: &str,
) -> std::result::Result<String, &'static str> {
    let trimmed = witness.trim_start();

    let Some(rest) = trimmed.strip_prefix("from ") else {
        return Err("rename_import_validation_failed");
    };

    let Some(import_at) = rest.find(" import ") else {
        return Err("rename_import_validation_failed");
    };

    let module = rest[..import_at].trim();

    if module != spec {
        return Err("rename_import_validation_failed");
    }

    let clause_offset_in_trimmed = "from ".len() + import_at + " import ".len();

    let leading = witness.len() - trimmed.len();
    let clause_start = leading + clause_offset_in_trimmed;

    let clause = &witness[clause_start..];
    let tokens = identifier_tokens(clause);

    let mut candidates = Vec::<(usize, usize)>::new();

    if local_symbol == source_symbol {
        for &(start, end, token) in &tokens {
            if token != source_symbol {
                continue;
            }

            /*
             * Reject "source as other" here: identity propagation means
             * source/local names are equal.
             */
            let token_idx = tokens
                .iter()
                .position(|&(s, e, _)| s == start && e == end)
                .expect("token exists");

            let aliased = tokens
                .get(token_idx + 1)
                .map(|(_, _, value)| *value == "as")
                .unwrap_or(false);

            if !aliased {
                candidates.push((start, end));
            }
        }
    } else {
        for window in tokens.windows(3) {
            let (s0, e0, t0) = window[0];
            let (_, _, t1) = window[1];
            let (_, _, t2) = window[2];

            if t0 == source_symbol && t1 == "as" && t2 == local_symbol {
                candidates.push((s0, e0));
            }
        }
    }

    if candidates.len() != 1 {
        return Err("rename_import_ambiguous");
    }

    let (start, end) = candidates[0];

    let mut out = witness.to_string();
    out.replace_range(clause_start + start..clause_start + end, new_name);

    Ok(out)
}

fn range_inside_any_def(defs: &[RenameDef], range: &Range<usize>) -> bool {
    defs.iter().any(|def| range_contains(&def.body, range))
}

fn python_scope_shadows_import(
    facts: &RenameFacts,
    candidate: &Range<usize>,
    import_range: &Range<usize>,
) -> std::result::Result<bool, &'static str> {
    /*
     * Python lexical rule:
     * assignment/parameter anywhere in a function makes that spelling local
     * to that function (global/nonlocal were already classified unsupported).
     *
     * Check every enclosing lexical function, not just the nearest one:
     * nested functions can close over module/import bindings only if no
     * intermediate function creates another binding.
     */
    for def in &facts.defs {
        if !range_contains(&def.body, candidate) {
            continue;
        }

        if def.params_shadow_symbol {
            return Ok(true);
        }

        if facts
            .declarations
            .iter()
            .any(|decl| !range_contains(import_range, decl) && range_contains(&def.body, decl))
        {
            return Ok(true);
        }
    }

    /*
     * A competing module-level declaration changes the module binding
     * identity/order semantics. We intentionally do not perform flow-sensitive
     * rebinding analysis here.
     */
    let module_competitor = facts.declarations.iter().any(|decl| {
        !range_contains(import_range, decl) && !range_inside_any_def(&facts.defs, decl)
    });

    if module_competitor {
        return Err("rename_binding_ambiguous");
    }

    Ok(false)
}

fn compile_python_import_binding(
    file: &AllowedFile,
    binding: &SymbolClosureBinding,
    new_name: &str,
) -> std::result::Result<Vec<Edit>, &'static str> {
    if binding.kind != "python_from" {
        return Err("rename_binding_unsupported");
    }

    let Some(import_start) = unique_exact_pos(&file.source, &binding.witness) else {
        return Err("rename_import_precondition_not_unique");
    };

    let import_range = import_start..import_start + binding.witness.len();

    let import_after = rewrite_python_from_import(
        &binding.witness,
        &binding.spec,
        &binding.source_symbol,
        &binding.local_symbol,
        new_name,
    )?;

    if import_after == binding.witness {
        return Err("rename_import_validation_failed");
    }

    let mut edits = vec![Edit {
        file: file.rel.clone(),
        kind: "replace_exact".to_string(),
        before: binding.witness.clone(),
        after: import_after,
    }];

    /*
     * Alias import:
     *
     *     from source import old as local
     *
     * Only the source side changes. local() keeps its spelling and binding.
     */
    if !binding.propagates {
        return Ok(edits);
    }

    let facts = scan_rename_facts(file, &binding.local_symbol)?;

    let mut by_owner = BTreeMap::<(usize, usize), Vec<Range<usize>>>::new();

    for (range, _) in &facts.candidates {
        if range_contains(&import_range, range) {
            continue;
        }

        /*
         * A function parameter is a lexical binding declaration, not a
         * reference to the imported symbol. Calls inside that function are
         * handled separately by python_scope_shadows_import().
         */
        if facts
            .parameter_bindings
            .iter()
            .any(|binding| same_range(binding, range))
        {
            continue;
        }

        if facts
            .unsupported_scopes
            .iter()
            .any(|scope| range_contains(scope, range))
        {
            return Err("rename_binding_unsupported");
        }

        /*
         * obj.name is a member namespace, not the imported lexical binding.
         */
        if facts
            .member_receivers
            .contains_key(&(range.start, range.end))
        {
            continue;
        }

        if python_scope_shadows_import(&facts, range, &import_range)? {
            continue;
        }

        let Some(owner_idx) = owner_def_index(&facts.defs, range) else {
            /*
             * Module-level executable references require statement-level
             * ownership/range edits. Until that primitive exists, fail closed
             * instead of widening to the whole file.
             */
            return Err("rename_context_unsupported");
        };

        let owner = facts.defs[owner_idx].def.clone();

        by_owner
            .entry((owner.start, owner.end))
            .or_default()
            .push(range.clone());
    }

    for ((start, end), mut ranges) in by_owner {
        if end <= start || end > file.source.len() || end - start > MAX_FRAGMENT_BYTES {
            return Err("rename_context_too_large");
        }

        let before = file.source[start..end].to_string();

        if before.is_empty() || count_exact(&file.source, &before) != 1 {
            return Err("rename_context_ambiguous");
        }

        ranges.sort_by(|a, b| b.start.cmp(&a.start));

        let mut after = before.clone();

        for range in ranges {
            let local_start = range.start - start;
            let local_end = range.end - start;

            if &after[local_start..local_end] != binding.local_symbol.as_str() {
                return Err("rename_binding_ambiguous");
            }

            after.replace_range(local_start..local_end, new_name);
        }

        if after != before {
            edits.push(Edit {
                file: file.rel.clone(),
                kind: "replace_exact".to_string(),
                before,
                after,
            });
        }
    }

    Ok(edits)
}

fn closure_failure_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("closure_import_ambiguous") => "rename_binding_ambiguous",
        Some("closure_import_unresolved") => "rename_scope_incomplete",
        Some("closure_index_refresh_incomplete")
        | Some("closure_index_unavailable")
        | Some("closure_index_incomplete")
        | Some("closure_source_validation_failed") => "rename_dependency_evidence_invalid",
        Some("closure_binding_budget_exceeded") | Some("closure_state_budget_exceeded") => {
            "rename_scope_too_large"
        }
        Some("closure_member_binding_unsupported") | Some("closure_unsupported_import_syntax") => {
            "rename_binding_unsupported"
        }
        _ => "rename_binding_unsupported",
    }
}

fn compile_rename(
    root: &Path,
    allowed: &BTreeMap<String, AllowedFile>,
    target: &AllowedFile,
    mutation: &Mutation,
) -> std::result::Result<Vec<Edit>, &'static str> {
    let new_name = mutation
        .new_name
        .as_deref()
        .ok_or("mutation_contract_invalid")?;

    if mutation.scope.as_deref().unwrap_or("handoff") != "handoff"
        || !valid_ascii_identifier(new_name)
    {
        return Err("mutation_contract_invalid");
    }

    if mutation.symbol == new_name {
        return Ok(Vec::new());
    }

    /*
     * First establish one concrete semantic definition.
     *
     * Do not discard this result: the old implementation validated a target
     * here and then renamed every same-text AST leaf in the handoff.
     */
    let (target_def_range, _) = symbol_target_ranges(target, &mutation.symbol)?;
    let facts = scan_rename_facts(target, &mutation.symbol)?;

    if facts.hard_unsupported_binding {
        return Err("rename_binding_unsupported");
    }

    let target_def = facts
        .defs
        .iter()
        .find(|def| same_range(&def.def, &target_def_range))
        .cloned()
        .ok_or("symbol_not_found")?;

    /*
     * A definition nested in a class is treated as a method. Python's
     * function_definition is therefore correctly distinguished from a
     * module/local function without relying on the node kind alone.
     */
    let target_class = enclosing_class(&facts.classes, &target_def.def);

    /*
     * Function names bind in the containing lexical function/module scope,
     * not in their own body. owner_def_index(target.name) therefore returns
     * the outer definition for nested functions and None for module scope.
     */
    let target_binding_owner = owner_def_index(&facts.defs, &target_def.name);

    let binding_scope = target_binding_owner
        .map(|idx| facts.defs[idx].body.clone())
        .unwrap_or_else(|| facts.root.clone());

    /*
     * Conservative shadow rule for ordinary lexical functions:
     *
     * If the same spelling is bound anywhere inside the target binding
     * scope, we do not attempt partial data-flow reasoning. Reject instead.
     *
     * This deliberately gives up valid renames in unusual shadow-heavy code
     * rather than renaming a different binding.
     */
    if target_class.is_none() {
        if let Some(owner_idx) = target_binding_owner {
            if facts.defs[owner_idx].params_shadow_symbol {
                return Err("rename_binding_ambiguous");
            }
        }

        for def in &facts.defs {
            if !range_contains(&binding_scope, &def.def) {
                continue;
            }

            if same_range(&def.def, &target_def.def) {
                if def.params_shadow_symbol {
                    return Err("rename_binding_ambiguous");
                }
                continue;
            }

            if def.params_shadow_symbol {
                return Err("rename_binding_ambiguous");
            }
        }

        for declaration in &facts.declarations {
            if same_range(declaration, &target_def.name) {
                continue;
            }

            if range_contains(&binding_scope, declaration) {
                return Err("rename_binding_ambiguous");
            }
        }
    } else {
        /*
         * Inside one class, two same-name method definitions are not a
         * situation where this bounded compiler should choose one.
         */
        let class_body = target_class.as_ref().expect("checked above");

        let competing_method = facts.defs.iter().any(|def| {
            !same_range(&def.def, &target_def.def)
                && range_contains(class_body, &def.def)
                && &target.source[def.name.clone()] == mutation.symbol.as_str()
        });

        if competing_method {
            return Err("symbol_ambiguous");
        }
    }

    /*
     * Cross-file identity comes only from the shared deterministic closure
     * resolver. The compiler must not infer identity from spelling or handoff
     * membership.
     */
    let closure =
        resolve_symbol_closure(root, &target.rel, &mutation.symbol, MAX_RENAME_OCCURRENCES)
            .map_err(|_| "rename_dependency_evidence_invalid")?;

    if !closure.ready || !closure.complete {
        return Err(closure_failure_reason(closure.reason.as_deref()));
    }

    /*
     * Handoff is mutation authorization, not truth.
     * If the proven closure escapes it, partial rename is forbidden.
     */
    for rel in &closure.files {
        if !allowed.contains_key(rel) {
            return Err("rename_scope_incomplete");
        }
    }

    let mut total_occurrences = facts.candidates.len();

    if closure.bindings.len() > MAX_RENAME_OCCURRENCES {
        return Err("rename_scope_too_large");
    }

    total_occurrences += closure.bindings.len();

    if total_occurrences > MAX_RENAME_OCCURRENCES {
        return Err("rename_scope_too_large");
    }

    let mut proven_ranges = Vec::<Range<usize>>::new();

    for (range, line) in &facts.candidates {
        let is_target_name = same_range(range, &target_def.name);

        if facts
            .unsupported_scopes
            .iter()
            .any(|scope| range_contains(scope, range))
        {
            return Err("rename_binding_unsupported");
        }

        let member_receiver = facts
            .member_receivers
            .get(&(range.start, range.end))
            .map(String::as_str);

        let same_binding = if is_target_name {
            true
        } else if let Some(class_body) = &target_class {
            /*
             * Proven common method references only:
             *
             *   Python: self.foo / cls.foo
             *   JS/TS:  this.foo
             *
             * x.foo, super().foo and other receivers remain unknown.
             */
            match member_receiver {
                Some("self" | "cls" | "this") if range_contains(class_body, range) => true,

                Some(_) if range_contains(class_body, range) => {
                    return Err("rename_binding_ambiguous");
                }

                _ => false,
            }
        } else {
            /*
             * Property access is a separate namespace from an unqualified
             * lexical function name: obj.foo does not resolve to local foo.
             */
            if member_receiver.is_some() {
                false
            } else {
                range_contains(&binding_scope, range)
            }
        };

        if !same_binding {
            continue;
        }

        let Some(distance) = nearest_evidence_distance(*line, &target.evidence_lines) else {
            return Err("evidence_anchor_missing");
        };

        if distance > MAX_EVIDENCE_DISTANCE_LINES {
            return Err("rename_scope_incomplete");
        }

        proven_ranges.push(range.clone());
    }

    if proven_ranges.is_empty() {
        return Err("symbol_not_found");
    }

    /*
     * Physical lowering:
     *
     * Group proven occurrences by the smallest containing structural
     * definition. This keeps replace_exact bounded and prevents duplicate
     * source lines from becoming fake semantic ambiguity.
     *
     * We deliberately do NOT widen to arbitrary neighbouring lines.
     */
    let mut groups = BTreeMap::<(usize, usize), Vec<Range<usize>>>::new();

    for range in proven_ranges {
        let envelope = if same_range(&range, &target_def.name) {
            target_def.def.clone()
        } else {
            let Some(owner_idx) = owner_def_index(&facts.defs, &range) else {
                /*
                 * A module-level reference would require either a statement
                 * locator or a ranged edit protocol. Do not rewrite the whole
                 * file merely to make the precondition unique.
                 */
                return Err("rename_context_unsupported");
            };

            facts.defs[owner_idx].def.clone()
        };

        groups
            .entry((envelope.start, envelope.end))
            .or_default()
            .push(range);
    }

    if groups.len() > MAX_LOWERED_EDITS {
        return Err("rename_scope_too_large");
    }

    let mut edits = Vec::new();

    for ((start, end), mut ranges) in groups {
        if end <= start || end > target.source.len() || end - start > MAX_FRAGMENT_BYTES {
            return Err("rename_context_too_large");
        }

        let before = target.source[start..end].to_string();

        /*
         * The executor's replace_exact contract still requires one exact
         * preimage. A structural definition should normally satisfy this.
         * If not, preserve fail-closed behaviour.
         */
        if before.is_empty() || count_exact(&target.source, &before) != 1 {
            return Err("rename_context_ambiguous");
        }

        ranges.sort_by(|a, b| b.start.cmp(&a.start));

        let mut after = before.clone();

        for range in ranges {
            if range.start < start || range.end > end {
                return Err("rename_binding_ambiguous");
            }

            let local_start = range.start - start;
            let local_end = range.end - start;

            if &after[local_start..local_end] != mutation.symbol {
                return Err("rename_binding_ambiguous");
            }

            after.replace_range(local_start..local_end, new_name);
        }

        if after != before {
            edits.push(Edit {
                file: target.rel.clone(),
                kind: "replace_exact".to_string(),
                before,
                after,
            });
        }
    }

    /*
     * Lower cross-file proven bindings.
     *
     * Import identity comes from SymbolClosureResolver.
     * Lexical reference identity is revalidated here from current AST.
     */
    for binding in &closure.bindings {
        let Some(importer) = allowed.get(&binding.importer) else {
            return Err("rename_scope_incomplete");
        };

        let lang = SupportLang::from_path(&importer.path).ok_or("language_unsupported")?;

        match lang {
            SupportLang::Python => {
                edits.extend(compile_python_import_binding(importer, binding, new_name)?);
            }

            /*
             * Impact Index can already discover JS/TS bindings, but the
             * compiler does not yet have a block/function lexical-shadow
             * validator strong enough to mutate them safely.
             */
            SupportLang::JavaScript | SupportLang::TypeScript | SupportLang::Tsx => {
                return Err("rename_binding_unsupported");
            }

            _ => {
                return Err("rename_binding_unsupported");
            }
        }
    }

    if edits.len() > MAX_LOWERED_EDITS {
        return Err("rename_scope_too_large");
    }

    edits.sort();
    edits.dedup();

    Ok(edits)
}

fn compile(request: &Request) -> Result<Response> {
    if request.mutation_protocol != MUTATION_PROTOCOL {
        return Ok(Response::rejected(
            request,
            "mutation_protocol_mismatch",
            None,
        ));
    }
    if request.mutations.is_empty() || request.mutations.len() > MAX_MUTATIONS {
        return Ok(Response::rejected(request, "mutation_count_invalid", None));
    }

    let root = fs::canonicalize(&request.root).context("cannot resolve project root")?;
    let handoff = match load_handoff(&root, &request.handoff) {
        Ok(value) => value,
        Err(error) => return Ok(Response::rejected(request, error.to_string(), None)),
    };
    // Compatibility is defined by the stable handoff schema.
    // search_protocol is provenance only and may evolve independently.
    if handoff.protocol != HANDOFF_PROTOCOL {
        return Ok(Response::rejected(
            request,
            "handoff_protocol_mismatch",
            None,
        ));
    }
    if handoff.status != "ready"
        || !handoff.blocking_reasons.is_empty()
        || !handoff.partial_reasons.is_empty()
    {
        return Ok(Response::rejected(request, "handoff_not_ready", None));
    }

    let mut allowed = BTreeMap::<String, AllowedFile>::new();
    for handoff_file in handoff.files {
        let Some(rel) = safe_rel(&handoff_file.file) else {
            return Ok(Response::rejected(request, "handoff_file_invalid", None));
        };
        let Some(path) = safe_existing_file(&root, &rel) else {
            return Ok(Response::rejected(
                request,
                "handoff_file_unavailable",
                None,
            ));
        };
        let source = match fs::read_to_string(&path) {
            Ok(value) => value,
            Err(_) => return Ok(Response::rejected(request, "handoff_file_not_utf8", None)),
        };
        allowed.insert(
            rel.clone(),
            AllowedFile {
                rel,
                path,
                source,
                evidence_lines: handoff_file.evidence_lines,
            },
        );
    }
    if allowed.is_empty() {
        return Ok(Response::rejected(request, "handoff_scope_empty", None));
    }

    let mut seen_mutations = BTreeSet::new();
    let mut edits = Vec::<Edit>::new();
    let mut dropped_noops = 0usize;
    let mut dropped_duplicates = 0usize;
    let mut effective = 0usize;

    for (idx, mutation) in request.mutations.iter().enumerate() {
        if mutation.symbol.is_empty()
            || mutation.symbol.len() > 256
            || mutation.symbol.contains('\0')
        {
            return Ok(Response::rejected(
                request,
                "mutation_contract_invalid",
                Some(idx),
            ));
        }
        let Some(rel) = safe_rel(&mutation.file) else {
            return Ok(Response::rejected(
                request,
                "mutation_file_invalid",
                Some(idx),
            ));
        };
        let Some(file) = allowed.get(&rel) else {
            return Ok(Response::rejected(
                request,
                "file_outside_handoff",
                Some(idx),
            ));
        };
        let key = serde_json::to_string(mutation).context("cannot canonicalize mutation")?;
        if !seen_mutations.insert(key) {
            dropped_duplicates += 1;
            continue;
        }

        let compiled = match mutation.kind.as_str() {
            "replace_body" => match compile_replace_body(file, mutation) {
                Ok(Some(edit)) => vec![edit],
                Ok(None) => Vec::new(),
                Err(reason) => return Ok(Response::rejected(request, reason, Some(idx))),
            },
            "replace_node" => match compile_replace_node(file, mutation) {
                Ok(Some(edit)) => vec![edit],
                Ok(None) => Vec::new(),
                Err(reason) => return Ok(Response::rejected(request, reason, Some(idx))),
            },
            "replace_expr" => match compile_replace_expr(file, mutation) {
                Ok(Some(edit)) => vec![edit],
                Ok(None) => Vec::new(),
                Err(reason) => return Ok(Response::rejected(request, reason, Some(idx))),
            },
            "rename_symbol" => match compile_rename(&root, &allowed, file, mutation) {
                Ok(values) => values,
                Err(reason) => return Ok(Response::rejected(request, reason, Some(idx))),
            },
            _ => {
                return Ok(Response::rejected(
                    request,
                    "mutation_kind_invalid",
                    Some(idx),
                ));
            }
        };
        if compiled.is_empty() {
            dropped_noops += 1;
        } else {
            effective += 1;
            edits.extend(compiled);
        }
    }

    edits.sort();
    edits.dedup();
    if edits.is_empty() {
        let mut response = Response::rejected(request, "no_effect_plan", None);
        response.dropped_noops = dropped_noops;
        response.dropped_duplicates = dropped_duplicates;
        return Ok(response);
    }
    if edits.len() > MAX_LOWERED_EDITS {
        return Ok(Response::rejected(
            request,
            "lowered_edit_budget_exceeded",
            None,
        ));
    }
    let changed_files = edits
        .iter()
        .map(|edit| edit.file.clone())
        .collect::<BTreeSet<_>>();
    if changed_files.len() > MAX_CHANGED_FILES {
        return Ok(Response::rejected(
            request,
            "changed_file_budget_exceeded",
            None,
        ));
    }

    let mut checks = BTreeSet::<Postcondition>::new();
    for edit in &edits {
        if !edit.after.is_empty() && edit.after.len() <= MAX_CHECK_BYTES {
            checks.insert(Postcondition {
                file: edit.file.clone(),
                kind: "contains_exact".to_string(),
                value: edit.after.clone(),
            });
        }
    }
    let checks = checks.into_iter().collect::<Vec<_>>();

    Ok(Response {
        protocol: PROTOCOL,
        mutation_protocol: request.mutation_protocol.clone(),
        edit_protocol: EDIT_PROTOCOL,
        ok: true,
        reason: None,
        mutation_index: None,
        mutations_requested: request.mutations.len(),
        mutations_effective: effective,
        dropped_noops,
        dropped_duplicates,
        lowered_edits: edits.len(),
        changed_files: changed_files.into_iter().collect(),
        checks_generated: checks.len(),
        edits,
        checks,
    })
}

fn read_request() -> Result<Request> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    serde_json::from_str(&input).context("invalid request json")
}

fn main() -> Result<()> {
    let request = read_request()?;
    let response = compile(&request)?;
    serde_json::to_writer(io::stdout(), &response)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_identifier_gate_is_conservative() {
        assert!(valid_ascii_identifier("calculate_price"));
        assert!(valid_ascii_identifier("_x2"));
        assert!(!valid_ascii_identifier("2bad"));
        assert!(!valid_ascii_identifier("bad-name"));
    }

    #[test]
    fn exact_count_is_bounded() {
        assert_eq!(count_exact("a a a", "a"), 2);
        assert_eq!(count_exact("abc", "z"), 0);
    }

    #[test]
    fn range_replacement_is_local() {
        let text = "def f():\n    return 1\n";
        let def = 0..21;
        let body = 13..21;
        assert_eq!(
            apply_range(text, def, body, "return 2"),
            "def f():\n    return 2"
        );
    }

    #[test]
    fn evidence_distance_is_bounded() {
        assert_eq!(nearest_evidence_distance(10, &[1, 12, 30]), Some(2));
        assert_eq!(nearest_evidence_distance(10, &[]), None);
    }

    fn rename_file(source: &str, evidence_lines: Vec<usize>) -> AllowedFile {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();

        let root = std::env::temp_dir().join(format!(
            "opencode-patch-compiler-{}-{nonce}",
            std::process::id()
        ));

        fs::create_dir_all(&root).unwrap();

        let path = root.join("sample.py");
        fs::write(&path, source).unwrap();

        AllowedFile {
            rel: "sample.py".to_string(),
            path,
            source: source.to_string(),
            evidence_lines,
        }
    }

    fn rename_mutation(symbol: &str, new_name: &str) -> Mutation {
        Mutation {
            file: "sample.py".to_string(),
            kind: "rename_symbol".to_string(),
            symbol: symbol.to_string(),
            body: None,
            before: None,
            after: None,
            replacement: None,
            new_name: Some(new_name.to_string()),
            scope: Some("handoff".to_string()),
        }
    }

    #[test]
    fn rename_uses_structural_owners_not_unique_source_lines() {
        let source = r#"def alpha():
    return 1

def first():
    return alpha()

def second():
    return alpha()
"#;

        let file = rename_file(source, vec![1, 5, 8]);
        let mut allowed = BTreeMap::new();
        allowed.insert(file.rel.clone(), file.clone());

        let edits = compile_rename(
            file.path.parent().expect("fixture root"),
            &allowed,
            &file,
            &rename_mutation("alpha", "beta"),
        )
        .expect("rename should compile");

        assert_eq!(edits.len(), 3);
        assert!(edits.iter().all(|edit| edit.kind == "replace_exact"));

        let rendered = edits
            .iter()
            .map(|edit| edit.after.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(rendered.matches("def beta():").count(), 1);
        assert_eq!(rendered.matches("return beta()").count(), 2);
        assert!(!rendered.contains("alpha"));
    }

    #[test]
    fn rename_rejects_shadowed_lexical_binding() {
        let source = r#"def alpha():
    return 1

def caller(alpha):
    return alpha()
"#;

        let file = rename_file(source, vec![1, 4, 5]);
        let mut allowed = BTreeMap::new();
        allowed.insert(file.rel.clone(), file.clone());

        let err = compile_rename(
            file.path.parent().expect("fixture root"),
            &allowed,
            &file,
            &rename_mutation("alpha", "beta"),
        )
        .unwrap_err();

        assert_eq!(err, "rename_binding_ambiguous");
    }

    #[test]
    fn rename_method_accepts_self_receiver_only() {
        let source = r#"class Service:
    def alpha(self):
        return 1

    def call(self):
        return self.alpha()
"#;

        let file = rename_file(source, vec![2, 6]);
        let mut allowed = BTreeMap::new();
        allowed.insert(file.rel.clone(), file.clone());

        let edits = compile_rename(
            file.path.parent().expect("fixture root"),
            &allowed,
            &file,
            &rename_mutation("alpha", "beta"),
        )
        .expect("method rename should compile");

        assert_eq!(edits.len(), 2);

        let rendered = edits
            .iter()
            .map(|edit| edit.after.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("def beta(self):"));
        assert!(rendered.contains("self.beta()"));
    }

    #[test]
    fn rename_method_rejects_unknown_receiver() {
        let source = r#"class Service:
    def alpha(self):
        return 1

    def call(self, other):
        return other.alpha()
"#;

        let file = rename_file(source, vec![2, 6]);
        let mut allowed = BTreeMap::new();
        allowed.insert(file.rel.clone(), file.clone());

        let err = compile_rename(
            file.path.parent().expect("fixture root"),
            &allowed,
            &file,
            &rename_mutation("alpha", "beta"),
        )
        .unwrap_err();

        assert_eq!(err, "rename_binding_ambiguous");
    }

    #[test]
    fn python_import_rewrite_changes_source_not_alias() {
        assert_eq!(
            rewrite_python_from_import(
                "from service import price as p",
                "service",
                "price",
                "p",
                "calculate_price",
            )
            .unwrap(),
            "from service import calculate_price as p"
        );
    }

    #[test]
    fn python_import_rewrite_handles_module_with_same_spelling() {
        assert_eq!(
            rewrite_python_from_import(
                "from price import price",
                "price",
                "price",
                "price",
                "calculate_price",
            )
            .unwrap(),
            "from price import calculate_price"
        );
    }

    #[test]
    fn python_import_rewrite_rejects_ambiguous_import_clause() {
        assert_eq!(
            rewrite_python_from_import(
                "from service import price, price",
                "service",
                "price",
                "price",
                "calculate_price",
            )
            .unwrap_err(),
            "rename_import_ambiguous"
        );
    }

    #[test]
    fn imported_binding_shadow_is_not_renamed() {
        let source = r#"from service import price

def quote(value):
    return price(value)

def shadow(price):
    return price(10)
"#;

        let file = rename_file(source, vec![1, 4, 7]);

        let binding = SymbolClosureBinding {
            importer: "sample.py".to_string(),
            target: "service.py".to_string(),
            kind: "python_from".to_string(),
            witness_line: 1,
            spec: "service".to_string(),
            source_symbol: "price".to_string(),
            local_symbol: "price".to_string(),
            witness: "from service import price".to_string(),
            confidence: "exact_local".to_string(),
            propagates: true,
        };

        let edits = compile_python_import_binding(&file, &binding, "calculate_price").unwrap();

        let rendered = edits
            .iter()
            .map(|edit| edit.after.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("from service import calculate_price"));

        assert!(rendered.contains("return calculate_price(value)"));

        assert!(!rendered.contains("def shadow(calculate_price)"));

        assert!(!rendered.contains("return calculate_price(10)"));
    }

    #[test]
    fn aliased_import_does_not_rename_local_references() {
        let source = r#"from service import price as p

def quote(value):
    return p(value)
"#;

        let file = rename_file(source, vec![1, 4]);

        let binding = SymbolClosureBinding {
            importer: "sample.py".to_string(),
            target: "service.py".to_string(),
            kind: "python_from".to_string(),
            witness_line: 1,
            spec: "service".to_string(),
            source_symbol: "price".to_string(),
            local_symbol: "p".to_string(),
            witness: "from service import price as p".to_string(),
            confidence: "exact_local".to_string(),
            propagates: false,
        };

        let edits = compile_python_import_binding(&file, &binding, "calculate_price").unwrap();

        assert_eq!(edits.len(), 1);

        assert_eq!(edits[0].after, "from service import calculate_price as p");

        assert!(!edits[0].after.contains("calculate_price("));
    }
    #[test]
    fn node_replacement_preserves_relative_indent() {
        let source = "def f():\n    old_call()\n";

        let start = source.find("old_call()").unwrap();

        let end = start + "old_call()".len();

        let replacement = "if ready:\n    return value";

        assert_eq!(
            format_node_replacement(source, &(start..end), replacement,),
            "if ready:\n        return value",
        );
    }
}
