#!/usr/bin/env python3
from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
from typing import Any


PROTOCOL = "inference-lifecycle-summary-v1"


def load_rows(path: Path) -> list[dict[str, Any]]:
    out = []

    with path.open(
        encoding="utf-8",
        errors="replace",
    ) as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except Exception:
                continue

            if isinstance(row, dict):
                out.append(row)

    return out


def number(value: Any) -> float | None:
    if (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
    ):
        return float(value)

    return None


def summarize_call(
    call: int,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    physical = []

    for row in rows:
        if row.get("model_call") != call:
            continue

        value = row.get(
            "physical_inference"
        )

        if isinstance(value, dict):
            physical.append(value)
        elif (
            row.get("operation") ==
            "physical_inference"
        ):
            physical.append(row)

    task_ids = sorted({
        value
        for row in physical
        for value in (
            row.get(
                "physical_task_ids_seen"
            ) or []
        )
        if isinstance(value, int)
        and not isinstance(value, bool)
    })

    phases: dict[str, int] = defaultdict(int)

    for row in physical:
        phase = row.get("phase")
        if isinstance(phase, str):
            phases[phase] += 1

    exact_prompt = sum(
        max(
            0,
            int(
                row.get(
                    "slot_prompt_processed_interval"
                ) or 0
            ),
        )
        for row in physical
    )

    exact_decode = sum(
        max(
            0,
            int(
                row.get(
                    "slot_decoded_interval"
                ) or 0
            ),
        )
        for row in physical
    )

    first_gap = next(
        (
            number(
                row.get(
                    "initial_slot_visibility_gap_ms"
                )
            )
            for row in physical
            if number(
                row.get(
                    "initial_slot_visibility_gap_ms"
                )
            ) is not None
        ),
        None,
    )

    lifecycle_rows = [
        row.get("inference_lifecycle")
        for row in rows
        if row.get("model_call") == call
        and isinstance(
            row.get("inference_lifecycle"),
            dict,
        )
    ]

    last_lifecycle = (
        lifecycle_rows[-1]
        if lifecycle_rows
        else None
    )

    return {
        "model_call": call,
        "physical_task_ids_seen":
            task_ids,
        "physical_task_cardinality_lower_bound":
            len(task_ids),
        "cardinality_claim":
            "observed_window_lower_bound",
        "initial_slot_visibility_gap_ms":
            first_gap,
        "exact_prompt_processed_delta_sum":
            exact_prompt,
        "exact_decode_delta_sum":
            exact_decode,
        "phase_samples":
            dict(sorted(phases.items())),
        "last_lifecycle":
            last_lifecycle,
        "stall_authority":
            False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "telemetry_jsonl"
    )
    parser.add_argument("--out")
    args = parser.parse_args()

    path = Path(
        args.telemetry_jsonl
    )

    if not path.is_file():
        raise SystemExit(
            f"telemetry file missing: {path}"
        )

    rows = load_rows(path)

    grouped: dict[
        str,
        list[dict[str, Any]],
    ] = defaultdict(list)

    for row in rows:
        trace_id = row.get("trace_id")
        if isinstance(trace_id, str):
            grouped[trace_id].append(row)

    result = {
        "protocol": PROTOCOL,
        "telemetry_authority":
            "observation_only",
        "lifecycle_authority":
            "resource_ownership_only",
        "stall_authority":
            False,
        "traces": [],
    }

    for trace_id, trace_rows in sorted(
        grouped.items()
    ):
        calls = sorted({
            row.get("model_call")
            for row in trace_rows
            if isinstance(
                row.get("model_call"),
                int,
            )
        })

        result["traces"].append({
            "trace_id":
                trace_id,
            "model_calls": [
                summarize_call(
                    call,
                    trace_rows,
                )
                for call in calls
            ],
        })

    payload = (
        json.dumps(
            result,
            indent=2,
            sort_keys=True,
        ) + "\n"
    )

    if args.out:
        Path(args.out).write_text(
            payload,
            encoding="utf-8",
        )
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()
