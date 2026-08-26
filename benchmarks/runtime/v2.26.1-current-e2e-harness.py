#!/usr/bin/env python3
from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

OLD = ROOT / "benchmarks/runtime/v2.17-real-task.py"
NEW = ROOT / "benchmarks/runtime/v2.26-real-task.py"


old = OLD.read_text(encoding="utf-8")
new = NEW.read_text(encoding="utf-8")

ast.parse(new)

assert 'PROTOCOL = "real-task-benchmark-v2"' in new


assert '"execute_replace_node"' in new
assert '"execute_rename_symbol"' in new

# Benchmark transport must preserve semantic task identity exactly.
# Safety/tool confinement belongs to the runtime tool surface, not user text.
assert "full_prompt = prompt" in new

# Candidate hygiene has exactly one authority implementation.
assert 'candidate_diff_check_failed' not in new
assert 'git(worktree, "diff", "--check")' not in new

for forbidden in (
    'f"TASK:\\n{prompt}"',
    'f"TASK: {prompt}"',
    "Use only search and the single capability-derived mutation tool",
    "real-task-benchmark-v2 requires a single-line task prompt",
):
    assert forbidden not in new, forbidden

assert 'tool_records(rows, "execute_replace_node")' in new
assert 'tool_records(rows, "execute_rename_symbol")' in new

assert '"mutation_tool_calls": len(patches)' in new
assert '"model_mutation_tool_calls": len(patches)' in new
assert '"deterministic_dispatches": deterministic_dispatches' in new
assert 'terminal_patch_rows = [' in new
assert 'if not patches and deterministic_dispatches < 1:' in new
assert '"execute_replace_node_calls": len(replace_calls)' in new
assert '"execute_rename_symbol_calls": len(rename_calls)' in new

# Historical benchmark remains historical.
assert 'PROTOCOL = "real-task-benchmark-v1"' in old
assert '"Use only search and execute_patch. "' in old
assert 'patches = tool_records(rows, "execute_patch")' in old

# New model-facing harness must no longer instruct the removed tool.
assert '"Use only search and execute_patch. "' not in new
assert 'patches = tool_records(rows, "execute_patch")' not in new

# Generic PATCH_* semantic transport remains intentionally supported.
for token in (
    "PATCH_READY",
    "PATCH_STOP",
):
    assert token in new

# Isolation / false-VERIFIED barriers must survive the fork.
for anchor in (
    "tracked_checkout_state(repo)",
    '"FALSE_VERIFIED"',
    '"patch_ready_without_passing_proofs"',
    '"candidate_not_replayable"',
    '"candidate_apply_failed"',
    '"task_acceptance_failed"',
    '"base_checkout_changed"',
):
    assert anchor in new, anchor

# Existing hard safety budgets survive.
for anchor in (
    '"model_calls", "max_model_calls"',
    '"patch_attempts", "max_patch_attempts"',
    '"changed_files", "max_changed_files"',
    '"changed_lines", "max_changed_lines"',
):
    assert anchor in new, anchor

print("PASS historical v2.17 harness remains frozen")
print("PASS v2.26 harness uses split mutation-action ABI")
print("PASS current harness retains isolation and false-VERIFIED barriers")
print("PASS current harness retains bounded budgets")
print("PASS v2.26.1 current-interface E2E harness")
