import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  SOURCE_SLOT_COMPILER_PROTOCOL,
  deriveSourceSlotSchemaFrontier,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"
import {
  QUALIFIED_COMPUTE_PROTOCOL,
  QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS,
  QUALIFIED_REPAIR_HARD_LEASE_MS,
  QUALIFIED_REPAIR_MIN_HARD_LEASE_MS,
  QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS,
  QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS,
  deriveQualifiedComputePlan,
  qualifiedAbortSignal,
} from "../../opencode/plugins/cpu-search-core/qualified-compute-v1.mjs"
import {
  compileBoundedMutationInferenceParams,
} from "../../opencode/plugins/cpu-search-core/bounded-mutation-inference-v1.mjs"

function sourceTool(properties, required) {
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
          properties,
          required,
        },
      },
      required: ["sources"],
    },
  }
}

const fullTool = sourceTool(
  {
    server_surface: { type: "string", minLength: 1, maxLength: 6144 },
    navigation_integration: { type: "string", minLength: 1, maxLength: 2048 },
    ui_surface: { type: "string", minLength: 1, maxLength: 8192 },
  },
  ["server_surface", "navigation_integration", "ui_surface"],
)
const repairTool = sourceTool(
  { server_surface: { type: "string", minLength: 1, maxLength: 6144 } },
  ["server_surface"],
)

const fullFrontier = deriveSourceSlotSchemaFrontier(fullTool)
assert.equal(fullFrontier.ok, true)
assert.equal(fullFrontier.protocol, SOURCE_SLOT_COMPILER_PROTOCOL)
assert.equal(fullFrontier.active_source_count, 3)
assert.equal(fullFrontier.active_source_capacity_bytes, 16384)
assert.equal(fullFrontier.total_source_capacity_bytes, 16384)

const repairFrontier = deriveSourceSlotSchemaFrontier(repairTool)
assert.equal(repairFrontier.ok, true)
assert.equal(repairFrontier.active_source_count, 1)
assert.deepEqual(repairFrontier.active_source_keys, ["server_surface"])
assert.equal(repairFrontier.active_source_capacity_bytes, 6144)

const fullPlan = deriveQualifiedComputePlan({
  tools: [fullTool],
  baseOutputCap: 4096,
  nowMs: 0,
  taskDeadlineAtMs: 360000,
})
assert.equal(fullPlan.active, false)
assert.equal(fullPlan.output_cap_tokens, null)

const repairPlan = deriveQualifiedComputePlan({
  tools: [repairTool],
  baseOutputCap: 4096,
  nowMs: 172000,
  taskDeadlineAtMs: 360000,
})
assert.equal(repairPlan.protocol, QUALIFIED_COMPUTE_PROTOCOL)
assert.equal(repairPlan.active, true)
assert.equal(repairPlan.output_cap_tokens, 1536)
assert.equal(QUALIFIED_REPAIR_HARD_LEASE_MS, 150000)
assert.equal(QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS, 30000)
assert.equal(QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS, 30000)
assert.equal(QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS, 120000)
assert.equal(QUALIFIED_REPAIR_MIN_HARD_LEASE_MS, 60000)
assert.equal(repairPlan.frontier_fraction, 6144 / 16384)
assert.equal(repairPlan.lease_policy, "frontier_coupled_affine_v1")
assert.equal(repairPlan.hard_lease_ms, 75000)
assert.equal(
  repairPlan.teardown_reserve_ms,
  QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS,
)
assert.equal(repairPlan.required_window_ms, 105000)
assert.equal(repairPlan.task_remaining_ms, 188000)
assert.equal(repairPlan.admission_allowed, true)
assert.equal(repairPlan.deadline_extension_ms, 0)

const exactBoundary = deriveQualifiedComputePlan({
  tools: [repairTool],
  baseOutputCap: 4096,
  nowMs: 255000,
  taskDeadlineAtMs: 360000,
})
assert.equal(exactBoundary.active, true)
assert.equal(exactBoundary.task_remaining_ms, 105000)
assert.equal(exactBoundary.required_window_ms, 105000)
assert.equal(exactBoundary.admission_allowed, true)

