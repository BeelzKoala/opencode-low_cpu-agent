#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import http.client
import importlib.util
import json
import socket
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PROTOCOL = "inference-viability-ladder-v1.2-cache-control"
TURN_SPLIT_PROTOCOL = "turn-splitting-ablation-v1"
DEFAULT_MODEL_VIABILITY = Path(__file__).with_name("v2.28-model-viability.py")
DEFAULT_BASELINE_SUMMARY = Path(
    "benchmarks/results/model-viability/north-current-vs-constrained-r1/summary.json"
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_model_viability(path: Path):
    spec = importlib.util.spec_from_file_location("opencode_model_viability", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import model viability benchmark: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def model_by_name(matrix: dict[str, Any], name: str | None) -> dict[str, Any]:
    rows = matrix.get("models")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("model matrix contains no models")
    candidates = [row for row in rows if isinstance(row, dict)]
    if name is None:
        if len(candidates) != 1:
            raise RuntimeError("model matrix has multiple models; pass --model-name")
        selected = candidates[0]
    else:
        matches = [row for row in candidates if row.get("name") == name]
        if len(matches) != 1:
            raise RuntimeError(f"expected one model name={name!r}, found {len(matches)}")
        selected = matches[0]
    defaults = matrix.get("defaults") if isinstance(matrix.get("defaults"), dict) else {}
    return {**defaults, **selected}


def tool_name(tool: dict[str, Any]) -> str | None:
    fn = tool.get("function") if isinstance(tool, dict) else None
    return fn.get("name") if isinstance(fn, dict) and isinstance(fn.get("name"), str) else None


def force_tool(name: str) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name}}


def clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def base_request(mv: Any, fixture: dict[str, Any], model: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    request = fixture.get("request")
    if not isinstance(request, dict):
        raise RuntimeError("fixture request missing")
    messages = mv.normalize_messages(request.get("system"), request.get("messages"))
    tools = mv.normalize_tools(request.get("tools"))
    return messages, tools


def common_body(
    model: dict[str, Any],
    *,
    messages: list[dict[str, Any]],
    max_tokens: int,
    cache_prompt: bool,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "messages": clone(messages),
        "stream": True,
        "stream_options": {"include_usage": True},
        "cache_prompt": bool(cache_prompt),
        "temperature": model.get("temperature", 0.0),
        "max_tokens": max_tokens,
    }
    model_id = model.get("model")
    if isinstance(model_id, str) and model_id:
        body["model"] = model_id
    if isinstance(model.get("id_slot"), int):
        body["id_slot"] = model["id_slot"]
    return body


def build_probe(
    mv: Any,
    fixture: dict[str, Any],
    spec: dict[str, Any],
    model: dict[str, Any],
    probe: str,
    *,
    cache_prompt: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    messages, current_tools = base_request(mv, fixture, model)
    meta: dict[str, Any] = {
        "probe": probe,
        "mapping": {},
        "cache_prompt_requested": bool(cache_prompt),
    }

    if probe == "p0_minimal_decode":
        body = common_body(model, messages=[{"role": "user", "content": "Reply exactly OK."}], max_tokens=8, cache_prompt=cache_prompt)
        return body, meta

    if probe == "p1_exact_prompt_no_tools":
        body = common_body(model, messages=messages, max_tokens=8, cache_prompt=cache_prompt)
        return body, meta

    if probe == "p2_exact_tools_auto":
        body = common_body(model, messages=messages, max_tokens=16, cache_prompt=cache_prompt)
        body["tools"] = clone(current_tools)
        body["tool_choice"] = "auto"
        return body, meta

    if probe == "p3_current_forced_short":
        current_name = spec.get("current_tool_name")
        if not isinstance(current_name, str) or not current_name:
            raise RuntimeError("current_tool_name missing")
        names = [tool_name(row) for row in current_tools]
        if current_name not in names:
            raise RuntimeError(f"current tool {current_name!r} absent from fixture tools={names}")
        body = common_body(model, messages=messages, max_tokens=48, cache_prompt=cache_prompt)
        body["tools"] = clone(current_tools)
        body["tool_choice"] = force_tool(current_name)
        meta["expected_tool"] = current_name
        return body, meta

    if probe == "p4_constrained_forced_short":
        constrained, mapping = mv.constrained_tool(spec)
        instruction = mv.constrained_instruction(spec, mapping)
        body = common_body(
            model,
            messages=[*messages, {"role": "system", "content": instruction}],
            max_tokens=48,
            cache_prompt=cache_prompt,
        )
        body["tools"] = [clone(constrained)]
        body["tool_choice"] = force_tool(constrained["function"]["name"])
        meta["expected_tool"] = constrained["function"]["name"]
        meta["mapping"] = mapping
        return body, meta

    raise RuntimeError(f"unsupported probe {probe!r}")


def turn_split_tool(spec: dict[str, Any]) -> dict[str, Any]:
    obligations = spec.get("obligations")
    if not isinstance(obligations, list) or not obligations:
        raise RuntimeError("turn split requires obligations")
    ids = []
    for row in obligations:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise RuntimeError("invalid obligation in spec")
        ids.append(row["id"])
    return {
        "type": "function",
        "function": {
            "name": "submit_one_required_operation_content",
            "description": (
                "Benchmark-only Turn-Splitting ablation. Fill exactly one deterministic obligation. "
                "The orchestrator fixes obligation order, slot and operation kind."
            ),
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "obligation": {"type": "string", "enum": ids},
                    "content": {"type": "string", "minLength": 1},
                    "before": {"type": "string", "minLength": 1},
                    "after": {"type": "string", "minLength": 1},
                },
                "required": ["obligation"],
            },
        },
    }


