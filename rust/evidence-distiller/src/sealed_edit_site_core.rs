use crate::crypto_hash::sha256_bytes;
use anyhow::{Context, Result};
use ast_grep_language::{LanguageExt, SupportLang};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

pub const SEALED_EDIT_SITE_PROTOCOL: &str = "sealed-edit-site-v1";
pub const SEALED_EDIT_SITE_PROJECTION_PROTOCOL: &str = "sealed-edit-site-projection-v1";
pub const SEALED_EDIT_SITE_DESCRIPTOR_PROTOCOL: &str = "sealed-edit-site-descriptor-v1";
pub const SEALED_EDIT_SITE_EVIDENCE_PROTOCOL: &str = "sealed-edit-site-evidence-binding-v1";
pub const SEALED_EDIT_SITE_PROVIDER_PROTOCOL: &str = "ast-grep-structural-site-v1";
pub const SEALED_EDIT_SITE_BACKEND: &str = "ast-grep-0.45.1";
pub const SEALED_EDIT_SITE_AUTHORITY: &str = "hypothesis";
pub const SEALED_EDIT_SITE_COORDINATES_AUTHORITY: &str = "derived_hint_only";

const MAX_REQUEST_BYTES: u64 = 256 * 1024;
const MAX_FILES: usize = 5;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EVIDENCE_LINES_PER_FILE: usize = 16;
const MAX_SITES_TOTAL: usize = 8;
const SHA256_HEX_LEN: usize = 64;

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectionRequest {
    pub root: String,
    pub files: Vec<ProjectionFileRequest>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectionFileRequest {
    pub file: String,
    pub source_sha256: String,
    pub evidence_lines: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectionResponse {
    pub protocol: &'static str,
    pub provider_protocol: &'static str,
    pub backend: &'static str,
    pub authority: &'static str,
    pub complete: bool,
    pub sites: Vec<SealedEditSite>,
    pub errors: Vec<ProjectionError>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectionError {
    pub file: String,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SealedEditSite {
    pub protocol: &'static str,
    pub site_id: String,
    pub authority: &'static str,
    pub file: String,
    pub source_sha256: String,
    pub evidence_line: usize,
    pub language: &'static str,
    pub provider_protocol: &'static str,
    pub backend: &'static str,
    pub node_kind: String,
    pub structural_path: Vec<usize>,
    pub relation: &'static str,
    pub operation: &'static str,
    pub anchor_text_sha256: String,
    pub descriptor_sha256: String,
    pub evidence_binding_sha256: String,
    pub site_sha256: String,
    pub derived_anchor_start_byte: usize,
    pub derived_anchor_end_byte: usize,
    pub derived_insert_byte: usize,
    pub coordinates_authority: &'static str,
}

#[derive(Debug, Serialize)]
struct DescriptorHashPayload<'a> {
    protocol: &'static str,
    provider_protocol: &'static str,
    backend: &'static str,
    language: &'static str,
    node_kind: &'a str,
    structural_path: &'a [usize],
    relation: &'static str,
    operation: &'static str,
    anchor_text_sha256: &'a str,
}

#[derive(Debug, Serialize)]
struct EvidenceHashPayload<'a> {
    protocol: &'static str,
    file: &'a str,
    source_sha256: &'a str,
    evidence_line: usize,
}

#[derive(Debug, Serialize)]
struct SiteHashPayload<'a> {
    protocol: &'static str,
    file: &'a str,
    source_sha256: &'a str,
    descriptor_sha256: &'a str,
    evidence_binding_sha256: &'a str,
}

#[derive(Debug)]
struct ProjectedSiteDraft {
    file: String,
    source_sha256: String,
    evidence_line: usize,
    node_kind: String,
    structural_path: Vec<usize>,
    relation: &'static str,
    operation: &'static str,
    anchor_text_sha256: String,
    descriptor_sha256: String,
    evidence_binding_sha256: String,
    site_sha256: String,
    derived_anchor_start_byte: usize,
    derived_anchor_end_byte: usize,
    derived_insert_byte: usize,
}

fn sha256_json<T: Serialize>(value: &T) -> String {
    let encoded = serde_json::to_vec(value).expect("canonical hash payload must serialize");
    sha256_bytes(&encoded)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_LEN && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_rel(raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > 4096
        || raw.chars().any(char::is_control)
        || Path::new(raw).is_absolute()
    {
        return None;
    }

    let mut parts = Vec::new();
    for component in Path::new(raw.trim_start_matches("./")).components() {
        match component {
            Component::Normal(value) => {
                let text = value.to_str()?;
                if text.is_empty() {
                    return None;
                }
                parts.push(text.to_string());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    if parts.is_empty() {
        return None;
    }

    let rel = parts.join("/");
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
    if !meta.is_file() || meta.len() > MAX_SOURCE_BYTES {
        return None;
    }
    Some(candidate)
}

fn line_for_byte(source: &str, byte: usize) -> usize {
    source.as_bytes()[..byte.min(source.len())]
        .iter()
        .filter(|value| **value == b'\n')
        .count()
        + 1
}

fn python_site_policy(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "import_statement" | "import_from_statement" => {
            Some(("module_child_after", "insert_after"))
        }
        "decorated_definition" | "function_definition" | "class_definition" => {
            Some(("module_child_before", "insert_before"))
        }
        _ => None,
    }
}

fn normalized_evidence_lines(raw: &[usize]) -> Result<Vec<usize>, &'static str> {
    if raw.is_empty() || raw.len() > MAX_EVIDENCE_LINES_PER_FILE {
        return Err("evidence_line_budget_invalid");
    }
    let mut lines = raw.to_vec();
    if lines.iter().any(|line| *line == 0) {
        return Err("evidence_line_invalid");
    }
    lines.sort_unstable();
    lines.dedup();
    if lines.is_empty() || lines.len() > MAX_EVIDENCE_LINES_PER_FILE {
        return Err("evidence_line_budget_invalid");
    }
    Ok(lines)
}

fn project_python_source(
    file: &str,
    source: &str,
    expected_source_sha256: &str,
    raw_evidence_lines: &[usize],
) -> Result<Vec<ProjectedSiteDraft>, &'static str> {
    if !valid_sha256(expected_source_sha256) {
        return Err("source_sha256_invalid");
    }

    let source_sha256 = sha256_bytes(source.as_bytes());
    if source_sha256 != expected_source_sha256.to_ascii_lowercase() {
        return Err("source_sha256_mismatch");
    }

    let evidence_lines = normalized_evidence_lines(raw_evidence_lines)?;
    let ast = SupportLang::Python.ast_grep(source);
    let root = ast.root();

    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return Err("python_parse_invalid");
    }

    let mut drafts = Vec::new();

    for (top_level_index, node) in root.children().filter(|node| node.is_named()).enumerate() {
        let range = node.range();
        let start_line = line_for_byte(source, range.start);

        if evidence_lines.binary_search(&start_line).is_err() {
            continue;
        }

        let kind = node.kind();
        let kind = kind.as_ref();
        let Some((relation, operation)) = python_site_policy(kind) else {
            continue;
        };

        let anchor_text_sha256 = sha256_bytes(node.text().as_ref().as_bytes());
        let structural_path = vec![top_level_index];

        let descriptor_sha256 = sha256_json(&DescriptorHashPayload {
            protocol: SEALED_EDIT_SITE_DESCRIPTOR_PROTOCOL,
            provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
            backend: SEALED_EDIT_SITE_BACKEND,
            language: "python",
            node_kind: kind,
            structural_path: &structural_path,
            relation,
            operation,
            anchor_text_sha256: &anchor_text_sha256,
        });

        let evidence_binding_sha256 = sha256_json(&EvidenceHashPayload {
            protocol: SEALED_EDIT_SITE_EVIDENCE_PROTOCOL,
            file,
            source_sha256: &source_sha256,
            evidence_line: start_line,
        });

        let site_sha256 = sha256_json(&SiteHashPayload {
            protocol: SEALED_EDIT_SITE_PROTOCOL,
            file,
            source_sha256: &source_sha256,
            descriptor_sha256: &descriptor_sha256,
            evidence_binding_sha256: &evidence_binding_sha256,
        });

        let derived_insert_byte = match operation {
            "insert_before" => range.start,
            "insert_after" => range.end,
            _ => return Err("site_policy_invalid"),
        };

        drafts.push(ProjectedSiteDraft {
            file: file.to_string(),
            source_sha256: source_sha256.clone(),
            evidence_line: start_line,
            node_kind: kind.to_string(),
            structural_path,
            relation,
            operation,
            anchor_text_sha256,
            descriptor_sha256,
            evidence_binding_sha256,
            site_sha256,
            derived_anchor_start_byte: range.start,
            derived_anchor_end_byte: range.end,
            derived_insert_byte,
        });
    }

    Ok(drafts)
}

fn project_file(
    root: &Path,
    request: &ProjectionFileRequest,
) -> Result<Vec<ProjectedSiteDraft>, &'static str> {
    let file = safe_rel(&request.file).ok_or("file_path_invalid")?;
    if !matches!(
        Path::new(&file)
            .extension()
            .and_then(|value| value.to_str()),
        Some("py" | "pyi")
    ) {
        return Err("language_unsupported");
    }

    let path = safe_existing_file(root, &file).ok_or("source_file_unavailable")?;
    let source = fs::read_to_string(path).map_err(|_| "source_utf8_invalid")?;

    project_python_source(
        &file,
        &source,
        &request.source_sha256,
        &request.evidence_lines,
    )
}

