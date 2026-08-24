use anyhow::{Context, Result};
use ast_grep_language::{Language, LanguageExt, SupportLang};
use opencode_evidence_distiller::impact_index_core::{
    SymbolClosureBinding, SymbolClosureResponse, resolve_symbol_closure,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    ops::Range,
    path::{Component, Path, PathBuf},
    process::Command,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const PROTOCOL: &str = "invariant-verifier-v2";
const VERIFICATION_PROTOCOL: &str = "verification-receipt-v1";
const COMPILER_PROTOCOL: &str = "patch-compiler-v2";
const MUTATION_PROTOCOL: &str = "mutation-plan-v1";
const HANDOFF_PROTOCOL: &str = "scout-handoff-v1";
const LOCAL_CAPABILITY_PROTOCOL: &str = "scout-local-capability-v1";
const MUTATION_CONFINEMENT_PROTOCOL: &str = "mutation-slice-v1";
const MAX_STRUCTURAL_SLICE_NODES: usize = 16;
const MAX_CHANGED_FILES: usize = 2;
const MAX_EDITS: usize = 4;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    handoff: String,
    patch: String,
    compiler_protocol: String,
    mutation_protocol: String,
    mutations: Vec<Mutation>,
    changed_files: Vec<String>,
    edits: Vec<Edit>,
}

