#!/usr/bin/env python3
from __future__ import annotations

import ast
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


PROTOCOL = "task-proof-evaluator-v1"
OBLIGATION_PROTOCOL = "task-proof-obligation-v1"

UI_EXTENSIONS = {
    ".html", ".htm", ".jinja", ".jinja2", ".j2",
    ".js", ".jsx", ".ts", ".tsx",
}

DATA_CALLS = {
    "execute", "executemany", "query", "select",
    "fetchone", "fetchall", "cursor",
}

OUTPUT_CALLS = {
    "FileResponse", "StreamingResponse", "Response",
    "send_file", "send_from_directory",
    "BytesIO", "StringIO",
}

OUTPUT_LITERALS = {
    "content-disposition",
    "attachment",
    "filename",
    "download_name",
    "application/octet-stream",
    "text/csv",
    "application/zip",
    "application/pdf",
    "spreadsheetml",
}

EXECUTION_CALLS = {"execute", "executemany"}

PARAM_KEYWORDS = {
    "params", "parameters", "bindings", "bindparams", "values",
}


def fail(reason: str, detail: Any = None) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "ok": False,
        "verdict": "FAIL",
        "reason": reason,
        "checks": [],
        "checks_total": 0,
        "checks_passed": 0,
        "checks_failed": 0,
        "detail": detail,
    }


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    stdin: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def safe_rel(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw or "\0" in raw:
        return None
    p = Path(raw)
    if p.is_absolute():
        return None
    parts: list[str] = []
    for part in p.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
            continue
        parts.append(part)
    if not parts:
        return None
    rel = "/".join(parts)
    if rel == ".git" or rel.startswith(".git/"):
        return None
    if rel == ".opencode" or rel.startswith(".opencode/"):
        return None
    return rel


def git_clean(root: Path) -> bool:
    proc = run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=root,
    )
    return proc.returncode == 0 and proc.stdout.strip() == ""


def create_candidate(root: Path, patch: str) -> tuple[Path, Path]:
    parent = Path(tempfile.mkdtemp(prefix="opencode-task-proof-"))
    wt = parent / "candidate"

    add = run(
        ["git", "worktree", "add", "--detach", str(wt), "HEAD"],
        cwd=root,
    )
    if add.returncode != 0:
        shutil.rmtree(parent, ignore_errors=True)
        raise RuntimeError(
            f"worktree_add_failed stdout={add.stdout!r} stderr={add.stderr!r}"
        )

    check = run(["git", "apply", "--check", "-"], cwd=wt, stdin=patch)
    if check.returncode != 0:
        run(["git", "worktree", "remove", "--force", str(wt)], cwd=root)
        shutil.rmtree(parent, ignore_errors=True)
        raise RuntimeError(
            f"patch_apply_check_failed stdout={check.stdout!r} stderr={check.stderr!r}"
        )

    apply = run(["git", "apply", "-"], cwd=wt, stdin=patch)
    if apply.returncode != 0:
        run(["git", "worktree", "remove", "--force", str(wt)], cwd=root)
        shutil.rmtree(parent, ignore_errors=True)
        raise RuntimeError(
            f"patch_apply_failed stdout={apply.stdout!r} stderr={apply.stderr!r}"
        )

    return parent, wt


def cleanup_candidate(root: Path, parent: Path, wt: Path) -> None:
    run(["git", "worktree", "remove", "--force", str(wt)], cwd=root)
    shutil.rmtree(parent, ignore_errors=True)


def read_text(root: Path, rel: str) -> str | None:
    path = root / rel
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def python_tree(root: Path, rel: str) -> ast.AST | None:
    source = read_text(root, rel)
    if source is None:
        return None
    try:
        return ast.parse(source, filename=rel)
    except SyntaxError:
        return None


def call_name(node: ast.Call) -> str:
    fn = node.func
    if isinstance(fn, ast.Name):
        return fn.id
    if isinstance(fn, ast.Attribute):
        return fn.attr
    return ""


def string_literals(tree: ast.AST) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.add(node.value)
    return out


def top_level_signatures(tree: ast.AST) -> list[str]:
    body = getattr(tree, "body", [])
    return [
        ast.dump(node, annotate_fields=True, include_attributes=False)
        for node in body
    ]


def added_top_level_nodes(
    baseline: Path,
    candidate: Path,
    rel: str,
) -> list[ast.AST]:
    before = python_tree(baseline, rel)
    after = python_tree(candidate, rel)
    if before is None or after is None:
        return []

    before_dump = top_level_signatures(before)
    pool = list(before_dump)
    added: list[ast.AST] = []

    for node in getattr(after, "body", []):
        signature = ast.dump(
            node,
            annotate_fields=True,
            include_attributes=False,
        )
        try:
            index = pool.index(signature)
        except ValueError:
            added.append(node)
        else:
            pool.pop(index)

    return added


