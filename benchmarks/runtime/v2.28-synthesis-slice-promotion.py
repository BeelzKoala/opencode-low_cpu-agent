#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import copy
import math
import hashlib
import importlib.util
import json
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable


PROTOCOL = "synthesis-slice-promotion-v1.5.1"
SLICE_PROTOCOL = "source-validated-synthesis-slice-v1.5"
PYTHON_ADAPTER_PROTOCOL = "python-synthesis-slice-adapter-v1.5"
REQUIREMENT_PROTOCOL = "synthesis-requirement-ir-v1.1"
SELECTION_PROTOCOL = "budgeted-evidence-selection-v1.2"
DEFAULT_PREFILL = Path(__file__).with_name("v2.28-prefill-compiler-ablation.py")
DEFAULT_MODEL_VIABILITY = Path(__file__).with_name("v2.28-model-viability.py")
DEFAULT_LADDER = Path(__file__).with_name("v2.28-inference-viability-ladder.py")

_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_SLOT_RE = re.compile(r"^(?:EXISTING|CREATE)\s+slot=(\S+)\s+(?:source=|file=)(\S+)")
_SOURCE_RE = re.compile(r"^SOURCE\s+file=(\S+)\s+level=(\S+)\s+anchors=([0-9,]+)\s*$")
_EVIDENCE_LINE_RE = re.compile(r"^(\d+)\|(.*)$")
_DECL_KINDS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


@dataclass(frozen=True)
class SourceRecord:
    path: str
    level: str
    anchors: tuple[int, ...]
    lines: tuple[tuple[int, str], ...]


@dataclass(frozen=True)
class DeclarationCandidate:
    kind: str
    name: str
    start_line: int
    end_line: int
    anchor_lines: tuple[int, ...]
    head_anchor_lines: tuple[int, ...]
    body_anchor_lines: tuple[int, ...]
    decorator_count: int
    lexical_hits: tuple[str, ...]
    coverage_facts: tuple[str, ...]
    source_bytes: int
    cost_units: int
    source: str
    sha256: str


@dataclass(frozen=True)
class DependencyAtom:
    symbols: tuple[str, ...]
    required_symbols: tuple[str, ...]
    kind: str
    projection: str
    start_line: int
    end_line: int
    relevance_weight: int
    source_bytes: int
    cost_units: int
    source: str
    source_sha256: str
    projected_sha256: str


@dataclass(frozen=True)
class EvidenceAtom:
    kind: str
    label: str
    start_line: int
    end_line: int
    coverage_facts: tuple[str, ...]
    task_hits: tuple[str, ...]
    source_bytes: int
    cost_units: int
    source: str
    sha256: str


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {name}: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def require_api(module: Any, names: Iterable[str], label: str) -> None:
    missing = [name for name in names if not hasattr(module, name)]
    if missing:
        raise RuntimeError(f"{label} semantic API missing: {missing}")


def normalized_messages(mv: Any, fixture: dict[str, Any]) -> list[dict[str, Any]]:
    request = fixture.get("request")
    if not isinstance(request, dict):
        raise RuntimeError("fixture request missing")
    messages = mv.normalize_messages(request.get("system"), request.get("messages"))
    if not isinstance(messages, list):
        raise RuntimeError("normalized messages must be list")
    return messages


def evidence_texts(mv: Any, fixture: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for message in normalized_messages(mv, fixture):
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str) and content:
            out.append(content)
    return out


def parse_context_records(texts: Iterable[str]) -> tuple[dict[str, str], dict[str, list[SourceRecord]]]:
    slot_paths: dict[str, str] = {}
    sources: dict[str, list[SourceRecord]] = {}
    for text in texts:
        lines = text.splitlines()
        i = 0
        while i < len(lines):
            stripped = lines[i].strip()
            slot_match = _SLOT_RE.match(stripped)
            if slot_match:
                slot, path = slot_match.groups()
                previous = slot_paths.get(slot)
                if previous is not None and previous != path:
                    raise RuntimeError(f"conflicting slot path evidence slot={slot} {previous!r}!={path!r}")
                slot_paths[slot] = path
                i += 1
                continue
            source_match = _SOURCE_RE.match(stripped)
            if not source_match:
                i += 1
                continue
            path, level, anchors_raw = source_match.groups()
            anchors = tuple(sorted({int(value) for value in anchors_raw.split(",") if value}))
            evidence_lines: list[tuple[int, str]] = []
            j = i + 1
            while j < len(lines):
                row = lines[j]
                match = _EVIDENCE_LINE_RE.match(row)
                if not match:
                    break
                evidence_lines.append((int(match.group(1)), match.group(2)))
                j += 1
            record = SourceRecord(path, level, anchors, tuple(evidence_lines))
            sources.setdefault(path, []).append(record)
            i = j
    return slot_paths, sources


def obligation_for_handle(prefill: Any, spec: dict[str, Any], handle: str) -> tuple[dict[str, Any], dict[str, Any]]:
    ir = prefill.model_ir(spec)
    rows = [row for row in ir.get("ops", []) if isinstance(row, dict) and row.get("handle") == handle]
    if len(rows) != 1:
        raise RuntimeError(f"unknown/ambiguous handle {handle!r}")
    row = rows[0]
    oid = row.get("obligation_id")
    obligations = spec.get("obligations")
    if not isinstance(obligations, list):
        raise RuntimeError("spec obligations missing")
    matches = [item for item in obligations if isinstance(item, dict) and item.get("id") == oid]
    if len(matches) != 1:
        raise RuntimeError(f"obligation identity mismatch for handle={handle}")
    return row, matches[0]


def safe_source_path(root: Path, relative: str) -> Path:
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise RuntimeError(f"unsafe source path {relative!r}")
    resolved_root = root.resolve()
    resolved = (resolved_root / rel).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as exc:
        raise RuntimeError(f"source path escapes root {relative!r}") from exc
    if not resolved.is_file():
        raise RuntimeError(f"source file missing {relative!r}")
    return resolved


def validate_source_records(path: Path, records: list[SourceRecord]) -> dict[str, Any]:
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    validated: dict[int, str] = {}
    declared_anchors: set[int] = set()
    for record in records:
        declared_anchors.update(record.anchors)
        for lineno, expected in record.lines:
            if lineno < 1 or lineno > len(lines):
                raise RuntimeError(f"source drift line out of range {record.path}:{lineno}")
            actual = lines[lineno - 1]
            if actual != expected:
                raise RuntimeError(
                    f"source drift {record.path}:{lineno} expected={expected!r} actual={actual!r}"
                )
            prior = validated.get(lineno)
            if prior is not None and prior != expected:
                raise RuntimeError(f"conflicting evidence line {record.path}:{lineno}")
            validated[lineno] = expected
    if not validated:
        raise RuntimeError(f"no exact source lines available for validation: {records[0].path if records else path}")
    uncovered = sorted(declared_anchors.difference(validated))
    return {
        "file_sha256": sha256_text(source),
        "validated_lines": sorted(validated),
        "declared_anchors": sorted(declared_anchors),
        "anchors_without_exact_line": uncovered,
        "line_count": len(lines),
        "source": source,
        "lines": lines,
    }


def node_start(node: ast.AST) -> int:
    start = int(getattr(node, "lineno", 0) or 0)
    decorators = getattr(node, "decorator_list", None)
    if isinstance(decorators, list) and decorators:
        starts = [int(getattr(item, "lineno", start) or start) for item in decorators]
        start = min([start, *starts])
    return start


def node_end(node: ast.AST) -> int:
    return int(getattr(node, "end_lineno", getattr(node, "lineno", 0)) or 0)


def exact_node_source(lines: list[str], node: ast.AST) -> str:
    start, end = node_start(node), node_end(node)
    if start < 1 or end < start:
        raise RuntimeError("AST node has invalid source span")
    return "\n".join(lines[start - 1:end]).rstrip() + "\n"


def terms(text: str) -> set[str]:
    return {match.group(0).casefold() for match in _WORD_RE.finditer(text)}


_GENERIC_TASK_TERMS = {
    "add", "allow", "already", "and", "before", "create", "data", "existing", "file",
    "for", "from", "into", "invalid", "must", "new", "not", "only", "page", "result",
    "return", "should", "source", "task", "the", "this", "through", "type", "user", "using",
    "where", "with", "without",
}


def synthesis_task_terms(text: str) -> set[str]:
    return {
        term for term in terms(text)
        if term not in _GENERIC_TASK_TERMS and len(term) >= 4
    }


def symbol_terms(name: str) -> set[str]:
    folded = name.casefold()
    out = {folded}
    out.update(part for part in re.split(r"[^a-z0-9]+|_+", folded) if len(part) >= 3)
    return out


def task_constraint_ir(text: str) -> dict[str, Any]:
    raw_words = [match.group(0) for match in _WORD_RE.finditer(text)]
    task_terms = synthesis_task_terms(text)
    identifiers = sorted({
        word.casefold() for word in raw_words
        if "_" in word or (word.isupper() and len(word) >= 3)
    })
    literals = sorted(set(re.findall(r"(?:/[A-Za-z0-9_./-]+|\.[A-Za-z0-9]{2,6})", text)))
    specific = sorted(set(identifiers).union(
        literal.casefold().lstrip("/.") for literal in literals if len(literal) > 2
    ))
    return {
        "protocol": "task-constraint-ir-v1",
        "task_terms": sorted(task_terms),
        "specific_terms": specific,
        "identifier_terms": identifiers,
        "literals": literals,
        "authority": "task_text_derived_selection_only",
    }


def declaration_header_end(node: ast.AST) -> int:
    lineno = int(getattr(node, "lineno", node_start(node)) or node_start(node))
    body = getattr(node, "body", None)
    if isinstance(body, list) and body:
        first_body = int(getattr(body[0], "lineno", lineno + 1) or lineno + 1)
        return max(lineno, first_body - 1)
    return lineno


def declaration_candidates(
    tree: ast.Module,
    lines: list[str],
    anchors: set[int],
    task_terms: set[str],
) -> list[DeclarationCandidate]:
    candidates: list[DeclarationCandidate] = []
    for node in ast.walk(tree):
        if not isinstance(node, _DECL_KINDS):
            continue
        start, end = node_start(node), node_end(node)
        covered = tuple(sorted(anchor for anchor in anchors if start <= anchor <= end))
        if not covered:
            continue
        header_end = declaration_header_end(node)
        head = tuple(anchor for anchor in covered if start <= anchor <= header_end)
        body = tuple(anchor for anchor in covered if anchor not in head)
        source = exact_node_source(lines, node)
        hits = tuple(sorted(terms(source).intersection(task_terms)))
        decorator_count = len(getattr(node, "decorator_list", []) or [])
        facts = {"pattern:validated_anchor"}
        if head:
            facts.add("pattern:declaration_head_anchor")
        if decorator_count:
            facts.add("pattern:decorated_declaration")
        if hits:
            facts.add("task:overlap")
            facts.update(f"task:{term}" for term in hits)
        source_bytes = len(source.encode("utf-8"))
        candidates.append(DeclarationCandidate(
            type(node).__name__,
            str(getattr(node, "name", "")),
            start,
            end,
            covered,
            head,
            body,
            decorator_count,
            hits,
            tuple(sorted(facts)),
            source_bytes,
            max(1, math.ceil(source_bytes / 4)),
            source,
            sha256_text(source),
        ))
    candidates.sort(key=lambda row: (row.start_line, row.end_line, row.name))
    return candidates


