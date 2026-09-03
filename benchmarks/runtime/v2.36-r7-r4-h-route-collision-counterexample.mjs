import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import {
  buildSourceSlotRepairCache,
  sourceSlotRepairAuthorityMatches,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"
import {
  deriveExistingRouteSourceCounterexample,
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
      "@bp.route('/existing')\n" +
      "def new_page():\n" +
      "    return 'x'",
    navigation_integration:
      "<a href=\"/new\">New</a>",
    ui_surface:
      "<html><body>new</body></html>",
  },
}

const routeFailure = {
  reason: "semantic_python_existing_route_forbidden",
  id: "op_0",
  operation_id: "op_0",
  operation_index: 0,
  frontend_reason: "semantic_python_existing_route_forbidden",
  frontend: {
    ok: false,
    protocol: "python-semantic-frontend-v3",
    reason: "semantic_python_existing_route_forbidden",
    routes: ["/existing"],
    mutation_authority: false,
    model_import_authority: false,
  },
}

const cache = buildSourceSlotRepairCache({
  binding,
  request,
  failure: routeFailure,
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

const counterexample = deriveExistingRouteSourceCounterexample({
  failure: routeFailure,
  request,
  binding,
  repairCache: cache,
})
assert.equal(counterexample.ok, true, JSON.stringify(counterexample, null, 2))
assert.equal(counterexample.layer, "route_collision")
assert.equal(counterexample.source_key, "server_surface")
assert.equal(counterexample.operation_id, "op_0")
assert.equal(counterexample.operation_index, 0)
assert.equal(counterexample.diagnostic.collision_route, "/existing")
assert.equal(counterexample.proof_vector.representation, "pass")
assert.equal(counterexample.proof_vector.syntax, "pass")
assert.equal(counterexample.proof_vector.required_declarations, "pass")
assert.equal(counterexample.proof_vector.semantic_lowering, "fail")
assert.equal(counterexample.extended_repair_eligible, true)
assert.equal(counterexample.mutation_authority, false)

const rendered = renderTypedCounterexampleForModel(counterexample)
assert.match(rendered, /CE route_collision/u)
assert.match(rendered, /src=server_surface/u)
assert.match(rendered, /collision_route="\/existing"/u)
assert.match(rendered, /auto_fix=false/u)
assert.ok(Buffer.byteLength(rendered, "utf8") <= 144)

const priorLedger = [{
  candidate_source_sha256: h("2"),
  counterexample_sha256: h("3"),
}]
const admitted = decideSourceCounterexampleRepairAdmission({
  counterexample,
  priorLedger,
  repairDispatches: 1,
  failureCount: 1,
})
assert.equal(admitted.ok, true)
assert.equal(admitted.admit_retry, true)
assert.equal(admitted.next_repair_dispatches, 2)
assert.equal(admitted.next_failure_count, 2)

const duplicate = decideSourceCounterexampleRepairAdmission({
  counterexample,
  priorLedger: admitted.next_ledger,
  repairDispatches: 2,
  failureCount: 2,
})
assert.equal(duplicate.ok, true)
assert.equal(duplicate.admit_retry, false)
assert.equal(duplicate.reason, "source_counterexample_no_progress")

const changed = {
  ...counterexample,
  candidate_source_sha256: h("4"),
  counterexample_sha256: h("5"),
}
const ceiling = decideSourceCounterexampleRepairAdmission({
  counterexample: changed,
  priorLedger: admitted.next_ledger,
  repairDispatches: 2,
  failureCount: 2,
})
assert.equal(ceiling.ok, true)
assert.equal(ceiling.admit_retry, false)
assert.equal(ceiling.reason, "source_counterexample_repair_ceiling")

for (const [label, failure] of [
  ["operation_index_drift", { ...routeFailure, operation_index: 1 }],
  ["operation_id_drift", {
    ...routeFailure,
    id: "op_1",
    operation_id: "op_1",
  }],
  ["multiple_collisions_terminal", {
    ...routeFailure,
    frontend: {
      ...routeFailure.frontend,
      routes: ["/a", "/b"],
    },
  }],
  ["relative_route_invalid", {
    ...routeFailure,
    frontend: {
      ...routeFailure.frontend,
      routes: ["existing"],
    },
  }],
  ["frontend_reason_drift", {
    ...routeFailure,
    frontend: {
      ...routeFailure.frontend,
      reason: "semantic_python_binding_unresolved",
    },
  }],
]) {
  const bad = deriveExistingRouteSourceCounterexample({
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
  deriveExistingRouteSourceCounterexample({
    failure: routeFailure,
    request,
    binding,
    repairCache: badCache,
  }).ok,
  false,
)

assert.equal(
  pythonSemanticFailureIsRepairable(routeFailure),
  false,
  "legacy/no-source-slot route collision policy must stay terminal",
)

const frontendSource = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search-core/python-semantic-frontend-v1.py",
    import.meta.url,
  ),
  "utf8",
)
assert.match(frontendSource, /semantic_python_existing_route_forbidden/u)
assert.match(frontendSource, /routes=route_collisions/u)

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

assert.match(fragment00, /deriveExistingRouteSourceCounterexample/u)

const start = fragment09.indexOf(
  "// R7-R4-H: an exact existing-route collision",
)
const end = fragment09.indexOf(
  "// R7-R4-G: a deterministic semantic binding counterexample",
  start,
)
assert.ok(start >= 0 && end > start)
const closure = fragment09.slice(start, end)

for (const required of [
  "semantic_python_existing_route_forbidden",
  "sourceSlotRepairAuthorityMatches",
  "deriveExistingRouteSourceCounterexample",
  "decideSourceCounterexampleRepairAdmission",
  "sourceRepairCache.failed_source_keys.length === 1",
  "state.sourceCounterexampleLedger",
  "state.sourceRepairDispatches",
  "typed_counterexample:",
  "collision_route=",
  "semantic_attempt_consumed: false",
  "mutation_authority: false",
]) {
  assert.ok(closure.includes(required), `route closure missing ${required}`)
}
assert.doesNotMatch(closure, /state\.mutationAttempts\s*\+=\s*1/u)
assert.doesNotMatch(closure, /readFile|writeFile|auto.?route|auto.?fix/iu)

console.log(
  "PASS R7-R4-H route-collision counterexample closure " +
    "collision_guard=unchanged " +
    "single_route_witness=deterministic " +
    "legacy_route_policy=terminal " +
    "source_repair=existing_bounded_cegis_second_dispatch " +
    "accepted_siblings=authority_preserved " +
    "semantic_attempt_budget=unchanged " +
    "auto_route=false mutation_authority=false",
)
