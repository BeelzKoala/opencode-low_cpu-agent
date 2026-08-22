use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::Command,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const PROTOCOL: &str = "impact-index-v1";
const CACHE_VERSION: u32 = 3;
// Safety ceiling only. Git-aware inventory is the primary scaling mechanism.
const DEFAULT_MAX_FILES: usize = 50_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_IMPORTS_PER_FILE: usize = 192;
const DEFAULT_MAX_NEIGHBORS: usize = 24;
const MAX_NEIGHBORS: usize = 64;
const MAX_BINDINGS: usize = 16;
const MAX_WITNESS_CHARS: usize = 180;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    mode: String,
    #[serde(default)]
    seed_files: Vec<String>,
    #[serde(default)]
    max_neighbors: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ImportRecord {
    spec: String,
    line: usize,
    kind: String,
    // Identifier used by the importing file after aliases are applied.
    bindings: Vec<String>,
    // Identifier expected to exist in the target module/file.
    #[serde(default)]
    source_symbols: Vec<String>,
    witness: String,
    // exact_local can be activated; exact_local_resource remains shadow-only.
    confidence: String,
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
    witness_line: usize,
    spec: String,
    bindings: Vec<String>,
    #[serde(default)]
    source_symbols: Vec<String>,
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
    protocol: String,
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
    files: BTreeMap<String, CachedFile>,
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
    witness: String,
    confidence: String,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    mode: String,
    ready: bool,
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
    walk_elapsed_ms: Option<f64>,
    parse_elapsed_ms: Option<f64>,
    elapsed_ms: f64,
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
        ".git" | ".opencode" | ".agentbench" | "node_modules" | ".venv" | "venv"
            | "__pycache__" | "target" | "dist" | "build" | ".next" | ".cache"
    )
}

fn language_key(path: &Path) -> &'static str {
    let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if name == "dockerfile" || name.starts_with("dockerfile.") || name.ends_with(".dockerfile") {
        return "docker";
    }
    match path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
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
            Component::ParentDir => { parts.pop()?; }
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

fn rel_string(root: &Path, path: &Path) -> Result<String> {
    let rel = path.strip_prefix(root).context("indexed path escaped root")?;
    normalize_rel(rel).context("cannot normalize indexed path")
}

fn git_inventory(root: &Path) -> Option<(Vec<PathBuf>, bool)> {
    let output = Command::new("git")
        .arg("-C").arg(root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .output().ok()?;
    if !output.status.success() { return None; }

    let mut files = Vec::new();
    let mut capped = false;
    for raw in output.stdout.split(|b| *b == 0) {
        if raw.is_empty() { continue; }
        if files.len() >= max_files() { capped = true; break; }
        let rel = String::from_utf8_lossy(raw);
        let path = root.join(rel.as_ref());
        let meta = match fs::metadata(&path) { Ok(v) => v, Err(_) => continue };
        if meta.is_file() && meta.len() <= MAX_FILE_BYTES && supported(&path) {
            files.push(path);
        }
    }
    files.sort();
    Some((files, capped))
}

fn walk_files(root: &Path) -> Result<(Vec<PathBuf>, bool)> {
    fn visit(dir: &Path, out: &mut Vec<PathBuf>, capped: &mut bool) -> Result<()> {
        if *capped { return Ok(()); }
        let mut entries: Vec<_> = fs::read_dir(dir)
            .with_context(|| format!("cannot read {}", dir.display()))?
            .filter_map(|entry| entry.ok()).collect();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            if out.len() >= max_files() { *capped = true; break; }
            let file_type = match entry.file_type() { Ok(v) => v, Err(_) => continue };
            if file_type.is_symlink() { continue; }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if !is_skipped_dir(&name) { visit(&path, out, capped)?; }
                continue;
            }
            if !file_type.is_file() || !supported(&path) { continue; }
            let meta = match entry.metadata() { Ok(v) => v, Err(_) => continue };
            if meta.len() <= MAX_FILE_BYTES { out.push(path); }
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
    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH).unwrap_or_default()
        .as_millis().min(u64::MAX as u128) as u64
}

