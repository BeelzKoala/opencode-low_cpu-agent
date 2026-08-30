import assert from "node:assert/strict"

import {
  effectivePhaseBudgetMs,
  initialLatencyProfile,
  latencyMarginMs,
  latencyReserveMs,
  observeLatency,
  requiredModelWindowMs,
  resolveGovernorAdmission,
} from "../../opencode/plugins/cpu-search-core/governor-latency-v1.mjs"

const BASE = 120_000
const TASK = 360_000

function profileWith(observedMs) {
  return observeLatency(initialLatencyProfile(), observedMs)
}

function admit({
  nowMs,
  taskStartedAt = 0,
  phaseStartedAt = 0,
  profile,
}) {
  return resolveGovernorAdmission({
    nowMs,
    taskStartedAt,
    phaseStartedAt,
    phaseBudgetMs: BASE,
    taskBudgetMs: TASK,
    latencyProfile: profile,
  })
}

const realProfile = profileWith(124_200)
assert.equal(latencyReserveMs(realProfile), 124_200)
assert.equal(latencyMarginMs(realProfile), 12_420)
assert.equal(requiredModelWindowMs(realProfile), 136_620)
assert.equal(
  effectivePhaseBudgetMs({
    basePhaseBudgetMs: BASE,
    taskBudgetMs: TASK,
    latencyProfile: realProfile,
  }),
  136_620,
)

const realRegression = admit({
  nowMs: 126_195,
  taskStartedAt: 0,
  phaseStartedAt: 126_014,
  profile: realProfile,
})
assert.equal(realRegression.admitted, true)
assert.equal(realRegression.reason, "latency_budget_available")
assert.equal(
  realRegression.admission_policy,
  "task_window_phase_runtime_v1",
)
assert.equal(realRegression.admission_blocker, null)
assert.equal(realRegression.reserve_ms, 124_200)
assert.equal(realRegression.required_model_window_ms, 136_620)
assert.equal(realRegression.phase_remaining_ms, 136_439)
assert.equal(realRegression.phase_dispatch_headroom_ms, 12_239)
assert.equal(realRegression.task_dispatch_headroom_ms, 97_185)

const phaseAtBoundary = admit({
  nowMs: 12_420,
  phaseStartedAt: 0,
  profile: realProfile,
})
assert.equal(phaseAtBoundary.phase_remaining_ms, 124_200)
assert.equal(phaseAtBoundary.phase_dispatch_headroom_ms, 0)
assert.equal(phaseAtBoundary.admitted, true)

const phasePastBoundary = admit({
  nowMs: 12_421,
  phaseStartedAt: 0,
  profile: realProfile,
})
assert.equal(phasePastBoundary.phase_remaining_ms, 124_199)
assert.equal(phasePastBoundary.phase_dispatch_headroom_ms, -1)
assert.equal(phasePastBoundary.admitted, false)
assert.equal(phasePastBoundary.reason, "latency_admission")
assert.equal(phasePastBoundary.admission_blocker, "phase_model_runtime")

const taskAtBoundaryNow = TASK - 136_620
const taskAtBoundary = admit({
  nowMs: taskAtBoundaryNow,
  taskStartedAt: 0,
  phaseStartedAt: taskAtBoundaryNow,
  profile: realProfile,
})
assert.equal(taskAtBoundary.task_remaining_ms, 136_620)
assert.equal(taskAtBoundary.task_dispatch_headroom_ms, 0)
assert.equal(taskAtBoundary.admitted, true)

const taskPastBoundaryNow = TASK - 136_619
const taskPastBoundary = admit({
  nowMs: taskPastBoundaryNow,
  taskStartedAt: 0,
  phaseStartedAt: taskPastBoundaryNow,
  profile: realProfile,
})
assert.equal(taskPastBoundary.task_remaining_ms, 136_619)
assert.equal(taskPastBoundary.task_dispatch_headroom_ms, -1)
assert.equal(taskPastBoundary.admitted, false)
assert.equal(taskPastBoundary.reason, "latency_admission")
assert.equal(taskPastBoundary.admission_blocker, "task_model_window")

const bothPastBoundary = admit({
  nowMs: TASK - 100_000,
  taskStartedAt: 0,
  phaseStartedAt: TASK - 100_000 - 40_000,
  profile: realProfile,
})
assert.equal(bothPastBoundary.admitted, false)
assert.equal(bothPastBoundary.reason, "latency_admission")
assert.equal(bothPastBoundary.admission_blocker, "task_model_window")

const cold = initialLatencyProfile()
const coldPass = admit({
  nowMs: BASE - 1,
  profile: cold,
})
assert.equal(coldPass.required_model_window_ms, 0)
assert.equal(coldPass.task_dispatch_headroom_ms, null)
assert.equal(coldPass.phase_dispatch_headroom_ms, null)
assert.equal(coldPass.admitted, true)
assert.equal(coldPass.reason, "cold_start_budget_available")

const coldPhaseWall = admit({
  nowMs: BASE,
  profile: cold,
})
assert.equal(coldPhaseWall.admitted, false)
assert.equal(coldPhaseWall.reason, "phase_wall_budget")

const impossibleProfile = profileWith(400_000)
assert.equal(latencyReserveMs(impossibleProfile), 400_000)
assert.equal(latencyMarginMs(impossibleProfile), 15_000)
assert.equal(requiredModelWindowMs(impossibleProfile), 415_000)
assert.equal(
  effectivePhaseBudgetMs({
    basePhaseBudgetMs: BASE,
    taskBudgetMs: TASK,
    latencyProfile: impossibleProfile,
  }),
  TASK,
)

const impossible = admit({
  nowMs: 0,
  profile: impossibleProfile,
})
assert.equal(impossible.admitted, false)
assert.equal(impossible.reason, "latency_admission")
assert.equal(impossible.admission_blocker, "task_model_window")
assert.equal(impossible.task_dispatch_headroom_ms, -55_000)

const moderateProfile = profileWith(100_000)
assert.equal(requiredModelWindowMs(moderateProfile), 110_000)
assert.equal(
  effectivePhaseBudgetMs({
    basePhaseBudgetMs: BASE,
    taskBudgetMs: TASK,
    latencyProfile: moderateProfile,
  }),
  BASE,
)

const moderateBoundary = admit({
  nowMs: 20_000,
  phaseStartedAt: 0,
  profile: moderateProfile,
})
assert.equal(moderateBoundary.phase_remaining_ms, 100_000)
assert.equal(moderateBoundary.phase_dispatch_headroom_ms, 0)
assert.equal(moderateBoundary.admitted, true)

const moderatePast = admit({
  nowMs: 20_001,
  phaseStartedAt: 0,
  profile: moderateProfile,
})
assert.equal(moderatePast.phase_dispatch_headroom_ms, -1)
assert.equal(moderatePast.admitted, false)
assert.equal(moderatePast.admission_blocker, "phase_model_runtime")

console.log(
  "PASS E2.0-R11 governor separates task model window from phase runtime reserve",
)
