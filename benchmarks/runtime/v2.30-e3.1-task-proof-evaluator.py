#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
EVALUATOR = ROOT / "opencode/plugins/cpu-search-core/task-proof-evaluator-v1.py"


def run(args, *, cwd=None, stdin=None):
    return subprocess.run(
        args,
        cwd=cwd,
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def must(args, *, cwd=None):
    proc = run(args, cwd=cwd)
    if proc.returncode != 0:
        raise AssertionError(
            f"failed {' '.join(args)}\n{proc.stdout}\n{proc.stderr}"
        )
    return proc


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def obligation(oid: str, checker: str) -> dict:
    return {
        "protocol": "task-proof-obligation-v1",
        "id": oid,
        "checker": checker,
        "disposition": "fatal",
        "source_kind": "oracle",
        "source_value": oid,
        "mutation_authority": False,
    }


def main() -> int:
    parent = Path(tempfile.mkdtemp(prefix="opencode-e31-oracle-"))
    root = parent / "repo"
    root.mkdir()

    try:
        (root / "templates").mkdir()
        server_before = (
            "def existing_route():\n"
            '    return "ok"\n'
        )
        nav_before = '<nav><a href="/">Home</a></nav>\n'

        (root / "server.py").write_text(server_before, encoding="utf-8")
        (root / "templates/nav.html").write_text(nav_before, encoding="utf-8")
        (root / ".gitignore").write_text(".opencode/\n", encoding="utf-8")

        must(["git", "init", "-q"], cwd=root)
        must(["git", "config", "user.email", "oracle@example.invalid"], cwd=root)
        must(["git", "config", "user.name", "E3.1 Oracle"], cwd=root)
        must(["git", "add", "."], cwd=root)
        must(["git", "commit", "-qm", "baseline"], cwd=root)

        server_after = (
            server_before
            + "\n"
            + "def export_report(start: str, end: str, report_type: str):\n"
            + '    if report_type not in ("summary", "detail"):\n'
            + '        return {"error": "invalid report type"}\n'
            + "    try:\n"
            + '        parsed_start = datetime.strptime(start, "%Y-%m-%d")\n'
            + "    except (ValueError, TypeError):\n"
            + '        return {"error": "invalid start"}\n'
            + '    query = "SELECT id FROM records WHERE created_at >= %s AND created_at < %s"\n'
            + "    params = (start, end)\n"
            + "    cursor.execute(query, params)\n"
            + '    return send_file(BytesIO(b"report"), download_name="report.csv")\n'
        )
        nav_after = (
            '<nav><a href="/">Home</a>'
            '<a href="/reports">Reports</a></nav>\n'
        )
        page = (
            "<!doctype html>\n"
            "<html><body><h1>Reports</h1></body></html>\n"
        )

        wt_parent = parent / "wt"
        add = run(
            ["git", "worktree", "add", "--detach", str(wt_parent), "HEAD"],
            cwd=root,
        )
        assert add.returncode == 0, add.stderr
        (wt_parent / "server.py").write_text(server_after, encoding="utf-8")
        (wt_parent / "templates/nav.html").write_text(nav_after, encoding="utf-8")
        (wt_parent / "templates/reports.html").write_text(page, encoding="utf-8")
        must(["git", "add", "-N", "--", "templates/reports.html"], cwd=wt_parent)

        patch = must(
            [
                "git", "diff", "--binary", "--no-ext-diff",
                "--", "server.py", "templates/nav.html", "templates/reports.html",
            ],
            cwd=wt_parent,
        ).stdout

        run(["git", "worktree", "remove", "--force", str(wt_parent)], cwd=root)

        request = {
            "root": str(root),
            "patch": patch,
            "changed_files": [
                "server.py",
                "templates/nav.html",
                "templates/reports.html",
            ],
            "mutations": [
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
                    "content": page,
                },
            ],
            "structural_verifier": {
                "protocol": "invariant-verifier-v2",
                "ok": True,
                "verdict": "PASS",
                "top_level_conservation": True,
            },
            "obligations": [
                obligation(
                    "server_surface_present",
                    "mutation_obligation_server_surface",
                ),
                obligation(
                    "ui_surface_present",
                    "mutation_obligation_ui_surface",
                ),
                obligation(
                    "navigation_integration_present",
                    "mutation_obligation_navigation",
                ),
                obligation(
                    "data_access_present",
                    "candidate_ast_data_access",
                ),
                obligation(
                    "output_artifact_present",
                    "candidate_ast_output_artifact",
                ),
                obligation(
                    "existing_behavior_conserved",
                    "additive_top_level_conservation",
                ),
                obligation(
                    "no_new_dependencies",
                    "dependency_closure_no_new_external",
                ),
                obligation(
                    "parameterized_data_query",
                    "candidate_ast_query_parameterization",
                ),
                obligation(
                    "input_validation_present",
                    "candidate_ast_input_validation",
                ),
                obligation(
                    "closed_choice_input",
                    "candidate_ast_closed_choice",
                ),
            ],
        }

        proc = run(
            ["python3", str(EVALUATOR)],
            stdin=json.dumps(request),
        )
        assert proc.returncode == 0, proc.stderr
        response = json.loads(proc.stdout)

        assert response["protocol"] == "task-proof-evaluator-v1", response
        assert response["ok"] is True, json.dumps(response, indent=2)
        assert response["verdict"] == "PASS", response
        assert response["checks_failed"] == 0, response
        assert response["baseline_clean_before"] is True, response
        assert response["baseline_clean_after"] is True, response

        ids = {row["id"] for row in response["checks"] if row["pass"]}
        for required in {
            "server_surface_present",
            "ui_surface_present",
            "navigation_integration_present",
            "data_access_present",
            "output_artifact_present",
            "existing_behavior_conserved",
            "no_new_dependencies",
            "parameterized_data_query",
            "input_validation_present",
            "closed_choice_input",
            "baseline_repo_unchanged",
        }:
            assert required in ids, (required, response)

        # Negative proof: interpolation must not be accepted as parameterized.
        unsafe_server = server_after.replace(
            'query = "SELECT id FROM records WHERE created_at >= %s AND created_at < %s"',
            'query = f"SELECT id FROM records WHERE created_at >= {start} AND created_at < {end}"',
        )
        wt_unsafe = parent / "unsafe-wt"
        add = run(
            ["git", "worktree", "add", "--detach", str(wt_unsafe), "HEAD"],
            cwd=root,
        )
        assert add.returncode == 0, add.stderr
        (wt_unsafe / "server.py").write_text(unsafe_server, encoding="utf-8")
        (wt_unsafe / "templates/nav.html").write_text(nav_after, encoding="utf-8")
        (wt_unsafe / "templates/reports.html").write_text(page, encoding="utf-8")
        must(["git", "add", "-N", "--", "templates/reports.html"], cwd=wt_unsafe)
        unsafe_patch = must(
            [
                "git", "diff", "--binary", "--no-ext-diff",
                "--", "server.py", "templates/nav.html", "templates/reports.html",
            ],
            cwd=wt_unsafe,
        ).stdout
        run(["git", "worktree", "remove", "--force", str(wt_unsafe)], cwd=root)

        unsafe_request = dict(request)
        unsafe_request["patch"] = unsafe_patch
        unsafe_request["mutations"] = [
            {
                **request["mutations"][0],
                "replacement": unsafe_server,
            },
            *request["mutations"][1:],
        ]

        proc = run(
            ["python3", str(EVALUATOR)],
            stdin=json.dumps(unsafe_request),
        )
        unsafe = json.loads(proc.stdout)
        assert unsafe["ok"] is False, unsafe
        parameterized = [
            row
            for row in unsafe["checks"]
            if row["id"] == "parameterized_data_query"
        ]
        assert len(parameterized) == 1
        assert parameterized[0]["pass"] is False

        print(
            "PASS E3.1 generic task-proof evaluator "
            "proves 8 obligation classes"
        )
        print(
            "PASS E3.1 parameterized-query checker rejects "
            "input-derived interpolation"
        )
        print(
            "PASS E3.1 task proof candidate worktree leaves baseline clean"
        )
        print(
            f"TASK_PROOF checks={response['checks_total']} "
            f"passed={response['checks_passed']} failed={response['checks_failed']}"
        )
        return 0
    finally:
        # Remove any surviving worktrees before deleting the temp root.
        run(["git", "worktree", "prune"], cwd=root) if root.exists() else None
        shutil.rmtree(parent, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
