#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.client
import json
import math
import socket
import ssl
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

PROTOCOL = "mutation-frontier-replay-v1"
DEFAULT_SERVER = "http://127.0.0.1:8080"
DEFAULT_TIMEOUT_S = 330
MAX_CAPTURE_CHARS = 2_000_000

E22_DESCRIPTION = (
    "Submit one closed, bounded additive transaction using only sealed slot ids. "
    "Always provide both replacements and creations arrays; use [] when a class is unused. "
    "For creations, relative_path is relative to the sealed create slot and must never contain "
    "an absolute path, repository path, or the sealed root. "
    "No shell, arbitrary filesystem path, raw diff authority, or model-selected create root is accepted."
)

E21_DESCRIPTION = (
    "Submit one bounded additive mutation transaction using only sealed slot ids emitted by Scout. "
    "Existing file paths are capability-derived; create_file paths are relative to one sealed "
    "source-derived root. No shell, arbitrary filesystem path, or raw diff authority is accepted."
)


def e22_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "execute_additive_plan",
            "description": E22_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "replacements": {
                        "type": "array",
                        "minItems": 0,
                        "maxItems": 5,
                        "items": {
                            "type": "object",
                            "properties": {
                                "slot": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 64,
                                },
                                "before": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 12288,
                                },
                                "replacement": {
                                    "type": "string",
                                    "maxLength": 12288,
                                },
                            },
                            "required": ["slot", "before", "replacement"],
                            "additionalProperties": False,
                        },
                    },
                    "creations": {
                        "type": "array",
                        "minItems": 0,
                        "maxItems": 2,
                        "items": {
                            "type": "object",
                            "properties": {
                                "slot": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 64,
                                },
                                "relative_path": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 240,
                                },
                                "content": {
                                    "type": "string",
                                    "maxLength": 16384,
                                },
                            },
                            "required": ["slot", "relative_path", "content"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["replacements", "creations"],
                "additionalProperties": False,
            },
        },
    }


def e21_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "execute_additive_plan",
            "description": E21_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {
                                    "type": "string",
                                    "enum": ["replace_exact", "create_file"],
                                },
                                "slot": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 64,
                                },
                                "before": {
                                    "type": "string",
                                    "maxLength": 12288,
                                },
                                "replacement": {
                                    "type": "string",
                                    "maxLength": 12288,
                                },
                                "path": {
                                    "type": "string",
                                    "maxLength": 240,
                                },
                                "content": {
                                    "type": "string",
                                    "maxLength": 16384,
                                },
                            },
                            "required": ["kind", "slot"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["operations"],
                "additionalProperties": False,
            },
        },
    }


