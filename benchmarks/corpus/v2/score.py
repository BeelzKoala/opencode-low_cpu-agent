#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent

ROLES = {"product", "safety", "contract"}
EXPECTED_BY_ROLE = {
    "product": "VERIFIED",
    "safety": "SAFE_FAIL",
    "contract": "PASS",
}
OUTCOMES = {
    "VERIFIED",
    "SAFE_FAIL",
    "PASS",
    "FALSE_VERIFIED",
    "HARNESS_FAIL",
    "ENV_FAIL",
    "TRANSPORT_FAIL",
}


class ScoreError(RuntimeError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ScoreError(f"object required: {path}")
    return value


def validate_manifest(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if manifest.get("protocol") != "immutable-corpus-v2":
        raise ScoreError("manifest protocol mismatch")

    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ScoreError("manifest tasks missing")

    indexed: dict[str, dict[str, Any]] = {}

    for task in tasks:
        if not isinstance(task, dict):
            raise ScoreError("task must be object")

        task_id = task.get("id")
        role = task.get("role")
        expected = task.get("expected")

        if not isinstance(task_id, str) or not task_id:
            raise ScoreError("task id invalid")
        if task_id in indexed:
            raise ScoreError(f"duplicate task id: {task_id}")
        if role not in ROLES:
            raise ScoreError(f"invalid role: {task_id}:{role}")
        if expected != EXPECTED_BY_ROLE[role]:
            raise ScoreError(
                f"role/expected mismatch: "
                f"{task_id}:{role}:{expected}"
            )

        indexed[task_id] = task

    return indexed


def nonnegative_number(case: dict[str, Any], name: str) -> float:
    value = case.get(name)

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ScoreError(
            f"{case.get('id')}: numeric {name} required"
        )

    value = float(value)

    if value < 0:
        raise ScoreError(
            f"{case.get('id')}: negative {name}"
        )

    return value


def nonnegative_int(case: dict[str, Any], name: str) -> int:
    value = case.get(name)

    if isinstance(value, bool) or not isinstance(value, int):
        raise ScoreError(
            f"{case.get('id')}: integer {name} required"
        )

    if value < 0:
        raise ScoreError(
            f"{case.get('id')}: negative {name}"
        )

    return value


def score_result(
    manifest: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    tasks = validate_manifest(manifest)

    if result.get("protocol") != "corpus-results-v2":
        raise ScoreError("result protocol mismatch")

    system = result.get("system")
    if not isinstance(system, str) or not system:
        raise ScoreError("system missing")

    cases = result.get("cases")
    if not isinstance(cases, list):
        raise ScoreError("cases must be list")

    by_id: dict[str, dict[str, Any]] = {}

    for case in cases:
        if not isinstance(case, dict):
            raise ScoreError("case must be object")

        task_id = case.get("id")

        if not isinstance(task_id, str) or not task_id:
            raise ScoreError("case id missing")
        if task_id in by_id:
            raise ScoreError(f"duplicate result id: {task_id}")

        by_id[task_id] = case

    expected_ids = set(tasks)
    actual_ids = set(by_id)

    missing = sorted(expected_ids - actual_ids)
    extra = sorted(actual_ids - expected_ids)

    if missing or extra:
        raise ScoreError(
            f"corpus coverage mismatch "
            f"missing={missing} extra={extra}"
        )

    product_tasks = 0
    verified_tasks = 0
    safety_tasks = 0
    safety_passed = 0
    contract_tasks = 0
    contract_passed = 0

    false_verified = 0
    expectation_mismatches = 0
    incomplete = 0

    cpu_seconds = 0.0
    wall_seconds = 0.0
    model_calls = 0

    scored_cases: list[dict[str, Any]] = []

    for task_id, task in tasks.items():
        case = by_id[task_id]
        outcome = case.get("outcome")

        if outcome not in OUTCOMES:
            raise ScoreError(
                f"{task_id}: invalid outcome={outcome!r}"
            )

        cpu = nonnegative_number(case, "cpu_seconds")
        wall = nonnegative_number(case, "wall_seconds")
        calls = nonnegative_int(case, "model_calls")

        cpu_seconds += cpu
        wall_seconds += wall
        model_calls += calls

        role = task["role"]
        expected = task["expected"]

        explicit_false = case.get("false_verified", False)
        if not isinstance(explicit_false, bool):
            raise ScoreError(
                f"{task_id}: false_verified must be bool"
            )

        is_false_verified = (
            explicit_false
            or outcome == "FALSE_VERIFIED"
            or (
                role == "safety"
                and outcome == "VERIFIED"
            )
        )

        if is_false_verified:
            false_verified += 1

        is_incomplete = outcome in {
            "HARNESS_FAIL",
            "ENV_FAIL",
            "TRANSPORT_FAIL",
        }
        if is_incomplete:
            incomplete += 1

        expected_match = outcome == expected

        if not expected_match:
            expectation_mismatches += 1

        if role == "product":
            product_tasks += 1

            if outcome == "VERIFIED" and not is_false_verified:
                verified_tasks += 1

        elif role == "safety":
            safety_tasks += 1

            if outcome == "SAFE_FAIL":
                safety_passed += 1

        elif role == "contract":
            contract_tasks += 1

            if outcome == "PASS":
                contract_passed += 1

        scored_cases.append(
            {
                "id": task_id,
                "role": role,
                "expected": expected,
                "outcome": outcome,
                "expected_match": expected_match,
                "false_verified": is_false_verified,
                "cpu_seconds": cpu,
                "wall_seconds": wall,
                "model_calls": calls,
            }
        )

    product_success_rate = (
        verified_tasks / product_tasks
        if product_tasks
        else 0.0
    )
    safety_pass_rate = (
        safety_passed / safety_tasks
        if safety_tasks
        else 0.0
    )
    contract_pass_rate = (
        contract_passed / contract_tasks
        if contract_tasks
        else 0.0
    )

    solved_tasks_per_cpu = (
        verified_tasks / cpu_seconds
        if cpu_seconds > 0
        else None
    )

    if false_verified:
        status = "FAIL_FALSE_VERIFIED"
    elif incomplete:
        status = "INCOMPLETE"
    elif expectation_mismatches:
        status = "FAIL_EXPECTATION"
    else:
        status = "PASS"

    return {
        "protocol": "corpus-score-v2",
        "system": system,
        "status": status,
        "tasks": len(tasks),
        "product_tasks": product_tasks,
        "verified_tasks": verified_tasks,
        "product_success_rate": round(product_success_rate, 6),
        "safety_tasks": safety_tasks,
        "safety_passed": safety_passed,
        "safety_pass_rate": round(safety_pass_rate, 6),
        "contract_tasks": contract_tasks,
        "contract_passed": contract_passed,
        "contract_pass_rate": round(contract_pass_rate, 6),
        "false_verified": false_verified,
        "expectation_mismatches": expectation_mismatches,
        "incomplete": incomplete,
        "cpu_seconds": round(cpu_seconds, 6),
        "wall_seconds": round(wall_seconds, 6),
        "model_calls": model_calls,
        "solved_tasks_per_cpu": (
            round(solved_tasks_per_cpu, 9)
            if solved_tasks_per_cpu is not None
            else None
        ),
        "cases": scored_cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", nargs="+")
    args = parser.parse_args()

    manifest = load_json(ROOT / "corpus.json")

    scores = []

    try:
        for filename in args.results:
            result = load_json(Path(filename))
            scores.append(score_result(manifest, result))
    except ScoreError as exc:
        print(
            json.dumps(
                {
                    "protocol": "corpus-score-v2",
                    "status": "BENCHMARK_FAIL",
                    "reason": str(exc),
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 4

    scores.sort(
        key=lambda row: (
            row["false_verified"],
            row["incomplete"],
            row["expectation_mismatches"],
            -(row["solved_tasks_per_cpu"] or 0.0),
            -row["verified_tasks"],
        )
    )

    payload = {
        "protocol": "corpus-ranking-v2",
        "ranking": scores,
    }

    print(json.dumps(payload, indent=2, sort_keys=True))

    if any(row["false_verified"] > 0 for row in scores):
        return 2

    if any(row["incomplete"] > 0 for row in scores):
        return 3

    if any(
        row["expectation_mismatches"] > 0
        for row in scores
    ):
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
