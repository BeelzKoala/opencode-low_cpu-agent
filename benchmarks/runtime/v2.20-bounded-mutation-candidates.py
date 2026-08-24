#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.20-bounded-mutation-candidates-gates.json"

COMPILER = ROOT / "rust/evidence-distiller/src/patch_compiler.rs"
EXECUTOR = ROOT / "rust/evidence-distiller/src/patch_executor.rs"
VERIFIER = ROOT / "rust/evidence-distiller/src/invariant_verifier.rs"

EXPECTED = {
    COMPILER: "bbeb9e14e7dd7fd34d6b9ce6b588d0234b2509af6e5f006b0d43ebce3d751a2f",
    EXECUTOR: "6db9aca5293b4173052a5fb90f5f4c81b1540e7f879b10df687bef32e5d79536",
    VERIFIER: "4a0c9ba504dc2f5c420f32ee74954b102715d925b010199635e5f8bfa54a9855",
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


for path, expected in EXPECTED.items():
    assert sha(path) == expected, (path, sha(path), expected)

s = PLUGIN.read_text(encoding="utf-8")
spec = json.loads(SPEC.read_text(encoding="utf-8"))

# Existing context ranking stays intact. v2.20 does not replace one heuristic
# ordering with another one.
for anchor in (
    'if (role === "call") return 5',
    'if (role === "assignment") return 4',
    'if (role === "definition") return 3',
    'if (role === "import") return 2',
    'if (role === "reference") return 1',
):
    assert anchor in s, anchor

# Preserve v2.18 literal/static contracts.
for anchor in (
    'SCOUT_OWNER_ATTESTATION_PROTOCOL = "owner-attestation-v1"',
    'SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS = Object.freeze(["replace_node"])',
    'allowed_mutations: [...SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS]',
    'owner_attestation: ownerAttestation',
    'ownerEvidenceDistance(line, target) <= EDIT_CAPSULE_WINDOW_RADIUS',
):
    assert anchor in s, anchor

# Candidate set exists before model-facing mutation tools, is bounded by the
# existing edit-capsule scope budget, and does not add model target fields.
for anchor in (
    'MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"',
    'const MUTATION_CANDIDATE_MAX = EDIT_CAPSULE_MAX_SCOPES',
    'async function attestLocalMutationCandidateSet(',
    'async function bindReplaceNodeMutationCandidate(',
    'localMutationCandidates: []',
    'boundMutationTarget: null',
    'mutation_candidate_protocol:',
    'mutation_candidates:',
):
    assert anchor in s, anchor

search_attest = s.index('await attestLocalMutationCandidateSet(')
execute_tool = min(
    s.index('        name: EXECUTE_REPLACE_NODE_TOOL,'),
    s.index('        name: EXECUTE_RENAME_SYMBOL_TOOL,'),
)
assert search_attest < execute_tool

# Each preauthorized candidate gets a distinct one-owner handoff. Frozen Rust
# still sees scout-local-capability-v1, not a new multi-owner protocol.
writer_start = s.index('async function writeLocalMutationHandoff(')
writer_end = s.index('\nasync function writeScoutHandoff(', writer_start)
writer = s[writer_start:writer_end]
assert 'discriminator = "primary"' in writer
assert ':local-mutation:${discriminator}' in writer

candidate_attest_start = s.index('async function attestLocalMutationCandidateSet(')
candidate_attest_end = s.index('\nconst sessionStates = new Map()', candidate_attest_start)
candidate_attest = s[candidate_attest_start:candidate_attest_end]
assert 'await attestLocalMutationCapability(' in candidate_attest
assert 'globalReady' in candidate_attest
assert 'sameAuthorizedScopeIdentity(candidate, initial)' in candidate_attest

# Impact graph is not authority: only already source-validated forward
# definitions enter the structural candidate recovery path. Reverse usage is
# explicitly absent from admission.
impact_start = s.index('function validatedImpactMutationCandidateHits(')
impact_end = s.index('\nasync function recoverValidatedImpactMutationCandidateGroups(', impact_start)
impact = s[impact_start:impact_end]
assert 'entry?.origin !== "impact"' in impact
assert 'entry?.impact?.validationKind !== "forward_scope_definition"' in impact
assert 'reverse_scope_usage' not in impact
assert 'entry?.impact?.sample?.line' in impact

recovery_start = impact_end + 1
recovery_end = s.index('\nasync function loadLivePreauthorizedMutationCandidates(', recovery_start)
recovery = s[recovery_start:recovery_end]
assert 'await runDistiller(root, fileHits)' in recovery
assert 'ownerRecoveryResponseSafe(response, probe, fileHits.length)' in recovery

# Post-model materialization cannot create new authority or discover repository
# state. It only reads the authenticated capsule, loads preauthorized candidates,
# binds exact semantic before, and chooses an already-written one-owner handoff.
materialize_start = s.index('async function materializeCapabilityBoundMutation(')
materialize_end = s.index('\nconst PATCH_COMPILER_RETRY_REASONS', materialize_start)
materialize = s[materialize_start:materialize_end]
assert 'await bindReplaceNodeMutationCandidate(' in materialize
assert 'binding.candidate.capability' in materialize
assert 'state.boundMutationTarget = mutationCandidateIdentity(target)' in materialize
assert '...(input.kind === "rename_symbol" ? { scope: "handoff" } : {}),' in materialize
for forbidden in (
    'attestLocalMutationCapability(',
    'attestLocalMutationCandidateSet(',
    'runQuery(',
    'runDistiller(',
    'validateImpactHypotheses(',
    'runFileDiscovery(',
):
    assert forbidden not in materialize, forbidden

# One existing repair only. No new model/search budget.
assert 'const MAX_PATCH_ATTEMPTS_PER_TURN = 2' in s
assert 'canRetryAuthorization' in s
assert 'authorization.repairable === true' in s
assert 'mutation_owner_repair_target_mismatch' in s

# Model-facing authority contract remains exact after split action tools.
replace_schema_start = s.index('        name: EXECUTE_REPLACE_NODE_TOOL,')
replace_schema_end = s.index('\n        options:', replace_schema_start)
replace_schema = s[replace_schema_start:replace_schema_end]
rename_schema_start = s.index('        name: EXECUTE_RENAME_SYMBOL_TOOL,')
rename_schema_end = s.index('\n        options:', rename_schema_start)
rename_schema = s[rename_schema_start:rename_schema_end]
for schema in (replace_schema, rename_schema):
    assert 'scope: {' not in schema
    assert 'file: {' not in schema
    assert 'symbol: {' not in schema
    assert 'kind: {' not in schema
    assert 'enum: ["handoff"]' not in schema
    assert 'additionalProperties: false' in schema

# No benchmark-specific business strings in product.
for forbidden in (
    'shipping_fee',
    'classify_risk',
    'normalize_sku',
    'free shipping',
    'subtotal 75',
):
    assert forbidden not in s, forbidden

inv = spec["invariants"]
assert inv["context_ranking_changed"] is False
assert inv["candidate_authority_issued_before_model_patch"] is True
assert inv["post_model_authority_issuance"] is False
assert inv["post_model_repository_discovery"] is False
assert inv["impact_edge_alone_authorizes"] is False
assert inv["reverse_impact_usage_authorizes"] is False
assert inv["repair_owner_is_sticky"] is True
assert inv["partial_handoff_cross_owner_candidates"] is False
assert inv["compiler_changed"] is False
assert inv["executor_changed"] is False
assert inv["verifier_changed"] is False
assert inv["model_calls_added"] == 0


def block(start_marker: str, end_marker: str) -> str:
    start = s.index(start_marker)
    end = s.index(end_marker, start)
    return s[start:end]


pure = block(
    'function mutationCandidateIdentity(',
    '\nasync function recoverValidatedImpactMutationCandidateGroups(',
)
set_helper = block(
    'async function attestLocalMutationCandidateSet(',
    '\nconst sessionStates = new Map()',
)

node = r'''
function normalizeMutationFile(x) {
  return typeof x === "string" ? x.replaceAll("\\", "/") : null
}
function evidenceFileKey(x) { return normalizeMutationFile(x) }
function sameAuthorizedScopeIdentity(a, b) {
  return !!a && !!b &&
    normalizeMutationFile(a.file) === normalizeMutationFile(b.file) &&
    a.symbol_name === b.symbol_name &&
    a.symbol_kind === b.symbol_kind &&
    a.start_line === b.start_line &&
    a.end_line === b.end_line
}
const MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"
__PURE__

function cap(file, name, start, end, source) {
  return {
    target: {
      file,
      symbol_kind: "function_definition",
      symbol_name: name,
      start_line: start,
      end_line: end,
    },
    live_source: source,
  }
}
function assert(x, msg) { if (!x) throw new Error(msg) }

// Callee target selected by semantic before; no definition role bonus.
{
  const caller = cap(
    "checkout.py", "checkout_total", 1, 2,
    "def checkout_total(x):\n    return x + shipping_fee(x)",
  )
  const definition = cap(
    "pricing.py", "shipping_fee", 1, 4,
    "def shipping_fee(x):\n    if x >= 50:\n        return 0\n    return 7",
  )
  const r = selectExactMutationCandidate(
    [caller, definition],
    "if x >= 50",
  )
  assert(r.ok && r.candidate.target.symbol_name === "shipping_fee", JSON.stringify(r))
}

// Symmetric anti-overfit: caller is selected when before belongs to caller.
{
  const caller = cap(
    "checkout.py", "checkout_total", 1, 2,
    "def checkout_total(x):\n    return x + shipping_fee(x)",
  )
  const definition = cap(
    "pricing.py", "shipping_fee", 1, 4,
    "def shipping_fee(x):\n    if x >= 50:\n        return 0\n    return 7",
  )
  const r = selectExactMutationCandidate(
    [caller, definition],
    "return x + shipping_fee(x)",
  )
  assert(r.ok && r.candidate.target.symbol_name === "checkout_total", JSON.stringify(r))
}

// v2.19 relative-indentation ABI remains bindable.
{
  const fn = cap(
    "normalize.py", "normalize", 1, 4,
    "def normalize(value):\n    value = value.strip()\n    value = value.lower()\n    return value",
  )
  const r = selectExactMutationCandidate(
    [fn],
    "value = value.strip()\n    value = value.lower()",
  )
  assert(r.ok, JSON.stringify(r))
}

// Nested owner collapses to most-specific structural scope.
{
  const outer = cap(
    "a.py", "A", 1, 5,
    "class A:\n    def f(self):\n        x = 1\n        return x\n",
  )
  outer.target.symbol_kind = "class_definition"
  const inner = cap(
    "a.py", "f", 2, 4,
    "def f(self):\n    x = 1\n    return x",
  )
  const r = selectExactMutationCandidate([outer, inner], "return x")
  assert(r.ok && r.candidate.target.symbol_name === "f", JSON.stringify(r))
}

// Disjoint exact owners fail closed.
{
  const a = cap("a.py", "a", 1, 2, "def a():\n    return marker")
  const b = cap("b.py", "b", 1, 2, "def b():\n    return marker")
  const r = selectExactMutationCandidate([a, b], "return marker")
  assert(!r.ok && r.reason === "mutation_owner_ambiguous_exact_match", JSON.stringify(r))
}

// Repair cannot jump owner after first successful bind.
{
  const a = cap("a.py", "a", 1, 2, "def a():\n    return 1")
  const b = cap("b.py", "b", 1, 2, "def b():\n    return 2")
  const r = selectExactMutationCandidate(
    [a, b],
    "return 2",
    mutationCandidateIdentity(a.target),
  )
  assert(!r.ok && r.reason === "mutation_owner_repair_target_mismatch", JSON.stringify(r))
}

// Only forward source-validated Impact definition is admitted.
{
  const hits = validatedImpactMutationCandidateHits([
    {
      origin: "impact",
      file: "domain/risk.py",
      queries: new Set([0]),
      impact: {
        validationKind: "forward_scope_definition",
        sample: {line: 1},
      },
    },
    {
      origin: "impact",
      file: "service/report.py",
      queries: new Set([0]),
      impact: {
        validationKind: "reverse_scope_usage",
        sample: {line: 3},
      },
    },
  ])
  assert(hits.length === 1 && hits[0].file === "domain/risk.py", JSON.stringify(hits))
}

async function attestLocalMutationCapability(
  root, sessionID, state, scoutHandoff, editCapsule, competitorCheck, target,
) {
  return {
    ok: true,
    target: mutationCandidateIdentity(target),
    localHandoffPath: `.opencode/cap/${target.symbol_name}.json`,
    allowedMutations: ["replace_node"],
    replaceNodeReady: true,
  }
}
__SET_HELPER__

// Global-ready discovery preauthorizes all bounded candidates before model patch.
{
  const a = {file:"a.py",symbol_kind:"function_definition",symbol_name:"a",start_line:1,end_line:2}
  const b = {file:"b.py",symbol_kind:"function_definition",symbol_name:"b",start_line:1,end_line:2}
  const r = await attestLocalMutationCandidateSet(
    "/repo", "s", {}, {status:"ready"},
    {mutationCandidates:[a,b], authorizedMutationScope:a},
    {ok:true},
  )
  assert(r.ok && r.candidates.length === 2, JSON.stringify(r))
}

// Partial discovery never preauthorizes a cross-owner rebind.
{
  const a = {file:"a.py",symbol_kind:"function_definition",symbol_name:"a",start_line:1,end_line:2}
  const b = {file:"b.py",symbol_kind:"function_definition",symbol_name:"b",start_line:1,end_line:2}
  const r = await attestLocalMutationCandidateSet(
    "/repo", "s", {}, {status:"partial"},
    {mutationCandidates:[a,b], authorizedMutationScope:a},
    {ok:true},
  )
  assert(r.ok && r.candidates.length === 1, JSON.stringify(r))
  assert(r.candidates[0].target.symbol_name === "a", JSON.stringify(r))
}

console.log("PASS v2.20 semantic binding + preauthorization cases")
'''.replace('__PURE__', pure).replace('__SET_HELPER__', set_helper)

with tempfile.TemporaryDirectory(prefix="v220-candidates-") as td:
    script = Path(td) / "gate.mjs"
    script.write_text(node, encoding="utf-8")
    cp = subprocess.run(
        ["node", str(script)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert cp.returncode == 0, (cp.stdout, cp.stderr)
    print(cp.stdout.strip())

print("PASS lower Rust action/verification plane frozen")
print("PASS old v2.18/v2.19/v2.19.1 contracts retained")
print("PASS candidate authority issued before model patch")
print("PASS no post-model authority issuance/discovery")
print("PASS sticky bounded owner repair")
print("PASS v2.20 bounded mutation candidates")
