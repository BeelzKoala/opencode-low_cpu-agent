#!/usr/bin/env python3
from __future__ import annotations

import argparse
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


CONTEXT_FILES = (
    "routes/bestsellers_bp.py",
    "templates/bestsellers_task.html",
    "templates/snippets/menu.html",
    "database.py",
)

EDITABLE_EXACT = {
    "routes/bestsellers_bp.py",
    "templates/bestsellers_task.html",
    "templates/snippets/menu.html",
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
                        score > 0
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
            "task text not found in benchmark JSON"
        )

    found.sort(
        key=lambda row: (
            row[0],
            row[1],
        ),
        reverse=True,
    )

    _, _, path, text = found[0]

    # Guard against accidentally selecting metadata
    # instead of the actual benchmark task.
    task_signals = (
        "/export",
        "XLSX",
        "BASDB",
        "rd_bestsellers_data",
        "report_date",
        "report_category3_filter",
        "report_seller_filter",
    )

    observed = sum(
        signal.lower() in text.lower()
        for signal in task_signals
    )

    if observed < 3:
        raise RuntimeError(
            "selected task text does not look like "
            "the bestsellers export task; "
            f"path={path!r} signals={observed}"
        )

    return path, text


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
            f"context file unavailable: {path}\n"
            + proc.stdout
        )

    return proc.stdout