fn clipped_witness(line: &str) -> String {
    line.trim().chars().take(MAX_WITNESS_CHARS).collect()
}

fn ident(raw: &str) -> Option<String> {
    let value = raw.trim()
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '$')
        .chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect::<String>();
    if value.is_empty() { None } else { Some(value) }
}

fn local_binding(source: &str, alias: Option<&str>) -> Option<String> {
    alias.and_then(ident).or_else(|| ident(source))
}

fn python_import_items(raw: &str) -> (Vec<String>, Vec<String>) {
    let mut locals = BTreeSet::new();
    let mut sources = BTreeSet::new();
    for item in raw.split(',') {
        let mut parts = item.trim().split_whitespace();
        let source = parts.next().unwrap_or("");
        if source == "*" || source.is_empty() { continue; }
        let alias = if parts.next() == Some("as") { parts.next() } else { None };
        if let Some(src) = ident(source) {
            sources.insert(src.clone());
            if let Some(local) = local_binding(&src, alias) { locals.insert(local); }
        }
        if locals.len() >= MAX_BINDINGS { break; }
    }
    (locals.into_iter().collect(), sources.into_iter().collect())
}

fn parse_python_import(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.contains('\\') { return None; }

    if let Some(rest) = trimmed.strip_prefix("from ") {
        let (spec, imported) = rest.split_once(" import ")?;
        let spec = spec.trim();
        if spec.is_empty() || imported.contains('(') || imported.contains(')') { return None; }
        let (bindings, source_symbols) = python_import_items(imported);
        if bindings.is_empty() { return None; }
        return Some(ImportRecord {
            spec: spec.to_string(), line: line_no, kind: "python_from".to_string(),
            bindings, source_symbols, witness: clipped_witness(line), confidence: "exact_local".to_string(),
        });
    }

    if let Some(rest) = trimmed.strip_prefix("import ") {
        if rest.contains(',') { return None; }
        let mut parts = rest.split_whitespace();
        let spec = parts.next()?.trim();
        let alias = if parts.next() == Some("as") { parts.next() } else { None };
        if spec.is_empty() { return None; }
        let default_local = spec.split('.').next().unwrap_or(spec);
        let binding = local_binding(default_local, alias).into_iter().collect();
        return Some(ImportRecord {
            spec: spec.to_string(), line: line_no, kind: "python_import".to_string(),
            bindings: binding, source_symbols: Vec::new(), witness: clipped_witness(line), confidence: "exact_local".to_string(),
        });
    }
    None
}

