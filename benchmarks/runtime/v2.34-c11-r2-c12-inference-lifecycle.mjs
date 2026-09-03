import assert from "node:assert/strict"

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
  snapshotInferenceLifecycle,
} from "../../opencode/plugins/cpu-search-core/inference-lifecycle-v1.mjs"

assert.equal(
  PHYSICAL_INFERENCE_PROTOCOL,
  "physical-inference-correlation-v3",
)
assert.equal(
  INFERENCE_LIFECYCLE_PROTOCOL,
  "inference-lifecycle-v2",
)

const parsed = parseLlamaSlots([
  {
    id: 0,
    id_task: 5257,
    n_ctx: 32768,
    is_processing: true,
    n_prompt_tokens: 2752,
    n_prompt_tokens_processed: 2048,
    n_prompt_tokens_cache: 0,
    params: {
      n_predict: 4096,
      secret: "DROP_ME",
    },
    next_token: [
      {
        has_next_token: false,
        n_remain: -1,
        n_decoded: 0,
      },
    ],
    prompt: "DROP_ME",
  },
])

assert.deepEqual(
  parsed,
  [
    {
      id: 0,
      id_task: 5257,
      n_ctx: 32768,
      is_processing: true,
      n_sequence_tokens: 2752,
      n_prompt_tokens_processed: 2048,
      n_prompt_tokens_cache: 0,
      next_token_schema: "array_singleton",
      next_token_ambiguous: false,
      n_decoded: 0,
      n_remain: -1,
      has_next_token: false,
      n_predict: 4096,
    },
  ],
)

assert.doesNotMatch(
  JSON.stringify(parsed),
  /DROP_ME/u,
)

const physical =
  createPhysicalInferenceCorrelationState({
    dispatched_mono_ms: 1000,
  })

const first =
  observePhysicalInferenceSnapshot(
    physical,
    {
      mono_ms: 1500,
      metrics: {
        "llamacpp:prompt_tokens_total": 1000,
        "llamacpp:prompt_seconds_total": 40,
        "llamacpp:tokens_predicted_total": 50,
        "llamacpp:tokens_predicted_seconds_total": 8,
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
        "llamacpp:n_tokens_max": 3000,
      },
      slots: [
        {
          id: 0,
          id_task: 5257,
          n_ctx: 32768,
          is_processing: true,
          n_prompt_tokens: 2048,
          n_prompt_tokens_processed: 0,
          n_prompt_tokens_cache: 0,
          params: { n_predict: 4096 },
          next_token: [
            {
              has_next_token: false,
              n_remain: -1,
              n_decoded: 0,
            },
          ],
        },
      ],
    },
  )

assert.equal(first.phase, "processing_unknown")
assert.equal(first.slot_prompt_remaining, null)
assert.equal(
  first.cardinality_claim,
  "observed_window_lower_bound",
)
assert.equal(
  first.physical_task_cardinality_lower_bound,
  1,
)
assert.equal(
  first.initial_slot_visibility_gap_ms,
  500,
)

const promptProgress =
  observePhysicalInferenceSnapshot(
    physical,
    {
      mono_ms: 6000,
      metrics: {
        "llamacpp:prompt_tokens_total": 3048,
        "llamacpp:prompt_seconds_total": 120,
        "llamacpp:tokens_predicted_total": 50,
        "llamacpp:tokens_predicted_seconds_total": 8,
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
        "llamacpp:n_tokens_max": 3500,
      },
      slots: [
        {
          id: 0,
          id_task: 5257,
          n_ctx: 32768,
          is_processing: true,
          n_prompt_tokens: 2752,
          n_prompt_tokens_processed: 2048,
          n_prompt_tokens_cache: 0,
          params: { n_predict: 4096 },
          next_token: [
            {
              has_next_token: false,
              n_remain: -1,
              n_decoded: 0,
            },
          ],
        },
      ],
    },
  )

assert.equal(
  promptProgress.slot_prompt_processed_interval,
  2048,
)
assert.equal(
  promptProgress.exact_server_progress_observed,
  true,
)
assert.ok(
  promptProgress.server_progress_kind.includes(
    "slot_prompt_processed",
  ),
)

const decodeProgress =
  observePhysicalInferenceSnapshot(
    physical,
    {
      mono_ms: 11000,
      metrics: {
        "llamacpp:prompt_tokens_total": 3752,
        "llamacpp:prompt_seconds_total": 150,
        "llamacpp:tokens_predicted_total": 50,
        "llamacpp:tokens_predicted_seconds_total": 8,
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
        "llamacpp:n_tokens_max": 4000,
      },
      slots: [
        {
          id: 0,
          id_task: 5257,
          n_ctx: 32768,
          is_processing: true,
          n_prompt_tokens: 2752,
          n_prompt_tokens_processed: 2752,
          n_prompt_tokens_cache: 0,
          params: { n_predict: 4096 },
          next_token: [
            {
              has_next_token: true,
              n_remain: 4080,
              n_decoded: 16,
            },
          ],
        },
      ],
    },
  )

assert.equal(decodeProgress.phase, "decode")
assert.equal(
  decodeProgress.slot_decoded_interval,
  16,
)
assert.ok(
  decodeProgress.server_progress_kind.includes(
    "slot_decode",
  ),
)

// Multiple next_token states are deliberately ambiguous.
const ambiguous = parseLlamaSlots([
  {
    id: 0,
    id_task: 1,
    is_processing: true,
    next_token: [
      { n_decoded: 1 },
      { n_decoded: 2 },
    ],
  },
])[0]

assert.equal(
  ambiguous.next_token_ambiguous,
  true,
)
assert.equal(
  ambiguous.n_decoded,
  null,
)

const lifecycle =
  createInferenceLifecycleState({
    logical_model_call: 1,
    dispatched_mono_ms: 1000,
  })

let observed =
  observeInferenceLifecycle(
    lifecycle,
    first,
    1500,
  )

assert.equal(
  observed.snapshot.state,
  "active",
)
assert.deepEqual(
  observed.snapshot.physical_task_ids,
  [5257],
)

markInferenceLogicalComplete(
  lifecycle,
  12000,
)

observed =
  observeInferenceLifecycle(
    lifecycle,
    {
      correlation_strategy:
        "no_processing_slot",
      correlated_slot_id: null,
      correlated_task_id: null,
      multiple_physical_tasks_observed:
        false,
    },
    12500,
  )

assert.equal(
  observed.snapshot.state,
  "quiescent",
)
assert.equal(
  snapshotInferenceLifecycle(
    lifecycle,
  ).task_terminal_requires_quiescence,
  true,
)

console.log(
  "PASS C11-R2+C12 inference lifecycle " +
  "slot_prompt_progress=request_scoped " +
  "next_token_array=supported " +
  "decode_progress=request_scoped " +
  "cardinality=observed_window_lower_bound " +
  "global_metrics=fallback_attribution_bound " +
  "ownership=logical_to_physical " +
  "task_terminal_requires_quiescence=true " +
  "stall_authority=false " +
  "solver_authority=false " +
  "mutation_authority=false",
)
