#!/usr/bin/env python3
from pathlib import Path
import argparse
import json

parser = argparse.ArgumentParser()
parser.add_argument("results", nargs="+")
args = parser.parse_args()

rows = []
for filename in args.results:
    result = json.loads(Path(filename).read_text(encoding="utf-8"))
    cases = result.get("cases", [])
    verified = sum(
        1
        for case in cases
        if case.get("state") == "VERIFIED" or case.get("pass") is True
    )
    false_verified = sum(
        1 for case in cases if case.get("false_verified") is True
    )
    cpu = sum(float(case.get("cpu_seconds", 0) or 0) for case in cases)
    wall = sum(
        float(case.get("wall_seconds", case.get("wall_s", 0)) or 0)
        for case in cases
    )
    model_calls = sum(
        int(case.get("model_calls", 0) or 0) for case in cases
    )
    rows.append(
        {
            "system": result.get("system", Path(filename).stem),
            "tasks": len(cases),
            "verified": verified,
            "false_verified": false_verified,
            "cpu_seconds": round(cpu, 3),
            "solved_tasks_per_cpu": (
                round(verified / cpu, 6) if cpu > 0 else None
            ),
            "model_calls": model_calls,
            "wall_seconds": round(wall, 3),
        }
    )

rows.sort(
    key=lambda row: (
        row["false_verified"],
        -(row["solved_tasks_per_cpu"] or 0),
        -row["verified"],
    )
)
print(json.dumps({"protocol": "corpus-score-v1", "ranking": rows}, indent=2))
