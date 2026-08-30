use opencode_evidence_distiller::crypto_hash::sha256_bytes as sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read};
use std::path::{Component, Path};

const REQUEST_PROTOCOL: &str = "completion-authorizer-request-v1";
const RESPONSE_PROTOCOL: &str = "completion-authorizer-v1";
const CERTIFICATE_PROTOCOL: &str = "completion-certificate-v1";
const POLICY: &str = "exact-rename-v1";
const OUTCOME: &str = "VERIFIED";

const TASK_ACTION_PROTOCOL: &str = "task-action-v1";
const ACTION_COMMIT_PROTOCOL: &str = "action-commit-v1";
const ACTION_COMMIT_ORIGIN: &str = "deterministic_action_commit";
const PATCH_RECEIPT_PROTOCOL: &str = "patch-receipt-v1";
const VERIFICATION_RECEIPT_PROTOCOL: &str = "verification-receipt-v1";
const VERIFIER_PROTOCOL: &str = "invariant-verifier-v2";
const PROOF_PROTOCOL: &str = "proof-obligation-v1";
const RENAME_TOOL: &str = "execute_rename_symbol";

const MAX_RECEIPT_BYTES: usize = 512 * 1024;
const MAX_OBLIGATIONS: usize = 16;
const MAX_TURN_ID_BYTES: usize = 512;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct TaskAction {
    protocol: String,
    status: String,
    operation: Option<String>,
    old_name: Option<String>,
    new_name: Option<String>,
    task_sha256: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct ActionTarget {
    file: String,
    symbol_kind: String,
    symbol_name: String,
    start_line: u64,
    end_line: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct ActionCommit {
    protocol: String,
    operation: String,
    tool: String,
    task_sha256: String,
    old_name: String,
    new_name: String,
    target: ActionTarget,
    target_identity_sha256: String,
    target_source_sha256: String,
    scout_handoff_path: String,
    edit_capsule_path: String,
    edit_capsule_sha256: String,
    dispatch_origin: String,
    commit_sha256: String,
}

#[derive(Serialize)]
struct ActionCommitCanonical<'a> {
    protocol: &'a str,
    operation: &'a str,
    tool: &'a str,
    task_sha256: &'a str,
    old_name: &'a str,
    new_name: &'a str,
    target: &'a ActionTarget,
    target_identity_sha256: &'a str,
    target_source_sha256: &'a str,
    scout_handoff_path: &'a str,
    edit_capsule_path: &'a str,
    edit_capsule_sha256: &'a str,
    dispatch_origin: &'a str,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct ProofObligation {
    protocol: String,
    id: String,
    check_kind: String,
    disposition: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
struct ProofAssessment {
    protocol: String,
    ok: bool,
    disposition: String,
    obligations: Vec<ProofObligation>,
    failed: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct Request {
    protocol: String,
    policy: String,
    user_turn_id: String,
    task_action: TaskAction,
    action_commit: ActionCommit,
    patch_receipt_path: String,
    patch_receipt_body: String,
    verification_receipt_path: String,
    verification_receipt_body: String,
    proof_assessment: ProofAssessment,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct CompletionCertificate {
    protocol: &'static str,
    policy: &'static str,
    outcome: &'static str,
    operation: &'static str,
    old_name: String,
    new_name: String,
    task_sha256: String,
    user_turn_id: String,
    action_commit_sha256: String,
    patch_receipt_path: String,
    patch_receipt_sha256: String,
    verification_receipt_path: String,
    verification_receipt_sha256: String,
    patch_sha256: String,
    proof_assessment_sha256: String,
    certificate_sha256: String,
}

#[derive(Serialize)]
struct CertificateCanonical<'a> {
    protocol: &'static str,
    policy: &'static str,
    outcome: &'static str,
    operation: &'static str,
    old_name: &'a str,
    new_name: &'a str,
    task_sha256: &'a str,
    user_turn_id: &'a str,
    action_commit_sha256: &'a str,
    patch_receipt_path: &'a str,
    patch_receipt_sha256: &'a str,
    verification_receipt_path: &'a str,
    verification_receipt_sha256: &'a str,
    patch_sha256: &'a str,
    proof_assessment_sha256: &'a str,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    decision: &'static str,
    reason: &'static str,
    certificate: Option<CompletionCertificate>,
}

fn abstain(reason: &'static str) -> Response {
    Response {
        protocol: RESPONSE_PROTOCOL,
        decision: "ABSTAIN",
        reason,
        certificate: None,
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c == '_' || c == '$' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c == '$' || c.is_ascii_alphanumeric())
}

fn safe_rel(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > 4096 || raw.chars().any(char::is_control) {
        return false;
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return false;
    }
    let mut depth = 0usize;
    for part in path.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => return false,
            _ => return false,
        }
    }
    depth > 0
}

fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn value_bool(value: &Value, key: &str) -> Option<bool> {
    value.get(key)?.as_bool()
}

fn value_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}

