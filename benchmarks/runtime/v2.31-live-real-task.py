#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
from typing import Any
from urllib.request import urlopen

PROTOCOL = "real-task-live-observability-v1.3"
DEFAULT_HEARTBEAT_S = 30.0
DEFAULT_STATUS_SAMPLE_S = 30.0
DEFAULT_PROCESS_POLL_S = 0.5
DEFAULT_METRICS_URL = "http://127.0.0.1:8080/metrics"

def load_json_lines(path: Path) -> list[dict[str, Any]]:
    rows = []
    if not path.is_file():
        return rows
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    value = json.loads(line)
                except Exception:
                    continue
                if isinstance(value, dict):
                    rows.append(value)
    except FileNotFoundError:
        pass
    return rows

def enabled_task_ids(config_path: Path) -> list[str]:
    value = json.loads(config_path.read_text(encoding="utf-8"))
    return [
        row["id"]
        for row in value.get("tasks", [])
        if row.get("enabled", True) is not False
        and isinstance(row.get("id"), str)
        and row["id"]
    ]

def extract_project_root(agent_rows: list[dict[str, Any]]) -> Path | None:
    for row in reversed(agent_rows):
        if row.get("type") != "tool_use":
            continue
        part = row.get("part") or {}
        if part.get("tool") != "search":
            continue
        state = part.get("state") or {}
        outer = state.get("metadata") or {}
        inner = outer.get("metadata") or {}
        value = inner.get("project_root")
        if isinstance(value, str) and value:
            return Path(value)
    return None

