#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

PROTOCOL = "compact-synthesis-feasibility-frontier-v0.4"
ABI_PROTOCOL = "python-callable-gbnf-wire-abi-v0.4"
PREFILL_CAL_PROTOCOL = "exact-cold-prefill-calibration-v2"
DECODE_CAL_PROTOCOL = "resident-grammar-decode-calibration-v1"
DEFAULT_R70 = Path(__file__).with_name("v2.28-compact-synthesis-ir.py")
DEFAULT_R71 = Path(__file__).with_name("v2.28-compact-synthesis-abi.py")
DEFAULT_R72 = Path(__file__).with_name("v2.28-compact-synthesis-grammar.py")


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


def terse_instruction() -> str:
    # The GBNF owns lexical structure; the unchanged R7 validator owns semantics.
    # Keep model text to semantic orientation only, not a duplicate grammar manual.
    return "Emit TSV callable IR only. F/D/P/R/S records; Python expressions; S end closes blocks; no prose."


def build_messages(prefill: Any, task_prompt: str, handle: str, slice_doc: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "\n".join([
                prefill.STABLE_SYSTEM_PREFIX,
                "TASK",
                task_prompt,
                f"SYNTHESIS_PROTOCOL {ABI_PROTOCOL}",
                terse_instruction(),
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


def build_body(r72: Any, prefill: Any, ladder: Any, model: dict[str, Any], task_prompt: str, handle: str, slice_doc: dict[str, Any], max_tokens: int, *, cache_prompt: bool) -> dict[str, Any]:
    body = ladder.common_body(
        model,
        messages=build_messages(prefill, task_prompt, handle, slice_doc),
        max_tokens=max_tokens,
        cache_prompt=cache_prompt,
    )
    body["grammar"] = r72.wire_gbnf()
    body["reasoning_format"] = "none"
    body.pop("tools", None)
    body.pop("tool_choice", None)
    body.pop("parallel_tool_calls", None)
    return body


def cached_tokens(r72: Any, result: dict[str, Any]) -> int:
    return int(r72.cached_tokens(result))


def compile_context(args: argparse.Namespace):
    r72 = load_module(Path(args.r72).resolve(), "compact_r72_r73")
    require_api(r72, ["compile_context", "wire_gbnf", "build_grammar_body", "run_text_probe", "cached_tokens", "validate_candidate"], "R7.2 grammar")
    context = r72.compile_context(args)
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    require_api(slice_mod, ["compile_prefill_cost_profile", "prefill_wall_admission", "result_cost_observation"], "R6.5 Governor")
    return r72, context


def shape(r71: Any, r70: Any, prefill: Any, ladder: Any, model: dict[str, Any], body: dict[str, Any], budget_s: float, label: str) -> dict[str, Any]:
    return r71.shape(r70, prefill, ladder, model, body, budget_s, label)


def inspect_payload(args: argparse.Namespace, r72: Any, context: tuple[Any, ...]) -> dict[str, Any]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    max_out = int(args.max_output_tokens)
    budget = float(args.shape_budget_s)
    raw_body = r71.build_body_variant(r70, prefill, ladder, model, task_prompt, args.handle, slice_doc, max_out, abi="raw_python")
    full_body = r72.build_grammar_body(prefill, ladder, model, task_prompt, args.handle, slice_doc, max_out)
    terse_body = build_body(r72, prefill, ladder, model, task_prompt, args.handle, slice_doc, max_out, cache_prompt=False)
    bodies = {"raw_python": raw_body, "grammar_full": full_body, "grammar_terse": terse_body}
    shapes = {name: shape(r71, r70, prefill, ladder, model, body, budget, f"r73_shape_{name}") for name, body in bodies.items()}
    terse_without = dict(terse_body); terse_without.pop("grammar", None)
    terse_without_shape = shape(r71, r70, prefill, ladder, model, terse_without, budget, "r73_grammar_oob_without")
    terse_shape = shapes["grammar_terse"]
    oob = (
        terse_shape.get("prompt_tokens_observed") == terse_without_shape.get("prompt_tokens_observed")
        and terse_shape.get("rendered_prompt_sha256") == terse_without_shape.get("rendered_prompt_sha256")
        and terse_shape.get("token_ids_sha256") == terse_without_shape.get("token_ids_sha256")
    )
    raw = int(shapes["raw_python"]["prompt_tokens_observed"])
    full = int(shapes["grammar_full"]["prompt_tokens_observed"])
    terse = int(shapes["grammar_terse"]["prompt_tokens_observed"])
    return {
        "protocol": "compact-synthesis-prompt-frontier-v1",
        "semantic_ir_unchanged": True,
        "grammar_sha256": sha256_text(r72.wire_gbnf()),
        "terse_instruction": terse_instruction(),
        "shapes": shapes,
        "raw_python_prompt_tokens": raw,
        "grammar_full_prompt_tokens": full,
        "grammar_terse_prompt_tokens": terse,
        "terse_vs_full_delta_tokens": terse - full,
        "terse_vs_raw_delta_tokens": terse - raw,
        "grammar_out_of_band_proven": oob,
        "token_admitted": terse <= int(args.max_prompt_tokens),
        "frontier_candidate": terse < full,
    }


def _prefill_completion_ms(result: dict[str, Any]) -> float | None:
    for key in ("ttft_ms",):
        value = result.get(key)
        if isinstance(value, (int, float)) and float(value) > 0:
            return float(value)
    timings = result.get("timings") if isinstance(result.get("timings"), dict) else {}
    value = timings.get("prompt_ms")
    if isinstance(value, (int, float)) and float(value) > 0:
        # prompt_ms excludes/changes some HTTP overhead, so first content is preferred.
        return float(value)
    return None


def cold_assessment(r72: Any, result: dict[str, Any], expected_prompt_tokens: int, postflight: dict[str, Any]) -> dict[str, Any]:
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    observed_prompt = usage.get("prompt_tokens")
    completion = usage.get("completion_tokens")
    prefill_ms = _prefill_completion_ms(result)
    reasons: list[str] = []
    if result.get("status") != "complete" or result.get("done_marker") is not True:
        reasons.append("cold_prefill_request_not_complete")
    if postflight.get("status") != "idle_confirmed":
        reasons.append("cold_prefill_postflight_idle_unconfirmed")
    if observed_prompt != expected_prompt_tokens:
        reasons.append("cold_prefill_prompt_accounting_mismatch")
    if cached_tokens(r72, result) != 0:
        reasons.append("cold_prefill_not_zero_cache")
    if not isinstance(completion, int) or completion < 1:
        reasons.append("cold_prefill_first_decode_not_observed")
    if prefill_ms is None:
        reasons.append("cold_prefill_completion_unproven")
    return {
        "protocol": PREFILL_CAL_PROTOCOL,
        "authority": "exact_same_prompt_zero_cache_first_text_token_upper_bound",
        "expected_prompt_tokens": expected_prompt_tokens,
        "observed_prompt_tokens": observed_prompt,
        "observed_cached_tokens": cached_tokens(r72, result),
        "completion_tokens": completion,
        "prefill_complete_upper_ms": prefill_ms,
        "reasons": reasons,
        "accepted": not reasons,
    }


def decode_rate(result: dict[str, Any]) -> float | None:
    timings = result.get("timings") if isinstance(result.get("timings"), dict) else {}
    value = timings.get("predicted_per_token_ms")
    if isinstance(value, (int, float)) and float(value) > 0:
        return float(value)
    n = timings.get("predicted_n"); ms = timings.get("predicted_ms")
    if isinstance(n, (int, float)) and float(n) >= 2 and isinstance(ms, (int, float)) and float(ms) > 0:
        return float(ms) / float(n)
    return None


def decode_assessment(r72: Any, result: dict[str, Any], expected_prompt_tokens: int, postflight: dict[str, Any], cache_tolerance: int) -> dict[str, Any]:
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    observed_prompt = usage.get("prompt_tokens")
    completion = usage.get("completion_tokens")
    cached = cached_tokens(r72, result)
    rate = decode_rate(result)
    reasons: list[str] = []
    if result.get("status") != "complete" or result.get("done_marker") is not True:
        reasons.append("decode_probe_request_not_complete")
    if postflight.get("status") != "idle_confirmed":
        reasons.append("decode_probe_postflight_idle_unconfirmed")
    if observed_prompt != expected_prompt_tokens:
        reasons.append("decode_probe_prompt_accounting_mismatch")
    if cached < max(0, expected_prompt_tokens - cache_tolerance):
        reasons.append("decode_probe_exact_replay_cache_not_proven")
    if not isinstance(completion, int) or completion < 8:
        reasons.append("decode_probe_sample_too_small")
    if rate is None:
        reasons.append("decode_probe_rate_unproven")
    return {
        "protocol": DECODE_CAL_PROTOCOL,
        "authority": "exact_prompt_resident_replay_llama_timings",
        "expected_prompt_tokens": expected_prompt_tokens,
        "observed_prompt_tokens": observed_prompt,
        "observed_cached_tokens": cached,
        "required_cached_tokens": max(0, expected_prompt_tokens - cache_tolerance),
        "completion_tokens": completion,
        "decode_ms_per_token": rate,
        "reasons": reasons,
        "accepted": not reasons,
    }


def _profile_result_without_one_token_decode(result: dict[str, Any]) -> dict[str, Any]:
    row = copy.deepcopy(result)
    timings = row.get("timings")
    if isinstance(timings, dict):
        for key in ("predicted_per_token_ms", "predicted_n", "predicted_ms", "predicted_per_second"):
            timings.pop(key, None)
    return row


def run_cold_calibration(args: argparse.Namespace, r72: Any, context: tuple[Any, ...], inspect: dict[str, Any], out: Path) -> tuple[dict[str, Any], Path | None]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    prompt_tokens = int(inspect["grammar_terse_prompt_tokens"])
    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {"protocol": PREFILL_CAL_PROTOCOL, "accepted": False, "decision": "COLD_PREFILL_ENVIRONMENT_DIRTY_PREFLIGHT", "preflight_idle": preflight, "product_source_mutated": False, "mutation_authority": False}
        write_json(out / "cold-calibration-summary.json", summary)
        return summary, None
    body = build_body(r72, prefill, ladder, model, task_prompt, args.handle, slice_doc, 1, cache_prompt=False)
    result = r72.run_text_probe(ladder, model["url"], body, float(args.calibration_wall_budget_s), "r73_exact_cold_prefill")
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    assessment = cold_assessment(r72, result, prompt_tokens, postflight)
    profile_result = _profile_result_without_one_token_decode(result)
    profile_doc = {"shape": inspect["shapes"]["grammar_terse"], "result": profile_result}
    profile_path = out / "cold-prefill-evidence.json"
    write_json(profile_path, profile_doc)
    summary = {
        "protocol": PREFILL_CAL_PROTOCOL,
        "shape": inspect["shapes"]["grammar_terse"],
        "preflight_idle": preflight,
        "postflight_idle": postflight,
        "result": result,
        "assessment": assessment,
        "accepted": assessment["accepted"],
        "decision": "EXACT_COLD_PREFILL_ACCEPTED" if assessment["accepted"] else "EXACT_COLD_PREFILL_REJECTED",
        "candidate_validity_authority": "not_applicable_calibration_only",
        "product_source_mutated": False,
        "mutation_authority": False,
    }
    write_json(out / "cold-calibration-summary.json", summary)
    return summary, profile_path


def run_decode_calibration(args: argparse.Namespace, r72: Any, context: tuple[Any, ...], inspect: dict[str, Any], out: Path) -> tuple[dict[str, Any], Path | None]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    prompt_tokens = int(inspect["grammar_terse_prompt_tokens"])
    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {"protocol": DECODE_CAL_PROTOCOL, "accepted": False, "decision": "DECODE_ENVIRONMENT_DIRTY_PREFLIGHT", "preflight_idle": preflight, "product_source_mutated": False, "mutation_authority": False}
        write_json(out / "decode-calibration-summary.json", summary)
        return summary, None
    body = build_body(r72, prefill, ladder, model, task_prompt, args.handle, slice_doc, int(args.decode_calibration_tokens), cache_prompt=True)
    result = r72.run_text_probe(ladder, model["url"], body, float(args.decode_calibration_wall_budget_s), "r73_resident_grammar_decode")
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    assessment = decode_assessment(r72, result, prompt_tokens, postflight, int(args.decode_cache_tolerance_tokens))
    profile_doc = {"shape": inspect["shapes"]["grammar_terse"], "result": result}
    profile_path = out / "decode-rate-evidence.json"
    write_json(profile_path, profile_doc)
    summary = {
        "protocol": DECODE_CAL_PROTOCOL,
        "shape": inspect["shapes"]["grammar_terse"],
        "preflight_idle": preflight,
        "postflight_idle": postflight,
        "result": result,
        "assessment": assessment,
        "accepted": assessment["accepted"],
        "decision": "RESIDENT_GRAMMAR_DECODE_ACCEPTED" if assessment["accepted"] else "RESIDENT_GRAMMAR_DECODE_REJECTED",
        "candidate_validity_authority": "not_applicable_calibration_only",
        "product_source_mutated": False,
        "mutation_authority": False,
    }
    write_json(out / "decode-calibration-summary.json", summary)
    return summary, profile_path


def candidate_command(args: argparse.Namespace) -> int:
    r72, context = compile_context(args)
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    inspect = inspect_payload(args, r72, context)
    write_json(out / "frontier-inspect.json", inspect)
    if inspect["grammar_out_of_band_proven"] is not True or inspect["frontier_candidate"] is not True or inspect["token_admitted"] is not True:
        summary = {"protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "decision": "TERSE_GRAMMAR_FRONTIER_REJECTED_NO_INFERENCE", "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False}
        write_json(out / "summary.json", summary); print(json.dumps(summary, indent=2)); return 0

    cold, cold_path = run_cold_calibration(args, r72, context, inspect, out)
    if cold.get("accepted") is not True or cold_path is None:
        summary = {"protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "cold_calibration": cold, "decision": "COLD_PREFILL_CALIBRATION_REJECTED_NO_SYNTHESIS", "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False}
        write_json(out / "summary.json", summary)
        print("\n=== R7.3 FEASIBILITY FRONTIER ==="); print("DECISION", summary["decision"]); print("SUMMARY", out / "summary.json"); return 0

    decode, decode_path = run_decode_calibration(args, r72, context, inspect, out)
    if decode.get("accepted") is not True or decode_path is None:
        summary = {"protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "cold_calibration": cold, "decode_calibration": decode, "decision": "GRAMMAR_DECODE_CALIBRATION_REJECTED_NO_SYNTHESIS", "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False}
        write_json(out / "summary.json", summary)
        print("\n=== R7.3 FEASIBILITY FRONTIER ==="); print("DECISION", summary["decision"]); print("SUMMARY", out / "summary.json"); return 0

    evidence_paths = list(args.prefill_evidence or []) + [str(cold_path), str(decode_path)]
    profile = slice_mod.compile_prefill_cost_profile(evidence_paths)
    prompt_tokens = int(inspect["grammar_terse_prompt_tokens"])
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
    if not inference_admitted:
        summary = {
            "protocol": PROTOCOL, "mode": "candidate", "inspect": inspect,
            "cold_calibration": cold, "decode_calibration": decode,
            "wall_admission": admission, "planned_output_tokens": planned,
            "decision": "CURRENT_MODEL_HARDWARE_SLO_INFEASIBLE_FOR_TERSE_GRAMMAR_S0",
            "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False,
        }
        write_json(out / "summary.json", summary)
        print("\n=== R7.3 FEASIBILITY FRONTIER ==="); print("DECISION", summary["decision"]); print("SUMMARY", out / "summary.json"); return 0

    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {"protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "wall_admission": admission, "decision": "CANDIDATE_ENVIRONMENT_DIRTY_PREFLIGHT", "inference_admitted": False, "preflight_idle": preflight, "product_source_mutated": False, "mutation_authority": False}
        write_json(out / "summary.json", summary); return 0
    body = build_body(r72, prefill, ladder, model, task_prompt, args.handle, slice_doc, planned, cache_prompt=False)
    result = r72.run_text_probe(ladder, model["url"], body, float(args.wall_budget_s), f"r73_terse_grammar_candidate_{args.handle}")
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    result["postflight_idle_barrier"] = postflight
    lowering = candidate = None
    candidate_evidence: dict[str, Any]
    if postflight.get("status") == "idle_confirmed":
        lowering, candidate, candidate_evidence = r72.validate_candidate(r71, r70, slice_mod, prefill, spec, ir_row, args.handle, result, float(args.shape_budget_s), model["url"])
    else:
        candidate_evidence = {"parsed": False, "candidate_contract_valid": False, "errors": ["postflight_idle_unconfirmed"]}
    result["candidate_evidence"] = candidate_evidence
    write_json(out / "result.json", result)
    if lowering is not None: write_json(out / "lowering.json", lowering)
    if candidate is not None: write_json(out / "mutation-candidate.json", candidate)
    valid = candidate_evidence.get("candidate_contract_valid") is True
    decision = "FIRST_TERSE_GRAMMAR_S0_CANDIDATE_VALID" if valid else "TERSE_GRAMMAR_S0_CANDIDATE_REJECTED"
    summary = {
        "protocol": PROTOCOL, "mode": "candidate", "handle": args.handle,
        "inspect": inspect, "cold_calibration": cold, "decode_calibration": decode,
        "wall_admission": admission, "planned_output_tokens": planned,
        "inference_admitted": True, "preflight_idle": preflight, "postflight_idle": postflight,
        "result": result, "lowering": lowering, "candidate": candidate,
        "candidate_evidence": candidate_evidence, "valid_candidate": valid,
        "decision": decision,
        "candidate_validity_authority": "existing_r7_wire_parser_validator_lowerer_plus_exact_python_declaration_validator" if valid else "not_validated",
        "calibration_cost_separate_from_candidate_wall": True,
        "product_source_mutated": False, "mutation_authority": False,
        "pass_metric": "FIRST_WALL_ADMITTED_SOURCE_VALIDATED_TERSE_GRAMMAR_S0_CANDIDATE",
    }
    write_json(out / "summary.json", summary)
    print("\n=== R7.3 FEASIBILITY FRONTIER ===")
    print(f"raw={inspect['raw_python_prompt_tokens']} full={inspect['grammar_full_prompt_tokens']} terse={inspect['grammar_terse_prompt_tokens']}")
    print(f"cold={cold.get('accepted')} decode={decode.get('accepted')} wall={admission.get('admitted')} planned={planned} candidate={valid}")
    print("DECISION", decision); print("SUMMARY", out / "summary.json")
    return 0


def inspect_command(args: argparse.Namespace) -> int:
    r72, context = compile_context(args)
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    inspect = inspect_payload(args, r72, context)
    write_json(out / "frontier-inspect.json", inspect)
    decision = "TERSE_GRAMMAR_READY_FOR_SPLIT_CALIBRATION" if inspect["grammar_out_of_band_proven"] and inspect["frontier_candidate"] and inspect["token_admitted"] else "TERSE_GRAMMAR_FRONTIER_REJECTED"
    summary = {"protocol": PROTOCOL, "mode": "inspect", "inspect": inspect, "decision": decision, "product_source_mutated": False, "mutation_authority": False}
    write_json(out / "summary.json", summary)
    print("\n=== R7.3 FEASIBILITY FRONTIER INSPECT ===")
    print(f"raw={inspect['raw_python_prompt_tokens']} full={inspect['grammar_full_prompt_tokens']} terse={inspect['grammar_terse_prompt_tokens']}")
    print("DECISION", decision); print("SUMMARY", out / "summary.json")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["inspect", "candidate"])
    ap.add_argument("--r70", default=str(DEFAULT_R70))
    ap.add_argument("--r71", default=str(DEFAULT_R71))
    ap.add_argument("--r72", default=str(DEFAULT_R72))
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
    ap.add_argument("--decode-calibration-wall-budget-s", type=float, default=30.0)
    ap.add_argument("--decode-calibration-tokens", type=int, default=16)
    ap.add_argument("--decode-cache-tolerance-tokens", type=int, default=16)
    ap.add_argument("--prefill-evidence", action="append", default=[])
    ap.add_argument("--prefill-safety-factor", type=float, default=1.10)
    ap.add_argument("--protocol-reserve-ms", type=float, default=3000.0)
    ap.add_argument("--idle-timeout-s", type=float, default=10.0)
    ap.add_argument("--postflight-idle-timeout-s", type=float, default=15.0)
    ap.add_argument("--out", required=True)
    return ap


def main() -> int:
    args = build_parser().parse_args()
    if int(args.decode_calibration_tokens) < 8:
        raise SystemExit("--decode-calibration-tokens must be >=8")
    if args.mode == "inspect":
        return inspect_command(args)
    return candidate_command(args)


if __name__ == "__main__":
    raise SystemExit(main())
