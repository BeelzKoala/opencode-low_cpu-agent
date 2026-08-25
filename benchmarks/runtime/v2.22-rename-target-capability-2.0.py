#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.22-rename-target-capability-2.0-gates.json"

EXPECTED_COMPILER = "bbeb9e14e7dd7fd34d6b9ce6b588d0234b2509af6e5f006b0d43ebce3d751a2f"
EXPECTED_EXECUTOR = "6db9aca5293b4173052a5fb90f5f4c81b1540e7f879b10df687bef32e5d79536"
EXPECTED_VERIFIER = "4a0c9ba504dc2f5c420f32ee74954b102715d925b010199635e5f8bfa54a9855"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def section(text: str, start: str, end: str) -> str:
    i = text.index(start)
    j = text.index(end, i)
    return text[i:j]


def node_selection_gate(plugin: str) -> None:
    with tempfile.TemporaryDirectory(prefix="v222-rename-target-") as td:
        module = Path(td) / "plugin.mjs"
        module.write_text(
            plugin
            + "\nexport { simpleRenameIdentifierQuery, selectRenameTargetFromExactEvidence };\n",
            encoding="utf-8",
        )
        test = Path(td) / "gate.mjs"
        test.write_text(
            r'''
import {
  simpleRenameIdentifierQuery,
  selectRenameTargetFromExactEvidence,
} from "./plugin.mjs"

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function group(file, symbol, role="definition", query=1, start=10, end=12) {
  return {
    file,
    symbol_kind: "function_definition",
    symbol_name: symbol,
    role,
    node_kind: "function_definition",
    match_text: symbol,
    anchor: symbol,
    start_line: start,
    end_line: end,
    hit_count: 1,
    queries: [query],
    hit_lines: [start],
    variants: [{
      subject_text: symbol,
      statement_text: symbol,
      hit_count: 1,
      queries: [query],
      hit_lines: [start],
    }],
  }
}

const complete = files => ({
  scanComplete: true,
  timedOut: false,
  scanCapped: false,
  error: null,
  queryFormulation: null,
  files,
})

assert(simpleRenameIdentifierQuery("alpha") === "alpha", "simple identifier")
assert(simpleRenameIdentifierQuery("a.*b") === null, "regex must not bind rename")
assert(simpleRenameIdentifierQuery("foo bar") === null, "phrase must not bind rename")

// Caller evidence may outrank a definition for replace_node, but rename target
// identity must select the unique exact structural definition.
let r = selectRenameTargetFromExactEvidence(
  "/repo",
  ["alpha"],
  [complete(["a.py"])],
  [
    group("a.py", "caller", "call", 1, 2, 4),
    group("a.py", "alpha", "definition", 1, 20, 24),
  ],
  [{file:"a.py"}],
)
assert(r.ok === true, "unique definition should bind")
assert(r.target.symbol_name === "alpha", "rename target must be queried definition")
assert(r.target.start_line === 20, "definition identity must survive")

r = selectRenameTargetFromExactEvidence(
  "/repo",
  ["alpha"],
  [complete(["a.py", "b.py"])],
  [
    group("a.py", "alpha", "definition", 1, 10, 12),
    group("b.py", "alpha", "definition", 1, 30, 32),
  ],
  [{file:"a.py"}, {file:"b.py"}],
)
assert(r.ok === false && r.reason === "rename_target_ambiguous_definition", "duplicate definitions fail closed")

r = selectRenameTargetFromExactEvidence(
  "/repo",
  ["alpha"],
  [{...complete(["a.py"]), queryFormulation:{branches:[1]}}],
  [group("a.py", "alpha")],
  [{file:"a.py"}],
)
assert(r.ok === false && r.reason === "rename_target_not_proven", "heuristic formulation cannot authorize rename")

r = selectRenameTargetFromExactEvidence(
  "/repo",
  ["alpha"],
  [complete(["a.py", "b.py"])],
  [group("a.py", "alpha")],
  [{file:"a.py"}],
)
assert(r.ok === false && r.reason === "rename_target_not_proven", "incomplete emitted handoff cannot authorize global rename")

r = selectRenameTargetFromExactEvidence(
  "/repo",
  ["alpha", "beta"],
  [complete(["a.py"]), complete(["b.py"])],
  [group("a.py", "alpha", "definition", 1), group("b.py", "beta", "definition", 2)],
  [{file:"a.py"}, {file:"b.py"}],
)
assert(r.ok === false && r.reason === "rename_target_multiple_exact_definitions", "multiple query targets fail closed")

console.log("PASS deterministic rename target selection / ambiguity / provenance cases")
''',
            encoding="utf-8",
        )
        subprocess.run(["node", str(test)], cwd=td, check=True)


