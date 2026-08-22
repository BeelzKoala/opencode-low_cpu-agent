use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const PROTOCOL: &str = "impact-index-v1";
const CACHE_VERSION: u32 = 1;
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_IMPORTS_PER_FILE: usize = 128;
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
    bindings: Vec<String>,
    witness: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedFile {
    size: u64,
    mtime_ms: u64,
    imports: Vec<ImportRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
struct EdgeRecord {
    from: String,
    to: String,
    kind: String,
    witness_line: usize,
    spec: String,
    bindings: Vec<String>,
    witness: String,
    confidence: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheFile {
    protocol: String,
    version: u32,
    refreshed_at_ms: u64,
    files: BTreeMap<String, CachedFile>,
    edges: Vec<EdgeRecord>,
}

impl Default for CacheFile {
    fn default() -> Self {
        Self {
            protocol: PROTOCOL.to_string(),
            version: CACHE_VERSION,
            refreshed_at_ms: 0,
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
    witness: String,
    confidence: String,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    mode: String,
    ready: bool,
    refresh_complete: Option<bool>,
    cache_path: String,
    cache_age_ms: Option<u64>,
    files_total: usize,
    files_reused: Option<usize>,
    files_reindexed: Option<usize>,
    files_removed: Option<usize>,
    imports_total: usize,
    edges_total: usize,
    resolved_imports: Option<usize>,
    unresolved_imports: Option<usize>,
    skipped_files: Option<usize>,
    seed_files: Vec<String>,
    neighbors_total: usize,
    neighbors: Vec<Neighbor>,
    walk_elapsed_ms: Option<f64>,
    parse_elapsed_ms: Option<f64>,
    elapsed_ms: f64,
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

fn supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "py" | "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "rs" | "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh"
    )
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
    let rel = path.strip_prefix(root).context("indexed path escaped root")?;
    normalize_rel(rel).context("cannot normalize indexed path")
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
            if out.len() >= MAX_FILES {
                *capped = true;
                break;
            }

            let file_type = match entry.file_type() {
                Ok(value) => value,
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

            let metadata = match entry.metadata() {
                Ok(value) => value,
                Err(_) => continue,
            };
            if metadata.len() <= MAX_FILE_BYTES {
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
    let trimmed = line.trim();
    let mut out = String::new();
    for ch in trimmed.chars().take(MAX_WITNESS_CHARS) {
        out.push(ch);
    }
    out
}

fn ident(raw: &str) -> Option<String> {
    let value = raw
        .trim()
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<String>();
    if value.is_empty() { None } else { Some(value) }
}

fn bindings_from_csv(raw: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for item in raw.split(',') {
        let source = item.trim().split_whitespace().next().unwrap_or("");
        if let Some(value) = ident(source) {
            out.insert(value);
            if out.len() >= MAX_BINDINGS {
                break;
            }
        }
    }
    out.into_iter().collect()
}

fn parse_python_import(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.contains('\\') {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix("from ") {
        let (spec, imported) = rest.split_once(" import ")?;
        let spec = spec.trim();
        if spec.is_empty() || spec.trim_matches('.').is_empty() || imported.contains('(') || imported.contains(')') {
            return None;
        }
        return Some(ImportRecord {
            spec: spec.to_string(),
            line: line_no,
            kind: "python_from".to_string(),
            bindings: bindings_from_csv(imported),
            witness: clipped_witness(line),
        });
    }

    if let Some(rest) = trimmed.strip_prefix("import ") {
        if rest.contains(',') {
            return None;
        }
        let spec = rest.split_whitespace().next()?.trim();
        if spec.is_empty() {
            return None;
        }
        let binding = spec.rsplit('.').next().and_then(ident).into_iter().collect();
        return Some(ImportRecord {
            spec: spec.to_string(),
            line: line_no,
            kind: "python_import".to_string(),
            bindings: binding,
            witness: clipped_witness(line),
        });
    }

    None
}

fn quoted_relative_spec(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
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
            let value = std::str::from_utf8(&bytes[start..i.min(bytes.len())]).ok()?;
            if value.starts_with("./") || value.starts_with("../") {
                return Some(value.to_string());
            }
        }
        i += 1;
    }
    None
}

fn parse_js_bindings(trimmed: &str) -> Vec<String> {
    let Some(import_body) = trimmed.strip_prefix("import ") else { return Vec::new(); };
    let Some((clause, _)) = import_body.split_once(" from ") else { return Vec::new(); };
    let clause = clause.trim();
    if let Some(inner) = clause.strip_prefix('{').and_then(|v| v.strip_suffix('}')) {
        return bindings_from_csv(inner);
    }
    Vec::new()
}

fn parse_js_import(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    let spec = quoted_relative_spec(trimmed)?;
    let is_import = trimmed.starts_with("import ") || trimmed.contains("import(");
    let is_require = trimmed.contains("require(");
    if !is_import && !is_require {
        return None;
    }

    Some(ImportRecord {
        spec,
        line: line_no,
        kind: if is_require { "js_require" } else { "js_relative_import" }.to_string(),
        bindings: if is_import { parse_js_bindings(trimmed) } else { Vec::new() },
        witness: clipped_witness(line),
    })
}

fn rust_bindings_from_use(rest: &str) -> Vec<String> {
    let value = rest.trim().trim_end_matches(';');
    if let Some(open) = value.find("::{") {
        if let Some(close) = value.rfind('}') {
            if close > open + 3 {
                return bindings_from_csv(&value[open + 3..close]);
            }
        }
    }
    value
        .rsplit("::")
        .next()
        .and_then(|part| part.split_whitespace().next())
        .and_then(ident)
        .into_iter()
        .collect()
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
            witness: clipped_witness(line),
        });
    }

    if let Some(rest) = no_vis.strip_prefix("use crate::") {
        if rest.contains('*') {
            return None;
        }
        return Some(ImportRecord {
            spec: rest.trim().trim_end_matches(';').to_string(),
            line: line_no,
            kind: "rust_crate_use".to_string(),
            bindings: rust_bindings_from_use(rest),
            witness: clipped_witness(line),
        });
    }

    None
}

fn parse_c_include(line_no: usize, line: &str) -> Option<ImportRecord> {
    let trimmed = line.trim();
    if !trimmed.starts_with("#include") {
        return None;
    }
    let spec = quoted_relative_spec(trimmed).or_else(|| {
        let start = trimmed.find('"')? + 1;
        let end = trimmed[start..].find('"')? + start;
        Some(trimmed[start..end].to_string())
    })?;
    Some(ImportRecord {
        spec,
        line: line_no,
        kind: "c_quote_include".to_string(),
        bindings: Vec::new(),
        witness: clipped_witness(line),
    })
}

fn parse_imports(path: &Path, source: &str) -> Vec<ImportRecord> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut out = Vec::new();

    for (idx, line) in source.lines().enumerate() {
        if out.len() >= MAX_IMPORTS_PER_FILE {
            break;
        }
        let line_no = idx + 1;
        let record = match ext.as_str() {
            "py" => parse_python_import(line_no, line),
            "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" => parse_js_import(line_no, line),
            "rs" => parse_rust_import(line_no, line),
            "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" => parse_c_include(line_no, line),
            _ => None,
        };
        if let Some(record) = record {
            out.push(record);
        }
    }

    out
}

