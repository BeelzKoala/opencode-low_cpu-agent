#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.20-r2-tool-schema-contract-gates.json"

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

    # This historical gate is monotonic: it owns only the v2.20
    # model-facing replace/rename language and its runtime shape defense.
    # Later versions may evolve Scout, budgets, capability authority and the
    # Rust mutation/verification plane under their own versioned gates.

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
    assert inv["lower_plane_byte_identity_frozen"] is False
    assert inv["unrelated_component_snapshot_frozen"] is False
    assert inv["compatibility_scope"] == [
        "replace_node_tool_abi",
        "rename_symbol_tool_abi",
        "runtime_shape_validation",
    ]

    print("PASS replace_node action tool has top-level before + replacement contract")
    print("PASS rename_symbol action tool has top-level new_name contract")
    print("PASS exact deletion remains representable")
    print("PASS runtime shape defense-in-depth retained")
    print("PASS target/scope remain model-inaccessible")
    print("PASS v2.20 compatibility gate does not freeze later implementation evolution")
    print("PASS v2.20-r2 tool schema contract")


if __name__ == "__main__":
    main()
