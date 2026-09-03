import assert from "node:assert/strict"

import {
  PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
  PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL,
  compileTypedPythonRepairSourceSchema,
  deriveSourceSlotSchemaFrontier,
  deriveTypedPythonRepairModelCapacity,
  validateTypedPythonRepairModelCapacity,
  validateTypedPythonRepairSource,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

import {
  validatePythonUnitsContract,
} from "../../opencode/plugins/cpu-search-core/python-unit-contract-v1.mjs"

const SHA = "a".repeat(64)

function row(sourceKey, maxBytes) {
  return {
    source_key: sourceKey,
    operation_id: "op_0",
    operation_index: 0,
    obligation: sourceKey,
    kind: "python_declaration",
    slot: "existing:0",
    allow_module_imports: true,
    mode: null,
    max_bytes: maxBytes,
  }
}

const server = row("server_surface", 6144)
const nav = {
  source_key: "navigation_integration",
  operation_id: "op_1",
  operation_index: 1,
  obligation: "navigation_integration",
  kind: "replacement",
  slot: "existing:1",
  allow_module_imports: false,
  mode: null,
  max_bytes: 2048,
}

const ordinary = validatePythonUnitsContract([{
  kind: "function",
  name: "report",
  parameters: "",
  returns: "Response",
  decorators: ["route"],
  suite: ["if ready:\n    return result", "return None"],
}])
assert.equal(ordinary.ok, true, JSON.stringify(ordinary))

const singleton = deriveTypedPythonRepairModelCapacity({
  row: server,
  frontierRows: [server],
})
assert.equal(singleton.ok, true, JSON.stringify(singleton))
assert.equal(singleton.capacity_profile.protocol, PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL)
assert.equal(singleton.capacity_profile.derivation, "frontier_share_semantic_allocation_v1")
assert.equal(singleton.capacity_profile.frontier_source_count, 1)
assert.equal(singleton.capacity_profile.frontier_source_capacity_bytes, 6144)
assert.equal(singleton.capacity_profile.frontier_generation_envelope_bytes, 5120)
assert.equal(singleton.capacity_profile.row_frontier_share_bytes, 5120)
assert.equal(singleton.capacity_profile.serialized_max_bytes, 5120)
assert.equal(singleton.capacity_profile.max_units, 2)
assert.equal(singleton.capacity_profile.suite_max_items, 4)
assert.equal(singleton.capacity_profile.suite_chunk_max_chars, 380)
assert.equal(singleton.capacity_profile.suite_total_chars_per_unit, 1520)

const pressured = deriveTypedPythonRepairModelCapacity({
  row: server,
  frontierRows: [server, nav],
})
assert.equal(pressured.ok, true, JSON.stringify(pressured))
assert.equal(pressured.capacity_profile.frontier_source_count, 2)
assert.equal(pressured.capacity_profile.frontier_source_capacity_bytes, 8192)
assert.equal(pressured.capacity_profile.frontier_generation_envelope_bytes, 6144)
assert.equal(pressured.capacity_profile.row_frontier_share_bytes, 4608)
assert.equal(pressured.capacity_profile.serialized_max_bytes, 4608)
assert.ok(
  pressured.capacity_profile.serialized_max_bytes <
  singleton.capacity_profile.serialized_max_bytes,
)

const sameA = deriveTypedPythonRepairModelCapacity({
  row: server,
  frontierRows: [server, nav],
  repo_files: 4,
  repo_bytes: 1000,
})
const sameB = deriveTypedPythonRepairModelCapacity({
  row: server,
  frontierRows: [nav, server],
  repo_files: 1000000,
  repo_bytes: 10 ** 12,
})
assert.deepEqual(sameA.capacity_profile, sameB.capacity_profile)
assert.equal(sameA.capacity_profile.repo_size_authority, false)
assert.equal(sameA.capacity_profile.wall_time_widening_authority, false)
assert.equal(sameA.capacity_profile.governor_widening_authority, false)

const authority = {
  protocol: PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
  authority: "source_backed",
  allowed_fields: ["returns"],
  source_sha256: SHA,
  model_authority: false,
  mutation_authority: false,
}
const withReturns = deriveTypedPythonRepairModelCapacity({
  row: server,
  frontierRows: [server],
  fieldAuthority: authority,
})
assert.equal(withReturns.ok, true)
assert.equal(withReturns.capacity_profile.returns_authorized, true)
assert.equal(
  withReturns.capacity_profile.serialized_max_bytes,
  singleton.capacity_profile.serialized_max_bytes,
)
assert.ok(
  withReturns.capacity_profile.suite_total_chars_per_unit <=
  singleton.capacity_profile.suite_total_chars_per_unit,
)

const compiled = compileTypedPythonRepairSourceSchema({
  row: server,
  frontierRows: [server],
})
assert.equal(compiled.ok, true, JSON.stringify(compiled))
assert.equal(
  compiled.capacity_profile.profile_sha256,
  singleton.capacity_profile.profile_sha256,
)
assert.equal(compiled.schema.properties.units.maxItems, singleton.capacity_profile.max_units)

const union =
  compiled.schema.properties.units.items.oneOf ??
  compiled.schema.properties.units.items.anyOf
for (const branch of union) {
  assert.equal(branch.properties.name.maxLength, singleton.capacity_profile.name_max_chars)
  assert.equal(branch.properties.parameters.maxLength, singleton.capacity_profile.parameters_max_chars)
  assert.equal(branch.properties.decorators.maxItems, singleton.capacity_profile.decorator_max_items)
  assert.equal(branch.properties.decorators.items.maxLength, singleton.capacity_profile.decorator_max_chars)
  assert.equal(branch.properties.suite.maxItems, singleton.capacity_profile.suite_max_items)
  assert.equal(branch.properties.suite.items.maxLength, singleton.capacity_profile.suite_chunk_max_chars)
  assert.equal(Object.hasOwn(branch.properties, "returns"), false)
}
assert.match(compiled.schema.description, /capacity_derivation=frontier_share_semantic_allocation_v1/)
assert.match(compiled.schema.description, /repo_size_widening=false/)

const tool = {
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      sources: {
        type: "object",
        additionalProperties: false,
        properties: { server_surface: compiled.schema },
        required: ["server_surface"],
      },
    },
    required: ["sources"],
  },
}
const frontier = deriveSourceSlotSchemaFrontier(tool)
assert.equal(frontier.ok, true, JSON.stringify(frontier))
assert.equal(frontier.active_source_capacity_bytes, 6144)
assert.equal(frontier.active_model_generation_capacity_bytes, 5120)
assert.equal(frontier.model_generation_fraction, 5120 / 16384)

