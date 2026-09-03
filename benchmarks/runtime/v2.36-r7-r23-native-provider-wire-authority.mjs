import assert from "node:assert/strict"

import {
  NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
  rewriteNativeOpenAICompatibleMutationRequest,
} from "../../opencode/plugins/cpu-search-core/native-openai-compatible-mutation-wire-v1.mjs"

const MUTATION_TOOLS = Object.freeze([
  "execute_replace_node",
  "execute_rename_symbol",
  "execute_additive_plan",
])

function eventFor(body) {
  return {
    request: new Request(
      "http://127.0.0.1:8080/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999",
        },
        body: JSON.stringify(body),
      },
    ),
  }
}

async function bodyOf(event) {
  return event.request.clone().json()
}

function walk(value, visit) {
  if (
    value == null ||
    typeof value !== "object"
  ) {
    return
  }

  visit(value)

  if (Array.isArray(value)) {
    for (const child of value) {
      walk(child, visit)
    }
    return
  }

  for (const child of Object.values(value)) {
    walk(child, visit)
  }
}

function keywordValues(value, keyword) {
  const out = []

  walk(value, (node) => {
    if (
      !Array.isArray(node) &&
      Object.prototype.hasOwnProperty.call(
        node,
        keyword,
      )
    ) {
      out.push(node[keyword])
    }
  })

  return out
}

const canonicalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    contents: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^op_[0-9]+$",
          },
          content: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: {
                type: "string",
                enum: [
                  "text",
                ],
              },
              text: {
                type: "string",
                minLength: 1,
                maxLength: 8192,
              },
            },
            required: [
              "kind",
              "text",
            ],
          },
        },
        required: [
          "id",
          "content",
        ],
      },
    },
  },
  required: [
    "contents",
  ],
}

const canonicalBefore =
  JSON.stringify(canonicalSchema)

const mutationBody = {
  model: "north-mini-code-local",
  messages: [
    {
      role: "user",
      content: "fixture",
    },
  ],
  stream: true,
  temperature: 0,
  tools: [
    {
      type: "function",
      function: {
        name: "execute_additive_plan",
        description:
          "bounded semantic payload",
        parameters:
          canonicalSchema,
      },
    },
  ],
  tool_choice: "auto",
}

const mutationEvent =
  eventFor(mutationBody)

const first =
  await rewriteNativeOpenAICompatibleMutationRequest(
    mutationEvent,
    {
      mutationToolNames:
        MUTATION_TOOLS,
    },
  )

assert.equal(
  first.protocol,
  NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
)
assert.equal(first.applied, true)
assert.equal(
  first.selected_tool,
  "execute_additive_plan",
)
assert.equal(
  first.mutation_authority,
  false,
)
assert.equal(
  first.canonical_validation_required,
  true,
)
assert.ok(
  first
    .dropped_oversized_repetition_bounds >=
    1,
)

const firstBody =
  await bodyOf(mutationEvent)

assert.deepEqual(
  firstBody.messages,
  mutationBody.messages,
)
assert.equal(
  firstBody.model,
  mutationBody.model,
)
assert.equal(
  firstBody.stream,
  mutationBody.stream,
)
assert.equal(
  firstBody.temperature,
  mutationBody.temperature,
)
assert.equal(
  firstBody.tools.length,
  1,
)
assert.deepEqual(
  firstBody.tool_choice,
  {
    type: "function",
    function: {
      name: "execute_additive_plan",
    },
  },
)

const projected =
  firstBody.tools[0]
    .function.parameters

assert.equal(
  JSON.stringify(canonicalSchema),
  canonicalBefore,
  "canonical tool schema mutated",
)

assert.deepEqual(
  keywordValues(projected, "pattern"),
  [],
)

assert.ok(
  keywordValues(
    projected,
    "maxLength",
  ).includes(64),
)

assert.ok(
  !keywordValues(
    projected,
    "maxLength",
  ).includes(8192),
)

assert.ok(
  keywordValues(
    projected,
    "maxLength",
  ).every(
    (value) => value < 2000,
  ),
)

assert.equal(
  mutationEvent.request.headers.has(
    "content-length",
  ),
  false,
)

const bodyAfterFirst =
  await bodyOf(mutationEvent)

const second =
  await rewriteNativeOpenAICompatibleMutationRequest(
    mutationEvent,
    {
      mutationToolNames:
        MUTATION_TOOLS,
    },
  )

assert.equal(second.applied, true)

const bodyAfterSecond =
  await bodyOf(mutationEvent)

assert.deepEqual(
  bodyAfterSecond,
  bodyAfterFirst,
)

const searchEvent =
  eventFor({
    model: "north-mini-code-local",
    messages: [],
    tools: [
      {
        type: "function",
        function: {
          name: "search",
          parameters: {
            type: "object",
          },
        },
      },
    ],
    tool_choice: "auto",
  })

const originalSearchRequest =
  searchEvent.request

const searchResult =
  await rewriteNativeOpenAICompatibleMutationRequest(
    searchEvent,
    {
      mutationToolNames:
        MUTATION_TOOLS,
    },
  )

assert.equal(
  searchResult.applied,
  false,
)
assert.equal(
  searchResult.reason,
  "no_mutation_tool",
)
assert.equal(
  searchEvent.request,
  originalSearchRequest,
)

const widenedEvent =
  eventFor({
    model: "north-mini-code-local",
    messages: [],
    tools: [
      mutationBody.tools[0],
      {
        type: "function",
        function: {
          name: "search",
          parameters: {
            type: "object",
          },
        },
      },
    ],
  })

await assert.rejects(
  () =>
    rewriteNativeOpenAICompatibleMutationRequest(
      widenedEvent,
      {
        mutationToolNames:
          MUTATION_TOOLS,
      },
    ),
  (error) =>
    error?.code ===
    "mutation_frontier_not_singleton",
)

const unsupportedEvent =
  eventFor({
    model: "north-mini-code-local",
    messages: [],
    tools: [
      {
        type: "function",
        function: {
          name:
            "execute_additive_plan",
          parameters: {
            $ref: "#/$defs/payload",
            $defs: {
              payload: {
                type: "object",
              },
            },
          },
        },
      },
    ],
  })

await assert.rejects(
  () =>
    rewriteNativeOpenAICompatibleMutationRequest(
      unsupportedEvent,
      {
        mutationToolNames:
          MUTATION_TOOLS,
      },
    ),
  (error) =>
    error?.code ===
    "provider_schema_projection_failed",
)

console.log(
  "PASS R7-R23 native provider wire authority " +
  "native_http_request=true " +
  "mutation_frontier_singleton=true " +
  "tool_choice_named=true " +
  "provider_projection=true " +
  "oversized_repetition_relaxed=true " +
  "canonical_validation_retained=true " +
  "nonmutation_unchanged=true " +
  "fail_closed=true " +
  "model_calls_added=0 mutation_authority=false",
)
