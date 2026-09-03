#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

PROTOCOL = "governor-work-separation-contract-v1"
FORBIDDEN_SOURCE = "sealed_capability_max_plan_bytes"

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

def evaluate(trace: Path) -> dict[str, Any]:
    rows = load_json_lines(trace)
    mutation = [
        row
        for row in rows
        if row.get("kind") == "model_dispatch"
        and row.get("execution_state") in {"mutate", "repair"}
    ]

    violations = []
    observations = []
    for row in mutation:
        obs = {
            "model_call": row.get("model_call"),
            "execution_state": row.get("execution_state"),
            "input_bytes": row.get("governor_work_input_bytes"),
            "output_bound_bytes": row.get("governor_work_output_bound_bytes"),
            "output_bound_source": row.get("governor_work_output_bound_source"),
            "required_operations": row.get("governor_work_required_operations"),
            "lease_ms": row.get("governor_inference_lease_ms"),
            "lease_source": row.get("governor_inference_lease_source"),
        }
        observations.append(obs)
        if obs["output_bound_source"] == FORBIDDEN_SOURCE:
            violations.append({
                **obs,
                "reason": "safety_ceiling_used_as_expected_generation",
            })

    return {
        "protocol": PROTOCOL,
        "authority": "benchmark_contract_only",
        "mutation_dispatches": len(mutation),
        "violations": violations,
        "observations": observations,
        "pass": len(mutation) > 0 and not violations,
        "reason": (
            "ok"
            if len(mutation) > 0 and not violations
            else "no_mutation_dispatch"
            if not mutation
            else "safety_ceiling_used_as_expected_generation"
        ),
    }

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("trace")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    row = evaluate(Path(args.trace).resolve())
    print(json.dumps(row, indent=2, sort_keys=True))
    if args.json_out:
        Path(args.json_out).resolve().write_text(
            json.dumps(row, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    return 0 if row["pass"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
