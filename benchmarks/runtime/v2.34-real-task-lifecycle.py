#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PROTOCOL = "inference-lifecycle-harness-v1"
DEFAULT_SLOTS_URL = "http://127.0.0.1:8080/slots"
DEFAULT_METRICS_URL = "http://127.0.0.1:8080/metrics"
DEFAULT_PRE_QUIESCENCE_S = 10.0
DEFAULT_POST_QUIESCENCE_S = 10.0
DEFAULT_POLL_S = 0.25
DEFAULT_EMERGENCY_CEILING_S = 1800


def env_float(
    name: str,
    fallback: float,
    minimum: float,
    maximum: float,
) -> float:
    raw = os.environ.get(name)
    try:
        value = float(raw) if raw is not None else fallback
    except ValueError:
        return fallback
    return value if minimum <= value <= maximum else fallback


def env_int(
    name: str,
    fallback: int,
    minimum: int,
    maximum: int,
) -> int:
    raw = os.environ.get(name)
    try:
        value = int(raw) if raw is not None else fallback
    except ValueError:
        return fallback
    return value if minimum <= value <= maximum else fallback


def fetch_json(
    url: str,
    timeout_s: float = 1.0,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        request = Request(
            url,
            method="GET",
            headers={"Accept": "application/json"},
        )
        with urlopen(request, timeout=timeout_s) as response:
            value = json.loads(
                response.read().decode(
                    "utf-8",
                    errors="replace",
                )
            )
        return {
            "status": "ok",
            "elapsed_ms": round(
                (time.monotonic() - started) * 1000,
                3,
            ),
            "value": value,
        }
    except (
        HTTPError,
        URLError,
        TimeoutError,
        json.JSONDecodeError,
        OSError,
    ) as exc:
        return {
            "status": "unavailable",
            "elapsed_ms": round(
                (time.monotonic() - started) * 1000,
                3,
            ),
            "error": type(exc).__name__,
            "value": None,
        }


def parse_prometheus(
    text: str,
) -> dict[str, float]:
    wanted = {
        "llamacpp:requests_processing",
        "llamacpp:requests_deferred",
        "llamacpp:prompt_tokens_total",
        "llamacpp:tokens_predicted_total",
        "llamacpp:n_tokens_max",
    }
    out: dict[str, float] = {}

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        name, raw = parts
        if "{" in name:
            name = name.split("{", 1)[0]
        if name not in wanted:
            continue
        try:
            out[name] = float(raw)
        except ValueError:
            continue

    return out


def fetch_metrics(
    url: str,
    timeout_s: float = 1.0,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        request = Request(
            url,
            method="GET",
            headers={"Accept": "text/plain"},
        )
        with urlopen(request, timeout=timeout_s) as response:
            text = response.read().decode(
                "utf-8",
                errors="replace",
            )
        return {
            "status": "ok",
            "elapsed_ms": round(
                (time.monotonic() - started) * 1000,
                3,
            ),
            "metrics": parse_prometheus(text),
        }
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
    ) as exc:
        return {
            "status": "unavailable",
            "elapsed_ms": round(
                (time.monotonic() - started) * 1000,
                3,
            ),
            "error": type(exc).__name__,
            "metrics": {},
        }


def normalized_slots(
    value: Any,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []

    out = []
    for row in value:
        if not isinstance(row, dict):
            continue
        out.append({
            "id": row.get("id"),
            "id_task": row.get("id_task"),
            "is_processing": row.get("is_processing") is True,
            "n_prompt_tokens": row.get("n_prompt_tokens"),
            "n_prompt_tokens_processed": row.get(
                "n_prompt_tokens_processed"
            ),
            "n_prompt_tokens_cache": row.get("n_prompt_tokens_cache"),
            "n_ctx": row.get("n_ctx"),
        })
    return out


def provider_snapshot() -> dict[str, Any]:
    slots_url = os.environ.get(
        "OPENCODE_CPU_TELEMETRY_LLAMA_SLOTS_URL",
        DEFAULT_SLOTS_URL,
    )
    metrics_url = os.environ.get(
        "OPENCODE_CPU_TELEMETRY_LLAMA_METRICS_URL",
        DEFAULT_METRICS_URL,
    )

    slots_raw = fetch_json(
        slots_url,
        timeout_s=1.0,
    )
    metrics = fetch_metrics(
        metrics_url,
        timeout_s=1.0,
    )
    slots = normalized_slots(
        slots_raw.get("value")
    )
    processing_slots = [
        row
        for row in slots
        if row.get("is_processing") is True
    ]

    metric_values = metrics.get("metrics", {})
    requests_processing = metric_values.get(
        "llamacpp:requests_processing"
    )
    requests_deferred = metric_values.get(
        "llamacpp:requests_deferred"
    )
    slots_available = slots_raw.get("status") == "ok"
    metrics_available = metrics.get("status") == "ok"

    if not slots_available:
        quiescent = None
        reason = "slots_unavailable"
    elif processing_slots:
        quiescent = False
        reason = "processing_slot_active"
    elif (
        metrics_available
        and (
            requests_processing not in (None, 0, 0.0)
            or requests_deferred not in (None, 0, 0.0)
        )
    ):
        quiescent = False
        reason = "slot_metric_quiescence_conflict"
    else:
        quiescent = True
        reason = "quiescent"

    return {
        "protocol": PROTOCOL,
        "slots_status": slots_raw.get("status"),
        "metrics_status": metrics.get("status"),
        "slots": slots,
        "processing_slots": processing_slots,
        "requests_processing": requests_processing,
        "requests_deferred": requests_deferred,
        "quiescent": quiescent,
        "reason": reason,
    }


def wait_for_quiescence(
    timeout_s: float,
) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + timeout_s
    attempts = []

    while True:
        snapshot = provider_snapshot()
        attempts.append({
            "elapsed_s": round(
                time.monotonic() - started,
                3,
            ),
            "quiescent": snapshot.get("quiescent"),
            "reason": snapshot.get("reason"),
            "processing_task_ids": [
                row.get("id_task")
                for row in snapshot.get(
                    "processing_slots",
                    [],
                )
            ],
            "requests_processing": snapshot.get(
                "requests_processing"
            ),
            "requests_deferred": snapshot.get(
                "requests_deferred"
            ),
        })

        if snapshot.get("quiescent") is True:
            return {
                "status": "idle_confirmed",
                "elapsed_s": round(
                    time.monotonic() - started,
                    3,
                ),
                "attempts": attempts[-20:],
                "snapshot": snapshot,
            }

        if time.monotonic() >= deadline:
            return {
                "status": "not_quiescent",
                "elapsed_s": round(
                    time.monotonic() - started,
                    3,
                ),
                "attempts": attempts[-20:],
                "snapshot": snapshot,
            }

        time.sleep(
            env_float(
                "OPENCODE_CPU_HARNESS_QUIESCENCE_POLL_S",
                DEFAULT_POLL_S,
                0.05,
                5.0,
            )
        )


def recovery_argv() -> list[str] | None:
    raw = os.environ.get(
        "OPENCODE_CPU_INFERENCE_RECOVERY_ARGV_JSON"
    )
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None

    if (
        not isinstance(value, list)
        or not value
        or not all(
            isinstance(item, str) and item
            for item in value
        )
    ):
        return None

    return value


def attempt_provider_recovery() -> dict[str, Any]:
    argv = recovery_argv()

    if argv is None:
        return {
            "attempted": False,
            "reason": "recovery_argv_unconfigured",
        }

    if (
        os.environ.get(
            "OPENCODE_CPU_INFERENCE_BACKEND_OWNED"
        )
        != "1"
    ):
        return {
            "attempted": False,
            "reason": "backend_ownership_unattested",
        }

    started = time.monotonic()
    try:
        cp = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            check=False,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return {
            "attempted": True,
            "ok": False,
            "reason": "recovery_command_timeout",
        }

    post = wait_for_quiescence(15.0)

    return {
        "attempted": True,
        "ok": (
            cp.returncode == 0
            and post.get("status") == "idle_confirmed"
        ),
        "rc": cp.returncode,
        "elapsed_s": round(
            time.monotonic() - started,
            3,
        ),
        "post_recovery": post,
    }


def classify_terminal_truth(
    row: dict[str, Any],
    postflight: dict[str, Any],
) -> dict[str, Any]:
    out = copy.deepcopy(row)
    timed_out = out.get("cli_timed_out") is True
    leak = postflight.get("status") != "idle_confirmed"

    out["provider_postflight_quiescent"] = not leak
    out["provider_leak_detected"] = leak

    if timed_out:
        out.update({
            "result": "HARNESS_FAIL",
            "failure_class": "benchmark_bug",
            "reason": "harness_emergency_ceiling",
            "agent_terminal_observed": False,
            "harness_terminated": True,
        })

    if leak:
        out.update({
            "result": "HARNESS_FAIL",
            "failure_class": "architecture_bug",
            "reason": "provider_inference_leak_after_task",
            "agent_terminal_observed": not timed_out,
        })

    return out


def load_base_runner() -> Any:
    path = (
        Path(__file__).resolve().parent
        / "v2.17-real-task.py"
    )
    spec = importlib.util.spec_from_file_location(
        "koalik_v217_real_task",
        path,
    )

    if spec is None or spec.loader is None:
        raise RuntimeError(
            f"cannot load base runner: {path}"
        )

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    base = load_base_runner()
    original_run_task = base.run_task

    pre_timeout = env_float(
        "OPENCODE_CPU_HARNESS_PRE_QUIESCENCE_S",
        DEFAULT_PRE_QUIESCENCE_S,
        0.5,
        120.0,
    )
    post_timeout = env_float(
        "OPENCODE_CPU_HARNESS_POST_QUIESCENCE_S",
        DEFAULT_POST_QUIESCENCE_S,
        0.5,
        120.0,
    )
    emergency_ceiling = env_int(
        "OPENCODE_CPU_HARNESS_EMERGENCY_CEILING_S",
        DEFAULT_EMERGENCY_CEILING_S,
        60,
        7200,
    )

    def guarded_run_task(
        task: dict[str, Any],
        defaults: dict[str, Any],
        opencode: Path,
        result_root: Path,
        keep_worktree: bool,
    ) -> dict[str, Any]:
        task_id = task.get("id", "<missing>")
        preflight = wait_for_quiescence(
            pre_timeout
        )

        if (
            preflight.get("status")
            != "idle_confirmed"
        ):
            return {
                "protocol": getattr(
                    base,
                    "PROTOCOL",
                    "real-task-benchmark-v1",
                ),
                "task_id": task_id,
                "repo": task.get("repo"),
                "result": "HARNESS_FAIL",
                "failure_class": "environment_bug",
                "reason": "provider_not_quiescent_before_task",
                "provider_preflight": preflight,
                "provider_postflight": None,
                "provider_leak_detected": True,
                "agent_terminal_observed": False,
                "harness_terminated": False,
            }

        bounded_task = dict(task)
        requested_timeout = bounded_task.get(
            "timeout_s",
            defaults.get("timeout_s"),
        )
        original_timeout = (
            requested_timeout
            if isinstance(requested_timeout, int)
            else 0
        )

        # Existing v2.17 telemetry/adaptive logic remains intact.
        # We only raise the process-safety ceiling so the historical
        # 390s observation limit cannot masquerade as agent SAFE_FAIL.
        bounded_task["timeout_s"] = max(
            emergency_ceiling,
            original_timeout,
        )

        row = original_run_task(
            bounded_task,
            defaults,
            opencode,
            result_root,
            keep_worktree,
        )

        postflight = wait_for_quiescence(
            post_timeout
        )
        truthful = classify_terminal_truth(
            row,
            postflight,
        )

        truthful[
            "inference_lifecycle_harness_protocol"
        ] = PROTOCOL
        truthful[
            "harness_timeout_authority"
        ] = "process_safety_only"
        truthful[
            "harness_requested_timeout_s_original"
        ] = requested_timeout
        truthful[
            "harness_emergency_ceiling_s"
        ] = emergency_ceiling
        truthful["provider_preflight"] = preflight
        truthful["provider_postflight"] = postflight

        if truthful.get("provider_leak_detected") is True:
            truthful["provider_recovery"] = (
                attempt_provider_recovery()
            )

        return truthful

    base.run_task = guarded_run_task
    return int(base.main())


if __name__ == "__main__":
    raise SystemExit(main())