def mutation_rows(request: dict[str, Any]) -> list[dict[str, Any]]:
    value = request.get("mutations")
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


def changed_files(request: dict[str, Any]) -> list[str]:
    value = request.get("changed_files")
    if not isinstance(value, list):
        return []
    out = []
    for raw in value:
        rel = safe_rel(raw)
        if rel is not None:
            out.append(rel)
    return sorted(set(out))


def python_changed_files(request: dict[str, Any]) -> list[str]:
    return [
        rel
        for rel in changed_files(request)
        if Path(rel).suffix.lower() in {".py", ".pyi"}
    ]


def obligation_server_surface(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    for rel in python_changed_files(request):
        for node in added_top_level_nodes(baseline, candidate, rel):
            if isinstance(
                node,
                (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
            ):
                return True, f"file={rel} added_top_level={type(node).__name__}"
    return False, "no_added_python_server_declaration"


def obligation_ui_surface(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    del baseline
    for row in mutation_rows(request):
        if row.get("kind") != "create_file":
            continue
        rel = safe_rel(row.get("file"))
        if rel is None or Path(rel).suffix.lower() not in UI_EXTENSIONS:
            continue
        source = read_text(candidate, rel)
        if source is not None and source.strip():
            return True, f"created_ui_file={rel}"
    return False, "no_nonempty_created_ui_surface"


def obligation_navigation(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    for row in mutation_rows(request):
        if row.get("kind") != "replace_exact":
            continue
        rel = safe_rel(row.get("file"))
        if rel is None or Path(rel).suffix.lower() not in UI_EXTENSIONS:
            continue
        before = read_text(baseline, rel)
        after = read_text(candidate, rel)
        if before is None or after is None:
            continue

        before_literals = set(re.findall(r"[\"']([^\"'\\]{1,256})[\"']", before))
        after_literals = set(re.findall(r"[\"']([^\"'\\]{1,256})[\"']", after))
        added = sorted(after_literals - before_literals)
        for value in added:
            normalized = value.strip()
            if (
                normalized.startswith("/")
                or normalized.endswith((".html", ".htm", ".jinja", ".jinja2", ".j2"))
            ):
                return True, f"file={rel} new_navigation_literal={normalized}"
    return False, "no_new_navigation_target_literal"


def obligation_data_access(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    for rel in python_changed_files(request):
        for added in added_top_level_nodes(baseline, candidate, rel):
            for node in ast.walk(added):
                if isinstance(node, ast.Call) and call_name(node) in DATA_CALLS:
                    return True, f"file={rel} call={call_name(node)}"
    return False, "no_added_data_access_call"


def obligation_output_artifact(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    for rel in python_changed_files(request):
        for added in added_top_level_nodes(baseline, candidate, rel):
            literals = {
                value.lower()
                for value in string_literals(added)
            }
            if any(
                marker in literal
                for literal in literals
                for marker in OUTPUT_LITERALS
            ):
                return True, f"file={rel} output_literal"
            for node in ast.walk(added):
                if isinstance(node, ast.Call) and call_name(node) in OUTPUT_CALLS:
                    return True, f"file={rel} output_call={call_name(node)}"
    return False, "no_added_output_artifact_primitive"


def imported_roots(tree: ast.AST) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".", 1)[0]
                if root:
                    out.add(root)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                root = node.module.split(".", 1)[0]
                if root:
                    out.add(root)
    return out


def baseline_import_roots(root: Path) -> set[str]:
    out: set[str] = set()
    proc = run(
        ["git", "ls-files", "-z", "--", "*.py", "*.pyi"],
        cwd=root,
    )
    if proc.returncode != 0:
        return out
    for raw in proc.stdout.split("\0"):
        rel = safe_rel(raw)
        if rel is None:
            continue
        tree = python_tree(root, rel)
        if tree is not None:
            out.update(imported_roots(tree))
    return out


def obligation_no_new_dependencies(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    baseline_roots = baseline_import_roots(baseline)
    stdlib = set(getattr(sys, "stdlib_module_names", ()))

    introduced: set[str] = set()
    for rel in python_changed_files(request):
        before = python_tree(baseline, rel)
        after = python_tree(candidate, rel)
        if after is None:
            return False, f"candidate_python_parse_failed={rel}"
        before_roots = imported_roots(before) if before is not None else set()
        introduced.update(imported_roots(after) - before_roots)

    unsupported = sorted(
        root
        for root in introduced
        if root not in stdlib and root not in baseline_roots
    )
    if unsupported:
        return False, "new_external_imports=" + ",".join(unsupported)
    return True, "new_imports_closed=" + ",".join(sorted(introduced))


def contains_runtime_name(expr: ast.AST) -> bool:
    return any(isinstance(node, ast.Name) for node in ast.walk(expr))


def unsafe_query_expression(expr: ast.AST) -> bool:
    if isinstance(expr, ast.JoinedStr):
        return contains_runtime_name(expr)
    if isinstance(expr, ast.BinOp) and isinstance(
        expr.op,
        (ast.Add, ast.Mod),
    ):
        return contains_runtime_name(expr)
    if (
        isinstance(expr, ast.Call)
        and isinstance(expr.func, ast.Attribute)
        and expr.func.attr == "format"
    ):
        return contains_runtime_name(expr)
    return False


def resolve_assignment(
    name: str,
    assignments: dict[str, ast.AST],
) -> ast.AST | None:
    return assignments.get(name)


def execution_has_parameter_channel(call: ast.Call) -> bool:
    if len(call.args) >= 2:
        return True
    return any(keyword.arg in PARAM_KEYWORDS for keyword in call.keywords)


def obligation_parameterized_query(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    observed_execute = False
    for rel in python_changed_files(request):
        for added in added_top_level_nodes(baseline, candidate, rel):
            assignments: dict[str, ast.AST] = {}
            for node in ast.walk(added):
                if (
                    isinstance(node, ast.Assign)
                    and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                ):
                    assignments[node.targets[0].id] = node.value

            for node in ast.walk(added):
                if not isinstance(node, ast.Call):
                    continue
                if call_name(node) not in EXECUTION_CALLS:
                    continue
                observed_execute = True
                if not node.args:
                    return False, f"file={rel} execute_without_query_argument"

                query_expr = node.args[0]
                if isinstance(query_expr, ast.Name):
                    query_expr = resolve_assignment(
                        query_expr.id,
                        assignments,
                    ) or query_expr

                if unsafe_query_expression(query_expr):
                    return False, f"file={rel} interpolated_query_expression"

                if execution_has_parameter_channel(node):
                    return True, f"file={rel} separate_parameter_channel"

    if not observed_execute:
        return False, "no_execute_call_for_parameterization_proof"
    return False, "execute_call_without_separate_parameter_channel"



INPUT_GETTERS = {"get", "getlist"}
INPUT_CONTAINER_NAMES = {
    "form", "args", "values", "json",
}
VALIDATION_CALLS = {
    "strptime", "fromisoformat",
    "int", "float", "bool",
}


def rejection_path(nodes: list[ast.stmt]) -> bool:
    return any(
        isinstance(item, (ast.Return, ast.Raise))
        for stmt in nodes
        for item in ast.walk(stmt)
    )


def attribute_chain(node: ast.AST) -> list[str]:
    out: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        out.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        out.append(current.id)
    out.reverse()
    return out


def request_input_assignments(
    node: ast.AST,
) -> set[str]:
    result: set[str] = set()

    if isinstance(
        node,
        (ast.FunctionDef, ast.AsyncFunctionDef),
    ):
        args = node.args
        for arg in [
            *args.posonlyargs,
            *args.args,
            *args.kwonlyargs,
        ]:
            result.add(arg.arg)

    for child in ast.walk(node):
        if not (
            isinstance(child, ast.Assign)
            and len(child.targets) == 1
            and isinstance(child.targets[0], ast.Name)
            and isinstance(child.value, ast.Call)
            and isinstance(child.value.func, ast.Attribute)
            and child.value.func.attr in INPUT_GETTERS
        ):
            continue

        chain = attribute_chain(
            child.value.func.value,
        )
        if (
            "request" in chain
            and any(
                item in INPUT_CONTAINER_NAMES
                for item in chain
            )
        ):
            result.add(
                child.targets[0].id,
            )

    return result


def expression_names(node: ast.AST) -> set[str]:
    return {
        item.id
        for item in ast.walk(node)
        if isinstance(item, ast.Name)
    }


def validation_call_uses_input(
    call: ast.Call,
    inputs: set[str],
) -> bool:
    if call_name(call) not in VALIDATION_CALLS:
        return False
    return any(
        expression_names(arg) & inputs
        for arg in call.args
    )


def obligation_input_validation(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    for rel in python_changed_files(request):
        for added in added_top_level_nodes(
            baseline,
            candidate,
            rel,
        ):
            inputs = request_input_assignments(
                added,
            )
            if not inputs:
                continue

            for child in ast.walk(added):
                if isinstance(child, ast.Try):
                    validates = any(
                        isinstance(item, ast.Call)
                        and validation_call_uses_input(
                            item,
                            inputs,
                        )
                        for stmt in child.body
                        for item in ast.walk(stmt)
                    )
                    rejects = any(
                        rejection_path(
                            handler.body,
                        )
                        for handler in child.handlers
                    )
                    if validates and rejects:
                        return (
                            True,
                            f"file={rel} guarded_parse_validation",
                        )

                if isinstance(child, ast.If):
                    if not (
                        expression_names(child.test)
                        & inputs
                    ):
                        continue
                    if rejection_path(child.body):
                        return (
                            True,
                            f"file={rel} rejecting_input_guard",
                        )

    return False, "no_input_validation_with_rejection_path"


def literal_choice_values(
    node: ast.AST,
) -> list[object] | None:
    if not isinstance(
        node,
        (ast.Tuple, ast.List, ast.Set),
    ):
        return None

    values: list[object] = []
    for item in node.elts:
        if not isinstance(
            item,
            ast.Constant,
        ):
            return None
        if isinstance(
            item.value,
            (str, int, float, bool),
        ):
            values.append(item.value)
        else:
            return None

    return values


def obligation_closed_choice(
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    for rel in python_changed_files(request):
        for added in added_top_level_nodes(
            baseline,
            candidate,
            rel,
        ):
            inputs = request_input_assignments(
                added,
            )
            if not inputs:
                continue

            for child in ast.walk(added):
                if not (
                    isinstance(child, ast.If)
                    and isinstance(
                        child.test,
                        ast.Compare,
                    )
                    and len(
                        child.test.ops,
                    ) == 1
                    and isinstance(
                        child.test.ops[0],
                        ast.NotIn,
                    )
                    and len(
                        child.test.comparators,
                    ) == 1
                ):
                    continue

                subject_names = expression_names(
                    child.test.left,
                )
                if not (
                    subject_names
                    & inputs
                ):
                    continue

                values = literal_choice_values(
                    child.test.comparators[0],
                )

                if (
                    values is not None
                    and 1 <= len(values) <= 32
                    and rejection_path(
                        child.body,
                    )
                ):
                    return (
                        True,
                        f"file={rel} closed_choice_count={len(values)}",
                    )

    return False, "no_input_bound_finite_choice_guard"

_SEMANTIC_PRESERVATION_MODULE: Any | None = None


def semantic_preservation_module() -> Any | None:
    global _SEMANTIC_PRESERVATION_MODULE

    if _SEMANTIC_PRESERVATION_MODULE is not None:
        return _SEMANTIC_PRESERVATION_MODULE

    module_path = Path(__file__).with_name(
        "semantic-preservation-v1.py",
    )
    try:
        spec = importlib.util.spec_from_file_location(
            "koalik_semantic_preservation_v1",
            module_path,
        )
        if spec is None or spec.loader is None:
            return None

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except (
        OSError,
        ImportError,
        AttributeError,
        SyntaxError,
    ):
        return None

    _SEMANTIC_PRESERVATION_MODULE = module
    return module


def obligation_existing_behavior(
    structural: dict[str, Any],
    baseline: Path,
    candidate: Path,
    request: dict[str, Any],
) -> tuple[bool, str]:
    structural_passed = (
        structural.get("ok") is True
        and structural.get("verdict") == "PASS"
        and structural.get("top_level_conservation") is True
    )
    if not structural_passed:
        return (
            False,
            "delegated_to_invariant_verifier:"
            "structural_conservation_failed",
        )

    semantic = semantic_preservation_module()
    if semantic is None:
        return False, "semantic_preservation_runtime_unavailable"

    # R29 accepts no request/model-authored allowed delta.
    # Future modifications/removals need a deterministic producer that names
    # a baseline detector fact by semantic_key.
    assessment = semantic.verify_changed_python_files(
        baseline=baseline,
        candidate=candidate,
        changed_files=request.get("changed_files"),
        allowed_delta=None,
    )

    if (
        assessment.get("ok") is not True
        or assessment.get("verdict") != "PASS"
        or assessment.get("complete") is not True
        or assessment.get("mutation_authority") is not False
    ):
        return (
            False,
            "semantic_preservation:"
            + str(assessment.get("reason") or "failed"),
        )

    return (
        True,
        "delegated_to_invariant_verifier+"
        + str(assessment.get("protocol"))
        + ":python_semantic_preservation_verified",
    )


CHECKERS = {
    "mutation_obligation_server_surface": obligation_server_surface,
    "mutation_obligation_ui_surface": obligation_ui_surface,
    "mutation_obligation_navigation": obligation_navigation,
    "candidate_ast_data_access": obligation_data_access,
    "candidate_ast_output_artifact": obligation_output_artifact,
    "candidate_ast_input_validation": obligation_input_validation,
    "dependency_closure_no_new_external": obligation_no_new_dependencies,
    "candidate_ast_query_parameterization": obligation_parameterized_query,
    "candidate_ast_closed_choice": obligation_closed_choice,
}


def validate_obligations(raw: Any) -> tuple[list[dict[str, Any]] | None, str | None]:
    if not isinstance(raw, list) or not raw:
        return None, "task_proof_obligations_missing"

    seen: set[tuple[str, str]] = set()
    rows: list[dict[str, Any]] = []

    for value in raw:
        if not isinstance(value, dict):
            return None, "task_proof_obligation_invalid"
        if value.get("protocol") != OBLIGATION_PROTOCOL:
            return None, "task_proof_obligation_protocol_invalid"
        oid = value.get("id")
        checker = value.get("checker")
        if (
            not isinstance(oid, str)
            or not oid
            or not isinstance(checker, str)
            or not checker
            or value.get("disposition") != "fatal"
            or value.get("mutation_authority") is not False
        ):
            return None, "task_proof_obligation_contract_invalid"
        key = (oid, checker)
        if key in seen:
            return None, "task_proof_obligation_duplicate"
        seen.add(key)
        rows.append(value)

    rows.sort(key=lambda row: (row["id"], row["checker"]))
    return rows, None


def evaluate(request: dict[str, Any]) -> dict[str, Any]:
    root_raw = request.get("root")
    patch = request.get("patch")
    structural = request.get("structural_verifier")

    if not isinstance(root_raw, str) or not isinstance(patch, str) or not patch:
        return fail("task_proof_request_invalid")
    if not isinstance(structural, dict):
        return fail("task_proof_structural_evidence_missing")

    try:
        root = Path(root_raw).resolve(strict=True)
    except OSError:
        return fail("task_proof_root_unavailable")

    if not (root / ".git").exists() and run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=root,
    ).returncode != 0:
        return fail("task_proof_root_not_git")

    obligations, error = validate_obligations(request.get("obligations"))
    if error:
        return fail(error)

    baseline_clean_before = git_clean(root)
    if not baseline_clean_before:
        return fail("task_proof_baseline_dirty")

    try:
        parent, candidate = create_candidate(root, patch)
    except RuntimeError as exc:
        return fail("task_proof_candidate_materialization_failed", str(exc))

    checks: list[dict[str, Any]] = []
    try:
        for obligation in obligations or []:
            checker = obligation["checker"]
            if checker == "additive_top_level_conservation":
                passed, detail = obligation_existing_behavior(
                    structural,
                    root,
                    candidate,
                    request,
                )
            else:
                fn = CHECKERS.get(checker)
                if fn is None:
                    checks.append({
                        "id": obligation["id"],
                        "checker": checker,
                        "pass": False,
                        "reason": "task_proof_checker_unsupported",
                    })
                    continue
                passed, detail = fn(root, candidate, request)

            checks.append({
                "id": obligation["id"],
                "checker": checker,
                "pass": bool(passed),
                "reason": detail,
            })
    finally:
        cleanup_candidate(root, parent, candidate)

    baseline_clean_after = git_clean(root)
    checks.append({
        "id": "baseline_repo_unchanged",
        "checker": "baseline_repo_unchanged",
        "pass": baseline_clean_after,
        "reason": "git_status_clean" if baseline_clean_after else "baseline_dirty_after_task_proof",
    })

    passed = sum(1 for row in checks if row["pass"])
    failed = len(checks) - passed
    ok = failed == 0

    return {
        "protocol": PROTOCOL,
        "ok": ok,
        "verdict": "PASS" if ok else "FAIL",
        "reason": None if ok else "task_proof_obligation_failed",
        "checks": checks,
        "checks_total": len(checks),
        "checks_passed": passed,
        "checks_failed": failed,
        "baseline_clean_before": baseline_clean_before,
        "baseline_clean_after": baseline_clean_after,
        "proof_authority": "deterministic_candidate_analysis",
        "mutation_authority": False,
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as exc:
        json.dump(fail("task_proof_request_json_invalid", str(exc)), sys.stdout)
        sys.stdout.write("\n")
        return 0

    if not isinstance(request, dict):
        response = fail("task_proof_request_invalid")
    else:
        response = evaluate(request)

    json.dump(response, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
