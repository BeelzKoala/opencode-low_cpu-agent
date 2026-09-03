import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  resolveModelContextCompilerMode,
  resolveModelContextCompilerPolicy,
} from "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs"

const protocol = "execution-context-compiler-policy-v1"

assert.equal(resolveModelContextCompilerMode(undefined), "shadow")
assert.equal(resolveModelContextCompilerMode("shadow"), "shadow")
assert.equal(resolveModelContextCompilerMode("active"), "active")
assert.equal(resolveModelContextCompilerMode("off"), "off")

const observationDefault =
  resolveModelContextCompilerPolicy(undefined)
assert.equal(observationDefault.protocol, protocol)
assert.equal(observationDefault.configured_mode, "shadow")
assert.equal(observationDefault.effective_mode, "shadow")
assert.equal(observationDefault.promoted, false)
assert.equal(observationDefault.blocked, false)
assert.equal(
  observationDefault.bound_execution_context_required,
  false,
)

const implicitMutation =
  resolveModelContextCompilerPolicy(
    undefined,
    { boundExecutionContextRequired: true },
  )
assert.equal(implicitMutation.configured_mode, "shadow")
assert.equal(implicitMutation.effective_mode, "active")
assert.equal(implicitMutation.promoted, true)
assert.equal(implicitMutation.blocked, false)

const shadowMutation =
  resolveModelContextCompilerPolicy(
    "shadow",
    { boundExecutionContextRequired: true },
  )
assert.equal(shadowMutation.effective_mode, "active")
assert.equal(shadowMutation.promoted, true)
assert.equal(shadowMutation.blocked, false)

const activeMutation =
  resolveModelContextCompilerPolicy(
    "active",
    { boundExecutionContextRequired: true },
  )
assert.equal(activeMutation.effective_mode, "active")
assert.equal(activeMutation.promoted, false)
assert.equal(activeMutation.blocked, false)

const disabledMutation =
  resolveModelContextCompilerPolicy(
    "off",
    { boundExecutionContextRequired: true },
  )
assert.equal(disabledMutation.effective_mode, "off")
assert.equal(disabledMutation.promoted, false)
assert.equal(disabledMutation.blocked, true)
assert.equal(
  disabledMutation.reason,
  "execution_context_compiler_disabled_for_bound_mutation",
)

for (const row of [
  observationDefault,
  implicitMutation,
  shadowMutation,
  activeMutation,
  disabledMutation,
]) {
  assert.equal(row.mutation_authority, false)
}

const part00 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/00.part.ts",
    import.meta.url,
  ),
  "utf8",
)
const part09 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)
const sourceSlot = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)

assert.match(part00, /\bresolveModelContextCompilerPolicy\b/u)

assert.match(
  part09,
  /const boundExecutionContextRequired =[\s\S]{0,500}resolveModelContextCompilerPolicy\([\s\S]{0,500}const modelContextCompilerMode =\s*modelContextCompilerPolicy\.effective_mode/u,
)

assert.match(
  part09,
  /state\.executionContextCapsule = compiledCapsule[\s\S]{0,300}state\.executionContextCapsuleSha256 =\s*compiledCapsule\.capsule_sha256[\s\S]{0,300}state\.executionContextContractSha256 =\s*compiledCapsule\.execution_contract_sha256/u,
)

assert.match(part09, /execution_context_handoff_unproven/u)
assert.match(
  part09,
  /modelContextCompilerPolicy\.blocked === true[\s\S]{0,300}state\.executionContextBlockReason =\s*modelContextCompilerPolicy\.reason/u,
)
assert.match(part09, /model_context_compiler_promoted/u)
assert.match(part09, /model_context_selected_capsule_sha256/u)

const repairStart =
  part09.indexOf("const repairExecutionContextEligible")
assert(repairStart >= 0)
const repairEnd =
  part09.indexOf(
    "if (repairExecutionContextEligible)",
    repairStart,
  )
assert(repairEnd > repairStart)
const repairRegion =
  part09.slice(repairStart, repairEnd)

assert.match(
  repairRegion,
  /state\.executionContextCapsuleSha256/u,
)
assert.match(repairRegion, /compiled_execution_capsule/u)
assert.doesNotMatch(
  repairRegion,
  /OPENCODE_CPU_MODEL_CONTEXT_COMPILER/u,
)
assert.doesNotMatch(
  repairRegion,
  /resolveModelContextCompilerMode/u,
)

assert.match(
  sourceSlot,
  /source_slot_execution_context_invalid/u,
)

console.log(
  "PASS R7-R10 execution-context handoff closure " +
  "observation_default=shadow " +
  "bound_mutation=active " +
  "shadow_mutation=deterministic_promotion " +
  "off_mutation=fail_closed " +
  "handoff=compiled_capsule_exact_identity " +
  "repair=persisted_capsule_authority " +
  "source_slot_missing_context=still_rejected " +
  "mutation_authority=false",
)
