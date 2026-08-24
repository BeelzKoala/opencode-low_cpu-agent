#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.20-r2-tool-schema-contract-gates.json"

EXPECTED_COMPILER = "bbeb9e14e7dd7fd34d6b9ce6b588d0234b2509af6e5f006b0d43ebce3d751a2f"
EXPECTED_EXECUTOR = "6db9aca5293b4173052a5fb90f5f4c81b1540e7f879b10df687bef32e5d79536"
EXPECTED_VERIFIER = "4a0c9ba504dc2f5c420f32ee74954b102715d925b010199635e5f8bfa54a9855"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def section(text: str, start_anchor: str, end_anchor: str) -> str:
    start = text.index(start_anchor)
    end = text.index(end_anchor, start)
    return text[start:end]


def main() -> None:
    plugin = PLUGIN.read_text(encoding="utf-8")
    spec = json.loads(SPEC.read_text(encoding="utf-8"))

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

    assert 'name: "execute_patch"' not in plugin
    assert 'anyOf: [' not in replace_schema
    assert 'oneOf: [' not in replace_schema
    assert 'anyOf: [' not in rename_schema
    assert 'oneOf: [' not in rename_schema

    for schema in (replace_schema, rename_schema):
        for forbidden in ('scope: {', 'file: {', 'symbol: {', 'kind: {'):
            assert forbidden not in schema, forbidden
        assert 'additionalProperties: false' in schema

    assert 'required: ["before", "replacement"]' in replace_schema
    assert 'required: ["new_name"]' in rename_schema

    # Existing field-level bounds are retained, including empty replacement
    # for an intentional exact deletion.
    before_start = replace_schema.index('before: {')
    replacement_start = replace_schema.index('replacement: {')
    before_block = replace_schema[before_start:replacement_start]
    replacement_block = replace_schema[replacement_start:]
    new_name_start = rename_schema.index('new_name: {')
    new_name_block = rename_schema[new_name_start:]
    assert 'minLength: 1' in before_block
    assert 'maxLength: 4096' in before_block
    assert 'maxLength: 4096' in replacement_block
    assert 'minLength: 1' not in replacement_block
    assert 'minLength: 1' in new_name_block
    assert 'maxLength: 256' in new_name_block

    # Runtime validation remains defense-in-depth if a provider ignores anyOf.
    shape = section(
        plugin,
        "function validateMutationShape(input)",
        "\nfunction normalizeMutationFile",
    )
    assert 'typeof input.replacement !== "string"' in shape
    assert 'replace_node_requires_${missing.join("_")}' in shape
    assert 'rename_symbol_requires_new_name' in shape
    for forbidden_field in ('"new_name",', '"scope",'):
        assert forbidden_field in shape
    for forbidden_field in ('"before",', '"replacement",', '"scope",'):
        assert forbidden_field in shape

    # No budget/ranking/authority compensation is introduced.
    assert 'const MAX_PATCH_ATTEMPTS_PER_TURN = 2' in plugin
    role_start = plugin.index('function focusedRoleScore(')
    role_end = plugin.index('\nfunction focusedScopesFromGroups(', role_start)
    role = plugin[role_start:role_end]
    for anchor in (
        'if (role === "call") return 5',
        'if (role === "assignment") return 4',
        'if (role === "definition") return 3',
        'if (role === "import") return 2',
        'if (role === "reference") return 1',
        'return 0',
    ):
        assert anchor in role, anchor
    assert 'MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"' in plugin

    # Lower mutation/verification plane remains frozen in the real repository.
    compiler = ROOT / "rust/evidence-distiller/src/patch_compiler.rs"
    executor = ROOT / "rust/evidence-distiller/src/patch_executor.rs"
    verifier = ROOT / "rust/evidence-distiller/src/invariant_verifier.rs"
    if compiler.exists() and executor.exists() and verifier.exists():
        assert sha(compiler) == EXPECTED_COMPILER
        assert sha(executor) == EXPECTED_EXECUTOR
        assert sha(verifier) == EXPECTED_VERIFIER

    inv = spec["invariants"]
    assert inv["replace_node_schema_requires"] == ["before", "replacement"]
    assert inv["rename_symbol_schema_requires"] == ["new_name"]
    assert inv["runtime_shape_validation_retained"] is True
    assert inv["split_action_tools"] is True
    assert inv["model_supplies_kind"] is False
    assert inv["conditional_schema"] is False
    assert inv["empty_replacement_allowed"] is True
    assert inv["model_supplies_target"] is False
    assert inv["model_supplies_scope"] is False
    assert inv["mutation_budget_changed"] is False
    assert inv["scout_ranking_changed"] is False
    assert inv["candidate_authority_changed"] is False
    assert inv["compiler_changed"] is False
    assert inv["executor_changed"] is False
    assert inv["verifier_changed"] is False

    print("PASS replace_node action tool has top-level before + replacement contract")
    print("PASS rename_symbol action tool has top-level new_name contract")
    print("PASS exact deletion remains representable")
    print("PASS runtime shape defense-in-depth retained")
    print("PASS target/scope, ranking, authority, budgets frozen")
    print("PASS v2.20-r2 tool schema contract")


if __name__ == "__main__":
    main()
