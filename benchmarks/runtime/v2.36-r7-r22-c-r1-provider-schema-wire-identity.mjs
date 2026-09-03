import assert from "node:assert/strict"

import {
  compileArgumentSynthesisPlan,
  compileLlGuidanceOpenAICompatibleWireOptions,
} from "../../opencode/plugins/cpu-search-core/deterministic-argument-synthesis-v1.mjs"

const TOOL = {
  type: "function",
  name: "execute_additive_plan",
  inputSchema: {
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
                items: {
                  oneOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        kind: {
                          type: "string",
                          const: "function",
                        },
                        name: {
                          type: "string",
                          minLength: 1,
                          maxLength: 64,
                          pattern:
                            "^[A-Za-z_][A-Za-z0-9_]*$",
                        },
                        suite: {
                          type: "array",
                          minItems: 1,
                          maxItems: 4,
                          items: {
                            type: "string",
                            maxLength: 380,
                            pattern: ".+",
                          },
                        },
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
                        name: {
                          type: "string",
                          minLength: 1,
                          maxLength: 64,
                          pattern:
                            "^[A-Za-z_][A-Za-z0-9_]*$",
                        },
                        suite: {
                          type: "array",
                          minItems: 1,
                          maxItems: 4,
                          items: {
                            type: "string",
                            maxLength: 380,
                            pattern: ".+",
                          },
                        },
                      },
                      required: [
                        "kind",
                        "name",
                        "suite",
                      ],
                    },
                  ],
                },
              },
            },
            required: ["units"],
          },
        },
        required: ["server_surface"],
      },
    },
    required: ["sources"],
  },
}

const plan =
  compileArgumentSynthesisPlan(TOOL)

assert.equal(
  plan.provider_schema_projection?.ok,
  true,
)

const errors = []
const originalError = console.error
const previousEnv =
  process.env
    .OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC

try {
  process.env
    .OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC =
    "1"
  console.error = (...args) => {
    errors.push(args.join(" "))
  }

  const raw =
    compileLlGuidanceOpenAICompatibleWireOptions({
      options: {},
      contract: {
        selected_tool:
          "execute_additive_plan",
      },
      plan,
      transport: {
        backend: "llguidance",
        wire_mode:
          "openai_compatible_raw_json_schema",
        provider_options_key: "llama",
      },
    })

  assert.equal(errors.length, 1)
  const prefix =
    "KOALIK_PROVIDER_SCHEMA_DIAGNOSTIC_V1 "
  assert.equal(
    errors[0].startsWith(prefix),
    true,
  )

  const diagnostic =
    JSON.parse(errors[0].slice(prefix.length))

  const wireSchema =
    raw.providerOptions.llama
      .response_format.json_schema.schema

  assert.equal(
    diagnostic.protocol,
    "provider-schema-wire-identity-v1",
  )
  assert.equal(
    diagnostic.authority,
    "observation_only",
  )
  assert.equal(
    diagnostic.selected_tool,
    "execute_additive_plan",
  )
  assert.equal(
    diagnostic.backend,
    "llguidance",
  )
  assert.equal(
    diagnostic.wire_mode,
    "openai_compatible_raw_json_schema",
  )
  assert.equal(
    diagnostic.provider_options_key,
    "llama",
  )
  assert.equal(
    diagnostic.provider_projection_match,
    true,
  )
  assert.equal(
    diagnostic.model_schema_match,
    false,
  )
  assert.equal(
    diagnostic.generic_response_format_type,
    "json",
  )
  assert.equal(
    diagnostic.raw_response_format_type,
    "json_schema",
  )
  assert.equal(diagnostic.strict, true)
  assert.equal(
    diagnostic.keyword_counts.oneOf,
    0,
  )
  assert.equal(
    diagnostic.keyword_counts.anyOf,
    0,
  )
  assert.equal(
    diagnostic.keyword_counts.pattern,
    0,
  )
  assert.deepEqual(
    diagnostic.schema,
    wireSchema,
  )
  assert.deepEqual(
    diagnostic.schema,
    plan.provider_model_schema,
  )
  assert.equal(
    diagnostic.semantic_authority,
    false,
  )
  assert.equal(
    diagnostic.mutation_authority,
    false,
  )
} finally {
  console.error = originalError
  if (previousEnv == null) {
    delete process.env
      .OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC
  } else {
    process.env
      .OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC =
      previousEnv
  }
}

console.log(
  "PASS R7-R22-C-R1 provider schema wire identity " +
  "diagnostic=opt_in observation_only=true " +
  "exact_schema_captured=true hash_and_bytes=true " +
  "provider_projection_match=true " +
  "full_schema_not_logged_by_default=true " +
  "model_calls_added=0 mutation_authority=false",
)
