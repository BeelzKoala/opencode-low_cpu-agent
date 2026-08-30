import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  buildPersistentRuntimeCostProfile,
} from "./runtime-cost-profile-v1.mjs"
import {
  ADMISSION_EVIDENCE_SIGNAL,
  RUNTIME_COST_ADMISSION_EVIDENCE_PROTOCOL,
  RUNTIME_COST_ADMISSION_REQUEST_PROTOCOL,
  evaluateRuntimeCostAdmissionEvidence,
} from "./runtime-cost-admission-evidence-v1.mjs"

const identity = ({
  frontier = "b4211972f2332bfd367161cd82f498e524b66ce5cd28d46fcc89f03d5c3c338c",
  phase = "mutate",
} = {}) => ({
  providerID: "local",
  modelID: "north-mini-code-local",
  phase,
  frontier_sha256: frontier,
  agent_protocol: "cpu-agent-v2.8.0-mutation-confinement-2",
  tool_frontier_protocol: "causal-tool-frontier-v2.5-deterministic-action",
  mutation_tool_abi_protocol: "capability-mutation-tools-v2",
})

const observation = ({
  actionable = null,
  censored = null,
  unresolved = false,
  context = 12_445,
  id = identity(),
} = {}) => ({
  providerID: id.providerID,
  modelID: id.modelID,
  execution_state: id.phase,
  tool_frontier_schema_sha256: id.frontier_sha256,
  agent_protocol: id.agent_protocol,
  tool_frontier_protocol: id.tool_frontier_protocol,
  mutation_tool_abi_protocol: id.mutation_tool_abi_protocol,
  context_bytes: context,
  status:
    actionable !== null
      ? "actionable_tool_boundary"
      : censored !== null
        ? "right_censored_at_cli_termination"
        : unresolved
          ? "open_unresolved"
          : "message_completion_boundary",
  outcome: actionable !== null ? "tool_call" : null,
  censored: censored !== null,
  dispatch_to_actionable_boundary_ms: actionable,
  elapsed_lower_bound_ms: censored,
})

const currentProfile = buildPersistentRuntimeCostProfile([
  observation({ actionable: 126_513 }),
  observation({ actionable: 168_733 }),
  observation({ actionable: 232_312 }),
  observation({ censored: 298_425 }),
  observation({ unresolved: true }),
  observation({ unresolved: true }),
], {
  sourceArtifacts: 6,
  sourceTelemetryConflicts: 0,
})

const request = ({
  remaining = 300_000,
  tail = 0,
  margin = 15_000,
  context = 12_445,
  id = identity(),
} = {}) => ({
  protocol: RUNTIME_COST_ADMISSION_REQUEST_PROTOCOL,
  identity: id,
  remaining_window_ms: remaining,
  deterministic_tail_reserve_ms: tail,
  safety_margin_ms: margin,
  context_bytes: context,
  window_kind: "task",
})

{
  const evidence = evaluateRuntimeCostAdmissionEvidence(
    currentProfile,
    request(),
  )
  assert.equal(
    evidence.protocol,
    RUNTIME_COST_ADMISSION_EVIDENCE_PROTOCOL,
  )
  assert.equal(
    evidence.signal,
    ADMISSION_EVIDENCE_SIGNAL.OBSERVED_WINDOW_VIOLATION,
  )
  assert.equal(
    evidence.reason,
    "compatible_history_contains_cost_above_available_window",
  )
  assert.equal(evidence.request.available_model_window_ms, 285_000)
  assert.equal(
    evidence.historical_evidence.historical_observed_cost_floor_ms,
    298_425,
  )
  assert.deepEqual(
    evidence.historical_evidence.historical_observed_cost_floor_sources,
    ["censored_lower_bound"],
  )
  assert.equal(evidence.observed_window_exceedance_ms, 13_425)
  assert.equal(
    evidence.headroom_to_historical_observed_floor_ms,
    -13_425,
  )
  assert.equal(
    evidence.context_coverage.status,
    "inside_observed_context_range",
  )
  assert.equal(evidence.admission_authority, false)
  assert.equal(evidence.scheduling_authority, false)
  assert.equal(evidence.mutation_authority, false)
}

