export const PHYSICAL_INFERENCE_PROTOCOL =
  "physical-inference-correlation-v3"

export const PHYSICAL_INFERENCE_AUTHORITY =
  "observation_only"

const COUNTER_KEYS = Object.freeze([
  "llamacpp:prompt_tokens_total",
  "llamacpp:prompt_seconds_total",
  "llamacpp:tokens_predicted_total",
  "llamacpp:tokens_predicted_seconds_total",
])

const GAUGE_KEYS = Object.freeze([
  "llamacpp:prompt_tokens_seconds",
  "llamacpp:predicted_tokens_seconds",
  "llamacpp:kv_cache_usage_ratio",
  "llamacpp:kv_cache_tokens",
  "llamacpp:requests_processing",
  "llamacpp:requests_deferred",
  "llamacpp:n_tokens_max",
])

function finite(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  )
    ? value
    : null
}

function integer(value) {
  return Number.isSafeInteger(value)
    ? value
    : null
}

function nonNegativeDelta(current, previous) {
  const now = finite(current)
  const before = finite(previous)

  if (
    now == null ||
    before == null ||
    now < before
  ) {
    return null
  }

  return now - before
}

function metricSubset(metrics) {
  const out = {}

  for (const key of [
    ...COUNTER_KEYS,
    ...GAUGE_KEYS,
  ]) {
    const value = finite(metrics?.[key])
    if (value != null) out[key] = value
  }

  return out
}

function counterDelta(current, baseline) {
  const out = {}

  for (const key of COUNTER_KEYS) {
    out[key] = nonNegativeDelta(
      current?.[key],
      baseline?.[key],
    )
  }

  return out
}

function normalizeNextToken(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return {
      schema: "object",
      ambiguous: false,
      value,
    }
  }

  if (Array.isArray(value)) {
    const objects = value.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item),
    )

    if (objects.length === 1) {
      return {
        schema: "array_singleton",
        ambiguous: false,
        value: objects[0],
      }
    }

    return {
      schema:
        objects.length === 0
          ? "array_empty"
          : "array_ambiguous",
      ambiguous:
        objects.length > 1,
      value: null,
    }
  }

  return {
    schema: "missing",
    ambiguous: false,
    value: null,
  }
}

function normalizedRowNextToken(row) {
  if (
    typeof row?.next_token_schema === "string" ||
    row?.n_decoded != null ||
    row?.n_remain != null
  ) {
    return {
      schema:
        typeof row.next_token_schema === "string"
          ? row.next_token_schema
          : "pre_normalized",
      ambiguous:
        row.next_token_ambiguous === true,
      value: {
        n_decoded:
          row.n_decoded,
        n_remain:
          row.n_remain,
        has_next_token:
          row.has_next_token,
      },
    }
  }

  return normalizeNextToken(
    row?.next_token,
  )
}

export function parseLlamaSlots(value) {
  if (!Array.isArray(value)) {
    return Object.freeze([])
  }

  const out = []

  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row)
    ) {
      continue
    }

    const id = integer(row.id)
    if (id == null) continue

    const next =
      normalizedRowNextToken(row)

    const nextValue =
      next.value

    out.push(
      Object.freeze({
        id,
        id_task:
          integer(row.id_task),
        n_ctx:
          integer(row.n_ctx),
        is_processing:
          row.is_processing === true,

        // llama.cpp exports prompt.tokens.size() here. During generation
        // sampled tokens are appended to prompt.tokens, therefore this is a
        // sequence/context length observation, NOT immutable prompt size.
        n_sequence_tokens:
          integer(
            row.n_sequence_tokens ??
            row.n_prompt_tokens,
          ),

        n_prompt_tokens_processed:
          integer(
            row.n_prompt_tokens_processed,
          ),
        n_prompt_tokens_cache:
          integer(
            row.n_prompt_tokens_cache,
          ),

        next_token_schema:
          next.schema,
        next_token_ambiguous:
          next.ambiguous,
        n_decoded:
          integer(
            nextValue?.n_decoded,
          ),
        n_remain:
          integer(
            nextValue?.n_remain,
          ),
        has_next_token:
          nextValue?.has_next_token === true,

        n_predict:
          integer(
            row.params?.n_predict ??
            row.n_predict,
          ),
      }),
    )
  }

  return Object.freeze(out)
}

function validPhysicalTaskID(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0
  )
    ? value
    : null
}

function samePhysicalTask(left, right) {
  return Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.id_task != null &&
    left.id_task === right.id_task
  )
}

function singletonProcessingSlot(slots) {
  const processing = slots.filter(
    (slot) =>
      slot.is_processing === true,
  )

  return {
    processing,
    singleton:
      processing.length === 1
        ? processing[0]
        : null,
  }
}

