export const GOVERNOR_PHYSICAL_LEASE_PROTOCOL =
  "governor-physical-lease-v1"

const DEFAULT_MIN_LEASE_MS = 1_000
const DEFAULT_MAX_LEASE_MS = 10 * 60_000

function positiveMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

function nonNegativeMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.floor(parsed)
}

export function deriveGovernorPhysicalLease({
  inferenceLeaseMs = null,
  inferenceLeaseSource = null,
  taskRemainingMs = null,
  phaseRemainingMs = null,
  teardownReserveMs = 0,
  minLeaseMs = DEFAULT_MIN_LEASE_MS,
  maxLeaseMs = DEFAULT_MAX_LEASE_MS,
} = {}) {
  const estimatedMs = positiveMs(inferenceLeaseMs)
  const remainingMs = nonNegativeMs(taskRemainingMs)
  const phaseMs = nonNegativeMs(phaseRemainingMs)
  const teardownMs = nonNegativeMs(teardownReserveMs) ?? 0
  const minimumMs = positiveMs(minLeaseMs) ?? DEFAULT_MIN_LEASE_MS
  const maximumMs = positiveMs(maxLeaseMs) ?? DEFAULT_MAX_LEASE_MS

  const estimateSource =
    typeof inferenceLeaseSource === "string" &&
    inferenceLeaseSource.length > 0
      ? inferenceLeaseSource
      : "unknown"

  const calibrated =
    estimatedMs != null &&
    estimateSource !== "bootstrap" &&
    estimateSource !== "unknown"

  const usableTaskMs =
    remainingMs == null
      ? maximumMs
      : Math.max(0, remainingMs - teardownMs)

  if (usableTaskMs < minimumMs) {
    return Object.freeze({
      ok: false,
      protocol: GOVERNOR_PHYSICAL_LEASE_PROTOCOL,
      reason: "governor_task_window_insufficient_for_physical_inference",
      lease_ms: 0,
      source: "task_window_exhausted",
      calibrated,
      governor_inference_lease_ms: estimatedMs,
      governor_inference_lease_source: estimateSource,
      task_remaining_ms: remainingMs,
      phase_remaining_ms: phaseMs,
      teardown_reserve_ms: teardownMs,
      policy_authority: "governor",
      enforcement_authority: "physical_inference_lease",
      mutation_authority: false,
    })
  }

  if (phaseMs != null && phaseMs < minimumMs) {
    return Object.freeze({
      ok: false,
      protocol: GOVERNOR_PHYSICAL_LEASE_PROTOCOL,
      reason: "governor_phase_window_insufficient_for_physical_inference",
      lease_ms: 0,
      source: "phase_window_exhausted",
      calibrated,
      governor_inference_lease_ms: estimatedMs,
      governor_inference_lease_source: estimateSource,
      task_remaining_ms: remainingMs,
      phase_remaining_ms: phaseMs,
      teardown_reserve_ms: teardownMs,
      policy_authority: "governor",
      enforcement_authority: "physical_inference_lease",
      mutation_authority: false,
    })
  }

  const taskBoundMs = Math.min(usableTaskMs, maximumMs)
  const phaseBoundMs =
    phaseMs == null ? maximumMs : Math.min(phaseMs, maximumMs)
  const estimateBoundMs =
    estimatedMs == null ? maximumMs : Math.min(estimatedMs, maximumMs)
  const bootstrapTaskCapMs =
    remainingMs == null
      ? maximumMs
      : Math.max(0, Math.floor(usableTaskMs / 3))

  // Cold-start /3 is a safety rail only. Once latency is calibrated, the
  // evidence-backed estimate replaces it. The absolute phase bound remains.
  const leaseMs = calibrated
    ? Math.min(taskBoundMs, phaseBoundMs, estimateBoundMs, maximumMs)
    : Math.min(
        taskBoundMs,
        phaseBoundMs,
        estimateBoundMs,
        bootstrapTaskCapMs,
        maximumMs,
      )

  if (leaseMs < minimumMs) {
    return Object.freeze({
      ok: false,
      protocol: GOVERNOR_PHYSICAL_LEASE_PROTOCOL,
      reason: "governor_bounded_window_insufficient_for_physical_inference",
      lease_ms: 0,
      source: calibrated
        ? "calibrated_window_exhausted"
        : "uncalibrated_window_exhausted",
      calibrated,
      governor_inference_lease_ms: estimatedMs,
      governor_inference_lease_source: estimateSource,
      task_remaining_ms: remainingMs,
      phase_remaining_ms: phaseMs,
      teardown_reserve_ms: teardownMs,
      bootstrap_task_fraction: 3,
      bootstrap_task_cap_ms: bootstrapTaskCapMs,
      policy_authority: "governor",
      enforcement_authority: "physical_inference_lease",
      mutation_authority: false,
    })
  }

  return Object.freeze({
    ok: true,
    protocol: GOVERNOR_PHYSICAL_LEASE_PROTOCOL,
    reason: calibrated
      ? "calibrated_phase_task_bounded_lease"
      : "uncalibrated_phase_task_fraction_bounded_lease",
    lease_ms: leaseMs,
    source: calibrated
      ? "calibrated_phase_task_bound"
      : "uncalibrated_phase_task_fraction",
    calibrated,
    governor_inference_lease_ms: estimatedMs,
    governor_inference_lease_source: estimateSource,
    task_remaining_ms: remainingMs,
    phase_remaining_ms: phaseMs,
    teardown_reserve_ms: teardownMs,
    bootstrap_task_fraction: 3,
    bootstrap_task_cap_ms: calibrated ? null : bootstrapTaskCapMs,
    estimate_bound_ms: estimateBoundMs,
    phase_bound_ms: phaseBoundMs,
    task_bound_ms: taskBoundMs,
    hard_lease_le_phase_remaining:
      phaseMs == null ? null : leaseMs <= phaseMs,
    policy_authority: "governor",
    enforcement_authority: "physical_inference_lease",
    mutation_authority: false,
  })
}
