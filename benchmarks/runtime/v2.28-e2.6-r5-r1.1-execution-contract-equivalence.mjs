import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  additiveRepairAuthorityMatches,
  buildAdditiveRepairHint,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"
import {
  buildRepairExecutionProjection,
  compileAdditiveExecutionCapsule,
  resolveRepairContextBudgetBytes,
  snapshotCompiledExecutionCapsule,
  verifyCompiledExecutionCapsule,
} from "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs"
import {
  extractAdditiveFailureDiagnostics,
  observeAdditivePlanSlotUsage,
  projectAdditiveExecutionContract,
} from "../../opencode/plugins/cpu-search-core/execution-contract-v1.mjs"

function sha(text) {
  return createHash("sha256").update(Buffer.from(text)).digest("hex")
}

const pluginSource = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)
const oneShotScoutIndex = pluginSource.indexOf(
  "const deterministicScoutEligible =",
)
const repairReinjectionIndex = pluginSource.indexOf(
  "const repairExecutionContextEligible =",
)
const allowedToolsAfterRepairIndex = pluginSource.indexOf(
  "const allowedTools = allowedToolsForState(state)",
  repairReinjectionIndex,
)
assert.ok(oneShotScoutIndex >= 0)
assert.ok(repairReinjectionIndex > oneShotScoutIndex)
assert.ok(allowedToolsAfterRepairIndex > repairReinjectionIndex)
assert.ok(
  !pluginSource
    .slice(repairReinjectionIndex, allowedToolsAfterRepairIndex)
    .includes("state.modelCalls === 0"),
)
assert.ok(pluginSource.includes("execution_context_repair_projection"))
assert.ok(pluginSource.includes("repair_context_source_capsule_sha256"))
assert.ok(pluginSource.includes("executionContextSha256:"))

