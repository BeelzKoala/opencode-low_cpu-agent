#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


PROTOCOL = "physical-inference-summary-v1"


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except Exception:
                continue

            if isinstance(value, dict):
                rows.append(value)

    return rows


def number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def integer(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def max_number(values: list[Any]) -> float | None:
    numbers = [value for value in (number(item) for item in values) if value is not None]
    return max(numbers) if numbers else None


def trace_end_mono(rows: list[dict[str, Any]]) -> float | None:
    return max_number([row.get("mono_ms") for row in rows])


def physical_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    for row in rows:
        physical = row.get("physical_inference")
        if isinstance(physical, dict):
            out.append({
                **physical,
                "mono_ms": row.get("mono_ms"),
                "source_operation": row.get("operation"),
            })
            continue

        if row.get("operation") == "physical_inference":
            out.append(row)

    return out


def summarize_model_call(
    call: int,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    call_rows = [row for row in rows if row.get("model_call") == call]
    physical = physical_rows(call_rows)

    client_progress = [
        row
        for row in call_rows
        if row.get("operation") == "provider_progress"
        and row.get("event") == "checkpoint"
    ]

    server_progress = [
        row
        for row in physical
        if row.get("server_progress_observed") is True
        or row.get("operation") == "physical_inference"
    ]

    strategies = sorted({
        value
        for row in physical
        for value in [row.get("correlation_strategy")]
        if isinstance(value, str) and value
    })

    task_ids = sorted({
        value
        for row in physical
        for value in (row.get("physical_task_ids_seen") or [])
        if isinstance(value, int) and not isinstance(value, bool)
    })

    prompt_delta = max_number([
        row.get("global_prompt_tokens_delta")
        for row in physical
    ])
    predicted_delta = max_number([
        row.get("global_predicted_tokens_delta")
        for row in physical
    ])
    high_water = max_number([
        row.get("server_context_high_water_tokens")
        for row in physical
    ])

    request_scoped_samples = sum(
        1
        for row in physical
        if row.get("request_scoped_counter_progress") is True
    )

    multiple_tasks = any(
        row.get("multiple_physical_tasks_observed") is True
        for row in physical
    )

    last_server_progress = max_number([
        row.get("mono_ms")
        for row in server_progress
    ])
    end_mono = trace_end_mono(call_rows)

    last_server_progress_age = (
        round(end_mono - last_server_progress, 3)
        if end_mono is not None and last_server_progress is not None
        else None
    )

    client_visible = len(client_progress) > 0
    server_visible = len(server_progress) > 0

    observations: list[str] = []

    if server_visible and not client_visible:
        observations.append("client_server_visibility_gap")

    if multiple_tasks:
        observations.append("multiple_physical_tasks_observed")

    if (
        prompt_delta is not None
        and predicted_delta is not None
        and prompt_delta > 0
        and prompt_delta >= max(4.0 * predicted_delta, 256.0)
    ):
        observations.append("prompt_dominant_server_work")

    if (
        server_visible
        and request_scoped_samples == 0
    ):
        observations.append("server_progress_not_request_scoped")

    if not server_visible:
        observations.append("server_progress_unobserved")

    return {
        "model_call": call,
        "telemetry_authority": "observation_only",
        "stall_authority": False,
        "client_progress_observed": client_visible,
        "client_progress_checkpoints": len(client_progress),
        "server_progress_observed": server_visible,
        "server_progress_samples": len(server_progress),
        "last_server_progress_age_at_trace_end_ms": last_server_progress_age,
        "correlation_strategies": strategies,
        "request_scoped_progress_samples": request_scoped_samples,
        "physical_task_ids_seen": task_ids,
        "physical_task_cardinality_observed": len(task_ids),
        "multiple_physical_tasks_observed": multiple_tasks,
        "global_prompt_tokens_delta_max": prompt_delta,
        "global_predicted_tokens_delta_max": predicted_delta,
        "server_context_high_water_tokens_max": high_water,
        "observations": observations,
    }


def summarize_trace(trace_id: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    calls = sorted({
        call
        for row in rows
        for call in [integer(row.get("model_call"))]
        if call is not None
    })

    llama_process_samples = [
        row.get("llama_process")
        for row in rows
        if isinstance(row.get("llama_process"), dict)
    ]

    return {
        "trace_id": trace_id,
        "telemetry_authority": "observation_only",
        "stall_authority": False,
        "model_calls": [summarize_model_call(call, rows) for call in calls],
        "llama_process_samples": len(llama_process_samples),
        "llama_process_available_samples": sum(
            1 for item in llama_process_samples if item.get("available") is True
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("telemetry_jsonl")
    parser.add_argument("--out")
    args = parser.parse_args()

    path = Path(args.telemetry_jsonl)
    if not path.is_file():
        raise SystemExit(f"telemetry file missing: {path}")

    rows = load_rows(path)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in rows:
        trace_id = row.get("trace_id")
        if isinstance(trace_id, str) and trace_id:
            grouped[trace_id].append(row)

    result = {
        "protocol": PROTOCOL,
        "telemetry_authority": "observation_only",
        "stall_authority": False,
        "traces": [
            summarize_trace(trace_id, trace_rows)
            for trace_id, trace_rows in sorted(grouped.items())
        ],
    }

    payload = json.dumps(result, indent=2, sort_keys=True) + "\n"

    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()
