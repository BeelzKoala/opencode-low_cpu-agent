
function rawHeaderReserveLines({
  scanComplete,
  discoveryComplete,
  selectedScanComplete,
  candidateFiles,
  selectedFiles,
  uniqueHits,
  querySummary,
}) {
  // This is deliberately conservative.
  //
  // The reserve must contain every field that the real RAW header may emit.
  // "false" is at least as long as "true", shown_hits cannot require more
  // digits than unique_hits, and the reasons line contains the union of all
  // RAW incomplete reasons.
  return [
    `SEARCH complete=false scan_complete=${scanComplete} ` +
      `lexical_discovery_complete=${discoveryComplete} ` +
      `selected_scan_complete=${selectedScanComplete} ` +
      `evidence_complete=false selected_evidence_complete=false ` +
      `candidate_files=${candidateFiles} selected_files=${selectedFiles} ` +
      `unique_hits=${uniqueHits} shown_hits=${uniqueHits}`,
    ...querySummary,
    "INCOMPLETE reasons=" +
      "lexical_discovery_incomplete,probe_subset,scan_incomplete," +
      "budgeted_emit_subset,output_budget",
  ]
}

function normalizePublicEvent(raw) {
  if (raw?.payload && typeof raw.payload === "object") return raw.payload
  return raw
}

function taskContextValueKind(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function taskContextPartTypes(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const part of value) {
    const type = typeof part?.type === "string" ? part.type : taskContextValueKind(part)
    if (seen.has(type)) continue
    seen.add(type)
    out.push(type)
    if (out.length >= TASK_CONTEXT_MAX_REPORTED_PART_TYPES) break
  }
  return out
}

function normalizeTaskTextChunk(value, source) {
  if (typeof value !== "string") {
    return {
      ok: false,
      reason: "task_text_chunk_not_string",
      text: "",
      source,
    }
  }

  const raw = value.trim()
  if (!raw) {
    return {
      ok: false,
      reason: "task_text_chunk_empty",
      text: "",
      source,
    }
  }

  // OpenCode context may expose one JSON-string serialization layer.
  // Decode exactly one layer; never recursively parse arbitrary values.
  //
  // Some host paths may preserve the outer JSON quotes while materializing
  // escaped control characters as literal U+0000..U+001F characters.
  // Strict JSON.parse rejects those. The fallback repairs ONLY those
  // characters and then requires strict JSON.parse to succeed.
  if (
    source === "content_text_part_text" &&
    raw.startsWith('"')
  ) {
    let decoded = null
    let decodedSource =
      "content_text_part_text_json_string"

    try {
      decoded = JSON.parse(raw)
    } catch {
      if (
        !raw.endsWith('"') ||
        !/[\u0000-\u001f]/u.test(raw)
      ) {
        return {
          ok: false,
          reason: "task_text_representation_invalid",
          text: "",
          source,
        }
      }

      const repaired = raw.replace(
        /[\u0000-\u001f]/gu,
        (value) =>
          JSON.stringify(value).slice(1, -1),
      )

      try {
        decoded = JSON.parse(repaired)
      } catch {
        return {
          ok: false,
          reason: "task_text_representation_invalid",
          text: "",
          source,
        }
      }

      decodedSource =
        "content_text_part_text_json_string_controls_repaired"
    }

    if (typeof decoded !== "string") {
      return {
        ok: false,
        reason: "task_text_representation_not_string",
        text: "",
        source,
      }
    }

    const text = decoded.trim()

    if (!text) {
      return {
        ok: false,
        reason: "task_text_chunk_empty",
        text: "",
        source: decodedSource,
      }
    }

    return {
      ok: true,
      reason:
        decodedSource ===
        "content_text_part_text_json_string"
          ? "task_text_json_string_decoded"
          : "task_text_json_string_controls_repaired",
      text,
      source: decodedSource,
    }
  }

  return {
    ok: true,
    reason: "task_text_plain",
    text: raw,
    source,
  }
}

function taskContextIsUserMessage(message) {
  return (
    message != null &&
    typeof message === "object" &&
    (
      message.role === "user" ||
      message.type === "user"
    )
  )
}

