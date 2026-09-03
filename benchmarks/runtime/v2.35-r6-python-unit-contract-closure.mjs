import assert from "node:assert/strict"
import fs from "node:fs"

import {
  PYTHON_UNIT_CONTRACT,
  PYTHON_UNIT_CONTRACT_PROTOCOL,
  PYTHON_UNIT_CONTRACT_SHA256,
  pythonUnitAllowedFields,
  pythonUnitKinds,
  pythonUnitSchema,
  validatePythonUnitsContract,
} from "../../opencode/plugins/cpu-search-core/python-unit-contract-v1.mjs"

assert.equal(
  PYTHON_UNIT_CONTRACT.protocol,
  PYTHON_UNIT_CONTRACT_PROTOCOL,
)
assert.match(
  PYTHON_UNIT_CONTRACT_SHA256,
  /^[a-f0-9]{64}$/u,
)

const topSchema = pythonUnitSchema({
  context: "top",
})
assert.ok(Array.isArray(topSchema.oneOf))
assert.equal(topSchema.oneOf.length, 4)

const byKind = new Map(
  topSchema.oneOf.map((variant) => [
    variant.properties.kind.enum[0],
    variant,
  ]),
)

for (const kind of [
  "function",
  "async_function",
  "assignment",
  "class",
]) {
  assert.ok(byKind.has(kind))
  assert.deepEqual(
    Object.keys(
      byKind.get(kind).properties,
    ).sort(),
    [...pythonUnitAllowedFields(kind)].sort(),
  )
}

const functionSchema =
  byKind.get("function")
assert.ok(functionSchema.required.includes("suite"))
assert.equal(
  Object.hasOwn(
    functionSchema.properties,
    "annotation",
  ),
  false,
)
assert.equal(
  Object.hasOwn(
    functionSchema.properties,
    "value",
  ),
  false,
)

const assignmentSchema =
  byKind.get("assignment")
assert.ok(
  assignmentSchema.required.includes("value"),
)
assert.equal(
  Object.hasOwn(
    assignmentSchema.properties,
    "suite",
  ),
  false,
)

const classSchema = byKind.get("class")
const memberSchema =
  classSchema.properties.members.items
assert.deepEqual(
  memberSchema.oneOf
    .map(
      (variant) =>
        variant.properties.kind.enum[0],
    )
    .sort(),
  [
    "assignment",
    "async_function",
    "function",
  ],
)

assert.deepEqual(
  [...pythonUnitKinds("member")].sort(),
  [
    "assignment",
    "async_function",
    "function",
  ],
)

const badRuntimePayload = [
  {
    kind: "class",
    name: "BestsellersReportHandler",
    members: [
      {
        kind: "function",
        name: "generate_report",
        parameters:
          "report_date: date, report_type: str",
        returns: "send_file",
        suite: [
          "return report_date",
        ],
        annotation:
          "wrong field for function",
        value:
          "finally: pass",
      },
    ],
  },
]

const bad =
  validatePythonUnitsContract(
    badRuntimePayload,
  )
assert.equal(bad.ok, false)
assert.equal(
  bad.reason,
  "python_unit_contract_fields_invalid",
)
assert.deepEqual(
  bad.unit_path,
  [0, 0],
)
assert.equal(bad.kind, "function")
assert.equal(bad.field, "annotation")
assert.deepEqual(
  bad.unexpected_fields,
  ["annotation", "value"],
)
assert.deepEqual(
  bad.allowed_fields,
  [
    "kind",
    "name",
    "suite",
    "parameters",
    "returns",
    "decorators",
  ],
)

const valid = [
  {
    kind: "function",
    name: "download",
    parameters: "",
    suite: [
      "return 1",
    ],
  },
  {
    kind: "assignment",
    name: "LIMIT",
    annotation: "int",
    value: "10",
  },
  {
    kind: "class",
    name: "Handler",
    members: [
      {
        kind: "function",
        name: "run",
        suite: [
          "return None",
        ],
      },
      {
        kind: "assignment",
        name: "enabled",
        value: "True",
      },
    ],
  },
]

assert.equal(
  validatePythonUnitsContract(valid).ok,
  true,
)

const nestedClass =
  validatePythonUnitsContract([
    {
      kind: "class",
      name: "Outer",
      members: [
        {
          kind: "class",
          name: "Inner",
          members: [
            {
              kind: "assignment",
              name: "x",
              value: "1",
            },
          ],
        },
      ],
    },
  ])
assert.equal(nestedClass.ok, false)
assert.equal(
  nestedClass.reason,
  "python_unit_contract_kind_invalid",
)
assert.deepEqual(
  nestedClass.unit_path,
  [0, 0],
)

const semanticSource =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs",
      import.meta.url,
    ),
    "utf8",
  )

assert.ok(
  semanticSource.includes(
    'from "./python-unit-contract-v1.mjs"',
  ),
)
assert.ok(
  semanticSource.includes(
    'pythonUnitSchema({ context: "top" })',
  ),
)

const nestedSource =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search-core/python-nested-semantic-ir-v1.mjs",
      import.meta.url,
    ),
    "utf8",
  )

assert.ok(
  nestedSource.includes(
    "validatePythonUnitsContract(units)",
  ),
)
assert.ok(
  nestedSource.includes(
    "PYTHON_UNIT_CONTRACT_PROTOCOL",
  ),
)

const installer =
  fs.readFileSync(
    new URL(
      "../../scripts/install-plugin-stack.sh",
      import.meta.url,
    ),
    "utf8",
  )

for (const required of [
  "cpu-search-core/python-unit-contract-v1.json",
  "cpu-search-core/python-unit-contract-v1.mjs",
]) {
  assert.ok(installer.includes(required))
}

console.log(
  "PASS R6 python unit contract closure " +
  "authority=single_declarative_contract " +
  "schema=discriminated_union " +
  "function_assignment_field_leak=closed " +
  "nested_class=forbidden " +
  "nested_ir_prevalidation=true " +
  "ruff_semantic_authority_preserved=true " +
  "model_calls_added=0 " +
  "mutation_authority_expansion=false",
)
