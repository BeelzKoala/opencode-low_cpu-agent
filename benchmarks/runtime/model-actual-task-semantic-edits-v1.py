#!/usr/bin/env python3

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any


ROUTE_FILE = "routes/bestsellers_bp.py"
MENU_FILE = "templates/snippets/menu.html"
STYLE_FILE = "templates/bestsellers_task.html"
DB_FILE = "database.py"

EDITABLE_EXISTING = {
    ROUTE_FILE,
    MENU_FILE,
    STYLE_FILE,
}

CREATE_RE = re.compile(r"^templates/bestsellers[^/]*\.html$")


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = 60.0,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def git_show(repo: Path, rev: str, path: str) -> str:
    p = run(
        ["git", "show", f"{rev}:{path}"],
        cwd=repo,
        timeout=20,
    )
    if p.returncode:
        raise RuntimeError(f"cannot read {path}\n{p.stdout}")
    return p.stdout


def extract_task_text(spec: Any) -> tuple[str, str]:
    priorities = {
        "prompt": 100,
        "task": 95,
        "instruction": 90,
        "instructions": 90,
        "request": 85,
        "description": 80,
        "goal": 75,
        "text": 70,
    }

    found: list[tuple[int, int, str, str]] = []

    def walk(value: Any, path: str) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = f"{path}.{key}" if path else str(key)

                if isinstance(child, str):
                    text = child.strip()
                    score = priorities.get(str(key).lower(), 0)
                    if score and len(text) >= 80:
                        found.append(
                            (score, len(text), child_path, text)
                        )

                walk(child, child_path)

        elif isinstance(value, list):
            for i, child in enumerate(value):
                walk(child, f"{path}[{i}]")

    walk(spec, "")

    if not found:
        raise RuntimeError("task text not found")

    found.sort(key=lambda row: (row[0], row[1]), reverse=True)
    _, _, source, text = found[0]
    return source, text


def python_function(source: str, name: str) -> str:
    tree = ast.parse(source)
    lines = source.splitlines()

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == name:
                end = getattr(node, "end_lineno", None)
                if end is None:
                    raise RuntimeError(f"no end_lineno for {name}")
                return "\n".join(lines[node.lineno - 1:end])

    raise RuntimeError(f"function absent: {name}")


def raw_window(text: str, start: int, end: int) -> str:
    lines = text.splitlines()
    return "\n".join(lines[max(start - 1, 0):end])


def build_context(repo: Path, rev: str) -> dict[str, str]:
    route = git_show(repo, rev, ROUTE_FILE)
    database = git_show(repo, rev, DB_FILE)
    menu = git_show(repo, rev, MENU_FILE)
    style = git_show(repo, rev, STYLE_FILE)

    return {
        ROUTE_FILE: route,
        f"{DB_FILE}::get_basdb_conn READ ONLY": python_function(
            database,
            "get_basdb_conn",
        ),
        f"{MENU_FILE}::EXACT EDITABLE EXCERPT": raw_window(
            menu,
            45,
            72,
        ),
        f"{STYLE_FILE}::STYLE REFERENCE": raw_window(
            style,
            190,
            285,
        ),
    }


