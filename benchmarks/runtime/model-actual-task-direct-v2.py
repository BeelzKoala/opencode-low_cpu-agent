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
DB_FILE = "database.py"
MENU_FILE = "templates/snippets/menu.html"
TEMPLATE_FILE = "templates/bestsellers_task.html"

EDITABLE_EXACT = {
    ROUTE_FILE,
    MENU_FILE,
    TEMPLATE_FILE,
}

NEW_TEMPLATE_RE = re.compile(
    r"^templates/bestsellers[^/]*\.html$"
)

DIFF_PATH_RE = re.compile(
    r"^diff --git a/(.+?) b/(.+?)$",
    re.MULTILINE,
)


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
    return hashlib.sha256(
        text.encode("utf-8")
    ).hexdigest()


def git_show(
    repo: Path,
    revision: str,
    path: str,
) -> str:
    proc = run(
        [
            "git",
            "show",
            f"{revision}:{path}",
        ],
        cwd=repo,
        timeout=20,
    )

    if proc.returncode != 0:
        raise RuntimeError(
            f"cannot read {path}\n{proc.stdout}"
        )

    return proc.stdout


def extract_task_text(
    spec: Any,
) -> tuple[str, str]:
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

    found: list[
        tuple[int, int, str, str]
    ] = []

    def walk(
        value: Any,
        path: str,
    ) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = (
                    f"{path}.{key}"
                    if path
                    else str(key)
                )

                if isinstance(child, str):
                    text = child.strip()
                    score = priorities.get(
                        str(key).lower(),
                        0,
                    )

                    if (
                        score
                        and len(text) >= 80
                    ):
                        found.append(
                            (
                                score,
                                len(text),
                                child_path,
                                text,
                            )
                        )

                walk(
                    child,
                    child_path,
                )

        elif isinstance(value, list):
            for index, child in enumerate(
                value
            ):
                walk(
                    child,
                    f"{path}[{index}]",
                )

    walk(spec, "")

    if not found:
        raise RuntimeError(
            "task text not found"
        )

    found.sort(
        key=lambda row: (
            row[0],
            row[1],
        ),
        reverse=True,
    )

    _, _, source, text = found[0]
    return source, text


def line_window(
    text: str,
    *,
    start: int,
    end: int,
) -> str:
    lines = text.splitlines()

    lo = max(
        1,
        start,
    )
    hi = min(
        len(lines),
        end,
    )

    selected = lines[
        lo - 1 : hi
    ]

    return "\n".join(
        f"{line_no:04d}: {line}"
        for line_no, line in enumerate(
            selected,
            start=lo,
        )
    )


def extract_python_function(
    source: str,
    name: str,
) -> str:
    tree = ast.parse(
        source
    )

    lines = source.splitlines()

    for node in tree.body:
        if (
            isinstance(
                node,
                (
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                ),
            )
            and node.name == name
        ):
            end_lineno = getattr(
                node,
                "end_lineno",
                None,
            )

            if end_lineno is None:
                raise RuntimeError(
                    f"AST end_lineno absent for {name}"
                )

            return "\n".join(
                lines[
                    node.lineno - 1 :
                    end_lineno
                ]
            )

    raise RuntimeError(
        f"function not found: {name}"
    )


def compact_context(
    *,
    repo: Path,
    revision: str,
) -> dict[str, str]:
    route = git_show(
        repo,
        revision,
        ROUTE_FILE,
    )

    database = git_show(
        repo,
        revision,
        DB_FILE,
    )

    menu = git_show(
        repo,
        revision,
        MENU_FILE,
    )

    template = git_show(
        repo,
        revision,
        TEMPLATE_FILE,
    )

    return {
        ROUTE_FILE: route,
        f"{DB_FILE}::get_basdb_conn": (
            extract_python_function(
                database,
                "get_basdb_conn",
            )
        ),
        f"{MENU_FILE}::relevant_window": (
            line_window(
                menu,
                start=45,
                end=72,
            )
        ),
        f"{TEMPLATE_FILE}::relevant_window": (
            line_window(
                template,
                start=190,
                end=285,
            )
        ),
    }


