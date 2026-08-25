#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / "rust" / "evidence-distiller"
TARGET = RUST / "target" / "debug"

COMPILER = TARGET / "opencode-patch-compiler"
EXECUTOR = TARGET / "opencode-patch-executor"
VERIFIER = TARGET / "opencode-invariant-verifier"

VERIFIER_SOURCE = RUST / "src" / "invariant_verifier.rs"
DIFFERENTIAL_SOURCE = (
    RUST / "src" / "invariant_verifier" / "differential.rs"
)

COMPILER_PROTOCOL = "patch-compiler-v2"
EXECUTOR_PROTOCOL = "patch-executor-v3"
VERIFIER_PROTOCOL = "invariant-verifier-v2"
EDIT_PROTOCOL = "edit-script-v3-certified-slice"
MUTATION_PROTOCOL = "mutation-plan-v1"

OBSERVATION_PROTOCOL = "differential-observation-v1"
OBSERVATION_KIND = "python_control_flow_points_v1"
OBSERVATION_AUTHORITY = "shadow_observation"


def run_json(binary: Path, payload: dict) -> dict:
    cp = subprocess.run(
        [str(binary)],
        input=json.dumps(payload),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=payload["root"],
        check=False,
    )
    assert cp.returncode == 0, {
        "binary": str(binary),
        "rc": cp.returncode,
        "stdout": cp.stdout,
        "stderr": cp.stderr,
    }
    return json.loads(cp.stdout)


def git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def init_repo(root: Path, source_text: str) -> Path:
    source = root / "single.py"
    source.write_text(source_text, encoding="utf-8")

    assert git(root, "init", "-q").returncode == 0
    assert git(root, "config", "user.email", "gate@example.invalid").returncode == 0
    assert git(root, "config", "user.name", "v2.25 promotion gate").returncode == 0
    assert git(root, "add", "single.py").returncode == 0
    assert git(root, "commit", "-qm", "baseline").returncode == 0

    return source


def write_handoff(root: Path, source: Path, symbol: str) -> str:
    rel = ".opencode/scout-handoffs/capabilities/local.json"
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)

    body = {
        "protocol": "scout-handoff-v1",
        "search_protocol": "v2.25-promotion-proof",
        "status": "ready",
        "blocking_reasons": [],
        "partial_reasons": [],
        "scope_mode": "local_mutation_capability",
        "capability_protocol": "scout-local-capability-v1",
        "allowed_mutations": ["replace_node"],
        "capability": {
            "protocol": "scout-local-capability-v1",
            "operation": "replace_node",
            "target": {
                "file": "single.py",
                "symbol_name": symbol,
            },
        },
        "files": [
            {
                "file": "single.py",
                "origins": ["lexical"],
                "evidence_lines": [1],
                "fingerprint": {
                    "kind": "sha256",
                    "strong": True,
                    "sha256": sha256(source),
                    "evidence_fresh": True,
                    "witnesses_checked": 1,
                },
                "changed_during_scout": False,
            }
        ],
    }

    path.write_text(
        json.dumps(body, indent=2) + "\n",
        encoding="utf-8",
    )
    return rel


def mutation(symbol: str, before: str, replacement: str) -> dict:
    return {
        "file": "single.py",
        "kind": "replace_node",
        "symbol": symbol,
        "before": before,
        "replacement": replacement,
    }


def compiler_request(root: Path, handoff: str, item: dict) -> dict:
    return {
        "root": str(root),
        "handoff": handoff,
        "mutation_protocol": MUTATION_PROTOCOL,
        "mutations": [item],
    }


def executor_request(
    root: Path,
    handoff: str,
    edits: list[dict],
    checks: list[dict] | None,
) -> dict:
    return {
        "root": str(root),
        "handoff": handoff,
        "mode": "guarded",
        "edit_protocol": EDIT_PROTOCOL,
        "edits": edits,
        "checks": checks or [],
    }


def verifier_request(
    root: Path,
    handoff: str,
    patch: str,
    item: dict,
    changed_files: list[str],
    edits: list[dict],
) -> dict:
    return {
        "root": str(root),
        "handoff": handoff,
        "patch": patch,
        "compiler_protocol": COMPILER_PROTOCOL,
        "mutation_protocol": MUTATION_PROTOCOL,
        "mutations": [item],
        "changed_files": changed_files,
        "edits": edits,
    }


def static_gate() -> None:
    verifier = VERIFIER_SOURCE.read_text(encoding="utf-8")
    differential = DIFFERENTIAL_SOURCE.read_text(encoding="utf-8")

    assert '#[path = "invariant_verifier/differential.rs"]' in verifier
    assert "mod differential;" in verifier
    assert (
        "use differential::{DifferentialObservation, observe_python_control_flow};"
        in verifier
    )
    assert "differential_observations: Vec<DifferentialObservation>" in verifier
    assert (
        "let mut differential_observations = "
        "Vec::<DifferentialObservation>::new();"
        in verifier
    )
    assert "observe_python_control_flow(" in verifier
    assert (
        "response.differential_observations = differential_observations;"
        in verifier
    )

    # Promotion boundary: shadow data does not participate in authority.
    assert (
        "let ok = reason.is_none() && invariants_failed == 0 && worktree_cleaned;"
        in verifier
    )
    assert "differential_observations.is_empty()" not in verifier
    assert "differential_observations.iter()" not in verifier

    assert (
        'const OBSERVATION_PROTOCOL: &str = '
        '"differential-observation-v1";'
        in differential
    )
    assert (
        'const OBSERVATION_AUTHORITY: &str = "shadow_observation";'
        in differential
    )
    assert (
        'const CONTROL_FLOW_KIND: &str = '
        '"python_control_flow_points_v1";'
        in differential
    )

    # The observation module has no direct route into authoritative checks.
    assert "struct Check" not in differential
    assert "checks.push" not in differential
    assert 'verdict: "PASS"' not in differential
    assert 'verdict: "FAIL"' not in differential

    print("PASS static shadow/authority separation")


