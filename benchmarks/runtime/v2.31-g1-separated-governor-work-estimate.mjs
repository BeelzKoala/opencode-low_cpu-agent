import assert from "node:assert/strict"

import {
  GOVERNOR_WORK_PROTOCOL,
  estimateGovernorDispatchWork,
} from "../../opencode/plugins/cpu-search-core/governor-work-v2.mjs"

const mutationText = [
  "MUTATION_CONTENT_ENVELOPE protocol=mutation-context-projection-v1",
  "REQUIRED_OPERATION id=op_0 obligation=server_surface operation=python_declaration payload=content",
  "REQUIRED_OPERATION id=op_1 obligation=navigation_integration operation=replacement payload=content",
  "REQUIRED_OPERATION id=op_2 obligation=ui_surface operation=creation payload=content",
  "SEALED_CONTEXT file=routes/example.py",
  "  1 | from flask import Blueprint",
  "  2 | bp = Blueprint('x', __name__)",
  "CONTENT_POLICY smallest_complete_implementation=true",
].join("\n")

const tools = {
  execute_additive_plan: {
    input: {
      type: "object",
      properties: {
        contents: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["op_0", "op_1", "op_2"],
              },
              content: {
                type: "string",
                minLength: 1,
                maxLength: 32768,
              },
            },
            required: ["id", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["contents"],
      additionalProperties: false,
    },
  },
}

const capability = {
  budgets: {
    max_plan_bytes: 32768,
  },
}

const work = estimateGovernorDispatchWork({
  system: [{ type: "text", text: "bounded mutation" }],
  messages: [{
    role: "user",
    content: [{ type: "text", text: mutationText }],
  }],
  tools,
  selectedTool: "execute_additive_plan",
  additiveCapability: capability,
})

assert.equal(work.protocol, GOVERNOR_WORK_PROTOCOL)
assert.equal(work.required_operations, 3)
assert.equal(work.output_bound_bytes, work.expected_output_bytes)
assert.equal(work.output_bound_source, work.expected_output_source)
assert.notEqual(
  work.expected_output_source,
  "sealed_capability_max_plan_bytes",
)
assert.match(
  work.expected_output_source,
  /^semantic_model_facing_surface_proxy/u,
)
assert.equal(work.output_ceiling_bytes, 32768)
assert.match(
  work.output_ceiling_source,
  /sealed_capability_max_plan_bytes/u,
)
assert.ok(work.expected_output_bytes > 0)
assert.ok(work.expected_output_bytes < work.output_ceiling_bytes)
assert.equal(work.prefill_bytes, work.input_bytes)
assert.equal(work.decode_expected_bytes, work.expected_output_bytes)
assert.equal(work.decode_ceiling_bytes, work.output_ceiling_bytes)
assert.equal(
  work.work_bytes,
  work.prefill_bytes + work.decode_expected_bytes,
)

const noCapability = estimateGovernorDispatchWork({
  system: "x",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: {},
  selectedTool: null,
})
assert.equal(noCapability.output_ceiling_bytes, null)
assert.equal(
  noCapability.expected_output_source,
  "model_facing_surface_proxy",
)
assert.ok(noCapability.expected_output_bytes > 0)

console.log(
  "PASS G1 separated Governor work estimate " +
  "safety_ceiling_not_expected_generation=true " +
  "prefill_decode_dimensions_exposed=true " +
  "semantic_expected_output_proxy=true " +
  "compat_output_bound_alias=true",
)
