import {
  deriveQualifiedComputePlan,
  qualifiedAbortSignal,
} from "./qualified-compute-v1.mjs"

export const BOUNDED_MUTATION_INFERENCE_PROTOCOL =
  "bounded-mutation-inference-v1"

export const BOUNDED_MUTATION_TARGET_TOOL =
  "execute_additive_plan"

const MUTATION_PHASE_MARKER =
  "MUTATION_PHASE protocol=mutation-phase-compiler-v1"

const MUTATION_CALL_POLICY_MARKER =
  `CALL_POLICY tool=${BOUNDED_MUTATION_TARGET_TOOL}`

const WRAPPER_CACHE = new WeakMap()

function finitePositiveInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.max(1, Math.floor(number))
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {}
}

function camelProviderKey(value) {
  if (typeof value !== "string" || !value.trim()) return null
  const raw = value.trim().split(".")[0]
  if (!raw) return null
  return raw.replace(/[-_\s]+(.)?/g, (_, next) =>
    next ? next.toUpperCase() : "",
  )
}

function providerOptionKeys(providerID, languageProvider) {
  const rawLanguageProvider =
    typeof languageProvider === "string"
      ? languageProvider.trim().split(".")[0]
      : null

  return [
    providerID,
    rawLanguageProvider,
    camelProviderKey(providerID),
    camelProviderKey(rawLanguageProvider),
    "openaiCompatible",
  ].filter(
    (value, index, values) =>
      typeof value === "string" &&
      value.length > 0 &&
      values.indexOf(value) === index,
  )
}

function mergeReasoningOffProviderOptions(
  providerOptions,
  providerID,
  languageProvider,
) {
  const result = {
    ...plainObject(providerOptions),
  }

  for (const key of providerOptionKeys(
    providerID,
    languageProvider,
  )) {
    const prior = plainObject(result[key])
    const templateKwargs = plainObject(
      prior.chat_template_kwargs,
    )

    result[key] = {
      ...prior,
      reasoningEffort: "none",
      chat_template_kwargs: {
        ...templateKwargs,
        enable_thinking: false,
      },
      parallel_tool_calls: false,
    }
  }

  return result
}

function promptContainsMutationProtocol(prompt) {
  let serialized
  try {
    serialized = JSON.stringify(prompt)
  } catch {
    return false
  }

  return (
    serialized.includes(MUTATION_PHASE_MARKER) &&
    serialized.includes(MUTATION_CALL_POLICY_MARKER)
  )
}

function functionToolNames(tools) {
  if (!Array.isArray(tools)) return []

  return tools
    .filter(
      (tool) =>
        tool &&
        typeof tool === "object" &&
        tool.type === "function" &&
        typeof tool.name === "string",
    )
    .map((tool) => tool.name)
}

export function isBoundedMutationInferenceRequest(params) {
  if (!params || typeof params !== "object") return false

  const names = functionToolNames(params.tools)
  if (
    names.length !== 1 ||
    names[0] !== BOUNDED_MUTATION_TARGET_TOOL
  ) {
    return false
  }

  return promptContainsMutationProtocol(params.prompt)
}

export function deriveBoundedMutationOutputCap({
  requestMaxOutputTokens,
  modelOutputLimit,
} = {}) {
  const requestCap = finitePositiveInteger(
    requestMaxOutputTokens,
  )
  const modelCap = finitePositiveInteger(modelOutputLimit)

  if (requestCap == null && modelCap == null) {
    const error = new Error(
      "bounded_mutation_output_cap_unavailable",
    )
    error.code = "bounded_mutation_output_cap_unavailable"
    throw error
  }

  if (requestCap != null && modelCap != null) {
    return {
      cap: Math.min(requestCap, modelCap),
      source:
        requestCap <= modelCap
          ? "request_and_model_min_request"
          : "request_and_model_min_model",
      request_cap: requestCap,
      model_cap: modelCap,
    }
  }

  if (requestCap != null) {
    return {
      cap: requestCap,
      source: "existing_request_cap",
      request_cap: requestCap,
      model_cap: null,
    }
  }

  return {
    cap: modelCap,
    source: "model_catalog_output_limit",
    request_cap: null,
    model_cap: modelCap,
  }
}

