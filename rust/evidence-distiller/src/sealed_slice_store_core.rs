use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::OpenOptions,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

const PROTOCOL: &str = "sealed-slice-store-v1";
const AUTHORITY: &str = "cache_only";
const BINDING_PROTOCOL: &str = "sealed-slice-binding-v1";
const SHA256_HEX_LEN: usize = 64;
const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SLICE_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
struct Request {
    root: String,
    mode: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    source_sha256: Option<String>,
    #[serde(default)]
    site_sha256: Option<String>,
    #[serde(default)]
    start_byte: Option<usize>,
    #[serde(default)]
    end_byte: Option<usize>,
    #[serde(default)]
    blob_sha256: Option<String>,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    authority: &'static str,
    binding_protocol: &'static str,
    mode: String,
    ok: bool,
    reason: Option<String>,
    file: Option<String>,
    source_sha256: Option<String>,
    site_sha256: Option<String>,
    start_byte: Option<usize>,
    end_byte: Option<usize>,
    blob_sha256: Option<String>,
    binding_sha256: Option<String>,
    bytes: Option<usize>,
    cache_hit: Option<bool>,
    execution_offsets_authoritative: bool,
}

impl Response {
    fn rejected(mode: &str, reason: impl Into<String>) -> Self {
        Self {
            protocol: PROTOCOL,
            authority: AUTHORITY,
            binding_protocol: BINDING_PROTOCOL,
            mode: mode.to_string(),
            ok: false,
            reason: Some(reason.into()),
            file: None,
            source_sha256: None,
            site_sha256: None,
            start_byte: None,
            end_byte: None,
            blob_sha256: None,
            binding_sha256: None,
            bytes: None,
            cache_hit: None,
            execution_offsets_authoritative: false,
        }
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_LEN && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn normalize_sha256(value: &str) -> Option<String> {
    valid_sha256(value).then(|| value.to_ascii_lowercase())
}

fn safe_rel(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return None;
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_str()?;
                if part.is_empty() {
                    return None;
                }
                parts.push(part);
            }
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn canonical_source(root: &Path, rel: &str) -> std::result::Result<PathBuf, &'static str> {
    let rel = safe_rel(rel).ok_or("file_path_invalid")?;
    let joined = root.join(&rel);
    let canonical = fs::canonicalize(&joined).map_err(|_| "source_unavailable")?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err("source_escape_or_not_file");
    }
    Ok(canonical)
}

fn cache_root() -> Result<PathBuf> {
    if let Ok(raw) = env::var("OPENCODE_SEALED_SLICE_CACHE") {
        if !raw.is_empty() {
            let path = PathBuf::from(raw);
            anyhow::ensure!(
                path.is_absolute(),
                "sealed slice cache override must be absolute"
            );
            return Ok(path);
        }
    }

    if let Ok(raw) = env::var("XDG_CACHE_HOME") {
        if !raw.is_empty() {
            return Ok(PathBuf::from(raw)
                .join("opencode-cpu-agent")
                .join("sealed-slices-v1"));
        }
    }

    let home = env::var("HOME").context("HOME unavailable for sealed slice cache")?;
    Ok(PathBuf::from(home)
        .join(".cache")
        .join("opencode-cpu-agent")
        .join("sealed-slices-v1"))
}

fn object_path(store: &Path, blob_sha256: &str) -> PathBuf {
    store
        .join("objects")
        .join("sha256")
        .join(&blob_sha256[..2])
        .join(blob_sha256)
}

fn read_verified_blob(
    store: &Path,
    blob_sha256: &str,
) -> std::result::Result<Vec<u8>, &'static str> {
    let expected = normalize_sha256(blob_sha256).ok_or("blob_sha256_invalid")?;
    let path = object_path(store, &expected);
    let metadata = fs::metadata(&path).map_err(|_| "cas_blob_missing")?;
    if !metadata.is_file() || metadata.len() as usize > MAX_SLICE_BYTES {
        return Err("cas_blob_invalid");
    }
    let bytes = fs::read(&path).map_err(|_| "cas_blob_unreadable")?;
    if sha256_bytes(&bytes) != expected {
        return Err("cas_blob_corrupt");
    }
    Ok(bytes)
}

