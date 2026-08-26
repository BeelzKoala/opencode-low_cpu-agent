#!/usr/bin/env python3
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")
TERMINAL = (
    ROOT / "opencode/plugins/cpu-search-core/terminal-commit-v1.mjs"
).resolve()

for anchor in (
    'from "./cpu-search-core/terminal-commit-v1.mjs"',
    'TERMINAL_SHORT_CIRCUIT_ENABLED',
    'function clearTerminalCommitState(state)',
    'async function validateTerminalCommitArtifacts(root, commit)',
    'deriveTerminalCommit({',
    'claimTerminalCommit(',
    'kind: "terminal_commit"',
    'terminalCommitMatchesTask(',
    'kind: "terminal_short_circuit_requested"',
    'kind: "terminal_short_circuit"',
    'kind: "terminal_short_circuit_failed"',
    'kind: "completion_authorizer"',
    'completion_authorizer_authority: "terminal_permission"',
    'completionAuthorizationPermitsTerminal(',
    'completion_safe_fail_commit',
    'completion_safe_fail_requested',
    'completion_safe_fail',
    'completionSafeFailMatchesTask(',
    'deriveCompletionSafeFail({',
    'claimCompletionSafeFail(',
    'await interrupt({',
    'continue: false',
    'terminal_short_circuit_requests:',
    'terminal_short_circuits:',
    'terminal_short_circuit_failures:',
):
    assert anchor in PLUGIN, anchor

reset_start = PLUGIN.index("function resetTurnState(")
reset_end = PLUGIN.index("\nfunction transitionExecutionState", reset_start)
reset_block = PLUGIN[reset_start:reset_end]
for forbidden in (
    "terminalCommit = null",
    "terminalCommitSha256 = null",
    "terminalCommitClaims = 0",
):
    assert forbidden not in reset_block, forbidden

context_start = PLUGIN.index('ctx.session.hook("context"')
context_end = PLUGIN.index("\n    }))", context_start)
context = PLUGIN[context_start:context_end]
safe_fail_gate_index = context.index("completionSafeFailMatchesTask(")
gate_index = context.index("terminalCommitMatchesTask(")
reset_index = context.index("resetTurnState(")
model_index = context.index("state.modelCalls += 1")
dispatch_index = context.index('kind: "model_dispatch"')
assert safe_fail_gate_index < gate_index < reset_index < model_index < dispatch_index
assert "terminal_task_turn_changed" in context
assert "clearTerminalCommitState(state)" in context
assert "completion_safe_fail_task_turn_changed" in context
assert "clearCompletionSafeFailState(state)" in context
assert 'kind: "completion_safe_fail_requested"' in context
assert 'kind: "completion_safe_fail"' in context
assert "validateTerminalCommitArtifacts(" in context

persist_index = PLUGIN.index("const persisted = await writePatchReceipt(")
authorize_index = PLUGIN.index(
    "await observeCompletionAuthorization(",
    persist_index,
)
ready_index = PLUGIN.index(
    'applyExecutionEvent(state, "patch_ready", "verification_passed")',
    authorize_index,
)
permit_index = PLUGIN.index(
    "completionAuthorizationPermitsTerminal(",
    ready_index,
)
derive_index = PLUGIN.index("deriveTerminalCommit({", permit_index)
terminal_let_index = PLUGIN.index("let terminalCommit = null", derive_index)
assert persist_index < authorize_index < ready_index < permit_index < derive_index < terminal_let_index

permission_block = PLUGIN[permit_index:terminal_let_index]
for anchor in (
    "deriveCompletionSafeFail({",
    "claimCompletionSafeFail(",
    'kind: "completion_safe_fail_commit"',
    "const terminalCommitResult = completionAuthorized",
    '? deriveTerminalCommit({',
    'completion_authorizer_not_applicable',
    'completion_authorizer_unavailable',
    'completion_authorizer_abstain',
    'completion_certificate_invalid',
):
    assert anchor in permission_block, anchor

assert PLUGIN.rfind("writePatchReceipt(", 0, authorize_index) >= 0

terminal_source = TERMINAL.read_text(encoding="utf-8")
for forbidden in (
    "spawn(",
    "exec(",
    "writeFile(",
    "readFile(",
    "runPatchCompiler(",
    "runPatchExecutor(",
    "runInvariantVerifier(",
    "runCompletionAuthorizer(",
    "completion_authorizer",
):
    assert forbidden not in terminal_source, forbidden