def json_bytes(value: Any) -> int:
    return len(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def load_json_lines(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    for raw in path.read_text(
        encoding="utf-8",
        errors="replace",
    ).splitlines():
        try:
            value = json.loads(raw)
        except Exception:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def tool_name(row: dict[str, Any]) -> str | None:
    if row.get("type") != "tool_use":
        return None
    part = row.get("part")
    if not isinstance(part, dict):
        return None
    value = part.get("tool")
    return value if isinstance(value, str) else None


def tool_output(row: dict[str, Any]) -> str:
    part = row.get("part")
    if not isinstance(part, dict):
        return ""
    state = part.get("state")
    if not isinstance(state, dict):
        return ""
    value = state.get("output")
    return value if isinstance(value, str) else ""


def extract_search_output(artifact: Path) -> str:
    stdout_rows = load_json_lines(artifact / "agent.stdout.jsonl")
    for row in reversed(stdout_rows):
        if tool_name(row) == "search":
            value = tool_output(row)
            if value:
                return value

    search_rows = load_json_lines(artifact / "search-trace.jsonl")
    for row in reversed(search_rows):
        content = row.get("content")
        if not isinstance(content, list):
            continue
        texts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            value = item.get("text")
            if isinstance(value, str) and value:
                texts.append(value)
        if texts:
            return "\n".join(texts)

    return ""


def extract_task_text(
    config_path: Path | None,
    task_id: str | None,
) -> str:
    if config_path is None:
        return ""

    data = load_json(config_path)
    if not data:
        return ""

    tasks = data.get("tasks")
    if isinstance(tasks, list):
        candidates = [
            task
            for task in tasks
            if isinstance(task, dict)
            and (
                task_id is None
                or task.get("id") == task_id
                or task.get("task_id") == task_id
            )
        ]
        if len(candidates) == 1:
            value = candidates[0].get("prompt")
            return value if isinstance(value, str) else ""
        return ""

    if task_id is not None:
        own_id = data.get("id") or data.get("task_id")
        if own_id not in (None, task_id):
            return ""

    value = data.get("prompt")
    return value if isinstance(value, str) else ""


def search_elapsed_ms(artifact: Path) -> float | None:
    rows = load_json_lines(artifact / "search-trace.jsonl")
    values = [
        row.get("elapsed_ms")
        for row in rows
        if isinstance(row.get("elapsed_ms"), (int, float))
    ]
    return float(values[-1]) if values else None


def parse_step_finish(row: dict[str, Any]) -> dict[str, Any]:
    part = row.get("part")
    if not isinstance(part, dict):
        return {}
    tokens = part.get("tokens")
    return tokens if isinstance(tokens, dict) else {}


def analyze_artifact(artifact: Path) -> dict[str, Any]:
    cpu = [
        row
        for row in load_json_lines(artifact / "cpu-agent-trace.jsonl")
        if row.get("kind") == "model_dispatch"
        and isinstance(row.get("ts"), (int, float))
    ]
    cpu.sort(key=lambda row: float(row["ts"]))

    stdout = load_json_lines(artifact / "agent.stdout.jsonl")
    starts = [
        row
        for row in stdout
        if row.get("type") == "step_start"
        and isinstance(row.get("timestamp"), (int, float))
    ]
    finishes = [
        row
        for row in stdout
        if row.get("type") == "step_finish"
        and isinstance(row.get("timestamp"), (int, float))
    ]
    starts.sort(key=lambda row: float(row["timestamp"]))
    finishes.sort(key=lambda row: float(row["timestamp"]))

    result = load_json(artifact / "result.json")
    wall_s = result.get("wall_s")
    if not isinstance(wall_s, (int, float)):
        wall_s = None

    task_started = None
    for row in cpu:
        value = row.get("governor_task_started_at_ms")
        if isinstance(value, (int, float)):
            task_started = float(value)
            break
    if task_started is None and cpu:
        elapsed = cpu[0].get("turn_elapsed_ms")
        task_started = float(cpu[0]["ts"]) - (
            float(elapsed) if isinstance(elapsed, (int, float)) else 0.0
        )

    dispatches: list[dict[str, Any]] = []
    finish_index = 0
    for index, row in enumerate(cpu):
        dispatch_ts = float(row["ts"])
        start_ts = (
            float(starts[index]["timestamp"])
            if index < len(starts)
            else None
        )

        finish_row = None
        if start_ts is not None:
            while (
                finish_index < len(finishes)
                and float(finishes[finish_index]["timestamp"]) < start_ts
            ):
                finish_index += 1
            if finish_index < len(finishes):
                next_dispatch_ts = (
                    float(cpu[index + 1]["ts"])
                    if index + 1 < len(cpu)
                    else math.inf
                )
                candidate_ts = float(finishes[finish_index]["timestamp"])
                if start_ts <= candidate_ts <= next_dispatch_ts:
                    finish_row = finishes[finish_index]
                    finish_index += 1

        finish_ts = (
            float(finish_row["timestamp"])
            if finish_row is not None
            else None
        )

        if (
            finish_ts is None
            and wall_s is not None
            and task_started is not None
        ):
            censor_ts = task_started + float(wall_s) * 1000.0
        else:
            censor_ts = None

        record: dict[str, Any] = {
            "model_call": row.get("model_call"),
            "dispatch_ts": int(dispatch_ts),
            "execution_state": row.get("execution_state"),
            "next_action": row.get("next_action"),
            "context_bytes": row.get("context_bytes"),
            "context_system_bytes": row.get("context_system_bytes"),
            "context_messages_bytes": row.get("context_messages_bytes"),
            "context_tools_bytes": row.get("context_tools_bytes"),
            "message_count": row.get("message_count"),
            "tool_count": row.get("tool_count"),
            "tool_names": row.get("tool_names"),
            "tool_frontier_schema_sha256":
                row.get("tool_frontier_schema_sha256"),
            "provider_step_start_ts":
                int(start_ts) if start_ts is not None else None,
            "provider_step_finish_ts":
                int(finish_ts) if finish_ts is not None else None,
            "dispatch_to_provider_start_ms":
                round(start_ts - dispatch_ts, 3)
                if start_ts is not None
                else None,
            "provider_service_ms":
                round(finish_ts - start_ts, 3)
                if start_ts is not None and finish_ts is not None
                else None,
            "dispatch_to_finish_ms":
                round(finish_ts - dispatch_ts, 3)
                if finish_ts is not None
                else None,
            "censored_after_dispatch_ms":
                round(censor_ts - dispatch_ts, 3)
                if censor_ts is not None
                else None,
            "complete": finish_ts is not None,
        }

        if finish_row is not None:
            record["tokens"] = parse_step_finish(finish_row)

        dispatches.append(record)

    locate = dispatches[0] if dispatches else None
    mutate = dispatches[1] if len(dispatches) >= 2 else None
    search_ms = search_elapsed_ms(artifact)

    bytes_per_prompt_token = None
    estimated_mutate_prompt_tokens = None
    estimated_mutate_uncached_multiplier = None
    if locate and locate.get("complete"):
        tokens = locate.get("tokens") or {}
        prompt_input = tokens.get("input")
        cache = tokens.get("cache")
        cache_read = (
            cache.get("read")
            if isinstance(cache, dict)
            and isinstance(cache.get("read"), (int, float))
            else 0
        )
        if (
            isinstance(prompt_input, (int, float))
            and prompt_input + cache_read > 0
            and isinstance(locate.get("context_bytes"), (int, float))
        ):
            total_prompt = float(prompt_input) + float(cache_read)
            bytes_per_prompt_token = (
                float(locate["context_bytes"]) / total_prompt
            )
            if (
                mutate
                and isinstance(mutate.get("context_bytes"), (int, float))
                and bytes_per_prompt_token > 0
            ):
                estimated_mutate_prompt_tokens = (
                    float(mutate["context_bytes"])
                    / bytes_per_prompt_token
                )
                if float(prompt_input) > 0:
                    estimated_mutate_uncached_multiplier = (
                        estimated_mutate_prompt_tokens
                        / float(prompt_input)
                    )

    avoidable_locate_model_ms = None
    if locate and locate.get("dispatch_to_finish_ms") is not None:
        avoidable_locate_model_ms = float(
            locate["dispatch_to_finish_ms"]
        )
        if search_ms is not None:
            avoidable_locate_model_ms = max(
                0.0,
                avoidable_locate_model_ms - search_ms,
            )

    queue_ratio = None
    context_ratio = None
    if locate and mutate:
        a = locate.get("dispatch_to_provider_start_ms")
        b = mutate.get("dispatch_to_provider_start_ms")
        if isinstance(a, (int, float)) and a > 0 and isinstance(b, (int, float)):
            queue_ratio = b / a
        ca = locate.get("context_bytes")
        cb = mutate.get("context_bytes")
        if isinstance(ca, (int, float)) and ca > 0 and isinstance(cb, (int, float)):
            context_ratio = cb / ca

    evidence: list[str] = []
    if queue_ratio is not None and context_ratio is not None:
        if queue_ratio >= context_ratio * 1.75:
            evidence.append(
                "dispatch_to_provider_start_growth_exceeds_context_growth"
            )
    if (
        estimated_mutate_uncached_multiplier is not None
        and queue_ratio is not None
        and abs(
            queue_ratio - estimated_mutate_uncached_multiplier
        ) <= max(1.0, estimated_mutate_uncached_multiplier * 0.40)
    ):
        evidence.append(
            "queue_growth_consistent_with_uncached_prefill_first_order"
        )
    if mutate and mutate.get("complete") is False:
        evidence.append("mutation_call_right_censored_by_outer_timeout")

    best_bound = {
        "successful_task_model_calls_lower_bound": 1,
        "successful_task_target_model_calls": 1,
        "repairable_task_model_calls_cap": 2,
        "localization_model_calls_target": 0,
        "deterministic_search_elapsed_ms": search_ms,
        "avoidable_locate_model_overhead_ms":
            round(avoidable_locate_model_ms, 3)
            if avoidable_locate_model_ms is not None
            else None,
        "executor_context_bytes_observed":
            mutate.get("context_bytes") if mutate else None,
        "executor_context_target_bytes": 10 * 1024,
        "reason":
            "deterministic Scout already produced mutation-ready authority; "
            "the locate LLM call only selected search and is avoidable",
    }

    return {
        "protocol": PROTOCOL,
        "artifact": str(artifact),
        "dispatches": dispatches,
        "search_elapsed_ms": search_ms,
        "ratios": {
            "mutate_vs_locate_dispatch_to_provider_start":
                round(queue_ratio, 3)
                if queue_ratio is not None
                else None,
            "mutate_vs_locate_context_bytes":
                round(context_ratio, 3)
                if context_ratio is not None
                else None,
        },
        "prompt_estimate": {
            "bytes_per_prompt_token_from_completed_locate":
                round(bytes_per_prompt_token, 4)
                if bytes_per_prompt_token is not None
                else None,
            "mutate_total_prompt_tokens_estimate":
                round(estimated_mutate_prompt_tokens, 1)
                if estimated_mutate_prompt_tokens is not None
                else None,
            "mutate_vs_locate_uncached_prompt_multiplier_estimate":
                round(estimated_mutate_uncached_multiplier, 3)
                if estimated_mutate_uncached_multiplier is not None
                else None,
            "authority": "diagnostic_estimate_only",
        },
        "evidence": evidence,
        "best_bound": best_bound,
        "next_measurement":
            "direct mutation-frontier replay: E2.2 tiny vs E2.2 task vs "
            "E2.1 task using identical captured messages",
    }


def model_id(server: str, explicit: str | None) -> str:
    if explicit and explicit != "auto":
        return explicit
    url = server.rstrip("/") + "/v1/models"
    with urllib.request.urlopen(url, timeout=10) as response:
        data = json.loads(response.read().decode("utf-8"))
    rows = data.get("data")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("llama server /v1/models returned no models")
    value = rows[0].get("id")
    if not isinstance(value, str) or not value:
        raise RuntimeError("llama server model id unavailable")
    return value


def mutation_messages(
    *,
    task_text: str,
    search_output: str,
    tiny: bool,
) -> list[dict[str, Any]]:
    system = (
        "You are the bounded mutation Executor. Search/localization has already "
        "completed deterministically. Use only execute_additive_plan. "
        "Do not call search, do not ask for files, do not use shell. "
        "The supplied tool schema is authoritative if the captured Scout text "
        "mentions an older or newer mutation ABI. Emit only the transaction "
        "needed for the task."
    )

    assistant = {
        "role": "assistant",
        "tool_calls": [{
            "id": "replay_search_1",
            "type": "function",
            "function": {
                "name": "search",
                "arguments": '{"replay":true}',
            },
        }],
    }
    tool = {
        "role": "tool",
        "tool_call_id": "replay_search_1",
        "name": "search",
        "content": search_output,
    }

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": "TASK:\n" + task_text},
        assistant,
        tool,
    ]

    if tiny:
        messages.append({
            "role": "user",
            "content": (
                "DIAGNOSTIC ONLY: do not solve the task. Return the smallest "
                "syntactically valid execute_additive_plan call. "
                "For closed E2.2 use creations=[{slot:'create:0',"
                "relative_path:'x.html',content:'x'}] and replacements=[]. "
                "For E2.1 use one create_file operation with slot create:0, "
                "path x.html and content x."
            ),
        })

    return messages


def post_stream(
    *,
    server: str,
    payload: dict[str, Any],
    timeout_s: int,
) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(server)
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError(f"unsupported server scheme: {parsed.scheme}")

    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    base_path = parsed.path.rstrip("/")
    path = base_path + "/v1/chat/completions"

    body = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    connection_cls = (
        http.client.HTTPSConnection
        if parsed.scheme == "https"
        else http.client.HTTPConnection
    )
    kwargs: dict[str, Any] = {"timeout": timeout_s}
    if parsed.scheme == "https":
        kwargs["context"] = ssl.create_default_context()

    conn = connection_cls(host, port, **kwargs)
    started_ns = time.monotonic_ns()
    response_ns = None
    first_data_ns = None
    first_semantic_ns = None
    chunks = 0
    content_parts: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    final_usage: dict[str, Any] = {}
    final_timings: dict[str, Any] = {}
    finish_reason = None

    try:
        conn.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
        )
        response = conn.getresponse()
        response_ns = time.monotonic_ns()

        if response.status >= 400:
            error_body = response.read().decode(
                "utf-8",
                errors="replace",
            )
            raise RuntimeError(
                f"HTTP {response.status}: "
                f"{error_body[-4000:]}"
            )

        while True:
            raw = response.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue

            data = line[5:].strip()
            if data == "[DONE]":
                break

            if first_data_ns is None:
                first_data_ns = time.monotonic_ns()

            try:
                chunk = json.loads(data)
            except Exception:
                continue
            chunks += 1

            usage = chunk.get("usage")
            if isinstance(usage, dict):
                final_usage = usage

            timings = chunk.get("timings")
            if isinstance(timings, dict):
                final_timings = timings

            choices = chunk.get("choices")
            if not isinstance(choices, list):
                continue

            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                if choice.get("finish_reason") is not None:
                    finish_reason = choice.get("finish_reason")
                delta = choice.get("delta")
                if not isinstance(delta, dict):
                    continue

                content = delta.get("content")
                if isinstance(content, str) and content:
                    if first_semantic_ns is None:
                        first_semantic_ns = time.monotonic_ns()
                    content_parts.append(content)

                calls = delta.get("tool_calls")
                if not isinstance(calls, list):
                    continue
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    index = call.get("index")
                    if not isinstance(index, int):
                        index = 0
                    target = tool_calls.setdefault(
                        index,
                        {
                            "id": "",
                            "type": "function",
                            "function": {
                                "name": "",
                                "arguments": "",
                            },
                        },
                    )
                    value = call.get("id")
                    if isinstance(value, str):
                        target["id"] += value
                    fn = call.get("function")
                    if isinstance(fn, dict):
                        name = fn.get("name")
                        arguments = fn.get("arguments")
                        if isinstance(name, str):
                            target["function"]["name"] += name
                        if isinstance(arguments, str):
                            if first_semantic_ns is None:
                                first_semantic_ns = time.monotonic_ns()
                            target["function"]["arguments"] += arguments

        finished_ns = time.monotonic_ns()
    finally:
        conn.close()

    def ms(ns: int | None, origin: int = started_ns) -> float | None:
        if ns is None:
            return None
        return round((ns - origin) / 1_000_000.0, 3)

    return {
        "http_response_ms": ms(response_ns),
        "first_sse_data_ms": ms(first_data_ns),
        "first_semantic_delta_ms": ms(first_semantic_ns),
        "total_ms": ms(finished_ns),
        "chunks": chunks,
        "finish_reason": finish_reason,
        "usage": final_usage,
        "timings": final_timings,
        "content": "".join(content_parts)[-MAX_CAPTURE_CHARS:],
        "tool_calls": [
            tool_calls[index]
            for index in sorted(tool_calls)
        ],
    }


