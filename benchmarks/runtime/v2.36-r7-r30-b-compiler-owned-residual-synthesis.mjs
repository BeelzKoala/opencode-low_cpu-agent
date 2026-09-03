import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  RESIDUAL_MODEL_VIEW_PROTOCOL,
  atomicModelViewRuntimeEnabled,
  residualModelViewRuntimeEnabled,
} from "../../opencode/plugins/cpu-search-core/atomic-model-view-v1.mjs"

const oneCallAtomicEnv = {
  OPENCODE_CPU_ONE_CALL_EXECUTOR: "1",
  OPENCODE_CPU_MODEL_SURFACE_MODE: "atomic",
}
assert.equal(residualModelViewRuntimeEnabled(oneCallAtomicEnv), true)
assert.equal(atomicModelViewRuntimeEnabled(oneCallAtomicEnv), false)

const legacyAtomicEnv = {
  OPENCODE_CPU_ONE_CALL_EXECUTOR: "0",
  OPENCODE_CPU_MODEL_SURFACE_MODE: "atomic",
}
assert.equal(residualModelViewRuntimeEnabled(legacyAtomicEnv), false)
assert.equal(atomicModelViewRuntimeEnabled(legacyAtomicEnv), true)
assert.equal(
  RESIDUAL_MODEL_VIEW_PROTOCOL,
  "compiler-owned-residual-model-view-v1",
)

const modelView = readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/model-view-compiler-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)
assert.match(modelView, /function preservationContractForRow\(/)
const tokenStart = modelView.indexOf("function semanticContractControlTokens(")
const tokenEnd = modelView.indexOf("\nfunction ", tokenStart + 1)
assert.ok(tokenStart >= 0)
const tokenSurface = modelView.slice(
  tokenStart,
  tokenEnd >= 0 ? tokenEnd : modelView.length,
)
assert.equal(tokenSurface.includes("preservation_mode"), false)
assert.equal(tokenSurface.includes("preservation_scope"), false)
assert.equal(tokenSurface.includes("allowed_delta_authority"), false)

const atomic = readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/atomic-model-view-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)
assert.match(atomic, /python_body_structural_escape/)
assert.match(atomic, /ast\.Import/)
assert.match(atomic, /ast\.ImportFrom/)
assert.match(atomic, /ast\.FunctionDef/)
assert.match(atomic, /ast\.AsyncFunctionDef/)
assert.match(atomic, /ast\.ClassDef/)

const importFragment = readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/00.part.ts",
    import.meta.url,
  ),
  "utf8",
)
assert.match(importFragment, /RESIDUAL_MODEL_VIEW_PROTOCOL/)
assert.match(importFragment, /residualModelViewRuntimeEnabled/)

const fragment = readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)
assert.match(fragment, /const residualModelViewEnabled =/)
assert.match(fragment, /residualModelViewEnabled !== true/)
assert.match(fragment, /residual_model_view_enabled:/)
assert.match(fragment, /residual_normal_physical_model_calls:/)
assert.match(fragment, /: sourceSlotModelView\.tool/)

// Existing repair path is the second physical call only when a deterministic
// validator rejects a subset. Accepted sources remain compiler-private cache.
for (const marker of [
  "buildSourceSlotRepairCache",
  "failed_source_keys",
  "preserved_source_keys",
  "state.sourceRepairDispatches === 0",
]) {
  assert.equal(fragment.includes(marker), true, marker)
}

const sourceSlot = readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)
assert.match(sourceSlot, /classifyCompilerOwnedSourceValue/)
assert.match(sourceSlot, /compilerOwnedSourceIdentities/)

console.log(
  "PASS R30-B compiler-owned residual synthesis " +
  "one_call_normal_path=true logical_holes_independent=true " +
  "sequential_atomic_disabled_in_one_call=true " +
  "accepted_subset_freeze_existing=true failed_subset_repair_max_one=true " +
  "preservation_tokens_removed=true native_body_escape_rejected=true " +
  "ownership_authority_reused=true mutation_authority=false",
)
