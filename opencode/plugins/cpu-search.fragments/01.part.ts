
async function attestLocalMutationCandidateSet(
  root,
  sessionID,
  state,
  scoutHandoff,
  editCapsule,
  competitorCheck,
) {
  const candidates =
    Array.isArray(editCapsule?.mutationCandidates)
      ? editCapsule.mutationCandidates
      : []

  const initial = editCapsule?.authorizedMutationScope ?? null
  const globalReady = scoutHandoff?.status === "ready"

  const eligibleCandidates =
    globalReady
      ? candidates
      : candidates.filter((candidate) =>
          sameAuthorizedScopeIdentity(candidate, initial),
        )

  const preauthorized = []
  const rejected = []

  for (const candidate of eligibleCandidates) {
    const capability = await attestLocalMutationCapability(
      root,
      sessionID,
      state,
      scoutHandoff,
      editCapsule,
      competitorCheck,
      candidate,
    )

    if (capability?.ok === true) {
      preauthorized.push({
        target: capability.target,
        capability,
      })
    } else {
      rejected.push({
        target: mutationCandidateIdentity(candidate),
        reason: capability?.reason ?? "candidate_attestation_failed",
        detail: capability?.detail ?? null,
      })
    }
  }

  const primary =
    preauthorized.find((entry) =>
      sameAuthorizedScopeIdentity(entry.target, initial),
    )?.capability ?? null

  return {
    ok: primary?.ok === true && preauthorized.length > 0,
    protocol: MUTATION_CANDIDATE_SET_PROTOCOL,
    primary,
    candidates: preauthorized,
    rejected,
  }
}

const sessionStates = new Map()

function dropSessionState(sessionID) {
  sessionStates.delete(sessionID)
}

function evictOldestSession() {
  let oldestID = null
  let oldestSeen = Infinity

  for (const [sessionID, state] of sessionStates) {
    if (state.lastSeen < oldestSeen) {
      oldestSeen = state.lastSeen
      oldestID = sessionID
    }
  }

  if (oldestID !== null) sessionStates.delete(oldestID)
}

function pruneSessionStates(now = nowMs()) {
  for (const [sessionID, state] of sessionStates) {
    if (now - state.lastSeen > SESSION_TTL_MS) sessionStates.delete(sessionID)
  }
}

function getSessionState(sessionID) {
  if (!sessionID) return null

  const now = nowMs()
  pruneSessionStates(now)

  let state = sessionStates.get(sessionID)

  if (!state) {
    while (sessionStates.size >= MAX_TRACKED_SESSIONS) evictOldestSession()

    state = {
      root: null,
      turnID: null,
      turnStartedAt: 0,
      modelCalls: 0,
      searchAttempts: 0,
      executedSearches: 0,
      evidenceBytes: 0,
      signatures: new Set(),
      queryCache: new Map(),
      sourceInventoryCache: new Map(),
      evidenceLedger: new Set(),
      routeLedger: new Set(),
      contextualizedHitLines: new Set(),
      consecutiveNoProgress: 0,
      ledgerSaturated: false,
      queryCacheMatches: 0,
      seenUsageMessages: new Set(),
      scoutSearches: [],
      scoutFiles: new Map(),
      scoutHandoffPath: null,
      localMutationHandoffPath: null,
      localMutationCapability: null,
      localMutationCandidates: [],
      renameMutationCapability: null,
      activeMutationHandoffPath: null,
      boundMutationTarget: null,
      mutationAttempts: 0,
      repairAttempts: 0,
      compilerRuns: 0,
      patchAttempts: 0,
      executorRuns: 0,
      executedPatches: 0,
      patchSignatures: new Set(),
      contractFailureSignatures: new Set(),
      contractFailures: 0,
      activeMutationTool: null,
      taskContextProtocol: TASK_CONTEXT_PROTOCOL,
      taskContextAdapterProtocol: TASK_CONTEXT_ADAPTER_PROTOCOL,
      taskContextLatched: false,
      taskTurnID: null,
      taskTextSha256: null,
      taskTextBytes: 0,
      taskTextSources: [],
      taskContextShape: null,
      taskContextReason: "unresolved",
      taskContextDrift: false,
      taskAction: null,
      mutationIntent: "unknown",
      mutationIntentReason: "unresolved",
      visibleToolSchemaSha256: null,
      patchAccepted: false,
      patchReceiptPath: null,
      executionState: EXEC_STATE_LOCATE,
      executionReason: "session_start",
      executionEvent: "session_start",
      editCapsulePath: null,
      editCapsuleHash: null,
      proofObligations: [],
      pendingRescout: null,
      lastSeen: now,
    }

    sessionStates.set(sessionID, state)
  }

  state.lastSeen = now
  return state
}

function resetTurnState(state, turnID, startedAt = nowMs()) {
  state.turnID = turnID
  state.turnStartedAt = startedAt
  state.modelCalls = 0
  state.searchAttempts = 0
  state.executedSearches = 0
  state.evidenceBytes = 0
  state.signatures.clear()
  state.queryCache.clear()
  state.sourceInventoryCache.clear()
  state.evidenceLedger.clear()
  state.routeLedger.clear()
  state.contextualizedHitLines.clear()
  state.consecutiveNoProgress = 0
  state.ledgerSaturated = false
  state.queryCacheMatches = 0
  state.seenUsageMessages.clear()
  state.scoutSearches = []
  state.scoutFiles = new Map()
  state.scoutHandoffPath = null
  state.localMutationHandoffPath = null
  state.localMutationCapability = null
  state.localMutationCandidates = []
  state.renameMutationCapability = null
  state.activeMutationHandoffPath = null
  state.boundMutationTarget = null
  state.mutationAttempts = 0
  state.repairAttempts = 0
  state.compilerRuns = 0
  state.patchAttempts = 0
  state.executorRuns = 0
  state.executedPatches = 0
  state.patchSignatures.clear()
  state.contractFailureSignatures.clear()
  state.contractFailures = 0
  state.activeMutationTool = null
  state.taskContextProtocol = TASK_CONTEXT_PROTOCOL
  state.taskContextAdapterProtocol = TASK_CONTEXT_ADAPTER_PROTOCOL
  state.taskContextLatched = false
  state.taskTurnID = null
  state.taskTextSha256 = null
  state.taskTextBytes = 0
  state.taskTextSources = []
  state.taskContextShape = null
  state.taskContextReason = "unresolved"
  state.taskContextDrift = false
  state.taskAction = null
  state.mutationIntent = "unknown"
  state.mutationIntentReason = "unresolved"
  state.visibleToolSchemaSha256 = null
  state.patchAccepted = false
  state.patchReceiptPath = null
  state.executionState = EXEC_STATE_LOCATE
  state.executionReason = "turn_start"
  state.executionEvent = "turn_start"
  state.editCapsulePath = null
  state.editCapsuleHash = null
  state.proofObligations = []
  state.pendingRescout = null
  state.lastSeen = nowMs()
}

function transitionExecutionState(current, event) {
  if (event === "turn_start") return EXEC_STATE_LOCATE
  if (event === "scout_ready") return EXEC_STATE_MUTATE
  if (event === "scout_needs_evidence") return EXEC_STATE_LOCATE
  if (event === "patch_retry") return EXEC_STATE_REPAIR
  if (event === "patch_rescout") return EXEC_STATE_LOCATE
  if (event === "patch_ready") return EXEC_STATE_DONE
  if (event === "verification_repair") return EXEC_STATE_REPAIR
  if (event === "verification_rescout") return EXEC_STATE_LOCATE
  if (event === "fatal") return EXEC_STATE_SAFE_FAIL
  return current
}

function allowedToolsForExecutionState(executionState) {
  if (executionState === EXEC_STATE_LOCATE) return ["search"]
  if (executionState === EXEC_STATE_MUTATE || executionState === EXEC_STATE_REPAIR) {
    return [...MUTATION_TOOL_NAMES]
  }
  return []
}

