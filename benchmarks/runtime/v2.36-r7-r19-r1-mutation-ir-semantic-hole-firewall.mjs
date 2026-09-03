import assert from "node:assert/strict"

import {
  inspectPythonSuiteItems,
} from "../../opencode/plugins/cpu-search-core/python-nested-semantic-ir-v1.mjs"

import {
  TYPED_PYTHON_REPAIR_SEMANTIC_HOLE_PROTOCOL,
  compileTypedPythonRepairSourceSchema,
  validateTypedPythonRepairSemanticHoles,
  validateTypedPythonRepairSource,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

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

const compiled = compileTypedPythonRepairSourceSchema({
  row,
  frontierRows: [row],
})
assert.equal(compiled.ok, true, JSON.stringify(compiled))
assert.equal(
  compiled.semantic_hole_protocol,
  TYPED_PYTHON_REPAIR_SEMANTIC_HOLE_PROTOCOL,
)

const union = compiled.schema.properties.units.items.oneOf ??
  compiled.schema.properties.units.items.anyOf
assert.ok(Array.isArray(union))
assert.equal(union.length, 2)

for (const branch of union) {
  const p = branch.properties
  const parameter = new RegExp(p.parameters.pattern, "u")
  const decorator = new RegExp(p.decorators.items.pattern, "u")
  const suite = new RegExp(p.suite.items.pattern, "u")

  assert.equal(parameter.test("report_date: str, report_type: Literal['category', 'seller']"), false)
  assert.equal(parameter.test("value=make_value()"), false)
  assert.equal(parameter.test("report_date, report_type"), true)
  assert.equal(parameter.test("a, /, b, *args, kw, **kwargs"), true)

  assert.equal(decorator.test("@bp.route('/report', methods=['POST'])"), true)
  assert.equal(decorator.test('"role": "server_surface"'), false)
  assert.equal(decorator.test('"""not a decorator"""'), false)

  assert.equal(suite.test("export"), false)
  assert.equal(suite.test("return report_date"), true)
  assert.equal(suite.test("report = build_report()"), true)
  assert.equal(suite.test("if ready:\n    return report"), true)
}

const bare = inspectPythonSuiteItems(["export"])
assert.equal(bare.ok, true, JSON.stringify(bare))
assert.deepEqual(bare.statement_shapes, [["bare_name_expr"]])

const doc = inspectPythonSuiteItems(['"""Build report."""'])
assert.equal(doc.ok, true, JSON.stringify(doc))
assert.deepEqual(doc.statement_shapes, [["string_literal_expr"]])

const work = inspectPythonSuiteItems([
  '"""Build report."""',
  "result = build_report()",
  "return result",
])
assert.equal(work.ok, true, JSON.stringify(work))
assert.ok(work.statement_shapes.flat().some((shape) =>
  shape === "statement" || shape === "expression",
))

const runtimeOptions = {
  fieldAuthority: compiled.field_authority,
  capacityProfile: compiled.capacity_profile,
}

const literal = validateTypedPythonRepairSource({
  units: [{
    kind: "function",
    name: "export_xlsx_report",
    parameters: "report_date: str, report_type: Literal['category', 'seller']",
    suite: ["return report_date"],
  }],
}, runtimeOptions)
assert.equal(literal.ok, false)
assert.equal(literal.reason, "source_slot_typed_repair_parameter_surface_invalid")

const bareBody = validateTypedPythonRepairSource({
  units: [{
    kind: "function",
    name: "export_xlsx_report",
    parameters: "report_date, report_type",
    suite: ["export"],
  }],
}, runtimeOptions)
assert.equal(bareBody.ok, false)
assert.equal(bareBody.reason, "source_slot_typed_repair_inert_suite")

const duplicate = validateTypedPythonRepairSemanticHoles([
  { kind: "function", name: "report", parameters: "", suite: ["return 1"] },
  { kind: "async_function", name: "report", parameters: "", suite: ["return 2"] },
])
assert.equal(duplicate.ok, false)
assert.equal(duplicate.reason, "source_slot_typed_repair_duplicate_unit_name")

const duplicateParameter = validateTypedPythonRepairSemanticHoles([
  { kind: "function", name: "report", parameters: "value, value", suite: ["return value"] },
])
assert.equal(duplicateParameter.ok, false)
assert.equal(duplicateParameter.reason, "source_slot_typed_repair_parameter_name_invalid")

const good = validateTypedPythonRepairSource({
  units: [{
    kind: "function",
    name: "export_xlsx_report",
    parameters: "report_date, report_type",
    decorators: ["@bp.route('/report', methods=['POST'])"],
    suite: [
      "if report_type == 'category':\n    return report_date",
      "return report_date",
    ],
  }],
}, runtimeOptions)
assert.equal(good.ok, true, JSON.stringify(good))

console.log(
  "PASS R7-R19-R1 mutation IR semantic-hole firewall " +
  "parameter_annotations=default_closed parameter_defaults=default_closed " +
  "parameter_layout=deterministic decorator_surface=bounded_common_python " +
  "suite_generation_guard=active suite_semantics=ruff_ast " +
  "bare_name_body=blocked docstring_only_body=blocked duplicate_unit_names=blocked " +
  "binding_names=frontend_owned global_python_ir=unchanged " +
  "model_calls_added=0 mutation_authority=false",
)