fn atomic_store_blob(
    store: &Path,
    blob_sha256: &str,
    bytes: &[u8],
) -> std::result::Result<bool, &'static str> {
    let path = object_path(store, blob_sha256);
    let parent = path.parent().ok_or("cas_parent_invalid")?;
    fs::create_dir_all(parent).map_err(|_| "cas_parent_create_failed")?;

    if path.exists() {
        let existing = read_verified_blob(store, blob_sha256)?;
        if existing != bytes {
            return Err("cas_hash_collision_or_corruption");
        }
        return Ok(true);
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "clock_before_epoch")?
        .as_nanos();
    let tmp = parent.join(format!(".tmp-{}-{stamp}", process::id()));

    let write_result = (|| -> std::result::Result<(), &'static str> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| "cas_temp_create_failed")?;
        file.write_all(bytes).map_err(|_| "cas_temp_write_failed")?;
        file.sync_all().map_err(|_| "cas_temp_sync_failed")?;
        fs::rename(&tmp, &path).map_err(|_| "cas_publish_failed")?;
        Ok(())
    })();

    if let Err(reason) = write_result {
        let _ = fs::remove_file(&tmp);
        if path.exists() {
            let existing = read_verified_blob(store, blob_sha256)?;
            if existing == bytes {
                return Ok(true);
            }
        }
        return Err(reason);
    }

    let stored = read_verified_blob(store, blob_sha256)?;
    if stored != bytes {
        return Err("cas_post_publish_mismatch");
    }

    Ok(false)
}

fn slice_binding_sha256(
    file: &str,
    source_sha256: &str,
    site_sha256: &str,
    start_byte: usize,
    end_byte: usize,
    blob_sha256: &str,
) -> String {
    let payload = format!(
        "{BINDING_PROTOCOL}\nfile={file}\nsource={source_sha256}\nsite={site_sha256}\nstart={start_byte}\nend={end_byte}\nblob={blob_sha256}\n"
    );
    sha256_bytes(payload.as_bytes())
}

fn put_slice(root: &Path, store: &Path, request: &Request) -> Response {
    let mode = request.mode.as_str();
    let Some(raw_file) = request.file.as_deref() else {
        return Response::rejected(mode, "file_missing");
    };
    let Some(file) = safe_rel(raw_file) else {
        return Response::rejected(mode, "file_path_invalid");
    };
    let Some(source_sha256) = request.source_sha256.as_deref().and_then(normalize_sha256) else {
        return Response::rejected(mode, "source_sha256_invalid");
    };
    let Some(site_sha256) = request.site_sha256.as_deref().and_then(normalize_sha256) else {
        return Response::rejected(mode, "site_sha256_invalid");
    };
    let Some(start_byte) = request.start_byte else {
        return Response::rejected(mode, "start_byte_missing");
    };
    let Some(end_byte) = request.end_byte else {
        return Response::rejected(mode, "end_byte_missing");
    };

    let source_path = match canonical_source(root, &file) {
        Ok(path) => path,
        Err(reason) => return Response::rejected(mode, reason),
    };
    let metadata = match fs::metadata(&source_path) {
        Ok(value) => value,
        Err(_) => return Response::rejected(mode, "source_metadata_unavailable"),
    };
    if metadata.len() as usize > MAX_SOURCE_BYTES {
        return Response::rejected(mode, "source_size_exceeded");
    }

    let bytes = match fs::read(&source_path) {
        Ok(value) => value,
        Err(_) => return Response::rejected(mode, "source_unreadable"),
    };
    let actual_source_sha256 = sha256_bytes(&bytes);
    if actual_source_sha256 != source_sha256 {
        return Response::rejected(mode, "source_hash_mismatch");
    }

    let source = match std::str::from_utf8(&bytes) {
        Ok(value) => value,
        Err(_) => return Response::rejected(mode, "source_not_utf8"),
    };
    if start_byte >= end_byte || end_byte > bytes.len() {
        return Response::rejected(mode, "slice_bounds_invalid");
    }
    if !source.is_char_boundary(start_byte) || !source.is_char_boundary(end_byte) {
        return Response::rejected(mode, "slice_utf8_boundary_invalid");
    }

    let slice = &bytes[start_byte..end_byte];
    if slice.len() > MAX_SLICE_BYTES {
        return Response::rejected(mode, "slice_size_exceeded");
    }

    let blob_sha256 = sha256_bytes(slice);
    let cache_hit = match atomic_store_blob(store, &blob_sha256, slice) {
        Ok(value) => value,
        Err(reason) => return Response::rejected(mode, reason),
    };
    let binding_sha256 = slice_binding_sha256(
        &file,
        &source_sha256,
        &site_sha256,
        start_byte,
        end_byte,
        &blob_sha256,
    );

    Response {
        protocol: PROTOCOL,
        authority: AUTHORITY,
        binding_protocol: BINDING_PROTOCOL,
        mode: mode.to_string(),
        ok: true,
        reason: None,
        file: Some(file),
        source_sha256: Some(source_sha256),
        site_sha256: Some(site_sha256),
        start_byte: Some(start_byte),
        end_byte: Some(end_byte),
        blob_sha256: Some(blob_sha256),
        binding_sha256: Some(binding_sha256),
        bytes: Some(slice.len()),
        cache_hit: Some(cache_hit),
        execution_offsets_authoritative: false,
    }
}

