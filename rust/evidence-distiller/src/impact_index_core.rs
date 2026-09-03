use anyhow::{Context, Result};
use ast_grep_core::{Node, tree_sitter::StrDoc};
use ast_grep_language::{LanguageExt, SupportLang};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const PROTOCOL: &str = "impact-index-v1";
const CACHE_VERSION: u32 = 5;
// Safety ceiling only. Git-aware inventory is the primary scaling mechanism.
const DEFAULT_MAX_FILES: usize = 50_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_IMPORTS_PER_FILE: usize = 192;
const DEFAULT_MAX_NEIGHBORS: usize = 24;
const MAX_NEIGHBORS: usize = 64;
const MAX_BINDINGS: usize = 16;
const MAX_WITNESS_CHARS: usize = 180;

#[derive(Debug, Deserialize)]
struct SeedFilter {
    seed: String,
    #[serde(default)]
    forward_bindings: Vec<String>,
    #[serde(default)]
    reverse_source_symbols: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    pub mode: String,
    #[serde(default)]
    seed_files: Vec<String>,
    #[serde(default)]
    seed_filters: Vec<SeedFilter>,
    #[serde(default)]
    max_neighbors: Option<usize>,
    #[serde(default)]
    check_freshness: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
struct BindingPair {
    local: String,
    source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ImportRecord {
    pub spec: String,
    line: usize,
    pub kind: String,
    // Identifier used by the importing file after aliases are applied.
    pub bindings: Vec<String>,
    // Identifier expected to exist in the target module/file.
    #[serde(default)]
    source_symbols: Vec<String>,
    #[serde(default)]
    binding_pairs: Vec<BindingPair>,
    pub witness: String,
    // exact_local can be activated; exact_local_resource remains shadow-only.
    pub confidence: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ParseStats {
    external_package: usize,
    unsupported_alias: usize,
    unsupported_dynamic: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedFile {
    size: u64,
    mtime_ms: u64,
    imports: Vec<ImportRecord>,
    #[serde(default)]
    parse_stats: ParseStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
struct EdgeRecord {
    from: String,
    to: String,
    kind: String,
    pub witness_line: usize,
    spec: String,
    bindings: Vec<String>,
    #[serde(default)]
    source_symbols: Vec<String>,
    #[serde(default)]
    binding_pairs: Vec<BindingPair>,
    witness: String,
    confidence: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ResolutionStats {
    local_resolved: usize,
    local_unresolved: usize,
    local_ambiguous: usize,
    external_package: usize,
    unsupported_alias: usize,
    unsupported_dynamic: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheFile {
    pub protocol: String,
    version: u32,
    refreshed_at_ms: u64,
    #[serde(default)]
    coverage_complete: bool,
    #[serde(default)]
    partial_reason: Option<String>,
    #[serde(default)]
    inventory_kind: String,
    #[serde(default)]
    stats: ResolutionStats,
    pub files: BTreeMap<String, CachedFile>,
    edges: Vec<EdgeRecord>,
}

impl Default for CacheFile {
    fn default() -> Self {
        Self {
            protocol: PROTOCOL.to_string(),
            version: CACHE_VERSION,
            refreshed_at_ms: 0,
            coverage_complete: false,
            partial_reason: Some("uninitialized".to_string()),
            inventory_kind: "none".to_string(),
            stats: ResolutionStats::default(),
            files: BTreeMap::new(),
            edges: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct Neighbor {
    seed: String,
    file: String,
    direction: String,
    kind: String,
    witness_file: String,
    witness_line: usize,
    spec: String,
    bindings: Vec<String>,
    source_symbols: Vec<String>,
    binding_pairs: Vec<BindingPair>,
    witness: String,
    confidence: String,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    mode: String,
    pub ready: bool,
    refresh_complete: Option<bool>,
    coverage_complete: Option<bool>,
    partial_reason: Option<String>,
    inventory_kind: Option<String>,
    cache_path: String,
    cache_age_ms: Option<u64>,
    files_total: usize,
    files_reused: Option<usize>,
    files_reindexed: Option<usize>,
    files_removed: Option<usize>,
    imports_total: usize,
    edges_total: usize,
    // Compatibility telemetry.
    resolved_imports: Option<usize>,
    unresolved_imports: Option<usize>,
    local_resolved: Option<usize>,
    local_unresolved: Option<usize>,
    local_ambiguous: Option<usize>,
    external_package: Option<usize>,
    unsupported_alias: Option<usize>,
    unsupported_dynamic: Option<usize>,
    skipped_files: Option<usize>,
    lossy_files: Option<usize>,
    capped: Option<bool>,
    seed_files: Vec<String>,
    neighbors_total: usize,
    neighbors: Vec<Neighbor>,
    task_filters_applied: Option<bool>,
    stale_seed_files: Option<usize>,
    stale_witness_edges: Option<usize>,
    walk_elapsed_ms: Option<f64>,
    parse_elapsed_ms: Option<f64>,
    pub elapsed_ms: f64,
}

const MAX_SYMBOL_CLOSURE_BINDINGS: usize = 64;

const MAX_DATA_PROVIDER_IDENTITIES: usize = 8;
const DEFAULT_MAX_DATA_PROVIDER_FILES_PER_IDENTITY: usize = 8;
const MAX_DATA_PROVIDER_FILES_PER_IDENTITY: usize = 16;
const MAX_DATA_PROVIDER_RESULTS_PER_IDENTITY: usize = 16;
const DATA_PROVIDER_RG_TIMEOUT_MS: u64 = 150;
const DATA_PROVIDER_RG_MAX_STDOUT_BYTES: usize = 128 * 1024;
const DATA_PROVIDER_RG_MAX_STDERR_BYTES: usize = 4 * 1024;

type ProviderSgNode<'a> = Node<'a, StrDoc<SupportLang>>;

#[derive(Debug, Deserialize)]
struct DataProviderIdentityRequest {
    #[serde(default)]
    identities: Vec<String>,
    #[serde(default)]
    max_files_per_identity: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct DataProviderCandidate {
    file: String,
    symbol: String,
    configuration_identity: String,
    constructor_family: String,
    constructor: String,
    witness_line: usize,
    witness: String,
}

#[derive(Debug, Clone, Serialize)]
struct DataProviderIdentityObservation {
    identity: String,
    search_complete: bool,
    truncated: bool,
    reason: Option<String>,
    candidate_files: Vec<String>,
    files_scanned: usize,
    candidates: Vec<DataProviderCandidate>,
}

#[derive(Debug, Serialize)]
struct DataProviderIdentityResponse {
    protocol: &'static str,
    mode: &'static str,
    ready: bool,
    complete: bool,
    reason: Option<String>,
    observations: Vec<DataProviderIdentityObservation>,
    elapsed_ms: f64,
}

#[derive(Debug, Deserialize)]
struct ModeRequest {
    root: String,
    mode: String,
}

#[derive(Debug, Deserialize)]
struct SymbolClosureRequest {
    pub source_file: String,
    pub source_symbol: String,
    #[serde(default)]
    max_bindings: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SymbolBindingIntoFileRequest {
    source_file: String,
    source_symbol: String,
    importer_file: String,
}

#[derive(Debug, Serialize)]
struct SymbolBindingIntoFileResponse {
    protocol: &'static str,
    mode: &'static str,
    ready: bool,
    complete: bool,
    reason: Option<String>,
    source_file: Option<String>,
    source_symbol: Option<String>,
    importer_file: Option<String>,
    bindings: Vec<SymbolClosureBinding>,
    inventory_kind: Option<String>,
    inventory_files: usize,
    elapsed_ms: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct SymbolClosureBinding {
    pub importer: String,
    pub target: String,
    pub kind: String,
    pub witness_line: usize,
    pub spec: String,
    pub source_symbol: String,
    pub local_symbol: String,
    pub witness: String,
    pub confidence: String,
    pub propagates: bool,
}

#[derive(Debug, Serialize)]
pub struct SymbolClosureResponse {
    pub protocol: &'static str,
    pub mode: &'static str,
    pub ready: bool,
    pub complete: bool,
    pub reason: Option<String>,
    pub source_file: Option<String>,
    pub source_symbol: Option<String>,
    pub states_visited: usize,
    pub bindings: Vec<SymbolClosureBinding>,
    pub files: Vec<String>,
    pub refresh_performed: bool,
    pub elapsed_ms: f64,
}

#[derive(Debug)]
enum Resolution {
    Resolved(String),
    Ambiguous,
    Unresolved,
    External,
}

fn max_files() -> usize {
    std::env::var("OPENCODE_IMPACT_MAX_FILES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_FILES)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn is_skipped_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".opencode"
            | ".agentbench"
            | "node_modules"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".cache"
    )
}

fn language_key(path: &Path) -> &'static str {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name == "dockerfile" || name.starts_with("dockerfile.") || name.ends_with(".dockerfile") {
        return "docker";
    }
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "py" => "python",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "html" | "htm" => "html",
        "css" => "css",
        "xml" | "xsd" | "xsl" | "xslt" => "xml",
        "sql" => "sql",
        "rs" => "rust",
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" => "c_cpp",
        _ => "other",
    }
}

fn supported(path: &Path) -> bool {
    language_key(path) != "other"
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
    Some(parts.join("/"))
}

fn rel_string(root: &Path, path: &Path) -> Result<String> {
    let rel = path
        .strip_prefix(root)
        .context("indexed path escaped root")?;
    normalize_rel(rel).context("cannot normalize indexed path")
}

fn git_inventory(root: &Path) -> Option<(Vec<PathBuf>, bool)> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let mut files = Vec::new();
    let mut capped = false;
    for raw in output.stdout.split(|b| *b == 0) {
        if raw.is_empty() {
            continue;
        }
        if files.len() >= max_files() {
            capped = true;
            break;
        }
        let rel = String::from_utf8_lossy(raw);
        let path = root.join(rel.as_ref());
        let meta = match fs::metadata(&path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if meta.is_file() && meta.len() <= MAX_FILE_BYTES && supported(&path) {
            files.push(path);
        }
    }
    files.sort();
    Some((files, capped))
}

fn walk_files(root: &Path) -> Result<(Vec<PathBuf>, bool)> {
    fn visit(dir: &Path, out: &mut Vec<PathBuf>, capped: &mut bool) -> Result<()> {
        if *capped {
            return Ok(());
        }
        let mut entries: Vec<_> = fs::read_dir(dir)
            .with_context(|| format!("cannot read {}", dir.display()))?
            .filter_map(|entry| entry.ok())
            .collect();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            if out.len() >= max_files() {
                *capped = true;
                break;
            }
            let file_type = match entry.file_type() {
                Ok(v) => v,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if !is_skipped_dir(&name) {
                    visit(&path, out, capped)?;
                }
                continue;
            }
            if !file_type.is_file() || !supported(&path) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(v) => v,
                Err(_) => continue,
            };
            if meta.len() <= MAX_FILE_BYTES {
                out.push(path);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    let mut capped = false;
    visit(root, &mut files, &mut capped)?;
    Ok((files, capped))
}

fn inventory(root: &Path) -> Result<(Vec<PathBuf>, bool, String)> {
    if let Some((files, capped)) = git_inventory(root) {
        return Ok((files, capped, "git_ls_files".to_string()));
    }
    let (files, capped) = walk_files(root)?;
    Ok((files, capped, "walk".to_string()))
}

fn mtime_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn clipped_witness(line: &str) -> String {
    line.trim().chars().take(MAX_WITNESS_CHARS).collect()
}

fn ident(raw: &str) -> Option<String> {
    let value = raw
        .trim()
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '$')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect::<String>();
    if value.is_empty() { None } else { Some(value) }
}

fn local_binding(source: &str, alias: Option<&str>) -> Option<String> {
    alias.and_then(ident).or_else(|| ident(source))
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if values.len() < MAX_BINDINGS && !values.contains(&value) {
        values.push(value);
    }
}

fn push_pair(pairs: &mut Vec<BindingPair>, local: String, source: String) {
    if pairs.len() >= MAX_BINDINGS {
        return;
    }
    if !pairs
        .iter()
        .any(|pair| pair.local == local && pair.source == source)
    {
        pairs.push(BindingPair { local, source });
    }
}

fn python_import_items(raw: &str) -> (Vec<String>, Vec<String>, Vec<BindingPair>) {
    let mut locals = Vec::new();
    let mut sources = Vec::new();
    let mut pairs = Vec::new();
    for item in raw.split(',') {
        let mut parts = item.trim().split_whitespace();
        let source = parts.next().unwrap_or("");
        if source == "*" || source.is_empty() {
            continue;
        }
        let alias = if parts.next() == Some("as") {
            parts.next()
        } else {
            None
        };
        let Some(src) = ident(source) else {
            continue;
        };
        let Some(local) = local_binding(&src, alias) else {
            continue;
        };
        push_unique(&mut locals, local.clone());
        push_unique(&mut sources, src.clone());
        push_pair(&mut pairs, local, src);
        if pairs.len() >= MAX_BINDINGS {
            break;
        }
    }
    (locals, sources, pairs)
}

fn parse_python_import(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix("from ") {
        let (spec, imported) = rest.split_once(" import ")?;
        let spec = spec.trim();
        if spec.is_empty() {
            return None;
        }
        let mut imported = imported.trim();
        if imported.starts_with('(') && imported.ends_with(')') && imported.len() >= 2 {
            imported = imported[1..imported.len() - 1].trim();
        }
        // After statement collection, nested expressions are not valid import
        // lists. Stay conservative instead of guessing through malformed code.
        if imported.contains('(') || imported.contains(')') || imported.contains('\\') {
            return None;
        }
        let (bindings, source_symbols, binding_pairs) = python_import_items(imported);
        if bindings.is_empty() {
            return None;
        }
        return Some(ImportRecord {
            spec: spec.to_string(),
            line: line_no,
            kind: "python_from".to_string(),
            bindings,
            source_symbols,
            binding_pairs,
            witness: clipped_witness(trimmed),
            confidence: "exact_local".to_string(),
        });
    }

    if let Some(rest) = trimmed.strip_prefix("import ") {
        // Multiple module imports are deliberately left unresolved because one
        // ImportRecord has one target spec. Common `import pkg as alias` stays
        // exact and module-member use is validated later in the TS router.
        if rest.contains(',') || rest.contains('\\') {
            return None;
        }
        let mut parts = rest.split_whitespace();
        let spec = parts.next()?.trim();
        let alias = if parts.next() == Some("as") {
            parts.next()
        } else {
            None
        };
        if spec.is_empty() {
            return None;
        }
        let default_local = spec.split('.').next().unwrap_or(spec);
        let binding = local_binding(default_local, alias).into_iter().collect();
        return Some(ImportRecord {
            spec: spec.to_string(),
            line: line_no,
            kind: "python_import".to_string(),
            bindings: binding,
            source_symbols: Vec::new(),
            binding_pairs: Vec::new(),
            witness: clipped_witness(trimmed),
            confidence: "exact_local".to_string(),
        });
    }
    None
}

fn strip_python_inline_comment(line: &str) -> &str {
    // Imports very rarely need # inside a quoted token; module/import names do
    // not. Treat # as a comment boundary to keep the collector deterministic.
    line.split_once('#').map(|(head, _)| head).unwrap_or(line)
}

fn parse_python_imports(source: &str) -> Vec<ImportRecord> {
    const MAX_IMPORT_STATEMENT_LINES: usize = 64;
    const MAX_IMPORT_STATEMENT_BYTES: usize = 16 * 1024;
    let lines: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < lines.len() && out.len() < MAX_IMPORTS_PER_FILE {
        let start = i;
        let first = lines[i].trim_start();
        if !(first.starts_with("from ") || first.starts_with("import ")) {
            i += 1;
            continue;
        }

        let mut statement = String::new();
        let mut depth: i32 = 0;
        let mut continued = false;
        let mut consumed = 0usize;
        loop {
            if i >= lines.len()
                || consumed >= MAX_IMPORT_STATEMENT_LINES
                || statement.len() >= MAX_IMPORT_STATEMENT_BYTES
            {
                break;
            }
            let raw = strip_python_inline_comment(lines[i]).trim();
            let mut piece = raw;
            let slash = piece.ends_with('\\');
            if slash {
                piece = piece[..piece.len() - 1].trim_end();
            }
            if !piece.is_empty() {
                if !statement.is_empty() {
                    statement.push(' ');
                }
                statement.push_str(piece);
                for ch in piece.chars() {
                    if ch == '(' {
                        depth += 1;
                    } else if ch == ')' {
                        depth -= 1;
                    }
                }
            }
            consumed += 1;
            i += 1;
            continued = slash || depth > 0;
            if !continued {
                break;
            }
        }

        // Unbalanced/truncated statements are ignored rather than creating a
        // low-confidence dependency edge.
        if continued || depth != 0 || statement.len() >= MAX_IMPORT_STATEMENT_BYTES {
            continue;
        }
        if let Some(record) = parse_python_import(start + 1, &statement) {
            out.push(record);
        }
    }
    out
}

fn quoted_specs(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let quote = bytes[i];
        if quote != b'\'' && quote != b'"' {
            i += 1;
            continue;
        }
        let start = i + 1;
        i = start;
        while i < bytes.len() && bytes[i] != quote {
            if bytes[i] == b'\\' {
                i += 1;
            }
            i += 1;
        }
        if i <= bytes.len() {
            if let Ok(value) = std::str::from_utf8(&bytes[start..i.min(bytes.len())]) {
                out.push(value.to_string());
            }
        }
        i += 1;
    }
    out
}

fn is_relative_spec(spec: &str) -> bool {
    spec.starts_with("./") || spec.starts_with("../")
}
fn is_remote_spec(spec: &str) -> bool {
    spec.starts_with("http://")
        || spec.starts_with("https://")
        || spec.starts_with("//")
        || spec.starts_with("data:")
        || spec.starts_with("javascript:")
        || spec.starts_with('#')
}
fn looks_alias_spec(spec: &str) -> bool {
    spec.starts_with("@/") || spec.starts_with("~/") || spec.starts_with("#/")
}

fn js_named_bindings(clause: &str) -> (Vec<String>, Vec<String>, Vec<BindingPair>) {
    let Some(inner) = clause
        .trim()
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
    else {
        return (Vec::new(), Vec::new(), Vec::new());
    };
    let mut locals = Vec::new();
    let mut sources = Vec::new();
    let mut pairs = Vec::new();
    for item in inner.split(',') {
        let mut item = item.trim();
        if let Some(rest) = item.strip_prefix("type ") {
            item = rest.trim();
        }
        if item.is_empty() {
            continue;
        }
        let parts: Vec<_> = item.split_whitespace().collect();
        let (source, local) = if parts.len() >= 3 && parts[parts.len() - 2] == "as" {
            (parts[0], parts[parts.len() - 1])
        } else {
            (
                parts.first().copied().unwrap_or(""),
                parts.first().copied().unwrap_or(""),
            )
        };
        if let (Some(src), Some(loc)) = (ident(source), ident(local)) {
            push_unique(&mut locals, loc.clone());
            push_unique(&mut sources, src.clone());
            push_pair(&mut pairs, loc, src);
        }
        if pairs.len() >= MAX_BINDINGS {
            break;
        }
    }
    (locals, sources, pairs)
}

fn js_merge_strings(dst: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        push_unique(dst, value);
    }
}

fn js_merge_pairs(dst: &mut Vec<BindingPair>, values: Vec<BindingPair>) {
    for pair in values {
        push_pair(dst, pair.local, pair.source);
    }
}

fn parse_js_import(
    line_no: usize,
    statement: &str,
    stats: &mut ParseStats,
) -> Option<ImportRecord> {
    let trimmed = statement.trim();
    let flat = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let spec = quoted_specs(trimmed).last()?.clone();
    let import_like =
        flat.starts_with("import ") || flat.contains("require(") || flat.contains("import(");
    if !import_like {
        return None;
    }
    if !is_relative_spec(&spec) {
        if looks_alias_spec(&spec) {
            stats.unsupported_alias += 1;
        } else {
            stats.external_package += 1;
        }
        return None;
    }
    if flat.contains("import(") {
        stats.unsupported_dynamic += 1;
        return None;
    }

    let mut bindings = Vec::new();
    let mut source_symbols = Vec::new();
    let mut binding_pairs = Vec::new();
    if let Some(body) = flat.strip_prefix("import ") {
        if let Some((clause, _)) = body.split_once(" from ") {
            let mut clause = clause.trim();
            if let Some(rest) = clause.strip_prefix("type ") {
                clause = rest.trim();
            }
            if clause.starts_with('{') {
                (bindings, source_symbols, binding_pairs) = js_named_bindings(clause);
            } else if let Some(rest) = clause.strip_prefix("* as ") {
                bindings = ident(rest).into_iter().collect();
            } else if !clause.is_empty() {
                if let Some((default_part, rest)) = clause.split_once(',') {
                    bindings = ident(default_part.trim()).into_iter().collect();
                    let rest = rest.trim();
                    if rest.starts_with('{') {
                        let (l, s, p) = js_named_bindings(rest);
                        js_merge_strings(&mut bindings, l);
                        js_merge_strings(&mut source_symbols, s);
                        js_merge_pairs(&mut binding_pairs, p);
                    } else if let Some(ns) = rest.strip_prefix("* as ") {
                        js_merge_strings(&mut bindings, ident(ns).into_iter().collect());
                    }
                } else {
                    bindings = ident(clause).into_iter().collect();
                }
            }
        }
    } else if flat.contains("require(") {
        if let Some((lhs, _)) = flat.split_once('=') {
            let lhs = lhs.trim();
            let lhs = lhs
                .strip_prefix("const ")
                .or_else(|| lhs.strip_prefix("let "))
                .or_else(|| lhs.strip_prefix("var "))
                .unwrap_or(lhs)
                .trim();
            if lhs.starts_with('{') {
                let (l, s, p) = js_named_bindings(lhs);
                bindings = l;
                source_symbols = s;
                binding_pairs = p;
            } else {
                bindings = ident(lhs).into_iter().collect();
            }
        }
    }
    Some(ImportRecord {
        spec,
        line: line_no,
        kind: if flat.contains("require(") {
            "js_require"
        } else {
            "js_relative_import"
        }
        .to_string(),
        bindings,
        source_symbols,
        binding_pairs,
        witness: clipped_witness(&flat),
        confidence: "exact_local".to_string(),
    })
}

fn js_import_statement_complete(statement: &str) -> bool {
    let flat = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    let has_spec = !quoted_specs(statement).is_empty();
    has_spec
        && (flat.contains(" from ")
            || flat.starts_with("import '")
            || flat.starts_with("import \"")
            || flat.contains("require("))
}

fn parse_js_imports(source: &str, stats: &mut ParseStats) -> Vec<ImportRecord> {
    const MAX_IMPORT_STATEMENT_LINES: usize = 64;
    const MAX_IMPORT_STATEMENT_BYTES: usize = 16 * 1024;
    let lines: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() && out.len() < MAX_IMPORTS_PER_FILE {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.starts_with("import ") && !trimmed.contains("import(") {
            let start_line = i + 1;
            let mut statement = line.to_string();
            let mut j = i;
            while !js_import_statement_complete(&statement)
                && j + 1 < lines.len()
                && j + 1 < i + MAX_IMPORT_STATEMENT_LINES
                && statement.len() < MAX_IMPORT_STATEMENT_BYTES
            {
                j += 1;
                statement.push('\n');
                statement.push_str(lines[j]);
            }
            if let Some(record) = parse_js_import(start_line, &statement, stats) {
                out.push(record);
            }
            i = j + 1;
            continue;
        }
        if let Some(record) = parse_js_import(i + 1, line, stats) {
            out.push(record);
        }
        i += 1;
    }
    out
}

fn parse_rust_import(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let no_vis = trimmed.strip_prefix("pub ").unwrap_or(trimmed);
    if let Some(rest) = no_vis.strip_prefix("mod ") {
        let name = ident(rest)?;
        return Some(ImportRecord {
            spec: name.clone(),
            line: line_no,
            kind: "rust_mod".to_string(),
            bindings: vec![name],
            source_symbols: Vec::new(),
            binding_pairs: Vec::new(),
            witness: clipped_witness(line),
            confidence: "exact_local".to_string(),
        });
    }
    if let Some(rest) = no_vis.strip_prefix("use crate::") {
        if rest.contains('*') {
            return None;
        }
        let value = rest.trim().trim_end_matches(';');
        let source = value
            .rsplit("::")
            .next()
            .and_then(ident)
            .into_iter()
            .collect::<Vec<_>>();
        return Some(ImportRecord {
            spec: value.to_string(),
            line: line_no,
            kind: "rust_crate_use".to_string(),
            bindings: source.clone(),
            source_symbols: source.clone(),
            binding_pairs: source
                .into_iter()
                .map(|value| BindingPair {
                    local: value.clone(),
                    source: value,
                })
                .collect(),
            witness: clipped_witness(line),
            confidence: "exact_local".to_string(),
        });
    }
    None
}

fn parse_c_include(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if !trimmed.starts_with("#include") {
        return None;
    }
    let spec = quoted_specs(trimmed).into_iter().next()?;
    Some(ImportRecord {
        spec,
        line: line_no,
        kind: "c_quote_include".to_string(),
        bindings: Vec::new(),
        source_symbols: Vec::new(),
        binding_pairs: Vec::new(),
        witness: clipped_witness(line),
        confidence: "exact_local_resource".to_string(),
    })
}

fn resource_binding(spec: &str) -> Vec<String> {
    Path::new(spec)
        .file_stem()
        .and_then(|v| v.to_str())
        .and_then(ident)
        .into_iter()
        .collect()
}

fn local_resource_record(
    line_no: usize,
    line: &str,
    kind: &str,
    spec: String,
) -> Option<ImportRecord> {
    if is_remote_spec(&spec) || spec.contains("{{") || spec.contains("${") || spec.contains("<%") {
        return None;
    }
    Some(ImportRecord {
        bindings: resource_binding(&spec),
        source_symbols: Vec::new(),
        binding_pairs: Vec::new(),
        spec,
        line: line_no,
        kind: kind.to_string(),
        witness: clipped_witness(line),
        confidence: "exact_local_resource".to_string(),
    })
}

fn extract_attr(line: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(pos) = line.find(&needle) {
            let rest = &line[pos + needle.len()..];
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn extract_tag_attr_all(line: &str, tag: &str, attr: &str) -> Vec<String> {
    let lower = line.to_ascii_lowercase();
    let tag_lower = tag.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while cursor < lower.len() {
        let Some(rel) = lower[cursor..].find(&tag_lower) else {
            break;
        };
        let start = cursor + rel;
        let end = lower[start..]
            .find('>')
            .map(|v| start + v + 1)
            .unwrap_or(line.len());
        if let Some(segment) = line.get(start..end) {
            if let Some(value) = extract_attr(segment, attr) {
                out.push(value);
            }
        }
        if end <= cursor {
            break;
        }
        cursor = end;
    }
    out
}

fn parse_html_dependencies(line_no: usize, line: &str) -> Vec<ImportRecord> {
    let mut out = Vec::new();
    for spec in extract_tag_attr_all(line, "<script", "src") {
        if let Some(record) = local_resource_record(line_no, line, "html_script", spec) {
            out.push(record);
        }
    }
    for spec in extract_tag_attr_all(line, "<link", "href") {
        if let Some(record) = local_resource_record(line_no, line, "html_link", spec) {
            out.push(record);
        }
    }
    out
}

fn parse_css_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if !trimmed.starts_with("@import") {
        return None;
    }
    let spec = quoted_specs(trimmed).into_iter().next().or_else(|| {
        let start = trimmed.find("url(")? + 4;
        let end = trimmed[start..].find(')')? + start;
        Some(
            trimmed[start..end]
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .to_string(),
        )
    })?;
    local_resource_record(line_no, line, "css_import", spec)
}

fn parse_xml_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let lower = line.to_ascii_lowercase();
    if !(lower.contains("include") || lower.contains("import")) {
        return None;
    }
    for attr in ["schemaLocation", "href", "file"] {
        if let Some(spec) = extract_attr(line, attr) {
            return local_resource_record(line_no, line, "xml_include", spec);
        }
    }
    None
}

fn parse_docker_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let upper = trimmed.to_ascii_uppercase();
    if !(upper.starts_with("COPY ") || upper.starts_with("ADD ")) {
        return None;
    }
    if trimmed.contains("--from=") {
        return None;
    }
    let rest = trimmed.split_whitespace().skip(1).collect::<Vec<_>>();
    if rest.len() < 2 {
        return None;
    }
    let spec = rest[rest.len() - 2]
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string();
    if spec.contains('*') || spec.contains('?') {
        return None;
    }
    local_resource_record(line_no, line, "docker_copy", spec)
}

fn parse_sql_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    let spec = if lower.starts_with("\\i ")
        || lower.starts_with("\\ir ")
        || lower.starts_with(".read ")
        || lower.starts_with("source ")
    {
        trimmed
            .split_whitespace()
            .nth(1)?
            .trim_matches(|c| c == '"' || c == '\'' || c == ';')
            .to_string()
    } else {
        return None;
    };
    local_resource_record(line_no, line, "sql_include", spec)
}

fn parse_imports(path: &Path, source: &str) -> (Vec<ImportRecord>, ParseStats) {
    let lang = language_key(path);
    let mut stats = ParseStats::default();
    if lang == "python" {
        return (parse_python_imports(source), stats);
    }
    if matches!(lang, "javascript" | "typescript") {
        return (parse_js_imports(source, &mut stats), stats);
    }
    let mut out = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        if out.len() >= MAX_IMPORTS_PER_FILE {
            break;
        }
        let line_no = idx + 1;
        let records: Vec<ImportRecord> = match lang {
            "html" => parse_html_dependencies(line_no, line),
            "css" => parse_css_dependency(line_no, line).into_iter().collect(),
            "xml" => parse_xml_dependency(line_no, line).into_iter().collect(),
            "docker" => parse_docker_dependency(line_no, line).into_iter().collect(),
            "sql" => parse_sql_dependency(line_no, line).into_iter().collect(),
            "rust" => parse_rust_import(line_no, line).into_iter().collect(),
            "c_cpp" => parse_c_include(line_no, line).into_iter().collect(),
            _ => Vec::new(),
        };
        for record in records {
            if out.len() >= MAX_IMPORTS_PER_FILE {
                break;
            }
            out.push(record);
        }
    }
    (out, stats)
}

fn unique_existing(
    candidates: impl IntoIterator<Item = String>,
    file_set: &HashSet<String>,
) -> Resolution {
    let found: BTreeSet<_> = candidates
        .into_iter()
        .filter(|c| file_set.contains(c))
        .collect();
    match found.len() {
        0 => Resolution::Unresolved,
        1 => Resolution::Resolved(found.into_iter().next().unwrap()),
        _ => Resolution::Ambiguous,
    }
}

fn python_candidates(importer: &str, spec: &str) -> Vec<String> {
    let mut dots = 0usize;
    for ch in spec.chars() {
        if ch == '.' {
            dots += 1;
        } else {
            break;
        }
    }
    let module = spec[dots..].replace('.', "/");
    let mut base = if dots == 0 {
        PathBuf::new()
    } else {
        let mut parent = Path::new(importer)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf();
        for _ in 1..dots {
            parent.pop();
        }
        parent
    };
    if !module.is_empty() {
        base.push(module);
    }
    let Some(base) = normalize_rel(&base) else {
        return Vec::new();
    };
    if base.is_empty() {
        return Vec::new();
    }
    vec![format!("{base}.py"), format!("{base}/__init__.py")]
}

fn ts_extension_substitutions(base: &str, ext: &str) -> Vec<String> {
    let stem_path = Path::new(base).with_extension("");
    let Some(stem) = normalize_rel(&stem_path) else {
        return Vec::new();
    };
    let mapped: &[&str] = match ext {
        "js" => &["ts", "tsx", "d.ts", "js", "jsx"],
        "jsx" => &["tsx", "d.ts", "jsx"],
        "mjs" => &["mts", "d.mts", "mjs"],
        "cjs" => &["cts", "d.cts", "cjs"],
        _ => &[],
    };
    mapped
        .iter()
        .map(|mapped_ext| format!("{stem}.{mapped_ext}"))
        .collect()
}

fn relative_module_candidates(importer: &str, spec: &str) -> Vec<String> {
    let parent = Path::new(importer)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let Some(base) = normalize_rel(&parent.join(spec)) else {
        return Vec::new();
    };
    let ext = Path::new(&base)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ext.is_empty() {
        let mut out = vec![base.clone()];
        out.extend(ts_extension_substitutions(&base, &ext));
        out.sort();
        out.dedup();
        return out;
    }
    let extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "d.ts"];
    let mut out = Vec::new();
    for ext in extensions {
        out.push(format!("{base}.{ext}"));
        out.push(format!("{base}/index.{ext}"));
    }
    out
}

fn rust_mod_candidates(importer: &str, name: &str) -> Vec<String> {
    let path = Path::new(importer);
    let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
    let base = if matches!(file_name, "lib.rs" | "main.rs" | "mod.rs") {
        path.parent().unwrap_or_else(|| Path::new("")).to_path_buf()
    } else {
        path.with_extension("")
    };
    let Some(base) = normalize_rel(&base.join(name)) else {
        return Vec::new();
    };
    vec![format!("{base}.rs"), format!("{base}/mod.rs")]
}

fn rust_crate_candidates(spec: &str) -> Vec<String> {
    let raw = spec.trim().trim_end_matches(';');
    let parts: Vec<_> = raw.split("::").filter(|v| !v.is_empty()).collect();
    let mut out = Vec::new();
    if !parts.is_empty() {
        let whole = parts.join("/");
        out.push(format!("src/{whole}.rs"));
        out.push(format!("src/{whole}/mod.rs"));
    }
    if parts.len() >= 2 {
        let module = parts[..parts.len() - 1].join("/");
        out.push(format!("src/{module}.rs"));
        out.push(format!("src/{module}/mod.rs"));
    }
    out
}

fn local_path_candidates(importer: &str, spec: &str) -> Vec<String> {
    let parent = Path::new(importer)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let mut out = Vec::new();
    if let Some(local) = normalize_rel(&parent.join(spec.trim_start_matches('/'))) {
        out.push(local);
    }
    if let Some(root) = normalize_rel(Path::new(spec.trim_start_matches('/'))) {
        out.push(root);
    }
    out.sort();
    out.dedup();
    out
}

fn resolve_import(importer: &str, import: &ImportRecord, file_set: &HashSet<String>) -> Resolution {
    match import.kind.as_str() {
        "python_from" | "python_import" => {
            let result = unique_existing(python_candidates(importer, &import.spec), file_set);
            if matches!(result, Resolution::Unresolved) && !import.spec.starts_with('.') {
                Resolution::External
            } else {
                result
            }
        }
        "js_relative_import" | "js_require" => {
            unique_existing(relative_module_candidates(importer, &import.spec), file_set)
        }
        "rust_mod" => unique_existing(rust_mod_candidates(importer, &import.spec), file_set),
        "rust_crate_use" => unique_existing(rust_crate_candidates(&import.spec), file_set),
        "c_quote_include" | "html_script" | "html_link" | "css_import" | "xml_include"
        | "docker_copy" | "sql_include" => {
            unique_existing(local_path_candidates(importer, &import.spec), file_set)
        }
        _ => Resolution::Unresolved,
    }
}

fn cache_path(root: &Path) -> PathBuf {
    root.join(".opencode").join("impact-index-v1.json")
}

fn load_cache(path: &Path) -> Option<CacheFile> {
    let bytes = fs::read(path).ok()?;
    let cache = serde_json::from_slice::<CacheFile>(&bytes).ok()?;
    if cache.protocol == PROTOCOL && cache.version == CACHE_VERSION {
        Some(cache)
    } else {
        None
    }
}

fn write_cache(path: &Path, cache: &CacheFile) -> Result<()> {
    let parent = path.parent().context("cache has no parent")?;
    fs::create_dir_all(parent).context("cannot create impact index directory")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(cache)?).context("cannot write impact index temp")?;
    fs::rename(&tmp, path).context("cannot atomically replace impact index")?;
    Ok(())
}

fn sanitize_seed(raw: &str, cache: &CacheFile) -> Option<String> {
    if raw.is_empty() || Path::new(raw).is_absolute() {
        return None;
    }
    let normalized = normalize_rel(Path::new(raw.trim_start_matches("./")))?;
    if cache.files.contains_key(&normalized) {
        Some(normalized)
    } else {
        None
    }
}

fn empty_response(mode: &str, path: &Path, started: Instant) -> Response {
    Response {
        protocol: PROTOCOL,
        mode: mode.to_string(),
        ready: false,
        refresh_complete: None,
        coverage_complete: None,
        partial_reason: None,
        inventory_kind: None,
        cache_path: path.display().to_string(),
        cache_age_ms: None,
        files_total: 0,
        files_reused: None,
        files_reindexed: None,
        files_removed: None,
        imports_total: 0,
        edges_total: 0,
        resolved_imports: None,
        unresolved_imports: None,
        local_resolved: None,
        local_unresolved: None,
        local_ambiguous: None,
        external_package: None,
        unsupported_alias: None,
        unsupported_dynamic: None,
        skipped_files: None,
        lossy_files: None,
        capped: None,
        seed_files: Vec::new(),
        neighbors_total: 0,
        neighbors: Vec::new(),
        task_filters_applied: None,
        stale_seed_files: None,
        stale_witness_edges: None,
        walk_elapsed_ms: None,
        parse_elapsed_ms: None,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    }
}

fn refresh(root: &Path, path: &Path, started: Instant) -> Result<Response> {
    let previous = load_cache(path).unwrap_or_default();
    let walk_started = Instant::now();
    let (paths, capped, inventory_kind) = inventory(root)?;
    let walk_elapsed = walk_started.elapsed().as_secs_f64() * 1000.0;

    let parse_started = Instant::now();
    let mut files = BTreeMap::new();
    let mut files_reused = 0usize;
    let mut files_reindexed = 0usize;
    let mut skipped_files = 0usize;
    let mut lossy_files = 0usize;

    for absolute in paths {
        let rel = match rel_string(root, &absolute) {
            Ok(v) => v,
            Err(_) => {
                skipped_files += 1;
                continue;
            }
        };
        let metadata = match fs::metadata(&absolute) {
            Ok(v) => v,
            Err(_) => {
                skipped_files += 1;
                continue;
            }
        };
        let size = metadata.len();
        let mtime = mtime_ms(&metadata);
        if let Some(old) = previous.files.get(&rel) {
            if old.size == size && old.mtime_ms == mtime {
                files.insert(rel, old.clone());
                files_reused += 1;
                continue;
            }
        }
        match fs::read(&absolute) {
            Ok(bytes) => {
                let was_lossy = std::str::from_utf8(&bytes).is_err();
                let source = String::from_utf8_lossy(&bytes);
                if was_lossy {
                    lossy_files += 1;
                }
                let (imports, parse_stats) = parse_imports(&absolute, source.as_ref());
                files.insert(
                    rel,
                    CachedFile {
                        size,
                        mtime_ms: mtime,
                        imports,
                        parse_stats,
                    },
                );
                files_reindexed += 1;
            }
            Err(_) => skipped_files += 1,
        }
    }

    let files_removed = previous
        .files
        .keys()
        .filter(|key| !files.contains_key(*key))
        .count();
    let file_set: HashSet<String> = files.keys().cloned().collect();
    let mut edges = BTreeSet::new();
    let mut stats = ResolutionStats::default();
    for file in files.values() {
        stats.external_package += file.parse_stats.external_package;
        stats.unsupported_alias += file.parse_stats.unsupported_alias;
        stats.unsupported_dynamic += file.parse_stats.unsupported_dynamic;
    }

    for (importer, file) in &files {
        for import in &file.imports {
            match resolve_import(importer, import, &file_set) {
                Resolution::Resolved(target) if target != *importer => {
                    stats.local_resolved += 1;
                    edges.insert(EdgeRecord {
                        from: importer.clone(),
                        to: target,
                        kind: import.kind.clone(),
                        witness_line: import.line,
                        spec: import.spec.clone(),
                        bindings: import.bindings.clone(),
                        source_symbols: import.source_symbols.clone(),
                        binding_pairs: import.binding_pairs.clone(),
                        witness: import.witness.clone(),
                        confidence: import.confidence.clone(),
                    });
                }
                Resolution::Resolved(_) => {}
                Resolution::Ambiguous => stats.local_ambiguous += 1,
                Resolution::Unresolved => stats.local_unresolved += 1,
                Resolution::External => stats.external_package += 1,
            }
        }
    }

    let mut reasons = Vec::new();
    if capped {
        reasons.push("file_budget");
    }
    if skipped_files > 0 {
        reasons.push("read_errors");
    }
    let coverage_complete = reasons.is_empty();
    let partial_reason = if reasons.is_empty() {
        None
    } else {
        Some(reasons.join(","))
    };
    let parse_elapsed = parse_started.elapsed().as_secs_f64() * 1000.0;
    let cache = CacheFile {
        protocol: PROTOCOL.to_string(),
        version: CACHE_VERSION,
        refreshed_at_ms: now_ms(),
        coverage_complete,
        partial_reason: partial_reason.clone(),
        inventory_kind: inventory_kind.clone(),
        stats: stats.clone(),
        files,
        edges: edges.into_iter().collect(),
    };

    // Partial routing data is useful, but never replace a known complete cache with a partial refresh.
    let use_new_cache =
        coverage_complete || previous.files.is_empty() || !previous.coverage_complete;
    if use_new_cache {
        write_cache(path, &cache)?;
    }
    let ready = use_new_cache || !previous.files.is_empty();
    let effective = if use_new_cache { &cache } else { &previous };
    let imports_total = effective
        .files
        .values()
        .map(|file| file.imports.len())
        .sum();

    Ok(Response {
        protocol: PROTOCOL,
        mode: "refresh".to_string(),
        ready,
        refresh_complete: Some(coverage_complete),
        coverage_complete: Some(coverage_complete),
        partial_reason,
        inventory_kind: Some(inventory_kind),
        cache_path: path.display().to_string(),
        cache_age_ms: Some(0),
        files_total: effective.files.len(),
        files_reused: Some(files_reused),
        files_reindexed: Some(files_reindexed),
        files_removed: Some(files_removed),
        imports_total,
        edges_total: effective.edges.len(),
        resolved_imports: Some(stats.local_resolved),
        unresolved_imports: Some(stats.local_unresolved + stats.local_ambiguous),
        local_resolved: Some(stats.local_resolved),
        local_unresolved: Some(stats.local_unresolved),
        local_ambiguous: Some(stats.local_ambiguous),
        external_package: Some(stats.external_package),
        unsupported_alias: Some(stats.unsupported_alias),
        unsupported_dynamic: Some(stats.unsupported_dynamic),
        skipped_files: Some(skipped_files),
        lossy_files: Some(lossy_files),
        capped: Some(capped),
        seed_files: Vec::new(),
        neighbors_total: 0,
        neighbors: Vec::new(),
        task_filters_applied: None,
        stale_seed_files: None,
        stale_witness_edges: None,
        walk_elapsed_ms: Some(walk_elapsed),
        parse_elapsed_ms: Some(parse_elapsed),
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn symbol_intersects(values: &[String], wanted: &HashSet<String>) -> bool {
    !wanted.is_empty() && values.iter().any(|value| wanted.contains(value))
}

fn cached_file_fresh(root: &Path, cache: &CacheFile, rel: &str) -> bool {
    let Some(old) = cache.files.get(rel) else {
        return false;
    };
    let Ok(meta) = fs::metadata(root.join(rel)) else {
        return false;
    };
    meta.len() == old.size && mtime_ms(&meta) == old.mtime_ms
}

fn neighbors(request: &Request, root: &Path, path: &Path, started: Instant) -> Result<Response> {
    let Some(cache) = load_cache(path) else {
        return Ok(empty_response("neighbors", path, started));
    };
    let max_neighbors = request
        .max_neighbors
        .unwrap_or(DEFAULT_MAX_NEIGHBORS)
        .clamp(1, MAX_NEIGHBORS);

    // Preserve lexical probe order. BTreeSet sorting here would reintroduce a
    // graph-side fairness bug where alphabetically earlier seeds monopolize cap.
    let mut seen = HashSet::new();
    let mut seeds = Vec::new();
    let mut missing_seed_files = 0usize;
    for raw in &request.seed_files {
        if raw.is_empty() || Path::new(raw).is_absolute() {
            continue;
        }
        let Some(normalized) = normalize_rel(Path::new(raw.trim_start_matches("./"))) else {
            continue;
        };
        if !seen.insert(normalized.clone()) {
            continue;
        }
        if cache.files.contains_key(&normalized) {
            seeds.push(normalized);
        } else {
            missing_seed_files += 1;
        }
    }
    let seed_set: HashSet<_> = seeds.iter().cloned().collect();

    let mut filters: BTreeMap<String, (HashSet<String>, HashSet<String>)> = BTreeMap::new();
    for filter in &request.seed_filters {
        let Some(seed) = sanitize_seed(&filter.seed, &cache) else {
            continue;
        };
        if !seed_set.contains(&seed) {
            continue;
        }
        filters.insert(
            seed,
            (
                filter
                    .forward_bindings
                    .iter()
                    .filter(|v| !v.is_empty())
                    .cloned()
                    .collect(),
                filter
                    .reverse_source_symbols
                    .iter()
                    .filter(|v| !v.is_empty())
                    .cloned()
                    .collect(),
            ),
        );
    }
    let task_filters_applied = !filters.is_empty();

    let mut freshness_cache = BTreeMap::<String, bool>::new();
    let mut is_fresh = |rel: &str| -> bool {
        if let Some(value) = freshness_cache.get(rel) {
            return *value;
        }
        let value = cached_file_fresh(root, &cache, rel);
        freshness_cache.insert(rel.to_string(), value);
        value
    };
    let mut stale_seed_files = missing_seed_files;
    if request.check_freshness {
        stale_seed_files += seeds.iter().filter(|seed| !is_fresh(seed)).count();
    }

    // Separate (seed,direction) lanes. Relevance filtering and witness
    // freshness happen before any cap; round-robin then prevents one high-
    // fanout seed/direction from hiding all other lexical seeds.
    let mut lanes: BTreeMap<(String, String), BTreeSet<(String, EdgeRecord)>> = BTreeMap::new();
    let mut stale_witness_edges = 0usize;
    for edge in &cache.edges {
        if seed_set.contains(&edge.from) {
            let allowed = filters
                .get(&edge.from)
                .map(|(forward, _)| symbol_intersects(&edge.bindings, forward))
                .unwrap_or(!task_filters_applied);
            if allowed {
                if request.check_freshness && !is_fresh(&edge.from) {
                    stale_witness_edges += 1;
                } else {
                    lanes
                        .entry((edge.from.clone(), "forward".to_string()))
                        .or_default()
                        .insert((edge.to.clone(), edge.clone()));
                }
            }
        }
        if seed_set.contains(&edge.to) {
            let allowed = filters
                .get(&edge.to)
                .map(|(_, reverse)| symbol_intersects(&edge.source_symbols, reverse))
                .unwrap_or(!task_filters_applied);
            if allowed {
                if request.check_freshness && !is_fresh(&edge.from) {
                    stale_witness_edges += 1;
                } else {
                    lanes
                        .entry((edge.to.clone(), "reverse".to_string()))
                        .or_default()
                        .insert((edge.from.clone(), edge.clone()));
                }
            }
        }
    }

    let neighbors_total: usize = lanes.values().map(|lane| lane.len()).sum();
    let mut lane_vec = Vec::new();
    for seed in &seeds {
        for direction in ["forward", "reverse"] {
            if let Some(values) = lanes.remove(&(seed.clone(), direction.to_string())) {
                lane_vec.push((
                    seed.clone(),
                    direction.to_string(),
                    values.into_iter().collect::<Vec<_>>(),
                    0usize,
                ));
            }
        }
    }

    let mut chosen = Vec::new();
    while chosen.len() < max_neighbors {
        let mut progressed = false;
        for (seed, direction, values, index) in &mut lane_vec {
            if chosen.len() >= max_neighbors {
                break;
            }
            let Some((file, edge)) = values.get(*index).cloned() else {
                continue;
            };
            *index += 1;
            progressed = true;
            chosen.push((seed.clone(), file, direction.clone(), edge));
        }
        if !progressed {
            break;
        }
    }

    let neighbors = chosen
        .into_iter()
        .map(|(seed, file, direction, edge)| Neighbor {
            seed,
            file,
            direction,
            kind: edge.kind,
            witness_file: edge.from,
            witness_line: edge.witness_line,
            spec: edge.spec,
            bindings: edge.bindings,
            source_symbols: edge.source_symbols,
            binding_pairs: edge.binding_pairs,
            witness: edge.witness,
            confidence: edge.confidence,
        })
        .collect::<Vec<_>>();
    let imports_total = cache.files.values().map(|file| file.imports.len()).sum();
    let st = &cache.stats;

    Ok(Response {
        protocol: PROTOCOL,
        mode: "neighbors".to_string(),
        ready: true,
        refresh_complete: None,
        coverage_complete: Some(cache.coverage_complete),
        partial_reason: cache.partial_reason.clone(),
        inventory_kind: Some(cache.inventory_kind.clone()),
        cache_path: path.display().to_string(),
        cache_age_ms: Some(now_ms().saturating_sub(cache.refreshed_at_ms)),
        files_total: cache.files.len(),
        files_reused: None,
        files_reindexed: None,
        files_removed: None,
        imports_total,
        edges_total: cache.edges.len(),
        resolved_imports: Some(st.local_resolved),
        unresolved_imports: Some(st.local_unresolved + st.local_ambiguous),
        local_resolved: Some(st.local_resolved),
        local_unresolved: Some(st.local_unresolved),
        local_ambiguous: Some(st.local_ambiguous),
        external_package: Some(st.external_package),
        unsupported_alias: Some(st.unsupported_alias),
        unsupported_dynamic: Some(st.unsupported_dynamic),
        skipped_files: None,
        lossy_files: None,
        capped: None,
        seed_files: seeds,
        neighbors_total,
        neighbors,
        task_filters_applied: Some(task_filters_applied),
        stale_seed_files: Some(stale_seed_files),
        stale_witness_edges: Some(stale_witness_edges),
        walk_elapsed_ms: None,
        parse_elapsed_ms: None,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn provider_constant_identity(raw: &str) -> Option<String> {
    if raw.len() < 3 || raw.len() > 80 {
        return None;
    }
    let first = raw.chars().next()?;
    if !first.is_ascii_uppercase() {
        return None;
    }
    if !raw
        .chars()
        .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
    {
        return None;
    }
    Some(raw.to_string())
}

fn provider_node_text(node: &ProviderSgNode<'_>, max_chars: usize) -> String {
    node.text()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn provider_has_parse_errors(root: &ProviderSgNode<'_>) -> bool {
    root.clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
}

fn python_psycopg2_aliases(
    path: &Path,
    source: &str,
) -> (BTreeSet<String>, BTreeSet<String>, bool) {
    let (imports, stats) = parse_imports(path, source);
    let mut modules = BTreeSet::new();
    let mut connects = BTreeSet::new();

    for import in imports {
        if import.spec != "psycopg2" {
            continue;
        }
        match import.kind.as_str() {
            "python_import" => {
                for binding in import.bindings {
                    if ident(&binding).as_deref() == Some(binding.as_str()) {
                        modules.insert(binding);
                    }
                }
            }
            "python_from" => {
                for pair in import.binding_pairs {
                    if pair.source == "connect"
                        && ident(&pair.local).as_deref() == Some(pair.local.as_str())
                    {
                        connects.insert(pair.local);
                    }
                }
            }
            _ => {}
        }
    }

    let unsupported = (stats.unsupported_alias > 0 || stats.unsupported_dynamic > 0)
        && source.contains("psycopg2");

    (modules, connects, unsupported)
}

fn python_psycopg2_constructor(
    call: &ProviderSgNode<'_>,
    modules: &BTreeSet<String>,
    connects: &BTreeSet<String>,
) -> Option<String> {
    if call.kind().as_ref() != "call" {
        return None;
    }
    let callee = call.field("function")?;
    let name = provider_node_text(&callee, 160);
    if connects.contains(&name) {
        return Some(name);
    }
    for alias in modules {
        if name == format!("{alias}.connect") {
            return Some(name);
        }
    }
    None
}

fn python_call_has_identity_splat(call: &ProviderSgNode<'_>, identity: &str) -> bool {
    let Some(arguments) = call.field("arguments") else {
        return false;
    };
    for node in arguments.dfs() {
        if node.kind().as_ref() != "dictionary_splat" {
            continue;
        }
        if node
            .dfs()
            .filter(|child| child.kind().as_ref() == "identifier")
            .any(|child| provider_node_text(&child, 80) == identity)
        {
            return true;
        }
    }
    false
}

fn python_innermost_function_owner(
    functions: &[ProviderSgNode<'_>],
    call: &ProviderSgNode<'_>,
) -> Option<String> {
    let call_range = call.range();
    let mut owners = functions
        .iter()
        .filter(|function| {
            let range = function.range();
            range.start <= call_range.start && call_range.end <= range.end
        })
        .filter_map(|function| {
            let name_node = function.field("name")?;
            let name = provider_node_text(&name_node, 160);
            if ident(&name).as_deref() != Some(name.as_str()) {
                return None;
            }
            let range = function.range();
            Some((name, range.end.saturating_sub(range.start)))
        })
        .collect::<Vec<_>>();
    owners.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    owners.into_iter().next().map(|(name, _)| name)
}

fn extract_python_data_provider_candidates(
    rel: &str,
    source: &str,
    identity: &str,
) -> Result<Vec<DataProviderCandidate>> {
    let ast = SupportLang::Python.ast_grep(source);
    let root = ast.root();
    anyhow::ensure!(
        !provider_has_parse_errors(&root),
        "provider_parse_contains_error"
    );

    let (modules, connects, unsupported) = python_psycopg2_aliases(Path::new(rel), source);
    anyhow::ensure!(!unsupported, "provider_import_syntax_unsupported");
    if modules.is_empty() && connects.is_empty() {
        return Ok(Vec::new());
    }

    let functions = root
        .clone()
        .dfs()
        .filter(|node| node.kind().as_ref() == "function_definition")
        .collect::<Vec<_>>();
    let mut out = BTreeSet::new();

    for call in root.dfs() {
        let Some(constructor) = python_psycopg2_constructor(&call, &modules, &connects) else {
            continue;
        };
        if !python_call_has_identity_splat(&call, identity) {
            continue;
        }
        let Some(symbol) = python_innermost_function_owner(&functions, &call) else {
            continue;
        };
        out.insert(DataProviderCandidate {
            file: rel.to_string(),
            symbol,
            configuration_identity: identity.to_string(),
            constructor_family: "python-psycopg2".to_string(),
            constructor,
            witness_line: call.start_pos().line() + 1,
            witness: provider_node_text(&call, MAX_WITNESS_CHARS),
        });
        if out.len() > MAX_DATA_PROVIDER_RESULTS_PER_IDENTITY {
            anyhow::bail!("provider_result_budget_exceeded");
        }
    }

    Ok(out.into_iter().collect())
}

fn read_child_limited<R: Read>(mut reader: R, limit: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let Ok(count) = reader.read(&mut chunk) else {
            break;
        };
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(out.len());
        if count > remaining {
            out.extend_from_slice(&chunk[..remaining]);
            return (out, true);
        }
        out.extend_from_slice(&chunk[..count]);
    }
    (out, false)
}

fn bounded_provider_identity_files(
    root: &Path,
    identity: &str,
    max_files: usize,
) -> DataProviderIdentityObservation {
    let mut command = Command::new("rg");
    command
        .current_dir(root)
        .arg("--files-with-matches")
        .arg("--null")
        .arg("--fixed-strings")
        .arg("--no-messages")
        .arg("--max-filesize")
        .arg("1M")
        .arg("-g")
        .arg("*.py")
        .arg("-g")
        .arg("!.git/**")
        .arg("-g")
        .arg("!.opencode/**")
        .arg("-g")
        .arg("!node_modules/**")
        .arg("-g")
        .arg("!target/**")
        .arg("-g")
        .arg("!dist/**")
        .arg("-g")
        .arg("!build/**")
        .arg("--")
        .arg(identity)
        .arg(".")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let failure = |reason: &str, truncated: bool| DataProviderIdentityObservation {
        identity: identity.to_string(),
        search_complete: false,
        truncated,
        reason: Some(reason.to_string()),
        candidate_files: Vec::new(),
        files_scanned: 0,
        candidates: Vec::new(),
    };

    let Ok(mut child) = command.spawn() else {
        return failure("provider_rg_spawn_failed", false);
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return failure("provider_rg_stdout_unavailable", false);
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return failure("provider_rg_stderr_unavailable", false);
    };

    let stdout_reader =
        std::thread::spawn(move || read_child_limited(stdout, DATA_PROVIDER_RG_MAX_STDOUT_BYTES));
    let stderr_reader =
        std::thread::spawn(move || read_child_limited(stderr, DATA_PROVIDER_RG_MAX_STDERR_BYTES));

    let deadline = Instant::now() + Duration::from_millis(DATA_PROVIDER_RG_TIMEOUT_MS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let (stdout, stdout_limited) = stdout_reader.join().unwrap_or_else(|_| (Vec::new(), true));
    let (stderr, _) = stderr_reader.join().unwrap_or_else(|_| (Vec::new(), true));

    if status.is_none() {
        return failure("provider_rg_timeout", false);
    }
    if stdout_limited {
        return failure("provider_rg_stdout_limit", true);
    }

    let status = status.expect("checked above");
    if status.code() != Some(0) && status.code() != Some(1) {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return failure(
            if detail.is_empty() {
                "provider_rg_failed"
            } else {
                "provider_rg_failed_with_stderr"
            },
            false,
        );
    }

    let files = stdout
        .split(|byte| *byte == 0)
        .filter_map(|raw| {
            if raw.is_empty() {
                return None;
            }
            let raw = String::from_utf8_lossy(raw);
            normalize_rel(Path::new(raw.trim_start_matches("./")))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    if files.len() > max_files {
        return DataProviderIdentityObservation {
            identity: identity.to_string(),
            search_complete: false,
            truncated: true,
            reason: Some("provider_candidate_files_truncated".to_string()),
            candidate_files: files.into_iter().take(max_files).collect(),
            files_scanned: 0,
            candidates: Vec::new(),
        };
    }

    DataProviderIdentityObservation {
        identity: identity.to_string(),
        search_complete: true,
        truncated: false,
        reason: None,
        candidate_files: files,
        files_scanned: 0,
        candidates: Vec::new(),
    }
}

fn data_provider_identity(
    request: &DataProviderIdentityRequest,
    root: &Path,
    started: Instant,
) -> Result<DataProviderIdentityResponse> {
    let identities = request
        .identities
        .iter()
        .filter_map(|value| provider_constant_identity(value))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    if identities.len() > MAX_DATA_PROVIDER_IDENTITIES {
        return Ok(DataProviderIdentityResponse {
            protocol: PROTOCOL,
            mode: "data_provider_identity",
            ready: false,
            complete: false,
            reason: Some("provider_identity_budget_exceeded".to_string()),
            observations: Vec::new(),
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        });
    }

    let max_files = request
        .max_files_per_identity
        .unwrap_or(DEFAULT_MAX_DATA_PROVIDER_FILES_PER_IDENTITY)
        .clamp(1, MAX_DATA_PROVIDER_FILES_PER_IDENTITY);
    let mut observations = Vec::new();

    for identity in identities {
        let mut observation = bounded_provider_identity_files(root, &identity, max_files);
        if !observation.search_complete || observation.truncated {
            observations.push(observation);
            continue;
        }

        let mut candidates = BTreeSet::new();
        let mut failed = None;
        for rel in &observation.candidate_files {
            let path = root.join(rel);
            let metadata = match fs::metadata(&path) {
                Ok(value) => value,
                Err(_) => {
                    failed = Some("provider_candidate_stat_failed".to_string());
                    break;
                }
            };
            if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
                failed = Some("provider_candidate_file_invalid".to_string());
                break;
            }
            let source = match fs::read_to_string(&path) {
                Ok(value) => value,
                Err(_) => {
                    failed = Some("provider_candidate_read_failed".to_string());
                    break;
                }
            };
            observation.files_scanned += 1;
            match extract_python_data_provider_candidates(rel, &source, &identity) {
                Ok(rows) => {
                    for row in rows {
                        candidates.insert(row);
                    }
                }
                Err(_) => {
                    failed = Some("provider_source_validation_failed".to_string());
                    break;
                }
            }
            if candidates.len() > MAX_DATA_PROVIDER_RESULTS_PER_IDENTITY {
                failed = Some("provider_result_budget_exceeded".to_string());
                break;
            }
        }

        if let Some(reason) = failed {
            observation.search_complete = false;
            observation.reason = Some(reason);
            observation.candidates.clear();
        } else {
            observation.candidates = candidates.into_iter().collect();
        }
        observations.push(observation);
    }

    observations.sort_by(|a, b| a.identity.cmp(&b.identity));
    Ok(DataProviderIdentityResponse {
        protocol: PROTOCOL,
        mode: "data_provider_identity",
        ready: true,
        complete: true,
        reason: None,
        observations,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn closure_failure(
    started: Instant,
    source_file: Option<String>,
    source_symbol: Option<String>,
    reason: &'static str,
    refresh_performed: bool,
    states_visited: usize,
) -> SymbolClosureResponse {
    SymbolClosureResponse {
        protocol: PROTOCOL,
        mode: "symbol_closure",
        ready: false,
        complete: false,
        reason: Some(reason.to_string()),
        source_file,
        source_symbol,
        states_visited,
        bindings: Vec::new(),
        files: Vec::new(),
        refresh_performed,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    }
}

fn import_resolution_unknown_for_symbol(
    cache: &CacheFile,
    file_set: &HashSet<String>,
    symbol: &str,
) -> Option<&'static str> {
    for (importer, cached) in &cache.files {
        for import in &cached.imports {
            if import.confidence != "exact_local"
                || !import.source_symbols.iter().any(|value| value == symbol)
            {
                continue;
            }

            match resolve_import(importer, import, file_set) {
                Resolution::Ambiguous => return Some("closure_import_ambiguous"),
                Resolution::Unresolved => return Some("closure_import_unresolved"),
                Resolution::Resolved(_) | Resolution::External => {}
            }
        }
    }

    None
}

fn unsupported_import_syntax_mentions_symbol(root: &Path, cache: &CacheFile, symbol: &str) -> bool {
    for (rel, cached) in &cache.files {
        if cached.parse_stats.unsupported_alias == 0 && cached.parse_stats.unsupported_dynamic == 0
        {
            continue;
        }

        let Ok(source) = fs::read_to_string(root.join(rel)) else {
            return true;
        };

        // Conservative by design: unsupported import syntax plus the target
        // spelling means the resolver cannot prove that the occurrence is
        // unrelated. False failure is preferable to false closure.
        if source.contains(symbol) {
            return true;
        }
    }

    false
}

fn edge_binding_is_current(
    root: &Path,
    edge: &EdgeRecord,
    target: &str,
    source_symbol: &str,
    local_symbol: &str,
    file_set: &HashSet<String>,
) -> bool {
    if edge.confidence != "exact_local" {
        return false;
    }

    let path = root.join(&edge.from);
    let Ok(source) = fs::read_to_string(&path) else {
        return false;
    };

    let (imports, _) = parse_imports(&path, &source);

    imports.iter().any(|import| {
        if import.line != edge.witness_line
            || import.kind != edge.kind
            || import.spec != edge.spec
            || import.confidence != "exact_local"
            || import.witness != edge.witness
        {
            return false;
        }

        if !import
            .binding_pairs
            .iter()
            .any(|pair| pair.source == source_symbol && pair.local == local_symbol)
        {
            return false;
        }

        matches!(
            resolve_import(&edge.from, import, file_set),
            Resolution::Resolved(value) if value == target
        )
    })
}

fn importer_has_unproven_member_use(root: &Path, edge: &EdgeRecord, symbol: &str) -> bool {
    /*
     * A named import with explicit BindingPairs is already structurally
     * resolved:
     *
     *     from service import welcome
     *
     * If `symbol` is not one of those source bindings, this edge cannot carry
     * that symbol. A same-spelled identifier elsewhere in the importer is
     * unrelated and must not poison the closure.
     *
     * The conservative member-binding fallback is only needed for
     * module/namespace imports, whose member access cannot currently be
     * represented by BindingPair:
     *
     *     import service
     *     service.price()
     *
     * Keep those fail-closed until a receiver/member validator exists.
     */
    if !edge.binding_pairs.is_empty() {
        return false;
    }

    let path = root.join(&edge.from);
    let Ok(source) = fs::read_to_string(&path) else {
        return true;
    };

    source.contains(symbol)
}

fn symbol_binding_failure(
    started: Instant,
    source_file: Option<String>,
    source_symbol: Option<String>,
    importer_file: Option<String>,
    reason: &'static str,
    inventory_kind: Option<String>,
    inventory_files: usize,
) -> SymbolBindingIntoFileResponse {
    SymbolBindingIntoFileResponse {
        protocol: PROTOCOL,
        mode: "symbol_binding_into_file",
        ready: false,
        complete: false,
        reason: Some(reason.to_string()),
        source_file,
        source_symbol,
        importer_file,
        bindings: Vec::new(),
        inventory_kind,
        inventory_files,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    }
}

fn symbol_binding_into_file(
    request: &SymbolBindingIntoFileRequest,
    root: &Path,
    started: Instant,
) -> Result<SymbolBindingIntoFileResponse> {
    let requested_source = request.source_file.trim_start_matches("./");
    let requested_importer = request.importer_file.trim_start_matches("./");

    let Some(source_file) = normalize_rel(Path::new(requested_source)) else {
        return Ok(symbol_binding_failure(
            started,
            None,
            Some(request.source_symbol.clone()),
            None,
            "binding_source_file_invalid",
            None,
            0,
        ));
    };

    let Some(importer_file) = normalize_rel(Path::new(requested_importer)) else {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            Some(request.source_symbol.clone()),
            None,
            "binding_importer_file_invalid",
            None,
            0,
        ));
    };

    let Some(source_symbol) = ident(&request.source_symbol) else {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            None,
            Some(importer_file),
            "binding_source_symbol_invalid",
            None,
            0,
        ));
    };

    if source_symbol != request.source_symbol {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            Some(request.source_symbol.clone()),
            Some(importer_file),
            "binding_source_symbol_invalid",
            None,
            0,
        ));
    }

    /*
     * This is relation-local completeness, not global symbol closure.
     *
     * Inventory is still bounded and must be complete so module resolution
     * cannot become falsely unique. Only the exact importer is parsed; parse
     * failures or unsupported syntax elsewhere are irrelevant to this
     * relation.
     */
    let (paths, capped, inventory_kind) = inventory(root)?;

    if capped {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            Some(source_symbol),
            Some(importer_file),
            "binding_inventory_truncated",
            Some(inventory_kind),
            paths.len(),
        ));
    }

    let mut file_set = HashSet::new();

    for absolute in &paths {
        let Ok(rel) = rel_string(root, absolute) else {
            return Ok(symbol_binding_failure(
                started,
                Some(source_file),
                Some(source_symbol),
                Some(importer_file),
                "binding_inventory_path_invalid",
                Some(inventory_kind),
                file_set.len(),
            ));
        };

        file_set.insert(rel);
    }

    if !file_set.contains(&source_file) {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            Some(source_symbol),
            Some(importer_file),
            "binding_source_file_missing",
            Some(inventory_kind),
            file_set.len(),
        ));
    }

    if !file_set.contains(&importer_file) {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            Some(source_symbol),
            Some(importer_file),
            "binding_importer_file_missing",
            Some(inventory_kind),
            file_set.len(),
        ));
    }

    let importer_path = root.join(&importer_file);
    let Ok(importer_source) = fs::read_to_string(&importer_path) else {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            Some(source_symbol),
            Some(importer_file),
            "binding_importer_read_failed",
            Some(inventory_kind),
            file_set.len(),
        ));
    };