function resolveMutationActionForState(state) {
  if (
    state?.executionState !== EXEC_STATE_MUTATE &&
    state?.executionState !== EXEC_STATE_REPAIR
  ) {
    return { tool: null, reason: "not_mutation_state" }
  }

  const capability = state?.localMutationCapability ?? null
  const replaceReady =
    capability?.replaceNodeReady === true &&
    Array.isArray(state?.localMutationCandidates) &&
    state.localMutationCandidates.length > 0

  const renameCapability = state?.renameMutationCapability ?? null
  const renameReady =
    renameCapability?.protocol === SCOUT_RENAME_TARGET_PROTOCOL &&
    renameCapability?.ready === true &&
    renameCapability?.globalReady === true &&
    renameCapability?.operation === "rename_symbol" &&
    renameCapability?.sourceHandoffPath === state?.scoutHandoffPath &&
    typeof state?.scoutHandoffPath === "string" &&
    state.scoutHandoffPath.length > 0

  if (
    state.executionState === EXEC_STATE_REPAIR &&
    typeof state.activeMutationTool === "string"
  ) {
    if (state.activeMutationTool === EXECUTE_RENAME_SYMBOL_TOOL && renameReady) {
      return { tool: EXECUTE_RENAME_SYMBOL_TOOL, reason: "repair_sticky_rename" }
    }
    if (state.activeMutationTool === EXECUTE_REPLACE_NODE_TOOL && replaceReady) {
      return { tool: EXECUTE_REPLACE_NODE_TOOL, reason: "repair_sticky_replace" }
    }
    return { tool: null, reason: "repair_capability_unavailable" }
  }

  if (state?.mutationIntent === "rename_symbol") {
    return renameReady
      ? { tool: EXECUTE_RENAME_SYMBOL_TOOL, reason: "rename_intent_authorized" }
      : { tool: null, reason: "rename_capability_unavailable" }
  }

  if (state?.mutationIntent === "generic_edit") {
    return replaceReady
      ? { tool: EXECUTE_REPLACE_NODE_TOOL, reason: "generic_edit_authorized" }
      : { tool: null, reason: "replace_capability_unavailable" }
  }

  return { tool: null, reason: "mutation_intent_unknown" }
}

function mutationToolsForState(state) {
  const resolution = resolveMutationActionForState(state)
  return resolution.tool ? [resolution.tool] : []
}

function compileTaskSearchPlanForState(
  state,
  requestedQueries,
  requestedPath = ".",
  requestedGlob = undefined,
) {
  const requested = [
    ...new Set(
      (Array.isArray(requestedQueries) ? requestedQueries : [])
        .filter((query) => typeof query === "string" && query.length > 0),
    ),
  ]
  const fallback = {
    protocol: TASK_SEARCH_PLAN_PROTOCOL,
    applied: false,
    reason: "model_search_plan",
    task_sha256: state?.taskTextSha256 ?? null,
    requested_queries: requested,
    effective_queries: requested,
    requested_path:
      typeof requestedPath === "string" && requestedPath.length > 0
        ? requestedPath
        : ".",
    effective_path:
      typeof requestedPath === "string" && requestedPath.length > 0
        ? requestedPath
        : ".",
    requested_glob:
      typeof requestedGlob === "string" && requestedGlob.length > 0
        ? requestedGlob
        : null,
    effective_glob:
      typeof requestedGlob === "string" && requestedGlob.length > 0
        ? requestedGlob
        : null,
  }

  const action = state?.taskAction ?? null
  const oldName = taskActionIdentifier(action?.old_name)
  const newName = taskActionIdentifier(action?.new_name)
  const exactRename =
    state?.executionState === EXEC_STATE_LOCATE &&
    state?.mutationIntent === "rename_symbol" &&
    action?.protocol === TASK_ACTION_PROTOCOL &&
    action?.status === "exact" &&
    action?.operation === "rename_symbol" &&
    typeof action?.task_sha256 === "string" &&
    action.task_sha256 === state?.taskTextSha256 &&
    oldName !== null &&
    newName !== null &&
    oldName !== newName

  if (!exactRename) return fallback

  const globalSourceGlob = buildLanguageGlob(
    "**/*",
    SOURCE_LANGUAGE_EXTENSIONS,
  )
  if (!globalSourceGlob) {
    return {
      ...fallback,
      reason: "exact_rename_source_glob_unavailable",
    }
  }

  return {
    protocol: TASK_SEARCH_PLAN_PROTOCOL,
    applied: true,
    reason: "exact_global_rename_identifier",
    task_sha256: action.task_sha256,
    requested_queries: requested,
    effective_queries: [oldName],
    requested_path: fallback.requested_path,
    effective_path: ".",
    requested_glob: fallback.requested_glob,
    effective_glob: globalSourceGlob,
  }
}

function allowedToolsForState(state) {
  if (!state) return []
  if (state.executionState === EXEC_STATE_LOCATE) return ["search"]
  if (
    state.executionState === EXEC_STATE_MUTATE ||
    state.executionState === EXEC_STATE_REPAIR
  ) {
    return mutationToolsForState(state)
  }
  return []
}

function applyExecutionEvent(state, event, reason, details = null) {
  if (!state) return null
  const next = transitionExecutionState(state.executionState, event)
  state.executionState = next
  state.executionReason = reason ?? event
  state.executionEvent = event
  if (event !== "patch_rescout" && event !== "verification_rescout") {
    state.pendingRescout = null
  } else {
    state.pendingRescout = details ?? { reason: reason ?? event }
    state.activeMutationTool = null
  }
  state.lastSeen = nowMs()
  return next
}

function toolAllowedForExecutionState(state, toolName) {
  if (!state) return false
  return allowedToolsForState(state).includes(toolName)
}

function nextActionForExecutionState(state) {
  const tools = allowedToolsForState(state)
  return tools[0] ?? "report_result"
}

function normalizeSessionID(event) {
  if (
    typeof event?.type === "string" &&
    event.type.startsWith("session.") &&
    typeof event?.properties?.info?.id === "string"
  ) {
    return event.properties.info.id
  }

  return (
    event?.sessionID ??
    event?.properties?.sessionID ??
    event?.properties?.info?.sessionID ??
    event?.properties?.part?.sessionID ??
    event?.part?.sessionID ??
    null
  )
}

async function rootFromSession(ctx, sessionID, state = null) {
  if (state?.root) return state.root
  if (!sessionID) return null

  try {
    const info = await ctx.session.get({ sessionID })
    const root = await normalizeDirectory(info?.location?.directory)
    if (root && state) state.root = root
    return root
  } catch {
    return null
  }
}

async function rootForTool(ctx, toolContext, sessionID, state) {
  const direct =
    (await normalizeDirectory(toolContext?.directory)) ??
    (await normalizeDirectory(toolContext?.worktree))

  if (direct) {
    if (state) state.root = direct
    return direct
  }

  return await rootFromSession(ctx, sessionID, state)
}

function searchSignature(queries, target, glob) {
  return JSON.stringify({
    queries: [...queries].sort(),
    path: target,
    glob: glob ?? null,
  })
}

function queryCacheKey(root, query, target, glob, files = null) {
  return JSON.stringify({
    root,
    query,
    path: target,
    glob: glob ?? null,
    files: Array.isArray(files) ? [...files].sort() : null,
  })
}

function reindexQueryResult(result, queryIndex, reused = false) {
  return {
    ...result,
    queryIndex,
    reused,
    matches: Array.isArray(result?.matches)
      ? result.matches.map((match) => ({
          ...match,
          queryIndex,
          exactSpans: Array.isArray(match?.exactSpans)
            ? match.exactSpans.map((span) => ({
                ...span,
                queryIndex,
              }))
            : [],
        }))
      : [],
  }
}

function cacheableQueryResult(result) {
  return (
    result &&
    !result.timedOut &&
    !result.error &&
    (result.scanComplete || result.scanCapped) &&
    Array.isArray(result.matches)
  )
}

function rememberQueryResult(state, key, result) {
  if (!state || !cacheableQueryResult(result)) return false
  if (state.queryCache.has(key)) return true
  if (state.queryCache.size >= QUERY_CACHE_MAX_ENTRIES_PER_TURN) return false

  const matchCount = result.matches.length
  if (
    state.queryCacheMatches + matchCount >
    QUERY_CACHE_MAX_MATCHES_PER_TURN
  ) {
    return false
  }

  state.queryCache.set(key, reindexQueryResult(result, 0, false))
  state.queryCacheMatches += matchCount
  return true
}


