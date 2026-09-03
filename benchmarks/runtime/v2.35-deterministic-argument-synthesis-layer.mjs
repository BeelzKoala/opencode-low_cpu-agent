import assert from "node:assert/strict"

import {
  DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
  compileArgumentSynthesisPlan,
} from "../../opencode/plugins/cpu-search-core/deterministic-argument-synthesis-v1.mjs"

import {
  wrapExecutionControlledLanguage,
} from "../../opencode/plugins/cpu-search-core/execution-control-kernel-v1.mjs"

import {
  PHYSICAL_INFERENCE_PROTOCOL,
  createPhysicalInferenceCorrelationState,
  observePhysicalInferenceSnapshot,
  parseLlamaSlots,
} from "../../opencode/plugins/cpu-search-core/physical-inference-correlation-v1.mjs"

import {
  INFERENCE_LIFECYCLE_PROTOCOL,
  createInferenceLifecycleState,
  markInferenceLogicalComplete,
  observeInferenceLifecycle,
} from "../../opencode/plugins/cpu-search-core/inference-lifecycle-v1.mjs"

assert.equal(
  DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
  "deterministic-argument-synthesis-v1",
)
assert.equal(
  PHYSICAL_INFERENCE_PROTOCOL,
  "physical-inference-correlation-v3",
)
assert.equal(
  INFERENCE_LIFECYCLE_PROTOCOL,
  "inference-lifecycle-v2",
)

const tool = {
  type: "function",
  name: "execute_additive_plan",
  description: "bounded",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sealed_mode: {
        type: "string",
        const: "additive",
      },
      content: {
        type: "string",
      },
    },
    required: [
      "sealed_mode",
      "content",
    ],
  },
}

const plan = compileArgumentSynthesisPlan(tool)
assert.equal(plan.active, true)
assert.equal(plan.fixed_fields, 1)
assert.equal(plan.model_action_authority, false)
assert.equal(plan.model_argument_authority, "semantic_holes_only")
assert.equal(plan.generated_tool_name_bytes, 0)
assert.equal(plan.model_schema.properties.sealed_mode, undefined)
assert.ok(plan.model_schema.properties.content)
assert.equal(plan.model_tool.inputSchema.properties.sealed_mode, undefined)

// Preferred transport: structured semantic arguments only.
let structuredOptions = null
const structuredLanguage = {
  supportsStructuredOutputs: true,
  async doGenerate(options) {
    structuredOptions = options
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ content: "hello" }),
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { outputTokens: { total: 7 } },
    }
  },
}

const structured = wrapExecutionControlledLanguage(structuredLanguage)
const structuredResult = await structured.doGenerate({ tools: [tool] })
assert.deepEqual(structuredOptions.tools, [])
assert.equal(structuredOptions.toolChoice, undefined)
assert.equal(structuredOptions.responseFormat.type, "json")
assert.equal(structuredOptions.responseFormat.schema.properties.sealed_mode, undefined)
assert.equal(structuredResult.content.length, 1)
assert.equal(structuredResult.content[0].type, "tool-call")
assert.equal(structuredResult.content[0].toolName, "execute_additive_plan")
assert.deepEqual(JSON.parse(structuredResult.content[0].input), {
  sealed_mode: "additive",
  content: "hello",
})
assert.equal(structuredResult.finishReason.unified, "tool-calls")

// Fallback transport: singleton REQUIRED tool, still only semantic holes.
let requiredOptions = null
const requiredLanguage = {
  supportsStructuredOutputs: false,
  async doGenerate(options) {
    requiredOptions = options
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "execute_additive_plan",
          input: JSON.stringify({ content: "fallback" }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    }
  },
}

const required = wrapExecutionControlledLanguage(requiredLanguage)
const requiredResult = await required.doGenerate({ tools: [tool] })
assert.deepEqual(requiredOptions.toolChoice, { type: "required" })
assert.equal(requiredOptions.tools.length, 1)
assert.equal(requiredOptions.tools[0].inputSchema.properties.sealed_mode, undefined)
assert.deepEqual(JSON.parse(requiredResult.content[0].input), {
  sealed_mode: "additive",
  content: "fallback",
})

// Structured streaming is buffered, materialized and only then exposed as tool call.
let streamOptions = null
const streamingLanguage = {
  supportsStructuredOutputs: true,
  async doStream(options) {
    streamOptions = options
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "txt" })
          controller.enqueue({
            type: "text-delta",
            id: "txt",
            delta: '{"content":"stream"}',
          })
          controller.enqueue({ type: "text-end", id: "txt" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
          })
          controller.close()
        },
      }),
    }
  },
}

