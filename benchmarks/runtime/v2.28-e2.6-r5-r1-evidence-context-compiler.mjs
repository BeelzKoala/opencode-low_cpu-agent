import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  MODEL_CONTEXT_COMPILER_AUTHORITY,
  MODEL_CONTEXT_COMPILER_PROTOCOL,
  compileAdditiveExecutionCapsule,
  resolveModelContextBudgetBytes,
  resolveModelContextCompilerMode,
} from "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs"

function sha(text) {
  return createHash("sha256").update(Buffer.from(text)).digest("hex")
}

const root = await mkdtemp(path.join(os.tmpdir(), "context-compiler-r5-"))
try {
  const api = [
    "from service import export_rows",
    "# context aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "@router.get('/export')",
    "def export_report(start, end):",
    "    return export_rows(start, end)",
    "# context bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "def unrelated():",
    "    return 1",
    "",
  ].join("\n")
  const service = [
    "# service aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "def export_rows(start, end):",
    "    rows = load_rows(start, end)",
    "    return render_csv(rows)",
    "# service bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "def load_rows(start, end):",
    "    return []",
    "",
  ].join("\n")
  const support = [
    `def render_csv(rows): # ${"x".repeat(1200)}`,
    "    return '\\n'.join(map(str, rows))",
    "",
  ].join("\n")

  await writeFile(path.join(root, "api.py"), api)
  await writeFile(path.join(root, "service.py"), service)
  await writeFile(path.join(root, "support.py"), support)

  const capability = {
    protocol: "scout-additive-capability-v1",
    operation: "additive_surface",
    binding_ready: true,
    ready: true,
    mutation_authority: true,
    capability_sha256: "a".repeat(64),
    authority_sha256: "b".repeat(64),
    authority_protocol: "sealed-additive-handoff-v1",
    host_bindings: {},
    budgets: {
      max_operations: 8,
      max_changed_files: 5,
      max_create_files: 2,
      max_plan_bytes: 32 * 1024,
    },
    existing_slots: [
      {
        slot: "existing:0",
        file: "api.py",
        sha256: sha(api),
        evidence_lines: [4],
        roles: ["route_host", "task_anchor_owner"],
        allowed_operations: ["replace_exact"],
      },
      {
        slot: "existing:1",
        file: "service.py",
        sha256: sha(service),
        evidence_lines: [2],
        roles: ["implementation_host"],
        allowed_operations: ["replace_exact"],
      },
    ],
    create_slots: [],
    context_files: [
      {
        file: "api.py",
        sha256: sha(api),
        evidence_lines: [4],
        roles: ["route_host", "task_anchor_owner"],
      },
      {
        file: "service.py",
        sha256: sha(service),
        evidence_lines: [2],
        roles: ["implementation_host"],
      },
      {
        file: "support.py",
        sha256: sha(support),
        evidence_lines: [1],
        roles: ["context"],
      },
    ],
  }
  const baseline = `RAW SEARCH OUTPUT\n${"x".repeat(6000)}`

  const first = await compileAdditiveExecutionCapsule({
    root,
    capability,
    baselineContent: baseline,
    maxBytes: 2200,
  })
  const second = await compileAdditiveExecutionCapsule({
    root,
    capability,
    baselineContent: baseline,
    maxBytes: 2200,
  })

  assert.equal(first.protocol, MODEL_CONTEXT_COMPILER_PROTOCOL)
  assert.equal(first.authority, MODEL_CONTEXT_COMPILER_AUTHORITY)
  assert.equal(first.ok, true)
  assert.equal(first.status, "compiled")
  assert.equal(first.routing_authority, false)
  assert.equal(first.mutation_authority, false)
  assert.equal(first.verification_authority, false)
  assert.equal(first.token_authority, false)
  assert.equal(first.token_count, null)
  assert.equal(first.critical_file_coverage_complete, true)
  assert.equal(first.execution_contract_coverage_complete, true)
  assert.ok(first.content.includes("SOURCE file=api.py "))
  assert.ok(first.content.includes("SOURCE file=service.py "))
  assert.ok(first.content.includes("EXISTING slot=existing:0"))
  assert.ok(first.content.includes("EXISTING slot=existing:1"))
  assert.ok(!first.dropped_files.includes("api.py"))
  assert.ok(!first.dropped_files.includes("service.py"))
  assert.ok(first.compiled_bytes <= 2200)
  assert.ok(first.compiled_bytes < first.source_bytes)
  assert.equal(first.content, second.content)
  assert.equal(first.semantic_coverage_sha256, second.semantic_coverage_sha256)

  const stale = structuredClone(capability)
  stale.context_files[0].sha256 = "0".repeat(64)
  const staleResult = await compileAdditiveExecutionCapsule({
    root,
    capability: stale,
    baselineContent: baseline,
    maxBytes: 2200,
  })
  assert.equal(staleResult.ok, false)
  assert.equal(staleResult.reason, "context_file_stale")

  const missing = structuredClone(capability)
  missing.context_files = missing.context_files.filter(
    (row) => row.file !== "service.py",
  )
  const missingResult = await compileAdditiveExecutionCapsule({
    root,
    capability: missing,
    baselineContent: baseline,
    maxBytes: 2200,
  })
  assert.equal(missingResult.ok, false)
  assert.equal(missingResult.reason, "critical_context_attestation_missing")

  assert.equal(resolveModelContextCompilerMode("active"), "active")
  assert.equal(resolveModelContextCompilerMode("garbage"), "shadow")
  assert.equal(resolveModelContextBudgetBytes("2200"), 2200)
  assert.equal(resolveModelContextBudgetBytes("1"), 512)
  assert.equal(resolveModelContextBudgetBytes("99999"), 4800)

  console.log("PASS E2.6/R5-R1 critical sealed files remain MUST_KEEP")
  console.log("PASS E2.6/R5-R1 optional support never displaces critical evidence")
  console.log("PASS E2.6/R5-R1 source hashes are revalidated and stale data fails closed")
  console.log("PASS E2.6/R5-R1 compiler remains deterministic and authority-free")
} finally {
  await rm(root, { recursive: true, force: true })
}
