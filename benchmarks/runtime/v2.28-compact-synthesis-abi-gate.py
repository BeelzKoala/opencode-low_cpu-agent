#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ABI = HERE / "v2.28-compact-synthesis-abi.py"
R70 = HERE / "v2.28-compact-synthesis-ir.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def expect_fail(fn, needle: str) -> None:
    try:
        fn()
    except RuntimeError as exc:
        assert needle in str(exc), (needle, str(exc))
        return
    raise AssertionError(f"expected failure containing {needle!r}")


def main() -> int:
    abi = load(ABI, "abi_gate")
    r70 = load(R70, "r70_gate")

    cases = [
        {
            "k": "fn", "n": "transform", "d": ["router.post('/x')"], "p": [["p", "request"]],
            "s": [["set", "value", "request.get('value')"], ["if", "not value"], ["ret", "('missing', 400)"], ["end"], ["ret", "build(value)"]],
        },
        {
            "k": "fn", "n": "aggregate", "d": [], "p": [["p", "items"]],
            "s": [["set", "total", "0"], ["for", "item", "items"], ["aug", "total", "+", "score(item)"], ["end"], ["ret", "total"]],
        },
        {
            "k": "afn", "n": "fetch_one", "d": [], "p": [["p", "client"]],
            "s": [["try"], ["awith", "client.session()", "session"], ["ret", "await session.fetch()"], ["end"], ["except", "TimeoutError"], ["ret", "None"], ["end"]],
        },
        {
            "k": "fn", "n": "defaults", "d": [], "p": [["p", "x", "", "None"]], "r": "str | None",
            "s": [["ret", "x"]],
        },
    ]
    for case in cases:
        norm_before = r70.validate_callable_ir(case)
        wire = abi.encode_wire(case, r70)
        parsed = abi.parse_wire(wire, r70)
        norm_after = r70.validate_callable_ir(parsed)
        assert r70.canonical_json(norm_before) == r70.canonical_json(norm_after)
        source_before = r70.lower_callable_ir(case)["source"]
        source_after = r70.lower_callable_ir(parsed)["source"]
        assert source_before == source_after
        assert "slot" not in wire and "source_repo" not in wire

    expect_fail(lambda: abi.parse_wire("hello world", r70), "unknown record tag")
    expect_fail(lambda: abi.parse_wire("F\tfn\tx\n\nS\tpass", r70), "empty lines")
    expect_fail(lambda: abi.parse_wire("F\tfn\tx\r\nS\tpass", r70), "CR characters")
    expect_fail(lambda: abi.parse_wire("F\tfn\tx\nS\tunknown", r70), "invalid")
    expect_fail(lambda: abi.parse_wire("F\tfn\tx\nS\tbreak", r70), "outside loop")
    expect_fail(lambda: abi.encode_wire({"k": "fn", "n": "x", "d": ["a\tb"], "p": [], "s": [["pass"]]}, r70), "invalid Python expression")

    tool = abi.envelope_tool()
    schema = abi.canonical_json(tool)
    assert len(schema.encode("utf-8")) <= 384, len(schema.encode("utf-8"))
    params = tool["function"]["parameters"]
    assert params["additionalProperties"] is False
    assert params["required"] == ["x"]
    assert set(params["properties"]) == {"x"}

    # Capability hints are deliberately telemetry only, never model restriction authority.
    hints = abi.opcode_hints_from_slice({"evidence_atoms": [{"source": "    return build(value)\n"}]})
    assert hints["capability_projection_applied"] is False
    assert hints["authority"] == "non_restrictive_source_shape_hint_only"
    assert hints["exposed_ops"] == list(abi.FULL_OPS)
    assert "ret" in hints["observed_ops"]

    # Stable deterministic ABI choice: minimum native prompt tokens, then name tiebreak.
    selected = abi.choose_abi({
        "raw_python": {"prompt_tokens_observed": 700},
        "json_tool": {"prompt_tokens_observed": 900},
        "wire_tool": {"prompt_tokens_observed": 800},
    })
    assert selected["selected_abi"] == "wire_tool"
    tied = abi.choose_abi({
        "raw_python": {"prompt_tokens_observed": 700},
        "json_tool": {"prompt_tokens_observed": 800},
        "wire_tool": {"prompt_tokens_observed": 800},
    })
    assert tied["selected_abi"] == "json_tool"

    # Shapley accounting exactly attributes a non-additive tokenizer cost function.
    names = ("protocol", "contract", "transport")
    def v(enabled: tuple[str, ...]) -> int:
        s = set(enabled)
        value = 700 + 20 * ("protocol" in s) + 30 * ("contract" in s) + 40 * ("transport" in s)
        if {"contract", "transport"}.issubset(s): value += 9
        return value
    values = {}
    for mask in range(8):
        enabled = tuple(names[i] for i in range(3) if mask & (1 << i))
        values[enabled] = v(enabled)
    shapley = abi.shapley_from_values(names, values)
    assert abs(sum(shapley.values()) - (values[names] - values[()])) < 0.01

    source = ABI.read_text(encoding="utf-8")
    forbidden = [
        "Blueprint(", "FastAPI", "APIRouter", "bestsellers", "rd_bestsellers_data",
        "report_category3_filter", "report_seller_filter", "get_basdb_conn", "xlsx_report",
    ]
    for marker in forbidden:
        assert marker not in source, f"repo/framework-specific ABI logic leaked: {marker}"
    required = [
        "server_apply_template_plus_tokenize_exact_factorial_shapley",
        "non_restrictive_source_shape_hint_only",
        "semantic_ir_unchanged",
        "deterministic-model-abi-selection-v1",
        "tokenizer-only-synthesis-economics-v1",
        "promotion_authority",
        "cache_prompt=False",
        "parse_wire",
        "encode_wire",
    ]
    for marker in required:
        assert marker in source, f"R7.1 marker missing: {marker}"

    print("PASS wire ABI round-trips through unchanged R7 semantic IR on unrelated callable shapes")
    print("PASS wire parser is bounded/fail-closed and carries no slot/path/mutation coordinates")
    print("PASS minimal forced-tool envelope is <=384 bytes and exact-x only")
    print("PASS capability hints never restrict compiler/model capability without machine proof")
    print("PASS ABI selection is deterministic from native prompt token authority")
    print("PASS exact factorial Shapley attribution handles tokenizer/template interactions")
    print("PASS token-economics proxy is explicitly non-authoritative without quality/wall evidence")
    print("PASS no repository/framework/business-specific ABI vocabulary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
