import { createHash } from "node:crypto"

import {
  TASK_ACTION_PROTOCOL,
  taskActionIdentifier,
} from "./task-action-v1.mjs"

export const ACTION_COMMIT_PROTOCOL = "action-commit-v1"
export const ACTION_COMMIT_DISPATCH_ORIGIN = "deterministic_action_commit"

const EDIT_CAPSULE_PROTOCOL = "edit-capsule-v1"
const SHA256_RE = /^[0-9a-f]{64}$/

function reject(reason) {
  return {
    ok: false,
    protocol: ACTION_COMMIT_PROTOCOL,
    reason,
    commit: null,
  }
}

function canonicalTarget(target) {
  if (
    !target ||
    typeof target.file !== "string" ||
    target.file.length < 1 ||
    typeof target.symbol_kind !== "string" ||
    target.symbol_kind.length < 1 ||
    typeof target.symbol_name !== "string" ||
    target.symbol_name.length < 1 ||
    !Number.isInteger(target.start_line) ||
    !Number.isInteger(target.end_line) ||
    target.start_line < 1 ||
    target.end_line < target.start_line
  ) {
    return null
  }

  return {
    file: target.file,
    symbol_kind: target.symbol_kind,
    symbol_name: target.symbol_name,
    start_line: target.start_line,
    end_line: target.end_line,
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function deriveActionCommit({
  state,
  editCapsule,
  frontier,
  renameToolName,
  renameCapabilityProtocol,
}) {
  if (!state || state.executionState !== "mutate") {
    return reject("action_commit_not_initial_mutate")
  }
  if (state.taskContextDrift === true) {
    return reject("action_commit_task_drift")
  }
  if (state.patchAccepted === true) {
    return reject("action_commit_patch_already_accepted")
  }
  if (state.pendingRescout != null) {
    return reject("action_commit_rescout_pending")
  }
  if (state.mutationAttempts !== 0) {
    return reject("action_commit_not_first_attempt")
  }

  const action = state.taskAction ?? null
  const oldName = taskActionIdentifier(action?.old_name)
  const newName = taskActionIdentifier(action?.new_name)

  if (
    action?.protocol !== TASK_ACTION_PROTOCOL ||
    action?.status !== "exact" ||
    action?.operation !== "rename_symbol" ||
    typeof action?.task_sha256 !== "string" ||
    !SHA256_RE.test(action.task_sha256) ||
    action.task_sha256 !== state.taskTextSha256 ||
    !oldName ||
    !newName ||
    oldName === newName
  ) {
    return reject("action_commit_task_not_exact_rename")
  }

  if (
    typeof renameToolName !== "string" ||
    renameToolName.length < 1 ||
    frontier?.tool !== renameToolName
  ) {
    return reject("action_commit_frontier_mismatch")
  }

  const capability = state.renameMutationCapability ?? null
  const target = canonicalTarget(capability?.target)

  if (
    capability?.protocol !== renameCapabilityProtocol ||
    capability?.operation !== "rename_symbol" ||
    capability?.ready !== true ||
    capability?.globalReady !== true ||
    typeof state.scoutHandoffPath !== "string" ||
    state.scoutHandoffPath.length < 1 ||
    capability?.sourceHandoffPath !== state.scoutHandoffPath ||
    !target ||
    target.symbol_name !== oldName ||
    !SHA256_RE.test(capability?.targetIdentitySha256 ?? "") ||
    !SHA256_RE.test(capability?.targetSourceSha256 ?? "")
  ) {
    return reject("action_commit_rename_capability_mismatch")
  }

  if (
    editCapsule?.protocol !== EDIT_CAPSULE_PROTOCOL ||
    typeof editCapsule?.path !== "string" ||
    editCapsule.path.length < 1 ||
    !SHA256_RE.test(editCapsule?.sha256 ?? "")
  ) {
    return reject("action_commit_capsule_unavailable")
  }

  const canonical = {
    protocol: ACTION_COMMIT_PROTOCOL,
    operation: "rename_symbol",
    tool: renameToolName,
    task_sha256: action.task_sha256,
    old_name: oldName,
    new_name: newName,
    target,
    target_identity_sha256: capability.targetIdentitySha256,
    target_source_sha256: capability.targetSourceSha256,
    scout_handoff_path: state.scoutHandoffPath,
    edit_capsule_path: editCapsule.path,
    edit_capsule_sha256: editCapsule.sha256,
    dispatch_origin: ACTION_COMMIT_DISPATCH_ORIGIN,
  }

  const commitSha256 = sha256(JSON.stringify(canonical))

  return {
    ok: true,
    protocol: ACTION_COMMIT_PROTOCOL,
    reason: "exact_rename_committed",
    commit: {
      ...canonical,
      commit_sha256: commitSha256,
    },
  }
}

export function claimActionCommit(state, commit) {
  if (
    !state ||
    commit?.protocol !== ACTION_COMMIT_PROTOCOL ||
    !SHA256_RE.test(commit?.commit_sha256 ?? "")
  ) {
    return { ok: false, reason: "action_commit_invalid" }
  }

  if (
    typeof state.actionCommitSha256 === "string" &&
    state.actionCommitSha256.length > 0
  ) {
    return {
      ok: false,
      reason:
        state.actionCommitSha256 === commit.commit_sha256
          ? "action_commit_duplicate"
          : "action_commit_conflict",
    }
  }

  if ((state.actionCommitDispatches ?? 0) !== 0) {
    return { ok: false, reason: "action_commit_already_dispatched" }
  }

  state.actionCommitSha256 = commit.commit_sha256
  state.actionCommitDispatches = 1

  return {
    ok: true,
    reason: "action_commit_claimed",
    commit_sha256: commit.commit_sha256,
  }
}
