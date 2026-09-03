use anyhow::{Context, Result};
use ast_grep_core::{Pattern, matcher::MatcherExt};
use ast_grep_language::{Language, LanguageExt, SupportLang};
use opencode_evidence_distiller::candidate_hygiene::audit_candidate_hygiene;
use opencode_evidence_distiller::crypto_hash::sha256_file;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const PROTOCOL: &str = "patch-executor-v3";
const HANDOFF_PROTOCOL: &str = "scout-handoff-v1";
const BASE_STATE_PROTOCOL: &str = "sealed-base-state-v1";
const LOCAL_CAPABILITY_PROTOCOL: &str = "scout-local-capability-v1";
const ADDITIVE_CAPABILITY_PROTOCOL: &str = "scout-additive-capability-v1";
const MUTATION_CONFINEMENT_PROTOCOL: &str = "mutation-slice-v1";
const EDIT_PROTOCOL: &str = "edit-script-v3-certified-slice";
const MODE: &str = "guarded";
const MAX_EDITS: usize = 8;
const LEGACY_MAX_EDITS: usize = 4;
const MAX_HANDOFF_FILES: usize = 16;
const MAX_CHANGED_FILES: usize = 5;
const LEGACY_MAX_CHANGED_FILES: usize = 2;
const MAX_CHANGED_LINES: usize = 240;
const LEGACY_MAX_CHANGED_LINES: usize = 120;
const ADDITIVE_MAX_CREATE_DEPTH: usize = 2;
const MAX_CHECKS: usize = 8;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BEFORE_BYTES: usize = 16 * 1024;
const MAX_AFTER_BYTES: usize = 32 * 1024;
const MAX_CHECK_BYTES: usize = 4 * 1024;
const MAX_PATCH_BYTES: usize = 64 * 1024;
const MAX_EVIDENCE_DISTANCE_LINES: usize = 96;
const DJLINT_TEMPLATE_HYGIENE_PROTOCOL: &str = "djlint-template-hygiene-v1";
const DJLINT_RUNTIME_WRAPPER: &str = "opencode-djlint";
const MAX_DJLINT_DIAGNOSTIC_CHARS: usize = 1200;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    handoff: String,
    mode: String,
    edit_protocol: String,
    edits: Vec<Edit>,
    #[serde(default)]
    checks: Vec<Postcondition>,
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct BasePrecondition {
    protocol: String,
    state: String,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Edit {
    file: String,
    kind: String,
    before: String,
    after: String,
    #[serde(default)]
    confinement: Option<SliceConfinement>,
    #[serde(default)]
    base: Option<BasePrecondition>,
}

#[derive(Debug, Deserialize)]
struct Postcondition {
    file: String,
    kind: String,
    value: String,
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
    additive_capability: Option<AdditiveMutationCapability>,
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

#[derive(Debug, Clone, Deserialize)]
struct AdditiveMutationCapability {
    protocol: String,
    operation: String,
    #[serde(default)]
    existing_slots: Vec<AdditiveExistingSlot>,
    #[serde(default)]
    create_slots: Vec<AdditiveCreateSlot>,
}

#[derive(Debug, Clone, Deserialize)]
struct AdditiveExistingSlot {
    slot: String,
    file: String,
    sha256: String,
    #[serde(default)]
    evidence_lines: Vec<usize>,
    #[serde(default)]
    allowed_operations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AdditiveCreateSlot {
    slot: String,
    root: String,
    source_file: String,
    source_sha256: String,
    #[serde(default)]
    allowed_extensions: Vec<String>,
    max_depth: usize,
    #[serde(default)]
    allowed_operations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct HandoffFile {
    file: String,
    #[serde(default)]
    evidence_lines: Vec<usize>,
    fingerprint: Fingerprint,
}

#[derive(Debug, Clone, Deserialize)]
struct Fingerprint {
    kind: String,
    strong: bool,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    evidence_fresh: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
struct ChangeSummary {
    file: String,
    before_sha256: String,
    after_sha256: String,
    first_edit_line: usize,
    nearest_evidence_distance: usize,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    mode: String,
    edit_protocol: String,
    admitted: bool,
    reason: Option<String>,
    handoff_protocol: Option<String>,
    handoff_status: Option<String>,
    blocking_reasons: Vec<String>,
    partial_reasons: Vec<String>,
    allowed_files: Vec<String>,
    verified_files: usize,
    edits_requested: usize,
    edits_accepted: usize,
    structural_edits: usize,
    changed_files: Vec<String>,
    changed_lines: usize,
    changes: Vec<ChangeSummary>,
    syntax_checked_files: Vec<String>,
    postconditions_checked: usize,
    git_diff_check: bool,
    git_apply_check: bool,
    worktree_used: bool,
    worktree_cleaned: bool,
    patch_bytes: usize,
    patch: Option<String>,
    repo_mutated: bool,
    elapsed_ms: f64,
}

impl Response {
    fn rejected(started: Instant, request: &Request, reason: impl Into<String>) -> Self {
        Self {
            protocol: PROTOCOL,
            mode: request.mode.clone(),
            edit_protocol: request.edit_protocol.clone(),
            admitted: false,
            reason: Some(reason.into()),
            handoff_protocol: None,
            handoff_status: None,
            blocking_reasons: Vec::new(),
            partial_reasons: Vec::new(),
            allowed_files: Vec::new(),
            verified_files: 0,
            edits_requested: request.edits.len(),
            edits_accepted: 0,
            structural_edits: 0,
            changed_files: Vec::new(),
            changed_lines: 0,
            changes: Vec::new(),
            syntax_checked_files: Vec::new(),
            postconditions_checked: 0,
            git_diff_check: false,
            git_apply_check: false,
            worktree_used: false,
            worktree_cleaned: true,
            patch_bytes: 0,
            patch: None,
            repo_mutated: false,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        }
    }
}

struct Worktree {
    root: PathBuf,
    path: PathBuf,
    parent: PathBuf,
    active: bool,
}

impl Worktree {
    fn create(root: &Path) -> Result<Self> {
        let top = Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .context("cannot resolve git toplevel")?;
        anyhow::ensure!(top.status.success(), "project root is not a git worktree");
        let top_text = String::from_utf8(top.stdout).context("git toplevel is not UTF-8")?;
        let top_path =
            fs::canonicalize(top_text.trim()).context("cannot canonicalize git toplevel")?;
        anyhow::ensure!(top_path == root, "project root must equal git toplevel");

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let parent = env::temp_dir().join(format!(
            "opencode-patch-worktree-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
        let path = parent.join("tree");
        let output = Command::new("git")
            .current_dir(root)
            .args(["worktree", "add", "--detach", "--quiet"])
            .arg(&path)
            .arg("HEAD")
            .output()
            .context("cannot create detached worktree")?;
        if !output.status.success() {
            let _ = fs::remove_dir_all(&parent);
            anyhow::bail!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(Self {
            root: root.to_path_buf(),
            path,
            parent,
            active: true,
        })
    }

    fn cleanup(&mut self) -> bool {
        if !self.active {
            return true;
        }
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(["worktree", "remove", "--force"])
            .arg(&self.path)
            .output();
        let ok = output.map(|value| value.status.success()).unwrap_or(false);
        if ok {
            self.active = false;
            let _ = fs::remove_dir_all(&self.parent);
            let _ = Command::new("git")
                .current_dir(&self.root)
                .args(["worktree", "prune"])
                .status();
        }
        ok
    }
}

impl Drop for Worktree {
    fn drop(&mut self) {
        if self.active {
            let _ = Command::new("git")
                .current_dir(&self.root)
                .args(["worktree", "remove", "--force"])
                .arg(&self.path)
                .status();
            let _ = fs::remove_dir_all(&self.parent);
            let _ = Command::new("git")
                .current_dir(&self.root)
                .args(["worktree", "prune"])
                .status();
            self.active = false;
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
    if rel.starts_with(".opencode/")
        || rel == ".opencode"
        || rel.starts_with(".git/")
        || rel == ".git"
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

fn count_exact(haystack: &str, needle: &str) -> (usize, Option<usize>) {
    if needle.is_empty() {
        return (0, None);
    }
    let mut count = 0usize;
    let mut first = None;
    for (idx, _) in haystack.match_indices(needle) {
        count += 1;
        if first.is_none() {
            first = Some(idx);
        }
        if count > 1 {
            break;
        }
    }
    (count, first)
}

fn line_for_byte(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte.min(text.len())]
        .iter()
        .filter(|value| **value == b'\n')
        .count()
        + 1
}

fn nearest_evidence_distance(line: usize, evidence: &[usize]) -> Option<usize> {
    evidence
        .iter()
        .copied()
        .filter(|value| *value > 0)
        .map(|value| value.abs_diff(line))
        .min()
}

fn syntax_is_valid(path: &Path, source: &str) -> Option<bool> {
    let lang = SupportLang::from_path(path)?;
    let ast = lang.ast_grep(source);
    let root = ast.root();
    Some(!root.dfs().any(|node| node.is_error() || node.is_missing()))
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

fn certified_owner_matches(
    path: &Path,
    source: &str,
    symbol: &str,
    owner_start: usize,
    owner_end: usize,
) -> bool {
    let Some(lang) = SupportLang::from_path(path) else {
        return false;
    };
    let ast = lang.ast_grep(source);
    let root = ast.root();
    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return false;
    }
    let mut matches = root.dfs().filter(|node| {
        if !node.is_named() || !is_definition_kind(node.kind().as_ref()) {
            return false;
        }
        let range = node.range();
        range.start == owner_start
            && range.end == owner_end
            && node
                .field("name")
                .map(|name| name.text().as_ref() == symbol)
                .unwrap_or(false)
            && node.field("body").is_some()
    });
    matches.next().is_some() && matches.next().is_none()
}

fn structural_match_range(
    path: &Path,
    source: &str,
    pattern_source: &str,
    evidence: &[usize],
) -> std::result::Result<(usize, usize, usize, usize), &'static str> {
    if evidence.iter().all(|line| *line == 0) {
        return Err("evidence_anchor_missing");
    }
    let lang = SupportLang::from_path(path).ok_or("syntax_language_unsupported")?;
    let pattern = Pattern::try_new(pattern_source, lang).map_err(|_| "ast_pattern_invalid")?;
    if !pattern.defined_vars().is_empty() {
        return Err("ast_metavariables_unsupported");
    }
    let ast = lang.ast_grep(source);
    let root = ast.root();
    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return Err("source_syntax_invalid");
    }

    let mut local_matches = Vec::new();
    for node in root.dfs().filter(|node| node.is_named()) {
        if pattern.match_node(node.clone()).is_none() {
            continue;
        }
        let line = node.start_pos().line() + 1;
        let Some(distance) = nearest_evidence_distance(line, evidence) else {
            return Err("evidence_anchor_missing");
        };
        if distance <= MAX_EVIDENCE_DISTANCE_LINES {
            let range = node.range();
            local_matches.push((range.start, range.end, line, distance));
            if local_matches.len() > 1 {
                return Err("ast_precondition_ambiguous");
            }
        }
    }
    local_matches
        .into_iter()
        .next()
        .ok_or("ast_precondition_not_found")
}

fn git_apply_check(root: &Path, patch: &str) -> Result<bool> {
    let mut child = Command::new("git")
        .current_dir(root)
        .args(["apply", "--check", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("cannot run git apply --check")?;
    child
        .stdin
        .as_mut()
        .context("git apply stdin unavailable")?
        .write_all(patch.as_bytes())?;
    let output = child.wait_with_output()?;
    Ok(output.status.success())
}

fn git_patch(root: &Path, files: &[String], created: &BTreeSet<String>) -> Result<String> {
    if !created.is_empty() {
        let mut add = Command::new("git");
        add.current_dir(root).args(["add", "-N", "--"]);
        for file in created {
            add.arg(file);
        }
        let output = add.output().context("cannot stage intent-to-add")?;
        anyhow::ensure!(output.status.success(), "git add -N failed");
    }
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args([
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        "--",
    ]);
    for file in files {
        cmd.arg(file);
    }
    let output = cmd.output().context("cannot produce worktree diff")?;
    anyhow::ensure!(output.status.success(), "git diff failed");
    String::from_utf8(output.stdout).context("git diff output is not UTF-8")
}

fn changed_line_count(patch: &str) -> usize {
    patch
        .lines()
        .filter(|line| {
            (line.starts_with('+') && !line.starts_with("+++ "))
                || (line.starts_with('-') && !line.starts_with("--- "))
        })
        .count()
}

fn postcondition_holds(kind: &str, source: &str, value: &str) -> Option<bool> {
    match kind {
        "contains_exact" => Some(source.contains(value)),
        "not_contains_exact" => Some(!source.contains(value)),
        _ => None,
    }
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
    anyhow::ensure!(handoff_root.starts_with(root), "handoff_root_escape");
    anyhow::ensure!(candidate.starts_with(&handoff_root), "handoff_path_escape");
    let bytes = fs::read(&candidate).context("handoff_read_failed")?;
    serde_json::from_slice(&bytes).context("handoff_json_invalid")
}

fn extension_with_dot(rel: &str) -> Option<String> {
    let ext = Path::new(rel).extension()?.to_str()?;
    if ext.is_empty() {
        None
    } else {
        Some(format!(".{ext}").to_ascii_lowercase())
    }
}

fn additive_create_slot_allows(slot: &AdditiveCreateSlot, rel: &str) -> bool {
    if slot.slot.is_empty()
        || !slot.allowed_operations.iter().any(|op| op == "create_file")
        || slot.max_depth == 0
        || slot.max_depth > ADDITIVE_MAX_CREATE_DEPTH
    {
        return false;
    }
    let Some(root) = safe_rel(&slot.root) else {
        return false;
    };
    let Some(file) = safe_rel(rel) else {
        return false;
    };
    let prefix = format!("{root}/");
    let Some(local) = file.strip_prefix(&prefix) else {
        return false;
    };
    if local.is_empty() || local.split('/').count() > slot.max_depth {
        return false;
    }
    let Some(ext) = extension_with_dot(&file) else {
        return false;
    };
    slot.allowed_extensions
        .iter()
        .any(|value| value.eq_ignore_ascii_case(&ext))
}

fn validate_additive_handoff(handoff: &ScoutHandoff) -> std::result::Result<(), &'static str> {
    let Some(capability) = handoff.additive_capability.as_ref() else {
        return Err("additive_capability_invalid");
    };
    if handoff.capability_protocol.as_deref() != Some(ADDITIVE_CAPABILITY_PROTOCOL)
        || capability.protocol != ADDITIVE_CAPABILITY_PROTOCOL
        || capability.operation != "additive_surface"
        || capability.existing_slots.is_empty()
        || capability.existing_slots.len() > MAX_CHANGED_FILES.saturating_sub(1)
        || capability.create_slots.is_empty()
        || capability.create_slots.len() > 2
        || !handoff
            .allowed_mutations
            .iter()
            .any(|value| value == "replace_exact")
        || !handoff
            .allowed_mutations
            .iter()
            .any(|value| value == "create_file")
    {
        return Err("additive_capability_invalid");
    }

    let files = handoff
        .files
        .iter()
        .filter_map(|row| safe_rel(&row.file).map(|rel| (rel, row)))
        .collect::<BTreeMap<_, _>>();

    for slot in &capability.existing_slots {
        let Some(rel) = safe_rel(&slot.file) else {
            return Err("additive_existing_slot_invalid");
        };
        let Some(row) = files.get(&rel) else {
            return Err("additive_existing_slot_invalid");
        };
        if slot.slot.is_empty()
            || slot.sha256.len() != 64
            || !slot.sha256.chars().all(|c| c.is_ascii_hexdigit())
            || !slot
                .allowed_operations
                .iter()
                .any(|op| op == "replace_exact")
            || row.fingerprint.kind != "sha256"
            || !row.fingerprint.strong
            || row.fingerprint.evidence_fresh != Some(true)
            || row
                .fingerprint
                .sha256
                .as_deref()
                .map(|v| v.eq_ignore_ascii_case(&slot.sha256))
                != Some(true)
            || slot.evidence_lines.is_empty()
        {
            return Err("additive_existing_slot_invalid");
        }
    }

    for slot in &capability.create_slots {
        let Some(source) = safe_rel(&slot.source_file) else {
            return Err("additive_create_slot_invalid");
        };
        let Some(root) = safe_rel(&slot.root) else {
            return Err("additive_create_slot_invalid");
        };
        let Some(row) = files.get(&source) else {
            return Err("additive_create_slot_invalid");
        };
        if slot.slot.is_empty()
            || slot.source_sha256.len() != 64
            || !slot.source_sha256.chars().all(|c| c.is_ascii_hexdigit())
            || slot.allowed_extensions.is_empty()
            || slot.max_depth == 0
            || slot.max_depth > ADDITIVE_MAX_CREATE_DEPTH
            || !slot.allowed_operations.iter().any(|op| op == "create_file")
            || Path::new(&source)
                .parent()
                .and_then(normalize_rel)
                .as_deref()
                != Some(root.as_str())
            || row.fingerprint.kind != "sha256"
            || !row.fingerprint.strong
            || row.fingerprint.evidence_fresh != Some(true)
            || row
                .fingerprint
                .sha256
                .as_deref()
                .map(|v| v.eq_ignore_ascii_case(&slot.source_sha256))
                != Some(true)
        {
            return Err("additive_create_slot_invalid");
        }
    }
    Ok(())
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
        Some("additive_mutation_capability") => validate_additive_handoff(handoff),
        Some(_) => Err("handoff_scope_mode_invalid"),
    }
}

fn handoff_allows_edit(handoff: &ScoutHandoff, rel: &str, edit: &Edit) -> bool {
    match handoff.scope_mode.as_deref() {
        Some("local_mutation_capability") => {
            let Some(capability) = handoff.capability.as_ref() else {
                return false;
            };
            let Some(confinement) = edit.confinement.as_ref() else {
                return false;
            };
            edit.kind == "replace_slice"
                && safe_rel(&capability.target.file).as_deref() == Some(rel)
                && confinement.owner_symbol == capability.target.symbol_name
        }
        Some("additive_mutation_capability") => {
            let Some(capability) = handoff.additive_capability.as_ref() else {
                return false;
            };
            if edit.kind == "replace_exact" && edit.confinement.is_none() {
                return capability.existing_slots.iter().any(|slot| {
                    safe_rel(&slot.file).as_deref() == Some(rel)
                        && slot
                            .allowed_operations
                            .iter()
                            .any(|op| op == "replace_exact")
                });
            }
            if edit.kind == "create_file" && edit.confinement.is_none() {
                return capability
                    .create_slots
                    .iter()
                    .any(|slot| additive_create_slot_allows(slot, rel));
            }
            false
        }
        None => true,
        Some(_) => false,
    }
}

fn safe_new_file_for_handoff(root: &Path, handoff: &ScoutHandoff, rel: &str) -> Option<PathBuf> {
    let capability = handoff.additive_capability.as_ref()?;
    let slot = capability
        .create_slots
        .iter()
        .find(|slot| additive_create_slot_allows(slot, rel))?;
    let safe = safe_rel(rel)?;
    let target = root.join(&safe);
    if target.exists() {
        return None;
    }
    let parent = fs::canonicalize(target.parent()?).ok()?;
    let create_root_rel = safe_rel(&slot.root)?;
    let create_root = fs::canonicalize(root.join(create_root_rel)).ok()?;
    if parent != create_root && !parent.starts_with(&create_root) {
        return None;
    }
    Some(target)
}

fn valid_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_existing_base_file(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = safe_rel(rel)?;
    let root = fs::canonicalize(root).ok()?;
    if !root.is_dir() {
        return None;
    }

    let mut current = root.clone();
    let components = Path::new(&rel).components().collect::<Vec<_>>();

    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return None;
        };
        current.push(part);

        let metadata = fs::symlink_metadata(&current).ok()?;
        if metadata.file_type().is_symlink() {
            return None;
        }

        let final_component = index + 1 == components.len();
        if final_component {
            if !metadata.file_type().is_file() || metadata.len() > MAX_FILE_BYTES {
                return None;
            }
        } else if !metadata.file_type().is_dir() {
            return None;
        }
    }

    Some(current)
}

fn path_is_absent_without_symlink(root: &Path, rel: &str) -> bool {
    let Some(rel) = safe_rel(rel) else {
        return false;
    };
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    if !root.is_dir() {
        return false;
    }

    let components = Path::new(&rel).components().collect::<Vec<_>>();
    if components.is_empty() {
        return false;
    }

    let mut current = root;
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return false;
        };
        current.push(part);

        let final_component = index + 1 == components.len();
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return false;
                }
                if final_component {
                    return false;
                }
                if !metadata.file_type().is_dir() {
                    return false;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                /*
                 * A create target is only authorized below an already-attested
                 * existing directory. Missing parents are not created as an
                 * OCC side effect; the additive capability owns that policy.
                 */
                return final_component;
            }
            Err(_) => return false,
        }
    }

    false
}

fn validate_base_preconditions(
    root: &Path,
    allowed: &BTreeMap<String, HandoffFile>,
    edits: &[Edit],
) -> std::result::Result<(), &'static str> {
    let mut by_file = BTreeMap::<String, BasePrecondition>::new();

    for edit in edits {
        let rel = safe_rel(&edit.file).ok_or("base_precondition_file_invalid")?;
        let base = edit.base.as_ref().ok_or("base_precondition_missing")?;

        if base.protocol != BASE_STATE_PROTOCOL {
            return Err("base_precondition_protocol_invalid");
        }

        if let Some(previous) = by_file.get(&rel) {
            if previous != base {
                return Err("base_precondition_conflict");
            }
        } else {
            by_file.insert(rel.clone(), base.clone());
        }

        if edit.kind == "create_file" {
            if base.state != "absent" || base.sha256.is_some() {
                return Err("base_precondition_state_invalid");
            }
            if !path_is_absent_without_symlink(root, &rel) {
                return Err("base_path_state_mismatch");
            }
            continue;
        }

        if base.state != "existing_regular_file" {
            return Err("base_precondition_state_invalid");
        }

        let expected_sha = base
            .sha256
            .as_deref()
            .ok_or("base_precondition_hash_invalid")?;
        if !valid_sha256_hex(expected_sha) {
            return Err("base_precondition_hash_invalid");
        }

        let handoff_file = allowed
            .get(&rel)
            .ok_or("base_precondition_handoff_mismatch")?;
        let fingerprint = &handoff_file.fingerprint;
        let handoff_sha = fingerprint
            .sha256
            .as_deref()
            .ok_or("base_precondition_handoff_mismatch")?;

        if fingerprint.kind != "sha256"
            || !fingerprint.strong
            || fingerprint.evidence_fresh != Some(true)
            || !handoff_sha.eq_ignore_ascii_case(expected_sha)
        {
            return Err("base_precondition_handoff_mismatch");
        }

        let path = safe_existing_base_file(root, &rel).ok_or("base_path_state_mismatch")?;
        let actual_sha = sha256_file(&path).map_err(|_| "base_state_unreadable")?;

        if !actual_sha.eq_ignore_ascii_case(expected_sha) {
            return Err("base_state_stale");
        }
    }

    Ok(())
}

fn main_sources_unchanged(
    root: &Path,
    expected: &BTreeMap<String, HandoffFile>,
    files: &BTreeSet<String>,
    created: &BTreeSet<String>,
) -> bool {
    files.iter().all(|rel| {
        if created.contains(rel) {
            return path_is_absent_without_symlink(root, rel);
        }
        let Some(handoff_file) = expected.get(rel) else {
            return false;
        };
        let Some(expected_sha) = handoff_file.fingerprint.sha256.as_deref() else {
            return false;
        };
        let Some(path) = safe_existing_file(root, rel) else {
            return false;
        };
        sha256_file(&path)
            .map(|actual| actual.eq_ignore_ascii_case(expected_sha))
            .unwrap_or(false)
    })
}

#[derive(Debug, Serialize)]
struct DjlintTemplateHygiene {
    protocol: &'static str,
    applied: bool,
    files: Vec<String>,
    profiles: BTreeMap<String, Vec<String>>,
}

fn djlint_profile(path: &Path, source: &str) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();

    match extension.as_str() {
        "jinja" | "jinja2" | "j2" => Some("jinja"),
        "html" | "htm" => {
            if source.contains("{% load ")
                || source.contains("{% static ")
                || source.contains("{% csrf_token")
            {
                Some("django")
            } else if source.contains("{%") || source.contains("{{") || source.contains("{#") {
                Some("jinja")
            } else {
                Some("html")
            }
        }
        _ => None,
    }
}

