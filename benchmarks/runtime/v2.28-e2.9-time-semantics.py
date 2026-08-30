#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "benchmarks/runtime/v2.17-real-task.py"
GOVERNOR = ROOT / "opencode/plugins/cpu-search-core/governor-latency-v1.mjs"
FRAGMENT00 = ROOT / "opencode/plugins/cpu-search.fragments/00.part.ts"
FRAGMENT09 = ROOT / "opencode/plugins/cpu-search.fragments/09.part.ts"
INTERFACES = ROOT / "contracts/interfaces-v1.json"
LEASE = ROOT / "benchmarks/runtime/execution-lease-v1.mjs"

spec = importlib.util.spec_from_file_location("real_task_v217", HARNESS)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

sample = {
    "result": "SAFE_FAIL",
    "failure_class": "implementation_bug",
    "reason": "legacy_timeout_reason",
    "cli_timed_out": True,
    "model_call_status": "inflight_at_harness_timeout",
}
out = module.normalize_time_semantics(dict(sample))

assert out["time_semantics_protocol"] == "time-semantics-v1"
assert out["benchmark_deadline_authority"] == "benchmark_only"
assert out["benchmark_deadline_exceeded"] is True
assert out["governor_task_window_semantics"] == "admission_guardrail"
assert out["product_task_sla_enforced"] is False
assert out["product_task_sla_ms"] is None
assert out["product_watchdog_mode"] == "observation_only"
assert out["production_hard_lease_promoted"] is False
assert out["product_failure_proven"] is False
assert out["backend_liveness_status"] == "unresolved_model_inflight"
assert out["transport_cancel_proven"] is False
assert out["compute_quiescence_proven"] is False
assert out["failure_class"] == "environment_bug"
assert out["failure_class_confidence"] == "unresolved"
assert out["reason"] == "benchmark_observation_timeout_model_inflight"
assert out["timeout_failure_reason"] == \
    "benchmark_observation_timeout_model_inflight"

normal = {
    "result": "SAFE_FAIL",
    "failure_class": "implementation_bug",
    "reason": "semantic_failure",
    "cli_timed_out": False,
    "model_call_status": "completed_or_not_dispatched",
}
normal_out = module.normalize_time_semantics(dict(normal))
assert normal_out["reason"] == "semantic_failure"
assert normal_out["failure_class"] == "implementation_bug"
assert normal_out["benchmark_deadline_exceeded"] is False

harness = HARNESS.read_text(encoding="utf-8")
assert "model_backend_timeout_after_governor_budget" not in harness
assert "normalize_time_semantics(result)" in harness

governor = GOVERNOR.read_text(encoding="utf-8")
for literal in (
    'TIME_SEMANTICS_PROTOCOL = "time-semantics-v1"',
    'GOVERNOR_TASK_WINDOW_SEMANTICS = "admission_guardrail"',
    "GOVERNOR_TASK_SLA_ENFORCED = false",
    'GOVERNOR_PRODUCT_WATCHDOG_MODE = "observation_only"',
    "GOVERNOR_PRODUCTION_HARD_LEASE_PROMOTED = false",
    'GOVERNOR_ADMISSION_POLICY = "task_window_phase_runtime_v1"',
):
    assert literal in governor, literal

fragment00 = FRAGMENT00.read_text(encoding="utf-8")
for name in (
    "TIME_SEMANTICS_PROTOCOL",
    "GOVERNOR_TASK_WINDOW_SEMANTICS",
    "GOVERNOR_TASK_SLA_ENFORCED",
    "GOVERNOR_PRODUCT_WATCHDOG_MODE",
    "GOVERNOR_PRODUCTION_HARD_LEASE_PROMOTED",
):
    assert name in fragment00, name

fragment09 = FRAGMENT09.read_text(encoding="utf-8")
for field in (
    "time_semantics_protocol: TIME_SEMANTICS_PROTOCOL",
    "governor_task_window_semantics:",
    "task_sla_enforced: GOVERNOR_TASK_SLA_ENFORCED",
    "product_watchdog_mode: GOVERNOR_PRODUCT_WATCHDOG_MODE",
    "production_hard_lease_promoted:",
    "benchmark_deadline_authority: false",
):
    assert field in fragment09, field

interfaces = json.loads(INTERFACES.read_text(encoding="utf-8"))
assert interfaces["protocols"]["time_semantics"] == "time-semantics-v1"

# Existing lease substrate must remain conservative. Synthetic cancellation
# evidence must not silently become production hard-lease authority.
lease = LEASE.read_text(encoding="utf-8")
assert "compute_quiesced" in lease
assert "PROVEN" in lease or '"proven"' in lease.lower()

# E2.8 remains the synthesis authority layer; E2.9 must not replace it.
assert (
    ROOT / "benchmarks/runtime/v2.28-e2.8-obligation-bound-synthesis.mjs"
).exists()

print(
    "PASS E2.9 time semantics: benchmark deadline != task SLA; "
    "Governor windows remain admission guardrails; production hard lease "
    "stays unpromoted; inflight harness timeout is unresolved liveness evidence"
)