def run_replay(
    *,
    artifact: Path,
    task_config: Path,
    task_id: str,
    server: str,
    model: str | None,
    variants: list[str],
    repeat: int,
    timeout_s: int,
    max_tokens: int,
) -> dict[str, Any]:
    task_text = extract_task_text(task_config, task_id)
    if not task_text:
        raise RuntimeError(
            "task prompt unavailable; check --task-config/--task-id"
        )

    search_output = extract_search_output(artifact)
    if not search_output:
        raise RuntimeError(
            "captured search output unavailable in artifact"
        )

    resolved_model = model_id(server, model)
    analysis = analyze_artifact(artifact)
    results: list[dict[str, Any]] = []

    definitions = {
        "e22_task": (e22_tool(), False),
        "e22_tiny": (e22_tool(), True),
        "e21_task": (e21_tool(), False),
        "e21_tiny": (e21_tool(), True),
    }

    for variant in variants:
        if variant not in definitions:
            raise RuntimeError(f"unknown replay variant: {variant}")
        tool, tiny = definitions[variant]

        messages = mutation_messages(
            task_text=task_text,
            search_output=search_output,
            tiny=tiny,
        )

        for attempt in range(1, repeat + 1):
            payload = {
                "model": resolved_model,
                "messages": messages,
                "tools": [tool],
                "tool_choice": "auto",
                "temperature": 0,
                "max_tokens": max_tokens,
                "stream": True,
                "stream_options": {"include_usage": True},
            }

            row: dict[str, Any] = {
                "variant": variant,
                "attempt": attempt,
                "model": resolved_model,
                "message_bytes": json_bytes(messages),
                "tool_schema_bytes": json_bytes([tool]),
                "request_bytes": json_bytes(payload),
                "authority": "diagnostic_only_no_tool_execution",
            }

            started = time.monotonic()
            try:
                row.update(
                    post_stream(
                        server=server,
                        payload=payload,
                        timeout_s=timeout_s,
                    )
                )
                row["ok"] = True
                row["error"] = None
            except (
                TimeoutError,
                socket.timeout,
                OSError,
                RuntimeError,
            ) as exc:
                row.update({
                    "ok": False,
                    "error": str(exc),
                    "total_ms":
                        round(
                            (time.monotonic() - started) * 1000.0,
                            3,
                        ),
                })
            results.append(row)

    return {
        "protocol": PROTOCOL,
        "mode": "replay",
        "artifact": str(artifact),
        "task_config": str(task_config),
        "task_id": task_id,
        "server": server,
        "model": resolved_model,
        "analysis": analysis,
        "replays": results,
        "decision_rules": {
            "e22_tiny_slow_before_first_semantic":
                "prefill/tool-grammar/provider frontier bottleneck",
            "e22_tiny_fast_e22_task_slow":
                "task decode/output volume bottleneck",
            "e21_task_fast_e22_task_slow":
                "E2.2 tool-schema/grammar regression",
            "all_variants_fast":
                "full E2E/OpenCode scheduling or cache-state variance",
        },
    }