function extractUserMessageText(message) {
  if (!taskContextIsUserMessage(message)) {
    return {
      ok: false,
      reason: "not_user_message",
      text: "",
      textBytes: 0,
      sources: [],
      shape: null,
    }
  }

  const chunks = []
  const sources = []
  const seenChunks = new Set()
  let partBudgetExceeded = false
  let representationFailure = null

  const add = (value, source) => {
    if (typeof value !== "string") return

    const normalized = normalizeTaskTextChunk(value, source)

    if (!normalized.ok) {
      if (
        normalized.reason === "task_text_representation_invalid" ||
        normalized.reason === "task_text_representation_not_string"
      ) {
        representationFailure ??= normalized.reason
      }
      return
    }

    const text = normalized.text
    if (!text || seenChunks.has(text)) return

    seenChunks.add(text)
    chunks.push(text)

    if (
      sources.length < TASK_CONTEXT_MAX_REPORTED_SOURCES &&
      !sources.includes(normalized.source)
    ) {
      sources.push(normalized.source)
    }
  }

  const readTextParts = (value, family) => {
    if (!Array.isArray(value)) return

    if (value.length > TASK_CONTEXT_MAX_PARTS) {
      partBudgetExceeded = true
      return
    }

    for (const part of value) {
      if (part?.type !== "text") continue

      if (family === "content") {
        add(part?.text, "content_text_part_text")
        add(part?.content, "content_text_part_content")
      } else {
        add(part?.text, "parts_text")
        add(part?.content, "parts_content")
      }
    }
  }

  if (typeof message.content === "string") {
    add(message.content, "content_string")
  } else {
    readTextParts(message.content, "content")
  }

  readTextParts(message.parts, "parts")
  add(message.text, "message_text")

  const shape = {
    content_kind: taskContextValueKind(message.content),
    content_part_types: taskContextPartTypes(message.content),
    parts_kind: taskContextValueKind(message.parts),
    parts_part_types: taskContextPartTypes(message.parts),
    has_message_text: typeof message.text === "string",
  }

  if (partBudgetExceeded) {
    return {
      ok: false,
      reason: "task_part_budget_exceeded",
      text: "",
      textBytes: 0,
      sources,
      shape,
    }
  }

  if (representationFailure) {
    return {
      ok: false,
      reason: representationFailure,
      text: "",
      textBytes: 0,
      sources,
      shape,
    }
  }

  if (chunks.length < 1) {
    return {
      ok: false,
      reason: "user_task_text_unavailable",
      text: "",
      textBytes: 0,
      sources,
      shape,
    }
  }

  const text = chunks.join("\n")
  const textBytes = Buffer.byteLength(text, "utf8")

  if (textBytes > TASK_CONTEXT_MAX_TEXT_BYTES) {
    return {
      ok: false,
      reason: "task_text_budget_exceeded",
      text: "",
      textBytes,
      sources,
      shape,
    }
  }

  return {
    ok: true,
    reason: "task_text_observed",
    text,
    textBytes,
    sources,
    shape,
  }
}

