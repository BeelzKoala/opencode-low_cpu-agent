#!/usr/bin/env python3
from __future__ import annotations

import ast
import hashlib
from collections import Counter
from pathlib import Path
from types import MappingProxyType
from typing import Any, Iterable


SEMANTIC_PRESERVATION_PROTOCOL = "semantic-preservation-v1"
SEMANTIC_FACT_PROTOCOL = "semantic-fact-v1"
SEMANTIC_POLICY_REGISTRY_PROTOCOL = "semantic-policy-registry-v1"
SEMANTIC_DETECTOR_REGISTRY_PROTOCOL = "semantic-detector-registry-v1"
SEMANTIC_ALLOWED_DELTA_PROTOCOL = "semantic-allowed-delta-v1"

PYTHON_NAMESPACE = "python.module"
PYTHON_DETECTOR_ID = "python_ast_top_level_v1"

_ALLOWED_CHANGES = frozenset({"modify", "remove"})


def _policy() -> MappingProxyType:
    return MappingProxyType({
        "mode": "allow_additive_preserve_existing",
        "requires_semantic_key_for_allowed_delta": True,
        "mutation_authority": False,
    })


# Static registries only. Runtime registration is intentionally absent.
POLICY_REGISTRY = MappingProxyType({
    (PYTHON_NAMESPACE, "module_docstring"): _policy(),
    (PYTHON_NAMESPACE, "import"): _policy(),
    (PYTHON_NAMESPACE, "assignment"): _policy(),
    (PYTHON_NAMESPACE, "function"): _policy(),
    (PYTHON_NAMESPACE, "async_function"): _policy(),
    (PYTHON_NAMESPACE, "class"): _policy(),
    (PYTHON_NAMESPACE, "statement"): _policy(),
})

DETECTOR_REGISTRY = MappingProxyType({
    ("python", "module"): PYTHON_DETECTOR_ID,
})

DETECTOR_POLICY_KEYS = MappingProxyType({
    PYTHON_DETECTOR_ID: frozenset(POLICY_REGISTRY.keys()),
})


def _sha_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _node_hash(node: ast.AST) -> str:
    return _sha_text(
        ast.dump(
            node,
            annotate_fields=True,
            include_attributes=False,
        )
    )


def _fail(reason: str, **extra: Any) -> dict[str, Any]:
    return {
        "protocol": SEMANTIC_PRESERVATION_PROTOCOL,
        "ok": False,
        "verdict": "FAIL",
        "reason": reason,
        "mutation_authority": False,
        **extra,
    }


def policy_for(namespace: str, kind: str) -> MappingProxyType | None:
    return POLICY_REGISTRY.get((namespace, kind))


def detector_for(language: str, scope: str) -> str | None:
    return DETECTOR_REGISTRY.get((language, scope))


def _stable_key(path: str, kind: str, identity: str) -> str:
    return f"{path}::{kind}::{identity}"


def _fact(
    *,
    path: str,
    kind: str,
    node: ast.AST,
    line: int,
    semantic_key: str | None,
    identity_status: str,
    identity_reason: str,
) -> dict[str, Any]:
    return {
        "protocol": SEMANTIC_FACT_PROTOCOL,
        "detector_id": PYTHON_DETECTOR_ID,
        "namespace": PYTHON_NAMESPACE,
        "kind": kind,
        "path": path,
        "semantic_key": semantic_key,
        "identity_status": identity_status,
        "identity_reason": identity_reason,
        "semantic_hash": _node_hash(node),
        "line": line,
        "mutation_authority": False,
    }


def _import_identity(node: ast.Import | ast.ImportFrom) -> str:
    if isinstance(node, ast.Import):
        parts = [
            f"{alias.name} as {alias.asname}" if alias.asname else alias.name
            for alias in node.names
        ]
        return "import:" + ",".join(parts)

    module = node.module or ""
    prefix = "." * int(node.level or 0)
    names = [
        f"{alias.name} as {alias.asname}" if alias.asname else alias.name
        for alias in node.names
    ]
    return f"from:{prefix}{module}:" + ",".join(names)


def _assignment_identity(node: ast.Assign | ast.AnnAssign) -> str | None:
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return node.target.id
    if (
        isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
    ):
        return node.targets[0].id
    return None


