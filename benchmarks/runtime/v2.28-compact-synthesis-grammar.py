#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import http.client
import importlib.util
import json
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

PROTOCOL = "compact-synthesis-grammar-benchmark-v0.3"
GRAMMAR_PROTOCOL = "python-callable-gbnf-wire-abi-v0.3"
CALIBRATION_PROTOCOL = "exact-cold-grammar-calibration-v1"
DEFAULT_R70 = Path(__file__).with_name("v2.28-compact-synthesis-ir.py")
DEFAULT_R71 = Path(__file__).with_name("v2.28-compact-synthesis-abi.py")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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


def require_api(module: Any, names: list[str], label: str) -> None:
    missing = [name for name in names if not hasattr(module, name)]
    if missing:
        raise RuntimeError(f"{label} API missing: {missing}")


def wire_gbnf() -> str:
    # GBNF is a lexical/bounds guard only. The unchanged R7 semantic validator/lowerer
    # remains the authority for identifiers, expressions, control-flow state and capabilities.
    return r'''root ::= f-line d-line{0,8} p-line{0,24} r-line? s-line ("\n" s-line){0,47}
    f-line ::= "F\t" fn-kind "\t" field "\n"
    d-line ::= "D\t" field "\n"
    p-line ::= "P\t" param-kind "\t" field "\t" field-opt "\t" field-opt "\n"
    r-line ::= "R\t" field "\n"
    s-line ::= set-line | aug-line | expr-line | ret-line | raise-line | if-line | else-line | for-line | afor-line | while-line | with-line | awith-line | try-line | except-line | try-else-line | finally-line | break-line | continue-line | pass-line | end-line
    set-line ::= "S\tset\t" field "\t" field
    aug-line ::= "S\taug\t" field "\t" field "\t" field
    expr-line ::= "S\texpr\t" field
    ret-line ::= "S\tret" ("\t" field)?
    raise-line ::= "S\traise" ("\t" field)?
    if-line ::= "S\tif\t" field
    else-line ::= "S\telse"
    for-line ::= "S\tfor\t" field "\t" field
    afor-line ::= "S\tafor\t" field "\t" field
    while-line ::= "S\twhile\t" field
    with-line ::= "S\twith\t" field ("\t" field)?
    awith-line ::= "S\tawith\t" field ("\t" field)?
    try-line ::= "S\ttry"
    except-line ::= "S\texcept" ("\t" field ("\t" field)?)?
    try-else-line ::= "S\ttry_else"
    finally-line ::= "S\tfinally"
    break-line ::= "S\tbreak"
    continue-line ::= "S\tcontinue"
    pass-line ::= "S\tpass"
    end-line ::= "S\tend"
    fn-kind ::= "fn" | "afn"
    param-kind ::= "po" | "p" | "v" | "ko" | "kw"
    field ::= [^\t\n\r]+
    field-opt ::= [^\t\n\r]*'''


def grammar_instruction() -> str:
    # Small model-facing legend. Grammar syntax itself is never injected into the prompt.
    return (
        "Output TSV callable IR only. F kind name; D decorator; P pk name ann? default?; R ann; "
        "S op args. Ops set,aug,expr,ret,raise,if,else,for,afor,while,with,awith,try,except,"
        "try_else,finally,break,continue,pass,end. Args: set t e; aug t op e; expr e; ret/raise e?; "
        "if/while e; for/afor t e; with/awith e alias?; except e? alias?. Python expression fields; end closes blocks."
    )


def grammar_identity() -> dict[str, Any]:
    grammar = wire_gbnf()
    return {
        "protocol": GRAMMAR_PROTOCOL,
        "authority": "out_of_band_llama_gbnf_lexical_guard_plus_unchanged_r7_semantic_validator",
        "grammar_sha256": sha256_text(grammar),
        "grammar_bytes": len(grammar.encode("utf-8")),
        "model_facing_grammar_bytes": 0,
        "semantic_ir_unchanged": True,
        "semantic_authority": "r7_validate_callable_ir_plus_lower_callable_ir",
        "max_decorators": 8,
        "max_params": 24,
        "max_instructions": 48,
    }


