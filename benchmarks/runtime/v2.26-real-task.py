#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any


PROTOCOL = "real-task-benchmark-v2"
MAX_CAPTURE_CHARS = 20_000


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
    for terminal_rows in (patches, searches):
        if not terminal_rows:
            continue

        output = tool_output(terminal_rows[-1])
        if "PATCH_STOP" in output:
            marker = "reason="
            pos = output.find(marker)
            if pos >= 0:
                return output[pos + len(marker):].split()[0]
            return "patch_stop"

    if searches:
        output = tool_output(searches[-1])

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
                and md.get("next_action") in {
                    "execute_patch",
                    "execute_replace_node",
                    "execute_rename_symbol",
                }
            ):
                return "post_handoff_timeout"

        return "cli_timeout_before_candidate"

    return "no_candidate"


def run_agent(
    opencode: Path,
    worktree: Path,
    prompt: str,
    timeout_s: int,
    stdout_path: Path,
    stderr_path: Path,
) -> dict[str, Any]:
    # Benchmark transport is identity: the product must observe exactly the
    # semantic developer task being scored. Tool confinement is enforced by
    # the runtime surface, not by contaminating user task text.
    full_prompt = prompt

    started = time.monotonic()

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

        timed_out = False

        try:
            rc = proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.terminate()

            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

            rc = 124

    return {
        "rc": rc,
        "timed_out": timed_out,
        "elapsed_s": round(time.monotonic() - started, 3),
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
                return result

        require_clean_tracked(worktree)

        stdout_path = artifact_dir / "agent.stdout.jsonl"
        stderr_path = artifact_dir / "agent.stderr"

        timeout_s = task.get(
            "timeout_s",
            defaults.get("timeout_s", 180),
        )

        agent = run_agent(
            opencode,
            worktree,
            prompt,
            timeout_s,
            stdout_path,
            stderr_path,
        )

        rows = load_json_lines(stdout_path)
        searches = tool_records(rows, "search")
        mutation_tools = {
            "execute_replace_node",
            "execute_rename_symbol",
        }
        replace_calls = tool_records(rows, "execute_replace_node")
        rename_calls = tool_records(rows, "execute_rename_symbol")
        patches = [
            row
            for row in rows
            if row.get("type") == "tool_use"
            and isinstance(row.get("part"), dict)
            and row["part"].get("tool") in mutation_tools
        ]
        terminal_patch_rows = [
            row
            for row in rows
            if row.get("type") == "tool_use"
            and any(
                marker in tool_output(row)
                for marker in (
                    "PATCH_READY",
                    "PATCH_STOP",
                    "PATCH_RETRY",
                    "PATCH_RESCOUT",
                )
            )
        ]
        driver_row = (
            terminal_patch_rows[-1]
            if terminal_patch_rows
            else patches[-1]
            if patches
            else searches[-1]
            if searches
            else None
        )
        driver_sid = session_id(driver_row) if driver_row else None
        trace = executor_trace_for_session(worktree, driver_sid)

        executor_trace_rows = load_json_lines(
            worktree / ".opencode" / "executor-trace.jsonl"
        )
        deterministic_commit_hashes = {
            row.get("action_commit_sha256")
            for row in executor_trace_rows
            if row.get("sessionID") == driver_sid
            and row.get("mutation_dispatch_origin")
                == "deterministic_action_commit"
            and isinstance(row.get("action_commit_sha256"), str)
            and len(row["action_commit_sha256"]) == 64
        }
        deterministic_dispatches = len(deterministic_commit_hashes)

        cpu_trace_rows = load_json_lines(
            worktree / ".opencode" / "cpu-agent-trace.jsonl"
        )
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
        terminal_commit_rows = [
            row
            for row in cpu_trace_rows
            if row.get("kind") == "terminal_commit"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        ]
        terminal_commit_hashes = {
            row.get("terminal_commit_sha256")
            for row in terminal_commit_rows
            if isinstance(row.get("terminal_commit_sha256"), str)
            and len(row["terminal_commit_sha256"]) == 64
        }
        terminal_commits = len(terminal_commit_hashes)
        terminal_short_circuit_requests = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "terminal_short_circuit_requested"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        )
        terminal_short_circuits = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "terminal_short_circuit"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        )
        terminal_short_circuit_failures = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "terminal_short_circuit_failed"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        )
        completion_safe_fail_commit_rows = [
            row
            for row in cpu_trace_rows
            if row.get("kind") == "completion_safe_fail_commit"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        ]
        completion_safe_fail_commits = len({
            row.get("completion_safe_fail_sha256")
            for row in completion_safe_fail_commit_rows
            if isinstance(row.get("completion_safe_fail_sha256"), str)
            and len(row["completion_safe_fail_sha256"]) == 64
        })
        completion_safe_fail_requests = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "completion_safe_fail_requested"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        )
        completion_safe_fails = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "completion_safe_fail"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        )
        completion_safe_fail_failures = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "completion_safe_fail_failed"
            and (
                driver_sid is None
                or row.get("sessionID") == driver_sid
            )
        )
        completion_safe_fail_ts = [
            row.get("ts")
            for row in completion_safe_fail_commit_rows
            if isinstance(row.get("ts"), (int, float))
        ]
        first_completion_safe_fail_ts = (
            min(completion_safe_fail_ts)
            if completion_safe_fail_ts
            else None
        )
        post_completion_safe_fail_model_dispatches = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "model_dispatch"
            and isinstance(row.get("ts"), (int, float))
            and first_completion_safe_fail_ts is not None
            and row["ts"] > first_completion_safe_fail_ts
        )
        terminal_ts = [
            row.get("ts")
            for row in terminal_commit_rows
            if isinstance(row.get("ts"), (int, float))
        ]
        first_terminal_ts = min(terminal_ts) if terminal_ts else None
        post_terminal_model_dispatches = sum(
            1
            for row in cpu_trace_rows
            if row.get("kind") == "model_dispatch"
            and isinstance(row.get("ts"), (int, float))
            and first_terminal_ts is not None
            and row["ts"] > first_terminal_ts
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
            "model_calls": model_calls,
            "model_dispatches": model_dispatches,
            "search_calls": len(searches),
            "mutation_tool_calls": len(patches),
            "model_mutation_tool_calls": len(patches),
            "deterministic_dispatches": deterministic_dispatches,
            "mutation_executions": len(patches) + deterministic_dispatches,
            "terminal_commits": terminal_commits,
            "terminal_short_circuit_requests":
                terminal_short_circuit_requests,
            "terminal_short_circuits": terminal_short_circuits,
            "terminal_short_circuit_failures":
                terminal_short_circuit_failures,
            "post_terminal_model_dispatches":
                post_terminal_model_dispatches,
            "completion_safe_fail_commits":
                completion_safe_fail_commits,
            "completion_safe_fail_requests":
                completion_safe_fail_requests,
            "completion_safe_fails": completion_safe_fails,
            "completion_safe_fail_failures":
                completion_safe_fail_failures,
            "post_completion_safe_fail_model_dispatches":
                post_completion_safe_fail_model_dispatches,
            "execute_replace_node_calls": len(replace_calls),
            "execute_rename_symbol_calls": len(rename_calls),
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
                return result

            if any(root != expected_root for root in declared_roots):
                result.update({
                    "result": "HARNESS_FAIL",
                    "failure_class": "environment_bug",
                    "reason": "project_root_mismatch",
                })
                return result

        if not patches and deterministic_dispatches < 1:
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": (
                    "environment_bug"
                    if not searches and agent["timed_out"]
                    else "implementation_bug"
                ),
                "reason": extract_failure_reason(
                    searches,
                    patches,
                    agent["timed_out"],
                ),
            })
            return result

        patch_row = driver_row
        if patch_row is None:
            result.update({
                "result": "HARNESS_FAIL",
                "failure_class": "telemetry_bug",
                "reason": "terminal_patch_transport_missing",
            })
            return result

        patch_output = tool_output(patch_row)
        sid = driver_sid

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
            return result

        if completion_safe_fail_commits > 0:
            safe_fail_reason = None
            if completion_safe_fail_commit_rows:
                safe_fail_reason = completion_safe_fail_commit_rows[-1].get(
                    "completion_safe_fail_reason"
                )
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": (
                    "environment_bug"
                    if safe_fail_reason in {
                        "spawn_error",
                        "timeout",
                        "completion_authorizer_unavailable",
                    }
                    else "architecture_bug"
                ),
                "reason": (
                    f"completion_safe_fail:{safe_fail_reason}"
                    if isinstance(safe_fail_reason, str) and safe_fail_reason
                    else "completion_safe_fail"
                ),
            })
            return result

        if trace and trace.get("proof_disposition") != "pass":
            result.update({
                "result": "FALSE_VERIFIED",
                "failure_class": "architecture_bug",
                "reason": "patch_ready_without_passing_proofs",
            })
            return result

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
            return result

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
            return result

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
            return result

        # Git/EOL/whitespace validity is authoritative inside the verifier
        # as candidate_hygiene-v1. The benchmark proves exact replay and task
        # acceptance, but must not implement a competing whitespace policy.

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
            return result

        checks = task.get("checks")

        if not isinstance(checks, list) or not checks:
            result.update({
                "result": "SAFE_FAIL",
                "failure_class": "benchmark_bug",
                "reason": "no_acceptance_checks",
            })
            return result

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
            return result

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
            return result

        result.update({
            "result": "VERIFIED",
            "failure_class": None,
            "reason": None,
        })

        return result

    except Exception as exc:
        result.update({
            "result": "HARNESS_FAIL",
            "failure_class": "benchmark_bug",
            "reason": str(exc),
        })
        return result

    finally:
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