def obligation_instruction(obligation: dict[str, Any], index: int, total: int) -> str:
    fields = obligation.get("constrained_fields")
    if not isinstance(fields, list) or not fields:
        fields = ["content"]
    return (
        f"TURN_SPLIT_ABLATION stage={index}/{total}. "
        f"Synthesize ONLY obligation={obligation.get('id')} "
        f"slot={obligation.get('slot')} operation={obligation.get('operation')}. "
        f"Required fields={','.join(str(x) for x in fields)}. "
        "Call submit_one_required_operation_content exactly once. "
        "Do not synthesize any other obligation."
    )


def validate_turn_split_args(args: Any, obligation: dict[str, Any]) -> tuple[bool, list[str]]:
    if not isinstance(args, dict):
        return False, ["arguments_not_object"]
    missing: list[str] = []
    if args.get("obligation") != obligation.get("id"):
        missing.append("obligation")
    fields = obligation.get("constrained_fields")
    if not isinstance(fields, list) or not fields:
        fields = ["content"]
    for field_name in fields:
        value = args.get(field_name)
        if not isinstance(value, str) or not value.strip():
            missing.append(str(field_name))
    return not missing, missing


@dataclass
class StreamState:
    started_monotonic: float
    headers_ms: float | None = None
    first_event_ms: float | None = None
    ttft_ms: float | None = None
    first_tool_delta_ms: float | None = None
    finish_reason: str | None = None
    done_marker: bool = False
    usage: dict[str, Any] | None = None
    timings: dict[str, Any] | None = None
    chunks: int = 0
    semantic_deltas: int = 0
    text_chars: int = 0
    tool_name: str | None = None
    tool_call_id: str | None = None
    tool_argument_text: str = ""
    raw_tail: list[dict[str, Any]] = field(default_factory=list)

    def observe(self, event: dict[str, Any]) -> None:
        now = time.monotonic()
        elapsed_ms = round((now - self.started_monotonic) * 1000, 3)
        self.chunks += 1
        if self.first_event_ms is None:
            self.first_event_ms = elapsed_ms
        if isinstance(event.get("usage"), dict):
            self.usage = event["usage"]
        if isinstance(event.get("timings"), dict):
            self.timings = event["timings"]
        choices = event.get("choices")
        if isinstance(choices, list) and choices:
            choice = choices[0] if isinstance(choices[0], dict) else {}
            if isinstance(choice.get("finish_reason"), str):
                self.finish_reason = choice["finish_reason"]
            delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
            content = delta.get("content")
            tool_calls = delta.get("tool_calls")
            semantic = False
            if isinstance(content, str) and content:
                semantic = True
                self.text_chars += len(content)
            if isinstance(tool_calls, list) and tool_calls:
                semantic = True
                if self.first_tool_delta_ms is None:
                    self.first_tool_delta_ms = elapsed_ms
                for call in tool_calls:
                    if not isinstance(call, dict):
                        continue
                    if isinstance(call.get("id"), str):
                        self.tool_call_id = call["id"]
                    function = call.get("function") if isinstance(call.get("function"), dict) else {}
                    if isinstance(function.get("name"), str) and function["name"]:
                        self.tool_name = function["name"]
                    if isinstance(function.get("arguments"), str):
                        self.tool_argument_text += function["arguments"]
            if semantic:
                self.semantic_deltas += 1
                if self.ttft_ms is None:
                    self.ttft_ms = elapsed_ms
        self.raw_tail.append(event)
        if len(self.raw_tail) > 4:
            self.raw_tail.pop(0)

    def parsed_tool_args(self) -> Any:
        if not self.tool_argument_text:
            return None
        try:
            return json.loads(self.tool_argument_text)
        except Exception:
            return None


