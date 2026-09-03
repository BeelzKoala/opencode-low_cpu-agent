import assert from "node:assert/strict"

import {
  compileProviderSafeModelSchema,
} from "../../opencode/plugins/cpu-search-core/deterministic-argument-synthesis-v1.mjs"

import {
  compileTypedPythonRepairSourceSchema,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

import {
  MODEL_VIEW_COMPILER_PROTOCOL,
  compileSourceSlotModelView,
  modelViewFailureIsNonRepairable,
  normalizeSourceSlotModelViewRequest,
  projectModelViewControlContext,
} from "../../opencode/plugins/cpu-search-core/model-view-compiler-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256:
    "a".repeat(64),
  authority_sha256:
    "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/example.py",
      allowed_operations: [
        "add_module_declaration",
        "add_imports",
      ],
      roles: [
        "task_anchor_owner",
      ],
    },
    {
      slot: "existing:1",
      file: "templates/nav.html",
      allowed_operations: [
        "replace_exact",
      ],
      roles: [
        "navigation_host",
      ],
    },
  ],
  create_slots: [
    {
      slot: "create:0",
      allowed_operations: [
        "create_file",
      ],
      allowed_extensions: [
        ".html",
      ],
      roles: [
        "ui_host",
      ],
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

assert.equal(
  typed.ok,
  true,
  JSON.stringify(typed),
)

const canonicalTool = {
  name: "execute_additive_plan",
  description:
    "canonical source slot tool",
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
              "navigation compiler identity description",
          },
          ui_surface: {
            type: "string",
            minLength: 1,
            maxLength: 8192,
            description:
              "ui compiler identity description",
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
  binding_sha256:
    "c".repeat(64),
  source_spec_sha256:
    "d".repeat(64),
  required_source_keys: [
    "server_surface",
    "navigation_integration",
    "ui_surface",
  ],
  all_source_rows:
    rows.map(
      (row) => ({ ...row }),
    ),
}

const bindingBefore =
  JSON.stringify(binding)
const canonicalBefore =
  JSON.stringify(canonicalTool)

const compiled =
  compileSourceSlotModelView({
    tool: canonicalTool,
    binding,
    capability,
  })

assert.equal(
  compiled.ok,
  true,
  JSON.stringify(compiled),
)
assert.equal(
  compiled.protocol,
  MODEL_VIEW_COMPILER_PROTOCOL,
)
assert.equal(
  compiled.compiler_identity_fields_exposed,
  0,
)
assert.equal(
  compiled.annotation_independent_semantics,
  true,
)
assert.equal(
  compiled.model_calls_added,
  0,
)
assert.equal(
  compiled.mutation_authority,
  false,
)

assert.equal(
  JSON.stringify(binding),
  bindingBefore,
)
assert.equal(
  JSON.stringify(canonicalTool),
  canonicalBefore,
)

const schema =
  compiled.tool.input

assert.deepEqual(
  schema.required,
  ["holes"],
)
assert.deepEqual(
  schema.properties.holes.required,
  ["h0", "h1", "h2"],
)

const h0 =
  schema
    .properties
    .holes
    .properties
    .h0

assert.ok(
  h0.properties
    .python_declarations,
)
assert.equal(
  h0.properties.units,
  undefined,
)

const pythonUnion =
  h0
    .properties
    .python_declarations
    .items
    .oneOf ??
  h0
    .properties
    .python_declarations
    .items
    .anyOf

assert.ok(
  Array.isArray(pythonUnion),
)

for (const branch of pythonUnion) {
  assert.ok(
    branch.properties
      .declaration_kind,
  )
  assert.ok(
    branch.properties
      .python_statements,
  )
  assert.equal(
    branch.properties.kind,
    undefined,
  )
  assert.equal(
    branch.properties.suite,
    undefined,
  )

  if (
    Object.prototype.hasOwnProperty.call(
      branch.properties,
      "parameters",
    )
  ) {
    assert.fail(
      "canonical parameters leaked",
    )
  }
}

assert.ok(
  schema
    .properties
    .holes
    .properties
    .h1
    .properties
    .markup_fragment,
)

assert.ok(
  schema
    .properties
    .holes
    .properties
    .h2
    .properties
    .markup_document,
)

const modelSchemaText =
  JSON.stringify(schema)

for (
  const forbidden
  of [
    "server_surface",
    "navigation_integration",
    "ui_surface",
    "op_0",
    "op_1",
    "op_2",
    "existing:0",
    "existing:1",
    "create:0",
    "\"description\"",
    "\"title\"",
    "\"$comment\"",
    "\"examples\"",
  ]
) {
  assert.equal(
    modelSchemaText.includes(
      forbidden,
    ),
    false,
    `model schema leaked ${forbidden}`,
  )
}

// Provider projection must preserve semantic property structure
// after every human annotation is already absent.
const provider =
  compileProviderSafeModelSchema(
    schema,
  )

assert.equal(
  provider.ok,
  true,
  JSON.stringify(provider),
)

const providerText =
  JSON.stringify(
    provider.schema,
  )

for (
  const required
  of [
    "\"holes\"",
    "\"h0\"",
    "\"h1\"",
    "\"h2\"",
    "\"python_declarations\"",
    "\"declaration_kind\"",
    "\"python_statements\"",
    "\"markup_fragment\"",
    "\"markup_document\"",
  ]
) {
  assert.equal(
    providerText.includes(required),
    true,
    `provider projection lost ${required}`,
  )
}

const control = {
  applied: true,
  control_context_applied: true,
  reason:
    "mutation_phase_compiled_structured_control",
  system: [
    [
      "CONTROL_CONTEXT protocol=control-context-layer-v1 authority=deterministic",
      "ACTION=execute_additive_plan",
      "REQUIRED=id=op_0 obligation=server_surface kind=python_declaration payload=content",
      "REQUIRED=id=op_1 obligation=navigation_integration kind=replacement payload=content",
      "REQUIRED=id=op_2 obligation=ui_surface kind=creation payload=content",
      "PYTHON_FUNCTION_SUITE=body_statements_only",
      "PYTHON_FUNCTION_PARAMETERS=python_signature_source_only",
      "PYTHON_FUNCTION_RETURNS=python_annotation_source_only",
      "PYTHON_DECLARATION_WRAPPER_IN_SUITE=forbidden",
    ].join("\n"),
  ],
  messages: [],
}

const projectedControl =
  projectModelViewControlContext(
    control,
    compiled.plan,
  )

assert.equal(
  projectedControl.applied,
  true,
  JSON.stringify(projectedControl),
)
assert.equal(
  projectedControl
    .model_view_applied,
  true,
)
assert.equal(
  projectedControl
    .model_view_control_namespace,
  "hole_only",
)

const controlText =
  JSON.stringify(
    projectedControl.system,
  )

assert.equal(
  controlText.includes(
    "REQUIRED=id=op_",
  ),
  false,
)
assert.equal(
  controlText.includes(
    "HOLE=h0 codec=python_units field=python_declarations required=true",
  ),
  true,
)
assert.equal(
  controlText.includes(
    "HOLE=h1 codec=markup_fragment field=markup_fragment required=true",
  ),
  true,
)
assert.equal(
  controlText.includes(
    "HOLE=h2 codec=markup_document field=markup_document required=true",
  ),
  true,
)
assert.equal(
  controlText.includes(
    "PYTHON_MODEL_BODY_FIELD=python_statements",
  ),
  true,
)
assert.equal(
  controlText.includes(
    "PYTHON_MODEL_SIGNATURE_FIELD=signature",
  ),
  true,
)

const good =
  normalizeSourceSlotModelViewRequest({
    plan: compiled.plan,
    request: {
      holes: {
        h0: {
          python_declarations: [
            {
              declaration_kind:
                "function",
              name: "report",
              signature: "",
              python_statements: [
                "return 1",
              ],
            },
          ],
        },
        h1: {
          markup_fragment:
            "<a href=\"resource://h2\">Report</a>",
        },
        h2: {
          markup_document:
            "<html><body>Report</body></html>",
        },
      },
    },
  })

assert.equal(
  good.ok,
  true,
  JSON.stringify(good),
)

assert.deepEqual(
  Object.keys(
    good.request.sources,
  ).sort(),
  [
    "navigation_integration",
    "server_surface",
    "ui_surface",
  ],
)

assert.deepEqual(
  good
    .request
    .sources
    .server_surface,
  {
    units: [
      {
        kind: "function",
        name: "report",
        parameters: "",
        suite: [
          "return 1",
        ],
      },
    ],
  },
)

assert.equal(
  good
    .request
    .sources
    .navigation_integration,
  "<a href=\"resource://ui_surface\">Report</a>",
)

const prosePython =
  normalizeSourceSlotModelViewRequest({
    plan: compiled.plan,
    request: {
      holes: {
        h0: {
          python_declarations: [
            {
              declaration_kind:
                "async_function",
              name:
                "build_report",
              signature: "",
              python_statements: [
                "\"\"\"Add a report page with filters and XLSX download.\"\"\"",
              ],
            },
          ],
        },
        h1: {
          markup_fragment:
            "<a>Report</a>",
        },
        h2: {
          markup_document:
            "<html></html>",
        },
      },
    },
  })

assert.equal(
  prosePython.ok,
  false,
)
assert.equal(
  prosePython.reason,
  "model_view_python_prose_payload",
)
assert.equal(
  modelViewFailureIsNonRepairable(
    prosePython.reason,
  ),
  true,
)

const proseMarkup =
  normalizeSourceSlotModelViewRequest({
    plan: compiled.plan,
    request: {
      holes: {
        h0: {
          python_declarations: [
            {
              declaration_kind:
                "function",
              name: "report",
              signature: "",
              python_statements: [
                "return 1",
              ],
            },
          ],
        },
        h1: {
          markup_fragment:
            "Add navigation menu item for the report.",
        },
        h2: {
          markup_document:
            "<html></html>",
        },
      },
    },
  })

assert.equal(
  proseMarkup.ok,
  false,
)
assert.equal(
  proseMarkup.reason,
  "model_view_structural_text_missing",
)
assert.equal(
  modelViewFailureIsNonRepairable(
    proseMarkup.reason,
  ),
  true,
)

// Stable global hole identity for a repair subset.
const repairTool = {
  ...canonicalTool,
  input: {
    type: "object",
    properties: {
      sources: {
        type: "object",
        properties: {
          navigation_integration:
            canonicalTool
              .input
              .properties
              .sources
              .properties
              .navigation_integration,
        },
        required: [
          "navigation_integration",
        ],
        additionalProperties:
          false,
      },
    },
    required: ["sources"],
    additionalProperties: false,
  },
}

const repair =
  compileSourceSlotModelView({
    tool: repairTool,
    binding: {
      ...binding,
      required_source_keys: [
        "navigation_integration",
      ],
    },
    capability,
  })

assert.equal(
  repair.ok,
  true,
  JSON.stringify(repair),
)
assert.deepEqual(
  repair.plan.required_holes,
  ["h1"],
)

console.log(
  "PASS R7-R25 model view compiler " +
  "single_model_namespace=true " +
  "annotation_independent_semantics=true " +
  "compiler_identity_fields_exposed=0 " +
  "python_model_field=python_statements " +
  "markup_codecs=structural " +
  "provider_projection_preserves_semantics=true " +
  "canonical_source_slot_abi=unchanged " +
  "deterministic_lowering=true " +
  "prose_preclassified=true " +
  "prose_repair=false " +
  "stable_hole_ids=true " +
  "model_calls_added=0 mutation_authority=false",
)
