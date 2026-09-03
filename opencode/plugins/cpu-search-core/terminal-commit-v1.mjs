import { createHash } from "node:crypto"

export const TERMINAL_COMMIT_PROTOCOL = "terminal-commit-v1"
export const TERMINAL_OUTCOME = "VERIFIED"

const PATCH_RECEIPT_PROTOCOL = "patch-receipt-v1"
const VERIFICATION_RECEIPT_PROTOCOL = "verification-receipt-v1"
const SHA256_RE = /^[0-9a-f]{64}$/
const TASK_PROOF_EVALUATOR_PROTOCOL = "task-proof-evaluator-v1"
const TASK_PROOF_TERMINAL_POLICY = "additive-task-proof-v1"
const NATIVE_TERMINAL_POLICY = "exact-rename-v1"

function reject(reason) {
  return {
    ok: false,
    protocol: TERMINAL_COMMIT_PROTOCOL,
    reason,
    commit: null,
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function relativeArtifactPath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.startsWith("/") ||
    value.includes("\0")
  ) {
    return null
  }

  const normalized = value.replaceAll("\\", "/")
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null
  }

  return normalized
}

function validProofAssessment(value) {
  return (
    value?.ok === true &&
    value?.disposition === "pass" &&
    Array.isArray(value?.failed) &&
    value.failed.length === 0
  )
}

function validTaskProofAssessment(value) {
  return (
    value?.protocol ===
      TASK_PROOF_EVALUATOR_PROTOCOL &&
    value?.ok === true &&
    value?.verdict === "PASS" &&
    Number.isInteger(value?.checks_total) &&
    value.checks_total > 0 &&
    value?.checks_passed ===
      value.checks_total &&
    value?.checks_failed === 0 &&
    value?.baseline_clean_before === true &&
    value?.baseline_clean_after === true &&
    value?.proof_authority ===
      "deterministic_candidate_analysis" &&
    value?.mutation_authority === false
  )
}

export function deriveTerminalCommit({
  state,
  persisted,
  proofAssessment,
  terminalPolicy = NATIVE_TERMINAL_POLICY,
  taskProofAssessment = null,
}) {
  if (
    !state ||
    state.patchAccepted !== true ||
    state.executionState !== "done" ||
    state.executionEvent !== "patch_ready" ||
    state.executionReason !== "verification_passed"
  ) {
    return reject("terminal_commit_not_verified_terminal")
  }

  if (
    state.taskContextLatched !== true ||
    state.taskContextDrift === true ||
    typeof state.taskTurnID !== "string" ||
    state.taskTurnID.length < 1 ||
    !SHA256_RE.test(state.taskTextSha256 ?? "")
  ) {
    return reject("terminal_commit_task_identity_invalid")
  }

  const receiptPath = relativeArtifactPath(persisted?.path)
  const verificationPath = relativeArtifactPath(persisted?.verificationPath)
  const patchPath = relativeArtifactPath(persisted?.receipt?.patch_path)

  if (
    !receiptPath ||
    !verificationPath ||
    !patchPath ||
    state.patchReceiptPath !== receiptPath
  ) {
    return reject("terminal_commit_artifact_path_invalid")
  }

  if (
    persisted?.receipt?.protocol !== PATCH_RECEIPT_PROTOCOL ||
    persisted?.receipt?.verification_protocol !==
      VERIFICATION_RECEIPT_PROTOCOL ||
    persisted?.verificationReceipt?.protocol !==
      VERIFICATION_RECEIPT_PROTOCOL ||
    persisted?.receipt?.verification_receipt !== verificationPath ||
    persisted?.verificationReceipt?.patch_receipt !== receiptPath
  ) {
    return reject("terminal_commit_receipt_protocol_mismatch")
  }

  if (
    !validProofAssessment(proofAssessment) ||
    !validProofAssessment(
      persisted?.verificationReceipt?.proof_assessment,
    ) ||
    persisted?.receipt?.proof_disposition !== "pass"
  ) {
    return reject("terminal_commit_proof_not_pass")
  }

  if (
    persisted?.receipt?.repo_mutated !== false ||
    persisted?.verificationReceipt?.verifier?.ok !== true ||
    persisted?.verificationReceipt?.verifier?.invariants_failed !== 0 ||
    persisted?.verificationReceipt?.verifier?.worktree_cleaned !== true ||
    !SHA256_RE.test(persisted?.receipt?.patch_sha256 ?? "") ||
    !SHA256_RE.test(persisted?.receiptSha256 ?? "") ||
    !SHA256_RE.test(persisted?.verificationSha256 ?? "")
  ) {
    return reject("terminal_commit_artifact_identity_invalid")
  }

  if (
    persisted.verificationReceipt?.patch_sha256 !==
    persisted.receipt.patch_sha256
  ) {
    return reject("terminal_commit_patch_identity_mismatch")
  }

  const additiveTaskProofPolicy =
    terminalPolicy ===
    TASK_PROOF_TERMINAL_POLICY

  if (
    terminalPolicy !==
      NATIVE_TERMINAL_POLICY &&
    !additiveTaskProofPolicy
  ) {
    return reject(
      "terminal_commit_policy_invalid",
    )
  }

  let taskProofSha256 = null

  if (additiveTaskProofPolicy) {
    const persistedTaskProof =
      persisted?.verificationReceipt
        ?.task_proof

    if (
      !validTaskProofAssessment(
        taskProofAssessment,
      ) ||
      !validTaskProofAssessment(
        persistedTaskProof,
      )
    ) {
      return reject(
        "terminal_commit_task_proof_not_pass",
      )
    }

    const suppliedSha256 =
      sha256(
        JSON.stringify(
          taskProofAssessment,
        ),
      )

    const persistedSha256 =
      sha256(
        JSON.stringify(
          persistedTaskProof,
        ),
      )

    if (
      suppliedSha256 !==
      persistedSha256
    ) {
      return reject(
        "terminal_commit_task_proof_mismatch",
      )
    }

    taskProofSha256 =
      suppliedSha256
  }

  const canonical = {
    protocol: TERMINAL_COMMIT_PROTOCOL,
    outcome: TERMINAL_OUTCOME,
    task_sha256: state.taskTextSha256,
    user_turn_id: state.taskTurnID,
    patch_receipt_path: receiptPath,
    patch_receipt_sha256: persisted.receiptSha256,
    verification_receipt_path: verificationPath,
    verification_receipt_sha256: persisted.verificationSha256,
    patch_path: patchPath,
    patch_sha256: persisted.receipt.patch_sha256,
    proof_disposition: "pass",
    terminal_reason: "verification_passed",
  }

  if (additiveTaskProofPolicy) {
    canonical.terminal_policy =
      TASK_PROOF_TERMINAL_POLICY
    canonical.task_proof_sha256 =
      taskProofSha256
  }

  return {
    ok: true,
    protocol: TERMINAL_COMMIT_PROTOCOL,
    reason: "verified_terminal_committed",
    commit: {
      ...canonical,
      commit_sha256: sha256(JSON.stringify(canonical)),
    },
  }
}

