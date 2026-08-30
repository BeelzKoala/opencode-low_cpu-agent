import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
  additiveRepairAuthorityMatches,
  buildAdditiveRepairHint,
  materializeAdditiveMutationPlan,
  validateAdditiveMutationRequest,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"

const empty = {
  replacements: [],
  creations: [],
}

const shape = validateAdditiveMutationRequest(empty)
assert.equal(shape.ok, true)
assert.equal(shape.operation_count, 0)

const capability = {
  ready: true,
  mutation_authority: true,
  authority_protocol: ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [],
  create_slots: [],
}

const failure = materializeAdditiveMutationPlan({
  capability,
  request: empty,
})
assert.equal(failure.ok, false)
assert.equal(failure.reason, "additive_empty_transaction")
assert.equal(failure.repairable, true)
assert.equal(failure.mutation_authority, false)

const hint = buildAdditiveRepairHint({
  failure,
  capability,
})
assert.equal(hint.repairable, true)
assert.equal(hint.reason, "additive_empty_transaction")
assert.equal(hint.operation_index, null)
assert.equal(hint.field, null)
assert.equal(
  additiveRepairAuthorityMatches({
    hint,
    capability,
  }),
  true,
)

const malformed = validateAdditiveMutationRequest({
  replacements: [],
})
assert.equal(malformed.ok, false)
assert.equal(malformed.reason, "additive_request_shape_invalid")
assert.equal(malformed.repairable, false)

const overBudget = validateAdditiveMutationRequest({
  replacements: Array.from({ length: 9 }, (_, index) => ({
    slot: `existing:${index}`,
    before: `before-${index}`,
    replacement: `after-${index}`,
  })),
  creations: [],
})
assert.equal(overBudget.ok, false)
assert.equal(overBudget.reason, "additive_operation_count_invalid")

const plugin = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)
for (const marker of [
  'forcedKind === "additive_surface"',
  "validateAdditiveMutationRequest(obligationBoundRequest.request)",
  "materializeAdditiveMutationPlan({",
  "buildAdditiveRepairHint({",
  "authorization.repairable === true",
]) {
  assert.equal(plugin.includes(marker), true, marker)
}

console.log(
  "PASS E2.2 empty transaction crosses ABI validation and becomes one-repair semantic failure",
)
