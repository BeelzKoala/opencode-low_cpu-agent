import assert from "node:assert/strict"
import fs from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  lowerPythonNestedSemanticUnits,
} from "../../opencode/plugins/cpu-search-core/python-nested-semantic-ir-v1.mjs"

import {
  compilePythonSemanticUnits,
} from "../../opencode/plugins/cpu-search-core/python-semantic-frontend-v1.mjs"

if (!process.env.OPENCODE_RUFF_PYTHON_BRIDGE) {
  const bridge = path.resolve(
    "rust/evidence-distiller/target/release/opencode-ruff-python-bridge",
  )

  if (fs.existsSync(bridge)) {
    process.env.OPENCODE_RUFF_PYTHON_BRIDGE = bridge
  }
}

const root = await mkdtemp(
  path.join(
    os.tmpdir(),
    "koalik-c9-binding-negative-",
  ),
)

const source = [
  "existing = 1",
  "",
].join("\n")

await writeFile(
  path.join(root, "sample.py"),
  source,
)

const nested =
  lowerPythonNestedSemanticUnits([
    {
      kind: "function",
      name: "probe",
      parameters: "",
      returns: "Response",
      suite: [
        "return None",
      ],
    },
  ])

assert.equal(
  nested.ok,
  true,
  JSON.stringify(nested, null, 2),
)

assert.equal(
  nested.mutation_authority,
  false,
)

const compiled =
  await compilePythonSemanticUnits({
    root,
    target_file: "sample.py",
    source,
    units: nested.units,
    operation_id: "op_0",
    capability_sha256:
      "a".repeat(64),
  })

console.log(
  JSON.stringify(
    compiled,
    null,
    2,
  ),
)

assert.equal(
  compiled.ok,
  false,
)

assert.equal(
  compiled.reason,
  "semantic_python_binding_unresolved",
)

assert.match(
  JSON.stringify(compiled),
  /Response/u,
)

assert.notEqual(
  compiled.mutation_authority,
  true,
)

console.log(
  "PASS C9-A binding authority negative " +
  "nested_ir=accepted " +
  "unknown_binding=Response " +
  "binding=fail_closed " +
  "mutation_authority=false"
)
