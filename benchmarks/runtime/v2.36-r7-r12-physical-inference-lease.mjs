import assert from "node:assert/strict"
import {
  createPhysicalInferenceLeaseController,
  proveProviderQuiescence,
} from "../../opencode/plugins/cpu-search-core/physical-inference-lease-v1.mjs"

let preflightFetchCalls = 0
const preflightController = createPhysicalInferenceLeaseController({
  fetchImpl: async () => {
    preflightFetchCalls += 1
    throw new Error("pre-dispatch metrics must not be consulted")
  },
})

const preflight = await preflightController.preflight({
  interrupt: async () => {},
})

assert.equal(preflight.ok, true)
assert.equal(preflight.reason, "physical_inference_preflight_ready")
assert.equal(preflight.predispatch_authority, "owned_lease_state_only")
assert.equal(preflight.quiescence_required_before_dispatch, false)
assert.equal(preflight.quiescence_role, "post_interrupt_confirmation_only")
assert.equal(preflightFetchCalls, 0)

const noInterrupt = await preflightController.preflight({})
assert.equal(noInterrupt.ok, false)
assert.equal(noInterrupt.reason, "physical_inference_interrupt_unavailable")

let scheduledMs = null
let scheduledCallback = null
const leaseController = createPhysicalInferenceLeaseController({
  hardLeaseMs: 1_234,
  setTimerFn: (callback, ms) => {
    scheduledCallback = callback
    scheduledMs = ms
    return { unref() {} }
  },
  clearTimerFn: () => {},
})

const armed = leaseController.arm({
  sessionID: "session",
  turnID: "turn",
  modelCall: 1,
  interrupt: async () => {},
})
assert.equal(armed.ok, true)
assert.equal(armed.reason, "physical_inference_hard_lease_armed")
assert.equal(scheduledMs, 1_234)
assert.equal(typeof scheduledCallback, "function")

const completed = leaseController.complete({
  sessionID: "session",
  turnID: "turn",
  modelCall: 1,
})
assert.equal(completed.completed, true)

let proofFetchCalls = 0
const proof = await proveProviderQuiescence({
  fetchImpl: async () => {
    proofFetchCalls += 1
    return {
      ok: true,
      status: 200,
      text: async () => [
        "llamacpp:requests_processing 0",
        "llamacpp:requests_deferred 0",
      ].join("\n"),
    }
  },
  requiredZeroSamples: 2,
  sleepFn: async () => {},
})
assert.equal(proof.ok, true)
assert.equal(proof.proven, true)
assert.equal(proof.reason, "provider_quiescence_proven")
assert.equal(proofFetchCalls, 2)

console.log("PASS R7-R12 physical inference lease boundary")