function phaseOf({
  slot,
  sameTask,
  promptProcessedInterval,
  promptCacheInterval,
  decodedInterval,
}) {
  if (!slot) return "idle"

  if (
    sameTask &&
    decodedInterval != null &&
    decodedInterval > 0
  ) {
    return "decode"
  }

  if (
    sameTask &&
    (
      (
        promptProcessedInterval != null &&
        promptProcessedInterval > 0
      ) ||
      (
        promptCacheInterval != null &&
        promptCacheInterval > 0
      )
    )
  ) {
    return "prompt"
  }

  if (
    integer(slot.n_decoded) != null &&
    slot.n_decoded > 0
  ) {
    return "decode"
  }

  if (
    integer(
      slot.n_prompt_tokens_processed,
    ) != null &&
    slot.n_prompt_tokens_processed > 0
  ) {
    return "prompt_or_transition"
  }

  if (slot.is_processing === true) {
    return "processing_unknown"
  }

  return "idle"
}

export function createPhysicalInferenceCorrelationState(
  {
    dispatched_mono_ms = null,
  } = {},
) {
  return {
    protocol:
      PHYSICAL_INFERENCE_PROTOCOL,
    authority:
      PHYSICAL_INFERENCE_AUTHORITY,

    dispatchedMonoMs:
      finite(dispatched_mono_ms),

    firstMetrics: null,
    firstMetricsMonoMs: null,
    lastMetrics: null,

    lastSingletonSlot: null,
    firstCorrelatedMonoMs: null,
    hadSlotsVisibilityGap: false,
    hadMetricsVisibilityGap: false,

    physicalTaskIDs:
      new Set(),
    taskTransitions: 0,

    firstServerProgressMonoMs: null,
    lastServerProgressMonoMs: null,
    serverProgressEvents: 0,

    firstExactProgressMonoMs: null,
    lastExactProgressMonoMs: null,
    exactProgressEvents: 0,
  }
}

function markProgress(
  state,
  monoMs,
  exact,
) {
  const mono = finite(monoMs)
  if (mono == null) return

  if (
    state.firstServerProgressMonoMs == null
  ) {
    state.firstServerProgressMonoMs =
      mono
  }

  state.lastServerProgressMonoMs =
    mono
  state.serverProgressEvents += 1

  if (exact) {
    if (
      state.firstExactProgressMonoMs == null
    ) {
      state.firstExactProgressMonoMs =
        mono
    }

    state.lastExactProgressMonoMs =
      mono
    state.exactProgressEvents += 1
  }
}