def render_prompt(
    *,
    task: str,
    context: dict[str, str],
) -> str:
    parts = [
        "Solve this repository task directly.",
        "",
        "You are given a compact set of source excerpts "
        "already selected by a developer.",
        "",
        "Produce ONE normal unified git diff.",
        "",
        "Constraints:",
        "- solve the complete business task",
        "- preserve existing /export behavior",
        "- do not modify database.py",
        "- do not add third-party dependencies",
        "- no placeholders, demos, TODOs, pseudo-code, "
        "or incomplete HTML",
        "- SQL date must be parameterized",
        "- report type must not become arbitrary SQL",
        "- invalid date/type must be rejected before BASDB access",
        "- SQL NULL means actual SQL NULL; empty string and "
        "literal 'null' remain non-NULL",
        "- XLSX must contain source-table rows",
        "- integrate the new page into the existing common menu",
        "",
        "Allowed edits:",
        f"- {ROUTE_FILE}",
        f"- {MENU_FILE}",
        f"- {TEMPLATE_FILE}",
        "- a new templates/bestsellers*.html file if useful",
        "",
        "The supplied source excerpts are authoritative.",
        "Do not invent unrelated repository APIs.",
        "",
        "TASK",
        "====",
        task,
        "",
        "SOURCE CONTEXT",
        "==============",
    ]

    for label, text in context.items():
        parts.extend(
            [
                "",
                f"===== BEGIN {label} =====",
                text,
                f"===== END {label} =====",
            ]
        )

    return "\n".join(
        parts
    )


def request_patch(
    *,
    base_url: str,
    model: str,
    prompt: str,
    timeout: float,
) -> tuple[
    str,
    dict[str, Any],
    float,
]:
    schema = {
        "type": "object",
        "properties": {
            "patch": {
                "type": "string",
                "minLength": 1,
            },
        },
        "required": ["patch"],
        "additionalProperties": False,
    }

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a coding model editing a real "
                    "Python/Flask repository. Solve the task "
                    "from the supplied source context. Return "
                    "only the requested structured result."
                ),
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        "temperature": 0.0,
        "max_tokens": 4096,
        "stream": False,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "direct_repository_patch_v2",
                "strict": True,
                "schema": schema,
            },
        },
    }

    req = urllib.request.Request(
        base_url.rstrip("/")
        + "/v1/chat/completions",
        data=json.dumps(
            payload
        ).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
        },
        method="POST",
    )

    started = time.monotonic()

    try:
        with urllib.request.urlopen(
            req,
            timeout=timeout,
        ) as response:
            raw = response.read().decode(
                "utf-8"
            )

    except urllib.error.HTTPError as exc:
        body = exc.read().decode(
            "utf-8",
            errors="replace",
        )
        raise RuntimeError(
            f"HTTP {exc.code}: {body}"
        ) from exc

    wall = (
        time.monotonic()
        - started
    )

    result = json.loads(
        raw
    )

    choices = result.get(
        "choices"
    )

    if (
        not isinstance(
            choices,
            list,
        )
        or not choices
    ):
        raise RuntimeError(
            "response contains no choices"
        )

    message = (
        choices[0].get(
            "message"
        )
        or {}
    )

    content = message.get(
        "content"
    )

    if (
        not isinstance(
            content,
            str,
        )
        or not content.strip()
    ):
        raise RuntimeError(
            "empty final content; "
            "reasoning_present="
            + str(
                bool(
                    message.get(
                        "reasoning_content"
                    )
                )
            )
        )

    decoded = json.loads(
        content
    )

    patch = decoded.get(
        "patch"
    )

    if (
        not isinstance(
            patch,
            str,
        )
        or not patch.strip()
    ):
        raise RuntimeError(
            "structured result contains no patch"
        )

    return (
        patch,
        result,
        wall,
    )


def normalize_patch(
    patch: str,
) -> str:
    text = patch.strip()

    if text.startswith(
        "```"
    ):
        lines = (
            text.splitlines()
        )

        lines = lines[1:]

        if (
            lines
            and lines[-1].strip()
            == "```"
        ):
            lines = lines[:-1]

        text = "\n".join(
            lines
        ).strip()

    if not text.endswith(
        "\n"
    ):
        text += "\n"

    return text


