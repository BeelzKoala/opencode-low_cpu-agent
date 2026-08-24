#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
RUST = REPO / "rust" / "evidence-distiller"
TARGET = RUST / "target" / "debug"
COMPILER = TARGET / "opencode-patch-compiler"
EXECUTOR = TARGET / "opencode-patch-executor"
VERIFIER = TARGET / "opencode-invariant-verifier"
PLUGIN = REPO / "opencode" / "plugins" / "cpu-search.ts"


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


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def write_handoff(
    root: Path,
    name: str,
    *,
    status: str,
    partial: list[str],
    scope_mode: str | None = None,
    capability_protocol: str | None = None,
    allowed_mutations: list[str] | None = None,
    files: list[dict],
) -> str:
    rel = f".opencode/scout-handoffs/{name}.json"
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "protocol": "scout-handoff-v1",
        "search_protocol": "search-v2.18.1-capability-hardening",
        "status": status,
        "blocking_reasons": [],
        "partial_reasons": partial,
        "files": files,
    }
    if scope_mode is not None:
        body["scope_mode"] = scope_mode
    if capability_protocol is not None:
        body["capability_protocol"] = capability_protocol
    if allowed_mutations is not None:
        body["allowed_mutations"] = allowed_mutations
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return rel


def replace_node_mutation() -> dict:
    return {
        "file": "single.py",
        "kind": "replace_node",
        "symbol": "calculate",
        "before": "return 1",
        "replacement": "return 2",
    }


def rename_mutation() -> dict:
    return {
        "file": "single.py",
        "kind": "rename_symbol",
        "symbol": "calculate",
        "new_name": "compute",
    }


def compiler_request(root: Path, handoff: str, mutation: dict) -> dict:
    return {
        "root": str(root),
        "handoff": handoff,
        "mutation_protocol": "mutation-plan-v1",
        "mutations": [mutation],
    }


def static_plugin_gate() -> None:
    s = PLUGIN.read_text(encoding="utf-8")

    assert 'SCOUT_OWNER_ATTESTATION_PROTOCOL = "owner-attestation-v1"' in s
    assert 'SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS = Object.freeze(["replace_node"])' in s
    assert 'allowed_mutations: [...SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS]' in s
    assert 'owner_attestation: ownerAttestation' in s
    assert 'ownerEvidenceDistance(line, target) <= EDIT_CAPSULE_WINDOW_RADIUS' in s

    start = s.index("function buildOwnerAttestation(")
    end = s.index("\nfunction ownerRecoveryResponseSafe", start)
    owner = s[start:end]
    assert "line_owner_recovery" not in owner
    assert "sameAuthorizedScopeIdentity" in owner
    assert "structural_owner_certificate" in owner

    start = s.index("async function confirmLocalMutationCompetitors(")
    end = s.index("\nasync function attestLocalMutationCapability(", start)
    competitor = s[start:end]
    overflow = competitor.index(
        "candidates.length > SCOUT_LOCAL_CAPABILITY_MAX_COMPETITOR_FILES"
    )
    empty = competitor.index("candidates.length < 1")
    assert overflow < empty
    overflow_block = competitor[overflow:empty]
    assert '"competitor_budget_exceeded"' in overflow_block
    assert "return reject(" in overflow_block

    print("PASS plugin generic owner certificate + fail-closed competitor cap")