#[derive(Debug, Clone, Deserialize)]
struct Mutation {
    file: String,
    kind: String,
    symbol: String,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    replacement: Option<String>,
    #[serde(default)]
    new_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SliceConfinement {
    protocol: String,
    mutation_index: usize,
    owner_symbol: String,
    owner_start: usize,
    owner_end: usize,
    start_byte: usize,
    end_byte: usize,
    envelope: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Edit {
    file: String,
    kind: String,
    before: String,
    after: String,
    #[serde(default)]
    confinement: Option<SliceConfinement>,
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
    scope_mode: Option<String>,
    #[serde(default)]
    capability_protocol: Option<String>,
    #[serde(default)]
    allowed_mutations: Vec<String>,
    #[serde(default)]
    capability: Option<LocalMutationCapability>,
    #[serde(default)]
    files: Vec<HandoffFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct LocalMutationCapability {
    protocol: String,
    operation: String,
    target: LocalMutationTarget,
}

#[derive(Debug, Clone, Deserialize)]
struct LocalMutationTarget {
    file: String,
    symbol_name: String,
}

#[derive(Debug, Deserialize)]
struct HandoffFile {
    file: String,
}

#[derive(Debug, Clone, Serialize)]
struct Check {
    kind: String,
    pass: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    verification_protocol: &'static str,
    ok: bool,
    verdict: &'static str,
    reason: Option<String>,
    invariants_total: usize,
    invariants_passed: usize,
    invariants_failed: usize,
    changed_files: Vec<String>,
    changed_file_set: bool,
    replay_exact: bool,
    ast_parse: bool,
    top_level_conservation: bool,
    target_cardinality: bool,
    replace_node_confinement: bool,
    rename_identifier_delta: bool,
    rename_global_closure: bool,
    worktree_cleaned: bool,
    elapsed_ms: f64,
    checks: Vec<Check>,
}

impl Response {
    fn finish(
        started: Instant,
        changed_files: Vec<String>,
        checks: Vec<Check>,
        worktree_cleaned: bool,
        reason: Option<String>,
    ) -> Self {
        let invariants_total = checks.len();
        let invariants_passed = checks.iter().filter(|c| c.pass).count();
        let invariants_failed = invariants_total.saturating_sub(invariants_passed);
        let all_kind = |kind: &str| {
            checks.iter().filter(|c| c.kind == kind).all(|c| c.pass)
                && checks.iter().any(|c| c.kind == kind)
        };
        let changed_file_set = all_kind("changed_file_set");
        let replay_exact = all_kind("replay_exact");
        let ast_parse = all_kind("ast_parse");
        let top_level_conservation = all_kind("top_level_conservation");
        let target_cardinality = all_kind("target_cardinality");
        let replace_node_confinement = checks
            .iter()
            .filter(|c| c.kind == "replace_node_confinement")
            .all(|c| c.pass);
        let rename_identifier_delta = checks
            .iter()
            .filter(|c| c.kind == "rename_identifier_delta")
            .all(|c| c.pass);
        let rename_global_closure = checks
            .iter()
            .filter(|c| c.kind == "rename_global_closure")
            .all(|c| c.pass);
        let ok = reason.is_none() && invariants_failed == 0 && worktree_cleaned;
        Self {
            protocol: PROTOCOL,
            verification_protocol: VERIFICATION_PROTOCOL,
            ok,
            verdict: if ok { "PASS" } else { "FAIL" },
            reason: if ok {
                None
            } else {
                reason.or_else(|| Some("invariant_failed".to_string()))
            },
            invariants_total,
            invariants_passed,
            invariants_failed,
            changed_files,
            changed_file_set,
            replay_exact,
            ast_parse,
            top_level_conservation,
            target_cardinality,
            replace_node_confinement,
            rename_identifier_delta,
            rename_global_closure,
            worktree_cleaned,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            checks,
        }
    }
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
    let base = fs::canonicalize(root.join(".opencode/scout-handoffs"))
        .context("handoff_root_unavailable")?;
    anyhow::ensure!(candidate.starts_with(base), "handoff_path_escape");
    serde_json::from_slice(&fs::read(candidate).context("handoff_read_failed")?)
        .context("handoff_json_invalid")
}

fn validate_handoff_capability(handoff: &ScoutHandoff) -> std::result::Result<(), &'static str> {
    match handoff.scope_mode.as_deref() {
        None => Ok(()),
        Some("local_mutation_capability") => {
            let Some(capability) = handoff.capability.as_ref() else {
                return Err("local_capability_invalid");
            };
            let Some(target_file) = safe_rel(&capability.target.file) else {
                return Err("local_capability_invalid");
            };
            let Some(handoff_file) = handoff
                .files
                .first()
                .and_then(|value| safe_rel(&value.file))
            else {
                return Err("local_capability_invalid");
            };
            if handoff.capability_protocol.as_deref() != Some(LOCAL_CAPABILITY_PROTOCOL)
                || handoff.files.len() != 1
                || handoff.allowed_mutations.len() != 1
                || handoff.allowed_mutations[0] != "replace_node"
                || capability.protocol != LOCAL_CAPABILITY_PROTOCOL
                || capability.operation != "replace_node"
                || capability.target.symbol_name.is_empty()
                || target_file != handoff_file
            {
                return Err("local_capability_invalid");
            }
            Ok(())
        }
        Some(_) => Err("handoff_scope_mode_invalid"),
    }
}

fn handoff_allows_mutation(handoff: &ScoutHandoff, mutation: &Mutation) -> bool {
    match handoff.scope_mode.as_deref() {
        Some("local_mutation_capability") => {
            let Some(capability) = handoff.capability.as_ref() else {
                return false;
            };
            handoff
                .allowed_mutations
                .iter()
                .any(|value| value == &mutation.kind)
                && capability.operation == mutation.kind
                && capability.target.symbol_name == mutation.symbol
                && safe_rel(&capability.target.file) == safe_rel(&mutation.file)
        }
        None => true,
        Some(_) => false,
    }
}

fn run_git(root: &Path, args: &[&str]) -> Result<()> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .context("git_spawn_failed")?;
    anyhow::ensure!(
        out.status.success(),
        "git_failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}

fn run_git_output(root: &Path, args: &[&str], allow_one: bool) -> Result<String> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .context("git_spawn_failed")?;
    let code = out.status.code().unwrap_or(-1);
    anyhow::ensure!(
        code == 0 || (allow_one && code == 1),
        "git_failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn git_grep_files(root: &Path, symbol: &str) -> Result<BTreeSet<String>> {
    let out = run_git_output(root, &["grep", "-l", "-w", "--", symbol, "--", "."], true)?;
    Ok(out
        .lines()
        .filter_map(|line| safe_rel(line.trim()))
        .collect())
}

fn is_identifier_kind(kind: &str) -> bool {
    kind == "identifier"
        || kind.ends_with("_identifier")
        || kind == "shorthand_property_identifier_pattern"
}

fn structural_identifier_files(root: &Path, symbol: &str) -> Result<BTreeSet<String>> {
    let mut files = BTreeSet::new();
    for rel in git_grep_files(root, symbol)? {
        let path = root.join(&rel);
        let Some(lang) = SupportLang::from_path(&path) else {
            continue;
        };
        let source = fs::read_to_string(&path).context("closure_source_not_utf8")?;
        let ast = lang.ast_grep(&source);
        let root_node = ast.root();
        anyhow::ensure!(
            !root_node
                .clone()
                .dfs()
                .any(|node| node.is_error() || node.is_missing()),
            "closure_source_syntax_invalid:{rel}"
        );
        if root_node.dfs().any(|node| {
            node.is_named_leaf()
                && is_identifier_kind(node.kind().as_ref())
                && node.text().as_ref() == symbol
        }) {
            files.insert(rel);
        }
    }
    Ok(files)
}

fn unique_pos(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let mut it = haystack.match_indices(needle);
    let first = it.next()?.0;
    if it.next().is_some() {
        None
    } else {
        Some(first)
    }
}

fn replay_file(
    source: &str,
    edits: &[&Edit],
) -> std::result::Result<(String, Vec<(usize, usize)>), &'static str> {
    let mut current = source.to_string();
    let mut original_ranges = Vec::new();
    for edit in edits {
        if edit.before == edit.after {
            return Err("edit_contract_invalid");
        }
        if edit.kind == "replace_slice" {
            let confinement = edit
                .confinement
                .as_ref()
                .ok_or("slice_certificate_missing")?;
            if confinement.protocol != MUTATION_CONFINEMENT_PROTOCOL
                || confinement.start_byte >= confinement.end_byte
                || confinement.owner_start > confinement.start_byte
                || confinement.end_byte > confinement.owner_end
                || confinement.end_byte > current.len()
                || !current.is_char_boundary(confinement.start_byte)
                || !current.is_char_boundary(confinement.end_byte)
                || confinement.end_byte - confinement.start_byte != edit.before.len()
            {
                return Err("slice_certificate_invalid");
            }
            if &current[confinement.start_byte..confinement.end_byte] != edit.before.as_str() {
                return Err("slice_precondition_mismatch");
            }
            original_ranges.push((confinement.start_byte, confinement.end_byte));
            current.replace_range(confinement.start_byte..confinement.end_byte, &edit.after);
            continue;
        }
        if edit.kind != "replace_exact" || edit.confinement.is_some() {
            return Err("edit_contract_invalid");
        }
        let pos = unique_pos(&current, &edit.before).ok_or("edit_precondition_not_unique")?;
        if let Some(original_pos) = unique_pos(source, &edit.before) {
            original_ranges.push((original_pos, original_pos + edit.before.len()));
        }
        current.replace_range(pos..pos + edit.before.len(), &edit.after);
    }
    Ok((current, original_ranges))
}

fn parse_ok(path: &Path, source: &str) -> bool {
    let Some(lang) = SupportLang::from_path(path) else {
        return false;
    };
    let ast = lang.ast_grep(source);
    !ast.root()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
}

fn top_level_nodes(path: &Path, source: &str) -> Option<Vec<(String, String, usize, usize)>> {
    let lang = SupportLang::from_path(path)?;
    let ast = lang.ast_grep(source);
    let root = ast.root();
    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return None;
    }
    Some(
        root.children()
            .filter(|node| node.is_named())
            .map(|node| {
                let r = node.range();
                (
                    node.kind().to_string(),
                    node.text().to_string(),
                    r.start,
                    r.end,
                )
            })
            .collect(),
    )
}

fn top_level_conserved(
    path: &Path,
    before: &str,
    after: &str,
    edited_ranges: &[(usize, usize)],
) -> bool {
    let Some(a) = top_level_nodes(path, before) else {
        return false;
    };
    let Some(b) = top_level_nodes(path, after) else {
        return false;
    };
    if a.len() != b.len() {
        return false;
    }
    for (idx, left) in a.iter().enumerate() {
        let right = &b[idx];
        if left.0 != right.0 {
            return false;
        }
        let touched = edited_ranges
            .iter()
            .any(|(s, e)| *s < left.3 && *e > left.2);
        if !touched && left.1 != right.1 {
            return false;
        }
    }
    true
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

fn source_newline_style(source: &str) -> std::result::Result<&'static str, &'static str> {
    let has_crlf = source.contains("\r\n");
    let without_crlf = source.replace("\r\n", "");
    let has_bare_lf = without_crlf.contains('\n');
    if has_crlf && has_bare_lf {
        return Err("mutation_source_eol_mixed");
    }
    Ok(if has_crlf { "\r\n" } else { "\n" })
}

fn normalize_fragment_for_source(
    source: &str,
    fragment: &str,
) -> std::result::Result<String, &'static str> {
    let trimmed = fragment.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let normalized = trimmed.replace("\r\n", "\n");
    if normalized.contains('\r') {
        return Err("mutation_fragment_invalid");
    }
    if source_newline_style(source)? == "\r\n" {
        Ok(normalized.replace('\n', "\r\n"))
    } else {
        Ok(normalized)
    }
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

fn unique_definition_range(path: &Path, source: &str, symbol: &str) -> Option<Range<usize>> {
    let lang = SupportLang::from_path(path)?;
    let ast = lang.ast_grep(source);
    let root = ast.root();
    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return None;
    }
    let mut found = root.dfs().filter_map(|node| {
        if !node.is_named() || !is_definition_kind(node.kind().as_ref()) {
            return None;
        }
        let name = node.field("name")?;
        if name.text().as_ref() != symbol || node.field("body").is_none() {
            return None;
        }
        Some(node.range())
    });
    let first = found.next()?;
    if found.next().is_some() {
        None
    } else {
        Some(first)
    }
}

fn exact_slice_range(
    source: &str,
    owner: &Range<usize>,
    needle: &str,
) -> std::result::Result<Range<usize>, &'static str> {
    if needle.is_empty() || owner.start >= owner.end || owner.end > source.len() {
        return Err("mutation_slice_not_exact");
    }
    let haystack = &source[owner.clone()];
    let mut matches = haystack.match_indices(needle);
    let Some((relative_start, _)) = matches.next() else {
        return Err("mutation_slice_not_exact");
    };
    if matches.next().is_some() {
        return Err("mutation_slice_ambiguous");
    }
    let start = owner.start + relative_start;
    Ok(start..start + needle.len())
}

