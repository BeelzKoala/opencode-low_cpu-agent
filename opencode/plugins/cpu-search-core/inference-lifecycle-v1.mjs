export const INFERENCE_LIFECYCLE_PROTOCOL =
  "inference-lifecycle-v2"

export const INFERENCE_LIFECYCLE_AUTHORITY =
  "resource_ownership_only"

const STATES = Object.freeze({
  DISPATCHED: "dispatched",
  CORRELATING: "correlating",
  ACTIVE: "active",
  LOGICAL_COMPLETE: "logical_complete",
  QUIESCENT: "quiescent",
  CANCEL_REQUESTED: "cancel_requested",
  LEAKED: "leaked",
  AMBIGUOUS: "ambiguous",
})

function finite(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  )
    ? value
    : null
}

function transition(state, next) {
  if (state.state === next) {
    return false
  }

  state.state = next
  state.transitionCount += 1
  return true
}

function segmentIdentity(slotID, taskID) {
  return `${slotID}:${taskID}`
}

function appendSegment(
  state,
  slotID,
  taskID,
  monoMs,
) {
  const key =
    segmentIdentity(
      slotID,
      taskID,
    )

  const last =
    state.segments[
      state.segments.length - 1
    ] ?? null

  if (last?.key === key) {
    last.lastObservedMonoMs =
      monoMs
    return {
      added: false,
      segment: last,
    }
  }

  if (last) {
    last.endedMonoMs =
      monoMs
  }

  const segment = {
    key,
    index:
      state.segments.length,
    slot_id:
      slotID,
    task_id:
      taskID,
    first_observed_mono_ms:
      monoMs,
    last_observed_mono_ms:
      monoMs,
    ended_mono_ms:
      null,
  }

  state.segments.push(segment)

  return {
    added: true,
    segment,
  }
}

export function createInferenceLifecycleState({
  logical_model_call = null,
  dispatched_mono_ms = null,
} = {}) {
  return {
    protocol:
      INFERENCE_LIFECYCLE_PROTOCOL,
    authority:
      INFERENCE_LIFECYCLE_AUTHORITY,

    logicalModelCall:
      Number.isSafeInteger(
        logical_model_call,
      )
        ? logical_model_call
        : null,

    dispatchedMonoMs:
      finite(dispatched_mono_ms),

    state:
      STATES.DISPATCHED,

    segments: [],
    logicalCompleteMonoMs: null,
    quiescentMonoMs: null,
    cancelRequestedMonoMs: null,
    leakDetectedMonoMs: null,

    transitionCount: 0,
    ownershipConflict: false,
    concurrentPhysicalActivityObserved:
      false,
  }
}

export function observeInferenceLifecycle(
  state,
  physical,
  mono_ms = null,
) {
  if (
    !state ||
    state.protocol !==
      INFERENCE_LIFECYCLE_PROTOCOL
  ) {
    throw new TypeError(
      "inference lifecycle v2 state required",
    )
  }

  const mono = finite(mono_ms)

  const processingSlots =
    Number.isSafeInteger(
      physical?.processing_slots,
    )
      ? physical.processing_slots
      : null

  let changed = false
  let sequentialTransition = false

  if (
    physical?.correlation_strategy ===
      "ambiguous_multiple_processing_slots" ||
    (
      processingSlots != null &&
      processingSlots > 1
    )
  ) {
    state.concurrentPhysicalActivityObserved =
      true
    state.ownershipConflict = true

    changed =
      transition(
        state,
        STATES.AMBIGUOUS,
      ) || changed

    return Object.freeze({
      changed,
      sequential_transition:
        false,
      snapshot:
        snapshotInferenceLifecycle(
          state,
        ),
    })
  }

  const slotID =
    Number.isSafeInteger(
      physical?.correlated_slot_id,
    )
      ? physical.correlated_slot_id
      : null

  const taskID =
    Number.isSafeInteger(
      physical?.correlated_task_id,
    )
      ? physical.correlated_task_id
      : null

  if (
    slotID != null &&
    taskID != null
  ) {
    const appended =
      appendSegment(
        state,
        slotID,
        taskID,
        mono,
      )

    sequentialTransition =
      appended.added &&
      state.segments.length > 1

    changed =
      appended.added ||
      changed

    changed =
      transition(
        state,
        STATES.ACTIVE,
      ) || changed
  } else if (
    physical?.correlation_strategy ===
      "no_processing_slot"
  ) {
    if (
      state.logicalCompleteMonoMs != null ||
      state.segments.length > 0
    ) {
      state.quiescentMonoMs =
        mono

      const last =
        state.segments[
          state.segments.length - 1
        ]

      if (
        last &&
        last.ended_mono_ms == null
      ) {
        last.ended_mono_ms =
          mono
      }

      changed =
        transition(
          state,
          STATES.QUIESCENT,
        ) || changed
    }
  } else if (
    state.state ===
      STATES.DISPATCHED
  ) {
    changed =
      transition(
        state,
        STATES.CORRELATING,
      ) || changed
  }

  return Object.freeze({
    changed,
    sequential_transition:
      sequentialTransition,
    snapshot:
      snapshotInferenceLifecycle(
        state,
      ),
  })
}