def synthesis_requirement_ir(
    *,
    ir_row: dict[str, Any],
    relative_path: str,
    candidates: list[DeclarationCandidate],
    task_terms: set[str],
) -> dict[str, Any]:
    hard = {"pattern:validated_anchor"}
    if any(row.head_anchor_lines for row in candidates):
        hard.add("pattern:declaration_head_anchor")
    if any(row.lexical_hits for row in candidates):
        hard.add("task:overlap")

    observed_task_terms = sorted({term for row in candidates for term in row.lexical_hits})
    weighted: dict[str, int] = {}
    if any(row.decorator_count for row in candidates):
        weighted["pattern:decorated_declaration"] = 4
    for term in observed_task_terms:
        # Derived from task/source overlap only. It influences selection but never source authority.
        specificity = 3 if "_" in term else 0
        weighted[f"task:{term}"] = 4 + specificity + min(4, max(0, (len(term) - 4) // 4))

    return {
        "protocol": REQUIREMENT_PROTOCOL,
        "operation": ir_row.get("operation"),
        "obligation_id": ir_row.get("obligation_id"),
        "source_file": relative_path,
        "hard_facts": sorted(hard),
        "weighted_facts": {key: weighted[key] for key in sorted(weighted)},
        "task_term_count": len(task_terms),
        "observed_task_terms": observed_task_terms,
        "authority": "derived_selection_requirements_not_source_authority",
    }


def coverage_weight(facts: set[str], weighted: dict[str, int]) -> int:
    return sum(int(weighted.get(fact, 0)) for fact in facts)


def pareto_frontier(candidates: list[DeclarationCandidate]) -> list[DeclarationCandidate]:
    out: list[DeclarationCandidate] = []
    for candidate in candidates:
        facts = set(candidate.coverage_facts)
        dominated = False
        for other in candidates:
            if other is candidate:
                continue
            other_facts = set(other.coverage_facts)
            if other.cost_units <= candidate.cost_units and other_facts.issuperset(facts):
                if other.cost_units < candidate.cost_units or other_facts != facts:
                    dominated = True
                    break
        if not dominated:
            out.append(candidate)
    out.sort(key=lambda row: (row.start_line, row.end_line, row.name))
    return out


def select_declarations(
    candidates: list[DeclarationCandidate],
    requirement_ir: dict[str, Any],
    max_declarations: int,
    max_bytes: int,
) -> tuple[list[DeclarationCandidate], dict[str, Any]]:
    hard = set(requirement_ir.get("hard_facts") or [])
    weighted = dict(requirement_ir.get("weighted_facts") or {})
    frontier = pareto_frontier(candidates)
    selected: list[DeclarationCandidate] = []
    covered: set[str] = set()
    used_bytes = 0
    remaining = list(frontier)
    ledger: list[dict[str, Any]] = []

    while remaining and len(selected) < max_declarations:
        ranked: list[tuple[tuple[Any, ...], DeclarationCandidate, set[str], set[str], int]] = []
        for row in remaining:
            if used_bytes + row.source_bytes > max_bytes:
                continue
            facts = set(row.coverage_facts)
            new_hard = hard.difference(covered).intersection(facts)
            new_soft = set(weighted).difference(covered).intersection(facts)
            soft_value = coverage_weight(new_soft, weighted)
            # Lexicographic greedy set cover: hard coverage first; then weighted new coverage density; then cost.
            density = soft_value / max(1, row.cost_units)
            key = (
                len(new_hard),
                soft_value,
                len(new_soft),
                density,
                -row.cost_units,
                -row.start_line,
            )
            ranked.append((key, row, new_hard, new_soft, soft_value))
        if not ranked:
            break
        ranked.sort(key=lambda item: item[0], reverse=True)
        key, chosen, new_hard, new_soft, soft_value = ranked[0]
        # Once all hard facts are covered, do not add declarations that bring no new weighted evidence.
        if hard.issubset(covered) and soft_value <= 0:
            break
        selected.append(chosen)
        covered.update(chosen.coverage_facts)
        used_bytes += chosen.source_bytes
        ledger.append({
            "name": chosen.name,
            "new_hard_facts": sorted(new_hard),
            "new_weighted_facts": sorted(new_soft),
            "new_weighted_value": soft_value,
            "cost_units": chosen.cost_units,
            "source_bytes": chosen.source_bytes,
        })
        remaining = [row for row in remaining if row != chosen]
        if hard.issubset(covered) and len(selected) >= 1:
            break

    missing_hard = sorted(hard.difference(covered))
    if missing_hard:
        raise RuntimeError(
            "required synthesis facts not covered within declaration budget: " + ",".join(missing_hard)
        )
    if not selected:
        raise RuntimeError("no source-validated declaration selected")

    return selected, {
        "protocol": SELECTION_PROTOCOL,
        "selection_algorithm": "lexicographic_hard_then_weighted_coverage_then_density",
        "cost_authority": "deterministic_utf8_proxy_final_prompt_authority_server_tokenizer",
        "candidate_count": len(candidates),
        "pareto_frontier_count": len(frontier),
        "selected_count": len(selected),
        "covered_hard_facts": sorted(hard.intersection(covered)),
        "missing_hard_facts": [],
        "covered_weighted_facts": sorted(set(weighted).intersection(covered)),
        "weighted_coverage_value": coverage_weight(set(weighted).intersection(covered), weighted),
        "declaration_source_bytes": used_bytes,
        "ledger": ledger,
    }


def statement_bound_names(node: ast.AST) -> set[str]:
    out: set[str] = set()
    for item in ast.walk(node):
        if isinstance(item, ast.Name) and isinstance(item.ctx, (ast.Store, ast.Param)):
            out.add(item.id)
    return out


def declaration_arg_names(node: ast.AST) -> set[str]:
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return set()
    args = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
    if node.args.vararg is not None:
        args.append(node.args.vararg)
    if node.args.kwarg is not None:
        args.append(node.args.kwarg)
    return {arg.arg for arg in args}


def declaration_node_for_candidate(tree: ast.Module, candidate: DeclarationCandidate) -> ast.AST:
    matches = [
        node for node in ast.walk(tree)
        if isinstance(node, _DECL_KINDS)
        and node_start(node) == candidate.start_line
        and node_end(node) == candidate.end_line
        and str(getattr(node, "name", "")) == candidate.name
    ]
    if len(matches) != 1:
        raise RuntimeError(f"selected declaration identity drift name={candidate.name!r} lines={candidate.start_line}-{candidate.end_line}")
    return matches[0]


def header_source(lines: list[str], node: ast.AST) -> str:
    start = node_start(node)
    end = declaration_header_end(node)
    return "\n".join(lines[start - 1:end]).rstrip() + "\n"


def statement_task_hits(node: ast.AST, lines: list[str], task_terms: set[str]) -> tuple[str, ...]:
    return tuple(sorted(terms(exact_node_source(lines, node)).intersection(task_terms)))


def statement_atom_facts(node: ast.AST, lines: list[str], task_terms: set[str]) -> set[str]:
    facts = {f"task:{term}" for term in statement_task_hits(node, lines, task_terms)}
    facts.add("pattern:ast_complete_statement")
    if isinstance(node, ast.Return):
        facts.add("pattern:return_shape")
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
        facts.add("pattern:side_effect_call")
    if statement_bound_names(node):
        facts.add("pattern:local_binding")
    return facts


def nearest_preceding_producer(body: list[ast.stmt], before: int, name: str) -> int | None:
    for idx in range(before - 1, -1, -1):
        if name in statement_bound_names(body[idx]):
            return idx
    return None


def statement_slice_plan(
    node: ast.AST,
    lines: list[str],
    task_terms: set[str],
    max_atoms: int = 10,
    max_dataflow_depth: int = 2,
) -> dict[str, Any]:
    if max_atoms < 1 or max_atoms > 32:
        raise RuntimeError("statement max_atoms must be in [1,32]")
    if max_dataflow_depth < 0 or max_dataflow_depth > 3:
        raise RuntimeError("statement dataflow depth must be in [0,3]")
    body = list(getattr(node, "body", []) or [])
    if not body:
        return {
            "algorithm": "bounded_statement_fact_cover_plus_frontier_dataflow",
            "max_atoms": max_atoms,
            "max_dataflow_depth": max_dataflow_depth,
            "selected_indices": [],
            "required_indices": [],
            "support_indices": [],
            "hard_facts": [],
            "covered_hard_facts": [],
            "missing_hard_facts": [],
            "frontier_symbols": [],
            "ledger": [],
        }

    facts_by_idx = {idx: statement_atom_facts(stmt, lines, task_terms) for idx, stmt in enumerate(body)}
    task_facts = sorted({fact for facts in facts_by_idx.values() for fact in facts if fact.startswith("task:")})
    hard_facts: set[str] = set(task_facts)
    if any(isinstance(stmt, ast.Return) for stmt in body):
        hard_facts.add("pattern:return_shape")
    if not hard_facts:
        hard_facts.add("pattern:representative_statement")
        facts_by_idx[0] = set(facts_by_idx[0]) | {"pattern:representative_statement"}

    selected: set[int] = set()
    required: set[int] = set()
    covered: set[str] = set()
    ledger: list[dict[str, Any]] = []

    while not hard_facts.issubset(covered):
        ranked = []
        for idx, stmt in enumerate(body):
            if idx in selected:
                continue
            new_hard = hard_facts.difference(covered).intersection(facts_by_idx[idx])
            if not new_hard:
                continue
            src_bytes = len(exact_node_source(lines, stmt).encode("utf-8"))
            task_value = sum(1 for fact in new_hard if fact.startswith("task:"))
            ranked.append(((len(new_hard), task_value, -src_bytes, -idx), idx, new_hard, src_bytes))
        if not ranked:
            missing = sorted(hard_facts.difference(covered))
            raise RuntimeError("required statement synthesis facts not coverable: " + ",".join(missing))
        ranked.sort(key=lambda item: item[0], reverse=True)
        _key, idx, new_hard, src_bytes = ranked[0]
        if len(selected) >= max_atoms:
            missing = sorted(hard_facts.difference(covered))
            raise RuntimeError(
                "required statement synthesis facts exceed atom budget "
                f"selected={len(selected)} max={max_atoms} missing={','.join(missing)}"
            )
        selected.add(idx)
        required.add(idx)
        covered.update(facts_by_idx[idx])
        ledger.append({
            "index": idx,
            "reason": "hard_fact_cover",
            "new_hard_facts": sorted(new_hard),
            "source_bytes": src_bytes,
        })

    args = declaration_arg_names(node)
    frontier_symbols: set[str] = set()
    current_wave = set(required)
    for depth in range(max_dataflow_depth):
        visible_defs = set(args)
        for idx in selected:
            visible_defs.update(statement_bound_names(body[idx]))
        by_producer: dict[int, set[str]] = {}
        for use_idx in sorted(current_wave):
            for name in sorted(loaded_names(body[use_idx]).difference(visible_defs)):
                producer = nearest_preceding_producer(body, use_idx, name)
                if producer is None or producer in selected:
                    continue
                by_producer.setdefault(producer, set()).add(name)

        ranked = []
        for producer, symbols in by_producer.items():
            src_bytes = len(exact_node_source(lines, body[producer]).encode("utf-8"))
            support_count = sum(1 for idx in selected if symbols.intersection(loaded_names(body[idx])))
            ranked.append(((support_count, -src_bytes, -producer), producer, sorted(symbols), src_bytes))
        ranked.sort(key=lambda item: item[0], reverse=True)

        next_wave: set[int] = set()
        for _key, producer, symbols, src_bytes in ranked:
            if len(selected) >= max_atoms:
                frontier_symbols.update(symbols)
                continue
            selected.add(producer)
            next_wave.add(producer)
            ledger.append({
                "index": producer,
                "reason": "bounded_backward_def_use",
                "depth": depth + 1,
                "supports_symbols": symbols,
                "source_bytes": src_bytes,
            })

        carrier_names: set[str] = set()
        for idx in selected:
            carrier_names.update(statement_bound_names(body[idx]))
        bridge_candidates = []
        if selected:
            lo, hi = min(selected), max(selected)
            for idx in range(lo, hi + 1):
                if idx in selected:
                    continue
                stmt = body[idx]
                if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)):
                    continue
                touched = sorted(loaded_names(stmt).intersection(carrier_names))
                if not touched:
                    continue
                src_bytes = len(exact_node_source(lines, stmt).encode("utf-8"))
                hits = statement_task_hits(stmt, lines, task_terms)
                bridge_candidates.append(((len(hits), len(touched), -src_bytes, -idx), idx, touched, src_bytes))
        bridge_candidates.sort(key=lambda item: item[0], reverse=True)
        for _key, idx, touched, src_bytes in bridge_candidates:
            if len(selected) >= max_atoms:
                break
            selected.add(idx)
            next_wave.add(idx)
            ledger.append({
                "index": idx,
                "reason": "bounded_carrier_side_effect",
                "depth": depth + 1,
                "carrier_symbols": touched,
                "source_bytes": src_bytes,
            })
        if not next_wave:
            break
        current_wave = next_wave

    visible_defs = set(args)
    for idx in selected:
        visible_defs.update(statement_bound_names(body[idx]))
    for idx in selected:
        for name in loaded_names(body[idx]).difference(visible_defs):
            if nearest_preceding_producer(body, idx, name) is not None:
                frontier_symbols.add(name)

    actual_covered = {fact for idx in selected for fact in facts_by_idx[idx]}
    missing_hard = sorted(hard_facts.difference(actual_covered))
    if missing_hard:
        raise RuntimeError("statement slice lost required facts: " + ",".join(missing_hard))

    return {
        "algorithm": "bounded_statement_fact_cover_plus_frontier_dataflow",
        "max_atoms": max_atoms,
        "max_dataflow_depth": max_dataflow_depth,
        "selected_indices": sorted(selected),
        "required_indices": sorted(required),
        "support_indices": sorted(selected.difference(required)),
        "hard_facts": sorted(hard_facts),
        "covered_hard_facts": sorted(actual_covered.intersection(hard_facts)),
        "missing_hard_facts": [],
        "frontier_symbols": sorted(frontier_symbols),
        "ledger": ledger,
    }


def selected_statement_indices(
    node: ast.AST,
    lines: list[str],
    task_terms: set[str],
    max_atoms: int = 10,
    max_dataflow_depth: int = 2,
) -> list[int]:
    return list(statement_slice_plan(node, lines, task_terms, max_atoms, max_dataflow_depth)["selected_indices"])