function evidenceFileKey(file) {
  const normalized = path.posix.normalize(
    String(file ?? "").replace(/\\/g, "/"),
  )

  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

function evidenceFact(kind, parts) {
  return `${kind}\0${JSON.stringify(parts)}`
}

function sourceLineFact(file, line) {
  return evidenceFact("line", [evidenceFileKey(file), line])
}

function hitLineFact(file, line) {
  return evidenceFact("hit", [evidenceFileKey(file), line])
}

function exactSpanFact(file, startByte, endByte) {
  return evidenceFact("span", [evidenceFileKey(file), startByte, endByte])
}

function scopeFact(scope) {
  return evidenceFact("scope", [
    evidenceFileKey(scope?.file),
    scope?.start,
    scope?.end,
    scope?.symbolKind,
    scope?.symbolName,
  ])
}

function groupFact(group) {
  return evidenceFact("group", [
    evidenceFileKey(group?.file),
    group?.start_line,
    group?.end_line,
    group?.symbol_kind,
    group?.symbol_name,
    group?.role,
    group?.anchor,
    group?.match_text,
  ])
}

function witnessFact(group, variant) {
  return evidenceFact("witness", [
    evidenceFileKey(group?.file),
    group?.start_line,
    group?.end_line,
    group?.symbol_kind,
    group?.symbol_name,
    group?.role,
    group?.anchor,
    variant?.subject_text,
    variant?.statement_text,
    integerList(variant?.hit_lines) ?? [],
  ])
}

function negativeQueryFact(result, target, glob) {
  return evidenceFact("negative", [
    result?.query,
    target,
    glob ?? null,
  ])
}

function indexSummaryFact(result, fileCount, exactMatches) {
  return evidenceFact("index_summary", [
    result?.scanComplete === true,
    result?.scanCapped === true,
    fileCount,
    result?.matches?.length ?? 0,
    exactMatches,
  ])
}

function indexFileFact(entry) {
  return evidenceFact("index_file", [
    evidenceFileKey(entry?.file),
    entry?.lineHits,
    entry?.exactMatches,
    entry?.firstLine ?? null,
    entry?.sample ?? null,
  ])
}

function indexFacetFact(kind, entry) {
  return evidenceFact("index_facet", [
    kind,
    entry?.text ?? null,
    entry?.exactMatches ?? 0,
    entry?.files?.size ?? 0,
    evidenceFileKey(entry?.firstFile),
    entry?.firstLine ?? null,
  ])
}

function routeCandidateFact(entry, selected, target, glob) {
  return evidenceFact("route_candidate", [
    evidenceFileKey(entry?.file),
    [...(entry?.queries ?? [])].sort((a, b) => a - b),
    selected === true,
    target,
    glob ?? null,
  ])
}

function routeSummaryFact(discoveryComplete, candidateCount, selectedCount) {
  return evidenceFact("route_summary", [
    discoveryComplete === true,
    candidateCount,
    selectedCount,
  ])
}

function routeFactsForRanking(
  rankedFiles,
  selectedFileSet,
  discoveryComplete,
  target,
  glob,
) {
  const facts = new Set([
    routeSummaryFact(
      discoveryComplete,
      rankedFiles?.length ?? 0,
      selectedFileSet?.size ?? 0,
    ),
  ])

  for (const entry of rankedFiles ?? []) {
    if (!(selectedFileSet instanceof Set) || !selectedFileSet.has(entry.file)) {
      continue
    }

    facts.add(
      routeCandidateFact(
        entry,
        true,
        target,
        glob,
      ),
    )
  }

  return facts
}

function contextualizedHitLineKey(file, line) {
  return `${evidenceFileKey(file)}\0${line}`
}

function positiveFactsForHit(hit) {
  const facts = new Set()

  if (typeof hit?.file !== "string" || !Number.isInteger(hit?.line)) {
    return facts
  }

  facts.add(hitLineFact(hit.file, hit.line))

  for (const span of hit.exactSpans ?? []) {
    if (
      Number.isSafeInteger(span?.startByte) &&
      Number.isSafeInteger(span?.endByte) &&
      span.startByte >= 0 &&
      span.endByte > span.startByte
    ) {
      facts.add(exactSpanFact(hit.file, span.startByte, span.endByte))
    }
  }

  return facts
}

function positiveFactsForHits(hits) {
  const facts = new Set()

  for (const hit of hits?.values?.() ?? []) {
    for (const fact of positiveFactsForHit(hit)) facts.add(fact)
  }

  return facts
}

function negativeFactsForResults(results, target, glob) {
  const facts = new Set()

  for (const result of results ?? []) {
    if (
      result?.scanComplete === true &&
      !result?.error &&
      !result?.timedOut &&
      Array.isArray(result?.matches) &&
      result.matches.length === 0
    ) {
      facts.add(negativeQueryFact(result, target, glob))
    }
  }

  return facts
}

function negativeFactsForDiscoveryResults(results, target, glob) {
  const facts = new Set()

  for (const result of results ?? []) {
    if (
      result?.scanComplete === true &&
      !result?.error &&
      !result?.timedOut &&
      Array.isArray(result?.files) &&
      result.files.length === 0
    ) {
      facts.add(negativeQueryFact(result, target, glob))
    }
  }

  return facts
}

function factSeen(seenFacts, fact) {
  return seenFacts instanceof Set && seenFacts.has(fact)
}

function hitHasNovelPositiveFact(hit, seenFacts) {
  for (const fact of positiveFactsForHit(hit)) {
    if (!factSeen(seenFacts, fact)) return true
  }

  return false
}

function hitFactsAlreadySeen(hit, seenFacts) {
  const facts = positiveFactsForHit(hit)
  if (facts.size < 1) return false

  for (const fact of facts) {
    if (!factSeen(seenFacts, fact)) return false
  }

  return true
}

function countHitsAlreadySeen(hits, seenFacts) {
  let count = 0

  for (const hit of hits?.values?.() ?? []) {
    if (hitFactsAlreadySeen(hit, seenFacts)) count += 1
  }

  return count
}

function novelEvidenceFacts(state, facts) {
  const novel = new Set()
  let prior = 0

  for (const fact of facts ?? []) {
    if (state?.evidenceLedger?.has(fact)) prior += 1
    else novel.add(fact)
  }

  return { novel, prior }
}

function novelRouteFacts(state, facts) {
  const novel = new Set()
  let prior = 0

  for (const fact of facts ?? []) {
    if (state?.routeLedger?.has(fact)) prior += 1
    else novel.add(fact)
  }

  return { novel, prior }
}

function rememberEvidenceFacts(state, facts) {
  if (!state?.evidenceLedger) return { added: 0, saturated: false }

  let added = 0

  for (const fact of facts ?? []) {
    if (state.evidenceLedger.has(fact)) continue

    if (state.evidenceLedger.size >= EVIDENCE_LEDGER_MAX_FACTS_PER_TURN) {
      state.ledgerSaturated = true
      return { added, saturated: true }
    }

    state.evidenceLedger.add(fact)
    added += 1
  }

  return {
    added,
    saturated: state.ledgerSaturated === true,
  }
}

function rememberRouteFacts(state, facts) {
  if (!state?.routeLedger) return { added: 0, saturated: false }

  let added = 0

  for (const fact of facts ?? []) {
    if (state.routeLedger.has(fact)) continue
    if (state.routeLedger.size >= ROUTE_LEDGER_MAX_FACTS_PER_TURN) {
      return { added, saturated: true }
    }

    state.routeLedger.add(fact)
    added += 1
  }

  return { added, saturated: false }
}

function rememberContextualizedHitLines(state, keys) {
  if (!state?.contextualizedHitLines) return

  for (const key of keys ?? []) {
    if (state.contextualizedHitLines.size >= CONTEXTUALIZED_HITS_MAX_PER_TURN) {
      return
    }

    state.contextualizedHitLines.add(key)
  }
}

function evidenceFactKind(fact) {
  if (typeof fact !== "string") return "other"
  const pos = fact.indexOf("\0")
  return pos >= 0 ? fact.slice(0, pos) : fact
}

function summarizeEvidenceFacts(facts) {
  const result = {
    positive: 0,
    context: 0,
    negative: 0,
    structural: 0,
    routing: 0,
    other: 0,
  }

  for (const fact of facts ?? []) {
    const kind = evidenceFactKind(fact)

    if (kind === "hit" || kind === "span") result.positive += 1
    else if (kind === "line") result.context += 1
    else if (kind === "negative") result.negative += 1
    else if (kind === "scope" || kind === "group" || kind === "witness") {
      result.structural += 1
    } else if (kind === "index_summary" || kind === "index_file") {
      result.routing += 1
    } else {
      result.other += 1
    }
  }

  return result
}

async function safeTarget(root, raw = ".") {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("path must be a non-empty relative path")
  }

  if (path.isAbsolute(raw)) {
    const resolvedAbsolute = await realpath(raw)

    if (resolvedAbsolute === root) {
      return "."
    }

    throw new Error("absolute paths are disabled")
  }

  const candidate = path.resolve(root, raw)
  const resolved = await realpath(candidate)

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("path escapes project root")
  }

  return path.relative(root, resolved) || "."
}