export function markInferenceLogicalComplete(
  state,
  mono_ms = null,
) {
  const mono = finite(mono_ms)

  state.logicalCompleteMonoMs =
    mono

  if (
    state.state !==
      STATES.QUIESCENT
  ) {
    transition(
      state,
      STATES.LOGICAL_COMPLETE,
    )
  }

  return snapshotInferenceLifecycle(
    state,
  )
}

export function markInferenceCancelRequested(
  state,
  mono_ms = null,
) {
  state.cancelRequestedMonoMs =
    finite(mono_ms)

  transition(
    state,
    STATES.CANCEL_REQUESTED,
  )

  return snapshotInferenceLifecycle(
    state,
  )
}

export function markInferenceLeak(
  state,
  mono_ms = null,
) {
  state.leakDetectedMonoMs =
    finite(mono_ms)

  transition(
    state,
    STATES.LEAKED,
  )

  return snapshotInferenceLifecycle(
    state,
  )
}

export function snapshotInferenceLifecycle(
  state,
) {
  const segments =
    state.segments.map(
      (segment) =>
        Object.freeze({
          index:
            segment.index,
          slot_id:
            segment.slot_id,
          task_id:
            segment.task_id,
          first_observed_mono_ms:
            segment.first_observed_mono_ms,
          last_observed_mono_ms:
            segment.last_observed_mono_ms,
          ended_mono_ms:
            segment.ended_mono_ms,
        }),
    )

  return Object.freeze({
    protocol:
      INFERENCE_LIFECYCLE_PROTOCOL,
    authority:
      INFERENCE_LIFECYCLE_AUTHORITY,
    state:
      state.state,

    logical_model_call:
      state.logicalModelCall,

    physical_segments:
      Object.freeze(segments),
    physical_segment_count:
      segments.length,
    physical_task_ids:
      Object.freeze([
        ...new Set(
          segments.map(
            (segment) =>
              segment.task_id,
          ),
        ),
      ]),

    logical_complete_mono_ms:
      state.logicalCompleteMonoMs,
    quiescent_mono_ms:
      state.quiescentMonoMs,
    cancel_requested_mono_ms:
      state.cancelRequestedMonoMs,
    leak_detected_mono_ms:
      state.leakDetectedMonoMs,

    transition_count:
      state.transitionCount,

    ownership_model:
      "one_logical_to_sequential_physical_segments",

    ownership_conflict:
      state.ownershipConflict,
    concurrent_physical_activity_observed:
      state.concurrentPhysicalActivityObserved,

    task_terminal_requires_quiescence:
      true,
    model_context_overhead_bytes:
      0,
    solver_authority:
      false,
    mutation_authority:
      false,
  })
}