fn quoted_specs(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let quote = bytes[i];
        if quote != b'\'' && quote != b'"' { i += 1; continue; }
        let start = i + 1;
        i = start;
        while i < bytes.len() && bytes[i] != quote {
            if bytes[i] == b'\\' { i += 1; }
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

fn is_relative_spec(spec: &str) -> bool { spec.starts_with("./") || spec.starts_with("../") }
fn is_remote_spec(spec: &str) -> bool {
    spec.starts_with("http://") || spec.starts_with("https://") || spec.starts_with("//")
        || spec.starts_with("data:") || spec.starts_with("javascript:") || spec.starts_with('#')
}
fn looks_alias_spec(spec: &str) -> bool {
    spec.starts_with("@/") || spec.starts_with("~/") || spec.starts_with("#/")
}

fn js_named_bindings(clause: &str) -> (Vec<String>, Vec<String>) {
    let Some(inner) = clause.trim().strip_prefix('{').and_then(|v| v.strip_suffix('}')) else {
        return (Vec::new(), Vec::new());
    };
    let mut locals = BTreeSet::new();
    let mut sources = BTreeSet::new();
    for item in inner.split(',') {
        let item = item.trim();
        if item.is_empty() { continue; }
        let (source, local) = if let Some((a, b)) = item.split_once(" as ") { (a.trim(), b.trim()) } else { (item, item) };
        if let (Some(src), Some(loc)) = (ident(source), ident(local)) {
            sources.insert(src);
            locals.insert(loc);
        }
    }
    (locals.into_iter().take(MAX_BINDINGS).collect(), sources.into_iter().take(MAX_BINDINGS).collect())
}

fn parse_js_import(line_no: usize, line: &str, stats: &mut ParseStats) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let specs = quoted_specs(trimmed);
    let spec = specs.last()?.clone();
    let import_like = trimmed.starts_with("import ") || trimmed.contains("require(") || trimmed.contains("import(");
    if !import_like { return None; }

    if !is_relative_spec(&spec) {
        if looks_alias_spec(&spec) { stats.unsupported_alias += 1; }
        else { stats.external_package += 1; }
        return None;
    }
    if trimmed.contains("import(") { stats.unsupported_dynamic += 1; return None; }

    let mut bindings = Vec::new();
    let mut source_symbols = Vec::new();
    if let Some(body) = trimmed.strip_prefix("import ") {
        if let Some((clause, _)) = body.split_once(" from ") {
            let clause = clause.trim();
            if clause.starts_with('{') {
                (bindings, source_symbols) = js_named_bindings(clause);
            } else if let Some(rest) = clause.strip_prefix("* as ") {
                bindings = ident(rest).into_iter().collect();
            } else if !clause.is_empty() {
                bindings = ident(clause.split(',').next().unwrap_or("")).into_iter().collect();
            }
        }
    }

    Some(ImportRecord {
        spec, line: line_no,
        kind: if trimmed.contains("require(") { "js_require" } else { "js_relative_import" }.to_string(),
        bindings, source_symbols, witness: clipped_witness(line), confidence: "exact_local".to_string(),
    })
}

fn parse_rust_import(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let no_vis = trimmed.strip_prefix("pub ").unwrap_or(trimmed);
    if let Some(rest) = no_vis.strip_prefix("mod ") {
        let name = ident(rest)?;
        return Some(ImportRecord { spec: name.clone(), line: line_no, kind: "rust_mod".to_string(), bindings: vec![name], source_symbols: Vec::new(), witness: clipped_witness(line), confidence: "exact_local".to_string() });
    }
    if let Some(rest) = no_vis.strip_prefix("use crate::") {
        if rest.contains('*') { return None; }
        let value = rest.trim().trim_end_matches(';');
        let source = value.rsplit("::").next().and_then(ident).into_iter().collect::<Vec<_>>();
        return Some(ImportRecord { spec: value.to_string(), line: line_no, kind: "rust_crate_use".to_string(), bindings: source.clone(), source_symbols: source, witness: clipped_witness(line), confidence: "exact_local".to_string() });
    }
    None
}

fn parse_c_include(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if !trimmed.starts_with("#include") { return None; }
    let spec = quoted_specs(trimmed).into_iter().next()?;
    Some(ImportRecord { spec, line: line_no, kind: "c_quote_include".to_string(), bindings: Vec::new(), source_symbols: Vec::new(), witness: clipped_witness(line), confidence: "exact_local_resource".to_string() })
}

fn resource_binding(spec: &str) -> Vec<String> {
    Path::new(spec).file_stem().and_then(|v| v.to_str()).and_then(ident).into_iter().collect()
}

fn local_resource_record(line_no: usize, line: &str, kind: &str, spec: String) -> Option<ImportRecord> {
    if is_remote_spec(&spec) || spec.contains("{{") || spec.contains("${") || spec.contains("<%") { return None; }
    Some(ImportRecord { bindings: resource_binding(&spec), source_symbols: Vec::new(), spec, line: line_no, kind: kind.to_string(), witness: clipped_witness(line), confidence: "exact_local_resource".to_string() })
}

fn extract_attr(line: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(pos) = line.find(&needle) {
            let rest = &line[pos + needle.len()..];
            if let Some(end) = rest.find(quote) { return Some(rest[..end].to_string()); }
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
        let Some(rel) = lower[cursor..].find(&tag_lower) else { break; };
        let start = cursor + rel;
        let end = lower[start..].find('>').map(|v| start + v + 1).unwrap_or(line.len());
        if let Some(segment) = line.get(start..end) {
            if let Some(value) = extract_attr(segment, attr) { out.push(value); }
        }
        if end <= cursor { break; }
        cursor = end;
    }
    out
}

fn parse_html_dependencies(line_no: usize, line: &str) -> Vec<ImportRecord> {
    let mut out = Vec::new();
    for spec in extract_tag_attr_all(line, "<script", "src") {
        if let Some(record) = local_resource_record(line_no, line, "html_script", spec) { out.push(record); }
    }
    for spec in extract_tag_attr_all(line, "<link", "href") {
        if let Some(record) = local_resource_record(line_no, line, "html_link", spec) { out.push(record); }
    }
    out
}

fn parse_css_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if !trimmed.starts_with("@import") { return None; }
    let spec = quoted_specs(trimmed).into_iter().next().or_else(|| {
        let start = trimmed.find("url(")? + 4;
        let end = trimmed[start..].find(')')? + start;
        Some(trimmed[start..end].trim().trim_matches(|c| c == '"' || c == '\'').to_string())
    })?;
    local_resource_record(line_no, line, "css_import", spec)
}

