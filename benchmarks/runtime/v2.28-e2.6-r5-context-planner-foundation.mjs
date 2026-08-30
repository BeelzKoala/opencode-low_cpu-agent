import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildRepairExecutionProjection,
  compileAdditiveExecutionCapsule,
  snapshotCompiledExecutionCapsule,
  verifyCompiledExecutionCapsule,
} from "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs"
import {
  packExecutionContext,
  renderExecutionContractWithCoverage,
  runStructuralContextPlanner,
} from "../../opencode/plugins/cpu-search-core/execution-context-planner-v1.mjs"
import {
  projectAdditiveExecutionContract,
} from "../../opencode/plugins/cpu-search-core/execution-contract-v1.mjs"

function sha(text) {
  return createHash("sha256").update(Buffer.from(text)).digest("hex")
}

async function put(root, file, body) {
  const target = path.join(root, file)
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(target), { recursive: true }),
  )
  await writeFile(target, body)
}

const root = await mkdtemp(path.join(os.tmpdir(), "r5-foundation-"))
try {
  const route = [
    "from database import get_basdb_conn",
    "",
    "@bp.get('/export')",
    "def export_page():",
    "    conn = get_basdb_conn()",
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

  await put(root, "routes/bestsellers_bp.py", route)
  await put(root, "templates/snippets/menu.html", nav)
  await put(root, "templates/bestsellers_task.html", ui)
  await put(root, "database.py", data)

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
        evidence_lines: [3, 4, 5, 6],
        roles: ["protected_surface", "route_host", "task_anchor_owner"],
        allowed_operations: ["replace_exact"],
      },
      {
        slot: "existing:1",
        file: "templates/snippets/menu.html",
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
        evidence_lines: [3, 4, 5, 6],
        roles: ["protected_surface", "route_host", "task_anchor_owner"],
      },
      {
        file: "templates/snippets/menu.html",
        sha256: sha(nav),
        evidence_lines: [2],
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

  const contract = projectAdditiveExecutionContract(capability)
  assert.equal(contract.ok, true)
  const rendered = renderExecutionContractWithCoverage(contract)
  assert.equal(rendered.ok, true)
  assert.equal(rendered.coverage.complete, true)
  assert.ok(rendered.coverage.scope_count >= 6)

  const future = {
    ...contract,
    visible: { ...contract.visible, future_semantic: "must-not-disappear" },
  }
  assert.equal(renderExecutionContractWithCoverage(future).ok, false)

  // Pure packing gate: the smallest anchor representation is mandatory, then
  // structural enrichment is monotonic and budget-bounded.
  const rows = capability.context_files.map((row) => ({
    ...row,
    tier: [
      "routes/bestsellers_bp.py",
      "templates/snippets/menu.html",
      "templates/bestsellers_task.html",
    ].includes(row.file) ? 0 : 2,
    critical: [
      "routes/bestsellers_bp.py",
      "templates/snippets/menu.html",
      "templates/bestsellers_task.html",
    ].includes(row.file),
    attested: true,
  }))
  const sources = new Map([
    ["routes/bestsellers_bp.py", route],
    ["templates/snippets/menu.html", nav],
    ["templates/bestsellers_task.html", ui],
    ["database.py", data],
  ])


  const degradedPlanner = await runStructuralContextPlanner({
    root,
    rows,
    maxBytes: 2400,
    binary: path.join(root, "missing-context-planner"),
  })
  assert.equal(degradedPlanner.ok, true)
  assert.equal(degradedPlanner.reason, "structural_line_fallback")
  assert.equal(degradedPlanner.response.byte_authority, false)
  assert.ok(
    degradedPlanner.response.files.every((file) =>
      file.candidates.every((candidate) =>
        candidate.ranges.every((range) =>
          range.start_byte == null && range.end_byte == null,
        ),
      ),
    ),
  )
  const structuralResponse = {
    protocol: "context-planner-v1",
    authority: "representation_only",
    backend: "fixture",
    parsed_files: 1,
    fallback_files: 3,
    files: rows.map((row) => ({
      file: row.file,
      parse_status: row.file.endsWith(".py") ? "parsed" : "unsupported",
      candidates: [
        {
          level: "anchor",
          structural: false,
          ranges: row.evidence_lines.map((line) => ({
            start_byte: line,
            end_byte: line + 1,
            start_line: line,
            end_line: line,
          })),
        },
        {
          level: row.file.endsWith(".py") ? "statement" : "window1",
          structural: row.file.endsWith(".py"),
          ranges: [{
            start_byte: 0,
            end_byte: 100,
            start_line: Math.max(1, Math.min(...row.evidence_lines) - 1),
            end_line: Math.max(...row.evidence_lines) + 1,
          }],
        },
      ],
    })),
  }
  const packed = packExecutionContext({
    contract,
    rows,
    criticalFiles: new Set(rows.filter((row) => row.critical).map((row) => row.file)),
    sources,
    structuralResponse,
    maxBytes: 2400,
  })
  assert.equal(packed.ok, true, JSON.stringify(packed))
  assert.equal(packed.semantic_coverage_complete, true)
  assert.equal(packed.evidence_coverage.complete, true)
  assert.ok(packed.minimum_required_bytes <= 2400)
  assert.ok(packed.compiled_bytes <= 2400)

  // Executable shim isolates JS orchestration tests from the Rust binary. Rust
  // candidate correctness is tested independently by cargo test.
  const shim = path.join(root, "planner-shim.mjs")
  await writeFile(shim, `#!/usr/bin/env node\nlet input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{ const r=JSON.parse(input); const files=r.files.map(f=>({file:f.file,critical:f.critical,language:null,parse_status:'unsupported',candidates:[{level:'anchor',structural:false,ranges:f.evidence_lines.map(line=>({start_byte:line,end_byte:line+1,start_line:line,end_line:line})),raw_bytes:f.evidence_lines.length,covered_lines:f.evidence_lines},{level:'window1',structural:false,ranges:[{start_byte:1,end_byte:100,start_line:Math.max(1,Math.min(...f.evidence_lines)-1),end_line:Math.max(...f.evidence_lines)+1}],raw_bytes:99,covered_lines:f.evidence_lines}] })); process.stdout.write(JSON.stringify({protocol:'context-planner-v1',backend:'test-shim',authority:'representation_only',budget_bytes:r.budget_bytes,files_total:files.length,parsed_files:0,fallback_files:files.length,elapsed_ms:0,files})+'\\n'); });\n`)
  await chmod(shim, 0o755)

  const compiled = await compileAdditiveExecutionCapsule({
    root,
    capability,
    baselineContent: `RAW\n${"x".repeat(6000)}`,
    maxBytes: 2400,
    plannerBinary: shim,
  })
  assert.equal(compiled.ok, true, JSON.stringify(compiled))
  assert.equal(compiled.semantic_coverage_complete, true)
  assert.ok(compiled.semantic_coverage_scope_count > 0)
  assert.ok(compiled.compiled_bytes <= 2400)
  assert.ok(compiled.minimum_required_bytes <= 2400)
  assert.equal(compiled.over_budget_bytes, 0)
  assert.equal(compiled.structural_planner_status, "planned")

  const capsule = snapshotCompiledExecutionCapsule(compiled)
  assert.ok(capsule)
  assert.equal(capsule.semantic_coverage_sha256, compiled.semantic_coverage_sha256)
  const verified = await verifyCompiledExecutionCapsule({ root, capsule, capability })
  assert.equal(verified.ok, true)

  // Repair must reuse the immutable planner receipt from the capsule. Removing
  // the planner executable proves no second structural planning pass occurs.
  await rm(shim, { force: true })

  const repair = await buildRepairExecutionProjection({
    root,
    capsule,
    capability,
    repairHint: {
      reason: "additive_plan_coverage_incomplete",
      execution_context_sha256: capsule.capsule_sha256,
      failure_diagnostics: { missing_slots: ["existing:1"] },
      slot_usage: {
        unused_existing_slots: ["existing:1"],
        unused_create_slots: [],
      },
    },
    maxBytes: 1800,
    plannerBinary: shim,
  })
  assert.equal(repair.ok, true, JSON.stringify(repair))
  assert.equal(repair.source_capsule_sha256, capsule.capsule_sha256)
  assert.equal(repair.source_semantic_coverage_sha256, capsule.semantic_coverage_sha256)
  assert.equal(repair.source_structural_plan_sha256, capsule.structural_plan_sha256)
  assert.ok(repair.bytes <= 1800)
  assert.ok(repair.content.includes("FAIL reason=additive_plan_coverage_incomplete"))

  const fragment = await readFile(
    path.resolve("opencode/plugins/cpu-search.fragments/09.part.ts"),
    "utf8",
  )
  assert.ok(fragment.includes("model_context_active_compile_failed"))
  assert.ok(fragment.includes("modelContextSelectedSource ="))
  assert.ok(fragment.includes('\"execution_context_blocked\"'))

  console.log("PASS R5 semantic coverage is proven per scope with bit masks")
  console.log("PASS R5 unknown future semantics fail closed")
  console.log("PASS R5 adaptive structural packing preserves mandatory anchor evidence")
  console.log("PASS R5 full capsule remains bounded without raw Scout fallback")
  console.log("PASS R5 repair preserves capsule + semantic coverage identity")
  console.log("PASS R5 repair reuses immutable structural-plan receipt without rerunning parser")
  console.log("PASS R5 line fallback declares byte authority absent instead of inventing offsets")
} finally {
  await rm(root, { recursive: true, force: true })
}
