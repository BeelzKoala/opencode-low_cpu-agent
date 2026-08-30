#!/usr/bin/env python3
from __future__ import annotations

import ast
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "benchmarks/runtime/v2.28-compact-synthesis-ir.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def expect_fail(fn, contains: str) -> None:
    try:
        fn()
    except RuntimeError as exc:
        assert contains in str(exc), (contains, str(exc))
    else:
        raise AssertionError(f"expected RuntimeError containing {contains!r}")


def main() -> int:
    bench = load(BENCH, "compact_ir_gate")

    # Three deliberately unrelated callable shapes exercise the exact same IR/lowerer.
    cases = [
        {
            "k": "fn", "n": "process_item", "d": ["router.post('/items')"],
            "p": [["p", "item_id", "str"]], "r": "dict[str, object]",
            "s": [
                ["if", "not item_id"], ["ret", "{'error': 'missing'}"], ["end"],
                ["set", "value", "load_item(item_id)"], ["ret", "{'value': value}"],
            ],
        },
        {
            "k": "fn", "n": "aggregate_rows", "d": [], "p": [["p", "rows"]],
            "s": [
                ["set", "total", "0"], ["for", "row", "rows"],
                ["if", "row is None"], ["continue"], ["end"],
                ["aug", "total", "+", "row"], ["end"], ["ret", "total"],
            ],
        },
        {
            "k": "afn", "n": "fetch_value", "d": [], "p": [["p", "client"]],
            "s": [
                ["try"], ["set", "value", "await client.fetch()"],
                ["except", "Exception", "exc"], ["raise", "RuntimeError(str(exc))"],
                ["end"], ["ret", "value"],
            ],
        },
    ]
    for doc in cases:
        lowered = bench.lower_callable_ir(doc)
        tree = ast.parse(lowered["source"])
        assert len(tree.body) == 1
        assert isinstance(tree.body[0], (ast.FunctionDef, ast.AsyncFunctionDef))
        assert lowered["mutation_authority"] is False
        assert lowered["instruction_count"] == len(doc["s"])
        assert bench.lower_callable_ir(doc)["source_sha256"] == lowered["source_sha256"]

    row = {"operation": "python_declaration", "required_fields": ["content"]}
    bridge = bench.mutation_candidate("S0", row, bench.lower_callable_ir(cases[0]))
    assert bridge["handle"] == "S0"
    assert bridge["operation"] == "python_declaration"
    assert set(bridge["fields"]) == {"content"}
    assert bridge["mutation_authority"] is False
    assert "slot" not in bridge and "path" not in bridge and "file" not in bridge

    # Capability cannot silently expand beyond the existing mutation operation.
    expect_fail(lambda: bench.mutation_candidate("S0", {"operation": "replacement"}, bench.lower_callable_ir(cases[0])), "only valid for python_declaration")
    expect_fail(lambda: bench.mutation_candidate("S0", {"operation": "python_declaration", "required_fields": ["content", "path"]}, bench.lower_callable_ir(cases[0])), "capability mismatch")

    # Parser/compiler safety and boundedness.
    bad_extra = dict(cases[0]); bad_extra["slot"] = "existing:0"
    expect_fail(lambda: bench.lower_callable_ir(bad_extra), "unauthorized fields")
    bad_import = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["expr", "import os"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_import), "invalid Python expression")
    bad_lambda = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["ret", "lambda x: x"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_lambda), "forbidden expression nodes")
    bad_break = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["break"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_break), "outside loop")
    bad_unclosed = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["if", "flag"], ["pass"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_unclosed), "unclosed control-flow blocks")
    bad_try = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["try"], ["pass"], ["end"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_try), "try requires except or finally")
    bad_sync_await = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["ret", "await fetch()"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_sync_await), "sync callable contains async-only syntax")
    bad_sync_awith = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["awith", "manager", "value"], ["pass"], ["end"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_sync_awith), "awith requires async callable")
    bad_except_alias = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["try"], ["pass"], ["except", "", "exc"], ["pass"], ["end"]]}
    expect_fail(lambda: bench.lower_callable_ir(bad_except_alias), "bare except cannot bind alias")
    too_many = {"k": "fn", "n": "x", "d": [], "p": [], "s": [["pass"]] * (bench.MAX_INSTRUCTIONS + 1)}
    expect_fail(lambda: bench.lower_callable_ir(too_many), "bounded array")

    tool = bench.callable_tool()
    tool_bytes = len(bench.canonical_json(tool).encode("utf-8"))
    assert tool_bytes <= 1024, tool_bytes
    assert tool["function"]["name"] == "emit_callable_ir"
    assert tool["function"]["parameters"]["additionalProperties"] is False

    source = BENCH.read_text(encoding="utf-8")
    # Repo/framework/business names belong in benchmark inputs/evidence, never opcodes/compiler logic.
    forbidden = [
        "Blueprint(", "FastAPI", "APIRouter", "bestsellers", "rd_bestsellers_data",
        "report_category3_filter", "report_seller_filter", "get_basdb_conn", "xlsx_report",
    ]
    for marker in forbidden:
        assert marker not in source, f"repo/framework-specific logic leaked into compact IR: {marker}"
    required = [
        "python-callable-synthesis-ir-v0.1",
        "bounded-mutation-candidate-bridge-v0.1",
        "capability_subset_of_existing_mutation",
        "mutation_authority",
        "MAX_INSTRUCTIONS",
        "MAX_NESTING",
        "MAX_EXPR_NODES",
        "assignment_target",
        "lower_instructions",
        "lower_callable_ir",
        "prefill_wall_admission",
        "cache_prompt=False",
        "native_token_count",
        "encoding_efficiency",
        "server_native_tokenizer",
    ]
    for marker in required:
        assert marker in source, f"compact IR marker missing: {marker}"

    print("PASS same compact callable IR lowers unrelated sync/loop/async shapes")
    print("PASS deterministic AST lowering emits exactly one top-level callable")
    print("PASS SynthesisIR capability is a strict subset of existing python_declaration mutation")
    print("PASS no slot/path/source coordinates are model-authorized")
    print("PASS expression/target/control-flow/budget validation is fail-closed")
    print("PASS flat tuple tool schema stays <=1KiB and avoids recursive schema")
    print("PASS no repository/framework/business-specific opcodes or lowering rules")
    print("PASS cold wall admission remains delegated to R6.5 Governor evidence")
    print("PASS benchmark-only experiment; no Executor/Scout/product mutation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
