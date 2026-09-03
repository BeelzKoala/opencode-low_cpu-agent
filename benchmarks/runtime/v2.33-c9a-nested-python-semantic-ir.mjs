import assert from "node:assert/strict"
import fs from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  compilePythonSemanticUnits,
} from "../../opencode/plugins/cpu-search-core/python-semantic-frontend-v1.mjs"

import {
  lowerPythonNestedSemanticUnits,
  PYTHON_NESTED_UNIT_PROTOCOL,
} from "../../opencode/plugins/cpu-search-core/python-nested-semantic-ir-v1.mjs"

if (!process.env.OPENCODE_RUFF_PYTHON_BRIDGE) {
  const bridge = path.resolve(
    "rust/evidence-distiller/target/release/opencode-ruff-python-bridge",
  )
  if (fs.existsSync(bridge)) {
    process.env.OPENCODE_RUFF_PYTHON_BRIDGE = bridge
  }
}

assert.equal(
  PYTHON_NESTED_UNIT_PROTOCOL,
  "python-unit-shell-v2",
)

const nested = [
  {
    kind: "class",
    name: "Report",
    members: [
      {
        kind: "function",
        name: "__init__",
        parameters: "self",
        suite: [
          "self.value = 1",
        ],
      },
      {
        kind: "function",
        name: "answer",
        parameters: "self",
        returns: "int",
        suite: [
          [
            "if self.value:",
            "    return 42",
          ].join("\n"),
          "return 0",
        ],
      },
    ],
  },
]

const lowered =
  lowerPythonNestedSemanticUnits(
    nested,
  )

assert.equal(
  lowered.ok,
  true,
  JSON.stringify(lowered, null, 2),
)

assert.equal(
  lowered.internal_unit_protocol,
  "python-unit-shell-v1",
)

assert.equal(
  lowered.model_raw_body_authority,
  false,
)

assert.equal(
  lowered.units[0].kind,
  "class",
)

assert.match(
  lowered.units[0].body,
  /^def __init__\(self\):$/mu,
)

assert.match(
  lowered.units[0].body,
  /^    self\.value = 1$/mu,
)

assert.match(
  lowered.units[0].body,
  /^def answer\(self\) -> int:$/mu,
)

const root = await mkdtemp(
  path.join(
    os.tmpdir(),
    "koalik-c9a-",
  ),
)

const source = "existing = 1\n"

await writeFile(
  path.join(root, "sample.py"),
  source,
)

const compiled =
  await compilePythonSemanticUnits({
    root,
    target_file: "sample.py",
    source,
    units: lowered.units,
    operation_id: "op_0",
    capability_sha256:
      "a".repeat(64),
  })

assert.equal(
  compiled.ok,
  true,
  JSON.stringify(compiled, null, 2),
)

assert.match(
  compiled.declaration,
  /^class Report:/mu,
)

assert.match(
  compiled.declaration,
  /^    def __init__\(self\):$/mu,
)

assert.match(
  compiled.declaration,
  /^        self\.value = 1$/mu,
)

assert.match(
  compiled.declaration,
  /^    def answer\(self\) -> int:$/mu,
)

assert.match(
  compiled.declaration,
  /^            return 42$/mu,
)

const malformed =
  lowerPythonNestedSemanticUnits([
    {
      kind: "function",
      name: "broken",
      suite: [
        "if True print('x')",
      ],
    },
  ])

assert.equal(malformed.ok, false)
assert.equal(
  malformed.reason,
  "semantic_suite_item_syntax_invalid",
)
assert.equal(
  malformed.unit_index,
  0,
)
assert.equal(
  malformed.suite_index,
  0,
)
assert.equal(
  malformed.field,
  "suite",
)

const multiple =
  lowerPythonNestedSemanticUnits([
    {
      kind: "function",
      name: "ambiguous",
      suite: [
        "x = 1\ny = 2",
      ],
    },
  ])

assert.equal(
  multiple.ok,
  true,
  JSON.stringify(multiple),
)

const legacy =
  lowerPythonNestedSemanticUnits([
    {
      kind: "function",
      name: "legacy",
      body: "return 1",
    },
  ])

assert.equal(legacy.ok, false)
assert.equal(
  legacy.reason,
  "python_unit_contract_fields_invalid",
)
assert.deepEqual(
  legacy.unexpected_fields,
  ["body"],
)

const nestedClass =
  lowerPythonNestedSemanticUnits([
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
              name: "value",
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

console.log(
  "PASS C9-A nested semantic IR " +
    "model_protocol=python-unit-shell-v2 " +
    "internal_protocol=python-unit-shell-v1 " +
    "suite=ruff_statement_chunks " +
    "class_members=typed " +
    "outer_indent=compiler_owned " +
    "raw_body_authority=false " +
    "backend_rewrite=false",
)
