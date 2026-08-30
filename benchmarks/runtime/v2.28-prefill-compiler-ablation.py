#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PROTOCOL = "prefill-compiler-ablation-v1"
MODEL_IR_PROTOCOL = "model-ir-projection-v1"
TURN_SPLIT_PROTOCOL = "projected-turn-splitting-v1"
DEFAULT_MODEL_VIABILITY = Path(__file__).with_name("v2.28-model-viability.py")
DEFAULT_LADDER = Path(__file__).with_name("v2.28-inference-viability-ladder.py")

STABLE_SYSTEM_PREFIX = (
    "MODEL_IR_V1. Mutation topology and authority are deterministic. "
    "Use only the handles and required fields supplied in TASK_IR. "
    "Do not choose files, slots, operation count, or operation kinds."
)

COMPACT_TOOL_NAME = "emit_ops"
COMPACT_TOOL = {
    "type": "function",
    "function": {
        "name": COMPACT_TOOL_NAME,
        "description": (
            "Emit content for deterministic operation handles. "
            "Unknown handles and unauthorized fields are rejected."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "ops": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "h": {"type": "string", "minLength": 1},
                            "content": {"type": "string"},
                            "before": {"type": "string"},
                            "after": {"type": "string"},
                        },
                        "required": ["h"],
                    },
                }
            },
            "required": ["ops"],
        },
    },
}


TURN_TOOL_NAME = "emit_fields"
TURN_TOOL = {
    "type": "function",
    "function": {
        "name": TURN_TOOL_NAME,
        "description": (
            "Return only synthesized payload fields for the current deterministic turn. "
            "The orchestrator owns turn identity; do not return handles, obligation ids, "
            "operation names, or planning metadata."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "content": {"type": "string"},
                "before": {"type": "string"},
                "after": {"type": "string"},
            },
        },
    },
}


@dataclass(frozen=True)
class ModelOp:
    handle: str
    obligation_id: str
    operation: str
    required_fields: tuple[str, ...]
    source_index: int


@dataclass(frozen=True)
class RenderAtom:
    key: str
    text: str
    covers: frozenset[str]
    cost: int


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonicalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonicalize(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonicalize(item) for item in value]
    return value


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_text(canonical_json(value))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {name}: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_task_prompt(path: Path, task_id: str, expected_sha: str) -> str:
    doc = read_json(path)
    if not isinstance(doc, dict):
        raise RuntimeError("task document must be JSON object")
    tasks = doc.get("tasks")
    if isinstance(tasks, list):
        matches = [row for row in tasks if isinstance(row, dict) and row.get("id") == task_id]
        if len(matches) != 1:
            raise RuntimeError(f"task id={task_id!r} expected once, found {len(matches)}")
        row = matches[0]
    else:
        row = doc
        if row.get("id") not in {None, task_id}:
            raise RuntimeError(f"single task id mismatch expected={task_id!r} actual={row.get('id')!r}")
    prompt = row.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        raise RuntimeError("task prompt missing")
    observed = sha256_text(prompt)
    if observed != expected_sha:
        raise RuntimeError(f"task prompt SHA mismatch expected={expected_sha} observed={observed}")
    return prompt


def validate_identity(fixture: dict[str, Any], spec: dict[str, Any], task_prompt: str) -> None:
    task_id = spec.get("task_id")
    expected_sha = spec.get("expected_task_text_sha256")
    if not isinstance(task_id, str) or not task_id:
        raise RuntimeError("spec task_id missing")
    if not isinstance(expected_sha, str) or len(expected_sha) != 64:
        raise RuntimeError("spec expected_task_text_sha256 missing")
    source = fixture.get("source")
    observed_sha = source.get("task_text_sha256") if isinstance(source, dict) else None
    if observed_sha != expected_sha:
        raise RuntimeError(f"fixture task identity mismatch expected={expected_sha} observed={observed_sha}")
    if sha256_text(task_prompt) != expected_sha:
        raise RuntimeError("task prompt identity mismatch after load")


def allocate_handles(spec: dict[str, Any]) -> list[ModelOp]:
    obligations = spec.get("obligations")
    if not isinstance(obligations, list) or not obligations:
        raise RuntimeError("spec obligations missing")
    counters: dict[str, int] = {"S": 0, "C": 0, "O": 0}
    seen_ids: set[str] = set()
    out: list[ModelOp] = []
    for index, row in enumerate(obligations):
        if not isinstance(row, dict):
            raise RuntimeError("obligation must be object")
        oid = row.get("id")
        operation = row.get("operation")
        slot = row.get("slot")
        if not isinstance(oid, str) or not oid or oid in seen_ids:
            raise RuntimeError(f"invalid/duplicate obligation id={oid!r}")
        if not isinstance(operation, str) or not operation:
            raise RuntimeError(f"operation missing for {oid}")
        if not isinstance(slot, str) or ":" not in slot:
            raise RuntimeError(f"slot missing/invalid for {oid}")
        fields = row.get("constrained_fields")
        if not isinstance(fields, list) or not fields:
            fields = ["content"]
        if not all(isinstance(field, str) and field for field in fields):
            raise RuntimeError(f"invalid constrained_fields for {oid}")
        kind = slot.split(":", 1)[0]
        prefix = "C" if kind == "create" else "S" if kind == "existing" else "O"
        handle = f"{prefix}{counters[prefix]}"
        counters[prefix] += 1
        seen_ids.add(oid)
        out.append(ModelOp(handle, oid, operation, tuple(fields), index))
    if len({row.handle for row in out}) != len(out):
        raise RuntimeError("handle allocation collision")
    return out


def required_model_facts(ops: Iterable[ModelOp]) -> set[str]:
    facts: set[str] = set()
    for op in ops:
        facts.add(f"obligation:{op.obligation_id}")
        facts.add(f"operation:{op.obligation_id}:{op.operation}")
        for field in op.required_fields:
            facts.add(f"field:{op.obligation_id}:{field}")
    return facts


def machine_enforced_facts(spec: dict[str, Any]) -> set[str]:
    facts: set[str] = set()
    obligations = spec.get("obligations")
    assert isinstance(obligations, list)
    for row in obligations:
        assert isinstance(row, dict)
        oid = str(row.get("id"))
        facts.add(f"slot:{oid}:{row.get('slot')}")
        facts.add(f"family:{oid}:{row.get('family')}")
    return facts


def render_candidates(ops: list[ModelOp]) -> list[RenderAtom]:
    atoms: list[RenderAtom] = []
    for op in ops:
        facts = {
            f"obligation:{op.obligation_id}",
            f"operation:{op.obligation_id}:{op.operation}",
            *(f"field:{op.obligation_id}:{field}" for field in op.required_fields),
        }
        verbose = (
            f"obligation={op.obligation_id} operation={op.operation} "
            f"required_fields={','.join(op.required_fields)}"
        )
        compact = f"{op.handle} {op.obligation_id} {op.operation} {','.join(op.required_fields)}"
        atoms.append(RenderAtom(f"verbose:{op.handle}", verbose, frozenset(facts), len(verbose.encode("utf-8"))))
        atoms.append(RenderAtom(f"compact:{op.handle}", compact, frozenset(facts), len(compact.encode("utf-8"))))
    return atoms


