#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

from v228_e27_timeout_contract import (
    finalize_timeout_result,
    observe_harness_timeout,
    resolve_harness_timeout_contract,
    timeout_contract_result_fields,
)


PROTOCOL = "real-task-benchmark-v1"
MAX_CAPTURE_CHARS = 20_000


TIME_SEMANTICS_PROTOCOL = "time-semantics-v1"


def normalize_time_semantics(result: dict[str, Any]) -> dict[str, Any]:
    # Classification-only: grants no cancellation, scheduling, mutation,
    # verification, or backend-reuse authority.
    result.setdefault("time_semantics_protocol", TIME_SEMANTICS_PROTOCOL)
    result.setdefault(
        "governor_task_window_semantics",
        "admission_guardrail",
    )
    result.setdefault("product_task_sla_enforced", False)
    result.setdefault("product_task_sla_ms", None)
    result.setdefault("product_watchdog_mode", "observation_only")
    result.setdefault("production_hard_lease_promoted", False)
    result.setdefault("benchmark_deadline_authority", "benchmark_only")

    timed_out = result.get("cli_timed_out") is True
    result["benchmark_deadline_exceeded"] = timed_out

    if (
        timed_out
        and result.get("model_call_status") == "inflight_at_harness_timeout"
    ):
        # Observation ended while inference remained in flight. This does not
        # prove a product implementation bug, backend stall, successful
        # transport cancellation, or compute quiescence.
        result.update({
            "result": "SAFE_FAIL",
            "failure_class": "environment_bug",
            "failure_class_confidence": "unresolved",
            "reason": "benchmark_observation_timeout_model_inflight",
            "timeout_failure_class": "environment_bug",
            "timeout_failure_reason":
                "benchmark_observation_timeout_model_inflight",
            "product_failure_proven": False,
            "backend_liveness_status": "unresolved_model_inflight",
            "transport_cancel_proven": False,
            "compute_quiescence_proven": False,
        })

    return result


def run(
    argv: list[str],
    *,
    cwd: Path,
    timeout_s: int = 60,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    started = time.monotonic()

    try:
        cp = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=timeout_s,
            check=False,
        )
        return {
            "argv": argv,
            "rc": cp.returncode,
            "timed_out": False,
            "elapsed_s": round(time.monotonic() - started, 3),
            "stdout": cp.stdout[-MAX_CAPTURE_CHARS:],
            "stderr": cp.stderr[-MAX_CAPTURE_CHARS:],
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "argv": argv,
            "rc": 124,
            "timed_out": True,
            "elapsed_s": round(time.monotonic() - started, 3),
            "stdout": str(exc.stdout or "")[-MAX_CAPTURE_CHARS:],
            "stderr": str(exc.stderr or "")[-MAX_CAPTURE_CHARS:],
        }


def git(repo: Path, *args: str, timeout_s: int = 30) -> dict[str, Any]:
    return run(["git", *args], cwd=repo, timeout_s=timeout_s)


def require_clean_tracked(repo: Path) -> None:
    if git(repo, "diff", "--quiet")["rc"] != 0:
        raise RuntimeError(f"tracked working tree dirty: {repo}")

    if git(repo, "diff", "--cached", "--quiet")["rc"] != 0:
        raise RuntimeError(f"index dirty: {repo}")


