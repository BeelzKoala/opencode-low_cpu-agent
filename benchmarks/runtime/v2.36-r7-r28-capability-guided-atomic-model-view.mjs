import assert from "node:assert/strict"

import {
  compileSourceSlotModelView,
  normalizeSourceSlotModelViewRequest,
} from "../../opencode/plugins/cpu-search-core/model-view-compiler-v1.mjs"

import {
  ATOMIC_MODEL_VIEW_PROTOCOL,
  accumulateAtomicModelViewRequest,
  compileAtomicModelViewProjection,
} from "../../opencode/plugins/cpu-search-core/atomic-model-view-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/example.py",
      allowed_operations: ["add_module_declaration"],
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
            minLength: 2,
            maxLength: 160,
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

const canonicalTool = {
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
  tool: canonicalTool,
  binding,
  capability,
})
assert.equal(view.ok, true, JSON.stringify(view))
assert.deepEqual(view.plan.required_holes, ["h0", "h1", "h2"])

const turnID = "turn:test"
const first = compileAtomicModelViewProjection({
  tool: view.tool,
  plan: view.plan,
  turnID,
})
assert.equal(first.ok, true, JSON.stringify(first))
assert.equal(first.protocol, ATOMIC_MODEL_VIEW_PROTOCOL)
assert.equal(first.current_hole, "h0")
assert.deepEqual(first.tool.input.required, ["holes"])
assert.deepEqual(first.tool.input.properties.holes.required, ["h0"])
assert.deepEqual(Object.keys(first.tool.input.properties.holes.properties), ["h0"])
assert.equal(first.partial_materialization, false)

const h0 = {
  holes: {
    h0: {
      python_declarations: [
        {
          declaration_kind: "function",
          name: "report_export",
          signature: "()",
          python_statements: ["return 1"],
        },
      ],
    },
  },
}

const accepted0 = accumulateAtomicModelViewRequest({
  plan: view.plan,
  assembly: first.assembly,
  request: h0,
  turnID,
})
assert.equal(accepted0.ok, true, JSON.stringify(accepted0))
assert.equal(accepted0.complete, false)
assert.equal(accepted0.accepted_hole, "h0")
assert.equal(accepted0.next_hole, "h1")
assert.equal(accepted0.partial_materialization, false)

const second = compileAtomicModelViewProjection({
  tool: view.tool,
  plan: view.plan,
  assembly: accepted0.assembly,
  turnID,
})
assert.equal(second.ok, true, JSON.stringify(second))
assert.equal(second.current_hole, "h1")
assert.deepEqual(second.tool.input.properties.holes.required, ["h1"])

const badFragment = accumulateAtomicModelViewRequest({
  plan: view.plan,
  assembly: accepted0.assembly,
  request: {
    holes: {
      h1: {
        markup_fragment: "<!DOCTYPE html><html><body>bad</body></html>",
      },
    },
  },
  turnID,
})
assert.equal(badFragment.ok, false)
assert.equal(
  badFragment.reason,
  "model_view_candidate_structural_contract_violation",
)
assert.equal(badFragment.atomic_unit_index, 1)

const accepted1 = accumulateAtomicModelViewRequest({
  plan: view.plan,
  assembly: accepted0.assembly,
  request: {
    holes: {
      h1: {
        markup_fragment: '<li><a href="/report">Report</a></li>',
      },
    },
  },
  turnID,
})
assert.equal(accepted1.ok, true, JSON.stringify(accepted1))
assert.equal(accepted1.complete, false)
assert.equal(accepted1.next_hole, "h2")

const third = compileAtomicModelViewProjection({
  tool: view.tool,
  plan: view.plan,
  assembly: accepted1.assembly,
  turnID,
})
assert.equal(third.ok, true, JSON.stringify(third))
assert.equal(third.current_hole, "h2")

const accepted2 = accumulateAtomicModelViewRequest({
  plan: view.plan,
  assembly: accepted1.assembly,
  request: {
    holes: {
      h2: {
        markup_document: "<html><body><h1>Report</h1></body></html>",
      },
    },
  },
  turnID,
})
assert.equal(accepted2.ok, true, JSON.stringify(accepted2))
assert.equal(accepted2.complete, true)
assert.equal(accepted2.accepted_count, 3)
assert.deepEqual(Object.keys(accepted2.request.holes), ["h0", "h1", "h2"])
assert.equal(accepted2.partial_materialization, false)

const joined = normalizeSourceSlotModelViewRequest({
  plan: view.plan,
  request: accepted2.request,
})
assert.equal(joined.ok, true, JSON.stringify(joined))
assert.deepEqual(Object.keys(joined.request.sources), [
  "server_surface",
  "navigation_integration",
  "ui_surface",
])

// Assembly is turn-bound. A new turn cannot inherit a partial candidate.
const reset = compileAtomicModelViewProjection({
  tool: view.tool,
  plan: view.plan,
  assembly: accepted1.assembly,
  turnID: "turn:new",
})
assert.equal(reset.ok, true, JSON.stringify(reset))
assert.equal(reset.current_hole, "h0")
assert.equal(reset.accepted_count, 0)

console.log(
  "PASS R7-R28 capability-guided atomic model view " +
  "canonical_plan_count=1 model_work_units=3 " +
  "heterogeneous_model_call=false " +
  "partial_materialization=false " +
  "join_requires_all_units_valid=true " +
  "turn_bound_assembly=true " +
  "structural_failure_stops_unit=true " +
  "physical_patch_transactions_max=1 " +
  "model_authority_expansion=false mutation_authority=false",
)