def prune_dominated_atoms(atoms: list[RenderAtom]) -> list[RenderAtom]:
    out: list[RenderAtom] = []
    for atom in atoms:
        dominated = False
        for other in atoms:
            if atom is other:
                continue
            if other.covers.issuperset(atom.covers) and other.cost <= atom.cost:
                if other.covers != atom.covers or other.cost < atom.cost or other.key < atom.key:
                    dominated = True
                    break
        if not dominated:
            out.append(atom)
    return sorted(out, key=lambda row: row.key)


def greedy_weighted_set_cover(required: set[str], atoms: list[RenderAtom]) -> list[RenderAtom]:
    remaining = set(required)
    chosen: list[RenderAtom] = []
    available = list(atoms)
    while remaining:
        scored: list[tuple[float, int, str, RenderAtom, set[str]]] = []
        for atom in available:
            newly = remaining.intersection(atom.covers)
            if not newly:
                continue
            score = len(newly) / max(1, atom.cost)
            scored.append((score, len(newly), atom.key, atom, newly))
        if not scored:
            raise RuntimeError(f"set cover incomplete missing={sorted(remaining)}")
        scored.sort(key=lambda row: (-row[0], -row[1], row[2]))
        atom = scored[0][3]
        chosen.append(atom)
        remaining.difference_update(atom.covers)
        available = [row for row in available if row.key != atom.key]
    return chosen


def model_ir(spec: dict[str, Any]) -> dict[str, Any]:
    ops = allocate_handles(spec)
    required = required_model_facts(ops)
    all_atoms = render_candidates(ops)
    non_dominated = prune_dominated_atoms(all_atoms)
    selected = greedy_weighted_set_cover(required, non_dominated)
    selected_by_handle: dict[str, str] = {}
    for atom in selected:
        handle = atom.key.split(":", 1)[1]
        selected_by_handle[handle] = atom.text
    if set(selected_by_handle) != {op.handle for op in ops}:
        raise RuntimeError("renderer set-cover did not select exactly one atom per operation")
    return {
        "protocol": MODEL_IR_PROTOCOL,
        "ops": [
            {
                "handle": op.handle,
                "obligation_id": op.obligation_id,
                "operation": op.operation,
                "required_fields": list(op.required_fields),
                "source_index": op.source_index,
            }
            for op in ops
        ],
        "required_model_facts": sorted(required),
        "machine_enforced_facts": sorted(machine_enforced_facts(spec)),
        "selected_render_atoms": [selected_by_handle[op.handle] for op in ops],
        "selected_render_atom_keys": [
            next(atom.key for atom in selected if atom.key.endswith(":" + op.handle))
            for op in ops
        ],
    }


def verbose_projection_text(task_prompt: str, ir: dict[str, Any]) -> str:
    lines = ["TASK", task_prompt, "", "REQUIRED OPERATIONS"]
    for row in ir["ops"]:
        lines.extend([
            f"obligation={row['obligation_id']}",
            f"operation={row['operation']}",
            f"required_fields={','.join(row['required_fields'])}",
            "",
        ])
    lines.append("Return exactly one tool call covering every required obligation.")
    return "\n".join(lines).strip()


def compact_projection_text(task_prompt: str, ir: dict[str, Any], only_handle: str | None = None) -> str:
    rows = ir["ops"]
    if only_handle is not None:
        rows = [row for row in rows if row["handle"] == only_handle]
        if len(rows) != 1:
            raise RuntimeError(f"unknown compact handle {only_handle!r}")
    lines = ["TASK", task_prompt, "", "TASK_IR"]
    for row in rows:
        lines.append(
            f"{row['handle']} {row['obligation_id']} {row['operation']} "
            f"{','.join(row['required_fields'])}"
        )
    lines.extend([
        "",
        "OUTPUT",
        "Call emit_ops once. One row per listed handle. Fill only its required fields.",
    ])
    return "\n".join(lines)


def compact_tool() -> dict[str, Any]:
    return canonicalize(COMPACT_TOOL)


def turn_tool() -> dict[str, Any]:
    return canonicalize(TURN_TOOL)


