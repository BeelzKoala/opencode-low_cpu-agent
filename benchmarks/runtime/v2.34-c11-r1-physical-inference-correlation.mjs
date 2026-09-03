import assert from "node:assert/strict"

import {
  PHYSICAL_INFERENCE_AUTHORITY,
  PHYSICAL_INFERENCE_PROTOCOL,
  createPhysicalInferenceCorrelationState,
  observePhysicalInferenceSnapshot,
  parseLlamaSlots,
} from "../../opencode/plugins/cpu-search-core/physical-inference-correlation-v1.mjs"

assert.equal(
  PHYSICAL_INFERENCE_PROTOCOL,
  "physical-inference-correlation-v1",
)
assert.equal(
  PHYSICAL_INFERENCE_AUTHORITY,
  "observation_only",
)

const safeSlots = parseLlamaSlots([
  {
    id: 0,
    id_task: 41,
    n_ctx: 32768,
    is_processing: true,
    prompt: "MUST_NOT_SURVIVE",
    params: {
      n_predict: 4096,
      secret: "MUST_NOT_SURVIVE",
    },
    next_token: {
      has_next_token: true,
      n_remain: 4090,
      n_decoded: 6,
    },
  },
])

assert.deepEqual(
  safeSlots,
  [
    {
      id: 0,
      id_task: 41,
      n_ctx: 32768,
      is_processing: true,
      n_decoded: 6,
      n_remain: 4090,
      has_next_token: true,
      n_predict: 4096,
    },
  ],
)

assert.doesNotMatch(
  JSON.stringify(safeSlots),
  /MUST_NOT_SURVIVE/u,
)

const state =
  createPhysicalInferenceCorrelationState()

const first =
  observePhysicalInferenceSnapshot(
    state,
    {
      mono_ms: 1000,
      metrics: {
        "llamacpp:prompt_tokens_total": 100,
        "llamacpp:prompt_seconds_total": 10,
        "llamacpp:tokens_predicted_total": 5,
        "llamacpp:tokens_predicted_seconds_total": 1,
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
        "llamacpp:n_tokens_max": 500,
      },
      slots: [
        {
          id: 0,
          id_task: 41,
          n_ctx: 32768,
          is_processing: true,
          next_token: {
            n_decoded: 5,
            n_remain: 4091,
            has_next_token: true,
          },
        },
      ],
    },
  )

assert.equal(
  first.correlation_strategy,
  "singleton_processing_slot",
)
assert.equal(
  first.physical_task_cardinality_observed,
  1,
)
assert.equal(
  first.global_prompt_tokens_delta,
  0,
)
assert.equal(
  first.server_context_high_water_tokens,
  500,
)
assert.equal(
  first.stall_authority,
  false,
)

const progressing =
  observePhysicalInferenceSnapshot(
    state,
    {
      mono_ms: 6000,
      metrics: {
        "llamacpp:prompt_tokens_total": 180,
        "llamacpp:prompt_seconds_total": 14,
        "llamacpp:tokens_predicted_total": 8,
        "llamacpp:tokens_predicted_seconds_total": 2,
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
        "llamacpp:n_tokens_max": 900,
      },
      slots: [
        {
          id: 0,
          id_task: 41,
          n_ctx: 32768,
          is_processing: true,
          next_token: {
            n_decoded: 8,
            n_remain: 4088,
            has_next_token: true,
          },
        },
      ],
    },
  )

assert.equal(
  progressing.request_scoped_counter_progress,
  true,
)
assert.equal(
  progressing.interval_prompt_tokens_delta,
  80,
)
assert.equal(
  progressing.interval_predicted_tokens_delta,
  3,
)
assert.equal(
  progressing.slot_decoded_interval,
  3,
)
assert.equal(
  progressing.server_progress_observed,
  true,
)
assert.deepEqual(
  progressing.server_progress_kind,
  ["global_counter", "slot_decode"],
)

