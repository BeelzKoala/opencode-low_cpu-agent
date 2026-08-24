#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.19.1-capability-derived-tool-abi-gates.json"

EXPECTED_COMPILER = "bbeb9e14e7dd7fd34d6b9ce6b588d0234b2509af6e5f006b0d43ebce3d751a2f"
EXPECTED_EXECUTOR = "6db9aca5293b4173052a5fb90f5f4c81b1540e7f879b10df687bef32e5d79536"
EXPECTED_VERIFIER = "4a0c9ba504dc2f5c420f32ee74954b102715d925b010199635e5f8bfa54a9855"

def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main() -> None:
    plugin = PLUGIN.read_text(encoding="utf-8")
    spec = json.loads(SPEC.read_text(encoding="utf-8"))

    start = plugin.index('        name: "execute_patch",')
    end = plugin.index("\n        options:", start)
    schema_block = plugin[start:end]

    assert 'scope: {' not in schema_block
    assert 'enum: ["handoff"]' not in schema_block
    assert 'additionalProperties: false' in schema_block
    assert 'Mutation scope is also capability-derived and MUST NOT be supplied' in schema_block

    materialize_start = plugin.index("async function materializeCapabilityBoundMutation(")
    materialize_end = plugin.index("\nconst PATCH_COMPILER_RETRY_REASONS", materialize_start)
    materialize = plugin[materialize_start:materialize_end]
    assert '...(input.kind === "rename_symbol" ? { scope: "handoff" } : {}),' in materialize
    assert 'typeof input.scope === "string"' not in materialize

    shape_start = plugin.index("function validateMutationShape(input)")
    shape_end = plugin.index("\nfunction normalizeMutationFile", shape_start)
    shape = plugin[shape_start:shape_end]
    replace_start = shape.index('if (input.kind === "replace_node")')
    rename_start = shape.index('if (input.kind === "rename_symbol")')
    replace_block = shape[replace_start:rename_start]
    rename_block = shape[rename_start:]
    assert '"scope",' in replace_block
    assert '"scope",' in rename_block

    assert sha(ROOT / "rust/evidence-distiller/src/patch_compiler.rs") == EXPECTED_COMPILER
    assert sha(ROOT / "rust/evidence-distiller/src/patch_executor.rs") == EXPECTED_EXECUTOR
    assert sha(ROOT / "rust/evidence-distiller/src/invariant_verifier.rs") == EXPECTED_VERIFIER

    inv = spec["invariants"]
    assert inv["model_supplies_scope"] is False
    assert inv["rename_scope"] == "deterministically_handoff"
    assert inv["replace_node_scope_field"] == "impossible"
    assert inv["compiler_changed"] is False
    assert inv["executor_changed"] is False
    assert inv["verifier_changed"] is False
    assert inv["scout_changed"] is False
    assert inv["model_calls_added"] == 0

    print("PASS model cannot choose target or mutation authority scope")
    print("PASS rename handoff scope is deterministic internal metadata")
    print("PASS replace_node cannot represent scope in model-facing ABI")
    print("PASS Rust action/verification plane frozen")
    print("PASS v2.19.1-r3 capability-derived tool ABI")

if __name__ == "__main__":
    main()
