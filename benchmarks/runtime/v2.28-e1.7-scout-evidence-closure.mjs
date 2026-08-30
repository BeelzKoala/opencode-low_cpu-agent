#!/usr/bin/env node

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  EVIDENCE_BASIS,
  makeTieredRoleEvidence,
} from "../../opencode/plugins/cpu-search-core/evidence-tier-v1.mjs"

import {
  RESOURCE_EDGE_KIND,
} from "../../opencode/plugins/cpu-search-core/resource-graph-v1.mjs"

import {
  SCOUT_EVIDENCE_CLOSURE_PROTOCOL,
  planTaskBoundHostRefinement,
  solveScoutEvidenceClosure,
} from "../../opencode/plugins/cpu-search-core/scout-evidence-closure-v1.mjs"

const TASK_SHA = "a".repeat(64)
const OWNER_SHA = "1".repeat(64)
const UI_SHA = "2".repeat(64)
const MENU_SHA = "3".repeat(64)
const DB_SHA = "4".repeat(64)

const witness = (file, line, sha256, extractor = "synthetic") => ({
  file,
  line,
  sha256,
  extractor,
})

const taskRequirements = {
  status: "compiled",
  task_sha256: TASK_SHA,
}

const additiveLocalizationPlan = {
  status: "planned",
  task_sha256: TASK_SHA,
  positive_coverage_requirements: {
    status: "compiled",
    task_sha256: TASK_SHA,
    required_roles: [
      "data_access_capability",
      "navigation_host",
      "ui_host",
    ],
  },
}

const anchorFrontier = {
  status: "bound",
  route_anchor: "/export",
  owner: "file:routes/owner.py",
  owner_file: "routes/owner.py",
}

const routeEdge = {
  validated: true,
  kind: RESOURCE_EDGE_KIND.DECLARES_ROUTE,
  from: "file:routes/owner.py",
  to: "route:/export",
  witness: witness("routes/owner.py", 10, OWNER_SHA, "flask-jinja"),
}

const renderEdge = {
  validated: true,
  kind: RESOURCE_EDGE_KIND.RENDERS_RESOURCE,
  from: "file:routes/owner.py",
  to: "template:bestsellers.html",
  witness: witness("routes/owner.py", 20, OWNER_SHA, "flask-jinja"),
}

const includeEdge = {
  validated: true,
  kind: RESOURCE_EDGE_KIND.INCLUDES_RESOURCE,
  from: "template:templates/bestsellers.html",
  to: "template:snippets/menu.html",
  witness: witness("templates/bestsellers.html", 2, UI_SHA, "flask-jinja"),
}

const menuRouteEdge = {
  validated: true,
  kind: RESOURCE_EDGE_KIND.TARGETS_ROUTE,
  from: "template:templates/snippets/menu.html",
  to: "route:/bestsellers",
  witness: witness("templates/snippets/menu.html", 8, MENU_SHA, "flask-jinja"),
}

const bindingEdge = {
  validated: true,
  kind: "provider_binding_into_task_host",
  from: "symbol:database.py#get_basdb_conn",
  to: "file:routes/owner.py",
  witness: witness("routes/owner.py", 3, OWNER_SHA, "python_binding"),
}

const uiEvidence = makeTieredRoleEvidence({
  role: "ui_host",
  taskSha256: TASK_SHA,
  basis: EVIDENCE_BASIS.TASK_CAUSAL_PATH,
  sourceProof: routeEdge.witness,
  causalPath: [renderEdge],
})

const navigationEvidence = makeTieredRoleEvidence({
  role: "navigation_host",
  taskSha256: TASK_SHA,
  basis: EVIDENCE_BASIS.TASK_CAUSAL_PATH,
  sourceProof: routeEdge.witness,
  causalPath: [renderEdge, includeEdge],
})

const dataEvidence = makeTieredRoleEvidence({
  role: "data_access_capability",
  taskSha256: TASK_SHA,
  basis: EVIDENCE_BASIS.TASK_CAUSAL_PATH,
  sourceProof: witness("database.py", 32, DB_SHA, "python_provider"),
  causalPath: [bindingEdge],
})

for (const item of [uiEvidence, navigationEvidence, dataEvidence]) {
  assert.ok(item)
  assert.equal(item.tier, "B")
  assert.equal(item.localization_authority, true)
  assert.equal(item.mutation_authority, false)
}

const refinement = planTaskBoundHostRefinement({
  taskRequirements,
  additiveLocalizationPlan,
  anchorFrontier,
  frameworkEdges: [routeEdge],
  selectedFiles: [{ file: "routes/other.py" }],
})

assert.equal(refinement.protocol, SCOUT_EVIDENCE_CLOSURE_PROTOCOL)
assert.equal(refinement.status, "planned")
assert.deepEqual(refinement.candidate_files, ["routes/owner.py"])
assert.equal(refinement.mutation_authority, false)

assert.equal(
  planTaskBoundHostRefinement({
    taskRequirements,
    additiveLocalizationPlan,
    anchorFrontier,
    frameworkEdges: [routeEdge],
    selectedFiles: [{ file: "routes/owner.py" }],
  }).status,
  "not_needed",
)

assert.equal(
  planTaskBoundHostRefinement({
    taskRequirements,
    additiveLocalizationPlan,
    anchorFrontier,
    frameworkEdges: [],
    selectedFiles: [],
  }).status,
  "abstained",
)

const hostResourceClosure = {
  ui_candidate: {
    structural_ready: true,
    physical_file: "templates/bestsellers.html",
  },
  navigation_candidate: {
    structural_ready: true,
    physical_file: "templates/snippets/menu.html",
  },
}