{
  // A larger window is NOT called admissible. It only lacks a historical
  // violation at the current observed floor.
  const evidence = evaluateRuntimeCostAdmissionEvidence(
    currentProfile,
    request({ remaining: 360_000, tail: 30_000, margin: 15_000 }),
  )
  assert.equal(
    evidence.signal,
    ADMISSION_EVIDENCE_SIGNAL.NO_OBSERVED_WINDOW_VIOLATION,
  )
  assert.equal(evidence.request.available_model_window_ms, 315_000)
  assert.equal(
    evidence.headroom_to_historical_observed_floor_ms,
    16_575,
  )
  assert.equal(
    evidence.extrapolation_flags.includes("censored_observations_present"),
    true,
  )
  assert.equal(
    evidence.extrapolation_flags.includes("unresolved_observations_present"),
    true,
  )
}

{
  // Exact compatibility only: no fallback between frontiers.
  const evidence = evaluateRuntimeCostAdmissionEvidence(
    currentProfile,
    request({
      id: identity({ frontier: "a".repeat(64) }),
    }),
  )
  assert.equal(
    evidence.signal,
    ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
  )
  assert.equal(evidence.reason, "compatible_profile_not_found")
}

{
  // Unresolved-only profiles cannot be converted into a numeric estimate.
  const unresolvedProfile = buildPersistentRuntimeCostProfile([
    observation({ unresolved: true }),
    observation({ unresolved: true }),
  ])
  const evidence = evaluateRuntimeCostAdmissionEvidence(
    unresolvedProfile,
    request(),
  )
  assert.equal(
    evidence.signal,
    ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
  )
  assert.equal(
    evidence.reason,
    "no_bounded_historical_cost_observation",
  )
}

{
  // Context outside the observed range is surfaced as extrapolation evidence,
  // but does not fabricate a different latency bucket.
  const evidence = evaluateRuntimeCostAdmissionEvidence(
    currentProfile,
    request({
      remaining: 360_000,
      tail: 0,
      margin: 15_000,
      context: 50_000,
    }),
  )
  assert.equal(
    evidence.context_coverage.status,
    "outside_observed_context_range",
  )
  assert.equal(evidence.context_coverage.extrapolation, true)
  assert.equal(
    evidence.extrapolation_flags.includes(
      "outside_observed_context_range",
    ),
    true,
  )
}

{
  // Tampered persistent evidence must fail closed.
  const tampered = JSON.parse(JSON.stringify(currentProfile))
  tampered.profiles[0].actionable_max_ms = 1
  const evidence = evaluateRuntimeCostAdmissionEvidence(
    tampered,
    request(),
  )
  assert.equal(
    evidence.signal,
    ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
  )
  assert.equal(evidence.reason, "profile_document_invalid")
  assert.equal(evidence.detail, "content_sha256_mismatch")
}

{
  // Request budgets must be explicit safe integers.
  const evidence = evaluateRuntimeCostAdmissionEvidence(
    currentProfile,
    {
      ...request(),
      remaining_window_ms: 300_000,
      deterministic_tail_reserve_ms: Number.MAX_SAFE_INTEGER,
      safety_margin_ms: 1,
    },
  )
  assert.equal(
    evidence.signal,
    ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
  )
  assert.equal(evidence.reason, "reserve_overflow")
}

{
  // Evidence output is deterministic and content-addressed.
  const a = evaluateRuntimeCostAdmissionEvidence(
    currentProfile,
    request(),
  )
  const b = evaluateRuntimeCostAdmissionEvidence(
    currentProfile,
    request(),
  )
  assert.deepEqual(a, b)
  assert.equal(a.content_sha256, b.content_sha256)
}

{
  // Production boundary: R3B2-A is not imported into plugin/Governor.
  const plugin = await readFile(
    path.resolve("opencode/plugins/cpu-search.ts"),
    "utf8",
  )
  const governor = await readFile(
    path.resolve("opencode/plugins/cpu-search-core/governor-latency-v1.mjs"),
    "utf8",
  )
  assert.doesNotMatch(plugin, /runtime-cost-admission-evidence-v1/u)
  assert.doesNotMatch(governor, /runtime-cost-admission-evidence-v1/u)
}

console.log(
  "PASS E2.5/R3B2-A shadow admission evidence distinguishes historical window violation from absence of observed violation without granting scheduling authority",
)