export function compileBoundedMutationInferenceParams(
  params,
  {
    providerID = null,
    modelID = null,
    modelOutputLimit = null,
    languageProvider = null,
    method = null,
  } = {},
) {
  if (!isBoundedMutationInferenceRequest(params)) {
    return {
      applied: false,
      reason: "not_sealed_additive_mutation",
      params,
      contract: null,
    }
  }

  const baseOutput = deriveBoundedMutationOutputCap({
    requestMaxOutputTokens: params.maxOutputTokens,
    modelOutputLimit,
  })

  const qualifiedCompute = deriveQualifiedComputePlan({
    tools: params.tools,
    selectedTool: BOUNDED_MUTATION_TARGET_TOOL,
    baseOutputCap: baseOutput.cap,
  })

  const output =
    qualifiedCompute.active === true &&
    finitePositiveInteger(qualifiedCompute.output_cap_tokens) != null
      ? {
          ...baseOutput,
          cap: Math.min(baseOutput.cap, qualifiedCompute.output_cap_tokens),
          source: "qualified_frontier_and_" + baseOutput.source,
        }
      : baseOutput

  const qualifiedAbort =
    qualifiedCompute.active === true
      ? qualifiedAbortSignal(params.abortSignal, qualifiedCompute.hard_lease_ms)
      : { signal: params.abortSignal, qualified: false }

  const providerOptions =
    mergeReasoningOffProviderOptions(
      params.providerOptions,
      providerID,
      languageProvider,
    )

  const compiled = {
    ...params,
    // Physical provider bound, never a lease estimate and never wider
    // than an already-present request cap.
    maxOutputTokens: output.cap,
    abortSignal: qualifiedAbort.signal,

    // Caveman lane: topology/tool/scope are already deterministic.
    // This is practical greedy reproducibility, not a bitwise guarantee.
    temperature: 0,
    topP: 1,
    seed: 0,

    // Singleton frontier => "required" is equivalent to naming the tool.
    toolChoice: { type: "required" },

    // AI SDK v4+ standard field. V3 providers ignore unknown call fields;
    // providerOptions below are the compatibility authority today.
    reasoning: "none",

    providerOptions,
  }

  const contract = {
    protocol: BOUNDED_MUTATION_INFERENCE_PROTOCOL,
    kind: "provider_request_transform",
    method,
    provider_id: providerID,
    model_id: modelID,
    language_provider: languageProvider,
    target_tool: BOUNDED_MUTATION_TARGET_TOOL,
    singleton_tool_frontier: true,
    max_output_tokens_before:
      finitePositiveInteger(params.maxOutputTokens),
    max_output_tokens_after: output.cap,
    max_output_tokens_source: output.source,
    model_output_limit: output.model_cap,
    request_output_limit: output.request_cap,
    qualified_compute_protocol: qualifiedCompute.protocol ?? null,
    qualified_compute_active: qualifiedCompute.active === true,
    qualified_compute_reason: qualifiedCompute.reason ?? null,
    qualified_compute_frontier_source_count:
      qualifiedCompute.active_source_count ?? null,
    qualified_compute_frontier_source_keys:
      qualifiedCompute.active_source_keys ?? null,
    qualified_compute_frontier_capacity_bytes:
      qualifiedCompute.active_source_capacity_bytes ?? null,
    qualified_compute_total_capacity_bytes:
      qualifiedCompute.total_source_capacity_bytes ?? null,
    qualified_compute_output_cap_tokens:
      qualifiedCompute.output_cap_tokens ?? null,
    qualified_compute_hard_lease_ms:
      qualifiedCompute.hard_lease_ms ?? null,
    qualified_compute_teardown_reserve_ms:
      qualifiedCompute.teardown_reserve_ms ?? null,
    qualified_compute_deadline_extension_ms:
      qualifiedCompute.deadline_extension_ms ?? 0,
    temperature_before:
      Number.isFinite(Number(params.temperature))
        ? Number(params.temperature)
        : null,
    temperature_after: 0,
    top_p_after: 1,
    seed_after: 0,
    tool_choice_after: "required",
    reasoning_after: "none",
    enable_thinking_after: false,
    parallel_tool_calls_after: false,
    tools_identity_preserved: compiled.tools === params.tools,
    abort_identity_preserved:
      compiled.abortSignal === params.abortSignal,
    mutation_authority: false,
    wire_verified: false,
  }

  return {
    applied: true,
    reason: "sealed_additive_mutation_bounded",
    params: compiled,
    contract,
  }
}

function wrappedMethod(
  language,
  method,
  metadata,
) {
  return async function boundedMutationProviderCall(params) {
    const compiled =
      compileBoundedMutationInferenceParams(
        params,
        {
          ...metadata,
          languageProvider:
            typeof language?.provider === "string"
              ? language.provider
              : metadata.languageProvider ?? null,
          method,
        },
      )

    return language[method].call(
      language,
      compiled.params,
    )
  }
}

export function wrapBoundedMutationLanguage(
  language,
  metadata = {},
) {
  if (
    !language ||
    (typeof language !== "object" &&
      typeof language !== "function")
  ) {
    throw new TypeError(
      "bounded_mutation_language_unavailable",
    )
  }

  if (
    typeof language.doStream !== "function" ||
    typeof language.doGenerate !== "function"
  ) {
    throw new TypeError(
      "bounded_mutation_language_contract_invalid",
    )
  }

  const cached = WRAPPER_CACHE.get(language)
  if (cached) return cached

  const doStream = wrappedMethod(
    language,
    "doStream",
    metadata,
  )
  const doGenerate = wrappedMethod(
    language,
    "doGenerate",
    metadata,
  )

  const proxy = new Proxy(language, {
    get(target, property) {
      if (property === "doStream") return doStream
      if (property === "doGenerate") return doGenerate

      const value = Reflect.get(
        target,
        property,
        target,
      )
      return typeof value === "function"
        ? value.bind(target)
        : value
    },
  })

  WRAPPER_CACHE.set(language, proxy)
  return proxy
}
