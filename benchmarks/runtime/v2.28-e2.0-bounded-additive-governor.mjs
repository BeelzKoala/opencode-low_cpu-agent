#!/usr/bin/env node

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
  ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
  EXECUTE_ADDITIVE_PLAN_TOOL,
  authorizeAdditiveMutationCapability,
  buildAdditiveMutationHandoff,
  deriveAdditiveMutationCapability,
  materializeAdditiveMutationContext,
  materializeAdditiveMutationPlan,
  verifyAdditiveMutationAuthority,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"
import {
  GOVERNOR_LATENCY_PROTOCOL,
  effectivePhaseBudgetMs,
  initialLatencyProfile,
  observeLatency,
  requiredModelWindowMs,
  resolveGovernorAdmission,
} from "../../opencode/plugins/cpu-search-core/governor-latency-v1.mjs"
import {
  EXECUTION_MUTATION_SHAPE,
  EXECUTION_READINESS_STATUS,
  resolveExecutionReadiness,
} from "../../opencode/plugins/cpu-search-core/execution-readiness-v1.mjs"

const root = await mkdtemp(path.join(os.tmpdir(), "opencode-e20-"))
await mkdir(path.join(root, "routes"), { recursive: true })
await mkdir(path.join(root, "templates", "snippets"), { recursive: true })
await mkdir(
  path.join(root, ".opencode", "scout-handoffs", "capabilities"),
  { recursive: true },
)

const sources = {
  "routes/bestsellers_bp.py":
    '@bp.route("/export")\ndef export():\n    return "old"\n',
  "templates/snippets/menu.html":
    '<a href="/export">Export</a>\n',
  "templates/existing.html":
    "<html>\n<form>old</form>\n</html>\n",
  "database.py":
    'class BASDB:\n    rd_bestsellers_data = "table"\n',
}

for (const [file, source] of Object.entries(sources)) {
  const absolute = path.join(root, file)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, source)
}

const evidenceRow = (file, roles, line) => ({
  file,
  roles,
  witnesses: [{
    line,
    sha256: createHash("sha256").update(sources[file]).digest("hex"),
    extractor: "e2_fixture",
  }],
})

