#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import sys


ROOT = Path(__file__).resolve().parent
LADDER = ROOT / "v2.28-inference-viability-ladder.py"
MV = ROOT / "v2.28-model-viability.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sse(handler: BaseHTTPRequestHandler, events: list[dict], *, done: bool = True) -> None:
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.end_headers()
    for event in events:
        handler.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        handler.wfile.flush()
    if done:
        handler.wfile.write(b"data: [DONE]\n\n")
        handler.wfile.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    request_bodies: list[dict] = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/slots":
            body = json.dumps([{"id": 0, "is_processing": False, "n_decoded": 0}]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length))
        type(self).request_bodies.append(body)
        messages = body.get("messages") or []
        tools = body.get("tools") or []
        tool_choice = body.get("tool_choice")

        if not tools:
            sse(self, [
                {"choices": [{"delta": {"content": "OK"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 1}, "timings": {"prompt_ms": 5.0, "predicted_ms": 2.0}},
            ])
            return

        fn = tools[0].get("function", {})
        name = fn.get("name")
        args = {}
        if name == "execute_additive_plan":
            args = {"python_declarations": [], "replacements": [], "creations": []}
        elif name == "submit_required_operation_content":
            args = {"server_surface": {"content": "x"}, "navigation_integration": {"before": "a", "after": "b"}, "ui_surface": {"content": "y"}}
        elif name == "submit_one_required_operation_content":
            last = messages[-1].get("content", "") if messages else ""
            if "server_surface" in last:
                args = {"obligation": "server_surface", "content": "route"}
            elif "navigation_integration" in last:
                args = {"obligation": "navigation_integration", "before": "old", "after": "new"}
            else:
                args = {"obligation": "ui_surface", "content": "ui"}
        else:
            args = {"ok": True}

        arg_text = json.dumps(args, separators=(",", ":"))
        cut = max(1, len(arg_text) // 2)
        sse(self, [
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": name, "arguments": arg_text[:cut]}}]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": arg_text[cut:]}}]}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 20, "completion_tokens": 8}, "timings": {"prompt_ms": 6.0, "predicted_ms": 4.0}},
        ])


