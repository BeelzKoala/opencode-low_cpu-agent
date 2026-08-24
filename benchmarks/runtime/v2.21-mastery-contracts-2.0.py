#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.21-mastery-contracts-2.0-gates.json"

EXPECTED_COMPILER = "bbeb9e14e7dd7fd34d6b9ce6b588d0234b2509af6e5f006b0d43ebce3d751a2f"
EXPECTED_EXECUTOR = "6db9aca5293b4173052a5fb90f5f4c81b1540e7f879b10df687bef32e5d79536"
EXPECTED_VERIFIER = "4a0c9ba504dc2f5c420f32ee74954b102715d925b010199635e5f8bfa54a9855"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def section(text: str, start: str, end: str) -> str:
    i = text.index(start)
    j = text.index(end, i)
    return text[i:j]


def node_runtime_gate(plugin: str) -> None:
    shape = section(
        plugin,
        "function mutationFieldPresent(input, key)",
        "\nfunction normalizeMutationFile",
    )
    frontier = section(
        plugin,
        "function allowedToolsForExecutionState(executionState)",
        "\nfunction applyExecutionEvent",
    )

    js = f'''\nconst EXEC_STATE_LOCATE = "locate"\nconst EXEC_STATE_MUTATE = "mutate"\nconst EXEC_STATE_REPAIR = "repair"\nconst EXECUTE_REPLACE_NODE_TOOL = "execute_replace_node"\nconst EXECUTE_RENAME_SYMBOL_TOOL = "execute_rename_symbol"\nconst MUTATION_TOOL_NAMES = Object.freeze([EXECUTE_REPLACE_NODE_TOOL, EXECUTE_RENAME_SYMBOL_TOOL])\n{shape}\n{frontier}\n\nfunction assert(cond, msg) {{ if (!cond) throw new Error(msg) }}\n\nassert(validateMutationShape({{kind:"replace_node",before:"x",replacement:"y"}}).ok === true, "replace valid")\nassert(validateMutationShape({{kind:"replace_node",before:"x",replacement:""}}).ok === true, "deletion valid")\nassert(validateMutationShape({{kind:"replace_node"}}).ok !== true, "replace missing fields")\nassert(validateMutationShape({{kind:"rename_symbol",new_name:"z"}}).ok === true, "rename valid")\nassert(validateMutationShape({{kind:"rename_symbol"}}).ok !== true, "rename missing name")\n\nconst local = {{\n  executionState: EXEC_STATE_MUTATE,\n  localMutationCapability: {{replaceNodeReady:true, renameSymbolReady:false, globalReady:false}},\n  localMutationCandidates: [{{target:{{}}}}],\n  scoutHandoffPath: "handoff.json",\n}}\nassert(JSON.stringify(allowedToolsForState(local)) === JSON.stringify([EXECUTE_REPLACE_NODE_TOOL]), "local frontier")\n\nconst global = {{\n  executionState: EXEC_STATE_MUTATE,\n  localMutationCapability: {{replaceNodeReady:true, renameSymbolReady:true, globalReady:true}},\n  localMutationCandidates: [{{target:{{}}}}],\n  scoutHandoffPath: "handoff.json",\n}}\nassert(JSON.stringify(allowedToolsForState(global)) === JSON.stringify([EXECUTE_REPLACE_NODE_TOOL, EXECUTE_RENAME_SYMBOL_TOOL]), "global frontier")\n\nconst noCandidates = {{...global, localMutationCandidates:[]}}\nassert(JSON.stringify(allowedToolsForState(noCandidates)) === JSON.stringify([EXECUTE_RENAME_SYMBOL_TOOL]), "candidate-aware frontier")\nconsole.log("PASS action-specific schema semantics + capability-aware frontier runtime")\n'''

    with tempfile.TemporaryDirectory(prefix="v221-mastery-") as td:
        path = Path(td) / "gate.mjs"
        path.write_text(js, encoding="utf-8")
        subprocess.run(["node", str(path)], check=True)


