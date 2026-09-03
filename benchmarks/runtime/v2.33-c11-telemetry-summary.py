#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


PROTOCOL = "koalik-telemetry-summary-v1"


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    if not path.is_file():
        raise SystemExit(f"telemetry file missing: {path}")

    with path.open(
        encoding="utf-8",
        errors="replace",
    ) as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except Exception:
                continue

            if isinstance(value, dict):
                rows.append(value)

    return rows


def finite(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def summarize_trace(
    trace_id: str,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    ordered = sorted(
        rows,
        key=lambda row: (
            finite(row.get("mono_ms")) or 0.0,
            row.get("seq") or 0,
        ),
    )

    components: dict[str, dict[str, Any]] = {}

    for row in ordered:
        component = row.get("component")
        if not isinstance(component, str):
            continue

        mono = finite(row.get("mono_ms"))

        bucket = components.setdefault(
            component,
            {
                "events": 0,
                "first_mono_ms": None,
                "last_mono_ms": None,
            },
        )

        bucket["events"] += 1

        if mono is not None:
            if bucket["first_mono_ms"] is None:
                bucket["first_mono_ms"] = mono
            bucket["last_mono_ms"] = mono

    for bucket in components.values():
        first = finite(bucket.get("first_mono_ms"))
        last = finite(bucket.get("last_mono_ms"))

        bucket["observed_window_ms"] = (
            round(last - first, 3)
            if first is not None and last is not None
            else None
        )

    model_starts = [
        row
        for row in ordered
        if row.get("operation") == "model_call"
        and row.get("event") == "start"
    ]

    model_finishes = [
        row
        for row in ordered
        if row.get("operation") == "model_call"
        and row.get("event") == "finish"
    ]

    progress = [
        row
        for row in ordered
        if row.get("operation") == "provider_progress"
        and row.get("event") == "checkpoint"
    ]

    resource_rows = [
        row
        for row in ordered
        if row.get("operation") == "resource_sample"
    ]

    by_call: dict[int, dict[str, Any]] = {}

    for start in model_starts:
        call = start.get("model_call")
        if not isinstance(call, int):
            continue

        by_call[call] = {
            "model_call": call,
            "providerID": start.get("providerID"),
            "modelID": start.get("modelID"),
            "context_bytes": start.get("context_bytes"),
            "context_system_bytes": start.get("context_system_bytes"),
            "context_messages_bytes": start.get("context_messages_bytes"),
            "context_tools_bytes": start.get("context_tools_bytes"),
            "start_mono_ms": start.get("mono_ms"),
            "finished": False,
            "duration_ms": None,
            "time_to_first_progress_ms": None,
            "last_progress_age_ms": None,
            "output_delta_events": 0,
            "output_delta_bytes": 0,
            "tool_raw_bytes_max": 0,
            "tool_input_bytes_max": 0,
            "max_progress_gap_ms": 0,
            "output_tokens": None,
            "finish": None,
        }

    for row in progress:
        call = row.get("model_call")
        if call not in by_call:
            continue

        bucket = by_call[call]
        bucket["output_delta_events"] = max(
            bucket["output_delta_events"],
            int(row.get("output_delta_events") or 0),
        )
        bucket["output_delta_bytes"] = max(
            bucket["output_delta_bytes"],
            int(row.get("output_delta_bytes") or 0),
        )
        bucket["tool_raw_bytes_max"] = max(
            bucket["tool_raw_bytes_max"],
            int(row.get("tool_raw_bytes_max") or 0),
        )
        bucket["tool_input_bytes_max"] = max(
            bucket["tool_input_bytes_max"],
            int(row.get("tool_input_bytes_max") or 0),
        )
        bucket["max_progress_gap_ms"] = max(
            bucket["max_progress_gap_ms"],
            float(row.get("max_progress_gap_ms") or 0),
        )

        if bucket["time_to_first_progress_ms"] is None:
            bucket["time_to_first_progress_ms"] = (
                row.get("first_progress_ms")
            )

    for finish in model_finishes:
        call = finish.get("model_call")
        if call not in by_call:
            continue

        bucket = by_call[call]
        bucket["finished"] = True
        bucket["duration_ms"] = finish.get("duration_ms")
        bucket["time_to_first_progress_ms"] = (
            finish.get("time_to_first_progress_ms")
            if finish.get("time_to_first_progress_ms") is not None
            else bucket["time_to_first_progress_ms"]
        )
        bucket["last_progress_age_ms"] = (
            finish.get("last_progress_age_ms")
        )
        bucket["output_delta_events"] = max(
            bucket["output_delta_events"],
            int(finish.get("output_delta_events") or 0),
        )
        bucket["output_delta_bytes"] = max(
            bucket["output_delta_bytes"],
            int(finish.get("output_delta_bytes") or 0),
        )
        bucket["tool_raw_bytes_max"] = max(
            bucket["tool_raw_bytes_max"],
            int(finish.get("tool_raw_bytes_max") or 0),
        )
        bucket["tool_input_bytes_max"] = max(
            bucket["tool_input_bytes_max"],
            int(finish.get("tool_input_bytes_max") or 0),
        )
        bucket["max_progress_gap_ms"] = max(
            bucket["max_progress_gap_ms"],
            float(finish.get("max_progress_gap_ms") or 0),
        )
        bucket["output_tokens"] = finish.get("output_tokens")
        bucket["finish"] = finish.get("finish")

    last_mono = max(
        (
            finite(row.get("mono_ms")) or 0.0
            for row in ordered
        ),
        default=0.0,
    )

    for call, bucket in by_call.items():
        if bucket["finished"]:
            continue

        starts = finite(bucket.get("start_mono_ms"))
        matching = [
            row
            for row in progress
            if row.get("model_call") == call
        ]

        last_progress_mono = max(
            (
                finite(row.get("mono_ms")) or 0.0
                for row in matching
            ),
            default=0.0,
        )

        bucket["inflight_at_trace_end"] = True
        bucket["observed_inflight_ms"] = (
            round(last_mono - starts, 3)
            if starts is not None
            else None
        )
        bucket["last_progress_age_at_trace_end_ms"] = (
            round(last_mono - last_progress_mono, 3)
            if last_progress_mono > 0
            else None
        )

    llama_available_samples = sum(
        1
        for row in resource_rows
        if row.get("llama_metrics_available") is True
    )

    return {
        "protocol": PROTOCOL,
        "telemetry_authority": "observation_only",
        "trace_id": trace_id,
        "events": len(ordered),
        "components": components,
        "model_calls": [
            by_call[key]
            for key in sorted(by_call)
        ],
        "resource_samples": len(resource_rows),
        "llama_metrics_available_samples": llama_available_samples,
        "content_captured": any(
            row.get("content_captured") is True
            for row in ordered
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("telemetry_jsonl")
    parser.add_argument("--out")
    args = parser.parse_args()

    path = Path(args.telemetry_jsonl)
    rows = load_rows(path)

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in rows:
        trace_id = row.get("trace_id")
        if isinstance(trace_id, str) and trace_id:
            grouped[trace_id].append(row)

    summary = {
        "protocol": PROTOCOL,
        "telemetry_authority": "observation_only",
        "traces": [
            summarize_trace(trace_id, trace_rows)
            for trace_id, trace_rows in sorted(grouped.items())
        ],
    }

    payload = json.dumps(
        summary,
        indent=2,
        sort_keys=True,
    ) + "\n"

    if args.out:
        Path(args.out).write_text(
            payload,
            encoding="utf-8",
        )
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()