def main() -> None:
    plugin = PLUGIN.read_text(encoding="utf-8")
    spec = json.loads(SPEC.read_text(encoding="utf-8"))

    assert spec["protocol"] == "v2.22-rename-target-capability-2.0"
    assert 'SCOUT_RENAME_TARGET_PROTOCOL = "scout-rename-target-v2"' in plugin
    assert 'function simpleRenameIdentifierQuery(value)' in plugin
    assert 'function selectRenameTargetFromExactEvidence(' in plugin
    assert 'async function attestRenameTargetCapability(' in plugin

    local = section(
        plugin,
        "async function attestLocalMutationCapability(",
        "\nasync function attestLocalMutationCandidateSet(",
    )
    assert 'renameSymbolReady: false' in local
    assert 'renameSymbolReady: globalReady' not in local

    # v2.25 task-context-v1 split routing into:
    #   resolveMutationActionForState(state) -> capability/intention proof
    #   mutationToolsForState(state)        -> one-tool wrapper
    #
    # v2.22 owns the authority invariant, not the historical placement of the
    # capability checks inside the wrapper. Inspect the whole routing block.
    routing = section(
        plugin,
        "function resolveMutationActionForState(state)",
        "\nfunction allowedToolsForState(state)",
    )
    assert 'const renameCapability = state?.renameMutationCapability ?? null' in routing
    assert 'renameCapability?.protocol === SCOUT_RENAME_TARGET_PROTOCOL' in routing
    assert 'renameCapability?.sourceHandoffPath === state?.scoutHandoffPath' in routing
    assert 'capability?.renameSymbolReady === true' not in routing
    assert 'function mutationToolsForState(state)' in routing
    assert 'const resolution = resolveMutationActionForState(state)' in routing
    assert 'return resolution.tool ? [resolution.tool] : []' in routing

    materializer = section(
        plugin,
        "async function materializeCapabilityBoundMutation(",
        "\nconst PATCH_COMPILER_RETRY_REASONS",
    )
    rename_branch = materializer[materializer.index('} else if (input.kind === "rename_symbol")'):]
    assert 'const renameCapability = state?.renameMutationCapability ?? null' in rename_branch
    assert 'target = renameCapability?.target ?? null' in rename_branch
    assert 'renameCapability?.targetIdentitySha256 !== identitySha256' in rename_branch
    assert 'currentSha256 !== renameCapability.targetSourceSha256' in rename_branch
    assert 'state.boundMutationTarget = mutationCandidateIdentity(target)' in rename_branch
    assert 'primaryCapability.renameSymbolReady' not in rename_branch

    # Capability is derived before the capped EditCapsule allocation and only
    # from exact structural groups, never Impact candidate groups or recovered
    # line owners.
    search = section(
        plugin,
        "          const exactStructuralGroups =",
        "          const capsuleGroups = [",
    )
    assert 'await attestRenameTargetCapability(' in search
    assert 'exactStructuralGroups ?? []' in search
    derive_pos = search.index('await attestRenameTargetCapability(')
    impact_pos = search.index('recoverValidatedImpactMutationCandidateGroups(')
    assert derive_pos < impact_pos

    assert 'scout_rename_target_protocol:' in plugin
    assert 'scout_rename_target_ready:' in plugin
    assert 'scout_rename_target:' in plugin
    assert 'rename_target_capability_protocol:' in plugin
    assert 'rename_target_capability_target:' in plugin

    # No repository/task literals in the product implementation.
    for forbidden in (
        "django/apps/config.py",
        "_path_from_module",
        "getNodeFromPath",
        "packages/typescript/src/api/fs.ts",
        "v221_probe",
    ):
        assert forbidden not in plugin, forbidden

    # This patch must not compensate by widening budgets or changing lower
    # mutation authority.
    assert 'const MAX_MODEL_CALLS_PER_TURN = 4' in plugin
    assert 'const MAX_EXECUTED_SEARCHES_PER_TURN = 4' in plugin
    assert 'const MAX_PATCH_ATTEMPTS_PER_TURN = 2' in plugin

    for rel, expected in (
        ("rust/evidence-distiller/src/patch_compiler.rs", EXPECTED_COMPILER),
        ("rust/evidence-distiller/src/patch_executor.rs", EXPECTED_EXECUTOR),
        ("rust/evidence-distiller/src/invariant_verifier.rs", EXPECTED_VERIFIER),
    ):
        path = ROOT / rel
        if path.exists():
            assert sha(path) == expected, (rel, sha(path), expected)

    node_selection_gate(plugin)

    print("PASS replace and rename authorities are structurally separated")
    print("PASS rename target requires complete exact identifier evidence + unique definition")
    print("PASS heuristic Query Formulation evidence cannot authorize rename")
    print("PASS rename target is independently fingerprinted and revalidated live")
    print("PASS lower Compiler/Executor/Verifier and budgets remain frozen")
    print("PASS v2.22 Rename Target Capability 2.0")


if __name__ == "__main__":
    main()
