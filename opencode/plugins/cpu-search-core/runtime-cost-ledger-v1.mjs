import { createHash } from "node:crypto"

export const RUNTIME_COST_LEDGER_PROTOCOL = "runtime-cost-ledger-v1"
export const RUNTIME_COST_TRACE_PROTOCOL = "runtime-cost-trace-v1"
export const RUNTIME_COST_AUTHORITY = "shadow_observation"
export const RUNTIME_COST_TRACE_FILE = "runtime-cost-trace.jsonl"
export const RUNTIME_COST_PROFILE_SAMPLE_CAP = 8

export const RUNTIME_RESOURCE_CLASS = Object.freeze({
  EXCLUSIVE_CPU: "exclusive_cpu",
  CPU_BOUNDED: "cpu_bounded",
  IO_MIXED: "io_mixed",
  MUTATION_SERIAL: "mutation_serial",
  TELEMETRY: "telemetry",
})

const MODEL_STAGE = "model_inference"

function finiteMs(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function boundedString(value, max = 256) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

function canonicalProfileIdentity(input = {}) {
  return {
    provider_id: boundedString(input.providerID, 128),
    model_id: boundedString(input.modelID, 128),
    phase: boundedString(input.phase, 64),
    frontier_sha256: boundedString(input.frontierSha256, 128),
  }
}

function profileKeySha256(identity) {
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
}

function median(sorted) {
  if (sorted.length < 1) return null
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function nearestRank(sorted, quantile) {
  if (sorted.length < 1) return null
  const rank = Math.max(
    1,
    Math.min(sorted.length, Math.ceil(quantile * sorted.length)),
  )
  return sorted[rank - 1]
}

export function summarizeRuntimeCostSamples(samples) {
  const values = (Array.isArray(samples) ? samples : [])
    .map(finiteMs)
    .filter((value) => value !== null)
    .sort((a, b) => a - b)

  if (values.length < 1) {
    return Object.freeze({
      samples: 0,
      p50_ms: null,
      p90_ms: null,
      max_ms: null,
    })
  }

  return Object.freeze({
    samples: values.length,
    p50_ms: median(values),
    p90_ms: nearestRank(values, 0.90),
    max_ms: values[values.length - 1],
  })
}

export function createRuntimeCostLedgerState() {
  return {
    protocol: RUNTIME_COST_LEDGER_PROTOCOL,
    authority: RUNTIME_COST_AUTHORITY,
    turnID: null,
    dispatchSeq: 0,
    activeModel: null,
    profiles: new Map(),
  }
}

export function resetRuntimeCostLedgerTurn(state, turnID) {
  if (!state || state.protocol !== RUNTIME_COST_LEDGER_PROTOCOL) return false
  state.turnID = typeof turnID === "string" ? turnID : null
  // A new user turn causally fences any unfinished observation. Do not invent
  // an end time for the old span: missing telemetry is safer than false cost.
  state.activeModel = null
  return true
}

export function startModelCostSpan(state, input = {}) {
  if (!state || state.protocol !== RUNTIME_COST_LEDGER_PROTOCOL) {
    return { ok: false, reason: "runtime_cost_state_invalid" }
  }

  const startedAtMs = finiteMs(input.startedAtMs)
  const turnID = boundedString(input.turnID, 512)
  if (startedAtMs === null || !turnID) {
    return { ok: false, reason: "runtime_cost_model_start_invalid" }
  }

  // Never overwrite an unclosed span. That would make the newer observation
  // look precise while silently corrupting the older one.
  if (state.activeModel) {
    return {
      ok: false,
      reason: "runtime_cost_model_span_already_active",
      active_dispatch_id: state.activeModel.dispatch_id,
    }
  }

  state.dispatchSeq += 1
  const dispatchSeq = Number.isInteger(input.dispatchSeq)
    ? input.dispatchSeq
    : state.dispatchSeq
  const identity = canonicalProfileIdentity(input)
  const dispatchID = createHash("sha256")
    .update(JSON.stringify({
      sessionID: boundedString(input.sessionID, 512),
      turnID,
      dispatchSeq,
      startedAtMs,
      identity,
    }))
    .digest("hex")
    .slice(0, 24)

  state.turnID = turnID
  state.activeModel = {
    dispatch_id: dispatchID,
    dispatch_seq: dispatchSeq,
    session_id: boundedString(input.sessionID, 512),
    turn_id: turnID,
    started_at_ms: startedAtMs,
    provider_id: identity.provider_id,
    model_id: identity.model_id,
    phase: identity.phase,
    frontier_sha256: identity.frontier_sha256,
    context_bytes: Number.isFinite(input.contextBytes)
      ? Math.max(0, Math.trunc(input.contextBytes))
      : null,
    profile_identity: identity,
    profile_key_sha256: profileKeySha256(identity),
  }

  return {
    ok: true,
    reason: "runtime_cost_model_span_started",
    dispatch_id: dispatchID,
  }
}

function classifyModelOutcome(input = {}) {
  if (input.error) return "error"
  const finish = String(input.finish ?? "").toLowerCase()
  if (finish.includes("tool")) return "tool_call"
  if (finish.includes("cancel") || finish.includes("abort")) return "cancelled"
  return "assistant_no_tool"
}

function validTimestamp(value, lower, upper) {
  const ms = finiteMs(value)
  if (ms === null) return null
  if (Number.isFinite(lower) && ms < lower) return null
  if (Number.isFinite(upper) && ms > upper) return null
  return ms
}

function appendProfileSample(state, active, durationMs) {
  const key = active.profile_key_sha256
  const existing = state.profiles.get(key)
  const values = Array.isArray(existing) ? existing.slice() : []
  values.push(durationMs)
  while (values.length > RUNTIME_COST_PROFILE_SAMPLE_CAP) values.shift()
  state.profiles.set(key, values)
  return summarizeRuntimeCostSamples(values)
}

export function finishModelCostSpan(state, input = {}) {
  if (!state || state.protocol !== RUNTIME_COST_LEDGER_PROTOCOL) {
    return { ok: false, reason: "runtime_cost_state_invalid" }
  }

  const active = state.activeModel
  if (!active) {
    return { ok: false, reason: "runtime_cost_model_span_absent" }
  }

  const currentTurnID = boundedString(input.currentTurnID, 512)
  if (currentTurnID && currentTurnID !== active.turn_id) {
    // A stale completion must never close a newer dispatch.
    return {
      ok: false,
      reason: "runtime_cost_model_completion_stale_turn",
      active_dispatch_id: active.dispatch_id,
    }
  }

  const observedAtMs = finiteMs(input.observedAtMs)
  if (observedAtMs === null) {
    return { ok: false, reason: "runtime_cost_model_end_invalid" }
  }

  // Prefer provider/message timestamps when OpenCode exposes them. This keeps
  // tool execution and delayed SSE delivery out of model latency. Fall back
  // conservatively to the context-hook release -> completion boundary.
  const completedAtMs = validTimestamp(
    input.completedAtMs,
    active.started_at_ms,
    observedAtMs + 1000,
  )
  const providerStartedAtMs = completedAtMs === null
    ? null
    : validTimestamp(
        input.providerStartedAtMs,
        0,
        completedAtMs,
      )

  let startAtMs = active.started_at_ms
  let endAtMs = observedAtMs
  let boundaryQuality = "context_hook_to_event_observed"

  if (providerStartedAtMs !== null && completedAtMs !== null) {
    startAtMs = providerStartedAtMs
    endAtMs = completedAtMs
    boundaryQuality = "assistant_message_timestamps"
  } else if (completedAtMs !== null) {
    endAtMs = completedAtMs
    boundaryQuality = "context_hook_to_completion_timestamp"
  }

  const durationMs = Math.max(0, Math.round(endAtMs - startAtMs))
  const outcome = classifyModelOutcome(input)
  const profile = appendProfileSample(state, active, durationMs)

  const record = Object.freeze({
    protocol: RUNTIME_COST_TRACE_PROTOCOL,
    ledger_protocol: RUNTIME_COST_LEDGER_PROTOCOL,
    authority: RUNTIME_COST_AUTHORITY,
    mutation_authority: false,
    scheduling_authority: false,
    stage: MODEL_STAGE,
    substage: active.phase,
    resource_class: RUNTIME_RESOURCE_CLASS.EXCLUSIVE_CPU,
    cost_kind: "leaf",
    dispatch_id: active.dispatch_id,
    dispatch_seq: active.dispatch_seq,
    sessionID: active.session_id,
    turnID: active.turn_id,
    providerID: active.provider_id,
    modelID: active.model_id,
    frontier_sha256: active.frontier_sha256,
    context_bytes: active.context_bytes,
    messageID: boundedString(input.messageID, 512),
    finish: boundedString(input.finish, 128),
    error: boundedString(input.error, 256),
    outcome,
    started_at_ms: startAtMs,
    ended_at_ms: endAtMs,
    observed_at_ms: observedAtMs,
    elapsed_ms: durationMs,
    boundary_quality: boundaryQuality,
    profile_key_sha256: active.profile_key_sha256,
    profile_shadow: profile,
  })

  state.activeModel = null
  return {
    ok: true,
    reason: "runtime_cost_model_span_finished",
    record,
  }
}

function completedCostRecord({
  sourceTrace,
  sourceProtocol,
  sourceKind,
  sessionID,
  turnID,
  endAtMs,
  stage,
  substage = null,
  resourceClass,
  costKind,
  elapsedMs,
}) {
  const elapsed = finiteMs(elapsedMs)
  if (elapsed === null) return null
  const end = finiteMs(endAtMs)
  return Object.freeze({
    protocol: RUNTIME_COST_TRACE_PROTOCOL,
    ledger_protocol: RUNTIME_COST_LEDGER_PROTOCOL,
    authority: RUNTIME_COST_AUTHORITY,
    mutation_authority: false,
    scheduling_authority: false,
    stage,
    substage,
    resource_class: resourceClass,
    cost_kind: costKind,
    sessionID: boundedString(sessionID, 512),
    turnID: boundedString(turnID, 512),
    started_at_ms: end === null ? null : Math.max(0, Math.round(end - elapsed)),
    ended_at_ms: end,
    elapsed_ms: Math.round(elapsed * 100) / 100,
    boundary_quality: "derived_existing_elapsed",
    source_trace: sourceTrace,
    source_protocol: boundedString(sourceProtocol, 128),
    source_kind: boundedString(sourceKind, 128),
  })
}

function pushCost(records, args) {
  const record = completedCostRecord(args)
  if (record) records.push(record)
}

export function runtimeCostRecordsFromTrace(fileName, record) {
  try {
    if (!record || typeof record !== "object") return []
    const sourceTrace = boundedString(fileName, 128)
    const sourceProtocol = record.protocol ?? null
    const sourceKind = record.kind ?? null
    const common = {
      sourceTrace,
      sourceProtocol,
      sourceKind,
      sessionID: record.sessionID ?? null,
      turnID: record.turnID ?? null,
      endAtMs: record.ts ?? null,
    }
    const records = []

    if (
      sourceTrace === "cpu-agent-trace.jsonl" &&
      sourceKind === "deterministic_scout_preflight"
    ) {
      pushCost(records, {
        ...common,
        stage: "deterministic_scout_preflight",
        resourceClass: RUNTIME_RESOURCE_CLASS.IO_MIXED,
        costKind: "aggregate",
        elapsedMs: record.elapsed_ms,
      })
    }

    if (sourceTrace === "search-trace.jsonl") {
      pushCost(records, {
        ...common,
        stage: "scout_search",
        resourceClass: RUNTIME_RESOURCE_CLASS.IO_MIXED,
        costKind: "aggregate",
        elapsedMs: record.elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "scout_lexical_discovery",
        resourceClass: RUNTIME_RESOURCE_CLASS.IO_MIXED,
        costKind: "component",
        elapsedMs: record.discovery_elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "retrieval_ranker",
        resourceClass: RUNTIME_RESOURCE_CLASS.CPU_BOUNDED,
        costKind: "component",
        elapsedMs: record.retrieval_ranker_elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "impact_index",
        resourceClass: RUNTIME_RESOURCE_CLASS.CPU_BOUNDED,
        costKind: "component",
        elapsedMs: record.impact_index_elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "impact_validation",
        resourceClass: RUNTIME_RESOURCE_CLASS.CPU_BOUNDED,
        costKind: "component",
        elapsedMs: record.impact_validation_elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "semantic_impact",
        resourceClass: RUNTIME_RESOURCE_CLASS.CPU_BOUNDED,
        costKind: "component",
        elapsedMs: record.semantic_impact_elapsed_ms,
      })
    }

    if (sourceTrace === "executor-trace.jsonl") {
      pushCost(records, {
        ...common,
        stage: "mutation_tool",
        resourceClass: RUNTIME_RESOURCE_CLASS.MUTATION_SERIAL,
        costKind: "aggregate",
        elapsedMs: record.tool_elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "patch_compiler",
        resourceClass: RUNTIME_RESOURCE_CLASS.CPU_BOUNDED,
        costKind: "component",
        elapsedMs: record.compiler_elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "patch_executor",
        resourceClass: RUNTIME_RESOURCE_CLASS.MUTATION_SERIAL,
        costKind: "component",
        elapsedMs: record.executor_elapsed_ms,
      })
      pushCost(records, {
        ...common,
        stage: "invariant_verifier",
        resourceClass: RUNTIME_RESOURCE_CLASS.CPU_BOUNDED,
        costKind: "component",
        elapsedMs: record.verifier_elapsed_ms,
      })
    }

    return records.slice(0, 12)
  } catch {
    // Telemetry classification must never alter product behavior.
    return []
  }
}
