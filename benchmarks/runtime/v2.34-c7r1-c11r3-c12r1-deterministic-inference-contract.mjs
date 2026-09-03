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
  observeInferenceLifecycle,
  markInferenceLogicalComplete,
} from "../../opencode/plugins/cpu-search-core/inference-lifecycle-v1.mjs"

assert.equal(
  PHYSICAL_INFERENCE_PROTOCOL,
  "physical-inference-correlation-v3",
)

assert.equal(
  INFERENCE_LIFECYCLE_PROTOCOL,
  "inference-lifecycle-v2",
)

// Raw llama.cpp /slots form.
const raw = parseLlamaSlots([
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
])

assert.equal(raw[0].n_sequence_tokens, 5119)
assert.equal(raw[0].n_decoded, 839)
assert.equal(raw[0].n_remain, 3257)

// Idempotence regression: telemetry already normalizes /slots once.
const twice = parseLlamaSlots(raw)
assert.equal(twice[0].n_sequence_tokens, 5119)
assert.equal(twice[0].n_decoded, 839)
assert.equal(twice[0].n_remain, 3257)

const physical =
  createPhysicalInferenceCorrelationState({
    dispatched_mono_ms: 0,
  })

observePhysicalInferenceSnapshot(
  physical,
  {
    mono_ms: 1000,
    metrics: {
      "llamacpp:requests_processing": 1,
      "llamacpp:requests_deferred": 0,
      "llamacpp:prompt_tokens_total": 4280,
      "llamacpp:prompt_seconds_total": 100,
      "llamacpp:tokens_predicted_total": 0,
      "llamacpp:tokens_predicted_seconds_total": 0,
    },
    slots: [
      {
        id: 0,
        id_task: 8,
        n_ctx: 32768,
        is_processing: true,
        n_prompt_tokens: 4280,
        n_prompt_tokens_processed: 4280,
        n_prompt_tokens_cache: 0,
        params: { n_predict: 4096 },
        next_token: [
          {
            has_next_token: true,
            n_remain: 4096,
            n_decoded: 0,
          },
        ],
      },
    ],
  },
)

const decode =
  observePhysicalInferenceSnapshot(
    physical,
    {
      mono_ms: 2000,
      metrics: {
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
        "llamacpp:prompt_tokens_total": 4280,
        "llamacpp:prompt_seconds_total": 100,
        "llamacpp:tokens_predicted_total": 0,
        "llamacpp:tokens_predicted_seconds_total": 0,
      },
      slots: [
        {
          id: 0,
          id_task: 8,
          n_ctx: 32768,
          is_processing: true,
          // llama.cpp grows this sequence during decode.
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
      ],
    },
  )

assert.equal(decode.phase, "decode")
assert.equal(decode.slot_decoded, 839)
assert.equal(decode.slot_decoded_interval, 839)
assert.equal(decode.slot_context_sequence_interval, 839)
assert.equal(decode.slot_prompt_processed_interval, 0)
assert.equal(decode.slot_prompt_tokens, null)
assert.equal(decode.slot_prompt_remaining, null)
assert.ok(
  decode.server_progress_kind.includes(
    "slot_decode",
  ),
)
assert.ok(
  !decode.server_progress_kind.includes(
    "slot_prompt_processed",
  ),
)

// Lifecycle: 4 -> 8 is sequential ownership, not conflict.
const lifecycle =
  createInferenceLifecycleState({
    logical_model_call: 1,
    dispatched_mono_ms: 0,
  })

let observed =
  observeInferenceLifecycle(
    lifecycle,
    {
      correlation_strategy:
        "singleton_processing_slot",
      processing_slots: 1,
      correlated_slot_id: 0,
      correlated_task_id: 4,
    },
    100,
  )

assert.equal(
  observed.snapshot.ownership_conflict,
  false,
)
assert.equal(
  observed.snapshot.physical_segment_count,
  1,
)

observed =
  observeInferenceLifecycle(
    lifecycle,
    {
      correlation_strategy:
        "singleton_processing_slot",
      processing_slots: 1,
      correlated_slot_id: 0,
      correlated_task_id: 8,
    },
    200,
  )

assert.equal(
  observed.sequential_transition,
  true,
)
assert.equal(
  observed.snapshot.ownership_conflict,
  false,
)
assert.equal(
  observed.snapshot.physical_segment_count,
  2,
)
assert.deepEqual(
  observed.snapshot.physical_task_ids,
  [4, 8],
)

markInferenceLogicalComplete(
  lifecycle,
  300,
)

observed =
  observeInferenceLifecycle(
    lifecycle,
    {
      correlation_strategy:
        "no_processing_slot",
      processing_slots: 0,
      correlated_slot_id: null,
      correlated_task_id: null,
    },
    400,
  )

assert.equal(
  observed.snapshot.state,
  "quiescent",
)

// Actual conflict is concurrent physical activity.
const bad =
  createInferenceLifecycleState({
    logical_model_call: 2,
  })

observed =
  observeInferenceLifecycle(
    bad,
    {
      correlation_strategy:
        "ambiguous_multiple_processing_slots",
      processing_slots: 2,
      correlated_slot_id: null,
      correlated_task_id: null,
    },
    100,
  )

assert.equal(
  observed.snapshot.ownership_conflict,
  true,
)
assert.equal(
  observed.snapshot.concurrent_physical_activity_observed,
  true,
)

console.log(
  "PASS deterministic inference contract corrections " +
  "slot_normalization=idempotent " +
  "decode_phase=exact " +
  "sequence_length_not_prompt_total=true " +
  "ownership=one_logical_to_sequential_physical_segments " +
  "sequential_task_transition=allowed " +
  "concurrent_physical_activity=conflict " +
  "stall_authority=false " +
  "solver_authority=false",
)