function classifyMutationIntent(text) {
  const value = String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim()
  if (!value) return { protocol:MUTATION_INTENT_PROTOCOL, kind:"unknown", reason:"empty_task" }

  const explicitEnglishRename = /(?:^|[.!?]\s*)(?:please\s+)?rename\b.{1,180}?(?:\bto\b|\bas\b|->|→)/iu
  const explicitEnglishChangeName = /\bchange\s+(?:the\s+)?(?:name|identifier)\b.{1,180}?(?:\bto\b|\bas\b|->|→)/iu
  const explicitRussianRename = /(?:^|[.!?]\s*)(?:пожалуйста[,\s]+)?переимен(?:уй|уйте)(?=\s|$|[,:;.!?]).{1,180}?(?:\sв\s|\sна\s|->|→)/iu

  if (explicitEnglishRename.test(value) || explicitEnglishChangeName.test(value) || explicitRussianRename.test(value)) {
    return { protocol:MUTATION_INTENT_PROTOCOL, kind:"rename_symbol", reason:"explicit_rename_with_destination" }
  }

  const lower = value.toLowerCase()
  const negativeRename =
    /\b(?:do\s+not|don't|never|avoid)\b.{0,80}\brenam(?:e|ing)\b/iu.test(lower) ||
    /\bwithout\b.{0,80}\brenam(?:e|ing)\b/iu.test(lower) ||
    /(?:^|\s)(?:не|без)\s+переимен/iu.test(lower)
  const incompleteImperativeRename =
    /(?:^|[.!?]\s*)(?:please\s+)?rename\b/iu.test(value) ||
    /(?:^|[.!?]\s*)(?:пожалуйста[,\s]+)?переимен(?:уй|уйте)(?=\s|$|[,:;.!?])/iu.test(value) ||
    /\bchange\s+(?:the\s+)?(?:name|identifier)\b/iu.test(value)

  if (incompleteImperativeRename && !negativeRename) {
    return { protocol:MUTATION_INTENT_PROTOCOL, kind:"unknown", reason:"rename_intent_incomplete" }
  }
  return {
    protocol:MUTATION_INTENT_PROTOCOL,
    kind:"generic_edit",
    reason: negativeRename ? "non_rename_task_with_negative_rename_constraint" : "generic_edit_task",
  }
}


function userTurnSnapshotFromContext(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : []
  let userOrdinal = 0
  let lastUser = null
  for (const message of messages) {
    if (!taskContextIsUserMessage(message)) continue
    userOrdinal += 1
    lastUser = message
  }
  if (!lastUser) {
    return { protocol:TASK_CONTEXT_PROTOCOL, adapter_protocol:TASK_CONTEXT_ADAPTER_PROTOCOL, ok:false, turnID:null, reason:"user_message_missing", text:"", textSha256:null, textBytes:0, sources:[], shape:null }
  }
  const id =
    (typeof lastUser.id === "string" && lastUser.id) ||
    (typeof lastUser.messageID === "string" && lastUser.messageID) ||
    (typeof lastUser.metadata?.messageID === "string" && lastUser.metadata.messageID) ||
    null
  const turnID = id ? `user:${id}` : `user-ordinal:${userOrdinal}`
  const extracted = extractUserMessageText(lastUser)
  return {
    protocol:TASK_CONTEXT_PROTOCOL,
    adapter_protocol:TASK_CONTEXT_ADAPTER_PROTOCOL,
    ok: extracted.ok === true,
    turnID,
    reason: extracted.reason,
    text: extracted.ok === true ? extracted.text : "",
    textSha256: extracted.ok === true ? createHash("sha256").update(extracted.text).digest("hex") : null,
    textBytes: extracted.textBytes,
    sources: extracted.sources,
    shape: extracted.shape,
  }
}

function latchTaskContextForTurn(state, snapshot) {
  if (!state) return { ok:false, reason:"state_unavailable" }

  if (state.taskContextLatched === true && state.taskTurnID === state.turnID) {
    if (
      snapshot?.turnID === state.taskTurnID &&
      snapshot?.ok === true &&
      typeof state.taskTextSha256 === "string" &&
      snapshot.textSha256 !== state.taskTextSha256
    ) {
      state.taskContextDrift = true
      state.taskContextReason = "task_text_drift_same_turn"
      state.taskAction = unresolvedTaskAction(
        "task_text_drift_same_turn",
        state.taskTextSha256,
      )
      state.taskRequirements = unresolvedTaskRequirements(
        "task_text_drift_same_turn",
        state.taskTextSha256,
      )
      state.taskAnchors = null
      state.taskShape = null
      state.additiveLocalizationPlan = null
      state.taskRoleEvidence = []
      state.mutationIntent = "unknown"
      state.mutationIntentReason = "task_text_drift_same_turn"
      return { ok:false, reason:"task_text_drift_same_turn", drift:true }
    }
    return { ok:true, reason:"task_context_already_latched", drift:state.taskContextDrift === true }
  }

  state.taskContextProtocol = TASK_CONTEXT_PROTOCOL
  state.taskContextAdapterProtocol = TASK_CONTEXT_ADAPTER_PROTOCOL
  state.taskContextLatched = true
  state.taskTurnID = state.turnID
  state.taskTextSha256 = null
  state.taskTextBytes = snapshot?.textBytes ?? 0
  state.taskTextSources = Array.isArray(snapshot?.sources) ? snapshot.sources.slice(0, TASK_CONTEXT_MAX_REPORTED_SOURCES) : []
  state.taskContextShape = snapshot?.shape ?? null
  state.taskContextDrift = false

  if (snapshot?.turnID && state.turnID && snapshot.turnID !== state.turnID) {
    state.taskContextReason = "task_turn_mismatch"
    state.taskAction = unresolvedTaskAction("task_turn_mismatch")
    state.taskRequirements =
      unresolvedTaskRequirements("task_turn_mismatch")
    state.taskAnchors = null
    state.taskShape = null
    state.additiveLocalizationPlan = null
    state.taskRoleEvidence = []
    state.mutationIntent = "unknown"
    state.mutationIntentReason = "task_turn_mismatch"
    return { ok:false, reason:"task_turn_mismatch" }
  }

  if (snapshot?.ok !== true) {
    state.taskContextReason = snapshot?.reason ?? "user_task_text_unavailable"
    state.taskAction = unresolvedTaskAction(state.taskContextReason)
    state.taskRequirements =
      unresolvedTaskRequirements(state.taskContextReason)
    state.taskAnchors = null
    state.taskShape = null
    state.additiveLocalizationPlan = null
    state.taskRoleEvidence = []
    state.mutationIntent = "unknown"
    state.mutationIntentReason = state.taskContextReason
    return { ok:false, reason:state.taskContextReason }
  }

  const intent = classifyMutationIntent(snapshot.text)
  const taskAction = compileTaskAction(snapshot.text, snapshot.textSha256)
  const taskRequirements =
    compileTaskRequirements(snapshot.text, snapshot.textSha256)
  const taskAnchors =
    compileTaskAnchors(snapshot.text, snapshot.textSha256)
  const taskShape =
    compileTaskShape(
      snapshot.text,
      snapshot.textSha256,
    )

  const additiveLocalizationPlan =
    planAdditiveLocalization({
      taskRequirements,

      taskKind:
        taskShape?.status === "compiled"
          ? taskShape.shape
          : null,
    })
  state.taskTextSha256 = snapshot.textSha256
  state.taskTextBytes = snapshot.textBytes
  state.taskContextReason = snapshot.reason
  state.taskAction = taskAction
  state.taskRequirements = taskRequirements
  state.taskAnchors = taskAnchors
  state.taskShape = taskShape
  state.additiveLocalizationPlan = additiveLocalizationPlan
  state.taskRoleEvidence = []

  if (
    taskAction.status === "exact" &&
    taskAction.operation !== intent.kind
  ) {
    state.taskAction = unresolvedTaskAction(
      "task_action_intent_mismatch",
      snapshot.textSha256,
    )
    state.mutationIntent = "unknown"
    state.mutationIntentReason = "task_action_intent_mismatch"
    return {
      ok: false,
      reason: "task_action_intent_mismatch",
      intent: "unknown",
    }
  }

  state.mutationIntent = intent.kind
  state.mutationIntentReason = intent.reason
  return {
    ok: intent.kind !== "unknown",
    reason: intent.reason,
    intent: intent.kind,
    task_action_status: state.taskAction.status,
  }
}
function turnIDFromContext(event) {
  return userTurnSnapshotFromContext(event).turnID
}

function usageFromTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null

  const hasAny =
    Number.isFinite(tokens.input) ||
    Number.isFinite(tokens.output) ||
    Number.isFinite(tokens.reasoning) ||
    Number.isFinite(tokens.cache?.read) ||
    Number.isFinite(tokens.cache?.write)

  if (!hasAny) return null

  return {
    input_tokens: Number.isFinite(tokens.input) ? tokens.input : null,
    output_tokens: Number.isFinite(tokens.output) ? tokens.output : null,
    reasoning_tokens: Number.isFinite(tokens.reasoning) ? tokens.reasoning : null,
    cache_read_tokens: Number.isFinite(tokens.cache?.read) ? tokens.cache.read : null,
    cache_write_tokens: Number.isFinite(tokens.cache?.write) ? tokens.cache.write : null,
  }
}

