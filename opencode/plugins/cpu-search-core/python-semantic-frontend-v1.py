#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import builtins
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import symtable
import sys
import sysconfig
import tomllib
from typing import Any

PROTOCOL = "python-semantic-frontend-v3"
UNIT_PROTOCOL = "python-unit-shell-v1"
CANONICALIZER_PROTOCOL = "semantic-canonicalizer-v1"
RUFF_BRIDGE_PROTOCOL = "ruff-python-bridge-v1"
BINDING_PROTOCOL = "python-binding-capability-v1"
PROVENANCE_PROTOCOL = "koalik-provenance-v1"
SCOPE_PROTOCOL = "python-scope-lattice-v1"
MAX_SCOPE_IMPORTS = 128
MAX_SCOPE_DEPTH = 32

MAX_REPO_PY_FILES = 768
MAX_REPO_SOURCE_BYTES = 8 * 1024 * 1024
MAX_UNITS = 8
MAX_UNIT_SOURCE_BYTES = 96 * 1024
MAX_BODY_BYTES = 64 * 1024
MAX_HEADER_BYTES = 4 * 1024
MAX_DECORATORS = 16
MAX_BASES = 16
MAX_BRIDGE_STDOUT_BYTES = 4 * 1024 * 1024

PY_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
REQ_NAME_RE = re.compile(r"^\s*([A-Za-z0-9_.-]+)")


DEPENDENCY_EVIDENCE_PROTOCOL = "python-dependency-evidence-v1"
MAX_DEPENDENCY_EVIDENCE_ITEMS = 64

def fail(reason: str, **extra: Any) -> dict[str, Any]:
    return {
        "ok": False,
        "protocol": PROTOCOL,
        "unit_protocol": UNIT_PROTOCOL,
        "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
        "ruff_bridge_protocol": RUFF_BRIDGE_PROTOCOL,
        "binding_protocol": BINDING_PROTOCOL,
        "provenance_protocol": PROVENANCE_PROTOCOL,
        "reason": reason,
        "mutation_authority": False,
        "model_import_authority": False,
        **extra,
    }


def stable_sha(value: Any) -> str:
    raw = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def safe_rel(root: Path, raw: str) -> Path | None:
    try:
        path = (root / raw).resolve()
        path.relative_to(root.resolve())
        return path
    except Exception:
        return None


def bridge_path() -> Path | None:
    override = os.environ.get("OPENCODE_RUFF_PYTHON_BRIDGE")
    if override:
        path = Path(override).expanduser().resolve()
        return path if path.is_file() else None

    plugin_root = Path(__file__).resolve().parent.parent
    installed = plugin_root / ".bin" / "opencode-ruff-python-bridge"
    if installed.is_file():
        return installed

    return None