def _classify_top_level(
    *,
    path: str,
    node: ast.stmt,
    index: int,
) -> dict[str, Any]:
    line = int(getattr(node, "lineno", 0) or 0)

    if (
        index == 0
        and isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    ):
        return _fact(
            path=path,
            kind="module_docstring",
            node=node,
            line=line,
            semantic_key=_stable_key(path, "module_docstring", "__module__"),
            identity_status="stable",
            identity_reason="module_singleton",
        )

    if isinstance(node, ast.FunctionDef):
        return _fact(
            path=path,
            kind="function",
            node=node,
            line=line,
            semantic_key=_stable_key(path, "function", node.name),
            identity_status="stable",
            identity_reason="named_top_level_declaration",
        )

    if isinstance(node, ast.AsyncFunctionDef):
        return _fact(
            path=path,
            kind="async_function",
            node=node,
            line=line,
            semantic_key=_stable_key(path, "async_function", node.name),
            identity_status="stable",
            identity_reason="named_top_level_declaration",
        )

    if isinstance(node, ast.ClassDef):
        return _fact(
            path=path,
            kind="class",
            node=node,
            line=line,
            semantic_key=_stable_key(path, "class", node.name),
            identity_status="stable",
            identity_reason="named_top_level_declaration",
        )

    if isinstance(node, (ast.Import, ast.ImportFrom)):
        identity = _import_identity(node)
        return _fact(
            path=path,
            kind="import",
            node=node,
            line=line,
            semantic_key=_stable_key(path, "import", identity),
            identity_status="stable",
            identity_reason="canonical_import_identity",
        )

    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        identity = _assignment_identity(node)
        if identity is not None:
            return _fact(
                path=path,
                kind="assignment",
                node=node,
                line=line,
                semantic_key=_stable_key(path, "assignment", identity),
                identity_status="stable",
                identity_reason="single_named_assignment_target",
            )

        return _fact(
            path=path,
            kind="assignment",
            node=node,
            line=line,
            semantic_key=None,
            identity_status="content_only",
            identity_reason="no_stable_named_identity",
        )

    return _fact(
        path=path,
        kind="statement",
        node=node,
        line=line,
        semantic_key=None,
        identity_status="content_only",
        identity_reason="no_stable_named_identity",
    )


def _validate_fact(fact: dict[str, Any]) -> str | None:
    if fact.get("protocol") != SEMANTIC_FACT_PROTOCOL:
        return "semantic_fact_protocol_invalid"

    detector_id = fact.get("detector_id")
    namespace = fact.get("namespace")
    kind = fact.get("kind")

    if not isinstance(detector_id, str) or detector_id not in DETECTOR_POLICY_KEYS:
        return "semantic_detector_unregistered"
    if not isinstance(namespace, str) or not isinstance(kind, str):
        return "semantic_fact_kind_invalid"

    registry_key = (namespace, kind)
    if registry_key not in DETECTOR_POLICY_KEYS[detector_id]:
        return "semantic_detector_policy_kind_unregistered"
    if policy_for(namespace, kind) is None:
        return "semantic_policy_unregistered"

    if fact.get("identity_status") == "stable":
        semantic_key = fact.get("semantic_key")
        if not isinstance(semantic_key, str) or not semantic_key:
            return "semantic_fact_stable_key_missing"
    elif fact.get("identity_status") == "content_only":
        if fact.get("semantic_key") is not None:
            return "semantic_fact_unstable_key_forbidden"
    else:
        return "semantic_fact_identity_status_invalid"

    digest = fact.get("semantic_hash")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(ch not in "0123456789abcdef" for ch in digest)
    ):
        return "semantic_fact_hash_invalid"

    return None


