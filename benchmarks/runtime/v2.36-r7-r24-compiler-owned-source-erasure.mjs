import assert from "node:assert/strict"

import {
  compileTypedPythonRepairSourceSchema,
  deriveSourceSlotSchemaFrontier,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

import {
  SOURCE_SLOT_MODEL_HOLE_PROTOCOL,
  normalizeSourceSlotModelHoleRequest,
  projectSourceSlotModelHoles,
  sourceSlotModelHoleFailureIsNonRepairable,
} from "../../opencode/plugins/cpu-search-core/source-slot-model-hole-v1.mjs"

const rows = [
  {
    source_key: "server_surface",
    operation_id: "op_0",
    operation_index: 0,
    obligation: "server_surface",
    kind: "python_declaration",
    slot: "existing:0",
    max_bytes: 6144,
    allow_module_imports: true,
  },
  {
    source_key: "navigation_integration",
    operation_id: "op_1",
    operation_index: 1,
    obligation: "navigation_integration",
    kind: "replacement",
    slot: "existing:1",
    max_bytes: 2048,
  },
  {
    source_key: "ui_surface",
    operation_id: "op_2",
    operation_index: 2,
    obligation: "ui_surface",
    kind: "creation",
    slot: "create:0",
    max_bytes: 8192,
  },
]

const typed =
  compileTypedPythonRepairSourceSchema({
    row: rows[0],
    frontierRows: [rows[0]],
  })

assert.equal(
  typed.ok,
  true,
  JSON.stringify(typed),
)

const legacyTool = {
  name: "execute_additive_plan",
  description:
    "Legacy compiler-owned source-slot ABI.",
  input: {
    type: "object",
    properties: {
      sources: {
        type: "object",
        properties: {
          server_surface:
            typed.schema,
          navigation_integration: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
            description:
              "Source for obligation navigation_integration in existing:1 / op_1.",
          },
          ui_surface: {
            type: "string",
            minLength: 1,
            maxLength: 8192,
            description:
              "Source for obligation ui_surface in create:0 / op_2.",
          },
        },
        required: [
          "server_surface",
          "navigation_integration",
          "ui_surface",
        ],
        additionalProperties: false,
      },
    },
    required: ["sources"],
    additionalProperties: false,
  },
}

const binding = {
  binding_sha256: "a".repeat(64),
  source_spec_sha256: "b".repeat(64),
  required_source_keys: [
    "server_surface",
    "navigation_integration",
    "ui_surface",
  ],
  all_source_rows:
    rows.map((row) => ({ ...row })),
}

const bindingBefore =
  JSON.stringify(binding)

const projected =
  projectSourceSlotModelHoles({
    tool: legacyTool,
    binding,
  })

assert.equal(
  projected.ok,
  true,
  JSON.stringify(projected),
)
assert.equal(
  projected.protocol,
  SOURCE_SLOT_MODEL_HOLE_PROTOCOL,
)
assert.equal(
  projected.compiler_identity_fields_exposed,
  0,
)

assert.equal(
  JSON.stringify(binding),
  bindingBefore,
  "canonical binding mutated",
)

const schema =
  projected.tool.input

assert.equal(
  schema.properties.sources,
  undefined,
)
assert.deepEqual(
  Object.keys(
    schema.properties.holes.properties,
  ).sort(),
  ["h0", "h1", "h2"],
)
assert.deepEqual(
  schema.properties.holes.required,
  ["h0", "h1", "h2"],
)

const modelSurface =
  JSON.stringify(projected.tool)

for (
  const forbidden of [
    "server_surface",
    "navigation_integration",
    "ui_surface",
    "op_0",
    "op_1",
    "op_2",
    "existing:0",
    "existing:1",
    "create:0",
  ]
) {
  assert.equal(
    modelSurface.includes(forbidden),
    false,
    `compiler identity leaked to model surface: ${forbidden}`,
  )
}

assert.match(
  projected.tool.description,
  /h0=python_declaration/u,
)
assert.match(
  projected.tool.description,
  /h1=replacement/u,
)
assert.match(
  projected.tool.description,
  /h2=creation/u,
)
assert.match(
  projected.tool.description,
  /compiler owns files, paths, slots, operation ids/u,
)