def assert_observation_common(row: dict, symbol: str) -> None:
    assert row.get("protocol") == OBSERVATION_PROTOCOL, row
    assert row.get("kind") == OBSERVATION_KIND, row
    assert row.get("authority") == OBSERVATION_AUTHORITY, row
    assert row.get("symbol") == symbol, row

    file_value = row.get("file")
    assert isinstance(file_value, str), row
    assert file_value.replace("\\", "/").endswith("/single.py"), row


def run_case(
    name: str,
    source_text: str,
    before: str,
    replacement: str,
    symbol: str = "calculate",
) -> dict:
    with tempfile.TemporaryDirectory(prefix=f"v225-{name}-") as td:
        root = Path(td)
        source = init_repo(root, source_text)
        handoff = write_handoff(root, source, symbol)

        item = mutation(symbol, before, replacement)

        compiled = run_json(
            COMPILER,
            compiler_request(root, handoff, item),
        )
        assert compiled.get("protocol") == COMPILER_PROTOCOL, compiled
        assert compiled.get("ok") is True, compiled

        edits = compiled.get("edits")
        changed_files = compiled.get("changed_files")
        assert isinstance(edits, list) and len(edits) == 1, compiled
        assert changed_files == ["single.py"], compiled

        executed = run_json(
            EXECUTOR,
            executor_request(
                root,
                handoff,
                edits,
                compiled.get("checks"),
            ),
        )
        assert executed.get("protocol") == EXECUTOR_PROTOCOL, executed
        assert executed.get("admitted") is True, executed

        patch = executed.get("patch")
        assert isinstance(patch, str) and patch, executed

        # Executor must not mutate the source checkout.
        assert git(root, "diff", "--quiet").returncode == 0

        verified = run_json(
            VERIFIER,
            verifier_request(
                root,
                handoff,
                patch,
                item,
                changed_files,
                edits,
            ),
        )

        assert verified.get("protocol") == VERIFIER_PROTOCOL, verified
        assert verified.get("ok") is True, verified
        assert verified.get("verdict") == "PASS", verified
        assert verified.get("reason") is None, verified
        assert verified.get("invariants_failed") == 0, verified

        observations = verified.get("differential_observations")
        assert isinstance(observations, list), verified
        assert len(observations) == 1, verified

        return verified


def main() -> None:
    static_gate()

    for binary in (COMPILER, EXECUTOR, VERIFIER):
        assert binary.is_file(), (
            f"missing {binary}; run cargo build --bins"
        )

    zero = run_case(
        "zero-delta",
        "def calculate(value):\n"
        "    return value\n",
        "return value",
        "return value + 0",
    )

    zero_obs = zero["differential_observations"][0]
    assert_observation_common(zero_obs, "calculate")
    assert zero_obs.get("status") == "observed", zero_obs
    assert zero_obs.get("before") == 0, zero_obs
    assert zero_obs.get("after") == 0, zero_obs
    assert zero_obs.get("delta") == 0, zero_obs
    assert zero_obs.get("increased") is False, zero_obs

    print("PASS zero control-flow delta is observed")

    increased = run_case(
        "increased-delta",
        "def calculate(value):\n"
        "    return value\n",
        "return value",
        "if value:\n"
        "    return value\n"
        "return 0",
    )

    increased_obs = increased["differential_observations"][0]
    assert_observation_common(increased_obs, "calculate")
    assert increased_obs.get("status") == "observed", increased_obs
    assert increased_obs.get("before") == 0, increased_obs
    assert increased_obs.get("after") == 1, increased_obs
    assert increased_obs.get("delta") == 1, increased_obs
    assert increased_obs.get("increased") is True, increased_obs

    # Critical promotion proof:
    # the shadow signal changed materially, but authoritative verdict stayed PASS.
    assert increased.get("ok") is True, increased
    assert increased.get("verdict") == "PASS", increased

    print("PASS increased shadow signal does not alter authoritative verdict")

    nested = run_case(
        "nested-abstention",
        "def calculate(value):\n"
        "    def helper(item):\n"
        "        if item:\n"
        "            return item\n"
        "        return 0\n"
        "    return helper(value)\n",
        "return helper(value)",
        "return helper(value) + 0",
    )

    nested_obs = nested["differential_observations"][0]
    assert_observation_common(nested_obs, "calculate")
    assert nested_obs.get("status") == "skipped", nested_obs
    assert nested_obs.get("reason") == "nested_definition", nested_obs
    assert "before" not in nested_obs, nested_obs
    assert "after" not in nested_obs, nested_obs
    assert "delta" not in nested_obs, nested_obs
    assert "increased" not in nested_obs, nested_obs

    # Abstention is telemetry, not a hidden failure gate.
    assert nested.get("ok") is True, nested
    assert nested.get("verdict") == "PASS", nested

    print("PASS ambiguous scope abstains without inventing evidence")

    # Observation did not silently become an invariant/check.
    assert zero["invariants_total"] == increased["invariants_total"]
    assert zero["invariants_total"] == nested["invariants_total"]
    assert len(zero["checks"]) == len(increased["checks"])
    assert len(zero["checks"]) == len(nested["checks"])

    print("PASS observation cardinality does not change authoritative checks")
    print("PASS v2.25 differential shadow promotion proof")


if __name__ == "__main__":
    main()