def main() -> int:
    ladder = load(LADDER, "ladder")
    mv = load(MV, "mv")

    raw_request = {
        "system": ["bounded-system"],
        "messages": [{"role": "user", "content": "perform synthetic task"}],
        "tools": {
            "execute_additive_plan": {
                "description": "bounded plan",
                "input": {
                    "type": "object",
                    "properties": {
                        "python_declarations": {"type": "array"},
                        "replacements": {"type": "array"},
                        "creations": {"type": "array"},
                    },
                },
            },
        },
    }
    task_sha = "a" * 64
    fixture = {
        "protocol": mv.FIXTURE_PROTOCOL,
        "source": {"task_text_sha256": task_sha},
        "request_sha256": mv.sha256_json(raw_request),
        "request": raw_request,
    }
    ablation = {
        "protocol": mv.SPEC_PROTOCOL,
        "task_id": "synthetic",
        "expected_task_text_sha256": task_sha,
        "current_tool_name": "execute_additive_plan",
        "constrained_tool_name": "submit_required_operation_content",
        "obligations": [
            {"id": "server_surface", "family": "python_declarations", "slot": "existing:0", "operation": "python_declaration", "constrained_fields": ["content"]},
            {"id": "navigation_integration", "family": "replacements", "slot": "existing:1", "operation": "replacement", "constrained_fields": ["before", "after"]},
            {"id": "ui_surface", "family": "creations", "slot": "create:0", "operation": "creation", "constrained_fields": ["content"]},
        ],
    }

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/v1/chat/completions"
        model = {"name": "synthetic", "url": url, "model": "synthetic", "temperature": 0.0}
        p0, p0_meta = ladder.build_probe(
            mv, fixture, ablation, model, "p0_minimal_decode", cache_prompt=False
        )
        assert p0["cache_prompt"] is False
        assert p0_meta["cache_prompt_requested"] is False
        p0_warm, p0_warm_meta = ladder.build_probe(
            mv, fixture, ablation, model, "p0_minimal_decode", cache_prompt=True
        )
        assert p0_warm["cache_prompt"] is True
        assert p0_warm_meta["cache_prompt_requested"] is True
        r0 = ladder.run_probe(url, p0, 2.0, "gate_p0")
        assert r0["status"] == "complete"
        assert r0["ttft_ms"] is not None

        p3, _ = ladder.build_probe(
            mv, fixture, ablation, model, "p3_current_forced_short", cache_prompt=False
        )
        assert p3["cache_prompt"] is False
        r3 = ladder.run_probe(url, p3, 2.0, "gate_p3")
        assert r3["status"] == "complete"
        assert r3["first_tool_delta_ms"] is not None
        assert r3["tool_name"] == "execute_additive_plan"
        assert r3["tool_arguments_parsed"] is True

        ts_start = len(Handler.request_bodies)
        ts = ladder.run_turn_split(mv, fixture, ablation, model, total_budget_s=5.0, max_tokens_per_turn=64)
        ts_requests = Handler.request_bodies[ts_start:]
        assert ts_requests and all(row.get("cache_prompt") is True for row in ts_requests)
        assert ts["valid_candidate_within_budget"] is True
        assert ts["accepted_obligations"] == ["server_surface", "navigation_integration", "ui_surface"]
        assert ts["shared_wall_budget"] is True
        assert ts["cache_prompt"] is True
        assert ts["cache_policy"] == "forced_on_for_prefix_reuse"

        assert ladder.reported_cached_tokens({
            "usage": {"prompt_tokens_details": {"cached_tokens": 7}}
        }) == 7
        assert ladder.reported_cached_tokens({"usage": {}}) is None

        signals = ladder.infer_signals(
            {
                "p0_minimal_decode": r0,
                "p1_exact_prompt_no_tools": r0,
                "p2_exact_tools_auto": r3,
                "p3_current_forced_short": r3,
                "p4_constrained_forced_short": r3,
            },
            {"constrained": {"completed_runs": 0}},
            ts,
        )
        assert "TURN_SPLITTING_SUPPORTED_WITH_SHARED_BUDGET" in signals

        assert ladder.validate_turn_split_args({"obligation": "server_surface", "content": "x"}, ablation["obligations"][0]) == (True, [])
        assert ladder.validate_turn_split_args({"obligation": "server_surface", "content": ""}, ablation["obligations"][0])[0] is False
        assert ladder.should_continue_after(
            "p2_exact_tools_auto",
            {
                "status": "timeout",
                "ttft_ms": 10.0,
                "cancellation_barrier": {"status": "idle_unconfirmed"},
            },
        ) is False

        prompt_progress = ladder.summarize_live_slot_progress([
            {
                "elapsed_ms": 500.0,
                "status": "ok",
                "slots": [{
                    "id": 0,
                    "id_task": 7,
                    "is_processing": True,
                    "n_prompt_tokens": 121,
                    "n_prompt_tokens_processed": 64,
                    "n_prompt_tokens_cache": 0,
                    "n_decoded": 0,
                    "generated_chars": 0,
                }],
            },
        ])
        assert prompt_progress["stage"] == "server_prompt_progress_before_first_token"
        assert prompt_progress["max_prompt_tokens_processed"] == 64

        decode_progress = ladder.summarize_live_slot_progress([
            {
                "elapsed_ms": 750.0,
                "status": "ok",
                "slots": [{
                    "id": 0,
                    "id_task": 8,
                    "is_processing": True,
                    "n_prompt_tokens": 121,
                    "n_prompt_tokens_processed": 121,
                    "n_prompt_tokens_cache": 0,
                    "n_decoded": 1,
                    "generated_chars": 4,
                }],
            },
        ])
        assert decode_progress["stage"] == "server_decode_before_stream_event"
        assert decode_progress["first_decode_progress_ms"] == 750.0

        scheduler_progress = ladder.summarize_live_slot_progress([
            {"elapsed_ms": 500.0, "status": "ok", "slots": [{"id": 0, "is_processing": False}]},
        ])
        assert scheduler_progress["stage"] == "server_processing_not_observed"
    finally:
        server.shutdown()
        server.server_close()

    print("PASS live /slots progress classifier")
    print("PASS streaming TTFT parser")
    print("PASS forced tool first-delta parser")
    print("PASS native usage/timings capture")
    print("PASS Turn-Splitting uses one shared wall budget")
    print("PASS Turn-Splitting deterministic obligation validation")
    print("PASS P0-P4 request-level cache_prompt is explicit and testable")
    print("PASS cold diagnostic default can disable prompt cache reuse")
    print("PASS reported cached-token evidence is preserved separately from requested policy")
    print("PASS Turn-Splitting cache_prompt enabled")
    print("PASS timeout cancellation barrier blocks contaminated next probe")
    print("PASS causal signal classification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