def current_request_parts(mv: Any, fixture: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    request = fixture.get("request")
    if not isinstance(request, dict):
        raise RuntimeError("fixture request missing")
    messages = mv.normalize_messages(request.get("system"), request.get("messages"))
    tools = mv.normalize_tools(request.get("tools"))
    return messages, tools


def build_variants(
    mv: Any,
    ladder: Any,
    fixture: dict[str, Any],
    spec: dict[str, Any],
    task_prompt: str,
    model: dict[str, Any] | None,
    *,
    max_tokens: int,
    cache_prompt: bool,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    if model is None:
        model = {"temperature": 0.0}
    exact_messages, current_tools = current_request_parts(mv, fixture)
    current_name = spec.get("current_tool_name")
    if not isinstance(current_name, str) or not current_name:
        raise RuntimeError("current_tool_name missing")
    if current_name not in [ladder.tool_name(tool) for tool in current_tools]:
        raise RuntimeError("current tool absent from captured fixture")

    ir = model_ir(spec)
    verbose_tool, verbose_mapping = mv.constrained_tool(spec)
    verbose_instruction = mv.constrained_instruction(spec, verbose_mapping)
    compact = compact_tool()

    def body(messages: list[dict[str, Any]]) -> dict[str, Any]:
        return ladder.common_body(
            model,
            messages=messages,
            max_tokens=max_tokens,
            cache_prompt=cache_prompt,
        )

    a = body(exact_messages)
    a["tools"] = canonicalize(current_tools)
    a["tool_choice"] = "auto"

    b_mapping = compact_projection_text(task_prompt, ir)
    b = body([
        *exact_messages,
        {"role": "system", "content": STABLE_SYSTEM_PREFIX},
        {"role": "user", "content": "RENDERER_MAP_ONLY\n" + b_mapping},
    ])
    b["tools"] = [compact]
    b["tool_choice"] = ladder.force_tool(COMPACT_TOOL_NAME)

    c = body([
        {"role": "system", "content": STABLE_SYSTEM_PREFIX},
        {"role": "user", "content": verbose_projection_text(task_prompt, ir)},
        {"role": "system", "content": verbose_instruction},
    ])
    c["tools"] = [canonicalize(verbose_tool)]
    c["tool_choice"] = ladder.force_tool(verbose_tool["function"]["name"])

    d = body([
        {"role": "system", "content": STABLE_SYSTEM_PREFIX},
        {"role": "user", "content": compact_projection_text(task_prompt, ir)},
    ])
    d["tools"] = [compact]
    d["tool_choice"] = ladder.force_tool(COMPACT_TOOL_NAME)

    variants = {
        "A_exact_current": a,
        "B_renderer_only": b,
        "C_projection_only": c,
        "D_projection_renderer": d,
    }
    metadata = {
        "model_ir": ir,
        "compact_tool_sha256": sha256_json(compact),
        "stable_system_prefix_sha256": sha256_text(STABLE_SYSTEM_PREFIX),
        "verbose_mapping": verbose_mapping,
    }
    return variants, metadata


def body_metrics(body: dict[str, Any]) -> dict[str, Any]:
    messages = body.get("messages") if isinstance(body.get("messages"), list) else []
    tools = body.get("tools") if isinstance(body.get("tools"), list) else []
    message_bytes = len(canonical_json(messages).encode("utf-8"))
    tool_bytes = len(canonical_json(tools).encode("utf-8"))
    body_bytes = len(canonical_json(body).encode("utf-8"))
    return {
        "request_sha256": sha256_json(body),
        "canonical_body_bytes": body_bytes,
        "message_bytes": message_bytes,
        "tool_bytes": tool_bytes,
        "message_count": len(messages),
        "tool_count": len(tools),
    }


def structural_coverage(ir: dict[str, Any], body: dict[str, Any], variant: str) -> dict[str, Any]:
    required_handles = [row["handle"] for row in ir["ops"]]
    required_obligations = [row["obligation_id"] for row in ir["ops"]]
    serialized = canonical_json(body)
    if variant in {"B_renderer_only", "D_projection_renderer"}:
        missing = [handle for handle in required_handles if handle not in serialized]
        kind = "handles"
    elif variant == "C_projection_only":
        missing = [oid for oid in required_obligations if oid not in serialized]
        kind = "obligations"
    else:
        missing = []
        kind = "captured_baseline"
    return {
        "coverage_kind": kind,
        "required": required_handles if kind == "handles" else required_obligations,
        "missing": missing,
        "complete": not missing,
    }


def validate_compact_args(args: Any, ir: dict[str, Any], *, only_handle: str | None = None) -> tuple[bool, list[str], list[str]]:
    expected_rows = ir.get("ops")
    if not isinstance(expected_rows, list):
        return False, ["model_ir_ops_missing"], []
    expected = {row["handle"]: row for row in expected_rows if isinstance(row, dict)}
    if only_handle is not None:
        if only_handle not in expected:
            return False, [f"unknown_expected_handle:{only_handle}"], []
        expected = {only_handle: expected[only_handle]}
    if not isinstance(args, dict) or not isinstance(args.get("ops"), list):
        return False, ["ops_not_array"], []
    seen: set[str] = set()
    errors: list[str] = []
    accepted: list[str] = []
    allowed_payload_fields = {"content", "before", "after"}
    for index, row in enumerate(args["ops"]):
        if not isinstance(row, dict):
            errors.append(f"row_not_object:{index}")
            continue
        handle = row.get("h")
        if not isinstance(handle, str) or handle not in expected:
            errors.append(f"unknown_handle:{handle}")
            continue
        if handle in seen:
            errors.append(f"duplicate_handle:{handle}")
            continue
        seen.add(handle)
        required_fields = expected[handle].get("required_fields")
        if not isinstance(required_fields, list):
            errors.append(f"required_fields_missing:{handle}")
            continue
        for field in required_fields:
            value = row.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"missing_field:{handle}:{field}")
        unauthorized = [
            key for key in allowed_payload_fields.difference(required_fields)
            if isinstance(row.get(key), str) and row.get(key).strip()
        ]
        for field in sorted(unauthorized):
            errors.append(f"unauthorized_field:{handle}:{field}")
        accepted.append(handle)
    for handle in expected:
        if handle not in seen:
            errors.append(f"missing_handle:{handle}")
    return not errors, errors, accepted


def observed_prompt_tokens(result: dict[str, Any]) -> int | None:
    usage = result.get("usage")
    if isinstance(usage, dict):
        value = usage.get("prompt_tokens")
        if isinstance(value, int) and value >= 0:
            return value
    progress = result.get("server_progress")
    if isinstance(progress, dict):
        value = progress.get("max_prompt_tokens")
        if isinstance(value, int) and value > 0:
            return value
    return None


def server_endpoint(chat_url: str, endpoint: str) -> str:
    parsed = urlparse(chat_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError(f"invalid model URL for tokenizer shape pass: {chat_url!r}")
    port = f":{parsed.port}" if parsed.port is not None else ""
    suffix = endpoint if endpoint.startswith("/") else "/" + endpoint
    return f"{parsed.scheme}://{parsed.hostname}{port}{suffix}"


def post_json_no_inference(
    url: str,
    payload: dict[str, Any],
    *,
    timeout_s: float,
) -> tuple[dict[str, Any], float]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    started = time.monotonic()
    try:
        with urlopen(request, timeout=timeout_s) as response:
            raw = response.read(8 * 1024 * 1024)
            status = int(getattr(response, "status", 200))
    except HTTPError as exc:
        try:
            detail = exc.read(16384).decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise RuntimeError(
            f"deterministic tokenizer endpoint HTTP {exc.code} url={url} "
            f"detail={detail[:1000]!r}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(
            f"deterministic tokenizer endpoint unavailable url={url} reason={exc.reason}"
        ) from exc
    except TimeoutError as exc:
        raise RuntimeError(
            f"deterministic tokenizer endpoint timeout url={url} budget_s={timeout_s}"
        ) from exc
    elapsed_ms = round((time.monotonic() - started) * 1000, 3)
    if status != 200:
        raise RuntimeError(f"deterministic tokenizer endpoint status={status} url={url}")
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as exc:
        raise RuntimeError(f"deterministic tokenizer endpoint returned invalid JSON url={url}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"deterministic tokenizer endpoint returned non-object url={url}")
    return value, elapsed_ms


def apply_template_payload(body: dict[str, Any]) -> dict[str, Any]:
    messages = body.get("messages")
    if not isinstance(messages, list):
        raise RuntimeError("shape request messages missing")
    payload: dict[str, Any] = {
        "messages": canonicalize(messages),
        "add_generation_prompt": True,
    }
    for key in ("model", "tools", "tool_choice", "parallel_tool_calls"):
        value = body.get(key)
        if value is not None:
            payload[key] = canonicalize(value)
    return payload


def render_token_shape(
    chat_url: str,
    body: dict[str, Any],
    *,
    timeout_s: float,
) -> dict[str, Any]:
    if timeout_s <= 0:
        raise RuntimeError("tokenizer shape timeout must be > 0")

    apply_url = server_endpoint(chat_url, "/apply-template")
    tokenize_url = server_endpoint(chat_url, "/tokenize")

    rendered, apply_ms = post_json_no_inference(
        apply_url,
        apply_template_payload(body),
        timeout_s=timeout_s,
    )
    prompt = rendered.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        raise RuntimeError(
            "server /apply-template did not return a non-empty prompt; "
            "tokenizer shape pass cannot claim model-input token counts"
        )

    tokens_response, tokenize_ms = post_json_no_inference(
        tokenize_url,
        {
            "content": prompt,
            "add_special": True,
            "parse_special": True,
            "with_pieces": False,
        },
        timeout_s=timeout_s,
    )
    tokens = tokens_response.get("tokens")
    if (
        not isinstance(tokens, list)
        or not all(isinstance(token, int) for token in tokens)
    ):
        raise RuntimeError(
            "server /tokenize did not return integer token IDs; "
            "tokenizer shape pass cannot continue"
        )

    return {
        "status": "counted",
        "stage_at_end": "apply_template_plus_tokenize_complete",
        "wall_s": round((apply_ms + tokenize_ms) / 1000, 3),
        "ttft_ms": None,
        "prompt_tokens_observed": len(tokens),
        "reported_cached_tokens": None,
        "server_progress": None,
        "cancellation_barrier": {
            "status": "not_required",
            "reason": "no_inference_was_started",
        },
        "request_sha256": sha256_json(body),
        "shape_authority": "server_apply_template_plus_tokenize",
        "no_inference": True,
        "apply_template_ms": apply_ms,
        "tokenize_ms": tokenize_ms,
        "rendered_prompt_bytes": len(prompt.encode("utf-8")),
        "rendered_prompt_sha256": sha256_text(prompt),
        "token_ids_sha256": sha256_json(tokens),
        "token_count": len(tokens),
    }


def variant_shape(
    ladder: Any,
    url: str,
    name: str,
    body: dict[str, Any],
    budget_s: float,
) -> dict[str, Any]:
    del ladder, name
    return render_token_shape(url, body, timeout_s=budget_s)


def lcp_len(a: bytes, b: bytes) -> int:
    limit = min(len(a), len(b))
    index = 0
    while index < limit and a[index] == b[index]:
        index += 1
    return index


def turn_projection_text(
    task_prompt: str,
    ir: dict[str, Any],
    handle: str,
) -> str:
    rows = [
        row for row in ir.get("ops", [])
        if isinstance(row, dict) and row.get("handle") == handle
    ]
    if len(rows) != 1:
        raise RuntimeError(f"unknown turn handle {handle!r}")
    row = rows[0]
    fields = row.get("required_fields")
    if not isinstance(fields, list) or not fields:
        raise RuntimeError(f"turn required fields missing for {handle}")
    return "\n".join([
        "TASK",
        task_prompt,
        "",
        "TURN",
        f"id={handle}",
        f"obligation={row.get('obligation_id')}",
        f"operation={row.get('operation')}",
        f"required_fields={','.join(str(field) for field in fields)}",
        "",
        "SYNTHESIS",
        "Call emit_fields once.",
        "Return only synthesized source payload in the required fields.",
        "Turn id and topology are deterministic metadata; never return them as payload.",
        "Do not copy TURN/TASK_IR descriptors into payload fields.",
    ])


def build_turn_body(
    ladder: Any,
    model: dict[str, Any],
    task_prompt: str,
    ir: dict[str, Any],
    handle: str,
    *,
    max_tokens: int,
) -> dict[str, Any]:
    body = ladder.common_body(
        model,
        messages=[
            {"role": "system", "content": STABLE_SYSTEM_PREFIX},
            {"role": "user", "content": turn_projection_text(task_prompt, ir, handle)},
        ],
        max_tokens=max_tokens,
        cache_prompt=True,
    )
    body["tools"] = [turn_tool()]
    body["tool_choice"] = ladder.force_tool(TURN_TOOL_NAME)
    return body


def _normalized_projection_echoes(ir: dict[str, Any], handle: str) -> set[str]:
    rows = [
        row for row in ir.get("ops", [])
        if isinstance(row, dict) and row.get("handle") == handle
    ]
    if len(rows) != 1:
        return set()
    row = rows[0]
    fields = row.get("required_fields")
    if not isinstance(fields, list):
        fields = []
    selected = ir.get("selected_render_atoms")
    echoes: set[str] = set()
    if isinstance(selected, list):
        for value in selected:
            if isinstance(value, str) and value.strip():
                echoes.add(" ".join(value.split()).casefold())
    descriptors = [
        handle,
        str(row.get("obligation_id") or ""),
        str(row.get("operation") or ""),
        f"{handle} {row.get('obligation_id')} {row.get('operation')} {','.join(str(field) for field in fields)}",
    ]
    for value in descriptors:
        normalized = " ".join(value.split()).casefold()
        if normalized:
            echoes.add(normalized)
    return echoes


def validate_turn_args(
    args: Any,
    ir: dict[str, Any],
    handle: str,
) -> tuple[bool, list[str], dict[str, str]]:
    rows = [
        row for row in ir.get("ops", [])
        if isinstance(row, dict) and row.get("handle") == handle
    ]
    if len(rows) != 1:
        return False, [f"unknown_expected_handle:{handle}"], {}
    expected = rows[0]
    fields = expected.get("required_fields")
    if not isinstance(fields, list) or not fields:
        return False, [f"required_fields_missing:{handle}"], {}
    if not isinstance(args, dict):
        return False, ["turn_args_not_object"], {}
    if "h" in args or "ops" in args:
        return False, ["turn_identity_must_be_out_of_band"], {}

    allowed = {"content", "before", "after"}
    errors: list[str] = []
    payload: dict[str, str] = {}
    for field in fields:
        value = args.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"missing_field:{handle}:{field}")
            continue
        payload[field] = value

    for field in sorted(allowed.difference(fields)):
        value = args.get(field)
        if isinstance(value, str) and value.strip():
            errors.append(f"unauthorized_field:{handle}:{field}")

    echoes = _normalized_projection_echoes(ir, handle)
    for field, value in payload.items():
        normalized = " ".join(value.split()).casefold()
        if normalized in echoes:
            errors.append(f"projection_echo:{handle}:{field}")
        elif any(
            len(echo) >= 12 and echo in normalized
            for echo in echoes
        ):
            errors.append(f"projection_echo:{handle}:{field}")

    operation = expected.get("operation")
    if operation == "python_declaration" and isinstance(payload.get("content"), str):
        import ast as _ast
        try:
            tree = _ast.parse(payload["content"])
        except SyntaxError:
            errors.append(f"python_syntax_invalid:{handle}:content")
        else:
            declaration_nodes = (
                _ast.FunctionDef,
                _ast.AsyncFunctionDef,
                _ast.ClassDef,
            )
            if not any(isinstance(node, declaration_nodes) for node in _ast.walk(tree)):
                errors.append(f"python_declaration_missing:{handle}:content")
    if operation == "replacement":
        before = payload.get("before")
        after = payload.get("after")
        if isinstance(before, str) and isinstance(after, str) and before == after:
            errors.append(f"replacement_no_change:{handle}")

    return not errors, errors, payload

def _selected_turn_rows(ir: dict[str, Any], handles: list[str] | None) -> list[dict[str, Any]]:
    rows = [row for row in ir.get("ops", []) if isinstance(row, dict)]
    if handles is None:
        return rows
    wanted = []
    seen: set[str] = set()
    by_handle = {row.get("handle"): row for row in rows if isinstance(row.get("handle"), str)}
    for handle in handles:
        if handle in seen:
            continue
        row = by_handle.get(handle)
        if row is None:
            raise RuntimeError(f"unknown selected turn handle {handle!r}")
        seen.add(handle)
        wanted.append(row)
    if not wanted:
        raise RuntimeError("selected turn handle set is empty")
    return wanted


def run_projected_turn_split(
    ladder: Any,
    model: dict[str, Any],
    task_prompt: str,
    ir: dict[str, Any],
    *,
    total_budget_s: float,
    max_tokens_per_turn: int,
    selected_handles: list[str] | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    stages: list[dict[str, Any]] = []
    accepted: list[str] = []
    request_prefixes: list[dict[str, Any]] = []
    selected_rows = _selected_turn_rows(ir, selected_handles)
    all_expected = [row["handle"] for row in ir["ops"]]
    selected_expected = [row["handle"] for row in selected_rows]
    for row in selected_rows:
        handle = row["handle"]
        elapsed = time.monotonic() - started
        remaining = total_budget_s - elapsed
        if remaining <= 0:
            break
        body = build_turn_body(
            ladder,
            model,
            task_prompt,
            ir,
            handle,
            max_tokens=max_tokens_per_turn,
        )
        request_prefixes.append({
            "handle": handle,
            "messages_sha256": sha256_json(body["messages"][:1]),
            "tool_sha256": sha256_json(body["tools"]),
            "request_bytes": len(canonical_json(body).encode("utf-8")),
        })
        result = ladder.run_probe(model["url"], body, remaining, f"projected_ts_{handle}")
        parsed = result.get("tool_arguments_parsed") is True and isinstance(result.get("tool_arguments"), dict)
        if parsed:
            valid, errors, payload = validate_turn_args(result.get("tool_arguments"), ir, handle)
            validation_status = "evaluated_complete_tool_arguments"
            semantic_validation_applicable = True
            failure_kind = "contract_rejected" if not valid else None
        else:
            valid, errors, payload = False, [], {}
            validation_status = "not_evaluated_incomplete_tool_arguments"
            semantic_validation_applicable = False
            if result.get("finish_reason") == "length":
                failure_kind = "decode_budget_exhausted_before_parse"
            elif result.get("status") == "timeout":
                failure_kind = "wall_budget_exhausted_before_parse"
            else:
                failure_kind = "incomplete_tool_arguments"
        result["handle"] = handle
        result["turn_identity_authority"] = "orchestrator_out_of_band"
        result["turn_contract_valid"] = valid
        result["validation_status"] = validation_status
        result["semantic_validation_applicable"] = semantic_validation_applicable
        result["turn_failure_kind"] = failure_kind
        result["validation_errors"] = errors
        result["accepted_handles"] = [handle] if valid else []
        result["accepted_payload"] = payload if valid else None
        result["reported_cached_tokens"] = ladder.reported_cached_tokens(result)
        stages.append(result)
        if not valid:
            break
        accepted.append(handle)
    wall_s = round(time.monotonic() - started, 3)
    tool_shas = {row["tool_sha256"] for row in request_prefixes}
    system_shas = {row["messages_sha256"] for row in request_prefixes}
    cached_tokens = [
        row.get("reported_cached_tokens")
        for row in stages
        if isinstance(row.get("reported_cached_tokens"), int)
    ]
    completion_tokens = []
    for stage in stages:
        usage = stage.get("usage")
        if isinstance(usage, dict) and isinstance(usage.get("completion_tokens"), int):
            completion_tokens.append(usage["completion_tokens"])
    selected_complete = accepted == selected_expected and wall_s <= total_budget_s
    full_complete = selected_expected == all_expected and selected_complete
    return {
        "protocol": TURN_SPLIT_PROTOCOL,
        "shared_wall_budget": True,
        "global_budget_s": total_budget_s,
        "wall_s": wall_s,
        "cache_prompt": True,
        "stateless_turns": True,
        "stable_tool_schema": len(tool_shas) <= 1,
        "stable_system_prefix": len(system_shas) <= 1,
        "diagnostic_subset": selected_expected != all_expected,
        "selected_handles": selected_expected,
        "stages": stages,
        "accepted_handles": accepted,
        "required_handles": all_expected,
        "selected_turn_contract_complete_within_budget": selected_complete,
        "turn_contract_complete_within_budget": full_complete,
        "valid_candidate_within_budget": False,
        "candidate_validity_authority": "not_evaluated_without_executor_verifier",
        "reported_cached_tokens": cached_tokens,
        "ambient_cache_tokens_first_stage": cached_tokens[0] if cached_tokens else None,
        "cross_turn_cache_reuse_observed": any(
            isinstance(stage.get("reported_cached_tokens"), int)
            and stage.get("reported_cached_tokens", 0) > 0
            for stage in stages[1:]
        ),
        "total_completion_tokens_reported": sum(completion_tokens) if completion_tokens else None,
    }


def inspect_payload(
    mv: Any,
    ladder: Any,
    fixture: dict[str, Any],
    spec: dict[str, Any],
    task_prompt: str,
) -> dict[str, Any]:
    variants, meta = build_variants(
        mv, ladder, fixture, spec, task_prompt, None, max_tokens=1, cache_prompt=False
    )
    ir = meta["model_ir"]
    rows: dict[str, Any] = {}
    for name, body in variants.items():
        rows[name] = {
            **body_metrics(body),
            "structural_coverage": structural_coverage(ir, body, name),
        }
    a_bytes = rows["A_exact_current"]["canonical_body_bytes"]
    for name in rows:
        rows[name]["body_bytes_ratio_vs_A"] = round(rows[name]["canonical_body_bytes"] / max(1, a_bytes), 4)
    d = variants["D_projection_renderer"]
    first_handle = ir["ops"][0]["handle"]
    ts_first = build_turn_body(ladder, {"temperature": 0.0}, task_prompt, ir, first_handle, max_tokens=1)
    stable_prefix = canonical_json(d["messages"][:1]).encode("utf-8")
    d_messages = canonical_json(d["messages"]).encode("utf-8")
    ts_messages = canonical_json(ts_first["messages"]).encode("utf-8")
    return {
        "protocol": PROTOCOL,
        "task_id": spec.get("task_id"),
        "task_text_sha256": spec.get("expected_task_text_sha256"),
        "fixture_request_sha256": fixture.get("request_sha256"),
        "model_ir": ir,
        "machine_enforced_fact_count": len(ir["machine_enforced_facts"]),
        "model_required_fact_count": len(ir["required_model_facts"]),
        "stable_system_prefix_sha256": meta["stable_system_prefix_sha256"],
        "compact_tool_sha256": meta["compact_tool_sha256"],
        "stable_prefix_bytes": len(stable_prefix),
        "D_vs_TS_first_message_lcp_bytes": lcp_len(d_messages, ts_messages),
        "variants": rows,
        "product_source_mutated": False,
    }



def load_candidate_evidence(
    path: Path,
    *,
    fixture_request_sha256: str,
    task_text_sha256: str,
    model: dict[str, Any],
) -> dict[str, Any]:
    summary = read_json(path)
    if not isinstance(summary, dict):
        raise RuntimeError("candidate evidence summary must be object")
    if summary.get("protocol") != PROTOCOL:
        raise RuntimeError(
            f"candidate evidence protocol mismatch: {summary.get('protocol')!r}"
        )
    if summary.get("fixture_request_sha256") != fixture_request_sha256:
        raise RuntimeError("candidate evidence fixture identity mismatch")
    if summary.get("task_text_sha256") != task_text_sha256:
        raise RuntimeError("candidate evidence task identity mismatch")
    for key in ("name", "model", "url"):
        expected = model.get(key)
        summary_key = "model_name" if key == "name" else key
        observed = summary.get(summary_key)
        if isinstance(expected, str) and expected and observed != expected:
            raise RuntimeError(
                f"candidate evidence model identity mismatch "
                f"field={summary_key} expected={expected!r} observed={observed!r}"
            )
    candidate = summary.get("candidate_D")
    if not isinstance(candidate, dict):
        raise RuntimeError("candidate evidence has no candidate_D object")
    if candidate.get("ttft_ms") is None:
        raise RuntimeError(
            "candidate evidence did not reach first semantic/tool delta"
        )
    normalized = json.loads(json.dumps(candidate))
    normalized["evidence_source_path"] = str(path)
    normalized["evidence_source_sha256"] = sha256_text(
        path.read_text(encoding="utf-8")
    )
    if normalized.get("status") != "complete":
        prior_errors = normalized.get("validation_errors")
        if isinstance(prior_errors, list) and prior_errors:
            normalized["prior_partial_stream_validation_errors"] = prior_errors
        normalized["validation_errors"] = []
        normalized["accepted_handles"] = []
        normalized["validation_status"] = "not_evaluated_incomplete_stream"
        normalized["semantic_validation_applicable"] = False
        normalized["valid_candidate_within_budget"] = False
    else:
        normalized["semantic_validation_applicable"] = True
    return normalized


def projected_turn_shape_pass(
    ladder: Any,
    model: dict[str, Any],
    task_prompt: str,
    ir: dict[str, Any],
    *,
    per_turn_budget_s: float,
    monolithic_prompt_tokens: int | None,
    selected_handles: list[str] | None = None,
) -> dict[str, Any]:
    if per_turn_budget_s <= 0:
        raise RuntimeError("turn shape budget must be > 0")
    selected_rows = _selected_turn_rows(ir, selected_handles)
    rows: list[dict[str, Any]] = []
    for op in selected_rows:
        handle = op.get("handle")
        if not isinstance(handle, str) or not handle:
            raise RuntimeError("turn shape handle missing")
        body = build_turn_body(
            ladder,
            model,
            task_prompt,
            ir,
            handle,
            max_tokens=1,
        )
        result = variant_shape(
            ladder,
            model["url"],
            f"turn_{handle}",
            body,
            per_turn_budget_s,
        )
        rows.append({
            "handle": handle,
            **result,
        })

    token_counts = [
        row.get("prompt_tokens_observed")
        for row in rows
        if isinstance(row.get("prompt_tokens_observed"), int)
    ]
    all_counted = len(rows) == len(selected_rows) and len(token_counts) == len(rows)
    max_tokens = max(token_counts) if token_counts else None
    min_tokens = min(token_counts) if token_counts else None
    ratio = (
        max_tokens / monolithic_prompt_tokens
        if (
            all_counted
            and isinstance(monolithic_prompt_tokens, int)
            and monolithic_prompt_tokens > 0
            and isinstance(max_tokens, int)
        )
        else None
    )
    any_reduction = isinstance(ratio, float) and ratio < 1.0
    material_reduction = isinstance(ratio, float) and ratio <= 0.90
    return {
        "protocol": "projected-turn-shape-v1",
        "authority": "server_apply_template_plus_tokenize",
        "no_inference": True,
        "cache_prompt_runtime_policy": True,
        "diagnostic_subset": selected_handles is not None,
        "selected_handles": [row["handle"] for row in selected_rows],
        "rows": rows,
        "all_counted": all_counted,
        "min_prompt_tokens": min_tokens,
        "max_prompt_tokens": max_tokens,
        "monolithic_prompt_tokens": monolithic_prompt_tokens,
        "max_turn_ratio_vs_monolithic": round(ratio, 4) if isinstance(ratio, float) else None,
        "all_turns_smaller_than_monolithic": any_reduction,
        "material_turn_shape_reduction": material_reduction,
        "material_reduction_threshold_ratio": 0.90,
    }


def choose_decision(signals: list[str]) -> str:
    priority = [
        "TURN_SPLIT_SYNTHESIS_CONTRACT_SUPPORTED",
        "TURN_SPLIT_SELECTED_TURN_CONTRACT_SUPPORTED",
        "TURN_SPLIT_PREFIX_CACHE_REUSE_OBSERVED",
        "TURN_SPLIT_DECODE_BUDGET_EXHAUSTED_BEFORE_PARSE",
        "TURN_SPLIT_WALL_BUDGET_EXHAUSTED_BEFORE_PARSE",
        "TURN_SPLIT_CONTRACT_REJECTED",
        "MONOLITHIC_D_CENSORED_DURING_TOOL_ARGS",
        "PROJECTED_MODEL_IR_MONOLITHIC_VIABLE",
        "PROJECTED_MODEL_IR_REACHES_DECODE",
        "TURN_SPLIT_TOKEN_SHAPE_REDUCTION",
        "TURN_SPLIT_SHAPE_REDUCTION_NEGLIGIBLE",
        "COMBINED_PREFILL_COMPILER_TOKEN_WIN",
        "COMBINED_PREFILL_COMPILER_STRUCTURAL_WIN",
        "PROJECTION_STRUCTURAL_REDUCTION",
        "RENDERER_STRUCTURAL_REDUCTION",
        "NO_PREFILL_COMPILER_EVIDENCE_YET",
    ]
    for signal in priority:
        if signal in signals:
            return signal
    return signals[0] if signals else "NO_PREFILL_COMPILER_EVIDENCE_YET"



def choose_signals(inspect: dict[str, Any], shapes: dict[str, Any], candidate: dict[str, Any] | None, turn_split: dict[str, Any] | None, turn_shapes: dict[str, Any] | None = None) -> list[str]:
    signals: list[str] = []
    variants = inspect["variants"]
    a = variants["A_exact_current"]["canonical_body_bytes"]
    b = variants["B_renderer_only"]["canonical_body_bytes"]
    c = variants["C_projection_only"]["canonical_body_bytes"]
    d = variants["D_projection_renderer"]["canonical_body_bytes"]
    if b < a:
        signals.append("RENDERER_STRUCTURAL_REDUCTION")
    if c < a:
        signals.append("PROJECTION_STRUCTURAL_REDUCTION")
    if d < min(a, b, c):
        signals.append("COMBINED_PREFILL_COMPILER_STRUCTURAL_WIN")

    token_counts = {name: row.get("prompt_tokens_observed") for name, row in shapes.items()}
    if all(isinstance(token_counts.get(name), int) for name in ["A_exact_current", "D_projection_renderer"]):
        if token_counts["D_projection_renderer"] < token_counts["A_exact_current"]:
            signals.append("COMBINED_PREFILL_COMPILER_TOKEN_WIN")
    if candidate:
        if candidate.get("valid_candidate_within_budget") is True:
            signals.append("PROJECTED_MODEL_IR_MONOLITHIC_VIABLE")
        elif candidate.get("ttft_ms") is not None:
            signals.append("PROJECTED_MODEL_IR_REACHES_DECODE")
        if (
            candidate.get("status") == "timeout"
            and candidate.get("stage_at_end") == "tool_args_decode"
            and candidate.get("ttft_ms") is not None
        ):
            signals.append("MONOLITHIC_D_CENSORED_DURING_TOOL_ARGS")
    if isinstance(turn_shapes, dict):
        if turn_shapes.get("material_turn_shape_reduction") is True:
            signals.append("TURN_SPLIT_TOKEN_SHAPE_REDUCTION")
        elif turn_shapes.get("all_turns_smaller_than_monolithic") is True:
            signals.append("TURN_SPLIT_SHAPE_REDUCTION_NEGLIGIBLE")
    if turn_split:
        if turn_split.get("turn_contract_complete_within_budget") is True:
            signals.append("TURN_SPLIT_SYNTHESIS_CONTRACT_SUPPORTED")
        elif turn_split.get("diagnostic_subset") is True and turn_split.get("selected_turn_contract_complete_within_budget") is True:
            signals.append("TURN_SPLIT_SELECTED_TURN_CONTRACT_SUPPORTED")
        stages = turn_split.get("stages")
        if isinstance(stages, list) and stages:
            first = stages[0]
            if isinstance(first, dict):
                failure_kind = first.get("turn_failure_kind")
                if failure_kind == "decode_budget_exhausted_before_parse":
                    signals.append("TURN_SPLIT_DECODE_BUDGET_EXHAUSTED_BEFORE_PARSE")
                elif failure_kind == "wall_budget_exhausted_before_parse":
                    signals.append("TURN_SPLIT_WALL_BUDGET_EXHAUSTED_BEFORE_PARSE")
                elif first.get("semantic_validation_applicable") is True and first.get("turn_contract_valid") is False:
                    signals.append("TURN_SPLIT_CONTRACT_REJECTED")
        if turn_split.get("cross_turn_cache_reuse_observed") is True:
            signals.append("TURN_SPLIT_PREFIX_CACHE_REUSE_OBSERVED")
    if not signals:
        signals.append("NO_PREFILL_COMPILER_EVIDENCE_YET")
    return signals


def run_ablation(args: argparse.Namespace) -> int:
    mv = load_module(Path(args.model_viability).resolve(), "prefill_mv")
    ladder = load_module(Path(args.ladder).resolve(), "prefill_ladder")
    fixture = read_json(Path(args.fixture).resolve())
    spec = read_json(Path(args.spec).resolve())
    matrix = read_json(Path(args.models).resolve())
    if not isinstance(fixture, dict) or not isinstance(spec, dict) or not isinstance(matrix, dict):
        raise RuntimeError("fixture/spec/models must be JSON objects")
    task_id = spec.get("task_id")
    expected_sha = spec.get("expected_task_text_sha256")
    if not isinstance(task_id, str) or not isinstance(expected_sha, str):
        raise RuntimeError("spec identity missing")
    task_prompt = load_task_prompt(Path(args.task).resolve(), task_id, expected_sha)
    validate_identity(fixture, spec, task_prompt)
    model = ladder.model_by_name(matrix, args.model_name)
    if not isinstance(model.get("url"), str):
        raise RuntimeError("model url missing")
    selected_turn_handles = None
    raw_selected = getattr(args, "turn_split_handles", None)
    if isinstance(raw_selected, str) and raw_selected.strip():
        selected_turn_handles = [part.strip() for part in raw_selected.split(",") if part.strip()]
        _selected_turn_rows(model_ir(spec), selected_turn_handles)

    inspect = inspect_payload(mv, ladder, fixture, spec, task_prompt)
    variants, meta = build_variants(
        mv,
        ladder,
        fixture,
        spec,
        task_prompt,
        model,
        max_tokens=1,
        cache_prompt=False,
    )
    ir = meta["model_ir"]
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "inspect.json", inspect)

    shape_budget = float(args.shape_budget_s)
    total_shape_budget = float(args.shape_total_budget_s)
    if shape_budget <= 0 or total_shape_budget <= 0:
        raise RuntimeError("shape budgets must be > 0")
    started_shapes = time.monotonic()
    shapes: dict[str, Any] = {}
    for name in ["A_exact_current", "B_renderer_only", "C_projection_only", "D_projection_renderer"]:
        remaining_total = total_shape_budget - (time.monotonic() - started_shapes)
        if remaining_total <= 0:
            break
        budget = min(shape_budget, remaining_total)
        result = variant_shape(ladder, model["url"], name, variants[name], budget)
        shapes[name] = result
        write_json(out / f"shape-{name}.json", result)
        barrier = result.get("cancellation_barrier")
        if result.get("status") == "timeout" and (
            not isinstance(barrier, dict) or barrier.get("status") != "idle_confirmed"
        ):
            break

    candidate: dict[str, Any] | None = None
    candidate_source: str | None = None
    structural_d = inspect["variants"]["D_projection_renderer"]["structural_coverage"]
    token_a = shapes.get("A_exact_current", {}).get("prompt_tokens_observed")
    token_d = shapes.get("D_projection_renderer", {}).get("prompt_tokens_observed")
    d_has_reduction = (
        isinstance(token_a, int) and isinstance(token_d, int) and token_d < token_a
    ) or (
        inspect["variants"]["D_projection_renderer"]["canonical_body_bytes"]
        < inspect["variants"]["A_exact_current"]["canonical_body_bytes"]
    )

    if args.reuse_candidate_summary:
        evidence_path = Path(args.reuse_candidate_summary).resolve()
        candidate = load_candidate_evidence(
            evidence_path,
            fixture_request_sha256=str(fixture.get("request_sha256")),
            task_text_sha256=expected_sha,
            model=model,
        )
        candidate_source = "reused_summary"
        write_json(out / "candidate-D-reused.json", candidate)
        print(
            "REUSE candidate_D "
            f"path={evidence_path} "
            f"status={candidate.get('status')} "
            f"ttft_ms={candidate.get('ttft_ms')}",
            flush=True,
        )
    elif (
        structural_d.get("complete") is True
        and d_has_reduction
        and args.run_candidate == "on"
    ):
        full_variants, _ = build_variants(
            mv,
            ladder,
            fixture,
            spec,
            task_prompt,
            model,
            max_tokens=int(args.candidate_max_tokens),
            cache_prompt=False,
        )
        result = ladder.run_probe(
            model["url"],
            full_variants["D_projection_renderer"],
            float(args.candidate_budget_s),
            "D_projection_renderer_full",
        )
        if (
            result.get("status") == "complete"
            and result.get("tool_arguments_parsed") is True
        ):
            valid, errors, accepted = validate_compact_args(
                result.get("tool_arguments"),
                ir,
            )
            result["validation_status"] = "evaluated_complete_stream"
            result["semantic_validation_applicable"] = True
        else:
            valid, errors, accepted = False, [], []
            result["validation_status"] = "not_evaluated_incomplete_stream"
            result["semantic_validation_applicable"] = False
        result["valid_candidate_within_budget"] = (
            valid
            and result.get("status") == "complete"
            and result.get("wall_s", 1e9) <= float(args.candidate_budget_s)
        )
        result["validation_errors"] = errors
        result["accepted_handles"] = accepted
        result["reported_cached_tokens"] = ladder.reported_cached_tokens(result)
        candidate = result
        candidate_source = "live_run"
        write_json(out / "candidate-D.json", candidate)

    turn_shapes: dict[str, Any] | None = None
    turn_split: dict[str, Any] | None = None
    if (
        args.turn_splitting == "on"
        and candidate
        and candidate.get("ttft_ms") is not None
    ):
        turn_shapes = projected_turn_shape_pass(
            ladder,
            model,
            task_prompt,
            ir,
            per_turn_budget_s=float(args.shape_budget_s),
            monolithic_prompt_tokens=(
                token_d if isinstance(token_d, int) else None
            ),
            selected_handles=selected_turn_handles,
        )
        write_json(out / "turn-splitting-shape.json", turn_shapes)

        if turn_shapes.get("all_turns_smaller_than_monolithic") is True:
            turn_split = run_projected_turn_split(
                ladder,
                model,
                task_prompt,
                ir,
                total_budget_s=float(args.turn_split_budget_s),
                max_tokens_per_turn=int(args.turn_split_max_tokens),
                selected_handles=selected_turn_handles,
            )
            write_json(out / "turn-splitting.json", turn_split)
        else:
            print(
                "SKIP turn_splitting "
                "reason=deterministic_turn_shape_not_smaller_than_monolithic",
                flush=True,
            )

    signals = choose_signals(inspect, shapes, candidate, turn_split, turn_shapes)
    summary = {
        "protocol": PROTOCOL,
        "fixture_request_sha256": fixture.get("request_sha256"),
        "task_text_sha256": expected_sha,
        "model_name": model.get("name"),
        "model": model.get("model"),
        "url": model.get("url"),
        "inspect": inspect,
        "shape_probe": {
            "mode": "server_apply_template_plus_tokenize",
            "no_inference": True,
            "per_variant_budget_s": shape_budget,
            "total_budget_s": total_shape_budget,
            "cache_prompt": False,
            "results": shapes,
        },
        "candidate_D": candidate,
        "candidate_D_source": candidate_source,
        "turn_splitting_shape": turn_shapes,
        "turn_splitting": turn_split,
        "signals": signals,
        "decision": choose_decision(signals),
        "product_source_mutated": False,
        "pass_metric": "MODEL_FACING_INPUT_REDUCED_WITH_STRUCTURAL_OBLIGATION_COVERAGE",
    }
    write_json(out / "summary.json", summary)

    print("\n=== PREFILL COMPILER ABLATION ===")
    for name, row in inspect["variants"].items():
        shape = shapes.get(name, {})
        print(
            f"{name:24} bytes={row['canonical_body_bytes']:6} "
            f"ratio={row['body_bytes_ratio_vs_A']:.3f} "
            f"prompt_tokens={shape.get('prompt_tokens_observed')} "
            f"coverage={row['structural_coverage']['complete']}"
        )
    if candidate:
        print(
            "candidate_D               "
            f"status={candidate.get('status')} ttft_ms={candidate.get('ttft_ms')} "
            f"valid={candidate.get('valid_candidate_within_budget')}"
        )
    if turn_split:
        print(
            "turn_splitting            "
            f"valid={turn_split.get('valid_candidate_within_budget')} "
            f"wall_s={turn_split.get('wall_s')} accepted={turn_split.get('accepted_handles')}"
        )
    print("SIGNALS", ",".join(signals))
    print("SUMMARY", out / "summary.json")
    return 0


def inspect_command(args: argparse.Namespace) -> int:
    mv = load_module(Path(args.model_viability).resolve(), "prefill_mv_inspect")
    ladder = load_module(Path(args.ladder).resolve(), "prefill_ladder_inspect")
    fixture = read_json(Path(args.fixture).resolve())
    spec = read_json(Path(args.spec).resolve())
    if not isinstance(fixture, dict) or not isinstance(spec, dict):
        raise RuntimeError("fixture/spec must be JSON objects")
    task_id = spec.get("task_id")
    expected_sha = spec.get("expected_task_text_sha256")
    if not isinstance(task_id, str) or not isinstance(expected_sha, str):
        raise RuntimeError("spec identity missing")
    task_prompt = load_task_prompt(Path(args.task).resolve(), task_id, expected_sha)
    validate_identity(fixture, spec, task_prompt)
    payload = inspect_payload(mv, ladder, fixture, spec, task_prompt)
    if args.out:
        write_json(Path(args.out).resolve(), payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def scale_command(args: argparse.Namespace) -> int:
    ladder = load_module(Path(args.ladder).resolve(), "prefill_ladder_scale")
    matrix = read_json(Path(args.models).resolve())
    if not isinstance(matrix, dict):
        raise RuntimeError("models must be JSON object")
    model = ladder.model_by_name(matrix, args.model_name)
    buckets = []
    for raw in args.buckets.split(","):
        value = int(raw.strip())
        if value <= 0:
            raise RuntimeError("scale buckets must be positive")
        buckets.append(value)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    rows = []
    for words in buckets:
        remaining = float(args.shared_budget_s) - (time.monotonic() - started)
        if remaining <= 0:
            break
        prompt = " ".join(["alpha"] * words)
        body = ladder.common_body(
            model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1,
            cache_prompt=False,
        )
        result = ladder.run_probe(
            model["url"],
            body,
            min(float(args.per_bucket_budget_s), remaining),
            f"prefill_scale_{words}",
        )
        row = {
            "requested_words": words,
            "prompt_tokens_observed": observed_prompt_tokens(result),
            "status": result.get("status"),
            "wall_s": result.get("wall_s"),
            "ttft_ms": result.get("ttft_ms"),
            "timings": result.get("timings"),
            "server_progress": result.get("server_progress"),
            "cancellation_barrier": result.get("cancellation_barrier"),
        }
        rows.append(row)
        write_json(out / f"scale-{words}.json", row)
        if result.get("status") == "timeout":
            barrier = result.get("cancellation_barrier")
            if not isinstance(barrier, dict) or barrier.get("status") != "idle_confirmed":
                break
    payload = {
        "protocol": "prefill-scaling-ablation-v1",
        "cache_prompt": False,
        "rows": rows,
        "shared_budget_s": float(args.shared_budget_s),
        "product_source_mutated": False,
    }
    write_json(out / "summary.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark-only deterministic Prefill Compiler ablation: projection, "
            "mapping, canonical renderer, tokenizer-only shape pass and cache-aware Turn-Splitting."
        )
    )
    parser.add_argument("--model-viability", default=str(DEFAULT_MODEL_VIABILITY))
    parser.add_argument("--ladder", default=str(DEFAULT_LADDER))
    sub = parser.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser("inspect")
    inspect.add_argument("--fixture", required=True)
    inspect.add_argument("--spec", required=True)
    inspect.add_argument("--task", required=True)
    inspect.add_argument("--out")

    run = sub.add_parser("run")
    run.add_argument("--fixture", required=True)
    run.add_argument("--spec", required=True)
    run.add_argument("--task", required=True)
    run.add_argument("--models", required=True)
    run.add_argument("--model-name")
    run.add_argument("--out", required=True)
    run.add_argument("--shape-budget-s", type=float, default=1.5)
    run.add_argument("--shape-total-budget-s", type=float, default=12.0)
    run.add_argument("--run-candidate", choices=["on", "off"], default="on")
    run.add_argument("--reuse-candidate-summary")
    run.add_argument("--candidate-budget-s", type=float, default=45.0)
    run.add_argument("--candidate-max-tokens", type=int, default=384)
    run.add_argument("--turn-splitting", choices=["on", "off"], default="on")
    run.add_argument("--turn-split-budget-s", type=float, default=90.0)
    run.add_argument("--turn-split-max-tokens", type=int, default=192)
    run.add_argument(
        "--turn-split-handles",
        help="Comma-separated diagnostic subset, e.g. S0. Default runs all turns.",
    )

    scale = sub.add_parser("scale")
    scale.add_argument("--models", required=True)
    scale.add_argument("--model-name")
    scale.add_argument("--buckets", default="24,48,72,96")
    scale.add_argument("--per-bucket-budget-s", type=float, default=20.0)
    scale.add_argument("--shared-budget-s", type=float, default=60.0)
    scale.add_argument("--out", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "inspect":
            return inspect_command(args)
        if args.command == "run":
            return run_ablation(args)
        if args.command == "scale":
            return scale_command(args)
        raise RuntimeError(f"unsupported command {args.command}")
    except Exception as exc:
        print(f"FAIL {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