const streaming = wrapExecutionControlledLanguage(streamingLanguage)
const streamResult = await streaming.doStream({ tools: [tool] })
const streamParts = []
for await (const part of streamResult.stream) streamParts.push(part)
const streamCall = streamParts.find((part) => part.type === "tool-call")
assert.ok(streamCall)
assert.equal(streamCall.toolName, "execute_additive_plan")
assert.deepEqual(JSON.parse(streamCall.input), {
  sealed_mode: "additive",
  content: "stream",
})
assert.equal(streamOptions.responseFormat.type, "json")

// Zero inference when the schema already seals the entire argument object.
const fixedTool = {
  type: "function",
  name: "fixed_action",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      value: { type: "string", const: "ok" },
    },
    required: ["value"],
  },
}
let zeroCalls = 0
const zeroLanguage = {
  supportsStructuredOutputs: true,
  async doGenerate() {
    zeroCalls += 1
    throw new Error("must not execute")
  },
}
const zero = wrapExecutionControlledLanguage(zeroLanguage)
const zeroResult = await zero.doGenerate({ tools: [fixedTool] })
assert.equal(zeroCalls, 0)
assert.deepEqual(JSON.parse(zeroResult.content[0].input), { value: "ok" })

// C11-R3: /slots parsing is idempotent; decode semantics survive normalization.
const rawSlots = [
  {
    id: 0,
    id_task: 8,
    n_ctx: 32768,
    is_processing: true,
    n_prompt_tokens: 5119,
    n_prompt_tokens_processed: 4280,
    n_prompt_tokens_cache: 0,
    params: { n_predict: 4096 },
    next_token: [
      {
        has_next_token: true,
        n_remain: 3257,
        n_decoded: 839,
      },
    ],
  },
]
const normalizedOnce = parseLlamaSlots(rawSlots)
const normalizedTwice = parseLlamaSlots(normalizedOnce)
assert.deepEqual(normalizedTwice, normalizedOnce)

const physical = createPhysicalInferenceCorrelationState({ dispatched_mono_ms: 0 })
const p1 = observePhysicalInferenceSnapshot(physical, {
  mono_ms: 1000,
  metrics: { "llamacpp:requests_processing": 1 },
  slots: normalizedOnce,
})
assert.equal(p1.phase, "decode")
assert.equal(p1.slot_decoded, 839)
assert.equal(p1.slot_prompt_remaining, null)

const p2 = observePhysicalInferenceSnapshot(physical, {
  mono_ms: 2000,
  metrics: { "llamacpp:requests_processing": 1 },
  slots: [
    {
      ...normalizedOnce[0],
      n_prompt_tokens: 5200,
      n_decoded: 920,
      n_remain: 3176,
    },
  ],
})
assert.equal(p2.slot_decoded_interval, 81)
assert.ok(p2.server_progress_kind.includes("slot_decode"))

// C12-R1: task 4 -> task 8 is a sequential owned segment, not conflict.
const lifecycle = createInferenceLifecycleState({
  logical_model_call: 1,
  dispatched_mono_ms: 0,
})
const s1 = observeInferenceLifecycle(lifecycle, {
  correlation_strategy: "singleton_processing_slot",
  processing_slots: 1,
  correlated_slot_id: 0,
  correlated_task_id: 4,
}, 100)
assert.equal(s1.snapshot.state, "active")
assert.equal(s1.snapshot.physical_segment_count, 1)

const s2 = observeInferenceLifecycle(lifecycle, {
  correlation_strategy: "singleton_processing_slot",
  processing_slots: 1,
  correlated_slot_id: 0,
  correlated_task_id: 8,
}, 200)
assert.equal(s2.sequential_transition, true)
assert.equal(s2.snapshot.ownership_conflict, false)
assert.equal(s2.snapshot.physical_segment_count, 2)

markInferenceLogicalComplete(lifecycle, 300)
const s3 = observeInferenceLifecycle(lifecycle, {
  correlation_strategy: "no_processing_slot",
  processing_slots: 0,
  correlated_slot_id: null,
  correlated_task_id: null,
}, 400)
assert.equal(s3.snapshot.state, "quiescent")

console.log(
  "PASS v2.35 deterministic argument synthesis " +
  "model_action_authority=false " +
  "model_argument_authority=semantic_holes_only " +
  "generated_tool_name_bytes=0 " +
  "structured_json_preferred=true " +
  "required_singleton_fallback=true " +
  "zero_inference_supported=true " +
  "slot_projection_idempotent=true " +
  "decode_phase_exact=true " +
  "sequential_physical_ownership=true " +
  "false_verified_authority_unchanged=true",
)