fn parse_xml_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let lower = line.to_ascii_lowercase();
    if !(lower.contains("include") || lower.contains("import")) { return None; }
    for attr in ["schemaLocation", "href", "file"] {
        if let Some(spec) = extract_attr(line, attr) { return local_resource_record(line_no, line, "xml_include", spec); }
    }
    None
}

fn parse_docker_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let upper = trimmed.to_ascii_uppercase();
    if !(upper.starts_with("COPY ") || upper.starts_with("ADD ")) { return None; }
    if trimmed.contains("--from=") { return None; }
    let rest = trimmed.split_whitespace().skip(1).collect::<Vec<_>>();
    if rest.len() < 2 { return None; }
    let spec = rest[rest.len() - 2].trim_matches(|c| c == '"' || c == '\'').to_string();
    if spec.contains('*') || spec.contains('?') { return None; }
    local_resource_record(line_no, line, "docker_copy", spec)
}

fn parse_sql_dependency(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    let spec = if lower.starts_with("\\i ") || lower.starts_with("\\ir ") || lower.starts_with(".read ") || lower.starts_with("source ") {
        trimmed.split_whitespace().nth(1)?.trim_matches(|c| c == '"' || c == '\'' || c == ';').to_string()
    } else { return None; };
    local_resource_record(line_no, line, "sql_include", spec)
}

fn parse_imports(path: &Path, source: &str) -> (Vec<ImportRecord>, ParseStats) {
    let lang = language_key(path);
    let mut out = Vec::new();
    let mut stats = ParseStats::default();
    for (idx, line) in source.lines().enumerate() {
        if out.len() >= MAX_IMPORTS_PER_FILE { break; }
        let line_no = idx + 1;
        let records: Vec<ImportRecord> = match lang {
            "python" => parse_python_import(line_no, line).into_iter().collect(),
            "javascript" | "typescript" => parse_js_import(line_no, line, &mut stats).into_iter().collect(),
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
            if out.len() >= MAX_IMPORTS_PER_FILE { break; }
            out.push(record);
        }
    }
    (out, stats)
}

fn unique_existing(candidates: impl IntoIterator<Item = String>, file_set: &HashSet<String>) -> Resolution {
    let found: BTreeSet<_> = candidates.into_iter().filter(|c| file_set.contains(c)).collect();
    match found.len() {
        0 => Resolution::Unresolved,
        1 => Resolution::Resolved(found.into_iter().next().unwrap()),
        _ => Resolution::Ambiguous,
    }
}