def self_test() -> None:
    with tempfile.TemporaryDirectory(
        prefix="frontier-replay-selftest-"
    ) as td:
        root = Path(td)
        artifact = root / "artifact"
        artifact.mkdir()

        cpu_rows = [
            {
                "ts": 1_000,
                "kind": "model_dispatch",
                "model_call": 1,
                "turn_elapsed_ms": 7,
                "execution_state": "locate",
                "next_action": "search",
                "context_bytes": 5_813,
                "context_system_bytes": 1_296,
                "context_messages_bytes": 1_926,
                "context_tools_bytes": 2_559,
                "message_count": 1,
                "tool_count": 1,
                "tool_names": ["search"],
                "tool_frontier_schema_sha256": "a" * 64,
                "governor_task_started_at_ms": 993,
            },
            {
                "ts": 22_050,
                "kind": "model_dispatch",
                "model_call": 2,
                "execution_state": "mutate",
                "next_action": "execute_additive_plan",
                "context_bytes": 10_475,
                "context_system_bytes": 1_296,
                "context_messages_bytes": 7_416,
                "context_tools_bytes": 1_731,
                "message_count": 3,
                "tool_count": 1,
                "tool_names": ["execute_additive_plan"],
                "tool_frontier_schema_sha256": "b" * 64,
                "governor_task_started_at_ms": 993,
            },
        ]
        (artifact / "cpu-agent-trace.jsonl").write_text(
            "\n".join(json.dumps(x) for x in cpu_rows) + "\n",
            encoding="utf-8",
        )

        stdout_rows = [
            {
                "type": "step_start",
                "timestamp": 19_439,
                "part": {},
            },
            {
                "type": "tool_use",
                "timestamp": 21_000,
                "part": {
                    "tool": "search",
                    "state": {
                        "output":
                            "ADDITIVE_CAPABILITY x\n"
                            "NEXT_ACTION=execute_additive_plan"
                    },
                },
            },
            {
                "type": "step_finish",
                "timestamp": 22_017,
                "part": {
                    "tokens": {
                        "input": 516,
                        "output": 48,
                        "cache": {"read": 674, "write": 0},
                    },
                },
            },
            {
                "type": "step_start",
                "timestamp": 112_147,
                "part": {},
            },
        ]
        (artifact / "agent.stdout.jsonl").write_text(
            "\n".join(json.dumps(x) for x in stdout_rows) + "\n",
            encoding="utf-8",
        )
        (artifact / "search-trace.jsonl").write_text(
            json.dumps({"elapsed_ms": 745.47}) + "\n",
            encoding="utf-8",
        )
        (artifact / "result.json").write_text(
            json.dumps({"wall_s": 300.017}) + "\n",
            encoding="utf-8",
        )

        report = analyze_artifact(artifact)
        assert len(report["dispatches"]) == 2
        first, second = report["dispatches"]
        assert round(first["dispatch_to_provider_start_ms"]) == 18_439
        assert round(second["dispatch_to_provider_start_ms"]) == 90_097
        assert first["complete"] is True
        assert second["complete"] is False
        assert report["best_bound"][
            "successful_task_target_model_calls"
        ] == 1
        assert report["best_bound"][
            "repairable_task_model_calls_cap"
        ] == 2
        assert report["ratios"][
            "mutate_vs_locate_dispatch_to_provider_start"
        ] > 4.8
        assert report["ratios"][
            "mutate_vs_locate_context_bytes"
        ] < 1.9
        assert (
            "dispatch_to_provider_start_growth_exceeds_context_growth"
            in report["evidence"]
        )

        e22 = e22_tool()
        e21 = e21_tool()
        p22 = e22["function"]["parameters"]
        p21 = e21["function"]["parameters"]
        assert "replacements" in p22["properties"]
        assert "creations" in p22["properties"]
        assert "operations" not in p22["properties"]
        assert "operations" in p21["properties"]
        assert "replacements" not in p21["properties"]

        task_cfg = root / "task.json"
        task_cfg.write_text(
            json.dumps({
                "tasks": [{
                    "id": "t",
                    "prompt": "add a page",
                }]
            }),
            encoding="utf-8",
        )
        assert extract_task_text(task_cfg, "t") == "add a page"
        assert "NEXT_ACTION" in extract_search_output(artifact)

    print("PASS mutation-frontier replay artifact decomposition")
    print("PASS one-call best-bound derivation")
    print("PASS E2.1/E2.2 replay schemas are isolated")
    print("PASS replay remains diagnostic-only and executes no mutation tools")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Decompose an E2 mutation frontier and optionally replay only "
            "the model/tool boundary directly against llama-server."
        )
    )
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--task-config", type=Path)
    parser.add_argument("--task-id")
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--model", default="auto")
    parser.add_argument(
        "--variants",
        default="e22_tiny,e22_task,e21_task",
        help=(
            "comma-separated: e22_tiny,e22_task,e21_tiny,e21_task"
        ),
    )
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--timeout-s", type=int, default=DEFAULT_TIMEOUT_S)
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--replay", action="store_true")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    if args.artifact is None:
        parser.error("--artifact is required unless --self-test")

    artifact = args.artifact.resolve()
    if not artifact.is_dir():
        raise SystemExit(f"artifact directory missing: {artifact}")

    if args.replay:
        if args.task_config is None or not args.task_id:
            parser.error("--replay requires --task-config and --task-id")
        variants = [
            value.strip()
            for value in args.variants.split(",")
            if value.strip()
        ]
        if args.repeat < 1 or args.repeat > 5:
            parser.error("--repeat must be in 1..5")
        report = run_replay(
            artifact=artifact,
            task_config=args.task_config.resolve(),
            task_id=args.task_id,
            server=args.server,
            model=args.model,
            variants=variants,
            repeat=args.repeat,
            timeout_s=args.timeout_s,
            max_tokens=args.max_tokens,
        )
    else:
        report = analyze_artifact(artifact)

    rendered = json.dumps(
        report,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    print(rendered)

    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered + "\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