const closure = solveScoutEvidenceClosure({
  taskRequirements,
  additiveLocalizationPlan,
  taskRoleEvidence: [uiEvidence, navigationEvidence, dataEvidence],
  anchorFrontier,
  hostResourceClosure,
  frameworkEdges: [routeEdge, renderEdge, includeEdge, menuRouteEdge],
})

assert.equal(closure.protocol, SCOUT_EVIDENCE_CLOSURE_PROTOCOL)
assert.equal(closure.status, "covered")
assert.equal(closure.coverage_status, "covered")
assert.deepEqual(closure.missing_roles, [])
assert.deepEqual(closure.ambiguous_roles, [])
assert.equal(closure.localization_authority, true)
assert.equal(closure.mutation_authority, false)
assert.deepEqual(
  closure.files.map((item) => item.file),
  [
    "database.py",
    "routes/owner.py",
    "templates/bestsellers.html",
    "templates/snippets/menu.html",
  ],
)
assert.ok(
  closure.files.every((item) =>
    item.witnesses.length > 0 &&
    item.witnesses.every((item) => /^[0-9a-f]{64}$/u.test(item.sha256)),
  ),
)

const insufficient = solveScoutEvidenceClosure({
  taskRequirements,
  additiveLocalizationPlan,
  taskRoleEvidence: [uiEvidence, dataEvidence],
  anchorFrontier,
  hostResourceClosure,
  frameworkEdges: [routeEdge, renderEdge],
})
assert.equal(insufficient.status, "insufficient")
assert.deepEqual(insufficient.missing_roles, ["navigation_host"])
assert.equal(insufficient.localization_authority, false)
assert.equal(insufficient.mutation_authority, false)

const ambiguousData = makeTieredRoleEvidence({
  role: "data_access_capability",
  taskSha256: TASK_SHA,
  basis: EVIDENCE_BASIS.TASK_CAUSAL_PATH,
  sourceProof: witness("database.py", 32, DB_SHA, "python_provider"),
  causalPath: [bindingEdge],
  ambiguous: true,
})

const ambiguous = solveScoutEvidenceClosure({
  taskRequirements,
  additiveLocalizationPlan,
  taskRoleEvidence: [uiEvidence, navigationEvidence, ambiguousData],
  anchorFrontier,
  hostResourceClosure,
  frameworkEdges: [routeEdge, renderEdge, includeEdge, menuRouteEdge],
})
assert.equal(ambiguous.status, "ambiguous")
assert.deepEqual(ambiguous.ambiguous_roles, ["data_access_capability"])
assert.equal(ambiguous.localization_authority, false)

const truncated = solveScoutEvidenceClosure({
  taskRequirements,
  additiveLocalizationPlan,
  taskRoleEvidence: [uiEvidence, navigationEvidence, dataEvidence],
  anchorFrontier,
  hostResourceClosure,
  frameworkEdges: [routeEdge, renderEdge, includeEdge, menuRouteEdge],
  maxFiles: 2,
})
assert.equal(truncated.status, "truncated")
assert.equal(truncated.truncated, true)
assert.equal(truncated.localization_authority, false)
assert.equal(truncated.mutation_authority, false)

const witnessOverflowEvidence = Array.from({ length: 9 }, (_, index) =>
  makeTieredRoleEvidence({
    role: "ui_host",
    taskSha256: TASK_SHA,
    basis: EVIDENCE_BASIS.TASK_CAUSAL_PATH,
    sourceProof: witness(
      "routes/owner.py",
      30 + index,
      OWNER_SHA,
      `overflow-source-${index}`,
    ),
    causalPath: [{
      validated: true,
      kind: RESOURCE_EDGE_KIND.RENDERS_RESOURCE,
      from: "file:routes/owner.py",
      to: `template:overflow-${index}.html`,
      witness: witness(
        "routes/owner.py",
        40 + index,
        OWNER_SHA,
        `overflow-edge-${index}`,
      ),
    }],
  }),
)
assert.ok(witnessOverflowEvidence.every((item) => item?.tier === "B"))

const witnessTruncated = solveScoutEvidenceClosure({
  taskRequirements,
  additiveLocalizationPlan: {
    ...additiveLocalizationPlan,
    positive_coverage_requirements: {
      ...additiveLocalizationPlan.positive_coverage_requirements,
      required_roles: ["ui_host"],
    },
  },
  taskRoleEvidence: witnessOverflowEvidence,
  anchorFrontier,
  frameworkEdges: [routeEdge],
})
assert.equal(witnessTruncated.status, "truncated")
assert.equal(witnessTruncated.truncated, true)
assert.equal(witnessTruncated.localization_authority, false)

const plugin = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)

assert.match(plugin, /SCOUT_EVIDENCE_CLOSURE_PROTOCOL/u)
assert.match(plugin, /planTaskBoundHostRefinement\(\{/u)
assert.match(plugin, /solveScoutEvidenceClosure\(\{/u)
assert.match(plugin, /host_owner_refinement_status/u)
assert.match(plugin, /scout_evidence_closure_status/u)
assert.match(plugin, /renderScoutEvidenceClosureContext\(/u)
assert.match(plugin, /SCOUT_EVIDENCE_CLOSURE status=/u)
assert.match(plugin, /context_files: contextFiles/u)
assert.match(plugin, /mutation_authority: false/u)
assert.match(plugin, /if \(state\.executionState === EXEC_STATE_LOCATE\) \{/u)
assert.match(plugin, /readinessStatus === EXECUTION_READINESS_STATUS\.SAFE_FAIL/u)
assert.match(plugin, /: \["search"\]/u)
assert.doesNotMatch(plugin, /name: EVIDENCE_INSPECT_TOOL/u)
assert.doesNotMatch(plugin, /origin === "obligation"/u)

console.log("PASS v2.28-E1.7 deterministic scout evidence closure")
