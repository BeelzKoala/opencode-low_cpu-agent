import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  OBLIGATION_BOUND_SYNTHESIS_PROTOCOL,
  bindObligationBoundToolSchema,
  deriveObligationBoundSynthesisContract,
  materializeObligationBoundAdditiveRequest,
  renderObligationBoundSynthesisContract,
} from "../../opencode/plugins/cpu-search-core/obligation-bound-synthesis-v1.mjs"

function capability() {
  return {
    ready: true,
    mutation_authority: true,
    operation: "additive_surface",
    capability_sha256: "a".repeat(64),
    budgets: { max_operations: 8 },
    existing_slots: [
      {
        slot: "existing:0",
        file: "server/feature.py",
        roles: ["data_access_capability", "task_anchor_owner", "ui_host"],
      },
      {
        slot: "existing:1",
        file: "views/navigation.html",
        roles: ["navigation_host"],
      },
    ],
    create_slots: [
      {
        slot: "create:0",
        root: "views",
        allowed_extensions: [".html"],
      },
    ],
  }
}

const taskRequirements = {
  constraints: [
    { kind: "no_new_dependencies", required: true },
    { kind: "preserve_existing_behavior", required: true },
    { kind: "diagnostic_only", required: false },
  ],
}

const contract = deriveObligationBoundSynthesisContract({
  capability: capability(),
  taskRequirements,
})
assert.equal(contract.ok, true)
assert.equal(contract.protocol, OBLIGATION_BOUND_SYNTHESIS_PROTOCOL)
assert.deepEqual(
  contract.operations.map(({ id, obligation, slot, kind }) => ({
    id,
    obligation,
    slot,
    kind,
  })),
  [
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
  ],
)
assert.deepEqual(contract.constraints, [
  "no_new_dependencies",
  "preserve_existing_behavior",
])
assert.equal(contract.mutation_authority, false)
assert.match(contract.contract_sha256, /^[0-9a-f]{64}$/u)

const baseTool = {
  name: "execute_additive_plan",
  description: "base additive tool",
  input: {
    type: "object",
    properties: {
      python_imports: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            modules: { type: "array", items: { type: "string" } },
            from_imports: { type: "array", items: { type: "object" } },
          },
          required: ["slot", "modules", "from_imports"],
          additionalProperties: false,
        },
      },
      python_declarations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            content: { type: "string", minLength: 1 },
          },
          required: ["slot", "content"],
        },
      },
      replacements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            before: { type: "string", minLength: 1 },
            replacement: { type: "string" },
          },
        },
      },
      creations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            relative_path: { type: "string", minLength: 1 },
            content: { type: "string" },
          },
        },
      },
    },
  },
}

const bound = bindObligationBoundToolSchema(
  baseTool,
  capability(),
  taskRequirements,
)
assert.equal(bound.ok, true)
assert.deepEqual(bound.tool.input.required, [
  "support_imports",
  "required_operations",
])
assert.deepEqual(bound.tool.input.properties.required_operations.required, [
  "op_0",
  "op_1",
  "op_2",
])
const boundSchema = JSON.stringify(bound.tool.input)
for (const forbidden of ['"slot"', '"file"', '"kind"', '"scope"']) {
  assert.equal(boundSchema.includes(forbidden), false, forbidden)
}

const materialized = materializeObligationBoundAdditiveRequest({
  capability: capability(),
  taskRequirements,
  request: {
    support_imports: [
      {
        modules: ["io"],
        from_imports: [],
      },
    ],
    required_operations: {
      op_0: { content: "def feature():\n    return None" },
      op_1: { before: "old", replacement: "new" },
      op_2: { relative_path: "feature.html", content: "<main></main>" },
    },
  },
})
assert.equal(materialized.ok, true)
assert.deepEqual(materialized.request, {
  python_imports: [
    { slot: "existing:0", modules: ["io"], from_imports: [] },
  ],
  python_declarations: [
    { slot: "existing:0", content: "def feature():\n    return None" },
  ],
  replacements: [
    { slot: "existing:1", before: "old", replacement: "new" },
  ],
  creations: [
    { slot: "create:0", relative_path: "feature.html", content: "<main></main>" },
  ],
})
assert.equal(materialized.mutation_authority, false)

const omitted = materializeObligationBoundAdditiveRequest({
  capability: capability(),
  taskRequirements,
  request: {
    support_imports: [],
    required_operations: {
      op_0: { content: "def feature():\n    return None" },
      op_1: { before: "old", replacement: "new" },
    },
  },
})
assert.equal(omitted.ok, false)
assert.equal(omitted.detail, "required_operation_set_mismatch")

const authorityInjection = materializeObligationBoundAdditiveRequest({
  capability: capability(),
  taskRequirements,
  request: {
    support_imports: [],
    required_operations: {
      op_0: { content: "def feature():\n    return None", slot: "existing:9" },
      op_1: { before: "old", replacement: "new" },
      op_2: { relative_path: "feature.html", content: "<main></main>" },
    },
  },
})
assert.equal(authorityInjection.ok, false)
assert.match(authorityInjection.detail, /fields_invalid/u)

const ambiguous = capability()
ambiguous.existing_slots.push({
  slot: "existing:2",
  file: "server/other.py",
  roles: ["task_anchor_owner"],
})
assert.equal(
  deriveObligationBoundSynthesisContract({ capability: ambiguous }).ok,
  false,
)

const rendered = renderObligationBoundSynthesisContract(
  capability(),
  taskRequirements,
)
assert.match(rendered, /REQUIRED_OPERATION id=op_0/u)
assert.match(rendered, /no_new_dependencies=true/u)
assert.match(rendered, /preserve_existing_behavior=true/u)
assert.doesNotMatch(rendered, /diagnostic_only=true/u)
assert.match(rendered, /MODEL_AUTHORITY content_only=true/u)

const fragment06 = await readFile(
  "opencode/plugins/cpu-search.fragments/06.part.ts",
  "utf8",
)
const fragment08 = await readFile(
  "opencode/plugins/cpu-search.fragments/08.part.ts",
  "utf8",
)
const fragment09 = await readFile(
  "opencode/plugins/cpu-search.fragments/09.part.ts",
  "utf8",
)
// The obligation-bound helper remains directly unit-tested above. Runtime
// integration has since moved to the canonical semantic-obligation bridge,
// source-slot frontend, and deterministic semantic materializer.
assert.match(fragment08, /renderObligationBoundSynthesisContract/u)
assert.match(fragment09, /deriveObligationBoundSynthesisContract/u)
assert.match(fragment09, /bindSemanticContentToolSchemaToCapability/u)
assert.match(fragment09, /bindSemanticObligationContract/u)
assert.match(fragment09, /bindSourceSlotToolSchema/u)
assert.match(fragment09, /validateSemanticObligationRequest/u)
assert.match(fragment09, /sourceSlotRehydration\.request/u)
assert.match(fragment09, /materializeSemanticAdditiveRequest/u)
assert.match(fragment09, /repair_context_projection_status/u)
assert.match(fragment09, /repair_context_projection_reason/u)
assert.doesNotMatch(fragment09, /bindObligationBoundToolSchema/u)

console.log(
  "PASS E2.8 obligation-bound synthesis: immutable required operations + content-only authority + compact constraints + causal repair telemetry",
)
