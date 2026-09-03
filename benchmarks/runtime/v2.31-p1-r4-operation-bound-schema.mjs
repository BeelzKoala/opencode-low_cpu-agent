import assert from "node:assert/strict"

import {
  bindSemanticContentToolSchemaToCapability,
  deriveSemanticContentSpec,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"

import {
  bindSemanticObligationContract,
  validateSemanticObligationRequest,
} from "../../opencode/plugins/cpu-search-core/semantic-obligation-bridge-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),

  existing_slots: [
    {
      slot: "existing:0",
      file: "src/server.py",
      allowed_operations: [
        "add_module_declaration",
      ],
      roles: ["task_anchor_owner"],
    },
    {
      slot: "existing:1",
      file: "templates/menu.html",
      allowed_operations: [
        "replace_exact",
      ],
      roles: ["navigation_host"],
    },
  ],

  create_slots: [
    {
      slot: "create:0",
      root: "templates",
      allowed_extensions: [
        ".html",
      ],
      max_depth: 2,
      allowed_operations: [
        "create_file",
      ],
      roles: ["ui_host"],
    },
  ],
}

const spec = deriveSemanticContentSpec({
  capability,
})

assert.equal(
  spec.ok,
  true,
  JSON.stringify(spec),
)

assert.deepEqual(
  spec.operations.map(
    ({ id, kind }) => ({ id, kind }),
  ),
  [
    {
      id: "op_0",
      kind: "python_declaration",
    },
    {
      id: "op_1",
      kind: "replacement",
    },
    {
      id: "op_2",
      kind: "creation",
    },
  ],
)

const baseTool = {
  name: "execute_additive_plan",
  input: {
    type: "object",
    properties: {
      contents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              pattern: "^op_[0-9]+$",
            },
            content: {
              type: "object",
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
}

const semanticBinding =
  bindSemanticContentToolSchemaToCapability(
    baseTool,
    capability,
  )

assert.equal(
  semanticBinding.ok,
  true,
  JSON.stringify(semanticBinding),
)

const contract = {
  ok: true,
  contract_sha256: "c".repeat(64),

  operations: spec.operations.map(
    ({ id, obligation, kind }) => ({
      id,
      obligation,
      kind,
    }),
  ),
}

const bound = bindSemanticObligationContract({
  semanticBinding,
  capability,
  contract,
})

assert.equal(
  bound.ok,
  true,
  JSON.stringify(bound),
)

const contents =
  bound.tool.input.properties.contents

const items = contents.items

assert.equal(contents.minItems, 3)
assert.equal(contents.maxItems, 3)
assert.ok(Array.isArray(items.oneOf))
assert.equal(items.oneOf.length, 3)

const branch = (id) =>
  items.oneOf.find(
    (candidate) =>
      candidate?.properties?.id?.enum?.length === 1 &&
      candidate.properties.id.enum[0] === id,
  )

const op0 = branch("op_0")
const op1 = branch("op_1")
const op2 = branch("op_2")

assert.ok(op0)
assert.ok(op1)
assert.ok(op2)

/*
 * Python declaration:
 * only kind + units.
 */
assert.equal(
  op0.properties.content.additionalProperties,
  false,
)

assert.deepEqual(
  Object.keys(
    op0.properties.content.properties,
  ).sort(),
  ["kind", "units"],
)

assert.deepEqual(
  op0.properties.content.required,
  ["kind", "units"],
)

assert.deepEqual(
  op0.properties.content.properties.kind.enum,
  ["python_units"],
)

/*
 * Replacement:
 * exact regression for real E2E failure.
 *
 * The model previously emitted:
 *
 *   kind=text
 *   mode=replace
 *   units=[...]
 *
 * units must now be impossible in this schema branch.
 */
assert.equal(
  op1.properties.content.additionalProperties,
  false,
)

assert.deepEqual(
  Object.keys(
    op1.properties.content.properties,
  ).sort(),
  ["kind", "mode", "text"],
)

assert.deepEqual(
  op1.properties.content.required,
  ["kind", "mode", "text"],
)

assert.deepEqual(
  op1.properties.content.properties.kind.enum,
  ["text"],
)

assert.deepEqual(
  op1.properties.content.properties.mode.enum,
  ["before", "after", "replace"],
)

assert.equal(
  Object.prototype.hasOwnProperty.call(
    op1.properties.content.properties,
    "units",
  ),
  false,
)

/*
 * Creation:
 * exact text payload and create mode.
 */
assert.equal(
  op2.properties.content.additionalProperties,
  false,
)

assert.deepEqual(
  Object.keys(
    op2.properties.content.properties,
  ).sort(),
  ["kind", "mode", "text"],
)

assert.deepEqual(
  op2.properties.content.required,
  ["kind", "mode", "text"],
)

assert.deepEqual(
  op2.properties.content.properties.kind.enum,
  ["text"],
)

assert.deepEqual(
  op2.properties.content.properties.mode.enum,
  ["create"],
)

assert.equal(
  Object.prototype.hasOwnProperty.call(
    op2.properties.content.properties,
    "units",
  ),
  false,
)

/*
 * Defense in depth:
 * even if structured generation were bypassed,
 * the validator must still reject the exact E2E hybrid.
 */
const hybrid = validateSemanticObligationRequest({
  request: {
    contents: [
      {
        id: "op_0",
        content: {
          kind: "python_units",
          units: [
            {
              kind: "function",
              name: "server_surface",
            },
          ],
        },
      },
      {
        id: "op_1",
        content: {
          kind: "text",
          mode: "replace",
          units: [
            {
              kind: "function",
              name: "wrong_payload",
            },
          ],
        },
      },
      {
        id: "op_2",
        content: {
          kind: "text",
          mode: "create",
          text: "<html></html>",
        },
      },
    ],
  },

  capability,
  contract,
  attestation: bound.attestation,
})

assert.equal(hybrid.ok, false)

assert.equal(
  hybrid.reason,
  "semantic_obligation_text_content_invalid",
)

/*
 * Attestation itself must refuse weakening of the
 * model-facing per-operation schema.
 */
const weakenedBinding = {
  ...semanticBinding,

  tool: {
    ...semanticBinding.tool,

    input: {
      ...semanticBinding.tool.input,

      properties: {
        ...semanticBinding.tool.input.properties,

        contents: {
          ...semanticBinding.tool.input.properties.contents,

          items: {
            ...semanticBinding.tool.input
              .properties
              .contents
              .items,

            oneOf: undefined,
          },
        },
      },
    },
  },
}

const weakened =
  bindSemanticObligationContract({
    semanticBinding: weakenedBinding,
    capability,
    contract,
  })

assert.equal(weakened.ok, false)

assert.equal(
  weakened.reason,
  "semantic_obligation_operation_schema_unbound",
)

console.log(
  "PASS P1-R4 operation-bound schema " +
    "id_payload_bound=true " +
    "text_units_hybrid_impossible=true " +
    "bridge_attests_exact_schema=true " +
    "validator_defense_in_depth=true",
)