const frontier =
  deriveSourceSlotSchemaFrontier(
    projected.tool,
  )

assert.equal(
  frontier.ok,
  true,
  JSON.stringify(frontier),
)
assert.deepEqual(
  frontier.active_source_keys,
  ["h0", "h1", "h2"],
)

const normalized =
  normalizeSourceSlotModelHoleRequest({
    projection:
      projected.projection,
    request: {
      holes: {
        h0: {
          units: [
            {
              kind: "function",
              name: "build_report",
              parameters: "day: str",
              suite: ["return day"],
            },
          ],
        },
        h1:
          "<a href=\"resource://h2\">Report</a>",
        h2:
          "<html><body>Report</body></html>",
      },
    },
  })

assert.equal(
  normalized.ok,
  true,
  JSON.stringify(normalized),
)

assert.deepEqual(
  Object.keys(
    normalized.request.sources,
  ).sort(),
  [
    "navigation_integration",
    "server_surface",
    "ui_surface",
  ],
)

assert.equal(
  normalized
    .request
    .sources
    .navigation_integration,
  "<a href=\"resource://ui_surface\">Report</a>",
)

assert.equal(
  normalized.model_file_authority,
  false,
)
assert.equal(
  normalized.model_slot_authority,
  false,
)
assert.equal(
  normalized.model_operation_authority,
  false,
)

const directLegacyShape =
  normalizeSourceSlotModelHoleRequest({
    projection:
      projected.projection,
    request: {
      sources: {
        navigation_integration:
          "templates/snippets/menu.html",
      },
    },
  })

assert.equal(
  directLegacyShape.ok,
  false,
)
assert.equal(
  directLegacyShape.reason,
  "source_slot_model_hole_request_invalid",
)

const identityReference =
  normalizeSourceSlotModelHoleRequest({
    projection:
      projected.projection,
    request: {
      holes: {
        h0: {
          units: [
            {
              kind: "function",
              name: "x",
              parameters: "",
              suite: ["return 1"],
            },
          ],
        },
        h1: "resource://ui_surface",
        h2: "<html></html>",
      },
    },
  })

assert.equal(
  identityReference.ok,
  false,
)
assert.equal(
  identityReference.reason,
  "source_slot_model_resource_identity_forbidden",
)

assert.equal(
  sourceSlotModelHoleFailureIsNonRepairable(
    "source_slot_compiler_owned_value_echo",
  ),
  true,
)
assert.equal(
  sourceSlotModelHoleFailureIsNonRepairable(
    "source_slot_model_hole_keys_invalid",
  ),
  true,
)
assert.equal(
  sourceSlotModelHoleFailureIsNonRepairable(
    "semantic_python_binding_unresolved",
  ),
  false,
)

// Future-proofing: repair keeps the original global operation index,
// so h1 remains h1 instead of being renumbered to h0.
const repairTool = {
  ...legacyTool,
  input: {
    type: "object",
    properties: {
      sources: {
        type: "object",
        properties: {
          navigation_integration:
            legacyTool
              .input
              .properties
              .sources
              .properties
              .navigation_integration,
        },
        required: [
          "navigation_integration",
        ],
        additionalProperties: false,
      },
    },
    required: ["sources"],
    additionalProperties: false,
  },
}

const repairBinding = {
  ...binding,
  required_source_keys: [
    "navigation_integration",
  ],
}

const repairProjection =
  projectSourceSlotModelHoles({
    tool: repairTool,
    binding: repairBinding,
  })

assert.equal(
  repairProjection.ok,
  true,
  JSON.stringify(repairProjection),
)
assert.deepEqual(
  repairProjection
    .projection
    .required_holes,
  ["h1"],
)

console.log(
  "PASS R7-R24 compiler-owned source erasure " +
  "model_abi=opaque_holes " +
  "compiler_identity_fields_exposed=0 " +
  "stable_hole_ids=true " +
  "sealed_binding_unchanged=true " +
  "deterministic_join=true " +
  "cross_hole_refs=true " +
  "owned_value_echo_repair=false " +
  "legacy_internal_contract=retained " +
  "model_calls_added=0 mutation_authority=false",
)