def main() -> None:
    static_plugin_gate()

    for binary in (COMPILER, EXECUTOR, VERIFIER):
        assert binary.is_file(), f"missing {binary}; run cargo build --bins"

    with tempfile.TemporaryDirectory(prefix="v218-hardening-") as td:
        root = Path(td)
        source = root / "single.py"
        source.write_text("def calculate():\n    return 1\n", encoding="utf-8")
        other = root / "other.py"
        other.write_text("def unrelated():\n    return 9\n", encoding="utf-8")

        assert git(root, "init", "-q").returncode == 0
        assert git(root, "config", "user.email", "gate@example.invalid").returncode == 0
        assert git(root, "config", "user.name", "Capability Gate").returncode == 0
        assert git(root, "add", "single.py", "other.py").returncode == 0
        assert git(root, "commit", "-qm", "baseline").returncode == 0

        file_entry = {
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

        other_entry = {
            "file": "other.py",
            "origins": ["lexical"],
            "evidence_lines": [1],
            "fingerprint": {
                "kind": "sha256",
                "strong": True,
                "sha256": sha256(other),
                "evidence_fresh": True,
                "witnesses_checked": 1,
            },
            "changed_during_scout": False,
        }

        partial = write_handoff(
            root,
            "global-partial",
            status="partial",
            partial=["evidence_incomplete"],
            files=[file_entry],
        )
        local = write_handoff(
            root,
            "capabilities/local",
            status="ready",
            partial=[],
            scope_mode="local_mutation_capability",
            capability_protocol="scout-local-capability-v1",
            allowed_mutations=["replace_node"],
            files=[file_entry],
        )
        malformed = write_handoff(
            root,
            "capabilities/malformed",
            status="ready",
            partial=[],
            scope_mode="local_mutation_capability",
            capability_protocol="scout-local-capability-v1",
            allowed_mutations=["rename_symbol"],
            files=[file_entry],
        )
        multi_file = write_handoff(
            root,
            "capabilities/multi-file",
            status="ready",
            partial=[],
            scope_mode="local_mutation_capability",
            capability_protocol="scout-local-capability-v1",
            allowed_mutations=["replace_node"],
            files=[file_entry, other_entry],
        )

        row = run_json(COMPILER, compiler_request(root, partial, replace_node_mutation()))
        assert row.get("ok") is False and row.get("reason") == "handoff_not_ready", row
        print("PASS global partial handoff remains rejected")

        row = run_json(COMPILER, compiler_request(root, malformed, rename_mutation()))
        assert row.get("ok") is False and row.get("reason") == "local_capability_invalid", row
        print("PASS malformed local capability rejected")

        row = run_json(COMPILER, compiler_request(root, local, rename_mutation()))
        assert row.get("ok") is False and row.get("reason") == "mutation_not_authorized_by_handoff", row
        print("PASS compiler rejects rename through local capability")

        row = run_json(COMPILER, compiler_request(root, multi_file, replace_node_mutation()))
        assert row.get("ok") is False and row.get("reason") == "local_capability_invalid", row
        print("PASS compiler rejects multi-file local capability")

        compiled = run_json(COMPILER, compiler_request(root, local, replace_node_mutation()))
        assert compiled.get("ok") is True, compiled
        assert compiled.get("changed_files") == ["single.py"], compiled
        assert len(compiled.get("edits") or []) == 1, compiled
        print("PASS compiler accepts bounded replace_node")

        executor_rejected = run_json(
            EXECUTOR,
            {
                "root": str(root),
                "handoff": malformed,
                "mode": "guarded",
                "edit_protocol": "edit-script-v2",
                "edits": compiled["edits"],
                "checks": compiled.get("checks") or [],
            },
        )
        assert executor_rejected.get("admitted") is False, executor_rejected
        assert executor_rejected.get("reason") == "local_capability_invalid", executor_rejected
        print("PASS executor rejects malformed local capability")

        executed = run_json(
            EXECUTOR,
            {
                "root": str(root),
                "handoff": local,
                "mode": "guarded",
                "edit_protocol": "edit-script-v2",
                "edits": compiled["edits"],
                "checks": compiled.get("checks") or [],
            },
        )
        assert executed.get("admitted") is True, executed
        patch = executed.get("patch")
        assert isinstance(patch, str) and patch, executed
        assert git(root, "diff", "--quiet").returncode == 0
        print("PASS executor accepts one-file local capability in isolated worktree")

        verified = run_json(
            VERIFIER,
            {
                "root": str(root),
                "handoff": local,
                "patch": patch,
                "compiler_protocol": "patch-compiler-v1",
                "mutation_protocol": "mutation-plan-v1",
                "mutations": [replace_node_mutation()],
                "changed_files": compiled["changed_files"],
                "edits": compiled["edits"],
            },
        )
        assert verified.get("ok") is True, verified
        print("PASS verifier accepts authorized replace_node")

        malformed_verify = run_json(
            VERIFIER,
            {
                "root": str(root),
                "handoff": malformed,
                "patch": patch,
                "compiler_protocol": "patch-compiler-v1",
                "mutation_protocol": "mutation-plan-v1",
                "mutations": [replace_node_mutation()],
                "changed_files": compiled["changed_files"],
                "edits": compiled["edits"],
            },
        )
        assert malformed_verify.get("ok") is False, malformed_verify
        assert malformed_verify.get("reason") == "local_capability_invalid", malformed_verify
        print("PASS verifier rejects malformed local capability")

        forbidden = run_json(
            VERIFIER,
            {
                "root": str(root),
                "handoff": local,
                "patch": patch,
                "compiler_protocol": "patch-compiler-v1",
                "mutation_protocol": "mutation-plan-v1",
                "mutations": [rename_mutation()],
                "changed_files": compiled["changed_files"],
                "edits": compiled["edits"],
            },
        )
        assert forbidden.get("ok") is False, forbidden
        assert forbidden.get("reason") == "mutation_not_authorized_by_handoff", forbidden
        print("PASS verifier independently rejects unauthorized rename")

    print("PASS v2.18 capability hardening gate")


if __name__ == "__main__":
    main()