def declaration_evidence_atoms(
    tree: ast.Module,
    lines: list[str],
    selected: list[DeclarationCandidate],
    task_terms: set[str],
    *,
    max_statement_atoms: int = 10,
    statement_dataflow_depth: int = 2,
) -> tuple[list[EvidenceAtom], list[ast.AST], list[ast.AST], list[dict[str, Any]]]:
    atoms: list[EvidenceAtom] = []
    decl_nodes: list[ast.AST] = []
    visible_stmt_nodes: list[ast.AST] = []
    plans: list[dict[str, Any]] = []
    for candidate in selected:
        node = declaration_node_for_candidate(tree, candidate)
        decl_nodes.append(node)
        hsrc = header_source(lines, node)
        hhits = tuple(sorted(terms(hsrc).intersection(task_terms)))
        hfacts = {"pattern:declaration_header", "selection:required"}
        if candidate.head_anchor_lines:
            hfacts.add("pattern:declaration_head_anchor")
        if candidate.decorator_count:
            hfacts.add("pattern:decorated_declaration")
        hfacts.update(f"task:{term}" for term in hhits)
        atoms.append(EvidenceAtom(
            "declaration_header", candidate.name, node_start(node), declaration_header_end(node),
            tuple(sorted(hfacts)), hhits, len(hsrc.encode("utf-8")), max(1, math.ceil(len(hsrc.encode("utf-8")) / 4)),
            hsrc, sha256_text(hsrc),
        ))
        body = list(getattr(node, "body", []) or [])
        plan = statement_slice_plan(
            node, lines, task_terms,
            max_atoms=max_statement_atoms,
            max_dataflow_depth=statement_dataflow_depth,
        )
        plans.append({"declaration": candidate.name, **plan})
        required_indices = set(plan["required_indices"])
        for idx in plan["selected_indices"]:
            stmt = body[idx]
            src = exact_node_source(lines, stmt)
            hits = statement_task_hits(stmt, lines, task_terms)
            facts = set(statement_atom_facts(stmt, lines, task_terms))
            facts.add("selection:required" if idx in required_indices else "selection:optional_support")
            atoms.append(EvidenceAtom(
                "statement", f"{candidate.name}:{idx}", node_start(stmt), node_end(stmt),
                tuple(sorted(facts)), hits, len(src.encode("utf-8")), max(1, math.ceil(len(src.encode("utf-8")) / 4)),
                src, sha256_text(src),
            ))
            visible_stmt_nodes.append(stmt)
    atoms.sort(key=lambda row: (row.start_line, row.end_line, row.kind, row.label))
    return atoms, decl_nodes, visible_stmt_nodes, plans

def anchored_task_symbols(tree: ast.Module, validated_lines: set[int], task_terms: set[str], selected_spans: set[tuple[int, int]]) -> set[str]:
    symbols: set[str] = set()
    for node in tree.body:
        span = (node_start(node), node_end(node))
        if span in selected_spans:
            continue
        if not any(node_start(node) <= line <= node_end(node) for line in validated_lines):
            continue
        for name in bound_names(node):
            if symbol_terms(name).intersection(task_terms):
                symbols.add(name)
    return symbols


def anchor_symbol_use_atoms(
    tree: ast.Module,
    lines: list[str],
    symbols: set[str],
    selected_spans: set[tuple[int, int]],
    task_terms: set[str],
    max_atoms: int = 4,
) -> list[EvidenceAtom]:
    atoms: list[EvidenceAtom] = []
    for symbol in sorted(symbols):
        candidates: list[tuple[int, int, ast.AST]] = []
        for decl in ast.walk(tree):
            if not isinstance(decl, _DECL_KINDS):
                continue
            if (node_start(decl), node_end(decl)) in selected_spans:
                continue
            for stmt in list(getattr(decl, "body", []) or []):
                if symbol in loaded_names(stmt):
                    src = exact_node_source(lines, stmt)
                    candidates.append((len(src.encode("utf-8")), node_start(stmt), stmt))
        if not candidates:
            continue
        candidates.sort(key=lambda item: (item[0], item[1]))
        _cost, _line, stmt = candidates[0]
        src = exact_node_source(lines, stmt)
        hits = tuple(sorted(terms(src).intersection(task_terms)))
        facts = {"pattern:source_anchored_symbol_use", f"symbol:{symbol}", "selection:optional_support"}
        facts.update(f"task:{term}" for term in symbol_terms(symbol).intersection(task_terms))
        atoms.append(EvidenceAtom(
            "anchor_symbol_use", symbol, node_start(stmt), node_end(stmt), tuple(sorted(facts)), hits,
            len(src.encode("utf-8")), max(1, math.ceil(len(src.encode("utf-8")) / 4)), src, sha256_text(src),
        ))
        if len(atoms) >= max_atoms:
            break
    return atoms


def bound_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        names.add(node.name)
    elif isinstance(node, (ast.Import, ast.ImportFrom)):
        for alias in node.names:
            names.add(alias.asname or alias.name.split(".")[0])
    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets: list[ast.AST] = list(node.targets) if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            for item in ast.walk(target):
                if isinstance(item, ast.Name):
                    names.add(item.id)
    return names


def top_level_binding_index(tree: ast.Module) -> dict[str, ast.AST]:
    out: dict[str, ast.AST] = {}
    for node in tree.body:
        for name in bound_names(node):
            out.setdefault(name, node)
    return out


def loaded_names(tree_node: ast.AST) -> set[str]:
    return {node.id for node in ast.walk(tree_node) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}


def local_names(tree_node: ast.AST) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(tree_node):
        if isinstance(node, ast.arg):
            out.add(node.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Param)):
            out.add(node.id)
    return out


def declaration_header_loaded_names(node: ast.AST) -> set[str]:
    roots: list[ast.AST] = []
    decorators = getattr(node, "decorator_list", None)
    if isinstance(decorators, list):
        roots.extend(decorators)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
            if arg.annotation is not None:
                roots.append(arg.annotation)
        if node.args.vararg is not None and node.args.vararg.annotation is not None:
            roots.append(node.args.vararg.annotation)
        if node.args.kwarg is not None and node.args.kwarg.annotation is not None:
            roots.append(node.args.kwarg.annotation)
        roots.extend(node.args.defaults)
        roots.extend(value for value in node.args.kw_defaults if value is not None)
        if node.returns is not None:
            roots.append(node.returns)
    elif isinstance(node, ast.ClassDef):
        roots.extend(node.bases)
        roots.extend(keyword.value for keyword in node.keywords)
    names: set[str] = set()
    for root in roots:
        names.update(loaded_names(root))
    return names


def alias_bound_name(alias: ast.alias) -> str:
    return alias.asname or alias.name.split(".")[0]


def project_import(node: ast.AST, wanted: set[str]) -> str:
    if isinstance(node, ast.Import):
        aliases = [copy.deepcopy(alias) for alias in node.names if alias_bound_name(alias) in wanted]
        if not aliases:
            return ""
        projected = ast.Import(names=aliases)
    elif isinstance(node, ast.ImportFrom):
        aliases = [copy.deepcopy(alias) for alias in node.names if alias_bound_name(alias) in wanted]
        if not aliases:
            return ""
        projected = ast.ImportFrom(module=node.module, names=aliases, level=node.level)
    else:
        raise TypeError(type(node).__name__)
    ast.fix_missing_locations(projected)
    return ast.unparse(projected).rstrip() + "\n"


def project_signature(node: ast.AST) -> str:
    projected = copy.deepcopy(node)
    if not isinstance(projected, _DECL_KINDS):
        raise TypeError(type(projected).__name__)
    projected.body = [ast.Expr(value=ast.Constant(value=Ellipsis))]
    ast.fix_missing_locations(projected)
    return ast.unparse(projected).rstrip() + "\n"


def dependency_projection(
    node: ast.AST,
    wanted: set[str],
    required: set[str],
    lines: list[str],
    task_terms: set[str],
) -> DependencyAtom:
    start, end = node_start(node), node_end(node)
    exact = exact_node_source(lines, node)
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        projected = project_import(node, wanted)
        projection = "relevant_import_aliases"
    elif isinstance(node, _DECL_KINDS):
        projected = project_signature(node)
        projection = "signature_only"
    else:
        projected = exact
        projection = "exact_binding"
    if not projected.strip():
        raise RuntimeError(f"empty dependency projection kind={type(node).__name__} lines={start}-{end}")
    hits = terms(projected).intersection(task_terms)
    source_bytes = len(projected.encode("utf-8"))
    return DependencyAtom(
        tuple(sorted(wanted)),
        tuple(sorted(required.intersection(wanted))),
        type(node).__name__,
        projection,
        start,
        end,
        len(hits),
        source_bytes,
        max(1, math.ceil(source_bytes / 4)),
        projected,
        sha256_text(exact),
        sha256_text(projected),
    )


def dependency_atoms(
    tree: ast.Module,
    lines: list[str],
    selected_spans: set[tuple[int, int]],
    depth: int,
    task_terms: set[str],
) -> list[DependencyAtom]:
    if depth < 0 or depth > 2:
        raise RuntimeError("dependency depth must be in [0,2]")
    if depth == 0:
        return []
    binding_index = top_level_binding_index(tree)
    selected_nodes = [
        node for node in ast.walk(tree)
        if isinstance(node, _DECL_KINDS) and (node_start(node), node_end(node)) in selected_spans
    ]
    required_frontier: set[str] = set()
    optional_frontier: set[str] = set()
    for node in selected_nodes:
        required = declaration_header_loaded_names(node)
        all_loaded = loaded_names(node).difference(local_names(node))
        required_frontier.update(required)
        optional_frontier.update(all_loaded.difference(required))

    emitted_spans: set[tuple[int, int]] = set(selected_spans)
    atoms: list[DependencyAtom] = []
    for _ in range(depth):
        grouped: dict[tuple[int, int], dict[str, Any]] = {}
        for symbol in sorted(required_frontier | optional_frontier):
            node = binding_index.get(symbol)
            if node is None:
                continue
            span = (node_start(node), node_end(node))
            if span in emitted_spans:
                continue
            row = grouped.setdefault(span, {"node": node, "wanted": set(), "required": set()})
            row["wanted"].add(symbol)
            if symbol in required_frontier:
                row["required"].add(symbol)

        next_required: set[str] = set()
        next_optional: set[str] = set()
        for span in sorted(grouped):
            row = grouped[span]
            node = row["node"]
            emitted_spans.add(span)
            atom = dependency_projection(node, row["wanted"], row["required"], lines, task_terms)
            atoms.append(atom)
            # Never pull a helper body merely because its name is referenced. Only its header can extend closure.
            if isinstance(node, _DECL_KINDS):
                next_required.update(declaration_header_loaded_names(node))
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                names = loaded_names(node).difference(local_names(node))
                if row["required"]:
                    next_required.update(names)
                else:
                    next_optional.update(names)
        required_frontier = next_required
        optional_frontier = next_optional
        if not required_frontier and not optional_frontier:
            break

    atoms.sort(key=lambda row: (
        0 if row.required_symbols else 1,
        -row.relevance_weight,
        row.cost_units,
        row.start_line,
        row.end_line,
        row.kind,
        row.symbols,
    ))
    return atoms


def dependency_atoms_for_evidence(
    tree: ast.Module,
    lines: list[str],
    declaration_nodes: list[ast.AST],
    visible_statement_nodes: list[ast.AST],
    depth: int,
    task_terms: set[str],
    anchored_symbols: set[str],
) -> list[DependencyAtom]:
    if depth < 0 or depth > 2:
        raise RuntimeError("dependency depth must be in [0,2]")
    if depth == 0:
        return []
    binding_index = top_level_binding_index(tree)
    required_frontier: set[str] = set()
    optional_frontier: set[str] = set(anchored_symbols)
    local_decl_names: set[str] = set()
    for node in declaration_nodes:
        required_frontier.update(declaration_header_loaded_names(node))
        local_decl_names.update(declaration_arg_names(node))
        for stmt in list(getattr(node, "body", []) or []):
            local_decl_names.update(statement_bound_names(stmt))
    for stmt in visible_statement_nodes:
        optional_frontier.update(loaded_names(stmt))
    optional_frontier.difference_update(local_decl_names)
    required_frontier.difference_update(local_decl_names)

    emitted_spans: set[tuple[int, int]] = set()
    atoms: list[DependencyAtom] = []
    for _ in range(depth):
        grouped: dict[tuple[int, int], dict[str, Any]] = {}
        for symbol in sorted(required_frontier | optional_frontier):
            node = binding_index.get(symbol)
            if node is None:
                continue
            span = (node_start(node), node_end(node))
            if span in emitted_spans:
                continue
            row = grouped.setdefault(span, {"node": node, "wanted": set(), "required": set()})
            row["wanted"].add(symbol)
            if symbol in required_frontier:
                row["required"].add(symbol)
        next_required: set[str] = set()
        next_optional: set[str] = set()
        for span in sorted(grouped):
            row = grouped[span]
            node = row["node"]
            emitted_spans.add(span)
            atom = dependency_projection(node, row["wanted"], row["required"], lines, task_terms)
            atoms.append(atom)
            if isinstance(node, _DECL_KINDS):
                next_required.update(declaration_header_loaded_names(node))
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                names = loaded_names(node).difference(local_names(node))
                if row["required"]:
                    next_required.update(names)
                else:
                    next_optional.update(names)
        required_frontier = next_required
        optional_frontier = next_optional
        if not required_frontier and not optional_frontier:
            break
    atoms.sort(key=lambda row: (
        0 if row.required_symbols else 1,
        -row.relevance_weight,
        row.cost_units,
        row.start_line,
        row.end_line,
        row.kind,
        row.symbols,
    ))
    return atoms


