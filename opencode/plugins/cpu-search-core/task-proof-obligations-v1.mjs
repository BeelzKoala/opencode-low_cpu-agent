import {
  TASK_CONSTRAINT,
  TASK_REQUIREMENTS_PROTOCOL,
  TASK_ROLE,
} from "./task-requirements-v1.mjs"

export const TASK_PROOF_COMPILER_PROTOCOL = "task-proof-compiler-v1"
export const TASK_PROOF_OBLIGATION_PROTOCOL = "task-proof-obligation-v1"

const ROLE_CHECKERS = Object.freeze({
  [TASK_ROLE.SERVER_ENDPOINT]: Object.freeze({
    id: "server_surface_present",
    checker: "mutation_obligation_server_surface",
  }),
  [TASK_ROLE.UI_SURFACE]: Object.freeze({
    id: "ui_surface_present",
    checker: "mutation_obligation_ui_surface",
  }),
  [TASK_ROLE.NAVIGATION]: Object.freeze({
    id: "navigation_integration_present",
    checker: "mutation_obligation_navigation",
  }),
  [TASK_ROLE.DATA_ACCESS]: Object.freeze({
    id: "data_access_present",
    checker: "candidate_ast_data_access",
  }),
  [TASK_ROLE.DATA_SCHEMA]: Object.freeze({
    id: "data_schema_delta",
    checker: "candidate_schema_delta",
  }),
  [TASK_ROLE.OUTPUT_ARTIFACT]: Object.freeze({
    id: "output_artifact_present",
    checker: "candidate_ast_output_artifact",
  }),
  [TASK_ROLE.INPUT_VALIDATION]: Object.freeze({
    id: "input_validation_present",
    checker: "candidate_ast_input_validation",
  }),
  [TASK_ROLE.PRESERVE_BEHAVIOR]: Object.freeze({
    id: "existing_behavior_conserved",
    checker: "additive_top_level_conservation",
  }),
  [TASK_ROLE.TEST_SURFACE]: Object.freeze({
    id: "focused_tests_pass",
    checker: "focused_test_execution",
  }),
  [TASK_ROLE.CONFIGURATION]: Object.freeze({
    id: "configuration_delta",
    checker: "candidate_configuration_delta",
  }),
  [TASK_ROLE.DEPENDENCY_POLICY]: Object.freeze({
    id: "dependency_manifest_delta",
    checker: "dependency_manifest_delta",
  }),
})

const CONSTRAINT_CHECKERS = Object.freeze({
  [TASK_CONSTRAINT.NO_NEW_DEPENDENCIES]: Object.freeze({
    id: "no_new_dependencies",
    checker: "dependency_closure_no_new_external",
  }),
  [TASK_CONSTRAINT.PRESERVE_EXISTING_BEHAVIOR]: Object.freeze({
    id: "existing_behavior_conserved",
    checker: "additive_top_level_conservation",
  }),
  [TASK_CONSTRAINT.PARAMETERIZED_DATA_QUERY]: Object.freeze({
    id: "parameterized_data_query",
    checker: "candidate_ast_query_parameterization",
  }),
  [TASK_CONSTRAINT.CLOSED_CHOICE_INPUT]: Object.freeze({
    id: "closed_choice_input",
    checker: "candidate_ast_closed_choice",
  }),
  [TASK_CONSTRAINT.VALIDATE_BEFORE_SIDE_EFFECT]: Object.freeze({
    id: "validate_before_side_effect",
    checker: "candidate_control_flow_validation_before_effect",
  }),
})

function rows(value) {
  return Array.isArray(value) ? value : []
}

function requiredKinds(value, keys) {
  const result = new Set()
  for (const row of rows(value)) {
    if (typeof row === "string") {
      if (row.length > 0) result.add(row)
      continue
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue
    if (row.required === false) continue
    for (const key of keys) {
      if (typeof row[key] === "string" && row[key].length > 0) {
        result.add(row[key])
        break
      }
    }
  }
  return [...result].sort()
}

function fail(reason, detail = null) {
  return Object.freeze({
    ok: false,
    protocol: TASK_PROOF_COMPILER_PROTOCOL,
    reason,
    detail,
    obligations: Object.freeze([]),
    mutation_authority: false,
  })
}

function obligation({ id, checker, source_kind, source_value }) {
  return Object.freeze({
    protocol: TASK_PROOF_OBLIGATION_PROTOCOL,
    id,
    checker,
    disposition: "fatal",
    source_kind,
    source_value,
    mutation_authority: false,
  })
}

export function compileTaskProofObligations(taskRequirements) {
  if (
    !taskRequirements ||
    typeof taskRequirements !== "object" ||
    Array.isArray(taskRequirements)
  ) {
    return fail("task_proof_requirements_invalid")
  }

  if (
    typeof taskRequirements.protocol === "string" &&
    taskRequirements.protocol !== TASK_REQUIREMENTS_PROTOCOL
  ) {
    return fail(
      "task_proof_requirements_protocol_mismatch",
      String(taskRequirements.protocol),
    )
  }

  const roles = requiredKinds(
    taskRequirements.roles,
    ["role", "kind", "id"],
  )
  const constraints = requiredKinds(
    taskRequirements.constraints,
    ["kind", "constraint", "id"],
  )

  const compiled = []

  for (const role of roles) {
    const spec = ROLE_CHECKERS[role]
    if (!spec) {
      return fail("task_proof_required_role_unsupported", role)
    }
    compiled.push(obligation({
      ...spec,
      source_kind: "role",
      source_value: role,
    }))
  }

  for (const constraint of constraints) {
    const spec = CONSTRAINT_CHECKERS[constraint]
    if (!spec) {
      return fail("task_proof_required_constraint_unsupported", constraint)
    }
    compiled.push(obligation({
      ...spec,
      source_kind: "constraint",
      source_value: constraint,
    }))
  }

  const byIdentity = new Map()
  for (const row of compiled) {
    const key = `${row.id}\0${row.checker}`
    const prior = byIdentity.get(key)
    if (!prior) {
      byIdentity.set(key, row)
      continue
    }
    byIdentity.set(key, Object.freeze({
      ...prior,
      source_kind: "composite",
      source_value: [prior.source_value, row.source_value]
        .flat()
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort(),
    }))
  }

  const obligations = [...byIdentity.values()]
    .sort((a, b) => a.id.localeCompare(b.id))

  return Object.freeze({
    ok: true,
    protocol: TASK_PROOF_COMPILER_PROTOCOL,
    reason: "task_proof_obligations_compiled",
    obligations: Object.freeze(obligations),
    required_obligation_count: obligations.length,
    mutation_authority: false,
  })
}

export function renderTaskProofObligations(taskRequirements) {
  const compiled = compileTaskProofObligations(taskRequirements)
  if (compiled.ok !== true) return ""
  return [
    `TASK_PROOF protocol=${TASK_PROOF_COMPILER_PROTOCOL} required=${compiled.required_obligation_count}`,
    ...compiled.obligations.map(
      (row) =>
        `PROOF_OBLIGATION id=${row.id} checker=${row.checker} disposition=${row.disposition}`,
    ),
  ].join("\n")
}