def detect_python_source(
    *,
    path: str,
    source: str,
) -> dict[str, Any]:
    if detector_for("python", "module") != PYTHON_DETECTOR_ID:
        return _fail("semantic_detector_registry_drift")
    if not isinstance(path, str) or not path or not isinstance(source, str):
        return _fail("semantic_detector_input_invalid")

    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        return _fail(
            "semantic_detector_python_parse_failed",
            path=path,
            line=exc.lineno,
            offset=exc.offset,
        )

    facts = [
        _classify_top_level(path=path, node=node, index=index)
        for index, node in enumerate(tree.body)
    ]

    key_counts = Counter(
        fact["semantic_key"]
        for fact in facts
        if fact["identity_status"] == "stable"
        and isinstance(fact["semantic_key"], str)
    )

    normalized: list[dict[str, Any]] = []
    for fact in facts:
        semantic_key = fact.get("semantic_key")
        if (
            fact.get("identity_status") == "stable"
            and isinstance(semantic_key, str)
            and key_counts[semantic_key] > 1
        ):
            fact = {
                **fact,
                "semantic_key": None,
                "identity_status": "content_only",
                "identity_reason": "semantic_key_collision",
            }

        error = _validate_fact(fact)
        if error is not None:
            return _fail(
                error,
                path=path,
                detector_id=PYTHON_DETECTOR_ID,
                fact=fact,
            )
        normalized.append(fact)

    stable = sum(
        1
        for fact in normalized
        if fact["identity_status"] == "stable"
    )
    content_only = len(normalized) - stable

    return {
        "protocol": SEMANTIC_PRESERVATION_PROTOCOL,
        "ok": True,
        "verdict": "PASS",
        "reason": "semantic_python_top_level_detected",
        "detector_registry_protocol": SEMANTIC_DETECTOR_REGISTRY_PROTOCOL,
        "policy_registry_protocol": SEMANTIC_POLICY_REGISTRY_PROTOCOL,
        "detector_id": PYTHON_DETECTOR_ID,
        "path": path,
        "facts": normalized,
        "facts_total": len(normalized),
        "stable_identity_facts": stable,
        "content_only_facts": content_only,
        "scan_complete": True,
        "policy_complete": True,
        # Do not conflate scan completeness with identity strength.
        "stable_identity_complete": content_only == 0,
        "complete": True,
        "mutation_authority": False,
    }


def _validate_allowed_delta(
    raw: Any,
    before_by_key: dict[str, dict[str, Any]],
) -> tuple[dict[str, str] | None, str | None]:
    if raw is None:
        raw = []
    if not isinstance(raw, (list, tuple)):
        return None, "semantic_allowed_delta_invalid"

    result: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict):
            return None, "semantic_allowed_delta_item_invalid"
        if set(item) != {"semantic_key", "change"}:
            return None, "semantic_allowed_delta_shape_invalid"

        semantic_key = item.get("semantic_key")
        change = item.get("change")
        if (
            not isinstance(semantic_key, str)
            or not semantic_key
            or change not in _ALLOWED_CHANGES
        ):
            return None, "semantic_allowed_delta_value_invalid"

        baseline = before_by_key.get(semantic_key)
        if baseline is None:
            return None, "semantic_allowed_delta_key_not_in_baseline"
        if baseline.get("identity_status") != "stable":
            return None, "semantic_allowed_delta_unstable_identity"

        previous = result.get(semantic_key)
        if previous is not None and previous != change:
            return None, "semantic_allowed_delta_conflict"
        result[semantic_key] = change

    return result, None


def _content_counter(
    facts: Iterable[dict[str, Any]],
) -> Counter[tuple[str, str, str]]:
    return Counter(
        (
            str(fact["namespace"]),
            str(fact["kind"]),
            str(fact["semantic_hash"]),
        )
        for fact in facts
        if fact.get("identity_status") == "content_only"
    )