fn verifier_check_passes(verifier: &Value, kind: &str) -> bool {
    let Some(checks) = verifier.get("checks").and_then(Value::as_array) else {
        return false;
    };
    let rows = checks
        .iter()
        .filter(|row| value_str(row, "kind") == Some(kind))
        .collect::<Vec<_>>();
    !rows.is_empty() && rows.iter().all(|row| value_bool(row, "pass") == Some(true))
}

fn expected_obligations() -> Vec<ProofObligation> {
    vec![
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "changed_file_set".into(), check_kind: "changed_file_set".into(), disposition: "fatal".into() },
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "replay_exact".into(), check_kind: "replay_exact".into(), disposition: "fatal".into() },
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "ast_parse".into(), check_kind: "ast_parse".into(), disposition: "fatal".into() },
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "candidate_validity_barrier".into(), check_kind: "candidate_validity_barrier".into(), disposition: "fatal".into() },
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "top_level_conservation".into(), check_kind: "top_level_conservation".into(), disposition: "repair".into() },
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "target_cardinality".into(), check_kind: "target_cardinality".into(), disposition: "repair".into() },
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "rename_identifier_delta".into(), check_kind: "rename_identifier_delta".into(), disposition: "repair".into() },
        ProofObligation { protocol: PROOF_PROTOCOL.into(), id: "rename_syntactic_closure".into(), check_kind: "rename_global_closure".into(), disposition: "rescout".into() },
    ]
}

fn canonical_action_commit(commit: &ActionCommit) -> Result<String, ()> {
    serde_json::to_string(&ActionCommitCanonical {
        protocol: &commit.protocol,
        operation: &commit.operation,
        tool: &commit.tool,
        task_sha256: &commit.task_sha256,
        old_name: &commit.old_name,
        new_name: &commit.new_name,
        target: &commit.target,
        target_identity_sha256: &commit.target_identity_sha256,
        target_source_sha256: &commit.target_source_sha256,
        scout_handoff_path: &commit.scout_handoff_path,
        edit_capsule_path: &commit.edit_capsule_path,
        edit_capsule_sha256: &commit.edit_capsule_sha256,
        dispatch_origin: &commit.dispatch_origin,
    }).map_err(|_| ())
}