def call_bridge(payload: dict[str, Any]) -> dict[str, Any]:
    bridge = bridge_path()
    if bridge is None:
        return fail("ruff_python_bridge_unavailable")

    try:
        proc = subprocess.run(
            [str(bridge)],
            input=json.dumps(
                payload,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
            check=False,
        )
    except Exception as exc:
        return fail(
            "ruff_python_bridge_spawn_failed",
            detail=type(exc).__name__,
        )

    if proc.returncode != 0:
        return fail(
            "ruff_python_bridge_process_failed",
            rc=proc.returncode,
            stderr=proc.stderr[:4096],
        )

    if len(proc.stdout.encode("utf-8")) > MAX_BRIDGE_STDOUT_BYTES:
        return fail("ruff_python_bridge_output_budget_exceeded")

    try:
        result = json.loads(proc.stdout)
    except Exception:
        return fail(
            "ruff_python_bridge_output_invalid",
            stdout=proc.stdout[:4096],
        )

    if not isinstance(result, dict):
        return fail("ruff_python_bridge_output_invalid")
    if result.get("protocol") != RUFF_BRIDGE_PROTOCOL:
        return fail(
            "ruff_python_bridge_protocol_mismatch",
            observed=result.get("protocol"),
        )
    return result


def ensure_string(value: Any, *, name: str, max_bytes: int) -> str:
    if not isinstance(value, str):
        raise ValueError(
            json.dumps({"reason": "python_unit_field_invalid", "field": name})
        )
    if len(value.encode("utf-8")) > max_bytes:
        raise ValueError(
            json.dumps({"reason": "python_unit_field_budget", "field": name})
        )
    return value


def ensure_name(value: Any, *, field: str) -> str:
    raw = ensure_string(value, name=field, max_bytes=256)
    if not PY_NAME_RE.fullmatch(raw):
        raise ValueError(
            json.dumps({"reason": "python_unit_identifier_invalid", "field": field})
        )
    return raw


def indent_body(body: str) -> str:
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not any(line.strip() for line in lines):
        raise ValueError(json.dumps({"reason": "python_unit_body_empty"}))
    return "\n".join("    " + line for line in lines)


def decorator_lines(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_DECORATORS:
        raise ValueError(json.dumps({"reason": "python_unit_decorators_invalid"}))
    out = []
    for index, row in enumerate(value):
        text = ensure_string(
            row,
            name=f"decorators[{index}]",
            max_bytes=MAX_HEADER_BYTES,
        ).strip()
        if not text or "\n" in text or "\r" in text:
            raise ValueError(json.dumps({"reason": "python_unit_decorator_invalid"}))
        out.append("@" + text.lstrip("@"))
    return out


def render_unit(unit: dict[str, Any], index: int) -> str:
    if not isinstance(unit, dict):
        raise ValueError(
            json.dumps({"reason": "python_unit_shape_invalid", "unit_index": index})
        )

    kind = unit.get("kind")
    name = ensure_name(unit.get("name"), field="name")
    decorators = decorator_lines(unit.get("decorators"))

    if kind in {"function", "async_function"}:
        params = ensure_string(
            unit.get("parameters", ""),
            name="parameters",
            max_bytes=MAX_HEADER_BYTES,
        ).strip()
        returns = unit.get("returns")
        if returns is not None:
            returns = ensure_string(
                returns,
                name="returns",
                max_bytes=MAX_HEADER_BYTES,
            ).strip() or None
        body = ensure_string(
            unit.get("body"),
            name="body",
            max_bytes=MAX_BODY_BYTES,
        )
        prefix = "async " if kind == "async_function" else ""
        header = f"{prefix}def {name}({params})"
        if returns:
            header += f" -> {returns}"
        header += ":"
        return "\n".join([*decorators, header, indent_body(body)])

    if kind == "class":
        raw_bases = unit.get("bases", [])
        if not isinstance(raw_bases, list) or len(raw_bases) > MAX_BASES:
            raise ValueError(json.dumps({"reason": "python_unit_bases_invalid"}))
        bases = []
        for base_index, raw in enumerate(raw_bases):
            text = ensure_string(
                raw,
                name=f"bases[{base_index}]",
                max_bytes=MAX_HEADER_BYTES,
            ).strip()
            if not text or "\n" in text or "\r" in text:
                raise ValueError(json.dumps({"reason": "python_unit_base_invalid"}))
            bases.append(text)
        body = ensure_string(
            unit.get("body"),
            name="body",
            max_bytes=MAX_BODY_BYTES,
        )
        suffix = f"({', '.join(bases)})" if bases else ""
        return "\n".join([*decorators, f"class {name}{suffix}:", indent_body(body)])

    if kind == "assignment":
        annotation = unit.get("annotation")
        value = ensure_string(
            unit.get("value"),
            name="value",
            max_bytes=MAX_BODY_BYTES,
        ).strip()
        if not value:
            raise ValueError(json.dumps({"reason": "python_unit_value_empty"}))
        if annotation is not None:
            annotation = ensure_string(
                annotation,
                name="annotation",
                max_bytes=MAX_HEADER_BYTES,
            ).strip() or None
        if decorators:
            raise ValueError(json.dumps({"reason": "python_assignment_decorator_forbidden"}))
        return f"{name}: {annotation} = {value}" if annotation else f"{name} = {value}"

    raise ValueError(
        json.dumps(
            {
                "reason": "python_unit_kind_unsupported",
                "kind": kind,
                "unit_index": index,
            }
        )
    )


def list_repo_python_files(root: Path) -> list[Path]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", "*.py"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=3,
        )
        if proc.returncode == 0:
            out = []
            for raw in proc.stdout.split(b"\0"):
                if not raw:
                    continue
                rel = raw.decode("utf-8", errors="surrogateescape")
                path = safe_rel(root, rel)
                if path is not None and path.is_file():
                    out.append(path)
            return out[:MAX_REPO_PY_FILES]
    except Exception:
        pass

    out: list[Path] = []
    skip = {".git", ".venv", "venv", "node_modules", "__pycache__"}
    for base, dirs, files in os.walk(root):
        dirs[:] = [item for item in dirs if item not in skip]
        for name in files:
            if not name.endswith(".py"):
                continue
            out.append(Path(base) / name)
            if len(out) >= MAX_REPO_PY_FILES:
                return out
    return out


def repo_import_index(
    root: Path,
) -> tuple[dict[str, list[dict[str, Any]]], set[str], int, int] | dict[str, Any]:
    sources = []
    total = 0
    for path in list_repo_python_files(root):
        try:
            raw = path.read_bytes()
        except Exception:
            continue
        if total + len(raw) > MAX_REPO_SOURCE_BYTES:
            break
        total += len(raw)
        sources.append(
            {
                "file": str(path.relative_to(root)).replace(os.sep, "/"),
                "source": raw.decode("utf-8", errors="replace"),
            }
        )

    result = call_bridge({"command": "index_sources", "sources": sources})
    if result.get("ok") is not True:
        return result

    aliases_raw = result.get("aliases")
    observed_raw = result.get("observed_modules")
    if not isinstance(aliases_raw, dict) or not isinstance(observed_raw, list):
        return fail("ruff_python_repo_index_invalid")

    aliases: dict[str, list[dict[str, Any]]] = {}
    for local, rows in aliases_raw.items():
        if isinstance(local, str) and isinstance(rows, list):
            aliases[local] = [row for row in rows if isinstance(row, dict)]

    return (
        aliases,
        {value for value in observed_raw if isinstance(value, str)},
        int(result.get("files") or len(sources)),
        int(result.get("bytes") or total),
    )


def requirement_names(root: Path) -> set[str]:
    names: set[str] = set()

    for path in root.glob("requirements*.txt"):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            match = REQ_NAME_RE.match(line)
            if match:
                names.add(match.group(1).lower().replace("_", "-"))

    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        except Exception:
            data = {}

        project = data.get("project") if isinstance(data, dict) else None
        if isinstance(project, dict):
            rows = list(project.get("dependencies") or [])
            optional = project.get("optional-dependencies")
            if isinstance(optional, dict):
                for group in optional.values():
                    rows.extend(group or [])
            for raw in rows:
                if isinstance(raw, str):
                    match = REQ_NAME_RE.match(raw)
                    if match:
                        names.add(match.group(1).lower().replace("_", "-"))

        tool = data.get("tool") if isinstance(data, dict) else None
        poetry = tool.get("poetry") if isinstance(tool, dict) else None
        deps = poetry.get("dependencies") if isinstance(poetry, dict) else None
        if isinstance(deps, dict):
            for name in deps:
                if str(name).lower() != "python":
                    names.add(str(name).lower().replace("_", "-"))

    return names


def install_roots() -> list[Path]:
    try:
        values = sysconfig.get_paths()
    except Exception:
        values = {}
    roots = []
    for key in ("purelib", "platlib"):
        raw = values.get(key)
        if raw:
            path = Path(raw)
            if path not in roots:
                roots.append(path)
    return roots


def installed_top_module(name: str) -> bool:
    if not PY_NAME_RE.fullmatch(name):
        return False
    for base in install_roots():
        if (base / f"{name}.py").is_file():
            return True
        if (base / name / "__init__.py").is_file():
            return True
        if any(base.glob(f"{name}.*.so")) or any(base.glob(f"{name}.*.pyd")):
            return True
    return False


def declared_modules(root: Path) -> set[str]:
    out = set()
    for dist in requirement_names(root):
        candidate = dist.replace("-", "_")
        if PY_NAME_RE.fullmatch(candidate) and installed_top_module(candidate):
            out.add(candidate)
    return out


def local_module_exists(root: Path, module: str) -> bool:
    if not PY_NAME_RE.fullmatch(module):
        return False
    return (root / f"{module}.py").is_file() or (root / module / "__init__.py").is_file()


def module_authority(
    module: str,
    *,
    root: Path,
    observed_modules: set[str],
    declared: set[str],
) -> str | None:
    top = module.split(".", 1)[0]
    if top in sys.stdlib_module_names:
        return "stdlib"
    if local_module_exists(root, top):
        return "repo_local"
    if top in observed_modules:
        return "repo_observed_dependency"
    if top in declared:
        return "declared_dependency"
    return None


def unique_binding(
    rows: list[dict[str, Any]],
    *,
    root: Path,
    observed_modules: set[str],
    declared: set[str],
) -> dict[str, Any] | None:
    candidates: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in rows:
        module = row.get("module")
        canonical = row.get("canonical")
        kind = row.get("kind")
        if not all(isinstance(value, str) and value for value in (module, canonical, kind)):
            continue
        authority = module_authority(
            module,
            root=root,
            observed_modules=observed_modules,
            declared=declared,
        )
        if authority is None:
            continue
        key = (kind, module, row.get("name"), canonical)
        candidates[key] = {**row, "authority": authority}

    if len(candidates) != 1:
        return None
    return next(iter(candidates.values()))



def _node_location(node: ast.AST) -> dict[str, int | None]:
    return {
        "lineno": getattr(node, "lineno", None),
        "col_offset": getattr(node, "col_offset", None),
        "end_lineno": getattr(node, "end_lineno", None),
        "end_col_offset": getattr(node, "end_col_offset", None),
    }


class ScopeLatticeVisitor(ast.NodeVisitor):
    """
    Compiler-internal structural scope tracker.

    This data is never model-facing. It exists to prove that semantic
    constructs remain in their original lexical/execution scope.
    """

    def __init__(self) -> None:
        self.lexical: list[str] = ["module"]
        self.regions: list[str] = []

        self.imports: list[dict[str, Any]] = []
        self.globals: list[dict[str, Any]] = []
        self.nonlocals: list[dict[str, Any]] = []

        self.scope_counts: dict[str, int] = {"module": 1}
        self.region_counts: dict[str, int] = {}
        self.max_scope_depth = 1
        self.max_region_depth = 0

    def _scope(
        self,
        kind: str,
        name: str,
        body: list[ast.stmt] | None = None,
        expression: ast.AST | None = None,
    ) -> None:
        segment = f"{kind}:{name}"
        self.lexical.append(segment)

        self.scope_counts[kind] = self.scope_counts.get(kind, 0) + 1
        self.max_scope_depth = max(
            self.max_scope_depth,
            len(self.lexical),
        )

        try:
            if body is not None:
                for row in body:
                    self.visit(row)
            elif expression is not None:
                self.visit(expression)
        finally:
            self.lexical.pop()

    def _region(
        self,
        kind: str,
        body: list[ast.stmt],
    ) -> None:
        self.regions.append(kind)
        self.region_counts[kind] = self.region_counts.get(kind, 0) + 1
        self.max_region_depth = max(
            self.max_region_depth,
            len(self.regions),
        )

        try:
            for row in body:
                self.visit(row)
        finally:
            self.regions.pop()

    def _record_import(
        self,
        *,
        node: ast.AST,
        kind: str,
        module: str,
        name: str | None,
        alias: str | None,
        local: str,
        level: int,
        star: bool,
    ) -> None:
        if len(self.imports) >= MAX_SCOPE_IMPORTS:
            raise ValueError("scope_import_budget_exceeded")

        self.imports.append(
            {
                "kind": kind,
                "module": module,
                "name": name,
                "alias": alias,
                "local": local,
                "level": level,
                "star": star,
                "lexical_path": list(self.lexical),
                "execution_path": list(self.regions),
                "scope_preserved": True,
                "model_authority": False,
                **_node_location(node),
            }
        )

    def visit_Import(self, node: ast.Import) -> None:
        for row in node.names:
            local = row.asname or row.name.split(".", 1)[0]
            self._record_import(
                node=node,
                kind="import",
                module=row.name,
                name=None,
                alias=row.asname,
                local=local,
                level=0,
                star=False,
            )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""

        for row in node.names:
            star = row.name == "*"
            local = row.asname or row.name

            self._record_import(
                node=node,
                kind="from",
                module=module,
                name=row.name,
                alias=row.asname,
                local=local,
                level=int(node.level or 0),
                star=star,
            )

    def visit_Global(self, node: ast.Global) -> None:
        self.globals.append(
            {
                "names": list(node.names),
                "lexical_path": list(self.lexical),
                "execution_path": list(self.regions),
                **_node_location(node),
            }
        )

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.nonlocals.append(
            {
                "names": list(node.names),
                "lexical_path": list(self.lexical),
                "execution_path": list(self.regions),
                **_node_location(node),
            }
        )

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._scope("function", node.name, body=node.body)

    def visit_AsyncFunctionDef(
        self,
        node: ast.AsyncFunctionDef,
    ) -> None:
        self._scope("async_function", node.name, body=node.body)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._scope("class", node.name, body=node.body)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self._scope("lambda", "<lambda>", expression=node.body)

    def _comprehension(
        self,
        kind: str,
        node: ast.AST,
    ) -> None:
        self.lexical.append(kind)
        self.scope_counts[kind] = self.scope_counts.get(kind, 0) + 1
        self.max_scope_depth = max(
            self.max_scope_depth,
            len(self.lexical),
        )
        try:
            self.generic_visit(node)
        finally:
            self.lexical.pop()

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._comprehension("list_comp", node)

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self._comprehension("set_comp", node)

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._comprehension("dict_comp", node)

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        self._comprehension("generator_exp", node)

    def visit_If(self, node: ast.If) -> None:
        self.visit(node.test)
        self._region("if.body", node.body)
        if node.orelse:
            self._region("if.else", node.orelse)

    def visit_For(self, node: ast.For) -> None:
        self.visit(node.target)
        self.visit(node.iter)
        self._region("for.body", node.body)
        if node.orelse:
            self._region("for.else", node.orelse)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self.visit(node.target)
        self.visit(node.iter)
        self._region("async_for.body", node.body)
        if node.orelse:
            self._region("async_for.else", node.orelse)

    def visit_While(self, node: ast.While) -> None:
        self.visit(node.test)
        self._region("while.body", node.body)
        if node.orelse:
            self._region("while.else", node.orelse)

    def _visit_try(
        self,
        node: ast.Try | Any,
    ) -> None:
        self._region("try.body", node.body)

        for index, handler in enumerate(node.handlers):
            if handler.type is not None:
                self.visit(handler.type)
            self._region(
                f"except[{index}]",
                handler.body,
            )

        if node.orelse:
            self._region("try.else", node.orelse)

        if node.finalbody:
            self._region("finally", node.finalbody)

    def visit_Try(self, node: ast.Try) -> None:
        self._visit_try(node)

    def visit_TryStar(self, node: Any) -> None:
        self._visit_try(node)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self.visit(item.optional_vars)
        self._region("with.body", node.body)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self.visit(item.optional_vars)
        self._region("async_with.body", node.body)

    def visit_Match(self, node: ast.Match) -> None:
        self.visit(node.subject)

        for index, case in enumerate(node.cases):
            self.visit(case.pattern)
            if case.guard is not None:
                self.visit(case.guard)
            self._region(
                f"match.case[{index}]",
                case.body,
            )


def analyze_scope_lattice(source: str) -> dict[str, Any]:
    try:
        tree = ast.parse(
            source,
            filename="<koalik-scope-lattice>",
            mode="exec",
        )
    except SyntaxError as exc:
        return fail(
            "semantic_python_scope_parse_failed",
            scope_protocol=SCOPE_PROTOCOL,
            detail=f"{exc.msg}:{exc.lineno}:{exc.offset}",
        )

    visitor = ScopeLatticeVisitor()

    try:
        visitor.visit(tree)
    except ValueError as exc:
        return fail(
            "semantic_python_scope_budget_exceeded",
            scope_protocol=SCOPE_PROTOCOL,
            detail=str(exc),
        )

    if visitor.max_scope_depth > MAX_SCOPE_DEPTH:
        return fail(
            "semantic_python_scope_depth_exceeded",
            scope_protocol=SCOPE_PROTOCOL,
            observed=visitor.max_scope_depth,
            max_depth=MAX_SCOPE_DEPTH,
        )

    if visitor.globals:
        return fail(
            "semantic_python_global_forbidden",
            scope_protocol=SCOPE_PROTOCOL,
            globals=visitor.globals,
        )

    if visitor.nonlocals:
        return fail(
            "semantic_python_nonlocal_forbidden",
            scope_protocol=SCOPE_PROTOCOL,
            nonlocals=visitor.nonlocals,
        )

    if any(row.get("star") is True for row in visitor.imports):
        return fail(
            "semantic_python_star_import_forbidden",
            scope_protocol=SCOPE_PROTOCOL,
        )

    return {
        "ok": True,
        "scope_protocol": SCOPE_PROTOCOL,
        "imports": visitor.imports,
        "summary": {
            "scope_counts": dict(sorted(visitor.scope_counts.items())),
            "region_counts": dict(sorted(visitor.region_counts.items())),
            "max_scope_depth": visitor.max_scope_depth,
            "max_region_depth": visitor.max_region_depth,
            "imports": len(visitor.imports),
            "globals": 0,
            "nonlocals": 0,
        },
    }


def _target_package_parts(
    root: Path,
    target_file: str,
) -> list[str] | None:
    target = safe_rel(root, target_file)
    if target is None:
        return None

    try:
        relative = target.relative_to(root.resolve())
    except Exception:
        return None

    parts = list(relative.parent.parts)

    # Relative imports require package-context proof.
    cursor = root.resolve()
    for part in parts:
        cursor = cursor / part
        if not (cursor / "__init__.py").is_file():
            return None

    return parts


def resolve_scoped_import_module(
    row: dict[str, Any],
    *,
    root: Path,
    target_file: str,
) -> str | None:
    module = row.get("module")
    level = row.get("level")

    if not isinstance(module, str) or not isinstance(level, int):
        return None

    if level == 0:
        return module or None

    package = _target_package_parts(root, target_file)
    if package is None:
        return None

    ascend = level - 1
    if ascend > len(package):
        return None

    base = package[: len(package) - ascend]

    if module:
        base.extend(module.split("."))

    return ".".join(part for part in base if part) or None


def authorize_scoped_imports(
    rows: list[dict[str, Any]],
    *,
    root: Path,
    target_file: str,
    observed_modules: set[str],
    declared: set[str],
) -> list[dict[str, Any]] | dict[str, Any]:
    authorized: list[dict[str, Any]] = []

    for index, row in enumerate(rows):
        resolved = resolve_scoped_import_module(
            row,
            root=root,
            target_file=target_file,
        )

        if not resolved:
            return fail(
                "semantic_python_scoped_import_unresolved",
                scope_protocol=SCOPE_PROTOCOL,
                import_index=index,
                import_row=row,
            )

        authority = module_authority(
            resolved,
            root=root,
            observed_modules=observed_modules,
            declared=declared,
        )

        if authority is None:
            return fail(
                "semantic_python_scoped_import_unauthorized",
                scope_protocol=SCOPE_PROTOCOL,
                import_index=index,
                module=resolved,
                lexical_path=row.get("lexical_path"),
                execution_path=row.get("execution_path"),
            )

        authorized.append(
            {
                **row,
                "resolved_module": resolved,
                "authority": authority,
                "scope_preserved": True,
                "model_authority": False,
            }
        )

    return authorized


def scope_import_fingerprint(
    rows: list[dict[str, Any]],
) -> str:
    semantic = [
        {
            "kind": row.get("kind"),
            "module": row.get("module"),
            "name": row.get("name"),
            "alias": row.get("alias"),
            "local": row.get("local"),
            "level": row.get("level"),
            "lexical_path": row.get("lexical_path"),
            "execution_path": row.get("execution_path"),
        }
        for row in rows
    ]
    return stable_sha(semantic)


ROUTE_LITERAL_RE = re.compile(
    r"\.route\(\s*([\"\'])((?:(?!\1).)+)\1",
)


def route_literals(decorators: set[str]) -> set[str]:
    out: set[str] = set()
    for decorator in decorators:
        match = ROUTE_LITERAL_RE.search(decorator)
        if match:
            out.add(match.group(2))
    return out


def global_references(source: str, explicit_loads: set[str]) -> set[str]:
    table = symtable.symtable(source, "<koalik-ruff-unit-shell>", "exec")
    out: set[str] = set()

    def visit(current: symtable.SymbolTable) -> None:
        for symbol in current.get_symbols():
            name = symbol.get_name()
            if name in explicit_loads and symbol.is_referenced() and symbol.is_global():
                out.add(name)
        for child in current.get_children():
            visit(child)

    visit(table)
    return out


def apply_load_rewrites(
    source: str,
    *,
    load_ranges: list[dict[str, Any]],
    mapping: dict[str, str],
) -> str:
    raw = bytearray(source.encode("utf-8"))
    edits = []
    for row in load_ranges:
        name = row.get("name")
        if name not in mapping:
            continue
        start = row.get("start")
        end = row.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            raise ValueError("invalid Ruff load range")
        edits.append((start, end, mapping[name].encode("utf-8")))

    for start, end, replacement in sorted(edits, reverse=True):
        raw[start:end] = replacement

    return raw.decode("utf-8")



CANONICALIZER_SUCCESS_FIELDS = frozenset(
    {
        "ok",
        "protocol",
        "canonicalizer_protocol",
        "body",
        "import_hints",
        "normalizations",
        "authority_expansion",
    }
)

CANONICALIZER_NORMALIZATIONS = frozenset(
    {
        "redundant_function_wrapper_removed",
        "redundant_wrapper_return_omission",
        "redundant_wrapper_decorator_omission",
        "scoped_prefix_import_preserved",
        "scoped_nested_import_preserved",
        "static_import_intent_extracted",
    }
)

CANONICALIZER_IMPORT_FIELDS = frozenset(
    {
        "kind",
        "module",
        "name",
        "local",
        "canonical",
        "alias",
        "source",
    }
)

CANONICALIZER_IMPORT_REQUIRED_FIELDS = frozenset(
    {
        "kind",
        "module",
        "local",
        "canonical",
        "source",
    }
)


def validate_canonicalizer_success(
    result: dict[str, Any],
    *,
    unit_index: int,
) -> dict[str, Any] | None:
    observed_fields = set(result)
    if observed_fields != CANONICALIZER_SUCCESS_FIELDS:
        return fail(
            "semantic_python_canonicalizer_shape_invalid",
            unit_index=unit_index,
            observed_fields=sorted(observed_fields),
        )

    if result.get("canonicalizer_protocol") != CANONICALIZER_PROTOCOL:
        return fail(
            "semantic_python_canonicalizer_protocol_mismatch",
            unit_index=unit_index,
            observed=result.get("canonicalizer_protocol"),
        )

    if result.get("authority_expansion") is not False:
        return fail(
            "semantic_python_canonicalizer_authority_expansion",
            unit_index=unit_index,
            observed=result.get("authority_expansion"),
        )

    body = result.get("body")
    if not isinstance(body, str) or not body.strip():
        return fail(
            "semantic_python_canonical_body_invalid",
            unit_index=unit_index,
        )

    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        return fail(
            "semantic_python_canonical_body_budget_exceeded",
            unit_index=unit_index,
        )

    import_hints = result.get("import_hints")
    if not isinstance(import_hints, list):
        return fail(
            "semantic_python_canonical_import_hints_invalid",
            unit_index=unit_index,
        )

    for hint_index, hint in enumerate(import_hints):
        if not isinstance(hint, dict):
            return fail(
                "semantic_python_canonical_import_hint_invalid",
                unit_index=unit_index,
                hint_index=hint_index,
            )

        fields = set(hint)
        if (
            not CANONICALIZER_IMPORT_REQUIRED_FIELDS.issubset(fields)
            or not fields.issubset(CANONICALIZER_IMPORT_FIELDS)
        ):
            return fail(
                "semantic_python_canonical_import_hint_shape_invalid",
                unit_index=unit_index,
                hint_index=hint_index,
                observed_fields=sorted(fields),
            )

        for field in (
            "kind",
            "module",
            "local",
            "canonical",
            "source",
        ):
            value = hint.get(field)
            if not isinstance(value, str) or not value:
                return fail(
                    "semantic_python_canonical_import_hint_field_invalid",
                    unit_index=unit_index,
                    hint_index=hint_index,
                    field=field,
                )

        if hint.get("source") != "model_static_import_hint":
            return fail(
                "semantic_python_canonical_import_hint_authority_invalid",
                unit_index=unit_index,
                hint_index=hint_index,
                observed=hint.get("source"),
            )

        for field in ("name", "alias"):
            value = hint.get(field)
            if value is not None and not isinstance(value, str):
                return fail(
                    "semantic_python_canonical_import_hint_field_invalid",
                    unit_index=unit_index,
                    hint_index=hint_index,
                    field=field,
                )

    normalizations = result.get("normalizations")
    if (
        not isinstance(normalizations, list)
        or any(not isinstance(value, str) for value in normalizations)
    ):
        return fail(
            "semantic_python_canonical_normalizations_invalid",
            unit_index=unit_index,
        )

    unknown = sorted(
        {
            value
            for value in normalizations
            if value not in CANONICALIZER_NORMALIZATIONS
        }
    )
    if unknown:
        return fail(
            "semantic_python_canonical_normalization_unknown",
            unit_index=unit_index,
            normalizations=unknown,
        )

    if len(set(normalizations)) != len(normalizations):
        return fail(
            "semantic_python_canonical_normalizations_duplicate",
            unit_index=unit_index,
        )

    return None

def validate_external_import_hints(value: Any) -> list[dict[str, Any]] | dict[str, Any]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_SCOPE_IMPORTS:
        return fail(
            "semantic_python_external_import_hints_invalid",
            max_imports=MAX_SCOPE_IMPORTS,
        )

    normalized: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            return fail(
                "semantic_python_external_import_hint_invalid",
                import_index=index,
            )
        fields = set(raw)
        if (
            not CANONICALIZER_IMPORT_REQUIRED_FIELDS.issubset(fields)
            or not fields.issubset(CANONICALIZER_IMPORT_FIELDS)
        ):
            return fail(
                "semantic_python_external_import_hint_shape_invalid",
                import_index=index,
                observed_fields=sorted(fields),
            )
        for field in ("kind", "module", "local", "canonical", "source"):
            item = raw.get(field)
            if not isinstance(item, str) or not item:
                return fail(
                    "semantic_python_external_import_hint_field_invalid",
                    import_index=index,
                    field=field,
                )
        if raw.get("source") != "model_static_import_hint":
            return fail(
                "semantic_python_external_import_hint_authority_invalid",
                import_index=index,
            )
        kind = raw.get("kind")
        name = raw.get("name")
        alias = raw.get("alias")
        if kind not in {"module", "from"}:
            return fail(
                "semantic_python_external_import_hint_kind_invalid",
                import_index=index,
            )
        if alias is not None and (not isinstance(alias, str) or not alias):
            return fail(
                "semantic_python_external_import_hint_field_invalid",
                import_index=index,
                field="alias",
            )
        if kind == "module":
            if name is not None:
                return fail(
                    "semantic_python_external_import_hint_name_invalid",
                    import_index=index,
                )
        elif not isinstance(name, str) or not name:
            return fail(
                "semantic_python_external_import_hint_name_invalid",
                import_index=index,
            )

        row = {
            "kind": kind,
            "module": raw["module"],
            "name": name,
            "local": raw["local"],
            "canonical": raw["canonical"],
            "alias": alias,
            "source": "model_static_import_hint",
        }
        key = (
            row["kind"],
            row["module"],
            row["name"],
            row["local"],
            row["canonical"],
            row["alias"],
            row["source"],
        )
        if key in seen:
            continue
        seen.add(key)
        normalized.append(row)
    return normalized


def canonicalize_units(
    units: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]] | dict[str, Any]:
    normalized = []
    import_hints = []
    ledger = []

    for index, unit in enumerate(units):
        if not isinstance(unit, dict):
            return fail("python_unit_shape_invalid", unit_index=index)

        kind = unit.get("kind")
        if kind in {"function", "async_function"}:
            result = call_bridge({"command": "canonicalize_unit", "unit": unit})
            if result.get("ok") is not True:
                return fail(
                    result.get("reason") or "semantic_python_canonicalization_failed",
                    canonicalizer=result,
                    unit_index=index,
                )
            contract_failure = validate_canonicalizer_success(
                result,
                unit_index=index,
            )
            if contract_failure is not None:
                return contract_failure

            body = result.get("body")
            if not isinstance(body, str) or not body.strip():
                return fail("semantic_python_canonical_body_invalid", unit_index=index)
            row = dict(unit)
            row["body"] = body
            normalized.append(row)
            hints = result.get("import_hints")
            if isinstance(hints, list):
                import_hints.extend(value for value in hints if isinstance(value, dict))
            norms = result.get("normalizations")
            if isinstance(norms, list):
                ledger.extend(str(value) for value in norms)
        else:
            normalized.append(dict(unit))

    return normalized, import_hints, ledger


