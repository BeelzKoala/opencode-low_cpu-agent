

function sampleScopeHitLines(scope, limit = REGION_SAMPLE_HITS_PER_SCOPE) {
  const lines = [...(scope?.hitLines ?? [])]
    .filter((line) => Number.isInteger(line) && line > 0)
    .sort((a, b) => a - b)

  if (lines.length <= limit) return lines

  const picks = [lines[0]]
  if (limit >= 3) picks.push(lines[Math.floor((lines.length - 1) / 2)])
  if (limit >= 2) picks.push(lines[lines.length - 1])

  return [...new Set(picks)].slice(0, limit).sort((a, b) => a - b)
}

async function renderRegionEvidence(root, groups, maxBytes, hits) {
  const budget = Math.min(REGION_BODY_BUDGET_BYTES, Math.max(0, maxBytes))
  const scopes = focusedScopesFromGroups(groups).slice(0, REGION_MAX_SCOPES)

  if (budget < FOCUSED_MIN_SUPPLEMENT_BYTES || scopes.length < 1) {
    return {
      body: [],
      facts: new Set(),
      bodyBytes: 0,
      complete: false,
      scopeCount: scopes.length,
      sampledScopes: 0,
      sampledHits: 0,
      retainedHits: hits?.size ?? 0,
      reason: scopes.length < 1 ? "no_behavior_scope" : "region_budget",
    }
  }

  const body = []
  const facts = new Set()
  const cache = new Map()
  const hitLookup = hitLookupByFileLine(hits)
  let bodyBytes = 0
  let sampledScopes = 0
  let sampledHits = 0
  const sampledHitKeys = new Set()

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > budget) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  for (const scope of scopes) {
    const lines = await loadLines(root, scope.file, cache)
    if (!lines || lines.length < 1) continue

    const start = Math.max(1, Math.min(scope.start, lines.length))
    const end = Math.max(start, Math.min(scope.end, lines.length))
    const samples = sampleScopeHitLines(scope)
    const q = [...scope.queries]
      .sort((a, b) => a - b)
      .map((value) => `Q${value}`)
      .join(",")
    const anchors = [...scope.anchors].slice(0, 4)

    const header =
      `REGION_CONTEXT ${scope.file}:${start}-${end} [${q}] ` +
      `symbol=${JSON.stringify(scope.symbolName)} kind=${scope.symbolKind} ` +
      `hits=${scope.hitCount} sampled_hit_lines=${samples.length}` +
      (anchors.length > 0 ? ` anchors=${JSON.stringify(anchors)}` : "")

    if (!push(header)) break
    facts.add(scopeFact(scope))

    const ranges = mergeLineRanges([
      { start, end: Math.min(end, start + FOCUSED_SCOPE_HEADER_LINES - 1) },
      ...samples.map((line) => ({
        start: Math.max(start, line - REGION_SAMPLE_RADIUS),
        end: Math.min(end, line + REGION_SAMPLE_RADIUS),
      })),
    ])

    const byLine = hitLookup.get(evidenceFileKey(scope.file)) ?? new Map()
    let previousEnd = null

    for (const range of ranges) {
      if (previousEnd !== null && range.start > previousEnd + 1) {
        if (!push(`  … sampled region context omitted ${range.start - previousEnd - 1} lines …`)) {
          return {
            body,
            facts,
            bodyBytes,
            complete: sampledScopes > 0,
            scopeCount: scopes.length,
            sampledScopes,
            sampledHits,
            retainedHits: Math.max(0, (hits?.size ?? 0) - sampledHitKeys.size),
            reason: sampledScopes > 0 ? null : "region_budget",
          }
        }
      }

      for (let n = range.start; n <= range.end; n++) {
        const hit = byLine.get(n)
        let prefix = " "

        if (hit) {
          const labels = [...hit.queries]
            .sort((a, b) => a - b)
            .map((value) => `Q${value + 1}`)
            .join(",")
          prefix = `>[${labels}]`
        }

        if (!push(
          `  ${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`,
        )) {
          return {
            body,
            facts,
            bodyBytes,
            complete: sampledScopes > 0,
            scopeCount: scopes.length,
            sampledScopes,
            sampledHits,
            retainedHits: Math.max(0, (hits?.size ?? 0) - sampledHitKeys.size),
            reason: sampledScopes > 0 ? null : "region_budget",
          }
        }

        facts.add(sourceLineFact(scope.file, n))
        if (hit && !sampledHitKeys.has(hit.key)) {
          sampledHitKeys.add(hit.key)
          sampledHits += 1
          for (const fact of positiveFactsForHit(hit)) facts.add(fact)
        }
      }

      previousEnd = range.end
    }

    sampledScopes += 1
  }

  return {
    body,
    facts,
    bodyBytes,
    complete: sampledScopes > 0,
    scopeCount: scopes.length,
    sampledScopes,
    sampledHits,
    retainedHits: Math.max(0, (hits?.size ?? 0) - sampledHitKeys.size),
    reason: sampledScopes > 0 ? null : "no_renderable_scope",
  }
}

