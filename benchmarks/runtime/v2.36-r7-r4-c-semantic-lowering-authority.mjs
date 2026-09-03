import assert from "node:assert/strict"

import {
  ADDITIVE_SEMANTIC_LOWERING_PROTOCOL,
  proveAdditiveSemanticLoweringAuthority,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v3.mjs"
import {
  bindSourceSlotToolSchema,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  operation: "additive_surface",
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/server.py",
      roles: ["task_anchor_owner"],
      allowed_operations: ["replace_exact"],
    },
    {
      slot: "existing:1",
      file: "templates/snippets/menu.html",
      roles: ["navigation_host"],
      allowed_operations: ["replace_exact"],
    },
  ],
  create_slots: [
    {
      slot: "create:0",
      root: "templates",
      source_file: "templates/source.html",
      allowed_extensions: [".html"],
      allowed_operations: ["create_file"],
    },
  ],
}

const operations = [
  {
    id: "op_0",
    obligation: "server_surface",
    slot: "existing:0",
    kind: "python_declaration",
  },
  {
    id: "op_1",
    obligation: "navigation_integration",
    slot: "existing:1",
    kind: "replacement",
  },
  {
    id: "op_2",
    obligation: "ui_surface",
    slot: "create:0",
    kind: "creation",
  },
]

const pythonProof =
  proveAdditiveSemanticLoweringAuthority({
    capability,
    operation: operations[0],
  })
assert.equal(pythonProof.ok, true, JSON.stringify(pythonProof))
assert.equal(
  pythonProof.protocol,
  ADDITIVE_SEMANTIC_LOWERING_PROTOCOL,
)
assert.equal(pythonProof.semantic_operation, "python_declaration")
assert.equal(pythonProof.physical_operation, "replace_exact")
assert.equal(
  pythonProof.lowering_protocol,
  "typed-python-additive-compiler-v1",
)
assert.equal(pythonProof.supports_python_imports, true)
assert.equal(pythonProof.authority_expansion, false)
assert.equal(pythonProof.model_authority_expansion, false)

const replacementProof =
  proveAdditiveSemanticLoweringAuthority({
    capability,
    operation: operations[1],
  })
assert.equal(replacementProof.ok, true, JSON.stringify(replacementProof))
assert.equal(replacementProof.physical_operation, "replace_exact")
assert.equal(replacementProof.lowering_protocol, "identity")
assert.equal(replacementProof.authority_expansion, false)

const creationProof =
  proveAdditiveSemanticLoweringAuthority({
    capability,
    operation: operations[2],
  })
assert.equal(creationProof.ok, true, JSON.stringify(creationProof))
assert.equal(creationProof.physical_operation, "create_file")
assert.equal(creationProof.lowering_protocol, "identity")
assert.equal(creationProof.authority_expansion, false)

const contract = {
  ok: true,
  contract_sha256: "c".repeat(64),
  operations,
}

const semanticAttestation = {
  attestation_sha256: "d".repeat(64),
  contract_sha256: contract.contract_sha256,
}

const tool = {
  name: "execute_additive_plan",
  input: {
    type: "object",
    properties: {
      legacy: {
        type: "string",
      },
    },
  },
}

const bound = bindSourceSlotToolSchema({
  tool,
  capability,
  contract,
  semanticAttestation,
  executionContextSha256: "e".repeat(64),
})
assert.equal(bound.ok, true, JSON.stringify(bound, null, 2))
assert.equal(bound.reason, "source_slot_schema_bound")
assert.deepEqual(
  Object.keys(bound.tool.input.properties),
  ["sources"],
)
assert.deepEqual(
  bound.binding.required_source_keys,
  [
    "server_surface",
    "navigation_integration",
    "ui_surface",
  ],
)
assert(bound.model_schema_bytes < 2500, bound.model_schema_bytes)

const deniedCapability = {
  ...capability,
  capability_sha256: "f".repeat(64),
  existing_slots: capability.existing_slots.map((slot) =>
    slot.slot === "existing:0"
      ? {
          ...slot,
          allowed_operations: [],
        }
      : slot,
  ),
}

const denied = bindSourceSlotToolSchema({
  tool,
  capability: deniedCapability,
  contract,
  semanticAttestation,
  executionContextSha256: "e".repeat(64),
})
assert.equal(denied.ok, false, JSON.stringify(denied))
assert.equal(
  denied.reason,
  "source_slot_operation_lowering_authority_unproven",
)
assert.equal(
  denied.lowering_authority_reason,
  "semantic_lowering_physical_authority_missing",
)
assert.notEqual(denied.not_applicable, true)

console.log(
  "PASS R7-R4-C semantic lowering authority " +
  "python_declaration=replace_exact " +
  "python_imports=same_compiler_authority " +
  "replacement=replace_exact creation=create_file " +
  "source_slot=real_physical_capability " +
  "authority_expansion=false",
)
