#!/usr/bin/env python3
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")
CORE_PROTOCOL_SOURCES = (
    "execution-readiness-v1.mjs",
    "additive-mutation-v1.mjs",
    "obligation-bound-synthesis-v1.mjs",
    "additive-mutation-v2.mjs",
    "additive-mutation-v3.mjs",
    "python-additive-compiler-v1.mjs",
    "governor-latency-v1.mjs",
)
INTERFACE_SOURCES = PLUGIN + "\n" + "\n".join(
    (ROOT / "opencode/plugins/cpu-search-core" / name).read_text(encoding="utf-8")
    for name in CORE_PROTOCOL_SOURCES
)
SPEC = json.loads((ROOT / "contracts/interfaces-v1.json").read_text(encoding="utf-8"))
for key, value in SPEC["protocols"].items():
    assert f'"{value}"' in INTERFACE_SOURCES, (key, value)

for value in (
    "const MAX_MODEL_CALLS_PER_TURN = 4",
    "const MAX_EXECUTED_SEARCHES_PER_TURN = 4",
    "const MAX_PATCH_ATTEMPTS_PER_TURN = 2",
):
    assert value in PLUGIN, value

assert 'name: "execute_patch"' not in PLUGIN
markers = {
    "search": '        name: "search",',
    "execute_replace_node": "        name: EXECUTE_REPLACE_NODE_TOOL,",
    "execute_rename_symbol": "        name: EXECUTE_RENAME_SYMBOL_TOOL,",
    "execute_additive_plan": "        name: EXECUTE_ADDITIVE_PLAN_TOOL,",
}
for tool, contract in SPEC["model_tools"].items():
    i = PLUGIN.index(markers[tool])
    j = PLUGIN.index("\n        options:", i)
    schema = PLUGIN[i:j]
    assert "additionalProperties: false" in schema, tool
    for required in contract["required"]:
        assert required in schema, (tool, required)
    for forbidden in contract.get("forbidden", []):
        assert f"{forbidden}: {{" not in schema, (tool, forbidden)
    for required_marker in contract.get("required_markers", []):
        assert required_marker in schema, (tool, required_marker)
    for forbidden_marker in contract.get("forbidden_markers", []):
        assert forbidden_marker not in schema, (tool, forbidden_marker)

assert SPEC["budgets"]["execution_phase_wall_ms"] == 120_000
assert SPEC["budgets"]["task_wall_ms"] == 360_000
assert "export const GOVERNOR_MAX_ACTIVE_PHASES = 3" in INTERFACE_SOURCES
assert '"governor-latency-v1"' in INTERFACE_SOURCES
assert '"scout-additive-capability-v1"' in INTERFACE_SOURCES
assert '"additive-mutation-plan-v1"' in INTERFACE_SOURCES

assert SPEC["protocols"]["additive_host_binding"] == "typed-host-attestation-v2"
assert SPEC["protocols"]["additive_mutation_authority"] == "sealed-additive-handoff-v1"
assert SPEC["budgets"]["execution_phase_wall_kind"] == "adaptive_base"
assert SPEC["budgets"]["execution_phase_latency_margin_min_ms"] == 5_000
assert SPEC["budgets"]["execution_phase_latency_margin_max_ms"] == 15_000
assert SPEC["budgets"]["execution_phase_latency_margin_ratio"] == 0.10
assert '"typed-host-attestation-v2"' in INTERFACE_SOURCES
assert '"sealed-additive-handoff-v1"' in INTERFACE_SOURCES
assert "effectivePhaseBudgetMs" in INTERFACE_SOURCES

assert SPEC["protocols"]["additive_mutation_abi"] == "closed-additive-mutation-abi-v3"
assert SPEC["protocols"]["obligation_bound_synthesis"] == \
    "obligation-bound-synthesis-v1"
assert SPEC["protocols"]["time_semantics"] == "time-semantics-v1"
assert SPEC["protocols"]["additive_repair_hint"] == "additive-repair-hint-v1"
assert SPEC["budgets"]["additive_semantic_repair_attempts"] == 1
assert SPEC["model_tools"]["execute_additive_plan"]["required"] == ["python_imports", "python_declarations", "replacements", "creations"]
assert "operations: {" in SPEC["model_tools"]["execute_additive_plan"]["forbidden_markers"]
assert 'required: ["operations"]' in SPEC["model_tools"]["execute_additive_plan"]["forbidden_markers"]
assert '"closed-additive-mutation-abi-v1"' in INTERFACE_SOURCES
assert '"closed-additive-mutation-abi-v2"' in INTERFACE_SOURCES
assert '"closed-additive-mutation-abi-v3"' in INTERFACE_SOURCES
assert '"obligation-bound-synthesis-v1"' in INTERFACE_SOURCES
assert '"time-semantics-v1"' in INTERFACE_SOURCES
assert '"typed-python-additive-compiler-v1"' in INTERFACE_SOURCES
assert SPEC["protocols"]["python_ir_canonicalizer"] == "python-ir-canonicalizer-v1"
assert SPEC["protocols"]["runtime_cost_observation"] == "runtime-cost-observation-v1"
assert '"runtime-cost-observation-v1"' in INTERFACE_SOURCES
assert '"python-ir-canonicalizer-v1"' in INTERFACE_SOURCES
assert '"candidate-static-preflight-v1"' in INTERFACE_SOURCES
assert '"additive-repair-hint-v1"' in INTERFACE_SOURCES
assert "relative_path" in INTERFACE_SOURCES
assert "additive_repair_authority_drift" in INTERFACE_SOURCES

print("PASS interface-freeze-v1")