export function claimTerminalCommit(state, commit) {
  if (
    !state ||
    commit?.protocol !== TERMINAL_COMMIT_PROTOCOL ||
    commit?.outcome !== TERMINAL_OUTCOME ||
    !SHA256_RE.test(commit?.commit_sha256 ?? "")
  ) {
    return { ok: false, reason: "terminal_commit_invalid" }
  }

  if (state.terminalCommit != null) {
    if (
      state.terminalCommitSha256 === commit.commit_sha256 &&
      state.terminalCommit?.commit_sha256 === commit.commit_sha256
    ) {
      return {
        ok: true,
        duplicate: true,
        reason: "terminal_commit_replay",
        commit_sha256: commit.commit_sha256,
      }
    }

    return { ok: false, reason: "terminal_commit_conflict" }
  }

  if ((state.terminalCommitClaims ?? 0) !== 0) {
    return { ok: false, reason: "terminal_commit_already_claimed" }
  }

  state.terminalCommit = commit
  state.terminalCommitSha256 = commit.commit_sha256
  state.terminalCommitClaims = 1

  return {
    ok: true,
    duplicate: false,
    reason: "terminal_commit_claimed",
    commit_sha256: commit.commit_sha256,
  }
}

export function terminalCommitMatchesTask(commit, snapshot) {
  if (
    commit?.protocol !== TERMINAL_COMMIT_PROTOCOL ||
    commit?.outcome !== TERMINAL_OUTCOME ||
    !SHA256_RE.test(commit?.commit_sha256 ?? "")
  ) {
    return { ok: false, reason: "terminal_commit_invalid" }
  }

  if (
    snapshot?.ok !== true ||
    typeof snapshot?.turnID !== "string" ||
    snapshot.turnID.length < 1 ||
    !SHA256_RE.test(snapshot?.textSha256 ?? "")
  ) {
    return { ok: false, reason: "terminal_task_snapshot_invalid" }
  }

  if (snapshot.turnID !== commit.user_turn_id) {
    return { ok: false, reason: "terminal_task_turn_changed" }
  }

  if (snapshot.textSha256 !== commit.task_sha256) {
    return { ok: false, reason: "terminal_task_text_drift" }
  }

  return { ok: true, reason: "terminal_task_match" }
}
