#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "benchmarks/runtime/v2.28-model-viability.py"
HARNESS = ROOT / "benchmarks/runtime/v2.17-real-task.py"

PUBLIC_TASK_ID = "synthetic-prompt-transport"
PUBLIC_PROMPT = "synthetic prompt transport contract"
PUBLIC_PROMPT_SHA256 = (
    "c4f07107816c4898036296ebe4088bc13416b7550a8b8565591bc7824f30f77e"
)


def assigned_name(node: ast.AST) -> str | None:
    if (
        isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
    ):
        return node.targets[0].id
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return node.target.id
    return None


def value(node: ast.AST) -> ast.AST | None:
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        return node.value
    return None


def direct_prompt_passthrough(
    text: str,
    function_name: str | None = None,
) -> bool:
    tree = ast.parse(text)
    functions = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and (function_name is None or node.name == function_name)
    ]
    for fn in functions:
        for node in ast.walk(fn):
            if (
                assigned_name(node) == "full_prompt"
                and isinstance(value(node), ast.Name)
                and value(node).id == "prompt"
            ):
                return True
    return False


def select_task(doc: dict, task_id: str) -> dict:
    tasks = doc.get("tasks")
    if isinstance(tasks, list):
        matches = [
            row
            for row in tasks
            if isinstance(row, dict) and row.get("id") == task_id
        ]
        if len(matches) != 1:
            raise AssertionError(f"task cardinality={len(matches)}")
        return matches[0]

    if doc.get("id") == task_id:
        return doc

    raise AssertionError("task missing")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", type=Path)
    parser.add_argument("--spec", type=Path)
    parser.add_argument("--task-id")
    args = parser.parse_args()

    supplied = [
        args.task is not None,
        args.spec is not None,
        args.task_id is not None,
    ]
    if any(supplied) and not all(supplied):
        parser.error(
            "--task, --spec and --task-id must be supplied together"
        )

    return args


def identity_inputs(
    args: argparse.Namespace,
) -> tuple[dict, dict, str, str]:
    if args.task is None:
        task_doc = {
            "id": PUBLIC_TASK_ID,
            "prompt": PUBLIC_PROMPT,
        }
        spec = {
            "expected_task_text_sha256": PUBLIC_PROMPT_SHA256,
        }
        return task_doc, spec, PUBLIC_TASK_ID, "public_synthetic"

    task_doc = json.loads(args.task.read_text(encoding="utf-8"))
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    return task_doc, spec, args.task_id, "explicit_fixture"


def main() -> int:
    args = parse_args()

    bench_text = BENCH.read_text(encoding="utf-8")
    harness_text = HARNESS.read_text(encoding="utf-8")

    bench_tree = ast.parse(bench_text)
    assert not any(
        assigned_name(node) == "HARNESS_PROMPT_PREFIX"
        for node in bench_tree.body
    ), "model viability still owns an independent harness prompt prefix"

    assert direct_prompt_passthrough(
        bench_text,
        "capture_request",
    ), "model viability capture must use full_prompt = prompt"

    assert direct_prompt_passthrough(
        harness_text,
        None,
    ), "v2.17 harness semantic prompt passthrough missing"

    task_doc, spec, task_id, identity_source = identity_inputs(args)
    task = select_task(task_doc, task_id)

    prompt = task.get("prompt")
    assert isinstance(prompt, str) and prompt

    task_sha = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    expected_sha = spec.get("expected_task_text_sha256")

    assert isinstance(expected_sha, str) and len(expected_sha) == 64
    assert task_sha == expected_sha, (
        f"benchmark reproduction task drift "
        f"task={task_sha} spec={expected_sha}"
    )

    print(f"PASS exact prompt transport sha256={task_sha}")
    print("PASS v2.17 and model-viability both use full_prompt = prompt")
    print("PASS model-viability owns no independent HARNESS_PROMPT_PREFIX")
    print(
        f"PASS task/spec semantic identity source={identity_source} "
        f"task_id={task_id}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