js = f'''
import {{
  TERMINAL_COMMIT_PROTOCOL,
  TERMINAL_OUTCOME,
  claimTerminalCommit,
  deriveTerminalCommit,
  terminalCommitMatchesTask,
}} from {json.dumps(TERMINAL.as_uri())};

function assert(x, m) {{
  if (!x) throw new Error(m)
}}

const taskSha = "a".repeat(64)
const receiptSha = "b".repeat(64)
const verificationSha = "c".repeat(64)
const patchSha = "d".repeat(64)
const userTurn = "user:message-1"

function state(overrides = {{}}) {{
  return {{
    patchAccepted: true,
    executionState: "done",
    executionEvent: "patch_ready",
    executionReason: "verification_passed",
    taskContextLatched: true,
    taskContextDrift: false,
    taskTurnID: userTurn,
    taskTextSha256: taskSha,
    patchReceiptPath: ".opencode/patches/p.json",
    terminalCommit: null,
    terminalCommitSha256: null,
    terminalCommitClaims: 0,
    ...overrides,
  }}
}}

const proof = {{
  ok: true,
  disposition: "pass",
  failed: [],
  obligations: [],
}}
const persisted = {{
  path: ".opencode/patches/p.json",
  verificationPath: ".opencode/patches/p.verify.json",
  receiptSha256: receiptSha,
  verificationSha256: verificationSha,
  receipt: {{
    protocol: "patch-receipt-v1",
    verification_protocol: "verification-receipt-v1",
    verification_receipt: ".opencode/patches/p.verify.json",
    patch_path: ".opencode/patches/p.diff",
    patch_sha256: patchSha,
    proof_disposition: "pass",
    repo_mutated: false,
  }},
  verificationReceipt: {{
    protocol: "verification-receipt-v1",
    patch_receipt: ".opencode/patches/p.json",
    patch_sha256: patchSha,
    proof_assessment: proof,
    verifier: {{
      ok: true,
      invariants_failed: 0,
      worktree_cleaned: true,
    }},
  }},
}}

const first = deriveTerminalCommit({{
  state: state(),
  persisted,
  proofAssessment: proof,
}})
const second = deriveTerminalCommit({{
  state: state(),
  persisted,
  proofAssessment: proof,
}})
assert(first.ok === true, JSON.stringify(first))
assert(first.commit.protocol === TERMINAL_COMMIT_PROTOCOL, JSON.stringify(first))
assert(first.commit.outcome === TERMINAL_OUTCOME, JSON.stringify(first))
assert(first.commit.commit_sha256 === second.commit.commit_sha256, "nondeterministic terminal hash")
assert(first.commit.user_turn_id === userTurn, JSON.stringify(first))
assert(first.commit.task_sha256 === taskSha, JSON.stringify(first))

const claimedState = state()
const claim1 = claimTerminalCommit(claimedState, first.commit)
assert(claim1.ok === true && claim1.duplicate === false, JSON.stringify(claim1))
const replay = claimTerminalCommit(claimedState, first.commit)
assert(replay.ok === true && replay.duplicate === true, JSON.stringify(replay))

const conflicting = {{
  ...first.commit,
  commit_sha256: "e".repeat(64),
}}
const conflict = claimTerminalCommit(claimedState, conflicting)
assert(conflict.ok === false && conflict.reason === "terminal_commit_conflict", JSON.stringify(conflict))

assert(
  terminalCommitMatchesTask(first.commit, {{
    ok: true,
    turnID: userTurn,
    textSha256: taskSha,
  }}).ok === true,
  "same task must match",
)
assert(
  terminalCommitMatchesTask(first.commit, {{
    ok: true,
    turnID: "user:message-2",
    textSha256: taskSha,
  }}).reason === "terminal_task_turn_changed",
  "same text in a new user turn must not replay",
)
assert(
  terminalCommitMatchesTask(first.commit, {{
    ok: true,
    turnID: userTurn,
    textSha256: "f".repeat(64),
  }}).reason === "terminal_task_text_drift",
  "same user turn with changed text must fail closed",
)

const badProof = deriveTerminalCommit({{
  state: state(),
  persisted,
  proofAssessment: {{...proof, ok: false, disposition: "repair"}},
}})
assert(badProof.ok === false, JSON.stringify(badProof))

const staleTask = deriveTerminalCommit({{
  state: state({{taskContextDrift: true}}),
  persisted,
  proofAssessment: proof,
}})
assert(staleTask.ok === false, JSON.stringify(staleTask))

const wrongReceipt = deriveTerminalCommit({{
  state: state(),
  persisted: {{
    ...persisted,
    path: "../escape.json",
  }},
  proofAssessment: proof,
}})
assert(wrongReceipt.ok === false, JSON.stringify(wrongReceipt))

console.log("PASS TerminalCommit deterministic + content-addressed")
console.log("PASS task hash + opaque user-turn identity prevent stale replay")
console.log("PASS only persisted pass-proof can terminalize")
console.log("PASS idempotent replay + conflicting terminal outcome fail closed")
'''

with tempfile.TemporaryDirectory(prefix="v227c-terminal-") as td:
    path = Path(td) / "gate.mjs"
    path.write_text(js, encoding="utf-8")
    cp = subprocess.run(
        ["node", str(path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert cp.returncode == 0, (cp.stdout, cp.stderr)
    print(cp.stdout.strip())

harness = (
    ROOT / "benchmarks/runtime/v2.26-real-task.py"
).read_text(encoding="utf-8")
for anchor in (
    '"terminal_commits": terminal_commits',
    '"terminal_short_circuit_requests":',
    '"terminal_short_circuits": terminal_short_circuits',
    '"terminal_short_circuit_failures":',
    '"post_terminal_model_dispatches":',
    '"completion_safe_fail_commits":',
    '"completion_safe_fail_requests":',
    '"completion_safe_fails":',
    '"completion_safe_fail_failures":',
    '"post_completion_safe_fail_model_dispatches":',
    'if completion_safe_fail_commits > 0:',
):
    assert anchor in harness, anchor

print("PASS terminal gate precedes model-call accounting")
print("PASS native CompletionAuthorizer is the only TerminalCommit permission")
print("PASS ABSTAIN/unavailable/invalid certificate withholds terminal optimization")
print("PASS denied completion produces bounded safe-fail before another model dispatch")
print("PASS TerminalCommit actuator remains completion-semantics-free")
print("PASS turn reset cannot erase terminal proof")
print("PASS Compiler/Executor/Verifier authority unchanged")
print("PASS v2.27-C proof-carrying terminal short-circuit")
