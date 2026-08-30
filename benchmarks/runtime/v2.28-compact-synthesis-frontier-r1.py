#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

PROTOCOL = "compact-synthesis-plain-wire-frontier-v0.5"
ABI_PROTOCOL = "python-callable-plain-wire-abi-v0.5"
PREFILL_CAL_PROTOCOL = "exact-cold-plain-wire-prefill-calibration-v1"
DECODE_CAL_PROTOCOL = "resident-plain-wire-decode-calibration-v1"
DEFAULT_R70 = Path(__file__).with_name("v2.28-compact-synthesis-ir.py")
DEFAULT_R71 = Path(__file__).with_name("v2.28-compact-synthesis-abi.py")
DEFAULT_R72 = Path(__file__).with_name("v2.28-compact-synthesis-grammar.py")
DEFAULT_R73 = Path(__file__).with_name("v2.28-compact-synthesis-frontier.py")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


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


def plain_instruction() -> str:
    # Same semantic wire language as R7.1/R7.3. No backend grammar dependency.
    # The parser + semantic validator remain fail-closed authority.
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
                plain_instruction(),
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


def build_plain_body(prefill: Any, ladder: Any, model: dict[str, Any], task_prompt: str, handle: str, slice_doc: dict[str, Any], max_tokens: int, *, cache_prompt: bool) -> dict[str, Any]:
    body = ladder.common_body(
        model,
        messages=build_messages(prefill, task_prompt, handle, slice_doc),
        max_tokens=max_tokens,
        cache_prompt=cache_prompt,
    )
    body["reasoning_format"] = "none"
    # Critical: current llama.cpp grammar path is not on the candidate critical path.
    body.pop("grammar", None)
    body.pop("tools", None)
    body.pop("tool_choice", None)
    body.pop("parallel_tool_calls", None)
    return body


def classify_backend_failure(result: dict[str, Any]) -> dict[str, Any]:
    messages: list[str] = []
    if isinstance(result.get("error"), str):
        messages.append(result["error"])
    tail = result.get("raw_tail") if isinstance(result.get("raw_tail"), list) else []
    for event in tail:
        if not isinstance(event, dict):
            continue
        err = event.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            messages.append(err["message"])
        elif isinstance(err, str):
            messages.append(err)
    text = "\n".join(messages)
    if "Unexpected empty grammar stack after accepting piece" in text:
        return {
            "classification": "backend_grammar_failure",
            "reason": "llama_cpp_empty_grammar_stack",
            "prefill_failure_authority": False,
        }
    return {
        "classification": None,
        "reason": None,
        "prefill_failure_authority": False,
    }


def normalize_dependency_namespace(args: argparse.Namespace) -> argparse.Namespace:
    """Populate transitive R7.0 dependency paths from the owning module defaults.

    Wrapper CLIs may expose overrides, but R7.0 remains the single source of truth
    for its internal benchmark dependencies. This avoids parser-surface drift across
    R7.1/R7.2/R7.3 wrappers and also supports programmatic Namespace callers.
    """
    if not hasattr(args, "r70") or not getattr(args, "r70"):
        setattr(args, "r70", str(DEFAULT_R70))
    r70_defaults = load_module(Path(args.r70).resolve(), "compact_r70_defaults_r731")
    require_api(r70_defaults, ["DEFAULT_SLICE", "DEFAULT_PREFILL", "DEFAULT_MV", "DEFAULT_LADDER"], "R7.0 dependency defaults")
    defaults = {
        "slice_benchmark": r70_defaults.DEFAULT_SLICE,
        "prefill": r70_defaults.DEFAULT_PREFILL,
        "model_viability": r70_defaults.DEFAULT_MV,
        "ladder": r70_defaults.DEFAULT_LADDER,
    }
    for name, value in defaults.items():
        if not hasattr(args, name) or getattr(args, name) in (None, ""):
            setattr(args, name, str(value))
    return args


def compile_context(args: argparse.Namespace):
    args = normalize_dependency_namespace(args)
    r73 = load_module(Path(args.r73).resolve(), "compact_r73_r731")
    require_api(r73, [
        "compile_context", "shape", "cold_assessment", "decode_assessment",
    ], "R7.3 frontier")
    r72, context = r73.compile_context(args)
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    require_api(r72, ["run_text_probe", "cached_tokens", "validate_candidate"], "R7.2 text probe")
    require_api(slice_mod, ["compile_prefill_cost_profile", "prefill_wall_admission"], "R6.5 Governor")
    return r73, r72, context


