import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import {
  CAUSAL_DISPATCH_CONTRACT_PROTOCOL,
  deriveCausalDispatchContract,
} from "../../opencode/plugins/cpu-search-core/causal-dispatch-contract-v1.mjs"
import {
  classifyCompilerOwnedSourceValue,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha(value) {
  return createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("hex")
}

const h = (char) => char.repeat(64)

const operations = [
  { id: "op_0", obligation: "server_surface", kind: "python_declaration" },
  { id: "op_1", obligation: "navigation_integration", kind: "replacement" },
  { id: "op_2", obligation: "ui_surface", kind: "creation" },
]

const semanticContract = {
  ok: true,
  contract_sha256: h("a"),
  operations,
}

const semanticAttestation = {
  protocol: "semantic-obligation-bridge-v1",
  contract_sha256: h("a"),
  attestation_sha256: h("b"),
  capability_fingerprint_sha256: h("c"),
  operation_ids: ["op_0", "op_1", "op_2"],
}

const rows = [
  {
    source_key: "server_surface",
    operation_id: "op_0",
    operation_index: 0,
    obligation: "server_surface",
    kind: "python_declaration",
    mode: null,
    max_bytes: 6144,
  },
  {
    source_key: "navigation_integration",
    operation_id: "op_1",
    operation_index: 1,
    obligation: "navigation_integration",
    kind: "replacement",
    mode: "after",
    max_bytes: 2048,
  },
  {
    source_key: "ui_surface",
    operation_id: "op_2",
    operation_index: 2,
    obligation: "ui_surface",
    kind: "creation",
    mode: "create",
    max_bytes: 8192,
  },
]

function binding(required) {
  const core = {
    protocol: "source-slot-compiler-v1",
    capability_sha256: h("d"),
    authority_sha256: h("e"),
    semantic_contract_sha256: h("a"),
    semantic_attestation_sha256: h("b"),
    execution_context_sha256: h("f"),
    source_spec_sha256: h("1"),
    model_schema_sha256: h("2"),
    repair_cache_sha256:
      required.length === rows.length ? null : h("3"),
    required_source_keys: [...required],
    all_source_rows: rows.map((row) => ({ ...row })),
    mutation_authority: false,
  }
  return {
    ...core,
    binding_sha256: sha(core),
  }
}

function rehash(value) {
  const core = { ...value }
  delete core.binding_sha256
  return { ...core, binding_sha256: sha(core) }
}

const common = {
  semanticContract,
  semanticAttestation,
  executionState: "mutate",
  selectedAction: "execute_additive_plan",
  selectedSource: "compiled_execution_capsule",
  executionContextCapsuleSha256: h("f"),
  executionContractSha256: h("9"),
}

const full = deriveCausalDispatchContract({
  ...common,
  sourceSlotBinding: binding([
    "server_surface",
    "navigation_integration",
    "ui_surface",
  ]),
})

assert.equal(full.ok, true, JSON.stringify(full, null, 2))
assert.equal(full.protocol, CAUSAL_DISPATCH_CONTRACT_PROTOCOL)
assert.deepEqual(
  full.active_operation_ids,
  ["op_0", "op_1", "op_2"],
)
assert.deepEqual(full.preserved_operation_ids, [])
assert.equal(full.canonical_operation_count, 3)
assert.equal(full.active_operation_count, 3)
assert.equal(full.required_operations.length, 3)
assert.equal(full.mutation_authority, false)

const repair = deriveCausalDispatchContract({
  ...common,
  executionState: "repair",
  selectedSource:
    "persisted_execution_capsule_repair_projection",
  sourceSlotBinding: binding(["server_surface"]),
})

assert.equal(repair.ok, true, JSON.stringify(repair, null, 2))
assert.equal(
  repair.reason,
  "dispatch_contract_causal_frontier_projected",
)
assert.deepEqual(repair.required_source_keys, ["server_surface"])
assert.deepEqual(repair.active_operation_ids, ["op_0"])
assert.deepEqual(
  repair.preserved_operation_ids,
  ["op_1", "op_2"],
)
assert.deepEqual(
  repair.required_operations.map((row) => row.id),
  ["op_0"],
)
assert.equal(repair.canonical_operation_count, 3)
assert.equal(repair.active_operation_count, 1)
assert.equal(repair.semantic_contract_sha256, h("a"))

const unknown = rehash({
  ...binding(["server_surface"]),
  required_source_keys: ["unknown_surface"],
})
const unknownResult = deriveCausalDispatchContract({
  ...common,
  sourceSlotBinding: unknown,
})
assert.equal(unknownResult.ok, false)
assert.equal(
  unknownResult.reason,
  "dispatch_contract_source_key_unknown",
)

const tampered = {
  ...binding(["server_surface"]),
  binding_sha256: h("0"),
}
const tamperedResult = deriveCausalDispatchContract({
  ...common,
  sourceSlotBinding: tampered,
})
assert.equal(tamperedResult.ok, false)
assert.equal(
  tamperedResult.reason,
  "dispatch_contract_source_binding_invalid",
)

const drift = binding(["server_surface"])
drift.all_source_rows[0].operation_id = "op_1"
const driftResult = deriveCausalDispatchContract({
  ...common,
  sourceSlotBinding: rehash(drift),
})
assert.equal(driftResult.ok, false)
assert.equal(
  driftResult.reason,
  "dispatch_contract_source_row_semantic_drift",
)

const badAttestation = deriveCausalDispatchContract({
  ...common,
  semanticAttestation: {
    ...semanticAttestation,
    operation_ids: ["op_0", "op_2", "op_1"],
  },
  sourceSlotBinding: binding(["server_surface"]),
})
assert.equal(badAttestation.ok, false)
assert.equal(
  badAttestation.reason,
  "dispatch_contract_canonical_operation_invalid",
)

const capability = {
  existing_slots: [
    { slot: "existing:0", file: "src/module.py" },
    { slot: "existing:1", file: "templates/menu.html" },
  ],
  create_slots: [
    { slot: "create:0", source_file: "templates/source.html" },
  ],
  host_bindings: {
    route_owner: "src/module.py",
    navigation_host: "templates/menu.html",
  },
}

const echo = classifyCompilerOwnedSourceValue({
  value: "src/module.py\n",
  capability,
  binding: binding(["server_surface"]),
})
assert.equal(echo?.matched, true)
assert.equal(
  echo?.reason,
  "source_slot_compiler_owned_value_echo",
)
assert.equal(echo?.echo_kind, "target_file")
assert.match(echo?.echo_sha256 ?? "", /^[0-9a-f]{64}$/u)

const operationEcho = classifyCompilerOwnedSourceValue({
  value: "op_0",
  capability,
  binding: binding(["server_surface"]),
})
assert.equal(operationEcho?.matched, true)
assert.equal(operationEcho?.echo_kind, "operation_id")

assert.equal(
  classifyCompilerOwnedSourceValue({
    value: "def handler():\n    return 1\n",
    capability,
    binding: binding(["server_surface"]),
  }),
  null,
)

const fragment00 = await readFile(
  "opencode/plugins/cpu-search.fragments/00.part.ts",
  "utf8",
)
const sourceSlot = await readFile(
  "opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs",
  "utf8",
)

const start = fragment00.indexOf(
  "function buildStructuredMutationControlEnvelope",
)
const end = fragment00.indexOf(
  "\nfunction compileMutationPhaseContext",
  start,
)
assert.notEqual(start, -1)
assert.notEqual(end, -1)
const body = fragment00.slice(start, end)

assert.match(body, /deriveCausalDispatchContract/u)
assert.match(body, /activeSourceSlotContract/u)
assert.match(body, /dispatchContract\.required_operations/u)
assert.doesNotMatch(body, /index < operations\.length/u)

assert.match(sourceSlot, /classifyCompilerOwnedSourceValue/u)
assert.match(
  sourceSlot,
  /source_slot_compiler_owned_value_echo/u,
)
assert.match(
  sourceSlot,
  /never return a target filename\/path as the value/u,
)
assert.match(
  sourceSlot,
  /Static top-level import\/import-from statements may precede one or more/u,
)
assert.match(
  sourceSlot,
  /the value is source text itself, never a target filename\/path/u,
)

console.log(
  "PASS R7-R4-D causal dispatch contract " +
  "canonical_obligations=immutable " +
  "repair_frontier=source_keys_biject_operation_ids " +
  "structured_control=causal_subset " +
  "compiler_owned_echo=typed_fail_closed " +
  "authority_expansion=false",
)
