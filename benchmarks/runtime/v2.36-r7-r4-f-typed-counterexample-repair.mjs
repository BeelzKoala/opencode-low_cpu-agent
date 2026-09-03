import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import {
  buildSourceSlotRepairCache,
  sourceSlotRepairAuthorityMatches,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"
import {
  SOURCE_COUNTEREXAMPLE_MAX_REPAIRS,
  deriveSourceSlotCounterexample,
  decideSourceCounterexampleRepairAdmission,
  renderTypedCounterexampleForModel,
} from "../../opencode/plugins/cpu-search-core/typed-counterexample-v1.mjs"

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function hash(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex")
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

function binding(requiredSourceKeys, repairCacheSha = null) {
  const core = {
    protocol: "source-slot-compiler-v1",
    capability_sha256: h("a"),
    authority_sha256: h("b"),
    semantic_contract_sha256: h("c"),
    semantic_attestation_sha256: h("d"),
    execution_context_sha256: h("e"),
    source_spec_sha256: h("f"),
    model_schema_sha256: h("1"),
    repair_cache_sha256: repairCacheSha,
    required_source_keys: [...requiredSourceKeys],
    all_source_rows: rows.map((row) => ({ ...row })),
    mutation_authority: false,
  }
  return { ...core, binding_sha256: hash(core) }
}

const initialBinding = binding([
  "server_surface",
  "navigation_integration",
  "ui_surface",
])
const initialRequest = {
  sources: {
    server_surface: "from package import helper",
    navigation_integration: "<a href=\"/next\">Next</a>",
    ui_surface: "<html><body>surface</body></html>",
  },
}
const declarationFailure = {
  reason: "source_fragment_declaration_missing",
  source_key: "server_surface",
  operation_id: "op_0",
  operation_index: 0,
}
const cache1 = buildSourceSlotRepairCache({
  binding: initialBinding,
  request: initialRequest,
  failure: declarationFailure,
  capability,
  executionContextSha256: h("e"),
})
assert.equal(cache1.repairable, true, JSON.stringify(cache1, null, 2))
assert.deepEqual(Object.keys(cache1.accepted_sources).sort(), [
  "navigation_integration",
  "ui_surface",
])
assert.equal(cache1.failed_slots[0], "existing:0")
assert.equal(
  sourceSlotRepairAuthorityMatches({
    hint: cache1,
    capability,
    executionContextSha256: h("e"),
    binding: initialBinding,
  }),
  true,
)

const compositeSourceKeysFailure = {
  reason: "source_slot_composite_invalid",
  source_keys: [
    "server_surface",
    "navigation_integration",
  ],
}
const compositeCache = buildSourceSlotRepairCache({
  binding: initialBinding,
  request: initialRequest,
  failure: compositeSourceKeysFailure,
  capability,
  executionContextSha256: h("e"),
})
assert.equal(compositeCache.repairable, true, JSON.stringify(compositeCache, null, 2))
assert.deepEqual(
  compositeCache.failed_source_keys,
  ["server_surface", "navigation_integration"],
)
assert.deepEqual(
  compositeCache.failed_slots,
  ["existing:0", "existing:1"],
)
assert.deepEqual(Object.keys(compositeCache.accepted_sources), ["ui_surface"])
assert.equal(
  compositeCache.accepted_source_hashes.ui_surface,
  createHash("sha256")
    .update(initialRequest.sources.ui_surface, "utf8")
    .digest("hex"),
)
assert.equal(
  sourceSlotRepairAuthorityMatches({
    hint: compositeCache,
    capability,
    executionContextSha256: h("e"),
    binding: initialBinding,
  }),
  true,
)

const compositeNestedFailure = {
  reason: "source_slot_composite_invalid",
  source_keys: [
    "server_surface",
    "navigation_integration",
  ],
  source_failures: [
    {
      reason: "source_fragment_declaration_missing",
      source_key: "server_surface",
      operation_id: "op_0",
      operation_index: 0,
    },
    {
      reason: "source_fragment_target_family_invalid",
      source_key: "navigation_integration",
      operation_id: "op_1",
      operation_index: 1,
    },
  ],
}
const nestedCompositeCache = buildSourceSlotRepairCache({
  binding: initialBinding,
  request: initialRequest,
  failure: compositeNestedFailure,
  capability,
  executionContextSha256: h("e"),
})
assert.equal(
  nestedCompositeCache.repairable,
  true,
  JSON.stringify(nestedCompositeCache, null, 2),
)
assert.deepEqual(
  nestedCompositeCache.failed_source_keys,
  compositeCache.failed_source_keys,
)

const legacyFailuresComposite = buildSourceSlotRepairCache({
  binding: initialBinding,
  request: initialRequest,
  failure: {
    reason: "source_slot_composite_invalid",
    failures: [
      { operation_id: "op_0" },
      { operation_index: 1 },
    ],
  },
  capability,
  executionContextSha256: h("e"),
})
assert.equal(legacyFailuresComposite.repairable, true)
assert.deepEqual(
  legacyFailuresComposite.failed_source_keys,
  ["server_surface", "navigation_integration"],
)

const conflictingComposite = buildSourceSlotRepairCache({
  binding: initialBinding,
  request: initialRequest,
  failure: {
    reason: "source_slot_composite_invalid",
    source_keys: [
      "server_surface",
      "navigation_integration",
    ],
    source_failures: [
      { source_key: "server_surface" },
      { source_key: "ui_surface" },
    ],
  },
  capability,
  executionContextSha256: h("e"),
})
assert.equal(conflictingComposite.repairable, false)

const duplicateComposite = buildSourceSlotRepairCache({
  binding: initialBinding,
  request: initialRequest,
  failure: {
    reason: "source_slot_composite_invalid",
    source_keys: [
      "server_surface",
      "server_surface",
    ],
  },
  capability,
  executionContextSha256: h("e"),
})
assert.equal(duplicateComposite.repairable, false)

const unknownComposite = buildSourceSlotRepairCache({
  binding: initialBinding,
  request: initialRequest,
  failure: {
    reason: "source_slot_composite_invalid",
    source_keys: ["unknown_surface"],
  },
  capability,
  executionContextSha256: h("e"),
})
assert.equal(unknownComposite.repairable, false)

const repairBinding = binding(["server_surface"], cache1.cache_sha256)
const repairedRequest = {
  sources: {
    server_surface: "from package import helper\n\ndef handler():\n    return helper()",
  },
}
const syntaxFailure = {
  reason: "source_fragment_syntax_invalid",
  source_key: "server_surface",
  operation_id: "op_0",
  operation_index: 0,
  frontend: {
    reason: "source_fragment_syntax_invalid",
    detail: "invalid syntax at line 3 column 1",
  },
}
const cache2 = buildSourceSlotRepairCache({
  binding: repairBinding,
  request: repairedRequest,
  failure: syntaxFailure,
  capability,
  executionContextSha256: h("e"),
  priorRepairCache: cache1,
})
assert.equal(cache2.repairable, true, JSON.stringify(cache2, null, 2))
assert.deepEqual(cache2.accepted_sources, cache1.accepted_sources)
assert.deepEqual(cache2.accepted_source_hashes, cache1.accepted_source_hashes)
assert.equal(
  sourceSlotRepairAuthorityMatches({
    hint: cache2,
    capability,
    executionContextSha256: h("e"),
    binding: repairBinding,
  }),
  true,
)

const badBinding = binding(["server_surface"], h("0"))
const rejectedRollForward = buildSourceSlotRepairCache({
  binding: badBinding,
  request: repairedRequest,
  failure: syntaxFailure,
  capability,
  executionContextSha256: h("e"),
  priorRepairCache: cache1,
})
assert.equal(rejectedRollForward.repairable, false)

const ce1 = deriveSourceSlotCounterexample({
  failure: declarationFailure,
  request: initialRequest,
  binding: initialBinding,
})
assert.equal(ce1.ok, true)
assert.equal(ce1.layer, "structure")
assert.equal(ce1.proof_vector.representation, "pass")
assert.equal(ce1.proof_vector.syntax, "pass")
assert.equal(ce1.proof_vector.required_declarations, "fail")
assert.equal(ce1.extended_repair_eligible, true)

const ce2 = deriveSourceSlotCounterexample({
  failure: syntaxFailure,
  request: repairedRequest,
  binding: repairBinding,
  priorRepairCache: cache1,
})
assert.equal(ce2.ok, true)
assert.equal(ce2.layer, "syntax")
assert.equal(ce2.proof_vector.representation, "pass")
assert.equal(ce2.proof_vector.syntax, "fail")
assert.equal(ce2.proof_vector.required_declarations, "unknown")
assert.equal(ce2.diagnostic.line, 3)
assert.equal(ce2.diagnostic.column, 1)

const rendered = renderTypedCounterexampleForModel(ce2)
assert.equal(typeof rendered, "string")
assert.ok(Buffer.byteLength(rendered, "utf8") <= 144)
assert.match(rendered, /CE syntax/u)
assert.match(rendered, /proof=R\+,S-,D\?/u)
assert.match(rendered, /require=valid_python_module_fragment/u)
assert.doesNotMatch(rendered, /def handler/u)
assert.doesNotMatch(rendered, /[0-9a-f]{64}/u)

const admitted1 = decideSourceCounterexampleRepairAdmission({
  counterexample: ce1,
  priorLedger: [],
  repairDispatches: 0,
  failureCount: 0,
})
assert.equal(admitted1.admit_retry, true)
assert.equal(admitted1.next_repair_dispatches, 1)
assert.equal(admitted1.next_failure_count, 1)

const admitted2 = decideSourceCounterexampleRepairAdmission({
  counterexample: ce2,
  priorLedger: admitted1.next_ledger,
  repairDispatches: admitted1.next_repair_dispatches,
  failureCount: admitted1.next_failure_count,
})
assert.equal(admitted2.admit_retry, true)
assert.equal(admitted2.next_repair_dispatches, 2)
assert.equal(admitted2.next_failure_count, 2)
assert.equal(SOURCE_COUNTEREXAMPLE_MAX_REPAIRS, 2)

const duplicate = decideSourceCounterexampleRepairAdmission({
  counterexample: ce2,
  priorLedger: admitted2.next_ledger,
  repairDispatches: admitted2.next_repair_dispatches,
  failureCount: admitted2.next_failure_count,
})
assert.equal(duplicate.admit_retry, false)
assert.equal(duplicate.reason, "source_counterexample_no_progress")

const changedThird = deriveSourceSlotCounterexample({
  failure: syntaxFailure,
  request: {
    sources: {
      server_surface: "def changed():\n    return 2",
    },
  },
  binding: repairBinding,
  priorRepairCache: cache2,
})
const ceiling = decideSourceCounterexampleRepairAdmission({
  counterexample: changedThird,
  priorLedger: admitted2.next_ledger,
  repairDispatches: 2,
  failureCount: 2,
})
assert.equal(ceiling.admit_retry, false)
assert.equal(ceiling.reason, "source_counterexample_repair_ceiling")

const generic = deriveSourceSlotCounterexample({
  failure: {
    ...syntaxFailure,
    reason: "source_fragment_unknown_failure",
  },
  request: repairedRequest,
  binding: repairBinding,
})
const genericSecond = decideSourceCounterexampleRepairAdmission({
  counterexample: generic,
  priorLedger: admitted1.next_ledger,
  repairDispatches: 1,
  failureCount: 1,
})
assert.equal(genericSecond.admit_retry, false)
assert.equal(
  genericSecond.reason,
  "source_counterexample_extended_repair_unproven",
)

const fragment01 = await readFile(
  "opencode/plugins/cpu-search.fragments/01.part.ts",
  "utf8",
)
const fragment09 = await readFile(
  "opencode/plugins/cpu-search.fragments/09.part.ts",
  "utf8",
)
const modelContext = await readFile(
  "opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs",
  "utf8",
)
const sourceSlotCompiler = await readFile(
  "opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs",
  "utf8",
)

const directFailedSourceKeyMatches =
  sourceSlotCompiler.match(/function directFailedSourceKey\(/gu) ?? []
const failedSourceKeysMatches =
  sourceSlotCompiler.match(/function failedSourceKeys\(/gu) ?? []
assert.equal(directFailedSourceKeyMatches.length, 1)
assert.equal(failedSourceKeysMatches.length, 1)
assert.match(
  sourceSlotCompiler,
  /const failedKeys = failedSourceKeys\(binding, failure\)/u,
)
assert.match(
  sourceSlotCompiler,
  /"source_keys", "failed_source_keys"/u,
)
assert.match(
  sourceSlotCompiler,
  /"source_failures", "failures"/u,
)
assert.match(
  sourceSlotCompiler,
  /sameSourceKeySet/u,
)

assert.match(fragment01, /sourceCounterexampleFailures:\s*0/u)
assert.match(fragment01, /sourceRepairDispatches:\s*0/u)
assert.match(fragment01, /sourceCounterexampleLedger:\s*\[\]/u)
assert.match(fragment01, /state\.sourceCounterexampleFailures\s*=\s*0/u)
assert.match(fragment01, /state\.sourceRepairDispatches\s*=\s*0/u)

const sourceBlockStart = fragment09.indexOf(
  "if (sourceSlotRehydration.ok !== true) {",
)
const semanticStart = fragment09.indexOf(
  "const semanticInput =",
  sourceBlockStart,
)
assert.ok(sourceBlockStart >= 0 && semanticStart > sourceBlockStart)
const sourceBlock = fragment09.slice(sourceBlockStart, semanticStart)
assert.match(sourceBlock, /deriveSourceSlotCounterexample/u)
assert.match(sourceBlock, /decideSourceCounterexampleRepairAdmission/u)
assert.match(sourceBlock, /priorRepairCache/u)
assert.match(sourceBlock, /typed_counterexample/u)
assert.match(sourceBlock, /source_slot_composite_invalid/u)
assert.match(sourceBlock, /source_counterexample_composite_causal_once/u)
assert.doesNotMatch(sourceBlock, /MAX_PATCH_ATTEMPTS_PER_TURN/u)
assert.doesNotMatch(sourceBlock, /mutationAttempts\s*\+=\s*1/u)
assert.match(fragment09, /MAX_PATCH_ATTEMPTS_PER_TURN/u)
assert.match(fragment09, /mutationAttempts\s*\+=\s*1/u)
assert.match(modelContext, /renderTypedCounterexampleForModel/u)
assert.match(modelContext, /repairHint\?\.failure_reason/u)

console.log(
  "PASS R7-R4-F typed counterexample repair " +
  "typed_counterexample=proof_vector " +
  "source_repair=bounded_2 " +
  "cache_roll_forward=byte_preserved " +
  "composite_repair=causal_n_slot_compatible " +
  "semantic_mutation_budget=separate " +
  "no_progress=fail_closed mutation_authority=false",
)