def patch_paths(
    patch: str,
) -> list[str]:
    return list(
        dict.fromkeys(
            match.group(2)
            for match in DIFF_PATH_RE.finditer(
                patch
            )
        )
    )


def safe_path(
    path: str,
) -> bool:
    if (
        not path
        or path.startswith("/")
    ):
        return False

    parts = PurePosixPath(
        path
    ).parts

    return (
        ".." not in parts
        and ".git" not in parts
    )


def allowed_path(
    path: str,
) -> bool:
    return (
        path in EDITABLE_EXACT
        or bool(
            NEW_TEMPLATE_RE.fullmatch(
                path
            )
        )
    )


def surface_gate(
    patch: str,
) -> tuple[
    bool,
    str,
]:
    paths = patch_paths(
        patch
    )

    if not paths:
        return (
            False,
            "no diff paths",
        )

    bad = [
        path
        for path in paths
        if (
            not safe_path(path)
            or not allowed_path(path)
        )
    ]

    if bad:
        return (
            False,
            f"forbidden paths={bad}",
        )

    if (
        ROUTE_FILE
        not in paths
    ):
        return (
            False,
            "route file unchanged",
        )

    if not any(
        path.startswith(
            "templates/"
        )
        for path in paths
    ):
        return (
            False,
            "no template change",
        )

    return (
        True,
        ",".join(paths),
    )


