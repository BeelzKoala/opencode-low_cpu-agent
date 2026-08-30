import assert from "node:assert/strict"

import {
  bindAdditiveToolSchemaToCapability,
  renderAdditiveMutationCapability,
  validateAdditiveMutationRequest,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"

const v1Request = {
  replacements: [{
    slot: "existing:0",
    before: "old_value",
    replacement: "new_value",
  }],
  creations: [],
}

const valid = validateAdditiveMutationRequest(v1Request)
assert.equal(valid.ok, true)

const v2ShapeMustRemainForeignToV1 = validateAdditiveMutationRequest({
  insertions: [],
  replacements: [],
  creations: [],
})
assert.equal(v2ShapeMustRemainForeignToV1.ok, false)
assert.equal(
  v2ShapeMustRemainForeignToV1.reason,
  "additive_request_shape_invalid",
)

const v1Tool = {
  description: "legacy-v1-compat",
  input: {
    type: "object",
    properties: {
      replacements: {
        type: "array",
        minItems: 0,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            before: { type: "string" },
            replacement: { type: "string" },
          },
          required: ["slot", "before", "replacement"],
          additionalProperties: false,
        },
      },
      creations: {
        type: "array",
        minItems: 0,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            relative_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["slot", "relative_path", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["replacements", "creations"],
    additionalProperties: false,
  },
}

const capability = {
  protocol: "scout-additive-capability-v1",
  ready: true,
  mutation_authority: true,
  operation: "additive_surface",
  capability_sha256: "a".repeat(64),
  existing_slots: [{
    slot: "existing:0",
    file: "routes/example.py",
    sha256: "b".repeat(64),
    evidence_lines: [10],
    roles: ["task_anchor_owner"],
  }],
  create_slots: [{
    slot: "create:0",
    root: "templates",
    source_file: "templates/example.html",
    source_sha256: "c".repeat(64),
    evidence_lines: [1],
    allowed_extensions: [".html"],
    max_depth: 2,
  }],
}

const bound = bindAdditiveToolSchemaToCapability(v1Tool, capability)
assert.equal(bound.ok, true)
assert.deepEqual(
  bound.tool.input.properties.replacements.items.properties.slot.enum,
  ["existing:0"],
)
assert.deepEqual(
  bound.tool.input.properties.creations.items.properties.slot.enum,
  ["create:0"],
)

const rendered = renderAdditiveMutationCapability(capability)
assert.match(rendered, /closed-additive-mutation-abi-v1/u)
assert.match(rendered, /slot=existing:0 op=replace_exact/u)

console.log(
  "PASS E2.5 additive v1 compatibility layer remains closed and callable",
)