def tracked_checkout_state(repo: Path) -> dict[str, str]:
    """Fingerprint tracked checkout state without requiring it to be clean."""

    head = git(repo, "rev-parse", "HEAD")
    status = git(
        repo,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=no",
    )
    unstaged = git(repo, "diff", "--binary", "--no-ext-diff")
    staged = git(repo, "diff", "--cached", "--binary", "--no-ext-diff")

    for name, result in (
        ("head", head),
        ("status", status),
        ("unstaged", unstaged),
        ("staged", staged),
    ):
        if result["rc"] != 0:
            raise RuntimeError(
                f"cannot snapshot base checkout {name}: {result['stderr']}"
            )

    def digest(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    return {
        "head": head["stdout"].strip(),
        "status_sha256": digest(status["stdout"]),
        "unstaged_diff_sha256": digest(unstaged["stdout"]),
        "staged_diff_sha256": digest(staged["stdout"]),
    }


def git_head(repo: Path) -> str:
    result = git(repo, "rev-parse", "HEAD")
    if result["rc"] != 0:
        raise RuntimeError(result["stderr"])
    return result["stdout"].strip()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def load_json_lines(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    if not path.is_file():
        return rows

    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                value = json.loads(line)
            except Exception:
                continue

            if isinstance(value, dict):
                rows.append(value)

    return rows


def tool_records(rows: list[dict[str, Any]], tool: str) -> list[dict[str, Any]]:
    out = []

    for row in rows:
        if row.get("type") != "tool_use":
            continue

        part = row.get("part")
        if not isinstance(part, dict):
            continue

        if part.get("tool") == tool:
            out.append(row)

    return out


def completed_tool_records(
    rows: list[dict[str, Any]],
    tool: str,
) -> list[dict[str, Any]]:
    # Terminal OpenCode tool completion is execution evidence.
    out = []
    for row in tool_records(rows, tool):
        part = row.get("part") or {}
        state = part.get("state") or {}
        if isinstance(state, dict) and state.get("status") == "completed":
            out.append(row)
    return out


def tool_metadata(row: dict[str, Any]) -> dict[str, Any]:
    part = row.get("part") or {}
    state = part.get("state") or {}
    outer = state.get("metadata") or {}
    inner = outer.get("metadata") or {}
    return inner if isinstance(inner, dict) else {}


def tool_output(row: dict[str, Any]) -> str:
    part = row.get("part") or {}
    state = part.get("state") or {}
    value = state.get("output")
    return value if isinstance(value, str) else ""


def session_id(row: dict[str, Any]) -> str | None:
    value = row.get("sessionID")

    if isinstance(value, str) and value:
        return value

    part = row.get("part") or {}
    value = part.get("sessionID")

    return value if isinstance(value, str) and value else None


def executor_trace_for_session(
    worktree: Path,
    sid: str | None,
) -> dict[str, Any] | None:
    if not sid:
        return None

    trace = worktree / ".opencode" / "executor-trace.jsonl"
    rows = load_json_lines(trace)

    matches = [
        row
        for row in rows
        if row.get("sessionID") == sid
    ]

    if not matches:
        return None

    ready = [
        row
        for row in matches
        if row.get("execution_state") == "done"
        and row.get("action") == "ready"
    ]

    if ready:
        return ready[-1]

    return matches[-1]


def candidate_patch_path(
    worktree: Path,
    patch_row: dict[str, Any],
    trace: dict[str, Any] | None,
) -> Path | None:
    if isinstance(trace, dict):
        value = trace.get("patch_path")

        if isinstance(value, str) and value:
            candidate = worktree / value
            if candidate.is_file():
                return candidate

    md = tool_metadata(patch_row)
    receipt = md.get("receipt_path")

    if isinstance(receipt, str) and receipt.endswith(".json"):
        candidate = worktree / (receipt[:-5] + ".diff")
        if candidate.is_file():
            return candidate

    return None


def copy_if_exists(src: Path, dst_dir: Path) -> None:
    if not src.is_file():
        return

    dst_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst_dir / src.name)


def preserve_agent_artifacts(worktree: Path, out: Path) -> None:
    dot = worktree / ".opencode"

    if not dot.exists():
        return

    for name in (
        "search-trace.jsonl",
        "executor-trace.jsonl",
        "cpu-agent-trace.jsonl",
        "telemetry-v1.jsonl",
        "koalik-stage-trace.jsonl",
    ):
        copy_if_exists(dot / name, out)

    for dirname in (
        "patches",
        "scout-handoffs",
        "edit-capsules",
    ):
        source = dot / dirname
        if not source.is_dir():
            continue

        shutil.copytree(
            source,
            out / dirname,
            dirs_exist_ok=True,
        )


def changed_stats(worktree: Path) -> tuple[int, int]:
    result = git(worktree, "diff", "--numstat")

    if result["rc"] != 0:
        return 0, 0

    files = 0
    lines = 0

    for row in result["stdout"].splitlines():
        parts = row.split("\t")

        if len(parts) < 3:
            continue

        files += 1

        try:
            add = int(parts[0])
        except ValueError:
            add = 0

        try:
            delete = int(parts[1])
        except ValueError:
            delete = 0

        lines += add + delete

    untracked = git(worktree, "ls-files", "--others", "--exclude-standard")
    if untracked["rc"] == 0:
        for raw in untracked["stdout"].splitlines():
            rel = raw.strip()
            if not rel:
                continue
            candidate = worktree / rel
            if not candidate.is_file():
                continue
            files += 1
            try:
                data = candidate.read_bytes()
                lines += data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)
            except OSError:
                pass

    return files, lines


def max_number(values: list[Any], default: int = 0) -> int:
    numbers = [
        value
        for value in values
        if isinstance(value, int) and not isinstance(value, bool)
    ]
    return max(numbers, default=default)


def extract_failure_reason(
    searches: list[dict[str, Any]],
    patches: list[dict[str, Any]],
    cli_timed_out: bool,
) -> str:
    if patches:
        output = tool_output(patches[-1])

        if "PATCH_STOP" in output:
            marker = "reason="
            pos = output.find(marker)

            if pos >= 0:
                return output[pos + len(marker):].split()[0]

            return "patch_stop"

    if searches:
        output = tool_output(searches[-1])

        if "SEARCH_STOP" in output:
            marker = "reason="
            pos = output.find(marker)
            if pos >= 0:
                return output[pos + len(marker):].split()[0]
            return "search_stop"

        if "SEARCH_NO_PROGRESS" in output:
            return "scout_no_progress"

        if "SEARCH_BLOCKED" in output:
            return "scout_blocked"

    if cli_timed_out:
        if searches:
            md = tool_metadata(searches[-1])

            if (
                md.get("scout_handoff_status") == "ready"
                and md.get("edit_capsule_mutation_ready") is True
                and md.get("execution_state") == "mutate"
                and md.get("next_action") == "execute_patch"
            ):
                return "post_handoff_timeout"

        return "cli_timeout_before_candidate"

    return "no_candidate"


def safe_fail_class(reason: str, *, searches: bool, timed_out: bool) -> str:
    if reason in {
        "mutation_capability_unavailable",
        "mutation_target_ambiguous",
        "scout_evidence_exhausted",
    }:
        return "architecture_bug"

    if not searches and timed_out:
        return "environment_bug"

    return "implementation_bug"



ADAPTIVE_GOVERNOR_WORK_PROTOCOL = "governor-work-v2"
ADAPTIVE_GOVERNOR_LEASE_GRACE_S = 30.0