export function observePhysicalInferenceSnapshot(
  state,
  {
    metrics = {},
    slots = [],
    metrics_available = true,
    slots_available = true,
    mono_ms = null,
  } = {},
) {
  if (
    !state ||
    state.protocol !==
      PHYSICAL_INFERENCE_PROTOCOL
  ) {
    throw new TypeError(
      "physical inference v3 state required",
    )
  }

  const mono = finite(mono_ms)
  const safeMetrics =
    metricSubset(metrics)

  // Intentionally idempotent: callers may pass raw /slots rows or the
  // already-normalized result returned by llamaSlots().
  const safeSlots =
    parseLlamaSlots(slots)

  if (slots_available !== true) {
    state.hadSlotsVisibilityGap = true
  }

  if (metrics_available !== true) {
    state.hadMetricsVisibilityGap = true
  }

  const hasCounterMetrics =
    metrics_available === true &&
    COUNTER_KEYS.some(
      (key) =>
        finite(safeMetrics[key]) != null,
    )

  if (
    !state.firstMetrics &&
    hasCounterMetrics
  ) {
    state.firstMetrics = {
      ...safeMetrics,
    }
    state.firstMetricsMonoMs =
      mono
  }

  const cumulative =
    state.firstMetrics &&
    hasCounterMetrics
      ? counterDelta(
          safeMetrics,
          state.firstMetrics,
        )
      : Object.fromEntries(
          COUNTER_KEYS.map(
            (key) => [key, null],
          ),
        )

  const interval =
    state.lastMetrics &&
    hasCounterMetrics
      ? counterDelta(
          safeMetrics,
          state.lastMetrics,
        )
      : Object.fromEntries(
          COUNTER_KEYS.map(
            (key) => [key, null],
          ),
        )

  const {
    processing,
    singleton,
  } =
    slots_available === true
      ? singletonProcessingSlot(
          safeSlots,
        )
      : {
          processing: [],
          singleton: null,
        }

  const previous =
    state.lastSingletonSlot

  const sameTask =
    samePhysicalTask(
      singleton,
      previous,
    )

  const currentTaskID =
    validPhysicalTaskID(
      singleton?.id_task,
    )

  const previousTaskID =
    validPhysicalTaskID(
      previous?.id_task,
    )

  let taskTransition = false

  if (currentTaskID != null) {
    state.physicalTaskIDs.add(
      currentTaskID,
    )

    if (
      state.firstCorrelatedMonoMs == null &&
      mono != null
    ) {
      state.firstCorrelatedMonoMs =
        mono
    }
  }

  if (
    singleton &&
    previous &&
    (
      singleton.id !== previous.id ||
      currentTaskID !== previousTaskID
    )
  ) {
    taskTransition = true
    state.taskTransitions += 1
  }

  const contextSequenceInterval =
    sameTask
      ? nonNegativeDelta(
          singleton?.n_sequence_tokens,
          previous?.n_sequence_tokens,
        )
      : null

  const promptProcessedInterval =
    sameTask
      ? nonNegativeDelta(
          singleton
            ?.n_prompt_tokens_processed,
          previous
            ?.n_prompt_tokens_processed,
        )
      : null

  const promptCacheInterval =
    sameTask
      ? nonNegativeDelta(
          singleton
            ?.n_prompt_tokens_cache,
          previous
            ?.n_prompt_tokens_cache,
        )
      : null

  const decodedInterval =
    sameTask &&
    singleton?.next_token_ambiguous !== true &&
    previous?.next_token_ambiguous !== true
      ? nonNegativeDelta(
          singleton?.n_decoded,
          previous?.n_decoded,
        )
      : null

  const exactPromptProgress =
    Boolean(
      (
        promptProcessedInterval != null &&
        promptProcessedInterval > 0
      ) ||
      (
        promptCacheInterval != null &&
        promptCacheInterval > 0
      )
    )

  const exactDecodeProgress =
    decodedInterval != null &&
    decodedInterval > 0

  const slotLifecycleProgress =
    slots_available === true &&
    Boolean(
      taskTransition ||
      (
        singleton &&
        !previous
      ) ||
      (
        !singleton &&
        previous
      )
    )

  const requestScopedCounters =
    Boolean(
      metrics_available === true &&
      slots_available === true &&
      sameTask &&
      processing.length === 1 &&
      finite(
        safeMetrics[
          "llamacpp:requests_processing"
        ],
      ) === 1
    )

  const promptCounterInterval =
    interval[
      "llamacpp:prompt_tokens_total"
    ]
  const predictedCounterInterval =
    interval[
      "llamacpp:tokens_predicted_total"
    ]

  const attributedGlobalProgress =
    requestScopedCounters &&
    Boolean(
      (
        promptCounterInterval != null &&
        promptCounterInterval > 0
      ) ||
      (
        predictedCounterInterval != null &&
        predictedCounterInterval > 0
      )
    )

  const unattributedGlobalProgress =
    !requestScopedCounters &&
    Boolean(
      (
        promptCounterInterval != null &&
        promptCounterInterval > 0
      ) ||
      (
        predictedCounterInterval != null &&
        predictedCounterInterval > 0
      )
    )

  const exactProgress =
    Boolean(
      exactPromptProgress ||
      exactDecodeProgress ||
      slotLifecycleProgress
    )

  const serverProgressObserved =
    Boolean(
      exactProgress ||
      attributedGlobalProgress
    )

  if (serverProgressObserved) {
    markProgress(
      state,
      mono,
      exactProgress,
    )
  }

  const correlationStrategy =
    slots_available !== true
      ? "slots_unavailable"
      : (
          processing.length === 1
            ? "singleton_processing_slot"
            : (
                processing.length === 0
                  ? "no_processing_slot"
                  : "ambiguous_multiple_processing_slots"
              )
        )

  const physicalTaskIDs =
    [...state.physicalTaskIDs]
      .sort(
        (a, b) => a - b,
      )

  const firstCorrelationGap =
    state.dispatchedMonoMs != null &&
    state.firstCorrelatedMonoMs != null
      ? Math.max(
          0,
          state.firstCorrelatedMonoMs -
          state.dispatchedMonoMs,
        )
      : null

  const firstMetricsGap =
    state.dispatchedMonoMs != null &&
    state.firstMetricsMonoMs != null
      ? Math.max(
          0,
          state.firstMetricsMonoMs -
          state.dispatchedMonoMs,
        )
      : null

  const phase =
    phaseOf({
      slot: singleton,
      sameTask,
      promptProcessedInterval,
      promptCacheInterval,
      decodedInterval,
    })

  const result = Object.freeze({
    protocol:
      PHYSICAL_INFERENCE_PROTOCOL,
    authority:
      PHYSICAL_INFERENCE_AUTHORITY,

    correlation_strategy:
      correlationStrategy,
    processing_slots:
      processing.length,
    correlated_slot_id:
      singleton?.id ?? null,
    correlated_task_id:
      currentTaskID,

    initial_slot_visibility_gap_ms:
      firstCorrelationGap,
    initial_metrics_visibility_gap_ms:
      firstMetricsGap,
    had_slots_visibility_gap:
      state.hadSlotsVisibilityGap,
    had_metrics_visibility_gap:
      state.hadMetricsVisibilityGap,

    task_transition:
      taskTransition,
    task_transitions_total:
      state.taskTransitions,

    physical_task_ids_seen:
      Object.freeze(
        physicalTaskIDs,
      ),
    physical_task_cardinality_lower_bound:
      physicalTaskIDs.length,
    multiple_physical_tasks_observed:
      physicalTaskIDs.length > 1,
    cardinality_claim:
      "observed_window_lower_bound",

    request_scoped_counter_progress:
      requestScopedCounters,

    // Correct semantics: sequence length, not prompt total.
    slot_context_sequence_tokens:
      singleton
        ?.n_sequence_tokens ?? null,
    slot_context_sequence_interval:
      contextSequenceInterval,

    slot_prompt_tokens_processed:
      singleton
        ?.n_prompt_tokens_processed ?? null,
    slot_prompt_tokens_cache:
      singleton
        ?.n_prompt_tokens_cache ?? null,

    slot_prompt_processed_interval:
      promptProcessedInterval,
    slot_prompt_cache_interval:
      promptCacheInterval,

    // Legacy compatibility fields intentionally no longer claim prompt-total
    // semantics.
    slot_prompt_tokens: null,
    slot_prompt_remaining: null,
    slot_prompt_tokens_interval: null,
    slot_prompt_semantics:
      "unsupported_sequence_length_is_not_prompt_total",

    slot_decoded:
      singleton?.n_decoded ?? null,
    slot_decoded_interval:
      decodedInterval,
    slot_remaining:
      singleton?.n_remain ?? null,
    slot_has_next_token:
      singleton?.has_next_token === true,
    slot_next_token_schema:
      singleton
        ?.next_token_schema ?? null,
    slot_next_token_ambiguous:
      singleton
        ?.next_token_ambiguous ?? null,

    slot_context_capacity:
      singleton?.n_ctx ?? null,
    slot_n_predict:
      singleton?.n_predict ?? null,
    phase,

    global_prompt_tokens_delta:
      cumulative[
        "llamacpp:prompt_tokens_total"
      ],
    global_predicted_tokens_delta:
      cumulative[
        "llamacpp:tokens_predicted_total"
      ],
    global_prompt_seconds_delta:
      cumulative[
        "llamacpp:prompt_seconds_total"
      ],
    global_predicted_seconds_delta:
      cumulative[
        "llamacpp:tokens_predicted_seconds_total"
      ],

    interval_prompt_tokens_delta:
      promptCounterInterval,
    interval_predicted_tokens_delta:
      predictedCounterInterval,
    interval_prompt_seconds_delta:
      interval[
        "llamacpp:prompt_seconds_total"
      ],
    interval_predicted_seconds_delta:
      interval[
        "llamacpp:tokens_predicted_seconds_total"
      ],

    attributed_global_progress:
      attributedGlobalProgress,
    unattributed_global_progress:
      unattributedGlobalProgress,

    server_context_high_water_tokens:
      finite(
        safeMetrics[
          "llamacpp:n_tokens_max"
        ],
      ),
    server_requests_processing:
      finite(
        safeMetrics[
          "llamacpp:requests_processing"
        ],
      ),
    server_requests_deferred:
      finite(
        safeMetrics[
          "llamacpp:requests_deferred"
        ],
      ),

    exact_server_progress_observed:
      exactProgress,
    server_progress_observed:
      serverProgressObserved,
    server_progress_kind:
      Object.freeze([
        exactPromptProgress
          ? "slot_prompt_processed"
          : null,
        exactDecodeProgress
          ? "slot_decode"
          : null,
        slotLifecycleProgress
          ? "slot_lifecycle"
          : null,
        attributedGlobalProgress
          ? "attributed_global_counter"
          : null,
      ].filter(Boolean)),

    server_progress_events:
      state.serverProgressEvents,
    exact_progress_events:
      state.exactProgressEvents,
    first_server_progress_mono_ms:
      state.firstServerProgressMonoMs,
    last_server_progress_mono_ms:
      state.lastServerProgressMonoMs,
    first_exact_progress_mono_ms:
      state.firstExactProgressMonoMs,
    last_exact_progress_mono_ms:
      state.lastExactProgressMonoMs,

    client_progress_authority:
      "separate_signal",
    stall_authority: false,
    mutation_authority: false,
  })

  if (hasCounterMetrics) {
    state.lastMetrics = {
      ...safeMetrics,
    }
  }

  if (slots_available === true) {
    state.lastSingletonSlot =
      singleton
        ? {
            ...singleton,
          }
        : null
  }

  return result
}