fn python_candidates(importer: &str, spec: &str) -> Vec<String> {
    let mut dots = 0usize;
    for ch in spec.chars() { if ch == '.' { dots += 1; } else { break; } }
    let module = spec[dots..].replace('.', "/");
    let mut base = if dots == 0 { PathBuf::new() } else {
        let mut parent = Path::new(importer).parent().unwrap_or_else(|| Path::new("")).to_path_buf();
        for _ in 1..dots { parent.pop(); }
        parent
    };
    if !module.is_empty() { base.push(module); }
    let Some(base) = normalize_rel(&base) else { return Vec::new(); };
    if base.is_empty() { return Vec::new(); }
    vec![format!("{base}.py"), format!("{base}/__init__.py")]
}

fn ts_extension_substitutions(base: &str, ext: &str) -> Vec<String> {
    let stem_path = Path::new(base).with_extension("");
    let Some(stem) = normalize_rel(&stem_path) else { return Vec::new(); };
    let mapped: &[&str] = match ext {
        "js" => &["ts", "tsx", "d.ts", "js", "jsx"],
        "jsx" => &["tsx", "d.ts", "jsx"],
        "mjs" => &["mts", "d.mts", "mjs"],
        "cjs" => &["cts", "d.cts", "cjs"],
        _ => &[],
    };
    mapped.iter().map(|mapped_ext| format!("{stem}.{mapped_ext}")).collect()
}