def select_dependencies(
    dependencies: list[DependencyAtom],
    *,
    used_bytes: int,
    max_bytes: int,
) -> tuple[list[DependencyAtom], dict[str, Any]]:
    kept: list[DependencyAtom] = []
    current = used_bytes
    omitted: list[dict[str, Any]] = []
    required = [row for row in dependencies if row.required_symbols]
    optional = [row for row in dependencies if not row.required_symbols]
    optional.sort(key=lambda row: (-row.relevance_weight, row.cost_units, row.start_line, row.kind, row.symbols))
    for row in [*required, *optional]:
        if current + row.source_bytes <= max_bytes:
            kept.append(row)
            current += row.source_bytes
            continue
        if row.required_symbols:
            raise RuntimeError(
                "required dependency projection exceeds synthesis slice budget "
                f"symbols={','.join(row.required_symbols)} bytes={row.source_bytes} used={current} budget={max_bytes}"
            )
        omitted.append({
            "symbols": list(row.symbols),
            "projection": row.projection,
            "source_bytes": row.source_bytes,
            "reason": "slice_byte_budget",
        })
    kept.sort(key=lambda row: (row.start_line, row.end_line, row.kind, row.symbols))
    return kept, {
        "required_dependency_count": len(required),
        "selected_dependency_count": len(kept),
        "omitted_optional_dependencies": omitted,
        "final_source_bytes": current,
    }


def render_slice(path: str, file_sha: str, evidence_atoms: list[EvidenceAtom], dependencies: list[DependencyAtom]) -> str:
    lines = [
        f"SOURCE_SLICE protocol={SLICE_PROTOCOL} adapter={PYTHON_ADAPTER_PROTOCOL}",
        f"FILE path={path} sha256={file_sha}",
        "AUTHORITY source_validation=exact_anchor_lines ranking_authority=false mutation_authority=false",
    ]
    for dep in dependencies:
        lines.extend([
            f"DEPENDENCY kind={dep.kind} projection={dep.projection} lines={dep.start_line}-{dep.end_line} symbols={','.join(dep.symbols)} source_sha256={dep.source_sha256} projected_sha256={dep.projected_sha256}",
            dep.source.rstrip(),
        ])
    for atom in evidence_atoms:
        lines.extend([
            f"EVIDENCE kind={atom.kind} label={atom.label} lines={atom.start_line}-{atom.end_line} task_hits={','.join(atom.task_hits)} sha256={atom.sha256}",
            atom.source.rstrip(),
        ])
    lines.append("END_SOURCE_SLICE")
    return "\n".join(lines) + "\n"


def render_model_view(path: str, evidence_atoms: list[EvidenceAtom], dependencies: list[DependencyAtom]) -> str:
    """Model-facing source only. Provenance/authority remain in the machine ledger."""
    lines = [f"PY_SOURCE {path}"]
    for dep in dependencies:
        lines.append(dep.source.rstrip())
    for atom in evidence_atoms:
        lines.append(atom.source.rstrip())
    lines.append("END_PY_SOURCE")
    return "\n".join(lines) + "\n"


def apply_model_view(out: dict[str, Any], atoms: list[EvidenceAtom], deps: list[DependencyAtom]) -> dict[str, Any]:
    model_view = render_model_view(out["file"], atoms, deps)
    out["model_view_bytes"] = len(model_view.encode("utf-8"))
    out["model_view_sha256"] = sha256_text(model_view)
    out["model_view"] = model_view
    return out


def token_lcp(left: list[int], right: list[int]) -> int:
    limit = min(len(left), len(right))
    idx = 0
    while idx < limit and left[idx] == right[idx]:
        idx += 1
    return idx


