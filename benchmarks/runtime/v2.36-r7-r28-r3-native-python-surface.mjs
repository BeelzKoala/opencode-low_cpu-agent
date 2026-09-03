import assert from "node:assert/strict"

import {
  compileSourceSlotModelView,
  normalizeSourceSlotModelViewRequest,
} from "../../opencode/plugins/cpu-search-core/model-view-compiler-v1.mjs"

import {
  ATOMIC_MODEL_VIEW_PROTOCOL,
  NATIVE_PYTHON_BODY_SURFACE_PROTOCOL,
  accumulateAtomicModelViewRequest,
  compileAtomicModelViewProjection,
  nativePythonBodySurfaceEnabled,
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

const priorCodec = process.env.OPENCODE_CPU_PYTHON_SURFACE_CODEC

try {
  delete process.env.OPENCODE_CPU_PYTHON_SURFACE_CODEC
  assert.equal(nativePythonBodySurfaceEnabled(), false)

  const legacy = compileAtomicModelViewProjection({
    tool: view.tool,
    plan: view.plan,
    turnID: "turn:legacy",
  })
  assert.equal(legacy.ok, true, JSON.stringify(legacy))
  assert.equal(legacy.current_representation, "python_units")
  const legacyDecl =
    legacy.tool.input.properties.holes.properties.h0
      .properties.python_declarations.items
  assert.ok(legacyDecl.properties.python_statements)
  assert.equal(legacyDecl.properties.body, undefined)

  process.env.OPENCODE_CPU_PYTHON_SURFACE_CODEC =
    "native_body_v1"
  assert.equal(nativePythonBodySurfaceEnabled(), true)

  const turnID = "turn:native"
  const first = compileAtomicModelViewProjection({
    tool: view.tool,
    plan: view.plan,
    turnID,
  })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.protocol, ATOMIC_MODEL_VIEW_PROTOCOL)
  assert.equal(first.current_hole, "h0")
  assert.equal(
    first.current_representation,
    "python_declaration_body_native",
  )
  assert.equal(
    first.current_canonical_representation,
    "python_units",
  )
  assert.equal(
    first.current_surface_codec,
    NATIVE_PYTHON_BODY_SURFACE_PROTOCOL,
  )

  const nativeDecl =
    first.tool.input.properties.holes.properties.h0
      .properties.python_declarations.items
  assert.ok(nativeDecl.properties.body)
  assert.equal(nativeDecl.properties.body.type, "string")
  assert.equal(nativeDecl.properties.python_statements, undefined)
  assert.ok(nativeDecl.required.includes("body"))
  assert.equal(nativeDecl.required.includes("python_statements"), false)

  const accepted0 = accumulateAtomicModelViewRequest({
    plan: view.plan,
    assembly: first.assembly,
    request: {
      holes: {
        h0: {
          python_declarations: [
            {
              declaration_kind: "function",
              name: "report_export",
              signature: "",
              body:
                "result = {}\n" +
                "    for row in rows:\n" +
                "        result[row] = result.get(row, 0) + 1\n" +
                "    return result",
            },
          ],
        },
      },
    },
    turnID,
  })
  assert.equal(accepted0.ok, true, JSON.stringify(accepted0))
  assert.equal(accepted0.complete, false)
  assert.equal(accepted0.accepted_hole, "h0")
  assert.equal(accepted0.next_hole, "h1")
  assert.equal(
    accepted0.surface_codec,
    NATIVE_PYTHON_BODY_SURFACE_PROTOCOL,
  )
  assert.equal(
    accepted0.surface_normalization[0].normalization_kind,
    "tail_base_dedent",
  )
  assert.equal(
    accepted0.assembly.holes.h0
      .python_declarations[0]
      .python_statements[0],
    "result = {}\n" +
      "for row in rows:\n" +
      "    result[row] = result.get(row, 0) + 1\n" +
      "return result",
  )

  // A model can still try to repeat the owned declaration wrapper inside
  // body. Lowering does not hide this: unchanged R26 derived-semantic
  // admission sees the canonical python_statements and rejects it.
  const duplicate = accumulateAtomicModelViewRequest({
    plan: view.plan,
    assembly: first.assembly,
    request: {
      holes: {
        h0: {
          python_declarations: [
            {
              declaration_kind: "function",
              name: "report_export",
              signature: "",
              body:
                "def report_export():\n" +
                "    return 1",
            },
          ],
        },
      },
    },
    turnID,
  })
  assert.equal(duplicate.ok, false, JSON.stringify(duplicate))
  assert.equal(
    duplicate.reason,
    "model_view_candidate_structural_contract_violation",
  )

  const second = compileAtomicModelViewProjection({
    tool: view.tool,
    plan: view.plan,
    assembly: accepted0.assembly,
    turnID,
  })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.current_hole, "h1")
  assert.equal(second.current_representation, "markup_fragment")
  assert.equal(second.current_surface_codec, "canonical_model_view")

  const accepted1 = accumulateAtomicModelViewRequest({
    plan: view.plan,
    assembly: accepted0.assembly,
    request: {
      holes: {
        h1: {
          markup_fragment:
            '<li><a href="/report">Report</a></li>',
        },
      },
    },
    turnID,
  })
  assert.equal(accepted1.ok, true, JSON.stringify(accepted1))
  assert.equal(accepted1.complete, false)

  const third = compileAtomicModelViewProjection({
    tool: view.tool,
    plan: view.plan,
    assembly: accepted1.assembly,
    turnID,
  })
  assert.equal(third.ok, true, JSON.stringify(third))
  assert.equal(third.current_hole, "h2")
  assert.equal(third.current_representation, "markup_document")

  const accepted2 = accumulateAtomicModelViewRequest({
    plan: view.plan,
    assembly: accepted1.assembly,
    request: {
      holes: {
        h2: {
          markup_document:
            "<!DOCTYPE html><html><body><h1>Report</h1></body></html>",
        },
      },
    },
    turnID,
  })
  assert.equal(accepted2.ok, true, JSON.stringify(accepted2))
  assert.equal(accepted2.complete, true)
  assert.equal(accepted2.accepted_count, 3)

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
  assert.equal(
    joined.request.sources.server_surface
      .units[0].suite[0],
    "result = {}\n" +
      "for row in rows:\n" +
      "    result[row] = result.get(row, 0) + 1\n" +
      "return result",
  )

  console.log(
    "PASS R7-R28-R3 native Python declaration-body surface " +
    "canonical_ir_unchanged=true " +
    "legacy_codec_retained=true " +
    "native_codec_opt_in=true " +
    "python_body_ast_guarded=true " +
    "tail_base_dedent=true " +
    "wrapper_duplicate_rejected_by_r26=true " +
    "markup_surfaces_unchanged=true " +
    "model_swap_routable=true " +
    "mutation_authority=false model_calls=0",
  )
} finally {
  if (priorCodec == null) {
    delete process.env.OPENCODE_CPU_PYTHON_SURFACE_CODEC
  } else {
    process.env.OPENCODE_CPU_PYTHON_SURFACE_CODEC = priorCodec
  }
}
