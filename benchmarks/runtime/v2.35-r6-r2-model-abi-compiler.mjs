import assert from "node:assert/strict"
import path from "node:path"

const root = path.resolve(
  new URL("../../", import.meta.url).pathname,
)

if (
  !process.env
    .OPENCODE_MODEL_ABI_COMPILER
) {
  process.env.OPENCODE_MODEL_ABI_COMPILER =
    path.join(
      root,
      "rust/evidence-distiller/target/release/opencode-model-abi-compiler",
    )
}

const {
  MODEL_ABI_COMPILER_PROTOCOL,
  compileModelFacingSchema,
  compileModelFacingToolSchemas,
  resetModelAbiCompilerCacheForTest,
} = await import(
  "../../opencode/plugins/cpu-search-core/model-abi-compiler-v1.mjs"
)

resetModelAbiCompilerCacheForTest()

const redundant = {
  allOf: [
    {
      type: "object",
      properties: {
        kind: {
          type: "string",
          const: "python_units",
        },
      },
      required: ["kind"],
    },
    {
      type: "object",
      properties: {
        units: {
          type: "array",
          minItems: 1,
          items: {
            type: "string",
          },
        },
      },
      required: ["units"],
    },
  ],
}

const first =
  compileModelFacingSchema({
    schema: redundant,
    minSavingsBytes: 0,
  })

assert.equal(first.ok, true)
assert.equal(
  first.protocol,
  MODEL_ABI_COMPILER_PROTOCOL,
)
assert.equal(
  first.model_authority_expansion,
  false,
)
assert.equal(
  first.mutation_authority,
  false,
)
assert.ok(
  first.selected_bytes <=
    first.base_bytes,
)

if (first.applied) {
  assert.equal(
    first.equivalent_to_base,
    true,
  )
  assert.ok(first.saved_bytes > 0)
}

const second =
  compileModelFacingSchema({
    schema: redundant,
    minSavingsBytes: 0,
  })

assert.equal(
  second.cache_hit,
  true,
)
assert.deepEqual(
  second.schema,
  first.schema,
)

const tools = {
  execute_additive_plan: {
    description:
      "tool description remains outside schema compiler",
    input: redundant,
  },
  execute_replace_node: {
    input: {
      type: "object",
      properties: {
        before: {
          type: "string",
        },
        replacement: {
          type: "string",
        },
      },
      required: [
        "before",
        "replacement",
      ],
      additionalProperties: false,
    },
  },
}

const toolResult =
  compileModelFacingToolSchemas({
    tools,
    frontierToolNames: [
      "execute_additive_plan",
      "execute_replace_node",
    ],
    active: true,
    minSavingsBytes: 0,
  })

assert.equal(toolResult.ok, true)
assert.equal(
  toolResult.model_authority_expansion,
  false,
)
assert.equal(
  toolResult.mutation_authority,
  false,
)
assert.equal(
  toolResult.tools_examined,
  2,
)
assert.ok(
  toolResult.selected_schema_bytes <=
    toolResult.base_schema_bytes,
)

const inactiveTools = {
  x: {
    input: {
      type: "object",
    },
  },
}

const beforeInactive =
  JSON.stringify(inactiveTools)

const inactive =
  compileModelFacingToolSchemas({
    tools: inactiveTools,
    frontierToolNames: ["x"],
    active: false,
  })

assert.equal(
  inactive.applied,
  false,
)
assert.equal(
  JSON.stringify(inactiveTools),
  beforeInactive,
)

const annotated = {
  type: "string",
  description:
    "must be preserved for the model",
}

const annotationResult =
  compileModelFacingSchema({
    schema: annotated,
    minSavingsBytes: 0,
  })

assert.equal(
  annotationResult.applied,
  false,
)
assert.deepEqual(
  annotationResult.schema,
  annotated,
)
assert.equal(
  annotationResult
    .model_authority_expansion,
  false,
)

console.log(
  "PASS R6-R2 generic Model ABI Compiler " +
    `synthetic_applied=${first.applied} ` +
    `synthetic_saved_bytes=${first.saved_bytes} ` +
    `tool_saved_bytes=${toolResult.saved_bytes} ` +
    "cache=true " +
    "annotation_preservation=fail_safe " +
    "full_schema_authority_preserved=true " +
    "model_calls_added=0 " +
    "mutation_authority_expansion=false",
)
