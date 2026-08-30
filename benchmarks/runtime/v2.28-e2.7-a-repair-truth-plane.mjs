import assert from "node:assert/strict"

import {
  ADDITIVE_COVERAGE_FAILURE_PROTOCOL,
  ADDITIVE_PLAN_OPERATION_USAGE_PROTOCOL,
  extractAdditiveFailureDiagnostics,
  normalizeAdditiveCoverageFailure,
  observeAdditivePlanSlotUsage,
  projectAdditiveExecutionContract,
  repairTargetSlots,
} from "../../opencode/plugins/cpu-search-core/execution-contract-v1.mjs"
import {
  ADDITIVE_REPAIR_HINT_PROTOCOL,
  buildAdditiveRepairHint,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"

function capability(authority = "b".repeat(64)) {
  return {
    protocol: "scout-additive-capability-v1",
    ready: true,
    binding_ready: true,
    mutation_authority: true,
    operation: "additive_surface",
    capability_sha256: "a".repeat(64),
    authority_sha256: authority,
    authority_protocol: "sealed-additive-handoff-v1",
    host_bindings: {
      route_owner: "routes/example.py",
      navigation_host: "templates/snippets/menu.html",
      ui_create_source: "templates/example.html",
    },
    existing_slots: [
      {
        slot: "existing:0",
        file: "routes/example.py",
        sha256: "1".repeat(64),
        evidence_lines: [10],
        roles: ["route_host"],
        allowed_operations: ["replace_exact"],
      },
      {
        slot: "existing:1",
        file: "templates/snippets/menu.html",
        sha256: "2".repeat(64),
        evidence_lines: [3],
        roles: ["navigation_host"],
        allowed_operations: ["replace_exact"],
      },
    ],
    create_slots: [
      {
        slot: "create:0",
        root: "templates",
        source_file: "templates/example.html",
        source_sha256: "3".repeat(64),
        evidence_lines: [1],
        allowed_extensions: [".html"],
        max_depth: 2,
        allowed_operations: ["create_file"],
      },
    ],
    context_files: [],
    budgets: {
      max_operations: 8,
      max_changed_files: 5,
      max_create_files: 2,
      max_plan_bytes: 32768,
    },
  }
}

const cap = capability()
const contract = projectAdditiveExecutionContract(cap)
assert.equal(contract.ok, true)
assert.equal(contract.semantic_contract_sha256, contract.visible_sha256)
assert.equal(contract.authority_instance_sha256, cap.authority_sha256)
assert.equal(contract.execution_instance_sha256, contract.contract_sha256)

const second = projectAdditiveExecutionContract(
  capability("c".repeat(64)),
)
assert.equal(second.ok, true)
assert.equal(
  second.semantic_contract_sha256,
  contract.semantic_contract_sha256,
)
assert.notEqual(
  second.execution_instance_sha256,
  contract.execution_instance_sha256,
)

const request = {
  python_imports: [
    {
      slot: "existing:0",
      modules: ["datetime"],
      from_imports: [],
    },
  ],
  python_declarations: [
    {
      slot: "existing:0",
      content: "def export_report():\n    pass",
    },
  ],
  replacements: [],
  creations: [],
}

const usage = observeAdditivePlanSlotUsage({
  capability: cap,
  request,
})
assert.equal(
  usage.protocol,
  ADDITIVE_PLAN_OPERATION_USAGE_PROTOCOL,
)
assert.deepEqual(
  usage.submitted_existing_slots,
  ["existing:0"],
)
assert.deepEqual(
  usage.unused_existing_slots,
  ["existing:1"],
)
assert.deepEqual(
  usage.unused_create_slots,
  ["create:0"],
)
assert.equal(
  usage.submitted_operation_mask,
  "0x3",
)
assert.deepEqual(
  usage.operations_by_slot,
  [
    {
      slot: "existing:0",
      operation_mask: "0x3",
      operations: ["python_declaration", "python_import"],
    },
  ],
)

const failure = {
  reason: "additive_plan_coverage_incomplete",
  detail:
    "missing=" +
    "server_surface@existing:0:python_declaration," +
    "navigation_integration@existing:1:replacement," +
    "ui_surface@create:0:creation",
}
const ir = normalizeAdditiveCoverageFailure({
  failure,
  capability: cap,
})
assert.equal(ir.protocol, ADDITIVE_COVERAGE_FAILURE_PROTOCOL)
assert.equal(ir.source, "legacy_detail_projection")
assert.equal(ir.missing.length, 3)
assert.deepEqual(
  ir.missing_slots,
  ["create:0", "existing:0", "existing:1"],
)
assert.deepEqual(
  ir.missing_obligations,
  [
    "navigation_integration",
    "server_surface",
    "ui_surface",
  ],
)
assert.equal(ir.mutation_authority, false)

const structured = normalizeAdditiveCoverageFailure({
  failure: {
    reason: "additive_plan_coverage_incomplete",
    coverage_failure: {
      missing: ir.missing,
    },
  },
  capability: cap,
})
assert.equal(structured.source, "structured_validator")
assert.deepEqual(structured.missing, ir.missing)

const malformed = normalizeAdditiveCoverageFailure({
  failure: {
    reason: "additive_plan_coverage_incomplete",
    detail: "missing=server_surface@existing:999:python_declaration",
  },
  capability: cap,
})
assert.equal(malformed, null)

const diagnostics = extractAdditiveFailureDiagnostics(
  failure,
  { capability: cap },
)
assert.deepEqual(
  diagnostics.missing_slots,
  ["create:0", "existing:0", "existing:1"],
)
assert.equal(
  diagnostics.coverage_failure_source,
  "legacy_detail_projection",
)

const hint = buildAdditiveRepairHint({
  failure,
  capability: cap,
  request,
  executionContextSha256: "d".repeat(64),
})
assert.equal(hint.protocol, ADDITIVE_REPAIR_HINT_PROTOCOL)
assert.deepEqual(
  hint.slot_usage.submitted_existing_slots,
  ["existing:0"],
)
assert.equal(
  hint.coverage_failure.protocol,
  ADDITIVE_COVERAGE_FAILURE_PROTOCOL,
)
assert.equal(
  hint.coverage_failure_sha256,
  hint.coverage_failure.failure_sha256,
)
assert.equal(typeof hint.failed_candidate_sha256, "string")

const targets = repairTargetSlots({
  contract,
  hint,
})
assert.deepEqual(
  targets.slots,
  ["create:0", "existing:0", "existing:1"],
)
assert.equal(targets.reason, "coverage_failure_ir")
assert.equal(targets.observation_only, false)

console.log("PASS E2.7-A operation-aware usage observes every additive family")
console.log("PASS E2.7-A coverage failure is typed, validated and fail-closed")
console.log("PASS E2.7-A repair hint preserves validator failure IR")
console.log("PASS E2.7-A semantic identity is stable across sealed authority instances")
console.log("PASS E2.7-A execution-instance identity remains authority-bound")
console.log("PASS E2.7-A no mutation authority introduced")
