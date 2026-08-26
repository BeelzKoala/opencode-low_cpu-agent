#!/usr/bin/env python3
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")
ACTION = (ROOT / "opencode/plugins/cpu-search-core/action-commit-v1.mjs").resolve()

for anchor in (
    'from "./cpu-search-core/action-commit-v1.mjs"',
    'const executeCapabilityMutationCore = async (',
    'deriveActionCommit({',
    'claimActionCommit(state, actionCommitResult.commit)',
    'origin: ACTION_COMMIT_DISPATCH_ORIGIN',
    '"task_action_argument_mismatch"',
    'mutation_dispatch_origin: dispatchOrigin',
    'action_commit_sha256: actionCommit?.commit_sha256 ?? null',
    'action_commit_dispatches:',
):
    assert anchor in PLUGIN, anchor

assert PLUGIN.count("const executeCapabilityMutationCore = async (") == 1
assert "const executeCapabilityMutation = async" not in PLUGIN
assert PLUGIN.index("const executeCapabilityMutationCore = async (") < PLUGIN.index('name: "search",')

for anchor in (
    'const MAX_MODEL_CALLS_PER_TURN = 4',
    'const MAX_EXECUTED_SEARCHES_PER_TURN = 4',
    'const MAX_PATCH_ATTEMPTS_PER_TURN = 2',
):
    assert anchor in PLUGIN, anchor

action_source = ACTION.read_text(encoding="utf-8")
for forbidden in (
    "spawn(", "exec(", "writeFile(", "readFile(", "runPatchCompiler(",
    "runPatchExecutor(", "runInvariantVerifier(", "writeLocalMutationHandoff(",
    "attestLocalMutationCapability(",
):
    assert forbidden not in action_source, forbidden

js = f'''
import {{ ACTION_COMMIT_DISPATCH_ORIGIN, ACTION_COMMIT_PROTOCOL,
  claimActionCommit, deriveActionCommit }} from {json.dumps(ACTION.as_uri())};
function assert(x, m) {{ if (!x) throw new Error(m) }}
const sha = "a".repeat(64), sourceSha = "b".repeat(64),
  identitySha = "c".repeat(64), capsuleSha = "d".repeat(64);
function state(overrides = {{}}) {{
  return {{
    executionState: "mutate", taskContextDrift: false, patchAccepted: false,
    pendingRescout: null, mutationAttempts: 0, taskTextSha256: sha,
    taskAction: {{ protocol: "task-action-v1", status: "exact",
      operation: "rename_symbol", old_name: "foo", new_name: "bar", task_sha256: sha }},
    scoutHandoffPath: "handoff.json",
    renameMutationCapability: {{ protocol: "scout-rename-target-v2",
      operation: "rename_symbol", ready: true, globalReady: true,
      sourceHandoffPath: "handoff.json",
      target: {{ file: "a.py", symbol_kind: "function_definition",
        symbol_name: "foo", start_line: 1, end_line: 2 }},
      targetIdentitySha256: identitySha, targetSourceSha256: sourceSha }},
    actionCommitSha256: null, actionCommitDispatches: 0, ...overrides,
  }};
}}
const capsule = {{ protocol: "edit-capsule-v1", path: "capsule.json", sha256: capsuleSha }};
const frontier = {{ tool: "execute_rename_symbol", reason: "rename_intent_authorized" }};
const args = {{ editCapsule: capsule, frontier, renameToolName: "execute_rename_symbol",
  renameCapabilityProtocol: "scout-rename-target-v2" }};

const s1 = state();
const first = deriveActionCommit({{ state: s1, ...args }});
const second = deriveActionCommit({{ state: state(), ...args }});
assert(first.ok === true, JSON.stringify(first));
assert(first.commit.protocol === ACTION_COMMIT_PROTOCOL, JSON.stringify(first));
assert(first.commit.dispatch_origin === ACTION_COMMIT_DISPATCH_ORIGIN, JSON.stringify(first));
assert(first.commit.commit_sha256 === second.commit.commit_sha256, "commit hash nondeterministic");
assert(claimActionCommit(s1, first.commit).ok === true, "first claim");
const duplicate = claimActionCommit(s1, first.commit);
assert(duplicate.ok === false && duplicate.reason === "action_commit_duplicate", JSON.stringify(duplicate));

const baseCap = state().renameMutationCapability;
const wrongOwner = deriveActionCommit({{ state: state({{
  renameMutationCapability: {{ ...baseCap,
    target: {{ ...baseCap.target, symbol_name: "other" }} }} }}), ...args }});
assert(wrongOwner.ok === false, JSON.stringify(wrongOwner));
assert(deriveActionCommit({{ state: state({{ executionState: "repair", mutationAttempts: 1 }}), ...args }}).ok === false, "repair commit");
assert(deriveActionCommit({{ state: state({{ taskTextSha256: "e".repeat(64) }}), ...args }}).ok === false, "stale task");
assert(deriveActionCommit({{ state: state({{ taskContextDrift: true }}), ...args }}).ok === false, "task drift");
assert(deriveActionCommit({{ state: state(), ...args, editCapsule: null }}).ok === false, "missing capsule");
assert(deriveActionCommit({{ state: state(), ...args, frontier: {{ tool: null }} }}).ok === false, "missing authority");

console.log("PASS ActionCommit deterministic + content-addressed");
console.log("PASS task/capability/handoff/capsule are causally bound");
console.log("PASS single-flight rejects duplicate dispatch");
console.log("PASS repair/drift/stale/mismatched authority fail closed");
'''

with tempfile.TemporaryDirectory(prefix="v227b-action-commit-") as td:
    path = Path(td) / "gate.mjs"
    path.write_text(js, encoding="utf-8")
    cp = subprocess.run(["node", str(path)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert cp.returncode == 0, (cp.stdout, cp.stderr)
    print(cp.stdout.strip())

harness = (ROOT / "benchmarks/runtime/v2.26-real-task.py").read_text(encoding="utf-8")
for anchor in (
    '"model_mutation_tool_calls": len(patches)',
    '"deterministic_dispatches": deterministic_dispatches',
    '"mutation_executions": len(patches) + deterministic_dispatches',
    'terminal_patch_rows = [',
    'if not patches and deterministic_dispatches < 1:',
):
    assert anchor in harness, anchor

print("PASS deterministic dispatch reuses one mutation core")
print("PASS harness treats tool event as transport, trace/receipt as execution evidence")
print("PASS v2.27-B proof-carrying deterministic Action Commitment")