def _read_governor_lease_records(
    trace_path: Path,
    offset: int,
) -> tuple[int, list[dict[str, Any]]]:
    if not trace_path.exists():
        return offset, []

    rows: list[dict[str, Any]] = []

    try:
        size = trace_path.stat().st_size
        if offset > size:
            offset = 0

        with trace_path.open("r", encoding="utf-8") as handle:
            handle.seek(offset)

            while True:
                line_start = handle.tell()
                line = handle.readline()

                if line == "":
                    return handle.tell(), rows

                if not line.endswith("\n"):
                    return line_start, rows

                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if (
                    isinstance(row, dict)
                    and row.get("kind") == "model_dispatch"
                    and row.get("governor_work_protocol")
                    == ADAPTIVE_GOVERNOR_WORK_PROTOCOL
                ):
                    rows.append(row)
    except OSError:
        return offset, []


KOALIK_STAGE_TELEMETRY_PROTOCOL = "koalik-stage-telemetry-v1"
KOALIK_HEARTBEAT_INTERVAL_S = 30.0

_koalik_stage_state: dict[str, dict[str, Any]] = {}


def _read_koalik_trace_records(
    trace_path: Path,
    offset: int,
) -> tuple[int, list[dict[str, Any]]]:
    if offset < 0:
        offset = 0

    try:
        size = trace_path.stat().st_size
    except OSError:
        return offset, []

    # Worktree traces normally append only, but fail safely if
    # the file was truncated/replaced.
    if size < offset:
        offset = 0

    if size == offset:
        return offset, []

    try:
        with trace_path.open("rb") as fh:
            fh.seek(offset)
            chunk = fh.read()
    except OSError:
        return offset, []

    if not chunk:
        return offset, []

    # Never consume an incomplete JSONL record.
    last_newline = chunk.rfind(b"\n")

    if last_newline < 0:
        return offset, []

    complete = chunk[:last_newline + 1]
    new_offset = offset + last_newline + 1

    rows: list[dict[str, Any]] = []

    for raw in complete.splitlines():
        if not raw:
            continue

        try:
            value = json.loads(
                raw.decode(
                    "utf-8",
                    errors="replace",
                )
            )
        except Exception:
            continue

        if isinstance(value, dict):
            rows.append(value)

    return new_offset, rows


def _koalik_poll_trace(
    trace_path: Path,
    offset: int,
) -> tuple[int, list[dict[str, Any]]]:
    new_offset, rows = _read_koalik_trace_records(
        trace_path,
        offset,
    )

    _koalik_observe_trace(
        trace_path,
        rows,
    )

    return new_offset, rows


def _koalik_stage_from_trace(
    rows: list[dict[str, Any]],
    current: str,
) -> str:
    stage = current

    for row in rows:
        if not isinstance(row, dict):
            continue

        kind = row.get("kind")

        if kind in {
            "fatal_safe_fail_requested",
            "fatal_safe_fail",
        }:
            stage = "SAFE_FAIL"
            continue

        if kind != "model_dispatch":
            continue

        execution_state = row.get("execution_state")
        next_action = row.get("next_action")

        if (
            execution_state == "locate"
            or next_action == "search"
        ):
            stage = "LOCATE_INFERENCE"
            continue

        if execution_state == "repair":
            stage = "REPAIR_INFERENCE"
            continue

        if (
            execution_state == "mutate"
            or next_action
            in {
                "execute_patch",
                "execute_additive_plan",
                "execute_replace_node",
                "execute_rename_symbol",
            }
        ):
            stage = "MUTATION_INFERENCE"
            continue

        stage = "MODEL_INFERENCE"

    return stage


def _koalik_emit_stage_event(
    trace_path: Path,
    *,
    kind: str,
    stage: str,
    previous_stage: str | None,
    started: float,
    stage_started: float,
    trace_events: int,
) -> None:
    now = time.monotonic()

    payload = {
        "protocol": KOALIK_STAGE_TELEMETRY_PROTOCOL,
        "kind": kind,
        "stage": stage,
        "previous_stage": previous_stage,
        "elapsed_s": round(now - started, 3),
        "stage_elapsed_s": round(now - stage_started, 3),
        "trace_events": trace_events,
    }

    try:
        telemetry_path = trace_path.with_name(
            "koalik-stage-trace.jsonl"
        )
        with telemetry_path.open(
            "a",
            encoding="utf-8",
        ) as fh:
            fh.write(
                json.dumps(
                    payload,
                    sort_keys=True,
                    ensure_ascii=False,
                )
                + "\n"
            )
    except OSError:
        # Telemetry is observation-only and must never alter
        # benchmark/product result semantics.
        pass

    try:
        if kind == "transition":
            print(
                "KOALIK ПЕРЕХОД"
                f" {previous_stage}->{stage}"
                f" elapsed={payload['elapsed_s']}s"
                f" trace_events={trace_events}",
                flush=True,
            )
        else:
            print(
                "KOALIK HEARTBEAT"
                f" stage={stage}"
                f" elapsed={payload['elapsed_s']}s"
                f" stage_elapsed={payload['stage_elapsed_s']}s"
                f" trace_events={trace_events}",
                flush=True,
            )
    except (BrokenPipeError, OSError):
        pass


