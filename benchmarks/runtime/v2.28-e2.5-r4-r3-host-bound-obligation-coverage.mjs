import assert from "node:assert/strict"

import {
  MUTATION_OBLIGATION_BINDING_PROTOCOL,
  MUTATION_OBLIGATION_PROTOCOL,
  MUTATION_PLAN_COVERAGE_PROTOCOL,
  buildAdditiveRepairHint,
  deriveAdditiveMutationObligations,
  materializeAdditiveMutationPlan,
  renderAdditiveMutationCapability,
  validateAdditivePlanCoverage,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v3.mjs"

function hostBoundCapability({ navigation = true } = {}) {
  return {
    protocol: "scout-additive-capability-v1",
    operation: "additive_surface",
    task_shape: "additive",
    binding_ready: true,
    ready: true,
    mutation_authority: true,
    authority_protocol: MUTATION_OBLIGATION_BINDING_PROTOCOL,
    capability_sha256: "a".repeat(64),
    authority_sha256: "b".repeat(64),
    host_bindings: {
      route_owner: "pkg-x/core/feature.py",
      navigation_host: navigation ? "assets-z/shared/navigation.html" : null,
      ui_create_source: "views-q/base/page.html",
      ui_resource: "resource:page.html",
      navigation_resource: navigation ? "resource:navigation.html" : null,
    },
    existing_slots: [
      {
        slot: "existing:0",
        file: "pkg-x/core/feature.py",
        sha256: "c".repeat(64),
        evidence_lines: [5],
        roles: ["implementation_host"],
        allowed_operations: ["replace_exact"],
      },
      ...(navigation ? [{
        slot: "existing:1",
        file: "assets-z/shared/navigation.html",
        sha256: "d".repeat(64),
        evidence_lines: [9],
        roles: ["integration_host"],
        allowed_operations: ["replace_exact"],
      }] : []),
    ],
    create_slots: [{
      slot: "create:0",
      root: "views-q/generated",
      source_file: "views-q/base/page.html",
      source_sha256: "e".repeat(64),
      evidence_lines: [3],
      allowed_extensions: [".html"],
      max_depth: 2,
      allowed_operations: ["create_file"],
    }],
    context_files: [],
    budgets: {
      max_operations: 8,
      max_changed_files: 5,
      max_create_files: 2,
      max_plan_bytes: 65536,
    },
  }
}

const importsOnly = {
  python_imports: [{
    slot: "existing:0",
    modules: ["library.alpha"],
    from_imports: [],
  }],
  python_declarations: [],
  replacements: [],
  creations: [],
}

{
  const compiled = deriveAdditiveMutationObligations(
    hostBoundCapability(),
  )
  assert.equal(compiled.ok, true)
  assert.equal(compiled.applicable, true)
  assert.equal(compiled.protocol, MUTATION_OBLIGATION_PROTOCOL)
  assert.deepEqual(
    compiled.obligations.map(
      (row) => [row.id, row.slot, row.operation_class],
    ),
    [
      ["server_surface", "existing:0", "python_declaration"],
      ["navigation_integration", "existing:1", "replacement"],
      ["ui_surface", "create:0", "creation"],
    ],
  )
}

{
  // Exact current E2E failure class.
  const coverage = validateAdditivePlanCoverage({
    capability: hostBoundCapability(),
    request: importsOnly,
  })
  assert.equal(coverage.ok, false)
  assert.equal(coverage.reason, "additive_plan_coverage_incomplete")
  assert.equal(coverage.coverage_protocol, MUTATION_PLAN_COVERAGE_PROTOCOL)
  assert.equal(coverage.repairable, true)
  assert.deepEqual(
    coverage.missing_obligations.map((row) => row.id),
    ["server_surface", "navigation_integration", "ui_surface"],
  )

  const hint = buildAdditiveRepairHint({
    failure: coverage,
    capability: hostBoundCapability(),
  })
  assert.equal(hint.repairable, true)
  assert.equal(hint.reason, "additive_plan_coverage_incomplete")
}

{
  // Host-bound model plans stop before the typed Python compiler.
  let compilerCalls = 0
  const plan = await materializeAdditiveMutationPlan({
    root: process.cwd(),
    capability: hostBoundCapability(),
    request: importsOnly,
    compilePython: async () => {
      compilerCalls += 1
      throw new Error("compiler_must_not_run")
    },
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, "additive_plan_coverage_incomplete")
  assert.equal(compilerCalls, 0)
}

{
  const complete = validateAdditivePlanCoverage({
    capability: hostBoundCapability(),
    request: {
      python_imports: [],
      python_declarations: [{
        slot: "existing:0",
        content: "def build_feature():\n    return 1\n",
      }],
      replacements: [{
        slot: "existing:1",
        before: "old-nav",
        replacement: "new-nav",
      }],
      creations: [{
        slot: "create:0",
        relative_path: "feature.html",
        content: "<main>feature</main>",
      }],
    },
  })
  assert.equal(complete.ok, true)
  assert.equal(complete.applicable, true)
  assert.equal(complete.protocol, MUTATION_PLAN_COVERAGE_PROTOCOL)
}

{
  // R2.1-style compiler fixture: authorized typed slots, intentionally no
  // host-binding contract. Coverage must not become a lower-level compiler
  // precondition.
  const compilerFixture = {
    protocol: "scout-additive-capability-v1",
    ready: true,
    mutation_authority: true,
    operation: "additive_surface",
    capability_sha256: "f".repeat(64),
    existing_slots: [{
      slot: "existing:0",
      file: "pkg/compiler_fixture.py",
      sha256: "1".repeat(64),
      evidence_lines: [2, 4],
      roles: ["task_anchor_owner"],
    }],
    create_slots: [],
  }
  const request = {
    python_imports: [{
      slot: "existing:0",
      modules: ["io"],
      from_imports: [],
    }],
    python_declarations: [{
      slot: "existing:0",
      content: "def added():\n    return 1",
    }],
    replacements: [],
    creations: [],
  }

  const coverage = validateAdditivePlanCoverage({
    capability: compilerFixture,
    request,
  })
  assert.equal(coverage.ok, true)
  assert.equal(coverage.applicable, false)
  assert.equal(
    coverage.reason,
    "mutation_obligation_coverage_not_applicable",
  )

  let compilerCalls = 0
  const plan = await materializeAdditiveMutationPlan({
    root: process.cwd(),
    capability: compilerFixture,
    request,
    compilePython: async () => {
      compilerCalls += 1
      return {
        ok: true,
        edits: [{ before: "old", replacement: "new" }],
        candidate_receipt: {
          protocol: "candidate-static-preflight-v1",
          file: "pkg/compiler_fixture.py",
          base_sha256: "1".repeat(64),
          candidate_sha256: "2".repeat(64),
          checks: {
            ast_syntax: "passed",
            format: "not_run",
            lint: "not_run",
            type_check: "not_run",
            complexity: "not_run",
          },
          mutation_authority: false,
        },
      }
    },
  })
  assert.equal(plan.ok, true)
  assert.equal(compilerCalls, 1)

  const rendered = renderAdditiveMutationCapability(compilerFixture)
  assert.doesNotMatch(rendered, /REQUIRED_MUTATION_COVERAGE/u)
}

{
  // binding_ready is the layer boundary. Once asserted, host authority and
  // exact bindings become mandatory and fail closed.
  const broken = hostBoundCapability()
  broken.authority_protocol = "wrong-authority"
  const coverage = validateAdditivePlanCoverage({
    capability: broken,
    request: importsOnly,
  })
  assert.equal(coverage.ok, false)
  assert.equal(coverage.reason, "additive_obligation_contract_unresolved")
  assert.equal(coverage.repairable, false)
}

{
  // Declared bindings must still resolve to exactly one sealed slot.
  const broken = hostBoundCapability()
  broken.existing_slots = broken.existing_slots.filter(
    (row) => row.slot !== "existing:0",
  )
  const coverage = validateAdditivePlanCoverage({
    capability: broken,
    request: importsOnly,
  })
  assert.equal(coverage.ok, false)
  assert.equal(coverage.reason, "additive_obligation_contract_unresolved")
  assert.equal(coverage.repairable, false)
}

{
  const compiled = deriveAdditiveMutationObligations(
    hostBoundCapability({ navigation: false }),
  )
  assert.equal(compiled.ok, true)
  assert.deepEqual(
    compiled.obligations.map((row) => row.id),
    ["server_surface", "ui_surface"],
  )
}

{
  const rendered = renderAdditiveMutationCapability(
    hostBoundCapability(),
  )
  assert.match(rendered, /REQUIRED_MUTATION_COVERAGE/u)
  assert.match(rendered, /server_surface@existing:0:python_declaration/u)
  assert.match(rendered, /navigation_integration@existing:1:replacement/u)
  assert.match(rendered, /ui_surface@create:0:creation/u)
  assert.match(rendered, /python_imports=support_only/u)
  assert.doesNotMatch(rendered, /bestsellers|ozon|flask/iu)
}

console.log(
  "PASS E2.5/R4-R3 host-bound mutation obligations preserve lower-level R2.1 compiler independence while rejecting incomplete model plans before Compiler",
)
