import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  compileAdditiveExecutionCapsule,
} from "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs"
import {
  projectAdditiveExecutionContract,
} from "../../opencode/plugins/cpu-search-core/execution-contract-v1.mjs"

function sha(text) {
  return createHash("sha256").update(Buffer.from(text)).digest("hex")
}

const root = await mkdtemp(path.join(os.tmpdir(), "r5-r12-"))
try {
  const route = [
    "from database import get_basdb_conn",
    "",
    "@bp.get('/export')",
    "def export_page():",
    "    return render_template('bestsellers_task.html')",
    "",
  ].join("\n")
  const nav = [
    "<nav>",
    "  <a href='/old'>Old</a>",
    "</nav>",
    "",
  ].join("\n")
  const ui = [
    "{% include 'snippets/menu.html' %}",
    "<main>Bestsellers</main>",
    "",
  ].join("\n")
  const data = [
    "def get_basdb_conn():",
    "    return connect()",
    "",
  ].join("\n")

  for (const [file, body] of [
    ["routes/bestsellers_bp.py", route],
    ["templates/snippets/menu.html", nav],
    ["templates/bestsellers_task.html", ui],
    ["database.py", data],
  ]) {
    await writeFile(path.join(root, file), body, { recursive: false }).catch(async () => {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), body)
    })
  }

  const capability = {
    protocol: "scout-additive-capability-v1",
    operation: "additive_surface",
    binding_ready: true,
    ready: true,
    mutation_authority: true,
    capability_sha256: "a".repeat(64),
    authority_sha256: "b".repeat(64),
    authority_protocol: "sealed-additive-handoff-v1",
    host_bindings: {
      route_owner: "routes/bestsellers_bp.py",
      navigation_host: "templates/snippets/menu.html",
      ui_create_source: "templates/bestsellers_task.html",
      ui_resource: "template:bestsellers_task.html",
      navigation_resource: "template:snippets/menu.html",
      navigation_topology: {
        resource: "template:snippets/menu.html",
        physical_file: "templates/snippets/menu.html",
        shared_includers: 8,
        internal_route_targets: 14,
      },
    },
    budgets: {
      max_operations: 8,
      max_changed_files: 5,
      max_create_files: 2,
      max_plan_bytes: 32 * 1024,
    },
    existing_slots: [
      {
        slot: "existing:0",
        file: "routes/bestsellers_bp.py",
        sha256: sha(route),
        evidence_lines: [3, 4, 5],
        roles: ["protected_surface", "route_host", "task_anchor_owner"],
        allowed_operations: ["replace_exact"],
      },
      {
        slot: "existing:1",
        file: "templates/snippets/menu.html",
        sha256: sha(nav),
        evidence_lines: [1, 2, 3],
        roles: ["navigation_host"],
        allowed_operations: ["replace_exact"],
      },
    ],
    create_slots: [
      {
        slot: "create:0",
        root: "templates",
        source_file: "templates/bestsellers_task.html",
        source_sha256: sha(ui),
        evidence_lines: [1, 2],
        allowed_extensions: [".html"],
        max_depth: 2,
        allowed_operations: ["create_file"],
      },
    ],
    context_files: [
      {
        file: "routes/bestsellers_bp.py",
        sha256: sha(route),
        evidence_lines: [3, 4, 5],
        roles: ["protected_surface", "route_host", "task_anchor_owner"],
      },
      {
        file: "templates/snippets/menu.html",
        sha256: sha(nav),
        evidence_lines: [1, 2, 3],
        roles: ["navigation_host"],
      },
      {
        file: "templates/bestsellers_task.html",
        sha256: sha(ui),
        evidence_lines: [1, 2],
        roles: ["ui_host"],
      },
      {
        file: "database.py",
        sha256: sha(data),
        evidence_lines: [1, 2],
        roles: ["data_access_capability"],
      },
    ],
  }

  const baseline = `RAW\n${"x".repeat(6000)}`
  const contract = projectAdditiveExecutionContract(capability)
  assert.equal(contract.ok, true)
  assert.equal(contract.execution_contract_coverage_complete, true)

  const compiled = await compileAdditiveExecutionCapsule({
    root,
    capability,
    baselineContent: baseline,
    maxBytes: 2400,
  })
  assert.equal(compiled.ok, true, JSON.stringify(compiled))
  assert.equal(compiled.execution_contract_sha256, contract.contract_sha256)
  assert.equal(compiled.critical_file_coverage_complete, true)
  assert.ok(compiled.execution_contract_bytes > 0)
  assert.ok(compiled.critical_evidence_bytes > 0)
  assert.ok(compiled.minimum_required_bytes <= 2400)
  assert.equal(compiled.over_budget_bytes, 0)

  // Semantics live once in the control plane; critical evidence carries source,
  // not a second copy of roles/anchors.
  assert.ok(contract.content.includes(
    "SLOT existing:0 op=replace_exact file=routes/bestsellers_bp.py",
  ))
  assert.ok(contract.content.includes("roles=protected_surface,route_host,task_anchor_owner"))
  assert.ok(compiled.content.includes("SOURCE file=routes/bestsellers_bp.py"))
  assert.ok(!compiled.content.includes(
    "SOURCE file=routes/bestsellers_bp.py roles=protected_surface,route_host,task_anchor_owner",
  ))
  assert.ok(compiled.content.includes("3|@bp.get('/export')"))
  assert.ok(compiled.content.includes("1|{% include 'snippets/menu.html' %}"))

  const tiny = await compileAdditiveExecutionCapsule({
    root,
    capability,
    baselineContent: baseline,
    maxBytes: 512,
  })
  assert.equal(tiny.ok, false)
  assert.ok([
    "execution_contract_over_budget",
    "critical_context_over_budget",
    "required_context_over_budget",
  ].includes(tiny.reason))
  assert.ok(tiny.minimum_required_bytes > 512)
  assert.ok(tiny.over_budget_bytes > 0)

  console.log("PASS E2.6/R5-R1.2 critical evidence header deduplicates control-plane semantics")
  console.log("PASS E2.6/R5-R1.2 slot/role/anchor semantics remain in execution contract")
  console.log("PASS E2.6/R5-R1.2 exact source anchors remain model-visible")
  console.log("PASS E2.6/R5-R1.2 byte ledger exposes minimum required and over-budget bytes")
} finally {
  await rm(root, { recursive: true, force: true })
}
