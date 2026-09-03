import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  deriveTerminalCommit,
} from "../../opencode/plugins/cpu-search-core/terminal-commit-v1.mjs"

const sha = "a".repeat(64)

const proofAssessment = {
  protocol: "proof-obligation-v1",
  ok: true,
  disposition: "pass",
  obligations: [],
  failed: [],
}

const taskProof = {
  protocol: "task-proof-evaluator-v1",
  ok: true,
  verdict: "PASS",
  reason: null,
  checks: [
    {
      id: "input_validation_present",
      checker: "candidate_ast_input_validation",
      pass: true,
      reason: "oracle",
    },
  ],
  checks_total: 1,
  checks_passed: 1,
  checks_failed: 0,
  baseline_clean_before: true,
  baseline_clean_after: true,
  proof_authority: "deterministic_candidate_analysis",
  mutation_authority: false,
}

const state = {
  patchAccepted: true,
  executionState: "done",
  executionEvent: "patch_ready",
  executionReason: "verification_passed",
  taskContextLatched: true,
  taskContextDrift: false,
  taskTurnID: "turn-1",
  taskTextSha256: sha,
  patchReceiptPath: ".opencode/patches/receipt.json",
}

const persisted = {
  path: ".opencode/patches/receipt.json",
  verificationPath: ".opencode/patches/verification.json",
  receiptSha256: sha,
  verificationSha256: sha,
  receipt: {
    protocol: "patch-receipt-v1",
    verification_protocol: "verification-receipt-v1",
    verification_receipt: ".opencode/patches/verification.json",
    patch_path: ".opencode/patches/candidate.patch",
    patch_sha256: sha,
    proof_disposition: "pass",
    repo_mutated: false,
  },
  verificationReceipt: {
    protocol: "verification-receipt-v1",
    patch_receipt: ".opencode/patches/receipt.json",
    patch_sha256: sha,
    proof_assessment: proofAssessment,
    task_proof_protocol: "task-proof-evaluator-v1",
    task_proof: taskProof,
    verifier: {
      protocol: "invariant-verifier-v2",
      ok: true,
      verdict: "PASS",
      invariants_failed: 0,
      worktree_cleaned: true,
    },
  },
}

const additive = deriveTerminalCommit({
  state,
  persisted,
  proofAssessment,
  terminalPolicy: "additive-task-proof-v1",
  taskProofAssessment: taskProof,
})

assert.equal(
  additive.ok,
  true,
  JSON.stringify(additive),
)
assert.equal(
  additive.commit.outcome,
  "VERIFIED",
)
assert.equal(
  additive.commit.terminal_policy,
  "additive-task-proof-v1",
)
assert.match(
  additive.commit.task_proof_sha256,
  /^[0-9a-f]{64}$/,
)

const failedTaskProof = {
  ...taskProof,
  ok: false,
  verdict: "FAIL",
  checks_passed: 0,
  checks_failed: 1,
}

const rejected = deriveTerminalCommit({
  state,
  persisted,
  proofAssessment,
  terminalPolicy: "additive-task-proof-v1",
  taskProofAssessment: failedTaskProof,
})

assert.equal(rejected.ok, false)
assert.equal(
  rejected.reason,
  "terminal_commit_task_proof_not_pass",
)

const legacyPersisted = {
  ...persisted,
  verificationReceipt: {
    ...persisted.verificationReceipt,
  },
}
delete legacyPersisted.verificationReceipt.task_proof
delete legacyPersisted.verificationReceipt.task_proof_protocol

const legacy = deriveTerminalCommit({
  state,
  persisted: legacyPersisted,
  proofAssessment,
})

assert.equal(
  legacy.ok,
  true,
  JSON.stringify(legacy),
)
assert.equal(
  "terminal_policy" in legacy.commit,
  false,
)
assert.equal(
  "task_proof_sha256" in legacy.commit,
  false,
)

const plugin = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.ts",
    import.meta.url,
  ),
  "utf8",
)

for (const marker of [
  "compileTaskProofObligations(",
  "runTaskProofEvaluator(",
  'forcedKind === "additive_surface"',
  "const taskProofTerminalAuthorized =",
  "const terminalAuthorized =",
  "terminalPolicy,",
]) {
  assert.equal(
    plugin.includes(marker),
    true,
    marker,
  )
}

assert.match(
  plugin,
  /task_proof:\s*taskProofAssessment,/,
)

console.log(
  "PASS E3.2 additive VERIFIED requires structural + deterministic task proof",
)
console.log(
  "PASS E3.2 legacy terminal commit shape remains task-proof independent",
)
console.log(
  "PASS E3.2 runtime wires TaskRequirements -> proof evaluator -> additive terminal policy",
)
