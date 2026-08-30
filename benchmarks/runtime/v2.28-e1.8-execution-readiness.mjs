#!/usr/bin/env node

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  EXECUTION_MUTATION_SHAPE,
  EXECUTION_READINESS_PROTOCOL,
  EXECUTION_READINESS_STATUS,
  initialExecutionReadiness,
  resolveExecutionReadiness,
} from "../../opencode/plugins/cpu-search-core/execution-readiness-v1.mjs"

const coveredClosure = {
  status: "covered",
  localization_authority: true,
}

const insufficientClosure = {
  status: "insufficient",
  localization_authority: false,
}

const additiveTaskShape = {
  status: "compiled",
  shape: "additive",
}

const genericCapsuleBlocked = {
  mutationReady: false,
  readinessBlockers: [
    "localization_mutation_authority_not_proven",
    "mutation_scope_unavailable",
    "mutation_candidate_set_unavailable",
  ],
}

const initial = initialExecutionReadiness()
assert.equal(initial.protocol, EXECUTION_READINESS_PROTOCOL)
assert.equal(initial.status, EXECUTION_READINESS_STATUS.NEEDS_EVIDENCE)
assert.equal(initial.mutation_authority, false)

const needsEvidence = resolveExecutionReadiness({
  taskShape: additiveTaskShape,
  mutationIntent: "generic_edit",
  scoutHandoff: { status: "partial" },
  evidenceClosure: insufficientClosure,
  editCapsule: genericCapsuleBlocked,
})
assert.equal(needsEvidence.status, EXECUTION_READINESS_STATUS.NEEDS_EVIDENCE)
assert.equal(needsEvidence.execution_event, "scout_needs_evidence")
assert.equal(needsEvidence.mutation_authority, false)

const additiveUnsupported = resolveExecutionReadiness({
  taskShape: additiveTaskShape,
  mutationIntent: "generic_edit",
  scoutHandoff: { status: "partial" },
  evidenceClosure: coveredClosure,
  editCapsule: genericCapsuleBlocked,
})
assert.equal(additiveUnsupported.status, EXECUTION_READINESS_STATUS.SAFE_FAIL)
assert.equal(additiveUnsupported.reason, "mutation_capability_unavailable")
assert.equal(additiveUnsupported.failure_kind, "mutation_capability")
assert.equal(
  additiveUnsupported.required_mutation_shape,
  EXECUTION_MUTATION_SHAPE.ADDITIVE_SURFACE,
)
assert.equal(additiveUnsupported.mutation_authority, false)

const replaceReady = resolveExecutionReadiness({
  taskShape: additiveTaskShape,
  mutationIntent: "generic_edit",
  scoutHandoff: { status: "ready" },
  evidenceClosure: coveredClosure,
  editCapsule: {
    mutationReady: true,
    readinessBlockers: [],
  },
  localMutationCapability: {
    ok: true,
    replaceNodeReady: true,
  },
  localMutationCandidates: [{ file: "routes/a.py" }],
})
assert.equal(replaceReady.status, EXECUTION_READINESS_STATUS.READY_TO_MUTATE)
assert.equal(replaceReady.execution_event, "scout_ready")
assert.deepEqual(replaceReady.available_mutation_operations, ["replace_node"])
assert.equal(replaceReady.mutation_authority, false)

const renameReady = resolveExecutionReadiness({
  taskAction: {
    status: "exact",
    operation: "rename_symbol",
  },
  mutationIntent: "rename_symbol",
  scoutHandoff: { status: "ready" },
  evidenceClosure: { status: "not_applicable", localization_authority: false },
  editCapsule: {
    mutationReady: true,
    readinessBlockers: [],
  },
  renameMutationCapability: {
    ok: true,
    ready: true,
    globalReady: true,
    operation: "rename_symbol",
  },
})
assert.equal(renameReady.status, EXECUTION_READINESS_STATUS.READY_TO_MUTATE)
assert.equal(renameReady.required_mutation_shape, EXECUTION_MUTATION_SHAPE.RENAME_SYMBOL)
assert.deepEqual(renameReady.available_mutation_operations, ["rename_symbol"])

const exhausted = resolveExecutionReadiness({
  taskShape: additiveTaskShape,
  mutationIntent: "generic_edit",
  scoutHandoff: { status: "partial" },
  evidenceClosure: insufficientClosure,
  editCapsule: genericCapsuleBlocked,
  noProgressBlocked: true,
})
assert.equal(exhausted.status, EXECUTION_READINESS_STATUS.SAFE_FAIL)
assert.equal(exhausted.reason, "scout_evidence_exhausted")

const ambiguous = resolveExecutionReadiness({
  taskShape: additiveTaskShape,
  mutationIntent: "generic_edit",
  scoutHandoff: { status: "partial" },
  evidenceClosure: coveredClosure,
  editCapsule: { mutationReady: true, readinessBlockers: [] },
  localCompetitorCheck: {
    ok: false,
    reason: "competing_structural_owner",
  },
})
assert.equal(ambiguous.status, EXECUTION_READINESS_STATUS.SAFE_FAIL)
assert.equal(ambiguous.reason, "mutation_target_ambiguous")

const genericReadyHandoffUnsupported = resolveExecutionReadiness({
  mutationIntent: "generic_edit",
  scoutHandoff: { status: "ready" },
  evidenceClosure: { status: "not_applicable", localization_authority: false },
  editCapsule: genericCapsuleBlocked,
})
assert.equal(
  genericReadyHandoffUnsupported.status,
  EXECUTION_READINESS_STATUS.SAFE_FAIL,
)
assert.equal(
  genericReadyHandoffUnsupported.reason,
  "mutation_capability_unavailable",
)

const plugin = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)
const realTaskHarness = await readFile(
  new URL("./v2.17-real-task.py", import.meta.url),
  "utf8",
)
const searchFragment = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/07.part.ts",
    import.meta.url,
  ),
  "utf8",
)

assert.doesNotMatch(
  searchFragment,
  /applyExecutionEvent\(state,\s*["']scout_(?:ready|needs_evidence)["']/u,
)

assert.match(plugin, /EXECUTION_READINESS_PROTOCOL/u)
assert.match(plugin, /resolveExecutionReadiness\(\{/u)
assert.match(plugin, /applyExecutionReadiness\(state, executionReadiness\)/u)
assert.match(
  plugin,
  /const primaryMutationReady =\s*executionReadiness\.status ===\s*EXECUTION_READINESS_STATUS\.READY_TO_MUTATE/u,
)
assert.match(plugin, /SEARCH_STOP reason=\$\{executionReadiness\.reason\}/u)
assert.match(plugin, /reason: "execution_safe_fail"/u)
assert.match(plugin, /reason: "turn_wall_admission"/u)
assert.match(plugin, /observeModelLatencyAtToolBoundary\(state\)/u)
assert.match(plugin, /modelDispatchReserveMs\(state\)/u)
assert.match(plugin, /execution_readiness_status/u)
assert.match(plugin, /execution_readiness_mutation_authority/u)
assert.match(realTaskHarness, /if "SEARCH_STOP" in output:/u)
assert.match(realTaskHarness, /"mutation_capability_unavailable"/u)
assert.match(realTaskHarness, /return "architecture_bug"/u)

console.log("PASS v2.28-E1.8 canonical execution readiness")