fn djlint_binary() -> Option<PathBuf> {
    if let Some(value) = env::var_os("OPENCODE_DJLINT") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }

    if let Some(value) = env::var_os("OPENCODE_RUNTIME_DIR") {
        let root = PathBuf::from(value);
        if !root.as_os_str().is_empty() {
            return Some(root.join(DJLINT_RUNTIME_WRAPPER));
        }
    }

    env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".local")
            .join("libexec")
            .join("opencode-cpu-agent")
            .join(DJLINT_RUNTIME_WRAPPER)
    })
}

fn bounded_djlint_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\0', "\\0")
        .chars()
        .take(MAX_DJLINT_DIAGNOSTIC_CHARS)
        .collect()
}

fn run_djlint_phase(
    worktree: &Path,
    binary: &Path,
    profile: &str,
    files: &[String],
    phase: &str,
) -> std::result::Result<(), String> {
    let mut command = Command::new(binary);
    command.current_dir(worktree);

    for file in files {
        command.arg(file);
    }

    command.arg(format!("--profile={profile}"));
    command.arg(phase);
    command.arg("--quiet");

    let output = command.output().map_err(|error| {
        eprintln!(
            "PATCH_EXECUTOR_DIAGNOSTIC kind=djlint_unavailable protocol={} error={}",
            DJLINT_TEMPLATE_HYGIENE_PROTOCOL, error
        );
        "djlint_unavailable".to_string()
    })?;

    if output.status.success() {
        return Ok(());
    }

    eprintln!(
        "PATCH_EXECUTOR_DIAGNOSTIC kind=djlint_failed protocol={} phase={} profile={} exit_code={} stdout={} stderr={}",
        DJLINT_TEMPLATE_HYGIENE_PROTOCOL,
        phase,
        profile,
        output.status.code().unwrap_or(-1),
        bounded_djlint_output(&output.stdout),
        bounded_djlint_output(&output.stderr),
    );

    Err(match phase {
        "--reformat" => "djlint_reformat_failed",
        "--check" => "djlint_check_failed",
        _ => "djlint_phase_invalid",
    }
    .to_string())
}

