import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"

export const EXECUTION_LEASE_PROTOCOL = "execution-lease-v1"
export const CANCELLATION_CAPABILITY_PROTOCOL =
  "cancellation-capabilities-v1"
export const CANCELLATION_PROOF_PROTOCOL =
  "cancellation-proof-v1"

export const PROOF_STATE = Object.freeze({
  PROVEN: "PROVEN",
  UNPROVEN: "UNPROVEN",
  UNSUPPORTED: "UNSUPPORTED",
})

const RESERVE_FIELDS = Object.freeze([
  "compiler_ms",
  "executor_ms",
  "verifier_ms",
  "focused_tests_ms",
  "rollback_ms",
  "terminalization_ms",
])

function safeMs(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedString(value, max = 256) {
  if (typeof value !== "string") return null
  const text = value.trim()
  return text && text.length <= max ? text : null
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`,
    ).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex")
}

function safeAdd(total, value) {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(value)) return null
  const next = total + value
  return Number.isSafeInteger(next) ? next : null
}

export function normalizeExecutionTailReserve(raw = {}) {
  if (!raw || typeof raw !== "object") {
    return Object.freeze({ ok: false, reason: "tail_reserve_invalid" })
  }

  const normalized = {}
  let total = 0
  for (const field of RESERVE_FIELDS) {
    const value = raw[field] === undefined ? 0 : safeMs(raw[field])
    if (value === null) {
      return Object.freeze({
        ok: false,
        reason: "tail_reserve_component_invalid",
        field,
      })
    }
    total = safeAdd(total, value)
    if (total === null) {
      return Object.freeze({
        ok: false,
        reason: "tail_reserve_overflow",
      })
    }
    normalized[field] = value
  }

  return Object.freeze({
    ok: true,
    reason: "normalized",
    reserve: Object.freeze({
      ...normalized,
      total_ms: total,
    }),
  })
}

export function createExecutionLease({
  lease_id,
  remaining_task_budget_ms,
  tail_reserve = {},
  now_monotonic_ms = Math.floor(performance.now()),
  clock = "performance.now",
} = {}) {
  const leaseID = boundedString(lease_id, 128)
  const remaining = safeMs(remaining_task_budget_ms)
  const now = safeMs(now_monotonic_ms)
  const clockName = boundedString(clock, 64)

  if (!leaseID) {
    return Object.freeze({ ok: false, reason: "lease_id_invalid" })
  }
  if (remaining === null) {
    return Object.freeze({ ok: false, reason: "remaining_budget_invalid" })
  }
  if (now === null || !clockName) {
    return Object.freeze({ ok: false, reason: "monotonic_clock_invalid" })
  }

  const reserve = normalizeExecutionTailReserve(tail_reserve)
  if (!reserve.ok) return reserve

  const available = Math.max(0, remaining - reserve.reserve.total_ms)
  const deadline = safeAdd(now, available)
  if (deadline === null) {
    return Object.freeze({ ok: false, reason: "lease_deadline_overflow" })
  }

  const base = {
    protocol: EXECUTION_LEASE_PROTOCOL,
    lease_id: leaseID,
    remaining_task_budget_ms: remaining,
    tail_reserve: reserve.reserve,
    dispatch_lease_ms: available,
    issued_monotonic_ms: now,
    deadline_monotonic_ms: deadline,
    monotonic_clock: clockName,
    authority: "contract_only",
    scheduling_authority: false,
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    reason: "lease_constructed",
    lease: Object.freeze({
      ...base,
      content_sha256: sha256Canonical(base),
    }),
  })
}

export function remainingLeaseMs(
  lease,
  nowMonotonicMs = Math.floor(performance.now()),
) {
  if (!lease || lease.protocol !== EXECUTION_LEASE_PROTOCOL) return null
  const now = safeMs(nowMonotonicMs)
  const deadline = safeMs(lease.deadline_monotonic_ms)
  if (now === null || deadline === null) return null
  return Math.max(0, deadline - now)
}

export function createCancellationCapabilities({
  adapter_id,
  request_cancellation = false,
  transport_close_observable = false,
  provider_cancel_observable = false,
  compute_stop_observable = false,
} = {}) {
  const adapterID = boundedString(adapter_id, 128)
  if (!adapterID) {
    return Object.freeze({ ok: false, reason: "adapter_id_invalid" })
  }

  const base = {
    protocol: CANCELLATION_CAPABILITY_PROTOCOL,
    adapter_id: adapterID,
    request_cancellation: request_cancellation === true,
    transport_close_observable: transport_close_observable === true,
    provider_cancel_observable: provider_cancel_observable === true,
    compute_stop_observable: compute_stop_observable === true,
    hard_lease_candidate:
      request_cancellation === true &&
      transport_close_observable === true &&
      provider_cancel_observable === true &&
      compute_stop_observable === true,
    authority: "capability_declaration",
    scheduling_authority: false,
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    reason: "capabilities_constructed",
    capabilities: Object.freeze({
      ...base,
      content_sha256: sha256Canonical(base),
    }),
  })
}

function proofState(value) {
  return Object.values(PROOF_STATE).includes(value) ? value : null
}

export function createCancellationProof({
  lease_id,
  adapter_id,
  lease_expired,
  cancel_requested,
  transport_closed,
  provider_cancel_observed,
  compute_quiesced,
  post_expiry_action_observed = false,
  evidence = {},
} = {}) {
  const leaseID = boundedString(lease_id, 128)
  const adapterID = boundedString(adapter_id, 128)
  if (!leaseID || !adapterID) {
    return Object.freeze({ ok: false, reason: "proof_identity_invalid" })
  }

  const states = {
    cancel_requested: proofState(cancel_requested),
    transport_closed: proofState(transport_closed),
    provider_cancel_observed: proofState(provider_cancel_observed),
    compute_quiesced: proofState(compute_quiesced),
  }
  for (const [field, value] of Object.entries(states)) {
    if (!value) {
      return Object.freeze({
        ok: false,
        reason: "proof_state_invalid",
        field,
      })
    }
  }

  const hardLeaseEligible =
    lease_expired === true &&
    states.cancel_requested === PROOF_STATE.PROVEN &&
    states.transport_closed === PROOF_STATE.PROVEN &&
    states.provider_cancel_observed === PROOF_STATE.PROVEN &&
    states.compute_quiesced === PROOF_STATE.PROVEN &&
    post_expiry_action_observed !== true

  const base = {
    protocol: CANCELLATION_PROOF_PROTOCOL,
    lease_id: leaseID,
    adapter_id: adapterID,
    lease_expired: lease_expired === true,
    ...states,
    post_expiry_action_observed: post_expiry_action_observed === true,
    hard_lease_eligible: hardLeaseEligible,
    evidence:
      evidence && typeof evidence === "object"
        ? Object.freeze({ ...evidence })
        : Object.freeze({}),
    authority: "probe_evidence",
    scheduling_authority: false,
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    reason: "proof_constructed",
    proof: Object.freeze({
      ...base,
      content_sha256: sha256Canonical(base),
    }),
  })
}

export function verifyHardLeaseEligibility(
  capabilities,
  proof,
) {
  if (
    !capabilities ||
    capabilities.protocol !== CANCELLATION_CAPABILITY_PROTOCOL
  ) {
    return Object.freeze({
      eligible: false,
      reason: "capabilities_invalid",
    })
  }
  if (!proof || proof.protocol !== CANCELLATION_PROOF_PROTOCOL) {
    return Object.freeze({
      eligible: false,
      reason: "proof_invalid",
    })
  }
  if (capabilities.adapter_id !== proof.adapter_id) {
    return Object.freeze({
      eligible: false,
      reason: "adapter_identity_mismatch",
    })
  }
  if (capabilities.hard_lease_candidate !== true) {
    return Object.freeze({
      eligible: false,
      reason: "capability_incomplete",
    })
  }
  if (proof.hard_lease_eligible !== true) {
    return Object.freeze({
      eligible: false,
      reason: "proof_incomplete",
    })
  }

  return Object.freeze({
    eligible: true,
    reason: "hard_lease_capability_proven",
    adapter_id: capabilities.adapter_id,
    proof_sha256: proof.content_sha256,
  })
}
