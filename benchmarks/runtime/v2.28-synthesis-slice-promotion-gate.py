#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import importlib.util
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "benchmarks/runtime/v2.28-synthesis-slice-promotion.py"
PREFILL = ROOT / "benchmarks/runtime/v2.28-prefill-compiler-ablation.py"
MV = ROOT / "benchmarks/runtime/v2.28-model-viability.py"
LADDER = ROOT / "benchmarks/runtime/v2.28-inference-viability-ladder.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {name}")
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def make_fixture(mv, source_lines: list[str], anchors: list[int], task_prompt: str) -> tuple[dict, dict, str]:
    context = "\n".join([
        "<<<OPENCODE_DETERMINISTIC_CONTEXT_BEGIN producer=deterministic_scout>>>",
        "EXECUTION tool=execute_additive_plan operation=additive_surface",
        f"EXISTING slot=existing:0 file=routes/sample.py operation=replace_exact roles=route_owner anchors={','.join(map(str, anchors))}",
        f"SOURCE file=routes/sample.py level=statement anchors={','.join(map(str, anchors))}",
        *[f"{line}|{source_lines[line - 1]}" for line in anchors],
        "<<<OPENCODE_DETERMINISTIC_CONTEXT_END>>>",
    ])
    task_sha = hashlib.sha256(task_prompt.encode()).hexdigest()
    raw_request = {
        "system": [context],
        "messages": [{"role": "user", "content": task_prompt}],
        "tools": {"execute_additive_plan": {"description": "synthetic", "input": {"type": "object"}}},
    }
    fixture = {
        "protocol": mv.FIXTURE_PROTOCOL,
        "source": {"task_text_sha256": task_sha},
        "request_sha256": mv.sha256_json(raw_request),
        "request": raw_request,
    }
    spec = {
        "protocol": mv.SPEC_PROTOCOL,
        "task_id": "synthetic",
        "expected_task_text_sha256": task_sha,
        "current_tool_name": "execute_additive_plan",
        "constrained_tool_name": "submit_required_operation_content",
        "obligations": [{
            "id": "server_surface",
            "family": "python_declarations",
            "slot": "existing:0",
            "operation": "python_declaration",
            "constrained_fields": ["content"],
        }],
    }
    return fixture, spec, context


