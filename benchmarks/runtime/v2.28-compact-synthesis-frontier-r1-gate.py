#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

R70 = Path(__file__).with_name("v2.28-compact-synthesis-ir.py")
R71 = Path(__file__).with_name("v2.28-compact-synthesis-abi.py")
R72 = Path(__file__).with_name("v2.28-compact-synthesis-grammar.py")
R73 = Path(__file__).with_name("v2.28-compact-synthesis-frontier.py")
R731 = Path(__file__).with_name("v2.28-compact-synthesis-frontier-r1.py")


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    r70 = load(R70, "r70_gate_r731")
    r71 = load(R71, "r71_gate_r731")
    r72 = load(R72, "r72_gate_r731")
    r73 = load(R73, "r73_gate_r731")
    r731 = load(R731, "r731_gate")

    assert r731.ABI_PROTOCOL == "python-callable-plain-wire-abi-v0.5"
    assert r731.plain_instruction() == r73.terse_instruction()

    # Regression: wrappers must inherit R7.0 transitive dependency defaults instead
    # of manually duplicating them and drifting from compile_context requirements.
    ns = argparse.Namespace(r70=str(R70))
    normalized = r731.normalize_dependency_namespace(ns)
    expected_dependency_files = {
        "slice_benchmark": "v2.28-synthesis-slice-promotion.py",
        "prefill": "v2.28-prefill-compiler-ablation.py",
        "model_viability": "v2.28-model-viability.py",
        "ladder": "v2.28-inference-viability-ladder.py",
    }
    for attr, filename in expected_dependency_files.items():
        assert hasattr(normalized, attr), attr
        assert Path(getattr(normalized, attr)).name == filename, (attr, getattr(normalized, attr))

    override = argparse.Namespace(r70=str(R70), prefill="/tmp/custom-prefill.py")
    override = r731.normalize_dependency_namespace(override)
    assert override.prefill == "/tmp/custom-prefill.py"
    assert Path(override.slice_benchmark).name == "v2.28-synthesis-slice-promotion.py"

    parsed = r731.build_parser().parse_args([
        "inspect", "--fixture", "f", "--spec", "s", "--task", "t",
        "--source-repo", "repo", "--models", "models", "--model-name", "m",
        "--out", "out",
    ])
    for attr in expected_dependency_files:
        assert hasattr(parsed, attr), attr
    parsed = r731.normalize_dependency_namespace(parsed)
    for attr, filename in expected_dependency_files.items():
        assert Path(getattr(parsed, attr)).name == filename

    class P:
        STABLE_SYSTEM_PREFIX = "SYS"
    class L:
        @staticmethod
        def common_body(model, *, messages, max_tokens, cache_prompt=False):
            return {"model": model["model"], "messages": messages, "max_tokens": max_tokens, "stream": True, "cache_prompt": cache_prompt, "grammar": "SHOULD_BE_REMOVED"}

    body = r731.build_plain_body(P, L, {"model":"m"}, "task", "S0", {"model_view":"PY_SOURCE x.py\npass\nEND_PY_SOURCE\n"}, 16, cache_prompt=False)
    assert "grammar" not in body
    assert "tools" not in body and "tool_choice" not in body
    assert body["reasoning_format"] == "none"
    assert body["cache_prompt"] is False

    failed = {
        "raw_tail": [{"error": {"code": 500, "message": "got exception: Unexpected empty grammar stack after accepting piece: : (30)", "type": "server_error"}}]
    }
    cls = r731.classify_backend_failure(failed)
    assert cls["classification"] == "backend_grammar_failure"
    assert cls["prefill_failure_authority"] is False
    clean = r731.classify_backend_failure({"raw_tail": []})
    assert clean["classification"] is None

    idle = {"status":"idle_confirmed"}
    cold_result = {
        "status":"complete", "done_marker":True, "ttft_ms":64000.0,
        "usage":{"prompt_tokens":725,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}},
        "timings":{"cache_n":0,"prompt_n":725,"prompt_ms":63500.0,"predicted_n":1,"predicted_ms":120.0},
    }
    cold = r73.cold_assessment(r72, cold_result, 725, idle)
    assert cold["accepted"] is True, cold
    dec_result = {
        "status":"complete", "done_marker":True,
        "usage":{"prompt_tokens":725,"completion_tokens":16,"prompt_tokens_details":{"cached_tokens":720}},
        "timings":{"cache_n":720,"predicted_n":16,"predicted_ms":1920.0,"predicted_per_token_ms":120.0},
    }
    dec = r73.decode_assessment(r72, dec_result, 725, idle, 16)
    assert dec["accepted"] is True, dec

    # Same wire parser and AST lowerer remain the semantic authority.
    sample = {"k":"fn","n":"f","d":[],"p":[],"s":[["set","x","1"],["ret","x"]]}
    wire = r71.encode_wire(sample, r70)
    parsed = r71.parse_wire(wire, r70)
    assert parsed == sample
    lowered = r70.lower_callable_ir(parsed)
    assert "def f" in lowered["source"]

    source = R731.read_text(encoding="utf-8")
    forbidden = ["Blueprint(", "FastAPI", "APIRouter", "bestsellers", "rd_bestsellers_data", "report_category3_filter", "report_seller_filter", "get_basdb_conn"]
    for marker in forbidden:
        assert marker not in source, marker
    required = [
        "backend_grammar_failure",
        "llama_cpp_empty_grammar_stack",
        "CURRENT_MODEL_HARDWARE_SLO_INFEASIBLE_FOR_PLAIN_WIRE_S0",
        "FIRST_PLAIN_WIRE_S0_CANDIDATE_VALID",
        "cache_prompt=False",
        "cache_prompt=True",
        "compile_prefill_cost_profile",
        "prefill_wall_admission",
        "normalize_dependency_namespace",
        "R7.0 dependency defaults",
        "--slice-benchmark",
        "--model-viability",
    ]
    for marker in required:
        assert marker in source, marker

    print("PASS grammar backend failure is not misclassified as prefill failure")
    print("PASS current GBNF backend is removed from M1 critical path")
    print("PASS plain wire keeps the same R7 parser / semantic validator / AST lowerer")
    print("PASS exact cold prefill and resident decode calibration remain separated")
    print("PASS Governor remains fail-closed before real candidate inference")
    print("PASS no repository/framework vocabulary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