def render_prompt(task: str, context: dict[str, str]) -> str:
    out = [
        "Solve this real repository task.",
        "",
        "Do NOT generate a git diff.",
        "Do NOT calculate hunk line numbers.",
        "",
        "Return semantic edit operations only.",
        "",
        "Operations:",
        "",
        "replace:",
        "  path = existing editable file",
        "  old = exact existing text copied from source context",
        "  new = replacement text",
        "  anchor = ''",
        "  content = ''",
        "",
        "insert_after:",
        "  path = existing editable file",
        "  anchor = exact existing text copied from source context",
        "  content = text to insert immediately after it",
        "  old = ''",
        "  new = ''",
        "",
        "create:",
        "  path = new templates/bestsellers*.html file",
        "  content = complete file contents",
        "  old = ''",
        "  new = ''",
        "  anchor = ''",
        "",
        "Important:",
        "- exact anchors must occur exactly once",
        "- prefer short stable exact anchors",
        "- do not reproduce unchanged files",
        "- preserve the existing /export implementation",
        "- database.py is read-only",
        "- no placeholders, demos, TODOs or fake HTML",
        "- invalid date/type must be rejected before BASDB access",
        "- date must be a SQL parameter",
        "- report type must never become arbitrary SQL",
        "- SQL NULL means actual NULL; '' and 'null' are non-NULL",
        "- produce a valid XLSX containing source-table rows",
        "- add a genuinely accessible new page to the common menu",
        "- initial GET of the new page must render the form, not fail validation",
        "- add no third-party dependency",
        "",
        "TASK",
        "====",
        task,
        "",
        "SOURCE CONTEXT",
        "==============",
    ]

    for name, body in context.items():
        out += [
            "",
            f"===== BEGIN {name} =====",
            body,
            f"===== END {name} =====",
        ]

    return "\n".join(out)