fn relative_module_candidates(importer: &str, spec: &str) -> Vec<String> {
    let parent = Path::new(importer).parent().unwrap_or_else(|| Path::new(""));
    let Some(base) = normalize_rel(&parent.join(spec)) else { return Vec::new(); };
    let ext = Path::new(&base).extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if !ext.is_empty() {
        let mut out = vec![base.clone()];
        out.extend(ts_extension_substitutions(&base, &ext));
        out.sort(); out.dedup();
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
    let base = if matches!(file_name, "lib.rs" | "main.rs" | "mod.rs") { path.parent().unwrap_or_else(|| Path::new("")).to_path_buf() } else { path.with_extension("") };
    let Some(base) = normalize_rel(&base.join(name)) else { return Vec::new(); };
    vec![format!("{base}.rs"), format!("{base}/mod.rs")]
}

fn rust_crate_candidates(spec: &str) -> Vec<String> {
    let raw = spec.trim().trim_end_matches(';');
    let parts: Vec<_> = raw.split("::").filter(|v| !v.is_empty()).collect();
    let mut out = Vec::new();
    if !parts.is_empty() {
        let whole = parts.join("/"); out.push(format!("src/{whole}.rs")); out.push(format!("src/{whole}/mod.rs"));
    }
    if parts.len() >= 2 {
        let module = parts[..parts.len()-1].join("/"); out.push(format!("src/{module}.rs")); out.push(format!("src/{module}/mod.rs"));
    }
    out
}

fn local_path_candidates(importer: &str, spec: &str) -> Vec<String> {
    let parent = Path::new(importer).parent().unwrap_or_else(|| Path::new(""));
    let mut out = Vec::new();
    if let Some(local) = normalize_rel(&parent.join(spec.trim_start_matches('/'))) { out.push(local); }
    if let Some(root) = normalize_rel(Path::new(spec.trim_start_matches('/'))) { out.push(root); }
    out.sort(); out.dedup(); out
}

fn resolve_import(importer: &str, import: &ImportRecord, file_set: &HashSet<String>) -> Resolution {
    match import.kind.as_str() {
        "python_from" | "python_import" => {
            let result = unique_existing(python_candidates(importer, &import.spec), file_set);
            if matches!(result, Resolution::Unresolved) && !import.spec.starts_with('.') { Resolution::External } else { result }
        }
        "js_relative_import" | "js_require" => unique_existing(relative_module_candidates(importer, &import.spec), file_set),
        "rust_mod" => unique_existing(rust_mod_candidates(importer, &import.spec), file_set),
        "rust_crate_use" => unique_existing(rust_crate_candidates(&import.spec), file_set),
        "c_quote_include" | "html_script" | "html_link" | "css_import" | "xml_include" | "docker_copy" | "sql_include" => {
            unique_existing(local_path_candidates(importer, &import.spec), file_set)
        }
        _ => Resolution::Unresolved,
    }
}

fn cache_path(root: &Path) -> PathBuf { root.join(".opencode").join("impact-index-v1.json") }

fn load_cache(path: &Path) -> Option<CacheFile> {
    let bytes = fs::read(path).ok()?;
    let cache = serde_json::from_slice::<CacheFile>(&bytes).ok()?;
    if cache.protocol == PROTOCOL && cache.version == CACHE_VERSION { Some(cache) } else { None }
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
    if raw.is_empty() || Path::new(raw).is_absolute() { return None; }
    let normalized = normalize_rel(Path::new(raw.trim_start_matches("./")))?;
    if cache.files.contains_key(&normalized) { Some(normalized) } else { None }
}

fn empty_response(mode: &str, path: &Path, started: Instant) -> Response {
    Response {
        protocol: PROTOCOL, mode: mode.to_string(), ready: false, refresh_complete: None,
        coverage_complete: None, partial_reason: None, inventory_kind: None,
        cache_path: path.display().to_string(), cache_age_ms: None, files_total: 0,
        files_reused: None, files_reindexed: None, files_removed: None, imports_total: 0,
        edges_total: 0, resolved_imports: None, unresolved_imports: None,
        local_resolved: None, local_unresolved: None, local_ambiguous: None,
        external_package: None, unsupported_alias: None, unsupported_dynamic: None,
        skipped_files: None, lossy_files: None, capped: None, seed_files: Vec::new(),
        neighbors_total: 0, neighbors: Vec::new(), walk_elapsed_ms: None, parse_elapsed_ms: None,
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
        let rel = match rel_string(root, &absolute) { Ok(v) => v, Err(_) => { skipped_files += 1; continue; } };
        let metadata = match fs::metadata(&absolute) { Ok(v) => v, Err(_) => { skipped_files += 1; continue; } };
        let size = metadata.len();
        let mtime = mtime_ms(&metadata);
        if let Some(old) = previous.files.get(&rel) {
            if old.size == size && old.mtime_ms == mtime { files.insert(rel, old.clone()); files_reused += 1; continue; }
        }
        match fs::read(&absolute) {
            Ok(bytes) => {
                let was_lossy = std::str::from_utf8(&bytes).is_err();
                let source = String::from_utf8_lossy(&bytes);
                if was_lossy { lossy_files += 1; }
                let (imports, parse_stats) = parse_imports(&absolute, source.as_ref());
                files.insert(rel, CachedFile { size, mtime_ms: mtime, imports, parse_stats });
                files_reindexed += 1;
            }
            Err(_) => skipped_files += 1,
        }
    }

    let files_removed = previous.files.keys().filter(|key| !files.contains_key(*key)).count();
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
                        from: importer.clone(), to: target, kind: import.kind.clone(), witness_line: import.line,
                        spec: import.spec.clone(), bindings: import.bindings.clone(), source_symbols: import.source_symbols.clone(),
                        witness: import.witness.clone(), confidence: import.confidence.clone(),
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
    if capped { reasons.push("file_budget"); }
    if skipped_files > 0 { reasons.push("read_errors"); }
    let coverage_complete = reasons.is_empty();
    let partial_reason = if reasons.is_empty() { None } else { Some(reasons.join(",")) };
    let parse_elapsed = parse_started.elapsed().as_secs_f64() * 1000.0;
    let cache = CacheFile {
        protocol: PROTOCOL.to_string(), version: CACHE_VERSION, refreshed_at_ms: now_ms(), coverage_complete,
        partial_reason: partial_reason.clone(), inventory_kind: inventory_kind.clone(), stats: stats.clone(),
        files, edges: edges.into_iter().collect(),
    };

    // Partial routing data is useful, but never replace a known complete cache with a partial refresh.
    let use_new_cache = coverage_complete || previous.files.is_empty() || !previous.coverage_complete;
    if use_new_cache { write_cache(path, &cache)?; }
    let ready = use_new_cache || !previous.files.is_empty();
    let effective = if use_new_cache { &cache } else { &previous };
    let imports_total = effective.files.values().map(|file| file.imports.len()).sum();

    Ok(Response {
        protocol: PROTOCOL, mode: "refresh".to_string(), ready,
        refresh_complete: Some(coverage_complete), coverage_complete: Some(coverage_complete),
        partial_reason, inventory_kind: Some(inventory_kind), cache_path: path.display().to_string(), cache_age_ms: Some(0),
        files_total: effective.files.len(), files_reused: Some(files_reused), files_reindexed: Some(files_reindexed), files_removed: Some(files_removed),
        imports_total, edges_total: effective.edges.len(),
        resolved_imports: Some(stats.local_resolved), unresolved_imports: Some(stats.local_unresolved + stats.local_ambiguous),
        local_resolved: Some(stats.local_resolved), local_unresolved: Some(stats.local_unresolved), local_ambiguous: Some(stats.local_ambiguous),
        external_package: Some(stats.external_package), unsupported_alias: Some(stats.unsupported_alias), unsupported_dynamic: Some(stats.unsupported_dynamic),
        skipped_files: Some(skipped_files), lossy_files: Some(lossy_files), capped: Some(capped), seed_files: Vec::new(),
        neighbors_total: 0, neighbors: Vec::new(), walk_elapsed_ms: Some(walk_elapsed), parse_elapsed_ms: Some(parse_elapsed),
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn neighbors(request: &Request, path: &Path, started: Instant) -> Result<Response> {
    let Some(cache) = load_cache(path) else { return Ok(empty_response("neighbors", path, started)); };
    let max_neighbors = request.max_neighbors.unwrap_or(DEFAULT_MAX_NEIGHBORS).clamp(1, MAX_NEIGHBORS);
    let seeds: Vec<String> = request.seed_files.iter().filter_map(|seed| sanitize_seed(seed, &cache)).collect::<BTreeSet<_>>().into_iter().collect();
    let seed_set: HashSet<_> = seeds.iter().cloned().collect();
    let mut out = BTreeSet::new();
    for edge in &cache.edges {
        if seed_set.contains(&edge.from) { out.insert((edge.from.clone(), edge.to.clone(), "forward".to_string(), edge.clone())); }
        if seed_set.contains(&edge.to) { out.insert((edge.to.clone(), edge.from.clone(), "reverse".to_string(), edge.clone())); }
    }
    let neighbors_total = out.len();
    let neighbors = out.into_iter().take(max_neighbors).map(|(seed, file, direction, edge)| Neighbor {
        seed, file, direction, kind: edge.kind, witness_file: edge.from, witness_line: edge.witness_line,
        spec: edge.spec, bindings: edge.bindings, source_symbols: edge.source_symbols,
        witness: edge.witness, confidence: edge.confidence,
    }).collect::<Vec<_>>();
    let imports_total = cache.files.values().map(|file| file.imports.len()).sum();
    let st = &cache.stats;

    Ok(Response {
        protocol: PROTOCOL, mode: "neighbors".to_string(), ready: true, refresh_complete: None,
        coverage_complete: Some(cache.coverage_complete), partial_reason: cache.partial_reason.clone(), inventory_kind: Some(cache.inventory_kind.clone()),
        cache_path: path.display().to_string(), cache_age_ms: Some(now_ms().saturating_sub(cache.refreshed_at_ms)), files_total: cache.files.len(),
        files_reused: None, files_reindexed: None, files_removed: None, imports_total, edges_total: cache.edges.len(),
        resolved_imports: Some(st.local_resolved), unresolved_imports: Some(st.local_unresolved + st.local_ambiguous),
        local_resolved: Some(st.local_resolved), local_unresolved: Some(st.local_unresolved), local_ambiguous: Some(st.local_ambiguous),
        external_package: Some(st.external_package), unsupported_alias: Some(st.unsupported_alias), unsupported_dynamic: Some(st.unsupported_dynamic),
        skipped_files: None, lossy_files: None, capped: None, seed_files: seeds, neighbors_total, neighbors,
        walk_elapsed_ms: None, parse_elapsed_ms: None, elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn main() -> Result<()> {
    let started = Instant::now();
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).context("failed to read stdin")?;
    let request: Request = serde_json::from_str(&input).context("invalid request JSON")?;
    let root = fs::canonicalize(&request.root).context("cannot resolve project root")?;
    anyhow::ensure!(root.is_dir(), "project root is not a directory");
    let path = cache_path(&root);
    let response = match request.mode.as_str() {
        "refresh" => refresh(&root, &path, started)?,
        "neighbors" => neighbors(&request, &path, started)?,
        other => anyhow::bail!("unsupported mode: {other}"),
    };
    serde_json::to_writer(io::stdout(), &response)?;
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
        assert_eq!(r.source_symbols, vec!["handle".to_string(), "other".to_string()]);
    }

    #[test]
    fn js_alias_separates_local_binding_from_source_symbol() {
        let mut stats = ParseStats::default();
        let r = parse_js_import(3, "import { handle as h, other } from './service.js'", &mut stats).unwrap();
        assert!(r.bindings.contains(&"h".to_string()));
        assert!(r.source_symbols.contains(&"handle".to_string()));
    }

    #[test]
    fn explicit_js_runtime_spec_maps_to_ts_source() {
        let files: HashSet<String> = ["src/service.ts"].into_iter().map(str::to_string).collect();
        let import = ImportRecord { spec: "./service.js".to_string(), line: 1, kind: "js_relative_import".to_string(), bindings: vec!["handle".to_string()], source_symbols: vec!["handle".to_string()], witness: "import { handle } from './service.js';".to_string(), confidence: "exact_local".to_string() };
        match resolve_import("src/api.ts", &import, &files) {
            Resolution::Resolved(value) => assert_eq!(value, "src/service.ts"),
            other => panic!("unexpected resolution: {other:?}"),
        }
    }

    #[test]
    fn ambiguous_ts_resolution_is_rejected() {
        let files: HashSet<String> = ["src/service.ts", "src/service.js"].into_iter().map(str::to_string).collect();
        let import = ImportRecord { spec: "./service.js".to_string(), line: 1, kind: "js_relative_import".to_string(), bindings: vec!["handle".to_string()], source_symbols: vec!["handle".to_string()], witness: String::new(), confidence: "exact_local".to_string() };
        assert!(matches!(resolve_import("src/api.ts", &import, &files), Resolution::Ambiguous));
    }

    #[test]
    fn html_css_xml_docker_sql_are_resource_edges() {
        let html = parse_html_dependencies(1, "<link href=\"./base.css\" rel=\"stylesheet\"><script src=\"./app.js\"></script>");
        assert_eq!(html.len(), 2);
        assert!(html.iter().any(|r| r.kind == "html_script"));
        assert!(html.iter().any(|r| r.kind == "html_link"));
        assert!(html.iter().all(|r| r.confidence == "exact_local_resource"));
        assert_eq!(parse_css_dependency(1, "@import './base.css';").unwrap().kind, "css_import");
        assert_eq!(parse_xml_dependency(1, "<xs:include schemaLocation=\"./base.xsd\"/>").unwrap().kind, "xml_include");
        assert_eq!(parse_docker_dependency(1, "COPY requirements.txt /app/").unwrap().kind, "docker_copy");
        assert_eq!(parse_sql_dependency(1, "\\i ./schema.sql").unwrap().kind, "sql_include");
    }
}
