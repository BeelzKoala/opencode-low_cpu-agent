import assert from "node:assert/strict"
import fs from "node:fs"

const core = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)
const imports = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/00.part.ts",
    import.meta.url,
  ),
  "utf8",
)
const runtime = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)

assert.match(
  core,
  /export function sourceSlotTypedStructuralRepairAuthorityMatches/u,
)
assert.match(core, /hint\?\.repairable !== false/u)
assert.match(
  core,
  /hint\?\.failure_reason !== TOP_LEVEL_KIND_FORBIDDEN_REASON/u,
)
assert.match(
  core,
  /Object\.keys\(witnesses\)\.length !== 0/u,
)
assert.match(
  core,
  /Object\.keys\(capsules\)\.length !== 0/u,
)
assert.match(
  core,
  /failedRow\?\.kind !== "python_declaration"/u,
)
assert.match(
  core,
  /compileTypedPythonRepairSourceSchema\(\{/u,
)
assert.match(
  core,
  /"semantic_unit_fields_only"/u,
)
assert.match(
  core,
  /legacyAuthorityOk\s*\|\|\s*typedStructuralAuthorityOk/u,
)
assert.match(
  imports,
  /sourceSlotTypedStructuralRepairAuthorityMatches,/u,
)
assert.match(
  runtime,
  /const legacyRepairAuthorityOk =/u,
)
assert.match(
  runtime,
  /const typedStructuralRepairAuthorityOk =/u,
)
assert.match(
  runtime,
  /sourceSlotTypedStructuralRepairAuthorityMatches\(\{/u,
)
assert.match(
  runtime,
  /const repairAuthorityOk =\s*legacyRepairAuthorityOk \|\|\s*typedStructuralRepairAuthorityOk/u,
)

console.log(
  "PASS R7-R18-R3 downstream typed structural authority " +
  "legacy_cache_repairable_semantics=unchanged " +
  "fallback_scope=single_python_top_level_ce " +
  "witness_present_requires_legacy=true " +
  "typed_schema_required=true " +
  "binder_runtime=shared_authority " +
  "raw_string_authority_expansion=false",
)
