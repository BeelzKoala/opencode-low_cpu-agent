#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / "rust" / "evidence-distiller"
TARGET = RUST / "target" / "debug"
COMPILER = TARGET / "opencode-patch-compiler"
EXECUTOR = TARGET / "opencode-patch-executor"
VERIFIER = TARGET / "opencode-invariant-verifier"
PLUGIN = ROOT / "opencode" / "plugins" / "cpu-search.ts"

COMPILER_PROTOCOL = "patch-compiler-v2"
EXECUTOR_PROTOCOL = "patch-executor-v3"
VERIFIER_PROTOCOL = "invariant-verifier-v2"
EDIT_PROTOCOL = "edit-script-v3-certified-slice"
MUTATION_PROTOCOL = "mutation-plan-v1"
CONFINEMENT_PROTOCOL = "mutation-slice-v1"


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


def init_repo(root: Path, source_text: str, *, newline: str | None = None) -> Path:
    source = root / "single.py"
    if newline is None:
        source.write_text(source_text, encoding="utf-8")
    else:
        source.write_bytes(source_text.replace("\n", newline).encode("utf-8"))
    assert git(root, "init", "-q").returncode == 0
    assert git(root, "config", "user.email", "gate@example.invalid").returncode == 0
    assert git(root, "config", "user.name", "Mutation Slice Gate").returncode == 0
    assert git(root, "add", "single.py").returncode == 0
    assert git(root, "commit", "-qm", "baseline").returncode == 0
    return source


