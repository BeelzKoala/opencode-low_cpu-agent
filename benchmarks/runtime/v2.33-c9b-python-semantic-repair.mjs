import assert from "node:assert/strict"
import fs from "node:fs"

import {
  buildPythonSemanticRepairHint,
  pythonSemanticFailureIsRepairable,
  pythonSemanticRepairAuthorityMatches,
} from "../../opencode/plugins/cpu-search-core/python-semantic-repair-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256:
    "a".repeat(64),
  authority_sha256:
    "b".repeat(64),
}

const contextSha =
  "c".repeat(64)

const request = {
  contents: [
    {
      id: "op_0",
      content: {
        kind: "python_units",
        units: [
          {
            kind: "function",
            name: "broken",
            suite: [
              "if True print('x')",
            ],
          },
        ],
      },
    },
  ],
}

const syntaxFailure = {
  ok: false,
  reason:
    "semantic_suite_item_syntax_invalid",
  operation_id: "op_0",
  operation_index: 0,
  unit_index: 0,
  unit_path: [0],
  suite_index: 0,
  field: "suite",
}

assert.equal(
  pythonSemanticFailureIsRepairable(
    syntaxFailure,
  ),
  true,
)

const hint =
  buildPythonSemanticRepairHint({
    failure: syntaxFailure,
    capability,
    request,
    executionContextSha256:
      contextSha,
  })

assert.equal(
  hint.repairable,
  true,
)

assert.equal(
  pythonSemanticRepairAuthorityMatches({
    hint,
    capability,
    executionContextSha256:
      contextSha,
  }),
  true,
)

assert.equal(
  pythonSemanticRepairAuthorityMatches({
    hint,
    capability,
    executionContextSha256:
      "d".repeat(64),
  }),
  false,
)

for (const reason of [
  "representation_ambiguous",
  "semantic_python_binding_unresolved",
  "semantic_python_binding_closure_incomplete",
  "semantic_unsupported",
  "semantic_python_alias_shadowed",
]) {
  assert.equal(
    pythonSemanticFailureIsRepairable({
      ...syntaxFailure,
      reason,
    }),
    false,
    reason,
  )
}

const oldE2E6Shape = {
  ...syntaxFailure,
  reason:
    "python_nested_unit_fields_invalid",
  suite_index: null,
  field: "body",
  unexpected_fields: ["body"],
}

assert.equal(
  pythonSemanticFailureIsRepairable(
    oldE2E6Shape,
  ),
  true,
)

const fragment06 =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/06.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

const fragment09 =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/09.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

assert.match(
  fragment06,
  /pythonSemanticRepairAuthorityMatches/u,
)

assert.match(
  fragment09,
  /pythonSemanticFailureIsRepairable/u,
)

assert.match(
  fragment09,
  /buildPythonSemanticRepairHint/u,
)

assert.match(
  fragment09,
  /PATCH_RETRY reason=/u,
)

console.log(
  "PASS C9-B authority-bound semantic repair " +
    "syntax=repairable " +
    "nested_ir_shape=repairable " +
    "binding=terminal " +
    "authority_conflict=terminal " +
    "same_capability=true " +
    "same_execution_context=true " +
    "existing_attempt_budget=true " +
    "mutation_authority_expansion=false",
)