def exact_body_tokens(prefill: Any, chat_url: str, body: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    require_api(prefill, ["server_endpoint", "post_json_no_inference", "apply_template_payload"], "prefill tokenizer")
    rendered, apply_ms = prefill.post_json_no_inference(
        prefill.server_endpoint(chat_url, "/apply-template"),
        prefill.apply_template_payload(body),
        timeout_s=timeout_s,
    )
    prompt = rendered.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        raise RuntimeError("server /apply-template returned empty prompt")
    tokenized, tokenize_ms = prefill.post_json_no_inference(
        prefill.server_endpoint(chat_url, "/tokenize"),
        {"content": prompt, "add_special": True, "parse_special": True, "with_pieces": False},
        timeout_s=timeout_s,
    )
    tokens = tokenized.get("tokens")
    if not isinstance(tokens, list) or not all(isinstance(x, int) for x in tokens):
        raise RuntimeError("server /tokenize returned invalid token ids")
    return {
        "tokens": tokens,
        "token_count": len(tokens),
        "rendered_prompt_bytes": len(prompt.encode("utf-8")),
        "rendered_prompt_sha256": sha256_text(prompt),
        "token_ids_sha256": hashlib.sha256(canonical_json(tokens).encode("utf-8")).hexdigest(),
        "apply_template_ms": apply_ms,
        "tokenize_ms": tokenize_ms,
    }


def numeric(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def cached_tokens_from_result(result: dict[str, Any]) -> int:
    usage = result.get("usage")
    if isinstance(usage, dict):
        details = usage.get("prompt_tokens_details")
        if isinstance(details, dict) and isinstance(details.get("cached_tokens"), int):
            return max(0, int(details["cached_tokens"]))
    progress = result.get("server_progress")
    if isinstance(progress, dict) and isinstance(progress.get("max_prompt_tokens_cache"), int):
        return max(0, int(progress["max_prompt_tokens_cache"]))
    value = result.get("reported_cached_tokens")
    return max(0, int(value)) if isinstance(value, int) else 0


def cache_regime(prompt_tokens: int, cached_tokens: int) -> str:
    if cached_tokens <= 0:
        return "cold"
    if cached_tokens >= prompt_tokens:
        return "resident_full"
    return "resident_partial"


def final_stream_prefill_completion(result: dict[str, Any], prompt_tokens: int) -> dict[str, Any] | None:
    """Conservative prefill-completion proof when live polling misses a short decode phase.

    A completed streaming response with at least one completion token and exact final
    prompt accounting proves that prefill completed.  `first_event_ms` is an upper
    bound on prefill completion (it may include the first decode step), so it is safe
    for admission/residency bookkeeping but is never presented as a live-slot exact
    timestamp.
    """
    if result.get("status") != "complete" or result.get("done_marker") is not True:
        return None
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    completion_tokens = usage.get("completion_tokens")
    final_prompt_tokens = usage.get("prompt_tokens")
    if not isinstance(completion_tokens, int) or completion_tokens < 1:
        return None
    if not isinstance(final_prompt_tokens, int) or final_prompt_tokens != prompt_tokens:
        return None
    timings = result.get("timings") if isinstance(result.get("timings"), dict) else {}
    prompt_n = timings.get("prompt_n"); cache_n = timings.get("cache_n")
    if not isinstance(prompt_n, (int, float)) or not isinstance(cache_n, (int, float)):
        return None
    accounted = int(round(float(prompt_n) + float(cache_n)))
    if accounted != prompt_tokens:
        return None
    first_event_ms = numeric(result.get("first_event_ms"))
    if first_event_ms is not None:
        return {
            "ms": first_event_ms,
            "authority": "completed_stream_first_event_with_exact_prompt_accounting",
            "is_upper_bound": True,
        }
    wall_s = numeric(result.get("wall_s"))
    if wall_s is not None:
        return {
            "ms": wall_s * 1000.0,
            "authority": "completed_stream_wall_with_exact_prompt_accounting",
            "is_upper_bound": True,
        }
    return None


def decode_cost_observation(result: dict[str, Any], progress: dict[str, Any]) -> float | None:
    """Accept decode-rate telemetry only when at least two decoded tokens support it.

    One-token prefix probes are useful for residency, but llama.cpp can report a
    rounded/near-zero predicted time for them; such samples must not contaminate the
    Governor's decode envelope.
    """
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    usage_decoded = usage.get("completion_tokens") if isinstance(usage.get("completion_tokens"), int) else 0
    progress_decoded = progress.get("max_decoded") if isinstance(progress.get("max_decoded"), int) else 0
    decoded_evidence = max(int(usage_decoded or 0), int(progress_decoded or 0))
    if decoded_evidence < 2:
        return None
    timings = result.get("timings") if isinstance(result.get("timings"), dict) else {}
    rate = numeric(timings.get("predicted_per_token_ms"))
    if rate is None or rate <= 0:
        pn = numeric(timings.get("predicted_n")); pm = numeric(timings.get("predicted_ms"))
        if pn is not None and pn >= 2 and pm is not None and pm > 0:
            rate = pm / pn
    return rate if rate is not None and rate > 0 else None


def result_cost_observation(result: dict[str, Any], prompt_tokens: int | None, label: str) -> dict[str, Any] | None:
    usage = result.get("usage")
    if prompt_tokens is None and isinstance(usage, dict) and isinstance(usage.get("prompt_tokens"), int):
        prompt_tokens = int(usage["prompt_tokens"])
    if not isinstance(prompt_tokens, int) or prompt_tokens <= 0:
        return None
    cache = min(prompt_tokens, cached_tokens_from_result(result))
    uncached = max(0, prompt_tokens - cache)
    progress = result.get("server_progress") if isinstance(result.get("server_progress"), dict) else {}
    first_decode_ms = numeric(progress.get("first_decode_progress_ms"))
    ttft_ms = numeric(result.get("ttft_ms"))
    completion_authority = None
    completion_is_upper = False
    if first_decode_ms is not None:
        prefill_complete_ms = first_decode_ms
        completion_authority = "live_slot_first_decode_progress"
    elif ttft_ms is not None:
        prefill_complete_ms = ttft_ms
        completion_authority = "stream_ttft"
    else:
        fallback = final_stream_prefill_completion(result, prompt_tokens)
        prefill_complete_ms = numeric(fallback.get("ms")) if isinstance(fallback, dict) else None
        completion_authority = fallback.get("authority") if isinstance(fallback, dict) else None
        completion_is_upper = bool(fallback.get("is_upper_bound")) if isinstance(fallback, dict) else False
    max_decoded = progress.get("max_decoded") if isinstance(progress.get("max_decoded"), int) else 0
    wall_s = numeric(result.get("wall_s"))
    censored = result.get("status") == "timeout" and max_decoded == 0 and prefill_complete_ms is None
    decode_ms_per_token = decode_cost_observation(result, progress)
    return {
        "protocol": "prefill-cost-observation-v2.1",
        "label": label,
        "request_sha256": result.get("request_sha256"),
        "prompt_tokens": prompt_tokens,
        "cached_tokens": cache,
        "cache_ratio": round(cache / prompt_tokens, 6),
        "uncached_tokens": uncached,
        "regime": cache_regime(prompt_tokens, cache),
        "prefill_complete_ms": prefill_complete_ms,
        "prefill_complete_authority": completion_authority,
        "prefill_complete_is_upper_bound": completion_is_upper,
        "prefill_censored_lower_ms": (wall_s * 1000.0) if censored and wall_s is not None else None,
        "decode_ms_per_token": decode_ms_per_token,
        "status": result.get("status"),
        "stage_at_end": result.get("stage_at_end"),
    }


def prime_prefill_completion_proven(result: dict[str, Any], observation: dict[str, Any] | None) -> bool:
    if result.get("status") != "complete" or result.get("done_marker") is not True:
        return False
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    if not isinstance(usage.get("completion_tokens"), int) or int(usage["completion_tokens"]) < 1:
        return False
    return isinstance(observation, dict) and numeric(observation.get("prefill_complete_ms")) is not None


def evidence_observations(doc: dict[str, Any], label: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    result = doc.get("result")
    shape = doc.get("shape")
    if isinstance(result, dict):
        prompt = shape.get("prompt_tokens_observed") if isinstance(shape, dict) else None
        row = result_cost_observation(result, int(prompt) if isinstance(prompt, int) else None, label + ":result")
        if row: out.append(row)
    candidate = doc.get("candidate_D")
    shape_probe = doc.get("shape_probe")
    if isinstance(candidate, dict):
        prompt = None
        if isinstance(shape_probe, dict):
            results = shape_probe.get("results")
            if isinstance(results, dict):
                d = results.get("D_projection_renderer")
                if isinstance(d, dict) and isinstance(d.get("prompt_tokens_observed"), int):
                    prompt = int(d["prompt_tokens_observed"])
        row = result_cost_observation(candidate, prompt, label + ":candidate_D")
        if row: out.append(row)
    split = doc.get("turn_splitting")
    if isinstance(split, dict) and isinstance(split.get("stages"), list):
        for idx, stage in enumerate(split["stages"]):
            if not isinstance(stage, dict): continue
            usage = stage.get("usage")
            prompt = usage.get("prompt_tokens") if isinstance(usage, dict) else None
            row = result_cost_observation(stage, int(prompt) if isinstance(prompt, int) else None, f"{label}:turn:{idx}")
            if row: out.append(row)
    if isinstance(doc.get("server_progress"), dict) and isinstance(doc.get("status"), str):
        row = result_cost_observation(doc, None, label + ":raw")
        if row: out.append(row)
    return out


def _dedup_observations(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    dedup: dict[str, dict[str, Any]] = {}
    for row in observations:
        key = str(row.get("request_sha256") or canonical_json(row))
        previous = dedup.get(key)
        if previous is None:
            dedup[key] = row
            continue
        previous_complete = numeric(previous.get("prefill_complete_ms")) is not None
        current_complete = numeric(row.get("prefill_complete_ms")) is not None
        if current_complete and not previous_complete:
            dedup[key] = row
    return list(dedup.values())


def _regime_summary(observations: list[dict[str, Any]], regime: str) -> dict[str, Any]:
    rows = [row for row in observations if row.get("regime") == regime]
    completed = [row for row in rows if numeric(row.get("prefill_complete_ms")) is not None and int(row.get("uncached_tokens") or 0) > 0]
    censored = [row for row in rows if numeric(row.get("prefill_censored_lower_ms")) is not None]
    return {
        "observation_count": len(rows),
        "completed_count": len(completed),
        "censored_count": len(censored),
        "uncached_token_min": min((int(row.get("uncached_tokens") or 0) for row in rows), default=None),
        "uncached_token_max": max((int(row.get("uncached_tokens") or 0) for row in rows), default=None),
    }


def _profile_from_observations(observations: list[dict[str, Any]], evidence_files: list[dict[str, Any]]) -> dict[str, Any]:
    observations = _dedup_observations(observations)
    decode_rates = [float(row["decode_ms_per_token"]) for row in observations if numeric(row.get("decode_ms_per_token")) is not None and float(row["decode_ms_per_token"]) > 0]
    regimes = {name: _regime_summary(observations, name) for name in ("cold", "resident_partial", "resident_full")}
    return {
        "protocol": "empirical-prefill-cost-profile-v2.1",
        "authority": "benchmark_observation_only_no_cross_regime_rate_mixing",
        "evidence_files": evidence_files,
        "observations": sorted(observations, key=lambda row: (str(row.get("regime")), int(row.get("uncached_tokens") or 0), str(row.get("label")))),
        "regimes": regimes,
        "decode_rate_observation_count": len(decode_rates),
        "decode_ms_per_token_upper": max(decode_rates) if decode_rates else None,
    }


def compile_prefill_cost_profile(paths: list[str]) -> dict[str, Any]:
    observations: list[dict[str, Any]] = []
    evidence_files: list[dict[str, Any]] = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError(f"prefill evidence missing: {path}")
        doc = read_json(path)
        if not isinstance(doc, dict):
            raise RuntimeError(f"prefill evidence must be object: {path}")
        rows = evidence_observations(doc, path.name)
        observations.extend(rows)
        evidence_files.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "observation_count": len(rows)})
    return _profile_from_observations(observations, evidence_files)


def compile_prefill_cost_profile_from_docs_for_gate(docs: list[dict[str, Any]]) -> dict[str, Any]:
    observations: list[dict[str, Any]] = []
    for idx, doc in enumerate(docs):
        observations.extend(evidence_observations(doc, f"gate:{idx}"))
    return _profile_from_observations(observations, [])


def empirical_prefill_interval(profile: dict[str, Any], *, uncached_tokens: int, regime: str) -> dict[str, Any]:
    if uncached_tokens < 0:
        raise RuntimeError("uncached token count must be non-negative")
    rows = [row for row in profile.get("observations") or [] if isinstance(row, dict) and row.get("regime") == regime]
    completed = [row for row in rows if numeric(row.get("prefill_complete_ms")) is not None and isinstance(row.get("uncached_tokens"), int)]
    censored = [row for row in rows if numeric(row.get("prefill_censored_lower_ms")) is not None and isinstance(row.get("uncached_tokens"), int)]
    lower_candidates: list[dict[str, Any]] = []
    for row in completed:
        if int(row["uncached_tokens"]) <= uncached_tokens:
            lower_candidates.append({"label": row.get("label"), "tokens": int(row["uncached_tokens"]), "ms": float(row["prefill_complete_ms"]), "kind": "completed_lower"})
    for row in censored:
        if int(row["uncached_tokens"]) <= uncached_tokens:
            lower_candidates.append({"label": row.get("label"), "tokens": int(row["uncached_tokens"]), "ms": float(row["prefill_censored_lower_ms"]), "kind": "censored_lower"})
    lower = max(lower_candidates, key=lambda row: row["ms"]) if lower_candidates else None

    # A completed same-regime observation with >= target uncached tokens is a conservative
    # upper envelope point under the explicit monotone-prefill assumption. Censored rows
    # are never promoted to upper bounds.
    upper_candidates = [
        {"label": row.get("label"), "tokens": int(row["uncached_tokens"]), "ms": float(row["prefill_complete_ms"]), "kind": "completed_upper"}
        for row in completed if int(row["uncached_tokens"]) >= uncached_tokens
    ]
    upper = max(upper_candidates, key=lambda row: row["ms"]) if upper_candidates else None
    return {
        "protocol": "empirical-prefill-interval-v1",
        "authority": "same_regime_monotone_empirical_envelope",
        "regime": regime,
        "uncached_tokens": uncached_tokens,
        "lower_bound_ms": round(lower["ms"], 3) if lower else None,
        "lower_bound_source": lower,
        "upper_bound_ms": round(upper["ms"], 3) if upper else None,
        "upper_bound_source": upper,
        "safe_upper_bound_available": upper is not None,
        "unsupported_extrapolation": upper is None,
    }


def prefill_wall_admission(
    profile: dict[str, Any], *, uncached_tokens: int, regime: str,
    min_output_tokens: int, requested_max_output_tokens: int,
    wall_budget_s: float, safety_factor: float, protocol_reserve_ms: float = 0.0,
) -> dict[str, Any]:
    if uncached_tokens < 0 or min_output_tokens < 1 or requested_max_output_tokens < min_output_tokens:
        raise RuntimeError("invalid output/prefill admission inputs")
    if wall_budget_s <= 0 or safety_factor < 1.0 or protocol_reserve_ms < 0:
        raise RuntimeError("invalid wall admission policy")
    interval = empirical_prefill_interval(profile, uncached_tokens=uncached_tokens, regime=regime)
    decode_rate = numeric(profile.get("decode_ms_per_token_upper"))
    reasons: list[str] = []
    if interval["safe_upper_bound_available"] is not True:
        reasons.append(f"missing_{regime}_prefill_safe_upper_bound")
    if decode_rate is None:
        reasons.append("missing_decode_cost_evidence")

    wall_ms = wall_budget_s * 1000.0
    prefill_upper = numeric(interval.get("upper_bound_ms"))
    guarded_prefill_ms = prefill_upper * safety_factor if prefill_upper is not None else None
    decode_token_cost_ms = decode_rate * safety_factor if decode_rate is not None else None
    remaining_decode_ms = None
    derived_max_output_tokens = 0
    if guarded_prefill_ms is not None and decode_token_cost_ms is not None:
        remaining_decode_ms = max(0.0, wall_ms - protocol_reserve_ms - guarded_prefill_ms)
        derived_max_output_tokens = int(math.floor(remaining_decode_ms / decode_token_cost_ms)) if decode_token_cost_ms > 0 else 0
        derived_max_output_tokens = min(requested_max_output_tokens, derived_max_output_tokens)
        if derived_max_output_tokens < min_output_tokens:
            reasons.append("insufficient_minimum_viable_decode_budget")

    # Censored evidence at or below the target is a direct hard blocker when its lower
    # bound already consumes the whole wall. It remains a lower bound, never an upper estimate.
    censored_blockers: list[dict[str, Any]] = []
    for row in profile.get("observations") or []:
        if not isinstance(row, dict) or row.get("regime") != regime: continue
        lower = numeric(row.get("prefill_censored_lower_ms")); tokens = row.get("uncached_tokens")
        if lower is None or not isinstance(tokens, int): continue
        if tokens <= uncached_tokens and lower + protocol_reserve_ms >= wall_ms:
            censored_blockers.append({"label": row.get("label"), "uncached_tokens": tokens, "lower_ms": lower})
    if censored_blockers:
        reasons.append("censored_prefill_lower_bound_exhausts_wall")

    planned_decode_tokens = derived_max_output_tokens if not reasons else 0
    planned_decode_ms = planned_decode_tokens * decode_token_cost_ms if decode_token_cost_ms is not None else None
    predicted_total_upper_ms = None
    if guarded_prefill_ms is not None and planned_decode_ms is not None:
        predicted_total_upper_ms = guarded_prefill_ms + protocol_reserve_ms + planned_decode_ms
    return {
        "protocol": "prefill-wall-admission-v2",
        "authority": "same_regime_empirical_upper_envelope_plus_dynamic_decode_budget",
        "regime": regime,
        "cache_credit_policy": "credit_requires_current_runtime_residency_authority",
        "uncached_tokens": uncached_tokens,
        "wall_budget_s": wall_budget_s,
        "safety_factor": safety_factor,
        "protocol_reserve_ms": protocol_reserve_ms,
        "prefill_interval": interval,
        "guarded_prefill_upper_ms": round(guarded_prefill_ms, 3) if guarded_prefill_ms is not None else None,
        "decode_ms_per_token_upper": decode_rate,
        "guarded_decode_ms_per_token": round(decode_token_cost_ms, 6) if decode_token_cost_ms is not None else None,
        "minimum_viable_output_tokens": min_output_tokens,
        "requested_max_output_tokens": requested_max_output_tokens,
        "derived_max_output_tokens": derived_max_output_tokens,
        "planned_decode_tokens": planned_decode_tokens,
        "remaining_decode_ms": round(remaining_decode_ms, 3) if remaining_decode_ms is not None else None,
        "planned_decode_ms": round(planned_decode_ms, 3) if planned_decode_ms is not None else None,
        "predicted_total_upper_ms": round(predicted_total_upper_ms, 3) if predicted_total_upper_ms is not None else None,
        "censored_blockers": censored_blockers,
        "reasons": reasons,
        "admitted": not reasons,
    }


def make_prefix_probe_body(body: dict[str, Any]) -> dict[str, Any]:
    alt = copy.deepcopy(body)
    messages = alt.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        raise RuntimeError("cache contract expects exactly two messages")
    messages[1] = {"role": "user", "content": "TURN_PREFIX_RESIDENCY_PRIME different_suffix"}
    alt["max_tokens"] = 1
    return alt


def cache_contract(prefill: Any, model: dict[str, Any], body: dict[str, Any], shape_budget_s: float) -> dict[str, Any]:
    full = exact_body_tokens(prefill, model["url"], body, shape_budget_s)
    alt_body = make_prefix_probe_body(body)
    alternate = exact_body_tokens(prefill, model["url"], alt_body, shape_budget_s)
    lcp = token_lcp(full["tokens"], alternate["tokens"])
    prefix_tokens = full["tokens"][:lcp]
    identity_payload = {
        "model": model,
        "shared_prefix_token_ids_sha256": hashlib.sha256(canonical_json(prefix_tokens).encode("utf-8")).hexdigest(),
        "full_prompt_token_ids_sha256": full["token_ids_sha256"],
        "prime_prompt_token_ids_sha256": alternate["token_ids_sha256"],
    }
    return {
        "protocol": "deterministic-prefix-cache-contract-v2",
        "authority": "server_template_token_lcp_not_runtime_residency",
        "total_prompt_tokens": full["token_count"],
        "prime_prompt_tokens": alternate["token_count"],
        "potential_shared_prefix_tokens": lcp,
        "potential_shared_prefix_ratio": round(lcp / full["token_count"], 4) if full["token_count"] else 0.0,
        "shared_prefix_token_ids_sha256": identity_payload["shared_prefix_token_ids_sha256"],
        "cache_contract_identity_sha256": hashlib.sha256(canonical_json(identity_payload).encode("utf-8")).hexdigest(),
        "first_turn_runtime_cache_credit_tokens": 0,
        "runtime_cache_credit_authority": "none_first_turn",
        "full_token_ids_sha256": full["token_ids_sha256"],
        "alternate_token_ids_sha256": alternate["token_ids_sha256"],
    }


def residency_evaluation(contract: dict[str, Any], grounded_result: dict[str, Any], tolerance_tokens: int) -> dict[str, Any]:
    if tolerance_tokens < 0:
        raise RuntimeError("residency tolerance must be non-negative")
    expected = int(contract.get("potential_shared_prefix_tokens") or 0)
    actual = cached_tokens_from_result(grounded_result)
    obs = result_cost_observation(grounded_result, int(contract.get("total_prompt_tokens") or 0), "residency:grounded_probe")
    prefill_complete = numeric(obs.get("prefill_complete_ms")) if isinstance(obs, dict) else None
    threshold = max(0, expected - tolerance_tokens)
    proven = actual >= threshold and expected > 0 and prefill_complete is not None
    return {
        "protocol": "runtime-prefix-residency-proof-v1",
        "authority": "immediate_prime_then_grounded_runtime_observation",
        "cache_contract_identity_sha256": contract.get("cache_contract_identity_sha256"),
        "shared_prefix_token_ids_sha256": contract.get("shared_prefix_token_ids_sha256"),
        "expected_shared_prefix_tokens": expected,
        "tolerance_tokens": tolerance_tokens,
        "required_cached_tokens": threshold,
        "observed_cached_tokens": actual,
        "prefill_complete_ms": round(prefill_complete, 3) if prefill_complete is not None else None,
        "proof": proven,
        "reason": None if proven else "runtime_cache_credit_not_proven",
    }


def rebuild_slice_rendered(slice_doc: dict[str, Any], dependencies: list[dict[str, Any]]) -> dict[str, Any]:
    atoms = [EvidenceAtom(**row) for row in slice_doc["evidence_atoms"]]
    dep_rows = [DependencyAtom(**row) for row in dependencies]
    rendered = render_slice(slice_doc["file"], slice_doc["file_sha256"], atoms, dep_rows)
    out = dict(slice_doc)
    out["dependencies"] = dependencies
    out["source_payload_bytes"] = sum(row.source_bytes for row in atoms) + sum(row.source_bytes for row in dep_rows)
    out["rendered_bytes"] = len(rendered.encode("utf-8"))
    out["rendered_sha256"] = sha256_text(rendered)
    out["rendered"] = rendered
    return apply_model_view(out, atoms, dep_rows)


def compile_python_slice(
    *,
    mv: Any,
    prefill: Any,
    fixture: dict[str, Any],
    spec: dict[str, Any],
    task_prompt: str,
    source_repo: Path,
    handle: str,
    max_bytes: int,
    max_declarations: int,
    dependency_depth: int,
    max_statement_atoms: int = 10,
    statement_dataflow_depth: int = 2,
) -> dict[str, Any]:
    if max_bytes < 256:
        raise RuntimeError("synthesis slice max_bytes must be >= 256")
    if max_declarations < 1 or max_declarations > 4:
        raise RuntimeError("max_declarations must be in [1,4]")
    ir_row, obligation = obligation_for_handle(prefill, spec, handle)
    if ir_row.get("operation") != "python_declaration":
        raise RuntimeError(f"adapter {PYTHON_ADAPTER_PROTOCOL} does not support operation={ir_row.get('operation')!r}")
    slot = obligation.get("slot")
    if not isinstance(slot, str) or not slot:
        raise RuntimeError(f"slot missing for {handle}")

    slot_paths, source_records = parse_context_records(evidence_texts(mv, fixture))
    relative_path = slot_paths.get(slot)
    if not isinstance(relative_path, str) or not relative_path:
        raise RuntimeError(f"source-validated slot path missing for slot={slot}")
    records = source_records.get(relative_path, [])
    if not records:
        raise RuntimeError(f"SOURCE records missing for slot file={relative_path}")

    source_path = safe_source_path(source_repo, relative_path)
    validation = validate_source_records(source_path, records)
    try:
        tree = ast.parse(validation["source"], filename=relative_path)
    except SyntaxError as exc:
        raise RuntimeError(f"python source parse failed {relative_path}:{exc.lineno}:{exc.msg}") from exc

    exact_anchors = set(validation["validated_lines"])
    task_constraints = task_constraint_ir(task_prompt)
    task_fact_terms = set(task_constraints["task_terms"])
    candidates = declaration_candidates(tree, validation["lines"], exact_anchors, task_fact_terms)
    if not candidates:
        raise RuntimeError(f"no enclosing Python declaration promoted from validated anchors in {relative_path}")
    requirement_ir = synthesis_requirement_ir(
        ir_row=ir_row,
        relative_path=relative_path,
        candidates=candidates,
        task_terms=task_fact_terms,
    )
    requirement_ir["task_constraints"] = task_constraints
    selected, selection = select_declarations(candidates, requirement_ir, max_declarations, max_bytes)
    spans = {(row.start_line, row.end_line) for row in selected}
    evidence_atoms, declaration_nodes, visible_statement_nodes, statement_plans = declaration_evidence_atoms(
        tree, validation["lines"], selected, task_fact_terms,
        max_statement_atoms=max_statement_atoms,
        statement_dataflow_depth=statement_dataflow_depth,
    )
    anchored_symbols = anchored_task_symbols(tree, exact_anchors, task_fact_terms, spans)
    anchor_use_atoms = anchor_symbol_use_atoms(
        tree, validation["lines"], anchored_symbols, spans, task_fact_terms
    )
    evidence_atoms.extend(anchor_use_atoms)
    evidence_atoms.sort(key=lambda row: (row.start_line, row.end_line, row.kind, row.label))
    selected_bytes = sum(row.source_bytes for row in evidence_atoms)
    if selected_bytes > max_bytes:
        raise RuntimeError(f"AST evidence atoms exceed source byte budget bytes={selected_bytes} max={max_bytes}")
    dependency_pool = dependency_atoms_for_evidence(
        tree, validation["lines"], declaration_nodes, visible_statement_nodes, dependency_depth,
        task_fact_terms, anchored_symbols,
    )
    dependencies, dependency_selection = select_dependencies(
        dependency_pool,
        used_bytes=selected_bytes,
        max_bytes=max_bytes,
    )
    selected_bytes = int(dependency_selection["final_source_bytes"])

    rendered = render_slice(relative_path, validation["file_sha256"], evidence_atoms, dependencies)
    rendered_bytes = len(rendered.encode("utf-8"))
    if rendered_bytes > max_bytes + 3072:
        raise RuntimeError(f"rendered slice metadata overhead unexpectedly high bytes={rendered_bytes}")
    model_view = render_model_view(relative_path, evidence_atoms, dependencies)

    return {
        "protocol": SLICE_PROTOCOL,
        "adapter_protocol": PYTHON_ADAPTER_PROTOCOL,
        "authority": "source_validated_exact_anchor_lines",
        "ranking_authority": False,
        "mutation_authority": False,
        "handle": handle,
        "obligation_id": ir_row.get("obligation_id"),
        "operation": ir_row.get("operation"),
        "slot": slot,
        "source_repo": str(source_repo.resolve()),
        "file": relative_path,
        "file_sha256": validation["file_sha256"],
        "validated_anchor_lines": validation["validated_lines"],
        "declared_anchors": validation["declared_anchors"],
        "anchors_without_exact_line": validation["anchors_without_exact_line"],
        "synthesis_requirements": requirement_ir,
        "selection": selection | {
            "dependency_selection": dependency_selection,
            "statement_slicing": {
                "algorithm": "bounded_statement_fact_cover_plus_frontier_dataflow",
                "max_statement_atoms": max_statement_atoms,
                "statement_dataflow_depth": statement_dataflow_depth,
                "evidence_atom_count": len(evidence_atoms),
                "anchor_symbol_use_count": len(anchor_use_atoms),
                "anchored_task_symbols": sorted(anchored_symbols),
                "plans": statement_plans,
                "frontier_symbols": sorted({symbol for plan in statement_plans for symbol in plan.get("frontier_symbols", [])}),
            },
        },
        "candidate_count": len(candidates),
        "candidates": [asdict(row) | {"source": None} for row in candidates[:8]],
        "selected_declarations": [asdict(row) | {"source": None} for row in selected],
        "evidence_atoms": [asdict(row) for row in evidence_atoms],
        "dependencies": [asdict(row) for row in dependencies],
        "dependency_depth": dependency_depth,
        "source_payload_bytes": selected_bytes,
        "rendered_bytes": rendered_bytes,
        "max_source_payload_bytes": max_bytes,
        "rendered_sha256": sha256_text(rendered),
        "rendered": rendered,
        "model_view_bytes": len(model_view.encode("utf-8")),
        "model_view_sha256": sha256_text(model_view),
        "model_view": model_view,
    }


def allowed_python_declaration_kinds(ir_row: dict[str, Any], obligation: dict[str, Any]) -> tuple[str, ...]:
    allowed_names = {"FunctionDef", "AsyncFunctionDef", "ClassDef"}
    for source in (ir_row, obligation):
        raw = source.get("allowed_ast_kinds") if isinstance(source, dict) else None
        if isinstance(raw, list) and raw:
            requested = tuple(str(item) for item in raw)
            if any(item not in allowed_names for item in requested):
                raise RuntimeError(f"unsupported allowed_ast_kinds={requested}")
            return requested
    # Adapter contract for the generic python_declaration operation; mutation authority remains downstream.
    return ("FunctionDef", "AsyncFunctionDef", "ClassDef")


def dependency_prune_order(dependencies: list[dict[str, Any]]) -> list[int]:
    optional: list[tuple[tuple[Any, ...], int]] = []
    for idx, row in enumerate(dependencies):
        if row.get("required_symbols"):
            continue
        key = (
            int(row.get("relevance_weight") or 0),
            -int(row.get("cost_units") or 0),
            int(row.get("start_line") or 0),
            str(row.get("kind") or ""),
        )
        optional.append((key, idx))
    optional.sort(key=lambda item: item[0])
    return [idx for _key, idx in optional]


def evidence_prune_order(evidence_atoms: list[dict[str, Any]]) -> list[int]:
    optional: list[tuple[tuple[Any, ...], int]] = []
    for idx, row in enumerate(evidence_atoms):
        facts = set(row.get("coverage_facts") or [])
        if "selection:optional_support" not in facts:
            continue
        key = (
            len(list(row.get("task_hits") or [])),
            -int(row.get("cost_units") or 0),
            int(row.get("start_line") or 0),
            str(row.get("kind") or ""),
            str(row.get("label") or ""),
        )
        optional.append((key, idx))
    optional.sort(key=lambda item: item[0])
    return [idx for _key, idx in optional]


def rebuild_slice_components(slice_doc: dict[str, Any], evidence_atoms: list[dict[str, Any]], dependencies: list[dict[str, Any]]) -> dict[str, Any]:
    atoms = [EvidenceAtom(**row) for row in evidence_atoms]
    dep_rows = [DependencyAtom(**row) for row in dependencies]
    rendered = render_slice(slice_doc["file"], slice_doc["file_sha256"], atoms, dep_rows)
    out = dict(slice_doc)
    out["evidence_atoms"] = evidence_atoms
    out["dependencies"] = dependencies
    out["source_payload_bytes"] = sum(row.source_bytes for row in atoms) + sum(row.source_bytes for row in dep_rows)
    out["rendered_bytes"] = len(rendered.encode("utf-8"))
    out["rendered_sha256"] = sha256_text(rendered)
    out["rendered"] = rendered
    return apply_model_view(out, atoms, dep_rows)


def fit_slice_to_prompt_budget(
    *,
    prefill: Any,
    ladder: Any,
    model: dict[str, Any],
    task_prompt: str,
    ir: dict[str, Any],
    handle: str,
    slice_doc: dict[str, Any],
    max_output_tokens: int,
    shape_budget_s: float,
    max_prompt_tokens: int,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    current = slice_doc
    ledger: list[dict[str, Any]] = []
    while True:
        body = build_grounded_turn_body(prefill, ladder, model, task_prompt, ir, handle, current, max_output_tokens)
        shape = prefill.variant_shape(ladder, model["url"], f"grounded_{handle}", body, shape_budget_s)
        observed = shape.get("prompt_tokens_observed")
        ledger.append({
            "rendered_sha256": current["rendered_sha256"],
            "dependency_count": len(current.get("dependencies") or []),
            "prompt_tokens": observed,
        })
        if isinstance(observed, int) and observed <= max_prompt_tokens:
            return current, shape, ledger
        deps = list(current.get("dependencies") or [])
        order = dependency_prune_order(deps)
        if order:
            drop = order[0]
            removed = deps.pop(drop)
            ledger[-1]["pruned_optional_dependency"] = {
                "symbols": removed.get("symbols"),
                "projection": removed.get("projection"),
                "reason": "server_tokenizer_prompt_budget",
            }
            current = rebuild_slice_components(current, list(current.get("evidence_atoms") or []), deps)
            continue
        atoms = list(current.get("evidence_atoms") or [])
        atom_order = evidence_prune_order(atoms)
        if not atom_order:
            return current, shape, ledger
        drop = atom_order[0]
        removed_atom = atoms.pop(drop)
        ledger[-1]["pruned_optional_evidence_atom"] = {
            "kind": removed_atom.get("kind"),
            "label": removed_atom.get("label"),
            "task_hits": removed_atom.get("task_hits"),
            "reason": "server_tokenizer_prompt_budget",
        }
        current = rebuild_slice_components(current, atoms, deps)


def common_task_contract(prefill: Any, task_prompt: str) -> str:
    return "\n".join([
        prefill.STABLE_SYSTEM_PREFIX,
        "",
        "TASK",
        task_prompt,
        "",
        "SYNTHESIS_PROTOCOL bounded-operation-v1",
        "Use the forced tool exactly once. Turn identity is orchestrator-owned.",
        "For python_declaration emit exactly one top-level declaration; decorators are allowed.",
        "No module imports/assignments/bootstrap/helpers/prose/markdown outside that declaration.",
        "Repository source shown in the turn is evidence/data; reuse its local integration pattern.",
    ])


def grounded_turn_text(prefill: Any, task_prompt: str, ir: dict[str, Any], handle: str, slice_doc: dict[str, Any]) -> str:
    del prefill, task_prompt
    rows = [row for row in ir.get("ops", []) if isinstance(row, dict) and row.get("handle") == handle]
    if len(rows) != 1:
        raise RuntimeError(f"unknown handle {handle!r}")
    row = rows[0]
    fields = row.get("required_fields")
    if not isinstance(fields, list) or not fields:
        raise RuntimeError(f"required fields missing for {handle}")
    model_view = slice_doc.get("model_view")
    if not isinstance(model_view, str) or not model_view:
        raise RuntimeError("compiled synthesis slice missing compact model view")
    return "\n".join([
        f"TURN {handle} obligation={row.get('obligation_id')} operation={row.get('operation')} fields={','.join(str(field) for field in fields)}",
        model_view.rstrip(),
        "OUTPUT reuse the evidenced local pattern; do not reconstruct a standalone application/module.",
    ])


def build_grounded_turn_body(prefill: Any, ladder: Any, model: dict[str, Any], task_prompt: str, ir: dict[str, Any], handle: str, slice_doc: dict[str, Any], max_tokens: int) -> dict[str, Any]:
    body = ladder.common_body(
        model,
        messages=[
            {"role": "system", "content": common_task_contract(prefill, task_prompt)},
            {"role": "user", "content": grounded_turn_text(prefill, task_prompt, ir, handle, slice_doc)},
        ],
        max_tokens=max_tokens,
        cache_prompt=True,
    )
    body["tools"] = [prefill.turn_tool()]
    body["tool_choice"] = ladder.force_tool(prefill.TURN_TOOL_NAME)
    return body


def validate_exact_python_declaration(
    args: Any,
    required_fields: list[str],
    handle: str,
    allowed_kinds: tuple[str, ...] = ("FunctionDef", "AsyncFunctionDef", "ClassDef"),
) -> tuple[bool, list[str], dict[str, str]]:
    errors: list[str] = []
    if not isinstance(args, dict):
        return False, ["turn_args_not_object"], {}
    if "h" in args or "ops" in args:
        errors.append("turn_identity_must_be_out_of_band")
    allowed_fields = {"content", "before", "after"}
    payload: dict[str, str] = {}
    for field in required_fields:
        value = args.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"missing_field:{handle}:{field}")
        else:
            payload[field] = value
    for field in sorted(allowed_fields.difference(required_fields)):
        value = args.get(field)
        if isinstance(value, str) and value.strip():
            errors.append(f"unauthorized_field:{handle}:{field}")
    content = payload.get("content")
    if isinstance(content, str):
        try:
            tree = ast.parse(content)
        except SyntaxError:
            errors.append(f"python_syntax_invalid:{handle}:content")
        else:
            kind = type(tree.body[0]).__name__ if len(tree.body) == 1 else "multiple"
            if len(tree.body) != 1 or kind not in set(allowed_kinds):
                kinds = ",".join(type(node).__name__ for node in tree.body)
                errors.append(f"python_exact_one_top_level_declaration_required:{handle}:{kinds}")
    return not errors, errors, payload


def load_inputs(args: argparse.Namespace) -> tuple[Any, Any, Any, dict[str, Any], dict[str, Any], str, dict[str, Any]]:
    prefill = load_module(Path(args.prefill).resolve(), "slice_prefill")
    mv = load_module(Path(args.model_viability).resolve(), "slice_mv")
    ladder = load_module(Path(args.ladder).resolve(), "slice_ladder")
    require_api(prefill, ["model_ir", "turn_tool", "load_task_prompt", "validate_identity", "STABLE_SYSTEM_PREFIX", "TURN_TOOL_NAME", "variant_shape", "server_endpoint", "post_json_no_inference", "apply_template_payload"], "prefill")
    require_api(mv, ["normalize_messages", "sha256_json"], "model-viability")
    require_api(ladder, ["common_body", "force_tool", "run_probe", "reported_cached_tokens", "wait_server_idle"], "ladder")
    fixture = read_json(Path(args.fixture).resolve())
    spec = read_json(Path(args.spec).resolve())
    if not isinstance(fixture, dict) or not isinstance(spec, dict):
        raise RuntimeError("fixture/spec must be JSON objects")
    task_id = spec.get("task_id")
    expected_sha = spec.get("expected_task_text_sha256")
    if not isinstance(task_id, str) or not isinstance(expected_sha, str):
        raise RuntimeError("spec task identity missing")
    task_prompt = prefill.load_task_prompt(Path(args.task).resolve(), task_id, expected_sha)
    prefill.validate_identity(fixture, spec, task_prompt)
    ir = prefill.model_ir(spec)
    return prefill, mv, ladder, fixture, spec, task_prompt, ir


def compile_for_args(args: argparse.Namespace, prefill: Any, mv: Any, fixture: dict[str, Any], spec: dict[str, Any], task_prompt: str) -> dict[str, Any]:
    return compile_python_slice(
        mv=mv,
        prefill=prefill,
        fixture=fixture,
        spec=spec,
        task_prompt=task_prompt,
        source_repo=Path(args.source_repo).expanduser().resolve(),
        handle=args.handle,
        max_bytes=int(args.slice_max_bytes),
        max_declarations=int(args.max_declarations),
        dependency_depth=int(args.dependency_depth),
    )


def inspect_command(args: argparse.Namespace) -> int:
    prefill, mv, _ladder, fixture, spec, task_prompt, _ir = load_inputs(args)
    slice_doc = compile_for_args(args, prefill, mv, fixture, spec, task_prompt)
    payload = {
        "protocol": PROTOCOL,
        "mode": "inspect",
        "no_inference": True,
        "fixture_request_sha256": fixture.get("request_sha256"),
        "task_text_sha256": spec.get("expected_task_text_sha256"),
        "slice": slice_doc,
        "pass_metric": "SOURCE_VALIDATED_SYNTHESIS_EVIDENCE_COMPILED_WITHIN_BOUNDS",
        "product_source_mutated": False,
    }
    out = Path(args.out).resolve()
    write_json(out, payload)
    print(json.dumps({
        "protocol": PROTOCOL,
        "handle": args.handle,
        "file": slice_doc["file"],
        "validated_anchor_lines": slice_doc["validated_anchor_lines"],
        "selected_declarations": [
            {key: row[key] for key in ["kind", "name", "start_line", "end_line", "anchor_lines", "head_anchor_lines", "lexical_hits", "source_bytes", "cost_units", "sha256"]}
            for row in slice_doc["selected_declarations"]
        ],
        "dependency_count": len(slice_doc["dependencies"]),
        "source_payload_bytes": slice_doc["source_payload_bytes"],
        "rendered_bytes": slice_doc["rendered_bytes"],
        "rendered_sha256": slice_doc["rendered_sha256"],
        "model_view_bytes": slice_doc["model_view_bytes"],
        "model_view_sha256": slice_doc["model_view_sha256"],
        "out": str(out),
    }, ensure_ascii=False, indent=2))
    return 0


def load_model(path: Path, requested: str | None) -> dict[str, Any]:
    doc = read_json(path)
    rows = doc.get("models") if isinstance(doc, dict) else doc
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("models config must contain non-empty models list")
    candidates = [row for row in rows if isinstance(row, dict)]
    if requested:
        candidates = [row for row in candidates if row.get("name") == requested]
    if len(candidates) != 1:
        raise RuntimeError(f"model selection expected exactly one row, found {len(candidates)}")
    model = dict(candidates[0])
    if not isinstance(model.get("url"), str) or not model["url"]:
        raise RuntimeError("selected model url missing")
    return model


def run_command(args: argparse.Namespace) -> int:
    prefill, mv, ladder, fixture, spec, task_prompt, ir = load_inputs(args)
    slice_doc = compile_for_args(args, prefill, mv, fixture, spec, task_prompt)
    model = load_model(Path(args.models).resolve(), args.model_name)
    prompt_budget = int(args.max_prompt_tokens)
    requested_output_budget = int(args.max_output_tokens)
    min_output_tokens = int(args.min_output_tokens)
    wall_budget_s = float(args.wall_budget_s)
    slice_doc, shape, prompt_fit_ledger = fit_slice_to_prompt_budget(
        prefill=prefill, ladder=ladder, model=model, task_prompt=task_prompt, ir=ir, handle=args.handle,
        slice_doc=slice_doc, max_output_tokens=requested_output_budget, shape_budget_s=float(args.shape_budget_s),
        max_prompt_tokens=prompt_budget,
    )
    provisional_body = build_grounded_turn_body(prefill, ladder, model, task_prompt, ir, args.handle, slice_doc, requested_output_budget)
    prompt_tokens = shape.get("prompt_tokens_observed")
    token_admitted = isinstance(prompt_tokens, int) and prompt_tokens <= prompt_budget
    prefix_contract = cache_contract(prefill, model, provisional_body, float(args.shape_budget_s))
    if isinstance(prompt_tokens, int) and prefix_contract["total_prompt_tokens"] != prompt_tokens:
        raise RuntimeError(f"token authority mismatch shape={prompt_tokens} exact={prefix_contract['total_prompt_tokens']}")
    cost_profile = compile_prefill_cost_profile(list(args.prefill_evidence or []))

    # Ordinary run is always first-turn/cold accounting. Historical cache evidence is never
    # promoted to current runtime residency credit.
    wall_admission = prefill_wall_admission(
        cost_profile,
        uncached_tokens=int(prefix_contract["total_prompt_tokens"]),
        regime="cold",
        min_output_tokens=min_output_tokens,
        requested_max_output_tokens=requested_output_budget,
        wall_budget_s=wall_budget_s,
        safety_factor=float(args.prefill_safety_factor),
        protocol_reserve_ms=float(args.protocol_reserve_ms),
    )
    wall_admitted = wall_admission["admitted"] is True
    planned_output_tokens = int(wall_admission.get("planned_decode_tokens") or 0)

    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    write_json(out / "synthesis-slice.json", slice_doc)
    write_json(out / "shape.json", shape)
    write_json(out / "cache-contract.json", prefix_contract)
    write_json(out / "prefill-cost-profile.json", cost_profile)
    write_json(out / "wall-admission.json", wall_admission)

    preflight_idle: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    inference_admitted = token_admitted and wall_admitted and planned_output_tokens >= min_output_tokens
    if inference_admitted:
        preflight_idle = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
        if preflight_idle.get("status") != "idle_confirmed":
            inference_admitted = False

    if inference_admitted:
        body = build_grounded_turn_body(prefill, ladder, model, task_prompt, ir, args.handle, slice_doc, planned_output_tokens)
        started = time.monotonic()
        result = ladder.run_probe(model["url"], body, wall_budget_s, f"grounded_{args.handle}")
        postflight_idle = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
        result["postflight_idle_barrier"] = postflight_idle
        parsed = result.get("tool_arguments_parsed") is True and isinstance(result.get("tool_arguments"), dict)
        row = next(row for row in ir["ops"] if row.get("handle") == args.handle)
        fields = row.get("required_fields"); fields = fields if isinstance(fields, list) else []
        if parsed:
            ir_row, obligation = obligation_for_handle(prefill, spec, args.handle)
            allowed_kinds = allowed_python_declaration_kinds(ir_row, obligation)
            valid, errors, payload = validate_exact_python_declaration(result.get("tool_arguments"), fields, args.handle, allowed_kinds)
            validation_status = "evaluated_complete_tool_arguments"; semantic_applicable = True
            failure_kind = None if valid else "grounded_contract_rejected"
        else:
            valid, errors, payload = False, [], {}
            validation_status = "not_evaluated_incomplete_tool_arguments"; semantic_applicable = False
            if result.get("finish_reason") == "length": failure_kind = "decode_budget_exhausted_before_parse"
            elif result.get("status") == "timeout": failure_kind = "wall_budget_exhausted_before_parse"
            else: failure_kind = "incomplete_tool_arguments"
        if postflight_idle.get("status") != "idle_confirmed":
            valid = False; payload = {}; failure_kind = "benchmark_environment_dirty_postflight"
        result.update({
            "handle": args.handle,
            "turn_identity_authority": "orchestrator_out_of_band",
            "source_evidence_authority": slice_doc["authority"],
            "source_ledger_sha256": slice_doc["rendered_sha256"],
            "model_view_sha256": slice_doc["model_view_sha256"],
            "source_file_sha256": slice_doc["file_sha256"],
            "planned_decode_tokens": planned_output_tokens,
            "turn_contract_valid": valid,
            "validation_status": validation_status,
            "semantic_validation_applicable": semantic_applicable,
            "turn_failure_kind": failure_kind,
            "validation_errors": errors,
            "accepted_payload": payload if valid else None,
            "reported_cached_tokens": ladder.reported_cached_tokens(result),
            "candidate_validity_authority": "not_evaluated_without_executor_verifier",
        })
        result["benchmark_wall_s"] = round(time.monotonic() - started, 3)
        write_json(out / "result.json", result)

    signals = ["SOURCE_VALIDATED_SYNTHESIS_SLICE_READY", "COMPACT_MODEL_VIEW_READY"]
    signals.append("GROUNDED_TURN_PROMPT_WITHIN_TOKEN_BUDGET" if token_admitted else "GROUNDED_TURN_PROMPT_BUDGET_EXCEEDED")
    if token_admitted and not wall_admitted:
        signals.append("GROUNDED_TURN_WALL_ADMISSION_REJECTED")
    if token_admitted and wall_admitted and preflight_idle is not None and preflight_idle.get("status") != "idle_confirmed":
        signals.append("BENCHMARK_ENVIRONMENT_DIRTY_PREFLIGHT")
    if result:
        if result.get("postflight_idle_barrier", {}).get("status") != "idle_confirmed": signals.append("BENCHMARK_ENVIRONMENT_DIRTY_POSTFLIGHT")
        elif result.get("turn_contract_valid") is True: signals.append("GROUNDED_PYTHON_DECLARATION_SUPPORTED")
        elif result.get("turn_failure_kind") == "decode_budget_exhausted_before_parse": signals.append("GROUNDED_TURN_DECODE_BUDGET_EXHAUSTED")
        elif result.get("turn_failure_kind") == "wall_budget_exhausted_before_parse": signals.append("GROUNDED_TURN_WALL_BUDGET_EXHAUSTED")
        elif result.get("semantic_validation_applicable") is True: signals.append("GROUNDED_TURN_CONTRACT_REJECTED")

    summary = {
        "protocol": PROTOCOL, "mode": "run",
        "fixture_request_sha256": fixture.get("request_sha256"), "task_text_sha256": spec.get("expected_task_text_sha256"),
        "model_name": model.get("name"), "handle": args.handle,
        "slice": {key: slice_doc[key] for key in ["protocol", "adapter_protocol", "authority", "file", "file_sha256", "validated_anchor_lines", "synthesis_requirements", "selection", "selected_declarations", "dependencies", "source_payload_bytes", "rendered_bytes", "rendered_sha256", "model_view_bytes", "model_view_sha256"]},
        "shape": shape, "prompt_fit_ledger": prompt_fit_ledger,
        "cache_contract": prefix_contract, "prefill_cost_profile": cost_profile, "wall_admission": wall_admission,
        "accounting": {"mode": "cold_first_turn", "runtime_cache_credit_tokens": 0, "priming_cost_included": False},
        "max_prompt_tokens": prompt_budget, "minimum_viable_output_tokens": min_output_tokens,
        "requested_max_output_tokens": requested_output_budget, "planned_output_tokens": planned_output_tokens,
        "token_admitted": token_admitted, "wall_admitted": wall_admitted, "preflight_idle": preflight_idle,
        "inference_admitted": inference_admitted, "result": result, "signals": signals, "decision": signals[-1],
        "candidate_validity_authority": "not_evaluated_without_executor_verifier", "product_source_mutated": False,
        "pass_metric": "EMPIRICALLY_WALL_ADMITTED_COMPACT_SOURCE_VALIDATED_SYNTHESIS_CALL",
    }
    write_json(out / "summary.json", summary)
    print("\n=== SYNTHESIS SLICE PROMOTION R6.5 ===")
    print(f"handle={args.handle} prompt_tokens={prompt_tokens} token_budget={prompt_budget} token_admitted={token_admitted}")
    print(f"cold_upper_ms={wall_admission['prefill_interval']['upper_bound_ms']} derived_decode={wall_admission['derived_max_output_tokens']} wall_admitted={wall_admitted}")
    print("SIGNALS", ",".join(signals)); print("SUMMARY", out / "summary.json")
    return 0


def residency_command(args: argparse.Namespace) -> int:
    """Benchmark-only immediate prefix-residency proof. It does not synthesize a candidate."""
    prefill, mv, ladder, fixture, spec, task_prompt, ir = load_inputs(args)
    slice_doc = compile_for_args(args, prefill, mv, fixture, spec, task_prompt)
    model = load_model(Path(args.models).resolve(), args.model_name)
    prompt_budget = int(args.max_prompt_tokens)
    slice_doc, shape, prompt_fit_ledger = fit_slice_to_prompt_budget(
        prefill=prefill, ladder=ladder, model=model, task_prompt=task_prompt, ir=ir, handle=args.handle,
        slice_doc=slice_doc, max_output_tokens=1, shape_budget_s=float(args.shape_budget_s), max_prompt_tokens=prompt_budget,
    )
    grounded_body = build_grounded_turn_body(prefill, ladder, model, task_prompt, ir, args.handle, slice_doc, 1)
    contract = cache_contract(prefill, model, grounded_body, float(args.shape_budget_s))
    prime_body = make_prefix_probe_body(grounded_body)
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    write_json(out / "cache-contract.json", contract)

    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {"protocol": PROTOCOL, "mode": "residency", "decision": "BENCHMARK_ENVIRONMENT_DIRTY_PREFLIGHT", "preflight_idle": preflight, "runtime_residency_proven": False, "product_source_mutated": False}
        write_json(out / "summary.json", summary); return 0

    prime_started = time.monotonic()
    prime_result = ladder.run_probe(model["url"], prime_body, float(args.prime_wall_budget_s), "prefix_residency_prime")
    prime_wall_ms = round((time.monotonic() - prime_started) * 1000.0, 3)
    after_prime = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    if after_prime.get("status") != "idle_confirmed":
        summary = {"protocol": PROTOCOL, "mode": "residency", "decision": "BENCHMARK_ENVIRONMENT_DIRTY_AFTER_PRIME", "preflight_idle": preflight, "after_prime_idle": after_prime, "prime_result": prime_result, "runtime_residency_proven": False, "product_source_mutated": False}
        write_json(out / "summary.json", summary); return 0
    prime_obs = result_cost_observation(prime_result, int(contract.get("prime_prompt_tokens") or 0), "residency:prime")
    prime_prefill_complete_ms = numeric(prime_obs.get("prefill_complete_ms")) if isinstance(prime_obs, dict) else None
    if not prime_prefill_completion_proven(prime_result, prime_obs):
        summary = {
            "protocol": PROTOCOL, "mode": "residency", "decision": "PREFIX_PRIME_PREFILL_INCOMPLETE",
            "preflight_idle": preflight, "after_prime_idle": after_prime, "prime_result": prime_result,
            "prime_observation": prime_obs, "prime_completion_evidence": {"authority": prime_obs.get("prefill_complete_authority") if isinstance(prime_obs, dict) else None, "is_upper_bound": prime_obs.get("prefill_complete_is_upper_bound") if isinstance(prime_obs, dict) else None}, "runtime_residency_proven": False, "product_source_mutated": False,
            "cache_state_after_probe": "unknown_or_partial_requires_server_restart_for_cold_measurement",
        }
        write_json(out / "summary.json", summary); return 0

    probe_started = time.monotonic()
    grounded_result = ladder.run_probe(model["url"], grounded_body, float(args.residency_probe_wall_budget_s), f"prefix_residency_{args.handle}")
    grounded_wall_ms = round((time.monotonic() - probe_started) * 1000.0, 3)
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    proof = residency_evaluation(contract, grounded_result, int(args.residency_tolerance_tokens))
    if postflight.get("status") != "idle_confirmed":
        proof["proof"] = False; proof["reason"] = "benchmark_environment_dirty_postflight"
    proof["preflight_idle"] = preflight; proof["after_prime_idle"] = after_prime; proof["postflight_idle"] = postflight
    proof["accounting"] = {
        "prime_wall_ms": prime_wall_ms,
        "prime_prefill_complete_ms": round(prime_prefill_complete_ms, 3),
        "prime_prefill_complete_authority": prime_obs.get("prefill_complete_authority") if isinstance(prime_obs, dict) else None,
        "prime_prefill_complete_is_upper_bound": prime_obs.get("prefill_complete_is_upper_bound") if isinstance(prime_obs, dict) else None,
        "grounded_probe_wall_ms": grounded_wall_ms,
        "priming_cost_separate_from_steady_state": True,
        "cold_cost_hidden": False,
        "cache_state_after_probe": "intentionally_warm_requires_server_restart_for_cold_measurement",
    }
    proof["prime_result"] = prime_result; proof["grounded_probe_result"] = grounded_result
    write_json(out / "residency-proof.json", proof)
    summary = {
        "protocol": PROTOCOL, "mode": "residency", "cache_contract": contract,
        "runtime_residency_proven": proof["proof"], "residency_proof": proof,
        "decision": "RUNTIME_PREFIX_RESIDENCY_PROVEN" if proof["proof"] else "RUNTIME_PREFIX_RESIDENCY_NOT_PROVEN",
        "candidate_validity_authority": "not_applicable_residency_probe", "product_source_mutated": False,
        "pass_metric": "IMMEDIATE_PREFIX_PRIME_TO_GROUNDED_RUNTIME_CACHE_REUSE",
    }
    write_json(out / "summary.json", summary)
    print("\n=== PREFIX RESIDENCY R6.5 ===")
    print(f"expected={proof['expected_shared_prefix_tokens']} cached={proof['observed_cached_tokens']} prefill_ms={proof['prefill_complete_ms']} proof={proof['proof']}")
    print("SUMMARY", out / "summary.json")
    return 0


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--source-repo", required=True)
    parser.add_argument("--handle", default="S0")
    parser.add_argument("--slice-max-bytes", type=int, default=6000)
    parser.add_argument("--max-declarations", type=int, default=1)
    parser.add_argument("--dependency-depth", type=int, default=1)
    parser.add_argument("--statement-max-atoms", type=int, default=10)
    parser.add_argument("--statement-dataflow-depth", type=int, default=2)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=("Benchmark-only source-validated synthesis evidence compiler with empirical wall admission and runtime prefix-residency proof.")
    )
    parser.add_argument("--prefill", default=str(DEFAULT_PREFILL))
    parser.add_argument("--model-viability", default=str(DEFAULT_MODEL_VIABILITY))
    parser.add_argument("--ladder", default=str(DEFAULT_LADDER))
    sub = parser.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser("inspect"); add_common(inspect); inspect.add_argument("--out", required=True)

    run = sub.add_parser("run"); add_common(run)
    run.add_argument("--models", required=True); run.add_argument("--model-name")
    run.add_argument("--shape-budget-s", type=float, default=3.0)
    run.add_argument("--max-prompt-tokens", type=int, default=1200)
    run.add_argument("--min-output-tokens", type=int, default=192)
    run.add_argument("--max-output-tokens", type=int, default=384)
    run.add_argument("--wall-budget-s", type=float, default=90.0)
    run.add_argument("--prefill-evidence", action="append", default=[], help="Prior benchmark summary/result JSON; observations stay separated by cache regime.")
    run.add_argument("--prefill-safety-factor", type=float, default=1.10)
    run.add_argument("--protocol-reserve-ms", type=float, default=0.0, help="Explicit fixed wall reserve; never folded into per-token cost.")
    run.add_argument("--idle-timeout-s", type=float, default=10.0)
    run.add_argument("--postflight-idle-timeout-s", type=float, default=15.0)
    run.add_argument("--out", required=True)

    residency = sub.add_parser("residency"); add_common(residency)
    residency.add_argument("--models", required=True); residency.add_argument("--model-name")
    residency.add_argument("--shape-budget-s", type=float, default=3.0)
    residency.add_argument("--max-prompt-tokens", type=int, default=1200)
    residency.add_argument("--prime-wall-budget-s", type=float, default=90.0)
    residency.add_argument("--residency-probe-wall-budget-s", type=float, default=90.0)
    residency.add_argument("--residency-tolerance-tokens", type=int, default=8)
    residency.add_argument("--idle-timeout-s", type=float, default=10.0)
    residency.add_argument("--postflight-idle-timeout-s", type=float, default=15.0)
    residency.add_argument("--out", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "inspect":
            return inspect_command(args)
        if args.command == "run":
            return run_command(args)
        if args.command == "residency":
            return residency_command(args)
        raise RuntimeError(f"unsupported command {args.command}")
    except Exception as exc:
        print(f"FAIL {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
