#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import runpy
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MC2 = ROOT / "benchmarks/runtime/v2.19-mutation-confinement-v2.py"
SPEC = ROOT / "benchmarks/v2.19.1-candidate-validity-gates.json"

ctx = runpy.run_path(str(MC2), run_name="v219_gate_library")
COMPILER = ctx["COMPILER"]
EXECUTOR = ctx["EXECUTOR"]
VERIFIER = ctx["VERIFIER"]
run_json = ctx["run_json"]
init_repo = ctx["init_repo"]
write_handoff = ctx["write_handoff"]
mutation = ctx["mutation"]
compiler_request = ctx["compiler_request"]
executor_request = ctx["executor_request"]
verifier_request = ctx["verifier_request"]
git = ctx["git"]

def barrier_check(response: dict) -> dict:
    checks = [
        c for c in response.get("checks", [])
        if c.get("kind") == "candidate_validity_barrier"
    ]
    assert len(checks) == 1, checks
    return checks[0]

def static_gate() -> None:
    module = (ROOT / "rust/evidence-distiller/src/candidate_validity.rs").read_text()
    lib = (ROOT / "rust/evidence-distiller/src/lib.rs").read_text()
    compiler = (ROOT / "rust/evidence-distiller/src/patch_compiler.rs").read_text()
    verifier = (ROOT / "rust/evidence-distiller/src/invariant_verifier.rs").read_text()
    plugin = (ROOT / "opencode/plugins/cpu-search.ts").read_text()
    spec = json.loads(SPEC.read_text())

    assert 'pub const PROTOCOL: &str = "candidate-validity-v1"' in module
    assert 'pub const PYTHON_VALIDATOR_KIND: &str = "python3-compile-v1"' in module
    assert 'VALIDATOR_TIMEOUT_MS: u64 = 1500' in module
    assert 'LANGUAGE_INVALID_EXIT_CODE: i32 = 10' in module
    assert 'Some(LANGUAGE_INVALID_EXIT_CODE) => CandidateValidation::Invalid(spec)' in module
    assert 'Some(_) | None => CandidateValidation::Failed(spec)' in module
    assert 'except (SyntaxError, ValueError, OverflowError)' in module
    assert 'raise SystemExit(10)' in module
    assert 'coverage=native_enforced' in module
    assert 'coverage=structural_only' in module
    assert 'Command::new(spec.program)' in module
    assert '.stdin(Stdio::piped())' in module
    assert '.stdout(Stdio::null())' in module
    assert '.stderr(Stdio::null())' in module
    assert '"-I"' in module and '"-S"' in module
    assert "compile(src, '<candidate>', 'exec'" in module
    assert "eval(" not in module
    assert 'pub mod candidate_validity;' in lib

    c_start = compiler.index("fn compile_replace_node(")
    c_end = compiler.index("\nfn valid_ascii_identifier", c_start)
    c_block = compiler[c_start:c_end]
    assert "validate_candidate(&file.path, &candidate)" in c_block
    assert "validity.failure_reason()" in c_block

    assert 'kind: "candidate_validity_barrier".to_string()' in verifier
    assert "validate_candidate(&wt.join(file), &actual)" in verifier
    assert "candidate_validity_barrier: bool" in verifier
    assert "candidate_validity_coverage: &'static str" in verifier
    assert '"native_enforced"' in verifier
    assert '"structural_only"' in verifier
    assert '"mixed"' in verifier

    assert 'const CANDIDATE_VALIDITY_PROTOCOL = "candidate-validity-v1"' in plugin
    assert '"candidate_language_invalid"' in plugin
    assert 'id: "candidate_validity_barrier"' in plugin
    assert '"candidate_validator_unavailable"' not in plugin
    assert '"candidate_validator_timeout"' not in plugin
    assert '"candidate_validator_failed"' not in plugin
    assert 'const SEARCH_PROTOCOL = "search-v2.18.1-capability-hardening"' in plugin

    assert spec["protocol"] == "candidate-validity-v1"
    assert spec["registered_validators"] == {"python": "python3-compile-v1"}
    inv = spec["invariants"]
    assert inv["target_source_executed"] is False
    assert inv["validator_uses_shell"] is False
    assert inv["compiler_early_barrier_replace_node"] is True
    assert inv["verifier_final_barrier_all_changed_files"] is True
    assert inv["invalid_registered_candidate_can_verify"] is False
    assert inv["model_calls_added"] == 0
    assert inv["scout_semantics_changed"] is False
    assert inv["executor_authority_changed"] is False
    print("PASS static candidate-validity architecture")