function exactSpansFromRgMatch(data, queryIndex) {
  const absoluteOffset = data?.absolute_offset
  const submatches = data?.submatches
  const lineText = data?.lines?.text

  if (
    !Number.isSafeInteger(absoluteOffset) ||
    absoluteOffset < 0 ||
    !Array.isArray(submatches) ||
    typeof lineText !== "string"
  ) {
    return []
  }

  // ripgrep JSON offsets are byte offsets. submatch start/end are relative to
  // data.lines, while absolute_offset is the byte offset of that data block
  // in the searched file. Keep these as bytes all the way into Rust.
  const lineBytes = bytes(lineText)
  const spans = []

  for (const submatch of submatches) {
    const start = submatch?.start
    const end = submatch?.end

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > lineBytes
    ) {
      continue
    }

    const startByte = absoluteOffset + start
    const endByte = absoluteOffset + end

    if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)) {
      continue
    }

    spans.push({
      queryIndex,
      startByte,
      endByte,
    })
  }

  return spans
}

function exactMatchTextsFromRgMatch(data) {
  const submatches = data?.submatches
  if (!Array.isArray(submatches)) return []

  const texts = []
  for (const submatch of submatches) {
    const text = submatch?.match?.text
    if (typeof text === "string" && text.length > 0) texts.push(text)
  }

  return texts
}

function runFileDiscovery(root, query, queryIndex, target, glob) {
  return new Promise((resolve) => {
    const args = [
      "--files-with-matches",
      "--null",
      "--color",
      "never",
    ]

    appendSearchGlobs(args, glob)
    args.push("--", query, target)

    const child = spawn("rg", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const files = []
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let scanCapped = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, QUERY_TIMEOUT_MS)

    function consume(file) {
      if (!file || scanCapped) return
      if (isReservedAgentEvidencePath(file)) return

      // Exactly FILE_DISCOVERY_CAP_PER_QUERY files are complete; observing
      // one more file proves that lexical file discovery is truncated.
      if (files.length >= FILE_DISCOVERY_CAP_PER_QUERY) {
        scanCapped = true
        child.kill("SIGTERM")
        return
      }

      files.push(file)
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")

      while (true) {
        const pos = stdout.indexOf("\0")
        if (pos < 0) break
        consume(stdout.slice(0, pos))
        stdout = stdout.slice(pos + 1)
      }
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 3000) stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true

      resolve({
        query,
        queryIndex,
        files,
        timedOut,
        scanCapped,
        error: String(error?.message ?? error),
        scanComplete: false,
      })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (!scanCapped && stdout.length > 0) consume(stdout.replace(/\0+$/, ""))
      if (settled) return
      settled = true

      let error = null
      if (!timedOut && !scanCapped && code !== 0 && code !== 1) {
        error = stderr.trim() || `rg exited with status ${code}`
      }

      resolve({
        query,
        queryIndex,
        files,
        timedOut,
        scanCapped,
        error,
        scanComplete: !timedOut && !scanCapped && !error,
      })
    })
  })
}

function queryPathTokens(query) {
  const chunks = String(query ?? "").match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g)
  if (!chunks) return []

  const tokens = new Set()

  for (const chunk of chunks) {
    const whole = chunk.toLowerCase()
    if (whole.length >= 3) tokens.add(whole)

    const split = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-\s]+/)

    for (const part of split) {
      if (part.length >= 3) tokens.add(part.toLowerCase())
    }
  }

  return [...tokens].slice(0, 8)
}


function escapeRegexLiteral(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function queryCompilerTokens(query) {
  const chunks = String(query ?? "").match(
    /[A-Za-z][A-Za-z0-9_-]{2,}/g,
  )

  if (!chunks) return []

  const tokens = []
  const seen = new Set()

  const add = (raw) => {
    const token = String(raw ?? "").toLowerCase()

    if (
      token.length < 3 ||
      token.length > 32 ||
      QUERY_COMPILER_STOPWORDS.has(token) ||
      seen.has(token)
    ) {
      return
    }

    seen.add(token)
    tokens.push(token)
  }

  for (const chunk of chunks) {
    const split = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-\s]+/)

    for (const part of split) add(part)
  }

  return tokens.slice(0, QUERY_COMPILER_MAX_TOKENS)
}

function queryCompilerEligible(query) {
  const tokens = queryCompilerTokens(query)

  // This fallback only runs after authoritative exact-zero discovery.
  // Requiring model-generated `.*` made ordinary natural-language
  // compound queries unnecessarily expensive.
  return tokens.length >= QUERY_COMPILER_MIN_TOKENS
}

function queryCompilerCasefoldRegex(query) {
  return `(?i:${String(query ?? "")})`
}

function queryCompilerAnchorToken(tokens) {
  return [...tokens].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  )[0] ?? null
}

function splitTopLevelRegexAlternatives(query) {
  const text = String(query ?? "")
  const branches = []
  let current = ""
  let escaped = false
  let classDepth = 0
  let parenDepth = 0

  for (const ch of text) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === "\\") {
      current += ch
      escaped = true
      continue
    }

    if (ch === "[" && classDepth === 0) {
      classDepth = 1
      current += ch
      continue
    }

    if (ch === "]" && classDepth === 1) {
      classDepth = 0
      current += ch
      continue
    }

    if (classDepth === 0) {
      if (ch === "(") {
        parenDepth += 1
        current += ch
        continue
      }

      if (ch === ")") {
        if (parenDepth < 1) return null
        parenDepth -= 1
        current += ch
        continue
      }

      if (ch === "|" && parenDepth === 0) {
        if (!current.trim()) return null
        branches.push(current)
        current = ""
        if (branches.length >= QUERY_FORMULATION_MAX_BRANCHES) return null
        continue
      }
    }

    current += ch
  }

  if (escaped || classDepth !== 0 || parenDepth !== 0 || !current.trim()) {
    return null
  }

  branches.push(current)
  return branches
}

function queryFormulationAtoms(fragment) {
  const chunks = String(fragment ?? "").match(
    /[A-Za-z][A-Za-z0-9_-]{2,}|\d{2,8}/g,
  )

  if (!chunks) return []

  const atoms = []
  const seen = new Set()

  const add = (raw) => {
    const atom = String(raw ?? "").toLowerCase()
    if (
      atom.length < 2 ||
      atom.length > 32 ||
      QUERY_COMPILER_STOPWORDS.has(atom) ||
      seen.has(atom)
    ) {
      return
    }

    seen.add(atom)
    atoms.push(atom)
  }

  for (const chunk of chunks) {
    if (/^\d+$/.test(chunk)) {
      add(chunk)
      continue
    }

    const parts = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-\s]+/)

    for (const part of parts) add(part)
  }

  return atoms
}

function buildQueryFormulationPlan(query) {
  const rawBranches = splitTopLevelRegexAlternatives(query)
  if (
    !Array.isArray(rawBranches) ||
    rawBranches.length < 1 ||
    rawBranches.length > QUERY_FORMULATION_MAX_BRANCHES
  ) {
    return null
  }

  const branches = []
  const atoms = []
  const seen = new Set()

  for (const raw of rawBranches) {
    const branchAtoms = queryFormulationAtoms(raw)

    if (
      branchAtoms.length < 1 ||
      branchAtoms.length > QUERY_FORMULATION_MAX_ATOMS_PER_BRANCH
    ) {
      return null
    }

    branches.push({ raw, atoms: branchAtoms })

    for (const atom of branchAtoms) {
      if (seen.has(atom)) continue
      seen.add(atom)
      atoms.push(atom)
      if (atoms.length > QUERY_FORMULATION_MAX_ATOMS) return null
    }
  }

  if (
    atoms.length < QUERY_FORMULATION_MIN_FILE_ATOMS ||
    !atoms.some((atom) => /[a-z]/.test(atom))
  ) {
    return null
  }

  return {
    protocol: QUERY_FORMULATION_PROTOCOL,
    branches,
    atoms,
  }
}