class StreamingRequest:
    def __init__(self, url: str, body: dict[str, Any], timeout_s: float) -> None:
        self.url = url
        self.body = body
        self.timeout_s = timeout_s
        self.state = StreamState(time.monotonic())
        self.error: str | None = None
        self.http_status: int | None = None
        self.completed = False
        self.timed_out = False
        self._conn: http.client.HTTPConnection | http.client.HTTPSConnection | None = None
        self._thread: threading.Thread | None = None
        self._done = threading.Event()

    def _run(self) -> None:
        parsed = urlparse(self.url)
        if parsed.scheme not in {"http", "https"}:
            self.error = f"unsupported_url_scheme:{parsed.scheme}"
            self._done.set()
            return
        host = parsed.hostname
        if not host:
            self.error = "url_host_missing"
            self._done.set()
            return
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        conn_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(host, port, timeout=max(1.0, self.timeout_s + 2.0))
        self._conn = conn
        payload = json.dumps(self.body, ensure_ascii=False).encode("utf-8")
        try:
            conn.request("POST", path, body=payload, headers={"Content-Type": "application/json", "Accept": "text/event-stream"})
            response = conn.getresponse()
            self.http_status = response.status
            self.state.headers_ms = round((time.monotonic() - self.state.started_monotonic) * 1000, 3)
            if response.status < 200 or response.status >= 300:
                data = response.read(8192).decode("utf-8", errors="replace")
                self.error = f"http_{response.status}:{data[-2000:]}"
                return
            while True:
                raw = response.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":") or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    self.state.done_marker = True
                    self.completed = True
                    break
                try:
                    event = json.loads(data)
                except Exception:
                    continue
                if isinstance(event, dict):
                    self.state.observe(event)
                    if self.state.finish_reason is not None:
                        # Continue briefly for usage/timings until [DONE].
                        continue
            if self.state.done_marker or self.state.finish_reason is not None:
                self.completed = True
        except Exception as exc:
            if not self.timed_out:
                self.error = f"{type(exc).__name__}:{exc}"
        finally:
            try:
                conn.close()
            except Exception:
                pass
            self._done.set()

    def execute(self) -> dict[str, Any]:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

        deadline = self.state.started_monotonic + self.timeout_s
        live_slot_samples: list[dict[str, Any]] = []
        poll_interval_s = 0.5
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if self._done.wait(min(poll_interval_s, remaining)):
                break
            elapsed_ms = (time.monotonic() - self.state.started_monotonic) * 1000
            snap = get_slots(self.url, timeout_s=min(0.35, max(0.1, remaining)))
            live_slot_samples.append(compact_live_slot_snapshot(snap, elapsed_ms))
            if len(live_slot_samples) > 80:
                live_slot_samples.pop(0)

        if not self._done.is_set():
            self.timed_out = True
            try:
                if self._conn is not None:
                    self._conn.close()
            except Exception:
                pass
            self._done.wait(2.0)

        wall_s = round(time.monotonic() - self.state.started_monotonic, 3)
        parsed_args = self.state.parsed_tool_args()
        server_progress = summarize_live_slot_progress(live_slot_samples)
        if self.completed:
            stage = "complete"
        elif self.state.first_tool_delta_ms is not None:
            stage = "tool_args_decode"
        elif self.state.ttft_ms is not None:
            stage = "decode_before_tool"
        elif self.state.headers_ms is not None:
            progress_stage = server_progress.get("stage")
            stage = (
                progress_stage
                if isinstance(progress_stage, str) and progress_stage != "server_processing_not_observed"
                else "post_headers_pre_first_token"
            )
        else:
            stage = "pre_headers_or_prefill"
        worker_alive = self._thread.is_alive() if self._thread is not None else False
        return {
            "status": "complete" if self.completed else "timeout" if self.timed_out else "error",
            "stage_at_end": stage,
            "wall_s": wall_s,
            "http_status": self.http_status,
            "error": self.error,
            "worker_alive_after_abort_wait": worker_alive,
            "headers_ms": self.state.headers_ms,
            "first_event_ms": self.state.first_event_ms,
            "ttft_ms": self.state.ttft_ms,
            "first_tool_delta_ms": self.state.first_tool_delta_ms,
            "finish_reason": self.state.finish_reason,
            "done_marker": self.state.done_marker,
            "chunks": self.state.chunks,
            "semantic_deltas": self.state.semantic_deltas,
            "text_chars": self.state.text_chars,
            "tool_name": self.state.tool_name,
            "tool_call_id": self.state.tool_call_id,
            "tool_argument_chars": len(self.state.tool_argument_text),
            "tool_argument_sha256": hashlib.sha256(self.state.tool_argument_text.encode("utf-8")).hexdigest() if self.state.tool_argument_text else None,
            "tool_argument_prefix": self.state.tool_argument_text[:512] if self.state.tool_argument_text else None,
            "tool_argument_suffix": self.state.tool_argument_text[-512:] if self.state.tool_argument_text else None,
            "tool_arguments_parsed": isinstance(parsed_args, dict),
            "tool_arguments": parsed_args if isinstance(parsed_args, dict) else None,
            "usage": self.state.usage,
            "timings": self.state.timings,
            "raw_tail": self.state.raw_tail,
            "live_slot_samples": live_slot_samples,
            "server_progress": server_progress,
        }