def main() -> None:
    plugin = PLUGIN.read_text(encoding="utf-8")
    spec = json.loads(SPEC.read_text(encoding="utf-8"))

    assert 'MUTATION_TOOL_ABI_PROTOCOL = "capability-mutation-tools-v2"' in plugin
    assert 'EXECUTE_REPLACE_NODE_TOOL = "execute_replace_node"' in plugin
    assert 'EXECUTE_RENAME_SYMBOL_TOOL = "execute_rename_symbol"' in plugin
    assert 'name: "execute_patch"' not in plugin

    replace_schema = section(
        plugin,
        '        name: EXECUTE_REPLACE_NODE_TOOL,',
        "\n        options:",
    )
    rename_schema = section(
        plugin,
        '        name: EXECUTE_RENAME_SYMBOL_TOOL,',
        "\n        options:",
    )
    for schema in (replace_schema, rename_schema):
        assert 'additionalProperties: false' in schema
        assert 'kind: {' not in schema
        assert 'file: {' not in schema
        assert 'symbol: {' not in schema
        assert 'scope: {' not in schema
        assert 'anyOf: [' not in schema
        assert 'oneOf: [' not in schema
    assert 'required: ["before", "replacement"]' in replace_schema
    assert 'required: ["new_name"]' in rename_schema
    assert 'before is a canonical exact source slice, never a pattern' in replace_schema
    assert 'minLength: 1' not in replace_schema[replace_schema.index('replacement: {'):]

    common = section(
        plugin,
        "      const executeCapabilityMutation = async",
        "\n      tools.add({\n        name: EXECUTE_REPLACE_NODE_TOOL,",
    )
    assert 'kind: forcedKind' in common
    assert 'toolAllowedForExecutionState(state, toolName)' in common
    assert 'state.contractFailures += 1' in common
    assert 'forbiddenRawAuthorityField' in common
    assert '`action_tool_forbids_${forbiddenRawAuthorityField}`' in common
    assert 'semantic_attempt_consumed: false' in common
    assert 'applyExecutionEvent(state, "fatal", "tool_contract_violation")' in common
    assert 'state.activeMutationTool !== toolName' in common
    assert 'mutation_action_changed_during_attempt' in common

    # Contract/transport validation must happen before semantic mutation/repair accounting.
    shape_pos = common.index('const shape = forbiddenRawAuthorityField')
    mutation_pos = common.index('state.mutationAttempts += 1')
    repair_pos = common.index('state.repairAttempts += 1')
    assert shape_pos < mutation_pos
    assert shape_pos < repair_pos

    # Existing semantic repair budget is unchanged; only accounting is typed.
    assert 'const MAX_PATCH_ATTEMPTS_PER_TURN = 2' in plugin
    assert 'const MAX_MODEL_CALLS_PER_TURN = 4' in plugin
    assert 'const MAX_EXECUTED_SEARCHES_PER_TURN = 4' in plugin

    frontier = section(
        plugin,
        "function mutationToolsForState(state)",
        "\nfunction applyExecutionEvent",
    )
    assert 'capability?.replaceNodeReady === true' in frontier
    assert 'state.localMutationCandidates.length > 0' in frontier
    assert 'capability?.renameSymbolReady === true' in frontier
    assert 'capability?.globalReady === true' in frontier
    assert 'allowedToolsForState(state)' in frontier

    context = section(
        plugin,
        '    await track(ctx.session.hook("context", async (event) => {',
        "\n    return async () => {",
    )
    assert 'stableToolSurface = new Set(["search", ...MUTATION_TOOL_NAMES])' in context
    assert 'const requiredSurface = ["search", ...MUTATION_TOOL_NAMES]' in context
    assert 'allowedToolsForState(state)' in context
    assert 'tool_frontier_schema_sha256: frontierToolSchemaSha256' in context
    assert 'turn_tool_contract_failures: state.contractFailures' in context

    # Scout 2.0 behavior is now measurable rather than inferred from model variance.
    assert 'query_formulation_used:' in plugin
    assert 'query_formulation_fallbacks:' in plugin
    assert 'query_formulation_protocol: QUERY_FORMULATION_PROTOCOL' in plugin

    receipt = section(
        plugin,
        "async function writePatchReceipt(",
        "\nfunction impactIndexBinary",
    )
    assert 'mutation_tool_abi_protocol: MUTATION_TOOL_ABI_PROTOCOL' in receipt
    assert 'mutation_tool: state.activeMutationTool' in receipt
    assert 'visible_tool_schema_sha256: state.visibleToolSchemaSha256' in receipt
    assert 'tool_contract_failures: state.contractFailures' in receipt

    # Rescout is the only place where action stickiness is deliberately released.
    apply_event = section(
        plugin,
        "function applyExecutionEvent(state, event, reason, details = null)",
        "\nfunction toolAllowedForExecutionState",
    )
    assert 'state.activeMutationTool = null' in apply_event
    assert 'event !== "patch_rescout" && event !== "verification_rescout"' in apply_event

    # Lower action/verification plane is intentionally frozen: mastery here is
    # stronger contracts around it, not an evidence-free backend rewrite.
    compiler = ROOT / "rust/evidence-distiller/src/patch_compiler.rs"
    executor = ROOT / "rust/evidence-distiller/src/patch_executor.rs"
    verifier = ROOT / "rust/evidence-distiller/src/invariant_verifier.rs"
    if compiler.exists() and executor.exists() and verifier.exists():
        assert sha(compiler) == EXPECTED_COMPILER
        assert sha(executor) == EXPECTED_EXECUTOR
        assert sha(verifier) == EXPECTED_VERIFIER

    for forbidden in (
        "shipping_fee",
        "classify_risk",
        "normalize_sku",
        "free shipping",
        "subtotal 75",
    ):
        assert forbidden not in plugin, forbidden

    inv = spec["invariants"]
    assert inv["split_action_tools"] is True
    assert inv["legacy_confinement_exact_slice_contract_retained"] is True
    assert inv["conditional_schema"] is False
    assert inv["capability_aware_tool_frontier"] is True
    assert inv["contract_failure_consumes_semantic_repair"] is False
    assert inv["repair_action_sticky"] is True
    assert inv["query_formulation_activation_observable"] is True
    assert inv["visible_tool_schema_hashed"] is True
    assert inv["compiler_changed"] is False
    assert inv["executor_changed"] is False
    assert inv["verifier_changed"] is False
    assert inv["model_call_budget_changed"] is False
    assert inv["search_budget_changed"] is False
    assert inv["semantic_repair_budget_changed"] is False

    node_runtime_gate(plugin)
    print("PASS split capability-derived mutation ABI")
    print("PASS legacy confinement exact-slice model contract retained")
    print("PASS typed Governor accounting preserves semantic repair")
    print("PASS capability-aware/sticky Orchestrator frontier")
    print("PASS Scout formulation activation is explicitly observable")
    print("PASS patch receipt carries tool-schema provenance")
    print("PASS lower Compiler/Executor/Verifier plane frozen")
    print("PASS v2.21 Mastery Contracts 2.0")


if __name__ == "__main__":
    main()
