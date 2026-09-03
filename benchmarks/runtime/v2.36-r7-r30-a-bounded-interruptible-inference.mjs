import assert from "node:assert/strict"

import { deriveGovernorPhysicalLease } from "../../opencode/plugins/cpu-search-core/governor-physical-lease-v1.mjs"
import { createPhysicalInferenceLeaseController } from "../../opencode/plugins/cpu-search-core/physical-inference-lease-v1.mjs"

const cold = deriveGovernorPhysicalLease({
  inferenceLeaseMs: 120_000,
  inferenceLeaseSource: "bootstrap",
  taskRemainingMs: 350_000,
  phaseRemainingMs: 120_000,
  teardownReserveMs: 15_000,
})
assert.equal(cold.ok, true, JSON.stringify(cold))
assert.equal(cold.lease_ms, 111_666)
assert.equal(cold.hard_lease_le_phase_remaining, true)
assert.equal(cold.bootstrap_task_fraction, 3)

const calibrated = deriveGovernorPhysicalLease({
  inferenceLeaseMs: 180_000,
  inferenceLeaseSource: "adaptive_profile",
  taskRemainingMs: 350_000,
  phaseRemainingMs: 90_000,
  teardownReserveMs: 15_000,
})
assert.equal(calibrated.ok, true)
assert.equal(calibrated.lease_ms, 90_000)
assert.equal(calibrated.hard_lease_le_phase_remaining, true)

let now = 0
let hardCallback = null
let intervalCallback = null
let interruptCalls = 0
const events = []
let slotPoll = 0
let metricPoll = 0

const controller = createPhysicalInferenceLeaseController({
  hardLeaseMs: 120_000,
  slotsUrl: "http://127.0.0.1:8080/slots",
  metricsUrl: "http://127.0.0.1:8080/metrics",
  stallThresholdMs: 1_000,
  stallPollMs: 100,
  nowFn: () => now,
  setTimerFn: (cb) => { hardCallback = cb; return { unref() {} } },
  clearTimerFn: () => {},
  setIntervalFn: (cb) => { intervalCallback = cb; return { unref() {} } },
  clearIntervalFn: () => {},
  sleepFn: async () => {},
  fetchImpl: async (url) => {
    if (String(url).includes("/slots")) {
      slotPoll += 1
      return {
        ok: true,
        json: async () => [{
          id: 0,
          id_task: 77,
          n_ctx: 32768,
          is_processing: true,
          n_prompt_tokens: 100,
          n_prompt_tokens_processed: 100,
          n_prompt_tokens_cache: 0,
          params: { n_predict: 1024 },
          next_token: [{ has_next_token: true, n_remain: 1020, n_decoded: 4 }],
        }],
      }
    }
    metricPoll += 1
    const processing = metricPoll === 1 ? 1 : 0
    return {
      ok: true,
      text: async () => [
        `llamacpp:requests_processing ${processing}`,
        "llamacpp:requests_deferred 0",
      ].join("\n"),
    }
  },
})

const armed = controller.arm({
  sessionID: "s",
  turnID: "t",
  modelCall: 1,
  hardLeaseMs: 120_000,
  interrupt: async () => { interruptCalls += 1 },
  isCurrent: () => true,
  onEvent: async (event) => { events.push(event) },
})
assert.equal(armed.ok, true)
assert.equal(armed.stall_interrupt_armed, true)
assert.equal(typeof hardCallback, "function")
assert.equal(typeof intervalCallback, "function")

now = 100
const first = await controller.pollProgress({ sessionID: "s", turnID: "t" })
assert.equal(first.ok, true, JSON.stringify(first))
assert.equal(first.stall_authority, true)
assert.equal(first.exact_progress_observed, true)
assert.equal(interruptCalls, 0)

now = 1_201
const stalled = await controller.pollProgress({ sessionID: "s", turnID: "t" })
assert.equal(stalled.ok, false, JSON.stringify(stalled))
assert.equal(stalled.reason, "physical_inference_stall_threshold_reached")
assert.equal(stalled.interrupted, true)
assert.equal(interruptCalls, 1)

const failure = controller.failure({ sessionID: "s", turnID: "t" })
assert.equal(failure.reason, "physical_inference_stall_exceeded")
assert.equal(failure.quiescence_proven, true)
assert.equal(events.some((e) => e.kind === "physical_inference_stall_detected"), true)

// Ambiguous concurrent provider slots never acquire stall authority.
let ambiguousInterrupts = 0
const ambiguous = createPhysicalInferenceLeaseController({
  slotsUrl: "http://127.0.0.1:8080/slots",
  stallThresholdMs: 1_000,
  setTimerFn: () => ({ unref() {} }),
  clearTimerFn: () => {},
  setIntervalFn: () => ({ unref() {} }),
  clearIntervalFn: () => {},
  fetchImpl: async () => ({
    ok: true,
    json: async () => [
      { id: 0, id_task: 1, is_processing: true, n_prompt_tokens_processed: 5, next_token: [{ n_decoded: 1 }] },
      { id: 1, id_task: 2, is_processing: true, n_prompt_tokens_processed: 6, next_token: [{ n_decoded: 2 }] },
    ],
  }),
})
ambiguous.arm({
  sessionID: "s2", turnID: "t2", modelCall: 1,
  interrupt: async () => { ambiguousInterrupts += 1 },
})
const a = await ambiguous.pollProgress({ sessionID: "s2", turnID: "t2" })
assert.equal(a.ok, true)
assert.equal(a.stall_authority, false)
assert.equal(ambiguousInterrupts, 0)

console.log(
  "PASS R30-A bounded interruptible inference " +
  "hard_lease_le_phase=true bootstrap_fraction=3 " +
  "owned_progress=true ambiguous_progress_abstains=true " +
  "stall_interrupt=true quiescence_proven=true mutation_authority=false",
)