    let (imports, parse_stats) = parse_imports(&importer_path, &importer_source);

    if (parse_stats.unsupported_alias > 0 || parse_stats.unsupported_dynamic > 0)
        && importer_source.contains(&source_symbol)
    {
        return Ok(symbol_binding_failure(
            started,
            Some(source_file),
            Some(source_symbol),
            Some(importer_file),
            "binding_importer_syntax_unsupported",
            Some(inventory_kind),
            file_set.len(),
        ));
    }

    let mut bindings = BTreeSet::<SymbolClosureBinding>::new();

    for import in imports {
        let mentions_symbol = import
            .source_symbols
            .iter()
            .any(|value| value == &source_symbol)
            || import
                .binding_pairs
                .iter()
                .any(|pair| pair.source == source_symbol);

        let resolved = resolve_import(&importer_file, &import, &file_set);

        match resolved {
            Resolution::Ambiguous if mentions_symbol => {
                return Ok(symbol_binding_failure(
                    started,
                    Some(source_file),
                    Some(source_symbol),
                    Some(importer_file),
                    "binding_import_ambiguous",
                    Some(inventory_kind),
                    file_set.len(),
                ));
            }
            Resolution::Unresolved if mentions_symbol => {
                return Ok(symbol_binding_failure(
                    started,
                    Some(source_file),
                    Some(source_symbol),
                    Some(importer_file),
                    "binding_import_unresolved",
                    Some(inventory_kind),
                    file_set.len(),
                ));
            }
            Resolution::Ambiguous | Resolution::Unresolved | Resolution::External => continue,
            Resolution::Resolved(target) if target != source_file => continue,
            Resolution::Resolved(_) => {}
        }

        if import.confidence != "exact_local" {
            return Ok(symbol_binding_failure(
                started,
                Some(source_file),
                Some(source_symbol),
                Some(importer_file),
                "binding_confidence_not_exact",
                Some(inventory_kind),
                file_set.len(),
            ));
        }

        let matching_pairs = import
            .binding_pairs
            .iter()
            .filter(|pair| pair.source == source_symbol)
            .collect::<Vec<_>>();

        if matching_pairs.is_empty() {
            /*
             * `import service; service.symbol()` is a real dependency on the
             * source module, but current BindingPair cannot prove the member
             * relation. Fail closed for this exact importer only.
             */
            if importer_source.contains(&source_symbol) {
                return Ok(symbol_binding_failure(
                    started,
                    Some(source_file),
                    Some(source_symbol),
                    Some(importer_file),
                    "binding_member_binding_unsupported",
                    Some(inventory_kind),
                    file_set.len(),
                ));
            }
            continue;
        }

        for pair in matching_pairs {
            bindings.insert(SymbolClosureBinding {
                importer: importer_file.clone(),
                target: source_file.clone(),
                kind: import.kind.clone(),
                witness_line: import.line,
                spec: import.spec.clone(),
                source_symbol: source_symbol.clone(),
                local_symbol: pair.local.clone(),
                witness: import.witness.clone(),
                confidence: import.confidence.clone(),
                propagates: false,
            });
        }
    }