def render_prompt(
    *,
    task: str,
    files: dict[str, str],
) -> str:
    out = [
        "Solve this real repository task directly.",
        "",
        "The relevant files have already been "
        "localized for you.",
        "Return one normal unified git diff.",
        "",
        "Requirements for your patch:",
        "- solve the task completely",
        "- do not emit placeholders, examples, "
        "demo text, TODOs, or fake implementations",
        "- preserve unrelated behavior",
        "- reuse existing project conventions",
        "- database.py is read-only context",
        "- routes/bestsellers_bp.py may be edited",
        "- templates/bestsellers_task.html may be edited",
        "- templates/snippets/menu.html may be edited",
        "- if a new template is needed, its path "
        "must match templates/bestsellers*.html",
        "- modify no other paths",
        "- do not add benchmark-specific tests",
        "- the diff must apply to the exact sources "
        "below with git apply",
        "",
        "TASK",
        "====",
        task,
        "",
        "REPOSITORY CONTEXT",
        "==================",
    ]

    for path, body in files.items():
        out.extend(
            [
                "",
                f"===== BEGIN FILE: {path} =====",
                body,
                f"===== END FILE: {path} =====",
            ]
        )

    return "\n".join(out)


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
                    "You are a coding model editing "
                    "a real repository. Solve the "
                    "task directly from the supplied "
                    "source files. Return only the "
                    "requested structured result."
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
                "name": (
                    "direct_repository_patch"
                ),
                "strict": True,
                "schema": schema,
            },
        },
    }

    request = urllib.request.Request(
        (
            base_url.rstrip("/")
            + "/v1/chat/completions"
        ),
        data=json.dumps(
            payload
        ).encode("utf-8"),
        headers={
            "Content-Type": (
                "application/json"
            )
        },
        method="POST",
    )

    started = time.monotonic()

    try:
        with urllib.request.urlopen(
            request,
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

    wall = time.monotonic() - started

    result = json.loads(raw)

    choices = result.get("choices")
    if (
        not isinstance(choices, list)
        or not choices
    ):
        raise RuntimeError(
            "response contains no choices"
        )

    message = choices[0].get(
        "message"
    )
    if not isinstance(message, dict):
        raise RuntimeError(
            "response contains no message"
        )

    content = message.get("content")

    if (
        not isinstance(content, str)
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

    decoded = json.loads(content)

    patch = decoded.get("patch")

    if (
        not isinstance(patch, str)
        or not patch.strip()
    ):
        raise RuntimeError(
            "structured response "
            "contains no patch"
        )

    return patch, result, wall


def normalize_patch(
    patch: str,
) -> str:
    text = patch.strip()

    # Schema asks for raw diff, but tolerate a
    # conventional markdown fence without turning
    # this into a repair/model retry.
    if text.startswith("```"):
        lines = text.splitlines()

        if (
            lines
            and lines[0].startswith(
                "```"
            )
        ):
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

    if not text.endswith("\n"):
        text += "\n"

    return text


def patch_paths(
    patch: str,
) -> list[str]:
    paths = [
        match.group(2)
        for match
        in DIFF_PATH_RE.finditer(
            patch
        )
    ]

    return list(
        dict.fromkeys(paths)
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

    if (
        ".." in parts
        or ".git" in parts
    ):
        return False

    return True


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


def gate(
    name: str,
    ok: bool,
    detail: str,
) -> dict[str, object]:
    return {
        "name": name,
        "ok": ok,
        "detail": detail,
    }


def patch_surface_gate(
    patch: str,
) -> dict[str, object]:
    paths = patch_paths(
        patch
    )

    if not paths:
        return gate(
            "patch_surface",
            False,
            "no diff --git paths",
        )

    unsafe = [
        path
        for path in paths
        if not safe_path(path)
    ]

    if unsafe:
        return gate(
            "patch_surface",
            False,
            f"unsafe paths={unsafe}",
        )

    forbidden = [
        path
        for path in paths
        if not allowed_path(path)
    ]

    if forbidden:
        return gate(
            "patch_surface",
            False,
            (
                "outside baseline "
                f"surface={forbidden}"
            ),
        )

    if (
        "routes/bestsellers_bp.py"
        not in paths
    ):
        return gate(
            "patch_surface",
            False,
            "route file unchanged",
        )

    if not any(
        path.startswith(
            "templates/"
        )
        for path in paths
    ):
        return gate(
            "patch_surface",
            False,
            "no template change",
        )

    return gate(
        "patch_surface",
        True,
        "paths=" + ",".join(
            paths
        ),
    )


def compile_gate(
    worktree: Path,
    paths: list[str],
) -> dict[str, object]:
    python_files = [
        path
        for path in paths
        if path.endswith(".py")
    ]

    for path in python_files:
        proc = run(
            [
                sys.executable,
                "-m",
                "py_compile",
                path,
            ],
            cwd=worktree,
            timeout=20,
        )

        if proc.returncode != 0:
            return gate(
                "python_compile",
                False,
                (
                    f"{path}: "
                    + proc.stdout[-4000:]
                ),
            )

    return gate(
        "python_compile",
        True,
        ",".join(
            python_files
        ),
    )


def structural_gate(
    worktree: Path,
    changed: list[str],
) -> dict[str, object]:
    route = (
        worktree
        / "routes/bestsellers_bp.py"
    ).read_text(
        encoding="utf-8"
    )

    templates = {
        "templates/bestsellers_task.html",
        "templates/snippets/menu.html",
    }

    templates.update(
        path
        for path in changed
        if (
            path.startswith(
                "templates/"
            )
            and path.endswith(
                ".html"
            )
        )
    )

    template_text = "\n".join(
        (
            worktree / path
        ).read_text(
            encoding="utf-8"
        )
        for path in sorted(
            templates
        )
        if (
            worktree / path
        ).is_file()
    )

    required_route = (
        "/export",
        "rd_bestsellers_data",
        "report_date",
        "report_category3_filter",
        "report_seller_filter",
        "get_basdb_conn",
    )

    missing = [
        token
        for token in required_route
        if token not in route
    ]

    xlsx_signals = (
        ".xlsx",
        "openpyxl",
        "xlsxwriter",
        "to_excel",
        "Workbook",
        "spreadsheetml",
    )

    response_signals = (
        "send_file",
        "Response(",
        "make_response",
    )

    problems: list[str] = []

    if missing:
        problems.append(
            "missing route tokens="
            + ",".join(missing)
        )

    if not any(
        signal.lower()
        in route.lower()
        for signal in xlsx_signals
    ):
        problems.append(
            "no XLSX generation signal"
        )

    if not any(
        signal in route
        for signal in response_signals
    ):
        problems.append(
            "no HTTP file response signal"
        )

    if not (
        "/export" in template_text
        or "export"
        in template_text.lower()
    ):
        problems.append(
            "no template export integration"
        )

    lower_templates = (
        template_text.lower()
    )

    if not (
        'type="date"'
        in lower_templates
        or "report_date"
        in template_text
        or "start_date"
        in template_text
        or "end_date"
        in template_text
    ):
        problems.append(
            "no template date input/signal"
        )

    if problems:
        return gate(
            "task_structural",
            False,
            "; ".join(problems),
        )

    return gate(
        "task_structural",
        True,
        (
            "route/data/xlsx/"
            "response/template "
            "witnesses present"
        ),
    )


def smoke_gate(
    worktree: Path,
) -> dict[str, object]:
    tests = [
        path
        for path in (
            "tests/test_app_smoke.py",
            "tests/test_legacy_blueprints.py",
        )
        if (
            worktree / path
        ).is_file()
    ]

    if not tests:
        return gate(
            "repo_smoke",
            True,
            "SKIP no known smoke tests",
        )

    pytest_probe = run(
        [
            sys.executable,
            "-c",
            "import pytest",
        ],
        cwd=worktree,
        timeout=10,
    )

    if pytest_probe.returncode != 0:
        return gate(
            "repo_smoke",
            True,
            "SKIP pytest unavailable",
        )

    proc = run(
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

    if proc.returncode != 0:
        return gate(
            "repo_smoke",
            False,
            proc.stdout[-8000:],
        )

    return gate(
        "repo_smoke",
        True,
        proc.stdout[-4000:],
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
            "ozon-bestsellers-report-"
            "export-e2e.json"
        ),
    )

    parser.add_argument(
        "--base-url",
        default=(
            "http://127.0.0.1:8080"
        ),
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
            "model-actual-task-direct-v1"
        ),
    )

    args = parser.parse_args()

    repo = (
        args.repo
        .expanduser()
        .resolve()
    )

    task_spec = (
        args.task_spec.resolve()
    )

    out = args.out.resolve()
    out.mkdir(
        parents=True,
        exist_ok=True,
    )

    if not (
        repo / ".git"
    ).exists():
        print(
            f"STOP not git repo: {repo}"
        )
        return 2

    if not task_spec.is_file():
        print(
            "STOP task spec absent: "
            f"{task_spec}"
        )
        return 2

    head_proc = run(
        [
            "git",
            "rev-parse",
            "HEAD",
        ],
        cwd=repo,
        timeout=10,
    )

    if head_proc.returncode != 0:
        print(
            "STOP cannot resolve "
            "target HEAD"
        )
        return 2

    base_head = (
        head_proc.stdout.strip()
    )

    spec = json.loads(
        task_spec.read_text(
            encoding="utf-8"
        )
    )

    try:
        task_source, task_text = (
            extract_task_text(spec)
        )
    except Exception as exc:
        print(
            "VERDICT=BENCHMARK_FAIL "
            f"reason=task_extract "
            f"detail={exc}"
        )
        return 2

    try:
        files = {
            path: git_show(
                repo,
                base_head,
                path,
            )
            for path
            in CONTEXT_FILES
        }
    except Exception as exc:
        print(
            "VERDICT=BENCHMARK_FAIL "
            f"reason=context "
            f"detail={exc}"
        )
        return 2

    prompt = render_prompt(
        task=task_text,
        files=files,
    )

    prompt_bytes = len(
        prompt.encode("utf-8")
    )

    print(
        "=== ACTUAL TASK "
        "DIRECT BASELINE v1 ==="
    )
    print(f"repo={repo}")
    print(
        f"base_head={base_head}"
    )
    print(
        f"task_source={task_source}"
    )
    print(
        "task_bytes="
        + str(
            len(
                task_text.encode(
                    "utf-8"
                )
            )
        )
    )
    print(
        f"context_files={len(files)}"
    )
    print(
        f"prompt_bytes={prompt_bytes}"
    )
    print("model_calls=1")
    print("repair_calls=0")
    print(
        "koalik_model_view=false"
    )
    print(
        "koalik_executor=false"
    )
    print()

    print("=== TASK ===")
    print(task_text)
    print("=== END TASK ===")
    print()

    if prompt_bytes > 90_000:
        print(
            "VERDICT=BENCHMARK_FAIL "
            "reason=direct_prompt_too_large"
        )
        return 2

    (
        out / "task.txt"
    ).write_text(
        task_text + "\n",
        encoding="utf-8",
    )

    (
        out / "prompt.txt"
    ).write_text(
        prompt + "\n",
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
        out / "candidate.patch"
    ).write_text(
        patch,
        encoding="utf-8",
    )

    (
        out / "response.json"
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
        f"inference_wall_s="
        f"{wall:.3f}"
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
        f"patch_sha256={sha(patch)}"
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
    print()

    gates: list[
        dict[str, object]
    ] = []

    surface = (
        patch_surface_gate(
            patch
        )
    )

    gates.append(surface)

    if not surface["ok"]:
        print(
            "GATE patch_surface FAIL "
            + str(
                surface["detail"]
            )
        )
        print(
            "VERDICT=MODEL_DIRECT_FAIL "
            "reason=patch_surface"
        )
        return 1

    changed = patch_paths(
        patch
    )

    with tempfile.TemporaryDirectory(
        prefix=(
            "koalik-direct-baseline-"
        )
    ) as tmp:
        root = Path(tmp)
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
                    base_head,
                ],
                cwd=repo,
                timeout=30,
            )

            if proc.returncode != 0:
                raise RuntimeError(
                    proc.stdout
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

            gates.append(
                gate(
                    "git_apply_check",
                    proc.returncode == 0,
                    (
                        proc.stdout[-4000:]
                        or "applicable"
                    ),
                )
            )

            if proc.returncode != 0:
                raise RuntimeError(
                    "patch does not apply"
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
                raise RuntimeError(
                    proc.stdout
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

            gates.append(
                gate(
                    "git_diff_check",
                    proc.returncode == 0,
                    (
                        proc.stdout[-4000:]
                        or "clean"
                    ),
                )
            )

            gates.append(
                compile_gate(
                    worktree,
                    changed,
                )
            )

            gates.append(
                structural_gate(
                    worktree,
                    changed,
                )
            )

            gates.append(
                smoke_gate(
                    worktree
                )
            )

            # Make new files visible in git diff
            # without actually staging content.
            run(
                [
                    "git",
                    "add",
                    "-N",
                    "--",
                    *changed,
                ],
                cwd=worktree,
                timeout=20,
            )

            final_diff = run(
                [
                    "git",
                    "diff",
                    "--binary",
                ],
                cwd=worktree,
                timeout=20,
            )

            (
                out / "applied.diff"
            ).write_text(
                final_diff.stdout,
                encoding="utf-8",
            )

        except Exception as exc:
            if not any(
                not bool(
                    item["ok"]
                )
                for item in gates
            ):
                gates.append(
                    gate(
                        "transaction",
                        False,
                        str(exc),
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

    print(
        "=== DETERMINISTIC GATES ==="
    )

    for item in gates:
        status = (
            "PASS"
            if item["ok"]
            else "FAIL"
        )

        detail = str(
            item["detail"]
        ).replace(
            "\n",
            " | ",
        )

        if len(detail) > 1200:
            detail = (
                detail[:1200]
                + "..."
            )

        print(
            f"GATE "
            f"{item['name']} "
            f"{status} "
            f"{detail}"
        )

    passed = all(
        bool(item["ok"])
        for item in gates
    )

    summary = {
        "protocol": (
            "model-actual-task-"
            "direct-v1"
        ),
        "model": args.model,
        "base_head": base_head,
        "task_source": task_source,
        "task_sha256": sha(
            task_text
        ),
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
        "changed_paths": changed,
        "model_calls": 1,
        "repair_calls": 0,
        "koalik_model_view": False,
        "koalik_executor": False,
        "gates": gates,
        "verdict": (
            "MODEL_DIRECT_PASS"
            if passed
            else "MODEL_DIRECT_FAIL"
        ),
    }

    (
        out / "summary.json"
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
        "VERDICT="
        + str(
            summary["verdict"]
        )
    )
    print(
        f"summary="
        f"{out / 'summary.json'}"
    )
    print(
        f"patch="
        f"{out / 'candidate.patch'}"
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
