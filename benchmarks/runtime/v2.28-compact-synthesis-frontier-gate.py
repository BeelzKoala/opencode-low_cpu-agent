#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

R70 = Path(__file__).with_name("v2.28-compact-synthesis-ir.py")
R71 = Path(__file__).with_name("v2.28-compact-synthesis-abi.py")
R72 = Path(__file__).with_name("v2.28-compact-synthesis-grammar.py")
R73 = Path(__file__).with_name("v2.28-compact-synthesis-frontier.py")


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec); sys.modules[name] = mod; spec.loader.exec_module(mod); return mod


def main() -> int:
    r70 = load(R70, "r70_gate_r73")
    r71 = load(R71, "r71_gate_r73")
    r72 = load(R72, "r72_gate_r73")
    r73 = load(R73, "r73_gate")

    assert r73.ABI_PROTOCOL == "python-callable-gbnf-wire-abi-v0.4"
    assert len(r73.terse_instruction()) < len(r72.grammar_instruction())
    assert r73.sha256_text(r72.wire_gbnf()) == r72.sha256_text(r72.wire_gbnf())

    class P: STABLE_SYSTEM_PREFIX = "SYS"
    class L:
        @staticmethod
        def common_body(model, *, messages, max_tokens, cache_prompt=False):
            return {"model": model["model"], "messages": messages, "max_tokens": max_tokens, "stream": True, "cache_prompt": cache_prompt}
    body = r73.build_body(r72, P, L, {"model":"m"}, "task", "S0", {"model_view":"PY_SOURCE x.py\npass\nEND_PY_SOURCE\n"}, 16, cache_prompt=False)
    assert body["grammar"] == r72.wire_gbnf()
    assert body["reasoning_format"] == "none"
    assert body["cache_prompt"] is False
    assert "tools" not in body and "tool_choice" not in body
    assert r72.wire_gbnf() not in "\n".join(m["content"] for m in body["messages"])

    idle = {"status":"idle_confirmed"}
    cold_result = {
        "status":"complete", "done_marker":True, "ttft_ms":65000.0,
        "usage":{"prompt_tokens":700,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}},
        "timings":{"cache_n":0,"prompt_n":700,"prompt_ms":64500.0,"predicted_n":1,"predicted_ms":120.0},
    }
    cold = r73.cold_assessment(r72, cold_result, 700, idle)
    assert cold["accepted"] is True, cold
    warm_cold = dict(cold_result); warm_cold["usage"]={"prompt_tokens":700,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":100}}
    assert r73.cold_assessment(r72, warm_cold, 700, idle)["accepted"] is False

    dec_result = {
        "status":"complete", "done_marker":True,
        "usage":{"prompt_tokens":700,"completion_tokens":16,"prompt_tokens_details":{"cached_tokens":695}},
        "timings":{"cache_n":695,"predicted_n":16,"predicted_ms":1920.0,"predicted_per_token_ms":120.0},
    }
    dec = r73.decode_assessment(r72, dec_result, 700, idle, 16)
    assert dec["accepted"] is True, dec
    no_cache = dict(dec_result); no_cache["usage"]={"prompt_tokens":700,"completion_tokens":16,"prompt_tokens_details":{"cached_tokens":10}}
    assert r73.decode_assessment(r72, no_cache, 700, idle, 16)["accepted"] is False

    # Same semantic IR/parser/lowerer remains underneath both R7.2 and R7.3.
    sample = {"k":"fn","n":"f","d":[],"p":[],"s":[["set","x","1"],["ret","x"]]}
    wire = r71.encode_wire(sample, r70)
    parsed = r71.parse_wire(wire, r70)
    assert parsed == sample
    lowered = r70.lower_callable_ir(parsed)
    assert "def f" in lowered["source"]

    source = R73.read_text(encoding="utf-8")
    forbidden = ["Blueprint(", "FastAPI", "APIRouter", "bestsellers", "rd_bestsellers_data", "report_category3_filter", "report_seller_filter", "get_basdb_conn"]
    for marker in forbidden:
        assert marker not in source, marker
    required = [
        "exact_same_prompt_zero_cache_first_text_token_upper_bound",
        "exact_prompt_resident_replay_llama_timings",
        "CURRENT_MODEL_HARDWARE_SLO_INFEASIBLE_FOR_TERSE_GRAMMAR_S0",
        "FIRST_TERSE_GRAMMAR_S0_CANDIDATE_VALID",
        "cache_prompt=False",
        "cache_prompt=True",
        "compile_prefill_cost_profile",
        "prefill_wall_admission",
    ]
    for marker in required:
        assert marker in source, marker

    print("PASS terse grammar removes duplicated model-facing grammar manual")
    print("PASS exact cold prefill calibration is separated from grammar decode calibration")
    print("PASS cold calibration requires zero cache and exact prompt accounting")
    print("PASS decode calibration requires exact resident replay and >=8 tokens")
    print("PASS same R7 wire parser / semantic validator / AST lowerer retained")
    print("PASS Governor remains fail-closed before real candidate inference")
    print("PASS no repository/framework vocabulary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
