import assert from "node:assert/strict"

import {
  BOUNDED_MUTATION_INFERENCE_PROTOCOL,
  compileBoundedMutationInferenceParams,
  deriveBoundedMutationOutputCap,
  isBoundedMutationInferenceRequest,
  wrapBoundedMutationLanguage,
} from "../../opencode/plugins/cpu-search-core/bounded-mutation-inference-v1.mjs"

const TARGET = "execute_additive_plan"

const mutationPrompt = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "MUTATION_PHASE protocol=mutation-phase-compiler-v1 state=mutate",
          "TASK",
          "bounded task",
          "CALL_POLICY tool=execute_additive_plan exactly_once=true prose=false",
        ].join("\n"),
      },
    ],
  },
]

const tool = {
  type: "function",
  name: TARGET,
  description: "bounded",
  inputSchema: {
    type: "object",
    properties: {},
  },
}

const abort = new AbortController().signal

assert.equal(
  isBoundedMutationInferenceRequest({
    prompt: mutationPrompt,
    tools: [tool],
  }),
  true,
)

assert.equal(
  isBoundedMutationInferenceRequest({
    prompt: [{ role: "user", content: [{ type: "text", text: "normal" }] }],
    tools: [tool],
  }),
  false,
)

assert.equal(
  isBoundedMutationInferenceRequest({
    prompt: mutationPrompt,
    tools: [tool, { ...tool, name: "other" }],
  }),
  false,
)

assert.deepEqual(
  deriveBoundedMutationOutputCap({
    requestMaxOutputTokens: 1024,
    modelOutputLimit: 4096,
  }),
  {
    cap: 1024,
    source: "request_and_model_min_request",
    request_cap: 1024,
    model_cap: 4096,
  },
)

assert.deepEqual(
  deriveBoundedMutationOutputCap({
    requestMaxOutputTokens: 8192,
    modelOutputLimit: 4096,
  }),
  {
    cap: 4096,
    source: "request_and_model_min_model",
    request_cap: 8192,
    model_cap: 4096,
  },
)

assert.throws(
  () =>
    deriveBoundedMutationOutputCap({
      requestMaxOutputTokens: null,
      modelOutputLimit: null,
    }),
  /bounded_mutation_output_cap_unavailable/,
)

const originalProviderOptions = {
  local: {
    preserved: "yes",
    chat_template_kwargs: {
      preserve_thinking: true,
    },
  },
}

const params = {
  prompt: mutationPrompt,
  tools: [tool],
  maxOutputTokens: undefined,
  temperature: 0.8,
  topP: 0.95,
  seed: undefined,
  toolChoice: { type: "auto" },
  abortSignal: abort,
  providerOptions: originalProviderOptions,
}

const compiled =
  compileBoundedMutationInferenceParams(
    params,
    {
      providerID: "local",
      modelID: "north-mini-code-local",
      modelOutputLimit: 4096,
      languageProvider: "local.chat",
      method: "doStream",
    },
  )

assert.equal(compiled.applied, true)
assert.equal(
  compiled.contract.protocol,
  BOUNDED_MUTATION_INFERENCE_PROTOCOL,
)
assert.equal(compiled.params.maxOutputTokens, 4096)
assert.equal(compiled.params.temperature, 0)
assert.equal(compiled.params.topP, 1)
assert.equal(compiled.params.seed, 0)
assert.deepEqual(
  compiled.params.toolChoice,
  { type: "required" },
)
assert.equal(compiled.params.reasoning, "none")
assert.equal(
  compiled.params.providerOptions.local.preserved,
  "yes",
)
assert.equal(
  compiled.params.providerOptions.local.reasoningEffort,
  "none",
)
assert.equal(
  compiled.params.providerOptions.local
    .chat_template_kwargs.preserve_thinking,
  true,
)
assert.equal(
  compiled.params.providerOptions.local
    .chat_template_kwargs.enable_thinking,
  false,
)
assert.equal(
  compiled.params.providerOptions.local.parallel_tool_calls,
  false,
)
assert.equal(
  compiled.params.providerOptions.openaiCompatible
    .reasoningEffort,
  "none",
)
assert.equal(compiled.params.tools, params.tools)
assert.equal(
  compiled.params.abortSignal,
  params.abortSignal,
)
assert.equal(
  compiled.contract.mutation_authority,
  false,
)
assert.equal(
  compiled.contract.wire_verified,
  false,
)

const stricter =
  compileBoundedMutationInferenceParams(
    {
      ...params,
      maxOutputTokens: 768,
    },
    {
      providerID: "local",
      modelOutputLimit: 4096,
    },
  )
assert.equal(stricter.params.maxOutputTokens, 768)

const locateParams = {
  prompt: [
    {
      role: "user",
      content: [{ type: "text", text: "locate" }],
    },
  ],
  tools: [
    {
      ...tool,
      name: "search",
    },
  ],
  temperature: 0.8,
}
const locate =
  compileBoundedMutationInferenceParams(
    locateParams,
    {
      providerID: "local",
      modelOutputLimit: 4096,
    },
  )
assert.equal(locate.applied, false)
assert.equal(locate.params, locateParams)

const calls = []
const language = {
  specificationVersion: "v3",
  provider: "local.chat",
  modelId: "north-mini-code-local",
  supportedUrls: {},
  async doStream(observed) {
    calls.push(["stream", observed])
    return { stream: new ReadableStream() }
  },
  async doGenerate(observed) {
    calls.push(["generate", observed])
    return {
      content: [],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {},
      warnings: [],
    }
  },
}

const wrapped =
  wrapBoundedMutationLanguage(
    language,
    {
      providerID: "local",
      modelID: "north-mini-code-local",
      modelOutputLimit: 4096,
    },
  )

assert.equal(
  wrapBoundedMutationLanguage(
    language,
    {
      providerID: "local",
      modelOutputLimit: 4096,
    },
  ),
  wrapped,
)

await wrapped.doStream(params)
await wrapped.doGenerate({
  ...params,
  maxOutputTokens: 2048,
})

assert.equal(calls.length, 2)
assert.equal(calls[0][0], "stream")
assert.equal(calls[0][1].maxOutputTokens, 4096)
assert.equal(calls[0][1].temperature, 0)
assert.deepEqual(
  calls[0][1].toolChoice,
  { type: "required" },
)
assert.equal(calls[1][0], "generate")
assert.equal(calls[1][1].maxOutputTokens, 2048)

console.log(
  "PASS E3.5-R2 provider bounded mutation inference " +
  "nonmutation_unchanged=true " +
  "existing_cap_conserved=true " +
  "model_cap_enforced=true " +
  "reasoning_off=true " +
  "singleton_tool_required=true " +
  "abort_preserved=true",
)
