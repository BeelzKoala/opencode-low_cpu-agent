#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

PROTOCOL = "model-terminal-telemetry-v1"

def load_json_lines(path: Path) -> list[dict[str, Any]]:
    rows = []
    if not path.is_file():
        return rows
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                value = json.loads(line)
            except Exception:
                continue
            if isinstance(value, dict):
                rows.append(value)
    return rows

def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}

def tool_uses(rows: list[dict[str, Any]], tool: str) -> list[dict[str, Any]]:
    out = []
    for row in rows:
        if row.get("type") != "tool_use":
            continue
        part = row.get("part") or {}
        if part.get("tool") == tool:
            out.append(row)
    return out

def classify(task_dir: Path) -> dict[str, Any]:
    agent = load_json_lines(task_dir / "agent.stdout.jsonl")
    cpu = load_json_lines(task_dir / "cpu-agent-trace.jsonl")
    result = load_json(task_dir / "result.json")

    mutation_dispatches = [
        row
        for row in cpu
        if row.get("kind") == "model_dispatch"
        and row.get("execution_state") in {"mutate", "repair"}
    ]
    dispatch = mutation_dispatches[-1] if mutation_dispatches else None

    additive = tool_uses(agent, "execute_additive_plan")
    patch = tool_uses(agent, "execute_patch")

    step_starts = [
        row for row in agent
        if row.get("type") == "step_start"
    ]
    step_finishes = [
        row for row in agent
        if row.get("type") == "step_finish"
    ]

    status = "mutation_not_dispatched"
    evidence = "no mutate/repair model_dispatch observed"

    if dispatch is not None:
        dispatch_ts = dispatch.get("ts")
        later_starts = [
            row for row in step_starts
            if not isinstance(dispatch_ts, int)
            or not isinstance(row.get("timestamp"), int)
            or row.get("timestamp") >= dispatch_ts
        ]
        last_start = later_starts[-1] if later_starts else None
        start_ts = last_start.get("timestamp") if last_start else None
        later_finishes = [
            row for row in step_finishes
            if not isinstance(start_ts, int)
            or not isinstance(row.get("timestamp"), int)
            or row.get("timestamp") >= start_ts
        ]

        if additive or patch:
            status = "mutation_tool_executed"
            evidence = "mutation tool_use observed after mutation dispatch"
        elif later_finishes:
            finish = later_finishes[-1]
            part = finish.get("part") or {}
            status = "model_step_finished_without_mutation_tool"
            evidence = f"step_finish reason={part.get('reason')}"
        elif result:
            status = "cli_ended_without_model_terminal_event"
            evidence = (
                "benchmark result exists, mutation dispatch observed, "
                "but no later mutation tool_use or step_finish exists"
            )
        elif last_start is not None:
            status = "mutation_model_inflight_or_unobserved_terminal"
            evidence = "mutation step_start exists without later terminal event"
        else:
            status = "mutation_dispatched_without_step_event"
            evidence = "cpu model_dispatch exists without matching agent step event"

    row = {
        "protocol": PROTOCOL,
        "classification_authority": "observation_only",
        "status": status,
        "evidence": evidence,
        "mutation_dispatches": len(mutation_dispatches),
        "last_mutation_model_call": dispatch.get("model_call") if dispatch else None,
        "last_mutation_execution_state": dispatch.get("execution_state") if dispatch else None,
        "last_mutation_tool_names": (
            dispatch.get("tool_names")
            or dispatch.get("tool_frontier_names")
            or []
        ) if dispatch else [],
        "step_starts": len(step_starts),
        "step_finishes": len(step_finishes),
        "execute_additive_plan_calls": len(additive),
        "execute_patch_calls": len(patch),
        "benchmark_result_present": bool(result),
        "benchmark_result": result.get("result") if result else None,
        "benchmark_reason": result.get("reason") if result else None,
    }
    return row

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("task_dir")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    task_dir = Path(args.task_dir).resolve()
    row = classify(task_dir)

    print(json.dumps(row, indent=2, sort_keys=True))

    if args.json_out:
        out = Path(args.json_out).resolve()
        out.write_text(
            json.dumps(row, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