def slots_url(chat_url: str) -> str:
    parsed = urlparse(chat_url)
    port = f":{parsed.port}" if parsed.port is not None else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}/slots"


def get_slots(chat_url: str, timeout_s: float = 1.25) -> dict[str, Any]:
    url = slots_url(chat_url)
    started = time.monotonic()
    try:
        req = Request(url, method="GET", headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout_s) as response:
            data = response.read(262144)
        parsed = json.loads(data.decode("utf-8", errors="replace"))
        return {
            "status": "ok",
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            "slots": parsed,
        }
    except Exception as exc:
        return {
            "status": "unavailable",
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            "error": f"{type(exc).__name__}:{exc}",
        }


def slots_idle(snapshot: dict[str, Any]) -> bool:
    if snapshot.get("status") != "ok":
        return False
    rows = snapshot.get("slots")
    if not isinstance(rows, list) or not rows or not all(isinstance(row, dict) for row in rows):
        return False
    return all(not bool(row.get("is_processing")) for row in rows)


def compact_live_slot_snapshot(snapshot: dict[str, Any], elapsed_ms: float) -> dict[str, Any]:
    rows = snapshot.get("slots") if snapshot.get("status") == "ok" else None
    compact: list[dict[str, Any]] = []
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            next_token = row.get("next_token")
            decoded = None
            if isinstance(next_token, list) and next_token and isinstance(next_token[0], dict):
                value = next_token[0].get("n_decoded")
                decoded = int(value) if isinstance(value, int) else None
            generated = row.get("generated")
            compact.append({
                "id": row.get("id"),
                "id_task": row.get("id_task"),
                "is_processing": bool(row.get("is_processing")),
                "n_prompt_tokens": row.get("n_prompt_tokens"),
                "n_prompt_tokens_processed": row.get("n_prompt_tokens_processed"),
                "n_prompt_tokens_cache": row.get("n_prompt_tokens_cache"),
                "n_decoded": decoded,
                "generated_chars": len(generated) if isinstance(generated, str) else 0,
            })
    return {
        "elapsed_ms": round(elapsed_ms, 3),
        "status": snapshot.get("status"),
        "slots": compact,
    }