pub fn project_sealed_edit_sites(request: &ProjectionRequest) -> ProjectionResponse {
    if request.files.is_empty() || request.files.len() > MAX_FILES {
        return ProjectionResponse {
            protocol: SEALED_EDIT_SITE_PROJECTION_PROTOCOL,
            provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
            backend: SEALED_EDIT_SITE_BACKEND,
            authority: SEALED_EDIT_SITE_AUTHORITY,
            complete: false,
            sites: Vec::new(),
            errors: vec![ProjectionError {
                file: String::new(),
                reason: "file_budget_invalid",
            }],
        };
    }

    let root = Path::new(&request.root);
    if fs::canonicalize(root).is_err() {
        return ProjectionResponse {
            protocol: SEALED_EDIT_SITE_PROJECTION_PROTOCOL,
            provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
            backend: SEALED_EDIT_SITE_BACKEND,
            authority: SEALED_EDIT_SITE_AUTHORITY,
            complete: false,
            sites: Vec::new(),
            errors: vec![ProjectionError {
                file: String::new(),
                reason: "root_unavailable",
            }],
        };
    }

    let mut drafts = Vec::new();
    let mut errors = Vec::new();

    for file in &request.files {
        match project_file(root, file) {
            Ok(mut projected) => drafts.append(&mut projected),
            Err(reason) => errors.push(ProjectionError {
                file: file.file.clone(),
                reason,
            }),
        }
    }

    if !errors.is_empty() {
        return ProjectionResponse {
            protocol: SEALED_EDIT_SITE_PROJECTION_PROTOCOL,
            provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
            backend: SEALED_EDIT_SITE_BACKEND,
            authority: SEALED_EDIT_SITE_AUTHORITY,
            complete: false,
            sites: Vec::new(),
            errors,
        };
    }

    drafts.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then(a.structural_path.cmp(&b.structural_path))
            .then(a.operation.cmp(b.operation))
            .then(a.site_sha256.cmp(&b.site_sha256))
    });

    if drafts.len() > MAX_SITES_TOTAL {
        return ProjectionResponse {
            protocol: SEALED_EDIT_SITE_PROJECTION_PROTOCOL,
            provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
            backend: SEALED_EDIT_SITE_BACKEND,
            authority: SEALED_EDIT_SITE_AUTHORITY,
            complete: false,
            sites: Vec::new(),
            errors: vec![ProjectionError {
                file: String::new(),
                reason: "site_budget_exceeded",
            }],
        };
    }

    let sites = drafts
        .into_iter()
        .enumerate()
        .map(|(index, draft)| SealedEditSite {
            protocol: SEALED_EDIT_SITE_PROTOCOL,
            site_id: format!("insert:{index}"),
            authority: SEALED_EDIT_SITE_AUTHORITY,
            file: draft.file,
            source_sha256: draft.source_sha256,
            evidence_line: draft.evidence_line,
            language: "python",
            provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
            backend: SEALED_EDIT_SITE_BACKEND,
            node_kind: draft.node_kind,
            structural_path: draft.structural_path,
            relation: draft.relation,
            operation: draft.operation,
            anchor_text_sha256: draft.anchor_text_sha256,
            descriptor_sha256: draft.descriptor_sha256,
            evidence_binding_sha256: draft.evidence_binding_sha256,
            site_sha256: draft.site_sha256,
            derived_anchor_start_byte: draft.derived_anchor_start_byte,
            derived_anchor_end_byte: draft.derived_anchor_end_byte,
            derived_insert_byte: draft.derived_insert_byte,
            coordinates_authority: SEALED_EDIT_SITE_COORDINATES_AUTHORITY,
        })
        .collect();

    ProjectionResponse {
        protocol: SEALED_EDIT_SITE_PROJECTION_PROTOCOL,
        provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
        backend: SEALED_EDIT_SITE_BACKEND,
        authority: SEALED_EDIT_SITE_AUTHORITY,
        complete: true,
        sites,
        errors: Vec::new(),
    }
}

