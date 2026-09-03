export const GOVERNOR_LATENCY_PROTOCOL = "governor-latency-v1"
export const TIME_SEMANTICS_PROTOCOL = "time-semantics-v1"
export const GOVERNOR_TASK_WINDOW_SEMANTICS = "admission_guardrail"
export const GOVERNOR_TASK_SLA_ENFORCED = false
export const GOVERNOR_PRODUCT_WATCHDOG_MODE = "observation_only"
export const GOVERNOR_PRODUCTION_HARD_LEASE_PROMOTED = true
const GOVERNOR_ADMISSION_POLICY = "task_window_phase_runtime_v1"
export const GOVERNOR_PHASES = Object.freeze({
  LOCATE: "locate",
  MUTATE: "mutate",
  REPAIR: "repair",
  TERMINAL: "terminal",
})
export const GOVERNOR_MAX_ACTIVE_PHASES = 3
export const GOVERNOR_MAX_LATENCY_SAMPLES = 8
export const GOVERNOR_LATENCY_MARGIN_MIN_MS = 5_000
export const GOVERNOR_LATENCY_MARGIN_MAX_MS = 15_000
export const GOVERNOR_LATENCY_MARGIN_RATIO = 0.10

function finiteMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

export function phaseForExecutionState(state) {
  if (state === "locate") return GOVERNOR_PHASES.LOCATE
  if (state === "mutate") return GOVERNOR_PHASES.MUTATE
  if (state === "repair") return GOVERNOR_PHASES.REPAIR
  return GOVERNOR_PHASES.TERMINAL
}

export function initialLatencyProfile() {
  return {
    protocol: GOVERNOR_LATENCY_PROTOCOL,
    samples_ms: [],
    max_ms: 0,
    ewma_ms: 0,
  }
}

export function observeLatency(profile, observedMs) {
  const observed = finiteMs(observedMs)
  const current = profile?.protocol === GOVERNOR_LATENCY_PROTOCOL
    ? profile
    : initialLatencyProfile()
  if (observed === null) return current

  const samples = [
    ...(Array.isArray(current.samples_ms) ? current.samples_ms : []),
    observed,
  ].slice(-GOVERNOR_MAX_LATENCY_SAMPLES)
  const previousEwma = finiteMs(current.ewma_ms) ?? 0
  const ewma = previousEwma > 0
    ? Math.floor((previousEwma * 3 + observed) / 4)
    : observed

  return {
    protocol: GOVERNOR_LATENCY_PROTOCOL,
    samples_ms: samples,
    max_ms: Math.max(finiteMs(current.max_ms) ?? 0, observed),
    ewma_ms: ewma,
  }
}

export function latencyReserveMs(profile) {
  if (profile?.protocol !== GOVERNOR_LATENCY_PROTOCOL) return 0

  const samples = (Array.isArray(profile.samples_ms) ? profile.samples_ms : [])
    .map(finiteMs)
    .filter((value) => value !== null)
    .sort((a, b) => a - b)

  if (samples.length < 1) return 0

  const p90Index = Math.min(
    samples.length - 1,
    Math.ceil(samples.length * 0.9) - 1,
  )
  const p90 = samples[p90Index]
  return Math.max(p90, finiteMs(profile.ewma_ms) ?? 0)
}

export function latencyMarginMs(profile) {
  const reserve = latencyReserveMs(profile)
  if (reserve <= 0) return 0

  return Math.min(
    GOVERNOR_LATENCY_MARGIN_MAX_MS,
    Math.max(
      GOVERNOR_LATENCY_MARGIN_MIN_MS,
      Math.ceil(reserve * GOVERNOR_LATENCY_MARGIN_RATIO),
    ),
  )
}

export function requiredModelWindowMs(profile) {
  const reserve = latencyReserveMs(profile)
  if (reserve <= 0) return 0
  return reserve + latencyMarginMs(profile)
}