fn structural_slice_envelope(
    path: &Path,
    source: &str,
    owner: &Range<usize>,
    slice: &Range<usize>,
) -> std::result::Result<&'static str, &'static str> {
    if slice.start < owner.start || slice.end > owner.end || slice.start >= slice.end {
        return Err("mutation_slice_not_structural");
    }
    if slice.start == owner.start && slice.end == owner.end {
        return Ok("owner");
    }
    let lang = SupportLang::from_path(path).ok_or("language_unsupported")?;
    let ast = lang.ast_grep(source);
    let root = ast.root();
    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return Err("source_syntax_invalid");
    }
    for node in root.clone().dfs().filter(|node| node.is_named()) {
        let range = node.range();
        if range.start == slice.start && range.end == slice.end {
            return Ok("node");
        }
    }
    let mut saw_too_wide = false;
    for parent in root.dfs().filter(|node| node.is_named()) {
        let parent_range = parent.range();
        if parent_range.start > slice.start
            || parent_range.end < slice.end
            || parent_range.start < owner.start
            || parent_range.end > owner.end
        {
            continue;
        }
        let children = parent
            .children()
            .filter(|node| node.is_named())
            .map(|node| node.range())
            .collect::<Vec<_>>();
        for start_idx in 0..children.len() {
            if children[start_idx].start != slice.start {
                continue;
            }
            for end_idx in start_idx..children.len() {
                let count = end_idx - start_idx + 1;
                if count > MAX_STRUCTURAL_SLICE_NODES {
                    saw_too_wide = true;
                    break;
                }
                let end = children[end_idx].end;
                if end == slice.end {
                    return Ok("siblings");
                }
                if end > slice.end {
                    break;
                }
            }
        }
    }
    if saw_too_wide {
        Err("mutation_slice_too_wide")
    } else {
        Err("mutation_slice_not_structural")
    }
}