pub fn run_cli() -> Result<()> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_string(&mut input)
        .context("cannot read sealed edit-site request")?;

    anyhow::ensure!(
        input.len() as u64 <= MAX_REQUEST_BYTES,
        "sealed edit-site request exceeds byte budget"
    );

    let request: ProjectionRequest =
        serde_json::from_str(&input).context("invalid sealed edit-site request JSON")?;
    let response = project_sealed_edit_sites(&request);

    serde_json::to_writer(io::stdout(), &response)
        .context("cannot serialize sealed edit-site response")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(
        source: &str,
        evidence_lines: &[usize],
    ) -> Result<Vec<ProjectedSiteDraft>, &'static str> {
        let hash = sha256_bytes(source.as_bytes());
        project_python_source("routes/sample.py", source, &hash, evidence_lines)
    }

    #[test]
    fn projects_only_evidence_exact_module_boundaries() {
        let source = concat!(
            "from database import get_conn\n",
            "def helper():\n",
            "    return 1\n",
            "@bp.route(\"/x\")\n",
            "def route():\n",
            "    return \"x\"\n",
        );

        let sites = project(source, &[1, 3, 4]).unwrap();
        assert_eq!(sites.len(), 2);

        assert_eq!(sites[0].node_kind, "import_from_statement");
        assert_eq!(sites[0].operation, "insert_after");
        assert_eq!(sites[0].relation, "module_child_after");
        assert_eq!(sites[0].evidence_line, 1);

        assert_eq!(sites[1].node_kind, "decorated_definition");
        assert_eq!(sites[1].operation, "insert_before");
        assert_eq!(sites[1].relation, "module_child_before");
        assert_eq!(sites[1].evidence_line, 4);

        assert!(!sites.iter().any(|site| site.evidence_line == 3));
    }

    #[test]
    fn decorated_definition_hashes_wrapper_not_inner_function() {
        let source = concat!(
            "@bp.route(\"/x\")\n",
            "def route():\n",
            "    return \"x\"\n",
        );

        let sites = project(source, &[1]).unwrap();
        assert_eq!(sites.len(), 1);
        assert_eq!(sites[0].node_kind, "decorated_definition");
        assert_eq!(sites[0].derived_anchor_start_byte, 0);
        assert_eq!(sites[0].derived_insert_byte, 0);
        assert_eq!(
            sites[0].anchor_text_sha256,
            sha256_bytes(source.trim_end_matches('\n').as_bytes())
        );
    }

    #[test]
    fn source_hash_is_mandatory_and_fail_closed() {
        let source = "import io\n";
        let wrong = "0".repeat(64);
        assert_eq!(
            project_python_source("x.py", source, &wrong, &[1]).unwrap_err(),
            "source_sha256_mismatch"
        );
        assert_eq!(
            project_python_source("x.py", source, "bad", &[1]).unwrap_err(),
            "source_sha256_invalid"
        );
    }

    #[test]
    fn evidence_order_does_not_change_site_identity() {
        let source = concat!("import io\n", "@decorator\n", "def f():\n", "    pass\n",);

        let mut a = project(source, &[2, 1]).unwrap();
        let mut b = project(source, &[1, 2]).unwrap();
        a.sort_by(|x, y| x.site_sha256.cmp(&y.site_sha256));
        b.sort_by(|x, y| x.site_sha256.cmp(&y.site_sha256));

        assert_eq!(
            a.iter().map(|site| &site.site_sha256).collect::<Vec<_>>(),
            b.iter().map(|site| &site.site_sha256).collect::<Vec<_>>()
        );
    }

    #[test]
    fn comment_only_source_drift_preserves_ast_descriptor_but_changes_site_identity() {
        let a = "import io\n";
        let b = "import io  # changed\n";

        let a_site = project(a, &[1]).unwrap().remove(0);
        let b_site = project(b, &[1]).unwrap().remove(0);

        assert_ne!(a_site.source_sha256, b_site.source_sha256);
        assert_eq!(a_site.anchor_text_sha256, b_site.anchor_text_sha256);
        assert_eq!(a_site.descriptor_sha256, b_site.descriptor_sha256);
        assert_ne!(
            a_site.evidence_binding_sha256,
            b_site.evidence_binding_sha256
        );
        assert_ne!(a_site.site_sha256, b_site.site_sha256);
    }

    #[test]
    fn semantic_anchor_drift_changes_descriptor_and_site_identity() {
        let a = "import io\n";
        let b = "import json\n";

        let a_site = project(a, &[1]).unwrap().remove(0);
        let b_site = project(b, &[1]).unwrap().remove(0);

        assert_ne!(a_site.source_sha256, b_site.source_sha256);
        assert_ne!(a_site.anchor_text_sha256, b_site.anchor_text_sha256);
        assert_ne!(a_site.descriptor_sha256, b_site.descriptor_sha256);
        assert_ne!(
            a_site.evidence_binding_sha256,
            b_site.evidence_binding_sha256
        );
        assert_ne!(a_site.site_sha256, b_site.site_sha256);
    }

    #[test]
    fn hashes_bind_provider_and_evidence_not_execution_offsets() {
        let source = "import io\n";
        let site = project(source, &[1]).unwrap().remove(0);

        assert!(valid_sha256(&site.anchor_text_sha256));
        assert!(valid_sha256(&site.descriptor_sha256));
        assert!(valid_sha256(&site.evidence_binding_sha256));
        assert!(valid_sha256(&site.site_sha256));

        let descriptor = sha256_json(&DescriptorHashPayload {
            protocol: SEALED_EDIT_SITE_DESCRIPTOR_PROTOCOL,
            provider_protocol: SEALED_EDIT_SITE_PROVIDER_PROTOCOL,
            backend: SEALED_EDIT_SITE_BACKEND,
            language: "python",
            node_kind: &site.node_kind,
            structural_path: &site.structural_path,
            relation: site.relation,
            operation: site.operation,
            anchor_text_sha256: &site.anchor_text_sha256,
        });
        assert_eq!(descriptor, site.descriptor_sha256);
    }

    #[test]
    fn invalid_python_never_produces_sites() {
        let source = "def broken(:\n    pass\n";
        let hash = sha256_bytes(source.as_bytes());
        assert_eq!(
            project_python_source("x.py", source, &hash, &[1]).unwrap_err(),
            "python_parse_invalid"
        );
    }

    #[test]
    fn unsupported_or_nested_surface_is_not_promoted() {
        let source = concat!("def f():\n", "    import io\n", "    return 1\n",);
        let sites = project(source, &[2]).unwrap();
        assert!(sites.is_empty());
    }

    #[test]
    fn cryptographic_site_identity_excludes_opaque_display_id() {
        let source = "import io\n";
        let draft = project(source, &[1]).unwrap().remove(0);

        let recomputed = sha256_json(&SiteHashPayload {
            protocol: SEALED_EDIT_SITE_PROTOCOL,
            file: &draft.file,
            source_sha256: &draft.source_sha256,
            descriptor_sha256: &draft.descriptor_sha256,
            evidence_binding_sha256: &draft.evidence_binding_sha256,
        });
        assert_eq!(recomputed, draft.site_sha256);
    }
}