const blocked = deriveQualifiedComputePlan({
  tools: [repairTool],
  baseOutputCap: 4096,
  nowMs: 255001,
  taskDeadlineAtMs: 360000,
})
assert.equal(blocked.active, true)
assert.equal(blocked.task_remaining_ms, 104999)
assert.equal(blocked.required_window_ms, 105000)
assert.equal(blocked.admission_allowed, false)
assert.equal(blocked.deadline_extension_ms, 0)

const nonFunctionTool = {
  ...repairTool,
}
delete nonFunctionTool.type

const originalAbort = new AbortController().signal
const prompt =
  "MUTATION_PHASE protocol=mutation-phase-compiler-v1\n" +
  "CALL_POLICY tool=execute_additive_plan"

const rejectedNonFunction =
  compileBoundedMutationInferenceParams(
    {
      prompt,
      tools: [nonFunctionTool],
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

assert.equal(rejectedNonFunction.applied, false)
assert.equal(
  rejectedNonFunction.reason,
  "not_sealed_additive_mutation",
)
assert.equal(rejectedNonFunction.contract, null)

const fullCompiled = compileBoundedMutationInferenceParams(
  {
    prompt,
    tools: [fullTool],
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
assert.equal(fullCompiled.applied, true)
assert.equal(
  fullCompiled.reason,
  "sealed_additive_mutation_bounded",
)
assert.equal(fullCompiled.params.maxOutputTokens, 4096)
assert.equal(fullCompiled.params.abortSignal, originalAbort)
assert.equal(fullCompiled.contract.qualified_compute_active, false)
assert.equal(
  fullCompiled.contract.abort_identity_preserved,
  true,
)

const repairCompiled = compileBoundedMutationInferenceParams(
  {
    prompt,
    tools: [repairTool],
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
assert.equal(repairCompiled.applied, true)
assert.equal(
  repairCompiled.reason,
  "sealed_additive_mutation_bounded",
)
assert.equal(repairCompiled.params.maxOutputTokens, 1536)
assert.notEqual(repairCompiled.params.abortSignal, originalAbort)
assert.equal(repairCompiled.contract.qualified_compute_active, true)
assert.equal(repairCompiled.contract.qualified_compute_hard_lease_ms, 75000)
assert.equal(repairCompiled.contract.qualified_compute_output_cap_tokens, 1536)
assert.equal(
  repairCompiled.contract.abort_identity_preserved,
  false,
)

const signalProof = qualifiedAbortSignal(
  originalAbort,
  repairPlan.hard_lease_ms,
)
assert.equal(signalProof.qualified, true)
assert.notEqual(signalProof.signal, originalAbort)

const fragment09 = await readFile(
  new URL("../../opencode/plugins/cpu-search.fragments/09.part.ts", import.meta.url),
  "utf8",
)
for (const required of [
  "deriveQualifiedComputePlan",
  "qualified_compute_admission",
  "qualified_compute_admission_rejected",
  "deadline_extension_ms",
  "qualified_compute_provider_output_cap_tokens",
]) {
  assert.ok(fragment09.includes(required), `fragment09 missing ${required}`)
}
const admission = fragment09.indexOf("const qualifiedComputeNow")
const increment = fragment09.search(
  /state\.modelCalls\s*(?:\+=\s*1|=\s*state\.modelCalls\s*\+\s*1)/u,
)
assert.ok(admission >= 0 && increment > admission)

console.log(
  "PASS R7-R5 qualified compute admission " +
    "multi_slot=legacy_unchanged " +
    "single_source_output_cap=frontier_scaled " +
    "single_source_provider_cap=1536_of_4096 " +
    "admission=immutable_task_deadline " +
    "repair_hard_lease_ms=frontier_coupled_75000_for_6144 " +
    "teardown_reserve_ms=30000 " +
    "deadline_extension_ms=0 " +
    "provider_abort=qualified_backstop " +
    "bounded_compile_abi=applied_params_contract " +
    "function_tool_gate=real_shape " +
    "scout_changes=false verifier_changes=false mutation_authority=false",
)
