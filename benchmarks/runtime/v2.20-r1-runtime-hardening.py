#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
SPEC = ROOT / "benchmarks/v2.20-r1-runtime-hardening-gates.json"


def block(source: str, start_marker: str, end_marker: str) -> str:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


def run_node(source: str, *args: str) -> str:
    with tempfile.TemporaryDirectory(prefix="v220-r1-gate-") as td:
        script = Path(td) / "gate.mjs"
        script.write_text(source, encoding="utf-8")
        cp = subprocess.run(
            ["node", str(script), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if cp.returncode != 0:
            Path("/tmp/v220-r1-failed-gate.mjs").write_text(source, encoding="utf-8")
        assert cp.returncode == 0, (cp.stdout, cp.stderr)
        return cp.stdout.strip()


s = PLUGIN.read_text(encoding="utf-8")
spec = json.loads(SPEC.read_text(encoding="utf-8"))
inv = spec["invariants"]

# Existing resource/security contracts stay fixed.
for anchor in (
    'if (role === "call") return 5',
    'if (role === "assignment") return 4',
    'if (role === "definition") return 3',
    'if (role === "import") return 2',
    'if (role === "reference") return 1',
    'const MAX_PATCH_ATTEMPTS_PER_TURN = 2',
    'const MAX_EXECUTED_SEARCHES_PER_TURN = 4',
    'const MAX_MODEL_CALLS_PER_TURN = 4',
    'MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"',
):
    assert anchor in s, anchor

# Runtime hardening anchors.
for anchor in (
    'function normalizeMutationCandidateEol(',
    'SOURCE_GLOB_INVENTORY_PROTOCOL = "source-glob-inventory-v1"',
    'const SOURCE_GLOB_INVENTORY_TIMEOUT_MS = 500',
    'const SOURCE_GLOB_INVENTORY_MAX_FILES = 20_000',
    'const SOURCE_GLOB_INVENTORY_MAX_STDOUT_BYTES = 2 * 1024 * 1024',
    'const SOURCE_GLOB_FALLBACK_MAX_EXTENSIONS = 12',
    'function parseSimpleLanguageGlob(',
    'function runSourceGlobInventory(',
    'async function resolveSearchLanguageGlob(',
    'sourceInventoryCache: new Map()',
    'state.sourceInventoryCache.clear()',
    'requested_glob:',
    'effective_glob:',
    'glob_correction_reason:',
):
    assert anchor in s, anchor

# The observed escaped-literal EOL bug must be absent from the candidate path.
candidate_start = s.index('function normalizeMutationCandidateSlice(')
candidate_end = s.index('\nasync function confirmLocalMutationCompetitors(', candidate_start)
candidate_runtime = s[candidate_start:candidate_end]
for forbidden in (
    '.replaceAll("\\\\r\\\\n", "\\\\n")',
    '.replaceAll("\\\\r", "\\\\n")',
    '.split("\\\\n")',
    '.join("\\\\n")',
):
    assert forbidden not in candidate_runtime, forbidden

# Effective search semantics drive signature/cache/discovery.
resolve_call = s.index('await resolveSearchLanguageGlob(')
signature_call = s.index('const signature = searchSignature(', resolve_call)
discovery_call = s.index('runCompiledDiscovery(', signature_call)
assert resolve_call < signature_call < discovery_call

# Post-model mutation path still cannot issue authority or rediscover repo.
materialize_start = s.index('async function materializeCapabilityBoundMutation(')
materialize_end = s.index('\nconst PATCH_COMPILER_RETRY_REASONS', materialize_start)
materialize = s[materialize_start:materialize_end]
for forbidden in (
    'attestLocalMutationCapability(',
    'attestLocalMutationCandidateSet(',
    'runQuery(',
    'runDistiller(',
    'runFileDiscovery(',
    'resolveSearchLanguageGlob(',
):
    assert forbidden not in materialize, forbidden

assert inv["candidate_eol_normalization"] == "canonical_lf"
assert inv["language_glob_correction_requires_complete_inventory"] is True
assert inv["language_glob_correction_simple_suffix_only"] is True
assert inv["language_glob_correction_preserves_prefix"] is True
assert inv["language_glob_correction_when_requested_language_present"] is False
assert inv["language_glob_correction_on_incomplete_inventory"] is False
assert inv["language_glob_inventory_cache_scope"] == "turn"
assert inv["model_calls_added"] == 0
assert inv["compiler_changed"] is False
assert inv["executor_changed"] is False
assert inv["verifier_changed"] is False

# -------------------------------------------------------------------------
# Actual live candidate loader: real bytes -> lines -> exact semantic bind.
# -------------------------------------------------------------------------
loader = block(
    s,
    'async function loadLivePreauthorizedMutationCandidates(',
    '\nasync function bindReplaceNodeMutationCandidate(',
)
binder = block(
    s,
    'async function bindReplaceNodeMutationCandidate(',
    '\nasync function confirmLocalMutationCompetitors(',
)
selector = block(
    s,
    'function mutationCandidateIdentity(',
    '\nfunction validatedImpactMutationCandidateHits(',
)

loader_js = r"""
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const SCOUT_LOCAL_CAPABILITY_PROTOCOL = "scout-local-capability-v1"
const MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"
const MUTATION_CANDIDATE_MAX = 4
function normalizeMutationFile(x) {
  return typeof x === "string" ? x.replaceAll("\\", "/") : null
}
function evidenceFileKey(x) { return normalizeMutationFile(x) }
function canonicalMutationFile(root, file) { return evidenceFileKey(file) }
function sameAuthorizedScopeIdentity(a, b) {
  return !!a && !!b &&
    normalizeMutationFile(a.file) === normalizeMutationFile(b.file) &&
    a.symbol_name === b.symbol_name &&
    a.symbol_kind === b.symbol_kind &&
    a.start_line === b.start_line &&
    a.end_line === b.end_line
}
__SELECTOR__
let CAPSULE = null
async function readAuthorizedEditCapsule() { return {ok:true,capsule:CAPSULE} }
__LOADER__
__BINDER__
function assert(x, msg) { if (!x) throw new Error(msg) }

const root = process.argv[2]
const target = {
  file: "rule.py",
  symbol_kind: "function_definition",
  symbol_name: "rule",
  start_line: 1,
  end_line: 4,
}

for (const [name, body] of [
  ["lf", "def rule(x):\n    if x >= 50:\n        return 0\n    return 7"],
  ["lf-final", "def rule(x):\n    if x >= 50:\n        return 0\n    return 7\n"],
  ["crlf", "def rule(x):\r\n    if x >= 50:\r\n        return 0\r\n    return 7\r\n"],
  ["cr", "def rule(x):\r    if x >= 50:\r        return 0\r    return 7"],
  ["mixed", "def rule(x):\r\n    if x >= 50:\n        return 0\r    return 7"],
]) {
  await writeFile(path.join(root, target.file), body, "utf8")
  const bytes = await readFile(path.join(root, target.file))
  const digest = createHash("sha256").update(bytes).digest("hex")
  CAPSULE = {
    mutation_candidate_protocol: MUTATION_CANDIDATE_SET_PROTOCOL,
    mutation_candidate_count: 1,
    mutation_candidates: [{...target, source_sha256: digest}],
  }
  const state = {
    localMutationCandidates: [{
      target,
      capability: {
        protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
        replaceNodeReady: true,
        allowedMutations: ["replace_node"],
        localHandoffPath: ".opencode/cap/rule.json",
        targetSourceSha256: digest,
      },
    }],
    boundMutationTarget: null,
  }
  const loaded = await loadLivePreauthorizedMutationCandidates(root, state)
  assert(loaded.ok, JSON.stringify({name, loaded}))
  assert(
    loaded.candidates[0].live_source ===
      "def rule(x):\n    if x >= 50:\n        return 0\n    return 7",
    JSON.stringify({name, live: loaded.candidates[0].live_source}),
  )
  const bound = await bindReplaceNodeMutationCandidate(
    root,
    state,
    "def rule(x):\n    if x >= 50:\n        return 0\n    return 7",
  )
  assert(bound.ok, JSON.stringify({name, bound}))
}

// Stale file contents fail closed before semantic binding.
await writeFile(path.join(root, target.file), "def rule(x):\n    return 9", "utf8")
CAPSULE = {
  mutation_candidate_protocol: MUTATION_CANDIDATE_SET_PROTOCOL,
  mutation_candidate_count: 1,
  mutation_candidates: [{...target, source_sha256: "0".repeat(64)}],
}
const stale = await loadLivePreauthorizedMutationCandidates(root, {
  localMutationCandidates: [{
    target,
    capability: {
      protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
      replaceNodeReady: true,
      allowedMutations: ["replace_node"],
      localHandoffPath: ".opencode/cap/rule.json",
      targetSourceSha256: "0".repeat(64),
    },
  }],
})
assert(!stale.ok && stale.reason === "mutation_candidate_source_stale", JSON.stringify(stale))

// Invalid structural line ranges fail closed.
const body = "def rule(x):\n    return 9"
await writeFile(path.join(root, target.file), body, "utf8")
const digest = createHash("sha256").update(await readFile(path.join(root, target.file))).digest("hex")
const badTarget = {...target, end_line: 99}
CAPSULE = {
  mutation_candidate_protocol: MUTATION_CANDIDATE_SET_PROTOCOL,
  mutation_candidate_count: 1,
  mutation_candidates: [{...badTarget, source_sha256: digest}],
}
const badRange = await loadLivePreauthorizedMutationCandidates(root, {
  localMutationCandidates: [{
    target: badTarget,
    capability: {
      protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
      replaceNodeReady: true,
      allowedMutations: ["replace_node"],
      localHandoffPath: ".opencode/cap/rule.json",
      targetSourceSha256: digest,
    },
  }],
})
assert(!badRange.ok && badRange.reason === "mutation_candidate_live_range_invalid", JSON.stringify(badRange))

console.log("PASS actual live candidate loader EOL/fingerprint/range cases")
""".replace("__SELECTOR__", selector).replace("__LOADER__", loader).replace("__BINDER__", binder)

with tempfile.TemporaryDirectory(prefix="v220-live-loader-") as td:
    repo = Path(td) / "repo"
    repo.mkdir()
    print(run_node(loader_js, str(repo)))

# -------------------------------------------------------------------------
# Actual filesystem/ripgrep language-glob correction.
# -------------------------------------------------------------------------
glob_helpers = block(
    s,
    'function sourceExtensionFromFile(',
    '\nfunction isReservedAgentEvidencePath(',
)

glob_js = r"""
import { spawn } from "node:child_process"
import { mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const SOURCE_GLOB_INVENTORY_PROTOCOL = "source-glob-inventory-v1"
const SOURCE_GLOB_INVENTORY_TIMEOUT_MS = 500
let SOURCE_GLOB_INVENTORY_MAX_FILES = 20_000
const SOURCE_GLOB_INVENTORY_MAX_STDOUT_BYTES = 2 * 1024 * 1024
const SOURCE_GLOB_FALLBACK_MAX_EXTENSIONS = 12
const SOURCE_LANGUAGE_EXTENSIONS = Object.freeze([
  "py","pyi","js","jsx","mjs","cjs","ts","tsx","mts","cts",
  "html","htm","css","scss","sass","less","xml","sql",
])
const SOURCE_LANGUAGE_EXTENSION_SET = new Set(SOURCE_LANGUAGE_EXTENSIONS)
const EXCLUDES = [
  "!.git/**","!.opencode/**","!.agentbench/**",
  "!node_modules/**","!**/node_modules/**",
  "!.venv/**","!**/.venv/**","!venv/**","!**/venv/**",
  "!__pycache__/**","!**/__pycache__/**",
  "!dist/**","!**/dist/**","!build/**","!**/build/**",
]
function evidenceFileKey(raw) {
  return String(raw ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "")
}
__GLOB_HELPERS__
function assert(x, msg) { if (!x) throw new Error(msg) }
async function put(root, rel, body = "x") {
  const file = path.join(root, rel)
  await mkdir(path.dirname(file), {recursive:true})
  await writeFile(file, body, "utf8")
}
function state() { return {sourceInventoryCache:new Map()} }

const root = process.argv[2]

await put(root, "pyonly/a.py")
{
  const st = state()
  const r = await resolveSearchLanguageGlob(root, "pyonly", "**/*.js", st)
  assert(r.corrected && r.effectiveGlob === "**/*.py", JSON.stringify(r))
  assert(r.reason === "requested_language_absent", JSON.stringify(r))
  const cached = await resolveSearchLanguageGlob(root, "pyonly", "**/*.ts", st)
  assert(cached.inventoryCacheHit === true, JSON.stringify(cached))
}

await put(root, "mixed/a.py")
await put(root, "mixed/b.js")
{
  const r = await resolveSearchLanguageGlob(root, "mixed", "**/*.js", state())
  assert(!r.corrected && r.effectiveGlob === "**/*.js", JSON.stringify(r))
  assert(r.reason === "requested_language_present", JSON.stringify(r))
}

await put(root, "poly/a.py")
await put(root, "poly/b.ts")
{
  const r = await resolveSearchLanguageGlob(root, "poly", "**/*.js", state())
  assert(r.corrected && r.effectiveGlob === "**/*.{py,ts}", JSON.stringify(r))
}

await put(root, "scoped/src/a.py")
await put(root, "scoped/vendor/b.js")
{
  const r = await resolveSearchLanguageGlob(root, ".", "scoped/src/**/*.js", state())
  assert(r.corrected && r.effectiveGlob === "scoped/src/**/*.py", JSON.stringify(r))
}

await put(root, "single/rule.py")
{
  const r = await resolveSearchLanguageGlob(root, "single/rule.py", "**/*.js", state())
  assert(r.corrected && r.effectiveGlob === undefined, JSON.stringify(r))
  assert(r.reason === "explicit_file_path_overrides_absent_language_glob", JSON.stringify(r))
}

for (const glob of ["**/*", "**/*.d.ts", "!**/*.js", "**/*.JS", "**/*.md"]) {
  const r = await resolveSearchLanguageGlob(root, "pyonly", glob, state())
  assert(!r.corrected && r.effectiveGlob === glob, JSON.stringify({glob,r}))
}

await put(root, "brace/a.jsx")
{
  const r = await resolveSearchLanguageGlob(root, "brace", "**/*.{js,jsx}", state())
  assert(!r.corrected, JSON.stringify(r))
}

await put(root, "reserved/a.py")
await put(root, "reserved/node_modules/fake.js")
{
  const r = await resolveSearchLanguageGlob(root, "reserved", "**/*.js", state())
  assert(r.corrected && r.effectiveGlob === "**/*.py", JSON.stringify(r))
}

await put(root, "weird/name\npart.py")
{
  const r = await resolveSearchLanguageGlob(root, "weird", "**/*.js", state())
  assert(r.corrected && r.inventoryExtensions.py === 1, JSON.stringify(r))
}

// Complete absence of supported source files is not evidence for a rewrite.
await put(root, "docs/readme.md")
{
  const r = await resolveSearchLanguageGlob(root, "docs", "**/*.js", state())
  assert(!r.corrected && r.reason === "no_supported_source_files", JSON.stringify(r))
}

// Oversized polyglot fallback is not guessed/truncated.
for (const ext of [
  "py","pyi","js","jsx","mjs","cjs","ts","tsx","mts","cts","html","htm","css",
]) {
  await put(root, `wide/file.${ext}`)
}
{
  const r = await resolveSearchLanguageGlob(root, "wide", "**/*.xml", state())
  assert(!r.corrected && r.reason === "fallback_extension_set_too_wide", JSON.stringify(r))
}

// Unsupported exact-file suffix does not cause a language rewrite.
await put(root, "single/readme.md")
{
  const r = await resolveSearchLanguageGlob(root, "single/readme.md", "**/*.js", state())
  assert(!r.corrected && r.effectiveGlob === "**/*.js", JSON.stringify(r))
}

// A capped/incomplete inventory never proves requested-language absence.
await put(root, "capped/a.py")
await put(root, "capped/b.py")
SOURCE_GLOB_INVENTORY_MAX_FILES = 1
{
  const r = await resolveSearchLanguageGlob(root, "capped", "**/*.js", state())
  assert(!r.corrected && r.reason === "source_inventory_incomplete", JSON.stringify(r))
  assert(r.inventoryComplete === false, JSON.stringify(r))
}

console.log("PASS deterministic language-glob correction edge cases")
""".replace("__GLOB_HELPERS__", glob_helpers)

with tempfile.TemporaryDirectory(prefix="v220-glob-recovery-") as td:
    repo = Path(td) / "repo"
    repo.mkdir()
    print(run_node(glob_js, str(repo)))

print("PASS v2.20-r1 runtime hardening")
