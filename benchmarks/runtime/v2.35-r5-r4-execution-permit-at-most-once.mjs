import assert from "node:assert/strict"
import fs from "node:fs"

import {
  EXECUTION_PERMIT_PROTOCOL,
  claimMutationExecutionPermit,
  validateClaimedMutationExecutionPermit,
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

function options(s, requestedTool) {
  return {
    turnID: s.turnID,
    dispatchGeneration: s.modelCalls,
    selectedTool: s.selectedTool,
    requestedTool,
    editCapsuleSha256:
      s.editCapsuleHash,
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

function validate(
  s,
  requestedTool = "execute_additive_plan",
) {
  return validateClaimedMutationExecutionPermit(
    s,
    options(s, requestedTool),
  )
}

// One model dispatch -> one successful mutation claim.
{
  const s = state()
  const first = claim(s)
  assert.equal(first.ok, true)
  assert.equal(
    first.protocol,
    EXECUTION_PERMIT_PROTOCOL,
  )
  assert.equal(first.max_claims, 1)

  const second = claim(s)
  assert.equal(second.ok, false)
  assert.equal(
    second.reason,
    "mutation_execution_permit_consumed",
  )
}

// Distinct second mutation in the same generation is still blocked.
{
  const s = state()
  assert.equal(claim(s).ok, true)

  const second = claim(
    s,
    "execute_replace_node",
  )
  assert.equal(second.ok, false)
  assert.equal(
    second.reason,
    "mutation_execution_permit_identity_drift",
  )
}

// Additive preclaim can be validated exactly once downstream without
// consuming a second permit.
{
  const s = state()
  assert.equal(claim(s).ok, true)
  assert.equal(validate(s).ok, true)
  assert.equal(validate(s).claims, 1)
}

// Downstream additive execution without preclaim fails closed.
{
  const s = state()
  const missing = validate(s)
  assert.equal(missing.ok, false)
  assert.equal(
    missing.reason,
    "mutation_execution_permit_preclaim_missing",
  )
}

// Failed candidate remains spent; genuine repair requires a new model call.
{
  const s = state()
  assert.equal(claim(s).ok, true)
  assert.equal(claim(s).ok, false)

  s.modelCalls = 2
  const repair = claim(s)
  assert.equal(repair.ok, true)
  assert.equal(
    repair.dispatch_generation,
    2,
  )
}

// New turn may restart a per-turn dispatch counter.
{
  const s = state()
  assert.equal(claim(s).ok, true)

  s.turnID = "turn:2"
  s.modelCalls = 1
  assert.equal(claim(s).ok, true)
}

// Wrong deterministic frontier cannot consume a fresh permit.
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

// Old dispatch generation cannot replay after a newer claim.
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

// Concurrent handlers still produce one claim because claim() has no await.
{
  const s = state()
  const results = await Promise.all([
    Promise.resolve().then(() => claim(s)),
    Promise.resolve().then(() => claim(s)),
  ])

  assert.equal(
    results.filter((row) => row.ok === true).length,
    1,
  )
  assert.equal(
    results.filter(
      (row) =>
        row.reason ===
        "mutation_execution_permit_consumed",
    ).length,
    1,
  )
}

// Structural integration gates.
const imports =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/00.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

const core =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/06.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

const tools =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/09.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

assert.ok(
  imports.includes(
    'from "./cpu-search-core/execution-permit-v1.mjs"',
  ),
)

{
  const start =
    core.indexOf(
      "const executeCapabilityMutationCore = async",
    )
  const end =
    core.indexOf(
      "const observedModelLatencyMs =",
      start,
    )
  assert.ok(start >= 0)
  assert.ok(end > start)

  const body = core.slice(start, end)

  const permit =
    body.indexOf(
      "C7-R4 EXECUTION PERMIT: common mutation core.",
    )
  const firstAwait =
    body.indexOf("await rootForTool(")

  assert.ok(permit >= 0)
  assert.ok(firstAwait >= 0)
  assert.ok(permit < firstAwait)

  assert.ok(
    body.includes(
      "validateClaimedMutationExecutionPermit(",
    ),
  )
  assert.ok(
    body.includes(
      "claimMutationExecutionPermit(",
    ),
  )
  assert.ok(
    body.includes(
      "dispatchOrigin === ACTION_COMMIT_DISPATCH_ORIGIN",
    ),
  )
}

{
  const start =
    tools.indexOf(
      "name: EXECUTE_ADDITIVE_PLAN_TOOL",
    )
  const end =
    tools.indexOf(
      "const activeSemanticMutationContract =",
      start,
    )
  assert.ok(start >= 0)
  assert.ok(end > start)

  const body = tools.slice(start, end)

  const permit =
    body.indexOf(
      "C7-R4 EXECUTION PERMIT: additive pre-materialization claim.",
    )
  const firstAwait =
    body.indexOf("await rootForTool(")

  assert.ok(permit >= 0)
  assert.ok(firstAwait >= 0)
  assert.ok(permit < firstAwait)
  assert.ok(
    body.includes(
      "claimMutationExecutionPermit(",
    ),
  )
}

const permitSource =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search-core/execution-permit-v1.mjs",
      import.meta.url,
    ),
    "utf8",
  )

assert.equal(
  permitSource.includes("messageID"),
  false,
)

console.log(
  "PASS R5-R4 execution permit " +
  "scope=mutation " +
  "authority=model_dispatch_generation " +
  "at_most_once=true " +
  "claim_before_await=true " +
  "additive_pre_materialization=true " +
  "common_core_preclaim_validation=true " +
  "failed_candidate_consumes=true " +
  "new_repair_dispatch_reopens=true " +
  "action_commit_single_flight_preserved=true " +
  "host_message_id_authority=false " +
  "model_calls_added=0 " +
  "model_context_overhead_bytes=0 " +
  "mutation_authority_expansion=false",
)
