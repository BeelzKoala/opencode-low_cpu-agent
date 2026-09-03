import assert from "node:assert/strict"

import {
  PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
  compileTypedPythonRepairSourceSchema,
  deriveTypedPythonRepairFieldAuthority,
  validateTypedPythonRepairSource,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

import {
  validatePythonUnitsContract,
} from "../../opencode/plugins/cpu-search-core/python-unit-contract-v1.mjs"

const SHA = "a".repeat(64)

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

const globalContract =
  validatePythonUnitsContract([
    {
      kind: "function",
      name: "report",
      parameters: "",
      returns: "Response",
      decorators: ["route"],
      suite: ["return 1"],
    },
  ])

assert.equal(
  globalContract.ok,
  true,
  JSON.stringify(globalContract),
)

const defaultAuthority =
  deriveTypedPythonRepairFieldAuthority()

assert.equal(defaultAuthority.ok, true)
assert.deepEqual(
  defaultAuthority.field_authority.allowed_fields,
  [],
)
assert.equal(
  defaultAuthority.field_authority.authority,
  "default_closed",
)

const closedSchema =
  compileTypedPythonRepairSourceSchema({
    row,
  })

assert.equal(
  closedSchema.ok,
  true,
  JSON.stringify(closedSchema),
)
assert.deepEqual(
  closedSchema.field_authority.allowed_fields,
  [],
)
assert.match(
  closedSchema.schema.description,
  /returns_authority=default_closed/,
)

const closedUnion =
  closedSchema.schema.properties.units.items.oneOf ??
  closedSchema.schema.properties.units.items.anyOf

for (const branch of closedUnion) {
  assert.equal(
    Object.hasOwn(
      branch.properties,
      "returns",
    ),
    false,
  )
  assert.equal(
    Object.hasOwn(
      branch.properties,
      "parameters",
    ),
    true,
  )
  assert.equal(
    Object.hasOwn(
      branch.properties,
      "decorators",
    ),
    true,
  )
}

const rejected =
  validateTypedPythonRepairSource(
    {
      units: [
        {
          kind: "function",
          name: "report",
          parameters: "",
          returns: "Response",
          suite: ["return 1"],
        },
      ],
    },
    {
      fieldAuthority:
        closedSchema.field_authority,
    },
  )

assert.equal(rejected.ok, false)
assert.equal(
  rejected.reason,
  "source_slot_typed_repair_field_unauthorized",
)
assert.equal(rejected.field, "returns")
assert.equal(rejected.unit_index, 0)

const evidenceCapsule = {
  python_unit_field_authority: {
    protocol:
      PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
    authority: "source_backed",
    allowed_fields: ["returns"],
    source_sha256: SHA,
    model_authority: false,
    mutation_authority: false,
  },
}

const openSchema =
  compileTypedPythonRepairSourceSchema({
    row,
    repairCapsule: evidenceCapsule,
  })

assert.equal(
  openSchema.ok,
  true,
  JSON.stringify(openSchema),
)
assert.deepEqual(
  openSchema.field_authority.allowed_fields,
  ["returns"],
)
assert.equal(
  openSchema.field_authority.source_sha256,
  SHA,
)
assert.match(
  openSchema.schema.description,
  /returns_authority=source_backed/,
)

const openUnion =
  openSchema.schema.properties.units.items.oneOf ??
  openSchema.schema.properties.units.items.anyOf

for (const branch of openUnion) {
  assert.equal(
    Object.hasOwn(
      branch.properties,
      "returns",
    ),
    true,
  )
}

const accepted =
  validateTypedPythonRepairSource(
    {
      units: [
        {
          kind: "function",
          name: "report",
          parameters: "",
          returns: "Response",
          suite: ["return 1"],
        },
      ],
    },
    {
      fieldAuthority:
        openSchema.field_authority,
    },
  )

assert.equal(
  accepted.ok,
  true,
  JSON.stringify(accepted),
)

for (const malformed of [
  {
    python_unit_field_authority: {
      protocol:
        PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
      authority: "source_backed",
      allowed_fields: ["returns"],
      source_sha256: "bad",
      model_authority: false,
      mutation_authority: false,
    },
  },
  {
    python_unit_field_authority: {
      protocol:
        PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
      authority: "source_backed",
      allowed_fields: ["unknown"],
      source_sha256: SHA,
      model_authority: false,
      mutation_authority: false,
    },
  },
  {
    python_unit_field_authority: {
      protocol:
        PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
      authority: "source_backed",
      allowed_fields: ["returns"],
      source_sha256: SHA,
      model_authority: true,
      mutation_authority: false,
    },
  },
]) {
  const authority =
    deriveTypedPythonRepairFieldAuthority({
      repairCapsule: malformed,
    })
  assert.equal(authority.ok, false)
  assert.equal(
    authority.reason,
    "source_slot_typed_repair_field_authority_invalid",
  )
}

console.log(
  "PASS R7-R16-R1 evidence-derived repair field authority " +
  "global_contract=unchanged default=closed " +
  "source_backed_returns=allowed malformed_evidence=fail_closed " +
  "parameters=preserved decorators=preserved " +
  "binding_authority=hash_bound model_calls_added=0 " +
  "mutation_authority=false",
)