def summarize_live_slot_progress(samples: list[dict[str, Any]]) -> dict[str, Any]:
    processing: list[tuple[float, dict[str, Any]]] = []
    for sample in samples:
        elapsed = sample.get("elapsed_ms")
        rows = sample.get("slots")
        if not isinstance(elapsed, (int, float)) or not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and row.get("is_processing") is True:
                processing.append((float(elapsed), row))

    if not processing:
        return {
            "stage": "server_processing_not_observed",
            "observed_processing": False,
            "sample_count": len(samples),
            "processing_sample_count": 0,
            "first_processing_ms": None,
            "first_prompt_progress_ms": None,
            "first_decode_progress_ms": None,
            "max_prompt_tokens": 0,
            "max_prompt_tokens_processed": 0,
            "max_prompt_tokens_cache": 0,
            "max_decoded": 0,
            "max_generated_chars": 0,
            "task_ids": [],
        }

    def integer(row: dict[str, Any], key: str) -> int:
        value = row.get(key)
        return value if isinstance(value, int) and value >= 0 else 0

    first_processing_ms = min(elapsed for elapsed, _ in processing)
    prompt_progress = [
        elapsed for elapsed, row in processing
        if integer(row, "n_prompt_tokens_processed") > 0 or integer(row, "n_prompt_tokens_cache") > 0
    ]
    decode_progress = [
        elapsed for elapsed, row in processing
        if integer(row, "n_decoded") > 0 or integer(row, "generated_chars") > 0
    ]
    max_prompt_tokens = max(integer(row, "n_prompt_tokens") for _, row in processing)
    max_prompt_processed = max(integer(row, "n_prompt_tokens_processed") for _, row in processing)
    max_prompt_cache = max(integer(row, "n_prompt_tokens_cache") for _, row in processing)
    max_decoded = max(integer(row, "n_decoded") for _, row in processing)
    max_generated = max(integer(row, "generated_chars") for _, row in processing)

    if max_decoded > 0 or max_generated > 0:
        stage = "server_decode_before_stream_event"
    elif max_prompt_processed > 0 or max_prompt_cache > 0:
        stage = "server_prompt_progress_before_first_token"
    elif max_prompt_tokens > 0:
        stage = "server_processing_no_prompt_progress_observed"
    else:
        stage = "server_processing_without_token_metadata"

    return {
        "stage": stage,
        "observed_processing": True,
        "sample_count": len(samples),
        "processing_sample_count": len(processing),
        "first_processing_ms": round(first_processing_ms, 3),
        "first_prompt_progress_ms": round(min(prompt_progress), 3) if prompt_progress else None,
        "first_decode_progress_ms": round(min(decode_progress), 3) if decode_progress else None,
        "max_prompt_tokens": max_prompt_tokens,
        "max_prompt_tokens_processed": max_prompt_processed,
        "max_prompt_tokens_cache": max_prompt_cache,
        "max_decoded": max_decoded,
        "max_generated_chars": max_generated,
        "task_ids": sorted({
            row.get("id_task") for _, row in processing
            if isinstance(row.get("id_task"), int)
        }),
    }


def wait_server_idle(chat_url: str, timeout_s: float = 5.0) -> dict[str, Any]:
    started = time.monotonic()
    attempts: list[dict[str, Any]] = []
    while time.monotonic() - started < timeout_s:
        snap = get_slots(chat_url, timeout_s=min(0.75, max(0.1, timeout_s - (time.monotonic() - started))))
        attempts.append({
            "status": snap.get("status"),
            "elapsed_ms": snap.get("elapsed_ms"),
            "idle": slots_idle(snap),
        })
        if slots_idle(snap):
            return {
                "status": "idle_confirmed",
                "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                "attempts": attempts,
                "snapshot": snap,
            }
        time.sleep(0.1)
    return {
        "status": "idle_unconfirmed",
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        "attempts": attempts,
    }


def run_probe(url: str, body: dict[str, Any], budget_s: float, label: str) -> dict[str, Any]:
    print(f"RUN probe={label} budget_s={budget_s:g}", flush=True)
    result = StreamingRequest(url, body, budget_s).execute()
    if result.get("status") == "timeout":
        result["cancellation_barrier"] = wait_server_idle(url)
    else:
        result["cancellation_barrier"] = {"status": "not_required"}
    result["probe"] = label
    result["budget_s"] = budget_s
    result["request_sha256"] = sha256_json(body)
    print(
        "RESULT "
        f"probe={label} status={result['status']} stage={result['stage_at_end']} "
        f"wall_s={result['wall_s']} ttft_ms={result['ttft_ms']} "
        f"tool_ms={result['first_tool_delta_ms']}",
        flush=True,
    )
    return result


def load_baseline(path: Path | None, fixture_sha: str, model_name: str) -> dict[str, Any] | None:
    if path is None or not path.is_file():
        return None
    data = read_json(path)
    if not isinstance(data, dict):
        return None
    if data.get("fixture_request_sha256") != fixture_sha:
        raise RuntimeError(
            "baseline summary fixture mismatch: "
            f"summary={data.get('fixture_request_sha256')} fixture={fixture_sha}"
        )
    groups = data.get("groups")
    if not isinstance(groups, list):
        return None
    selected = [row for row in groups if isinstance(row, dict) and row.get("model_name") == model_name]
    if not selected:
        return None
    by_abi = {row.get("abi"): row for row in selected if isinstance(row.get("abi"), str)}
    return {
        "protocol": data.get("protocol"),
        "path": str(path),
        "fixture_request_sha256": data.get("fixture_request_sha256"),
        "current": by_abi.get("current"),
        "constrained": by_abi.get("constrained"),
        "source_ablation_signal": data.get("ablation_signal"),
    }


