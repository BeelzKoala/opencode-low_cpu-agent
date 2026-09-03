import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import {
  buildSourceSlotRepairCache,
  sourceSlotRepairAuthorityMatches,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"
import {
  deriveSemanticSourceCounterexample,
  decideSourceCounterexampleRepairAdmission,
  renderTypedCounterexampleForModel,
} from "../../opencode/plugins/cpu-search-core/typed-counterexample-v1.mjs"
import {
  pythonSemanticFailureIsRepairable,
} from "../../opencode/plugins/cpu-search-core/python-semantic-repair-v1.mjs"

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(",")}}`
  }
  return JSON.stringify(value)
}

function hash(value) {
  return createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("hex")
}

const h = (value) => value.repeat(64)
const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: h("a"),
  authority_sha256: h("b"),
}

const rows = [
  {
    source_key: "server_surface",
    operation_id: "op_0",
    operation_index: 0,
    obligation: "server_surface",
    kind: "python_declaration",
    slot: "existing:0",
    allow_module_imports: true,
    mode: null,
    max_bytes: 6144,
  },
  {
    source_key: "navigation_integration",
    operation_id: "op_1",
    operation_index: 1,
    obligation: "navigation_integration",
    kind: "replacement",
    slot: "existing:1",
    allow_module_imports: false,
    mode: "after",
    max_bytes: 2048,
  },
  {
    source_key: "ui_surface",
    operation_id: "op_2",
    operation_index: 2,
    obligation: "ui_surface",
    kind: "creation",
    slot: "create:0",
    allow_module_imports: false,
    mode: "create",
    max_bytes: 8192,
  },
]

const bindingCore = {
  protocol: "source-slot-compiler-v1",
  capability_sha256: h("a"),
  authority_sha256: h("b"),
  semantic_contract_sha256: h("c"),
  semantic_attestation_sha256: h("d"),
  execution_context_sha256: h("e"),
  source_spec_sha256: h("f"),
  model_schema_sha256: h("1"),
  repair_cache_sha256: null,
  required_source_keys: [
    "server_surface",
    "navigation_integration",
    "ui_surface",
  ],
  all_source_rows: rows.map((row) => ({ ...row })),
  mutation_authority: false,
}
const binding = {
  ...bindingCore,
  binding_sha256: hash(bindingCore),
}

const request = {
  sources: {
    server_surface:
      "import pandas as pd\n\n" +
      "@bp.route('/export')\n" +
      "def export_report():\n" +
      "    return pd.DataFrame(rows)",
    navigation_integration:
      "<a href=\"/export\">Export</a>",
    ui_surface:
      "<html><body>export</body></html>",
  },
}

const bindingFailure = {
  reason: "semantic_python_binding_unresolved",
  id: "op_0",
  operation_id: "op_0",
  operation_index: 0,
  unit_index: null,
  suite_index: null,
  field: null,
  frontend_reason: "semantic_python_binding_unresolved",
  frontend: {
    ok: false,
    protocol: "python-semantic-frontend-v3",
    reason: "semantic_python_binding_unresolved",
    symbol: "rows",
    free_names: ["bp", "pd", "rows"],
    mutation_authority: false,
    model_import_authority: false,
  },
}

const cache = buildSourceSlotRepairCache({
  binding,
  request,
  failure: bindingFailure,
  capability,
  executionContextSha256: h("e"),
})
assert.equal(cache.repairable, true, JSON.stringify(cache, null, 2))
assert.deepEqual(cache.failed_source_keys, ["server_surface"])
assert.deepEqual(cache.failed_slots, ["existing:0"])
assert.deepEqual(
  Object.keys(cache.accepted_sources).sort(),
  ["navigation_integration", "ui_surface"],
)
assert.equal(
  sourceSlotRepairAuthorityMatches({
    hint: cache,
    capability,
    executionContextSha256: h("e"),
    binding,
  }),
  true,
)

const counterexample = deriveSemanticSourceCounterexample({
  failure: bindingFailure,
  request,
  binding,
  repairCache: cache,
})
assert.equal(counterexample.ok, true, JSON.stringify(counterexample, null, 2))
assert.equal(counterexample.layer, "binding")
assert.equal(counterexample.source_key, "server_surface")
assert.equal(counterexample.operation_id, "op_0")
assert.equal(counterexample.operation_index, 0)
assert.equal(counterexample.diagnostic.symbol, "rows")
assert.equal(counterexample.diagnostic.free_name_count, 3)
assert.equal(counterexample.proof_vector.representation, "pass")
assert.equal(counterexample.proof_vector.syntax, "pass")
assert.equal(counterexample.proof_vector.required_declarations, "pass")
assert.equal(counterexample.proof_vector.semantic_lowering, "fail")
assert.equal(counterexample.proof_vector.materialization, "fail")
assert.equal(counterexample.extended_repair_eligible, true)
assert.equal(counterexample.mutation_authority, false)

const rendered = renderTypedCounterexampleForModel(counterexample)
assert.match(rendered, /CE binding/u)
assert.match(rendered, /src=server_surface/u)
assert.match(rendered, /unresolved=rows/u)
assert.match(rendered, /auto_fix=false/u)
assert.doesNotMatch(rendered, /bp,pd,rows/u)
assert.ok(Buffer.byteLength(rendered, "utf8") <= 144)

const admitted = decideSourceCounterexampleRepairAdmission({
  counterexample,
  priorLedger: [],
  repairDispatches: 0,
  failureCount: 0,
})
assert.equal(admitted.ok, true)
assert.equal(admitted.admit_retry, true)
assert.equal(admitted.next_repair_dispatches, 1)
assert.equal(admitted.next_failure_count, 1)

const duplicate = decideSourceCounterexampleRepairAdmission({
  counterexample,
  priorLedger: admitted.next_ledger,
  repairDispatches: 1,
  failureCount: 1,
})
assert.equal(duplicate.ok, true)
assert.equal(duplicate.admit_retry, false)
assert.equal(duplicate.reason, "source_counterexample_no_progress")

for (const [label, failure] of [
  ["operation_index_drift", { ...bindingFailure, operation_index: 1 }],
  [
    "operation_id_drift",
    { ...bindingFailure, id: "op_1", operation_id: "op_1" },
  ],
  [
    "symbol_missing",
    {
      ...bindingFailure,
      frontend: { ...bindingFailure.frontend, symbol: null },
    },
  ],
  [
    "symbol_not_free",
    {
      ...bindingFailure,
      frontend: { ...bindingFailure.frontend, symbol: "other" },
    },
  ],
  [
    "free_names_duplicate",
    {
      ...bindingFailure,
      frontend: {
        ...bindingFailure.frontend,
        free_names: ["bp", "rows", "rows"],
      },
    },
  ],
  [
    "free_names_nondeterministic_order",
    {
      ...bindingFailure,
      frontend: {
        ...bindingFailure.frontend,
        free_names: ["rows", "bp", "pd"],
      },
    },
  ],
]) {
  const bad = deriveSemanticSourceCounterexample({
    failure,
    request,
    binding,
    repairCache: cache,
  })
  assert.equal(bad.ok, false, label)
}

const badCache = {
  ...cache,
  failed_source_keys: ["navigation_integration"],
}
assert.equal(
  deriveSemanticSourceCounterexample({
    failure: bindingFailure,
    request,
    binding,
    repairCache: badCache,
  }).ok,
  false,
)

assert.equal(
  pythonSemanticFailureIsRepairable(bindingFailure),
  false,
  "legacy/no-source-slot binding policy must stay terminal",
)

const fragment00 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/00.part.ts",
    import.meta.url,
  ),
  "utf8",
)
const fragment09 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)
assert.match(fragment00, /deriveSemanticSourceCounterexample/u)

const start = fragment09.indexOf(
  "// R7-R4-G: a deterministic semantic binding counterexample",
)
const end = fragment09.indexOf("const fileFamilyRepairable", start)
assert.ok(start >= 0 && end > start)
const closure = fragment09.slice(start, end)

for (const required of [
  "semantic_python_binding_unresolved",
  "sourceSlotRepairAuthorityMatches",
  "deriveSemanticSourceCounterexample",
  "decideSourceCounterexampleRepairAdmission",
  "sourceRepairCache.failed_source_keys.length === 1",
  "state.sourceCounterexampleLedger",
  "state.sourceRepairDispatches",
  "typed_counterexample:",
  "PATCH_RETRY reason=",
  "semantic_attempt_consumed: false",
  "mutation_authority: false",
]) {
  assert.ok(closure.includes(required), `semantic source closure missing ${required}`)
}
assert.doesNotMatch(closure, /state\.mutationAttempts\s*\+=\s*1/u)
assert.doesNotMatch(closure, /writeFile|auto.?import|auto.?fix/iu)

console.log(
  "PASS R7-R4-G semantic-to-source counterexample closure " +
    "binding_failure=sealed_single_source " +
    "symbol_witness=deterministic " +
    "legacy_binding_policy=terminal " +
    "source_repair=existing_bounded_cegis " +
    "accepted_siblings=authority_preserved " +
    "semantic_attempt_budget=unchanged " +
    "auto_import=false mutation_authority=false",
)