fn verify_blob(store: &Path, request: &Request) -> Response {
    let mode = request.mode.as_str();
    let Some(blob_sha256) = request.blob_sha256.as_deref().and_then(normalize_sha256) else {
        return Response::rejected(mode, "blob_sha256_invalid");
    };
    match read_verified_blob(store, &blob_sha256) {
        Ok(bytes) => Response {
            protocol: PROTOCOL,
            authority: AUTHORITY,
            binding_protocol: BINDING_PROTOCOL,
            mode: mode.to_string(),
            ok: true,
            reason: None,
            file: None,
            source_sha256: None,
            site_sha256: None,
            start_byte: None,
            end_byte: None,
            blob_sha256: Some(blob_sha256),
            binding_sha256: None,
            bytes: Some(bytes.len()),
            cache_hit: Some(true),
            execution_offsets_authoritative: false,
        },
        Err(reason) => Response::rejected(mode, reason),
    }
}

pub fn run_cli() -> Result<()> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("failed to read stdin")?;
    let request: Request = serde_json::from_str(&input).context("invalid request JSON")?;

    let root = fs::canonicalize(&request.root).context("cannot resolve project root")?;
    anyhow::ensure!(root.is_dir(), "project root is not a directory");

    let store = cache_root()?;
    let response = match request.mode.as_str() {
        "put_slice" => put_slice(&root, &store, &request),
        "verify_blob" => verify_blob(&store, &request),
        other => Response::rejected(other, "mode_unsupported"),
    };

    serde_json::to_writer(io::stdout(), &response)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("opencode-r14b-{tag}-{}-{stamp}", process::id()))
    }

    fn fixture(tag: &str, source: &str) -> (PathBuf, PathBuf, String) {
        let parent = temp_root(tag);
        let repo = parent.join("repo");
        let store = parent.join("store");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("sample.py"), source.as_bytes()).unwrap();
        let source_sha256 = sha256_bytes(source.as_bytes());
        (repo, store, source_sha256)
    }

    fn put_request(source_sha256: &str, start: usize, end: usize) -> Request {
        Request {
            root: String::new(),
            mode: "put_slice".into(),
            file: Some("sample.py".into()),
            source_sha256: Some(source_sha256.into()),
            site_sha256: Some("a".repeat(64)),
            start_byte: Some(start),
            end_byte: Some(end),
            blob_sha256: None,
        }
    }

    #[test]
    fn stores_and_reuses_content_addressed_slice() {
        let (repo, store, source_sha256) = fixture("reuse", "def f():\n    return 1\n");
        let request = put_request(&source_sha256, 0, 8);

        let first = put_slice(&repo, &store, &request);
        assert!(first.ok, "{first:?}");
        assert_eq!(first.cache_hit, Some(false));

        let second = put_slice(&repo, &store, &request);
        assert!(second.ok, "{second:?}");
        assert_eq!(second.cache_hit, Some(true));
        assert_eq!(first.blob_sha256, second.blob_sha256);
        assert_eq!(first.binding_sha256, second.binding_sha256);

        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn source_hash_mismatch_fails_closed_without_cache_write() {
        let (repo, store, _) = fixture("stale", "x = 1\n");
        let request = put_request(&"0".repeat(64), 0, 5);

        let response = put_slice(&repo, &store, &request);
        assert!(!response.ok);
        assert_eq!(response.reason.as_deref(), Some("source_hash_mismatch"));
        assert!(!store.exists());

        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn binding_changes_with_execution_range_but_offsets_are_not_authority() {
        let (repo, store, source_sha256) = fixture("binding", "alpha = 1\nbeta = 2\n");
        let a = put_slice(&repo, &store, &put_request(&source_sha256, 0, 5));
        let b = put_slice(&repo, &store, &put_request(&source_sha256, 10, 14));

        assert!(a.ok && b.ok);
        assert_ne!(a.binding_sha256, b.binding_sha256);
        assert!(!a.execution_offsets_authoritative);
        assert_eq!(a.authority, "cache_only");

        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn traversal_and_invalid_bounds_are_rejected() {
        let (repo, store, source_sha256) = fixture("bounds", "x = 1\n");

        let mut traversal = put_request(&source_sha256, 0, 1);
        traversal.file = Some("../outside.py".into());
        let response = put_slice(&repo, &store, &traversal);
        assert_eq!(response.reason.as_deref(), Some("file_path_invalid"));

        let bounds = put_request(&source_sha256, 3, 3);
        let response = put_slice(&repo, &store, &bounds);
        assert_eq!(response.reason.as_deref(), Some("slice_bounds_invalid"));

        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn corrupted_existing_blob_is_never_reused() {
        let (repo, store, source_sha256) = fixture("corrupt", "x = 123\n");
        let request = put_request(&source_sha256, 0, 7);
        let first = put_slice(&repo, &store, &request);
        assert!(first.ok);

        let blob = first.blob_sha256.as_deref().unwrap();
        let path = object_path(&store, blob);
        fs::write(&path, b"corrupt").unwrap();

        let second = put_slice(&repo, &store, &request);
        assert!(!second.ok);
        assert_eq!(second.reason.as_deref(), Some("cas_blob_corrupt"));

        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn cache_is_outside_repository_and_stores_only_content_addressed_objects() {
        let (repo, store, source_sha256) = fixture("outside", "def f():\n    pass\n");
        let response = put_slice(&repo, &store, &put_request(&source_sha256, 0, 8));
        assert!(response.ok);
        assert!(!repo.join(".opencode").exists());

        let blob = response.blob_sha256.as_deref().unwrap();
        let path = object_path(&store, blob);
        assert!(path.is_file());
        assert_eq!(sha256_bytes(&fs::read(path).unwrap()), blob);

        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn verify_blob_detects_corruption() {
        let (repo, store, source_sha256) = fixture("verify", "abc = 1\n");
        let first = put_slice(&repo, &store, &put_request(&source_sha256, 0, 3));
        let blob = first.blob_sha256.clone().unwrap();

        let verify_request = Request {
            root: String::new(),
            mode: "verify_blob".into(),
            file: None,
            source_sha256: None,
            site_sha256: None,
            start_byte: None,
            end_byte: None,
            blob_sha256: Some(blob.clone()),
        };
        let verified = verify_blob(&store, &verify_request);
        assert!(verified.ok);
        assert_eq!(verified.blob_sha256.as_deref(), Some(blob.as_str()));

        fs::write(object_path(&store, &blob), b"bad").unwrap();
        let corrupted = verify_blob(&store, &verify_request);
        assert_eq!(corrupted.reason.as_deref(), Some("cas_blob_corrupt"));

        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }
}