const root = await mkdtemp(path.join(os.tmpdir(), "execution-contract-r11-"))
try {
  const route = [
    "from service import build_export",
    "@bp.get('/export')",
    "def export_page():",
    "    return build_export()",
    "",
  ].join("\n")
  const nav = [
    "<nav>",
    "  <a href='/existing'>Existing</a>",
    "</nav>",
    "",
  ].join("\n")
  const ui = [
    "<main>",
    "  <form id='filters'></form>",
    "</main>",
    "",
  ].join("\n")
  const support = [
    `const unrelated = "${"z".repeat(1400)}"`,
    "",
  ].join("\n")

  for (const [file, content] of [
    ["route.py", route],
    ["nav.html", nav],
    ["ui.html", ui],
    ["support.js", support],
  ]) {
    await writeFile(path.join(root, file), content)
  }

  const capability = {
    protocol: "scout-additive-capability-v1",
    host_binding_protocol: "typed-host-attestation-v2",
    operation: "additive_surface",
    task_shape: "additive",
    binding_ready: true,
    ready: true,
    mutation_authority: true,
    capability_sha256: "a".repeat(64),
    authority_sha256: "b".repeat(64),
    authority_protocol: "sealed-additive-handoff-v1",
    host_bindings: {
      route_owner: "route.py",
      navigation_host: "nav.html",
      ui_create_source: "ui.html",
      ui_resource: "template:ui.html",
      navigation_resource: "template:nav.html",
    },
    existing_slots: [
      {
        slot: "existing:0",
        file: "route.py",
        sha256: sha(route),
        evidence_lines: [3],
        roles: ["route_host"],
        allowed_operations: ["replace_exact"],
      },
      {
        slot: "existing:1",
        file: "nav.html",
        sha256: sha(nav),
        evidence_lines: [2],
        roles: ["navigation_host"],
        allowed_operations: ["replace_exact"],
      },
    ],
    create_slots: [
      {
        slot: "create:0",
        root: "templates",
        source_file: "ui.html",
        source_sha256: sha(ui),
        evidence_lines: [2],
        allowed_extensions: [".html"],
        max_depth: 2,
        allowed_operations: ["create_file"],
      },
    ],
    context_files: [
      {
        file: "route.py",
        sha256: sha(route),
        evidence_lines: [3],
        roles: ["route_host"],
      },
      {
        file: "nav.html",
        sha256: sha(nav),
        evidence_lines: [2],
        roles: ["navigation_host"],
      },
      {
        file: "ui.html",
        sha256: sha(ui),
        evidence_lines: [2],
        roles: ["ui_host"],
      },
      {
        file: "support.js",
        sha256: sha(support),
        evidence_lines: [1],
        roles: ["context"],
      },
    ],
    budgets: {
      max_operations: 8,
      max_changed_files: 5,
      max_create_files: 2,
      max_plan_bytes: 32 * 1024,
    },
  }

  const contract = projectAdditiveExecutionContract(capability)
  assert.equal(contract.ok, true)
  assert.equal(contract.execution_contract_coverage_complete, true)
  assert.ok(contract.content.includes("SLOT existing:0 op=replace_exact file=route.py"))
  assert.ok(contract.content.includes("SLOT existing:1 op=replace_exact file=nav.html"))
  assert.ok(contract.content.includes("SLOT create:0 op=create_file source=ui.html"))
  assert.ok(contract.content.includes("path=relative_to_sealed_root"))
  assert.ok(!contract.content.includes("root=templates"))
  assert.equal(contract.mutation_authority, false)

  const unknownHost = structuredClone(capability)
  unknownHost.host_bindings.future_semantic = "must-not-be-dropped"
  assert.equal(projectAdditiveExecutionContract(unknownHost).ok, false)

  const baseline = `RAW SEARCH OUTPUT\n${"x".repeat(6000)}`
  const compiled = await compileAdditiveExecutionCapsule({
    root,
    capability,
    baselineContent: baseline,
    maxBytes: 2400,
  })
  assert.equal(compiled.ok, true)
  assert.equal(compiled.execution_contract_coverage_complete, true)
  assert.equal(compiled.critical_file_coverage_complete, true)
  assert.ok(compiled.compiled_bytes <= 2400)
  assert.ok(compiled.compiled_bytes < compiled.source_bytes)
  assert.equal(compiled.semantic_coverage_complete, true)
  assert.ok(typeof compiled.semantic_coverage_sha256 === "string")

  const capsule = snapshotCompiledExecutionCapsule(compiled)
  assert.ok(capsule)
  assert.equal(capsule.capsule_sha256, compiled.content_sha256)

  const verified = await verifyCompiledExecutionCapsule({
    root,
    capsule,
    capability,
  })
  assert.equal(verified.ok, true)

  const request = {
    replacements: [{
      slot: "existing:0",
      before: "def export_page():",
      replacement: "def export_page(start=None, end=None):",
    }],
    creations: [],
  }
  const slotUsage = observeAdditivePlanSlotUsage({ capability, request })
  assert.deepEqual(slotUsage.unused_existing_slots, ["existing:1"])
  assert.deepEqual(slotUsage.unused_create_slots, ["create:0"])
  assert.equal(slotUsage.observation_only, true)

  const syntheticFailure = {
    reason: "additive_plan_coverage_incomplete",
    missing_slots: ["existing:1", "create:0"],
    missing_roles: ["navigation_host", "ui_host"],
    missing_obligations: ["navigation_update", "ui_create"],
  }
  const diagnostics = extractAdditiveFailureDiagnostics(syntheticFailure)
  assert.deepEqual(diagnostics.missing_slots, ["create:0", "existing:1"])
  assert.deepEqual(diagnostics.missing_roles, ["navigation_host", "ui_host"])

  const repairHint = buildAdditiveRepairHint({
    failure: syntheticFailure,
    capability,
    request,
    executionContextSha256: capsule.capsule_sha256,
  })
  assert.equal(repairHint.repairable, true)
  assert.equal(repairHint.execution_context_sha256, capsule.capsule_sha256)
  assert.deepEqual(repairHint.slot_usage.unused_existing_slots, ["existing:1"])
  assert.deepEqual(repairHint.slot_usage.unused_create_slots, ["create:0"])
  assert.deepEqual(repairHint.failure_diagnostics.missing_slots, ["create:0", "existing:1"])
  assert.equal(additiveRepairAuthorityMatches({
    hint: repairHint,
    capability,
    executionContextSha256: capsule.capsule_sha256,
  }), true)
  assert.equal(additiveRepairAuthorityMatches({
    hint: repairHint,
    capability,
    executionContextSha256: "f".repeat(64),
  }), false)

  const repair = await buildRepairExecutionProjection({
    root,
    capsule,
    capability,
    repairHint,
    maxBytes: 1800,
  })
  assert.equal(repair.ok, true)
  assert.equal(repair.source_capsule_sha256, capsule.capsule_sha256)
  assert.equal(repair.source_contract_sha256, capsule.execution_contract_sha256)
  assert.deepEqual(repair.target_slots, ["create:0", "existing:1"])
  assert.ok(repair.content.includes("FAIL reason=additive_plan_coverage_incomplete"))
  assert.ok(repair.content.includes("SOURCE file=nav.html"))
  assert.ok(repair.content.includes("SOURCE file=ui.html"))
  assert.ok(!repair.content.includes("SOURCE file=route.py"))
  assert.ok(repair.bytes <= 1800)

  const driftedCapability = structuredClone(capability)
  driftedCapability.capability_sha256 = "c".repeat(64)
  const drift = await verifyCompiledExecutionCapsule({
    root,
    capsule,
    capability: driftedCapability,
  })
  assert.equal(drift.ok, false)
  assert.equal(drift.reason, "execution_context_capsule_authority_drift")

  await writeFile(path.join(root, "nav.html"), `${nav}\n<!-- drift -->\n`)
  const sourceDrift = await verifyCompiledExecutionCapsule({
    root,
    capsule,
    capability,
  })
  assert.equal(sourceDrift.ok, false)
  assert.equal(sourceDrift.reason, "context_file_stale")

  assert.equal(resolveRepairContextBudgetBytes("1800"), 1800)
  assert.equal(resolveRepairContextBudgetBytes("1"), 768)
  assert.equal(resolveRepairContextBudgetBytes("99999"), 3200)

  console.log("PASS E2.6/R5-R1.1 full->compact execution contract preserves slot semantics")
  console.log("PASS E2.6/R5-R1.1 hidden preconditions remain machine-enforced, not model-authored")
  console.log("PASS E2.6/R5-R1.1 capsule identity binds capability + evidence across repair")
  console.log("PASS E2.6/R5-R1.1 repair projection carries exact failure delta and target evidence")
  console.log("PASS E2.6/R5-R1.1 slot usage is telemetry-only; validator diagnostics stay distinct")
  console.log("PASS E2.6/R5-R1.1 authority/source drift fails closed")
} finally {
  await rm(root, { recursive: true, force: true })
}
