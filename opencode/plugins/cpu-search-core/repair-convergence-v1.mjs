import { createHash } from "node:crypto"

export const REPAIR_CONVERGENCE_PROTOCOL =
  "repair-convergence-v1"
export const FAILED_CANDIDATE_PROTOCOL =
  "failed-candidate-ir-v1"
export const REPAIR_DELTA_PROTOCOL =
  "repair-delta-v1"

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function missingKey(row) {
  if (
    typeof row?.obligation !== "string" ||
    typeof row?.slot !== "string" ||
    typeof row?.operation !== "string"
  ) {
    return null
  }
  return `${row.obligation}\0${row.slot}\0${row.operation}`
}

export function repairMissingKeys(coverageFailure) {
  const keys = array(coverageFailure?.missing)
    .map(missingKey)
    .filter(Boolean)
  return Object.freeze([...new Set(keys)].sort())
}

export function snapshotFailedCandidate({
  request,
  slotUsage,
} = {}) {
  const familyCounts = {}
  for (const key of [
    "python_imports",
    "python_declarations",
    "replacements",
    "creations",
  ]) {
    familyCounts[key] = array(request?.[key]).length
  }
  const payload = {
    protocol: FAILED_CANDIDATE_PROTOCOL,
    request_sha256:
      request && typeof request === "object" && !Array.isArray(request)
        ? stableSha(request)
        : null,
    family_counts: Object.freeze(familyCounts),
    operations_by_slot: Object.freeze(
      array(slotUsage?.operations_by_slot).map(
        (row) => Object.freeze({
          slot: row?.slot ?? null,
          operation_mask: row?.operation_mask ?? "0x0",
          operations: Object.freeze(
            [...array(row?.operations)].sort(),
          ),
        }),
      ),
    ),
    mutation_authority: false,
  }
  return Object.freeze({
    ...payload,
    candidate_sha256: stableSha(payload),
  })
}

export function classifyRepairProgress({
  previousFailure = null,
  currentFailure = null,
} = {}) {
  const previous = repairMissingKeys(previousFailure)
  const current = repairMissingKeys(currentFailure)

  if (previous.length < 1) {
    return Object.freeze({
      protocol: REPAIR_CONVERGENCE_PROTOCOL,
      status: current.length > 0 ? "initial" : "untracked",
      allow_retry: true,
      strict_progress: false,
      previous_missing: Object.freeze(previous),
      current_missing: Object.freeze(current),
      removed: Object.freeze([]),
      added: Object.freeze(current),
      mutation_authority: false,
    })
  }

  const previousSet = new Set(previous)
  const currentSet = new Set(current)
  const removed = previous.filter((key) => !currentSet.has(key))
  const added = current.filter((key) => !previousSet.has(key))
  const subset = current.every((key) => previousSet.has(key))

  let status
  let allowRetry
  let strictProgress
  if (added.length > 0 || !subset) {
    status = "regression"
    allowRetry = false
    strictProgress = false
  } else if (current.length === previous.length) {
    status = "no_progress"
    allowRetry = false
    strictProgress = false
  } else if (current.length < previous.length) {
    status = "progress"
    allowRetry = true
    strictProgress = true
  } else {
    status = "untracked"
    allowRetry = false
    strictProgress = false
  }

  return Object.freeze({
    protocol: REPAIR_CONVERGENCE_PROTOCOL,
    status,
    allow_retry: allowRetry,
    strict_progress: strictProgress,
    previous_missing: Object.freeze(previous),
    current_missing: Object.freeze(current),
    removed: Object.freeze(removed),
    added: Object.freeze(added),
    mutation_authority: false,
  })
}
