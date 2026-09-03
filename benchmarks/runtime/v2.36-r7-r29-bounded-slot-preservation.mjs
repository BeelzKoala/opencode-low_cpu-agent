import assert from "node:assert/strict"

import {
  compileSourceSlotModelView,
  projectModelViewControlContext,
} from "../../opencode/plugins/cpu-search-core/model-view-compiler-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/example.py",
      allowed_operations: [
        "add_module_declaration",
        "add_imports",
      ],
      roles: ["task_anchor_owner"],
    },
    {
      slot: "existing:1",
      file: "templates/nav.html",
      allowed_operations: ["replace_exact"],
      roles: ["navigation_host"],
    },
  ],
  create_slots: [
    {
      slot: "create:0",
      allowed_operations: ["create_file"],
      allowed_extensions: [".html"],
      roles: ["ui_host"],
    },
  ],
}

const rows = [
  {
    source_key: "server_surface",
    operation_id: "op_0",
    operation_index: 0,
    obligation: "server_surface",
    kind: "python_declaration",
    slot: "existing:0",
    allow_module_imports: true,
    max_bytes: 6144,
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

const pythonUnitSchema = {
  type: "object",
  properties: {
    units: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["function", "async_function"],
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 80,
          },
          parameters: {
            type: "string",
            minLength: 0,
            maxLength: 160,
          },
          returns: {
            type: "string",
            minLength: 1,
            maxLength: 160,
          },
          decorators: {
            type: "array",
            maxItems: 8,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
          },
          suite: {
            type: "array",
            minItems: 1,
            maxItems: 24,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 800,
            },
          },
        },
        required: ["kind", "name", "parameters", "suite"],
        additionalProperties: false,
      },
    },
  },
  required: ["units"],
  additionalProperties: false,
}

const tool = {
  name: "execute_additive_plan",
  description: "canonical fixture",
  input: {
    type: "object",
    properties: {
      sources: {
        type: "object",
        properties: {
          server_surface: pythonUnitSchema,
          navigation_integration: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
          },
          ui_surface: {
            type: "string",
            minLength: 1,
            maxLength: 8192,
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
  binding_sha256: "c".repeat(64),
  source_spec_sha256: "d".repeat(64),
  required_source_keys: rows.map((row) => row.source_key),
  all_source_rows: rows.map((row) => ({ ...row })),
}

const view = compileSourceSlotModelView({
  tool,
  binding,
  capability,
})
assert.equal(view.ok, true, JSON.stringify(view))
assert.deepEqual(view.plan.required_holes, ["h0", "h1", "h2"])

const [pythonRow, navRow, createRow] = view.plan.rows
assert.equal(
  pythonRow.semantic_contract.preservation_mode,
  "preserve_unmentioned_semantics",
)
assert.equal(
  navRow.semantic_contract.preservation_mode,
  "preserve_unmentioned_semantics",
)
assert.equal(
  createRow.semantic_contract.preservation_mode,
  "not_applicable",
)
assert.equal(
  pythonRow.semantic_contract.preservation_scope,
  "bounded_slot",
)
assert.equal(
  pythonRow.semantic_contract.allowed_delta_authority,
  "deterministic_verifier_only",
)

// Policy is private compiler state: same bounded holes, no second model ABI.
const schemaText = JSON.stringify(view.tool.input)
assert.equal(schemaText.includes("preservation_mode"), false)
assert.equal(schemaText.includes("allowed_delta_authority"), false)
assert.equal(schemaText.includes("server_surface"), false)
assert.equal(schemaText.includes("navigation_integration"), false)
assert.deepEqual(Object.keys(view.tool.input.properties), ["holes"])

const control = {
  applied: true,
  control_context_applied: true,
  reason: "mutation_phase_compiled_structured_control",
  system: [[
    "ACTION=execute_additive_plan",
    "REQUIRED=id=op_0 obligation=server_surface kind=python_declaration payload=content",
    "REQUIRED=id=op_1 obligation=navigation_integration kind=replacement payload=content",
    "REQUIRED=id=op_2 obligation=ui_surface kind=creation payload=content",
    "PYTHON_FUNCTION_SUITE=body_statements_only",
    "PYTHON_DECLARATION_WRAPPER_IN_SUITE=forbidden",
  ].join("\n")],
  messages: [],
}

const projected = projectModelViewControlContext(control, view.plan)
assert.equal(projected.applied, true, JSON.stringify(projected))

const text = JSON.stringify(projected.system)
assert.equal(
  text.includes(
    "preservation_mode=preserve_unmentioned_semantics " +
    "preservation_scope=bounded_slot " +
    "allowed_delta_authority=deterministic_verifier_only",
  ),
  false,
)
assert.equal(
  text.includes(
    "preservation_mode=not_applicable " +
    "preservation_scope=bounded_slot " +
    "allowed_delta_authority=deterministic_verifier_only",
  ),
  false,
)
assert.equal(text.includes("server_surface"), false)
assert.equal(text.includes("navigation_integration"), false)
assert.equal(projected.model_view_control_namespace, "hole_only")

console.log(
  "PASS R29 bounded-slot preservation " +
  "single_model_protocol=true preservation_via_existing_holes=true " +
  "policy_private=true compiler_identity_fields_exposed=0 " +
  "model_calls_added=0 mutation_authority=false",
)
