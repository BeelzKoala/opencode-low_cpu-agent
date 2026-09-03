import assert from "node:assert/strict"

import {
  compileArgumentSynthesisPlan,
  compileLlGuidanceOpenAICompatibleWireOptions,
} from "../../opencode/plugins/cpu-search-core/deterministic-argument-synthesis-v1.mjs"

function walk(value, visit, path = []) {
  if (!value || typeof value !== "object") return
  visit(value, path)
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      walk(child, visit, [...path, index]),
    )
    return
  }
  for (const [key, child] of Object.entries(value)) {
    walk(child, visit, [...path, key])
  }
}

function containsKeyword(value, keyword) {
  let found = false
  walk(value, (node) => {
    if (
      !Array.isArray(node) &&
      Object.prototype.hasOwnProperty.call(
        node,
        keyword,
      )
    ) {
      found = true
    }
  })
  return found
}

const FUNCTION_COMMON = {
  name: {
    type: "string",
    minLength: 1,
    maxLength: 256,
    pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
  },
  parameters: {
    type: "string",
    maxLength: 512,
    pattern: "^[^:=\\n]*(?:,[^:=\\n]*)*$",
  },
  suite: {
    type: "array",
    minItems: 1,
    maxItems: 4,
    items: {
      type: "string",
      minLength: 1,
      maxLength: 380,
      pattern: "^(?!\\s*$).+",
    },
  },
}

const TYPED_UNIT = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          const: "function",
        },
        ...FUNCTION_COMMON,
      },
      required: [
        "kind",
        "name",
        "suite",
      ],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          const: "async_function",
        },
        ...FUNCTION_COMMON,
      },
      required: [
        "kind",
        "name",
        "suite",
      ],
    },
  ],
}

const CANONICAL = {
  type: "object",
  additionalProperties: false,
  properties: {
    sources: {
      type: "object",
      additionalProperties: false,
      properties: {
        server_surface: {
          type: "object",
          additionalProperties: false,
          properties: {
            units: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: TYPED_UNIT,
            },
          },
          required: ["units"],
        },
        navigation_integration: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
        },
        ui_surface: {
          type: "string",
          minLength: 1,
          maxLength: 8192,
        },
      },
      required: [
        "server_surface",
        "navigation_integration",
        "ui_surface",
      ],
    },
  },
  required: ["sources"],
}

const TOOL = {
  type: "function",
  name: "execute_additive_plan",
  description: "bounded semantic payload",
  inputSchema: CANONICAL,
}

const plan = compileArgumentSynthesisPlan(TOOL)

assert.equal(plan.active, true)
assert.equal(plan.zero_inference, false)
assert.equal(
  plan.provider_schema_projection?.ok,
  true,
  JSON.stringify(plan.provider_schema_projection),
)
assert.equal(
  plan.provider_schema_projection.protocol,
  "provider-safe-model-schema-v1",
)
assert.equal(
  plan.provider_schema_projection.semantic_authority,
  false,
)
assert.equal(
  plan.provider_schema_projection.mutation_authority,
  false,
)
assert.equal(
  plan.provider_schema_projection
    .canonical_validation_required,
  true,
)
assert.equal(
  plan.provider_schema_projection
    .generation_constraints_relaxed,
  true,
)
assert.equal(
  plan.provider_schema_projection.flattened_unions,
  1,
)
assert.ok(
  plan.provider_schema_projection.dropped_patterns >= 3,
)

assert.equal(
  containsKeyword(plan.model_schema, "oneOf"),
  true,
)
assert.equal(
  containsKeyword(plan.model_schema, "pattern"),
  true,
)
assert.equal(
  containsKeyword(
    plan.provider_model_schema,
    "oneOf",
  ),
  false,
)
assert.equal(
  containsKeyword(
    plan.provider_model_schema,
    "anyOf",
  ),
  false,
)
assert.equal(
  containsKeyword(
    plan.provider_model_schema,
    "pattern",
  ),
  false,
)

const providerUnit =
  plan.provider_model_schema
    .properties.sources
    .properties.server_surface
    .properties.units.items