async function recordModelUsage(ctx, state, sessionID, root, data) {
  const messageID = typeof data?.messageID === "string" ? data.messageID : null
  if (!messageID) return
  if (state.seenUsageMessages.has(messageID)) return

  const usage = usageFromTokens(data?.tokens)
  if (!usage) return

  state.seenUsageMessages.add(messageID)

  await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
    ts: nowMs(),
    protocol: AGENT_PROTOCOL,
    kind: "model_usage",
    source: data.source ?? null,
    sessionID,
    turnID: state.turnID,
    messageID,
    parentID: data.parentID ?? null,
    providerID: data.providerID ?? null,
    modelID: data.modelID ?? null,
    finish: data.finish ?? null,
    reason: data.reason ?? null,
    error: data.error ?? null,
    ...usage,
    model_calls_started: state.modelCalls,
    turn_elapsed_ms: state.turnStartedAt
      ? Math.max(0, nowMs() - state.turnStartedAt)
      : null,
  })
}

async function subscribeEvents(ctx) {
  let source
  try {
    // The public OpenCode event API is async and returns an object whose
    // `.stream` is the async iterable. Promise.resolve also tolerates builds
    // where subscribe() already returns the stream synchronously.
    source = await Promise.resolve(ctx.event.subscribe())
  } catch {
    return async () => {}
  }

  const stream = source?.stream ?? source?.events ?? source
  const iterator = stream?.[Symbol.asyncIterator]?.()
  if (!iterator) return async () => {}

  let stopped = false

  void (async () => {
    while (!stopped) {
      const next = await iterator.next()
      if (next.done) break

      // OpenCode SDK/server versions have used both the direct event shape
      // and an SSE envelope { payload: { type, properties }, ... }.
      const event = normalizePublicEvent(next.value)
      const sessionID = normalizeSessionID(event)
      if (!sessionID) continue

      if (event?.type === "session.deleted") {
        dropSessionState(sessionID)
        continue
      }

      const state = getSessionState(sessionID)
      if (!state) continue

      const root = await rootFromSession(ctx, sessionID, state)
      if (!root) continue

      try {
        await observePublicEventTelemetry({
          root,
          event,
          sessionID,
          turnID: state.turnID,
        })
      } catch {
        // Observation only. Public event telemetry must not affect execution.
      }

      // Primary usage source in beta-17728: a step-finish message part.
      // Also accept the flattened CLI/public event shape observed under
      // `opencode2 run --format json` so telemetry survives API drift.
      if (
        event?.type === "message.part.updated" ||
        event?.type === "step_finish" ||
        event?.type === "step-finish"
      ) {
        const part = event?.properties?.part ?? event?.part

        if (part?.type === "step-finish" || event?.type !== "message.part.updated") {
          await recordModelUsage(ctx, state, sessionID, root, {
            source: "step_finish",
            messageID: part?.messageID,
            reason: part?.reason ?? null,
            tokens: part?.tokens,
          })
        }
      }

      if (event?.type !== "message.updated") continue

      const info = event?.properties?.info
      if (!info || typeof info !== "object") continue

      // This is telemetry only. Turn correctness is derived synchronously
      // from session.hook("context"), so delayed SSE cannot reset budgets.
      if (info.role === "user" && typeof info.id === "string") {
        const turnID = `user:${info.id}`
        if (state.turnID === turnID) continue

        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "turn_observed",
          sessionID,
          turnID,
          active_turnID: state.turnID,
          project_root: root,
        })

        continue
      }

      const assistantDone =
        info.role === "assistant" &&
        typeof info.id === "string" &&
        (
          Number.isFinite(info.time?.completed) ||
          typeof info.finish === "string" ||
          info.error != null
        )

      if (assistantDone) {
        const completionObservedAtMs = nowMs()
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: completionObservedAtMs,
          protocol: AGENT_PROTOCOL,
          cost_observation_protocol: RUNTIME_COST_OBSERVATION_PROTOCOL,
          kind: "model_completion",
          sessionID,
          turnID: state.turnID,
          model_call: state.modelCalls,
          project_root: root,
          observed_at_ms: completionObservedAtMs,
          message_created_at_ms:
            Number.isFinite(info.time?.created) ? info.time.created : null,
          message_completed_at_ms:
            Number.isFinite(info.time?.completed) ? info.time.completed : null,
          messageID: info.id,
          parentID: info.parentID ?? null,
          providerID: info.providerID ?? null,
          modelID: info.modelID ?? null,
          finish: info.finish ?? null,
          error: info.error?.name ?? null,
          mutation_authority: false,
          scheduling_authority: false,
        })

        await recordModelUsage(ctx, state, sessionID, root, {
          source: "message_updated",
          messageID: info.id,
          parentID: info.parentID ?? null,
          providerID: info.providerID ?? null,
          modelID: info.modelID ?? null,
          finish: info.finish ?? null,
          error: info.error?.name ?? null,
          tokens: info.tokens,
        })
      }
    }
  })().catch(() => {
    // Event telemetry is best-effort. Model/search correctness must not depend
    // on the public event stream.
  })

  return async () => {
    stopped = true
    try {
      await iterator.return?.()
    } catch {
      // Best effort.
    }
  }
}