def _koalik_observe_trace(
    trace_path: Path,
    rows: list[dict[str, Any]],
) -> None:
    key = str(trace_path.resolve())
    now = time.monotonic()

    state = _koalik_stage_state.get(key)

    if state is None:
        state = {
            "stage": "STARTUP",
            "started": now,
            "stage_started": now,
            "next_heartbeat":
                now + KOALIK_HEARTBEAT_INTERVAL_S,
            "trace_events": 0,
        }
        _koalik_stage_state[key] = state

    state["trace_events"] += len(rows)

    previous = str(state["stage"])
    observed = _koalik_stage_from_trace(
        rows,
        previous,
    )

    if observed != previous:
        state["stage"] = observed
        state["stage_started"] = now
        state["next_heartbeat"] = (
            now + KOALIK_HEARTBEAT_INTERVAL_S
        )

        _koalik_emit_stage_event(
            trace_path,
            kind="transition",
            stage=observed,
            previous_stage=previous,
            started=float(state["started"]),
            stage_started=float(state["stage_started"]),
            trace_events=int(state["trace_events"]),
        )
        return

    if now >= float(state["next_heartbeat"]):
        _koalik_emit_stage_event(
            trace_path,
            kind="heartbeat",
            stage=observed,
            previous_stage=None,
            started=float(state["started"]),
            stage_started=float(state["stage_started"]),
            trace_events=int(state["trace_events"]),
        )

        state["next_heartbeat"] = (
            now + KOALIK_HEARTBEAT_INTERVAL_S
        )



def _terminate_process_group(proc: subprocess.Popen[Any]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        proc.terminate()

    try:
        proc.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()

    proc.wait()


def _wait_with_governor_leases(
    proc: subprocess.Popen[Any],
    worktree: Path,
    started_monotonic: float,
    started_epoch_ms: int,
    initial_timeout_s: float,
) -> dict[str, Any]:
    trace_path = worktree / ".opencode" / "cpu-agent-trace.jsonl"
    deadline = started_monotonic + initial_timeout_s
    offset = 0
    seen: set[tuple[Any, Any]] = set()
    telemetry_offset = 0
    leases_seen = 0
    extensions = 0
    max_lease_ms = 0
    last_source = None

    while True:
        rc = proc.poll()
        if rc is not None:
            return {
                "rc": rc,
                "timed_out": False,
                "adaptive_lease_seen": leases_seen > 0,
                "adaptive_lease_records": leases_seen,
                "adaptive_lease_extensions": extensions,
                "adaptive_max_lease_ms": max_lease_ms,
                "adaptive_last_lease_source": last_source,
                "effective_timeout_s": max(
                    initial_timeout_s,
                    deadline - started_monotonic,
                ),
            }

        offset, rows = _read_governor_lease_records(trace_path, offset)
        telemetry_offset, _ = _koalik_poll_trace(
            trace_path,
            telemetry_offset,
        )

        for row in rows:
            key = (row.get("ts"), row.get("model_call"))
            if key in seen:
                continue
            seen.add(key)

            lease_ms = row.get("governor_inference_lease_ms")
            dispatch_ts_ms = row.get("ts")

            if (
                not isinstance(lease_ms, (int, float))
                or isinstance(lease_ms, bool)
                or lease_ms <= 0
                or not isinstance(dispatch_ts_ms, (int, float))
                or isinstance(dispatch_ts_ms, bool)
            ):
                continue

            leases_seen += 1
            max_lease_ms = max(max_lease_ms, int(lease_ms))
            last_source = row.get("governor_inference_lease_source")

            dispatch_offset_s = max(
                0.0,
                (float(dispatch_ts_ms) - started_epoch_ms) / 1000.0,
            )
            candidate = (
                started_monotonic
                + dispatch_offset_s
                + float(lease_ms) / 1000.0
                + ADAPTIVE_GOVERNOR_LEASE_GRACE_S
            )

            if candidate > deadline:
                deadline = candidate
                extensions += 1

        now = time.monotonic()
        if now >= deadline:
            _terminate_process_group(proc)
            return {
                "rc": 124,
                "timed_out": True,
                "adaptive_lease_seen": leases_seen > 0,
                "adaptive_lease_records": leases_seen,
                "adaptive_lease_extensions": extensions,
                "adaptive_max_lease_ms": max_lease_ms,
                "adaptive_last_lease_source": last_source,
                "effective_timeout_s": max(
                    initial_timeout_s,
                    deadline - started_monotonic,
                ),
            }

        time.sleep(min(0.25, max(0.01, deadline - now)))


def run_agent(
    opencode: Path,
    worktree: Path,
    prompt: str,
    timeout_s: int,
    stdout_path: Path,
    stderr_path: Path,
) -> dict[str, Any]:
    # Benchmark authority is the immutable fixture task itself.
    # Runtime/tool controls must not contaminate Task-derived IR.
    full_prompt = prompt

    started = time.monotonic()
    started_at_ms = time.time_ns() // 1_000_000

    with stdout_path.open("w", encoding="utf-8") as stdout, \
         stderr_path.open("w", encoding="utf-8") as stderr:

        child_env = os.environ.copy()
        # OpenCode/session root discovery may consult PWD in addition to the
        # process cwd. Popen(cwd=...) does not rewrite inherited PWD.
        # Pin both so the agent cannot accidentally bind to the harness repo.
        child_env["PWD"] = str(worktree.resolve())

        proc = subprocess.Popen(
            [
                str(opencode),
                "run",
                "--format",
                "json",
                full_prompt,
            ],
            cwd=worktree,
            env=child_env,
            stdout=stdout,
            stderr=stderr,
            text=True,
            start_new_session=True,
        )

        wait_result = _wait_with_governor_leases(
            proc,
            worktree,
            started,
            started_at_ms,
            float(timeout_s),
        )
        rc = int(wait_result["rc"])
        timed_out = bool(wait_result["timed_out"])

    ended_at_ms = time.time_ns() // 1_000_000

    return {
        "rc": rc,
        "timed_out": timed_out,
        "elapsed_s": round(time.monotonic() - started, 3),
        "started_at_ms": started_at_ms,
        "ended_at_ms": ended_at_ms,
        "adaptive_lease_seen":
            bool(wait_result.get("adaptive_lease_seen")),
        "adaptive_lease_records":
            int(wait_result.get("adaptive_lease_records", 0)),
        "adaptive_lease_extensions":
            int(wait_result.get("adaptive_lease_extensions", 0)),
        "adaptive_max_lease_ms":
            int(wait_result.get("adaptive_max_lease_ms", 0)),
        "adaptive_last_lease_source":
            wait_result.get("adaptive_last_lease_source"),
        "effective_timeout_s":
            round(float(wait_result.get("effective_timeout_s", timeout_s)), 3),
    }


def check_budget(
    result: dict[str, Any],
    defaults: dict[str, Any],
    task: dict[str, Any],
) -> str | None:
    def limit(name: str) -> int | None:
        value = task.get(name, defaults.get(name))
        return value if isinstance(value, int) else None

    checks = (
        ("model_calls", "max_model_calls"),
        ("patch_attempts", "max_patch_attempts"),
        ("changed_files", "max_changed_files"),
        ("changed_lines", "max_changed_lines"),
    )

    for metric, config_key in checks:
        cap = limit(config_key)

        if cap is None:
            continue

        value = result.get(metric)

        if isinstance(value, int) and value > cap:
            return f"{metric}_budget_exceeded:{value}>{cap}"

    return None


def execute_checks(
    worktree: Path,
    checks: list[dict[str, Any]],
    default_timeout: int,
    artifact_dir: Path,
) -> tuple[bool, list[dict[str, Any]]]:
    results = []

    for index, check in enumerate(checks, 1):
        argv = check.get("argv")

        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(x, str) and x for x in argv)
        ):
            results.append({
                "index": index,
                "ok": False,
                "reason": "invalid_check_argv",
            })
            return False, results

        timeout_s = check.get("timeout_s", default_timeout)
        timeout_s = timeout_s if isinstance(timeout_s, int) else default_timeout

        cwd_value = check.get("cwd", ".")
        cwd = (worktree / cwd_value).resolve()

        try:
            cwd.relative_to(worktree.resolve())
        except ValueError:
            results.append({
                "index": index,
                "ok": False,
                "reason": "check_cwd_outside_worktree",
            })
            return False, results

        executed = run(
            argv,
            cwd=cwd,
            timeout_s=timeout_s,
        )

        record = {
            "index": index,
            "argv": argv,
            "cwd": str(cwd.relative_to(worktree)),
            "rc": executed["rc"],
            "timed_out": executed["timed_out"],
            "elapsed_s": executed["elapsed_s"],
        }

        results.append(record)

        (artifact_dir / f"check-{index}.stdout").write_text(
            executed["stdout"],
            encoding="utf-8",
        )
        (artifact_dir / f"check-{index}.stderr").write_text(
            executed["stderr"],
            encoding="utf-8",
        )

        if executed["rc"] != 0:
            return False, results

    return True, results