def build_messages(prefill: Any, task_prompt: str, handle: str, slice_doc: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "\n".join([
                prefill.STABLE_SYSTEM_PREFIX,
                "TASK",
                task_prompt,
                f"SYNTHESIS_PROTOCOL {GRAMMAR_PROTOCOL}",
                grammar_instruction(),
            ]),
        },
        {
            "role": "user",
            "content": "\n".join([
                f"TURN handle={handle} operation=python_declaration",
                slice_doc["model_view"].rstrip(),
            ]),
        },
    ]


def build_grammar_body(prefill: Any, ladder: Any, model: dict[str, Any], task_prompt: str, handle: str, slice_doc: dict[str, Any], max_tokens: int) -> dict[str, Any]:
    body = ladder.common_body(
        model,
        messages=build_messages(prefill, task_prompt, handle, slice_doc),
        max_tokens=max_tokens,
        cache_prompt=False,
    )
    # llama.cpp completion-specific grammar is request-side sampling state, not prompt text.
    body["grammar"] = wire_gbnf()
    # Keep raw generated grammar text in content instead of server reasoning extraction.
    body["reasoning_format"] = "none"
    body.pop("tools", None)
    body.pop("tool_choice", None)
    body.pop("parallel_tool_calls", None)
    return body


def prompt_shape(r71: Any, r70: Any, prefill: Any, ladder: Any, model: dict[str, Any], body: dict[str, Any], budget_s: float, label: str) -> dict[str, Any]:
    return r71.shape(r70, prefill, ladder, model, body, budget_s, label)


def grammar_out_of_band_proof(r71: Any, r70: Any, prefill: Any, ladder: Any, model: dict[str, Any], body: dict[str, Any], budget_s: float) -> dict[str, Any]:
    without = dict(body)
    without.pop("grammar", None)
    with_shape = prompt_shape(r71, r70, prefill, ladder, model, body, budget_s, "grammar_oob_with")
    without_shape = prompt_shape(r71, r70, prefill, ladder, model, without, budget_s, "grammar_oob_without")
    equal = (
        with_shape.get("prompt_tokens_observed") == without_shape.get("prompt_tokens_observed")
        and with_shape.get("rendered_prompt_sha256") == without_shape.get("rendered_prompt_sha256")
        and with_shape.get("token_ids_sha256") == without_shape.get("token_ids_sha256")
    )
    return {
        "protocol": "grammar-out-of-band-prompt-proof-v1",
        "authority": "server_apply_template_plus_tokenize_with_vs_without_grammar_field",
        "proof": equal,
        "with_grammar_tokens": with_shape.get("prompt_tokens_observed"),
        "without_grammar_tokens": without_shape.get("prompt_tokens_observed"),
        "rendered_prompt_sha_equal": with_shape.get("rendered_prompt_sha256") == without_shape.get("rendered_prompt_sha256"),
        "token_ids_sha_equal": with_shape.get("token_ids_sha256") == without_shape.get("token_ids_sha256"),
    }


