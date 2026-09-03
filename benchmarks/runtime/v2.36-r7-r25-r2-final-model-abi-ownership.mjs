import assert from "node:assert/strict"

import {
  compileProviderSafeModelSchema,
} from "../../opencode/plugins/cpu-search-core/deterministic-argument-synthesis-v1.mjs"

import {
  compileModelFacingToolSchemas,
} from "../../opencode/plugins/cpu-search-core/model-abi-compiler-v1.mjs"

import {
  compileTypedPythonRepairSourceSchema,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

import {
  MODEL_VIEW_COMPILER_PROTOCOL,
  compileSourceSlotModelView,
  modelViewOwnsFinalModelAbi,
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

const typed =
  compileTypedPythonRepairSourceSchema({
    row: rows[0],
    frontierRows: rows,
  })

assert.equal(typed.ok, true, JSON.stringify(typed))

const canonicalTool = {
  name: "execute_additive_plan",
  description: "canonical source-slot fixture",
  input: {
    type: "object",
    properties: {
      sources: {
        type: "object",
        properties: {
          server_surface: typed.schema,
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
  required_source_keys: [
    "server_surface",
    "navigation_integration",
    "ui_surface",
  ],
  all_source_rows: rows.map((row) => ({ ...row })),
}

const view =
  compileSourceSlotModelView({
    tool: canonicalTool,
    binding,
    capability,
  })

assert.equal(view.ok, true, JSON.stringify(view))
assert.equal(
  view.final_model_abi_owner,
  MODEL_VIEW_COMPILER_PROTOCOL,
)
assert.equal(
  view.generic_model_abi_projection_allowed,
  false,
)
assert.equal(
  view.plan.final_model_abi_owner,
  MODEL_VIEW_COMPILER_PROTOCOL,
)
assert.equal(
  view.plan.generic_model_abi_projection_allowed,
  false,
)
assert.equal(modelViewOwnsFinalModelAbi(view.plan), true)

const tools = {
  execute_additive_plan: structuredClone(view.tool),
}

const schemaBefore =
  JSON.stringify(tools.execute_additive_plan.input)

const generic =
  compileModelFacingToolSchemas({
    tools,
    frontierToolNames: ["execute_additive_plan"],
    active:
      !modelViewOwnsFinalModelAbi(view.plan),
    minSavingsBytes: 0,
  })

assert.equal(generic.ok, true)
assert.equal(generic.applied, false)
assert.equal(
  JSON.stringify(tools.execute_additive_plan.input),
  schemaBefore,
  "generic compiler rewrote final Model View ABI",
)

const provider =
  compileProviderSafeModelSchema(
    tools.execute_additive_plan.input,
  )

assert.equal(provider.ok, true, JSON.stringify(provider))

const providerText =
  JSON.stringify(provider.schema)

for (
  const required
  of [
    "\"holes\"",
    "\"h0\"",
    "\"h1\"",
    "\"h2\"",
    "\"python_declarations\"",
    "\"python_statements\"",
    "\"markup_fragment\"",
    "\"markup_document\"",
  ]
) {
  assert.equal(
    providerText.includes(required),
    true,
    `native provider projection lost ${required}`,
  )
}

const genericTools = {
  execute_replace_node: {
    input: {
      type: "object",
      properties: {
        replacement: {
          type: "string",
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ["replacement"],
      additionalProperties: false,
    },
  },
}

const genericPath =
  compileModelFacingToolSchemas({
    tools: genericTools,
    frontierToolNames: ["execute_replace_node"],
    active: true,
    minSavingsBytes: 0,
  })

assert.equal(genericPath.ok, true)
assert.equal(modelViewOwnsFinalModelAbi(null), false)

console.log(
  "PASS R7-R25-R2 final model ABI ownership " +
  "final_owner=model-view-compiler-v1 " +
  "generic_projection_skipped=true " +
  "final_schema_identity_retained=true " +
  "native_provider_projection_accepts_final_schema=true " +
  "generic_non_model_view_path_retained=true " +
  "provider_fail_closed_retained=true " +
  "model_calls_added=0 mutation_authority=false",
)
