import assert from "node:assert/strict"

import {
  TASK_CONSTRAINT,
  TASK_REQUIREMENTS_PROTOCOL,
  TASK_ROLE,
} from "../../opencode/plugins/cpu-search-core/task-requirements-v1.mjs"
import {
  TASK_PROOF_COMPILER_PROTOCOL,
  compileTaskProofObligations,
} from "../../opencode/plugins/cpu-search-core/task-proof-obligations-v1.mjs"

const compiled = compileTaskProofObligations({
  protocol: TASK_REQUIREMENTS_PROTOCOL,
  roles: [
    { role: TASK_ROLE.SERVER_ENDPOINT, required: true },
    { role: TASK_ROLE.UI_SURFACE, required: true },
    { role: TASK_ROLE.NAVIGATION, required: true },
    { role: TASK_ROLE.DATA_ACCESS, required: true },
    { role: TASK_ROLE.OUTPUT_ARTIFACT, required: true },
    { role: TASK_ROLE.PRESERVE_BEHAVIOR, required: true },
  ],
  constraints: [
    { kind: TASK_CONSTRAINT.NO_NEW_DEPENDENCIES, required: true },
    { kind: TASK_CONSTRAINT.PARAMETERIZED_DATA_QUERY, required: true },
    {
      kind: TASK_CONSTRAINT.PRESERVE_EXISTING_BEHAVIOR,
      required: true,
    },
  ],
})

assert.equal(compiled.ok, true)
assert.equal(compiled.protocol, TASK_PROOF_COMPILER_PROTOCOL)
assert.equal(compiled.mutation_authority, false)

const ids = compiled.obligations.map((row) => row.id)
assert.deepEqual(ids, [...ids].sort())

for (const required of [
  "server_surface_present",
  "ui_surface_present",
  "navigation_integration_present",
  "data_access_present",
  "output_artifact_present",
  "existing_behavior_conserved",
  "no_new_dependencies",
  "parameterized_data_query",
]) {
  assert.equal(ids.includes(required), true, required)
}

assert.equal(
  ids.filter((value) => value === "existing_behavior_conserved").length,
  1,
)

assert.equal(
  compiled.obligations.every(
    (row) =>
      row.disposition === "fatal" &&
      row.mutation_authority === false &&
      typeof row.checker === "string" &&
      row.checker.length > 0,
  ),
  true,
)

const unknown = compileTaskProofObligations({
  protocol: TASK_REQUIREMENTS_PROTOCOL,
  roles: [{ role: "future_unknown_role", required: true }],
  constraints: [],
})
assert.equal(unknown.ok, false)
assert.equal(unknown.reason, "task_proof_required_role_unsupported")

console.log(
  "PASS E3.0 generic TaskRequirements -> fail-closed proof obligations",
)