def inspect_payload(args: argparse.Namespace, r73: Any, r72: Any, context: tuple[Any, ...]) -> dict[str, Any]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    requested = int(args.max_output_tokens)
    budget = float(args.shape_budget_s)
    raw_body = r71.build_body_variant(r70, prefill, ladder, model, task_prompt, args.handle, slice_doc, requested, abi="raw_python")
    grammar_body = r73.build_body(r72, prefill, ladder, model, task_prompt, args.handle, slice_doc, requested, cache_prompt=False)
    plain_body = build_plain_body(prefill, ladder, model, task_prompt, args.handle, slice_doc, requested, cache_prompt=False)
    shapes = {
        "raw_python": r73.shape(r71, r70, prefill, ladder, model, raw_body, budget, "r731_shape_raw_python"),
        "grammar_terse": r73.shape(r71, r70, prefill, ladder, model, grammar_body, budget, "r731_shape_grammar_terse"),
        "plain_wire": r73.shape(r71, r70, prefill, ladder, model, plain_body, budget, "r731_shape_plain_wire"),
    }
    raw = int(shapes["raw_python"]["prompt_tokens_observed"])
    grammar = int(shapes["grammar_terse"]["prompt_tokens_observed"])
    plain = int(shapes["plain_wire"]["prompt_tokens_observed"])
    return {
        "protocol": "plain-wire-feasibility-frontier-v1",
        "semantic_ir_unchanged": True,
        "backend_grammar_dependency": False,
        "plain_instruction": plain_instruction(),
        "shapes": shapes,
        "raw_python_prompt_tokens": raw,
        "grammar_terse_prompt_tokens": grammar,
        "plain_wire_prompt_tokens": plain,
        "plain_vs_grammar_delta_tokens": plain - grammar,
        "plain_vs_raw_delta_tokens": plain - raw,
        "token_admitted": plain <= int(args.max_prompt_tokens),
        "frontier_candidate": plain <= grammar,
    }


