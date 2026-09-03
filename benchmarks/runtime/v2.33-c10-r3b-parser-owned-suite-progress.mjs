import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

import {
  normalizePythonSuiteChunk,
} from "../../opencode/plugins/cpu-search-core/python-nested-semantic-ir-v1.mjs"

import {
  PYTHON_SEMANTIC_PROGRESS_PROTOCOL,
  createPythonClassMemberProgressLedger,
} from "../../opencode/plugins/cpu-search-core/python-semantic-progress-v1.mjs"

import {
  buildPythonSemanticRepairHint,
  pythonSemanticFailureIsRepairable,
  pythonSemanticRepairAuthorityMatches,
} from "../../opencode/plugins/cpu-search-core/python-semantic-repair-v1.mjs"

const bridge =
  process.env.OPENCODE_RUFF_PYTHON_BRIDGE

assert.equal(
  typeof bridge,
  "string",
  "OPENCODE_RUFF_PYTHON_BRIDGE required",
)

function bridgeCall(payload) {
  const result =
    spawnSync(
      bridge,
      [],
      {
        input:
          JSON.stringify(payload),
        encoding: "utf8",
        maxBuffer:
          1024 * 1024,
      },
    )

  assert.equal(
    result.error,
    undefined,
    String(result.error),
  )
  assert.equal(
    result.status,
    0,
    result.stderr,
  )

  return JSON.parse(
    result.stdout,
  )
}

const raw =
  "    conn = get_conn()\n" +
  "    try:\n" +
  "        value = fetch(conn)\n" +
  "        return value\n" +
  "    finally:\n" +
  "        conn.close()"

const normalized =
  normalizePythonSuiteChunk(raw)

assert.equal(
  normalized,
  "conn = get_conn()\n" +
  "try:\n" +
  "    value = fetch(conn)\n" +
  "    return value\n" +
  "finally:\n" +
  "    conn.close()",
)

const multi =
  bridgeCall({
    command:
      "validate_suite_items",
    sources: [
      {
        file: "0",
        source: normalized,
      },
    ],
  })

assert.equal(
  multi.ok,
  true,
  JSON.stringify(multi),
)
assert.equal(
  multi.suite_protocol,
  "python-suite-ir-v2",
)
assert.deepEqual(
  multi.statement_counts,
  [2],
)
assert.equal(
  multi.atomic_statement_boundary,
  false,
)
assert.equal(
  multi.statement_chunk_boundary,
  true,
)
assert.equal(
  multi.mutation_authority,
  false,
)

const malformed =
  bridgeCall({
    command:
      "validate_suite_items",
    sources: [
      {
        file: "0",
        source:
          "try:\n    x = 1",
      },
    ],
  })

assert.equal(
  malformed.ok,
  false,
)
assert.equal(
  malformed.reason,
  "semantic_suite_item_syntax_invalid",
)

const zeroStatement =
  bridgeCall({
    command:
      "validate_suite_items",
    sources: [
      {
        file: "0",
        source:
          "# comment only",
      },
    ],
  })

assert.equal(
  zeroStatement.ok,
  false,
)
assert.equal(
  zeroStatement.reason,
  "semantic_suite_item_statement_count_invalid",
)
assert.equal(
  zeroStatement.minimum_statements,
  1,
)

assert.equal(
  PYTHON_SEMANTIC_PROGRESS_PROTOCOL,
  "python-semantic-progress-v1",
)

const repairCapability = {
  ready: true,
  mutation_authority: true,
  capability_sha256:
    "a".repeat(64),
  authority_sha256:
    "b".repeat(64),
}

const repairExecutionContextSha256 =
  "c".repeat(64)

const repairRequest = {
  contents: [
    {
      id: "op_0",
      content: {
        kind: "python_units",
        units: [],
      },
    },
  ],
}

function materializedMemberFailure(
  reason,
) {
  return {
    ok: false,
    reason,
    operation_id: "op_0",
    operation_index: 0,
    unit_index: 0,
    unit_path: [0, 1],
    suite_index: null,
    field: "members",
    mutation_authority: false,
  }
}

function assertBoundedRepairable(reason) {
  const failure =
    materializedMemberFailure(
      reason,
    )

  assert.equal(
    pythonSemanticFailureIsRepairable(
      failure,
    ),
    true,
  )

  const hint =
    buildPythonSemanticRepairHint({
      failure,
      capability:
        repairCapability,
      request:
        repairRequest,
      executionContextSha256:
        repairExecutionContextSha256,
    })

  assert.equal(
    hint.repairable,
    true,
  )
  assert.equal(
    hint.mutation_authority,
    false,
  )

  assert.equal(
    pythonSemanticRepairAuthorityMatches({
      hint,
      capability:
        repairCapability,
      executionContextSha256:
        repairExecutionContextSha256,
    }),
    true,
  )

  assert.equal(
    pythonSemanticRepairAuthorityMatches({
      hint,
      capability:
        repairCapability,
      executionContextSha256:
        "d".repeat(64),
    }),
    false,
  )
}

const exactLedger =
  createPythonClassMemberProgressLedger()

const methodA = {
  kind: "function",
  name: "download_report",
  parameters: "self",
  body: "return 1",
}

const first =
  exactLedger.observe(methodA)

assert.equal(first.ok, true)

const repeated =
  exactLedger.observe({
    ...methodA,
  })

assert.equal(
  repeated.ok,
  false,
)
assert.equal(
  repeated.reason,
  "python_nested_repeated_member_cycle",
)
assert.equal(
  repeated.exact_repeat,
  true,
)
assert.equal(
  repeated.mutation_authority,
  false,
)
assertBoundedRepairable(
  "python_nested_repeated_member_cycle",
)

const conflictLedger =
  createPythonClassMemberProgressLedger()

assert.equal(
  conflictLedger.observe(
    methodA,
  ).ok,
  true,
)

const conflict =
  conflictLedger.observe({
    ...methodA,
    body: "return 2",
  })

assert.equal(
  conflict.ok,
  false,
)
assert.equal(
  conflict.reason,
  "python_nested_class_member_identity_conflict",
)
assert.equal(
  conflict.identity_conflict,
  true,
)
assert.equal(
  conflict.mutation_authority,
  false,
)
assertBoundedRepairable(
  "python_nested_class_member_identity_conflict",
)

console.log(
  "PASS C10-R3B parser-owned suite progress " +
  "suite_protocol=python-suite-ir-v2 " +
  "multi_statement_chunk=true " +
  "common_margin_dedent=compiler_owned " +
  "parser_authority=ruff " +
  "malformed_chunk=fail_closed " +
  "zero_statement=fail_closed " +
  "repeated_exact_member=fail_closed " +
  "distinct_same_name_conflict=fail_closed " +
  "semantic_progress=exact_fingerprint " +
  "repair=existing_authority_bound " +
  "repair_fixture=materialized_failure_shape " +
  "repair_context_drift=fail_closed " +
  "mutation_authority_expansion=false",
)