def compile_units(payload: dict[str, Any]) -> dict[str, Any]:
    root_raw = payload.get("root")
    target_file = payload.get("target_file")
    source = payload.get("source")
    units = payload.get("units")
    operation_id = payload.get("operation_id")
    capability_sha = payload.get("capability_sha256")

    if not (
        isinstance(root_raw, str)
        and isinstance(target_file, str)
        and isinstance(source, str)
        and isinstance(operation_id, str)
        and isinstance(units, list)
    ):
        return fail("python_unit_input_invalid")

    if not (1 <= len(units) <= MAX_UNITS):
        return fail("python_unit_count_invalid", units=len(units), max_units=MAX_UNITS)

    external_import_hints = validate_external_import_hints(
        payload.get("module_import_hints", [])
    )
    if isinstance(external_import_hints, dict):
        return external_import_hints

    root = Path(root_raw).resolve()
    if safe_rel(root, target_file) is None:
        return fail("python_unit_target_escape")

    source_facts = call_bridge({"command": "analyze", "source": source})
    if source_facts.get("ok") is not True:
        return fail(
            source_facts.get("reason") or "semantic_python_source_invalid",
            ruff=source_facts,
        )

    canonical = canonicalize_units(units)
    if isinstance(canonical, dict):
        return canonical
    normalized_units, model_import_hints, normalization_ledger = canonical

    merged_import_hints: list[dict[str, Any]] = []
    seen_import_hints: set[tuple[Any, ...]] = set()
    for row in [*model_import_hints, *external_import_hints]:
        key = (
            row.get("kind"),
            row.get("module"),
            row.get("name"),
            row.get("local"),
            row.get("canonical"),
            row.get("alias"),
            row.get("source"),
        )
        if key in seen_import_hints:
            continue
        seen_import_hints.add(key)
        merged_import_hints.append(row)
    model_import_hints = merged_import_hints

    try:
        rendered = [render_unit(row, index) for index, row in enumerate(normalized_units)]
    except ValueError as exc:
        try:
            detail = json.loads(str(exc))
        except Exception:
            detail = {"reason": "python_unit_compile_failed"}
        reason = detail.pop("reason", "python_unit_compile_failed")
        return fail(reason, **detail)

    source_text = "\n\n".join(rendered).strip()
    if len(source_text.encode("utf-8")) > MAX_UNIT_SOURCE_BYTES:
        return fail("python_unit_source_budget_exceeded", max_bytes=MAX_UNIT_SOURCE_BYTES)

    facts = call_bridge({"command": "analyze", "source": source_text})
    if facts.get("ok") is not True:
        return fail(
            facts.get("reason") or "semantic_python_render_invalid",
            ruff=facts,
        )

    scope = analyze_scope_lattice(source_text)
    if scope.get("ok") is not True:
        return scope

    scoped_import_rows = scope.get("imports")
    if not isinstance(scoped_import_rows, list):
        return fail(
            "semantic_python_scope_output_invalid",
            scope_protocol=SCOPE_PROTOCOL,
        )

    ruff_import_rows = facts.get("imports")
    if not isinstance(ruff_import_rows, list):
        return fail(
            "semantic_python_ruff_import_facts_invalid",
            scope_protocol=SCOPE_PROTOCOL,
        )

    # Ruff remains syntax/AST authority. CPython AST is used here only
    # for Python lexical/execution scope semantics. Their import
    # cardinalities must agree before we authorize anything.
    if len(ruff_import_rows) != len(scoped_import_rows):
        return fail(
            "semantic_python_scope_parser_disagreement",
            scope_protocol=SCOPE_PROTOCOL,
            ruff_imports=len(ruff_import_rows),
            scope_imports=len(scoped_import_rows),
        )

    initial_scope_fingerprint = scope_import_fingerprint(
        scoped_import_rows
    )
    if facts.get("has_global") is True or facts.get("has_nonlocal") is True:
        return fail("semantic_python_scope_escape_forbidden")

    existing_names = {
        value for value in source_facts.get("top_names", []) if isinstance(value, str)
    }
    new_names = {value for value in facts.get("top_names", []) if isinstance(value, str)}
    collisions = sorted(existing_names & new_names)
    if collisions:
        return fail("semantic_python_existing_symbol_forbidden", symbols=collisions)

    existing_decorators = {
        value for value in source_facts.get("decorators", []) if isinstance(value, str)
    }
    new_decorators = {
        value for value in facts.get("decorators", []) if isinstance(value, str)
    }
    route_collisions = sorted(
        route_literals(existing_decorators)
        & route_literals(new_decorators)
    )
    if route_collisions:
        return fail(
            "semantic_python_existing_route_forbidden",
            routes=route_collisions,
        )

    repo_index = repo_import_index(root)
    if isinstance(repo_index, dict):
        return repo_index
    repo_aliases, observed_modules, scanned_files, scanned_bytes = repo_index

    scoped_imports = authorize_scoped_imports(
        scoped_import_rows,
        root=root,
        target_file=target_file,
        observed_modules=observed_modules,
        declared=declared_modules(root),
    )
    if isinstance(scoped_imports, dict):
        return scoped_imports

    scope_summary = scope["summary"]
    scope_sha256 = stable_sha(
        {
            "scope_protocol": SCOPE_PROTOCOL,
            "imports": scoped_imports,
            "summary": scope_summary,
        }
    )
    declared = declared_modules(root)

    hint_map: dict[str, list[dict[str, Any]]] = {}
    for row in model_import_hints:
        local = row.get("local")
        if isinstance(local, str):
            hint_map.setdefault(local, []).append(row)

    explicit_loads = {
        value for value in facts.get("loads", []) if isinstance(value, str)
    }
    free = global_references(source_text, explicit_loads)

    builtins_set = set(dir(builtins))
    unresolved = sorted(
        free
        - existing_names
        - new_names
        - builtins_set
        - {"__name__", "__file__", "__package__"}
    )

    selected: dict[str, dict[str, Any]] = {}
    alias_map: dict[str, str] = {}

    for name in unresolved:
        candidates = [
            *hint_map.get(name, []),
            *repo_aliases.get(name, []),
        ]
        chosen = unique_binding(
            candidates,
            root=root,
            observed_modules=observed_modules,
            declared=declared,
        )

        if chosen is None and name in sys.stdlib_module_names:
            chosen = {
                "kind": "module",
                "module": name,
                "canonical": name,
                "local": name,
                "source": "stdlib_module",
                "authority": "stdlib",
            }

        if chosen is None and (
            local_module_exists(root, name)
            or name in observed_modules
            or name in declared
        ):
            authority = module_authority(
                name,
                root=root,
                observed_modules=observed_modules,
                declared=declared,
            )
            if authority:
                chosen = {
                    "kind": "module",
                    "module": name,
                    "canonical": name,
                    "local": name,
                    "source": "authorized_module_name",
                    "authority": authority,
                }

        if chosen is None:
            return fail(
                "semantic_python_binding_unresolved",
                symbol=name,
                free_names=unresolved,
                repo_python_files_scanned=scanned_files,
                repo_python_bytes_scanned=scanned_bytes,
            )

        selected[name] = chosen
        canonical_name = chosen.get("canonical")
        if isinstance(canonical_name, str) and canonical_name != name:
            alias_map[name] = canonical_name

    if alias_map:
        shadowed = {
            value for value in facts.get("stores", []) if isinstance(value, str)
        } | {
            value for value in facts.get("parameters", []) if isinstance(value, str)
        }
        conflict = sorted(set(alias_map) & shadowed)
        if conflict:
            return fail("semantic_python_alias_shadowed", symbols=conflict)

        try:
            source_text = apply_load_rewrites(
                source_text,
                load_ranges=[
                    value
                    for value in facts.get("load_ranges", [])
                    if isinstance(value, dict)
                ],
                mapping=alias_map,
            )
        except Exception:
            return fail("semantic_python_alias_rewrite_failed")

        normalization_ledger.append("alias_canonicalized")
        facts = call_bridge({"command": "analyze", "source": source_text})
        if facts.get("ok") is not True:
            return fail("semantic_python_alias_rewrite_invalid", ruff=facts)

    final_loads = {
        value for value in facts.get("loads", []) if isinstance(value, str)
    }
    final_scope = analyze_scope_lattice(source_text)
    if final_scope.get("ok") is not True:
        return final_scope

    final_scope_imports = final_scope.get("imports")
    if not isinstance(final_scope_imports, list):
        return fail(
            "semantic_python_final_scope_invalid",
            scope_protocol=SCOPE_PROTOCOL,
        )

    if (
        scope_import_fingerprint(final_scope_imports)
        != initial_scope_fingerprint
    ):
        return fail(
            "semantic_python_scope_changed_by_normalization",
            scope_protocol=SCOPE_PROTOCOL,
        )

    final_free = global_references(source_text, final_loads)
    final_allowed = (
        existing_names
        | new_names
        | builtins_set
        | {
            row["canonical"]
            for row in selected.values()
            if isinstance(row.get("canonical"), str)
        }
        | {"__name__", "__file__", "__package__"}
    )
    residue = sorted(final_free - final_allowed)
    if residue:
        return fail("semantic_python_binding_closure_incomplete", symbols=residue)

    existing_modules = {
        value for value in source_facts.get("module_imports", []) if isinstance(value, str)
    }
    existing_from = {
        (row.get("module"), row.get("name"))
        for row in source_facts.get("from_imports", [])
        if isinstance(row, dict)
        and isinstance(row.get("module"), str)
        and isinstance(row.get("name"), str)
    }

    modules: set[str] = set()
    from_imports: set[tuple[str, str]] = set()
    binding_rows = []

    for original, row in sorted(selected.items()):
        if row.get("kind") == "module":
            module = row["module"]
            if module not in existing_modules:
                modules.add(module)
        else:
            pair = (row["module"], row["name"])
            if pair not in existing_from:
                from_imports.add(pair)

        binding_rows.append(
            {
                "symbol": original,
                "canonical": row["canonical"],
                "kind": row["kind"],
                "module": row["module"],
                "name": row.get("name"),
                "authority": row["authority"],
                "evidence": row.get("source"),
                "model_import_authority": False,
            }
        )

    operation_material = {
        "operation_id": operation_id,
        "target_file": target_file,
        "target_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "normalized_units": normalized_units,
        "declaration": source_text,
        "modules": sorted(modules),
        "from_imports": sorted(from_imports),
        "capability_sha256": capability_sha if isinstance(capability_sha, str) else None,
        "normalizations": sorted(set(normalization_ledger)),
    }
    operation_sha = stable_sha(operation_material)
    marker = operation_sha[:8]
    annotated = (
        f"# koalik:begin {operation_id}:{marker}\n"
        f"{source_text}\n"
        f"# koalik:end {operation_id}"
    )

    return {
        "ok": True,
        "protocol": PROTOCOL,
        "unit_protocol": UNIT_PROTOCOL,
        "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
        "ruff_bridge_protocol": RUFF_BRIDGE_PROTOCOL,
        "binding_protocol": BINDING_PROTOCOL,
        "provenance_protocol": PROVENANCE_PROTOCOL,
        "agent": "koalik",
        "declaration": annotated,
        "raw_declaration": source_text,
        "modules": sorted(modules),
        "from_imports": [
            {"module": module, "name": name}
            for module, name in sorted(from_imports)
        ],
        "bindings": binding_rows,
        "alias_rewrites": dict(sorted(alias_map.items())),
        "unit_names": sorted(new_names),
        "normalizations": sorted(set(normalization_ledger)),
        "model_import_hints": model_import_hints,
        "scope_protocol": SCOPE_PROTOCOL,
        "scope_sha256": scope_sha256,
        "scoped_imports": scoped_imports,
        "scope_summary": scope_summary,
        "model_import_authority": False,
        "provenance": {
            "protocol": PROVENANCE_PROTOCOL,
            "agent": "koalik",
            "operation_id": operation_id,
            "operation_sha256": operation_sha,
            "marker": marker,
            "target_file": target_file,
            "timestamp_authority": "external_ledger_only",
            "model_authority": False,
        },
        "repo_python_files_scanned": scanned_files,
        "repo_python_bytes_scanned": scanned_bytes,
        "mutation_authority": False,
        "authority_expansion": False,
    }