/*
 * Do not trust the compiler certificate as proof. Re-derive the owner,
 * canonical precondition slice, structural envelope, and formatted
 * replacement from the immutable baseline + original semantic mutation.
 */
fn verify_replace_node_confinement(
    path: &Path,
    source: &str,
    mutation_index: usize,
    mutation: &Mutation,
    edits: &[Edit],
) -> (bool, String) {
    let Some(before_raw) = mutation.before.as_deref() else {
        return (false, "mutation_before_missing".to_string());
    };
    let Some(replacement_raw) = mutation.replacement.as_deref() else {
        return (false, "mutation_replacement_missing".to_string());
    };
    let Some(owner) = unique_definition_range(path, source, &mutation.symbol) else {
        return (false, "owner_unavailable".to_string());
    };
    let before = match normalize_fragment_for_source(source, before_raw) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) => return (false, "mutation_before_empty".to_string()),
        Err(reason) => return (false, reason.to_string()),
    };
    let slice = match exact_slice_range(source, &owner, &before) {
        Ok(value) => value,
        Err(reason) => return (false, reason.to_string()),
    };
    let envelope = match structural_slice_envelope(path, source, &owner, &slice) {
        Ok(value) => value,
        Err(reason) => return (false, reason.to_string()),
    };
    let matching = edits
        .iter()
        .filter(|edit| {
            edit.confinement
                .as_ref()
                .map(|value| value.mutation_index == mutation_index)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return (false, format!("certified_edit_count={}", matching.len()));
    }
    let edit = matching[0];
    let Some(confinement) = edit.confinement.as_ref() else {
        return (false, "slice_certificate_missing".to_string());
    };
    if edit.kind != "replace_slice"
        || confinement.protocol != MUTATION_CONFINEMENT_PROTOCOL
        || confinement.owner_symbol != mutation.symbol
        || confinement.owner_start != owner.start
        || confinement.owner_end != owner.end
        || confinement.start_byte != slice.start
        || confinement.end_byte != slice.end
        || confinement.envelope != envelope
        || edit.before.as_str() != &source[slice.clone()]
    {
        return (false, "slice_certificate_mismatch".to_string());
    }
    let replacement = match normalize_fragment_for_source(source, replacement_raw) {
        Ok(value) => value,
        Err(reason) => return (false, reason.to_string()),
    };
    let formatted = format_node_replacement(source, &slice, &replacement);
    let formatted = match source_newline_style(source) {
        Ok("\r\n") => formatted.replace('\n', "\r\n"),
        Ok(_) => formatted,
        Err(reason) => return (false, reason.to_string()),
    };
    if edit.after != formatted {
        return (false, "compiled_replacement_mismatch".to_string());
    }
    (
        true,
        format!(
            "protocol={} envelope={} start={} end={} owner_start={} owner_end={}",
            MUTATION_CONFINEMENT_PROTOCOL, envelope, slice.start, slice.end, owner.start, owner.end,
        ),
    )
}

fn definition_count(path: &Path, source: &str, symbol: &str) -> usize {
    let Some(lang) = SupportLang::from_path(path) else {
        return 0;
    };
    let ast = lang.ast_grep(source);
    ast.root()
        .dfs()
        .filter(|node| {
            node.is_named()
                && is_definition_kind(node.kind().as_ref())
                && node
                    .field("name")
                    .map(|name| name.text().as_ref() == symbol)
                    .unwrap_or(false)
        })
        .count()
}

fn identifier_leaf_count(path: &Path, source: &str, text: &str) -> usize {
    let Some(lang) = SupportLang::from_path(path) else {
        return 0;
    };
    let ast = lang.ast_grep(source);
    ast.root()
        .dfs()
        .filter(|node| {
            node.is_named_leaf()
                && is_identifier_kind(node.kind().as_ref())
                && node.text().as_ref() == text
        })
        .count()
}

type ClosureBindingKey = (
    String,
    String,
    String,
    usize,
    String,
    String,
    String,
    String,
    bool,
);

fn closure_binding_key(
    binding: &SymbolClosureBinding,
    source_symbol: String,
    local_symbol: String,
) -> ClosureBindingKey {
    (
        binding.importer.clone(),
        binding.target.clone(),
        binding.kind.clone(),
        binding.witness_line,
        binding.spec.clone(),
        source_symbol,
        local_symbol,
        binding.confidence.clone(),
        binding.propagates,
    )
}

fn expected_after_closure_keys(
    before: &SymbolClosureResponse,
    new_name: &str,
) -> BTreeSet<ClosureBindingKey> {
    before
        .bindings
        .iter()
        .map(|binding| {
            let local = if binding.propagates {
                new_name.to_string()
            } else {
                binding.local_symbol.clone()
            };

            closure_binding_key(binding, new_name.to_string(), local)
        })
        .collect()
}

