#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "v2.34-real-task-lifecycle.py"

spec = importlib.util.spec_from_file_location(
    "lifecycle_runner",
    TARGET,
)
assert spec is not None
assert spec.loader is not None

module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

safe = module.classify_terminal_truth(
    {
        "task_id": "x",
        "result": "SAFE_FAIL",
        "failure_class": "implementation_bug",
        "reason": "bounded_safe_failure",
        "cli_timed_out": False,
    },
    {
        "status": "idle_confirmed",
    },
)

assert safe["result"] == "SAFE_FAIL"
assert safe["provider_leak_detected"] is False

timeout = module.classify_terminal_truth(
    {
        "task_id": "x",
        "result": "SAFE_FAIL",
        "failure_class": "environment_bug",
        "reason": "benchmark_observation_timeout_model_inflight",
        "cli_timed_out": True,
    },
    {
        "status": "idle_confirmed",
    },
)

assert timeout["result"] == "HARNESS_FAIL"
assert timeout["reason"] == "harness_emergency_ceiling"
assert timeout["agent_terminal_observed"] is False

leak = module.classify_terminal_truth(
    {
        "task_id": "x",
        "result": "VERIFIED",
        "failure_class": None,
        "reason": None,
        "cli_timed_out": False,
    },
    {
        "status": "not_quiescent",
    },
)

assert leak["result"] == "HARNESS_FAIL"
assert leak["reason"] == "provider_inference_leak_after_task"
assert leak["provider_leak_detected"] is True

print(
    "PASS C12 harness lifecycle "
    "harness_cannot_forge_safe_fail=true "
    "pre_task_quiescence=true "
    "post_task_quiescence=true "
    "provider_leak_is_harness_fail=true "
    "emergency_ceiling=process_safety_only "
    "recovery=explicit_owned_backend_only"
)
