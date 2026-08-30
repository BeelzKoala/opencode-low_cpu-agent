#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import runpy
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MC2 = ROOT / "benchmarks/runtime/v2.19-mutation-confinement-v2.py"

ctx = runpy.run_path(str(MC2), run_name="r14c_mc2_library")
COMPILER = ctx["COMPILER"]
EXECUTOR = ctx["EXECUTOR"]
run_json = ctx["run_json"]
init_repo = ctx["init_repo"]
write_handoff = ctx["write_handoff"]
mutation = ctx["mutation"]
compiler_request = ctx["compiler_request"]
executor_request = ctx["executor_request"]
git = ctx["git"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assert_clean(root: Path) -> None:
    assert git(root, "diff", "--quiet").returncode == 0
    assert git(root, "diff", "--cached", "--quiet").returncode == 0


compiler_src = (ROOT / "rust/evidence-distiller/src/patch_compiler.rs").read_text()
executor_src = (ROOT / "rust/evidence-distiller/src/patch_executor.rs").read_text()
plugin_src = (ROOT / "opencode/plugins/cpu-search.ts").read_text()
verifier_src = (ROOT / "rust/evidence-distiller/src/invariant_verifier.rs").read_text()
cas_src = (ROOT / "rust/evidence-distiller/src/sealed_slice_store_core.rs").read_text()

assert 'const BASE_STATE_PROTOCOL: &str = "sealed-base-state-v1";' in compiler_src
assert 'const BASE_STATE_PROTOCOL: &str = "sealed-base-state-v1";' in executor_src
assert "seal_edit_base_states(&mut edits, &allowed)" in compiler_src
assert "fs::symlink_metadata(&target)" in compiler_src
assert executor_src.count("validate_base_preconditions(") >= 3
assert "path_is_absent_without_symlink" in executor_src
assert "base_precondition_handoff_mismatch" in executor_src
assert "base_state_stale" in executor_src
assert "sealed-base-state-v1" not in plugin_src
assert "sealed-base-state-v1" not in verifier_src
assert 'const AUTHORITY: &str = "cache_only";' in cas_src

legacy_harness_src = MC2.read_text(encoding="utf-8")
assert 'if __name__ == "__main__":' in legacy_harness_src
assert 'runpy.run_path(str(MC2), run_name="r14c_mc2_library")' in Path(__file__).read_text(
    encoding="utf-8"
)
print("PASS R14-C static authority separation")
print("PASS legacy v2.19 helpers reused without historical static_gate authority")

with tempfile.TemporaryDirectory(prefix="r14c-base-occ-") as td:
    root = Path(td)
    source = init_repo(root, "def calculate():\n    return 1\n")
    handoff = write_handoff(root, source)
    item = mutation("calculate", "return 1", "return 2")

    compiled = run_json(COMPILER, compiler_request(root, handoff, item))
    assert compiled.get("ok") is True, compiled
    assert compiled.get("edits"), compiled

    expected = sha256(source)
    for edit in compiled["edits"]:
        base = edit.get("base")
        assert base is not None, edit
        assert base["protocol"] == "sealed-base-state-v1", base
        assert base["state"] == "existing_regular_file", base
        assert base["sha256"] == expected, (base, expected)

    executed = run_json(
        EXECUTOR,
        executor_request(
            root,
            handoff,
            compiled["edits"],
            compiled.get("checks"),
        ),
    )
    assert executed.get("admitted") is True, executed
    assert executed.get("repo_mutated") is not True, executed
    assert_clean(root)
    print("PASS unchanged sealed base admits isolated execution")

    tampered = copy.deepcopy(compiled["edits"])
    tampered[0]["base"]["sha256"] = "0" * 64
    rejected = run_json(
        EXECUTOR,
        executor_request(root, handoff, tampered, compiled.get("checks")),
    )
    assert rejected.get("admitted") is not True, rejected
    assert rejected.get("reason") == "base_precondition_handoff_mismatch", rejected
    assert_clean(root)
    print("PASS tampered compiler base cannot escape handoff authority")

    missing = copy.deepcopy(compiled["edits"])
    missing[0].pop("base", None)
    rejected = run_json(
        EXECUTOR,
        executor_request(root, handoff, missing, compiled.get("checks")),
    )
    assert rejected.get("admitted") is not True, rejected
    assert rejected.get("reason") == "base_precondition_missing", rejected
    assert_clean(root)
    print("PASS missing sealed base fails closed")

    source.write_text(
        "def calculate():\n    # concurrent drift\n    return 1\n",
        encoding="utf-8",
    )
    rejected = run_json(
        EXECUTOR,
        executor_request(
            root,
            handoff,
            compiled["edits"],
            compiled.get("checks"),
        ),
    )
    assert rejected.get("admitted") is not True, rejected
    assert rejected.get("reason") in {
        "stale_fingerprint",
        "base_state_stale",
        "base_path_state_mismatch",
    }, rejected
    assert "return 2" not in source.read_text(encoding="utf-8")
    print("PASS stale source produces zero mutation")

print("PASS R14-C sealed BaseState OCC / handoff binding / stale fail-closed")
