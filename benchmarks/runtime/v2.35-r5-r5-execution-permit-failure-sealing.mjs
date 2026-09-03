import assert from "node:assert/strict"

import {
  EXECUTION_PERMIT_PROTOCOL,
  claimMutationExecutionPermit,
} from "../../opencode/plugins/cpu-search-core/execution-permit-v1.mjs"

const CAPSULE = "a".repeat(64)

function state({
  turnID = "turn:1",
  modelCalls = 1,
  selectedTool = "execute_additive_plan",
} = {}) {
  return {
    turnID,
    modelCalls,
    selectedTool,
    editCapsuleHash: CAPSULE,
  }
}

function options(
  s,
  requestedTool = "execute_additive_plan",
) {
  return {
    turnID: s.turnID,
    dispatchGeneration: s.modelCalls,
    selectedTool: s.selectedTool,
    requestedTool,
    editCapsuleSha256: s.editCapsuleHash,
  }
}

function claim(
  s,
  requestedTool = "execute_additive_plan",
) {
  return claimMutationExecutionPermit(
    s,
    options(s, requestedTool),
  )
}

// Regression: requestedIdentity() contains ok=true. A duplicate claim must not
// let that diagnostic field overwrite fail().ok=false.
{
  const s = state()
  const first = claim(s)
  assert.equal(first.ok, true)

  const duplicate = claim(s)
  assert.equal(duplicate.ok, false)
  assert.equal(
    duplicate.protocol,
    EXECUTION_PERMIT_PROTOCOL,
  )
  assert.equal(
    duplicate.reason,
    "mutation_execution_permit_consumed",
  )
  assert.equal(
    duplicate.action_class,
    "mutation",
  )
  assert.equal(
    duplicate.max_claims,
    1,
  )
  assert.equal(
    duplicate.mutation_authority,
    false,
  )
}

// Identity drift is also fail-closed even though its diagnostics inherit
// wanted.ok=true.
{
  const s = state()
  assert.equal(claim(s).ok, true)

  const drift = claim(
    s,
    "execute_replace_node",
  )
  assert.equal(drift.ok, false)
  assert.equal(
    drift.reason,
    "mutation_execution_permit_identity_drift",
  )
  assert.equal(
    drift.mutation_authority,
    false,
  )
}

// Stale generations must remain fail-closed.
{
  const s = state({ modelCalls: 2 })
  assert.equal(claim(s).ok, true)

  s.modelCalls = 1
  const stale = claim(s)
  assert.equal(stale.ok, false)
  assert.equal(
    stale.reason,
    "mutation_execution_permit_stale_dispatch",
  )
}

// Wrong frontier must not mutate permit state.
{
  const s = state({
    selectedTool: "execute_replace_node",
  })
  const wrong = claim(
    s,
    "execute_additive_plan",
  )
  assert.equal(wrong.ok, false)
  assert.equal(
    wrong.reason,
    "mutation_execution_permit_tool_mismatch",
  )
  assert.equal(
    s.mutationExecutionPermit,
    undefined,
  )
}

console.log(
  "PASS R5-R5 execution permit failure sealing " +
  "diagnostics_cannot_override_control=true " +
  "duplicate=fail_closed " +
  "identity_drift=fail_closed " +
  "stale_dispatch=fail_closed " +
  "tool_mismatch=fail_closed " +
  "mutation_authority_expansion=false",
)