def verify_fact_sets(
    *,
    before: dict[str, Any],
    after: dict[str, Any],
    allowed_delta: Any = None,
) -> dict[str, Any]:
    if before.get("ok") is not True or before.get("complete") is not True:
        return _fail("semantic_before_incomplete")
    if after.get("ok") is not True or after.get("complete") is not True:
        return _fail("semantic_after_incomplete")

    before_facts = before.get("facts")
    after_facts = after.get("facts")
    if not isinstance(before_facts, list) or not isinstance(after_facts, list):
        return _fail("semantic_fact_set_invalid")

    for fact in [*before_facts, *after_facts]:
        error = _validate_fact(fact)
        if error is not None:
            return _fail(error, fact=fact)

    before_by_key = {
        fact["semantic_key"]: fact
        for fact in before_facts
        if fact.get("identity_status") == "stable"
    }
    after_by_key = {
        fact["semantic_key"]: fact
        for fact in after_facts
        if fact.get("identity_status") == "stable"
    }

    before_stable_count = sum(
        1
        for fact in before_facts
        if fact.get("identity_status") == "stable"
    )
    after_stable_count = sum(
        1
        for fact in after_facts
        if fact.get("identity_status") == "stable"
    )
    if len(before_by_key) != before_stable_count:
        return _fail("semantic_before_stable_key_collision")
    if len(after_by_key) != after_stable_count:
        return _fail("semantic_after_stable_key_collision")

    allowed, error = _validate_allowed_delta(allowed_delta, before_by_key)
    if error is not None or allowed is None:
        return _fail(
            error or "semantic_allowed_delta_invalid",
            allowed_delta_protocol=SEMANTIC_ALLOWED_DELTA_PROTOCOL,
        )

    violations: list[dict[str, Any]] = []

    for semantic_key, fact in before_by_key.items():
        policy = policy_for(str(fact["namespace"]), str(fact["kind"]))
        if policy is None:
            return _fail(
                "semantic_policy_unregistered",
                namespace=fact["namespace"],
                kind=fact["kind"],
            )

        candidate = after_by_key.get(semantic_key)
        permitted = allowed.get(semantic_key)

        if candidate is None:
            if permitted != "remove":
                violations.append({
                    "semantic_key": semantic_key,
                    "kind": fact["kind"],
                    "reason": "baseline_semantic_fact_removed",
                })
            continue

        if candidate["semantic_hash"] != fact["semantic_hash"]:
            if permitted != "modify":
                violations.append({
                    "semantic_key": semantic_key,
                    "kind": fact["kind"],
                    "reason": "baseline_semantic_fact_modified",
                })

    before_unkeyed = _content_counter(before_facts)
    after_unkeyed = _content_counter(after_facts)
    for identity, count in before_unkeyed.items():
        missing = count - after_unkeyed.get(identity, 0)
        if missing <= 0:
            continue

        namespace, kind, semantic_hash = identity
        if policy_for(namespace, kind) is None:
            return _fail(
                "semantic_policy_unregistered",
                namespace=namespace,
                kind=kind,
            )

        violations.append({
            "semantic_key": None,
            "kind": kind,
            "semantic_hash": semantic_hash,
            "missing_count": missing,
            "identity_status": "content_only",
            "reason": "content_only_baseline_fact_not_preserved",
        })

    # Candidate additions are legal only for statically registered additive policy.
    for fact in after_facts:
        registry_key = (str(fact["namespace"]), str(fact["kind"]))
        policy = POLICY_REGISTRY.get(registry_key)
        if policy is None:
            return _fail(
                "semantic_policy_unregistered",
                namespace=registry_key[0],
                kind=registry_key[1],
            )
        if policy.get("mode") != "allow_additive_preserve_existing":
            return _fail(
                "semantic_policy_mode_unsupported",
                namespace=registry_key[0],
                kind=registry_key[1],
            )

    ok = not violations
    return {
        "protocol": SEMANTIC_PRESERVATION_PROTOCOL,
        "ok": ok,
        "verdict": "PASS" if ok else "FAIL",
        "reason": (
            "semantic_preservation_verified"
            if ok
            else "semantic_preservation_violation"
        ),
        "allowed_delta_protocol": SEMANTIC_ALLOWED_DELTA_PROTOCOL,
        "allowed_delta_count": len(allowed),
        "violations": violations,
        "violations_total": len(violations),
        "baseline_facts": len(before_facts),
        "candidate_facts": len(after_facts),
        "baseline_stable_identity_facts": len(before_by_key),
        "baseline_content_only_facts": sum(before_unkeyed.values()),
        "scan_complete": True,
        "policy_complete": True,
        "stable_identity_complete": (
            before.get("stable_identity_complete") is True
            and after.get("stable_identity_complete") is True
        ),
        "complete": True,
        "mutation_authority": False,
    }


def verify_sources(
    *,
    path: str,
    before_source: str,
    after_source: str,
    allowed_delta: Any = None,
) -> dict[str, Any]:
    before = detect_python_source(path=path, source=before_source)
    if before.get("ok") is not True:
        return before

    after = detect_python_source(path=path, source=after_source)
    if after.get("ok") is not True:
        return after

    result = verify_fact_sets(
        before=before,
        after=after,
        allowed_delta=allowed_delta,
    )
    return {
        **result,
        "path": path,
        "before_stable_identity_complete": before["stable_identity_complete"],
        "after_stable_identity_complete": after["stable_identity_complete"],
    }