def write_handoff(
    root: Path,
    source: Path,
    *,
    evidence_lines: list[int] | None = None,
    target_symbol: str = "calculate",
) -> str:
    rel = ".opencode/scout-handoffs/capabilities/local.json"
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "protocol": "scout-handoff-v1",
        "search_protocol": "search-v2.18.1-capability-hardening",
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
                "symbol_name": target_symbol,
            },
        },
        "files": [
            {
                "file": "single.py",
                "origins": ["lexical"],
                "evidence_lines": evidence_lines or [1],
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
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
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


def executor_request(root: Path, handoff: str, edits: list[dict], checks: list[dict] | None = None) -> dict:
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
    plugin = PLUGIN.read_text(encoding="utf-8")
    compiler = (RUST / "src" / "patch_compiler.rs").read_text(encoding="utf-8")
    executor = (RUST / "src" / "patch_executor.rs").read_text(encoding="utf-8")
    verifier = (RUST / "src" / "invariant_verifier.rs").read_text(encoding="utf-8")

    assert 'const AGENT_PROTOCOL = "cpu-agent-v2.8.0-mutation-confinement-2"' in plugin
    assert f'const PATCH_COMPILER_PROTOCOL = "{COMPILER_PROTOCOL}"' in plugin
    assert f'const PATCH_EXECUTOR_PROTOCOL = "{EXECUTOR_PROTOCOL}"' in plugin
    assert f'const PATCH_EDIT_PROTOCOL = "{EDIT_PROTOCOL}"' in plugin
    assert f'const INVARIANT_VERIFIER_PROTOCOL = "{VERIFIER_PROTOCOL}"' in plugin
    assert 'id: "replace_node_confinement"' in plugin
    assert "before is a canonical exact source slice, never a pattern" in plugin
    assert 'const SEARCH_PROTOCOL = "search-v2.18.1-capability-hardening"' in plugin
    assert 'const MAX_PATCH_ATTEMPTS_PER_TURN = 2' in plugin
    assert 'target_fields_forbidden_capability_bound' in plugin
    assert 'SCOUT_LOCAL_CAPABILITY_MAX_COMPETITOR_FILES = 4' in plugin

    c_start = compiler.index("fn compile_replace_node(")
    c_end = compiler.index("\nfn valid_ascii_identifier", c_start)
    c_block = compiler[c_start:c_end]
    assert "Pattern::try_new" not in c_block
    assert "exact_slice_range" in c_block
    assert "structural_slice_envelope" in c_block
    assert 'kind: "replace_slice".to_string()' in c_block
    assert "owner_start: owner_range.start" in c_block
    assert "start_byte: slice_range.start" in c_block
    assert f'MUTATION_CONFINEMENT_PROTOCOL: &str = "{CONFINEMENT_PROTOCOL}"' in compiler

    assert '"replace_slice"' in executor
    assert "slice_precondition_mismatch" in executor
    assert "slice_owner_mismatch" in executor
    assert "certified_owner_matches" in executor
    assert "local_capability_allows_edit" in executor
    assert "capability.target.symbol_name" in executor

    assert "verify_replace_node_confinement" in verifier
    assert 'kind: "replace_node_confinement".to_string()' in verifier
    assert "compiled_replacement_mismatch" in verifier
    assert "slice_certificate_orphaned" in verifier
    assert "capability.target.symbol_name == mutation.symbol" in verifier
    assert "capability.target.symbol_name == mutation.symbol" in compiler
    assert "mutation_slice_transaction_unsupported" in compiler
    assert "mutation_slice_transaction_unsupported" in executor
    assert "mutation_slice_transaction_unsupported" in verifier

    print("PASS static Mutation Confinement 2.0 contract")


def main() -> None:
    static_gate()
    for binary in (COMPILER, EXECUTOR, VERIFIER):
        assert binary.is_file(), f"missing {binary}; run cargo build --bins"

    with tempfile.TemporaryDirectory(prefix="v219-mc2-main-") as td:
        root = Path(td)
        original = "def calculate():\n    first()\n    second()\n    keep_tail()\n"
        source = init_repo(root, original)
        handoff = write_handoff(root, source)

        wrong_target = write_handoff(root, source, target_symbol="other")
        row = run_json(
            COMPILER,
            compiler_request(root, wrong_target, mutation("calculate", "first()", "guarded()")),
        )
        assert row.get("ok") is False, row
        assert row.get("reason") == "mutation_not_authorized_by_handoff", row
        print("PASS local capability target owner is bound downstream")

        handoff = write_handoff(root, source)
        multi_payload = compiler_request(
            root,
            handoff,
            mutation("calculate", "first()", "guarded()"),
        )
        multi_payload["mutations"] = [
            mutation("calculate", "first()", "guarded()"),
            mutation("calculate", "second()", "second_guarded()"),
        ]
        row = run_json(COMPILER, multi_payload)
        assert row.get("ok") is False, row
        assert row.get("reason") == "mutation_slice_transaction_unsupported", row
        print("PASS multiple baseline-relative slices in one file fail closed")

        partial_owner = mutation(
            "calculate",
            "def calculate():\n    first()",
            "def calculate():\n    guarded()",
        )
        row = run_json(COMPILER, compiler_request(root, handoff, partial_owner))
        assert row.get("ok") is False, row
        assert row.get("reason") == "mutation_slice_not_structural", row
        print("PASS partial owner prefix cannot escalate to whole-owner edit")

        explicit_owner = mutation(
            "calculate",
            original.rstrip("\n"),
            "def calculate():\n    guarded()\n    second()\n    keep_tail()",
        )
        row = run_json(COMPILER, compiler_request(root, handoff, explicit_owner))
        assert row.get("ok") is True, row
        owner_edit = row["edits"][0]
        assert owner_edit["kind"] == "replace_slice", owner_edit
        assert owner_edit["confinement"]["envelope"] == "owner", owner_edit
        assert owner_edit["before"] == original.rstrip("\n"), owner_edit
        print("PASS exact full-owner replacement remains explicitly available")

        siblings = mutation(
            "calculate",
            "first()\n    second()",
            "guarded()\nsecond()",
        )
        row = run_json(COMPILER, compiler_request(root, handoff, siblings))
        assert row.get("ok") is True, row
        assert row["edits"][0]["confinement"]["envelope"] == "siblings", row
        assert "keep_tail()" not in row["edits"][0]["before"], row
        print("PASS bounded contiguous sibling slice is supported")

        child = mutation("calculate", "first()", "guarded()\nfirst()")
        compiled = run_json(COMPILER, compiler_request(root, handoff, child))
        assert compiled.get("ok") is True, compiled
        assert compiled.get("protocol") == COMPILER_PROTOCOL, compiled
        assert compiled.get("edit_protocol") == EDIT_PROTOCOL, compiled
        assert len(compiled.get("edits") or []) == 1, compiled
        edit = compiled["edits"][0]
        assert edit["kind"] == "replace_slice", edit
        assert edit["before"] == "first()", edit
        assert "keep_tail()" not in edit["before"], edit
        assert edit["confinement"]["protocol"] == CONFINEMENT_PROTOCOL, edit
        print("PASS compiler emits certified physical slice without owner promotion")

        wrong_target = write_handoff(root, source, target_symbol="other")
        rejected = run_json(
            EXECUTOR,
            executor_request(root, wrong_target, compiled["edits"], compiled.get("checks")),
        )
        assert rejected.get("admitted") is False, rejected
        assert rejected.get("reason") == "mutation_not_authorized_by_handoff", rejected
        print("PASS executor independently binds certified slice to capability target owner")
        handoff = write_handoff(root, source)

        tampered = copy.deepcopy(edit)
        tampered["confinement"]["start_byte"] = 0
        tampered["confinement"]["end_byte"] = len(tampered["before"])
        rejected = run_json(EXECUTOR, executor_request(root, handoff, [tampered]))
        assert rejected.get("admitted") is False, rejected
        assert rejected.get("reason") in {
            "slice_precondition_mismatch",
            "slice_certificate_invalid",
        }, rejected
        print("PASS executor rejects offset/precondition certificate tamper")

        executed = run_json(
            EXECUTOR,
            executor_request(root, handoff, compiled["edits"], compiled.get("checks")),
        )
        assert executed.get("protocol") == EXECUTOR_PROTOCOL, executed
        assert executed.get("admitted") is True, executed
        patch = executed.get("patch")
        assert isinstance(patch, str) and patch, executed
        assert edit["before"] == "first()", edit
        assert git(root, "diff", "--quiet").returncode == 0
        print("PASS executor applies certified slice only in isolated worktree")

        wrong_target = write_handoff(root, source, target_symbol="other")
        forbidden_verify = run_json(
            VERIFIER,
            verifier_request(
                root,
                wrong_target,
                patch,
                child,
                compiled["changed_files"],
                compiled["edits"],
            ),
        )
        assert forbidden_verify.get("ok") is False, forbidden_verify
        assert forbidden_verify.get("reason") == "mutation_not_authorized_by_handoff", forbidden_verify
        print("PASS verifier independently binds semantic mutation to capability target owner")
        handoff = write_handoff(root, source)

        verified = run_json(
            VERIFIER,
            verifier_request(
                root,
                handoff,
                patch,
                child,
                compiled["changed_files"],
                compiled["edits"],
            ),
        )
        assert verified.get("protocol") == VERIFIER_PROTOCOL, verified
        assert verified.get("ok") is True, verified
        confinement_checks = [
            x for x in verified.get("checks", [])
            if x.get("kind") == "replace_node_confinement"
        ]
        assert len(confinement_checks) == 1, verified
        assert confinement_checks[0].get("pass") is True, verified
        print("PASS verifier independently re-derives mutation slice")

        owner_before = original.rstrip("\n")
        malicious_after = "def calculate():\n    guarded()"
        malicious_edit = {
            "file": "single.py",
            "kind": "replace_slice",
            "before": owner_before,
            "after": malicious_after,
            "confinement": {
                "protocol": CONFINEMENT_PROTOCOL,
                "mutation_index": 0,
                "owner_symbol": "calculate",
                "owner_start": 0,
                "owner_end": len(owner_before),
                "start_byte": 0,
                "end_byte": len(owner_before),
                "envelope": "owner",
            },
        }
        malicious_exec = run_json(
            EXECUTOR,
            executor_request(root, handoff, [malicious_edit]),
        )
        assert malicious_exec.get("admitted") is True, malicious_exec
        malicious_patch = malicious_exec.get("patch")
        assert isinstance(malicious_patch, str) and malicious_patch, malicious_exec

        malicious_verify = run_json(
            VERIFIER,
            verifier_request(
                root,
                handoff,
                malicious_patch,
                child,
                ["single.py"],
                [malicious_edit],
            ),
        )
        assert malicious_verify.get("ok") is False, malicious_verify
        confinement_checks = [
            x for x in malicious_verify.get("checks", [])
            if x.get("kind") == "replace_node_confinement"
        ]
        assert len(confinement_checks) == 1, malicious_verify
        assert confinement_checks[0].get("pass") is False, malicious_verify
        print("PASS verifier rejects compiler/edit promotion inconsistent with mutation intent")

    with tempfile.TemporaryDirectory(prefix="v219-mc2-ambiguous-") as td:
        root = Path(td)
        source = init_repo(
            root,
            "def duplicate(flag):\n"
            "    if flag:\n"
            "        return 1\n"
            "    return 1\n",
        )
        handoff = write_handoff(root, source, target_symbol="duplicate")
        item = mutation("duplicate", "return 1", "return 2")
        row = run_json(COMPILER, compiler_request(root, handoff, item))
        assert row.get("ok") is False, row
        assert row.get("reason") == "mutation_slice_ambiguous", row
        print("PASS duplicate exact slice requires bounded repair, not guessing")

    with tempfile.TemporaryDirectory(prefix="v219-mc2-mixed-eol-") as td:
        root = Path(td)
        source = root / "single.py"
        source.write_bytes(b"def calculate():\r\n    first()\n    keep_tail()\r\n")
        assert git(root, "init", "-q").returncode == 0
        assert git(root, "config", "user.email", "gate@example.invalid").returncode == 0
        assert git(root, "config", "user.name", "Mutation Slice Gate").returncode == 0
        assert git(root, "add", "single.py").returncode == 0
        assert git(root, "commit", "-qm", "baseline").returncode == 0
        handoff = write_handoff(root, source)
        item = mutation("calculate", "first()", "guarded()")
        row = run_json(COMPILER, compiler_request(root, handoff, item))
        assert row.get("ok") is False, row
        assert row.get("reason") == "mutation_source_eol_mixed", row
        print("PASS mixed-EOL replace_node fails closed without repair budget inflation")

    with tempfile.TemporaryDirectory(prefix="v219-mc2-crlf-") as td:
        root = Path(td)
        source = init_repo(
            root,
            "def calculate():\n    return 1\n",
            newline="\r\n",
        )
        handoff = write_handoff(root, source)
        item = mutation("calculate", "return 1", "if ready:\n    return 2")
        compiled = run_json(COMPILER, compiler_request(root, handoff, item))
        assert compiled.get("ok") is True, compiled
        edit = compiled["edits"][0]
        assert "\r\n" in edit["after"], edit
        executed = run_json(
            EXECUTOR,
            executor_request(root, handoff, compiled["edits"], compiled.get("checks")),
        )
        assert executed.get("admitted") is True, executed
        verified = run_json(
            VERIFIER,
            verifier_request(
                root,
                handoff,
                executed["patch"],
                item,
                compiled["changed_files"],
                compiled["edits"],
            ),
        )
        assert verified.get("ok") is True, verified
        print("PASS LF model fragment compiles safely against CRLF baseline")

    print("PASS v2.19 Mutation Confinement 2.0 gate")


if __name__ == "__main__":
    main()
