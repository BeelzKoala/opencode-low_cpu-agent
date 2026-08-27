

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
