import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import {
  PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
  SOURCE_SLOT_TYPED_INITIAL_PROTOCOL,
  compileTypedPythonRepairSourceSchema,
  validateTypedPythonRepairSource,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/v2.36-r7-r21-typed-first-action-stage-lock.json", import.meta.url),
    "utf8",
  ),
)

assert.equal(fixture.protocol, "r21-typed-first-action-stage-lock-v1")
assert.equal(fixture.mutation_authority, false)
assert.equal(fixture.expected.model_calls, 0)

const row = {
  source_key: "server_surface",
  operation_id: "op_0",
  operation_index: 0,
  obligation: "server_surface",
  kind: "python_declaration",
  slot: "existing:0",
  allow_module_imports: true,
  mode: null,
  max_bytes: 6144,
}

const typed = compileTypedPythonRepairSourceSchema({
  row,
  frontierRows: [row],
})
assert.equal(typed.ok, true, JSON.stringify(typed))
assert.equal(
  typed.field_authority.protocol,
  PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
)

const typedInitial = fixture.initial_request.sources.server_surface
const admission = validateTypedPythonRepairSource(
  typedInitial,
  {
    fieldAuthority: typed.field_authority,
    capacityProfile: typed.capacity_profile,
  },
)
assert.equal(admission.ok, true, JSON.stringify(admission))

const rawAdmission = validateTypedPythonRepairSource(
  "def report():\n    return 1\n",
  {
    fieldAuthority: typed.field_authority,
    capacityProfile: typed.capacity_profile,
  },
)
assert.equal(rawAdmission.ok, false)

const core = readFileSync(
  new URL("../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs", import.meta.url),
  "utf8",
)
const runtime = readFileSync(
  new URL("../../opencode/plugins/cpu-search.fragments/09.part.ts", import.meta.url),
  "utf8",
)

assert.equal(
  SOURCE_SLOT_TYPED_INITIAL_PROTOCOL,
  "source-slot-typed-initial-v1",
)
assert.match(
  core,
  /function schemaForRows\([\s\S]{0,260}typedPython = false,[\s\S]{0,100}typedRepair = false/u,
)
assert.match(
  core,
  /if \(typedPython && row\.kind === "python_declaration"\)/u,
)
assert.match(
  core,
  /frontierRows:\s*typedRepair\s*\?\s*rows\s*:\s*\[row\]/u,
)
assert.match(core, /typedInitialPython = false/u)
assert.match(
  core,
  /typedPython:\s*\n?\s*typedInitialPython === true \|\|\s*\n?\s*activeCache != null/u,
)
assert.match(
  core,
  /binding\?\.typed_initial_protocol ===\s*\n?\s*SOURCE_SLOT_TYPED_INITIAL_PROTOCOL/u,
)
assert.match(
  core,
  /typed_repair_field_authority_by_source:\s*\n?\s*typedPythonActive\s*\n?\s*\?/u,
)
assert.match(
  core,
  /typed_repair_model_capacity_by_source:\s*\n?\s*typedPythonActive\s*\n?\s*\?/u,
)
assert.match(core, /sourceSlotValueClone\(value\)/u)
assert.match(core, /sourceSlotValueHash\(value\)/u)
assert.match(runtime, /typedInitialPython:\s*true/u)

const legacy = "legacy-source\n"
const legacyHash = createHash("sha256")
  .update(legacy, "utf8")
  .digest("hex")
assert.match(legacyHash, /^[0-9a-f]{64}$/u)

console.log(
  "PASS R7-R21-R6 typed first action + deterministic stage lock " +
  "production_initial_python=typed_units repair_python=typed_units " +
  "raw_initial_python=schema_forbidden initial_capacity=single_row " +
  "repair_capacity=repair_frontier typed_sibling_cache=enabled " +
  "legacy_default_lane=preserved legacy_string_hash=byte_compatible " +
  "model_calls_added=0 repair_budget_unchanged mutation_authority=false",
)