fn git_changed_paths(worktree: &Path) -> std::result::Result<BTreeSet<String>, String> {
    let tracked = Command::new("git")
        .current_dir(worktree)
        .args(["diff", "--name-only", "--"])
        .output()
        .map_err(|_| "djlint_scope_check_failed".to_string())?;

    if !tracked.status.success() {
        return Err("djlint_scope_check_failed".to_string());
    }

    let untracked = Command::new("git")
        .current_dir(worktree)
        .args(["ls-files", "--others", "--exclude-standard"])
        .output()
        .map_err(|_| "djlint_scope_check_failed".to_string())?;

    if !untracked.status.success() {
        return Err("djlint_scope_check_failed".to_string());
    }

    let mut paths = BTreeSet::new();

    for raw in [tracked.stdout, untracked.stdout] {
        let text =
            std::str::from_utf8(&raw).map_err(|_| "djlint_scope_check_failed".to_string())?;

        for line in text.lines() {
            let Some(relative) = safe_rel(line.trim()) else {
                return Err("djlint_scope_escape".to_string());
            };
            paths.insert(relative);
        }
    }

    Ok(paths)
}

fn bounded_djlint_template_hygiene(
    worktree: &Path,
    changed: &[String],
) -> std::result::Result<DjlintTemplateHygiene, String> {
    if changed.len() > MAX_CHANGED_FILES {
        return Err("djlint_file_budget_exceeded".to_string());
    }

    let mut profiles = BTreeMap::<String, Vec<String>>::new();

    for raw in changed {
        let relative = safe_rel(raw).ok_or_else(|| "djlint_target_invalid".to_string())?;
        let path = worktree.join(&relative);

        if !path.is_file() {
            return Err("djlint_target_unavailable".to_string());
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if !matches!(
            extension.as_str(),
            "html" | "htm" | "jinja" | "jinja2" | "j2"
        ) {
            continue;
        }

        let source =
            fs::read_to_string(&path).map_err(|_| "djlint_target_not_utf8".to_string())?;
        let profile =
            djlint_profile(&path, &source).ok_or_else(|| "djlint_profile_unavailable".to_string())?;

        profiles
            .entry(profile.to_string())
            .or_default()
            .push(relative);
    }

    if profiles.is_empty() {
        return Ok(DjlintTemplateHygiene {
            protocol: DJLINT_TEMPLATE_HYGIENE_PROTOCOL,
            applied: false,
            files: Vec::new(),
            profiles,
        });
    }

    for files in profiles.values_mut() {
        files.sort();
        files.dedup();
    }

    let binary = djlint_binary().ok_or_else(|| "djlint_unavailable".to_string())?;

    for (profile, files) in &profiles {
        run_djlint_phase(worktree, &binary, profile, files, "--reformat")?;
        run_djlint_phase(worktree, &binary, profile, files, "--check")?;
    }

    let allowed = changed.iter().cloned().collect::<BTreeSet<_>>();
    let observed = git_changed_paths(worktree)?;

    if observed.iter().any(|path| !allowed.contains(path)) {
        eprintln!(
            "PATCH_EXECUTOR_DIAGNOSTIC kind=djlint_scope_escape protocol={} allowed_files={} observed_files={}",
            DJLINT_TEMPLATE_HYGIENE_PROTOCOL,
            allowed.len(),
            observed.len(),
        );
        return Err("djlint_scope_escape".to_string());
    }

    let mut files = profiles.values().flatten().cloned().collect::<Vec<_>>();
    files.sort();
    files.dedup();

    Ok(DjlintTemplateHygiene {
        protocol: DJLINT_TEMPLATE_HYGIENE_PROTOCOL,
        applied: true,
        files,
        profiles,
    })
}

struct GuardedResult {
    patch: String,
    changed_lines: usize,
    syntax_checked_files: Vec<String>,
    postconditions_checked: usize,
}

fn mutate_in_worktree(
    worktree: &Path,
    root: &Path,
    handoff: &ScoutHandoff,
    allowed: &BTreeMap<String, HandoffFile>,
    candidates: &BTreeMap<String, String>,
    changed: &BTreeSet<String>,
    created: &BTreeSet<String>,
    checks: &[Postcondition],
    max_changed_lines: usize,
) -> std::result::Result<GuardedResult, String> {
    let mut required = changed.clone();
    for check in checks {
        let rel = safe_rel(&check.file).ok_or_else(|| "check_file_invalid".to_string())?;
        if !allowed.contains_key(&rel) && !created.contains(&rel) {
            return Err("check_file_outside_handoff".to_string());
        }
        required.insert(rel);
    }

    for rel in &required {
        if created.contains(rel) {
            if safe_new_file_for_handoff(worktree, handoff, rel).is_none() {
                return Err("worktree_create_target_invalid".to_string());
            }
            continue;
        }
        let handoff_file = allowed
            .get(rel)
            .ok_or_else(|| "file_outside_handoff".to_string())?;
        let expected = handoff_file
            .fingerprint
            .sha256
            .as_deref()
            .ok_or_else(|| "handoff_fingerprint_missing".to_string())?;
        let path = safe_existing_file(worktree, rel)
            .ok_or_else(|| "worktree_baseline_missing".to_string())?;
        let actual = sha256_file(&path).map_err(|_| "worktree_baseline_hash_failed".to_string())?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err("worktree_baseline_mismatch".to_string());
        }
    }

    for rel in changed {
        let source = candidates
            .get(rel)
            .ok_or_else(|| "candidate_missing".to_string())?;
        let path = if created.contains(rel) {
            safe_new_file_for_handoff(worktree, handoff, rel)
                .ok_or_else(|| "worktree_create_target_invalid".to_string())?
        } else {
            safe_existing_file(worktree, rel)
                .ok_or_else(|| "worktree_edit_file_unavailable".to_string())?
        };
        fs::write(&path, source.as_bytes()).map_err(|_| "worktree_write_failed".to_string())?;
    }

    let changed_vec: Vec<String> = changed.iter().cloned().collect();
    let djlint_hygiene = bounded_djlint_template_hygiene(worktree, &changed_vec)?;

    if djlint_hygiene.applied {
        let diagnostic = serde_json::to_string(&djlint_hygiene).unwrap_or_else(|_| {
            "{\"protocol\":\"djlint-template-hygiene-v1\",\"applied\":true}".to_string()
        });
        eprintln!(
            "PATCH_EXECUTOR_DIAGNOSTIC kind=djlint_template_hygiene {}",
            diagnostic
        );
    }

    let mut syntax_checked = Vec::new();
    for rel in changed {
        let path = if created.contains(rel) {
            worktree.join(rel)
        } else {
            safe_existing_file(worktree, rel)
                .ok_or_else(|| "worktree_edit_file_unavailable".to_string())?
        };
        let source = fs::read_to_string(&path).map_err(|_| "edit_file_not_utf8".to_string())?;
        match syntax_is_valid(&path, &source) {
            Some(true) => syntax_checked.push(rel.clone()),
            Some(false) => return Err("candidate_syntax_invalid".to_string()),
            None => return Err("syntax_language_unsupported".to_string()),
        }
    }

    let mut checked = 0usize;
    for check in checks {
        let rel = safe_rel(&check.file).ok_or_else(|| "check_file_invalid".to_string())?;
        let path = worktree.join(&rel);
        if !path.is_file() {
            return Err("check_file_unavailable".to_string());
        }
        let source = fs::read_to_string(&path).map_err(|_| "check_file_not_utf8".to_string())?;
        match postcondition_holds(&check.kind, &source, &check.value) {
            Some(true) => checked += 1,
            Some(false) => return Err("postcondition_failed".to_string()),
            None => return Err("postcondition_kind_invalid".to_string()),
        }
    }

    if !created.is_empty() {
        let mut add = Command::new("git");
        add.current_dir(worktree).args(["add", "-N", "--"]);
        for file in created {
            add.arg(file);
        }
        let output = add
            .output()
            .map_err(|_| "git_intent_to_add_failed".to_string())?;
        if !output.status.success() {
            return Err("git_intent_to_add_failed".to_string());
        }
    }
    let hygiene = audit_candidate_hygiene(root, worktree, &changed_vec).map_err(|err| {
        eprintln!(
            "PATCH_EXECUTOR_DIAGNOSTIC kind=candidate_hygiene_error error={}",
            err
        );
        "git_diff_check_failed".to_string()
    })?;
    if !hygiene.ok {
        let diagnostic = serde_json::to_string(&hygiene)
            .unwrap_or_else(|_| "{\"protocol\":\"candidate-hygiene-v1\",\"ok\":false}".to_string());
        eprintln!(
            "PATCH_EXECUTOR_DIAGNOSTIC kind=candidate_hygiene_failed {}",
            diagnostic
        );
        return Err("git_diff_check_failed".to_string());
    }
    let patch =
        git_patch(worktree, &changed_vec, created).map_err(|_| "git_diff_failed".to_string())?;
    if patch.is_empty() {
        return Err("no_effect".to_string());
    }
    if patch.len() > MAX_PATCH_BYTES {
        return Err("patch_budget_exceeded".to_string());
    }
    let changed_lines = changed_line_count(&patch);
    if changed_lines > max_changed_lines {
        return Err("changed_line_budget_exceeded".to_string());
    }
    if !git_apply_check(root, &patch).map_err(|_| "git_apply_check_failed".to_string())? {
        return Err("git_apply_check_failed".to_string());
    }

    Ok(GuardedResult {
        patch,
        changed_lines,
        syntax_checked_files: syntax_checked,
        postconditions_checked: checked,
    })
}

