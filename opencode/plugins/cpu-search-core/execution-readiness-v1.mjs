export const EXECUTION_READINESS_PROTOCOL = "execution-readiness-v1"
export const EXECUTION_READINESS_AUTHORITY = "control_flow_only"

export const EXECUTION_READINESS_STATUS = Object.freeze({
  NEEDS_EVIDENCE: "needs_evidence",
  READY_TO_MUTATE: "ready_to_mutate",
  SAFE_FAIL: "safe_fail",
})

export const EXECUTION_READINESS_EVENT = Object.freeze({
  NEEDS_EVIDENCE: "scout_needs_evidence",
  READY_TO_MUTATE: "scout_ready",
  SAFE_FAIL: "readiness_safe_fail",
})

export const EXECUTION_MUTATION_SHAPE = Object.freeze({
  RENAME_SYMBOL: "rename_symbol",
  REPLACE_EXISTING_NODE: "replace_existing_node",
  ADDITIVE_SURFACE: "additive_surface",
  UNRESOLVED: "unresolved",
})

function array(value) {
  return Array.isArray(value) ? value : []
}

function string(value) {
  return typeof value === "string" && value.length > 0 ? value : null
}

function includesAny(values, expected) {
  const set = new Set(array(values))
  return expected.some((value) => set.has(value))
}

function requiredMutationShape({ taskShape, taskAction, mutationIntent }) {
  if (
    taskAction?.status === "exact" &&
    taskAction?.operation === "rename_symbol"
  ) {
    return EXECUTION_MUTATION_SHAPE.RENAME_SYMBOL
  }

  if (
    taskShape?.status === "compiled" &&
    taskShape?.shape === "additive"
  ) {
    return EXECUTION_MUTATION_SHAPE.ADDITIVE_SURFACE
  }

  if (mutationIntent === "generic_edit") {
    return EXECUTION_MUTATION_SHAPE.REPLACE_EXISTING_NODE
  }

  return EXECUTION_MUTATION_SHAPE.UNRESOLVED
}

function evidenceState({ evidenceClosure, scoutHandoff, editCapsule }) {
  const closureStatus = string(evidenceClosure?.status) ?? "not_observed"
  const closureApplicable = closureStatus !== "not_applicable" && closureStatus !== "not_observed"
  const closureAuthorized = evidenceClosure?.localization_authority === true
  const handoffStatus = string(scoutHandoff?.status) ?? "unavailable"
  const capsuleReady = editCapsule?.mutationReady === true

  if (closureApplicable) {
    return {
      applicable: true,
      sufficient: closureAuthorized,
      status: closureStatus,
      handoff_status: handoffStatus,
    }
  }

  // Legacy/non-additive paths do not have the additive evidence-closure
  // contract. A mutation-ready capsule remains the strongest existing proof
  // that localization reached the execution boundary.
  return {
    applicable: false,
    sufficient: capsuleReady || handoffStatus === "ready",
    status: closureStatus,
    handoff_status: handoffStatus,
  }
}

function availableMutationOperations({
  localMutationCapability,
  localMutationCandidates,
  renameMutationCapability,
  additiveMutationCapability,
}) {
  const operations = []

  if (
    localMutationCapability?.ok === true &&
    localMutationCapability?.replaceNodeReady === true &&
    array(localMutationCandidates).length > 0
  ) {
    operations.push("replace_node")
  }

  if (
    renameMutationCapability?.ok === true &&
    renameMutationCapability?.ready === true &&
    renameMutationCapability?.globalReady === true &&
    renameMutationCapability?.operation === "rename_symbol"
  ) {
    operations.push("rename_symbol")
  }

  if (
    additiveMutationCapability?.ready === true &&
    additiveMutationCapability?.mutation_authority === true &&
    additiveMutationCapability?.operation === "additive_surface"
  ) {
    operations.push("additive_surface")
  }

  return operations.sort()
}

function decision({
  status,
  reason,
  failureKind = null,
  requiredShape,
  evidence,
  editCapsule,
  availableOperations,
  selectedOperation = null,
  noProgressBlocked,
}) {
  const event =
    status === EXECUTION_READINESS_STATUS.READY_TO_MUTATE
      ? EXECUTION_READINESS_EVENT.READY_TO_MUTATE
      : status === EXECUTION_READINESS_STATUS.SAFE_FAIL
        ? EXECUTION_READINESS_EVENT.SAFE_FAIL
        : EXECUTION_READINESS_EVENT.NEEDS_EVIDENCE

  return Object.freeze({
    protocol: EXECUTION_READINESS_PROTOCOL,
    authority: EXECUTION_READINESS_AUTHORITY,
    status,
    reason,
    failure_kind: failureKind,
    execution_event: event,
    terminal: status === EXECUTION_READINESS_STATUS.SAFE_FAIL,
    required_mutation_shape: requiredShape,
    available_mutation_operations: Object.freeze([...availableOperations]),
    selected_mutation_operation: selectedOperation,
    evidence: Object.freeze({ ...evidence }),
    edit_capsule_ready: editCapsule?.mutationReady === true,
    edit_capsule_blockers: Object.freeze(array(editCapsule?.readinessBlockers)),
    no_progress_blocked: noProgressBlocked === true,

    // This reducer is control-plane authority only. Mutation tools must still
    // validate their existing capability/attestation contracts independently.
    mutation_authority: false,
  })
}

export function initialExecutionReadiness(reason = "turn_start") {
  return decision({
    status: EXECUTION_READINESS_STATUS.NEEDS_EVIDENCE,
    reason,
    requiredShape: EXECUTION_MUTATION_SHAPE.UNRESOLVED,
    evidence: {
      applicable: false,
      sufficient: false,
      status: "unobserved",
      handoff_status: "unavailable",
    },
    editCapsule: null,
    availableOperations: [],
    noProgressBlocked: false,
  })
}