fn unique_existing(candidates: impl IntoIterator<Item = String>, file_set: &HashSet<String>) -> Option<String> {
    let found: BTreeSet<_> = candidates
        .into_iter()
        .filter(|candidate| file_set.contains(candidate))
        .collect();
    if found.len() == 1 { found.into_iter().next() } else { None }
}

fn python_candidates(importer: &str, spec: &str) -> Vec<String> {
    let mut dots = 0usize;
    for ch in spec.chars() {
        if ch == '.' { dots += 1; } else { break; }
    }
    let module = spec[dots..].replace('.', "/");
    let mut base = if dots == 0 {
        PathBuf::new()
    } else {
        let mut parent = Path::new(importer).parent().unwrap_or_else(|| Path::new("")).to_path_buf();
        for _ in 1..dots {
            parent.pop();
        }
        parent
    };
    if !module.is_empty() {
        base.push(module);
    }
    let Some(base) = normalize_rel(&base) else { return Vec::new(); };
    if base.is_empty() { return Vec::new(); }
    vec![format!("{base}.py"), format!("{base}/__init__.py")]
}

fn relative_module_candidates(importer: &str, spec: &str) -> Vec<String> {
    let parent = Path::new(importer).parent().unwrap_or_else(|| Path::new(""));
    let Some(base) = normalize_rel(&parent.join(spec)) else { return Vec::new(); };
    let mut out = vec![base.clone()];
    if Path::new(&base).extension().is_none() {
        let importer_ext = Path::new(importer).extension().and_then(|v| v.to_str()).unwrap_or("");
        let mut extensions = vec![importer_ext, "ts", "tsx", "js", "jsx", "mjs", "cjs"];
        extensions.retain(|ext| !ext.is_empty());
        extensions.sort_unstable();
        extensions.dedup();
        for ext in extensions {
            out.push(format!("{base}.{ext}"));
            out.push(format!("{base}/index.{ext}"));
        }
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
    let Some(base) = normalize_rel(&base.join(name)) else { return Vec::new(); };
    vec![format!("{base}.rs"), format!("{base}/mod.rs")]
}

fn rust_crate_candidates(spec: &str) -> Vec<String> {
    let raw = spec.trim().trim_end_matches(';');
    let module_part = raw.split("::{").next().unwrap_or(raw);
    let parts: Vec<_> = module_part.split("::").filter(|v| !v.is_empty()).collect();
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

fn c_include_candidates(importer: &str, spec: &str) -> Vec<String> {
    let parent = Path::new(importer).parent().unwrap_or_else(|| Path::new(""));
    let mut out = Vec::new();
    if let Some(local) = normalize_rel(&parent.join(spec)) {
        out.push(local);
    }
    if let Some(root) = normalize_rel(Path::new(spec)) {
        out.push(root);
    }
    out
}

fn resolve_import(importer: &str, import: &ImportRecord, file_set: &HashSet<String>) -> Option<String> {
    let candidates = match import.kind.as_str() {
        "python_from" | "python_import" => python_candidates(importer, &import.spec),
        "js_relative_import" | "js_require" => relative_module_candidates(importer, &import.spec),
        "rust_mod" => rust_mod_candidates(importer, &import.spec),
        "rust_crate_use" => rust_crate_candidates(&import.spec),
        "c_quote_include" => c_include_candidates(importer, &import.spec),
        _ => Vec::new(),
    };
    unique_existing(candidates, file_set)
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
    if cache.files.contains_key(&normalized) { Some(normalized) } else { None }
}

fn empty_response(mode: &str, path: &Path, started: Instant) -> Response {
    Response {
        protocol: PROTOCOL,
        mode: mode.to_string(),
        ready: false,
        refresh_complete: None,
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
        skipped_files: None,
        seed_files: Vec::new(),
        neighbors_total: 0,
        neighbors: Vec::new(),
        walk_elapsed_ms: None,
        parse_elapsed_ms: None,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    }
}

fn refresh(root: &Path, path: &Path, started: Instant) -> Result<Response> {
    let previous = load_cache(path).unwrap_or_default();
    let walk_started = Instant::now();
    let (paths, capped) = walk_files(root)?;
    let walk_elapsed = walk_started.elapsed().as_secs_f64() * 1000.0;

    let parse_started = Instant::now();
    let mut files = BTreeMap::new();
    let mut files_reused = 0usize;
    let mut files_reindexed = 0usize;
    let mut skipped_files = 0usize;

    for absolute in paths {
        let rel = match rel_string(root, &absolute) {
            Ok(value) => value,
            Err(_) => { skipped_files += 1; continue; }
        };
        let metadata = match fs::metadata(&absolute) {
            Ok(value) => value,
            Err(_) => { skipped_files += 1; continue; }
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

        match fs::read_to_string(&absolute) {
            Ok(source) => {
                files.insert(rel, CachedFile {
                    size,
                    mtime_ms: mtime,
                    imports: parse_imports(&absolute, &source),
                });
                files_reindexed += 1;
            }
            Err(_) => skipped_files += 1,
        }
    }

    let files_removed = previous.files.keys().filter(|key| !files.contains_key(*key)).count();
    let file_set: HashSet<String> = files.keys().cloned().collect();
    let mut edges = BTreeSet::new();
    let mut resolved_imports = 0usize;
    let mut unresolved_imports = 0usize;

    for (importer, file) in &files {
        for import in &file.imports {
            if let Some(target) = resolve_import(importer, import, &file_set) {
                if target != *importer {
                    resolved_imports += 1;
                    edges.insert(EdgeRecord {
                        from: importer.clone(),
                        to: target,
                        kind: import.kind.clone(),
                        witness_line: import.line,
                        spec: import.spec.clone(),
                        bindings: import.bindings.clone(),
                        witness: import.witness.clone(),
                        confidence: "exact_local".to_string(),
                    });
                }
            } else {
                unresolved_imports += 1;
            }
        }
    }

    let parse_elapsed = parse_started.elapsed().as_secs_f64() * 1000.0;
    let refresh_complete = !capped && skipped_files == 0;
    let cache = CacheFile {
        protocol: PROTOCOL.to_string(),
        version: CACHE_VERSION,
        refreshed_at_ms: now_ms(),
        files,
        edges: edges.into_iter().collect(),
    };

    // Never replace a known-good cache with a partial refresh.
    if refresh_complete {
        write_cache(path, &cache)?;
    }

    let imports_total = cache.files.values().map(|file| file.imports.len()).sum();
    Ok(Response {
        protocol: PROTOCOL,
        mode: "refresh".to_string(),
        ready: refresh_complete,
        refresh_complete: Some(refresh_complete),
        cache_path: path.display().to_string(),
        cache_age_ms: Some(0),
        files_total: cache.files.len(),
        files_reused: Some(files_reused),
        files_reindexed: Some(files_reindexed),
        files_removed: Some(files_removed),
        imports_total,
        edges_total: cache.edges.len(),
        resolved_imports: Some(resolved_imports),
        unresolved_imports: Some(unresolved_imports),
        skipped_files: Some(skipped_files),
        seed_files: Vec::new(),
        neighbors_total: 0,
        neighbors: Vec::new(),
        walk_elapsed_ms: Some(walk_elapsed),
        parse_elapsed_ms: Some(parse_elapsed),
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn neighbors(request: &Request, path: &Path, started: Instant) -> Result<Response> {
    let Some(cache) = load_cache(path) else {
        return Ok(empty_response("neighbors", path, started));
    };

    let max_neighbors = request.max_neighbors.unwrap_or(DEFAULT_MAX_NEIGHBORS).clamp(1, MAX_NEIGHBORS);
    let seeds: Vec<String> = request
        .seed_files
        .iter()
        .filter_map(|seed| sanitize_seed(seed, &cache))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let seed_set: HashSet<_> = seeds.iter().cloned().collect();
    let mut out = BTreeSet::new();

    for edge in &cache.edges {
        if seed_set.contains(&edge.from) {
            out.insert((
                edge.from.clone(), edge.to.clone(), "forward".to_string(), edge.clone(),
            ));
        }
        if seed_set.contains(&edge.to) {
            out.insert((
                edge.to.clone(), edge.from.clone(), "reverse".to_string(), edge.clone(),
            ));
        }
    }

    let neighbors_total = out.len();
    let neighbors = out
        .into_iter()
        .take(max_neighbors)
        .map(|(seed, file, direction, edge)| Neighbor {
            seed,
            file,
            direction,
            kind: edge.kind,
            witness_file: edge.from,
            witness_line: edge.witness_line,
            spec: edge.spec,
            bindings: edge.bindings,
            witness: edge.witness,
            confidence: edge.confidence,
        })
        .collect::<Vec<_>>();
    let imports_total = cache.files.values().map(|file| file.imports.len()).sum();

    Ok(Response {
        protocol: PROTOCOL,
        mode: "neighbors".to_string(),
        ready: true,
        refresh_complete: None,
        cache_path: path.display().to_string(),
        cache_age_ms: Some(now_ms().saturating_sub(cache.refreshed_at_ms)),
        files_total: cache.files.len(),
        files_reused: None,
        files_reindexed: None,
        files_removed: None,
        imports_total,
        edges_total: cache.edges.len(),
        resolved_imports: None,
        unresolved_imports: None,
        skipped_files: None,
        seed_files: seeds,
        neighbors_total,
        neighbors,
        walk_elapsed_ms: None,
        parse_elapsed_ms: None,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
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
    fn python_from_keeps_binding_and_witness() {
        let record = parse_python_import(7, "from service import handle as local, other").unwrap();
        assert_eq!(record.spec, "service");
        assert_eq!(record.bindings, vec!["handle".to_string(), "other".to_string()]);
        assert_eq!(record.line, 7);
        assert!(record.witness.contains("from service import handle"));
    }

    #[test]
    fn js_named_relative_import_is_precision_first() {
        let record = parse_js_import(3, "import { handle as h, other } from './service'").unwrap();
        assert_eq!(record.spec, "./service");
        assert_eq!(record.bindings, vec!["handle".to_string(), "other".to_string()]);
        assert_eq!(record.kind, "js_relative_import");
        assert!(parse_js_import(1, "import {x} from 'external-package'").is_none());
    }

    #[test]
    fn ambiguous_resolution_is_rejected() {
        let files: HashSet<String> = ["service.ts", "service.js"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert!(unique_existing(
            vec!["service.ts".to_string(), "service.js".to_string()],
            &files,
        ).is_none());
    }

    #[test]
    fn rust_crate_use_points_to_module_not_symbol() {
        let files: HashSet<String> = ["src/service.rs"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let import = ImportRecord {
            spec: "service::handle".to_string(),
            line: 2,
            kind: "rust_crate_use".to_string(),
            bindings: vec!["handle".to_string()],
            witness: "use crate::service::handle;".to_string(),
        };
        assert_eq!(resolve_import("src/lib.rs", &import, &files), Some("src/service.rs".to_string()));
    }
}