def deterministic_gates(
    *,
    repo: Path,
    revision: str,
    patch: str,
) -> tuple[
    bool,
    list[
        tuple[str, bool, str]
    ],
]:
    results: list[
        tuple[str, bool, str]
    ] = []

    paths = patch_paths(
        patch
    )

    ok, detail = surface_gate(
        patch
    )

    results.append(
        (
            "surface",
            ok,
            detail,
        )
    )

    if not ok:
        return (
            False,
            results,
        )

    with tempfile.TemporaryDirectory(
        prefix="koalik-direct-v2-"
    ) as tmp:
        root = Path(
            tmp
        )

        worktree = (
            root / "worktree"
        )

        patch_file = (
            root / "candidate.patch"
        )

        added = False

        try:
            proc = run(
                [
                    "git",
                    "worktree",
                    "add",
                    "--detach",
                    str(worktree),
                    revision,
                ],
                cwd=repo,
                timeout=30,
            )

            if proc.returncode != 0:
                results.append(
                    (
                        "worktree",
                        False,
                        proc.stdout,
                    )
                )

                return (
                    False,
                    results,
                )

            added = True

            patch_file.write_text(
                patch,
                encoding="utf-8",
            )

            proc = run(
                [
                    "git",
                    "apply",
                    "--check",
                    str(patch_file),
                ],
                cwd=worktree,
                timeout=20,
            )

            results.append(
                (
                    "git_apply_check",
                    proc.returncode == 0,
                    proc.stdout or "applicable",
                )
            )

            if proc.returncode != 0:
                return (
                    False,
                    results,
                )

            proc = run(
                [
                    "git",
                    "apply",
                    str(patch_file),
                ],
                cwd=worktree,
                timeout=20,
            )

            if proc.returncode != 0:
                results.append(
                    (
                        "git_apply",
                        False,
                        proc.stdout,
                    )
                )

                return (
                    False,
                    results,
                )

            proc = run(
                [
                    "git",
                    "diff",
                    "--check",
                ],
                cwd=worktree,
                timeout=20,
            )

            results.append(
                (
                    "git_diff_check",
                    proc.returncode == 0,
                    proc.stdout or "clean",
                )
            )

            route_path = (
                worktree
                / ROUTE_FILE
            )

            proc = run(
                [
                    sys.executable,
                    "-m",
                    "py_compile",
                    str(route_path),
                ],
                cwd=worktree,
                timeout=20,
            )

            results.append(
                (
                    "python_compile",
                    proc.returncode == 0,
                    proc.stdout or "clean",
                )
            )

            route_text = (
                route_path.read_text(
                    encoding="utf-8"
                )
            )

            structural_required = (
                "rd_bestsellers_data",
                "report_date",
                "report_category3_filter",
                "report_seller_filter",
                "get_basdb_conn",
            )

            missing = [
                token
                for token
                in structural_required
                if token
                not in route_text
            ]

            has_xlsx = any(
                token.lower()
                in route_text.lower()
                for token in (
                    ".xlsx",
                    "openpyxl",
                    "xlsxwriter",
                    "to_excel",
                    "Workbook",
                )
            )

            has_download = any(
                token
                in route_text
                for token in (
                    "send_file",
                    "make_response",
                    "Response(",
                )
            )

            structural_ok = (
                not missing
                and has_xlsx
                and has_download
            )

            results.append(
                (
                    "task_structural",
                    structural_ok,
                    (
                        f"missing={missing} "
                        f"xlsx={has_xlsx} "
                        f"download={has_download}"
                    ),
                )
            )

            smoke_files = [
                path
                for path in (
                    "tests/test_app_smoke.py",
                    "tests/test_legacy_blueprints.py",
                )
                if (
                    worktree
                    / path
                ).is_file()
            ]

            pytest_probe = run(
                [
                    sys.executable,
                    "-c",
                    "import pytest",
                ],
                cwd=worktree,
                timeout=10,
            )

            if (
                smoke_files
                and pytest_probe.returncode
                == 0
            ):
                proc = run(
                    [
                        sys.executable,
                        "-m",
                        "pytest",
                        "-q",
                        *smoke_files,
                    ],
                    cwd=worktree,
                    timeout=90,
                )

                results.append(
                    (
                        "repo_smoke",
                        proc.returncode == 0,
                        proc.stdout[-6000:],
                    )
                )

            else:
                results.append(
                    (
                        "repo_smoke",
                        True,
                        "SKIP",
                    )
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

    return (
        all(
            ok
            for _, ok, _
            in results
        ),
        results,
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

    parser.add_argument(
        "--model",
        required=True,
    )

    parser.add_argument(
        "--timeout",
        type=float,
        default=300.0,
    )

    parser.add_argument(
        "--out",
        type=Path,
        default=Path(
            "benchmarks/results/"
            "model-actual-task-direct-v2"
        ),
    )

    args = parser.parse_args()

    repo = (
        args.repo
        .expanduser()
        .resolve()
    )

    task_spec = (
        args.task_spec
        .resolve()
    )

    out = (
        args.out
        .resolve()
    )

    out.mkdir(
        parents=True,
        exist_ok=True,
    )

    head = run(
        [
            "git",
            "rev-parse",
            "HEAD",
        ],
        cwd=repo,
        timeout=10,
    )

    if head.returncode != 0:
        print(
            "VERDICT=BENCHMARK_FAIL "
            "reason=head"
        )
        return 2

    revision = (
        head.stdout.strip()
    )

    spec = json.loads(
        task_spec.read_text(
            encoding="utf-8"
        )
    )

    task_source, task = (
        extract_task_text(
            spec
        )
    )

    context = compact_context(
        repo=repo,
        revision=revision,
    )

    prompt = render_prompt(
        task=task,
        context=context,
    )

    prompt_bytes = len(
        prompt.encode("utf-8")
    )

    print(
        "=== ACTUAL TASK "
        "DIRECT BASELINE v2 ==="
    )

    print(
        f"repo={repo}"
    )

    print(
        f"base_head={revision}"
    )

    print(
        f"task_source={task_source}"
    )

    print(
        "task_bytes="
        + str(
            len(
                task.encode(
                    "utf-8"
                )
            )
        )
    )

    print(
        f"context_parts={len(context)}"
    )

    for label, text in context.items():
        print(
            f"context_bytes "
            f"{label}="
            f"{len(text.encode('utf-8'))}"
        )

    print(
        f"prompt_bytes={prompt_bytes}"
    )

    print(
        "model_calls=1"
    )

    print(
        "repair_calls=0"
    )

    print(
        "koalik_model_view=false"
    )

    print(
        "koalik_executor=false"
    )

    print()

    if prompt_bytes > 18_000:
        print(
            "VERDICT=BENCHMARK_FAIL "
            "reason=compact_prompt_too_large"
        )

        return 2

    (
        out
        / "prompt.txt"
    ).write_text(
        prompt,
        encoding="utf-8",
    )

    try:
        patch, response, wall = (
            request_patch(
                base_url=args.base_url,
                model=args.model,
                prompt=prompt,
                timeout=args.timeout,
            )
        )

    except Exception as exc:
        print(
            "VERDICT=MODEL_DIRECT_FAIL "
            "reason=inference_error "
            f"detail={exc}"
        )

        return 1

    patch = normalize_patch(
        patch
    )

    (
        out
        / "candidate.patch"
    ).write_text(
        patch,
        encoding="utf-8",
    )

    (
        out
        / "response.json"
    ).write_text(
        json.dumps(
            response,
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    choice = (
        response["choices"][0]
    )

    message = (
        choice.get("message")
        or {}
    )

    usage = (
        response.get("usage")
        or {}
    )

    print(
        f"inference_wall_s={wall:.3f}"
    )

    print(
        "finish_reason="
        + repr(
            choice.get(
                "finish_reason"
            )
        )
    )

    print(
        "reasoning_present="
        + str(
            bool(
                message.get(
                    "reasoning_content"
                )
            )
        )
    )

    print(
        "prompt_tokens="
        + str(
            usage.get(
                "prompt_tokens"
            )
        )
    )

    print(
        "completion_tokens="
        + str(
            usage.get(
                "completion_tokens"
            )
        )
    )

    print(
        "patch_bytes="
        + str(
            len(
                patch.encode(
                    "utf-8"
                )
            )
        )
    )

    print(
        "patch_sha256="
        + sha(
            patch
        )
    )

    print()
    print(
        "=== CANDIDATE PATCH ==="
    )
    print(
        patch,
        end="",
    )
    print(
        "=== END PATCH ==="
    )

    passed, gates = (
        deterministic_gates(
            repo=repo,
            revision=revision,
            patch=patch,
        )
    )

    print()
    print(
        "=== DETERMINISTIC GATES ==="
    )

    for name, ok, detail in gates:
        status = (
            "PASS"
            if ok
            else "FAIL"
        )

        clean = detail.replace(
            "\n",
            " | ",
        )

        if len(clean) > 1200:
            clean = (
                clean[:1200]
                + "..."
            )

        print(
            f"GATE {name} "
            f"{status} "
            f"{clean}"
        )

    verdict = (
        "MODEL_DIRECT_PASS"
        if passed
        else "MODEL_DIRECT_FAIL"
    )

    summary = {
        "protocol": (
            "model-actual-task-direct-v2"
        ),
        "model": args.model,
        "base_head": revision,
        "task_source": task_source,
        "prompt_bytes": prompt_bytes,
        "prompt_sha256": sha(
            prompt
        ),
        "inference_wall_s": round(
            wall,
            3,
        ),
        "prompt_tokens": usage.get(
            "prompt_tokens"
        ),
        "completion_tokens": (
            usage.get(
                "completion_tokens"
            )
        ),
        "reasoning_present": bool(
            message.get(
                "reasoning_content"
            )
        ),
        "patch_sha256": sha(
            patch
        ),
        "changed_paths": patch_paths(
            patch
        ),
        "model_calls": 1,
        "repair_calls": 0,
        "koalik_model_view": False,
        "koalik_executor": False,
        "gates": [
            {
                "name": name,
                "ok": ok,
                "detail": detail,
            }
            for name, ok, detail
            in gates
        ],
        "verdict": verdict,
    }

    (
        out
        / "summary.json"
    ).write_text(
        json.dumps(
            summary,
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    print()
    print(
        f"VERDICT={verdict}"
    )

    print(
        f"summary={out / 'summary.json'}"
    )

    return (
        0
        if passed
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(
        main()
    )