def append_turn(messages: list[dict[str, Any]], result: dict[str, Any], tool: dict[str, Any], stage_index: int, obligation_id: str) -> None:
    call_id = result.get("tool_call_id")
    if not isinstance(call_id, str) or not call_id:
        call_id = f"turn_split_{stage_index}"
    args = result.get("tool_arguments")
    arguments = json.dumps(args if isinstance(args, dict) else {}, ensure_ascii=False, separators=(",", ":"))
    name = tool["function"]["name"]
    messages.append({
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": call_id,
            "type": "function",
            "function": {"name": name, "arguments": arguments},
        }],
    })
    messages.append({
        "role": "tool",
        "tool_call_id": call_id,
        "name": name,
        "content": f"ACCEPTED obligation={obligation_id}",
    })


def run_turn_split(
    mv: Any,
    fixture: dict[str, Any],
    spec: dict[str, Any],
    model: dict[str, Any],
    *,
    total_budget_s: float,
    max_tokens_per_turn: int,
) -> dict[str, Any]:
    base_messages, _ = base_request(mv, fixture, model)
    tool = turn_split_tool(spec)
    tool_name_value = tool["function"]["name"]
    obligations = spec.get("obligations")
    assert isinstance(obligations, list)
    messages = [
        *base_messages,
        {
            "role": "system",
            "content": (
                "TURN_SPLIT_ABLATION_ONLY. Mutation topology is deterministic and fixed. "
                "Each following turn requests exactly one obligation. Never synthesize future obligations."
            ),
        },
    ]
    started = time.monotonic()
    stages: list[dict[str, Any]] = []
    accepted: list[str] = []
    for index, obligation in enumerate(obligations, 1):
        if not isinstance(obligation, dict):
            raise RuntimeError("invalid obligation")
        elapsed = time.monotonic() - started
        remaining = total_budget_s - elapsed
        if remaining <= 0:
            break
        oid = obligation.get("id")
        messages.append({"role": "user", "content": obligation_instruction(obligation, index, len(obligations))})
        body = common_body(
            model,
            messages=messages,
            max_tokens=max_tokens_per_turn,
            cache_prompt=True,
        )
        body["tools"] = [clone(tool)]
        body["tool_choice"] = force_tool(tool_name_value)
        result = run_probe(model["url"], body, remaining, f"ts{index}_{oid}")
        valid, missing = validate_turn_split_args(result.get("tool_arguments"), obligation)
        result["obligation"] = oid
        result["valid_obligation"] = valid
        result["missing_fields"] = missing
        stages.append(result)
        if not valid:
            break
        accepted.append(str(oid))
        append_turn(messages, result, tool, index, str(oid))
    wall_s = round(time.monotonic() - started, 3)
    complete = len(accepted) == len(obligations)
    return {
        "protocol": TURN_SPLIT_PROTOCOL,
        "global_budget_s": total_budget_s,
        "wall_s": wall_s,
        "max_tokens_per_turn": max_tokens_per_turn,
        "cache_prompt": True,
        "cache_policy": "forced_on_for_prefix_reuse",
        "shared_wall_budget": True,
        "stages": stages,
        "accepted_obligations": accepted,
        "required_obligations": [row.get("id") for row in obligations if isinstance(row, dict)],
        "valid_candidate_within_budget": complete and wall_s <= total_budget_s,
    }


def reported_cached_tokens(row: dict[str, Any]) -> int | None:
    usage = row.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("prompt_tokens_details")
    if not isinstance(details, dict):
        return None
    value = details.get("cached_tokens")
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    return None


def first_delta_ok(row: dict[str, Any] | None) -> bool:
    return isinstance(row, dict) and isinstance(row.get("ttft_ms"), (int, float))


