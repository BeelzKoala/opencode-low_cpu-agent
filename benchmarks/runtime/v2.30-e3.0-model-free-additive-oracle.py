#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / "rust" / "evidence-distiller"

BINS = {
    "compiler": "opencode-patch-compiler",
    "executor": "opencode-patch-executor",
    "verifier": "opencode-invariant-verifier",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def run(cmd: list[str], *, cwd: Path | None = None, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def must_run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    proc = run(cmd, cwd=cwd)
    if proc.returncode != 0:
        raise AssertionError(
            f"command failed rc={proc.returncode}: {' '.join(cmd)}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )
    return proc


def resolve_bin(name: str) -> Path:
    env_name = f"OPENCODE_E30_{name.upper()}_BIN"
    if os.environ.get(env_name):
        path = Path(os.environ[env_name]).expanduser().resolve()
        if not path.is_file():
            raise AssertionError(f"{env_name} is not a file: {path}")
        return path

    binary = BINS[name]
    candidates = [
        RUST / "target" / "debug" / binary,
        RUST / "target" / "release" / binary,
        Path.home() / ".local" / "bin" / binary,
    ]
    for path in candidates:
        if path.is_file():
            return path.resolve()

    raise AssertionError(
        f"{binary} unavailable; build first:\n"
        f"cargo build --manifest-path {RUST / 'Cargo.toml'} "
        f"--bin opencode-patch-compiler "
        f"--bin opencode-patch-executor "
        f"--bin opencode-invariant-verifier"
    )


def invoke_json(binary: Path, payload: dict) -> dict:
    proc = run([str(binary)], input_text=json.dumps(payload))
    if proc.returncode != 0:
        raise AssertionError(
            f"{binary.name} transport failed rc={proc.returncode}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )
    try:
        value = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"{binary.name} returned invalid JSON: {exc}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        ) from exc
    if not isinstance(value, dict):
        raise AssertionError(f"{binary.name} returned non-object JSON")
    return value


def init_repo(root: Path) -> tuple[str, str]:
    server = (
        "from pathlib import Path\n"
        "\n"
        "\n"
        "def existing_route():\n"
        '    return "ok"\n'
    )
    nav = '<nav><a href="/">Home</a></nav>\n'

    (root / "templates").mkdir(parents=True)
    (root / "server.py").write_text(server, encoding="utf-8")
    (root / "templates" / "nav.html").write_text(nav, encoding="utf-8")
    (root / ".gitignore").write_text(".opencode/\n", encoding="utf-8")

    must_run(["git", "init", "-q"], cwd=root)
    must_run(["git", "config", "user.email", "oracle@example.invalid"], cwd=root)
    must_run(["git", "config", "user.name", "E3 Oracle"], cwd=root)
    must_run(["git", "add", "."], cwd=root)
    must_run(["git", "commit", "-qm", "baseline"], cwd=root)

    return server, nav


def write_handoff(root: Path) -> str:
    server_sha = sha256_file(root / "server.py")
    nav_sha = sha256_file(root / "templates" / "nav.html")

    rel = ".opencode/scout-handoffs/e3-model-free-oracle.json"
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)

    handoff = {
        "protocol": "scout-handoff-v1",
        "search_protocol": "model-free-oracle-v1",
        "status": "ready",
        "blocking_reasons": [],
        "partial_reasons": [],
        "scope_mode": "additive_mutation_capability",
        "capability_protocol": "scout-additive-capability-v1",
        "allowed_mutations": ["replace_exact", "create_file"],
        "additive_capability": {
            "protocol": "scout-additive-capability-v1",
            "operation": "additive_surface",
            "existing_slots": [
                {
                    "slot": "existing:0",
                    "file": "server.py",
                    "sha256": server_sha,
                    "evidence_lines": [4],
                    "allowed_operations": ["replace_exact"],
                },
                {
                    "slot": "existing:1",
                    "file": "templates/nav.html",
                    "sha256": nav_sha,
                    "evidence_lines": [1],
                    "allowed_operations": ["replace_exact"],
                },
            ],
            "create_slots": [
                {
                    "slot": "create:0",
                    "root": "templates",
                    "source_file": "templates/nav.html",
                    "source_sha256": nav_sha,
                    "allowed_extensions": [".html"],
                    "max_depth": 1,
                    "allowed_operations": ["create_file"],
                }
            ],
        },
        "files": [
            {
                "file": "server.py",
                "evidence_lines": [4],
                "fingerprint": {
                    "kind": "sha256",
                    "strong": True,
                    "sha256": server_sha,
                    "evidence_fresh": True,
                },
            },
            {
                "file": "templates/nav.html",
                "evidence_lines": [1],
                "fingerprint": {
                    "kind": "sha256",
                    "strong": True,
                    "sha256": nav_sha,
                    "evidence_fresh": True,
                },
            },
        ],
    }

    target.write_text(json.dumps(handoff, indent=2) + "\n", encoding="utf-8")
    return rel


def mutations(server_before: str, nav_before: str) -> list[dict]:
    server_after = (
        server_before
        + "\n"
        + "def export_report(start: str, end: str):\n"
        + '    query = "SELECT id FROM records WHERE created_at >= %s AND created_at < %s"\n'
        + "    params = (start, end)\n"
        + '    return {"query": query, "params": params}\n'
    )
    nav_after = (
        '<nav><a href="/">Home</a>'
        '<a href="/reports">Reports</a></nav>\n'
    )

    return [
        {
            "file": "server.py",
            "kind": "replace_exact",
            "symbol": "<additive>",
            "before": server_before,
            "replacement": server_after,
        },
        {
            "file": "templates/nav.html",
            "kind": "replace_exact",
            "symbol": "<additive>",
            "before": nav_before,
            "replacement": nav_after,
        },
        {
            "file": "templates/reports.html",
            "kind": "create_file",
            "symbol": "<additive>",
            "content": (
                "<!doctype html>\n"
                "<html><body><h1>Reports</h1></body></html>\n"
            ),
        },
    ]


def assert_clean_baseline(root: Path, server_sha: str, nav_sha: str) -> None:
    assert sha256_file(root / "server.py") == server_sha
    assert sha256_file(root / "templates" / "nav.html") == nav_sha
    assert not (root / "templates" / "reports.html").exists()

    status = must_run(
        ["git", "status", "--short", "--untracked-files=all"],
        cwd=root,
    ).stdout
    # .opencode is ignored; the committed baseline must remain untouched.
    assert status.strip() == "", status


def main() -> int:
    compiler_bin = resolve_bin("compiler")
    executor_bin = resolve_bin("executor")
    verifier_bin = resolve_bin("verifier")

    parent = Path(tempfile.mkdtemp(prefix="opencode-e30-oracle-"))
    root = parent / "repo"
    root.mkdir()

    try:
        server_before, nav_before = init_repo(root)
        server_sha = sha256_file(root / "server.py")
        nav_sha = sha256_file(root / "templates" / "nav.html")
        handoff = write_handoff(root)
        plan = mutations(server_before, nav_before)

        compiler = invoke_json(
            compiler_bin,
            {
                "root": str(root),
                "handoff": handoff,
                "mutation_protocol": "mutation-plan-v1",
                "mutations": plan,
            },
        )
        assert compiler.get("protocol") == "patch-compiler-v2", compiler
        assert compiler.get("ok") is True, compiler
        assert compiler.get("reason") is None, compiler
        assert compiler.get("mutations_requested") == 3, compiler
        assert compiler.get("mutations_effective") == 3, compiler
        assert compiler.get("lowered_edits") == 3, compiler
        assert set(compiler.get("changed_files", [])) == {
            "server.py",
            "templates/nav.html",
            "templates/reports.html",
        }, compiler

        assert_clean_baseline(root, server_sha, nav_sha)

        executor = invoke_json(
            executor_bin,
            {
                "root": str(root),
                "handoff": handoff,
                "mode": "guarded",
                "edit_protocol": compiler["edit_protocol"],
                "edits": compiler["edits"],
                "checks": compiler["checks"],
            },
        )
        assert executor.get("protocol") == "patch-executor-v3", executor
        assert executor.get("admitted") is True, executor
        assert executor.get("reason") is None, executor
        assert executor.get("worktree_used") is True, executor
        assert executor.get("worktree_cleaned") is True, executor
        assert executor.get("repo_mutated") is False, executor
        assert isinstance(executor.get("patch"), str) and executor["patch"], executor

        assert_clean_baseline(root, server_sha, nav_sha)

        verifier = invoke_json(
            verifier_bin,
            {
                "root": str(root),
                "handoff": handoff,
                "patch": executor["patch"],
                "compiler_protocol": compiler["protocol"],
                "mutation_protocol": compiler["mutation_protocol"],
                "mutations": plan,
                "changed_files": compiler["changed_files"],
                "edits": compiler["edits"],
            },
        )
        assert verifier.get("protocol") == "invariant-verifier-v2", verifier
        assert verifier.get("ok") is True, verifier
        assert verifier.get("verdict") == "PASS", verifier
        assert verifier.get("invariants_failed") == 0, verifier
        assert verifier.get("changed_file_set") is True, verifier
        assert verifier.get("replay_exact") is True, verifier
        assert verifier.get("candidate_hygiene") is True, verifier
        assert verifier.get("top_level_conservation") is True, verifier
        assert verifier.get("worktree_cleaned") is True, verifier

        assert_clean_baseline(root, server_sha, nav_sha)

        print(
            "PASS E3.0 model-free additive oracle "
            "handoff->compiler->executor->verifier"
        )
        print(
            "PASS E3.0 additive Python growth preserves baseline "
            "top-level sequence"
        )
        print(
            "PASS E3.0 isolated executor/verifier leave baseline repo untouched"
        )
        print(
            "ORACLE "
            f"compiler_edits={compiler.get('lowered_edits')} "
            f"changed_files={len(compiler.get('changed_files', []))} "
            f"patch_bytes={executor.get('patch_bytes')} "
            f"invariants={verifier.get('invariants_total')}"
        )
        return 0
    finally:
        shutil.rmtree(parent, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