def _profile_doc(shape: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    return {"shape": shape, "result": result}


def run_cold_calibration(args: argparse.Namespace, r73: Any, r72: Any, context: tuple[Any, ...], inspect: dict[str, Any], out: Path) -> tuple[dict[str, Any], Path | None]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    prompt_tokens = int(inspect["plain_wire_prompt_tokens"])
    shape = inspect["shapes"]["plain_wire"]
    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {
            "protocol": PREFILL_CAL_PROTOCOL,
            "accepted": False,
            "decision": "PLAIN_WIRE_PREFILL_ENVIRONMENT_DIRTY_PREFLIGHT",
            "preflight_idle": preflight,
            "product_source_mutated": False,
            "mutation_authority": False,
        }
        write_json(out / "cold-calibration-summary.json", summary)
        return summary, None
    body = build_plain_body(prefill, ladder, model, task_prompt, args.handle, slice_doc, 1, cache_prompt=False)
    result = r72.run_text_probe(ladder, model["url"], body, float(args.calibration_wall_budget_s), "r731_exact_cold_plain_wire_prefill")
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    backend_failure = classify_backend_failure(result)
    assessment = r73.cold_assessment(r72, result, prompt_tokens, postflight)
    # A backend grammar crash must never be relabelled as a prefill failure.
    if backend_failure["classification"] is not None:
        assessment = dict(assessment)
        assessment["accepted"] = False
        assessment["backend_failure"] = backend_failure
        assessment["reasons"] = list(assessment.get("reasons") or []) + ["backend_failure_not_prefill_authority"]
    profile_path = out / "cold-prefill-evidence.json"
    write_json(profile_path, _profile_doc(shape, result))
    summary = {
        "protocol": PREFILL_CAL_PROTOCOL,
        "shape": shape,
        "preflight_idle": preflight,
        "postflight_idle": postflight,
        "result": result,
        "backend_failure": backend_failure,
        "assessment": assessment,
        "accepted": assessment.get("accepted") is True,
        "decision": "EXACT_COLD_PLAIN_WIRE_PREFILL_ACCEPTED" if assessment.get("accepted") is True else "EXACT_COLD_PLAIN_WIRE_PREFILL_REJECTED",
        "candidate_validity_authority": "not_applicable_calibration_only",
        "product_source_mutated": False,
        "mutation_authority": False,
    }
    write_json(out / "cold-calibration-summary.json", summary)
    return summary, profile_path if summary["accepted"] else None


def run_decode_calibration(args: argparse.Namespace, r73: Any, r72: Any, context: tuple[Any, ...], inspect: dict[str, Any], out: Path) -> tuple[dict[str, Any], Path | None]:
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    prompt_tokens = int(inspect["plain_wire_prompt_tokens"])
    shape = inspect["shapes"]["plain_wire"]
    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {
            "protocol": DECODE_CAL_PROTOCOL,
            "accepted": False,
            "decision": "PLAIN_WIRE_DECODE_ENVIRONMENT_DIRTY_PREFLIGHT",
            "preflight_idle": preflight,
            "product_source_mutated": False,
            "mutation_authority": False,
        }
        write_json(out / "decode-calibration-summary.json", summary)
        return summary, None
    body = build_plain_body(prefill, ladder, model, task_prompt, args.handle, slice_doc, int(args.decode_calibration_tokens), cache_prompt=True)
    result = r72.run_text_probe(ladder, model["url"], body, float(args.decode_calibration_wall_budget_s), "r731_resident_plain_wire_decode")
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    backend_failure = classify_backend_failure(result)
    assessment = r73.decode_assessment(r72, result, prompt_tokens, postflight, int(args.decode_cache_tolerance_tokens))
    if backend_failure["classification"] is not None:
        assessment = dict(assessment)
        assessment["accepted"] = False
        assessment["backend_failure"] = backend_failure
        assessment["reasons"] = list(assessment.get("reasons") or []) + ["backend_failure_not_decode_authority"]
    profile_path = out / "decode-rate-evidence.json"
    write_json(profile_path, _profile_doc(shape, result))
    summary = {
        "protocol": DECODE_CAL_PROTOCOL,
        "shape": shape,
        "preflight_idle": preflight,
        "postflight_idle": postflight,
        "result": result,
        "backend_failure": backend_failure,
        "assessment": assessment,
        "accepted": assessment.get("accepted") is True,
        "decision": "RESIDENT_PLAIN_WIRE_DECODE_ACCEPTED" if assessment.get("accepted") is True else "RESIDENT_PLAIN_WIRE_DECODE_REJECTED",
        "candidate_validity_authority": "not_applicable_calibration_only",
        "product_source_mutated": False,
        "mutation_authority": False,
    }
    write_json(out / "decode-calibration-summary.json", summary)
    return summary, profile_path if summary["accepted"] else None


def inspect_command(args: argparse.Namespace) -> int:
    r73, r72, context = compile_context(args)
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    inspect = inspect_payload(args, r73, r72, context)
    write_json(out / "frontier-inspect.json", inspect)
    decision = "PLAIN_WIRE_READY_FOR_SPLIT_CALIBRATION" if inspect["frontier_candidate"] and inspect["token_admitted"] else "PLAIN_WIRE_FRONTIER_REJECTED"
    summary = {
        "protocol": PROTOCOL,
        "mode": "inspect",
        "inspect": inspect,
        "decision": decision,
        "product_source_mutated": False,
        "mutation_authority": False,
    }
    write_json(out / "summary.json", summary)
    print("\n=== R7.3.1 PLAIN WIRE FRONTIER INSPECT ===")
    print(f"raw={inspect['raw_python_prompt_tokens']} grammar={inspect['grammar_terse_prompt_tokens']} plain={inspect['plain_wire_prompt_tokens']}")
    print("DECISION", decision)
    print("SUMMARY", out / "summary.json")
    return 0


def candidate_command(args: argparse.Namespace) -> int:
    r73, r72, context = compile_context(args)
    r71, r70, slice_mod, prefill, mv, ladder, fixture, spec, task_prompt, ir_row, slice_doc, model = context
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    inspect = inspect_payload(args, r73, r72, context)
    write_json(out / "frontier-inspect.json", inspect)
    if inspect["frontier_candidate"] is not True or inspect["token_admitted"] is not True:
        summary = {
            "protocol": PROTOCOL, "mode": "candidate", "inspect": inspect,
            "decision": "PLAIN_WIRE_FRONTIER_REJECTED_NO_INFERENCE",
            "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False,
        }
        write_json(out / "summary.json", summary); return 0

    cold, cold_path = run_cold_calibration(args, r73, r72, context, inspect, out)
    if cold.get("accepted") is not True or cold_path is None:
        summary = {
            "protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "cold_calibration": cold,
            "decision": "PLAIN_WIRE_COLD_PREFILL_REJECTED_NO_SYNTHESIS",
            "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False,
        }
        write_json(out / "summary.json", summary)
        print("\n=== R7.3.1 PLAIN WIRE FRONTIER ==="); print("DECISION", summary["decision"]); print("SUMMARY", out / "summary.json")
        return 0

    decode, decode_path = run_decode_calibration(args, r73, r72, context, inspect, out)
    if decode.get("accepted") is not True or decode_path is None:
        summary = {
            "protocol": PROTOCOL, "mode": "candidate", "inspect": inspect,
            "cold_calibration": cold, "decode_calibration": decode,
            "decision": "PLAIN_WIRE_DECODE_CALIBRATION_REJECTED_NO_SYNTHESIS",
            "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False,
        }
        write_json(out / "summary.json", summary)
        print("\n=== R7.3.1 PLAIN WIRE FRONTIER ==="); print("DECISION", summary["decision"]); print("SUMMARY", out / "summary.json")
        return 0

    evidence_paths = list(args.prefill_evidence or []) + [str(cold_path), str(decode_path)]
    profile = slice_mod.compile_prefill_cost_profile(evidence_paths)
    prompt_tokens = int(inspect["plain_wire_prompt_tokens"])
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
            "decision": "CURRENT_MODEL_HARDWARE_SLO_INFEASIBLE_FOR_PLAIN_WIRE_S0",
            "inference_admitted": False, "product_source_mutated": False, "mutation_authority": False,
        }
        write_json(out / "summary.json", summary)
        print("\n=== R7.3.1 PLAIN WIRE FRONTIER ==="); print("DECISION", summary["decision"]); print("SUMMARY", out / "summary.json")
        return 0

    preflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.idle_timeout_s))
    if preflight.get("status") != "idle_confirmed":
        summary = {
            "protocol": PROTOCOL, "mode": "candidate", "inspect": inspect, "wall_admission": admission,
            "decision": "PLAIN_WIRE_CANDIDATE_ENVIRONMENT_DIRTY_PREFLIGHT", "inference_admitted": False,
            "preflight_idle": preflight, "product_source_mutated": False, "mutation_authority": False,
        }
        write_json(out / "summary.json", summary); return 0
    body = build_plain_body(prefill, ladder, model, task_prompt, args.handle, slice_doc, planned, cache_prompt=False)
    result = r72.run_text_probe(ladder, model["url"], body, float(args.wall_budget_s), f"r731_plain_wire_candidate_{args.handle}")
    postflight = ladder.wait_server_idle(model["url"], timeout_s=float(args.postflight_idle_timeout_s))
    result["postflight_idle_barrier"] = postflight
    backend_failure = classify_backend_failure(result)
    result["backend_failure"] = backend_failure
    lowering = candidate = None
    candidate_evidence: dict[str, Any]
    if backend_failure["classification"] is not None:
        candidate_evidence = {"parsed": False, "candidate_contract_valid": False, "errors": ["backend_failure_not_candidate_authority"]}
    elif postflight.get("status") == "idle_confirmed":
        lowering, candidate, candidate_evidence = r72.validate_candidate(
            r71, r70, slice_mod, prefill, spec, ir_row, args.handle, result, float(args.shape_budget_s), model["url"]
        )
    else:
        candidate_evidence = {"parsed": False, "candidate_contract_valid": False, "errors": ["postflight_idle_unconfirmed"]}
    result["candidate_evidence"] = candidate_evidence
    write_json(out / "result.json", result)
    if lowering is not None:
        write_json(out / "lowering.json", lowering)
    if candidate is not None:
        write_json(out / "mutation-candidate.json", candidate)
    valid = candidate_evidence.get("candidate_contract_valid") is True
    decision = "FIRST_PLAIN_WIRE_S0_CANDIDATE_VALID" if valid else "PLAIN_WIRE_S0_CANDIDATE_REJECTED"
    summary = {
        "protocol": PROTOCOL, "mode": "candidate", "handle": args.handle,
        "inspect": inspect, "cold_calibration": cold, "decode_calibration": decode,
        "wall_admission": admission, "planned_output_tokens": planned,
        "preflight_idle": preflight, "postflight_idle": postflight,
        "result": result, "lowering": lowering, "candidate": candidate,
        "decision": decision, "inference_admitted": True,
        "candidate_validity_authority": "existing_r7_parser_semantic_validator_ast_lowerer_plus_existing_mutation_candidate_validator",
        "product_source_mutated": False, "mutation_authority": False,
        "pass_metric": "FIRST_VALID_BOUNDED_PLAIN_WIRE_S0_CANDIDATE",
    }
    write_json(out / "summary.json", summary)
    print("\n=== R7.3.1 PLAIN WIRE FRONTIER ===")
    print("DECISION", decision)
    print("SUMMARY", out / "summary.json")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="R7.3.1 plain-wire fallback after backend grammar failure")
    ap.add_argument("mode", choices=["inspect", "candidate"])
    ap.add_argument("--r70", default=str(DEFAULT_R70))
    ap.add_argument("--r71", default=str(DEFAULT_R71))
    ap.add_argument("--r72", default=str(DEFAULT_R72))
    ap.add_argument("--r73", default=str(DEFAULT_R73))
    # R7.0 owns these dependency defaults. None means inherit from that module.
    ap.add_argument("--slice-benchmark", default=None)
    ap.add_argument("--prefill", default=None)
    ap.add_argument("--model-viability", default=None)
    ap.add_argument("--ladder", default=None)
    ap.add_argument("--fixture", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--source-repo", required=True)
    ap.add_argument("--handle", default="S0")
    ap.add_argument("--slice-max-bytes", type=int, default=6000)
    ap.add_argument("--max-declarations", type=int, default=1)
    ap.add_argument("--dependency-depth", type=int, default=1)
    ap.add_argument("--models", required=True)
    ap.add_argument("--model-name", required=True)
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