function querySummaryFor(results) {
  return results.map((result) => {
    let count = String(result.matches.length)
    if (result.scanCapped) count = `>=${LINE_HIT_CAP_PER_QUERY}`

    let state = "complete"
    if (result.timedOut) state = "timeout"
    else if (result.scanCapped) state = "scan_cap"
    else if (result.error) state = "error"

    const errorDetail = result.error
      ? ` error=${JSON.stringify(clipLine(result.error, 240))}`
      : ""
    const matchDetail =
      result.matchMode && result.matchMode !== "exact"
        ? ` match=${result.matchMode}`
        : ""

    return `Q${result.queryIndex + 1} probed_line_hits=${count} probe_scan=${state}${matchDetail}${errorDetail}`
  })
}

function exactSpansInResult(result) {
  return Array.isArray(result?.matches)
    ? result.matches.reduce(
        (total, match) =>
          total + (Array.isArray(match?.exactSpans) ? match.exactSpans.length : 0),
        0,
      )
    : 0
}

function normalizeIndexFacetText(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!normalized) return null
  return normalized.length <= INDEX_FACET_TEXT_MAX
    ? normalized
    : normalized.slice(0, INDEX_FACET_TEXT_MAX) + " …"
}

function indexFacetStats(result) {
  const facets = new Map()

  for (const match of result?.matches ?? []) {
    for (const rawText of match?.matchTexts ?? []) {
      const text = normalizeIndexFacetText(rawText)
      if (!text) continue

      let entry = facets.get(text)
      if (!entry) {
        entry = {
          text,
          exactMatches: 0,
          files: new Set(),
          firstFile: null,
          firstLine: null,
          sample: null,
        }
        facets.set(text, entry)
      }

      entry.exactMatches += 1
      if (typeof match?.file === "string") entry.files.add(match.file)

      const line = match?.line
      const shouldReplace =
        entry.firstFile == null ||
        String(match.file ?? "").localeCompare(String(entry.firstFile)) < 0 ||
        (match.file === entry.firstFile &&
          Number.isInteger(line) &&
          (!Number.isInteger(entry.firstLine) || line < entry.firstLine))

      if (shouldReplace) {
        entry.firstFile = match?.file ?? null
        entry.firstLine = Number.isInteger(line) ? line : null
        entry.sample = clipLine(match?.text, 120)
      }
    }
  }

  return [...facets.values()]
}

function selectIndexFacets(facets) {
  if (!Array.isArray(facets) || facets.length < 1) {
    return { dominant: null, discriminative: null }
  }

  const dominant = [...facets].sort(
    (a, b) =>
      b.exactMatches - a.exactMatches ||
      b.files.size - a.files.size ||
      a.text.localeCompare(b.text),
  )[0]

  const alternatives = facets.filter((entry) => entry !== dominant)
  const discriminative = alternatives.length
    ? [...alternatives].sort((a, b) => {
        // Repeated match text is a stronger routing signal than an accidental
        // singleton created by a wide wildcard branch. Among repeated facets,
        // prefer the smaller support: it is more discriminative, not more
        // semantically important.
        const aSingleton = a.exactMatches < 2 ? 1 : 0
        const bSingleton = b.exactMatches < 2 ? 1 : 0

        return (
          aSingleton - bSingleton ||
          a.exactMatches - b.exactMatches ||
          a.files.size - b.files.size ||
          a.text.localeCompare(b.text)
        )
      })[0]
    : null

  return { dominant, discriminative }
}

