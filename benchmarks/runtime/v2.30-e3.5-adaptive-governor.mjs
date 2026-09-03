import assert from "node:assert/strict"

import {
  GOVERNOR_LEASE_PROTOCOL,
  GOVERNOR_WORK_PROTOCOL,
  adaptiveGovernorWindows,
  deriveGovernorInferenceLease,
  estimateGovernorDispatchWork,
  governorUpperMsPerByte,
  initialGovernorWorkProfile,
  observeGovernorWork,
} from "../../opencode/plugins/cpu-search-core/governor-work-v2.mjs"

const locate = estimateGovernorDispatchWork({
  system: [{ text: "system" }],
  messages: [{ role: "user", content: [{ type: "text", text: "find owner" }] }],
  tools: {
    search: {
      input: {
        type: "object",
        properties: { query: { type: "string", maxLength: 256 } },
      },
    },
  },
  selectedTool: "search",
})
assert.equal(locate.protocol, GOVERNOR_WORK_PROTOCOL)
assert.ok(locate.input_bytes > 0)
assert.ok(locate.output_bound_bytes > 0)
assert.equal(locate.mutation_authority, false)

const mutation = estimateGovernorDispatchWork({
  system: [{ text: "bounded" }],
  messages: [{
    role: "user",
    content: [{
      type: "text",
      text: [
        "REQUIRED_OPERATION id=op_0 operation=python_declaration",
        "REQUIRED_OPERATION id=op_1 operation=replacement",
        "REQUIRED_OPERATION id=op_2 operation=creation",
      ].join("\n"),
    }],
  }],
  tools: { execute_plan: { input: { type: "object" } } },
  selectedTool: "execute_plan",
  additiveCapability: { budgets: { max_plan_bytes: 32768 } },
})
assert.equal(mutation.required_operations, 3)

// v2.31+ Governor semantics:
//
// expected_output_*
//   models actual provider-facing decode work.
//
// output_ceiling_*
//   remains the deterministic capability safety maximum.
//
// output_bound_* is retained as a compatibility alias for
// expected_output_*, not for the safety ceiling.
assert.equal(
  mutation.expected_output_source,
  "semantic_model_facing_surface_proxy",
)
assert.equal(
  mutation.expected_output_bytes,
  207,
)

assert.equal(
  mutation.output_bound_source,
  mutation.expected_output_source,
)
assert.equal(
  mutation.output_bound_bytes,
  mutation.expected_output_bytes,
)

assert.equal(
  mutation.output_ceiling_source,
  "sealed_capability_max_plan_bytes",
)
assert.equal(
  mutation.output_ceiling_bytes,
  32768,
)

assert.equal(
  mutation.decode_expected_bytes,
  mutation.expected_output_bytes,
)
assert.equal(
  mutation.decode_ceiling_bytes,
  mutation.output_ceiling_bytes,
)

assert.equal(
  mutation.work_model_separated,
  true,
)

assert.ok(
  mutation.expected_output_bytes <
    mutation.output_ceiling_bytes,
)

assert.equal(
  mutation.work_bytes,
  mutation.input_bytes +
    mutation.expected_output_bytes,
)

assert.ok(mutation.work_bytes > locate.work_bytes)

let profile = initialGovernorWorkProfile()
profile = observeGovernorWork(profile, { elapsedMs: 60_000, workBytes: 8_000 })
const firstUpper = governorUpperMsPerByte(profile)
assert.ok(firstUpper > 0)
assert.equal(profile.samples, 1)

const mutationLease = deriveGovernorInferenceLease({
  profile,
  work: mutation,
  bootstrapLeaseMs: 120_000,
  legacyReserveMs: 60_000,
})
const locateLease = deriveGovernorInferenceLease({
  profile,
  work: locate,
  bootstrapLeaseMs: 120_000,
  legacyReserveMs: 60_000,
})
assert.equal(mutationLease.protocol, GOVERNOR_LEASE_PROTOCOL)
assert.equal(mutationLease.source, "jacobson_p2_work_normalized")
// With expected decode work separated from the hard capability
// ceiling, both small dispatches may legitimately be clamped by the
// same bootstrap lease floor. The architectural invariant is
// monotonicity, not strict separation:
//
//   larger modeled work must never receive a smaller lease.
//
// Strict ">" previously held only because max_plan_bytes (32768)
// incorrectly inflated expected mutation work.
assert.ok(
  mutation.work_bytes > locate.work_bytes,
)
assert.ok(
  mutationLease.lease_ms >=
    locateLease.lease_ms,
)
assert.equal(
  mutationLease.source,
  "jacobson_p2_work_normalized",
)
assert.equal(
  locateLease.source,
  "jacobson_p2_work_normalized",
)

for (const elapsedMs of [59_000, 61_000, 60_500, 59_500, 60_250]) {
  profile = observeGovernorWork(profile, { elapsedMs, workBytes: 8_000 })
}
const stableUpper = governorUpperMsPerByte(profile)
assert.ok(stableUpper > 0)
const stableLease = deriveGovernorInferenceLease({
  profile,
  work: mutation,
  bootstrapLeaseMs: 120_000,
})
const variableProfile = observeGovernorWork(profile, {
  elapsedMs: 150_000,
  workBytes: 8_000,
})
const variableLease = deriveGovernorInferenceLease({
  profile: variableProfile,
  work: mutation,
  bootstrapLeaseMs: 120_000,
})
// Increased observed latency/variance must increase the
// underlying Jacobson work estimate. The final lease may still be
// clamped by the same bootstrap floor, so strict lease ordering is
// not an invariant.
//
// Test estimator sensitivity and post-clamp monotonicity separately.
const variableUpper =
  governorUpperMsPerByte(variableProfile)

assert.ok(
  variableUpper > stableUpper,
)

assert.ok(
  variableLease.lease_ms >=
    stableLease.lease_ms,
)

assert.equal(
  variableLease.source,
  "jacobson_p2_work_normalized",
)

const windows = adaptiveGovernorWindows({
  nowMs: 500_000,
  taskStartedAt: 100_000,
  phaseStartedAt: 450_000,
  basePhaseBudgetMs: 120_000,
  baseTaskBudgetMs: 360_000,
  inferenceLeaseMs: mutationLease.lease_ms,
})
assert.ok(windows.phase_budget_ms >= 50_000 + mutationLease.lease_ms)
assert.ok(windows.task_budget_ms >= 400_000 + mutationLease.lease_ms)

console.log(
  "PASS E3.5 adaptive governor " +
  `samples=${profile.samples} ` +
  `stable_upper_ms_per_byte=${stableUpper.toFixed(6)} ` +
  `mutation_lease_ms=${mutationLease.lease_ms} ` +
  `variable_lease_ms=${variableLease.lease_ms}`,
)