fn actual_closure_keys(after: &SymbolClosureResponse) -> BTreeSet<ClosureBindingKey> {
    after
        .bindings
        .iter()
        .map(|binding| {
            closure_binding_key(
                binding,
                binding.source_symbol.clone(),
                binding.local_symbol.clone(),
            )
        })
        .collect()
}

fn closure_topology_matches_rename(
    before: &SymbolClosureResponse,
    after: &SymbolClosureResponse,
    new_name: &str,
) -> bool {
    if !before.ready || !before.complete || !after.ready || !after.complete {
        return false;
    }

    if before.source_file != after.source_file {
        return false;
    }

    if after.source_symbol.as_deref() != Some(new_name) {
        return false;
    }

    let before_files = before.files.iter().cloned().collect::<BTreeSet<_>>();

    let after_files = after.files.iter().cloned().collect::<BTreeSet<_>>();

    if before_files != after_files {
        return false;
    }

    expected_after_closure_keys(before, new_name) == actual_closure_keys(after)
}

fn temp_worktree() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("opencode-invariant-{}-{nanos}", std::process::id()))
}

fn verify(request: &Request) -> Result<Response> {
    let started = Instant::now();
    let root = fs::canonicalize(&request.root).context("root_unavailable")?;
    let mut checks = Vec::<Check>::new();

    if request.compiler_protocol != COMPILER_PROTOCOL
        || request.mutation_protocol != MUTATION_PROTOCOL
    {
        return Ok(Response::finish(
            started,
            Vec::new(),
            checks,
            true,
            Some("protocol_mismatch".to_string()),
        ));
    }
    if request.edits.is_empty()
        || request.edits.len() > MAX_EDITS
        || request.changed_files.is_empty()
        || request.changed_files.len() > MAX_CHANGED_FILES
    {
        return Ok(Response::finish(
            started,
            Vec::new(),
            checks,
            true,
            Some("verification_contract_invalid".to_string()),
        ));
    }

    let handoff = load_handoff(&root, &request.handoff)?;
    // Compatibility is defined by the stable handoff schema.
    // search_protocol is provenance only and may evolve independently.
    if handoff.protocol != HANDOFF_PROTOCOL
        || handoff.status != "ready"
        || !handoff.blocking_reasons.is_empty()
        || !handoff.partial_reasons.is_empty()
    {
        return Ok(Response::finish(
            started,
            Vec::new(),
            checks,
            true,
            Some("handoff_not_ready".to_string()),
        ));
    }
    if let Err(reason) = validate_handoff_capability(&handoff) {
        return Ok(Response::finish(
            started,
            Vec::new(),
            checks,
            true,
            Some(reason.to_string()),
        ));
    }
    for mutation in &request.mutations {
        if !handoff_allows_mutation(&handoff, mutation) {
            return Ok(Response::finish(
                started,
                Vec::new(),
                checks,
                true,
                Some("mutation_not_authorized_by_handoff".to_string()),
            ));
        }
    }
    let mut certified_slice_files = BTreeSet::new();
    for edit in &request.edits {
        if edit.kind == "replace_slice" && !certified_slice_files.insert(edit.file.clone()) {
            return Ok(Response::finish(
                started,
                Vec::new(),
                checks,
                true,
                Some("mutation_slice_transaction_unsupported".to_string()),
            ));
        }
        if let Some(confinement) = edit.confinement.as_ref() {
            if edit.kind != "replace_slice"
                || confinement.protocol != MUTATION_CONFINEMENT_PROTOCOL
                || confinement.mutation_index >= request.mutations.len()
                || request.mutations[confinement.mutation_index].kind != "replace_node"
            {
                return Ok(Response::finish(
                    started,
                    Vec::new(),
                    checks,
                    true,
                    Some("slice_certificate_orphaned".to_string()),
                ));
            }
        }
    }
    let allowed = handoff
        .files
        .iter()
        .filter_map(|f| safe_rel(&f.file))
        .collect::<BTreeSet<_>>();
    let changed = request
        .changed_files
        .iter()
        .filter_map(|f| safe_rel(f))
        .collect::<BTreeSet<_>>();
    let edit_files = request
        .edits
        .iter()
        .filter_map(|e| safe_rel(&e.file))
        .collect::<BTreeSet<_>>();
    if changed.len() != request.changed_files.len()
        || changed != edit_files
        || !changed.is_subset(&allowed)
    {
        return Ok(Response::finish(
            started,
            changed.into_iter().collect(),
            checks,
            true,
            Some("scope_invariant_failed".to_string()),
        ));
    }

    /*
     * Resolve rename identity against the immutable baseline checkout before
     * applying any patch. Handoff is mutation authorization, not the source
     * of symbol identity.
     */
    let mut rename_closures = BTreeMap::<usize, SymbolClosureResponse>::new();

    for (idx, mutation) in request.mutations.iter().enumerate() {
        if mutation.kind != "rename_symbol" {
            continue;
        }

        let Some(file) = safe_rel(&mutation.file) else {
            checks.push(Check {
                kind: "rename_global_closure".to_string(),
                pass: false,
                file: None,
                detail: Some("unsafe rename source file".to_string()),
            });

            return Ok(Response::finish(
                started,
                changed.iter().cloned().collect(),
                checks,
                true,
                Some("rename_closure_contract_invalid".to_string()),
            ));
        };

        let closure = match resolve_symbol_closure(&root, &file, &mutation.symbol, 64) {
            Ok(value) => value,
            Err(err) => {
                checks.push(Check {
                    kind: "rename_global_closure".to_string(),
                    pass: false,
                    file: Some(file),
                    detail: Some(format!("baseline_resolution_failed:{err}")),
                });

                return Ok(Response::finish(
                    started,
                    changed.iter().cloned().collect(),
                    checks,
                    true,
                    Some("rename_closure_unproven".to_string()),
                ));
            }
        };

        let closure_files = closure.files.iter().cloned().collect::<BTreeSet<_>>();

        /*
         * A proven dependency outside the handoff means partial rename.
         * A proven dependency inside the handoff but absent from changed
         * files means the compiler failed to mutate the complete closure.
         */
        let scope_pass = closure.ready
            && closure.complete
            && closure_files.is_subset(&allowed)
            && closure_files.is_subset(&changed);

        checks.push(Check {
            kind: "rename_global_closure".to_string(),
            pass: scope_pass,
            file: Some(file.clone()),
            detail: Some(format!(
                "phase=baseline files={} outside_handoff={} unchanged={}",
                closure_files.len(),
                closure_files.difference(&allowed).count(),
                closure_files.difference(&changed).count(),
            )),
        });

        if !scope_pass {
            return Ok(Response::finish(
                started,
                changed.iter().cloned().collect(),
                checks,
                true,
                Some("rename_closure_incomplete".to_string()),
            ));
        }

        rename_closures.insert(idx, closure);
    }

    let mut before = BTreeMap::<String, String>::new();
    let mut expected = BTreeMap::<String, String>::new();
    let mut edit_ranges = BTreeMap::<String, Vec<(usize, usize)>>::new();
    for file in &changed {
        let path = root.join(file);
        let meta = fs::metadata(&path).context("changed_file_unavailable")?;
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            return Ok(Response::finish(
                started,
                changed.iter().cloned().collect(),
                checks,
                true,
                Some("changed_file_invalid".to_string()),
            ));
        }
        let source = fs::read_to_string(&path).context("changed_file_not_utf8")?;
        let file_edits = request
            .edits
            .iter()
            .filter(|e| safe_rel(&e.file).as_deref() == Some(file.as_str()))
            .collect::<Vec<_>>();
        let (after, ranges) = match replay_file(&source, &file_edits) {
            Ok(value) => value,
            Err(reason) => {
                return Ok(Response::finish(
                    started,
                    changed.iter().cloned().collect(),
                    checks,
                    true,
                    Some(reason.to_string()),
                ));
            }
        };
        before.insert(file.clone(), source);
        expected.insert(file.clone(), after);
        edit_ranges.insert(file.clone(), ranges);
    }

    let wt = temp_worktree();
    let wt_s = wt.to_string_lossy().to_string();
    run_git(
        &root,
        &["worktree", "add", "--detach", "--quiet", &wt_s, "HEAD"],
    )?;
    let verification = (|| -> Result<Option<String>> {
        for file in &changed {
            let wt_source =
                fs::read_to_string(wt.join(file)).context("worktree_file_unavailable")?;
            if wt_source != before[file] {
                return Ok(Some("worktree_baseline_mismatch".to_string()));
            }
        }
        let patch_file = wt.join(".opencode-v215.patch");
        fs::write(&patch_file, &request.patch).context("patch_temp_write_failed")?;
        let patch_s = patch_file.to_string_lossy().to_string();
        run_git(&wt, &["apply", "--whitespace=error-all", &patch_s])?;
        let _ = fs::remove_file(&patch_file);
        let diff_names = run_git_output(&wt, &["diff", "--name-only", "--no-ext-diff"], false)?
            .lines()
            .filter_map(|line| safe_rel(line.trim()))
            .collect::<BTreeSet<_>>();
        checks.push(Check {
            kind: "changed_file_set".to_string(),
            pass: diff_names == changed,
            file: None,
            detail: Some(format!(
                "actual={}",
                diff_names.into_iter().collect::<Vec<_>>().join(",")
            )),
        });

        for file in &changed {
            let actual = fs::read_to_string(wt.join(file)).context("patched_file_unavailable")?;
            let replay_pass = actual == expected[file];
            checks.push(Check {
                kind: "replay_exact".to_string(),
                pass: replay_pass,
                file: Some(file.clone()),
                detail: None,
            });
            let parse_pass = parse_ok(&wt.join(file), &actual);
            checks.push(Check {
                kind: "ast_parse".to_string(),
                pass: parse_pass,
                file: Some(file.clone()),
                detail: None,
            });
            let top_pass =
                top_level_conserved(&root.join(file), &before[file], &actual, &edit_ranges[file]);
            checks.push(Check {
                kind: "top_level_conservation".to_string(),
                pass: top_pass,
                file: Some(file.clone()),
                detail: None,
            });
        }

        for (mutation_idx, mutation) in request.mutations.iter().enumerate() {
            let Some(file) = safe_rel(&mutation.file) else {
                checks.push(Check {
                    kind: "target_cardinality".to_string(),
                    pass: false,
                    file: None,
                    detail: Some("unsafe mutation file".to_string()),
                });
                continue;
            };
            if !changed.contains(&file) {
                continue;
            }
            let before_src = &before[&file];
            let after_src =
                fs::read_to_string(wt.join(&file)).context("patched_target_unavailable")?;

            if mutation.kind == "replace_node" {
                let (pass, detail) = verify_replace_node_confinement(
                    &root.join(&file),
                    before_src,
                    mutation_idx,
                    mutation,
                    &request.edits,
                );
                checks.push(Check {
                    kind: "replace_node_confinement".to_string(),
                    pass,
                    file: Some(file.clone()),
                    detail: Some(detail),
                });
            }

            let before_defs = definition_count(&root.join(&file), before_src, &mutation.symbol);
            let target_pass = match mutation.kind.as_str() {
                "rename_symbol" => match mutation.new_name.as_deref() {
                    Some(new_name) => {
                        before_defs == 1
                            && definition_count(&wt.join(&file), &after_src, &mutation.symbol) == 0
                            && definition_count(&wt.join(&file), &after_src, new_name) == 1
                    }
                    None => false,
                },
                "replace_body" | "replace_expr" | "replace_node" => {
                    before_defs == 1
                        && definition_count(&wt.join(&file), &after_src, &mutation.symbol) == 1
                }
                _ => false,
            };
            checks.push(Check {
                kind: "target_cardinality".to_string(),
                pass: target_pass,
                file: Some(file.clone()),
                detail: Some(mutation.symbol.clone()),
            });

            if mutation.kind == "rename_symbol" {
                let Some(new_name) = mutation.new_name.as_deref() else {
                    continue;
                };

                let Some(baseline_closure) = rename_closures.get(&mutation_idx) else {
                    checks.push(Check {
                        kind: "rename_global_closure".to_string(),
                        pass: false,
                        file: Some(file.clone()),
                        detail: Some("baseline_closure_missing".to_string()),
                    });
                    continue;
                };

                /*
                 * Resolve the renamed symbol independently against the actual
                 * patched worktree. We compare dependency topology, not raw
                 * identifier spelling.
                 */
                let after_closure = resolve_symbol_closure(&wt, &file, new_name, 64);

                let (closure_pass, closure_detail) = match after_closure {
                    Ok(ref after) => {
                        let pass =
                            closure_topology_matches_rename(baseline_closure, after, new_name);

                        (
                            pass,
                            format!(
                                "phase=patched before_files={} \
                                     after_files={} before_bindings={} \
                                     after_bindings={} complete={}",
                                baseline_closure.files.len(),
                                after.files.len(),
                                baseline_closure.bindings.len(),
                                after.bindings.len(),
                                after.complete,
                            ),
                        )
                    }

                    Err(ref err) => (false, format!("patched_resolution_failed:{err}")),
                };

                checks.push(Check {
                    kind: "rename_global_closure".to_string(),
                    pass: closure_pass,
                    file: Some(file.clone()),
                    detail: Some(closure_detail),
                });

                /*
                 * Secondary conservation invariant only.
                 *
                 * This is deliberately NOT symbol identity proof: unrelated
                 * or shadowed same-name identifiers may remain. It checks that
                 * the emitted patch conserves the number of renamed
                 * identifier leaves overall.
                 */
                let mut old_before = 0usize;
                let mut old_after = 0usize;
                let mut new_before = 0usize;
                let mut new_after = 0usize;

                for f in &changed {
                    old_before +=
                        identifier_leaf_count(&root.join(f), &before[f], &mutation.symbol);

                    new_before += identifier_leaf_count(&root.join(f), &before[f], new_name);

                    let aft = fs::read_to_string(wt.join(f))
                        .context("patched_rename_file_unavailable")?;

                    old_after += identifier_leaf_count(&wt.join(f), &aft, &mutation.symbol);

                    new_after += identifier_leaf_count(&wt.join(f), &aft, new_name);
                }

                let removed = old_before.saturating_sub(old_after);

                let added = new_after.saturating_sub(new_before);

                let delta_pass = removed > 0 && removed == added;

                checks.push(Check {
                    kind: "rename_identifier_delta".to_string(),
                    pass: delta_pass,
                    file: Some(file.clone()),
                    detail: Some(format!("removed={removed} added={added}")),
                });
            }
        }

        if checks.iter().any(|c| !c.pass) {
            return Ok(Some("invariant_failed".to_string()));
        }
        Ok(None)
    })();

    let cleanup_ok = Command::new("git")
        .current_dir(&root)
        .args(["worktree", "remove", "--force", &wt_s])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let prune_ok = Command::new("git")
        .current_dir(&root)
        .args(["worktree", "prune"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let cleaned = cleanup_ok && prune_ok && !wt.exists();

    let reason = match verification {
        Ok(value) => value,
        Err(err) => Some(format!("verification_runtime_failed:{err}")),
    };
    Ok(Response::finish(
        started,
        changed.into_iter().collect(),
        checks,
        cleaned,
        reason,
    ))
}

fn read_request() -> Result<Request> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    serde_json::from_str(&input).context("invalid request json")
}

