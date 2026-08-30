import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildRepairExecutionProjection,
  compileAdditiveExecutionCapsule,
  snapshotCompiledExecutionCapsule,
} from "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs"
import {
  buildAdditiveRepairHint,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"
import {
  REPAIR_CONVERGENCE_PROTOCOL,
  classifyRepairProgress,
} from "../../opencode/plugins/cpu-search-core/repair-convergence-v1.mjs"

function sha(value) {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
}

async function put(root, rel, content) {
  const absolute = path.join(root, rel)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content, "utf8")
}

const root = await mkdtemp(
  path.join(os.tmpdir(), "e27-repair-foundation-"),
)
try {
  const route = [
    "from database import get_basdb_conn",
    "",
    "def bestsellers_task():",
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
      max_plan_bytes: 32768,
    },
    existing_slots: [
      {
        slot: "existing:0",
        file: "routes/bestsellers_bp.py",
        sha256: sha(route),
        evidence_lines: [3, 4, 5],
        roles: ["protected_surface", "route_host"],
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
        evidence_lines: [3, 4, 5],
        roles: ["protected_surface", "route_host"],
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
        evidence_lines: [1],
        roles: ["data_access_capability"],
      },
    ],
  }

  const shim = path.join(root, "planner-shim.mjs")
  await writeFile(
    shim,
    `#!/usr/bin/env node
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{
  const r=JSON.parse(input);
  const files=r.files.map(f=>({
    file:f.file,
    critical:f.critical,
    language:null,
    parse_status:'unsupported',
    candidates:[
      {
        level:'anchor',
        structural:false,
        ranges:f.evidence_lines.map(line=>({
          start_byte:null,end_byte:null,start_line:line,end_line:line
        })),
        raw_bytes:f.evidence_lines.length,
        covered_lines:f.evidence_lines
      },
      {
        level:'window1',
        structural:false,
        ranges:[{
          start_byte:null,end_byte:null,
          start_line:Math.max(1,Math.min(...f.evidence_lines)-1),
          end_line:Math.max(...f.evidence_lines)+1
        }],
        raw_bytes:64,
        covered_lines:f.evidence_lines
      }
    ]
  }));
  process.stdout.write(JSON.stringify({
    protocol:'context-planner-v1',
    backend:'test-shim',
    authority:'representation_only',
    budget_bytes:r.budget_bytes,
    files_total:files.length,
    parsed_files:0,
    fallback_files:files.length,
    byte_authority:false,
    elapsed_ms:0,
    files
  })+'\\n');
});
`,
    "utf8",
  )
  await chmod(shim, 0o755)

  const compiled = await compileAdditiveExecutionCapsule({
    root,
    capability,
    baselineContent: `RAW\n${"x".repeat(6000)}`,
    maxBytes: 2400,
    plannerBinary: shim,
  })
  assert.equal(compiled.ok, true, JSON.stringify(compiled))
  const capsule = snapshotCompiledExecutionCapsule(compiled)
  assert.ok(capsule)
  await rm(shim, { force: true })

  const request = {
    python_imports: [{
      slot: "existing:0",
      modules: ["datetime"],
      from_imports: [],
    }],
    python_declarations: [{
      slot: "existing:0",
      content: "import datetime",
    }],
    replacements: [],
    creations: [],
  }
  const failure = {
    reason: "additive_plan_coverage_incomplete",
    detail:
      "missing=" +
      "server_surface@existing:0:python_declaration," +
      "navigation_integration@existing:1:replacement," +
      "ui_surface@create:0:creation",
  }
  const hint = buildAdditiveRepairHint({
    failure,
    capability,
    request,
    executionContextSha256: capsule.capsule_sha256,
  })
  assert.equal(hint.repairable, true)
  assert.equal(hint.repair_progress.protocol, REPAIR_CONVERGENCE_PROTOCOL)
  assert.equal(hint.repair_progress.status, "initial")

  const repair = await buildRepairExecutionProjection({
    root,
    capsule,
    capability,
    repairHint: hint,
    maxBytes: 1800,
  })
  assert.equal(repair.ok, true, JSON.stringify(repair))
  assert.equal(
    repair.protocol,
    "repair-execution-context-projection-v2",
  )
  assert.equal(repair.reason, "repair_delta_from_verified_capsule")
  assert.equal(repair.target_observation_only, false)
  assert.deepEqual(
    repair.target_slots,
    ["create:0", "existing:0", "existing:1"],
  )
  assert.ok(repair.bytes <= 1800)
  assert.ok(repair.content.includes(
    "MISSING obligation=server_surface slot=existing:0 operation=python_declaration",
  ))
  assert.ok(repair.content.includes(
    "MISSING obligation=navigation_integration slot=existing:1 operation=replacement",
  ))
  assert.ok(repair.content.includes(
    "MISSING obligation=ui_surface slot=create:0 operation=creation",
  ))
  assert.ok(repair.content.includes("SOURCE file=routes/bestsellers_bp.py"))
  assert.ok(repair.content.includes("SOURCE file=templates/snippets/menu.html"))
  assert.ok(repair.content.includes("SOURCE file=templates/bestsellers_task.html"))
  assert.ok(!repair.content.includes("SOURCE file=database.py"))
  assert.ok(!repair.content.includes("EXECUTION_CONTRACT protocol="))
  assert.equal(
    repair.coverage_failure_sha256,
    hint.coverage_failure_sha256,
  )
  assert.equal(
    repair.failed_candidate_sha256,
    hint.failed_candidate_sha256,
  )

  const same = classifyRepairProgress({
    previousFailure: hint.coverage_failure,
    currentFailure: hint.coverage_failure,
  })
  assert.equal(same.status, "no_progress")
  assert.equal(same.allow_retry, false)

  const subsetFailure = {
    ...hint.coverage_failure,
    missing: hint.coverage_failure.missing.slice(0, 2),
  }
  const progress = classifyRepairProgress({
    previousFailure: hint.coverage_failure,
    currentFailure: subsetFailure,
  })
  assert.equal(progress.status, "progress")
  assert.equal(progress.allow_retry, true)
  assert.equal(progress.strict_progress, true)

  const regressionFailure = {
    ...hint.coverage_failure,
    missing: [
      ...hint.coverage_failure.missing,
      {
        obligation: "new_failure",
        slot: "existing:0",
        operation: "replacement",
      },
    ],
  }
  const regression = classifyRepairProgress({
    previousFailure: hint.coverage_failure,
    currentFailure: regressionFailure,
  })
  assert.equal(regression.status, "regression")
  assert.equal(regression.allow_retry, false)

  const repeatedHint = buildAdditiveRepairHint({
    failure,
    capability,
    request,
    executionContextSha256: capsule.capsule_sha256,
    previousRepairHint: hint,
  })
  assert.equal(repeatedHint.repair_progress.status, "no_progress")
  assert.equal(repeatedHint.repairable, false)

  await put(
    root,
    "templates/snippets/menu.html",
    `${nav}\n<!-- drift -->\n`,
  )
  const drift = await buildRepairExecutionProjection({
    root,
    capsule,
    capability,
    repairHint: hint,
    maxBytes: 1800,
  })
  assert.equal(drift.ok, false)
  assert.equal(drift.reason, "context_file_stale")

  console.log("PASS E2.7-B coverage repair is delta-only and <=1800 bytes")
  console.log("PASS E2.7-B repair reuses immutable capsule evidence, not a second parser pass")
  console.log("PASS E2.7-B missing obligations are model-visible as typed slot+operation facts")
  console.log("PASS E2.7-B same missing set stops as NO_PROGRESS")
  console.log("PASS E2.7-B new missing obligations stop as REGRESSION")
  console.log("PASS E2.7-B strict subset is the only retry progress condition")
  console.log("PASS E2.7-B source drift remains fail-closed")
  console.log("PASS E2.7-B repair does not gain mutation authority")
} finally {
  await rm(root, { recursive: true, force: true })
}