fn execute(request: &Request, started: Instant) -> Result<Response> {
    if request.mode != MODE {
        return Ok(Response::rejected(started, request, "unsupported_mode"));
    }
    if request.edit_protocol != EDIT_PROTOCOL {
        return Ok(Response::rejected(
            started,
            request,
            "edit_protocol_mismatch",
        ));
    }
    if request.edits.is_empty() || request.edits.len() > MAX_EDITS {
        return Ok(Response::rejected(started, request, "edit_count_invalid"));
    }
    if request.checks.len() > MAX_CHECKS
        || request.checks.iter().any(|check| {
            check.value.is_empty()
                || check.value.len() > MAX_CHECK_BYTES
                || check.value.contains('\0')
                || !matches!(check.kind.as_str(), "contains_exact" | "not_contains_exact")
        })
    {
        return Ok(Response::rejected(
            started,
            request,
            "check_contract_invalid",
        ));
    }
    if request.edits.iter().any(|edit| {
        !matches!(
            edit.kind.as_str(),
            "replace_exact" | "replace_ast" | "replace_slice" | "create_file"
        ) || edit.before.len() > MAX_BEFORE_BYTES
            || edit.after.len() > MAX_AFTER_BYTES
            || (edit.kind == "create_file" && (edit.before != "" || edit.after.is_empty()))
            || (edit.kind != "create_file" && (edit.before.is_empty() || edit.before == edit.after))
            || edit.before.contains('\0')
            || edit.after.contains('\0')
            || (edit.kind == "replace_slice" && edit.confinement.is_none())
            || (edit.kind != "replace_slice" && edit.confinement.is_some())
    }) {
        return Ok(Response::rejected(
            started,
            request,
            "edit_contract_invalid",
        ));
    }

    let root = fs::canonicalize(&request.root).context("cannot resolve project root")?;
    anyhow::ensure!(root.is_dir(), "project root is not a directory");
    let handoff = match load_handoff(&root, &request.handoff) {
        Ok(value) => value,
        Err(error) => return Ok(Response::rejected(started, request, error.to_string())),
    };

    let mut base = Response::rejected(started, request, "handoff_not_ready");
    base.handoff_protocol = Some(handoff.protocol.clone());
    base.handoff_status = Some(handoff.status.clone());
    base.blocking_reasons = handoff.blocking_reasons.clone();
    base.partial_reasons = handoff.partial_reasons.clone();
    // Compatibility is defined by the stable handoff schema.
    // search_protocol is provenance only and may evolve independently.
    if handoff.protocol != HANDOFF_PROTOCOL {
        base.reason = Some("handoff_protocol_mismatch".to_string());
        return Ok(base);
    }
    if handoff.files.len() > MAX_HANDOFF_FILES {
        base.reason = Some("handoff_scope_too_large".to_string());
        return Ok(base);
    }
    if handoff.status != "ready"
        || !handoff.blocking_reasons.is_empty()
        || !handoff.partial_reasons.is_empty()
    {
        return Ok(base);
    }
    if let Err(reason) = validate_handoff_capability(&handoff) {
        base.reason = Some(reason.to_string());
        return Ok(base);
    }
    let additive_scope = handoff.scope_mode.as_deref() == Some("additive_mutation_capability");
    let edit_limit = if additive_scope {
        MAX_EDITS
    } else {
        LEGACY_MAX_EDITS
    };
    let changed_file_limit = if additive_scope {
        MAX_CHANGED_FILES
    } else {
        LEGACY_MAX_CHANGED_FILES
    };
    let changed_line_limit = if additive_scope {
        MAX_CHANGED_LINES
    } else {
        LEGACY_MAX_CHANGED_LINES
    };
    if request.edits.len() > edit_limit {
        base.reason = Some("edit_count_invalid".to_string());
        return Ok(base);
    }

    let mut allowed = BTreeMap::<String, HandoffFile>::new();
    for file in &handoff.files {
        let Some(rel) = safe_rel(&file.file) else {
            base.reason = Some("handoff_file_invalid".to_string());
            return Ok(base);
        };
        if file.fingerprint.kind != "sha256"
            || !file.fingerprint.strong
            || file.fingerprint.evidence_fresh != Some(true)
        {
            base.reason = Some("handoff_fingerprint_weak".to_string());
            return Ok(base);
        }
        let Some(expected) = file.fingerprint.sha256.as_ref() else {
            base.reason = Some("handoff_fingerprint_missing".to_string());
            return Ok(base);
        };
        let Some(path) = safe_existing_file(&root, &rel) else {
            base.reason = Some("handoff_file_unavailable".to_string());
            return Ok(base);
        };
        let actual = sha256_file(&path)?;
        if !actual.eq_ignore_ascii_case(expected) {
            base.reason = Some("stale_fingerprint".to_string());
            return Ok(base);
        }
        allowed.insert(rel, file.clone());
    }
    if allowed.is_empty() {
        base.reason = Some("handoff_scope_empty".to_string());
        return Ok(base);
    }
    base.allowed_files = allowed.keys().cloned().collect();
    base.verified_files = allowed.len();
    if let Err(reason) = validate_base_preconditions(&root, &allowed, &request.edits) {
        base.reason = Some(reason.to_string());
        return Ok(base);
    }

    for check in &request.checks {
        let Some(rel) = safe_rel(&check.file) else {
            base.reason = Some("check_file_invalid".to_string());
            return Ok(base);
        };
        let created_check = request.edits.iter().any(|edit| {
            edit.kind == "create_file"
                && safe_rel(&edit.file).as_deref() == Some(rel.as_str())
                && handoff_allows_edit(&handoff, &rel, edit)
        });
        if !allowed.contains_key(&rel) && !created_check {
            base.reason = Some("check_file_outside_handoff".to_string());
            return Ok(base);
        }
    }

    let mut originals = BTreeMap::<String, String>::new();
    let mut candidates = BTreeMap::<String, String>::new();
    let mut first_lines = BTreeMap::<String, usize>::new();
    let mut nearest_distances = BTreeMap::<String, usize>::new();
    let mut edits_accepted = 0usize;
    let mut structural_edits = 0usize;
    let mut certified_slice_files = BTreeSet::new();
    let mut created_files = BTreeSet::<String>::new();

    for edit in &request.edits {
        let Some(rel) = safe_rel(&edit.file) else {
            base.reason = Some("edit_file_invalid".to_string());
            return Ok(base);
        };
        if !handoff_allows_edit(&handoff, &rel, edit) {
            base.reason = Some("mutation_not_authorized_by_handoff".to_string());
            return Ok(base);
        }

        if edit.kind == "create_file" {
            if safe_new_file_for_handoff(&root, &handoff, &rel).is_none() {
                base.reason = Some("create_target_invalid".to_string());
                return Ok(base);
            }
            if originals.contains_key(&rel) || !created_files.insert(rel.clone()) {
                base.reason = Some("create_target_duplicate".to_string());
                return Ok(base);
            }
            originals.insert(rel.clone(), String::new());
            candidates.insert(rel.clone(), edit.after.clone());
            first_lines.insert(rel.clone(), 1);
            nearest_distances.insert(rel, 0);
            edits_accepted += 1;
            continue;
        }

        let Some(handoff_file) = allowed.get(&rel) else {
            base.reason = Some("file_outside_handoff".to_string());
            return Ok(base);
        };
        if edit.kind == "replace_slice" && !certified_slice_files.insert(rel.clone()) {
            base.reason = Some("mutation_slice_transaction_unsupported".to_string());
            return Ok(base);
        }
        if !originals.contains_key(&rel) {
            let Some(path) = safe_existing_file(&root, &rel) else {
                base.reason = Some("edit_file_unavailable".to_string());
                return Ok(base);
            };
            let text = match fs::read_to_string(path) {
                Ok(value) => value,
                Err(_) => {
                    base.reason = Some("edit_file_not_utf8".to_string());
                    return Ok(base);
                }
            };
            originals.insert(rel.clone(), text.clone());
            candidates.insert(rel.clone(), text);
        }

        let current = candidates.get(&rel).expect("candidate exists").clone();
        /*
         * Certified slices are compiler output, not model-selected offsets.
         * Executor still binds them to the fingerprinted source, exact bytes,
         * structural owner identity, and evidence radius before mutation.
         */
        let (next, line, distance) = if edit.kind == "replace_slice" {
            let Some(confinement) = edit.confinement.as_ref() else {
                base.reason = Some("slice_certificate_missing".to_string());
                return Ok(base);
            };
            if confinement.protocol != MUTATION_CONFINEMENT_PROTOCOL
                || confinement.mutation_index >= MAX_EDITS
                || confinement.owner_symbol.is_empty()
                || confinement.start_byte >= confinement.end_byte
                || confinement.owner_start > confinement.start_byte
                || confinement.end_byte > confinement.owner_end
                || confinement.owner_end > current.len()
                || confinement.end_byte > current.len()
                || !current.is_char_boundary(confinement.start_byte)
                || !current.is_char_boundary(confinement.end_byte)
                || confinement.end_byte - confinement.start_byte != edit.before.len()
                || !matches!(confinement.envelope.as_str(), "node" | "siblings" | "owner")
            {
                base.reason = Some("slice_certificate_invalid".to_string());
                return Ok(base);
            }
            if &current[confinement.start_byte..confinement.end_byte] != edit.before.as_str() {
                base.reason = Some("slice_precondition_mismatch".to_string());
                return Ok(base);
            }
            if !certified_owner_matches(
                &root.join(&rel),
                &current,
                &confinement.owner_symbol,
                confinement.owner_start,
                confinement.owner_end,
            ) {
                base.reason = Some("slice_owner_mismatch".to_string());
                return Ok(base);
            }
            let line = line_for_byte(&current, confinement.start_byte);
            let Some(distance) = nearest_evidence_distance(line, &handoff_file.evidence_lines)
            else {
                base.reason = Some("evidence_anchor_missing".to_string());
                return Ok(base);
            };
            if distance > MAX_EVIDENCE_DISTANCE_LINES {
                base.reason = Some("edit_outside_evidence_radius".to_string());
                return Ok(base);
            }
            let mut next = current.clone();
            next.replace_range(confinement.start_byte..confinement.end_byte, &edit.after);
            structural_edits += 1;
            (next, line, distance)
        } else if edit.kind == "replace_exact" {
            let (count, byte) = count_exact(&current, &edit.before);
            if count != 1 {
                base.reason = Some("precondition_not_unique".to_string());
                return Ok(base);
            }
            let line = line_for_byte(&current, byte.unwrap());
            let Some(distance) = nearest_evidence_distance(line, &handoff_file.evidence_lines)
            else {
                base.reason = Some("evidence_anchor_missing".to_string());
                return Ok(base);
            };
            if distance > MAX_EVIDENCE_DISTANCE_LINES {
                base.reason = Some("edit_outside_evidence_radius".to_string());
                return Ok(base);
            }
            (
                current.replacen(&edit.before, &edit.after, 1),
                line,
                distance,
            )
        } else {
            let path = root.join(&rel);
            let (start, end, line, distance) = match structural_match_range(
                &path,
                &current,
                &edit.before,
                &handoff_file.evidence_lines,
            ) {
                Ok(value) => value,
                Err(reason) => {
                    base.reason = Some(reason.to_string());
                    return Ok(base);
                }
            };
            if start >= end
                || end > current.len()
                || !current.is_char_boundary(start)
                || !current.is_char_boundary(end)
            {
                base.reason = Some("ast_match_range_invalid".to_string());
                return Ok(base);
            }
            let mut next = current.clone();
            next.replace_range(start..end, &edit.after);
            structural_edits += 1;
            (next, line, distance)
        };
        candidates.insert(rel.clone(), next);
        first_lines
            .entry(rel.clone())
            .and_modify(|value| *value = (*value).min(line))
            .or_insert(line);
        nearest_distances
            .entry(rel)
            .and_modify(|value| *value = (*value).min(distance))
            .or_insert(distance);
        edits_accepted += 1;
    }

    let changed: BTreeSet<String> = candidates
        .iter()
        .filter_map(|(file, after)| {
            originals
                .get(file)
                .filter(|before| *before != after)
                .map(|_| file.clone())
        })
        .collect();
    if changed.is_empty() {
        base.reason = Some("no_effect".to_string());
        return Ok(base);
    }
    if changed.len() > changed_file_limit {
        base.reason = Some("changed_file_budget_exceeded".to_string());
        base.edits_accepted = edits_accepted;
        base.structural_edits = structural_edits;
        return Ok(base);
    }

    let mut guarded_required = changed.clone();
    for check in &request.checks {
        if let Some(rel) = safe_rel(&check.file) {
            guarded_required.insert(rel);
        }
    }

    let mut worktree = match Worktree::create(&root) {
        Ok(value) => value,
        Err(_) => {
            base.reason = Some("worktree_create_failed".to_string());
            base.edits_accepted = edits_accepted;
            base.structural_edits = structural_edits;
            return Ok(base);
        }
    };
    base.worktree_used = true;
    base.worktree_cleaned = false;
    base.edits_accepted = edits_accepted;
    base.structural_edits = structural_edits;
    base.changed_files = changed.iter().cloned().collect();

    let guarded = mutate_in_worktree(
        &worktree.path,
        &root,
        &handoff,
        &allowed,
        &candidates,
        &changed,
        &created_files,
        &request.checks,
        changed_line_limit,
    );
    let cleaned = worktree.cleanup();
    base.worktree_cleaned = cleaned;
    if !cleaned {
        base.reason = Some("worktree_cleanup_failed".to_string());
        return Ok(base);
    }
    if let Err(reason) = validate_base_preconditions(&root, &allowed, &request.edits) {
        base.reason = Some(reason.to_string());
        return Ok(base);
    }

    if !main_sources_unchanged(&root, &allowed, &guarded_required, &created_files) {
        base.reason = Some("source_changed_during_execution".to_string());
        base.repo_mutated = true;
        return Ok(base);
    }

    let guarded = match guarded {
        Ok(value) => value,
        Err(reason) => {
            base.reason = Some(reason);
            return Ok(base);
        }
    };

    let mut changes = Vec::new();
    for rel in &changed {
        let before = originals.get(rel).expect("original exists");
        let after = candidates.get(rel).expect("candidate exists");
        let temp_parent = env::temp_dir();
        let before_path = temp_parent.join(format!(
            "opencode-patch-before-{}-{}",
            std::process::id(),
            changes.len()
        ));
        let after_path = temp_parent.join(format!(
            "opencode-patch-after-{}-{}",
            std::process::id(),
            changes.len()
        ));
        fs::write(&before_path, before.as_bytes())?;
        fs::write(&after_path, after.as_bytes())?;
        let before_sha256 = sha256_file(&before_path)?;
        let after_sha256 = sha256_file(&after_path)?;
        let _ = fs::remove_file(&before_path);
        let _ = fs::remove_file(&after_path);
        changes.push(ChangeSummary {
            file: rel.clone(),
            before_sha256,
            after_sha256,
            first_edit_line: *first_lines.get(rel).unwrap_or(&1),
            nearest_evidence_distance: *nearest_distances.get(rel).unwrap_or(&usize::MAX),
        });
    }

    Ok(Response {
        protocol: PROTOCOL,
        mode: request.mode.clone(),
        edit_protocol: request.edit_protocol.clone(),
        admitted: true,
        reason: None,
        handoff_protocol: Some(handoff.protocol),
        handoff_status: Some(handoff.status),
        blocking_reasons: handoff.blocking_reasons,
        partial_reasons: handoff.partial_reasons,
        allowed_files: allowed.keys().cloned().collect(),
        verified_files: allowed.len(),
        edits_requested: request.edits.len(),
        edits_accepted,
        structural_edits,
        changed_files: changed.into_iter().collect(),
        changed_lines: guarded.changed_lines,
        changes,
        syntax_checked_files: guarded.syntax_checked_files,
        postconditions_checked: guarded.postconditions_checked,
        git_diff_check: true,
        git_apply_check: true,
        worktree_used: true,
        worktree_cleaned: true,
        patch_bytes: guarded.patch.len(),
        patch: Some(guarded.patch),
        repo_mutated: false,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn main() -> Result<()> {
    let started = Instant::now();
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("failed to read stdin")?;
    let request: Request = serde_json::from_str(&input).context("invalid request JSON")?;
    let response = execute(&request, started).unwrap_or_else(|error| {
        Response::rejected(started, &request, format!("internal_error:{error}"))
    });
    serde_json::to_writer(io::stdout(), &response)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_precondition_detects_ambiguity() {
        assert_eq!(count_exact("x x", "x"), (2, Some(0)));
        assert_eq!(count_exact("abc", "b"), (1, Some(1)));
    }

    #[test]
    fn relative_paths_cannot_escape_or_target_runtime_state() {
        assert_eq!(safe_rel("src/a.py").as_deref(), Some("src/a.py"));
        assert!(safe_rel("../a.py").is_none());
        assert!(safe_rel("/tmp/a.py").is_none());
        assert!(safe_rel(".opencode/state.json").is_none());
        assert!(safe_rel(".git/config").is_none());
    }

    #[test]
    fn evidence_distance_is_bounded() {
        assert_eq!(nearest_evidence_distance(100, &[1, 95, 140]), Some(5));
        assert_eq!(nearest_evidence_distance(100, &[]), None);
    }

    #[test]
    fn structural_match_ignores_trivia_but_stays_evidence_local() {
        let source = "def f():\n    return add(1,  2)\n";
        let (start, end, line, distance) =
            structural_match_range(Path::new("sample.py"), source, "add(1, 2)", &[2]).unwrap();
        assert_eq!(&source[start..end], "add(1,  2)");
        assert_eq!(line, 2);
        assert_eq!(distance, 0);
    }

    #[test]
    fn changed_lines_ignore_patch_headers() {
        let patch = "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n";
        assert_eq!(changed_line_count(patch), 2);
    }

    #[test]
    fn deterministic_postconditions_are_bounded_predicates() {
        assert_eq!(
            postcondition_holds("contains_exact", "abc", "b"),
            Some(true)
        );
        assert_eq!(
            postcondition_holds("not_contains_exact", "abc", "z"),
            Some(true)
        );
        assert_eq!(postcondition_holds("shell", "abc", "b"), None);
    }
}

#[cfg(test)]
mod r14c_base_state_tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "opencode-r14c-{tag}-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn absent_precondition_requires_existing_non_symlink_parent() {
        let root = temp_root("absent");
        fs::create_dir_all(root.join("templates")).unwrap();

        assert!(path_is_absent_without_symlink(&root, "templates/new.html"));

        fs::write(root.join("templates/new.html"), b"x").unwrap();
        assert!(!path_is_absent_without_symlink(&root, "templates/new.html"));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn absent_precondition_rejects_broken_target_symlink_and_symlink_parent() {
        use std::os::unix::fs::symlink;

        let root = temp_root("symlink");
        fs::create_dir_all(root.join("real")).unwrap();

        symlink("missing-target", root.join("broken")).unwrap();
        assert!(!path_is_absent_without_symlink(&root, "broken"));

        symlink(root.join("real"), root.join("alias")).unwrap();
        assert!(!path_is_absent_without_symlink(&root, "alias/new.txt"));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn existing_base_file_rejects_symlink_target() {
        use std::os::unix::fs::symlink;

        let root = temp_root("existing-symlink");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("real.py"), b"x = 1\n").unwrap();
        symlink(root.join("real.py"), root.join("alias.py")).unwrap();

        assert!(safe_existing_base_file(&root, "real.py").is_some());
        assert!(safe_existing_base_file(&root, "alias.py").is_none());

        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod r20_djlint_template_hygiene_tests {
    use super::*;

    #[test]
    fn djlint_profile_is_language_bounded() {
        assert_eq!(
            djlint_profile(Path::new("template.html"), "<div>plain</div>\n"),
            Some("html")
        );
        assert_eq!(
            djlint_profile(
                Path::new("template.html"),
                "{% if ok %}{{ value }}{% endif %}\n"
            ),
            Some("jinja")
        );
        assert_eq!(
            djlint_profile(Path::new("template.html"), "{% load static %}\n"),
            Some("django")
        );
        assert_eq!(
            djlint_profile(Path::new("template.jinja2"), "{{ value }}\n"),
            Some("jinja")
        );
        assert_eq!(
            djlint_profile(Path::new("source.py"), "print('x')\n"),
            None
        );
    }

    #[test]
    fn djlint_runtime_wrapper_is_not_model_selected() {
        assert_eq!(DJLINT_RUNTIME_WRAPPER, "opencode-djlint");
        assert_eq!(
            DJLINT_TEMPLATE_HYGIENE_PROTOCOL,
            "djlint-template-hygiene-v1"
        );
    }
}
