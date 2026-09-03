import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  PHYSICAL_INFERENCE_LEASE_PROTOCOL,
  createPhysicalInferenceLeaseController,
  parseLlamaQuiescenceMetrics,
} from "../../opencode/plugins/cpu-search-core/physical-inference-lease-v1.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "../..")
const plugin = fs.readFileSync(
  path.join(repo, "opencode/plugins/cpu-search.ts"),
  "utf8",
)

const idle = [
  "# TYPE llamacpp:requests_processing gauge",
  "llamacpp:requests_processing 0",
  "# TYPE llamacpp:requests_deferred gauge",
  "llamacpp:requests_deferred 0",
  "",
].join("\n")
const busy = [
  "llamacpp:requests_processing 1",
  "llamacpp:requests_deferred 0",
  "",
].join("\n")

assert.equal(parseLlamaQuiescenceMetrics(idle).quiescent, true)
assert.equal(parseLlamaQuiescenceMetrics(busy).quiescent, false)
assert.equal(parseLlamaQuiescenceMetrics("garbage").ok, false)

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body
    },
  }
}

function harness(samples) {
  let timer = null
  let now = 0
  let interrupts = 0
  const events = []
  const queue = [...samples]
  const controller = createPhysicalInferenceLeaseController({
    hardLeaseMs: 1_000,
    preflightTimeoutMs: 100,
    quiescenceGraceMs: 100,
    quiescencePollMs: 10,
    requiredZeroSamples: 2,
    fetchImpl: async () => response(queue.shift() ?? idle),
    nowFn: () => {
      now += 10
      return now
    },
    sleepFn: async () => {},
    setTimerFn: (fn) => {
      timer = fn
      return { unref() {} }
    },
    clearTimerFn: () => {},
  })
  const interrupt = async () => {
    interrupts += 1
  }
  const arm = (modelCall = 1, isCurrent = () => true) =>
    controller.arm({
      sessionID: "session",
      turnID: "turn",
      modelCall,
      providerID: "local",
      modelID: "north-mini-code-local",
      interrupt,
      isCurrent,
      onEvent: async (event) => events.push(event),
    })
  return {
    controller,
    interrupt,
    arm,
    events,
    get timer() {
      return timer
    },
    get interrupts() {
      return interrupts
    },
  }
}

// Pre-dispatch authority is fail-closed, but admission is not a one-sample
// race. The controller acquires a bounded provider-quiescence window and
// requires two consecutive idle observations before dispatch.
{
  const h = harness([idle, idle])
  const preflight = await h.controller.preflight({ interrupt: h.interrupt })
  assert.equal(preflight.ok, true)
  assert.equal(preflight.processing, 0)
  assert.equal(preflight.deferred, 0)
  assert.equal(preflight.consecutive_zero_samples, 2)
  assert.equal(preflight.attempts, 2)
}
{
  const h = harness([busy, idle, idle])
  const preflight = await h.controller.preflight({ interrupt: h.interrupt })
  assert.equal(preflight.ok, true)
  assert.equal(preflight.consecutive_zero_samples, 2)
  assert.equal(preflight.attempts, 3)
}
{
  const h = harness([
    busy, busy, busy, busy, busy, busy, busy, busy,
    busy, busy, busy, busy, busy, busy, busy, busy,
  ])
  const preflight = await h.controller.preflight({ interrupt: h.interrupt })
  assert.equal(preflight.ok, false)
  assert.equal(
    preflight.reason,
    "physical_inference_provider_not_quiescent_before_dispatch",
  )
  assert.equal(preflight.attempts > 1, true)
}
{
  const h = harness([idle, idle])
  const preflight = await h.controller.preflight({ interrupt: null })
  assert.equal(preflight.ok, false)
  assert.equal(preflight.reason, "physical_inference_interrupt_unavailable")
}

// If the host bookkeeping is late but llama is already idle at the deadline,
// do not interrupt a tool phase. This prevents a stale timer from becoming a
// false cancellation authority.
{
  const h = harness([idle])
  assert.equal(h.arm().ok, true)
  await h.timer()
  assert.equal(h.interrupts, 0)
  assert.equal(h.controller.failure({ sessionID: "session", turnID: "turn" }), null)
  assert.equal(
    h.events.some(
      (event) => event.reason === "provider_idle_at_deadline_boundary",
    ),
    true,
  )
}

// Busy at the deadline => physical interrupt => two zero samples => terminal
// SAFE_FAIL evidence. The timed-out generation can never become a candidate.
{
  const h = harness([busy, idle, idle])
  assert.equal(h.arm().ok, true)
  await h.timer()
  assert.equal(h.interrupts, 1)
  const failure = h.controller.failure({ sessionID: "session", turnID: "turn" })
  assert.equal(failure.reason, "physical_inference_hard_lease_exceeded")
  assert.equal(failure.quiescence_proven, true)
  assert.equal(failure.mutation_authority, false)
  assert.equal(
    h.events.filter((event) => event.kind === "physical_inference_lease_terminal").length,
    1,
  )
}

// Interrupt without observable backend quiescence is not a successful bound.
{
  const h = harness([busy, busy, busy, busy, busy, busy, busy, busy, busy, busy])
  assert.equal(h.arm().ok, true)
  await h.timer()
  const failure = h.controller.failure({ sessionID: "session", turnID: "turn" })
  assert.equal(failure.reason, "physical_inference_quiescence_unproven")
  assert.equal(failure.quiescence_proven, false)
}

// A later dispatch is synchronous proof that the previous provider call
// returned through the host. Its stale timer must be retired, not inherited.
{
  const h = harness([idle])
  assert.equal(h.arm(1).ok, true)
  assert.equal(h.arm(2).ok, true)
  assert.equal(
    h.events.some((event) => event.reason === "next_dispatch_proves_prior_completion"),
    true,
  )
}

// Integration ordering: hard-lease failure is checked before consuming a new
// model-call budget; a real timer is armed before the model_dispatch trace.
const failureGate = plugin.indexOf("physicalInferenceLeaseController.failure({")
const modelIncrement = plugin.indexOf("state.modelCalls += 1", failureGate)
const armIndex = plugin.indexOf("physicalInferenceLeaseController.arm({", modelIncrement)
const dispatchIndex = plugin.indexOf('kind: "model_dispatch"', armIndex)
assert.ok(failureGate >= 0)
assert.ok(failureGate < modelIncrement)
assert.ok(modelIncrement < armIndex)
assert.ok(armIndex < dispatchIndex)
assert.match(plugin, /production_hard_lease_promoted:\s*true/u)
assert.match(plugin, /physical_inference_enforcement_authority:\s*"transport_interrupt_plus_backend_quiescence"/u)
assert.doesNotMatch(
  plugin.slice(failureGate, dispatchIndex),
  /mutation_authority:\s*true/u,
)

console.log(
  "PASS R7-R8 physical inference lease " +
  "preflight=bounded_quiescence_two_zero_samples hard_deadline=75000_default " +
  "deadline_busy=interrupt post_interrupt=two_zero_samples " +
  "late_host_event=idle_no_false_interrupt timeout_candidate=sealed " +
  "mutation_authority=false protocol=" + PHYSICAL_INFERENCE_LEASE_PROTOCOL,
)
