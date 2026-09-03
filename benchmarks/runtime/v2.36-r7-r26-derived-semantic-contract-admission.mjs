import assert from "node:assert/strict"

import {
  compileProviderSafeModelSchema,
} from "../../opencode/plugins/cpu-search-core/deterministic-argument-synthesis-v1.mjs"

import {
  compileTypedPythonRepairSourceSchema,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

import {
  MODEL_VIEW_FAILURE_CLASSIFIER_PROTOCOL,
  MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
  classifyModelViewFailure,
  compileSourceSlotModelView,
  modelViewFailureIsNonRepairable,
  normalizeSourceSlotModelViewRequest,
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

const typed = compileTypedPythonRepairSourceSchema({
  row: rows[0],
  frontierRows: rows,
})
assert.equal(typed.ok, true, JSON.stringify(typed))

const canonicalTool = {
  name: "execute_additive_plan",
  description: "canonical fixture",
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

const view = compileSourceSlotModelView({
  tool: canonicalTool,
  binding,
  capability,
})
assert.equal(view.ok, true, JSON.stringify(view))
assert.equal(
  view.semantic_contract_protocol,
  MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
)
assert.equal(view.derived_semantic_contract_count, 3)

const [pythonRow, fragmentRow, documentRow] = view.plan.rows
assert.equal(
  pythonRow.semantic_contract.kind,
  "python_declaration_body_v1",
)
assert.equal(
  pythonRow.semantic_contract.duplicate_owned_wrapper_forbidden,
  true,
)
assert.equal(
  pythonRow.semantic_contract.module_imports_possible,
  true,
)
assert.equal(
  fragmentRow.semantic_contract.kind,
  "markup_fragment_replacement_v1",
)
assert.equal(
  fragmentRow.semantic_contract.template_extends_forbidden,
  true,
)
assert.equal(
  fragmentRow.semantic_contract.document_root_forbidden,
  true,
)
assert.equal(
  documentRow.semantic_contract.kind,
  "markup_document_creation_v1",
)
assert.equal(
  documentRow.semantic_contract.template_document_allowed,
  true,
)

// Semantic contract is private compiler state, not a model-selected field.
const schemaText = JSON.stringify(view.tool.input)
assert.equal(schemaText.includes("semantic_contract"), false)
assert.equal(schemaText.includes("navigation_integration"), false)
assert.equal(schemaText.includes("server_surface"), false)

const provider = compileProviderSafeModelSchema(view.tool.input)
assert.equal(provider.ok, true, JSON.stringify(provider))

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

const projectedControl = projectModelViewControlContext(
  control,
  view.plan,
)
assert.equal(projectedControl.applied, true)
const controlText = JSON.stringify(projectedControl.system)
assert.equal(
  controlText.includes(
    "contract=python_declaration_body_v1 duplicate_owned_wrapper_forbidden=true module_imports_possible=true",
  ),
  true,
)
assert.equal(
  controlText.includes(
    "contract=markup_fragment_replacement_v1 template_extends_forbidden=true document_root_forbidden=true",
  ),
  true,
)
assert.equal(controlText.includes("navigation_integration"), false)
assert.equal(
  projectedControl.model_view_semantic_contract_protocol,
  MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
)

const baseGood = {
  holes: {
    h0: {
      python_declarations: [
        {
          declaration_kind: "function",
          name: "report",
          signature: "",
          python_statements: [
            "import json",
            "return json.dumps({'ok': True})",
          ],
        },
        {
          declaration_kind: "function",
          name: "outer",
          signature: "",
          python_statements: [
            "def inner():\n    return 1",
            "return inner()",
          ],
        },
      ],
    },
    h1: {
      markup_fragment:
        "{% block item %}<a href=\"#\">Report</a>{% endblock %}",
    },
    h2: {
      // Intentionally malformed HTML. R26 must not duplicate djlint.
      markup_document:
        "{% extends 'base.html' %}{% block content %}<input=\"radio\">{% endblock %}",
    },
  },
}

// Local imports remain legal; a genuinely nested helper with another name remains legal.
// Real syntax/format correctness remains Ruff/djlint authority downstream.
const good = normalizeSourceSlotModelViewRequest({
  plan: view.plan,
  request: structuredClone(baseGood),
})
assert.equal(good.ok, true, JSON.stringify(good))

const duplicate = structuredClone(baseGood)
duplicate.holes.h0.python_declarations[0].python_statements = [
  "def report():\n    return 1",
]
const duplicateFailure = normalizeSourceSlotModelViewRequest({
  plan: view.plan,
  request: duplicate,
})
assert.equal(duplicateFailure.ok, false)
assert.equal(
  duplicateFailure.reason,
  "model_view_candidate_structural_contract_violation",
)
assert.equal(duplicateFailure.structural_violation_count, 1)
assert.deepEqual(
  duplicateFailure.structural_violation_kinds,
  ["python_owned_wrapper_duplicate"],
)
assert.equal(duplicateFailure.repair_eligible, false)

const documentInFragment = structuredClone(baseGood)
documentInFragment.holes.h1.markup_fragment =
  "{% extends 'base.html' %}{% block content %}<a>Report</a>{% endblock %}"
const fragmentFailure = normalizeSourceSlotModelViewRequest({
  plan: view.plan,
  request: documentInFragment,
})
assert.equal(fragmentFailure.ok, false)
assert.equal(fragmentFailure.structural_violation_count, 1)
assert.deepEqual(
  fragmentFailure.structural_violation_kinds,
  ["markup_fragment_template_extends"],
)
assert.equal(fragmentFailure.repair_eligible, false)

const multi = structuredClone(baseGood)
multi.holes.h0.python_declarations[0].python_statements = [
  "async def report():\n    return 1",
]
multi.holes.h1.markup_fragment =
  "<!doctype html><html><body>Report</body></html>"
const multiFailure = normalizeSourceSlotModelViewRequest({
  plan: view.plan,
  request: multi,
})
assert.equal(multiFailure.ok, false)
assert.equal(multiFailure.structural_violation_count, 2)
assert.deepEqual(
  new Set(multiFailure.structural_violation_kinds),
  new Set([
    "python_owned_wrapper_duplicate",
    "markup_fragment_document_root",
  ]),
)
assert.equal(multiFailure.repair_eligible, false)
assert.equal(
  modelViewFailureIsNonRepairable(multiFailure.reason),
  true,
)

const classified = classifyModelViewFailure(multiFailure.reason)
assert.equal(
  classified.protocol,
  MODEL_VIEW_FAILURE_CLASSIFIER_PROTOCOL,
)
assert.equal(
  classified.failure_class,
  "derived_semantic_contract_violation",
)
assert.equal(classified.repair_eligible, false)

// Unknown downstream tool failures keep the pre-R26 repair policy authority.
const downstream = classifyModelViewFailure("djlint_reformat_failed")
assert.equal(downstream.repair_eligible, true)
assert.equal(
  downstream.failure_class,
  "candidate_defect_unclassified",
)

console.log(
  "PASS R7-R26 derived semantic contract admission " +
  "contracts=derived_not_taxonomy " +
  "compiler_identity_fields_exposed=0 " +
  "python_duplicate_owned_wrapper_rejected=true " +
  "python_inner_helper_allowed=true " +
  "python_local_import_allowed=true " +
  "fragment_template_document_rejected=true " +
  "document_template_allowed=true " +
  "djlint_authority_not_duplicated=true " +
  "multi_violation_classified=true " +
  "structural_violation_repair=false " +
  "canonical_source_slot_abi=unchanged " +
  "model_calls_added=0 mutation_authority=false",
)