fn validate_task_and_action(request: &Request) -> Result<(String, String, String), &'static str> {
    let action = &request.task_action;
    if action.protocol != TASK_ACTION_PROTOCOL
        || action.status != "exact"
        || action.operation.as_deref() != Some("rename_symbol")
    {
        return Err("unsupported_task_class");
    }

    let old_name = action.old_name.as_deref().ok_or("task_action_invalid")?;
    let new_name = action.new_name.as_deref().ok_or("task_action_invalid")?;
    let task_sha = action.task_sha256.as_deref().ok_or("task_action_invalid")?;
    if !valid_identifier(old_name)
        || !valid_identifier(new_name)
        || old_name == new_name
        || !is_sha256(task_sha)
    {
        return Err("task_action_invalid");
    }

    let commit = &request.action_commit;
    if commit.protocol != ACTION_COMMIT_PROTOCOL
        || commit.operation != "rename_symbol"
        || commit.tool != RENAME_TOOL
        || commit.dispatch_origin != ACTION_COMMIT_ORIGIN
        || commit.task_sha256 != task_sha
        || commit.old_name != old_name
        || commit.new_name != new_name
        || commit.target.symbol_name != old_name
        || commit.target.start_line < 1
        || commit.target.end_line < commit.target.start_line
        || !safe_rel(&commit.target.file)
        || !safe_rel(&commit.scout_handoff_path)
        || !safe_rel(&commit.edit_capsule_path)
        || !is_sha256(&commit.target_identity_sha256)
        || !is_sha256(&commit.target_source_sha256)
        || !is_sha256(&commit.edit_capsule_sha256)
        || !is_sha256(&commit.commit_sha256)
    {
        return Err("action_commit_invalid");
    }

    let canonical = canonical_action_commit(commit).map_err(|_| "action_commit_invalid")?;
    if sha256_hex(canonical.as_bytes()) != commit.commit_sha256 {
        return Err("action_commit_hash_invalid");
    }

    Ok((old_name.to_string(), new_name.to_string(), task_sha.to_string()))
}

fn validate_proof(assessment: &ProofAssessment) -> Result<String, &'static str> {
    if assessment.protocol != PROOF_PROTOCOL
        || assessment.ok != true
        || assessment.disposition != "pass"
        || !assessment.failed.is_empty()
        || assessment.obligations.len() > MAX_OBLIGATIONS
        || assessment.obligations != expected_obligations()
    {
        return Err("proof_obligations_invalid");
    }
    let canonical = serde_json::to_string(assessment).map_err(|_| "proof_obligations_invalid")?;
    Ok(sha256_hex(canonical.as_bytes()))
}

