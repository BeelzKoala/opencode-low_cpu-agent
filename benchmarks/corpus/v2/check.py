#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import score


ROOT = Path(__file__).resolve().parent

manifest = json.loads(
    (ROOT / "corpus.json").read_text(encoding="utf-8")
)

tasks = score.validate_manifest(manifest)

assert len(tasks) == 12
assert sum(
    task["role"] == "product"
    for task in tasks.values()
) == 5
assert sum(
    task["role"] == "safety"
    for task in tasks.values()
) == 4
assert sum(
    task["role"] == "contract"
    for task in tasks.values()
) == 3


def perfect_result() -> dict:
    return {
        "protocol": "corpus-results-v2",
        "system": "self-test",
        "cases": [
            {
                "id": task_id,
                "outcome": task["expected"],
                "false_verified": False,
                "cpu_seconds": 1.0,
                "wall_seconds": 1.0,
                "model_calls": (
                    0
                    if task["role"] == "contract"
                    else 1
                ),
            }
            for task_id, task in tasks.items()
        ],
    }


perfect = score.score_result(
    manifest,
    perfect_result(),
)

assert perfect["status"] == "PASS", perfect
assert perfect["verified_tasks"] == 5, perfect
assert perfect["product_tasks"] == 5, perfect
assert perfect["safety_passed"] == 4, perfect
assert perfect["contract_passed"] == 3, perfect
assert perfect["false_verified"] == 0, perfect

# Critical regression:
# three PASS contract cases must NOT become solved coding tasks.
assert perfect["verified_tasks"] != 8, perfect

print("PASS contract PASS is not counted as VERIFIED task")

unsafe = perfect_result()

for case in unsafe["cases"]:
    if case["id"] == "duplicate-definition-rename":
        case["outcome"] = "VERIFIED"
        break
else:
    raise AssertionError("safety fixture missing")

unsafe_score = score.score_result(manifest, unsafe)

assert unsafe_score["false_verified"] == 1, unsafe_score
assert unsafe_score["status"] == "FAIL_FALSE_VERIFIED", unsafe_score

print("PASS adversarial VERIFIED becomes false_verified")

missing = perfect_result()
missing["cases"].pop()

try:
    score.score_result(manifest, missing)
except score.ScoreError as exc:
    assert "corpus coverage mismatch" in str(exc)
else:
    raise AssertionError("missing corpus task was accepted")

print("PASS incomplete corpus coverage is rejected")

legacy_shape = perfect_result()
legacy_shape["cases"][0].pop("outcome")
legacy_shape["cases"][0]["pass"] = True

try:
    score.score_result(manifest, legacy_shape)
except score.ScoreError as exc:
    assert "invalid outcome" in str(exc)
else:
    raise AssertionError("legacy pass=true became VERIFIED")

print("PASS legacy pass=true cannot imply VERIFIED")

lock_path = ROOT / "corpus.lock.json"

if lock_path.is_file():
    lock = json.loads(lock_path.read_text(encoding="utf-8"))

    assert lock["protocol"] == "corpus-content-lock-v2"

    expected_files = {
        "check.py",
        "corpus.json",
        "repos.lock.json",
        "score.py",
    }

    assert set(lock["files"]) == expected_files

    for name, record in lock["files"].items():
        body = (ROOT / name).read_bytes()

        assert len(body) == record["bytes"], name
        assert hashlib.sha256(body).hexdigest() == record["sha256"], name

    print("PASS immutable corpus v2 content lock")

print("PASS corpus scoring authority v2")
