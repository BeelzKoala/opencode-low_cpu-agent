#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


FAMILIES = (
    "python_imports",
    "python_declarations",
    "replacements",
    "creations",
)


def compact_sha(value: Any) -> str:
    data = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def rows(path: Path) -> list[dict[str, Any]]:
    out = []
    if not path.is_file():
        return out
    for raw in path.read_text(
        encoding="utf-8",
        errors="replace",
    ).splitlines():
        try:
            value = json.loads(raw)
        except Exception:
            continue
        if isinstance(value, dict):
            out.append(value)
    return out


def first_kind(values, kind):
    return next(
        (row for row in values if row.get("kind") == kind),
        {},
    )


def first_tool(values):
    for row in values:
        if row.get("type") != "tool_use":
            continue
        part = row.get("part") or {}
        if part.get("tool") == "execute_additive_plan":
            return row
    return {}


def task_dir(out: Path, task_id: str) -> Path:
    direct = out / task_id
    if direct.is_dir():
        return direct
    candidates = [
        p for p in out.iterdir()
        if p.is_dir()
        and (p / "cpu-agent-trace.jsonl").is_file()
    ]
    if len(candidates) != 1:
        raise RuntimeError(f"task result directory ambiguous: {out}")
    return candidates[0]


def parse_run(out: Path, task_id: str, rc: int) -> dict[str, Any]:
    root = task_dir(out, task_id)
    trace = rows(root / "cpu-agent-trace.jsonl")
    stdout = rows(root / "agent.stdout.jsonl")
    executor = rows(root / "executor-trace.jsonl")
    preflight = first_kind(trace, "deterministic_scout_preflight")
    dispatch = first_kind(trace, "model_dispatch")
    tool = first_tool(stdout)
    state = (tool.get("part") or {}).get("state") or {}
    plan = state.get("input")
    if not isinstance(plan, dict):
        plan = {}
    inner = ((state.get("metadata") or {}).get("metadata") or {})
    exec_row = executor[0] if executor else {}

    result = {}
    summary = out / "summary.json"
    if summary.is_file():
        try:
            doc = json.loads(summary.read_text(encoding="utf-8"))
            values = doc.get("results")
            if isinstance(values, list) and values:
                result = values[0]
        except Exception:
            pass

    family_counts = {
        key: len(plan.get(key))
        if isinstance(plan.get(key), list)
        else 0
        for key in FAMILIES
    }

    model_surface = {
        "task_sha256": dispatch.get("task_text_sha256"),
        "capsule_sha256":
            preflight.get("model_context_capsule_sha256"),
        "semantic_coverage_sha256":
            preflight.get("model_context_semantic_coverage_sha256"),
        "structural_plan_sha256":
            preflight.get("model_context_structural_plan_sha256"),
        "tool_schema_sha256":
            dispatch.get("tool_frontier_schema_sha256"),
        "context_bytes": dispatch.get("context_bytes"),
        "context_system_bytes":
            dispatch.get("context_system_bytes"),
        "context_messages_bytes":
            dispatch.get("context_messages_bytes"),
        "context_tools_bytes":
            dispatch.get("context_tools_bytes"),
    }

    return {
        "rc": rc,
        "result": result.get("result"),
        "reason": result.get("reason"),
        "execution_reason": result.get("execution_reason"),
        "wall_s": result.get("wall_s"),
        "model_latency_ms":
            exec_row.get("observed_model_latency_ms"),
        "model_surface": model_surface,
        "model_surface_sha256": compact_sha(model_surface),
        "execution_instance": {
            "contract_sha256":
                dispatch.get("execution_context_contract_sha256"),
            "authority_sha256":
                preflight.get("additive_authority_sha256"),
        },
        "plan_sha256": compact_sha(plan) if plan else None,
        "family_counts": family_counts,
        "coverage_detail": inner.get("detail"),
        "failure_reason": inner.get("reason"),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument(
        "--task",
        default=(
            "benchmarks/runtime/"
            "ozon-bestsellers-report-export-e2e.json"
        ),
    )
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument(
        "--out-root",
        default=(
            "benchmarks/results/"
            "v228-e27-model-repeatability-v2"
        ),
    )
    args = ap.parse_args()
    if args.runs < 2 or args.runs > 10:
        raise SystemExit("--runs must be 2..10")

    repo = Path(args.repo).resolve()
    task = Path(args.task)
    if not task.is_absolute():
        task = repo / task
    task_doc = json.loads(task.read_text(encoding="utf-8"))
    task_id = str(
        task_doc.get("id")
        or task_doc.get("task_id")
        or task.stem
    )
    out_root = Path(args.out_root)
    if not out_root.is_absolute():
        out_root = repo / out_root
    out_root.mkdir(parents=True, exist_ok=True)

    runs = []
    for index in range(1, args.runs + 1):
        out = out_root / f"run-{index:02d}"
        if out.exists():
            import shutil
            shutil.rmtree(out)
        cp = subprocess.run(
            [
                sys.executable,
                "benchmarks/runtime/v2.17-real-task.py",
                str(task),
                "--out",
                str(out),
            ],
            cwd=repo,
            env=os.environ.copy(),
            check=False,
        )
        run = parse_run(out, task_id, cp.returncode)
        run["index"] = index
        runs.append(run)
        print(
            f"RUN {index} "
            f"surface={run['model_surface_sha256'][:12]} "
            f"plan={str(run['plan_sha256'])[:12]} "
            f"counts={run['family_counts']} "
            f"latency_ms={run['model_latency_ms']}",
            flush=True,
        )

    surface_shas = [
        run["model_surface_sha256"]
        for run in runs
    ]
    stable_surface = len(set(surface_shas)) == 1
    plan_shas = [
        run["plan_sha256"]
        for run in runs
        if run["plan_sha256"] is not None
    ]
    failure_signatures = {
        json.dumps(
            [
                run["execution_reason"],
                run["failure_reason"],
                run["coverage_detail"],
                run["family_counts"],
            ],
            ensure_ascii=False,
            sort_keys=True,
        )
        for run in runs
        if run["plan_sha256"] is not None
    }

    if not stable_surface:
        verdict = (
            "MODEL_SURFACE_DRIFT: true model-facing telemetry changed."
        )
    elif len(plan_shas) >= 2 and len(failure_signatures) == 1:
        verdict = (
            "SYSTEMATIC_FAILURE_TOPOLOGY: stable model surface, "
            "different exact generations, same semantic failure topology."
        )
    elif len(set(plan_shas)) > 1:
        verdict = (
            "OUTPUT_DIVERSITY: stable model surface with differing "
            "semantic outcomes; investigate serving/sampling stability."
        )
    else:
        verdict = (
            "INSUFFICIENT_COMPLETED_GENERATIONS: model surface is stable "
            "but too few completed plans for a quality conclusion."
        )

    report = {
        "protocol": "model-repeatability-bench-v2",
        "stable_model_surface": stable_surface,
        "model_surface_sha256s": surface_shas,
        "unique_completed_plan_sha256s": len(set(plan_shas)),
        "unique_completed_failure_topologies":
            len(failure_signatures),
        "execution_instance_identity_is_observational": True,
        "verdict": verdict,
        "runs": runs,
    }
    path = out_root / "repeatability-report-v2.json"
    path.write_text(
        json.dumps(
            report,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nVERDICT {verdict}")
    print(f"report={path}")


if __name__ == "__main__":
    main()