assert.equal(providerUnit.type, "object")
assert.equal(
  providerUnit.additionalProperties,
  false,
)
assert.deepEqual(
  providerUnit.properties.kind,
  {
    type: "string",
    enum: [
      "async_function",
      "function",
    ],
  },
)
assert.deepEqual(
  providerUnit.required,
  [
    "kind",
    "name",
    "suite",
  ],
)
assert.equal(
  providerUnit.properties.name.maxLength,
  256,
)
assert.equal(
  providerUnit.properties.parameters.maxLength,
  512,
)
assert.equal(
  providerUnit.properties.suite.maxItems,
  4,
)
assert.equal(
  providerUnit.properties.suite.items.maxLength,
  380,
)

const legacyPlan = {
  active: true,
  zero_inference: false,
  model_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      contents: {
        type: "string",
        minLength: 1,
        maxLength: 32,
      },
    },
    required: ["contents"],
  },
  model_tool: null,
}

const legacyRaw =
  compileLlGuidanceOpenAICompatibleWireOptions({
    options: {},
    contract: {
      selected_tool: "legacy_fixture",
    },
    plan: legacyPlan,
    transport: {
      backend: "llguidance",
      wire_mode:
        "openai_compatible_raw_json_schema",
      provider_options_key: "llama",
    },
  })

assert.deepEqual(
  legacyRaw.providerOptions.llama
    .response_format.json_schema.schema,
  legacyPlan.model_schema,
)

const explicitFailedPlan = {
  ...legacyPlan,
  provider_model_schema: null,
  provider_schema_projection: {
    ok: false,
    reason: "fixture_explicit_failure",
  },
}

assert.throws(
  () =>
    compileLlGuidanceOpenAICompatibleWireOptions({
      options: {},
      contract: {
        selected_tool: "legacy_fixture",
      },
      plan: explicitFailedPlan,
      transport: {
        backend: "llguidance",
        wire_mode:
          "openai_compatible_raw_json_schema",
        provider_options_key: "llama",
      },
    }),
  /llguidance_provider_schema_projection_unavailable/u,
)

const raw = compileLlGuidanceOpenAICompatibleWireOptions({
  options: {
    providerOptions: {
      llama: {
        keep: "yes",
      },
    },
  },
  contract: {
    selected_tool: "execute_additive_plan",
  },
  plan,
  transport: {
    backend: "llguidance",
    wire_mode:
      "openai_compatible_raw_json_schema",
    provider_options_key: "llama",
  },
})

const wireSchema =
  raw.providerOptions.llama
    .response_format.json_schema.schema

assert.deepEqual(
  wireSchema,
  plan.provider_model_schema,
)
assert.notDeepEqual(
  wireSchema,
  plan.model_schema,
)
assert.equal(
  raw.providerOptions.llama.keep,
  "yes",
)
assert.equal(raw.responseFormat.type, "json")

const unsupportedTool = {
  type: "function",
  name: "unsupported_union",
  inputSchema: {
    oneOf: [
      { type: "string" },
      { type: "integer" },
    ],
  },
}

const unsupported =
  compileArgumentSynthesisPlan(
    unsupportedTool,
  )

assert.equal(unsupported.active, true)
assert.equal(
  unsupported.provider_schema_projection.ok,
  false,
)
assert.equal(
  unsupported.provider_model_schema,
  null,
)

assert.throws(
  () =>
    compileLlGuidanceOpenAICompatibleWireOptions({
      options: {},
      contract: {
        selected_tool: "unsupported_union",
      },
      plan: unsupported,
      transport: {
        backend: "llguidance",
        wire_mode:
          "openai_compatible_raw_json_schema",
        provider_options_key: "llama",
      },
    }),
  /llguidance_provider_schema_projection_unavailable/u,
)

console.log(
  "PASS R7-R22-A-R4 provider-safe model ABI " +
  "canonical_schema=unchanged " +
  "provider_wire=bounded_subset " +
  "equivalent_union=flattened " +
  "pattern=post_generation_validator_only " +
  "unsupported_union=fail_closed " +
  "legacy_plan=inline_projected " +
  "explicit_failed_projection=no_fallback " +
  "canonical_validation_required=true " +
  "model_calls_added=0 mutation_authority=false",
)