def infer_signals(probes: dict[str, dict[str, Any]], baseline: dict[str, Any] | None, turn_split: dict[str, Any] | None) -> list[str]:
    signals: list[str] = []
    p0 = probes.get("p0_minimal_decode")
    p1 = probes.get("p1_exact_prompt_no_tools")
    p2 = probes.get("p2_exact_tools_auto")
    p3 = probes.get("p3_current_forced_short")
    p4 = probes.get("p4_constrained_forced_short")

    if p0 and not first_delta_ok(p0):
        progress = p0.get("server_progress") if isinstance(p0.get("server_progress"), dict) else {}
        stage = progress.get("stage")
        if stage == "server_decode_before_stream_event":
            signals.append("P0_SERVER_DECODE_WITHOUT_STREAM_EVENT")
        elif stage == "server_prompt_progress_before_first_token":
            signals.append("P0_PROMPT_OR_FIRST_DECODE_TOO_SLOW")
        elif stage == "server_processing_no_prompt_progress_observed":
            signals.append("P0_PROMPT_EVAL_NO_PROGRESS_OBSERVED")
        elif stage == "server_processing_not_observed":
            signals.append("P0_SCHEDULER_OR_SLOT_DISPATCH_UNRESOLVED")
        else:
            signals.append("P0_PRE_FIRST_TOKEN_UNRESOLVED")
        return signals
    if first_delta_ok(p0) and p1 and not first_delta_ok(p1):
        signals.append("EXACT_PROMPT_PREFILL_OR_CONTEXT_UNVIABLE")
    if first_delta_ok(p1) and p2 and not first_delta_ok(p2):
        signals.append("TOOL_SURFACE_OR_TOOL_REASONING_UNVIABLE")
    if p3 and p4 and not first_delta_ok(p3) and first_delta_ok(p4):
        signals.append("CURRENT_TOOL_SCHEMA_COMPLEXITY_SUPPORTED")
    if first_delta_ok(p4) and baseline:
        constrained = baseline.get("constrained")
        if isinstance(constrained, dict) and constrained.get("completed_runs") == 0:
            signals.append("MONOLITHIC_ARGUMENT_SYNTHESIS_CENSORED")
    if turn_split:
        if turn_split.get("valid_candidate_within_budget") is True:
            signals.append("TURN_SPLITTING_SUPPORTED_WITH_SHARED_BUDGET")
        elif first_delta_ok(p4):
            signals.append("TURN_SPLITTING_NOT_YET_SUPPORTED")
    if not signals:
        signals.append("INFERENCE_PATH_UNRESOLVED")
    return signals


def should_continue_after(probe: str, result: dict[str, Any]) -> bool:
    barrier = result.get("cancellation_barrier")
    if result.get("status") == "timeout":
        if not isinstance(barrier, dict) or barrier.get("status") != "idle_confirmed":
            return False
    # Fail-fast only when no semantic delta appears. A completed or partially
    # decoding response carries evidence for the next narrower probe.
    if probe == "p0_minimal_decode" and result.get("ttft_ms") is None:
        return False
    if probe == "p1_exact_prompt_no_tools" and result.get("ttft_ms") is None:
        return False
    return True