fn validate_receipts(
    request: &Request,
    proof_sha: &str,
) -> Result<(String, String, String), &'static str> {
    if request.patch_receipt_body.len() > MAX_RECEIPT_BYTES
        || request.verification_receipt_body.len() > MAX_RECEIPT_BYTES
        || !safe_rel(&request.patch_receipt_path)
        || !safe_rel(&request.verification_receipt_path)
    {
        return Err("receipt_budget_or_path_invalid");
    }

    let patch: Value = serde_json::from_str(&request.patch_receipt_body)
        .map_err(|_| "patch_receipt_invalid")?;
    let verification: Value = serde_json::from_str(&request.verification_receipt_body)
        .map_err(|_| "verification_receipt_invalid")?;

    if value_str(&patch, "protocol") != Some(PATCH_RECEIPT_PROTOCOL)
        || value_str(&patch, "verification_protocol") != Some(VERIFICATION_RECEIPT_PROTOCOL)
        || value_str(&patch, "verification_receipt") != Some(request.verification_receipt_path.as_str())
        || value_str(&patch, "mutation_dispatch_origin") != Some(ACTION_COMMIT_ORIGIN)
        || value_str(&patch, "action_commit_protocol") != Some(ACTION_COMMIT_PROTOCOL)
        || value_str(&patch, "action_commit_sha256") != Some(request.action_commit.commit_sha256.as_str())
        || value_str(&patch, "mutation_tool") != Some(RENAME_TOOL)
        || value_str(&patch, "proof_obligation_protocol") != Some(PROOF_PROTOCOL)
        || value_str(&patch, "proof_disposition") != Some("pass")
        || value_bool(&patch, "repo_mutated") != Some(false)
        || value_str(&patch, "invariant_verifier_protocol") != Some(VERIFIER_PROTOCOL)
    {
        return Err("patch_receipt_authority_invalid");
    }

    let patch_sha = value_str(&patch, "patch_sha256").ok_or("patch_receipt_identity_invalid")?;
    if !is_sha256(patch_sha) {
        return Err("patch_receipt_identity_invalid");
    }

    let patch_total = value_u64(&patch, "invariants_total").ok_or("patch_receipt_verifier_summary_invalid")?;
    let patch_passed = value_u64(&patch, "invariants_passed").ok_or("patch_receipt_verifier_summary_invalid")?;
    let patch_failed = value_u64(&patch, "invariants_failed").ok_or("patch_receipt_verifier_summary_invalid")?;
    if patch_total == 0 || patch_total != patch_passed || patch_failed != 0 {
        return Err("patch_receipt_verifier_summary_invalid");
    }

    let patch_obligations: Vec<ProofObligation> = serde_json::from_value(
        patch.get("proof_obligations").cloned().ok_or("patch_receipt_proof_invalid")?
    ).map_err(|_| "patch_receipt_proof_invalid")?;
    if patch_obligations != expected_obligations() {
        return Err("patch_receipt_proof_invalid");
    }

    if value_str(&verification, "protocol") != Some(VERIFICATION_RECEIPT_PROTOCOL)
        || value_str(&verification, "patch_receipt") != Some(request.patch_receipt_path.as_str())
        || value_str(&verification, "patch_sha256") != Some(patch_sha)
        || value_str(&verification, "proof_obligation_protocol") != Some(PROOF_PROTOCOL)
    {
        return Err("verification_receipt_authority_invalid");
    }

    let persisted_proof: ProofAssessment = serde_json::from_value(
        verification.get("proof_assessment").cloned().ok_or("verification_receipt_proof_invalid")?
    ).map_err(|_| "verification_receipt_proof_invalid")?;
    if &persisted_proof != &request.proof_assessment {
        return Err("verification_receipt_proof_mismatch");
    }
    let persisted_proof_json = serde_json::to_string(&persisted_proof)
        .map_err(|_| "verification_receipt_proof_invalid")?;
    if sha256_hex(persisted_proof_json.as_bytes()) != proof_sha {
        return Err("verification_receipt_proof_hash_mismatch");
    }

    let verifier = verification.get("verifier").ok_or("verifier_evidence_missing")?;
    if value_str(verifier, "protocol") != Some(VERIFIER_PROTOCOL)
        || value_bool(verifier, "ok") != Some(true)
        || value_str(verifier, "verdict") != Some("PASS")
        || value_u64(verifier, "invariants_failed") != Some(0)
        || value_bool(verifier, "worktree_cleaned") != Some(true)
        || value_bool(verifier, "candidate_hygiene") != Some(true)
        || value_bool(verifier, "changed_file_set") != Some(true)
        || value_bool(verifier, "replay_exact") != Some(true)
        || value_bool(verifier, "ast_parse") != Some(true)
        || value_bool(verifier, "candidate_validity_barrier") != Some(true)
        || value_bool(verifier, "top_level_conservation") != Some(true)
        || value_bool(verifier, "target_cardinality") != Some(true)
        || value_bool(verifier, "rename_identifier_delta") != Some(true)
        || value_bool(verifier, "rename_global_closure") != Some(true)
        || value_bool(verifier, "rename_destination_fresh") != Some(true)
        || value_bool(verifier, "rename_reflective_builtin_safe") != Some(true)
    {
        return Err("verifier_completion_evidence_invalid");
    }

    let total = value_u64(verifier, "invariants_total").ok_or("verifier_completion_evidence_invalid")?;
    let passed = value_u64(verifier, "invariants_passed").ok_or("verifier_completion_evidence_invalid")?;
    if total == 0 || total != passed {
        return Err("verifier_completion_evidence_invalid");
    }

    for kind in [
        "changed_file_set",
        "candidate_hygiene",
        "replay_exact",
        "ast_parse",
        "candidate_validity_barrier",
        "top_level_conservation",
        "target_cardinality",
        "rename_global_closure",
        "rename_identifier_delta",
        "rename_destination_fresh",
        "rename_reflective_builtin_safe",
    ] {
        if !verifier_check_passes(verifier, kind) {
            return Err("verifier_completion_check_missing_or_failed");
        }
    }

    Ok((
        patch_sha.to_string(),
        sha256_hex(request.patch_receipt_body.as_bytes()),
        sha256_hex(request.verification_receipt_body.as_bytes()),
    ))
}

