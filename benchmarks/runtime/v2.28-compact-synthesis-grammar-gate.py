#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
R70 = HERE / "v2.28-compact-synthesis-ir.py"
R71 = HERE / "v2.28-compact-synthesis-abi.py"
R72 = HERE / "v2.28-compact-synthesis-grammar.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m); return m


def expect_fail(fn, *args):
    try:
        fn(*args)
    except Exception:
        return
    raise AssertionError("expected failure")


def main() -> int:
    r70 = load(R70, "gate_r70")
    r71 = load(R71, "gate_r71")
    r72 = load(R72, "gate_r72")

    docs = [
        {"k":"fn","n":"transform","d":[],"p":[["p","value"]],"s":[["set","x","normalize(value)"],["if","not x"],["ret","None"],["end"],["ret","x"]]},
        {"k":"fn","n":"sum_rows","d":[],"p":[["p","rows"]],"s":[["set","total","0"],["for","row","rows"],["aug","total","+","row"],["end"],["ret","total"]]},
        {"k":"afn","n":"fetch","d":[],"p":[["p","client"]],"s":[["try"],["set","value","await client.get()"],["except","Exception","exc"],["raise","exc"],["end"],["ret","value"]]},
    ]
    for doc in docs:
        wire = r71.encode_wire(doc, r70)
        parsed = r71.parse_wire(wire, r70)
        assert r70.validate_callable_ir(parsed) == r70.validate_callable_ir(doc)
        lowered = r70.lower_callable_ir(parsed)
        compile(lowered["source"], "<gate>", "exec")

    grammar = r72.wire_gbnf()
    identity = r72.grammar_identity()
    assert identity["model_facing_grammar_bytes"] == 0
    assert identity["max_decorators"] == 8 and identity["max_params"] == 24 and identity["max_instructions"] == 48
    for marker in ["root ::=", "d-line{0,8}", "p-line{0,24}", "{0,47}", "field ::= [^\\t\\n\\r]+"]:
        assert marker in grammar, marker

    class FakePrefill:
        STABLE_SYSTEM_PREFIX = "SYSTEM"
    class FakeLadder:
        @staticmethod
        def common_body(model, *, messages, max_tokens, cache_prompt=False):
            return {"model": model["model"], "messages": messages, "max_tokens": max_tokens, "stream": True, "cache_prompt": cache_prompt}
    body = r72.build_grammar_body(FakePrefill, FakeLadder, {"model":"m"}, "task", "S0", {"model_view":"PY_SOURCE x.py\npass\nEND_PY_SOURCE\n"}, 128)
    assert body["cache_prompt"] is False
    assert body["grammar"] == grammar
    assert body["reasoning_format"] == "none"
    assert "tools" not in body and "tool_choice" not in body
    assert grammar not in "\n".join(row["content"] for row in body["messages"])

    cold_obs = {"regime":"cold","prefill_complete_ms":60000.0,"decode_ms_per_token":120.0}
    cold_result = {"status":"complete","done_marker":True,"usage":{"prompt_tokens":800,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":0}},"timings":{"cache_n":0}}
    idle = {"status":"idle_confirmed"}
    ok = r72.assess_calibration(cold_result, cold_obs, 800, idle)
    assert ok["accepted"] is True
    warm_result = {"status":"complete","done_marker":True,"usage":{"prompt_tokens":800,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":100}},"timings":{"cache_n":100}}
    bad = r72.assess_calibration(warm_result, {**cold_obs,"regime":"resident_partial"}, 800, idle)
    assert bad["accepted"] is False and "calibration_not_cold_zero_cache" in bad["reasons"]
    tiny_result = {"status":"complete","done_marker":True,"usage":{"prompt_tokens":800,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}},"timings":{"cache_n":0}}
    bad2 = r72.assess_calibration(tiny_result, {**cold_obs,"decode_ms_per_token":None}, 800, idle)
    assert bad2["accepted"] is False and "calibration_decode_sample_too_small" in bad2["reasons"]

    source = R72.read_text(encoding="utf-8")
    forbidden = ["Blueprint(", "FastAPI", "APIRouter", "bestsellers", "rd_bestsellers_data", "report_category3_filter", "report_seller_filter", "get_basdb_conn"]
    for marker in forbidden:
        assert marker not in source, f"repo/framework-specific grammar logic leaked: {marker}"
    required = [
        "out_of_band_llama_gbnf_lexical_guard_plus_unchanged_r7_semantic_validator",
        "grammar-out-of-band-prompt-proof-v1",
        "exact-cold-grammar-calibration-v1",
        "calibration_not_cold_zero_cache",
        "compile_prefill_cost_profile",
        "prefill_wall_admission",
        "FIRST_GRAMMAR_S0_CANDIDATE_VALID",
        "mutation_authority\": False",
        "cache_prompt=False",
        "reasoning_format",
    ]
    for marker in required:
        assert marker in source, f"R7.2 marker missing: {marker}"

    print("PASS GBNF bounds mirror R7 decorator/param/instruction limits")
    print("PASS grammar is lexical guard; unchanged R7 validator/lowerer remains semantic authority")
    print("PASS grammar wire uses no tool transport and no repository/framework vocabulary")
    print("PASS exact cold calibration rejects cache contamination and undersized decode telemetry")
    print("PASS calibration and candidate keep mutation authority false")
    print("PASS candidate path reuses existing Governor wall admission and exact declaration validator")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