def run_ladder(args: argparse.Namespace) -> int:
    mv = load_model_viability(Path(args.model_viability).resolve())
    fixture_path = Path(args.fixture).resolve()
    spec_path = Path(args.spec).resolve()
    models_path = Path(args.models).resolve()
    fixture = read_json(fixture_path)
    spec = read_json(spec_path)
    matrix = read_json(models_path)
    if not isinstance(fixture, dict) or not isinstance(spec, dict) or not isinstance(matrix, dict):
        raise RuntimeError("fixture/spec/models must be JSON objects")
    model = model_by_name(matrix, args.model_name)
    model_name = model.get("name")
    url = model.get("url")
    if not isinstance(model_name, str) or not model_name:
        raise RuntimeError("model name missing")
    if not isinstance(url, str) or not url:
        raise RuntimeError("model url missing")

    expected_task_sha = spec.get("expected_task_text_sha256")
    observed_task_sha = fixture.get("source", {}).get("task_text_sha256") if isinstance(fixture.get("source"), dict) else None
    if expected_task_sha != observed_task_sha:
        raise RuntimeError(f"task identity mismatch expected={expected_task_sha} observed={observed_task_sha}")

    fixture_sha = fixture.get("request_sha256")
    if not isinstance(fixture_sha, str) or len(fixture_sha) != 64:
        raise RuntimeError("fixture request SHA missing")

    baseline_path = Path(args.baseline_summary).resolve() if args.baseline_summary else None
    baseline = load_baseline(baseline_path, fixture_sha, model_name)

    budgets = {
        "p0_minimal_decode": float(args.p0_budget_s),
        "p1_exact_prompt_no_tools": float(args.p1_budget_s),
        "p2_exact_tools_auto": float(args.p2_budget_s),
        "p3_current_forced_short": float(args.p3_budget_s),
        "p4_constrained_forced_short": float(args.p4_budget_s),
    }
    if any(value <= 0 for value in budgets.values()):
        raise RuntimeError("all probe budgets must be > 0")

    probe_cache_prompt = args.probe_cache_prompt == "on"

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    print(f"FIXTURE sha256={fixture_sha} model={model_name}")
    if baseline:
        print(f"REUSE baseline={baseline['path']}")

    pre_slots = get_slots(url)
    probes: dict[str, dict[str, Any]] = {}
    order = list(budgets)
    for probe in order:
        body, meta = build_probe(
            mv,
            fixture,
            spec,
            model,
            probe,
            cache_prompt=probe_cache_prompt,
        )
        result = run_probe(url, body, budgets[probe], probe)
        result["cache_prompt_requested"] = bool(body.get("cache_prompt"))
        result["reported_cached_tokens"] = reported_cached_tokens(result)
        result["meta"] = meta
        probes[probe] = result
        write_json(out / f"{probe}.json", result)
        if args.stop_after == probe:
            break
        if not should_continue_after(probe, result):
            break

    turn_split: dict[str, Any] | None = None
    p1 = probes.get("p1_exact_prompt_no_tools")
    run_ts = args.turn_splitting != "off"
    if run_ts and first_delta_ok(p1):
        turn_split = run_turn_split(
            mv,
            fixture,
            spec,
            model,
            total_budget_s=float(args.turn_split_budget_s),
            max_tokens_per_turn=int(args.turn_split_max_tokens),
        )
        write_json(out / "turn-splitting.json", turn_split)
    elif run_ts:
        turn_split = {
            "protocol": TURN_SPLIT_PROTOCOL,
            "skipped": True,
            "reason": "exact_prompt_probe_has_no_first_delta",
            "valid_candidate_within_budget": False,
        }
        write_json(out / "turn-splitting.json", turn_split)

    post_slots = get_slots(url)
    signals = infer_signals(probes, baseline, turn_split)
    summary = {
        "protocol": PROTOCOL,
        "fixture_request_sha256": fixture_sha,
        "task_text_sha256": observed_task_sha,
        "model_name": model_name,
        "model": model.get("model"),
        "url": url,
        "probe_budgets_s": budgets,
        "probe_cache_prompt_requested": probe_cache_prompt,
        "probe_cache_policy": "on" if probe_cache_prompt else "off",
        "stop_after": args.stop_after,
        "probes": probes,
        "baseline_reuse": baseline,
        "turn_splitting": turn_split,
        "slots_before": pre_slots,
        "slots_after": post_slots,
        "signals": signals,
        "decision": signals[0],
        "product_source_mutated": False,
        "pass_metric": "CAUSE_LOCALIZED_WITHOUT_FALSE_MODEL_CLAIM",
    }
    write_json(out / "summary.json", summary)
    print("\n=== INFERENCE VIABILITY LADDER ===")
    for probe, row in probes.items():
        print(
            f"{probe:30} status={row['status']:8} stage={row['stage_at_end']:28} "
            f"ttft_ms={row['ttft_ms']} tool_ms={row['first_tool_delta_ms']} "
            f"cache={row.get('cache_prompt_requested')} cached_tokens={row.get('reported_cached_tokens')}"
        )
    if turn_split:
        print(
            "turn_splitting                 "
            f"valid={turn_split.get('valid_candidate_within_budget')} "
            f"wall_s={turn_split.get('wall_s')}"
        )
    print("SIGNALS", ",".join(signals))
    print("SUMMARY", out / "summary.json")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bounded causal inference ladder for captured coding-agent requests")
    parser.add_argument("--model-viability", default=str(DEFAULT_MODEL_VIABILITY))
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--fixture", required=True)
    run.add_argument("--spec", required=True)
    run.add_argument("--models", required=True)
    run.add_argument("--model-name")
    run.add_argument("--baseline-summary")
    run.add_argument("--out", required=True)
    run.add_argument("--p0-budget-s", type=float, default=15)
    run.add_argument("--p1-budget-s", type=float, default=30)
    run.add_argument("--p2-budget-s", type=float, default=30)
    run.add_argument("--p3-budget-s", type=float, default=45)
    run.add_argument("--p4-budget-s", type=float, default=45)
    run.add_argument(
        "--probe-cache-prompt",
        choices=["off", "on"],
        default="off",
        help=(
            "Request-level llama-server cache_prompt policy for P0-P4. "
            "Default off for causal cold-prefill diagnostics; Turn-Splitting always uses on."
        ),
    )
    run.add_argument(
        "--stop-after",
        choices=[
            "p0_minimal_decode",
            "p1_exact_prompt_no_tools",
            "p2_exact_tools_auto",
            "p3_current_forced_short",
            "p4_constrained_forced_short",
        ],
    )
    run.add_argument("--turn-splitting", choices=["on", "off"], default="on")
    run.add_argument("--turn-split-budget-s", type=float, default=90)
    run.add_argument("--turn-split-max-tokens", type=int, default=512)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "run":
            return run_ladder(args)
        raise RuntimeError(f"unsupported command {args.command}")
    except Exception as exc:
        print(f"FAIL {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
