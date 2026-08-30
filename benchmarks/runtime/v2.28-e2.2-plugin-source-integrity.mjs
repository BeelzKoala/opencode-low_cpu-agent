#!/usr/bin/env node

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import path from "node:path"

const ROOT = path.resolve(
  new URL("../..", import.meta.url).pathname,
)
const FRAGMENT = path.join(
  ROOT,
  "opencode/plugins/cpu-search.fragments/00.part.ts",
)
const ENTRYPOINT = path.join(
  ROOT,
  "opencode/plugins/cpu-search.ts",
)

const fragment = await readFile(FRAGMENT, "utf8")
const plugin = await readFile(ENTRYPOINT, "utf8")

// Historical E2.2 corruption signature: a greedy import rewrite absorbed
// unrelated imports into the additive named-import block.
for (const forbidden of [
  '  import path from "node:path",',
  '  import { createHash } from "node:crypto",',
  '  spawn } from "node:child_process",',
  '} from "./cpu-search-core/task-action-v1.mjs",',
  '} from "./cpu-search-core/task-shape-v1.mjs",',
]) {
  assert.equal(
    fragment.includes(forbidden),
    false,
    `malformed import signature survived: ${forbidden}`,
  )
}

for (const required of [
  'import { spawn } from "node:child_process"',
  'import { createHash } from "node:crypto"',
  'import path from "node:path"',
  '} from "./cpu-search-core/additive-mutation-v3.mjs"',
  '} from "./cpu-search-core/governor-latency-v1.mjs"',
]) {
  assert.equal(
    fragment.includes(required),
    true,
    `required import boundary missing: ${required}`,
  )
}

// Parse generated TypeScript as an ES module through stdin. This is the
// authoritative cheap syntax gate; it does not depend on .ts extension
// handling differences in `node --check file.ts`.
const syntax = spawnSync(
  process.execPath,
  ["--input-type=module", "--check"],
  {
    input: plugin,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  },
)
assert.equal(
  syntax.status,
  0,
  `generated plugin module parse failed:\n${syntax.stderr || syntax.stdout}`,
)

// Check named-import bindings against the actual local core modules. This
// catches a syntactically valid but semantically misbound import repair.
const bindings = new Map([
  ["task-action-v1.mjs", [
    "TASK_ACTION_PROTOCOL",
    "compileTaskAction",
    "unresolvedTaskAction",
  ]],
  ["task-requirements-v1.mjs", [
    "TASK_REQUIREMENTS_PROTOCOL",
    "compileTaskRequirements",
    "unresolvedTaskRequirements",
  ]],
  ["evidence-authority-v1.mjs", [
    "classifyEvidenceAuthority",
  ]],
  ["localization-decision-v1.mjs", [
    "LOCALIZATION_STATUS",
    "decideLocalization",
  ]],
  ["repo-capability-v1.mjs", [
    "REPO_CAPABILITY_PROTOCOL",
    "SOURCE_FAMILY_PLAN_PROTOCOL",
    "compileRepoCapabilityProfile",
    "planTaskSourceFamilies",
  ]],
  ["framework-resource-bridge-v1.mjs", [
    "FRAMEWORK_RESOURCE_BRIDGE_PROTOCOL",
    "inspectFrameworkResourceFile",
  ]],
  ["resource-adapter-bridge-v1.mjs", [
    "RESOURCE_ADAPTER_BRIDGE_PROTOCOL",
    "inspectResourceAdapterFile",
  ]],
  ["task-anchor-v1.mjs", [
    "TASK_ANCHOR_PROTOCOL",
    "compileTaskAnchors",
  ]],
  ["task-causal-shadow-v1.mjs", [
    "TASK_CAUSAL_SHADOW_PROTOCOL",
    "runTaskCausalShadow",
  ]],
  ["task-shape-v1.mjs", [
    "TASK_SHAPE_PROTOCOL",
    "compileTaskShape",
  ]],
  ["additive-localization-plan-v1.mjs", [
    "ADDITIVE_LOCALIZATION_PLAN_PROTOCOL",
    "planAdditiveLocalization",
  ]],
  ["host-integration-shadow-v1.mjs", [
    "HOST_INTEGRATION_SHADOW_PROTOCOL",
    "runHostIntegrationShadow",
  ]],
  ["anchor-resolution-frontier-v1.mjs", [
    "resolveAnchorFrontier",
    "routeAnchorValues",
  ]],
  ["host-resource-closure-v2.mjs", [
    "hostResourceClosureSummary",
    "mergeHostAliases",
    "resolveHostAliasesForNodes",
    "resolveHostClosureContext",
  ]],
  ["host-obligation-projector-v1.mjs", [
    "projectAnchoredHostObligationProofs",
  ]],
  ["data-obligation-projector-v1.mjs", [
    "DATA_OBLIGATION_PROJECTOR_PROTOCOL",
    "projectDataAccessObligation",
  ]],
  ["scout-evidence-closure-v1.mjs", [
    "SCOUT_EVIDENCE_CLOSURE_PROTOCOL",
    "planTaskBoundHostRefinement",
    "solveScoutEvidenceClosure",
  ]],
  ["evidence-inspect-v1.mjs", [
    "inspectEvidence",
  ]],
  ["execution-readiness-v1.mjs", [
    "EXECUTION_MUTATION_SHAPE",
    "EXECUTION_READINESS_PROTOCOL",
    "EXECUTION_READINESS_STATUS",
    "initialExecutionReadiness",
    "resolveExecutionReadiness",
  ]],
  ["additive-mutation-v1.mjs", [
    "ADDITIVE_HOST_BINDING_PROTOCOL",
    "ADDITIVE_MODEL_CONTEXT_MAX_BYTES",
    "ADDITIVE_MUTATION_ABI_PROTOCOL",
    "ADDITIVE_MUTATION_AUTHORITY_PROTOCOL",
    "ADDITIVE_MUTATION_CAPABILITY_PROTOCOL",
    "ADDITIVE_MUTATION_PLAN_PROTOCOL",
    "ADDITIVE_REPAIR_HINT_PROTOCOL",
    "EXECUTE_ADDITIVE_PLAN_TOOL",
    "additiveRepairAuthorityMatches",
    "authorizeAdditiveMutationCapability",
    "buildAdditiveMutationHandoff",
    "buildAdditiveRepairHint",
    "deriveAdditiveMutationCapability",
    "materializeAdditiveMutationContext",
    "materializeAdditiveMutationPlan",
    "renderAdditiveMutationCapability",
    "validateAdditiveMutationRequest",
    "verifyAdditiveMutationAuthority",
  ]],
  ["governor-latency-v1.mjs", [
    "GOVERNOR_LATENCY_PROTOCOL",
    "GOVERNOR_MAX_ACTIVE_PHASES",
    "effectivePhaseBudgetMs",
    "initialLatencyProfile",
    "latencyReserveMs",
    "observeLatency",
    "phaseForExecutionState",
    "resolveGovernorAdmission",
  ]],
])

const core = path.join(
  ROOT,
  "opencode/plugins/cpu-search-core",
)

for (const [file, names] of bindings) {
  const module = await import(
    pathToFileURL(path.join(core, file)).href
  )
  for (const name of names) {
    assert.equal(
      Object.hasOwn(module, name),
      true,
      `${file} missing export ${name}`,
    )
  }
}

console.log("PASS E2.2 plugin import boundaries are structurally intact")
console.log("PASS generated plugin parses as an ES module")
console.log("PASS local core named-import bindings resolve")
