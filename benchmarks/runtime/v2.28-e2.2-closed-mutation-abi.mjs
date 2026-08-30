#!/usr/bin/env node
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  ADDITIVE_MUTATION_ABI_PROTOCOL,
  ADDITIVE_REPAIR_HINT_PROTOCOL,
  buildAdditiveRepairHint,
  additiveRepairAuthorityMatches,
  materializeAdditiveMutationPlan,
  validateAdditiveMutationRequest,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  authority_protocol: "sealed-additive-handoff-v1",
  existing_slots: [{
    slot: "existing:0",
    file: "routes/page.py",
  }],
  create_slots: [{
    slot: "create:0",
    root: "templates",
    allowed_extensions: [".html"],
    max_depth: 2,
  }],
}

const valid = {
  replacements: [{
    slot: "existing:0",
    before: "old",
    replacement: "new",
  }],
  creations: [{
    slot: "create:0",
    relative_path: "report.html",
    content: "<html></html>\n",
  }],
}

const plan = materializeAdditiveMutationPlan({
  capability,
  request: valid,
})
assert.equal(plan.ok, true)
assert.equal(plan.abi_protocol, ADDITIVE_MUTATION_ABI_PROTOCOL)
assert.deepEqual(plan.changed_files, [
  "routes/page.py",
  "templates/report.html",
])
assert.deepEqual(plan.mutations.map((m) => m.kind), [
  "replace_exact",
  "create_file",
])

assert.equal(validateAdditiveMutationRequest({
  operations: [],
}).reason, "additive_request_shape_invalid")

assert.equal(validateAdditiveMutationRequest({
  replacements: [],
  creations: [{
    slot: "create:0",
    path: "report.html",
    content: "x",
  }],
}).reason, "additive_create_shape_invalid")

const absolute = materializeAdditiveMutationPlan({
  capability,
  request: {
    replacements: [],
    creations: [{
      slot: "create:0",
      relative_path: "/tmp/repo/templates/report.html",
      content: "x",
    }],
  },
})
assert.equal(absolute.reason, "additive_create_relative_path_absolute")
assert.equal(absolute.repairable, true)

const restated = materializeAdditiveMutationPlan({
  capability,
  request: {
    replacements: [],
    creations: [{
      slot: "create:0",
      relative_path: "templates/report.html",
      content: "x",
    }],
  },
})
assert.equal(restated.ok, true)
assert.deepEqual(restated.changed_files, ["templates/report.html"])
assert.equal(restated.creation_count, 1)
assert.equal(restated.mutations.length, 1)
assert.equal(restated.mutations[0].kind, "create_file")
assert.equal(restated.mutations[0].file, "templates/report.html")

const rootOnly = materializeAdditiveMutationPlan({
  capability,
  request: {
    replacements: [],
    creations: [{
      slot: "create:0",
      relative_path: "templates",
      content: "x",
    }],
  },
})
assert.equal(rootOnly.reason, "additive_create_relative_path_restates_root")
assert.equal(rootOnly.repairable, true)

const traversal = materializeAdditiveMutationPlan({
  capability,
  request: {
    replacements: [],
    creations: [{
      slot: "create:0",
      relative_path: "../report.html",
      content: "x",
    }],
  },
})
assert.equal(traversal.reason, "additive_create_relative_path_invalid")
assert.equal(traversal.repairable, true)

const wrongSlot = materializeAdditiveMutationPlan({
  capability,
  request: {
    replacements: [],
    creations: [{
      slot: "create:999",
      relative_path: "report.html",
      content: "x",
    }],
  },
})
assert.equal(wrongSlot.reason, "additive_create_slot_invalid")
assert.equal(wrongSlot.repairable, false)

const hint = buildAdditiveRepairHint({
  failure: absolute,
  capability,
})
assert.equal(hint.protocol, ADDITIVE_REPAIR_HINT_PROTOCOL)
assert.equal(hint.repairable, true)
assert.equal(hint.reason, "additive_create_relative_path_absolute")
assert.equal(hint.operation_index, 0)
assert.equal(hint.field, "relative_path")
assert.equal(hint.capability_sha256, capability.capability_sha256)
assert.equal(hint.authority_sha256, capability.authority_sha256)
assert.equal(hint.mutation_authority, false)
assert.equal(
  JSON.stringify(hint).includes("/tmp/repo"),
  false,
)
assert.equal(
  additiveRepairAuthorityMatches({ hint, capability }),
  true,
)
assert.equal(
  additiveRepairAuthorityMatches({
    hint,
    capability: { ...capability, authority_sha256: "c".repeat(64) },
  }),
  false,
)


const plugin = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)
const toolStart = plugin.indexOf("        name: EXECUTE_ADDITIVE_PLAN_TOOL,")
assert.ok(toolStart >= 0)
const toolEnd = plugin.indexOf("\n        options:", toolStart)
assert.ok(toolEnd > toolStart)
const toolSchema = plugin.slice(toolStart, toolEnd)

assert.match(toolSchema, /replacements:/u)
assert.match(toolSchema, /creations:/u)
assert.match(toolSchema, /relative_path:/u)
assert.match(toolSchema, /required: \["python_imports", "python_declarations", "replacements", "creations"\]/u)
assert.match(toolSchema, /required: \["slot", "before", "replacement"\]/u)
assert.match(toolSchema, /required: \["slot", "relative_path", "content"\]/u)
assert.doesNotMatch(toolSchema, /operations:/u)
assert.doesNotMatch(toolSchema, /\bpath:\s*\{/u)
assert.doesNotMatch(toolSchema, /\bkind:\s*\{/u)
assert.doesNotMatch(toolSchema, /oneOf:/u)
assert.doesNotMatch(toolSchema, /anyOf:/u)

assert.match(plugin, /additiveRepairLock/u)
assert.match(plugin, /additive_repair_authority_drift/u)
assert.match(plugin, /revise_additive_transaction/u)
assert.match(plugin, /ADDITIVE_REPAIR_HINT_PROTOCOL/u)
assert.match(plugin, /additiveRepairAuthorityMatches/u)
assert.match(plugin, /MAX_PATCH_ATTEMPTS_PER_TURN = 2/u)

console.log("PASS v2.28-E2.2 closed additive mutation ABI")
