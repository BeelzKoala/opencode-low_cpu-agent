import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  GOVERNOR_PHYSICAL_LEASE_PROTOCOL,
  deriveGovernorPhysicalLease,
} from "../../opencode/plugins/cpu-search-core/governor-physical-lease-v1.mjs"
import {
  createPhysicalInferenceLeaseController,
} from "../../opencode/plugins/cpu-search-core/physical-inference-lease-v1.mjs"

const cold = deriveGovernorPhysicalLease({
  inferenceLeaseMs: 120_000,
  inferenceLeaseSource: "bootstrap",
  taskRemainingMs: 350_000,
  phaseRemainingMs: 120_000,
  teardownReserveMs: 15_000,
})
assert.equal(cold.ok, true)
assert.equal(cold.protocol, GOVERNOR_PHYSICAL_LEASE_PROTOCOL)
assert.equal(cold.lease_ms, 111_666)
assert.equal(cold.source, "uncalibrated_phase_task_fraction")
assert.equal(cold.policy_authority, "governor")

const calibrated = deriveGovernorPhysicalLease({
  inferenceLeaseMs: 180_000,
  inferenceLeaseSource: "adaptive_profile",
  taskRemainingMs: 350_000,
  phaseRemainingMs: 120_000,
  teardownReserveMs: 15_000,
})
assert.equal(calibrated.ok, true)
assert.equal(calibrated.lease_ms, 120_000)

const taskCapped = deriveGovernorPhysicalLease({
  inferenceLeaseMs: 500_000,
  inferenceLeaseSource: "adaptive_profile",
  taskRemainingMs: 210_000,
  phaseRemainingMs: 120_000,
  teardownReserveMs: 10_000,
})
assert.equal(taskCapped.ok, true)
assert.equal(taskCapped.lease_ms, 120_000)

const exhausted = deriveGovernorPhysicalLease({
  inferenceLeaseMs: 120_000,
  inferenceLeaseSource: "bootstrap",
  taskRemainingMs: 500,
})
assert.equal(exhausted.ok, false)

let scheduledMs = null
const controller = createPhysicalInferenceLeaseController({
  hardLeaseMs: 75_000,
  setTimerFn: (_callback, ms) => {
    scheduledMs = ms
    return { unref() {} }
  },
  clearTimerFn: () => {},
})

const armed = controller.arm({
  sessionID: "session",
  turnID: "turn",
  modelCall: 1,
  hardLeaseMs: cold.lease_ms,
  interrupt: async () => {},
})
assert.equal(armed.ok, true)
assert.equal(scheduledMs, 111_666)
assert.equal(armed.hard_lease_ms, 111_666)
assert.equal(armed.default_hard_lease_ms, 75_000)

const completed = controller.complete({
  sessionID: "session",
  turnID: "turn",
  modelCall: 1,
})
assert.equal(completed.completed, true)
assert.equal(completed.hard_lease_ms, 111_666)

const part = await readFile(
  new URL("../../opencode/plugins/cpu-search.fragments/09.part.ts", import.meta.url),
  "utf8",
)
assert.match(part, /deriveGovernorPhysicalLease\(\{/ )
assert.match(part, /phaseRemainingMs:\s*governorAdmission\.phase_remaining_ms/)
assert.match(part, /hardLeaseMs:\s*physicalLeaseBudget\.lease_ms/)
assert.match(part, /physical_inference_policy_authority:\s*"governor"/)

console.log(
  "PASS R7-R13 Governor owns policy; physical lease only enforces bounded call lease",
)