def main() -> int:
    bench = load(BENCH, "slice_gate_r65")
    prefill = load(PREFILL, "slice_gate_prefill_r65")
    mv = load(MV, "slice_gate_mv_r65")
    _ladder = load(LADDER, "slice_gate_ladder_r65")

    # Deliberately recreate the R6 failure shape: a short body-anchored page declaration
    # and a longer declaration whose decorator/head anchor plus task overlap make it
    # synthesis-relevant. Cost alone must never make the short declaration win.
    source = '''from toolkit import make_host, request_value, send_blob, unused_symbol
from store import fetch_rows
host = make_host()

@host.get("/page")
def page_view():
    value = request_value("id")
    return value


def helper(report_date):
    SECRET_IMPLEMENTATION_DETAIL = "must-not-enter-signature-projection"
    return fetch_rows(report_date, SECRET_IMPLEMENTATION_DETAIL)

@host.post("/download")
def export_report():
    report_date = request_value("report_date")
    rows = helper(report_date)
    unrelated_counter = 0
    for item in range(100):
        unrelated_counter += item
    UNRELATED_BODY_NOISE = str(unrelated_counter) * 20
    return send_blob(rows, filename="report.xlsx")
'''
    lines = source.splitlines()
    anchors = [1, 7, 15]
    assert lines[0].startswith("from toolkit import")
    assert lines[6] == '    value = request_value("id")'
    assert lines[14] == '@host.post("/download")'
    task_prompt = "Add a bounded report_date export download declaration using the existing send_blob and data access pattern."
    fixture, spec, context = make_fixture(mv, lines, anchors, task_prompt)

    with tempfile.TemporaryDirectory(prefix="slice-gate-r64-") as td:
        root = Path(td)
        source_path = root / "routes/sample.py"
        source_path.parent.mkdir(parents=True)
        source_path.write_text(source, encoding="utf-8")

        compiled = bench.compile_python_slice(
            mv=mv,
            prefill=prefill,
            fixture=fixture,
            spec=spec,
            task_prompt=task_prompt,
            source_repo=root,
            handle="S0",
            max_bytes=4096,
            max_declarations=1,
            dependency_depth=1,
        )
        assert compiled["protocol"] == "source-validated-synthesis-slice-v1.5"
        assert compiled["authority"] == "source_validated_exact_anchor_lines"
        assert compiled["ranking_authority"] is False
        assert compiled["mutation_authority"] is False
        assert compiled["validated_anchor_lines"] == anchors
        assert compiled["file_sha256"] == hashlib.sha256(source.encode()).hexdigest()

        req = compiled["synthesis_requirements"]
        assert req["protocol"] == "synthesis-requirement-ir-v1.1"
        assert "pattern:declaration_head_anchor" in req["hard_facts"]
        assert "task:overlap" in req["hard_facts"]
        selection = compiled["selection"]
        assert selection["protocol"] == "budgeted-evidence-selection-v1.2"
        assert selection["missing_hard_facts"] == []
        assert selection["selection_algorithm"] == "lexicographic_hard_then_weighted_coverage_then_density"

        selected = compiled["selected_declarations"]
        assert len(selected) == 1
        assert selected[0]["name"] == "export_report", selected
        assert tuple(selected[0]["head_anchor_lines"]) == (15,)
        assert "report_date" in selected[0]["lexical_hits"]
        assert "download" in selected[0]["lexical_hits"]
        assert compiled["rendered"].find("export_report") >= 0
        assert compiled["rendered"].find("page_view") < 0
        assert compiled["selection"]["statement_slicing"]["algorithm"] == "bounded_statement_fact_cover_plus_frontier_dataflow"
        atoms = compiled["evidence_atoms"]
        assert any(row["kind"] == "declaration_header" and row["label"] == "export_report" for row in atoms)
        assert any("report_date" in row["source"] for row in atoms if row["kind"] == "statement")
        assert any("send_blob" in row["source"] for row in atoms if row["kind"] == "statement")

        # Whole-body noise is not model-facing: statement slicing is AST-complete and task/dataflow driven.
        rendered = compiled["rendered"]
        assert "UNRELATED_BODY_NOISE" not in rendered
        assert "unrelated_counter" not in rendered
        assert "unused_symbol" not in rendered
        assert "send_blob" in rendered
        assert "request_value" in rendered
        assert "host = make_host()" in rendered
        # Referenced helper is visible only as a declaration signature, not its body.
        assert "def helper(report_date):" in rendered
        assert "SECRET_IMPLEMENTATION_DETAIL" not in rendered
        helper_deps = [row for row in compiled["dependencies"] if "helper" in row["symbols"]]
        assert helper_deps and helper_deps[0]["projection"] == "signature_only"
        constraints = compiled["synthesis_requirements"]["task_constraints"]
        assert constraints["protocol"] == "task-constraint-ir-v1"
        assert "report_date" in constraints["identifier_terms"]

        # Compilation is deterministic.
        compiled2 = bench.compile_python_slice(
            mv=mv, prefill=prefill, fixture=fixture, spec=spec, task_prompt=task_prompt,
            source_repo=root, handle="S0", max_bytes=4096, max_declarations=1, dependency_depth=1,
        )
        assert compiled2["rendered_sha256"] == compiled["rendered_sha256"]
        assert compiled2["selection"] == compiled["selection"]

        stress_source = "\n".join([
            "from toolkit import host, request_value, send_blob",
            "from io import BytesIO",
            "import pandas as pd",
            "",
            "@host.post(\"/download\")",
            "def export_report():",
            "    report_date = request_value(\"report_date\")",
            "    rows = fetch_rows(report_date)",
            "    columns = build_columns(rows)",
            "    data = normalize_rows(rows, columns)",
            "    frame = pd.DataFrame(data, columns=columns)",
            "    buf = BytesIO()",
            "    frame.to_excel(buf, index=False)",
            "    buf.seek(0)",
            "    name = f\"report_{report_date}.xlsx\"",
            "    audit = make_audit(rows)",
            "    emit_audit(audit)",
            "    touch_metrics(rows)",
            "    return send_blob(buf, filename=name)",
        ]) + "\n"
        stress_lines = stress_source.splitlines()
        stress_anchors = [5]
        stress_task = "Add a bounded report_date xlsx download declaration using the existing send_blob pattern."
        stress_fixture, stress_spec, _stress_context = make_fixture(mv, stress_lines, stress_anchors, stress_task)
        source_path.write_text(stress_source, encoding="utf-8")
        stress = bench.compile_python_slice(
            mv=mv, prefill=prefill, fixture=stress_fixture, spec=stress_spec, task_prompt=stress_task,
            source_repo=root, handle="S0", max_bytes=4096, max_declarations=1, dependency_depth=1,
            max_statement_atoms=7, statement_dataflow_depth=2,
        )
        plan = stress["selection"]["statement_slicing"]["plans"][0]
        assert len(plan["selected_indices"]) <= 7, plan
        assert plan["missing_hard_facts"] == []
        assert "report_date" in stress["rendered"]
        assert "send_blob" in stress["rendered"]
        assert isinstance(plan["frontier_symbols"], list)
        source_path.write_text(source, encoding="utf-8")

        # Output authority is bounded by operation contract, not by prompt prose.
        ir = prefill.model_ir(spec)
        row, obligation = bench.obligation_for_handle(prefill, spec, "S0")
        kinds = bench.allowed_python_declaration_kinds(row, obligation)
        good = bench.validate_exact_python_declaration(
            {"content": "@host.post('/new')\ndef new_report():\n    return send_blob([])\n"},
            ["content"], "S0", kinds,
        )
        assert good[0] is True and good[1] == []
        bad_import = bench.validate_exact_python_declaration(
            {"content": "from x import y\n\ndef f():\n    return y\n"},
            ["content"], "S0", kinds,
        )
        assert bad_import[0] is False
        bad_multi = bench.validate_exact_python_declaration(
            {"content": "def a():\n    pass\n\ndef b():\n    pass\n"},
            ["content"], "S0", kinds,
        )
        assert bad_multi[0] is False

        text = bench.grounded_turn_text(prefill, task_prompt, ir, "S0", compiled)
        assert "PY_SOURCE routes/sample.py" in text
        assert "do not reconstruct a standalone application/module." in text
        assert task_prompt not in text
        assert "sha256=" not in compiled["model_view"]
        assert "AUTHORITY" not in compiled["model_view"]
        assert "EVIDENCE kind=" not in compiled["model_view"]
        assert "DEPENDENCY kind=" not in compiled["model_view"]
        assert "export_report" in compiled["model_view"]
        assert compiled["model_view_bytes"] < compiled["rendered_bytes"]
        common = bench.common_task_contract(prefill, task_prompt)
        assert task_prompt in common
        assert "SOURCE_SLICE" not in common
        assert bench.token_lcp([1, 2, 3], [1, 2, 4]) == 2

        # Cost regimes must not mix warm fixed overhead into cold per-token economics.
        synthetic_profile = bench.compile_prefill_cost_profile_from_docs_for_gate([
            {
                "shape": {"prompt_tokens_observed": 600},
                "result": {
                    "status": "complete", "wall_s": 70.0, "ttft_ms": 62000.0,
                    "server_progress": {"first_decode_progress_ms": 60000.0, "max_prompt_tokens_cache": 0, "max_decoded": 10},
                    "timings": {"predicted_per_token_ms": 120.0}, "request_sha256": "cold-complete",
                },
            },
            {
                "shape": {"prompt_tokens_observed": 593},
                "result": {
                    "status": "complete", "wall_s": 3.0, "ttft_ms": 1500.0,
                    "server_progress": {"first_decode_progress_ms": 1500.0, "max_prompt_tokens_cache": 588, "max_decoded": 2},
                    "timings": {"predicted_per_token_ms": 125.0}, "request_sha256": "resident-complete",
                },
            },
            {
                "shape": {"prompt_tokens_observed": 1000},
                "result": {
                    "status": "timeout", "wall_s": 90.0,
                    "server_progress": {"first_decode_progress_ms": None, "max_prompt_tokens_cache": 0, "max_decoded": 0},
                    "request_sha256": "cold-censored",
                },
            },
        ])
        assert synthetic_profile["protocol"] == "empirical-prefill-cost-profile-v2.1"
        assert synthetic_profile["regimes"]["cold"]["completed_count"] == 1
        assert synthetic_profile["regimes"]["resident_partial"]["completed_count"] == 1
        assert "prefill_ms_per_uncached_token_upper" not in synthetic_profile

        # A completed one-token prime can legitimately miss live-slot decode polling.
        # Final usage + exact prompt accounting + first_event is a conservative proof
        # that prefill completed; its one-token decode timing must not enter decode cost.
        prime_without_live_decode = {
            "status": "complete", "stage_at_end": "complete", "done_marker": True,
            "wall_s": 51.2, "first_event_ms": 51100.0, "ttft_ms": None,
            "usage": {
                "prompt_tokens": 601, "completion_tokens": 1,
                "prompt_tokens_details": {"cached_tokens": 102},
            },
            "timings": {
                "cache_n": 102, "prompt_n": 499, "prompt_ms": 50700.0,
                "predicted_n": 1, "predicted_ms": 0.001, "predicted_per_token_ms": 0.0,
            },
            "server_progress": {
                "first_decode_progress_ms": None, "max_prompt_tokens_cache": 102, "max_decoded": 0,
            },
            "request_sha256": "prime-no-live-decode",
        }
        prime_obs = bench.result_cost_observation(prime_without_live_decode, 601, "gate:prime")
        assert bench.prime_prefill_completion_proven(prime_without_live_decode, prime_obs) is True
        assert prime_obs["prefill_complete_ms"] == 51100.0
        assert prime_obs["prefill_complete_authority"] == "completed_stream_first_event_with_exact_prompt_accounting"
        assert prime_obs["prefill_complete_is_upper_bound"] is True
        assert prime_obs["decode_ms_per_token"] is None
        broken_prime = copy.deepcopy(prime_without_live_decode)
        broken_prime["usage"]["completion_tokens"] = 0
        broken_obs = bench.result_cost_observation(broken_prime, 601, "gate:broken-prime")
        assert bench.prime_prefill_completion_proven(broken_prime, broken_obs) is False
        cold_500 = bench.empirical_prefill_interval(synthetic_profile, uncached_tokens=500, regime="cold")
        assert cold_500["safe_upper_bound_available"] is True
        assert cold_500["upper_bound_ms"] == 60000.0
        cold_800 = bench.empirical_prefill_interval(synthetic_profile, uncached_tokens=800, regime="cold")
        assert cold_800["safe_upper_bound_available"] is False
        admission = bench.prefill_wall_admission(
            synthetic_profile, uncached_tokens=500, regime="cold", min_output_tokens=64,
            requested_max_output_tokens=384, wall_budget_s=100.0, safety_factor=1.1,
        )
        assert admission["admitted"] is True, admission
        assert 64 <= admission["derived_max_output_tokens"] < 384
        reject = bench.prefill_wall_admission(
            synthetic_profile, uncached_tokens=800, regime="cold", min_output_tokens=64,
            requested_max_output_tokens=384, wall_budget_s=120.0, safety_factor=1.1,
        )
        assert reject["admitted"] is False
        assert "missing_cold_prefill_safe_upper_bound" in reject["reasons"]

        fake_contract = {
            "potential_shared_prefix_tokens": 588, "total_prompt_tokens": 865,
            "cache_contract_identity_sha256": "contract-id", "shared_prefix_token_ids_sha256": "prefix-id",
        }
        fake_result = {
            "status": "complete", "ttft_ms": 25000.0,
            "server_progress": {"first_decode_progress_ms": 24000.0, "max_prompt_tokens_cache": 584, "max_decoded": 1},
        }
        residency = bench.residency_evaluation(fake_contract, fake_result, 8)
        assert residency["proof"] is True
        assert residency["required_cached_tokens"] == 580
        fake_result["server_progress"]["max_prompt_tokens_cache"] = 100
        assert bench.residency_evaluation(fake_contract, fake_result, 8)["proof"] is False

        # Hard synthesis facts are fail-closed; do not silently fall back to a cheaper irrelevant declaration.
        try:
            bench.select_declarations(
                [bench.DeclarationCandidate(**selected[0])],
                {
                    "hard_facts": ["pattern:validated_anchor", "task:overlap", "pattern:declaration_head_anchor", "missing:required"],
                    "weighted_facts": {},
                },
                1,
                4096,
            )
        except RuntimeError as exc:
            assert "required synthesis facts not covered" in str(exc)
        else:
            raise AssertionError("missing hard synthesis fact must fail closed")

        # Source drift remains a pre-inference hard failure.
        source_path.write_text(source.replace('value = request_value("id")', 'value = request_value("other")'), encoding="utf-8")
        try:
            bench.compile_python_slice(
                mv=mv, prefill=prefill, fixture=fixture, spec=spec, task_prompt=task_prompt,
                source_repo=root, handle="S0", max_bytes=4096, max_declarations=1, dependency_depth=1,
            )
        except RuntimeError as exc:
            assert "source drift" in str(exc)
        else:
            raise AssertionError("source drift must fail closed")

        # Path confinement remains hard authority boundary.
        evil_context = context.replace("file=routes/sample.py", "file=../sample.py")
        evil_request = dict(fixture["request"])
        evil_request["system"] = [evil_context]
        evil_fixture = dict(fixture)
        evil_fixture["request"] = evil_request
        evil_fixture["request_sha256"] = mv.sha256_json(evil_request)
        try:
            bench.compile_python_slice(
                mv=mv, prefill=prefill, fixture=evil_fixture, spec=spec, task_prompt=task_prompt,
                source_repo=root, handle="S0", max_bytes=4096, max_declarations=1, dependency_depth=1,
            )
        except RuntimeError as exc:
            assert "unsafe source path" in str(exc) or "escapes root" in str(exc)
        else:
            raise AssertionError("path escape must fail closed")

    source_text = BENCH.read_text(encoding="utf-8")
    for forbidden in ["FastAPI", "APIRouter", "Blueprint(", "@app.route", "@router.get", "xlsx_report", "bestsellers"]:
        assert forbidden not in source_text, f"repository/framework tuning leaked into benchmark: {forbidden}"

    for required in [
        "synthesis_requirement_ir",
        "task_constraint_ir",
        "select_declarations",
        "statement_slice_plan",
        "selected_statement_indices",
        "declaration_evidence_atoms",
        "anchor_symbol_use_atoms",
        "dependency_atoms_for_evidence",
        "fit_slice_to_prompt_budget",
        "evidence_prune_order",
        "bounded_statement_fact_cover_plus_frontier_dataflow",
        "server_tokenizer_prompt_budget",
        "render_model_view",
        "deterministic-prefix-cache-contract-v2",
        "empirical-prefill-cost-profile-v2.1",
        "prefill-wall-admission-v2",
        "same_regime_monotone_empirical_envelope",
        "runtime-prefix-residency-proof-v1",
        "PREFIX_PRIME_PREFILL_INCOMPLETE",
        "prefill-cost-observation-v2.1",
        "completed_stream_first_event_with_exact_prompt_accounting",
        "prime_prefill_completion_proven",
        "credit_requires_current_runtime_residency_authority",
        "BENCHMARK_ENVIRONMENT_DIRTY_PREFLIGHT",
    ]:
        assert required in source_text, f"R6.3 algorithm marker missing: {required}"

    print("PASS source authority / drift / path confinement retained")
    print("PASS SynthesisRequirementIR retains hard/weighted selection and explicit TaskConstraintIR")
    print("PASS declaration selector still defeats cheap irrelevant exemplar")
    print("PASS declaration-head/task evidence remains generic and source authority stays exact-anchor based")
    print("PASS dependencies are derived from model-visible AST atoms rather than whole declaration bodies")
    print("PASS helper/class dependencies remain signature-only and body noise is omitted by statement slicing")
    print("PASS statement atom budget is admission-aware; transitive closure becomes explicit frontier")
    print("PASS optional statement support can be pruned by real server-tokenizer budget")
    print("PASS exact-one-declaration output contract retained")
    print("PASS no repository/framework-specific tuning")
    print("PASS compact model view separates machine provenance from model-facing source")
    print("PASS deterministic token-LCP is separated from runtime residency proof and grants no historical cache credit")
    print("PASS regime-separated empirical envelope avoids warm/cold cost mixing and rejects unsupported extrapolation")
    print("PASS completed one-token prime can prove prefill from final stream accounting when live-slot polling misses decode")
    print("PASS one-token prime decode telemetry cannot contaminate decode-rate envelope")
    print("PASS dynamic decode budget is derived from remaining wall; residency probe keeps priming cost separate and idle barriers fail closed")
    print("PASS benchmark-only scope retained; no product/Scout mutation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