fn authorize(request: &Request) -> Response {
    if request.protocol != REQUEST_PROTOCOL {
        return abstain("request_protocol_mismatch");
    }
    if request.policy != POLICY {
        return abstain("policy_unsupported");
    }
    if request.user_turn_id.is_empty() || request.user_turn_id.len() > MAX_TURN_ID_BYTES {
        return abstain("user_turn_identity_invalid");
    }

    let (old_name, new_name, task_sha) = match validate_task_and_action(request) {
        Ok(value) => value,
        Err(reason) => return abstain(reason),
    };
    let proof_sha = match validate_proof(&request.proof_assessment) {
        Ok(value) => value,
        Err(reason) => return abstain(reason),
    };
    let (patch_sha, patch_receipt_sha, verification_receipt_sha) =
        match validate_receipts(request, &proof_sha) {
            Ok(value) => value,
            Err(reason) => return abstain(reason),
        };

    let canonical = CertificateCanonical {
        protocol: CERTIFICATE_PROTOCOL,
        policy: POLICY,
        outcome: OUTCOME,
        operation: "rename_symbol",
        old_name: &old_name,
        new_name: &new_name,
        task_sha256: &task_sha,
        user_turn_id: &request.user_turn_id,
        action_commit_sha256: &request.action_commit.commit_sha256,
        patch_receipt_path: &request.patch_receipt_path,
        patch_receipt_sha256: &patch_receipt_sha,
        verification_receipt_path: &request.verification_receipt_path,
        verification_receipt_sha256: &verification_receipt_sha,
        patch_sha256: &patch_sha,
        proof_assessment_sha256: &proof_sha,
    };
    let canonical_json = match serde_json::to_string(&canonical) {
        Ok(value) => value,
        Err(_) => return abstain("certificate_serialization_failed"),
    };
    let certificate_sha = sha256_hex(canonical_json.as_bytes());

    Response {
        protocol: RESPONSE_PROTOCOL,
        decision: "CERTIFY",
        reason: "completion_certificate_issued",
        certificate: Some(CompletionCertificate {
            protocol: CERTIFICATE_PROTOCOL,
            policy: POLICY,
            outcome: OUTCOME,
            operation: "rename_symbol",
            old_name,
            new_name,
            task_sha256: task_sha,
            user_turn_id: request.user_turn_id.clone(),
            action_commit_sha256: request.action_commit.commit_sha256.clone(),
            patch_receipt_path: request.patch_receipt_path.clone(),
            patch_receipt_sha256: patch_receipt_sha,
            verification_receipt_path: request.verification_receipt_path.clone(),
            verification_receipt_sha256: verification_receipt_sha,
            patch_sha256: patch_sha,
            proof_assessment_sha256: proof_sha,
            certificate_sha256: certificate_sha,
        }),
    }
}

fn read_request() -> Result<Request, String> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).map_err(|e| e.to_string())?;
    if input.len() > (2 * MAX_RECEIPT_BYTES + 256 * 1024) {
        return Err("request_too_large".into());
    }
    serde_json::from_str(&input).map_err(|_| "invalid_request_json".into())
}

fn main() {
    let request = match read_request() {
        Ok(value) => value,
        Err(reason) => {
            eprintln!("{reason}");
            std::process::exit(2);
        }
    };
    let response = authorize(&request);
    if serde_json::to_writer(io::stdout(), &response).is_err() {
        std::process::exit(3);
    }
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn exact_obligation_set_is_stable() {
        let ids = expected_obligations().into_iter().map(|x| x.id).collect::<Vec<_>>();
        assert_eq!(ids, vec![
            "changed_file_set", "replay_exact", "ast_parse", "candidate_validity_barrier",
            "top_level_conservation", "target_cardinality", "rename_identifier_delta", "rename_syntactic_closure",
        ]);
    }

    #[test]
    fn safe_relative_paths_fail_closed() {
        assert!(safe_rel(".opencode/patches/a.json"));
        assert!(!safe_rel("../a.json"));
        assert!(!safe_rel("/tmp/a.json"));
        assert!(!safe_rel(""));
    }
}
