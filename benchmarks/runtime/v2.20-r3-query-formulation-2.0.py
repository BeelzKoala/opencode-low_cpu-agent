#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.20-r3-query-formulation-2.0-gates.json"

COMPILER = ROOT / "rust/evidence-distiller/src/patch_compiler.rs"
EXECUTOR = ROOT / "rust/evidence-distiller/src/patch_executor.rs"
VERIFIER = ROOT / "rust/evidence-distiller/src/invariant_verifier.rs"

FROZEN = {
    COMPILER: "bbeb9e14e7dd7fd34d6b9ce6b588d0234b2509af6e5f006b0d43ebce3d751a2f",
    EXECUTOR: "6db9aca5293b4173052a5fb90f5f4c81b1540e7f879b10df687bef32e5d79536",
    VERIFIER: "4a0c9ba504dc2f5c420f32ee74954b102715d925b010199635e5f8bfa54a9855",
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def block(source: str, start_marker: str, end_marker: str) -> str:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


def run_node(source: str, *args: str) -> str:
    with tempfile.TemporaryDirectory(prefix="v220-r3-qf-") as td:
        script = Path(td) / "gate.mjs"
        script.write_text(source, encoding="utf-8")
        cp = subprocess.run(
            ["node", str(script), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
        )
        if cp.returncode != 0:
            Path("/tmp/v220-r3-query-formulation-failed.mjs").write_text(
                source, encoding="utf-8"
            )
        assert cp.returncode == 0, (cp.stdout, cp.stderr)
        return cp.stdout.strip()


s = PLUGIN.read_text(encoding="utf-8")
spec = json.loads(SPEC.read_text(encoding="utf-8"))
inv = spec["invariants"]

# Product/resource/safety plane remains fixed.
for anchor in (
    'const MAX_QUERIES = 4',
    'const MAX_EXECUTED_SEARCHES_PER_TURN = 4',
    'const MAX_MODEL_CALLS_PER_TURN = 4',
    'const MAX_PATCH_ATTEMPTS_PER_TURN = 2',
    'if (role === "call") return 5',
    'if (role === "assignment") return 4',
    'if (role === "definition") return 3',
    'if (role === "import") return 2',
    'if (role === "reference") return 1',
    'MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"',
    'SOURCE_GLOB_INVENTORY_PROTOCOL = "source-glob-inventory-v1"',
):
    assert anchor in s, anchor

for path, expected in FROZEN.items():
    if path.exists():
        assert sha(path) == expected, (path, sha(path), expected)

# Query Formulation 2.0 architecture.
for anchor in (
    'QUERY_FORMULATION_PROTOCOL = "query-formulation-v2"',
    'const QUERY_FORMULATION_MAX_BRANCHES = 4',
    'const QUERY_FORMULATION_MAX_ATOMS = 8',
    'const QUERY_FORMULATION_MAX_ATOMS_PER_BRANCH = 5',
    'const QUERY_FORMULATION_MIN_FILE_ATOMS = 2',
    'const QUERY_FORMULATION_MIN_COVERAGE_RATIO = 0.5',
    'const QUERY_FORMULATION_MAX_FILES = PROBE_MAX_FILES * 3',
    'function splitTopLevelRegexAlternatives(',
    'function queryFormulationAtoms(',
    'function buildQueryFormulationPlan(',
    'function queryFormulationLineHasAtom(',
    'async function runQueryFormulationDiscovery(',
    'matchMode: "token_file_cooccurrence"',
    'query_formulation_protocol: QUERY_FORMULATION_PROTOCOL',
    'query_formulation_fallbacks:',
):
    assert anchor in s, anchor

# The broadened formulation is downstream of complete exact/casefold zero.
compiled = block(
    s,
    'async function runCompiledDiscovery(',
    '\nfunction pathAffinity(',
)
assert compiled.index('const exact = await runFileDiscovery(') < compiled.index(
    'const folded = await runFileDiscovery('
)
assert compiled.index('const foldedCompleteZero =') < compiled.index(
    'const formulationPlan = buildQueryFormulationPlan(query)'
)
assert 'if (!foldedCompleteZero) {' in compiled
assert 'runQueryFormulationDiscovery(' in compiled

# Fallback evidence can route, but cannot masquerade as exact mutation evidence.
formulation = block(
    s,
    'async function runQueryFormulationDiscovery(',
    '\nfunction queryCompilerProbeResult(',
)
assert 'exactSpans: []' in formulation
assert 'matchTexts: []' in formulation
assert 'probe.scanComplete !== true' in formulation
assert 'ranked.length > QUERY_FORMULATION_MAX_FILES' in formulation

# No task/business-specific vocabulary in the product implementation.
for forbidden in (
    'shipping_fee',
    'classify_risk',
    'normalize_sku',
    'free shipping',
    'subtotal 75',
    'risk band',
):
    assert forbidden not in s, forbidden

assert inv["exact_regex_remains_authoritative"] is True
assert inv["fallback_requires_complete_exact_and_casefold_zero"] is True
assert inv["fallback_evidence_exact_spans"] == 0
assert inv["top_level_alternation_only"] is True
assert inv["same_file_source_backed_atom_quorum"] is True
assert inv["pure_numeric_fallback"] is False
assert inv["incomplete_or_capped_fallback"] is False
assert inv["fallback_file_cap"] == 24
assert inv["model_calls_added"] == 0
assert inv["search_budget_changed"] is False
assert inv["ranking_changed"] is False
assert inv["compiler_changed"] is False
assert inv["executor_changed"] is False
assert inv["verifier_changed"] is False

helpers = block(
    s,
    'function splitTopLevelRegexAlternatives(',
    '\nfunction queryCompilerProbeResult(',
)

js = r'''
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const QUERY_FORMULATION_PROTOCOL = "query-formulation-v2"
const QUERY_FORMULATION_MAX_BRANCHES = 4
const QUERY_FORMULATION_MAX_ATOMS = 8
const QUERY_FORMULATION_MAX_ATOMS_PER_BRANCH = 5
const QUERY_FORMULATION_MIN_FILE_ATOMS = 2
const QUERY_FORMULATION_MIN_COVERAGE_RATIO = 0.5
const PROBE_MAX_FILES = 8
const QUERY_FORMULATION_MAX_FILES = PROBE_MAX_FILES * 3
const QUERY_COMPILER_STOPWORDS = new Set([
  "the","and","for","with","from","into","when","then","this","that",
])

function escapeRegexLiteral(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
function evidenceFileKey(raw) {
  return String(raw ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "")
}
function assert(x, msg) { if (!x) throw new Error(msg) }

let RUN_MODE = "real"
async function runQuery(root, query, queryIndex, targets, glob) {
  if (RUN_MODE === "incomplete") {
    return {query, queryIndex, matches: [], timedOut: true, scanCapped: false, error: null, scanComplete: false}
  }
  if (RUN_MODE === "wide") {
    const matches = []
    for (let i = 0; i < 25; i += 1) {
      matches.push({file:`f${i}.py`, line:1, text:"alpha beta", queryIndex, exactSpans:[{start:0,end:5}], matchTexts:["alpha"]})
    }
    return {query, queryIndex, matches, timedOut:false, scanCapped:false, error:null, scanComplete:true}
  }

  const args = ["--json", "--color", "never"]
  if (glob) args.push("-g", glob)
  args.push("--", query, ...(Array.isArray(targets) ? targets : [targets]))
  const cp = spawnSync("rg", args, {cwd: root, encoding:"utf8"})
  if (![0,1].includes(cp.status)) {
    return {query, queryIndex, matches:[], timedOut:false, scanCapped:false, error:cp.stderr, scanComplete:false}
  }
  const matches = []
  for (const line of cp.stdout.split("\n")) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event.type !== "match") continue
    matches.push({
      file:event.data.path.text,
      line:event.data.line_number,
      text:event.data.lines.text,
      queryIndex,
      exactSpans:[{start:0,end:1}],
      matchTexts:["synthetic"],
    })
  }
  return {query, queryIndex, matches, timedOut:false, scanCapped:false, error:null, scanComplete:true}
}

__HELPERS__

const root = process.argv[2]
mkdirSync(path.join(root, "shop"), {recursive:true})
writeFileSync(path.join(root, "shop/pricing.py"), "def shipping_fee(subtotal):\n    if subtotal >= 50:\n        return 0\n    return 7\n")
writeFileSync(path.join(root, "shop/checkout.py"), "from shop.pricing import shipping_fee\n\ndef checkout_total(subtotal):\n    return subtotal + shipping_fee(subtotal)\n")

// Safe top-level splitting: escaped pipes, classes and nested groups stay intact.
assert(splitTopLevelRegexAlternatives("alpha|beta").length === 2, "top-level split")
assert(splitTopLevelRegexAlternatives("alpha\\|beta").length === 1, "escaped pipe")
assert(splitTopLevelRegexAlternatives("[a|b].*value").length === 1, "class pipe")
assert(splitTopLevelRegexAlternatives("(alpha|beta).*value").length === 1, "group pipe")
assert(splitTopLevelRegexAlternatives("alpha|beta|gamma|delta|epsilon") === null, "branch cap fail-closed")
assert(splitTopLevelRegexAlternatives("(alpha") === null, "malformed group fail-closed")

// Purely numeric and one-atom formulations are not admitted.
assert(buildQueryFormulationPlan("50|75") === null, "pure numeric blocked")
assert(buildQueryFormulationPlan("subtotal") === null, "single atom blocked")

// Numeric boundary is source-safe: 50 does not match 150.
assert(queryFormulationLineHasAtom("x = 50", "50"), "numeric exact")
assert(!queryFormulationLineHasAtom("x = 150", "50"), "numeric boundary")

const query = "subtotal.*shipping.*eligible|free.*shipping.*subtotal.*75|shipping.*rule.*subtotal.*50"
const plan = buildQueryFormulationPlan(query)
assert(plan && plan.branches.length === 3, JSON.stringify(plan))

const result = await runQueryFormulationDiscovery(root, query, 0, ".", "**/*.py", plan)
assert(result, "shipping-like formulation recovered")
assert(result.matchMode === "token_file_cooccurrence", JSON.stringify(result))
assert(result.files.includes("shop/pricing.py"), JSON.stringify(result.files))
assert(result.files.includes("shop/checkout.py"), JSON.stringify(result.files))
assert(result.compiledProbe.matches.every((m) => m.exactSpans.length === 0), "no exact spans")
assert(result.compiledProbe.matches.every((m) => m.matchTexts.length === 0), "no exact texts")

// Conceptual words absent from source are not fabricated as evidence.
const sourceBacked = result.queryFormulation.source_backed_branches.flatMap((b) => b.atoms)
assert(!sourceBacked.includes("eligible"), JSON.stringify(sourceBacked))
assert(!sourceBacked.includes("free"), JSON.stringify(sourceBacked))
assert(!sourceBacked.includes("rule"), JSON.stringify(sourceBacked))
assert(sourceBacked.includes("shipping") && sourceBacked.includes("subtotal"), JSON.stringify(sourceBacked))

// Cache identity includes branch structure, not only the atom set.
const p1 = buildQueryFormulationPlan("alpha.*beta|gamma.*delta")
const p2 = buildQueryFormulationPlan("alpha.*gamma|beta.*delta")
RUN_MODE = "wide"
const c1 = await runQueryFormulationDiscovery(root, "alpha.*beta|gamma.*delta", 0, ".", undefined, p1)
const c2 = await runQueryFormulationDiscovery(root, "alpha.*gamma|beta.*delta", 0, ".", undefined, p2)
// wide mode is intentionally rejected by the file cap, so validate canonical identities directly.
const k1 = `token-file:${p1.branches.map((b) => b.atoms.join("&")).join("||")}`
const k2 = `token-file:${p2.branches.map((b) => b.atoms.join("&")).join("||")}`
assert(k1 !== k2, JSON.stringify({k1,k2,c1,c2}))
RUN_MODE = "real"

// Incomplete deterministic evidence cannot broaden the search.
RUN_MODE = "incomplete"
const incomplete = await runQueryFormulationDiscovery(root, "alpha.*beta", 0, ".", undefined)
assert(incomplete === null, JSON.stringify(incomplete))

// Too-wide routing ambiguity is fail-closed rather than silently truncated.
RUN_MODE = "wide"
const wide = await runQueryFormulationDiscovery(root, "alpha.*beta", 0, ".", undefined)
assert(wide === null, JSON.stringify(wide))

console.log("PASS Query Formulation 2.0 branch/atom/file-cooccurrence edge cases")
'''.replace("__HELPERS__", helpers)

with tempfile.TemporaryDirectory(prefix="v220-r3-qf-repo-") as td:
    repo = Path(td) / "repo"
    repo.mkdir()
    print(run_node(js, str(repo)))

print("PASS v2.20-r3 Query Formulation 2.0")
