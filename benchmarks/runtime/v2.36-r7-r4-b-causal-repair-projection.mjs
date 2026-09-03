import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  compactFailureDelta,
  sourceSlotRepairTargets,
} from "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs"

const sha = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex")

const contract = {
  visible: {
    existing_slots: [
      { slot: "existing:0", file: "src/server.py" },
      { slot: "existing:1", file: "templates/menu.html" },
    ],
    create_slots: [
      { slot: "create:0", source_file: "templates/source.html" },
    ],
  },
}

const acceptedText = "HOST_PRESERVED_SOURCE_MUST_NOT_REENTER_MODEL_CONTEXT"
const hint = {
  protocol: "source-slot-repair-cache-v1",
  repairable: true,
  cache_sha256: "a".repeat(64),
  failed_source_keys: ["server_change"],
  failed_slots: ["existing:0"],
  accepted_sources: {
    navigation_change: acceptedText,
  },
  accepted_source_hashes: {
    navigation_change: sha(acceptedText),
  },
  failure_reason: "source_fragment_top_level_kind_forbidden",
}

const targets = sourceSlotRepairTargets(contract, hint)
assert.equal(targets.ok, true, JSON.stringify(targets))
assert.deepEqual(targets.slots, ["existing:0"])
assert.equal(targets.reason, "source_slot_causal_failed_set")
assert.equal(targets.observation_only, false)

const delta = compactFailureDelta(hint, targets)
assert.match(delta, /source_keys=server_change/u)
assert.match(delta, new RegExp(sha(acceptedText), "u"))
assert.equal(delta.includes(acceptedText), false)

const multi = sourceSlotRepairTargets(contract, {
  ...hint,
  failed_source_keys: ["navigation_change", "ui_change"],
  failed_slots: ["create:0", "existing:1"],
})
assert.equal(multi.ok, true, JSON.stringify(multi))
assert.deepEqual(multi.slots, ["create:0", "existing:1"])

const unknown = sourceSlotRepairTargets(contract, {
  ...hint,
  failed_slots: ["existing:999"],
})
assert.equal(unknown.ok, false)
assert.equal(unknown.reason, "source_slot_repair_target_invalid")

const unbound = sourceSlotRepairTargets(contract, {
  ...hint,
  repairable: false,
})
assert.equal(unbound.ok, false)
assert.equal(unbound.reason, "source_slot_repair_authority_shape_invalid")

assert.equal(
  sourceSlotRepairTargets(contract, {
    protocol: "file-family-repair-hint-v1",
  }),
  null,
)

console.log(
  "PASS R7-R4-B causal repair projection " +
  "failed_slots=causal_n_slot " +
  "accepted_source_text=model_context_absent " +
  "accepted_source_hashes=authority_only " +
  "legacy_repair_fallback=preserved " +
  "mutation_authority=false",
)
