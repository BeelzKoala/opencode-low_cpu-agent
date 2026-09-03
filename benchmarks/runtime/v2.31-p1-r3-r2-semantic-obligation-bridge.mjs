import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  bindSemanticObligationContract,
  validateSemanticObligationRequest,
} from "../../opencode/plugins/cpu-search-core/semantic-obligation-bridge-v1.mjs"
import {
  bindSemanticContentToolSchemaToCapability,
  deriveSemanticContentSpec,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"

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
  description: "semantic additive plan",
  input: {
    type: "object",
    properties: {
      contents: {
        type: "array",
        minItems: 1,
        maxItems: 8,
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
assert.equal(bound.ok, true)
assert.equal(bound.reason, "semantic_obligation_schema_bound")
assert.equal(bound.tool.input.properties.contents.minItems, 3)
assert.equal(bound.tool.input.properties.contents.maxItems, 3)
assert.deepEqual(
  bound.tool.input.properties.contents.items.properties.id.enum,
  ["op_0", "op_1", "op_2"],
)
assert.equal(
  Object.prototype.hasOwnProperty.call(
    bound.tool.input.properties,
    "support_imports",
  ),
  false,
)

const request = {
  contents: [
    {
      id: "op_0",
      content: {
        kind: "python_units",
        units: [
          {
            kind: "function",
            name: "server_surface",
            parameters: "",
            suite: ["return None"],
          },
        ],
      },
    },
    {
      id: "op_1",
      content: {
        kind: "text",
        mode: "replace",
        text: "<li>navigation</li>",
      },
    },
    {
      id: "op_2",
      content: {
        kind: "text",
        mode: "create",
        text: "<html><body>ui</body></html>",
      },
    },
  ],
}

const valid = validateSemanticObligationRequest({
  request,
  capability,
  contract,
  attestation: bound.attestation,
})
assert.equal(valid.ok, true, JSON.stringify(valid, null, 2))
assert.equal(valid.coverage_complete, true)

const duplicate = validateSemanticObligationRequest({
  request: {
    contents: [
      request.contents[0],
      request.contents[0],
      request.contents[2],
    ],
  },
  capability,
  contract,
  attestation: bound.attestation,
})
assert.equal(duplicate.ok, false)
assert.equal(
  duplicate.reason,
  "semantic_obligation_duplicate_operation_id",
)

const driftedCapability = {
  ...capability,
  authority_sha256: "c".repeat(64),
}
const drift = validateSemanticObligationRequest({
  request,
  capability: driftedCapability,
  contract,
  attestation: bound.attestation,
})
assert.equal(drift.ok, false)
assert.equal(drift.reason, "semantic_obligation_attestation_mismatch")

const here = path.dirname(fileURLToPath(import.meta.url))
const fragment = fs.readFileSync(
  path.resolve(
    here,
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
  ),
  "utf8",
)

const modelStart = fragment.indexOf(
  "        const canonicalObligationContract =",
)
const modelEnd = fragment.indexOf(
  "      const frontierToolNames =",
  modelStart,
)
assert.ok(modelStart >= 0)
assert.ok(modelEnd > modelStart)

const modelBlock = fragment.slice(modelStart, modelEnd)
assert.match(
  modelBlock,
  /bindSemanticContentToolSchemaToCapability/u,
)
assert.match(
  modelBlock,
  /bindSemanticObligationContract/u,
)
assert.doesNotMatch(
  modelBlock,
  /bindObligationBoundToolSchema/u,
)
assert.doesNotMatch(
  modelBlock,
  /bindAdditiveToolSchemaToCapability/u,
)

const toolNameAt = fragment.indexOf(
  "        name: EXECUTE_ADDITIVE_PLAN_TOOL,",
)
const nextTransformAt = fragment.indexOf(
  "\n    await track(ctx.tool.transform((tools) => {",
  toolNameAt + 1,
)
assert.ok(toolNameAt >= 0)
assert.ok(nextTransformAt > toolNameAt)

const executeBlock = fragment.slice(
  toolNameAt,
  nextTransformAt,
)
const validationAt = executeBlock.indexOf(
  "validateSemanticObligationRequest",
)
const materializerAt = executeBlock.indexOf(
  "materializeSemanticAdditiveRequest",
)
assert.ok(validationAt >= 0)
assert.ok(materializerAt > validationAt)

console.log(
  "PASS P1-R3-R2 semantic obligation bridge " +
  "canonical_contract_once=true " +
  "semantic_schema_contract_checked=true " +
  "schema_executor_abi_aligned=true " +
  "attestation_checked_before_materializer=true " +
  "physical_binder_not_model_facing=true",
)