export function effectivePhaseBudgetMs({
  basePhaseBudgetMs,
  taskBudgetMs,
  latencyProfile,
} = {}) {
  const base = finiteMs(basePhaseBudgetMs)
  const task = finiteMs(taskBudgetMs)
  if (base === null || task === null || base < 1 || task < base) return null

  const required = requiredModelWindowMs(latencyProfile)
  return Math.min(task, Math.max(base, required))
}

export function resolveGovernorAdmission({
  nowMs,
  taskStartedAt,
  phaseStartedAt,
  phaseBudgetMs,
  taskBudgetMs,
  latencyProfile,
} = {}) {
  const now = finiteMs(nowMs)
  const taskStart = finiteMs(taskStartedAt)
  const phaseStart = finiteMs(phaseStartedAt)
  const basePhaseBudget = finiteMs(phaseBudgetMs)
  const taskBudget = finiteMs(taskBudgetMs)

  if (
    now === null ||
    taskStart === null ||
    phaseStart === null ||
    basePhaseBudget === null ||
    taskBudget === null ||
    basePhaseBudget < 1 ||
    taskBudget < basePhaseBudget
  ) {
    return {
      protocol: GOVERNOR_LATENCY_PROTOCOL,
      admitted: false,
      reason: "governor_budget_inputs_invalid",
    }
  }

  const effectivePhaseBudget = effectivePhaseBudgetMs({
    basePhaseBudgetMs: basePhaseBudget,
    taskBudgetMs: taskBudget,
    latencyProfile,
  })
  if (effectivePhaseBudget === null) {
    return {
      protocol: GOVERNOR_LATENCY_PROTOCOL,
      admitted: false,
      reason: "governor_budget_inputs_invalid",
    }
  }

  const taskElapsed = Math.max(0, now - taskStart)
  const phaseElapsed = Math.max(0, now - phaseStart)
  const taskRemaining = Math.max(0, taskBudget - taskElapsed)
  const phaseRemaining = Math.max(0, effectivePhaseBudget - phaseElapsed)
  const reserve = latencyReserveMs(latencyProfile)
  const margin = latencyMarginMs(latencyProfile)
  const requiredWindow = requiredModelWindowMs(latencyProfile)
  const taskDispatchHeadroom =
    requiredWindow > 0 ? taskRemaining - requiredWindow : null
  const phaseDispatchHeadroom =
    reserve > 0 ? phaseRemaining - reserve : null

  const common = {
    protocol: GOVERNOR_LATENCY_PROTOCOL,
    admission_policy: GOVERNOR_ADMISSION_POLICY,
    task_dispatch_headroom_ms: taskDispatchHeadroom,
    phase_dispatch_headroom_ms: phaseDispatchHeadroom,
    task_elapsed_ms: taskElapsed,
    phase_elapsed_ms: phaseElapsed,
    task_remaining_ms: taskRemaining,
    phase_remaining_ms: phaseRemaining,
    reserve_ms: reserve,
    reserve_margin_ms: margin,
    required_model_window_ms: requiredWindow,
    base_phase_budget_ms: basePhaseBudget,
    effective_phase_budget_ms: effectivePhaseBudget,
    task_budget_ms: taskBudget,
  }

  if (taskRemaining <= 0) {
    return {
      ...common,
      admitted: false,
      reason: "task_wall_budget",
    }
  }

  if (phaseRemaining <= 0) {
    return {
      ...common,
      admitted: false,
      reason: "phase_wall_budget",
    }
  }

  const taskWindowInsufficient =
    requiredWindow > 0 && taskRemaining < requiredWindow
  const phaseRuntimeInsufficient =
    reserve > 0 && phaseRemaining < reserve
  if (taskWindowInsufficient || phaseRuntimeInsufficient) {
    return {
      ...common,
      admitted: false,
      reason: "latency_admission",
      admission_blocker: taskWindowInsufficient
        ? "task_model_window"
        : "phase_model_runtime",
    }
  }

  return {
    ...common,
    admitted: true,
    admission_blocker: null,
    reason:
      requiredWindow > 0
        ? "latency_budget_available"
        : "cold_start_budget_available",
  }
}