def last_dispatch(cpu_rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    rows = [r for r in cpu_rows if r.get("kind") == "model_dispatch"]
    return rows[-1] if rows else None

def tool_rows(rows: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    out = []
    for row in rows:
        if row.get("type") != "tool_use":
            continue
        part = row.get("part") or {}
        if part.get("tool") == name:
            out.append(row)
    return out

def fatal_agent_reason(rows: list[dict[str, Any]]) -> str | None:
    for row in reversed(rows):
        if row.get("type") != "tool_use":
            continue
        part = row.get("part") or {}
        state = part.get("state") or {}
        output = state.get("output")
        if not isinstance(output, str):
            continue
        for line in output.splitlines():
            if not line.startswith("PATCH_STOP "):
                continue
            for token in line.split():
                if token.startswith("reason="):
                    value = token.split("=", 1)[1].strip()
                    if value:
                        return value
    return None

def latest_event_ts(*groups: list[dict[str, Any]]) -> int | None:
    values = []
    for group in groups:
        for row in group:
            value = row.get("timestamp", row.get("ts"))
            if isinstance(value, int):
                values.append(value)
    return max(values) if values else None

def read_backend(metrics_url: str) -> dict[str, Any]:
    try:
        with urlopen(metrics_url, timeout=0.25) as response:
            body = response.read(256_000).decode("utf-8", errors="replace")
    except Exception as exc:
        return {
            "available": False,
            "processing": None,
            "deferred": None,
            "state": "unavailable",
            "error": type(exc).__name__,
        }

    values = {}
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        metric, raw = parts
        if metric not in {
            "llamacpp:requests_processing",
            "llamacpp:requests_deferred",
        }:
            continue
        try:
            values[metric] = float(raw)
        except ValueError:
            continue

    processing = values.get("llamacpp:requests_processing")
    deferred = values.get("llamacpp:requests_deferred")
    if processing is None and deferred is None:
        return {
            "available": False,
            "processing": None,
            "deferred": None,
            "state": "unavailable",
            "error": "metrics_missing",
        }

    busy = (processing or 0) > 0 or (deferred or 0) > 0
    return {
        "available": True,
        "processing": processing,
        "deferred": deferred,
        "state": "busy" if busy else "idle",
        "error": None,
    }

def derive_status(
    *,
    agent_rows: list[dict[str, Any]],
    cpu_rows: list[dict[str, Any]],
    executor_rows: list[dict[str, Any]],
    process_alive: bool,
    started_monotonic: float,
    backend: dict[str, Any],
) -> dict[str, Any]:
    elapsed = max(0.0, time.monotonic() - started_monotonic)
    searches = tool_rows(agent_rows, "search")
    additive = tool_rows(agent_rows, "execute_additive_plan")
    patches = tool_rows(agent_rows, "execute_patch")
    dispatch = last_dispatch(cpu_rows)
    fatal_reason = fatal_agent_reason(agent_rows)
    dispatch_state = dispatch.get("execution_state") if dispatch else None
    dispatch_reason = dispatch.get("execution_reason") if dispatch else None

    phase_num = 1
    phase = "LOCATE"
    detail = "waiting for first model/search event"
    model_call = None
    tool = None

    if searches:
        phase_num = 2
        phase = "SCOUT"
        detail = "search completed; compiling mutation frontier"

    if dispatch:
        model_call = dispatch.get("model_call")
        state = dispatch.get("execution_state")
        names = (
            dispatch.get("tool_names")
            or dispatch.get("tool_frontier_names")
            or []
        )
        if state in {"mutate", "repair"}:
            phase_num = 3
            phase = "MUTATE MODEL" if state == "mutate" else "REPAIR MODEL"
            tool = names[0] if isinstance(names, list) and len(names) == 1 else None
            detail = "bounded inference dispatched"

    if additive:
        phase_num = 4
        phase = "MATERIALIZE"
        tool = "execute_additive_plan"
        detail = "semantic mutation tool observed"

    if patches:
        phase_num = 5
        phase = "EXECUTE"
        tool = "execute_patch"
        detail = "patch execution tool observed"

    if executor_rows:
        latest = executor_rows[-1]
        proof = latest.get("proof_disposition")
        execution_state = latest.get("execution_state")
        if proof is not None:
            phase_num = 6
            phase = "VERIFY"
            detail = f"proof_disposition={proof}"
        elif execution_state:
            phase_num = max(phase_num, 5)
            phase = "EXECUTE"
            detail = f"execution_state={execution_state}"

    # Current terminal state has higher authority than historical tool events.
    # PATCH_STOP is emitted by the deterministic tool path and remains visible
    # even when S1 prevents a post-fatal model dispatch.
    if dispatch_state == "safe_fail" or fatal_reason:
        phase_num = 7
        phase = "SAFE_FAIL"
        reason = fatal_reason or dispatch_reason or "fatal"
        detail = f"reason={reason}"
        tool = None

    if not process_alive:
        phase_num = 7
        if phase != "SAFE_FAIL":
            phase = "TERMINAL"
            detail = "benchmark process exited"

    last_ts = latest_event_ts(agent_rows, cpu_rows, executor_rows)
    last_age_s = (
        elapsed
        if last_ts is None
        else max(0.0, time.time() - last_ts / 1000.0)
    )

    attention = None
    if (
        process_alive
        and phase_num == 3
        and backend.get("state") == "idle"
        and last_age_s >= 30
    ):
        attention = "backend_idle_after_mutation_dispatch"

    return {
        "protocol": PROTOCOL,
        "phase_num": phase_num,
        "phase": phase,
        "detail": detail,
        "elapsed_s": elapsed,
        "last_event_age_s": last_age_s,
        "model_call": model_call,
        "tool": tool,
        "process_alive": process_alive,
        "backend": backend,
        "attention": attention,
    }

def render(status: dict[str, Any]) -> str:
    elapsed = int(status["elapsed_s"])
    mm, ss = divmod(elapsed, 60)
    age = int(status["last_event_age_s"])
    spinner = "…" if status["process_alive"] else "✓"
    tool = f" tool={status['tool']}" if status.get("tool") else ""
    model = f" model#{status['model_call']}" if status.get("model_call") else ""
    backend = status.get("backend") or {}
    backend_text = f" backend={backend.get('state', 'unavailable')}"
    attention = (
        f" attention={status['attention']}"
        if status.get("attention")
        else ""
    )
    return (
        f"[{status['phase_num']}/7] {status['phase']:<12} {spinner} "
        f"{mm:02d}:{ss:02d}{model}{tool}{backend_text} "
        f"last_event={age}s{attention} | {status['detail']}"
    )

def parse_out(args: list[str]) -> Path:
    for index, arg in enumerate(args):
        if arg == "--out" and index + 1 < len(args):
            return Path(args[index + 1]).resolve()
        if arg.startswith("--out="):
            return Path(arg.split("=", 1)[1]).resolve()
    return Path("benchmarks/results/v2.17-real-task-v1").resolve()

def append_sample(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, sort_keys=True) + "\n")

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--heartbeat-seconds", type=float, default=DEFAULT_HEARTBEAT_S)
    parser.add_argument(
        "--status-sample-seconds",
        type=float,
        default=DEFAULT_STATUS_SAMPLE_S,
    )
    parser.add_argument(
        "--process-poll-seconds",
        type=float,
        default=DEFAULT_PROCESS_POLL_S,
    )
    parser.add_argument("--metrics-url", default=DEFAULT_METRICS_URL)
    parser.add_argument("--runner", default="benchmarks/runtime/v2.17-real-task.py")
    parser.add_argument("runner_args", nargs=argparse.REMAINDER)
    ns = parser.parse_args()

    forwarded = list(ns.runner_args)
    if forwarded and forwarded[0] == "--":
        forwarded = forwarded[1:]
    if not forwarded:
        raise SystemExit(
            "usage: v2.31-live-real-task.py [wrapper opts] -- "
            "<tasks.json> [v2.17 args]"
        )

    config = Path(forwarded[0]).resolve()
    task_ids = enabled_task_ids(config)
    if not task_ids:
        raise SystemExit("no enabled task ids")

    result_root = parse_out(forwarded)
    result_root.mkdir(parents=True, exist_ok=True)
    runner = Path(ns.runner).resolve()
    if not runner.is_file():
        raise SystemExit(f"runner not found: {runner}")

    current_task = task_ids[0]
    artifact = result_root / current_task
    lifecycle = artifact / "live-observability.jsonl"
    if lifecycle.exists():
        lifecycle.unlink()

    proc = subprocess.Popen(
        [sys.executable, str(runner), *forwarded],
        cwd=Path.cwd(),
    )

    started = time.monotonic()
    last_print = 0.0
    last_sample = 0.0
    last_signature = None
    tty = sys.stdout.isatty()

    try:
        while proc.poll() is None:
            now = time.monotonic()
            status_due = (
                last_sample == 0.0
                or now - last_sample >= max(
                    1.0,
                    ns.status_sample_seconds,
                )
            )

            if status_due:
                agent_rows = load_json_lines(
                    artifact / "agent.stdout.jsonl"
                )
                project_root = extract_project_root(agent_rows)
                cpu_rows = []
                executor_rows = []
                if project_root is not None:
                    cpu_rows = load_json_lines(
                        project_root
                        / ".opencode"
                        / "cpu-agent-trace.jsonl"
                    )
                    executor_rows = load_json_lines(
                        project_root
                        / ".opencode"
                        / "executor-trace.jsonl"
                    )

                backend = read_backend(ns.metrics_url)
                status = derive_status(
                    agent_rows=agent_rows,
                    cpu_rows=cpu_rows,
                    executor_rows=executor_rows,
                    process_alive=True,
                    started_monotonic=started,
                    backend=backend,
                )
                append_sample(
                    lifecycle,
                    {
                        **status,
                        "observed_at_ms": int(
                            time.time() * 1000
                        ),
                    },
                )
                last_sample = now

                signature = (
                    status["phase_num"],
                    status["phase"],
                    status.get("model_call"),
                    status.get("tool"),
                    backend.get("state"),
                    status.get("attention"),
                )
                if (
                    signature != last_signature
                    or now - last_print >= max(
                        1.0,
                        ns.heartbeat_seconds,
                    )
                ):
                    line = render(status)
                    if tty:
                        print(
                            "\r" + line[:220].ljust(220),
                            end="",
                            flush=True,
                        )
                    else:
                        print("LIVE " + line, flush=True)
                    last_signature = signature
                    last_print = now

            # Cheap process supervision remains responsive while trace and
            # llama.cpp status sampling stays at the low-frequency cadence.
            time.sleep(
                max(
                    0.1,
                    ns.process_poll_seconds,
                )
            )
    finally:
        rc = proc.wait()
        if tty:
            print()

    backend = read_backend(ns.metrics_url)
    terminal = derive_status(
        agent_rows=load_json_lines(artifact / "agent.stdout.jsonl"),
        cpu_rows=[],
        executor_rows=[],
        process_alive=False,
        started_monotonic=started,
        backend=backend,
    )
    append_sample(
        lifecycle,
        {
            **terminal,
            "observed_at_ms": int(time.time() * 1000),
        },
    )
    print("LIVE " + render(terminal), flush=True)
    return rc

if __name__ == "__main__":
    raise SystemExit(main())