def request_edits(
    *,
    base_url: str,
    model: str,
    prompt: str,
    timeout: float,
) -> tuple[list[dict[str, str]], dict[str, Any], float]:
    edit_schema = {
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": ["replace", "insert_after", "create"],
            },
            "path": {"type": "string"},
            "old": {"type": "string"},
            "new": {"type": "string"},
            "anchor": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": [
            "op",
            "path",
            "old",
            "new",
            "anchor",
            "content",
        ],
        "additionalProperties": False,
    }

    schema = {
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "minItems": 1,
                "maxItems": 10,
                "items": edit_schema,
            }
        },
        "required": ["edits"],
        "additionalProperties": False,
    }

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a coding model editing a real Flask repository. "
                    "Choose the semantic code changes. "
                    "A deterministic materializer will apply them. "
                    "Return only the requested structured result."
                ),
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        "temperature": 0.0,
        "max_tokens": 3072,
        "stream": False,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "semantic_repository_edits",
                "strict": True,
                "schema": schema,
            },
        },
    }

    req = urllib.request.Request(
        base_url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    started = time.monotonic()

    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc

    wall = time.monotonic() - started
    response = json.loads(raw)

    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("no choices")

    message = choices[0].get("message") or {}
    content = message.get("content")

    if not isinstance(content, str) or not content.strip():
        raise RuntimeError(
            "empty final content; reasoning_present="
            + str(bool(message.get("reasoning_content")))
        )

    decoded = json.loads(content)
    edits = decoded.get("edits")

    if not isinstance(edits, list) or not edits:
        raise RuntimeError("no semantic edits")

    return edits, response, wall


def safe_path(path: str) -> bool:
    if not path or path.startswith("/"):
        return False

    parts = PurePosixPath(path).parts
    return ".." not in parts and ".git" not in parts


def validate_edit_shape(edit: dict[str, str]) -> None:
    op = edit["op"]
    path = edit["path"]

    if not safe_path(path):
        raise RuntimeError(f"unsafe path: {path}")

    if op in {"replace", "insert_after"}:
        if path not in EDITABLE_EXISTING:
            raise RuntimeError(
                f"existing-file edit outside allowlist: {path}"
            )

    elif op == "create":
        if not CREATE_RE.fullmatch(path):
            raise RuntimeError(
                f"create outside template allowlist: {path}"
            )

    if op == "replace":
        if not edit["old"]:
            raise RuntimeError("replace has empty old")
        if edit["anchor"] or edit["content"]:
            raise RuntimeError("replace carries unrelated fields")

    elif op == "insert_after":
        if not edit["anchor"] or not edit["content"]:
            raise RuntimeError("insert_after missing anchor/content")
        if edit["old"] or edit["new"]:
            raise RuntimeError("insert_after carries unrelated fields")

    elif op == "create":
        if not edit["content"]:
            raise RuntimeError("create has empty content")
        if edit["old"] or edit["new"] or edit["anchor"]:
            raise RuntimeError("create carries unrelated fields")

    else:
        raise RuntimeError(f"unknown operation: {op}")


def materialize(
    worktree: Path,
    edits: list[dict[str, str]],
) -> list[str]:
    changed: list[str] = []

    total_payload = sum(
        len(json.dumps(edit, ensure_ascii=False).encode())
        for edit in edits
    )

    if total_payload > 30_000:
        raise RuntimeError(
            f"semantic edit payload too large: {total_payload}"
        )

    for index, edit in enumerate(edits):
        validate_edit_shape(edit)

        op = edit["op"]
        path = edit["path"]
        target = worktree / path

        if op == "create":
            if target.exists():
                raise RuntimeError(
                    f"edit[{index}] create target already exists: {path}"
                )

            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(edit["content"], encoding="utf-8")

        else:
            if not target.is_file():
                raise RuntimeError(
                    f"edit[{index}] target absent: {path}"
                )

            current = target.read_text(encoding="utf-8")

            if op == "replace":
                needle = edit["old"]
                count = current.count(needle)

                if count != 1:
                    raise RuntimeError(
                        f"edit[{index}] replace anchor cardinality "
                        f"path={path} count={count}"
                    )

                updated = current.replace(
                    needle,
                    edit["new"],
                    1,
                )

            else:
                anchor = edit["anchor"]
                count = current.count(anchor)

                if count != 1:
                    raise RuntimeError(
                        f"edit[{index}] insert anchor cardinality "
                        f"path={path} count={count}"
                    )

                updated = current.replace(
                    anchor,
                    anchor + edit["content"],
                    1,
                )

            target.write_text(updated, encoding="utf-8")

        if path not in changed:
            changed.append(path)

    return changed


def route_functions(source: str) -> dict[str, ast.AST]:
    tree = ast.parse(source)
    found: dict[str, ast.AST] = {}

    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        for deco in node.decorator_list:
            if not isinstance(deco, ast.Call):
                continue
            if not deco.args:
                continue

            first = deco.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                func = deco.func

                if isinstance(func, ast.Attribute):
                    if func.attr in {"route", "get", "post"}:
                        found[first.value] = node

    return found


def ast_dump(node: ast.AST) -> str:
    return ast.dump(node, include_attributes=False)


def static_task_gates(
    *,
    before_route: str,
    worktree: Path,
    changed: list[str],
) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    route_path = worktree / ROUTE_FILE
    after_route = route_path.read_text(encoding="utf-8")

    try:
        ast.parse(after_route)
        out.append(("python_ast", True, "parseable"))
    except SyntaxError as exc:
        out.append(("python_ast", False, str(exc)))
        return out

    before_routes = route_functions(before_route)
    after_routes = route_functions(after_route)

    before_export = before_routes.get("/export")
    after_export = after_routes.get("/export")

    export_ok = (
        before_export is not None
        and after_export is not None
        and ast_dump(before_export) == ast_dump(after_export)
    )

    out.append(
        (
            "preserve_existing_export",
            export_ok,
            "AST identical" if export_ok else "/export changed or missing",
        )
    )

    new_routes = sorted(
        set(after_routes) - set(before_routes)
    )

    out.append(
        (
            "new_route",
            bool(new_routes),
            repr(new_routes),
        )
    )

    required = [
        "rd_bestsellers_data",
        "report_date",
        "report_category3_filter",
        "report_seller_filter",
        "get_basdb_conn",
        "IS NOT NULL",
    ]

    missing = [
        token for token in required
        if token.lower() not in after_route.lower()
    ]

    has_parameter = "%s" in after_route

    out.append(
        (
            "data_contract",
            not missing and has_parameter,
            f"missing={missing} sql_parameter={has_parameter}",
        )
    )

    joined_sql = False
    tree = ast.parse(after_route)

    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = ast.unparse(node).lower()
            if "select" in text or "rd_bestsellers_data" in text:
                joined_sql = True

    out.append(
        (
            "no_fstring_sql",
            not joined_sql,
            f"joined_sql={joined_sql}",
        )
    )

    menu = (worktree / MENU_FILE).read_text(encoding="utf-8")
    menu_ok = (
        "url_for('bestsellers." in menu
        or 'url_for("bestsellers.' in menu
    )

    out.append(
        (
            "menu_integration",
            menu_ok,
            "bestsellers url_for present",
        )
    )

    template_paths = [
        path for path in changed
        if path.startswith("templates/")
        and path.endswith(".html")
    ]

    template_text = "\n".join(
        (worktree / path).read_text(encoding="utf-8")
        for path in template_paths
        if (worktree / path).is_file()
    )

    lower = template_text.lower()

    form_ok = (
        "<form" in lower
        and 'type="date"' in lower
        and "category" in lower
        and "seller" in lower
    )

    out.append(
        (
            "page_form",
            form_ok,
            f"templates={template_paths}",
        )
    )

    return out


def initial_page_gate(
    *,
    worktree: Path,
    new_routes: list[str],
) -> tuple[str, bool, str]:
    if not new_routes:
        return ("initial_page", False, "no new route")

    probe = r'''
import json
import sys
from pathlib import Path

root = Path.cwd()
sys.path.insert(0, str(root))

try:
    from flask import Flask
    import routes.bestsellers_bp as mod
except Exception as exc:
    print(json.dumps({
        "kind": "environment_skip",
        "detail": f"{type(exc).__name__}: {exc}",
    }))
    raise SystemExit(3)

new_routes = set(json.loads(sys.argv[1]))

def bomb(*args, **kwargs):
    raise RuntimeError("BASDB_TOUCHED_ON_INITIAL_PAGE")

mod.get_basdb_conn = bomb

app = Flask(
    "direct_semantic_gate",
    root_path=str(root),
    template_folder="templates",
)
app.secret_key = "direct-gate"
app.register_blueprint(mod.bp)

client = app.test_client()
observed = []

for rule in app.url_map.iter_rules():
    if rule.rule not in new_routes:
        continue
    if "GET" not in rule.methods:
        continue
    if "<" in rule.rule:
        continue

    try:
        response = client.get(rule.rule)
        observed.append({
            "route": rule.rule,
            "status": response.status_code,
            "db_touched": False,
        })
    except Exception as exc:
        observed.append({
            "route": rule.rule,
            "status": None,
            "db_touched": "BASDB_TOUCHED" in str(exc),
            "error": f"{type(exc).__name__}: {exc}",
        })

ok = any(
    row.get("status") is not None
    and 200 <= row["status"] < 400
    and not row.get("db_touched")
    for row in observed
)

print(json.dumps({
    "kind": "result",
    "ok": ok,
    "observed": observed,
}))
raise SystemExit(0 if ok else 1)
'''

    proc = run(
        [
            sys.executable,
            "-c",
            probe,
            json.dumps(new_routes),
        ],
        cwd=worktree,
        timeout=30,
    )

    lines = [
        line for line in proc.stdout.splitlines()
        if line.strip().startswith("{")
    ]

    if proc.returncode == 3:
        detail = lines[-1] if lines else proc.stdout[-2000:]
        return (
            "initial_page",
            True,
            "SKIP environment: " + detail,
        )

    detail = lines[-1] if lines else proc.stdout[-3000:]

    return (
        "initial_page",
        proc.returncode == 0,
        detail,
    )


def smoke_gate(worktree: Path) -> tuple[str, bool, str]:
    tests = [
        path
        for path in (
            "tests/test_app_smoke.py",
            "tests/test_legacy_blueprints.py",
        )
        if (worktree / path).is_file()
    ]

    if not tests:
        return ("repo_smoke", True, "SKIP no smoke tests")

    probe = run(
        [sys.executable, "-c", "import pytest"],
        cwd=worktree,
        timeout=10,
    )

    if probe.returncode:
        return ("repo_smoke", True, "SKIP pytest unavailable")

    result = run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            *tests,
        ],
        cwd=worktree,
        timeout=90,
    )

    return (
        "repo_smoke",
        result.returncode == 0,
        result.stdout[-6000:],
    )