def dependency_evidence(root_raw: str) -> dict[str, Any]:
    try:
        root = Path(root_raw).expanduser().resolve()
    except Exception:
        root = Path(root_raw)

    if not root.is_dir():
        return {
            "ok": False,
            "protocol": DEPENDENCY_EVIDENCE_PROTOCOL,
            "reason": "python_dependency_root_invalid",
            "declared_distributions": [],
            "declared_modules": [],
            "manifest_files": [],
            "truncated": False,
            "absence_authority": False,
            "mutation_authority": False,
            "model_import_authority": False,
        }

    manifest_files = sorted(
        {
            path.name
            for path in root.glob("requirements*.txt")
            if path.is_file()
        }
        | ({"pyproject.toml"} if (root / "pyproject.toml").is_file() else set())
    )

    distributions_all = sorted(requirement_names(root))
    modules_all = sorted(declared_modules(root))

    distributions = distributions_all[:MAX_DEPENDENCY_EVIDENCE_ITEMS]
    modules = modules_all[:MAX_DEPENDENCY_EVIDENCE_ITEMS]

    return {
        "ok": True,
        "protocol": DEPENDENCY_EVIDENCE_PROTOCOL,
        "reason": "source_backed_dependency_evidence",
        "declared_distributions": distributions,
        "declared_modules": modules,
        "manifest_files": manifest_files[:16],
        "truncated": (
            len(distributions_all) > len(distributions)
            or len(modules_all) > len(modules)
            or len(manifest_files) > 16
        ),
        # Positive evidence only. A missing item is never evidence of absence:
        # manifests may be incomplete, malformed, or use distribution/module
        # names that do not map one-to-one.
        "absence_authority": False,
        "mutation_authority": False,
        "model_import_authority": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", action="store_true")
    parser.add_argument("--bridge-protocol", action="store_true")
    parser.add_argument("--dependency-evidence")
    args = parser.parse_args()

    if args.dependency_evidence:
        print(
            json.dumps(
                dependency_evidence(args.dependency_evidence),
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 0

    if args.protocol:
        print(PROTOCOL)
        return 0
    if args.bridge_protocol:
        result = call_bridge({"command": "protocol"})
        print(json.dumps(result, sort_keys=True))
        return 0 if result.get("ok") is True else 2

    try:
        payload = json.load(sys.stdin)
    except Exception:
        print(json.dumps(fail("python_unit_json_invalid")))
        return 0

    if not isinstance(payload, dict):
        print(json.dumps(fail("python_unit_json_invalid")))
        return 0

    print(
        json.dumps(
            compile_units(payload),
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
