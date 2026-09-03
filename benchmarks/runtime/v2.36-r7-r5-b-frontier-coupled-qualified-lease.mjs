import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  QUALIFIED_COMPUTE_PROTOCOL,
  QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS,
  QUALIFIED_REPAIR_HARD_LEASE_MS,
  QUALIFIED_REPAIR_MIN_HARD_LEASE_MS,
  QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS,
  QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS,
  deriveQualifiedComputePlan,
} from "../../opencode/plugins/cpu-search-core/qualified-compute-v1.mjs"

import {
  compileBoundedMutationInferenceParams,
} from "../../opencode/plugins/cpu-search-core/bounded-mutation-inference-v1.mjs"

function sourceTool(sourceKey, maxLength) {
  return {
    type: "function",
    name: "execute_additive_plan",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        sources: {
          type: "object",
          additionalProperties: false,
          properties: {
            [sourceKey]: {
              type: "string",
              minLength: 1,
              maxLength,
            },
          },
          required: [sourceKey],
        },
      },
      required: ["sources"],
    },
  }
}

const baseOutputCap = 4096
const taskDeadlineAtMs = 360000

const cases = [
  {
    sourceKey: "alpha",
    capacity: 2048,
    outputCap: 512,
    hardLease: 60000,
    requiredWindow: 90000,
  },
  {
    sourceKey: "beta",
    capacity: 6144,
    outputCap: 1536,
    hardLease: 75000,
    requiredWindow: 105000,
  },
  {
    sourceKey: "gamma",
    capacity: 8192,
    outputCap: 2048,
    hardLease: 90000,
    requiredWindow: 120000,
  },
]

assert.equal(QUALIFIED_REPAIR_HARD_LEASE_MS, 150000)
assert.equal(QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS, 30000)
assert.equal(QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS, 30000)
assert.equal(QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS, 120000)
assert.equal(QUALIFIED_REPAIR_MIN_HARD_LEASE_MS, 60000)

for (const row of cases) {
  const tool = sourceTool(row.sourceKey, row.capacity)

  const plan = deriveQualifiedComputePlan({
    tools: [tool],
    baseOutputCap,
    nowMs: 0,
    taskDeadlineAtMs,
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.protocol, QUALIFIED_COMPUTE_PROTOCOL)
  assert.equal(plan.active, true)
  assert.equal(plan.active_source_count, 1)
  assert.deepEqual(plan.active_source_keys, [row.sourceKey])
  assert.equal(plan.active_source_capacity_bytes, row.capacity)
  assert.equal(plan.total_source_capacity_bytes, 16384)
  assert.equal(
    plan.frontier_fraction,
    row.capacity / 16384,
  )
  assert.equal(plan.output_cap_tokens, row.outputCap)
  assert.equal(plan.hard_lease_ms, row.hardLease)
  assert.equal(
    plan.required_window_ms,
    row.requiredWindow,
  )
  assert.equal(
    plan.lease_policy,
    "frontier_coupled_affine_v1",
  )
  assert.equal(
    plan.fixed_inference_reserve_ms,
    QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS,
  )
  assert.equal(
    plan.scalable_inference_budget_ms,
    QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS,
  )
  assert.equal(
    plan.min_hard_lease_ms,
    QUALIFIED_REPAIR_MIN_HARD_LEASE_MS,
  )
  assert.equal(
    plan.max_hard_lease_ms,
    QUALIFIED_REPAIR_HARD_LEASE_MS,
  )
  assert.equal(plan.admission_allowed, true)
  assert.equal(plan.deadline_extension_ms, 0)
  assert.equal(plan.mutation_authority, false)
}

const betaTool = sourceTool("causal_slot", 6144)

const exactBoundary = deriveQualifiedComputePlan({
  tools: [betaTool],
  baseOutputCap,
  nowMs: taskDeadlineAtMs - 105000,
  taskDeadlineAtMs,
})
assert.equal(exactBoundary.hard_lease_ms, 75000)
assert.equal(exactBoundary.task_remaining_ms, 105000)
assert.equal(exactBoundary.required_window_ms, 105000)
assert.equal(exactBoundary.admission_allowed, true)

const belowBoundary = deriveQualifiedComputePlan({
  tools: [betaTool],
  baseOutputCap,
  nowMs: taskDeadlineAtMs - 104999,
  taskDeadlineAtMs,
})
assert.equal(belowBoundary.task_remaining_ms, 104999)
assert.equal(belowBoundary.required_window_ms, 105000)
assert.equal(belowBoundary.admission_allowed, false)

const admissionWithoutProviderCap = deriveQualifiedComputePlan({
  tools: [betaTool],
  baseOutputCap: null,
  nowMs: taskDeadlineAtMs - 105000,
  taskDeadlineAtMs,
})
assert.equal(admissionWithoutProviderCap.output_cap_tokens, null)
assert.equal(
  admissionWithoutProviderCap.output_cap_authority,
  "frontier_observation_only",
)
assert.equal(admissionWithoutProviderCap.hard_lease_ms, 75000)
assert.equal(admissionWithoutProviderCap.required_window_ms, 105000)
assert.equal(admissionWithoutProviderCap.admission_allowed, true)

const originalAbort = new AbortController().signal
const prompt =
  "MUTATION_PHASE protocol=mutation-phase-compiler-v1\n" +
  "CALL_POLICY tool=execute_additive_plan"

const compiled =
  compileBoundedMutationInferenceParams(
    {
      prompt,
      tools: [betaTool],
      maxOutputTokens: 4096,
      abortSignal: originalAbort,
    },
    {
      providerID: "openai",
      modelID: "north-mini-code-local",
      modelOutputLimit: 4096,
      languageProvider: "openai-compatible",
      method: "doStream",
    },
  )

assert.equal(compiled.applied, true)
assert.equal(
  compiled.reason,
  "sealed_additive_mutation_bounded",
)
assert.equal(compiled.params.maxOutputTokens, 1536)
assert.notEqual(compiled.params.abortSignal, originalAbort)
assert.equal(compiled.contract.qualified_compute_active, true)
assert.equal(
  compiled.contract.qualified_compute_output_cap_tokens,
  1536,
)
assert.equal(
  compiled.contract.qualified_compute_hard_lease_ms,
  75000,
)

const fragment09 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)

for (const required of [
  "frontier_fraction:",
  "lease_policy:",
  "fixed_inference_reserve_ms:",
  "scalable_inference_budget_ms:",
  "min_hard_lease_ms:",
  "max_hard_lease_ms:",
  "qualified_compute_admission_rejected",
]) {
  assert.ok(
    fragment09.includes(required),
    `fragment09 missing ${required}`,
  )
}

const admissionPos =
  fragment09.indexOf("const qualifiedComputeNow")
const modelCallPos =
  fragment09.search(
    /state\.modelCalls\s*(?:\+=\s*1|=\s*state\.modelCalls\s*\+\s*1)/u,
  )

assert.ok(admissionPos >= 0)
assert.ok(modelCallPos > admissionPos)

console.log(
  "PASS R7-R5-B frontier-coupled qualified lease " +
    "source_key_independent=true " +
    "capacity_2048=lease60000_output512 " +
    "capacity_6144=lease75000_output1536 " +
    "capacity_8192=lease90000_output2048 " +
    "admission_provider_same_frontier=true " +
    "deadline_extension_ms=0 " +
    "provider_abort=frontier_coupled " +
    "mutation_authority=false repo_specific=false",
)
