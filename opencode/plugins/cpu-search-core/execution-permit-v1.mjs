export const EXECUTION_PERMIT_PROTOCOL =
  "execution-permit-v1"

function frozen(value) {
  return Object.freeze(value)
}

function boundedText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512
  )
    ? value
    : null
}

function positiveGeneration(value) {
  return (
    Number.isSafeInteger(value) &&
    value > 0
  )
    ? value
    : null
}

function capsuleIdentity(value) {
  if (value == null) return null
  return (
    typeof value === "string" &&
    /^[a-f0-9]{64}$/u.test(value)
  )
    ? value
    : null
}

function fail(reason, details = {}) {
  /*
   * Caller-supplied diagnostics are untrusted with respect to control fields.
   * Put them first so no diagnostic payload can overwrite the fail-closed
   * authority tuple below (notably requestedIdentity().ok === true).
   */
  return frozen({
    ...details,
    ok: false,
    protocol: EXECUTION_PERMIT_PROTOCOL,
    reason,
    action_class: "mutation",
    max_claims: 1,
    mutation_authority: false,
  })
}

function requestedIdentity({
  turnID,
  dispatchGeneration,
  selectedTool,
  requestedTool,
  editCapsuleSha256,
}) {
  const turn = boundedText(turnID)
  const generation =
    positiveGeneration(dispatchGeneration)
  const selected = boundedText(selectedTool)
  const requested = boundedText(requestedTool)
  const capsule =
    capsuleIdentity(editCapsuleSha256)

  if (!turn) {
    return fail(
      "mutation_execution_permit_turn_unavailable",
    )
  }

  if (generation == null) {
    return fail(
      "mutation_execution_permit_dispatch_unavailable",
      { turn_id: turn },
    )
  }

  if (!selected || !requested) {
    return fail(
      "mutation_execution_permit_tool_unavailable",
      {
        turn_id: turn,
        dispatch_generation: generation,
      },
    )
  }

  if (
    editCapsuleSha256 != null &&
    capsule == null
  ) {
    return fail(
      "mutation_execution_permit_capsule_invalid",
      {
        turn_id: turn,
        dispatch_generation: generation,
        selected_tool: selected,
        requested_tool: requested,
      },
    )
  }

  return frozen({
    ok: true,
    turn_id: turn,
    dispatch_generation: generation,
    selected_tool: selected,
    requested_tool: requested,
    edit_capsule_sha256: capsule,
  })
}

/*
 * At-most-once mutation execution for one deterministic model dispatch.
 *
 * MUST be called synchronously before the handler's first await. JavaScript
 * run-to-completion makes the local state transition atomic for concurrent
 * tool handlers without locks, timers, message ids, or model-visible tokens.
 *
 * A failed candidate remains SPENT. Real repair requires a new model dispatch
 * generation.
 */
export function claimMutationExecutionPermit(
  state,
  options = {},
) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return fail(
      "mutation_execution_permit_state_unavailable",
    )
  }

  const wanted = requestedIdentity(options)
  if (wanted.ok !== true) return wanted

  const existing =
    state.mutationExecutionPermit &&
    typeof state.mutationExecutionPermit === "object" &&
    !Array.isArray(state.mutationExecutionPermit)
      ? state.mutationExecutionPermit
      : null

  // Same turn + generation has already consumed its one mutation capability.
  // Do this before frontier/tool comparison so post-failure FSM transitions
  // cannot accidentally turn a duplicate into a fresh attempt.
  if (
    existing?.turn_id === wanted.turn_id &&
    existing?.dispatch_generation ===
      wanted.dispatch_generation
  ) {
    const sameIdentity =
      existing.requested_tool ===
        wanted.requested_tool &&
      existing.edit_capsule_sha256 ===
        wanted.edit_capsule_sha256

    return fail(
      sameIdentity
        ? "mutation_execution_permit_consumed"
        : "mutation_execution_permit_identity_drift",
      {
        ...wanted,
        claimed_tool:
          existing.requested_tool ?? null,
        claimed_edit_capsule_sha256:
          existing.edit_capsule_sha256 ?? null,
        claims: 1,
      },
    )
  }

  if (
    existing?.turn_id === wanted.turn_id &&
    Number.isSafeInteger(
      existing?.dispatch_generation,
    ) &&
    existing.dispatch_generation >
      wanted.dispatch_generation
  ) {
    return fail(
      "mutation_execution_permit_stale_dispatch",
      {
        ...wanted,
        claimed_dispatch_generation:
          existing.dispatch_generation,
      },
    )
  }

  if (
    wanted.selected_tool !==
    wanted.requested_tool
  ) {
    return fail(
      "mutation_execution_permit_tool_mismatch",
      wanted,
    )
  }

  const permit = frozen({
    ok: true,
    protocol: EXECUTION_PERMIT_PROTOCOL,
    reason:
      "mutation_execution_permit_claimed",
    action_class: "mutation",
    state: "spent",
    ...wanted,
    claims: 1,
    max_claims: 1,
    mutation_authority: false,
  })

  // Deliberately synchronous. No await before this state transition.
  state.mutationExecutionPermit = permit
  return permit
}

/*
 * Additive semantic content claims before materialization. The common
 * executor core validates the already-consumed capability instead of claiming
 * a second time.
 */
export function validateClaimedMutationExecutionPermit(
  state,
  options = {},
) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return fail(
      "mutation_execution_permit_state_unavailable",
    )
  }

  const wanted = requestedIdentity(options)
  if (wanted.ok !== true) return wanted

  const existing =
    state.mutationExecutionPermit &&
    typeof state.mutationExecutionPermit === "object" &&
    !Array.isArray(state.mutationExecutionPermit)
      ? state.mutationExecutionPermit
      : null

  if (!existing) {
    return fail(
      "mutation_execution_permit_preclaim_missing",
      wanted,
    )
  }

  if (
    existing.state !== "spent" ||
    existing.claims !== 1 ||
    existing.turn_id !== wanted.turn_id ||
    existing.dispatch_generation !==
      wanted.dispatch_generation ||
    existing.selected_tool !==
      wanted.selected_tool ||
    existing.requested_tool !==
      wanted.requested_tool ||
    existing.edit_capsule_sha256 !==
      wanted.edit_capsule_sha256
  ) {
    return fail(
      "mutation_execution_permit_preclaim_mismatch",
      {
        ...wanted,
        claimed_turn_id:
          existing.turn_id ?? null,
        claimed_dispatch_generation:
          existing.dispatch_generation ?? null,
        claimed_selected_tool:
          existing.selected_tool ?? null,
        claimed_requested_tool:
          existing.requested_tool ?? null,
        claimed_edit_capsule_sha256:
          existing.edit_capsule_sha256 ?? null,
      },
    )
  }

  return existing
}
