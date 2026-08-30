#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE = HERE / "v228_e27_timeout_contract.py"
spec = importlib.util.spec_from_file_location("e27_timeout_contract", MODULE)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

contract = mod.resolve_harness_timeout_contract(
    task={},
    defaults={
        "timeout_s": 300,
        "governor_task_budget_ms": 360000,
        "harness_timeout_grace_s": 30,
    },
    requested_timeout_s=300,
)
assert contract["effective_timeout_s"] == 390
assert contract["minimum_timeout_s"] == 390

legacy = mod.resolve_harness_timeout_contract(
    task={}, defaults={}, requested_timeout_s=180
)
assert legacy["enabled"] is False
assert legacy["effective_timeout_s"] == 180

trace = [{
    "kind": "model_dispatch",
    "ts": 1_000_000,
    "governor_task_budget_ms": 360000,
}]

old_bad = dict(contract, effective_timeout_s=300)
obs = mod.observe_harness_timeout(
    contract=old_bad,
    cpu_trace_rows=trace,
    agent={"timed_out": True},
    observed_at_ms=1_300_000,
)
assert obs["timeout_failure_class"] == "benchmark_bug"
assert obs["timeout_failure_reason"] == "harness_timeout_before_governor"
assert obs["model_inflight_elapsed_lower_bound_ms"] == 300000

obs = mod.observe_harness_timeout(
    contract=contract,
    cpu_trace_rows=trace,
    agent={"timed_out": True},
    observed_at_ms=1_390_000,
)
assert obs["governor_budget_contract_status"] == "matched"
assert obs["timeout_failure_class"] == "environment_bug"
assert obs["timeout_failure_reason"] == "benchmark_observation_timeout_model_inflight"
assert obs["model_inflight_elapsed_lower_bound_ms"] == 390000

drift = mod.observe_harness_timeout(
    contract=contract,
    cpu_trace_rows=[{
        "kind": "model_dispatch",
        "ts": 2_000_000,
        "governor_task_budget_ms": 420000,
    }],
    agent={"timed_out": True},
    observed_at_ms=2_390_000,
)
assert drift["governor_budget_contract_status"] == "drift"
assert drift["timeout_failure_class"] == "benchmark_bug"
assert drift["timeout_failure_reason"] == "governor_budget_contract_drift"

startup = mod.observe_harness_timeout(
    contract=contract,
    cpu_trace_rows=[],
    agent={"timed_out": True},
    observed_at_ms=1,
)
assert startup["timeout_failure_class"] == "environment_bug"
assert startup["timeout_failure_reason"] == "cli_timeout_before_model_dispatch"


safe = {
    "result": "SAFE_FAIL",
    "failure_class": "environment_bug",
    "reason": "cli_timeout_before_candidate",
}
fixed = mod.finalize_timeout_result(
    result=safe,
    agent_timed_out=True,
    timeout_observation=obs,
)
assert fixed["failure_class"] == "environment_bug"
assert fixed["reason"] == "benchmark_observation_timeout_model_inflight"

strong = {
    "result": "HARNESS_FAIL",
    "failure_class": "environment_bug",
    "reason": "project_root_mismatch",
}
preserved = mod.finalize_timeout_result(
    result=strong,
    agent_timed_out=True,
    timeout_observation=obs,
)
assert preserved == strong

not_timed_out = mod.finalize_timeout_result(
    result=safe,
    agent_timed_out=False,
    timeout_observation=obs,
)
assert not_timed_out == safe

print("PASS E2.7-C harness timeout >= Governor budget + grace")
print("PASS E2.7-C legacy benchmarks remain unbound unless contract is declared")
print("PASS E2.7-C pre-Governor harness kill is benchmark_bug")
print("PASS E2.7-C inflight benchmark timeout is unresolved environment/liveness evidence")
print("PASS E2.7-C Governor budget drift fails closed")
print("PASS E2.7-C inflight model latency lower bound is observable")
