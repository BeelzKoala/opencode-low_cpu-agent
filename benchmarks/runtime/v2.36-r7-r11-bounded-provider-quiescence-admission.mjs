import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  createPhysicalInferenceLeaseController,
} from "../../opencode/plugins/cpu-search-core/physical-inference-lease-v1.mjs"

const idle = [
  "llamacpp:requests_processing 0",
  "llamacpp:requests_deferred 0",
  "",
].join("\n")

const busy = [
  "llamacpp:requests_processing 1",
  "llamacpp:requests_deferred 0",
  "",
].join("\n")

function response(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return body
    },
  }
}

function controllerFor(samples) {
  let now = 0
  const queue = [...samples]
  return createPhysicalInferenceLeaseController({
    hardLeaseMs: 1_000,
    preflightTimeoutMs: 100,
    quiescenceGraceMs: 100,
    quiescencePollMs: 10,
    requiredZeroSamples: 2,
    fetchImpl: async () =>
      response(queue.shift() ?? idle),
    nowFn: () => {
      now += 10
      return now
    },
    sleepFn: async () => {},
  })
}

const interrupt = async () => {}

{
  const controller =
    controllerFor([busy, idle, idle])
  const result =
    await controller.preflight({ interrupt })
  assert.equal(result.ok, true)
  assert.equal(
    result.reason,
    "physical_inference_preflight_proven",
  )
  assert.equal(result.attempts, 3)
  assert.equal(result.consecutive_zero_samples, 2)
}

{
  const controller =
    controllerFor([
      busy, busy, busy, busy, busy, busy,
      busy, busy, busy, busy, busy, busy,
      busy, busy, busy, busy,
    ])
  const result =
    await controller.preflight({ interrupt })
  assert.equal(result.ok, false)
  assert.equal(
    result.reason,
    "physical_inference_provider_not_quiescent_before_dispatch",
  )
  assert.equal(result.attempts > 1, true)
  assert.equal(
    result.detail,
    "provider_quiescence_not_reached",
  )
}

const core = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search-core/physical-inference-lease-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)

const preflightStart =
  core.indexOf("async function preflight")
const preflightEnd =
  core.indexOf(
    "\n  function failure(",
    preflightStart,
  )
assert(preflightStart >= 0)
assert(preflightEnd > preflightStart)

const preflight =
  core.slice(preflightStart, preflightEnd)

assert.match(
  preflight,
  /proveProviderQuiescence\(/u,
)
assert.match(
  preflight,
  /requiredZeroSamples:\s*config\.required_zero_samples/u,
)
assert.match(
  preflight,
  /graceMs:\s*config\.quiescence_grace_ms/u,
)
assert.doesNotMatch(
  preflight,
  /const sample = await sampleProviderQuiescence/u,
)

console.log(
  "PASS R7-R11 bounded provider quiescence admission " +
  "transient_busy=wait_then_dispatch " +
  "stable_idle=two_zero_samples " +
  "persistent_busy=bounded_safe_fail " +
  "single_snapshot_authority=removed " +
  "hard_lease=unchanged " +
  "mutation_authority=false",
)