def run_task(
    task: dict[str, Any],
    defaults: dict[str, Any],
    opencode: Path,
    result_root: Path,
    keep_worktree: bool,
) -> dict[str, Any]:
    task_id = task["id"]
    repo = Path(os.path.expanduser(task["repo"])).resolve()
    prompt = task["prompt"]

    artifact_dir = result_root / task_id
    artifact_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {
        "protocol": PROTOCOL,
        "task_id": task_id,
        "repo": str(repo),
        "result": "HARNESS_FAIL",
        "failure_class": None,
        "reason": None,
    }

    worktree: Path | None = None
    agent: dict[str, Any] = {}
    timeout_observation: dict[str, Any] = {}

    try:
        if not (repo / ".git").exists():
            # Also supports repositories where .git is a file only in worktrees,
            # but the benchmark source itself should normally be a main checkout.
            probe = git(repo, "rev-parse", "--git-dir")
            if probe["rc"] != 0:
                raise RuntimeError(f"not a git repository: {repo}")

        base_state_before = tracked_checkout_state(repo)
        base_head_before = base_state_before["head"]
        base_ref = task.get("base_ref", "HEAD")

        temp_parent = Path(
            tempfile.mkdtemp(prefix=f"opencode-v217-{task_id}-")
        )
        temp_parent.rmdir()
        worktree = temp_parent

        add = git(
            repo,
            "worktree",
            "add",
            "--detach",
            str(worktree),
            str(base_ref),
            timeout_s=60,
        )

        if add["rc"] != 0:
            raise RuntimeError(
                f"git worktree add failed: {add['stderr']}"
            )

        setup_results = []

        for index, setup in enumerate(task.get("setup", []), 1):
            argv = setup.get("argv")
            if not isinstance(argv, list) or not argv:
                raise RuntimeError(f"invalid setup command #{index}")

            setup_timeout = setup.get(
                "timeout_s",
                defaults.get("setup_timeout_s", 120),
            )

            executed = run(
                argv,
                cwd=worktree,
                timeout_s=setup_timeout,
            )

            setup_results.append({
                "index": index,
                "argv": argv,
                "rc": executed["rc"],
                "timed_out": executed["timed_out"],
                "elapsed_s": executed["elapsed_s"],
            })

            (artifact_dir / f"setup-{index}.stdout").write_text(
                executed["stdout"],
                encoding="utf-8",
            )
            (artifact_dir / f"setup-{index}.stderr").write_text(
                executed["stderr"],
                encoding="utf-8",
            )

            if executed["rc"] != 0:
                result.update({
                    "result": "HARNESS_FAIL",
                    "failure_class": "environment_bug",
                    "reason": f"setup_failed:{index}",
                    "setup": setup_results,
                })
                return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        require_clean_tracked(worktree)

        stdout_path = artifact_dir / "agent.stdout.jsonl"
        stderr_path = artifact_dir / "agent.stderr"

        requested_timeout_s = task.get(
            "timeout_s",
            defaults.get("timeout_s", 180),
        )
        timeout_contract = resolve_harness_timeout_contract(
            task=task,
            defaults=defaults,
            requested_timeout_s=requested_timeout_s,
        )
        timeout_s = timeout_contract["effective_timeout_s"]
        result.update(timeout_contract_result_fields(timeout_contract))

        agent = run_agent(
            opencode,
            worktree,
            prompt,
            timeout_s,
            stdout_path,
            stderr_path,
        )

        print(
            "KOALIK ЭТАП stage=POST_AGENT_ANALYSIS"
            f" elapsed={agent.get('elapsed_s')}s",
            flush=True,
        )

        rows = load_json_lines(stdout_path)
        search_proposals = tool_records(rows, "search")
        searches = completed_tool_records(rows, "search")
        mutation_tools = (
            "execute_patch",
            "execute_replace_node",
            "execute_rename_symbol",
            "execute_additive_plan",
        )
        mutation_tool_proposals = [
            row
            for tool_name in mutation_tools
            for row in tool_records(rows, tool_name)
        ]
        patches = [
            row
            for tool_name in mutation_tools
            for row in completed_tool_records(rows, tool_name)
        ]
        patches.sort(
            key=lambda row: rows.index(row)
            if row in rows
            else len(rows)
        )

        cpu_trace_rows = load_json_lines(
            worktree / ".opencode" / "cpu-agent-trace.jsonl"
        )
        timeout_observation = observe_harness_timeout(
            contract=timeout_contract,
            cpu_trace_rows=cpu_trace_rows,
            agent=agent,
        )
        result.update(timeout_observation)
        if (
            timeout_observation.get("governor_budget_contract_status")
            == "drift"
        ):
            result.update({
                "result": "HARNESS_FAIL",
                "failure_class": "benchmark_bug",
                "reason": "governor_budget_contract_drift",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)
        dispatch_calls = [
            row.get("model_call")
            for row in cpu_trace_rows
            if row.get("kind") == "model_dispatch"
        ]
        model_calls = max_number(
            dispatch_calls,
            max_number(
                [
                    tool_metadata(row).get("turn_model_calls")
                    for row in searches + patches
                ],
                0,
            ),
        )
        model_dispatches = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "model_dispatch"
        )

        files_considered = max_number(
            [
                tool_metadata(row).get("candidate_files")
                for row in searches
            ],
            0,
        )

        result.update({
            "base_head": base_head_before,
            "cli_rc": agent["rc"],
            "cli_timed_out": agent["timed_out"],
            "wall_s": agent["elapsed_s"],
            "cli_started_at_ms": agent["started_at_ms"],
            "cli_ended_at_ms": agent["ended_at_ms"],
            "harness_adaptive_lease_seen":
                agent.get("adaptive_lease_seen", False),
            "harness_adaptive_lease_records":
                agent.get("adaptive_lease_records", 0),
            "harness_adaptive_lease_extensions":
                agent.get("adaptive_lease_extensions", 0),
            "harness_adaptive_max_lease_ms":
                agent.get("adaptive_max_lease_ms", 0),
            "harness_adaptive_last_lease_source":
                agent.get("adaptive_last_lease_source"),
            "harness_adaptive_effective_timeout_s":
                agent.get("effective_timeout_s"),
            "model_calls": model_calls,
            "model_dispatches": model_dispatches,
            "search_calls": len(searches),
            "search_proposals": len(search_proposals),
            "execute_patch_calls": len(patches),
            "mutation_calls": len(patches),
            "mutation_tool_proposals": len(mutation_tool_proposals),
            "execute_additive_plan_calls": len(
                completed_tool_records(rows, "execute_additive_plan")
            ),
            "execute_additive_plan_proposals": len(
                tool_records(rows, "execute_additive_plan")
            ),
            "files_considered": files_considered,
            "setup": setup_results,
        })

        # Root identity is a benchmark precondition, not a product-quality
        # signal. Never classify a run against the wrong repository as
        # SAFE_FAIL or FALSE_VERIFIED.
        if searches:
            expected_root = str(worktree.resolve())

            declared_roots = []

            for search_row in searches:
                value = tool_metadata(search_row).get("project_root")

                if not isinstance(value, str) or not value:
                    continue

                try:
                    declared_roots.append(str(Path(value).resolve()))
                except Exception:
                    continue

            result["expected_project_root"] = expected_root
            result["observed_project_roots"] = declared_roots
            result["observed_project_root"] = (
                declared_roots[-1]
                if declared_roots
                else None
            )

            if not declared_roots:
                result.update({
                    "result": "HARNESS_FAIL",
                    "failure_class": "telemetry_bug",
                    "reason": "project_root_unattested",
                })
                return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

            if any(root != expected_root for root in declared_roots):
                result.update({
                    "result": "HARNESS_FAIL",
                    "failure_class": "environment_bug",
                    "reason": "project_root_mismatch",
                })
                return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        if not patches:
            failure_reason = extract_failure_reason(
                searches,
                patches,
                agent["timed_out"],
            )
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": safe_fail_class(
                    failure_reason,
                    searches=bool(searches),
                    timed_out=agent["timed_out"],
                ),
                "reason": failure_reason,
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        patch_row = patches[-1]
        patch_output = tool_output(patch_row)
        sid = session_id(patch_row)
        trace = executor_trace_for_session(worktree, sid)

        result["session_id"] = sid

        if trace:
            result.update({
                "execution_state": trace.get("execution_state"),
                "execution_reason": trace.get("execution_reason"),
                "patch_attempts": trace.get("patch_attempt", 0),
                "repair_attempts": max(
                    0,
                    int(trace.get("patch_attempt", 0) or 0) - 1,
                ),
                "proof_disposition": trace.get("proof_disposition"),
                "repo_mutated": trace.get("repo_mutated"),
                "invariants_total": trace.get("invariants_total"),
                "invariants_passed": trace.get("invariants_passed"),
                "runtime_stack_status": trace.get("runtime_stack_status"),
                "runtime_manifest_sha256": trace.get(
                    "runtime_manifest_sha256"
                ),
            })
        else:
            result.update({
                "patch_attempts": len(patches),
                "repair_attempts": max(0, len(patches) - 1),
            })

        if "PATCH_READY" not in patch_output:
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": "implementation_bug",
                "reason": extract_failure_reason(
                    searches,
                    patches,
                    agent["timed_out"],
                ),
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        if trace and trace.get("proof_disposition") != "pass":
            result.update({
                "result": "FALSE_VERIFIED",
                "failure_class": "architecture_bug",
                "reason": "patch_ready_without_passing_proofs",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        patch_path = candidate_patch_path(
            worktree,
            patch_row,
            trace,
        )

        if patch_path is None:
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": "telemetry_bug",
                "reason": "candidate_patch_unavailable",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        candidate_copy = artifact_dir / "candidate.diff"
        shutil.copy2(patch_path, candidate_copy)

        result["candidate_sha256"] = sha256_file(candidate_copy)

        replay_check = git(
            worktree,
            "apply",
            "--check",
            str(candidate_copy),
        )

        if replay_check["rc"] != 0:
            result.update({
                "result": "FALSE_VERIFIED",
                "failure_class": "implementation_bug",
                "reason": "candidate_not_replayable",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        replay = git(
            worktree,
            "apply",
            str(candidate_copy),
        )

        if replay["rc"] != 0:
            result.update({
                "result": "FALSE_VERIFIED",
                "failure_class": "implementation_bug",
                "reason": "candidate_apply_failed",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        diff_check = git(worktree, "diff", "--check")

        if diff_check["rc"] != 0:
            result.update({
                "result": "FALSE_VERIFIED",
                "failure_class": "implementation_bug",
                "reason": "candidate_diff_check_failed",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        changed_files, changed_lines = changed_stats(worktree)

        result["changed_files"] = changed_files
        result["changed_lines"] = changed_lines

        budget_reason = check_budget(result, defaults, task)

        if budget_reason:
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": "architecture_bug",
                "reason": budget_reason,
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        checks = task.get("checks")

        if not isinstance(checks, list) or not checks:
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": "benchmark_bug",
                "reason": "no_acceptance_checks",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        print(
            "KOALIK ЭТАП stage=ACCEPTANCE_VERIFY",
            flush=True,
        )

        checks_ok, check_results = execute_checks(
            worktree,
            checks,
            defaults.get("check_timeout_s", 120),
            artifact_dir,
        )

        result["checks"] = check_results

        if not checks_ok:
            result.update({
                "result": "FALSE_VERIFIED",
                "failure_class": "architecture_bug",
                "reason": "task_acceptance_failed",
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        # The original repository may already be dirty. The invariant is
        # transactional: the agent must leave its tracked state exactly as it
        # found it.
        base_state_after = tracked_checkout_state(repo)

        if base_state_after != base_state_before:
            result.update({
                "result": "FALSE_VERIFIED",
                "failure_class": "architecture_bug",
                "reason": "base_checkout_changed",
                "base_state_before": base_state_before,
                "base_state_after": base_state_after,
            })
            return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

        result.update({
            "result": "VERIFIED",
            "failure_class": None,
            "reason": None,
        })

        return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

    except Exception as exc:
        result.update({
            "result": "HARNESS_FAIL",
            "failure_class": "benchmark_bug",
            "reason": str(exc),
        })
        return finalize_timeout_result(result=result, agent_timed_out=(agent.get("timed_out") is True), timeout_observation=timeout_observation)

    finally:
        normalize_time_semantics(result)

        if worktree is not None and worktree.exists():
            preserve_agent_artifacts(worktree, artifact_dir)

        if worktree is not None and not keep_worktree:
            git(
                repo,
                "worktree",
                "remove",
                "--force",
                str(worktree),
                timeout_s=60,
            )

            if worktree.exists():
                shutil.rmtree(worktree, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("tasks")
    parser.add_argument(
        "--out",
        default="benchmarks/results/v2.17-real-task-v1",
    )
    parser.add_argument(
        "--opencode",
        default=os.path.expanduser("~/.opencode/bin/opencode2"),
    )
    parser.add_argument(
        "--keep-worktrees",
        action="store_true",
    )
    args = parser.parse_args()

    tasks_path = Path(args.tasks).resolve()
    config = json.loads(tasks_path.read_text(encoding="utf-8"))

    if config.get("protocol") != PROTOCOL:
        raise SystemExit(
            f"expected protocol={PROTOCOL}"
        )

    tasks = [
        task
        for task in config.get("tasks", [])
        if task.get("enabled", True)
    ]

    if not tasks:
        raise SystemExit("no enabled tasks")

    defaults = config.get("defaults", {})
    result_root = Path(args.out).resolve()
    result_root.mkdir(parents=True, exist_ok=True)

    opencode = Path(args.opencode).resolve()

    if not opencode.is_file():
        raise SystemExit(f"opencode not found: {opencode}")

    results = []

    for task in tasks:
        task_id = task.get("id", "<missing>")
        print(f"=== TASK {task_id} ===", flush=True)

        if (
            not isinstance(task.get("id"), str)
            or not isinstance(task.get("repo"), str)
            or not isinstance(task.get("prompt"), str)
        ):
            row = {
                "protocol": PROTOCOL,
                "task_id": task_id,
                "result": "HARNESS_FAIL",
                "failure_class": "benchmark_bug",
                "reason": "task requires id/repo/prompt strings",
            }
        else:
            row = run_task(
                task,
                defaults,
                opencode,
                result_root,
                args.keep_worktrees,
            )

        results.append(row)

        print(
            "KOALIK RESULT"
            f" task={row.get('task_id')}"
            f" result={row.get('result')}"
            f" reason={row.get('reason')}",
            flush=True,
        )

        print(
            "RESULT"
            f" task={row.get('task_id')}"
            f" result={row.get('result')}"
            f" reason={row.get('reason')}"
            f" model_calls={row.get('model_calls')}"
            f" search_calls={row.get('search_calls')}"
            f" patch_attempts={row.get('patch_attempts')}"
            f" wall_s={row.get('wall_s')}",
            flush=True,
        )

        task_dir = result_root / str(row.get("task_id"))
        task_dir.mkdir(parents=True, exist_ok=True)

        (task_dir / "result.json").write_text(
            json.dumps(row, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        # R3A-R2: deterministic post-run cost reduction. This is shadow
        # telemetry only; reducer failure must never change the task result.
        reducer = Path(__file__).with_name("runtime-cost-reducer-v2.mjs")
        reducer_stdout = task_dir / "runtime-cost-reducer.stdout"
        reducer_stderr = task_dir / "runtime-cost-reducer.stderr"

        try:
            reduced = subprocess.run(
                ["node", str(reducer), str(task_dir)],
                cwd=Path(__file__).resolve().parents[2],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                timeout=10,
                check=False,
            )
            reducer_stdout.write_text(
                reduced.stdout[-MAX_CAPTURE_CHARS:],
                encoding="utf-8",
            )
            reducer_stderr.write_text(
                reduced.stderr[-MAX_CAPTURE_CHARS:],
                encoding="utf-8",
            )
        except Exception as exc:
            reducer_stderr.write_text(
                f"runtime cost reducer unavailable: {exc}\n",
                encoding="utf-8",
            )

    counts = {
        name: sum(1 for row in results if row.get("result") == name)
        for name in (
            "VERIFIED",
            "SAFE_FAIL",
            "FALSE_VERIFIED",
            "HARNESS_FAIL",
        )
    }

    summary = {
        "protocol": PROTOCOL,
        "tasks": len(results),
        **{key.lower(): value for key, value in counts.items()},
        "false_verified_zero": counts["FALSE_VERIFIED"] == 0,
        "results": results,
    }

    (result_root / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print()
    print("=== SUMMARY ===")
    print(f"tasks={len(results)}")
    print(f"verified={counts['VERIFIED']}")
    print(f"safe_fail={counts['SAFE_FAIL']}")
    print(f"false_verified={counts['FALSE_VERIFIED']}")
    print(f"harness_fail={counts['HARNESS_FAIL']}")

    min_verified = config.get("min_verified", 0)

    # Safety is absolute.
    if counts["FALSE_VERIFIED"] > 0:
        print("VERDICT FAIL reason=false_verified")
        return 2

    # Harness failures are not product failures, but benchmark evidence
    # is incomplete and therefore cannot be called PASS.
    if counts["HARNESS_FAIL"] > 0:
        print("VERDICT INCONCLUSIVE reason=harness_failure")
        return 3

    if counts["VERIFIED"] < min_verified:
        print(
            "VERDICT FAIL "
            f"reason=min_verified actual={counts['VERIFIED']} "
            f"required={min_verified}"
        )
        return 1

    print("VERDICT PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
