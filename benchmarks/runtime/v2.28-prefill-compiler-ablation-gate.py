#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import inspect as pyinspect
import importlib.util
import json
import sys
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "benchmarks/runtime/v2.28-prefill-compiler-ablation.py"
MV = ROOT / "benchmarks/runtime/v2.28-model-viability.py"
LADDER = ROOT / "benchmarks/runtime/v2.28-inference-viability-ladder.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    bench = load(BENCH, "prefill_bench_gate")
    mv = load(MV, "prefill_mv_gate")
    ladder = load(LADDER, "prefill_ladder_gate")

    task_prompt = "Add an export page and endpoint for a date range."
    task_sha = hashlib.sha256(task_prompt.encode("utf-8")).hexdigest()
    raw_request = {
        "system": [
            "NOISY_CAPTURED_CONTEXT slot=existing:0 family=python_declarations "
            "slot=existing:1 family=replacements slot=create:0 family=creations "
            "authority hashes and verbose provenance that the model should not need."
        ],
        "messages": [{"role": "user", "content": task_prompt}],
        "tools": {
            "execute_additive_plan": {
                "description": "A deliberately verbose current ABI for the synthetic gate.",
                "input": {
                    "type": "object",
                    "properties": {
                        "python_declarations": {
                            "type": "array",
                            "description": "server_surface existing:0 python_declaration content",
                            "items": {"type": "object", "properties": {"content": {"type": "string"}}},
                        },
                        "replacements": {
                            "type": "array",
                            "description": "navigation_integration existing:1 replacement before after",
                            "items": {"type": "object", "properties": {"before": {"type": "string"}, "after": {"type": "string"}}},
                        },
                        "creations": {
                            "type": "array",
                            "description": "ui_surface create:0 creation content",
                            "items": {"type": "object", "properties": {"content": {"type": "string"}}},
                        },
                    },
                },
            },
        },
    }
    fixture = {
        "protocol": getattr(mv, "FIXTURE_PROTOCOL"),
        "source": {"task_text_sha256": task_sha},
        "request_sha256": mv.sha256_json(raw_request),
        "request": raw_request,
    }
    spec = {
        "protocol": getattr(mv, "SPEC_PROTOCOL"),
        "task_id": "synthetic",
        "expected_task_text_sha256": task_sha,
        "current_tool_name": "execute_additive_plan",
        "constrained_tool_name": "submit_required_operation_content",
        "obligations": [
            {
                "id": "server_surface",
                "family": "python_declarations",
                "slot": "existing:0",
                "operation": "python_declaration",
                "constrained_fields": ["content"],
            },
            {
                "id": "navigation_integration",
                "family": "replacements",
                "slot": "existing:1",
                "operation": "replacement",
                "constrained_fields": ["before", "after"],
            },
            {
                "id": "ui_surface",
                "family": "creations",
                "slot": "create:0",
                "operation": "creation",
                "constrained_fields": ["content"],
            },
        ],
    }

    with tempfile.TemporaryDirectory(prefix="prefill-gate-") as td:
        task_path = Path(td) / "task.json"
        task_path.write_text(json.dumps({"id": "synthetic", "prompt": task_prompt}), encoding="utf-8")
        loaded_prompt = bench.load_task_prompt(task_path, "synthetic", task_sha)
        assert loaded_prompt == task_prompt
        bench.validate_identity(fixture, spec, task_prompt)

    ir = bench.model_ir(spec)
    assert [row["handle"] for row in ir["ops"]] == ["S0", "S1", "C0"]
    assert all(key.startswith("compact:") for key in ir["selected_render_atom_keys"])
    assert "slot:server_surface:existing:0" in ir["machine_enforced_facts"]
    assert "family:server_surface:python_declarations" in ir["machine_enforced_facts"]
    assert "slot:server_surface:existing:0" not in ir["required_model_facts"]

    variants, meta = bench.build_variants(
        mv,
        ladder,
        fixture,
        spec,
        task_prompt,
        {"temperature": 0.0, "model": "synthetic"},
        max_tokens=1,
        cache_prompt=False,
    )
    assert list(variants) == [
        "A_exact_current",
        "B_renderer_only",
        "C_projection_only",
        "D_projection_renderer",
    ]
    assert meta["compact_tool_sha256"] == bench.sha256_json(bench.compact_tool())

    shape_source = pyinspect.getsource(bench.variant_shape)
    assert "run_probe" not in shape_source
    assert "render_token_shape" in shape_source
    assert bench.server_endpoint(
        "http://127.0.0.1:8080/v1/chat/completions",
        "/tokenize",
    ) == "http://127.0.0.1:8080/tokenize"
    template_payload = bench.apply_template_payload(variants["D_projection_renderer"])
    assert template_payload["add_generation_prompt"] is True
    assert template_payload["messages"] == variants["D_projection_renderer"]["messages"]
    assert template_payload["tools"] == variants["D_projection_renderer"]["tools"]
    assert "max_tokens" not in template_payload
    assert "cache_prompt" not in template_payload

    inspect = bench.inspect_payload(mv, ladder, fixture, spec, task_prompt)
    assert inspect["variants"]["D_projection_renderer"]["structural_coverage"]["complete"] is True
    assert inspect["variants"]["C_projection_only"]["structural_coverage"]["complete"] is True
    d_serialized = bench.canonical_json(variants["D_projection_renderer"])
    assert "existing:0" not in d_serialized
    assert "existing:1" not in d_serialized
    assert "create:0" not in d_serialized
    assert "python_declarations" not in d_serialized
    assert "replacements" not in d_serialized
    assert "creations" not in d_serialized
    for token in ["S0", "S1", "C0", "server_surface", "navigation_integration", "ui_surface"]:
        assert token in d_serialized

    good = {
        "ops": [
            {"h": "S0", "content": "route"},
            {"h": "S1", "before": "old", "after": "new"},
            {"h": "C0", "content": "page"},
        ]
    }
    valid, errors, accepted = bench.validate_compact_args(good, ir)
    assert valid is True and errors == [] and accepted == ["S0", "S1", "C0"]

    invalid_unknown = {"ops": [{"h": "S9", "content": "x"}]}
    assert bench.validate_compact_args(invalid_unknown, ir)[0] is False
    invalid_missing = {"ops": [{"h": "S0", "content": "route"}]}
    assert bench.validate_compact_args(invalid_missing, ir)[0] is False
    invalid_extra = {
        "ops": [
            {"h": "S0", "content": "route", "before": "unauthorized"},
            {"h": "S1", "before": "old", "after": "new"},
            {"h": "C0", "content": "page"},
        ]
    }
    assert bench.validate_compact_args(invalid_extra, ir)[0] is False

    ts0 = bench.build_turn_body(
        ladder,
        {"temperature": 0.0, "model": "synthetic"},
        task_prompt,
        ir,
        "S0",
        max_tokens=32,
    )
    ts1 = bench.build_turn_body(
        ladder,
        {"temperature": 0.0, "model": "synthetic"},
        task_prompt,
        ir,
        "S1",
        max_tokens=32,
    )
    assert ts0["cache_prompt"] is True and ts1["cache_prompt"] is True
    assert bench.sha256_json(ts0["tools"]) == bench.sha256_json(ts1["tools"])
    assert bench.sha256_json(ts0["messages"][:1]) == bench.sha256_json(ts1["messages"][:1])
    assert ts0["messages"][1]["content"] != ts1["messages"][1]["content"]
    assert bench.TURN_TOOL_NAME == "emit_fields"
    turn_schema = bench.turn_tool()["function"]["parameters"]
    assert "h" not in turn_schema.get("properties", {})
    assert "ops" not in turn_schema.get("properties", {})
    ladder_source = pyinspect.getsource(ladder.StreamingRequest.execute)
    assert "tool_argument_prefix" in ladder_source
    assert "tool_argument_suffix" in ladder_source
    assert "tool_argument_sha256" in ladder_source

    valid_turn, turn_errors, turn_payload = bench.validate_turn_args(
        {"content": "def export_report():\n    return 'ok'\n"},
        ir,
        "S0",
    )
    assert valid_turn is True and turn_errors == []
    assert "content" in turn_payload

    echo_turn = bench.validate_turn_args(
        {"content": "S0 server_surface python_declaration content"},
        ir,
        "S0",
    )
    assert echo_turn[0] is False
    assert any(error.startswith("projection_echo:S0:content") for error in echo_turn[1])

    identity_leak = bench.validate_turn_args(
        {"h": "S0", "content": "def export_report():\n    return 'ok'\n"},
        ir,
        "S0",
    )
    assert identity_leak[0] is False
    assert "turn_identity_must_be_out_of_band" in identity_leak[1]

    invalid_python = bench.validate_turn_args(
        {"content": "server_surface"},
        ir,
        "S0",
    )
    assert invalid_python[0] is False

    reversed_tool = json.loads(json.dumps(bench.COMPACT_TOOL))
    assert bench.sha256_json(bench.canonicalize(reversed_tool)) == bench.sha256_json(bench.compact_tool())
    reversed_turn_tool = json.loads(json.dumps(bench.TURN_TOOL))
    assert bench.sha256_json(bench.canonicalize(reversed_turn_tool)) == bench.sha256_json(bench.turn_tool())

    atoms = bench.render_candidates(bench.allocate_handles(spec))
    pruned = bench.prune_dominated_atoms(atoms)
    chosen = bench.greedy_weighted_set_cover(bench.required_model_facts(bench.allocate_handles(spec)), pruned)
    assert len(chosen) == 3
    assert all(atom.key.startswith("compact:") for atom in chosen)

    selected = bench._selected_turn_rows(ir, ["S0"])
    assert [row["handle"] for row in selected] == ["S0"]
    try:
        bench._selected_turn_rows(ir, ["S9"])
    except RuntimeError:
        pass
    else:
        raise AssertionError("unknown diagnostic handle must fail closed")

    synthetic_model = {
        "name": "synthetic-model",
        "model": "synthetic",
        "url": "http://127.0.0.1:8080/v1/chat/completions",
    }
    synthetic_candidate_summary = {
        "protocol": bench.PROTOCOL,
        "fixture_request_sha256": fixture["request_sha256"],
        "task_text_sha256": task_sha,
        "model_name": synthetic_model["name"],
        "model": synthetic_model["model"],
        "url": synthetic_model["url"],
        "candidate_D": {
            "status": "timeout",
            "stage_at_end": "tool_args_decode",
            "ttft_ms": 1234.0,
            "validation_errors": ["ops_not_array"],
            "accepted_handles": [],
            "valid_candidate_within_budget": False,
        },
    }
    with tempfile.TemporaryDirectory(prefix="prefill-r3-gate-") as tmp:
        evidence_path = Path(tmp) / "summary.json"
        evidence_path.write_text(
            json.dumps(synthetic_candidate_summary) + "\n",
            encoding="utf-8",
        )
        reused = bench.load_candidate_evidence(
            evidence_path,
            fixture_request_sha256=fixture["request_sha256"],
            task_text_sha256=task_sha,
            model=synthetic_model,
        )
        assert reused["validation_status"] == "not_evaluated_incomplete_stream"
        assert reused["semantic_validation_applicable"] is False
        assert reused["validation_errors"] == []
        assert reused["prior_partial_stream_validation_errors"] == ["ops_not_array"]

        bad = dict(synthetic_candidate_summary)
        bad["fixture_request_sha256"] = "0" * 64
        evidence_path.write_text(json.dumps(bad) + "\n", encoding="utf-8")
        try:
            bench.load_candidate_evidence(
                evidence_path,
                fixture_request_sha256=fixture["request_sha256"],
                task_text_sha256=task_sha,
                model=synthetic_model,
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError("candidate evidence identity mismatch must fail closed")

    assert bench.choose_decision([
        "PROJECTION_STRUCTURAL_REDUCTION",
        "COMBINED_PREFILL_COMPILER_TOKEN_WIN",
        "PROJECTED_MODEL_IR_REACHES_DECODE",
        "MONOLITHIC_D_CENSORED_DURING_TOOL_ARGS",
    ]) == "MONOLITHIC_D_CENSORED_DURING_TOOL_ARGS"
    assert bench.choose_decision([
        "COMBINED_PREFILL_COMPILER_TOKEN_WIN",
        "TURN_SPLIT_SYNTHESIS_CONTRACT_SUPPORTED",
    ]) == "TURN_SPLIT_SYNTHESIS_CONTRACT_SUPPORTED"
    assert bench.choose_decision([
        "MONOLITHIC_D_CENSORED_DURING_TOOL_ARGS",
        "TURN_SPLIT_DECODE_BUDGET_EXHAUSTED_BEFORE_PARSE",
    ]) == "TURN_SPLIT_DECODE_BUDGET_EXHAUSTED_BEFORE_PARSE"
    assert bench.choose_decision([
        "TURN_SPLIT_SELECTED_TURN_CONTRACT_SUPPORTED",
        "TURN_SPLIT_SHAPE_REDUCTION_NEGLIGIBLE",
    ]) == "TURN_SPLIT_SELECTED_TURN_CONTRACT_SUPPORTED"

    turn_shape_source = pyinspect.getsource(bench.projected_turn_shape_pass)
    assert "run_probe" not in turn_shape_source
    assert "variant_shape" in turn_shape_source
    assert "material_turn_shape_reduction" in turn_shape_source

    split_source = pyinspect.getsource(bench.run_projected_turn_split)
    assert "validate_turn_args" in split_source
    assert "validate_compact_args" not in split_source
    assert "turn_identity_authority" in split_source
    assert "candidate_validity_authority" in split_source
    assert "semantic_validation_applicable" in split_source
    assert "decode_budget_exhausted_before_parse" in split_source
    assert "selected_turn_contract_complete_within_budget" in split_source
    assert "cross_turn_cache_reuse_observed" in split_source

    print("PASS bounded partial tool-argument evidence is retained without changing inference")
    print("PASS length-censored tool JSON is classified as decode-budget exhaustion, not contract rejection")
    print("PASS diagnostic turn subsets are orchestrator-selected and cannot claim full contract completion")
    print("PASS first-stage ambient cache is separated from cross-turn cache reuse evidence")
    print("PASS immutable candidate evidence reuse is identity-bound")
    print("PASS incomplete streamed tool args are not semantically validated")
    print("PASS deterministic turn-shape admission precedes Turn-Splitting inference")
    print("PASS turn identity is orchestrator-owned and absent from model output schema")
    print("PASS projection echoes and trivial Python declarations fail closed")
    print("PASS Turn-Splitting contract completion is not mislabeled VERIFIED candidate validity")
    print("PASS negligible turn-shape reduction is separated from material reduction")
    print("PASS decision precedence reports the strongest causal signal")
    print("PASS exact task SHA is the projection root")
    print("PASS deterministic handle allocation S0/S1/C0")
    print("PASS machine-enforced slot/family facts are excluded from Model IR requirements")
    print("PASS dominance pruning + weighted set cover select compact render atoms")
    print("PASS canonical stable tool schema is task-topology independent")
    print("PASS A/B/C/D ablation variants build deterministically")
    print("PASS tokenizer-only shape pass uses /apply-template + /tokenize without inference")
    print("PASS shape pass excludes decode/cache parameters from template projection")
    print("PASS compact projection structurally covers all obligations")
    print("PASS reverse mapping rejects unknown/missing/unauthorized payload")
    print("PASS stateless Turn-Splitting keeps stable system/tool prefix and cache_prompt=true")
    print("PASS benchmark-only contract; product mutation authority unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