export function resolveExecutionReadiness({
  taskShape = null,
  taskAction = null,
  mutationIntent = "unknown",
  scoutHandoff = null,
  evidenceClosure = null,
  editCapsule = null,
  localCompetitorCheck = null,
  localMutationCapability = null,
  localMutationCandidates = [],
  renameMutationCapability = null,
  additiveMutationCapability = null,
  noProgressBlocked = false,
} = {}) {
  const requiredShape = requiredMutationShape({
    taskShape,
    taskAction,
    mutationIntent,
  })
  const evidence = evidenceState({
    evidenceClosure,
    scoutHandoff,
    editCapsule,
  })
  const availableOperations = availableMutationOperations({
    localMutationCapability,
    localMutationCandidates,
    renameMutationCapability,
    additiveMutationCapability,
  })

  const replaceReady = availableOperations.includes("replace_node")
  const renameReady = availableOperations.includes("rename_symbol")
  const additiveReady = availableOperations.includes("additive_surface")

  let selectedOperation = null

  // Canonical operation selection belongs here, not in the downstream FSM.
  // Prefer a task-complete additive capability when it exists, but preserve
  // the already-proven bounded replace/rename paths as compatibility fallbacks.
  if (
    evidence.sufficient &&
    requiredShape === EXECUTION_MUTATION_SHAPE.ADDITIVE_SURFACE &&
    additiveReady
  ) {
    selectedOperation = "additive_surface"
  } else if (
    evidence.sufficient &&
    editCapsule?.mutationReady === true &&
    requiredShape === EXECUTION_MUTATION_SHAPE.RENAME_SYMBOL &&
    renameReady
  ) {
    selectedOperation = "rename_symbol"
  } else if (
    evidence.sufficient &&
    editCapsule?.mutationReady === true &&
    replaceReady
  ) {
    selectedOperation = "replace_node"
  }

  if (selectedOperation) {
    return decision({
      status: EXECUTION_READINESS_STATUS.READY_TO_MUTATE,
      reason:
        selectedOperation === "additive_surface"
          ? "additive_capability_ready"
          : selectedOperation === "rename_symbol"
            ? "rename_capability_ready"
            : "replace_capability_ready",
      requiredShape,
      evidence,
      editCapsule,
      availableOperations,
      selectedOperation,
      noProgressBlocked,
    })
  }

  // Exact structural ambiguity is not repaired by paying for the same Scout
  // frontier again. The safe response is to stop rather than turn a routing
  // hypothesis into mutation authority.
  if (
    localCompetitorCheck?.ok === false &&
    localCompetitorCheck?.reason === "competing_structural_owner"
  ) {
    return decision({
      status: EXECUTION_READINESS_STATUS.SAFE_FAIL,
      reason: "mutation_target_ambiguous",
      failureKind: "mutation_target_ambiguity",
      requiredShape,
      evidence,
      editCapsule,
      availableOperations,
      noProgressBlocked,
    })
  }

  if (noProgressBlocked) {
    return decision({
      status: EXECUTION_READINESS_STATUS.SAFE_FAIL,
      reason: "scout_evidence_exhausted",
      failureKind: "scout_exhausted",
      requiredShape,
      evidence,
      editCapsule,
      availableOperations,
      noProgressBlocked,
    })
  }

  if (!evidence.sufficient) {
    return decision({
      status: EXECUTION_READINESS_STATUS.NEEDS_EVIDENCE,
      reason: `evidence_${evidence.status}`,
      requiredShape,
      evidence,
      editCapsule,
      availableOperations,
      noProgressBlocked,
    })
  }

  const blockers = array(editCapsule?.readinessBlockers)
  const mutationSurfaceUnavailable = includesAny(blockers, [
    "mutation_scope_unavailable",
    "mutation_candidate_set_unavailable",
  ])

  // Explicit additive surfaces are a planning fact, not mutation authority.
  // Once their localization obligations are source-covered, repeatedly
  // scouting cannot manufacture an executor capability. Fail safely until a
  // future executor registers a first-class additive operation.
  if (
    requiredShape === EXECUTION_MUTATION_SHAPE.ADDITIVE_SURFACE &&
    !additiveReady &&
    mutationSurfaceUnavailable
  ) {
    return decision({
      status: EXECUTION_READINESS_STATUS.SAFE_FAIL,
      reason: "mutation_capability_unavailable",
      failureKind: "mutation_capability",
      requiredShape,
      evidence,
      editCapsule,
      availableOperations,
      noProgressBlocked,
    })
  }

  // A complete handoff with sufficient source evidence but no executable
  // candidate has crossed the Scout boundary. Re-running lexical search is no
  // longer a justified transition; preserve safe failure instead.
  if (
    scoutHandoff?.status === "ready" &&
    editCapsule?.mutationReady !== true &&
    mutationSurfaceUnavailable
  ) {
    return decision({
      status: EXECUTION_READINESS_STATUS.SAFE_FAIL,
      reason: "mutation_capability_unavailable",
      failureKind: "mutation_capability",
      requiredShape,
      evidence,
      editCapsule,
      availableOperations,
      noProgressBlocked,
    })
  }

  return decision({
    status: EXECUTION_READINESS_STATUS.NEEDS_EVIDENCE,
    reason: "mutation_preconditions_incomplete",
    requiredShape,
    evidence,
    editCapsule,
    availableOperations,
    noProgressBlocked,
  })
}