const closure = {
  status: "covered",
  localization_authority: true,
  truncated: false,
  required_roles: [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
  missing_roles: [],
  ambiguous_roles: [],
  files: [
    // Deliberately propagated roles: they must not create extra mutation
    // targets.
    evidenceRow(
      "routes/bestsellers_bp.py",
      ["task_anchor_owner", "navigation_host", "ui_host"],
      1,
    ),
    evidenceRow(
      "templates/snippets/menu.html",
      ["navigation_host"],
      1,
    ),
    evidenceRow(
      "templates/existing.html",
      ["ui_host"],
      2,
    ),
    evidenceRow(
      "database.py",
      ["data_access_capability"],
      2,
    ),
  ],
}

const hostResourceClosure = {
  protected_surface: {
    status: "context_bound",
    owner: "file:routes/bestsellers_bp.py",
    owner_file: "routes/bestsellers_bp.py",
    structural_ready: true,
  },
  ui_candidate: {
    status: "resolved_physical_host",
    resource: "template:existing.html",
    physical_file: "templates/existing.html",
    structural_ready: true,
  },
  navigation_candidate: {
    status: "resolved_structural_host",
    resource: "template:snippets/menu.html",
    physical_file: "templates/snippets/menu.html",
    structural_ready: true,
    topology: [{
      resource: "template:snippets/menu.html",
      physical_file: "templates/snippets/menu.html",
      includers: ["template:existing.html"],
      route_targets: ["route:bestsellers.page"],
      shared_includers: 1,
      internal_route_targets: 1,
      structural_ready: true,
    }],
  },
}

let capability = deriveAdditiveMutationCapability({
  taskShape: { status: "compiled", shape: "additive" },
  evidenceClosure: closure,
  hostResourceClosure,
})

assert.equal(capability.protocol, ADDITIVE_MUTATION_CAPABILITY_PROTOCOL)
assert.equal(capability.status, "bound")
assert.equal(capability.binding_ready, true)
assert.equal(capability.ready, false)
assert.equal(capability.mutation_authority, false)
assert.deepEqual(
  capability.existing_slots.map((slot) => slot.file),
  ["routes/bestsellers_bp.py", "templates/snippets/menu.html"],
)
assert.equal(capability.create_slots[0].root, "templates")
assert.equal(
  capability.host_bindings.navigation_host,
  "templates/snippets/menu.html",
)
assert.ok(capability.context_files.some((row) => row.file === "database.py"))
assert.ok(
  !capability.existing_slots.some((slot) => slot.file === "database.py"),
)

const context = await materializeAdditiveMutationContext({
  root,
  capability,
})
assert.equal(context.ok, true)
assert.equal(context.mutation_authority, false)
assert.match(
  context.content,
  /SEALED_CONTEXT file=routes\/bestsellers_bp\.py/u,
)
assert.match(
  context.content,
  /SEALED_CONTEXT file=templates\/snippets\/menu\.html/u,
)
assert.match(
  context.content,
  /SEALED_CONTEXT file=templates\/existing\.html/u,
)

const provisional = buildAdditiveMutationHandoff({
  searchProtocol: "search-test",
  sessionKey: "s",
  turnKey: "t",
  capability,
  context,
})
assert.equal(provisional.ok, true)
assert.equal(provisional.bundle.status, "provisional")

const handoffRel =
  ".opencode/scout-handoffs/capabilities/e20-additive.json"
const handoffAbs = path.join(root, handoffRel)
await writeFile(
  handoffAbs,
  JSON.stringify(provisional.bundle, null, 2) + "\n",
  "utf8",
)

capability = await authorizeAdditiveMutationCapability({
  root,
  capability,
  context,
  handoffPath: handoffRel,
})
assert.equal(capability.ready, true)
assert.equal(capability.mutation_authority, true)
assert.equal(
  capability.authority_protocol,
  ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
)

const finalHandoff = buildAdditiveMutationHandoff({
  searchProtocol: "search-test",
  sessionKey: "s",
  turnKey: "t",
  capability,
  context,
})
assert.equal(finalHandoff.ok, true)
assert.equal(finalHandoff.bundle.status, "ready")
await writeFile(
  handoffAbs,
  JSON.stringify(finalHandoff.bundle, null, 2) + "\n",
  "utf8",
)

const authority = await verifyAdditiveMutationAuthority({
  root,
  capability,
  context,
  handoffPath: handoffRel,
})
assert.equal(authority.ok, true)

const plan = materializeAdditiveMutationPlan({
  capability,
  request: {
    replacements: [
      {
        slot: "existing:0",
        before: '@bp.route("/export")',
        replacement:
          '@bp.route("/export")\n# additive route follows',
      },
    ],
    creations: [
      {
        slot: "create:0",
        relative_path: "bestsellers_report.html",
        content: "<html></html>\n",
      },
    ],
  },
})
assert.equal(plan.ok, true)
assert.deepEqual(plan.changed_files, [
  "routes/bestsellers_bp.py",
  "templates/bestsellers_report.html",
])
assert.equal(plan.mutation_authority, false)

const readiness = resolveExecutionReadiness({
  taskShape: { status: "compiled", shape: "additive" },
  mutationIntent: "generic_edit",
  scoutHandoff: { status: "partial" },
  evidenceClosure: closure,
  editCapsule: {
    mutationReady: false,
    readinessBlockers: [
      "localization_mutation_authority_not_proven",
      "mutation_scope_unavailable",
      "mutation_candidate_set_unavailable",
    ],
  },
  additiveMutationCapability: capability,
})
assert.equal(
  readiness.status,
  EXECUTION_READINESS_STATUS.READY_TO_MUTATE,
)
assert.equal(
  readiness.required_mutation_shape,
  EXECUTION_MUTATION_SHAPE.ADDITIVE_SURFACE,
)
assert.deepEqual(
  readiness.available_mutation_operations,
  ["additive_surface"],
)
assert.equal(readiness.mutation_authority, false)

// Governor must admit a mandatory second model call after a slow first call
// without removing the global task wall.
let profile = initialLatencyProfile()
profile = observeLatency(profile, 145_000)
assert.equal(requiredModelWindowMs(profile), 159_500)
assert.equal(
  effectivePhaseBudgetMs({
    basePhaseBudgetMs: 120_000,
    taskBudgetMs: 360_000,
    latencyProfile: profile,
  }),
  159_500,
)

const mutateAdmission = resolveGovernorAdmission({
  nowMs: 146_000,
  taskStartedAt: 0,
  phaseStartedAt: 146_000,
  phaseBudgetMs: 120_000,
  taskBudgetMs: 360_000,
  latencyProfile: profile,
})
assert.equal(mutateAdmission.protocol, GOVERNOR_LATENCY_PROTOCOL)
assert.equal(mutateAdmission.admitted, true)
assert.equal(mutateAdmission.effective_phase_budget_ms, 159_500)

const samePhaseLate = resolveGovernorAdmission({
  nowMs: 115_000,
  taskStartedAt: 0,
  phaseStartedAt: 0,
  phaseBudgetMs: 120_000,
  taskBudgetMs: 360_000,
  latencyProfile: observeLatency(initialLatencyProfile(), 79_000),
})
assert.equal(samePhaseLate.admitted, false)
assert.equal(samePhaseLate.reason, "latency_admission")

const repairAfterTwoSlowCalls = resolveGovernorAdmission({
  nowMs: 300_000,
  taskStartedAt: 0,
  phaseStartedAt: 300_000,
  phaseBudgetMs: 120_000,
  taskBudgetMs: 360_000,
  latencyProfile: profile,
})
assert.equal(repairAfterTwoSlowCalls.admitted, false)
assert.equal(repairAfterTwoSlowCalls.reason, "latency_admission")

const plugin = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)
const compiler = await readFile(
  new URL("../../rust/evidence-distiller/src/patch_compiler.rs", import.meta.url),
  "utf8",
)
const executor = await readFile(
  new URL("../../rust/evidence-distiller/src/patch_executor.rs", import.meta.url),
  "utf8",
)
const verifier = await readFile(
  new URL("../../rust/evidence-distiller/src/invariant_verifier.rs", import.meta.url),
  "utf8",
)

assert.match(plugin, /name: EXECUTE_ADDITIVE_PLAN_TOOL/u)
assert.match(plugin, /ADDITIVE_MUTATION_ABI_PROTOCOL/u)
assert.match(plugin, /relative_path/u)
assert.doesNotMatch(plugin, /required: \["operations"\]/u)
assert.match(plugin, /authorizeAdditiveMutationCapability/u)
assert.match(plugin, /verifyAdditiveMutationAuthority/u)
assert.match(plugin, /effectivePhaseBudgetMs/u)
assert.match(plugin, /additiveMutationHandoffPath/u)
assert.match(plugin, /execution_readiness_additive/u)
assert.doesNotMatch(plugin, /unrestricted_additive_shell/u)

for (const source of [compiler, executor, verifier]) {
  assert.match(source, /scout-additive-capability-v1/u)
  assert.match(source, /additive_mutation_capability/u)
  assert.match(source, /create_file/u)
}

console.log(
  "PASS v2.28-E2.0 bounded additive executor + adaptive latency governor",
)
