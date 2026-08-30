import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  PROOF_STATE,
  createCancellationCapabilities,
  createCancellationProof,
  createExecutionLease,
  remainingLeaseMs,
  verifyHardLeaseEligibility,
} from "./execution-lease-v1.mjs"
import {
  runSyntheticHttpCancellationProbe,
} from "./synthetic-http-cancellation-probe-v1.mjs"

{
  const lease = createExecutionLease({
    lease_id: "unit",
    remaining_task_budget_ms: 360_000,
    tail_reserve: {
      compiler_ms: 1_000,
      executor_ms: 2_000,
      verifier_ms: 3_000,
      focused_tests_ms: 4_000,
      rollback_ms: 5_000,
      terminalization_ms: 6_000,
    },
    now_monotonic_ms: 10_000,
    clock: "test_clock",
  })
  assert.equal(lease.ok, true)
  assert.equal(lease.lease.tail_reserve.total_ms, 21_000)
  assert.equal(lease.lease.dispatch_lease_ms, 339_000)
  assert.equal(lease.lease.deadline_monotonic_ms, 349_000)
  assert.equal(remainingLeaseMs(lease.lease, 348_500), 500)
  assert.equal(remainingLeaseMs(lease.lease, 350_000), 0)
  assert.equal(lease.lease.scheduling_authority, false)
}

{
  const overflow = createExecutionLease({
    lease_id: "overflow",
    remaining_task_budget_ms: Number.MAX_SAFE_INTEGER,
    tail_reserve: {},
    now_monotonic_ms: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(overflow.ok, false)
  assert.equal(overflow.reason, "lease_deadline_overflow")
}

{
  // A transport-only proof cannot become hard-lease eligible.
  const caps = createCancellationCapabilities({
    adapter_id: "partial",
    request_cancellation: true,
    transport_close_observable: true,
    provider_cancel_observable: false,
    compute_stop_observable: false,
  })
  const proof = createCancellationProof({
    lease_id: "l1",
    adapter_id: "partial",
    lease_expired: true,
    cancel_requested: PROOF_STATE.PROVEN,
    transport_closed: PROOF_STATE.PROVEN,
    provider_cancel_observed: PROOF_STATE.UNPROVEN,
    compute_quiesced: PROOF_STATE.UNPROVEN,
  })
  assert.equal(
    verifyHardLeaseEligibility(caps.capabilities, proof.proof).eligible,
    false,
  )
}

{
  // Even a fully declared adapter is ineligible when compute stop is unproven.
  const caps = createCancellationCapabilities({
    adapter_id: "declared",
    request_cancellation: true,
    transport_close_observable: true,
    provider_cancel_observable: true,
    compute_stop_observable: true,
  })
  const proof = createCancellationProof({
    lease_id: "l2",
    adapter_id: "declared",
    lease_expired: true,
    cancel_requested: PROOF_STATE.PROVEN,
    transport_closed: PROOF_STATE.PROVEN,
    provider_cancel_observed: PROOF_STATE.PROVEN,
    compute_quiesced: PROOF_STATE.UNPROVEN,
  })
  assert.equal(
    verifyHardLeaseEligibility(caps.capabilities, proof.proof).eligible,
    false,
  )
}

{
  const synthetic = await runSyntheticHttpCancellationProbe()
  assert.equal(synthetic.runtime_authority, false)
  assert.equal(synthetic.production_backend_proven, false)
  assert.equal(synthetic.proof.cancel_requested, PROOF_STATE.PROVEN)
  assert.equal(synthetic.proof.transport_closed, PROOF_STATE.PROVEN)
  assert.equal(
    synthetic.proof.provider_cancel_observed,
    PROOF_STATE.PROVEN,
  )
  assert.equal(synthetic.proof.compute_quiesced, PROOF_STATE.PROVEN)
  assert.equal(synthetic.proof.post_expiry_action_observed, false)
  assert.equal(synthetic.proof.hard_lease_eligible, true)
  assert.equal(synthetic.eligibility.eligible, true)
}

{
  // R3C-A is substrate/probe only.
  const plugin = await readFile(
    path.resolve("opencode/plugins/cpu-search.ts"),
    "utf8",
  )
  const governor = await readFile(
    path.resolve("opencode/plugins/cpu-search-core/governor-latency-v1.mjs"),
    "utf8",
  )
  assert.doesNotMatch(plugin, /execution-lease-v1/u)
  assert.doesNotMatch(governor, /execution-lease-v1/u)
  assert.doesNotMatch(plugin, /synthetic-http-cancellation-probe-v1/u)
  assert.doesNotMatch(governor, /synthetic-http-cancellation-probe-v1/u)
}

console.log(
  "PASS E2.5/R3C-A execution lease contract keeps structured tail reserves, requires observable compute quiescence for hard-lease eligibility, and proves Node HTTP cancellation only on a synthetic backend without production authority",
)