fn main() -> Result<()> {
    let request = read_request()?;
    let response = verify(&request)?;
    serde_json::to_writer(io::stdout(), &response)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_rejects_ambiguous_precondition() {
        let edit = Edit {
            file: "a.py".into(),
            kind: "replace_exact".into(),
            before: "x".into(),
            after: "y".into(),
            confinement: None,
        };
        assert_eq!(
            replay_file("x\nx\n", &[&edit]),
            Err("edit_precondition_not_unique")
        );
    }

    #[test]
    fn top_level_conservation_allows_target_body_change() {
        let before = "def a():\n    return 1\n\ndef b():\n    return 2\n";
        let after = "def a():\n    return 3\n\ndef b():\n    return 2\n";
        let start = before.find("def a").unwrap();
        let end = before.find("\ndef b").unwrap();
        assert!(top_level_conserved(
            Path::new("x.py"),
            before,
            after,
            &[(start, end)]
        ));
    }

    #[test]
    fn top_level_conservation_rejects_sibling_drift() {
        let before = "def a():\n    return 1\n\ndef b():\n    return 2\n";
        let after = "def a():\n    return 3\n\ndef b():\n    return 9\n";
        let start = before.find("def a").unwrap();
        let end = before.find("\ndef b").unwrap();
        assert!(!top_level_conserved(
            Path::new("x.py"),
            before,
            after,
            &[(start, end)]
        ));
    }

    #[test]
    fn definition_cardinality_is_structural() {
        let source = "def alpha():\n    return 1\n\ndef beta():\n    return alpha()\n";
        assert_eq!(definition_count(Path::new("x.py"), source, "alpha"), 1);
        assert_eq!(definition_count(Path::new("x.py"), source, "missing"), 0);
    }

    #[test]
    fn identifier_leaf_count_ignores_string_and_comment_contents() {
        let source = "def alpha():\n    note = \"alpha\"\n    return 1  # alpha\n";
        assert_eq!(identifier_leaf_count(Path::new("x.py"), source, "alpha"), 1);
    }

    #[test]
    fn identifier_kind_gate_excludes_literal_content() {
        assert!(is_identifier_kind("identifier"));
        assert!(is_identifier_kind("property_identifier"));
        assert!(is_identifier_kind("field_identifier"));
        assert!(is_identifier_kind("shorthand_property_identifier_pattern"));
        assert!(!is_identifier_kind("string_content"));
        assert!(!is_identifier_kind("comment"));
    }

    #[test]
    fn safe_paths_reject_runtime_state() {
        assert_eq!(safe_rel("src/a.py").as_deref(), Some("src/a.py"));
        assert!(safe_rel("../a.py").is_none());
        assert!(safe_rel(".opencode/x").is_none());
    }

    fn test_binding(
        importer: &str,
        target: &str,
        source: &str,
        local: &str,
        propagates: bool,
    ) -> SymbolClosureBinding {
        SymbolClosureBinding {
            importer: importer.to_string(),
            target: target.to_string(),
            kind: "python_from".to_string(),
            witness_line: 1,
            spec: target.trim_end_matches(".py").to_string(),
            source_symbol: source.to_string(),
            local_symbol: local.to_string(),
            witness: String::new(),
            confidence: "exact_local".to_string(),
            propagates,
        }
    }

    fn test_closure(symbol: &str, bindings: Vec<SymbolClosureBinding>) -> SymbolClosureResponse {
        let mut files = BTreeSet::new();
        files.insert("source.py".to_string());

        for binding in &bindings {
            files.insert(binding.importer.clone());
        }

        SymbolClosureResponse {
            protocol: "impact-index-v1",
            mode: "symbol_closure",
            ready: true,
            complete: true,
            reason: None,
            source_file: Some("source.py".to_string()),
            source_symbol: Some(symbol.to_string()),
            states_visited: bindings.len() + 1,
            bindings,
            files: files.into_iter().collect(),
            refresh_performed: true,
            elapsed_ms: 0.0,
        }
    }

    #[test]
    fn closure_topology_preserves_alias_local_name() {
        let before = test_closure(
            "price",
            vec![
                test_binding("direct.py", "source.py", "price", "price", true),
                test_binding("alias.py", "source.py", "price", "p", false),
            ],
        );

        let after = test_closure(
            "calculate_price",
            vec![
                test_binding(
                    "direct.py",
                    "source.py",
                    "calculate_price",
                    "calculate_price",
                    true,
                ),
                test_binding("alias.py", "source.py", "calculate_price", "p", false),
            ],
        );

        assert!(closure_topology_matches_rename(
            &before,
            &after,
            "calculate_price",
        ));
    }

    #[test]
    fn closure_topology_rejects_alias_local_drift() {
        let before = test_closure(
            "price",
            vec![test_binding("alias.py", "source.py", "price", "p", false)],
        );

        let after = test_closure(
            "calculate_price",
            vec![test_binding(
                "alias.py",
                "source.py",
                "calculate_price",
                "calculate_price",
                false,
            )],
        );

        assert!(!closure_topology_matches_rename(
            &before,
            &after,
            "calculate_price",
        ));
    }

    #[test]
    fn closure_topology_rejects_missing_transitive_edge() {
        let before = test_closure(
            "price",
            vec![
                test_binding("direct.py", "source.py", "price", "price", true),
                test_binding("consumer.py", "direct.py", "price", "price", true),
            ],
        );

        let after = test_closure(
            "calculate_price",
            vec![test_binding(
                "direct.py",
                "source.py",
                "calculate_price",
                "calculate_price",
                true,
            )],
        );

        assert!(!closure_topology_matches_rename(
            &before,
            &after,
            "calculate_price",
        ));
    }
}