function queryFormulationLineHasAtom(text, atom) {
  const line = String(text ?? "").toLowerCase()
  if (!line || !atom) return false

  if (/^\d+$/.test(atom)) {
    const escaped = escapeRegexLiteral(atom)
    return new RegExp(`(?:^|\\D)${escaped}(?=\\D|$)`).test(line)
  }

  return line.includes(atom)
}

async function runQueryFormulationDiscovery(
  root,
  query,
  queryIndex,
  target,
  glob,
  plan = null,
) {
  const formulation = plan ?? buildQueryFormulationPlan(query)
  if (!formulation) return null

  const anchorQuery =
    `(?i:${formulation.atoms.map(escapeRegexLiteral).join("|")})`

  const probe = await runQuery(
    root,
    anchorQuery,
    queryIndex,
    [target],
    glob,
  )

  if (
    probe.scanComplete !== true ||
    probe.timedOut === true ||
    probe.scanCapped === true ||
    probe.error
  ) {
    return null
  }

  const atomsByFile = new Map()
  const globalObserved = new Set()

  for (const match of probe.matches ?? []) {
    const file = evidenceFileKey(match?.file)
    if (!file) continue

    let fileAtoms = atomsByFile.get(file)
    if (!fileAtoms) {
      fileAtoms = new Set()
      atomsByFile.set(file, fileAtoms)
    }

    for (const atom of formulation.atoms) {
      if (!queryFormulationLineHasAtom(match?.text, atom)) continue
      fileAtoms.add(atom)
      globalObserved.add(atom)
    }
  }

  const scoreByFile = new Map()
  const branchEvidence = []

  formulation.branches.forEach((branch, branchIndex) => {
    const sourceBackedAtoms = branch.atoms.filter((atom) =>
      globalObserved.has(atom),
    )

    if (
      sourceBackedAtoms.length < QUERY_FORMULATION_MIN_FILE_ATOMS ||
      !sourceBackedAtoms.some((atom) => /[a-z]/.test(atom))
    ) {
      return
    }

    const requiredAtoms = Math.max(
      QUERY_FORMULATION_MIN_FILE_ATOMS,
      Math.ceil(
        sourceBackedAtoms.length * QUERY_FORMULATION_MIN_COVERAGE_RATIO,
      ),
    )

    branchEvidence.push({
      branchIndex,
      sourceBackedAtoms,
      requiredAtoms,
    })

    for (const [file, observedAtoms] of atomsByFile.entries()) {
      const matchedAtoms = sourceBackedAtoms.filter((atom) =>
        observedAtoms.has(atom),
      )

      if (matchedAtoms.length < requiredAtoms) continue

      const ratio = matchedAtoms.length / sourceBackedAtoms.length
      const prior = scoreByFile.get(file) ?? {
        file,
        maxAtoms: 0,
        maxRatio: 0,
        matchedBranches: 0,
      }

      prior.maxAtoms = Math.max(prior.maxAtoms, matchedAtoms.length)
      prior.maxRatio = Math.max(prior.maxRatio, ratio)
      prior.matchedBranches += 1
      scoreByFile.set(file, prior)
    }
  })

  const ranked = [...scoreByFile.values()].sort(
    (a, b) =>
      b.maxAtoms - a.maxAtoms ||
      b.maxRatio - a.maxRatio ||
      b.matchedBranches - a.matchedBranches ||
      a.file.localeCompare(b.file),
  )

  if (
    ranked.length < 1 ||
    ranked.length > QUERY_FORMULATION_MAX_FILES
  ) {
    return null
  }

  const files = ranked.map((entry) => entry.file)
  const allowed = new Set(files)
  const matches = (probe.matches ?? [])
    .filter((match) => allowed.has(evidenceFileKey(match?.file)))
    .map((match) => ({
      ...match,
      exactSpans: [],
      matchTexts: [],
    }))

  if (matches.length < 1) return null

  const compiledProbe = {
    ...probe,
    query,
    requestedQuery: query,
    matchMode: "token_file_cooccurrence",
    matches,
  }

  return {
    query,
    requestedQuery: query,
    effectiveQuery: anchorQuery,
    cacheQuery: `token-file:${formulation.branches
      .map((branch) => branch.atoms.join("&"))
      .join("||")}`,
    queryIndex,
    files,
    timedOut: false,
    scanCapped: false,
    error: null,
    scanComplete: true,
    matchMode: "token_file_cooccurrence",
    compilerTokens: formulation.atoms,
    compiledProbe,
    queryFormulation: {
      protocol: QUERY_FORMULATION_PROTOCOL,
      branches: formulation.branches.map((branch) => branch.atoms),
      source_backed_branches: branchEvidence.map((entry) => ({
        branch_index: entry.branchIndex,
        atoms: entry.sourceBackedAtoms,
        required_atoms: entry.requiredAtoms,
      })),
      selected_files: files.length,
    },
  }
}

function queryCompilerProbeResult(
  result,
  requestedQuery,
  matchMode,
) {
  const fallback = matchMode !== "exact"

  return {
    ...result,
    query: requestedQuery,
    matchMode,
    matches: (result?.matches ?? []).map((match) => ({
      ...match,

      // A fallback hit is real source evidence, but it is NOT an exact
      // match for the model-supplied regex. Never allow it to masquerade
      // as exact structural replacement evidence.
      exactSpans: fallback ? [] : (match.exactSpans ?? []),
      matchTexts: fallback ? [] : (match.matchTexts ?? []),
    })),
  }
}

function restrictProbeResultToTargets(result, targets) {
  const allowed = new Set(
    (targets ?? []).map((file) => evidenceFileKey(file)),
  )

  return {
    ...result,
    matches: (result?.matches ?? []).filter((match) =>
      allowed.has(evidenceFileKey(match.file)),
    ),
  }
}