def _safe_relative(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw or "\0" in raw:
        return None

    path = Path(raw)
    if path.is_absolute():
        return None

    parts: list[str] = []
    for part in path.parts:
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


def verify_changed_python_files(
    *,
    baseline: Path,
    candidate: Path,
    changed_files: Any,
    allowed_delta: Any = None,
) -> dict[str, Any]:
    if not isinstance(changed_files, list):
        return _fail("semantic_changed_files_missing")

    normalized: list[str] = []
    for raw in changed_files:
        rel = _safe_relative(raw)
        if rel is None:
            return _fail("semantic_changed_file_invalid", changed_file=raw)
        if rel not in normalized:
            normalized.append(rel)

    python_files = sorted(rel for rel in normalized if rel.endswith(".py"))
    unsupported = sorted(rel for rel in normalized if not rel.endswith(".py"))

    results: list[dict[str, Any]] = []
    for rel in python_files:
        before_path = baseline / rel
        after_path = candidate / rel

        before_exists = before_path.is_file()
        after_exists = after_path.is_file()

        if not before_exists and after_exists:
            results.append({
                "path": rel,
                "ok": True,
                "verdict": "PASS",
                "reason": "semantic_creation_has_no_baseline",
                "complete": True,
                "mutation_authority": False,
            })
            continue

        if before_exists and not after_exists:
            results.append({
                "path": rel,
                "ok": False,
                "verdict": "FAIL",
                "reason": "semantic_baseline_file_removed",
                "complete": True,
                "mutation_authority": False,
            })
            continue

        if not before_exists and not after_exists:
            results.append({
                "path": rel,
                "ok": False,
                "verdict": "FAIL",
                "reason": "semantic_changed_file_unavailable",
                "complete": False,
                "mutation_authority": False,
            })
            continue

        try:
            before_source = before_path.read_text(encoding="utf-8")
            after_source = after_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            results.append({
                "path": rel,
                "ok": False,
                "verdict": "FAIL",
                "reason": "semantic_changed_file_read_failed",
                "detail": str(exc),
                "complete": False,
                "mutation_authority": False,
            })
            continue

        per_file_delta: list[dict[str, str]] = []
        if isinstance(allowed_delta, dict):
            raw_delta = allowed_delta.get(rel, [])
            if not isinstance(raw_delta, (list, tuple)):
                results.append({
                    "path": rel,
                    "ok": False,
                    "verdict": "FAIL",
                    "reason": "semantic_allowed_delta_file_value_invalid",
                    "complete": False,
                    "mutation_authority": False,
                })
                continue
            per_file_delta = list(raw_delta)
        elif allowed_delta not in (None, [], ()):
            return _fail("semantic_allowed_delta_by_file_invalid")

        results.append(
            verify_sources(
                path=rel,
                before_source=before_source,
                after_source=after_source,
                allowed_delta=per_file_delta,
            )
        )

    failed = [row for row in results if row.get("ok") is not True]
    complete = all(row.get("complete") is True for row in results)
    ok = not failed and complete

    return {
        "protocol": SEMANTIC_PRESERVATION_PROTOCOL,
        "ok": ok,
        "verdict": "PASS" if ok else "FAIL",
        "reason": (
            "python_semantic_preservation_verified"
            if ok
            else (
                "python_semantic_preservation_incomplete"
                if not complete
                else "python_semantic_preservation_failed"
            )
        ),
        "files": results,
        "python_files_checked": len(python_files),
        "unsupported_changed_files": unsupported,
        "unsupported_changed_files_authority": (
            "delegated_to_existing_structural_and_task_proof"
        ),
        "policy_registry_protocol": SEMANTIC_POLICY_REGISTRY_PROTOCOL,
        "detector_registry_protocol": SEMANTIC_DETECTOR_REGISTRY_PROTOCOL,
        "allowed_delta_protocol": SEMANTIC_ALLOWED_DELTA_PROTOCOL,
        "allowed_delta_authority": "deterministic_producer_only",
        "scan_complete": complete,
        "policy_complete": complete,
        "complete": complete,
        "mutation_authority": False,
    }