function renderSearchIndex(results, groups, bodyBudgetBytes) {
  const budget = Math.min(INDEX_BODY_BUDGET_BYTES, bodyBudgetBytes)
  const body = []
  const facts = new Set()
  let bodyBytes = 0
  let complete = true
  let sampleCount = 0
  let structuralGroupsShown = 0
  let discriminativeFacetsShown = 0
  const uniqueFiles = new Set()
  const queryEntries = []

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > budget) {
      complete = false
      return false
    }

    body.push(line)
    bodyBytes += cost
    return true
  }

  for (const result of results) {
    const byFile = new Map()

    for (const match of result.matches ?? []) {
      const file = match?.file
      if (typeof file !== "string") continue

      uniqueFiles.add(file)

      let entry = byFile.get(file)
      if (!entry) {
        entry = {
          file,
          lineHits: 0,
          exactMatches: 0,
          firstLine: match.line,
          sample: clipLine(match.text, 120),
        }
        byFile.set(file, entry)
      }

      entry.lineHits += 1
      entry.exactMatches += Array.isArray(match.exactSpans)
        ? match.exactSpans.length
        : 0

      if (
        Number.isInteger(match.line) &&
        (!Number.isInteger(entry.firstLine) || match.line < entry.firstLine)
      ) {
        entry.firstLine = match.line
        entry.sample = clipLine(match.text, 120)
      }
    }

    const exactMatches = exactSpansInResult(result)
    const facets = indexFacetStats(result)
    const selectedFacets = selectIndexFacets(facets)
    const rankedFiles = [...byFile.values()].sort(
      (a, b) =>
        b.exactMatches - a.exactMatches ||
        b.lineHits - a.lineHits ||
        a.file.localeCompare(b.file),
    )

    queryEntries.push({
      result,
      byFile,
      exactMatches,
      facets,
      selectedFacets,
      rankedFiles,
    })
  }

  // Pass 1: routing core. Every query gets visibility before any query gets
  // extra file samples. This prevents an early broad query from consuming the
  // index body budget and hiding later, narrower query evidence.
  for (const entry of queryEntries) {
    const { result, byFile, exactMatches, facets, selectedFacets } = entry
    const dominant = selectedFacets.dominant
    const discriminative = selectedFacets.discriminative

    let line =
      `Q${result.queryIndex + 1} index files=${byFile.size} ` +
      `collected_lines=${result.matches.length} exact_matches=${exactMatches}`

    if (dominant) {
      line +=
        ` dominant=${JSON.stringify(dominant.text)}` +
        `:${dominant.exactMatches}`
    }

    if (discriminative) {
      line +=
        ` route=${JSON.stringify(discriminative.text)}` +
        `:${discriminative.exactMatches}` +
        ` route_files=${discriminative.files.size}`

      if (discriminative.firstFile) {
        line += ` route_at=${discriminative.firstFile}`
        if (Number.isInteger(discriminative.firstLine)) {
          line += `:${discriminative.firstLine}`
        }
      }
    }

    if (facets.length > 0) line += ` facets=${facets.length}`

    if (!push(line)) break

    facts.add(indexSummaryFact(result, byFile.size, exactMatches))
    if (dominant) facts.add(indexFacetFact("dominant", dominant))
    if (discriminative) {
      facts.add(indexFacetFact("discriminative", discriminative))
      discriminativeFacetsShown += 1
    }
  }

  // Pass 2: bounded file details, round-robin by rank across queries.
  if (complete) {
    for (let rank = 0; rank < INDEX_MAX_FILES_PER_QUERY; rank += 1) {
      let addedAtThisRank = false

      for (const entry of queryEntries) {
        const fileEntry = entry.rankedFiles[rank]
        if (!fileEntry) continue
        addedAtThisRank = true

        const line =
          `  Q${entry.result.queryIndex + 1} ${fileEntry.file} ` +
          `lines=${fileEntry.lineHits} exact=${fileEntry.exactMatches}` +
          (Number.isInteger(fileEntry.firstLine)
            ? ` sample_line=${fileEntry.firstLine}`
            : "") +
          (fileEntry.sample
            ? ` sample=${JSON.stringify(fileEntry.sample)}`
            : "")

        if (!push(line)) break
        facts.add(indexFileFact(fileEntry))
        sampleCount += fileEntry.sample ? 1 : 0
      }

      if (!complete || !addedAtThisRank) break
    }
  }

  if (complete && Array.isArray(groups) && groups.length > 0) {
    if (push(`STRUCTURAL_MAP groups=${groups.length}`)) {
      const rankedGroups = [...groups].sort(
        (a, b) =>
          (b?.hit_count ?? 0) - (a?.hit_count ?? 0) ||
          String(a?.file ?? "").localeCompare(String(b?.file ?? "")) ||
          (a?.start_line ?? 0) - (b?.start_line ?? 0),
      )

      const shown = rankedGroups.slice(0, INDEX_MAX_STRUCTURAL_GROUPS)

      for (const group of shown) {
        const q = queryLabels(group?.queries)
        if (!q) continue

        const line =
          `  ${group.file}:${group.start_line}-${group.end_line} [${q}] ` +
          `symbol=${JSON.stringify(group.symbol_name)} ` +
          `role=${group.role} anchor=${JSON.stringify(group.anchor)} ` +
          `hits=${group.hit_count} variants=${group.variants?.length ?? 0}`

        if (!push(line)) break
        facts.add(groupFact(group))
        structuralGroupsShown += 1
      }

      if (complete && rankedGroups.length > shown.length) {
        push(`  … +${rankedGroups.length - shown.length} structural groups`)
      }
    }
  }

  return {
    body,
    facts,
    bodyBytes,
    complete,
    fileCount: uniqueFiles.size,
    sampleCount,
    structuralGroupsShown,
    discriminativeFacetsShown,
  }
}

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

  // Real OpenCode context evidence shows content text parts may carry one
  // JSON-string serialization layer. Decode exactly one layer only for this
  // versioned host representation. Never recursively parse arbitrary values.
  if (
    source === "content_text_part_text" &&
    raw.startsWith('"')
  ) {
    let decoded = null

    try {
      decoded = JSON.parse(raw)
    } catch {
      return {
        ok: false,
        reason: "task_text_representation_invalid",
        text: "",
        source,
      }
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
        source: "content_text_part_text_json_string",
      }
    }

    return {
      ok: true,
      reason: "task_text_json_string_decoded",
      text,
      source: "content_text_part_text_json_string",
    }
  }

  return {
    ok: true,
    reason: "task_text_plain",
    text: raw,
    source,
  }
}

function extractUserMessageText(message) {
  if (!message || message.role !== "user") {
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
    if (message?.role !== "user") continue
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
    state.mutationIntent = "unknown"
    state.mutationIntentReason = "task_turn_mismatch"
    return { ok:false, reason:"task_turn_mismatch" }
  }

  if (snapshot?.ok !== true) {
    state.taskContextReason = snapshot?.reason ?? "user_task_text_unavailable"
    state.mutationIntent = "unknown"
    state.mutationIntentReason = state.taskContextReason
    return { ok:false, reason:state.taskContextReason }
  }

  const intent = classifyMutationIntent(snapshot.text)
  state.taskTextSha256 = snapshot.textSha256
  state.taskTextBytes = snapshot.textBytes
  state.taskContextReason = snapshot.reason
  state.mutationIntent = intent.kind
  state.mutationIntentReason = intent.reason
  return { ok:intent.kind !== "unknown", reason:intent.reason, intent:intent.kind }
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