    Ok(SymbolBindingIntoFileResponse {
        protocol: PROTOCOL,
        mode: "symbol_binding_into_file",
        ready: true,
        complete: true,
        reason: if bindings.is_empty() {
            Some("exact_binding_absent".to_string())
        } else {
            None
        },
        source_file: Some(source_file),
        source_symbol: Some(source_symbol),
        importer_file: Some(importer_file),
        bindings: bindings.into_iter().collect(),
        inventory_kind: Some(inventory_kind),
        inventory_files: file_set.len(),
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn symbol_closure(
    request: &SymbolClosureRequest,
    root: &Path,
    path: &Path,
    started: Instant,
) -> Result<SymbolClosureResponse> {
    let requested_file = request.source_file.trim_start_matches("./");

    let Some(parsed_file) = normalize_rel(Path::new(requested_file)) else {
        return Ok(closure_failure(
            started,
            None,
            Some(request.source_symbol.clone()),
            "closure_source_file_invalid",
            false,
            0,
        ));
    };

    let Some(parsed_symbol) = ident(&request.source_symbol) else {
        return Ok(closure_failure(
            started,
            Some(parsed_file),
            None,
            "closure_source_symbol_invalid",
            false,
            0,
        ));
    };

    if parsed_symbol != request.source_symbol {
        return Ok(closure_failure(
            started,
            Some(parsed_file),
            Some(request.source_symbol.clone()),
            "closure_source_symbol_invalid",
            false,
            0,
        ));
    }

    /*
     * Closure correctness is stricter than routing correctness.
     *
     * Do a deterministic incremental refresh first. Warm refreshes reuse
     * cached parse results; changed files alone are reparsed. We never promote
     * a stale routing cache into mutation evidence.
     */
    let refreshed = refresh(root, path, Instant::now())?;

    if refreshed.ready != true || refreshed.refresh_complete != Some(true) {
        return Ok(closure_failure(
            started,
            Some(parsed_file),
            Some(parsed_symbol),
            "closure_index_refresh_incomplete",
            true,
            0,
        ));
    }

    let Some(cache) = load_cache(path) else {
        return Ok(closure_failure(
            started,
            Some(parsed_file),
            Some(parsed_symbol),
            "closure_index_unavailable",
            true,
            0,
        ));
    };

    if !cache.coverage_complete || !cache.files.contains_key(&parsed_file) {
        return Ok(closure_failure(
            started,
            Some(parsed_file),
            Some(parsed_symbol),
            "closure_index_incomplete",
            true,
            0,
        ));
    }

    let max_bindings = request
        .max_bindings
        .unwrap_or(32)
        .clamp(1, MAX_SYMBOL_CLOSURE_BINDINGS);

    let file_set = cache.files.keys().cloned().collect::<HashSet<_>>();

    let mut queue = VecDeque::<(String, String)>::new();
    let mut seen_states = BTreeSet::<(String, String)>::new();
    let mut proven_bindings = BTreeSet::<SymbolClosureBinding>::new();
    let mut closure_files = BTreeSet::<String>::new();

    queue.push_back((parsed_file.clone(), parsed_symbol.clone()));
    closure_files.insert(parsed_file.clone());

    while let Some((target_file, source_symbol)) = queue.pop_front() {
        if !seen_states.insert((target_file.clone(), source_symbol.clone())) {
            continue;
        }

        if seen_states.len() > max_bindings + 1 {
            return Ok(closure_failure(
                started,
                Some(parsed_file),
                Some(parsed_symbol),
                "closure_state_budget_exceeded",
                true,
                seen_states.len(),
            ));
        }

        /*
         * If the index itself cannot resolve an import carrying this source
         * symbol, absence of an edge is not evidence that no dependency
         * exists.
         */
        if let Some(reason) =
            import_resolution_unknown_for_symbol(&cache, &file_set, &source_symbol)
        {
            return Ok(closure_failure(
                started,
                Some(parsed_file),
                Some(parsed_symbol),
                reason,
                true,
                seen_states.len(),
            ));
        }

        if unsupported_import_syntax_mentions_symbol(root, &cache, &source_symbol) {
            return Ok(closure_failure(
                started,
                Some(parsed_file),
                Some(parsed_symbol),
                "closure_unsupported_import_syntax",
                true,
                seen_states.len(),
            ));
        }

        for edge in cache.edges.iter().filter(|edge| edge.to == target_file) {
            let matching_pairs = edge
                .binding_pairs
                .iter()
                .filter(|pair| pair.source == source_symbol)
                .cloned()
                .collect::<Vec<_>>();

            /*
             * Module/namespace imports are dependency edges too, but a member
             * use is not represented by a source/local BindingPair. If the
             * importer mentions the symbol, this resolver cannot yet prove
             * the member binding.
             */
            if matching_pairs.is_empty() {
                if importer_has_unproven_member_use(root, edge, &source_symbol) {
                    return Ok(closure_failure(
                        started,
                        Some(parsed_file),
                        Some(parsed_symbol),
                        "closure_member_binding_unsupported",
                        true,
                        seen_states.len(),
                    ));
                }
                continue;
            }

            for pair in matching_pairs {
                if proven_bindings.len() >= max_bindings {
                    return Ok(closure_failure(
                        started,
                        Some(parsed_file),
                        Some(parsed_symbol),
                        "closure_binding_budget_exceeded",
                        true,
                        seen_states.len(),
                    ));
                }

                /*
                 * Graph edge is a hypothesis. Reparse the current importer,
                 * re-find the exact import record and rerun module resolution.
                 */
                if !edge_binding_is_current(
                    root,
                    edge,
                    &target_file,
                    &source_symbol,
                    &pair.local,
                    &file_set,
                ) {
                    return Ok(closure_failure(
                        started,
                        Some(parsed_file),
                        Some(parsed_symbol),
                        "closure_source_validation_failed",
                        true,
                        seen_states.len(),
                    ));
                }

                let propagates = pair.local == source_symbol;

                proven_bindings.insert(SymbolClosureBinding {
                    importer: edge.from.clone(),
                    target: target_file.clone(),
                    kind: edge.kind.clone(),
                    witness_line: edge.witness_line,
                    spec: edge.spec.clone(),
                    source_symbol: source_symbol.clone(),
                    local_symbol: pair.local.clone(),
                    witness: edge.witness.clone(),
                    confidence: edge.confidence.clone(),
                    propagates,
                });

                closure_files.insert(edge.from.clone());

                /*
                 * Identity import changes the importer's lexical binding and
                 * can itself be re-exported further.
                 *
                 * Alias import does not propagate:
                 *
                 *   from service import price as p
                 *
                 * source "price" changes, local "p" and p() remain stable.
                 */
                if propagates {
                    queue.push_back((edge.from.clone(), pair.local.clone()));
                }
            }
        }
    }

    Ok(SymbolClosureResponse {
        protocol: PROTOCOL,
        mode: "symbol_closure",
        ready: true,
        complete: true,
        reason: None,
        source_file: Some(parsed_file),
        source_symbol: Some(parsed_symbol),
        states_visited: seen_states.len(),
        bindings: proven_bindings.into_iter().collect(),
        files: closure_files.into_iter().collect(),
        refresh_performed: true,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

pub fn resolve_symbol_closure(
    root: &Path,
    source_file: &str,
    source_symbol: &str,
    max_bindings: usize,
) -> Result<SymbolClosureResponse> {
    let canonical = fs::canonicalize(root).context("cannot resolve project root")?;

    anyhow::ensure!(canonical.is_dir(), "project root is not a directory");

    let request = SymbolClosureRequest {
        source_file: source_file.to_string(),
        source_symbol: source_symbol.to_string(),
        max_bindings: Some(max_bindings.clamp(1, MAX_SYMBOL_CLOSURE_BINDINGS)),
    };

    let path = cache_path(&canonical);

    symbol_closure(&request, &canonical, &path, Instant::now())
}

pub fn run_cli() -> Result<()> {
    let started = Instant::now();
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("failed to read stdin")?;

    let mode_request: ModeRequest = serde_json::from_str(&input).context("invalid request JSON")?;

    let root = fs::canonicalize(&mode_request.root).context("cannot resolve project root")?;
    anyhow::ensure!(root.is_dir(), "project root is not a directory");

    let path = cache_path(&root);

    match mode_request.mode.as_str() {
        "data_provider_identity" => {
            let request: DataProviderIdentityRequest =
                serde_json::from_str(&input).context("invalid data provider identity request")?;
            let response = data_provider_identity(&request, &root, started)?;
            serde_json::to_writer(io::stdout(), &response)?;
        }
        "symbol_binding_into_file" => {
            let request: SymbolBindingIntoFileRequest =
                serde_json::from_str(&input).context("invalid symbol binding into file request")?;
            let response = symbol_binding_into_file(&request, &root, started)?;
            serde_json::to_writer(io::stdout(), &response)?;
        }
        "symbol_closure" => {
            let request: SymbolClosureRequest =
                serde_json::from_str(&input).context("invalid symbol closure request")?;
            let response = symbol_closure(&request, &root, &path, started)?;
            serde_json::to_writer(io::stdout(), &response)?;
        }
        "refresh" | "neighbors" => {
            let request: Request = serde_json::from_str(&input).context("invalid request JSON")?;
            let response = match request.mode.as_str() {
                "refresh" => refresh(&root, &path, started)?,
                "neighbors" => neighbors(&request, &root, &path, started)?,
                _ => unreachable!("mode checked above"),
            };
            serde_json::to_writer(io::stdout(), &response)?;
        }
        other => anyhow::bail!("unsupported mode: {other}"),
    }

    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_alias_separates_local_binding_from_source_symbol() {
        let r = parse_python_import(7, "from service import handle as h, other").unwrap();
        assert_eq!(r.bindings, vec!["h".to_string(), "other".to_string()]);
        assert_eq!(
            r.source_symbols,
            vec!["handle".to_string(), "other".to_string()]
        );
        assert_eq!(
            r.binding_pairs[0],
            BindingPair {
                local: "h".to_string(),
                source: "handle".to_string()
            }
        );
    }

    #[test]
    fn js_alias_separates_local_binding_from_source_symbol() {
        let mut stats = ParseStats::default();
        let r = parse_js_import(
            3,
            "import { handle as h, other } from './service.js'",
            &mut stats,
        )
        .unwrap();
        assert!(r.bindings.contains(&"h".to_string()));
        assert!(r.source_symbols.contains(&"handle".to_string()));
    }

    #[test]
    fn multiline_ts_import_preserves_named_bindings() {
        let mut stats = ParseStats::default();
        let source =
            "import type {\n    Alpha,\n    Beta as LocalBeta,\n} from \"./service.js\";\n";
        let imports = parse_js_imports(source, &mut stats);
        assert_eq!(imports.len(), 1);
        let r = &imports[0];
        assert_eq!(r.spec, "./service.js");
        assert!(r.bindings.contains(&"Alpha".to_string()));
        assert!(r.bindings.contains(&"LocalBeta".to_string()));
        assert!(r.source_symbols.contains(&"Alpha".to_string()));
        assert!(r.source_symbols.contains(&"Beta".to_string()));
    }

    #[test]
    fn multiline_namespace_import_is_recorded() {
        let mut stats = ParseStats::default();
        let source = "import * as ts from\n    \"./_namespaces/ts.js\";\n";
        let imports = parse_js_imports(source, &mut stats);
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].bindings, vec!["ts".to_string()]);
    }

    #[test]
    fn explicit_js_runtime_spec_maps_to_ts_source() {
        let files: HashSet<String> = ["src/service.ts"].into_iter().map(str::to_string).collect();
        let import = ImportRecord {
            spec: "./service.js".to_string(),
            line: 1,
            kind: "js_relative_import".to_string(),
            bindings: vec!["handle".to_string()],
            source_symbols: vec!["handle".to_string()],
            binding_pairs: vec![BindingPair {
                local: "handle".to_string(),
                source: "handle".to_string(),
            }],
            witness: "import { handle } from './service.js';".to_string(),
            confidence: "exact_local".to_string(),
        };
        match resolve_import("src/api.ts", &import, &files) {
            Resolution::Resolved(value) => assert_eq!(value, "src/service.ts"),
            other => panic!("unexpected resolution: {other:?}"),
        }
    }

    #[test]
    fn ambiguous_ts_resolution_is_rejected() {
        let files: HashSet<String> = ["src/service.ts", "src/service.js"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let import = ImportRecord {
            spec: "./service.js".to_string(),
            line: 1,
            kind: "js_relative_import".to_string(),
            bindings: vec!["handle".to_string()],
            source_symbols: vec!["handle".to_string()],
            binding_pairs: vec![BindingPair {
                local: "handle".to_string(),
                source: "handle".to_string(),
            }],
            witness: String::new(),
            confidence: "exact_local".to_string(),
        };
        assert!(matches!(
            resolve_import("src/api.ts", &import, &files),
            Resolution::Ambiguous
        ));
    }

    #[test]
    fn html_css_xml_docker_sql_are_resource_edges() {
        let html = parse_html_dependencies(
            1,
            "<link href=\"./base.css\" rel=\"stylesheet\"><script src=\"./app.js\"></script>",
        );
        assert_eq!(html.len(), 2);
        assert!(html.iter().any(|r| r.kind == "html_script"));
        assert!(html.iter().any(|r| r.kind == "html_link"));
        assert!(html.iter().all(|r| r.confidence == "exact_local_resource"));
        assert_eq!(
            parse_css_dependency(1, "@import './base.css';")
                .unwrap()
                .kind,
            "css_import"
        );
        assert_eq!(
            parse_xml_dependency(1, "<xs:include schemaLocation=\"./base.xsd\"/>")
                .unwrap()
                .kind,
            "xml_include"
        );
        assert_eq!(
            parse_docker_dependency(1, "COPY requirements.txt /app/")
                .unwrap()
                .kind,
            "docker_copy"
        );
        assert_eq!(
            parse_sql_dependency(1, "\\i ./schema.sql").unwrap().kind,
            "sql_include"
        );
    }

    #[test]
    fn pairwise_task_filter_keeps_matching_binding_beyond_four() {
        let wanted = ["e".to_string()].into_iter().collect::<HashSet<_>>();
        assert!(symbol_intersects(
            &["a".into(), "b".into(), "c".into(), "d".into(), "e".into()],
            &wanted
        ));
    }

    #[test]
    fn alias_pairs_survive_adversarial_sort_order() {
        let py =
            parse_python_import(1, "from service import Zebra as alpha, Alpha as zebra").unwrap();
        assert_eq!(
            py.binding_pairs,
            vec![
                BindingPair {
                    local: "alpha".to_string(),
                    source: "Zebra".to_string()
                },
                BindingPair {
                    local: "zebra".to_string(),
                    source: "Alpha".to_string()
                },
            ]
        );
        let mut stats = ParseStats::default();
        let js = parse_js_import(
            1,
            "import { Zebra as alpha, Alpha as zebra } from './service.js';",
            &mut stats,
        )
        .unwrap();
        assert_eq!(
            js.binding_pairs,
            vec![
                BindingPair {
                    local: "alpha".to_string(),
                    source: "Zebra".to_string()
                },
                BindingPair {
                    local: "zebra".to_string(),
                    source: "Alpha".to_string()
                },
            ]
        );
    }

    #[test]
    fn python_multiline_from_import_preserves_pairs() {
        let source = "from service import (\n    Alpha as a,\n    beta,  # comment\n)\n";
        let imports = parse_python_imports(source);
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].line, 1);
        assert_eq!(
            imports[0].binding_pairs,
            vec![
                BindingPair {
                    local: "a".to_string(),
                    source: "Alpha".to_string()
                },
                BindingPair {
                    local: "beta".to_string(),
                    source: "beta".to_string()
                },
            ]
        );
    }

    fn closure_test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "opencode-symbol-closure-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn run_closure_test(
        root: &Path,
        source_file: &str,
        source_symbol: &str,
    ) -> SymbolClosureResponse {
        let canonical = fs::canonicalize(root).unwrap();
        let request = SymbolClosureRequest {
            source_file: source_file.to_string(),
            source_symbol: source_symbol.to_string(),
            max_bindings: Some(32),
        };

        symbol_closure(
            &request,
            &canonical,
            &cache_path(&canonical),
            Instant::now(),
        )
        .unwrap()
    }

    fn run_binding_test(
        root: &Path,
        source_file: &str,
        source_symbol: &str,
        importer_file: &str,
    ) -> SymbolBindingIntoFileResponse {
        let canonical = fs::canonicalize(root).unwrap();
        let request = SymbolBindingIntoFileRequest {
            source_file: source_file.to_string(),
            source_symbol: source_symbol.to_string(),
            importer_file: importer_file.to_string(),
        };

        symbol_binding_into_file(&request, &canonical, Instant::now()).unwrap()
    }

    #[test]
    fn data_provider_identity_extracts_exact_psycopg2_config() {
        let source = r#"
import psycopg2
DB = {}
REPORTING_DB = {}
def primary():
    return psycopg2.connect(**DB)
def reporting():
    return psycopg2.connect(**REPORTING_DB)
"#;
        let rows =
            extract_python_data_provider_candidates("database.py", source, "REPORTING_DB").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].symbol, "reporting");
        assert_eq!(rows[0].configuration_identity, "REPORTING_DB");
    }