async function runCompiledDiscovery(
  root,
  query,
  queryIndex,
  target,
  glob,
) {
  const exact = await runFileDiscovery(
    root,
    query,
    queryIndex,
    target,
    glob,
  )

  const exactResult = {
    ...exact,
    query,
    requestedQuery: query,
    effectiveQuery: query,
    cacheQuery: `exact:${query}`,
    matchMode: "exact",
    compilerTokens: [],
    compiledProbe: null,
  }

  const exactCompleteZero =
    exact.scanComplete === true &&
    exact.timedOut !== true &&
    exact.scanCapped !== true &&
    !exact.error &&
    (exact.files?.length ?? 0) === 0

  if (
    !exactCompleteZero ||
    !queryCompilerEligible(query)
  ) {
    return exactResult
  }

  // Stage 1: preserve regex semantics and only relax case.
  const foldedQuery = queryCompilerCasefoldRegex(query)

  const folded = await runFileDiscovery(
    root,
    foldedQuery,
    queryIndex,
    target,
    glob,
  )

  if ((folded.files?.length ?? 0) > 0) {
    return {
      ...folded,
      query,
      requestedQuery: query,
      effectiveQuery: foldedQuery,
      cacheQuery: `casefold:${foldedQuery}`,
      matchMode: "casefold",
      compilerTokens: queryCompilerTokens(query),
      compiledProbe: null,
    }
  }

  // Do not build stronger routing claims on top of an incomplete fallback.
  const foldedCompleteZero =
    folded.scanComplete === true &&
    folded.timedOut !== true &&
    folded.scanCapped !== true &&
    !folded.error &&
    (folded.files?.length ?? 0) === 0

  if (!foldedCompleteZero) {
    return exactResult
  }

  const formulationPlan = buildQueryFormulationPlan(query)

  // Stage 2a: top-level alternation is usually a set of independent search
  // hypotheses. Requiring every token from every alternative on one line is
  // structurally impossible, so try bounded same-file co-occurrence first.
  if ((formulationPlan?.branches?.length ?? 0) > 1) {
    const formulated = await runQueryFormulationDiscovery(
      root,
      query,
      queryIndex,
      target,
      glob,
      formulationPlan,
    )
    if (formulated) return formulated
  }

  // Stage 2b: order-independent recovery, but only when ALL significant
  // query tokens occur on the SAME physical source line.
  //
  // One longest token is used as a cheap rg anchor; JS then validates
  // complete co-occurrence. This avoids permutations/lookaheads and keeps
  // the operation bounded to one additional rg scan.
  const tokens = queryCompilerTokens(query)

  if (tokens.length < QUERY_COMPILER_MIN_TOKENS) {
    return exactResult
  }

  const anchorToken = queryCompilerAnchorToken(tokens)
  if (!anchorToken) return exactResult

  const anchorQuery =
    `(?i:${escapeRegexLiteral(anchorToken)})`

  const anchorProbe = await runQuery(
    root,
    anchorQuery,
    queryIndex,
    [target],
    glob,
  )

  if (
    anchorProbe.scanComplete !== true ||
    anchorProbe.timedOut === true ||
    anchorProbe.scanCapped === true ||
    anchorProbe.error
  ) {
    return exactResult
  }

  const matches = (anchorProbe.matches ?? [])
    .filter((match) => {
      const line = String(match?.text ?? "").toLowerCase()
      return tokens.every((token) => line.includes(token))
    })
    .map((match) => ({
      ...match,
      exactSpans: [],
      matchTexts: [],
    }))

  if (matches.length < 1) {
    const formulated = await runQueryFormulationDiscovery(
      root,
      query,
      queryIndex,
      target,
      glob,
      formulationPlan,
    )
    return formulated ?? exactResult
  }

  const files = [
    ...new Set(
      matches
        .map((match) => match.file)
        .filter((file) => typeof file === "string" && file.length > 0),
    ),
  ]

  const compiledProbe = {
    ...anchorProbe,
    query,
    requestedQuery: query,
    matchMode: "token_line_cooccurrence",
    matches,
  }

  return {
    query,
    requestedQuery: query,
    effectiveQuery: anchorQuery,
    cacheQuery: `token-line:${tokens.join("|")}`,
    queryIndex,
    files,
    timedOut: false,
    scanCapped: false,
    error: null,
    scanComplete: true,
    matchMode: "token_line_cooccurrence",
    compilerTokens: tokens,
    compiledProbe,
  }
}

function pathAffinity(file, queryIndices, queryTokensByIndex) {
  const normalized = evidenceFileKey(file).toLowerCase()
  const base = path.posix.basename(normalized)
  const stem = base.replace(/\.[^.]+$/, "")
  let score = 0

  for (const queryIndex of queryIndices ?? []) {
    for (const token of queryTokensByIndex.get(queryIndex) ?? []) {
      if (stem === token) score += 4
      else if (stem.includes(token)) score += 2
      else if (normalized.includes(token)) score += 1
    }
  }

  return score
}

function rankDiscoveredFiles(discoveryResults) {
  const byFile = new Map()
  const queryFileCounts = new Map()
  const queryTokensByIndex = new Map(
    (discoveryResults ?? []).map((result) => [
      result.queryIndex,
      queryPathTokens(result.query),
    ]),
  )

  for (const result of discoveryResults ?? []) {
    const unique = [...new Set(result?.files ?? [])]
    queryFileCounts.set(result.queryIndex, unique.length)

    for (const file of unique) {
      let entry = byFile.get(file)

      if (!entry) {
        entry = {
          file,
          queries: new Set(),
          coverage: 0,
          pathAffinity: 0,
          rarity: 0,
        }
        byFile.set(file, entry)
      }

      entry.queries.add(result.queryIndex)
    }
  }

  for (const entry of byFile.values()) {
    entry.coverage = entry.queries.size
    entry.pathAffinity = pathAffinity(
      entry.file,
      entry.queries,
      queryTokensByIndex,
    )
    entry.rarity = [...entry.queries].reduce((score, queryIndex) => {
      const count = Math.max(1, queryFileCounts.get(queryIndex) ?? 1)
      return score + 1 / count
    }, 0)
  }

  // Relevance stays separate from fairness.
  //
  // Query specificity is intentionally only a tertiary tie-break:
  //
  //   coverage > path affinity > provenance specificity > stable path
  //
  // Therefore a weak rare query can never outrank stronger multi-query
  // coverage or a better path match. It only replaces the previous
  // arbitrary filename tie-break when lexical evidence is otherwise equal.
  //
  // The signal is free: discovery already measured the number of files
  // matched by every query, so this adds no repository scan or model call.
  return [...byFile.values()].sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.pathAffinity - a.pathAffinity ||
      b.rarity - a.rarity ||
      a.file.localeCompare(b.file),
  )
}



function semanticResolverBinary() {
  const override = process.env.OPENCODE_SEMANTIC_RESOLVER
  if (typeof override === "string" && override.length > 0) {
    return override
  }

  const dir = runtimeStackDirectory()
  if (!dir) return null

  return path.join(dir, "opencode-semantic-resolver")
}

function semanticLanguageForFile(file) {
  const lower = String(file ?? "").toLowerCase()

  if (lower.endsWith(".py") || lower.endsWith(".pyi")) {
    return "python"
  }

  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "typescript"
  }

  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "javascript"
  }

  return null
}

function semanticExpectedImpactTarget(relation) {
  if (relation?.direction === "forward") {
    return evidenceFileKey(relation?.file)
  }

  if (relation?.direction === "reverse") {
    return evidenceFileKey(relation?.seed)
  }

  return ""
}

function semanticSpecCursorOffset(spec) {
  const value = String(spec ?? "")
  if (!value) return 0

  const slash = Math.max(
    value.lastIndexOf("/"),
    value.lastIndexOf("\\"),
  )

  if (slash >= 0 && slash + 1 < value.length) {
    return slash + 1
  }

  const dot = value.lastIndexOf(".")
  if (dot >= 0 && dot + 1 < value.length) {
    return dot + 1
  }

  return 0
}

function semanticLineWindow(text, oneBasedLine, maxLines) {
  if (
    !Number.isInteger(oneBasedLine) ||
    oneBasedLine < 1 ||
    !Number.isInteger(maxLines) ||
    maxLines < 1
  ) {
    return null
  }

  let line = 1
  let start = 0

  while (line < oneBasedLine) {
    const next = text.indexOf("\n", start)
    if (next < 0) return null
    start = next + 1
    line += 1
  }

  let end = start

  for (let index = 0; index < maxLines; index += 1) {
    const next = text.indexOf("\n", end)
    if (next < 0) {
      end = text.length
      break
    }

    end = next + 1
  }

  return { start, end }
}

async function semanticImpactQueryForRelation(
  root,
  relation,
  id,
) {
  const witnessFile = evidenceFileKey(relation?.witness_file)
  const expectedFile = semanticExpectedImpactTarget(relation)
  const spec =
    typeof relation?.spec === "string"
      ? relation.spec
      : ""
  const witnessLine = relation?.witness_line
  const language = semanticLanguageForFile(witnessFile)

  if (
    !witnessFile ||
    !expectedFile ||
    !spec ||
    !language ||
    !Number.isInteger(witnessLine) ||
    witnessLine < 1
  ) {
    return {
      ok: false,
      reason: "unsupported_relation",
    }
  }

  const resolved = path.resolve(root, witnessFile)

  if (
    resolved !== root &&
    !resolved.startsWith(root + path.sep)
  ) {
    return {
      ok: false,
      reason: "witness_outside_root",
    }
  }

  let canonical
  let info
  let source

  try {
    canonical = await realpath(resolved)

    if (
      canonical !== root &&
      !canonical.startsWith(root + path.sep)
    ) {
      return {
        ok: false,
        reason: "witness_realpath_outside_root",
      }
    }

    info = await stat(canonical)

    if (
      !info.isFile() ||
      info.size > MAX_CONTEXT_FILE_BYTES
    ) {
      return {
        ok: false,
        reason: "witness_file_budget",
      }
    }

    source = await readFile(canonical, "utf8")
  } catch {
    return {
      ok: false,
      reason: "witness_unavailable",
    }
  }

  const window = semanticLineWindow(
    source,
    witnessLine,
    SEMANTIC_IMPACT_WITNESS_WINDOW_LINES,
  )

  if (!window) {
    return {
      ok: false,
      reason: "witness_line_invalid",
    }
  }

  const fragment = source.slice(window.start, window.end)
  const occurrences = []

  let cursor = 0

  while (true) {
    const found = fragment.indexOf(spec, cursor)
    if (found < 0) break

    occurrences.push(found)

    if (occurrences.length > 1) break

    cursor = found + Math.max(1, spec.length)
  }

  if (occurrences.length !== 1) {
    return {
      ok: false,
      reason:
        occurrences.length === 0
          ? "module_spec_not_found"
          : "module_spec_ambiguous",
    }
  }

  const charOffset =
    window.start +
    occurrences[0] +
    semanticSpecCursorOffset(spec)

  const byteOffset =
    Buffer.byteLength(
      source.slice(0, charOffset),
      "utf8",
    )

  return {
    ok: true,
    language,
    expectedFile,
    relation: {
      file: evidenceFileKey(relation?.file),
      seed: evidenceFileKey(relation?.seed),
      direction: relation?.direction ?? null,
      witness_file: witnessFile,
      witness_line: witnessLine,
      spec,
    },
    query: {
      id,
      operation: "definition",
      file: witnessFile,
      byte_offset: byteOffset,
      max_results: SEMANTIC_IMPACT_MAX_RESULTS,
    },
  }
}

