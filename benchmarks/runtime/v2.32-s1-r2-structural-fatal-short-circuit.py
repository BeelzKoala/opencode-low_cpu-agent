#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = (
    ROOT / "opencode/plugins/cpu-search.ts"
).read_text(encoding="utf-8")

required = (
    'const FATAL_SAFE_FAIL_PROTOCOL = "fatal-safe-fail-v1"',
    'function deriveFatalSafeFail(state, reason = null)',
    'function claimFatalSafeFail(state, commit)',
    'function fatalSafeFailMatchesState(commit, state)',
    'function clearFatalSafeFailState(state)',
    'if (event === "fatal")',
    'kind: "fatal_safe_fail_requested"',
    'kind: "fatal_safe_fail"',
    'kind: "fatal_safe_fail_failed"',
    'continue: false',
)
for marker in required:
    assert marker in PLUGIN, marker

apply_start = PLUGIN.index(
    "function applyExecutionEvent("
)
apply_end = PLUGIN.index(
    "\nfunction toolAllowedForExecutionState",
    apply_start,
)
apply_block = PLUGIN[apply_start:apply_end]

event_index = apply_block.index(
    "state.executionEvent = event"
)
claim_index = apply_block.index(
    "deriveFatalSafeFail(",
    event_index,
)
phase_index = apply_block.index(
    "if (previousPhase !== nextPhase)",
)
assert event_index < claim_index < phase_index

model_index = PLUGIN.index(
    "state.modelCalls += 1"
)
fatal_gate_index = PLUGIN.rfind(
    "Deterministic fatal is already a terminal decision.",
    0,
    model_index,
)
assert fatal_gate_index >= 0
assert fatal_gate_index < model_index

gate = PLUGIN[fatal_gate_index:model_index]
assert (
    'state.executionState === EXEC_STATE_SAFE_FAIL'
    in gate
)
assert 'state.executionEvent === "fatal"' in gate
assert "MAX_MODEL_CALLS_PER_TURN" not in gate
assert "semantic_python_" not in gate
assert "report_result" not in gate

reset_start = PLUGIN.index(
    "function resetTurnState("
)
reset_end = PLUGIN.index(
    "\nfunction transitionExecutionState",
    reset_start,
)
reset = PLUGIN[reset_start:reset_end]

# Terminal proof/receipt must survive ordinary turn-state cleanup until the
# pre-model gate validates whether it belongs to the same task/turn.
assert "fatalSafeFail = null" not in reset
assert "fatalSafeFailSha256 = null" not in reset

print(
    "PASS S1-R2 structural fatal short-circuit "
    "fragment_number_independent=true "
    "governor_phase_preserved=true "
    "pre_model_gate=true "
    "reason_agnostic=true "
    "task_or_turn_bound=true "
    "no_post_fatal_provider_dispatch=true"
)