def input_tokens_probe(prefill: Any, chat_url: str, body: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    # Optional stronger no-inference check against llama.cpp's chat input_tokens endpoint.
    # Older server builds may not expose it; absence is telemetry, not a reason to weaken gates.
    payload = dict(body)
    payload.pop("stream", None)
    try:
        value, elapsed_ms = prefill.post_json_no_inference(
            prefill.server_endpoint(chat_url, "/v1/chat/completions/input_tokens"),
            payload,
            timeout_s=timeout_s,
        )
    except Exception as exc:
        return {"status": "unavailable", "error": f"{type(exc).__name__}:{exc}"}
    count = value.get("input_tokens")
    return {
        "status": "counted" if isinstance(count, int) else "invalid",
        "input_tokens": count if isinstance(count, int) else None,
        "elapsed_ms": elapsed_ms,
    }


class TextStreamingRequest:
    '''Benchmark-local text capture; no product/runtime mutation.

    Existing ladder remains the owner of server-idle/cancellation barriers. This class only
    adds the full assistant text that the older generic ladder intentionally did not retain.
    '''
    def __init__(self, url: str, body: dict[str, Any], timeout_s: float) -> None:
        self.url = url
        self.body = body
        self.timeout_s = timeout_s
        self.started = time.monotonic()
        self.http_status: int | None = None
        self.error: str | None = None
        self.headers_ms: float | None = None
        self.first_event_ms: float | None = None
        self.ttft_ms: float | None = None
        self.finish_reason: str | None = None
        self.done_marker = False
        self.completed = False
        self.timed_out = False
        self.usage: dict[str, Any] | None = None
        self.timings: dict[str, Any] | None = None
        self.content_parts: list[str] = []
        self.reasoning_parts: list[str] = []
        self.raw_tail: list[dict[str, Any]] = []
        self.chunks = 0
        self._conn: http.client.HTTPConnection | http.client.HTTPSConnection | None = None
        self._done = threading.Event()
        self._thread: threading.Thread | None = None

    def _observe(self, event: dict[str, Any]) -> None:
        elapsed_ms = round((time.monotonic() - self.started) * 1000, 3)
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
            reasoning = delta.get("reasoning_content")
            if isinstance(content, str) and content:
                self.content_parts.append(content)
                if self.ttft_ms is None:
                    self.ttft_ms = elapsed_ms
            if isinstance(reasoning, str) and reasoning:
                self.reasoning_parts.append(reasoning)
        self.raw_tail.append(event)
        if len(self.raw_tail) > 4:
            self.raw_tail.pop(0)

    def _run(self) -> None:
        parsed = urlparse(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            self.error = "invalid_chat_url"
            self._done.set()
            return
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        conn_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(parsed.hostname, port, timeout=max(1.0, self.timeout_s + 2.0))
        self._conn = conn
        try:
            conn.request(
                "POST", path,
                body=json.dumps(self.body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
            )
            response = conn.getresponse()
            self.http_status = response.status
            self.headers_ms = round((time.monotonic() - self.started) * 1000, 3)
            if response.status < 200 or response.status >= 300:
                detail = response.read(16384).decode("utf-8", errors="replace")
                self.error = f"http_{response.status}:{detail[-4000:]}"
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
                    self.done_marker = True
                    self.completed = True
                    break
                try:
                    event = json.loads(data)
                except Exception:
                    continue
                if isinstance(event, dict):
                    self._observe(event)
            if self.done_marker or self.finish_reason is not None:
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
        if not self._done.wait(self.timeout_s):
            self.timed_out = True
            try:
                if self._conn is not None:
                    self._conn.close()
            except Exception:
                pass
            self._done.wait(2.0)
        wall_s = round(time.monotonic() - self.started, 3)
        content = "".join(self.content_parts)
        reasoning = "".join(self.reasoning_parts)
        if self.completed:
            stage = "complete"
        elif content or reasoning:
            stage = "decode"
        elif self.headers_ms is not None:
            stage = "post_headers_pre_first_token"
        else:
            stage = "pre_headers_or_prefill"
        return {
            "status": "complete" if self.completed else "timeout" if self.timed_out else "error",
            "stage_at_end": stage,
            "wall_s": wall_s,
            "http_status": self.http_status,
            "error": self.error,
            "headers_ms": self.headers_ms,
            "first_event_ms": self.first_event_ms,
            "ttft_ms": self.ttft_ms,
            "finish_reason": self.finish_reason,
            "done_marker": self.done_marker,
            "chunks": self.chunks,
            "content": content,
            "content_chars": len(content),
            "reasoning_content": reasoning,
            "reasoning_chars": len(reasoning),
            "usage": self.usage,
            "timings": self.timings,
            "server_progress": {},
            "raw_tail": self.raw_tail,
        }


def run_text_probe(ladder: Any, url: str, body: dict[str, Any], budget_s: float, label: str) -> dict[str, Any]:
    print(f"RUN probe={label} budget_s={budget_s:g}", flush=True)
    result = TextStreamingRequest(url, body, budget_s).execute()
    if result.get("status") == "timeout":
        result["cancellation_barrier"] = ladder.wait_server_idle(url, timeout_s=min(15.0, max(5.0, budget_s / 6.0)))
    else:
        result["cancellation_barrier"] = {"status": "not_required"}
    result["probe"] = label
    result["budget_s"] = budget_s
    result["request_sha256"] = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    print(
        f"RESULT probe={label} status={result['status']} stage={result['stage_at_end']} "
        f"wall_s={result['wall_s']} ttft_ms={result['ttft_ms']} chars={result['content_chars']}",
        flush=True,
    )
    return result


def cached_tokens(result: dict[str, Any]) -> int:
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    details = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
    value = details.get("cached_tokens")
    if isinstance(value, (int, float)):
        return max(0, int(value))
    timings = result.get("timings") if isinstance(result.get("timings"), dict) else {}
    value = timings.get("cache_n")
    return max(0, int(value)) if isinstance(value, (int, float)) else 0


def assess_calibration(result: dict[str, Any], observation: dict[str, Any] | None, expected_prompt_tokens: int, postflight_idle: dict[str, Any]) -> dict[str, Any]:
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    observed_prompt = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    reasons: list[str] = []
    if result.get("status") != "complete" or result.get("done_marker") is not True:
        reasons.append("calibration_request_not_complete")
    if postflight_idle.get("status") != "idle_confirmed":
        reasons.append("calibration_postflight_idle_unconfirmed")
    if observed_prompt != expected_prompt_tokens:
        reasons.append("calibration_prompt_accounting_mismatch")
    if cached_tokens(result) != 0:
        reasons.append("calibration_not_cold_zero_cache")
    if not isinstance(completion_tokens, int) or completion_tokens < 2:
        reasons.append("calibration_decode_sample_too_small")
    if not isinstance(observation, dict) or observation.get("regime") != "cold":
        reasons.append("calibration_observation_not_cold")
    if not isinstance(observation, dict) or not isinstance(observation.get("prefill_complete_ms"), (int, float)):
        reasons.append("calibration_prefill_completion_unproven")
    if not isinstance(observation, dict) or not isinstance(observation.get("decode_ms_per_token"), (int, float)) or float(observation.get("decode_ms_per_token") or 0) <= 0:
        reasons.append("calibration_decode_rate_unproven")
    return {
        "protocol": CALIBRATION_PROTOCOL,
        "authority": "exact_same_abi_zero_cache_completed_stream_plus_llama_timings",
        "expected_prompt_tokens": expected_prompt_tokens,
        "observed_prompt_tokens": observed_prompt,
        "observed_cached_tokens": cached_tokens(result),
        "completion_tokens": completion_tokens,
        "observation": observation,
        "reasons": reasons,
        "accepted": not reasons,
    }


def compile_context(args: argparse.Namespace):
    r71 = load_module(Path(args.r71).resolve(), "compact_r71_r72")
    require_api(r71, [
        "compile_context", "build_body_variant", "shape", "parse_wire", "encode_wire", "FULL_OPS",
    ], "R7.1 ABI")
    r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = r71.compile_context(args)
    require_api(slice_mod, [
        "compile_prefill_cost_profile", "prefill_wall_admission", "result_cost_observation",
        "obligation_for_handle", "allowed_python_declaration_kinds", "validate_exact_python_declaration",
    ], "R6.5 Governor benchmark")
    require_api(ladder, ["common_body", "wait_server_idle"], "inference ladder")
    return r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model


def inspect_payload(args: argparse.Namespace, context: tuple[Any, ...]) -> dict[str, Any]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    requested = int(args.max_output_tokens)
    budget = float(args.shape_budget_s)
    raw_body = r71.build_body_variant(r70, prefill, ladder, model, task_prompt, args.handle, slice_doc, requested, abi="raw_python")
    json_body = r71.build_body_variant(r70, prefill, ladder, model, task_prompt, args.handle, slice_doc, requested, abi="json_tool")
    wire_body = r71.build_body_variant(r70, prefill, ladder, model, task_prompt, args.handle, slice_doc, requested, abi="wire_tool")
    grammar_body = build_grammar_body(prefill, ladder, model, task_prompt, args.handle, slice_doc, requested)
    bodies = {"raw_python": raw_body, "json_tool": json_body, "wire_tool": wire_body, "grammar_wire": grammar_body}
    shapes = {name: prompt_shape(r71, r70, prefill, ladder, model, body, budget, f"r72_shape_{name}") for name, body in bodies.items()}
    oob = grammar_out_of_band_proof(r71, r70, prefill, ladder, model, grammar_body, budget)
    endpoint_with = input_tokens_probe(prefill, model["url"], grammar_body, budget)
    endpoint_without_body = dict(grammar_body); endpoint_without_body.pop("grammar", None)
    endpoint_without = input_tokens_probe(prefill, model["url"], endpoint_without_body, budget)
    endpoint_equal = (
        endpoint_with.get("status") == endpoint_without.get("status") == "counted"
        and endpoint_with.get("input_tokens") == endpoint_without.get("input_tokens")
    )
    prompt_tokens = int(shapes["grammar_wire"]["prompt_tokens_observed"])
    return {
        "protocol": "grammar-abi-inspect-v1",
        "grammar_identity": grammar_identity(),
        "shapes": shapes,
        "grammar_prompt_tokens": prompt_tokens,
        "raw_python_prompt_tokens": int(shapes["raw_python"]["prompt_tokens_observed"]),
        "wire_tool_prompt_tokens": int(shapes["wire_tool"]["prompt_tokens_observed"]),
        "json_tool_prompt_tokens": int(shapes["json_tool"]["prompt_tokens_observed"]),
        "grammar_vs_raw_delta_tokens": prompt_tokens - int(shapes["raw_python"]["prompt_tokens_observed"]),
        "grammar_vs_wire_delta_tokens": prompt_tokens - int(shapes["wire_tool"]["prompt_tokens_observed"]),
        "out_of_band_proof": oob,
        "chat_input_tokens_endpoint": {
            "with_grammar": endpoint_with,
            "without_grammar": endpoint_without,
            "equal_when_available": endpoint_equal,
        },
        "token_admitted": prompt_tokens <= int(args.max_prompt_tokens),
    }


def write_inspect(out: Path, inspect: dict[str, Any]) -> None:
    write_json(out / "grammar-contract.json", inspect["grammar_identity"])
    write_json(out / "abi-shapes.json", inspect["shapes"])
    write_json(out / "grammar-oob-proof.json", inspect["out_of_band_proof"])
    write_json(out / "grammar-inspect.json", inspect)


def run_calibration(args: argparse.Namespace, context: tuple[Any, ...], inspect: dict[str, Any], out: Path) -> tuple[dict[str, Any], Path]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    prompt_tokens = int(inspect["grammar_prompt_tokens"])
    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {
            "protocol": CALIBRATION_PROTOCOL,
            "decision": "CALIBRATION_ENVIRONMENT_DIRTY_PREFLIGHT",
            "preflight_idle": preflight,
            "result": None,
            "shape": inspect["shapes"]["grammar_wire"],
            "accepted": False,
            "product_source_mutated": False,
            "mutation_authority": False,
        }
        path = out / "calibration-summary.json"; write_json(path, summary); return summary, path
    body = build_grammar_body(
        prefill, ladder, model, task_prompt, args.handle, slice_doc,
        int(args.calibration_output_tokens),
    )
    result = run_text_probe(ladder, model["url"], body, float(args.calibration_wall_budget_s), "r72_exact_cold_grammar_calibration")
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    observation = slice_mod.result_cost_observation(result, prompt_tokens, "r72:exact_cold_grammar_calibration")
    assessment = assess_calibration(result, observation, prompt_tokens, postflight)
    summary = {
        "protocol": CALIBRATION_PROTOCOL,
        "fixture_request_sha256": fixture.get("request_sha256"),
        "task_text_sha256": spec.get("expected_task_text_sha256"),
        "model_name": model.get("name"),
        "grammar_identity": grammar_identity(),
        "shape": inspect["shapes"]["grammar_wire"],
        "preflight_idle": preflight,
        "postflight_idle": postflight,
        "result": result,
        "calibration_observation": observation,
        "assessment": assessment,
        "accepted": assessment["accepted"],
        "decision": "EXACT_COLD_GRAMMAR_CALIBRATION_ACCEPTED" if assessment["accepted"] else "EXACT_COLD_GRAMMAR_CALIBRATION_REJECTED",
        "candidate_validity_authority": "not_applicable_calibration_only",
        "product_source_mutated": False,
        "mutation_authority": False,
    }
    path = out / "calibration-summary.json"
    write_json(path, summary)
    write_json(out / "calibration-result.json", result)
    return summary, path


def validate_candidate(r71: Any, r70: Any, slice_mod: Any, prefill: Any, spec: dict[str, Any], ir_row: dict[str, Any], handle: str, result: dict[str, Any], shape_budget_s: float, model_url: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any]]:
    evidence: dict[str, Any] = {"parsed": False, "candidate_contract_valid": False, "errors": []}
    text = result.get("content")
    if not isinstance(text, str) or not text:
        evidence["errors"].append("grammar_output_missing_content")
        return None, None, evidence
    if result.get("reasoning_chars") not in {0, None}:
        evidence["errors"].append("unexpected_reasoning_channel_content")
        return None, None, evidence
    try:
        doc = r71.parse_wire(text, r70)
        lowering = r70.lower_callable_ir(doc)
    except RuntimeError as exc:
        evidence["errors"].append(str(exc))
        return None, None, evidence
    evidence["parsed"] = True
    candidate = r70.mutation_candidate(handle, ir_row, lowering)
    ir_meta, obligation = slice_mod.obligation_for_handle(prefill, spec, handle)
    allowed = slice_mod.allowed_python_declaration_kinds(ir_meta, obligation)
    valid, errors, payload = slice_mod.validate_exact_python_declaration({"content": lowering["source"]}, ["content"], handle, allowed)
    evidence["candidate_contract_valid"] = bool(valid)
    evidence["errors"] = errors
    evidence["accepted_payload"] = payload if valid else None
    return lowering, candidate, evidence


def candidate_command(args: argparse.Namespace) -> int:
    context = compile_context(args)
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    inspect = inspect_payload(args, context); write_inspect(out, inspect)
    if inspect["out_of_band_proof"].get("proof") is not True:
        raise RuntimeError("grammar field changed rendered prompt; out-of-band ABI claim invalid")
    if inspect["token_admitted"] is not True:
        summary = {"protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "decision": "GRAMMAR_PROMPT_TOKEN_BUDGET_REJECTED", "product_source_mutated": False, "mutation_authority": False}
        write_json(out / "summary.json", summary); print(json.dumps(summary, ensure_ascii=False, indent=2)); return 0

    calibration, calibration_path = run_calibration(args, context, inspect, out)
    if calibration.get("accepted") is not True:
        summary = {
            "protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "calibration": calibration,
            "decision": "GRAMMAR_CALIBRATION_REJECTED_NO_SYNTHESIS", "inference_admitted": False,
            "product_source_mutated": False, "mutation_authority": False,
        }
        write_json(out / "summary.json", summary)
        print("\n=== R7.2 GRAMMAR CANDIDATE ==="); print("DECISION", summary["decision"]); print("SUMMARY", out / "summary.json"); return 0

    evidence_paths = list(args.prefill_evidence or []) + [str(calibration_path)]
    profile = slice_mod.compile_prefill_cost_profile(evidence_paths)
    prompt_tokens = int(inspect["grammar_prompt_tokens"])
    admission = slice_mod.prefill_wall_admission(
        profile,
        uncached_tokens=prompt_tokens,
        regime="cold",
        min_output_tokens=int(args.min_output_tokens),
        requested_max_output_tokens=int(args.max_output_tokens),
        wall_budget_s=float(args.wall_budget_s),
        safety_factor=float(args.prefill_safety_factor),
        protocol_reserve_ms=float(args.protocol_reserve_ms),
    )
    write_json(out / "prefill-cost-profile.json", profile)
    write_json(out / "wall-admission.json", admission)
    planned = int(admission.get("planned_decode_tokens") or 0)
    inference_admitted = admission.get("admitted") is True and planned >= int(args.min_output_tokens)
    result = lowering = candidate = candidate_evidence = token_economics = None
    preflight = postflight = None
    if inference_admitted:
        preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
        if preflight.get("status") != "idle_confirmed":
            inference_admitted = False
    if inference_admitted:
        body = build_grammar_body(prefill, ladder, model, task_prompt, args.handle, slice_doc, planned)
        result = run_text_probe(ladder, model["url"], body, float(args.wall_budget_s), f"r72_grammar_candidate_{args.handle}")
        postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
        result["postflight_idle_barrier"] = postflight
        if postflight.get("status") == "idle_confirmed":
            lowering, candidate, candidate_evidence = validate_candidate(
                r71, r70, slice_mod, prefill, spec, ir_row, args.handle, result,
                float(args.shape_budget_s), model["url"],
            )
        else:
            candidate_evidence = {"parsed": False, "candidate_contract_valid": False, "errors": ["postflight_idle_unconfirmed"]}
        result["candidate_evidence"] = candidate_evidence
        if lowering is not None:
            wire = r71.encode_wire(lowering["normalized_ir"], r70)
            ir_shape = r70.native_token_count(prefill, model["url"], wire, float(args.shape_budget_s))
            source_shape = r70.native_token_count(prefill, model["url"], lowering["source"], float(args.shape_budget_s))
            raw_input = int(inspect["raw_python_prompt_tokens"])
            token_economics = {
                "protocol": "observed-grammar-ir-token-economics-v1",
                "authority": "server_native_tokenizer_plus_observed_candidate",
                "grammar_input_tokens": prompt_tokens,
                "grammar_output_payload_tokens": ir_shape["token_count"],
                "grammar_total_token_proxy": prompt_tokens + ir_shape["token_count"],
                "raw_python_input_tokens": raw_input,
                "lowered_python_output_tokens": source_shape["token_count"],
                "raw_python_total_token_proxy": raw_input + source_shape["token_count"],
                "proxy_delta_tokens": (prompt_tokens + ir_shape["token_count"]) - (raw_input + source_shape["token_count"]),
                "candidate_quality_required": True,
                "promotion_authority": "candidate_quality_plus_observed_wall_required",
            }
        write_json(out / "result.json", result)
        if lowering is not None: write_json(out / "lowering.json", lowering)
        if candidate is not None: write_json(out / "mutation-candidate.json", candidate)
        if token_economics is not None: write_json(out / "token-economics.json", token_economics)

    valid_candidate = bool(result and candidate_evidence and candidate_evidence.get("candidate_contract_valid") is True)
    signals = [
        "OUT_OF_BAND_GRAMMAR_PROMPT_PROVEN",
        "EXACT_COLD_GRAMMAR_CALIBRATION_ACCEPTED",
        "GRAMMAR_WALL_ADMISSION_READY" if admission.get("admitted") else "GRAMMAR_WALL_ADMISSION_REJECTED",
    ]
    if result is not None:
        signals.append("FIRST_GRAMMAR_S0_CANDIDATE_VALID" if valid_candidate else "GRAMMAR_S0_CANDIDATE_REJECTED")
    decision = signals[-1]
    summary = {
        "protocol": PROTOCOL,
        "mode": "candidate",
        "handle": args.handle,
        "fixture_request_sha256": fixture.get("request_sha256"),
        "task_text_sha256": spec.get("expected_task_text_sha256"),
        "model_name": model.get("name"),
        "source_file": slice_doc.get("file"),
        "source_authority": slice_doc.get("authority"),
        "semantic_ir_protocol": r70.IR_PROTOCOL,
        "semantic_ir_unchanged": True,
        "inspect": inspect,
        "calibration": calibration,
        "wall_admission": admission,
        "planned_output_tokens": planned,
        "inference_admitted": inference_admitted,
        "preflight_idle": preflight,
        "postflight_idle": postflight,
        "result": result,
        "lowering": lowering,
        "candidate": candidate,
        "candidate_evidence": candidate_evidence,
        "token_economics": token_economics,
        "valid_candidate": valid_candidate,
        "signals": signals,
        "decision": decision,
        "calibration_cost_separate_from_candidate_wall": True,
        "candidate_validity_authority": "existing_r7_lowerer_plus_existing_exact_python_declaration_validator" if valid_candidate else "not_validated",
        "product_source_mutated": False,
        "mutation_authority": False,
        "pass_metric": "FIRST_WALL_ADMITTED_SOURCE_VALIDATED_GRAMMAR_IR_S0_CANDIDATE",
    }
    write_json(out / "summary.json", summary)
    print("\n=== R7.2 GRAMMAR CANDIDATE ===")
    print(f"raw={inspect['raw_python_prompt_tokens']} wire={inspect['wire_tool_prompt_tokens']} grammar={prompt_tokens}")
    print(f"calibration={calibration.get('accepted')} wall_admitted={admission.get('admitted')} planned_output={planned} candidate_valid={valid_candidate}")
    print("SIGNALS", ",".join(signals))
    print("SUMMARY", out / "summary.json")
    return 0


def inspect_command(args: argparse.Namespace) -> int:
    context = compile_context(args)
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    inspect = inspect_payload(args, context); write_inspect(out, inspect)
    summary = {
        "protocol": PROTOCOL,
        "mode": "inspect",
        "inspect": inspect,
        "decision": "GRAMMAR_ABI_READY_FOR_COLD_CALIBRATION" if inspect["out_of_band_proof"].get("proof") and inspect["token_admitted"] else "GRAMMAR_ABI_INSPECT_REJECTED",
        "product_source_mutated": False,
        "mutation_authority": False,
    }
    write_json(out / "summary.json", summary)
    print("\n=== R7.2 GRAMMAR ABI INSPECT ===")
    print(f"raw={inspect['raw_python_prompt_tokens']} wire={inspect['wire_tool_prompt_tokens']} grammar={inspect['grammar_prompt_tokens']}")
    print("OOB", inspect["out_of_band_proof"].get("proof"), "DECISION", summary["decision"])
    print("SUMMARY", out / "summary.json")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["inspect", "candidate"])
    ap.add_argument("--r70", default=str(DEFAULT_R70))
    ap.add_argument("--r71", default=str(DEFAULT_R71))
    ap.add_argument("--slice-benchmark", default=str(Path(__file__).with_name("v2.28-synthesis-slice-promotion.py")))
    ap.add_argument("--prefill", default=str(Path(__file__).with_name("v2.28-prefill-compiler-ablation.py")))
    ap.add_argument("--model-viability", default=str(Path(__file__).with_name("v2.28-model-viability.py")))
    ap.add_argument("--ladder", default=str(Path(__file__).with_name("v2.28-inference-viability-ladder.py")))
    ap.add_argument("--fixture", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--source-repo", required=True)
    ap.add_argument("--handle", default="S0")
    ap.add_argument("--slice-max-bytes", type=int, default=6000)
    ap.add_argument("--dependency-depth", type=int, default=1)
    ap.add_argument("--models", required=True)
    ap.add_argument("--model-name")
    ap.add_argument("--shape-budget-s", type=float, default=3.0)
    ap.add_argument("--max-prompt-tokens", type=int, default=1200)
    ap.add_argument("--min-output-tokens", type=int, default=128)
    ap.add_argument("--max-output-tokens", type=int, default=192)
    ap.add_argument("--wall-budget-s", type=float, default=90.0)
    ap.add_argument("--calibration-wall-budget-s", type=float, default=90.0)
    ap.add_argument("--calibration-output-tokens", type=int, default=8)
    ap.add_argument("--prefill-evidence", action="append", default=[])
    ap.add_argument("--prefill-safety-factor", type=float, default=1.10)
    ap.add_argument("--protocol-reserve-ms", type=float, default=3000.0)
    ap.add_argument("--idle-timeout-s", type=float, default=10.0)
    ap.add_argument("--postflight-idle-timeout-s", type=float, default=15.0)
    ap.add_argument("--out", required=True)
    return ap


def main() -> int:
    args = build_parser().parse_args()
    if args.calibration_output_tokens < 2 or args.calibration_output_tokens > 32:
        raise RuntimeError("calibration output tokens must be in [2,32]")
    if args.mode == "inspect":
        return inspect_command(args)
    return candidate_command(args)


if __name__ == "__main__":
    raise SystemExit(main())