    #[test]
    fn data_provider_identity_rejects_arbitrary_connect() {
        let source = r#"
import serializer
REPORTING_DB = {}
def no():
    return serializer.connect(**REPORTING_DB)
"#;
        assert!(
            extract_python_data_provider_candidates("service.py", source, "REPORTING_DB",)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn data_provider_identity_supports_module_alias() {
        let source = r#"
import psycopg2 as pg
REPORTING_DB = {}
def reporting():
    return pg.connect(**REPORTING_DB)
"#;
        let rows =
            extract_python_data_provider_candidates("database.py", source, "REPORTING_DB").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].symbol, "reporting");
    }

    #[test]
    fn data_provider_identity_supports_connect_alias() {
        let source = r#"
from psycopg2 import connect as db_connect
REPORTING_DB = {}
def reporting():
    return db_connect(**REPORTING_DB)
"#;
        let rows =
            extract_python_data_provider_candidates("database.py", source, "REPORTING_DB").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].symbol, "reporting");
    }

    #[test]
    fn symbol_binding_into_file_is_target_conditioned() {
        let root = closure_test_root("target-conditioned-binding");

        fs::write(root.join("service.py"), "def handle():\n    return 1\n").unwrap();
        fs::write(
            root.join("host.py"),
            "from service import handle as h\n\ndef call():\n    return h()\n",
        )
        .unwrap();
        fs::write(
            root.join("unrelated.py"),
            "import service\n\ndef call():\n    return service.handle()\n",
        )
        .unwrap();

        let targeted = run_binding_test(&root, "service.py", "handle", "host.py");
        assert!(targeted.ready, "{targeted:?}");
        assert!(targeted.complete, "{targeted:?}");
        assert_eq!(targeted.reason, None);
        assert_eq!(targeted.bindings.len(), 1);
        assert_eq!(targeted.bindings[0].importer, "host.py");
        assert_eq!(targeted.bindings[0].target, "service.py");
        assert_eq!(targeted.bindings[0].source_symbol, "handle");
        assert_eq!(targeted.bindings[0].local_symbol, "h");
        assert_eq!(targeted.bindings[0].confidence, "exact_local");

        let global = run_closure_test(&root, "service.py", "handle");
        assert!(!global.ready);
        assert!(!global.complete);
        assert_eq!(
            global.reason.as_deref(),
            Some("closure_member_binding_unsupported")
        );

        let namespace = run_binding_test(&root, "service.py", "handle", "unrelated.py");
        assert!(!namespace.ready);
        assert!(!namespace.complete);
        assert_eq!(
            namespace.reason.as_deref(),
            Some("binding_member_binding_unsupported")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn symbol_closure_is_alias_aware_and_transitive() {
        let root = closure_test_root("alias-transitive");

        fs::write(root.join("service.py"), "def handle():\n    return 1\n").unwrap();

        fs::write(
            root.join("api.py"),
            "from service import handle\n\ndef call():\n    return handle()\n",
        )
        .unwrap();

        fs::write(
            root.join("consumer.py"),
            "from api import handle\n\ndef consume():\n    return handle()\n",
        )
        .unwrap();

        fs::write(
            root.join("alias_consumer.py"),
            "from service import handle as h\n\ndef consume():\n    return h()\n",
        )
        .unwrap();

        let closure = run_closure_test(&root, "service.py", "handle");

        assert!(closure.ready, "{closure:?}");
        assert!(closure.complete, "{closure:?}");

        assert!(closure.bindings.iter().any(|binding| {
            binding.importer == "api.py"
                && binding.target == "service.py"
                && binding.source_symbol == "handle"
                && binding.local_symbol == "handle"
                && binding.propagates
        }));

        assert!(closure.bindings.iter().any(|binding| {
            binding.importer == "consumer.py"
                && binding.target == "api.py"
                && binding.source_symbol == "handle"
                && binding.local_symbol == "handle"
                && binding.propagates
        }));

        assert!(closure.bindings.iter().any(|binding| {
            binding.importer == "alias_consumer.py"
                && binding.target == "service.py"
                && binding.source_symbol == "handle"
                && binding.local_symbol == "h"
                && !binding.propagates
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symbol_closure_rejects_ambiguous_module_resolution() {
        let root = closure_test_root("ambiguous-ts");

        fs::create_dir_all(root.join("src")).unwrap();

        fs::write(
            root.join("src/service.ts"),
            "export function handle() { return 1 }\n",
        )
        .unwrap();

        fs::write(
            root.join("src/service.js"),
            "export function handle() { return 2 }\n",
        )
        .unwrap();

        fs::write(
            root.join("src/api.ts"),
            "import { handle } from './service.js'\nexport const value = handle()\n",
        )
        .unwrap();

        let closure = run_closure_test(&root, "src/service.ts", "handle");

        assert!(!closure.complete, "{closure:?}");
        assert_eq!(closure.reason.as_deref(), Some("closure_import_ambiguous"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symbol_closure_ignores_unrelated_named_member_edges() {
        let root = closure_test_root("unrelated-named-member-edge");

        fs::write(root.join("app.py"), "def greet():\n    return 1\n").unwrap();

        fs::write(
            root.join("service.py"),
            "from app import greet\n\ndef welcome():\n    return greet()\n",
        )
        .unwrap();

        /*
         * This file carries `greet` directly from app.py and independently
         * imports a different member (`welcome`) from service.py.
         *
         * While resolving the propagated state (service.py, greet), the
         * service->test edge must not be treated as an unproven greet member
         * merely because the importer also contains the spelling `greet`.
         */
        fs::write(
            root.join("test_app.py"),
            concat!(
                "from app import greet\n",
                "from service import welcome\n\n",
                "def test_greet():\n",
                "    assert greet() == 1\n\n",
                "def test_welcome():\n",
                "    assert welcome() == 1\n",
            ),
        )
        .unwrap();

        let closure = run_closure_test(&root, "app.py", "greet");

        assert!(closure.ready, "{closure:?}");
        assert!(closure.complete, "{closure:?}");
        assert_eq!(closure.reason, None);

        assert!(
            closure.bindings.iter().any(|binding| {
                binding.importer == "service.py"
                    && binding.target == "app.py"
                    && binding.source_symbol == "greet"
                    && binding.local_symbol == "greet"
                    && binding.propagates
            }),
            "{closure:?}"
        );

        assert!(
            closure.bindings.iter().any(|binding| {
                binding.importer == "test_app.py"
                    && binding.target == "app.py"
                    && binding.source_symbol == "greet"
                    && binding.local_symbol == "greet"
                    && binding.propagates
            }),
            "{closure:?}"
        );

        assert!(
            !closure.bindings.iter().any(|binding| {
                binding.target == "service.py" && binding.source_symbol == "greet"
            }),
            "{closure:?}"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symbol_closure_does_not_guess_namespace_member_binding() {
        let root = closure_test_root("namespace");

        fs::write(root.join("service.py"), "def handle():\n    return 1\n").unwrap();

        fs::write(
            root.join("api.py"),
            "import service\n\ndef call():\n    return service.handle()\n",
        )
        .unwrap();

        let closure = run_closure_test(&root, "service.py", "handle");

        assert!(!closure.complete, "{closure:?}");
        assert_eq!(
            closure.reason.as_deref(),
            Some("closure_member_binding_unsupported")
        );

        fs::remove_dir_all(root).unwrap();
    }
}