function runSemanticResolverBatch(
  root,
  language,
  planned,
) {
  return new Promise((resolve) => {
    const binary = semanticResolverBinary()

    if (!binary) {
      resolve({
        ok: false,
        reason: "binary_unavailable",
        language,
        elapsedMs: 0,
      })
      return
    }

    const started = performance.now()

    let child

    try {
      child = spawn(binary, [], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      resolve({
        ok: false,
        reason: "spawn_error",
        language,
        elapsedMs:
          Math.round(
            (performance.now() - started) * 100,
          ) / 100,
      })
      return
    }

    let stdout = []
    let stdoutBytes = 0
    let stderr = ""
    let timedOut = false
    let outputLimited = false
    let settled = false

    const elapsed = () =>
      Math.round(
        (performance.now() - started) * 100,
      ) / 100

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, SEMANTIC_RESOLVER_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (
        stdoutBytes >
        SEMANTIC_RESOLVER_MAX_STDOUT_BYTES
      ) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }

      stdout.push(Buffer.from(chunk))
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString("utf8")
      }
    })

    child.on("error", () => {
      finish({
        ok: false,
        reason: "spawn_error",
        language,
        elapsedMs: elapsed(),
      })
    })

    child.on("close", (code) => {
      if (timedOut) {
        finish({
          ok: false,
          reason: "timeout",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      if (outputLimited) {
        finish({
          ok: false,
          reason: "stdout_limit",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      if (code !== 0) {
        finish({
          ok: false,
          reason: "exit_error",
          language,
          elapsedMs: elapsed(),
          error: stderr.trim() || null,
        })
        return
      }

      let response

      try {
        response = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        )
      } catch {
        finish({
          ok: false,
          reason: "invalid_json",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      const expectedIds =
        new Set(
          planned.map((entry) => entry.query.id),
        )

      const results = response?.results

      const ids =
        Array.isArray(results)
          ? results.map((entry) => entry?.id)
          : []

      const validIds =
        ids.length === expectedIds.size &&
        new Set(ids).size === ids.length &&
        ids.every((id) => expectedIds.has(id))

      if (
        response?.protocol !== SEMANTIC_RESOLVER_PROTOCOL ||
        response?.authority !== SEMANTIC_RESOLVER_AUTHORITY ||
        typeof response?.engine !== "string" ||
        !response.engine ||
        !Array.isArray(results) ||
        !validIds
      ) {
        finish({
          ok: false,
          reason: "response_contract_invalid",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      finish({
        ok: true,
        reason: "resolved",
        language,
        engine: response.engine,
        elapsedMs: elapsed(),
        response,
      })
    })

    const request = {
      protocol: SEMANTIC_RESOLVER_PROTOCOL,
      root,
      language,
      queries:
        planned.map((entry) => entry.query),
    }

    child.stdin.end(
      JSON.stringify(request),
      "utf8",
    )
  })
}

async function runSemanticImpactShadow(
  root,
  validatedImpact,
) {
  const sourceValidated =
    Array.isArray(validatedImpact)
      ? validatedImpact
      : []

  if (sourceValidated.length < 1) {
    return {
      attempted: false,
      ok: true,
      reason: "no_source_validated_impact",
      elapsedMs: 0,
      queries: 0,
      confirmed: 0,
      contradicted: 0,
      ambiguous: 0,
      unresolved: 0,
      unavailable: 0,
      skipped: 0,
      engines: [],
      outcomes: [],
    }
  }

  const started = performance.now()
  const planned = []
  const seen = new Set()
  let skipped = 0

  outer:
  for (const hypothesis of sourceValidated) {
    for (const relation of hypothesis?.relations ?? []) {
      if (planned.length >= SEMANTIC_IMPACT_MAX_QUERIES) {
        break outer
      }

      const expectedFile =
        semanticExpectedImpactTarget(relation)

      const key = [
        evidenceFileKey(relation?.witness_file),
        relation?.witness_line,
        relation?.spec,
        expectedFile,
      ].join("\0")

      if (seen.has(key)) continue
      seen.add(key)

      const entry =
        await semanticImpactQueryForRelation(
          root,
          relation,
          `impact-semantic-${planned.length + 1}`,
        )

      if (!entry.ok) {
        skipped += 1
        continue
      }

      planned.push(entry)
    }
  }

  if (planned.length < 1) {
    return {
      attempted: false,
      ok: true,
      reason: "no_supported_semantic_witnesses",
      elapsedMs:
        Math.round(
          (performance.now() - started) * 100,
        ) / 100,
      queries: 0,
      confirmed: 0,
      contradicted: 0,
      ambiguous: 0,
      unresolved: 0,
      unavailable: 0,
      skipped,
      engines: [],
      outcomes: [],
    }
  }

  const byLanguage = new Map()

  for (const entry of planned) {
    const batch =
      byLanguage.get(entry.language) ?? []
    batch.push(entry)
    byLanguage.set(entry.language, batch)
  }

  const batches =
    await Promise.all(
      [...byLanguage.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([language, entries]) =>
          runSemanticResolverBatch(
            root,
            language,
            entries,
          ),
        ),
    )

  const batchByLanguage =
    new Map(
      batches.map((batch) => [
        batch.language,
        batch,
      ]),
    )

  const outcomes = []

  for (const plan of planned) {
    const batch =
      batchByLanguage.get(plan.language)

    if (!batch?.ok) {
      outcomes.push({
        verdict: "unavailable",
        expected_file: plan.expectedFile,
        actual_file: null,
        engine: null,
        reason:
          batch?.reason ??
          "batch_unavailable",
        ...plan.relation,
      })
      continue
    }

    const result =
      batch.response.results.find(
        (entry) =>
          entry?.id === plan.query.id,
      )

    if (!result) {
      outcomes.push({
        verdict: "unavailable",
        expected_file: plan.expectedFile,
        actual_file: null,
        engine: batch.engine,
        reason: "result_missing",
        ...plan.relation,
      })
      continue
    }

    const locations =
      Array.isArray(result?.locations)
        ? result.locations
        : []

    let verdict = "unresolved"
    let actualFile = null
    let reason = result?.status ?? "unknown"

    if (
      result?.status === "resolved" &&
      result?.bounded_complete === true &&
      locations.length === 1
    ) {
      actualFile =
        evidenceFileKey(locations[0]?.file)

      verdict =
        actualFile === plan.expectedFile
          ? "confirmed"
          : "contradicted"

      reason =
        verdict === "confirmed"
          ? "semantic_target_match"
          : "semantic_target_mismatch"
    } else if (
      result?.status === "ambiguous" ||
      result?.bounded_complete !== true ||
      locations.length > 1
    ) {
      verdict = "ambiguous"
      reason = "semantic_result_ambiguous"
    } else if (
      result?.status === "unsupported" ||
      result?.status === "error"
    ) {
      verdict = "unavailable"
    }

    outcomes.push({
      verdict,
      expected_file: plan.expectedFile,
      actual_file: actualFile,
      engine: batch.engine,
      reason,
      ...plan.relation,
    })
  }

  const count = (verdict) =>
    outcomes.filter(
      (entry) => entry.verdict === verdict,
    ).length

  const confirmed = count("confirmed")
  const contradicted = count("contradicted")
  const ambiguous = count("ambiguous")
  const unresolved = count("unresolved")
  const unavailable = count("unavailable")
  const allBatchesOk =
    batches.every((batch) => batch.ok)

  return {
    attempted: true,
    ok: allBatchesOk,
    reason:
      !allBatchesOk
        ? "resolver_partial"
        : contradicted > 0
          ? "semantic_contradictions_observed"
          : confirmed > 0
            ? "semantic_confirmations_observed"
            : "semantic_no_confirmation",
    elapsedMs:
      Math.round(
        (performance.now() - started) * 100,
      ) / 100,
    queries: planned.length,
    confirmed,
    contradicted,
    ambiguous,
    unresolved,
    unavailable,
    skipped,
    engines:
      [...new Set(
        batches
          .map((batch) => batch.engine)
          .filter(Boolean),
      )].sort(),
    outcomes: outcomes.slice(
      0,
      SEMANTIC_IMPACT_MAX_QUERIES,
    ),
  }
}

function retrievalRankerBinary() {
  const override = process.env.OPENCODE_RETRIEVAL_RANKER
  if (typeof override === "string" && override.length > 0) {
    return override
  }

  const dir = runtimeStackDirectory()
  if (!dir) return null

  return path.join(dir, "opencode-retrieval-ranker")
}

function retrievalRankerQuery(queries) {
  /*
   * Reuse the already-proven lexical tokenization used by Scout path
   * relevance. Do not pass regex punctuation into BM25F.
   *
   * Preserve first-seen order so identical search input is reproducible.
   */
  const terms = []
  const seen = new Set()

  for (const query of queries ?? []) {
    for (const term of queryPathTokens(query)) {
      if (seen.has(term)) continue
      seen.add(term)
      terms.push(term)

      if (terms.length >= 32) {
        return terms.join(" ")
      }
    }
  }

  return terms.join(" ")
}

function retrievalRankerFallback(
  rankedFiles,
  reason,
  extra = {},
) {
  return {
    attempted: extra.attempted === true,
    ok: false,
    reason,
    elapsedMs:
      Number.isFinite(extra.elapsedMs)
        ? extra.elapsedMs
        : 0,
    inputFiles:
      Number.isInteger(extra.inputFiles)
        ? extra.inputFiles
        : 0,
    outputFiles: 0,
    degradedFiles: 0,
    errorFiles: 0,
    rankedFiles,
  }
}

function validateRetrievalRankerResponse(
  response,
  candidates,
) {
  if (
    response?.protocol !== RETRIEVAL_RANKER_PROTOCOL ||
    response?.authority !== RETRIEVAL_RANKER_AUTHORITY ||
    !Array.isArray(response?.results)
  ) {
    return {
      ok: false,
      reason: "response_contract_invalid",
    }
  }

  const allowed = new Set(
    candidates.map((entry) =>
      evidenceFileKey(entry.file),
    ),
  )

  const seen = new Set()

  for (
    let index = 0;
    index < response.results.length;
    index += 1
  ) {
    const result = response.results[index]
    const file = evidenceFileKey(result?.file)

    if (
      !file ||
      !allowed.has(file) ||
      seen.has(file) ||
      result?.rank !== index + 1 ||
      !Number.isFinite(result?.rrf_score) ||
      !Number.isFinite(result?.bm25f_score)
    ) {
      return {
        ok: false,
        reason: "result_contract_invalid",
      }
    }

    seen.add(file)
  }

  return {
    ok: true,
    reason: "ranked",
  }
}

function runRetrievalRanker(
  root,
  queries,
  lexicalRankedFiles,
) {
  return new Promise((resolve) => {
    const query = retrievalRankerQuery(queries)

    const candidates =
      (lexicalRankedFiles ?? [])
        .slice(0, RETRIEVAL_RANKER_MAX_FILES)

    if (candidates.length < 2) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "not_needed",
        ),
      )
      return
    }

    if (!query) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "no_query_terms",
        ),
      )
      return
    }

    const binary = retrievalRankerBinary()

    if (!binary) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "binary_unavailable",
        ),
      )
      return
    }

    const started = performance.now()

    let child

    try {
      child = spawn(binary, [], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "spawn_error",
          {
            attempted: true,
            inputFiles: candidates.length,
            elapsedMs:
              Math.round(
                (performance.now() - started) * 100,
              ) / 100,
          },
        ),
      )
      return
    }

    let stdout = []
    let stdoutBytes = 0
    let stderr = ""
    let timedOut = false
    let outputLimited = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const elapsed = () =>
      Math.round(
        (performance.now() - started) * 100,
      ) / 100

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, RETRIEVAL_RANKER_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (
        stdoutBytes >
        RETRIEVAL_RANKER_MAX_STDOUT_BYTES
      ) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }

      stdout.push(Buffer.from(chunk))
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString("utf8")
      }
    })

    child.on("error", () => {
      finish(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "spawn_error",
          {
            attempted: true,
            inputFiles: candidates.length,
            elapsedMs: elapsed(),
          },
        ),
      )
    })

    child.on("close", (code) => {
      if (settled) return

      if (timedOut) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "timeout",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      if (outputLimited) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "stdout_limit",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      if (code !== 0) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "nonzero_exit",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      let response

      try {
        response = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        )
      } catch {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "invalid_json",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      const contract =
        validateRetrievalRankerResponse(
          response,
          candidates,
        )

      if (!contract.ok) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            contract.reason,
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      const originalByFile = new Map(
        candidates.map((entry, index) => [
          evidenceFileKey(entry.file),
          {
            entry,
            lexicalRank: index + 1,
          },
        ]),
      )

      const reranked = []
      const rerankedKeys = new Set()

      for (const result of response.results) {
        const key = evidenceFileKey(result.file)
        const original = originalByFile.get(key)

        if (!original) continue

        reranked.push({
          ...original.entry,

          // Routing telemetry only. These fields are never mutation
          // authority and are not consumed as semantic evidence.
          retrievalRank: result.rank,
          retrievalRrfScore:
            result.rrf_score,
          retrievalBm25fScore:
            result.bm25f_score,
          retrievalLexicalRank:
            result.exact_rank ?? original.lexicalRank,
          retrievalBm25Rank:
            result.bm25_rank ?? null,
          retrievalStructuralComplete:
            result.structural_complete === true,
        })

        rerankedKeys.add(key)
      }

      /*
       * A candidate rejected by the ranker (for example >2 MiB) is not
       * declared irrelevant. Keep it in the candidate universe in its
       * original relative order after the successfully reranked prefix.
       */
      for (const entry of candidates) {
        const key = evidenceFileKey(entry.file)
        if (!rerankedKeys.has(key)) {
          reranked.push(entry)
        }
      }

      // Files outside the bounded rerank prefix retain original order.
      const tail =
        lexicalRankedFiles.slice(candidates.length)

      finish({
        attempted: true,
        ok: true,
        reason:
          (response.errors?.length ?? 0) > 0
            ? "ranked_partial"
            : "ranked",
        elapsedMs: elapsed(),
        inputFiles: candidates.length,
        outputFiles: response.results.length,
        degradedFiles:
          Array.isArray(response.degraded_files)
            ? response.degraded_files.length
            : 0,
        errorFiles:
          Array.isArray(response.errors)
            ? response.errors.length
            : 0,
        rankedFiles: [
          ...reranked,
          ...tail,
        ],
      })
    })

    try {
      child.stdin.end(
        JSON.stringify({
          root,
          query,
          files: candidates.map(
            (entry, index) => ({
              file: evidenceFileKey(entry.file),

              // retrieval-ranker-v1 calls this exact_rank. In live Scout
              // this is the deterministic lexical relevance rank.
              exact_rank: index + 1,
            }),
          ),
          max_results:
            RETRIEVAL_RANKER_MAX_FILES,
        }),
      )
    } catch {
      child.kill("SIGKILL")

      finish(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "stdin_error",
          {
            attempted: true,
            inputFiles: candidates.length,
            elapsedMs: elapsed(),
          },
        ),
      )
    }
  })
}