const valid = {
  units: [{
    kind: "function",
    name: "report",
    parameters: "date, report_type",
    decorators: ["bp.route('/report')"],
    suite: [
      "report_date = date",
      "if not report_date:\n    return None",
      "return report_date",
    ],
  }],
}
const admitted = validateTypedPythonRepairSource(valid, {
  fieldAuthority: compiled.field_authority,
  capacityProfile: compiled.capacity_profile,
})
assert.equal(admitted.ok, true, JSON.stringify(admitted))

const oversized = {
  units: [{
    kind: "function",
    name: "report",
    parameters: "",
    suite: ["x".repeat(singleton.capacity_profile.suite_chunk_max_chars + 1)],
  }],
}
const oversizedResult = validateTypedPythonRepairSource(oversized, {
  fieldAuthority: compiled.field_authority,
  capacityProfile: compiled.capacity_profile,
})
assert.equal(oversizedResult.ok, false)
assert.equal(oversizedResult.reason, "source_slot_typed_repair_suite_budget_exceeded")

const tampered = {
  ...singleton.capacity_profile,
  suite_chunk_max_chars: singleton.capacity_profile.suite_chunk_max_chars + 1,
}
const tamperedResult = validateTypedPythonRepairModelCapacity(valid.units, tampered)
assert.equal(tamperedResult.ok, false)
assert.equal(tamperedResult.reason, "source_slot_typed_repair_capacity_profile_invalid")

console.log(
  "PASS R7-R17-R3 adaptive frontier repair capacity " +
  "singleton=5120 pressured=4608 canonical_frontier=6144 model_frontier=5120 " +
  "field_authority=accounted repo_size_widening=false profile=hash_sealed " +
  "schema_runtime=shared model_calls_added=0 mutation_authority=false",
)
