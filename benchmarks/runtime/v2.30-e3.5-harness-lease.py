#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time


ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "benchmarks/runtime/v2.17-real-task.py"


def load_harness():
    spec = importlib.util.spec_from_file_location(
        "e35_real_task_harness",
        HARNESS,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load real-task harness")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def case_adaptive_extension(module) -> None:
    with tempfile.TemporaryDirectory(prefix="e35-lease-") as td:
        root = Path(td)
        trace = root / ".opencode" / "cpu-agent-trace.jsonl"
        trace.parent.mkdir(parents=True)

        started_monotonic = time.monotonic()
        started_epoch_ms = int(time.time() * 1000)

        proc = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import time; time.sleep(0.40)",
            ],
            start_new_session=True,
        )

        def writer() -> None:
            time.sleep(0.03)
            row = {
                "ts": int(time.time() * 1000),
                "kind": "model_dispatch",
                "model_call": 1,
                "governor_work_protocol": "governor-work-v2",
                "governor_inference_lease_ms": 700,
                "governor_inference_lease_source":
                    "jacobson_p2_work_normalized",
            }
            trace.write_text(
                json.dumps(row) + "\n",
                encoding="utf-8",
            )

        threading.Thread(target=writer, daemon=True).start()

        result = module._wait_with_governor_leases(
            proc,
            root,
            started_monotonic,
            started_epoch_ms,
            0.10,
        )

        assert result["rc"] == 0, result
        assert result["timed_out"] is False, result
        assert result["adaptive_lease_seen"] is True, result
        assert result["adaptive_lease_extensions"] >= 1, result


def case_no_lease_times_out(module) -> None:
    with tempfile.TemporaryDirectory(prefix="e35-no-lease-") as td:
        root = Path(td)
        started_monotonic = time.monotonic()
        started_epoch_ms = int(time.time() * 1000)

        proc = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import time; time.sleep(2)",
            ],
            start_new_session=True,
        )

        result = module._wait_with_governor_leases(
            proc,
            root,
            started_monotonic,
            started_epoch_ms,
            0.10,
        )

        assert result["rc"] == 124, result
        assert result["timed_out"] is True, result
        assert result["adaptive_lease_seen"] is False, result


def main() -> None:
    module = load_harness()

    assert hasattr(module, "_wait_with_governor_leases")
    assert hasattr(module, "_read_governor_lease_records")

    case_adaptive_extension(module)
    case_no_lease_times_out(module)

    print(
        "PASS E3.5 harness lease inheritance "
        "adaptive_extension=true no_lease_timeout=true"
    )


if __name__ == "__main__":
    main()