def main() -> None:
    static_gate()
    for binary in (COMPILER, EXECUTOR, VERIFIER):
        assert binary.is_file(), f"missing {binary}; run cargo build --bins"

    with tempfile.TemporaryDirectory(prefix="v2191-validity-") as td:
        root = Path(td)
        original = (
            "def normalize(value):\n"
            "    value = value.strip()\n"
            "    value = value.lower()\n"
            "    return value\n"
        )
        source = init_repo(root, original)
        handoff = write_handoff(root, source, target_symbol="normalize")
        before = "value = value.strip()\n    value = value.lower()"

        valid_mutation = mutation(
            "normalize",
            before,
            "value = value.strip()\nvalue = value.upper()",
        )
        valid = run_json(COMPILER, compiler_request(root, handoff, valid_mutation))
        assert valid.get("ok") is True, valid
        assert len(valid.get("edits") or []) == 1, valid
        valid_edit = valid["edits"][0]
        assert valid_edit["confinement"]["envelope"] == "siblings", valid_edit
        print("PASS compiler admits native-valid bounded siblings candidate")

        bad_mutation = mutation(
            "normalize",
            before,
            "value = value.strip()\n    value = value.upper()",
        )
        rejected = run_json(COMPILER, compiler_request(root, handoff, bad_mutation))
        assert rejected.get("ok") is False, rejected
        assert rejected.get("reason") == "candidate_language_invalid", rejected
        print("PASS compiler blocks tree-sitter-tolerated invalid Python")

        executed_valid = run_json(
            EXECUTOR,
            executor_request(root, handoff, valid["edits"], valid.get("checks")),
        )
        assert executed_valid.get("admitted") is True, executed_valid
        verified_valid = run_json(
            VERIFIER,
            verifier_request(
                root,
                handoff,
                executed_valid["patch"],
                valid_mutation,
                valid["changed_files"],
                valid["edits"],
            ),
        )
        assert verified_valid.get("ok") is True, verified_valid
        check = barrier_check(verified_valid)
        assert check["pass"] is True, check
        assert "status=valid" in (check.get("detail") or ""), check
        assert "validator=python3-compile-v1" in (check.get("detail") or ""), check
        assert "coverage=native_enforced" in (check.get("detail") or ""), check
        assert verified_valid.get("candidate_validity_coverage") == "native_enforced", verified_valid
        print("PASS verifier independently accepts native-valid Python with native coverage")

        # Simulate compiler bypass/tamper while retaining a valid certificate.
        forged_edit = copy.deepcopy(valid_edit)
        valid_after = forged_edit["after"]
        forged_after = valid_after.replace(
            "\n    value = value.upper()",
            "\n        value = value.upper()",
            1,
        )
        assert forged_after != valid_after, (valid_after, forged_after)
        forged_edit["after"] = forged_after

        executed_bad = run_json(
            EXECUTOR,
            executor_request(root, handoff, [forged_edit]),
        )
        assert executed_bad.get("admitted") is True, executed_bad
        assert git(root, "diff", "--quiet").returncode == 0

        verified_bad = run_json(
            VERIFIER,
            verifier_request(
                root,
                handoff,
                executed_bad["patch"],
                bad_mutation,
                [forged_edit["file"]],
                [forged_edit],
            ),
        )
        assert verified_bad.get("ok") is False, verified_bad
        assert verified_bad.get("candidate_validity_barrier") is False, verified_bad

        bad_check = barrier_check(verified_bad)
        assert bad_check["pass"] is False, bad_check
        detail = bad_check.get("detail") or ""
        assert "protocol=candidate-validity-v1" in detail, bad_check
        assert "validator=python3-compile-v1" in detail, bad_check
        assert "status=invalid" in detail, bad_check
        assert "coverage=native_enforced" in detail, bad_check
        assert verified_bad.get("candidate_validity_coverage") == "native_enforced", verified_bad

        confinement = [
            c for c in verified_bad.get("checks", [])
            if c.get("kind") == "replace_node_confinement"
        ]
        assert len(confinement) == 1 and confinement[0]["pass"] is True, confinement
        print("PASS verifier blocks forged invalid candidate after confinement passes")

    module = (ROOT / "rust/evidence-distiller/src/candidate_validity.rs").read_text()
    assert "typed_exit_contract_separates_language_invalid_from_backend_failure" in module
    assert 'candidate_validator_failed' in module
    print("PASS typed validator failure is not classified as semantic invalidity")
    print("PASS v2.19.1 Deterministic Candidate Validity Barrier R2")

if __name__ == "__main__":
    main()