const transitioned =
  observePhysicalInferenceSnapshot(
    state,
    {
      mono_ms: 11000,
      metrics: {
        "llamacpp:prompt_tokens_total": 260,
        "llamacpp:prompt_seconds_total": 18,
        "llamacpp:tokens_predicted_total": 8,
        "llamacpp:tokens_predicted_seconds_total": 2,
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
        "llamacpp:n_tokens_max": 1200,
      },
      slots: [
        {
          id: 0,
          id_task: 42,
          n_ctx: 32768,
          is_processing: true,
          next_token: {
            n_decoded: 0,
            n_remain: 4096,
            has_next_token: true,
          },
        },
      ],
    },
  )

assert.equal(
  transitioned.task_transition,
  true,
)
assert.equal(
  transitioned.request_scoped_counter_progress,
  false,
)
assert.equal(
  transitioned.physical_task_cardinality_observed,
  2,
)
assert.equal(
  transitioned.multiple_physical_tasks_observed,
  true,
)
assert.deepEqual(
  transitioned.physical_task_ids_seen,
  [41, 42],
)

const ambiguous =
  observePhysicalInferenceSnapshot(
    state,
    {
      mono_ms: 16000,
      metrics: {
        "llamacpp:prompt_tokens_total": 300,
        "llamacpp:prompt_seconds_total": 20,
        "llamacpp:tokens_predicted_total": 9,
        "llamacpp:tokens_predicted_seconds_total": 2.5,
        "llamacpp:requests_processing": 2,
        "llamacpp:requests_deferred": 0,
        "llamacpp:n_tokens_max": 1300,
      },
      slots: [
        {
          id: 0,
          id_task: 42,
          is_processing: true,
          next_token: { n_decoded: 1 },
        },
        {
          id: 1,
          id_task: 99,
          is_processing: true,
          next_token: { n_decoded: 10 },
        },
      ],
    },
  )

assert.equal(
  ambiguous.correlation_strategy,
  "ambiguous_multiple_processing_slots",
)
assert.equal(
  ambiguous.correlated_task_id,
  null,
)
assert.equal(
  ambiguous.request_scoped_counter_progress,
  false,
)
assert.equal(
  ambiguous.physical_task_cardinality_observed,
  2,
)

// n_tokens_max is metadata only. A high-water change without a counter/slot
// transition must never manufacture progress.
const highWaterOnlyState =
  createPhysicalInferenceCorrelationState()

observePhysicalInferenceSnapshot(
  highWaterOnlyState,
  {
    mono_ms: 1000,
    metrics: {
      "llamacpp:prompt_tokens_total": 10,
      "llamacpp:tokens_predicted_total": 2,
      "llamacpp:n_tokens_max": 100,
      "llamacpp:requests_processing": 1,
    },
    slots: [
      {
        id: 0,
        id_task: 7,
        is_processing: true,
        next_token: { n_decoded: 2 },
      },
    ],
  },
)

const highWaterOnly =
  observePhysicalInferenceSnapshot(
    highWaterOnlyState,
    {
      mono_ms: 6000,
      metrics: {
        "llamacpp:prompt_tokens_total": 10,
        "llamacpp:tokens_predicted_total": 2,
        "llamacpp:n_tokens_max": 999,
        "llamacpp:requests_processing": 1,
      },
      slots: [
        {
          id: 0,
          id_task: 7,
          is_processing: true,
          next_token: { n_decoded: 2 },
        },
      ],
    },
  )

assert.equal(
  highWaterOnly.server_progress_observed,
  false,
)
assert.equal(
  highWaterOnly.server_context_high_water_tokens,
  999,
)

console.log(
  "PASS C11-R1 physical inference correlation " +
  "logical_to_physical_cardinality=observed " +
  "singleton_slot=request_scoped " +
  "multi_slot=ambiguous_fail_closed " +
  "task_transition=observed " +
  "slot_decode_progress=exact " +
  "global_metric_delta=baseline_bound " +
  "n_tokens_max=metadata_only " +
  "stall_authority=false " +
  "solver_authority=false " +
  "mutation_authority=false",
)
