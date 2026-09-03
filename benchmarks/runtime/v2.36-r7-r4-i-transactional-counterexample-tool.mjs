import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL,
  prepareCounterexampleToolResult,
} from "../../opencode/plugins/cpu-search-core/typed-counterexample-v1.mjs"

const protocol = "typed-counterexample-v1"

const good = prepareCounterexampleToolResult({
  protocol,
  content:
    "PATCH_RETRY reason=x source_key=server_surface action=revise_failed_source_slot",
  metadata: {
    protocol,
    action: "retry",
    reason: "x",
    source_key: "server_surface",
    source_counterexample_failures: 2,
    source_repair_dispatches: 2,
    mutation_authority: false,
  },
})
assert.equal(good.ok, true, JSON.stringify(good, null, 2))
assert.equal(good.protocol, COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL)
assert.equal(good.result.metadata.protocol, protocol)
assert.equal(good.result.metadata.source_repair_dispatches, 2)
assert.equal(Object.isFrozen(good.result), true)
assert.equal(Object.isFrozen(good.result.metadata), true)

const badProtocol = prepareCounterexampleToolResult({
  protocol,
  content: "PATCH_RETRY reason=x",
  metadata: { protocol: "wrong" },
})
assert.equal(badProtocol.ok, false)
assert.equal(
  badProtocol.reason,
  "counterexample_tool_result_contract_invalid",
)

const circular = {}
circular.self = circular
const badCircular = prepareCounterexampleToolResult({
  protocol,
  content: "PATCH_RETRY reason=x",
  metadata: { protocol, circular },
})
assert.equal(badCircular.ok, false)
assert.equal(
  badCircular.reason,
  "counterexample_tool_result_not_serializable",
)

const badBigInt = prepareCounterexampleToolResult({
  protocol,
  content: "PATCH_RETRY reason=x",
  metadata: { protocol, value: 1n },
})
assert.equal(badBigInt.ok, false)
assert.equal(
  badBigInt.reason,
  "counterexample_tool_result_not_serializable",
)

const state = {
  executionState: "repair",
  executionReason: "before",
  sourceCounterexampleFailures: 1,
  sourceCounterexampleLedger: ["before"],
  sourceRepairDispatches: 1,
  repairAttempts: 0,
}
const before = JSON.stringify(state)
prepareCounterexampleToolResult({
  protocol,
  content: "PATCH_RETRY reason=x",
  metadata: { protocol, value: 1n },
})
assert.equal(JSON.stringify(state), before)

const fragment00 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/00.part.ts",
    import.meta.url,
  ),
  "utf8",
)
const fragment09 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)

assert.match(fragment00, /prepareCounterexampleToolResult/u)
assert.doesNotMatch(
  fragment09,
  /\bTYPED_COUNTEREXAMPLE_PROTOCOL\b/u,
  "runtime fragment must not depend on unimported typed protocol constant",
)

function span(startMarker, endMarker) {
  const start = fragment09.indexOf(startMarker)
  const end = fragment09.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `${startMarker} span unavailable`)
  return fragment09.slice(start, end)
}

const sourceSpan = span(
  "if (sourceSlotRehydration.ok !== true) {",
  "const semanticObligationValidation =",
)
const hSpan = span(
  "// R7-R4-H: an exact existing-route collision",
  "// R7-R4-G: a deterministic semantic binding counterexample",
)
const gSpan = span(
  "// R7-R4-G: a deterministic semantic binding counterexample",
  "const fileFamilyRepairable =",
)

for (const [label, block] of [
  ["F", sourceSpan],
  ["H", hSpan],
  ["G", gSpan],
]) {
  assert.match(block, /prepareCounterexampleToolResult/u, `${label}: wire preparation missing`)
  assert.match(block, /Transaction commit point/u, `${label}: explicit commit point missing`)
}

function stateMutationMarkers() {
  return [
    "state.sourceCounterexampleFailures =",
    "state.sourceCounterexampleLedger =",
    "state.sourceRepairDispatches =",
    "state.repairAttempts =",
    "state.activeMutationTool =",
    "state.sourceSlotRepairCache =",
    "state.additiveRepairLock =",
    "applyExecutionEvent(",
  ]
}

function assertNoStateMutation(label, block) {
  for (const mutation of stateMutationMarkers()) {
    assert.equal(
      block.includes(mutation),
      false,
      `${label}: state mutation leaked before prepared result: ${mutation}`,
    )
  }
}

function assertTwoPhaseRetry(label, block) {
  const firstPrepare =
    block.indexOf("prepareCounterexampleToolResult({")
  assert.ok(firstPrepare >= 0, `${label}: retry prepare unavailable`)

  const failureIf = block.indexOf(
    "if (preparedToolResult.ok !== true) {",
    firstPrepare,
  )
  assert.ok(
    failureIf > firstPrepare,
    `${label}: retry preparation failure branch unavailable`,
  )
  assertNoStateMutation(
    `${label} retry preparation`,
    block.slice(firstPrepare, failureIf),
  )

  const failurePrepare = block.indexOf(
    "const preparedFailureResult =",
    failureIf,
  )
  const terminalCommit = block.indexOf(
    "// Terminal transaction commit point",
    failurePrepare,
  )
  assert.ok(
    failurePrepare > failureIf &&
      terminalCommit > failurePrepare,
    `${label}: prepared STOP transaction unavailable`,
  )
  assertNoStateMutation(
    `${label} STOP preparation`,
    block.slice(failureIf, terminalCommit),
  )

  const retryCommit = block.indexOf(
    "// Transaction commit point",
    terminalCommit,
  )
  assert.ok(
    retryCommit > terminalCommit,
    `${label}: retry commit point unavailable`,
  )
}

assertTwoPhaseRetry("H", hSpan)
assertTwoPhaseRetry("G", gSpan)

const fTypedStart = sourceSpan.indexOf(
  "typedCounterexample?.ok === true",
)
const fTypedEnd = sourceSpan.indexOf(
  "const compositeCompatibilityRetry",
  fTypedStart,
)
assert.ok(fTypedStart >= 0 && fTypedEnd > fTypedStart)
const fTyped = sourceSpan.slice(
  sourceSpan.lastIndexOf("if (", fTypedStart),
  fTypedEnd,
)
assertTwoPhaseRetry("F", fTyped)

for (const block of [hSpan, gSpan]) {
  assert.match(block, /Counterexample\.protocol/u)
  assert.doesNotMatch(block, /protocol:\s*TYPED_COUNTEREXAMPLE_PROTOCOL/u)
}

console.log(
  "PASS R7-R4-I transactional counterexample tool commit " +
    "wire_result=prepared_before_state " +
    "protocol=counterexample_owned " +
    "serialization_failure=pure_no_state_change " +
    "F_G_H=transactional_typed_ce " +
    "composite_compatibility=unchanged " +
    "mutation_authority=false",
)
