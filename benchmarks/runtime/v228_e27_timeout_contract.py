#!/usr/bin/env python3
from __future__ import annotations

import math
import time
from typing import Any

PROTOCOL = "harness-timeout-contract-v1"
DEFAULT_GRACE_S = 30


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    return None


def resolve_harness_timeout_contract(
    *,
    task: dict[str, Any],
    defaults: dict[str, Any],
    requested_timeout_s: int,
) -> dict[str, Any]:
    requested = _positive_int(requested_timeout_s)
    if requested is None:
        raise ValueError("requested timeout must be a positive integer")

    budget_ms = _positive_int(
        task.get(
            "governor_task_budget_ms",
            defaults.get("governor_task_budget_ms"),
        )
    )
    grace_s = _positive_int(
        task.get(
            "harness_timeout_grace_s",
            defaults.get("harness_timeout_grace_s", DEFAULT_GRACE_S),
        )
    )
    if grace_s is None:
        raise ValueError("harness timeout grace must be a positive integer")

    if budget_ms is None:
        return {
            "protocol": PROTOCOL,
            "enabled": False,
            "requested_timeout_s": requested,
            "effective_timeout_s": requested,
            "governor_task_budget_ms_expected": None,
            "grace_s": grace_s,
            "minimum_timeout_s": None,
        }

    minimum_timeout_s = math.ceil(budget_ms / 1000) + grace_s
    return {
        "protocol": PROTOCOL,
        "enabled": True,
        "requested_timeout_s": requested,
        "effective_timeout_s": max(requested, minimum_timeout_s),
        "governor_task_budget_ms_expected": budget_ms,
        "grace_s": grace_s,
        "minimum_timeout_s": minimum_timeout_s,
    }


def timeout_contract_result_fields(contract: dict[str, Any]) -> dict[str, Any]:
    return {
        "harness_timeout_protocol": contract.get("protocol"),
        "harness_timeout_contract_enabled": contract.get("enabled") is True,
        "harness_timeout_requested_s": contract.get("requested_timeout_s"),
        "harness_timeout_effective_s": contract.get("effective_timeout_s"),
        "harness_timeout_grace_s": contract.get("grace_s"),
        "governor_task_budget_ms_expected": contract.get(
            "governor_task_budget_ms_expected"
        ),
    }



def finalize_timeout_result(
    *,
    result: dict[str, Any],
    agent_timed_out: bool,
    timeout_observation: dict[str, Any],
) -> dict[str, Any]:
    """Apply timeout causality only to timeout-derived SAFE_FAIL results.

    Preserve HARNESS_FAIL / FALSE_VERIFIED / VERIFIED classifications that
    carry stronger causal evidence (for example root mismatch or replay failure).
    """
    if not agent_timed_out:
        return result
    if result.get("result") != "SAFE_FAIL":
        return result

    failure_class = timeout_observation.get("timeout_failure_class")
    failure_reason = timeout_observation.get("timeout_failure_reason")
    if not isinstance(failure_class, str) or not failure_class:
        return result
    if not isinstance(failure_reason, str) or not failure_reason:
        return result

    out = dict(result)
    out["failure_class"] = failure_class
    out["reason"] = failure_reason
    return out


def observe_harness_timeout(
    *,
    contract: dict[str, Any],
    cpu_trace_rows: list[dict[str, Any]],
    agent: dict[str, Any],
    observed_at_ms: int | None = None,
) -> dict[str, Any]:
    dispatches = [
        row
        for row in cpu_trace_rows
        if row.get("kind") == "model_dispatch"
    ]
    observed_budgets = sorted({
        value
        for value in (
            row.get("governor_task_budget_ms")
            for row in dispatches
        )
        if _positive_int(value) is not None
    })
    expected = _positive_int(
        contract.get("governor_task_budget_ms_expected")
    )

    if not contract.get("enabled"):
        budget_status = "legacy_unbound"
    elif not observed_budgets:
        budget_status = "unobserved"
    elif observed_budgets == [expected]:
        budget_status = "matched"
    else:
        budget_status = "drift"

    timed_out = agent.get("timed_out") is True
    effective_s = _positive_int(contract.get("effective_timeout_s"))
    grace_s = _positive_int(contract.get("grace_s")) or DEFAULT_GRACE_S

    latest_dispatch_ts = max(
        (
            row.get("ts")
            for row in dispatches
            if _positive_int(row.get("ts")) is not None
        ),
        default=None,
    )
    if observed_at_ms is None:
        ended = _positive_int(agent.get("ended_at_ms"))
        observed_at_ms = ended or int(time.time() * 1000)

    lower_bound_ms = None
    if timed_out and latest_dispatch_ts is not None:
        lower_bound_ms = max(0, observed_at_ms - latest_dispatch_ts)

    failure_class = None
    failure_reason = None
    call_status = "completed_or_not_dispatched"

    if timed_out:
        call_status = (
            "inflight_at_harness_timeout"
            if dispatches
            else "no_model_dispatch_before_harness_timeout"
        )
        if budget_status == "drift":
            failure_class = "benchmark_bug"
            failure_reason = "governor_budget_contract_drift"
        elif dispatches and expected is not None and effective_s is not None:
            required_ms = expected + grace_s * 1000
            if effective_s * 1000 < required_ms:
                failure_class = "benchmark_bug"
                failure_reason = "harness_timeout_before_governor"
            else:
                # Benchmark observation ended while model inference was
                # still in flight. This proves neither a product defect nor
                # backend compute stall/quiescence.
                failure_class = "environment_bug"
                failure_reason = "benchmark_observation_timeout_model_inflight"
        elif dispatches:
            failure_class = "implementation_bug"
            failure_reason = "model_backend_timeout_unbounded_contract"
        else:
            failure_class = "environment_bug"
            failure_reason = "cli_timeout_before_model_dispatch"

    return {
        "governor_budget_contract_status": budget_status,
        "governor_task_budget_ms_observed": (
            observed_budgets[0]
            if len(observed_budgets) == 1
            else None
        ),
        "governor_task_budget_ms_observed_values": observed_budgets,
        "model_call_status": call_status,
        "model_last_dispatch_ts_ms": latest_dispatch_ts,
        "model_inflight_elapsed_lower_bound_ms": lower_bound_ms,
        "timeout_failure_class": failure_class,
        "timeout_failure_reason": failure_reason,
    }