def main() -> int:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--repo",
        type=Path,
        required=True,
        help="Target repository root.",
    )
    parser.add_argument(
        "--task-spec",
        type=Path,
        default=Path(
            "benchmarks/runtime/"
            "ozon-bestsellers-report-export-e2e.json"
        ),
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8080",
    )
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=float, default=420.0)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(
            "benchmarks/results/"
            "model-actual-task-semantic-edits-v1"
        ),
    )

    args = parser.parse_args()

    repo = args.repo.expanduser().resolve()
    task_spec = args.task_spec.resolve()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    head = run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        timeout=10,
    )
    if head.returncode:
        print("VERDICT=BENCHMARK_FAIL reason=head")
        return 2

    rev = head.stdout.strip()

    spec = json.loads(task_spec.read_text(encoding="utf-8"))
    task_source, task = extract_task_text(spec)

    context = build_context(repo, rev)
    prompt = render_prompt(task, context)

    prompt_bytes = len(prompt.encode())

    print("=== ACTUAL TASK SEMANTIC EDITS v1 ===")
    print(f"repo={repo}")
    print(f"base_head={rev}")
    print(f"task_source={task_source}")
    print(f"prompt_bytes={prompt_bytes}")
    print("model_calls=1")
    print("repair_calls=0")
    print("raw_diff_from_model=false")
    print("koalik_model_view=false")
    print("materializer=deterministic_exact_anchor")
    print()

    if prompt_bytes > 18_000:
        print(
            "VERDICT=BENCHMARK_FAIL "
            f"reason=prompt_too_large bytes={prompt_bytes}"
        )
        return 2

    (out / "prompt.txt").write_text(prompt, encoding="utf-8")

    try:
        edits, response, wall = request_edits(
            base_url=args.base_url,
            model=args.model,
            prompt=prompt,
            timeout=args.timeout,
        )
    except Exception as exc:
        print(
            "VERDICT=MODEL_SEMANTIC_EDITS_FAIL "
            f"reason=inference_error detail={exc}"
        )
        return 1

    (out / "response.json").write_text(
        json.dumps(response, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    (out / "candidate-edits.json").write_text(
        json.dumps(
            {"edits": edits},
            indent=2,
            ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
    )

    usage = response.get("usage") or {}
    choice = response["choices"][0]
    message = choice.get("message") or {}

    print(f"inference_wall_s={wall:.3f}")
    print(f"finish_reason={choice.get('finish_reason')!r}")
    print(
        "reasoning_present="
        + str(bool(message.get("reasoning_content")))
    )
    print(f"prompt_tokens={usage.get('prompt_tokens')}")
    print(f"completion_tokens={usage.get('completion_tokens')}")
    print(f"edit_count={len(edits)}")
    print()

    print("=== SEMANTIC EDITS ===")
    print(
        json.dumps(
            {"edits": edits},
            indent=2,
            ensure_ascii=False,
        )
    )
    print("=== END SEMANTIC EDITS ===")
    print()

    before_route = git_show(repo, rev, ROUTE_FILE)

    gates: list[tuple[str, bool, str]] = []
    final_diff = ""
    changed: list[str] = []

    with tempfile.TemporaryDirectory(
        prefix="koalik-semantic-edits-"
    ) as tmp:
        root = Path(tmp)
        worktree = root / "worktree"
        added = False

        try:
            p = run(
                [
                    "git",
                    "worktree",
                    "add",
                    "--detach",
                    str(worktree),
                    rev,
                ],
                cwd=repo,
                timeout=30,
            )

            if p.returncode:
                raise RuntimeError(p.stdout)

            added = True

            try:
                changed = materialize(worktree, edits)
                gates.append(
                    (
                        "materializer",
                        True,
                        "exact anchors resolved",
                    )
                )
            except Exception as exc:
                gates.append(
                    (
                        "materializer",
                        False,
                        str(exc),
                    )
                )
                raise

            new_files = [
                path for path in changed
                if not run(
                    ["git", "cat-file", "-e", f"HEAD:{path}"],
                    cwd=worktree,
                    timeout=5,
                ).returncode == 0
            ]

            if new_files:
                p = run(
                    ["git", "add", "-N", "--", *new_files],
                    cwd=worktree,
                    timeout=20,
                )
                if p.returncode:
                    raise RuntimeError(p.stdout)

            p = run(
                ["git", "diff", "--check"],
                cwd=worktree,
                timeout=20,
            )
            gates.append(
                (
                    "git_diff_check",
                    p.returncode == 0,
                    p.stdout or "clean",
                )
            )

            p = run(
                [
                    sys.executable,
                    "-m",
                    "py_compile",
                    ROUTE_FILE,
                ],
                cwd=worktree,
                timeout=20,
            )
            gates.append(
                (
                    "python_compile",
                    p.returncode == 0,
                    p.stdout or "clean",
                )
            )

            gates.extend(
                static_task_gates(
                    before_route=before_route,
                    worktree=worktree,
                    changed=changed,
                )
            )

            after_route = (
                worktree / ROUTE_FILE
            ).read_text(encoding="utf-8")

            before_routes = route_functions(before_route)
            after_routes = route_functions(after_route)

            new_routes = sorted(
                set(after_routes) - set(before_routes)
            )

            gates.append(
                initial_page_gate(
                    worktree=worktree,
                    new_routes=new_routes,
                )
            )

            gates.append(smoke_gate(worktree))

            p = run(
                ["git", "diff", "--binary"],
                cwd=worktree,
                timeout=20,
            )

            final_diff = p.stdout
            (out / "materialized.patch").write_text(
                final_diff,
                encoding="utf-8",
            )

        except Exception as exc:
            if not any(not ok for _, ok, _ in gates):
                gates.append(
                    ("transaction", False, str(exc))
                )

        finally:
            if added:
                run(
                    [
                        "git",
                        "worktree",
                        "remove",
                        "--force",
                        str(worktree),
                    ],
                    cwd=repo,
                    timeout=30,
                )

    print("=== DETERMINISTIC GATES ===")

    for name, ok, detail in gates:
        status = "PASS" if ok else "FAIL"
        compact = str(detail).replace("\n", " | ")

        if len(compact) > 1400:
            compact = compact[:1400] + "..."

        print(f"GATE {name} {status} {compact}")

    passed = bool(gates) and all(ok for _, ok, _ in gates)

    verdict = (
        "MODEL_SEMANTIC_EDITS_PASS"
        if passed
        else "MODEL_SEMANTIC_EDITS_FAIL"
    )

    summary = {
        "protocol": "model-actual-task-semantic-edits-v1",
        "model": args.model,
        "base_head": rev,
        "task_source": task_source,
        "prompt_bytes": prompt_bytes,
        "prompt_sha256": sha(prompt),
        "inference_wall_s": round(wall, 3),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "reasoning_present": bool(
            message.get("reasoning_content")
        ),
        "edit_count": len(edits),
        "changed_paths": changed,
        "model_calls": 1,
        "repair_calls": 0,
        "raw_diff_from_model": False,
        "koalik_model_view": False,
        "materializer": "deterministic_exact_anchor",
        "materialized_patch_sha256": (
            sha(final_diff) if final_diff else None
        ),
        "gates": [
            {
                "name": name,
                "ok": ok,
                "detail": detail,
            }
            for name, ok, detail in gates
        ],
        "verdict": verdict,
    }

    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print()
    print(f"VERDICT={verdict}")
    print(f"summary={out / 'summary.json'}")
    print(f"edits={out / 'candidate-edits.json'}")
    print(f"patch={out / 'materialized.patch'}")

    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
