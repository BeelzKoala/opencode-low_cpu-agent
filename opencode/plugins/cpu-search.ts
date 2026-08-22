import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

const MAX_QUERIES = 4
const LINE_HIT_CAP_PER_QUERY = 1000
const FILE_DISCOVERY_CAP_PER_QUERY = 5000
const PROBE_MAX_FILES = 8
const EMIT_MAX_FILES = 4
const PROBE_MATCH_SIGNAL_CAP = 3
const ROUTE_BODY_BUDGET_BYTES = 700
const CONTEXT_RADIUS = 2

const QUERY_CACHE_MAX_ENTRIES_PER_TURN = 16
const QUERY_CACHE_MAX_MATCHES_PER_TURN = 4000

const INDEX_BODY_BUDGET_BYTES = 1400
const INDEX_MAX_FILES_PER_QUERY = 5
const INDEX_MAX_STRUCTURAL_GROUPS = 6
const INDEX_FACET_TEXT_MAX = 80

const MAX_OUTPUT_BYTES = 6500
const BODY_BUDGET_BYTES = 5000
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024
const QUERY_TIMEOUT_MS = 1500

const DISTILLER_TIMEOUT_MS = 500
const DISTILLER_MAX_STDOUT_BYTES = 512 * 1024
const DISTILLER_RAW_BODY_PRESSURE_BYTES = 2500
const DISTILLER_MAX_HITS_PER_FILE = 12
const DISTILLER_IR_BUDGET_BYTES = 32 * 1024

const IMPACT_INDEX_REFRESH_TIMEOUT_MS = 800
const IMPACT_INDEX_QUERY_TIMEOUT_MS = 150
const IMPACT_INDEX_MAX_STDOUT_BYTES = 128 * 1024
const IMPACT_INDEX_MAX_SEEDS = PROBE_MAX_FILES
const IMPACT_INDEX_MAX_NEIGHBORS = 24
const IMPACT_INDEX_REFRESH_TTL_MS = 120_000
const IMPACT_GRAPH_PROBE_MAX_FILES = 2
const IMPACT_GRAPH_EMIT_MAX_FILES = 1
const IMPACT_BINDINGS_PER_CANDIDATE = 4
const IMPACT_EDGE_SYMBOL_CAP = 16
const IMPACT_VALIDATION_SYMBOL_CAP = IMPACT_EDGE_SYMBOL_CAP
const IMPACT_SCOPE_IDENTIFIER_CAP = 160
const IMPACT_FILTER_SYMBOL_CAP = IMPACT_SCOPE_IDENTIFIER_CAP
const IMPACT_VALIDATION_TIMEOUT_MS = 350
const IMPACT_VALIDATION_HIT_CAP = 8
const IMPACT_SCOPE_WINDOW_RADIUS = 12
const IMPACT_SCOPE_MAX_LINES = 180
const HYBRID_MIN_SAVINGS_RATIO = 0.75
const HYBRID_CONTEXT_RADIUS = 1
const HYBRID_CONTEXT_SAMPLES_PER_GROUP = 3

const FOCUSED_PROBE_MAX_LINE_HITS = 24
const FOCUSED_PROBE_MAX_EXACT_MATCHES = 32
const FOCUSED_PROBE_MAX_HITS_PER_FILE = 8
const FOCUSED_MAX_SCOPES = 3
const FOCUSED_SUPPLEMENT_MAX_BYTES = 2600
const FOCUSED_FULL_SCOPE_MAX_LINES = 96
const FOCUSED_SCOPE_HEADER_LINES = 3
const FOCUSED_WINDOW_RADII = [20, 12, 6, 2]
const FOCUSED_MIN_SUPPLEMENT_BYTES = 128
const FOCUSED_MAX_OVERHEAD_BYTES = 256
const FOCUSED_MAX_OVERHEAD_RATIO = 1.12

const REGION_MAX_SCOPES = 3
const REGION_BODY_BUDGET_BYTES = 2200
const REGION_SAMPLE_HITS_PER_SCOPE = 3
const REGION_SAMPLE_RADIUS = 1

const EVIDENCE_LEDGER_MAX_FACTS_PER_TURN = 12000
const ROUTE_LEDGER_MAX_FACTS_PER_TURN = 4000
const CONTEXTUALIZED_HITS_MAX_PER_TURN = 4000
const MAX_CONSECUTIVE_NO_PROGRESS = 2

const SEARCH_PROTOCOL = "search-v2.13.5-task-local-impact"
const AGENT_PROTOCOL = "cpu-agent-v2.3.2-global"

const MAX_SEARCH_ATTEMPTS_PER_TURN = 6
const MAX_EXECUTED_SEARCHES_PER_TURN = 4
const MAX_TURN_EVIDENCE_BYTES = 8192

const MAX_MODEL_CALLS_PER_TURN = 4
const MAX_TURN_WALL_MS = 120_000

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_TRACKED_SESSIONS = 256

const EXCLUDES = [
  "!.git/**",
  "!.opencode/**",
  "!.agentbench/**",
  "!node_modules/**",
  "!.venv/**",
  "!venv/**",
  "!__pycache__/**",
  "!dist/**",
  "!build/**",
]

function bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8")
}

function nowMs() {
  return Date.now()
}

function clipLine(text, max = 500) {
  const line = String(text ?? "").replace(/\r?\n/g, "").trimEnd()
  return line.length <= max ? line : line.slice(0, max) + " …[line clipped]"
}

async function normalizeDirectory(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null

  try {
    const resolved = await realpath(raw)
    const info = await stat(resolved)
    return info.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

async function writeProjectTrace(root, fileName, record) {
  if (!root) return

  try {
    const dir = path.join(root, ".opencode")
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, fileName), JSON.stringify(record) + "\n", "utf8")
  } catch {
    // Telemetry is best-effort and must never break the agent.
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
      evidenceLedger: new Set(),
      routeLedger: new Set(),
      contextualizedHitLines: new Set(),
      consecutiveNoProgress: 0,
      ledgerSaturated: false,
      queryCacheMatches: 0,
      seenUsageMessages: new Set(),
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
  state.evidenceLedger.clear()
  state.routeLedger.clear()
  state.contextualizedHitLines.clear()
  state.consecutiveNoProgress = 0
  state.ledgerSaturated = false
  state.queryCacheMatches = 0
  state.seenUsageMessages.clear()
  state.lastSeen = nowMs()
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

  if (path.isAbsolute(raw)) throw new Error("absolute paths are disabled")

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

    for (const pattern of EXCLUDES) args.push("-g", pattern)
    if (glob) args.push("-g", glob)
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

  // Relevance rank is deliberately separate from fairness. Direct lexical
  // candidates are never filtered out. Query rarity is retained for telemetry
  // and fairness reservation only; it must not make a semantically weak rare
  // query outrank a stronger multi-query/path match.
  return [...byFile.values()].sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.pathAffinity - a.pathAffinity ||
      a.file.localeCompare(b.file),
  )
}

function selectFairFiles(rankedFiles, queryResults, limit) {
  const selected = new Set()
  const coveredQueries = new Set()
  const activeQueries = (queryResults ?? [])
    .map((result) => ({
      queryIndex: result.queryIndex,
      files: Array.isArray(result?.files)
        ? [...new Set(result.files)]
        : [...new Set((result?.matches ?? []).map((match) => match.file))],
    }))
    .filter((result) => result.files.length > 0)
    .sort(
      (a, b) =>
        a.files.length - b.files.length || a.queryIndex - b.queryIndex,
    )

  // Fairness is a reservation rule, not a relevance score. Reserve one direct
  // candidate for every non-empty query first, then fill the remaining slots
  // from the caller-provided relevance order.
  for (const result of activeQueries) {
    if (selected.size >= limit) break
    if (coveredQueries.has(result.queryIndex)) continue

    const fileKeys = new Set(result.files.map((file) => evidenceFileKey(file)))
    const candidate = rankedFiles.find(
      (entry) =>
        fileKeys.has(evidenceFileKey(entry.file)) &&
        !selected.has(entry.file),
    )

    if (candidate) {
      selected.add(candidate.file)
      for (const queryIndex of candidate.queries ?? []) {
        coveredQueries.add(queryIndex)
      }
    }
  }

  for (const entry of rankedFiles) {
    if (selected.size >= limit) break
    if (selected.has(entry.file)) continue
    selected.add(entry.file)
    for (const queryIndex of entry.queries ?? []) coveredQueries.add(queryIndex)
  }

  return rankedFiles.filter((entry) => selected.has(entry.file))
}

function selectProbeFiles(rankedFiles, discoveryResults) {
  return selectFairFiles(rankedFiles, discoveryResults, PROBE_MAX_FILES)
}

function declarationHint(text) {
  const line = String(text ?? "").trim()
  if (!line) return 0

  return /^(?:export\s+)?(?:async\s+)?(?:def|class|function|interface|type|enum|struct|trait|fn)\b/.test(
    line,
  )
    ? 1
    : 0
}

function rankProbedFiles(rankedFiles, probeResults) {
  const byFile = new Map(
    (rankedFiles ?? []).map((entry, index) => [
      evidenceFileKey(entry.file),
      {
        ...entry,
        initialRank: index + 1,
        probeLineHits: 0,
        probeExactMatches: 0,
        probeDefinitionHints: 0,
      },
    ]),
  )

  for (const result of probeResults ?? []) {
    for (const match of result?.matches ?? []) {
      const entry = byFile.get(evidenceFileKey(match.file))
      if (!entry) continue

      entry.probeLineHits += 1
      entry.probeExactMatches += Array.isArray(match.exactSpans)
        ? match.exactSpans.length
        : 0
      entry.probeDefinitionHints += declarationHint(match.text)
    }
  }

  // Probe evidence is deliberately weak. Coverage/path still dominate. The
  // extra line scan only breaks otherwise-ambiguous candidates using a bounded
  // definition hint and a capped exact-match signal; raw hit volume can never
  // grow without bound into a relevance score.
  return [...byFile.values()].sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.pathAffinity - a.pathAffinity ||
      b.probeDefinitionHints - a.probeDefinitionHints ||
      Math.min(PROBE_MATCH_SIGNAL_CAP, b.probeExactMatches) -
        Math.min(PROBE_MATCH_SIGNAL_CAP, a.probeExactMatches) ||
      a.initialRank - b.initialRank ||
      a.file.localeCompare(b.file),
  )
}

function selectEmitFiles(probedFiles, discoveryResults) {
  return selectFairFiles(probedFiles, discoveryResults, EMIT_MAX_FILES)
}

function filterQueryResultsToFiles(results, selectedFiles) {
  const allowed = new Set(
    (selectedFiles ?? []).map((entry) => evidenceFileKey(entry.file)),
  )

  return (results ?? []).map((result) => ({
    ...result,
    matches: (result.matches ?? []).filter((match) =>
      allowed.has(evidenceFileKey(match.file)),
    ),
  }))
}

function discoverySummaryFor(results) {
  return (results ?? []).map((result) => {
    let count = String(result.files?.length ?? 0)
    if (result.scanCapped) count = `>=${FILE_DISCOVERY_CAP_PER_QUERY}`

    let state = "complete"
    if (result.timedOut) state = "timeout"
    else if (result.scanCapped) state = "scan_cap"
    else if (result.error) state = "error"

    const errorDetail = result.error
      ? ` error=${JSON.stringify(clipLine(result.error, 240))}`
      : ""

    return `Q${result.queryIndex + 1} files=${count} discovery=${state}${errorDetail}`
  })
}

function renderRouteMap(rankedFiles, selectedFiles, bodyBudgetBytes) {
  const budget = Math.min(ROUTE_BODY_BUDGET_BYTES, bodyBudgetBytes)
  const body = []
  let bodyBytes = 0

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > budget) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  const lexicalSelected = (selectedFiles ?? []).filter((entry) => entry?.origin !== "impact")
  const retained = Math.max(0, rankedFiles.length - lexicalSelected.length)
  push(`ROUTE emitted=${selectedFiles.length} retained=${retained}`)

  for (const entry of selectedFiles) {
    if (entry?.origin === "impact") {
      const binding = (entry.impact?.bindings ?? []).join(",") || "-"
      const via = entry.impact?.seed ?? "-"
      const direction = entry.impact?.direction ?? "-"
      const validation = entry.impact?.validationKind ?? "-"
      if (!push(`  ${entry.file} [IMPACT via=${via} direction=${direction} binding=${binding} validated=${validation}]`)) break
      const sample = entry.impact?.sample
      if (Number.isInteger(sample?.line)) {
        if (!push(`    > ${sample.line} | ${clipLine(sample.text, 220)}`)) break
      }
      continue
    }

    const q = [...entry.queries]
      .sort((a, b) => a - b)
      .map((value) => `Q${value + 1}`)
      .join(",")
    if (!push(`  ${entry.file} [${q}]`)) break
  }

  if (retained > 0) push(`  +${retained} lexical candidates retained_unemitted`)
  return { body, bodyBytes, retained }
}

function runQuery(root, query, queryIndex, targets, glob) {
  return new Promise((resolve) => {
    const searchTargets = Array.isArray(targets) ? targets : [targets]

    if (searchTargets.length < 1) {
      resolve({
        query,
        queryIndex,
        matches: [],
        timedOut: false,
        scanCapped: false,
        error: null,
        scanComplete: true,
      })
      return
    }

    const args = [
      "--json",
      "--color",
      "never",
      "--max-columns",
      "500",
      "--max-columns-preview",
    ]

    for (const pattern of EXCLUDES) args.push("-g", pattern)
    if (glob) args.push("-g", glob)
    args.push("--", query, ...searchTargets)

    const child = spawn("rg", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const matches = []
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let scanCapped = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, QUERY_TIMEOUT_MS)

    function consume(line) {
      if (!line.trim() || scanCapped) return

      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }

      if (event?.type !== "match") return

      const file = event.data?.path?.text
      const lineNo = event.data?.line_number
      if (typeof file !== "string" || !Number.isInteger(lineNo)) return

      // Exactly LINE_HIT_CAP_PER_QUERY hits are complete; the next hit proves truncation.
      if (matches.length >= LINE_HIT_CAP_PER_QUERY) {
        scanCapped = true
        child.kill("SIGTERM")
        return
      }

      matches.push({
        file,
        line: lineNo,
        text: event.data?.lines?.text ?? "",
        queryIndex,
        exactSpans: exactSpansFromRgMatch(event.data, queryIndex),
        matchTexts: exactMatchTextsFromRgMatch(event.data),
      })
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")

      while (true) {
        const pos = stdout.indexOf("\n")
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
        matches,
        timedOut,
        scanCapped,
        error: String(error?.message ?? error),
        scanComplete: false,
      })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (!scanCapped && stdout.trim()) consume(stdout)
      if (settled) return
      settled = true

      let error = null
      if (!timedOut && !scanCapped && code !== 0 && code !== 1) {
        error = stderr.trim() || `rg exited with status ${code}`
      }

      resolve({
        query,
        queryIndex,
        matches,
        timedOut,
        scanCapped,
        error,
        scanComplete: !timedOut && !scanCapped && !error,
      })
    })
  })
}

async function loadLines(root, rel, cache) {
  const candidate = path.resolve(root, rel)

  let resolved
  try {
    resolved = await realpath(candidate)
  } catch {
    return null
  }

  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null

  let info
  try {
    info = await stat(resolved)
  } catch {
    return null
  }

  if (!info.isFile() || info.size > MAX_CONTEXT_FILE_BYTES) return null

  if (!cache.has(resolved)) {
    try {
      const text = await readFile(resolved, "utf8")
      cache.set(resolved, text.split(/\r?\n/))
    } catch {
      return null
    }
  }

  return cache.get(resolved)
}

function buildRanges(hitLines, totalLines) {
  const sorted = [...new Set(hitLines)].sort((a, b) => a - b)
  const ranges = []

  for (const line of sorted) {
    const start = Math.max(1, line - CONTEXT_RADIUS)
    const end = Math.min(totalLines, line + CONTEXT_RADIUS)
    const last = ranges[ranges.length - 1]

    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }

  return ranges
}

function mergeHits(results) {
  const hits = new Map()

  for (const result of results) {
    for (const match of result.matches) {
      const key = `${match.file}:${match.line}`
      let item = hits.get(key)

      if (!item) {
        item = {
          file: match.file,
          line: match.line,
          text: match.text,
          queries: new Set(),
          exactSpans: [],
        }
        hits.set(key, item)
      }

      item.queries.add(result.queryIndex)
      if (Array.isArray(match.exactSpans)) item.exactSpans.push(...match.exactSpans)
    }
  }

  return hits
}

function spanCaptureComplete(results) {
  return results.every((result) =>
    result.matches.every(
      (match) => Array.isArray(match.exactSpans) && match.exactSpans.length > 0,
    ),
  )
}

function distillerHitsFromMerged(hits) {
  const unique = new Map()

  for (const hit of hits.values()) {
    for (const span of hit.exactSpans ?? []) {
      const startByte = span?.startByte
      const endByte = span?.endByte
      const queryIndex = span?.queryIndex

      if (
        !Number.isSafeInteger(startByte) ||
        !Number.isSafeInteger(endByte) ||
        !Number.isInteger(queryIndex) ||
        startByte < 0 ||
        endByte <= startByte
      ) {
        continue
      }

      const key = `${hit.file}\0${startByte}\0${endByte}`
      const query = queryIndex + 1
      const existing = unique.get(key)

      if (!existing || query < existing.query) {
        unique.set(key, {
          file: hit.file,
          line: hit.line,
          query,
          start_byte: startByte,
          end_byte: endByte,
        })
      }
    }
  }

  return [...unique.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.start_byte - b.start_byte ||
      a.end_byte - b.end_byte ||
      a.query - b.query,
  )
}

function maxHitsInOneFile(hits) {
  const counts = new Map()
  let max = 0

  for (const hit of hits.values()) {
    const count = (counts.get(hit.file) ?? 0) + 1
    counts.set(hit.file, count)
    if (count > max) max = count
  }

  return max
}

function evidencePressure(hits, rawRendered, rawEvidenceComplete) {
  const reasons = []
  const maxHitsPerFile = maxHitsInOneFile(hits)

  if (!rawEvidenceComplete) reasons.push("raw_output_budget")
  if (rawRendered.bodyBytes >= DISTILLER_RAW_BODY_PRESSURE_BYTES) {
    reasons.push("raw_body_bytes")
  }
  if (maxHitsPerFile >= DISTILLER_MAX_HITS_PER_FILE) {
    reasons.push("hits_per_file")
  }

  return {
    active: reasons.length > 0,
    reasons,
    maxHitsPerFile,
  }
}

function distillerBinary() {
  const override = process.env.OPENCODE_EVIDENCE_DISTILLER
  if (typeof override === "string" && override.length > 0) return override

  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null

  return path.join(
    home,
    ".local",
    "libexec",
    "opencode-cpu-agent",
    "opencode-evidence-distiller",
  )
}

function runDistiller(root, hits) {
  return new Promise((resolve) => {
    const binary = distillerBinary()

    if (!binary) {
      resolve({
        ok: false,
        reason: "binary_path_unavailable",
        elapsedMs: 0,
      })
      return
    }

    const started = performance.now()
    const child = spawn(binary, [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let outputLimited = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      resolve({
        ...result,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, DISTILLER_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (stdoutBytes > DISTILLER_MAX_STDOUT_BYTES) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }

      stdout.push(Buffer.from(chunk))
    })

    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 4096) return

      const remaining = 4096 - stderrBytes
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
      stderr.push(Buffer.from(kept))
      stderrBytes += kept.length
    })

    child.stdin.on("error", () => {
      // spawn/close handlers determine the final fallback reason.
    })

    child.on("error", (error) => {
      finish({
        ok: false,
        reason: "spawn_error",
        error: String(error?.message ?? error),
      })
    })

    child.on("close", (code, signal) => {
      if (settled) return

      const stderrText = Buffer.concat(stderr).toString("utf8").trim()

      if (timedOut) {
        finish({
          ok: false,
          reason: "timeout",
          error: stderrText || null,
        })
        return
      }

      if (outputLimited) {
        finish({
          ok: false,
          reason: "stdout_limit",
          error: stderrText || null,
        })
        return
      }

      if (code !== 0) {
        finish({
          ok: false,
          reason: "exit_error",
          exitCode: code,
          signal: signal ?? null,
          error: stderrText || null,
        })
        return
      }

      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (error) {
        finish({
          ok: false,
          reason: "invalid_json",
          error: String(error?.message ?? error),
        })
        return
      }

      // Rolling-upgrade compatibility: an old v2 helper is recognized, but its
      // summary-only output is never allowed to replace raw evidence. v3 keeps
      // v2's grouping idea inside enriched groups and adds witness variants.
      if (response?.protocol === "evidence-distiller-v2") {
        finish({
          ok: false,
          reason: "legacy_v2_summary_only",
          response,
        })
        return
      }

      if (
        response?.protocol !== "evidence-distiller-v3" ||
        response?.representation !== "evidence_ir" ||
        response?.ir_complete !== true ||
        response?.location_complete !== true ||
        response?.anchor_complete !== true ||
        response?.witness_complete !== true ||
        response?.v2_grouping_preserved !== true ||
        response?.raw_hits !== hits.length ||
        !Array.isArray(response?.groups) ||
        response.groups.length < 1 ||
        response?.groups_shown !== response.groups.length ||
        response?.variants_shown !== response?.variants_total
      ) {
        finish({
          ok: false,
          reason: "unsafe_ir",
          response,
        })
        return
      }

      finish({
        ok: true,
        reason: "ir_complete",
        response,
      })
    })

    try {
      child.stdin.end(
        JSON.stringify({
          root,
          hits,
          budget_bytes: DISTILLER_IR_BUDGET_BYTES,
        }),
      )
    } catch (error) {
      child.kill("SIGKILL")
      finish({
        ok: false,
        reason: "stdin_error",
        error: String(error?.message ?? error),
      })
    }
  })
}


function impactIndexBinary() {
  const override = process.env.OPENCODE_IMPACT_INDEX
  if (typeof override === "string" && override.length > 0) return override
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(home, ".local", "libexec", "opencode-cpu-agent", "opencode-impact-index")
}

function runImpactIndexRequest(root, request, timeoutMs) {
  return new Promise((resolve) => {
    const binary = impactIndexBinary()
    if (!binary) {
      resolve({ ok: false, reason: "binary_path_unavailable", elapsedMs: 0 })
      return
    }
    const started = performance.now()
    const child = spawn(binary, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let outputLimited = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > IMPACT_INDEX_MAX_STDOUT_BYTES) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 4096) return
      const remaining = 4096 - stderrBytes
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
      stderr.push(Buffer.from(kept))
      stderrBytes += kept.length
    })
    child.stdin.on("error", () => {})
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", error: String(error?.message ?? error) }))
    child.on("close", (code, signal) => {
      if (settled) return
      const stderrText = Buffer.concat(stderr).toString("utf8").trim()
      if (timedOut) return finish({ ok: false, reason: "timeout", error: stderrText || null })
      if (outputLimited) return finish({ ok: false, reason: "stdout_limit", error: stderrText || null })
      if (code !== 0) return finish({ ok: false, reason: "exit_error", exitCode: code, signal: signal ?? null, error: stderrText || null })
      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (error) {
        return finish({ ok: false, reason: "invalid_json", error: String(error?.message ?? error) })
      }
      if (response?.protocol !== "impact-index-v1") return finish({ ok: false, reason: "protocol_mismatch", response })
      finish({ ok: true, reason: "ok", response })
    })
    try {
      child.stdin.end(JSON.stringify({ root, ...request }))
    } catch (error) {
      child.kill("SIGKILL")
      finish({ ok: false, reason: "stdin_error", error: String(error?.message ?? error) })
    }
  })
}

function impactIndexShadowStats(result, lexicalFiles) {
  const lexical = new Set((lexicalFiles ?? []).map((entry) =>
    evidenceFileKey(typeof entry === "string" ? entry : entry?.file),
  ))
  const neighbors = result?.ok && Array.isArray(result?.query?.response?.neighbors)
    ? result.query.response.neighbors
    : []
  const lexicalMisses = neighbors.filter((neighbor) =>
    typeof neighbor?.file === "string" && !lexical.has(evidenceFileKey(neighbor.file)),
  )
  const refresh = result?.refresh?.response ?? null
  const query = result?.query?.response ?? null

  return {
    attempted: result?.attempted === true,
    ok: result?.ok === true,
    reason: result?.reason ?? "unknown",
    elapsedMs: result?.elapsedMs ?? 0,
    refreshDue: result?.refreshDue === true,
    refreshDeferred: result?.refreshDeferred === true,
    refreshOk:
      result?.refresh?.ok === true &&
      refresh?.mode === "refresh" &&
      refresh?.ready === true,
    refreshComplete: query?.coverage_complete ?? refresh?.coverage_complete ?? refresh?.refresh_complete ?? null,
    partialReason: query?.partial_reason ?? refresh?.partial_reason ?? null,
    inventoryKind: query?.inventory_kind ?? refresh?.inventory_kind ?? null,
    refreshReason: result?.refresh?.reason ?? null,
    refreshElapsedMs: result?.refresh?.elapsedMs ?? null,
    queryElapsedMs: result?.query?.elapsedMs ?? null,
    cacheAgeMs: query?.cache_age_ms ?? null,
    staleSeedFiles: query?.stale_seed_files ?? 0,
    staleWitnessEdges: query?.stale_witness_edges ?? 0,
    taskFiltersApplied: query?.task_filters_applied === true,
    bootstrapCacheHit: false,
    filesTotal: query?.files_total ?? refresh?.files_total ?? null,
    filesReused: refresh?.files_reused ?? null,
    filesReindexed: refresh?.files_reindexed ?? null,
    filesRemoved: refresh?.files_removed ?? null,
    importsTotal: query?.imports_total ?? refresh?.imports_total ?? null,
    edgesTotal: query?.edges_total ?? refresh?.edges_total ?? null,
    resolvedImports: query?.local_resolved ?? refresh?.local_resolved ?? refresh?.resolved_imports ?? null,
    unresolvedImports: query?.local_unresolved ?? refresh?.local_unresolved ?? null,
    ambiguousImports: query?.local_ambiguous ?? refresh?.local_ambiguous ?? null,
    externalPackages: query?.external_package ?? refresh?.external_package ?? null,
    unsupportedAliases: query?.unsupported_alias ?? refresh?.unsupported_alias ?? null,
    unsupportedDynamic: query?.unsupported_dynamic ?? refresh?.unsupported_dynamic ?? null,
    neighborsTotal: query?.neighbors_total ?? null,
    neighborsShown: neighbors.length,
    lexicalMisses: lexicalMisses.length,
    forwardNeighbors: neighbors.filter((neighbor) => neighbor?.direction === "forward").length,
    reverseNeighbors: neighbors.filter((neighbor) => neighbor?.direction === "reverse").length,
    candidates: lexicalMisses.slice(0, IMPACT_INDEX_MAX_NEIGHBORS).map((neighbor) => ({
      file: neighbor.file,
      seed: neighbor.seed,
      direction: neighbor.direction,
      kind: neighbor.kind,
      confidence: neighbor.confidence,
      witness_file: neighbor.witness_file,
      witness_line: neighbor.witness_line,
      spec: neighbor.spec,
      bindings: Array.isArray(neighbor.bindings) ? neighbor.bindings : [],
      source_symbols: Array.isArray(neighbor.source_symbols) ? neighbor.source_symbols : [],
      binding_pairs: Array.isArray(neighbor.binding_pairs) ? neighbor.binding_pairs : [],
      witness: neighbor.witness ?? null,
    })),
  }
}

function impactStatsForTaskQuery(queryResult, lexicalFiles, reason = "impact_task_filtered", refresh = null) {
  const response = queryResult?.response ?? null
  const age = Number(response?.cache_age_ms)
  const ready =
    queryResult?.ok === true &&
    response?.mode === "neighbors" &&
    response?.ready === true &&
    Array.isArray(response?.neighbors)
  const staleSeedFiles = Number(response?.stale_seed_files ?? 0)
  const staleWitnessEdges = Number(response?.stale_witness_edges ?? 0)
  const refreshDue =
    queryResult?.ok === true && (
      !ready ||
      !Number.isFinite(age) ||
      age >= IMPACT_INDEX_REFRESH_TTL_MS ||
      staleSeedFiles > 0 ||
      staleWitnessEdges > 0
    )
  return impactIndexShadowStats({
    attempted: true,
    ok: ready,
    reason: ready ? reason : queryResult?.reason ?? "query_unavailable",
    elapsedMs: queryResult?.elapsedMs ?? 0,
    refreshDue,
    refreshDeferred: ready && refreshDue,
    refresh,
    query: queryResult,
  }, lexicalFiles)
}

function regexEscape(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function impactSymbolArray(values, cap = IMPACT_EDGE_SYMBOL_CAP) {
  const out = []
  for (const value of values ?? []) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ||
      value.length > 80
    ) continue
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

function impactBindingList(values) {
  return [...new Set(impactSymbolArray(values, IMPACT_BINDINGS_PER_CANDIDATE))]
}

function impactRelationPairs(candidate) {
  const local = impactSymbolArray(candidate?.bindings)
  const source = impactSymbolArray(candidate?.source_symbols)
  const explicit = []
  for (const pair of candidate?.binding_pairs ?? []) {
    const localName = typeof pair?.local === "string" ? pair.local : null
    const sourceName = typeof pair?.source === "string" ? pair.source : null
    if (!localName || !sourceName) continue
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(localName) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sourceName)) continue
    explicit.push({ local: localName, source: sourceName })
    if (explicit.length >= IMPACT_EDGE_SYMBOL_CAP) break
  }
  if (explicit.length > 0) return { local, source, pairs: explicit }

  // Fail-open only for identity mappings. Old caches are rejected by cache
  // version, but this keeps helper skew conservative instead of guessing alias
  // alignment from two independently ordered arrays.
  const pairs = []
  if (local.length === source.length && local.every((value, index) => value === source[index])) {
    for (let i = 0; i < local.length; i += 1) pairs.push({ local: local[i], source: source[i] })
  }
  return { local, source, pairs }
}

function impactLanguage(file) {
  const base = path.basename(String(file ?? "")).toLowerCase()
  if (base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "docker"
  const ext = path.extname(base).slice(1)
  if (ext === "py") return "python"
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript"
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript"
  if (["html", "htm"].includes(ext)) return "html"
  if (ext === "css") return "css"
  if (["xml", "xsd", "xsl", "xslt"].includes(ext)) return "xml"
  if (ext === "sql") return "sql"
  return "other"
}

function impactIdentifiers(text) {
  const out = new Set()
  const stop = new Set([
    "and", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "def", "default", "do", "else", "except", "export", "extends", "false", "finally", "for",
    "from", "function", "if", "import", "in", "interface", "let", "new", "none", "null", "of",
    "pass", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "var",
    "while", "with", "yield",
  ])
  const pattern = /[A-Za-z_$][A-Za-z0-9_$]*/g
  for (const match of String(text ?? "").matchAll(pattern)) {
    const value = match[0]
    // One-character local aliases are common in Python/JS/TS (for example
    // `import { handle as h } ...`). Candidate matching remains exact and is
    // followed by source validation, so retaining them is safer than silently
    // losing a real dependency edge.
    if (value.length < 1 || stop.has(value.toLowerCase())) continue
    out.add(value)
    if (out.size >= IMPACT_SCOPE_IDENTIFIER_CAP) break
  }
  return out
}

function impactDeclaredSymbols(line, language) {
  const text = String(line ?? "").trim()
  const out = new Set()
  const patterns = language === "python"
    ? [
        /^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/,
      ]
    : [
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:export\s+)?(?:default\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:(?:public|private|protected|static|readonly|async|abstract|override|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\)\s*(?::[^={]+)?\s*\{?/,
      ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match?.[1]) continue
    const value = match[1]
    if (!["if", "for", "while", "switch", "catch", "function", "constructor"].includes(value)) out.add(value)
  }
  return out
}

function impactPythonOwnerSymbols(lines, ranges, hitLines) {
  const owners = new Set()
  for (const range of ranges ?? []) {
    const start = Math.max(0, range.start ?? 0)
    for (const value of impactDeclaredSymbols(lines[start] ?? "", "python")) owners.add(value)
    const baseIndent = impactIndent(lines[start] ?? "")
    let ceilingIndent = baseIndent
    for (let i = start - 1; i >= Math.max(0, start - IMPACT_SCOPE_MAX_LINES); i -= 1) {
      const line = lines[i] ?? ""
      const match = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
      if (!match) continue
      const indent = impactIndent(line)
      if (indent < ceilingIndent) {
        owners.add(match[1]); ceilingIndent = indent
        if (indent === 0) break
      }
    }
  }
  for (const lineNo of hitLines ?? []) {
    for (const value of impactDeclaredSymbols(lines[Math.max(0, lineNo - 1)] ?? "", "python")) owners.add(value)
  }
  return owners
}

function impactBraceEnclosingOwner(lines, start) {
  let depth = 0
  for (let i = start - 1; i >= Math.max(0, start - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i] ?? ""
    for (let j = line.length - 1; j >= 0; j -= 1) {
      const ch = line[j]
      if (ch === "}") depth += 1
      else if (ch === "{") {
        if (depth > 0) depth -= 1
        else {
          for (const value of impactDeclaredSymbols(line, "typescript")) return value
        }
      }
    }
  }
  return null
}

function impactBraceOwnerSymbols(lines, ranges, hitLines, language) {
  const owners = new Set()
  for (const range of ranges ?? []) {
    const start = Math.max(0, range.start ?? 0)
    const end = Math.min(lines.length - 1, start + 5)
    for (let i = Math.max(0, start - 2); i <= end; i += 1) {
      for (const value of impactDeclaredSymbols(lines[i] ?? "", language)) owners.add(value)
    }
    const enclosing = impactBraceEnclosingOwner(lines, start)
    if (enclosing) owners.add(enclosing)
  }
  for (const lineNo of hitLines ?? []) {
    for (const value of impactDeclaredSymbols(lines[Math.max(0, lineNo - 1)] ?? "", language)) owners.add(value)
  }
  return owners
}

function impactOwnerSymbols(lines, ranges, hitLines, language) {
  if (!Array.isArray(lines)) return new Set()
  if (language === "python") return impactPythonOwnerSymbols(lines, ranges, hitLines)
  if (["javascript", "typescript"].includes(language)) return impactBraceOwnerSymbols(lines, ranges, hitLines, language)
  return new Set()
}

function impactIndent(line) {
  const match = String(line ?? "").match(/^[ \t]*/)
  return match ? match[0].replace(/\t/g, "    ").length : 0
}

function impactWindowRange(lines, lineNo, radius = IMPACT_SCOPE_WINDOW_RADIUS) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  return {
    start: Math.max(0, center - radius),
    end: Math.min(lines.length - 1, center + radius),
  }
}

function impactPythonRange(lines, lineNo) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  const hitIndent = impactIndent(lines[center])
  const defPattern = /^\s*(?:async\s+def|def|class)\s+[A-Za-z_][A-Za-z0-9_]*\b/
  let start = -1
  let baseIndent = -1

  for (let i = center; i >= Math.max(0, center - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i]
    if (!defPattern.test(line)) continue
    const indent = impactIndent(line)
    if (indent <= hitIndent) {
      start = i
      baseIndent = indent
      break
    }
  }

  if (start < 0) return impactWindowRange(lines, lineNo)
  let end = Math.min(lines.length - 1, start + IMPACT_SCOPE_MAX_LINES - 1)
  for (let i = start + 1; i < lines.length && i <= end; i += 1) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (impactIndent(lines[i]) <= baseIndent && !/^\s*@/.test(lines[i])) {
      end = i - 1
      break
    }
  }
  return { start, end }
}

function impactBraceRange(lines, lineNo) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  let balance = 0
  let start = -1
  for (let i = center; i >= Math.max(0, center - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i]
    for (let j = line.length - 1; j >= 0; j -= 1) {
      if (line[j] === "}") balance += 1
      else if (line[j] === "{") {
        if (balance === 0) {
          start = i
          break
        }
        balance -= 1
      }
    }
    if (start >= 0) break
  }
  if (start < 0) return impactWindowRange(lines, lineNo)

  balance = 0
  let end = Math.min(lines.length - 1, start + IMPACT_SCOPE_MAX_LINES - 1)
  outer: for (let i = start; i < lines.length && i <= end; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") balance += 1
      else if (ch === "}") {
        balance -= 1
        if (balance <= 0) {
          end = i
          break outer
        }
      }
    }
  }
  return { start, end }
}

function impactRangeForLanguage(lines, lineNo, language) {
  if (language === "python") return impactPythonRange(lines, lineNo)
  if (["javascript", "typescript", "css"].includes(language)) return impactBraceRange(lines, lineNo)
  return impactWindowRange(lines, lineNo)
}

function impactMergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

async function buildImpactSeedContexts(root, probeResults) {
  const byFile = new Map()
  for (const hit of mergeHits(probeResults).values()) {
    const file = evidenceFileKey(hit.file)
    let entry = byFile.get(file)
    if (!entry) {
      entry = { file, hitLines: new Set(), fallbackText: [] }
      byFile.set(file, entry)
    }
    entry.hitLines.add(hit.line)
    entry.fallbackText.push(hit.text ?? "")
  }

  const contexts = new Map()
  await Promise.all([...byFile.values()].map(async (entry) => {
    const language = impactLanguage(entry.file)
    const resolved = path.resolve(root, entry.file)
    let lines = null
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      try {
        const source = await readFile(resolved, "utf8")
        if (bytes(source) <= MAX_CONTEXT_FILE_BYTES) lines = source.split(/\r?\n/)
      } catch {}
    }

    const ranges = []
    const chunks = []
    if (lines) {
      for (const lineNo of [...entry.hitLines].slice(0, 12)) {
        ranges.push(impactRangeForLanguage(lines, lineNo, language))
      }
      for (const range of impactMergeRanges(ranges)) {
        chunks.push(lines.slice(range.start, range.end + 1).join("\n"))
      }
    } else {
      chunks.push(...entry.fallbackText)
    }

    const mergedRanges = impactMergeRanges(ranges)
    const text = chunks.join("\n")
    contexts.set(entry.file, {
      file: entry.file,
      language,
      identifiers: impactIdentifiers(text),
      ownerSymbols: impactOwnerSymbols(lines, mergedRanges, entry.hitLines, language),
      ranges: mergedRanges,
      text,
      hitLines: entry.hitLines,
    })
  }))
  return contexts
}

function impactFilterSymbols(values, cap = IMPACT_FILTER_SYMBOL_CAP) {
  const out = []
  const seen = new Set()
  for (const value of values ?? []) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ||
      value.length > 80 ||
      seen.has(value)
    ) continue
    seen.add(value)
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

function impactSeedFilters(seedContexts) {
  return [...seedContexts.entries()].map(([seed, context]) => ({
    seed,
    forward_bindings: impactFilterSymbols(context?.identifiers),
    reverse_source_symbols: impactFilterSymbols(context?.ownerSymbols),
  }))
}

async function runTaskFilteredImpactQuery(root, seedContexts) {
  const seedFilters = impactSeedFilters(seedContexts)
  const seeds = seedFilters.map((entry) => entry.seed)
  if (seeds.length < 1) return null
  return await runImpactIndexRequest(
    root,
    {
      mode: "neighbors",
      seed_files: seeds,
      seed_filters: seedFilters,
      max_neighbors: IMPACT_INDEX_MAX_NEIGHBORS,
      check_freshness: true,
    },
    IMPACT_INDEX_QUERY_TIMEOUT_MS,
  )
}

function impactMatchedForwardSymbols(candidate, context) {
  const { local, source, pairs } = impactRelationPairs(candidate)
  const matched = []
  if (pairs.length > 0) {
    for (const pair of pairs) {
      if (context?.identifiers?.has(pair.local)) matched.push(pair.source)
    }
    return [...new Set(matched)].slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
  }
  const matchedLocals = local.filter((value) => context?.identifiers?.has(value))
  if (matchedLocals.length < 1 || source.length > 0) return []
  return impactMemberSymbols(context, matchedLocals).slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
}

function impactMatchedReverseBindings(candidate, context) {
  const { pairs } = impactRelationPairs(candidate)
  const matched = []
  for (const pair of pairs) {
    if (context?.ownerSymbols?.has(pair.source)) matched.push(pair.local)
  }
  return [...new Set(matched)].slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
}

function impactMemberSymbols(context, bindings) {
  const out = new Set()
  for (const binding of [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))]) {
    const pattern = new RegExp(`\\b${regexEscape(binding)}\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, "g")
    for (const match of context?.text?.matchAll(pattern) ?? []) {
      out.add(match[1])
      if (out.size >= IMPACT_VALIDATION_SYMBOL_CAP) return [...out]
    }
  }
  return [...out]
}

async function impactExpansionScope(root, target) {
  if (target === "." || target === "./" || target === "") return { kind: "root", root }
  const candidate = path.resolve(root, target)
  let resolved
  let info
  try {
    resolved = await realpath(candidate)
    info = await stat(resolved)
  } catch {
    return { kind: "blocked", reason: "target_unavailable" }
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return { kind: "blocked", reason: "target_outside_root" }
  if (info.isFile()) return { kind: "blocked", reason: "explicit_file_scope" }
  if (!info.isDirectory()) return { kind: "blocked", reason: "target_not_directory" }
  return { kind: "directory", root: resolved }
}

function impactFileAllowedByScope(root, file, scope) {
  if (!scope || scope.kind === "blocked") return false
  const resolved = path.resolve(root, evidenceFileKey(file))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false
  if (scope.kind === "root") return true
  return resolved === scope.root || resolved.startsWith(scope.root + path.sep)
}

function buildImpactHypotheses(impactStats, probeFiles, seedContexts, root, scope) {
  if (!impactStats?.ok || !Array.isArray(impactStats?.candidates)) return { hypotheses: [], rejectedByScope: 0 }

  const lexical = new Set((probeFiles ?? []).map((entry) => evidenceFileKey(entry.file)))
  const seedQueries = new Map((probeFiles ?? []).map((entry) => [evidenceFileKey(entry.file), new Set(entry.queries ?? [])]))
  const grouped = new Map()
  let rejectedByScope = 0

  for (const candidate of impactStats.candidates) {
    const file = evidenceFileKey(candidate?.file)
    const seed = evidenceFileKey(candidate?.seed)
    if (!file || !seed || lexical.has(file)) continue
    if (candidate?.confidence !== "exact_local") continue
    if (!impactFileAllowedByScope(root, file, scope)) continue

    const context = seedContexts.get(seed)
    if (!context) {
      rejectedByScope += 1
      continue
    }

    let forwardSymbols = []
    let reverseBindings = []
    if (candidate.direction === "forward") {
      forwardSymbols = impactMatchedForwardSymbols(candidate, context)
    } else if (candidate.direction === "reverse") {
      reverseBindings = impactMatchedReverseBindings(candidate, context)
    }

    if (forwardSymbols.length < 1 && reverseBindings.length < 1) {
      rejectedByScope += 1
      continue
    }

    const rawLocal = impactSymbolArray(candidate?.bindings)
    const rawSource = impactSymbolArray(candidate?.source_symbols)
    let entry = grouped.get(file)
    if (!entry) {
      entry = {
        file,
        queries: new Set(),
        relations: [],
        forwardSymbols: new Set(),
        reverseBindings: new Set(),
        displayBindings: new Set(),
        hasForward: false,
        hasReverse: false,
      }
      grouped.set(file, entry)
    }

    for (const queryIndex of seedQueries.get(seed) ?? []) entry.queries.add(queryIndex)
    for (const symbol of forwardSymbols) entry.forwardSymbols.add(symbol)
    for (const binding of reverseBindings) entry.reverseBindings.add(binding)
    for (const value of [...rawLocal, ...rawSource]) entry.displayBindings.add(value)
    entry.hasForward ||= candidate.direction === "forward"
    entry.hasReverse ||= candidate.direction === "reverse"
    entry.relations.push({ ...candidate, file, seed, bindings: rawLocal, source_symbols: rawSource })
  }

  const hypotheses = [...grouped.values()]
    .map((entry) => ({
      ...entry,
      forwardSymbols: [...entry.forwardSymbols].slice(0, IMPACT_VALIDATION_SYMBOL_CAP),
      reverseBindings: [...entry.reverseBindings].slice(0, IMPACT_VALIDATION_SYMBOL_CAP),
      displayBindings: [...entry.displayBindings].slice(0, IMPACT_BINDINGS_PER_CANDIDATE),
    }))
    .filter((entry) => entry.forwardSymbols.length > 0 || entry.reverseBindings.length > 0)
    .sort(
      (a, b) =>
        Number(b.hasForward) - Number(a.hasForward) ||
        b.queries.size - a.queries.size ||
        (b.forwardSymbols.length + b.reverseBindings.length) - (a.forwardSymbols.length + a.reverseBindings.length) ||
        a.file.localeCompare(b.file),
    )
    // This is the actual graph-file probe budget. We deliberately do not hide
    // extra deterministic file reads behind a larger "validation pool".
    .slice(0, IMPACT_GRAPH_PROBE_MAX_FILES)

  return { hypotheses, rejectedByScope }
}

function runImpactValidationQuery(root, file, bindings, glob) {
  return new Promise((resolve) => {
    const escaped = [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))].map(regexEscape)
    if (escaped.length < 1) {
      resolve({ ok: false, reason: "no_bindings", matches: [], scanComplete: true, elapsedMs: 0 })
      return
    }
    const pattern = escaped.length === 1 ? escaped[0] : `(?:${escaped.join("|")})`
    const args = ["--json", "--color", "never", "--max-columns", "500", "--max-columns-preview"]
    for (const exclude of EXCLUDES) args.push("-g", exclude)
    if (glob) args.push("-g", glob)
    args.push("--", pattern, file)

    const started = performance.now()
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    const matches = []
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let capped = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, pattern, matches, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, IMPACT_VALIDATION_TIMEOUT_MS)

    function consume(line) {
      if (!line.trim() || capped) return
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event?.type !== "match") return
      const matchFile = event.data?.path?.text
      const lineNo = event.data?.line_number
      if (typeof matchFile !== "string" || !Number.isInteger(lineNo)) return
      if (matches.length >= IMPACT_VALIDATION_HIT_CAP) { capped = true; child.kill("SIGTERM"); return }
      matches.push({ file: matchFile, line: lineNo, text: event.data?.lines?.text ?? "", exactMatches: Array.isArray(event.data?.submatches) ? event.data.submatches.length : 0 })
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
      while (true) {
        const pos = stdout.indexOf("\n")
        if (pos < 0) break
        consume(stdout.slice(0, pos))
        stdout = stdout.slice(pos + 1)
      }
    })
    child.stderr.on("data", (chunk) => { if (stderr.length < 2000) stderr += chunk.toString("utf8") })
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", scanComplete: false, error: String(error?.message ?? error) }))
    child.on("close", (code) => {
      if (!capped && stdout.trim()) consume(stdout)
      if (timedOut) return finish({ ok: false, reason: "timeout", scanComplete: false, error: stderr.trim() || null })
      if (capped) return finish({ ok: true, reason: "hit_cap", scanComplete: false, error: null })
      if (code !== 0 && code !== 1) return finish({ ok: false, reason: "exit_error", scanComplete: false, error: stderr.trim() || `rg exited with status ${code}` })
      finish({ ok: true, reason: "complete", scanComplete: true, error: null })
    })
  })
}

function impactDefinitionMatch(text, bindings) {
  const line = String(text ?? "").trim()
  if (!line) return false
  for (const binding of bindings ?? []) {
    const name = regexEscape(binding)
    const patterns = [
      new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:def|class|function|interface|type|enum)\\s+${name}\\b`),
      new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`),
      new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|type|const|static)\\s+${name}\\b`),
    ]
    if (patterns.some((pattern) => pattern.test(line))) return true
  }
  return false
}

function impactLineContainsBinding(text, bindings) {
  const line = String(text ?? "")
  return [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))]
    .some((binding) => new RegExp(`\\b${regexEscape(binding)}\\b`).test(line))
}

async function validateImpactHypotheses(root, target, glob, probeFiles, probeResults) {
  const scope = await impactExpansionScope(root, target)
  const emptyStats = impactIndexShadowStats({
    attempted: false, ok: false, reason: scope.kind === "blocked" ? scope.reason : "not_queried",
    elapsedMs: 0, refreshDue: false, refreshDeferred: false, refresh: null, query: null,
  }, probeFiles)
  if (scope.kind === "blocked") {
    return {
      attempted: false, reason: scope.reason, hypotheses: [], validated: [], rejected: [], elapsedMs: 0,
      queryCount: 0, scopeRejected: 0, seedContexts: 0, ownerSymbols: 0,
      filterQueryUsed: false, filterQueryElapsedMs: null, refreshFallbackAttempted: false,
      refreshFallbackElapsedMs: null, pairwiseConditioned: true, indexStats: emptyStats,
    }
  }

  const seedContexts = await buildImpactSeedContexts(root, probeResults)
  const ownerSymbols = [...seedContexts.values()].reduce((sum, context) => sum + (context.ownerSymbols?.size ?? 0), 0)
  let filterQueryUsed = false
  let filterQueryElapsedMs = null
  let refreshFallbackAttempted = false
  let refreshFallbackElapsedMs = null
  let refresh = null

  async function queryTaskGraph(reason) {
    const query = await runTaskFilteredImpactQuery(root, seedContexts)
    filterQueryUsed = query != null
    if (query) filterQueryElapsedMs = (filterQueryElapsedMs ?? 0) + (query.elapsedMs ?? 0)
    return query ? impactStatsForTaskQuery(query, probeFiles, reason, refresh) : emptyStats
  }

  async function validateStats(stats) {
    const built = buildImpactHypotheses(stats, probeFiles, seedContexts, root, scope)
    const hypotheses = built.hypotheses
    if (hypotheses.length < 1) {
      return {
        attempted: false,
        reason: stats?.ok ? "no_scope_relevant_hypotheses" : "impact_index_unavailable",
        hypotheses: [], validated: [], rejected: [], elapsedMs: 0, queryCount: 0,
        scopeRejected: built.rejectedByScope,
      }
    }

    const started = performance.now()
    const checks = await Promise.all(hypotheses.map(async (hypothesis) => {
      const validationTerms = [...new Set([...hypothesis.forwardSymbols, ...hypothesis.reverseBindings])]
      const validation = await runImpactValidationQuery(root, hypothesis.file, validationTerms, glob)
      const matches = validation.matches ?? []
      const declarationMatches = matches.filter((match) => impactDefinitionMatch(match.text, hypothesis.forwardSymbols))
      const reverseWitnessLines = new Set(
        hypothesis.relations
          .filter((relation) => relation.direction === "reverse" && evidenceFileKey(relation.witness_file) === evidenceFileKey(hypothesis.file) && Number.isInteger(relation.witness_line))
          .map((relation) => relation.witness_line),
      )
      const reverseUsageMatches = matches.filter(
        (match) => !reverseWitnessLines.has(match.line) && impactLineContainsBinding(match.text, hypothesis.reverseBindings),
      )
      const forwardValidated = hypothesis.forwardSymbols.length > 0 && declarationMatches.length > 0
      const reverseValidated = hypothesis.reverseBindings.length > 0 && reverseUsageMatches.length > 0
      const validated = validation.ok && (forwardValidated || reverseValidated)

      return {
        ...hypothesis,
        validation,
        validated,
        validationKind: forwardValidated ? "forward_scope_definition" : reverseValidated ? "reverse_scope_usage" : null,
        declarationMatches,
        reverseUsageMatches,
      }
    }))

    const validated = checks.filter((entry) => entry.validated).sort(
      (a, b) =>
        Number(b.validationKind === "forward_scope_definition") - Number(a.validationKind === "forward_scope_definition") ||
        b.queries.size - a.queries.size || a.file.localeCompare(b.file),
    )
    return {
      attempted: true,
      reason: validated.length > 0 ? "validated_scope_conditioned" : "all_rejected",
      hypotheses,
      validated,
      rejected: checks.filter((entry) => !entry.validated),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      queryCount: checks.length,
      scopeRejected: built.rejectedByScope,
    }
  }

  let indexStats = await queryTaskGraph("impact_task_filtered")
  const initialIndexStats = {
    refreshDue: indexStats?.refreshDue === true,
    staleSeedFiles: Number(indexStats?.staleSeedFiles ?? 0),
    staleWitnessEdges: Number(indexStats?.staleWitnessEdges ?? 0),
    reason: indexStats?.reason ?? null,
    cacheAgeMs: indexStats?.cacheAgeMs ?? null,
  }
  let result = await validateStats(indexStats)

  // A stale graph is only a hypothesis. We can reuse a source-validated edge
  // when its import witness file is unchanged. If task-local routing misses and
  // the helper reports age/fingerprint staleness (or no readable cache), do one
  // synchronous refresh and one filtered retry.
  if (result.validated.length < 1 && indexStats.refreshDue === true) {
    refreshFallbackAttempted = true
    refresh = await runImpactIndexRequest(root, { mode: "refresh" }, IMPACT_INDEX_REFRESH_TIMEOUT_MS)
    refreshFallbackElapsedMs = refresh?.elapsedMs ?? null
    if (refresh?.ok === true && refresh.response?.ready === true) {
      indexStats = await queryTaskGraph("impact_refreshed_task_filtered")
      indexStats.refresh = refresh
      indexStats.refreshOk = true
      indexStats.refreshElapsedMs = refresh.elapsedMs ?? null
      result = await validateStats(indexStats)
    }
  }

  return {
    ...result,
    seedContexts: seedContexts.size,
    ownerSymbols,
    filterQueryUsed,
    filterQueryElapsedMs,
    refreshFallbackAttempted,
    refreshFallbackElapsedMs,
    initialIndexStats,
    pairwiseConditioned: true,
    indexStats,
  }
}

function selectFairReservedFiles(rankedFiles, queryResults, limit) {
  const selected = new Set()
  const coveredQueries = new Set()
  const activeQueries = (queryResults ?? [])
    .map((result) => ({
      queryIndex: result.queryIndex,
      files: Array.isArray(result?.files)
        ? [...new Set(result.files)]
        : [...new Set((result?.matches ?? []).map((match) => match.file))],
    }))
    .filter((result) => result.files.length > 0)
    .sort((a, b) => a.files.length - b.files.length || a.queryIndex - b.queryIndex)

  for (const result of activeQueries) {
    if (selected.size >= limit) break
    if (coveredQueries.has(result.queryIndex)) continue
    const fileKeys = new Set(result.files.map((file) => evidenceFileKey(file)))
    const candidate = rankedFiles.find(
      (entry) => fileKeys.has(evidenceFileKey(entry.file)) && !selected.has(entry.file),
    )
    if (!candidate) continue
    selected.add(candidate.file)
    for (const queryIndex of candidate.queries ?? []) coveredQueries.add(queryIndex)
  }

  return rankedFiles.filter((entry) => selected.has(entry.file))
}

function impactEmitEntry(entry) {
  const primary = entry.relations?.[0] ?? {}
  const sample = entry.validationKind === "forward_scope_definition"
    ? entry.declarationMatches?.[0]
    : entry.reverseUsageMatches?.[0]
  return {
    file: entry.file,
    origin: "impact",
    queries: new Set(entry.queries ?? []),
    coverage: 0,
    pathAffinity: 0,
    rarity: 0,
    impact: {
      seed: primary.seed ?? null,
      direction: entry.validationKind === "forward_scope_definition" ? "forward" : "reverse",
      kind: primary.kind ?? null,
      bindings: entry.displayBindings ?? [],
      validationKind: entry.validationKind,
      sample: sample ?? null,
    },
  }
}

function selectEmitFilesWithImpact(probedFiles, discoveryResults, validatedImpact) {
  const selected = []
  const selectedKeys = new Set()

  const reserve = selectFairReservedFiles(probedFiles, discoveryResults, EMIT_MAX_FILES)
  for (const entry of reserve) {
    if (selected.length >= EMIT_MAX_FILES) break
    selected.push({ ...entry, origin: "lexical" })
    selectedKeys.add(evidenceFileKey(entry.file))
  }

  let impactEmitted = 0
  for (const entry of validatedImpact ?? []) {
    if (selected.length >= EMIT_MAX_FILES || impactEmitted >= IMPACT_GRAPH_EMIT_MAX_FILES) break
    const key = evidenceFileKey(entry.file)
    if (selectedKeys.has(key)) continue
    selected.push(impactEmitEntry(entry))
    selectedKeys.add(key)
    impactEmitted += 1
  }

  for (const entry of probedFiles ?? []) {
    if (selected.length >= EMIT_MAX_FILES) break
    const key = evidenceFileKey(entry.file)
    if (selectedKeys.has(key)) continue
    selected.push({ ...entry, origin: "lexical" })
    selectedKeys.add(key)
  }

  return selected
}

function impactEvidenceFactsForSelected(selectedFiles) {
  const facts = new Set()
  for (const entry of selectedFiles ?? []) {
    if (entry?.origin !== "impact") continue
    const sample = entry?.impact?.sample
    if (typeof entry?.file === "string" && Number.isInteger(sample?.line)) {
      facts.add(hitLineFact(entry.file, sample.line))
    }
  }
  return facts
}

function integerList(values) {
  if (!Array.isArray(values)) return null

  const result = [...new Set(values)]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b)

  return result.length > 0 ? result : null
}

function lineList(values) {
  const lines = integerList(values)
  return lines ? lines.join(",") : "-"
}

function queryLabels(values) {
  const queries = integerList(values)
  return queries ? queries.map((value) => `Q${value}`).join(",") : null
}

function validateEvidenceGroup(group) {
  if (
    typeof group?.file !== "string" ||
    typeof group?.symbol_kind !== "string" ||
    typeof group?.symbol_name !== "string" ||
    typeof group?.role !== "string" ||
    typeof group?.node_kind !== "string" ||
    typeof group?.match_text !== "string" ||
    typeof group?.anchor !== "string" ||
    !Number.isInteger(group?.start_line) ||
    !Number.isInteger(group?.end_line) ||
    !Number.isInteger(group?.hit_count) ||
    group.hit_count < 1 ||
    !queryLabels(group?.queries) ||
    !Array.isArray(group?.hit_lines) ||
    !Array.isArray(group?.variants) ||
    group.variants.length < 1
  ) {
    return false
  }

  let variantHits = 0

  for (const variant of group.variants) {
    if (
      typeof variant?.subject_text !== "string" ||
      typeof variant?.statement_text !== "string" ||
      !Number.isInteger(variant?.hit_count) ||
      variant.hit_count < 1 ||
      !queryLabels(variant?.queries) ||
      !Array.isArray(variant?.hit_lines)
    ) {
      return false
    }

    variantHits += variant.hit_count
  }

  return variantHits === group.hit_count
}

async function renderHybridEvidence(root, groups, bodyBudgetBytes) {
  const core = []
  const facts = new Set()
  let coreBytes = 0

  function pushCore(line) {
    const cost = bytes(line + "\n")
    if (coreBytes + cost > bodyBudgetBytes) return false
    core.push(line)
    coreBytes += cost
    return true
  }

  for (const group of groups) {
    if (!validateEvidenceGroup(group)) {
      return {
        body: [],
        bodyBytes: 0,
        coreBytes: 0,
        complete: false,
        contextSamples: 0,
        shownGroups: 0,
        shownVariants: 0,
        reason: "invalid_group",
      }
    }

    const q = queryLabels(group.queries)
    const header =
      `${group.file}:${group.start_line}-${group.end_line} [${q}] ` +
      `symbol=${JSON.stringify(group.symbol_name)} ` +
      `role=${group.role} ` +
      `anchor=${JSON.stringify(group.anchor)} ` +
      `match=${JSON.stringify(group.match_text)} ` +
      `hits=${group.hit_count} variants=${group.variants.length} ` +
      `lines=${lineList(group.hit_lines)}` +
      (group.lines_truncated ? ",…" : "")

    if (!pushCore(header)) {
      return {
        body: core,
        bodyBytes: coreBytes,
        coreBytes,
        complete: false,
        contextSamples: 0,
        shownGroups: 0,
        shownVariants: 0,
        reason: "witness_output_budget",
      }
    }

    facts.add(groupFact(group))

    for (const variant of group.variants) {
      const vq = queryLabels(variant.queries)
      const same = variant.subject_text === variant.statement_text
      const detail = same
        ? `subject=${JSON.stringify(variant.subject_text)}`
        : `subject=${JSON.stringify(variant.subject_text)} statement=${JSON.stringify(variant.statement_text)}`

      const line =
        `  x${variant.hit_count} [${vq}] ${detail} ` +
        `lines=${lineList(variant.hit_lines)}` +
        (variant.lines_truncated ? ",…" : "")

      if (!pushCore(line)) {
        return {
          body: core,
          bodyBytes: coreBytes,
          coreBytes,
          complete: false,
          contextSamples: 0,
          shownGroups: 0,
          shownVariants: 0,
          reason: "witness_output_budget",
        }
      }

      facts.add(witnessFact(group, variant))
    }
  }

  // Witnesses are complete at this point. Context is deliberately sampled,
  // never confused with complete raw context. Samples are all-or-nothing per
  // group and use the already-proven file loader/path confinement.
  const body = [...core]
  let bodyBytes = coreBytes
  let contextSamples = 0
  const cache = new Map()

  for (const group of groups) {
    const lines = await loadLines(root, group.file, cache)
    if (!lines || lines.length < 1) continue

    for (const variant of group.variants.slice(0, HYBRID_CONTEXT_SAMPLES_PER_GROUP)) {
      const exemplar = integerList(variant.hit_lines)?.[0]
      if (!exemplar) continue

      const start = Math.max(1, exemplar - HYBRID_CONTEXT_RADIUS)
      const end = Math.min(lines.length, exemplar + HYBRID_CONTEXT_RADIUS)
      const block = [
        `  variant_context=${group.file}:${start}-${end} subject=${JSON.stringify(variant.subject_text)}`,
      ]

      for (let n = start; n <= end; n++) {
        const marker = n === exemplar ? ">" : " "
        block.push(`  ${marker} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`)
      }

      const blockBytes = block.reduce(
        (total, line) => total + bytes(line + "\n"),
        0,
      )
      if (bodyBytes + blockBytes > bodyBudgetBytes) continue

      body.push(...block)
      bodyBytes += blockBytes
      contextSamples += 1

      for (let n = start; n <= end; n++) {
        facts.add(sourceLineFact(group.file, n))
      }
    }
  }

  const shownVariants = groups.reduce(
    (total, group) => total + group.variants.length,
    0,
  )

  return {
    body,
    facts,
    bodyBytes,
    coreBytes,
    complete: true,
    contextSamples,
    shownGroups: groups.length,
    shownVariants,
    reason: null,
  }
}

async function renderEvidence(root, hits, bodyBudgetBytes) {
  const byFile = new Map()

  for (const [key, hit] of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, [])
    byFile.get(hit.file).push({ key, ...hit })
  }

  const cache = new Map()
  const body = []
  const shown = new Set()
  let bodyBytes = 0

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > bodyBudgetBytes) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  outer:
  for (const [file, fileHits] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = await loadLines(root, file, cache)

    if (!lines) {
      for (const hit of fileHits.sort((a, b) => a.line - b.line)) {
        const q = [...hit.queries]
          .sort((a, b) => a - b)
          .map((x) => `Q${x + 1}`)
          .join(",")

        if (!push(`${file}:${hit.line} [${q}] ${clipLine(hit.text)}`)) break outer
        shown.add(hit.key)
      }
      continue
    }

    const hitByLine = new Map()
    for (const hit of fileHits) hitByLine.set(hit.line, hit)

    const ranges = buildRanges(fileHits.map((x) => x.line), lines.length)

    for (const range of ranges) {
      if (!push(`--- ${file}:${range.start}-${range.end} ---`)) break outer

      for (let n = range.start; n <= range.end; n++) {
        const hit = hitByLine.get(n)
        let prefix = " "

        if (hit) {
          const q = [...hit.queries]
            .sort((a, b) => a - b)
            .map((x) => `Q${x + 1}`)
            .join(",")
          prefix = `>[${q}]`
        }

        if (!push(`${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`)) {
          break outer
        }

        if (hit) shown.add(hit.key)
      }
    }
  }

  return { body, shown, bodyBytes }
}

function mergeLineRanges(ranges) {
  const sorted = ranges
    .filter(
      (range) =>
        Number.isInteger(range?.start) &&
        Number.isInteger(range?.end) &&
        range.start > 0 &&
        range.end >= range.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }

  return merged
}


function addLineRange(rangesByFile, file, start, end) {
  const key = evidenceFileKey(file)
  if (!rangesByFile.has(key)) rangesByFile.set(key, [])
  rangesByFile.get(key).push({ start, end })
}

function subtractLineRanges(ranges, exclusions) {
  const excluded = mergeLineRanges(exclusions ?? [])
  if (excluded.length < 1) return mergeLineRanges(ranges ?? [])

  const result = []

  for (const range of mergeLineRanges(ranges ?? [])) {
    let cursor = range.start

    for (const cut of excluded) {
      if (cut.end < cursor) continue
      if (cut.start > range.end) break

      if (cut.start > cursor) {
        result.push({
          start: cursor,
          end: Math.min(range.end, cut.start - 1),
        })
      }

      cursor = Math.max(cursor, cut.end + 1)
      if (cursor > range.end) break
    }

    if (cursor <= range.end) result.push({ start: cursor, end: range.end })
  }

  return result
}

function lineNumbersToRanges(numbers) {
  const sorted = [...new Set(numbers)]
    .filter((line) => Number.isInteger(line) && line > 0)
    .sort((a, b) => a - b)

  const ranges = []

  for (const line of sorted) {
    const last = ranges[ranges.length - 1]

    if (last && line === last.end + 1) last.end = line
    else ranges.push({ start: line, end: line })
  }

  return ranges
}

function hitLookupByFileLine(hits) {
  const lookup = new Map()

  for (const [key, hit] of hits ?? []) {
    const fileKey = evidenceFileKey(hit.file)
    let byLine = lookup.get(fileKey)

    if (!byLine) {
      byLine = new Map()
      lookup.set(fileKey, byLine)
    }

    byLine.set(hit.line, { key, ...hit })
  }

  return lookup
}

async function renderNovelRawEvidence(
  root,
  hits,
  bodyBudgetBytes,
  seenFacts = null,
  excludedRangesByFile = new Map(),
  contextualizedHitLines = null,
) {
  const byFile = new Map()

  for (const [key, hit] of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, [])
    byFile.get(hit.file).push({ key, ...hit })
  }

  const cache = new Map()
  const body = []
  const shown = new Set()
  const facts = new Set()
  let bodyBytes = 0
  let emittedLines = 0
  let skippedPriorLines = 0
  let suppressedContextAnchors = 0

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > bodyBudgetBytes) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  outer:
  for (const [file, fileHits] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = await loadLines(root, file, cache)
    const fileKey = evidenceFileKey(file)
    const exclusions = excludedRangesByFile.get(fileKey) ?? []

    if (!lines) {
      for (const hit of fileHits.sort((a, b) => a.line - b.line)) {
        const excluded = exclusions.some(
          (range) => hit.line >= range.start && hit.line <= range.end,
        )
        if (excluded) continue

        const alreadyContextualized =
          contextualizedHitLines instanceof Set &&
          contextualizedHitLines.has(
            contextualizedHitLineKey(file, hit.line),
          )
        const lineFact = sourceLineFact(file, hit.line)
        const novelLine = !factSeen(seenFacts, lineFact)
        const novelHit = hitHasNovelPositiveFact(hit, seenFacts)

        // A prior FOCUSED scope already supplied source context for this hit.
        // A different regex matching the same hit must not manufacture
        // progress by reopening the same source location.
        if (alreadyContextualized && !novelHit) {
          suppressedContextAnchors += 1
          skippedPriorLines += 1
          continue
        }

        if (!novelLine && !novelHit) {
          skippedPriorLines += 1
          continue
        }

        const q = [...hit.queries]
          .sort((a, b) => a - b)
          .map((x) => `Q${x + 1}`)
          .join(",")

        if (!push(`${file}:${hit.line} [${q}] ${clipLine(hit.text)}`)) break outer

        facts.add(lineFact)
        for (const fact of positiveFactsForHit(hit)) facts.add(fact)
        shown.add(hit.key)
        emittedLines += 1
      }
      continue
    }

    const hitByLine = new Map()
    for (const hit of fileHits) hitByLine.set(hit.line, hit)

    // Context expansion is one-shot per hit line. Once a FOCUSED scope has
    // contextualized a hit, later regex variants matching the same hit may
    // still contribute a genuinely new positive fact, but they cannot use
    // that old hit as an anchor to expose fringe source lines outside the
    // already-shown scope.
    const contextAnchorLines = []
    const forcedNovelHitLines = []

    for (const hit of fileHits) {
      const excluded = exclusions.some(
        (range) => hit.line >= range.start && hit.line <= range.end,
      )
      if (excluded) continue

      const alreadyContextualized =
        contextualizedHitLines instanceof Set &&
        contextualizedHitLines.has(
          contextualizedHitLineKey(file, hit.line),
        )

      if (alreadyContextualized) {
        suppressedContextAnchors += 1
        if (hitHasNovelPositiveFact(hit, seenFacts)) {
          forcedNovelHitLines.push(hit.line)
        }
        continue
      }

      contextAnchorLines.push(hit.line)
    }

    const baseRanges =
      contextAnchorLines.length > 0
        ? buildRanges(contextAnchorLines, lines.length)
        : []
    const availableRanges = subtractLineRanges(baseRanges, exclusions)
    const selectedLines = new Set(forcedNovelHitLines)

    for (const range of availableRanges) {
      for (let n = range.start; n <= range.end; n++) {
        const hit = hitByLine.get(n)
        const lineFact = sourceLineFact(file, n)
        const novelLine = !factSeen(seenFacts, lineFact)
        const novelHit = hit ? hitHasNovelPositiveFact(hit, seenFacts) : false

        if (novelLine || novelHit) selectedLines.add(n)
        else skippedPriorLines += 1
      }
    }

    for (const range of lineNumbersToRanges(selectedLines)) {
      if (!push(`--- ${file}:${range.start}-${range.end} ---`)) break outer

      for (let n = range.start; n <= range.end; n++) {
        const hit = hitByLine.get(n)
        let prefix = " "

        if (hit) {
          const q = [...hit.queries]
            .sort((a, b) => a - b)
            .map((x) => `Q${x + 1}`)
            .join(",")
          prefix = `>[${q}]`
        }

        if (!push(`${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`)) {
          break outer
        }

        facts.add(sourceLineFact(file, n))
        emittedLines += 1

        if (hit) {
          for (const fact of positiveFactsForHit(hit)) facts.add(fact)
          shown.add(hit.key)
        }
      }
    }
  }

  return {
    body,
    shown,
    facts,
    bodyBytes,
    emittedLines,
    skippedPriorLines,
    suppressedContextAnchors,
  }
}

function focusedRoleScore(role) {
  if (role === "call") return 5
  if (role === "assignment") return 4
  if (role === "definition") return 3
  if (role === "import") return 2
  if (role === "reference") return 1

  // Unknown structural roles stay discovery-only. Known imports/references
  // are weak rather than impossible candidates: for wiring/type-usage tasks
  // they can be exactly the behavior the user is asking about.
  return 0
}

function focusedScopesFromGroups(groups) {
  const scopes = new Map()

  for (const group of groups ?? []) {
    if (!validateEvidenceGroup(group)) continue
    if (group.symbol_kind === "module" || group.symbol_name === "<module>") continue
    if (
      !Number.isInteger(group.start_line) ||
      !Number.isInteger(group.end_line) ||
      group.start_line < 1 ||
      group.end_line < group.start_line
    ) continue

    const key =
      `${group.file}\0${group.start_line}\0${group.end_line}` +
      `\0${group.symbol_kind}\0${group.symbol_name}`
    let scope = scopes.get(key)

    if (!scope) {
      scope = {
        file: group.file,
        start: group.start_line,
        end: group.end_line,
        symbolKind: group.symbol_kind,
        symbolName: group.symbol_name,
        hitLines: new Set(),
        anchors: new Set(),
        roles: new Set(),
        queries: new Set(),
        hitCount: 0,
        roleScore: 0,
      }
      scopes.set(key, scope)
    }

    if (group.anchor) scope.anchors.add(group.anchor)
    for (const query of group.queries ?? []) {
      if (Number.isInteger(query) && query > 0) scope.queries.add(query)
    }
    scope.hitCount += Number.isInteger(group.hit_count) ? group.hit_count : 0
    if (group.role) {
      scope.roles.add(group.role)
      scope.roleScore = Math.max(scope.roleScore, focusedRoleScore(group.role))
    }
    for (const line of group.hit_lines ?? []) {
      if (Number.isInteger(line) && line > 0) scope.hitLines.add(line)
    }
  }

  return [...scopes.values()]
    .filter((scope) => scope.hitLines.size > 0 && scope.roleScore > 0)
    .sort(
      (a, b) =>
        b.roleScore - a.roleScore ||
        b.queries.size - a.queries.size ||
        b.hitCount - a.hitCount ||
        b.hitLines.size - a.hitLines.size ||
        a.file.localeCompare(b.file) ||
        a.start - b.start ||
        a.end - b.end,
    )
}

async function renderFocusedSupplement(
  root,
  groups,
  maxBytes,
  hits,
  seenFacts = null,
  contextualizedHitLines = null,
) {
  const budget = Math.min(FOCUSED_SUPPLEMENT_MAX_BYTES, Math.max(0, maxBytes))
  const allCandidateScopes = focusedScopesFromGroups(groups)
  const reusableScopes = []
  const eligibleScopes = []

  for (const scope of allCandidateScopes) {
    const scopeAlreadySeen = factSeen(seenFacts, scopeFact(scope))
    const hasUncontextualizedHit = [...scope.hitLines].some(
      (line) =>
        !(contextualizedHitLines instanceof Set) ||
        !contextualizedHitLines.has(
          contextualizedHitLineKey(scope.file, line),
        ),
    )

    if (scopeAlreadySeen || !hasUncontextualizedHit) {
      reusableScopes.push(scope)
      continue
    }

    eligibleScopes.push(scope)
  }

  const scopes = eligibleScopes.slice(0, FOCUSED_MAX_SCOPES)

  if (budget < FOCUSED_MIN_SUPPLEMENT_BYTES || scopes.length < 1) {
    let reason = "supplement_budget"

    if (allCandidateScopes.length < 1) reason = "no_behavior_scope"
    else if (eligibleScopes.length < 1) reason = "scope_already_contextualized"

    return {
      body: [],
      facts: new Set(),
      bodyBytes: 0,
      complete: false,
      scopeCount: allCandidateScopes.length,
      selectedScopeCount: scopes.length,
      reusedScopeCount: reusableScopes.length,
      fullScopes: 0,
      partialScopes: 0,
      radius: null,
      coveredRangesByFile: new Map(),
      coveredHitKeys: new Set(),
      shownHitKeys: new Set(),
      contextualizedHitLines: new Set(),
      emittedLines: 0,
      reason,
    }
  }

  const cache = new Map()
  const hitLookup = hitLookupByFileLine(hits)

  async function build({ allowFull, radius }) {
    const body = []
    const facts = new Set()
    const coveredRangesByFile = new Map()
    const coveredHitKeys = new Set()
    const shownHitKeys = new Set()
    const contextualized = new Set()
    let bodyBytes = 0
    let fullScopes = 0
    let partialScopes = 0
    let emittedLines = 0

    function push(line) {
      const cost = bytes(line + "\n")
      if (bodyBytes + cost > budget) return false
      body.push(line)
      bodyBytes += cost
      return true
    }

    for (const scope of scopes) {
      const lines = await loadLines(root, scope.file, cache)
      if (!lines || lines.length < 1) {
        return { complete: false, reason: "file_unavailable" }
      }

      const start = Math.max(1, Math.min(scope.start, lines.length))
      const end = Math.max(start, Math.min(scope.end, lines.length))
      const useFull = allowFull && end - start + 1 <= FOCUSED_FULL_SCOPE_MAX_LINES
      const anchors = [...scope.anchors].slice(0, 4)
      const scopeKey = scopeFact(scope)
      const fileKey = evidenceFileKey(scope.file)
      const byLine = hitLookup.get(fileKey) ?? new Map()

      let ranges
      if (useFull) {
        ranges = [{ start, end }]
      } else {
        const headerEnd = Math.min(end, start + FOCUSED_SCOPE_HEADER_LINES - 1)
        ranges = mergeLineRanges([
          { start, end: headerEnd },
          ...[...scope.hitLines].map((line) => ({
            start: Math.max(start, line - radius),
            end: Math.min(end, line + radius),
          })),
        ])
      }

      const selectedLines = []

      for (const range of ranges) {
        for (let n = range.start; n <= range.end; n++) {
          const hit = byLine.get(n)
          const lineNovel = !factSeen(seenFacts, sourceLineFact(scope.file, n))
          const hitNovel = hit ? hitHasNovelPositiveFact(hit, seenFacts) : false

          if (lineNovel || hitNovel) selectedLines.push(n)
        }
      }

      const selectedRanges = lineNumbersToRanges(selectedLines)
      const priorLinesOmitted =
        ranges.reduce((total, range) => total + range.end - range.start + 1, 0) -
        selectedLines.length

      if (!push(
        `SCOPE_CONTEXT ${scope.file}:${start}-${end} ` +
          `symbol=${JSON.stringify(scope.symbolName)} kind=${scope.symbolKind} ` +
          `hits=${scope.hitLines.size} context=${useFull ? "full_turn" : `window±${radius}`}` +
          ` prior_lines_omitted=${Math.max(0, priorLinesOmitted)}` +
          (anchors.length > 0 ? ` anchors=${JSON.stringify(anchors)}` : ""),
      )) {
        return { complete: false, reason: "supplement_budget" }
      }

      facts.add(scopeKey)

      if (useFull) fullScopes += 1
      else partialScopes += 1

      let previousEnd = null

      for (const range of selectedRanges) {
        if (previousEnd !== null && range.start > previousEnd + 1) {
          const omitted = range.start - previousEnd - 1
          if (!push(`  … prior/unsampled scope context omitted ${omitted} lines …`)) {
            return { complete: false, reason: "supplement_budget" }
          }
        }

        for (let n = range.start; n <= range.end; n++) {
          const hit = byLine.get(n)
          let prefix = " "

          if (hit) {
            const q = [...hit.queries]
              .sort((a, b) => a - b)
              .map((x) => `Q${x + 1}`)
              .join(",")
            prefix = `>[${q}]`
          }

          if (!push(
            `  ${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`,
          )) {
            return { complete: false, reason: "supplement_budget" }
          }

          addLineRange(coveredRangesByFile, scope.file, n, n)
          facts.add(sourceLineFact(scope.file, n))
          emittedLines += 1

          if (hit) {
            coveredHitKeys.add(hit.key)
            shownHitKeys.add(hit.key)
            for (const fact of positiveFactsForHit(hit)) facts.add(fact)
          }
        }

        previousEnd = range.end
      }

      for (const [hitKey, hit] of byLine) {
        if (hit.line < start || hit.line > end) continue

        coveredHitKeys.add(hit.key)
        contextualized.add(contextualizedHitLineKey(hit.file, hit.line))
      }
    }

    for (const [file, ranges] of coveredRangesByFile) {
      coveredRangesByFile.set(file, mergeLineRanges(ranges))
    }

    return {
      body,
      facts,
      bodyBytes,
      complete: true,
      scopeCount: allCandidateScopes.length,
      selectedScopeCount: scopes.length,
      reusedScopeCount: reusableScopes.length,
      fullScopes,
      partialScopes,
      radius,
      coveredRangesByFile,
      coveredHitKeys,
      shownHitKeys,
      contextualizedHitLines: contextualized,
      emittedLines,
      reason: null,
    }
  }

  const strategies = [
    { allowFull: true, radius: FOCUSED_WINDOW_RADII[0] },
    ...FOCUSED_WINDOW_RADII.map((radius) => ({ allowFull: false, radius })),
  ]
  let fallback = null

  for (const strategy of strategies) {
    const rendered = await build(strategy)
    fallback = rendered

    if (
      rendered.complete &&
      rendered.bodyBytes >= FOCUSED_MIN_SUPPLEMENT_BYTES
    ) {
      return rendered
    }
  }

  return {
    body: fallback?.body ?? [],
    facts: fallback?.facts ?? new Set(),
    bodyBytes: fallback?.bodyBytes ?? 0,
    complete: false,
    scopeCount: allCandidateScopes.length,
    selectedScopeCount: scopes.length,
    reusedScopeCount: reusableScopes.length,
    fullScopes: fallback?.fullScopes ?? 0,
    partialScopes: fallback?.partialScopes ?? 0,
    radius: fallback?.radius ?? null,
    coveredRangesByFile: fallback?.coveredRangesByFile ?? new Map(),
    coveredHitKeys: fallback?.coveredHitKeys ?? new Set(),
    shownHitKeys: fallback?.shownHitKeys ?? new Set(),
    contextualizedHitLines: fallback?.contextualizedHitLines ?? new Set(),
    emittedLines: fallback?.emittedLines ?? 0,
    reason: fallback?.reason ?? "supplement_budget",
  }
}


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

    return `Q${result.queryIndex + 1} probed_line_hits=${count} probe_scan=${state}${errorDetail}`
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

function worstCaseHeaderBytes(scanComplete, querySummary, uniqueHits) {
  return bytes([
    `SEARCH complete=false scan_complete=${scanComplete} evidence_complete=false unique_hits=${uniqueHits} shown_hits=${uniqueHits}`,
    ...querySummary,
    "INCOMPLETE reasons=scan_incomplete,output_budget",
    "",
  ].join("\n"))
}

function normalizePublicEvent(raw) {
  if (raw?.payload && typeof raw.payload === "object") return raw.payload
  return raw
}

function turnIDFromContext(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : []
  let userOrdinal = 0
  let lastUser = null

  for (const message of messages) {
    if (message?.role !== "user") continue
    userOrdinal += 1
    lastUser = message
  }

  if (!lastUser) return null

  const id =
    (typeof lastUser.id === "string" && lastUser.id) ||
    (typeof lastUser.messageID === "string" && lastUser.messageID) ||
    (typeof lastUser.metadata?.messageID === "string" && lastUser.metadata.messageID) ||
    null

  if (id) return `user:${id}`
  return `user-ordinal:${userOrdinal}`
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

export default {
  id: "cpu-agent.global",

  setup: async (ctx) => {
    const registrations = []
    const track = async (registrationPromise) => {
      registrations.push(await registrationPromise)
    }

    const unsubscribeEvents = await subscribeEvents(ctx)

    await track(ctx.tool.transform((tools) => {
      tools.add({
        name: "search",
        description:
          "Search the active project with 1 to 4 regular expressions in one call. " +
          "Search first performs repository-wide file discovery, ranks lexical candidate files with fairness separated from relevance, " +
          "and probes up to eight candidates before emitting at most four evidence files in the same tool call. " +
          "Returns bounded line-numbered evidence and explicit completeness metadata. " +
          "lexical_discovery_complete=true means the file-level rg pass saw every matching file " +
          "for the requested regex/path/glob. scan_complete=true is stronger: every discovered file " +
          "was probed and every matching line was scanned. " +
          "A ROUTE block is heuristic routing only; retained_unemitted files remain lexical candidates " +
          "and must not be treated as irrelevant or absent. " +
          "Completeness is lexical: scan_complete=true means all matches for the requested " +
          "regex/path/glob were scanned across the probed universe, not that a semantic category is exhaustively absent. " +
          "evidence_complete=true means every discovered hit line is represented, not that " +
          "the surrounding function or file is fully shown. representation=focused adds bounded " +
          "containing-scope context chosen from structurally relevant non-module matches but still " +
          "does not imply whole-file context. Turn evidence is deduplicated: prior_evidence_reused=true " +
          "means omitted facts remain available in earlier tool results. Scope contextualization is one-shot " +
          "per hit within a turn; SEARCH_NO_PROGRESS means change the search dimension instead of retrying " +
          "equivalent context. representation=index is now only a narrow-scope fallback when selected line " +
          "evidence itself cannot fit or complete; broad repository routing is probed and budgeted before returning.",
        input: {
          type: "object",
          properties: {
            queries: {
              type: "array",
              minItems: 1,
              maxItems: MAX_QUERIES,
              items: { type: "string", minLength: 1, maxLength: 200 },
              description: "One to four regular expressions.",
            },
            path: {
              type: "string",
              minLength: 1,
              description: "Optional project-relative file or directory. Default: project root.",
            },
            glob: {
              type: "string",
              minLength: 1,
              description: "Optional file glob such as **/*.py.",
            },
          },
          required: ["queries"],
          additionalProperties: false,
        },
        options: {
          codemode: false,
          permission: "search",
        },

        execute: async (input, toolContext) => {
          const started = performance.now()
          const sessionID =
            typeof toolContext?.sessionID === "string" && toolContext.sessionID.length > 0
              ? toolContext.sessionID
              : null

          const state = getSessionState(sessionID)
          const root = await rootForTool(ctx, toolContext, sessionID, state)

          if (!root) {
            return {
              content: "SEARCH_ERROR: cannot resolve active project root for this session.",
            }
          }

          if (state && !state.turnID) {
            resetTurnState(state, `implicit:${sessionID}:${nowMs()}`, nowMs())
          }

          let attemptIndex = null
          if (state) {
            state.searchAttempts += 1
            state.lastSeen = nowMs()
            attemptIndex = state.searchAttempts
          }

          const blockSearch = async (reason, extra = {}) => {
            await writeProjectTrace(root, "search-trace.jsonl", {
              ts: nowMs(),
              protocol: SEARCH_PROTOCOL,
              sessionID,
              turnID: state?.turnID ?? null,
              project_root: root,
              blocked: true,
              reason,
              attempt_index: attemptIndex,
              turn_model_calls: state?.modelCalls ?? null,
              turn_search_attempts: state?.searchAttempts ?? null,
              turn_executed_searches: state?.executedSearches ?? null,
              turn_evidence_bytes: state?.evidenceBytes ?? null,
              ...extra,
            })

            return {
              content: `SEARCH_BLOCKED reason=${reason} action=use_prior_or_refine`,
              metadata: { protocol: SEARCH_PROTOCOL, blocked: true, reason },
            }
          }

          if (state && state.searchAttempts > MAX_SEARCH_ATTEMPTS_PER_TURN) {
            return await blockSearch("attempt_budget", {
              limit: MAX_SEARCH_ATTEMPTS_PER_TURN,
            })
          }

          let queries = input?.queries
          if (
            !Array.isArray(queries) ||
            queries.length < 1 ||
            queries.length > MAX_QUERIES ||
            queries.some(
              (query) =>
                typeof query !== "string" || query.length < 1 || query.length > 200,
            )
          ) {
            return {
              content: "SEARCH_ERROR: queries must contain 1..4 strings of 1..200 characters.",
            }
          }

          queries = [...new Set(queries)]

          let target
          try {
            target = await safeTarget(root, input?.path ?? ".")
          } catch (error) {
            return { content: "SEARCH_ERROR: " + String(error?.message ?? error) }
          }

          const glob = typeof input?.glob === "string" ? input.glob : undefined
          const signature = searchSignature(queries, target, glob)

          if (state && state.signatures.has(signature)) {
            return await blockSearch("duplicate_search", {
              queries,
              path: target,
              glob: glob ?? null,
            })
          }

          const remainingEvidenceBytes = state
            ? Math.max(0, MAX_TURN_EVIDENCE_BYTES - state.evidenceBytes)
            : MAX_OUTPUT_BYTES

          if (state && remainingEvidenceBytes <= 0) {
            return await blockSearch("evidence_budget", {
              limit_bytes: MAX_TURN_EVIDENCE_BYTES,
            })
          }

          // Every new search now starts with a file-level lexical discovery
          // pass. This is deliberate: routing must not depend on a possibly
          // truncated stream of line hits from one noisy file.
          if (
            state &&
            state.executedSearches >= MAX_EXECUTED_SEARCHES_PER_TURN
          ) {
            return await blockSearch("executed_search_budget", {
              limit: MAX_EXECUTED_SEARCHES_PER_TURN,
              queries,
              path: target,
              glob: glob ?? null,
            })
          }

          if (state) {
            state.signatures.add(signature)
            state.executedSearches += 1
          }

          const discoveryStarted = performance.now()
          const discoveryResults = await Promise.all(
            queries.map((query, index) =>
              runFileDiscovery(root, query, index, target, glob),
            ),
          )
          const discoveryElapsedMs =
            Math.round((performance.now() - discoveryStarted) * 100) / 100

          const discoveryComplete = discoveryResults.every(
            (result) => result.scanComplete,
          )
          const rankedFiles = rankDiscoveredFiles(discoveryResults)
          const probeFiles = selectProbeFiles(rankedFiles, discoveryResults)
          const probeFileSet = new Set(probeFiles.map((entry) => entry.file))
          const allDiscoveredFilesProbed =
            rankedFiles.length === probeFileSet.size

          const queryPlan = queries.map((query, index) => {
            const targets = probeFiles
              .filter((entry) => entry.queries.has(index))
              .map((entry) => entry.file)
              .sort()
            const cacheKey = queryCacheKey(
              root,
              query,
              target,
              glob,
              targets,
            )
            const cached = state?.queryCache?.get(cacheKey) ?? null

            return {
              query,
              index,
              targets,
              cacheKey,
              cached,
            }
          })

          const freshPlan = queryPlan.filter((item) => !item.cached)
          const reusedQueryCount = queryPlan.length - freshPlan.length
          const executedQueryCount = freshPlan.filter(
            (item) => item.targets.length > 0,
          ).length

          const refineStarted = performance.now()
          const freshResults = await Promise.all(
            freshPlan.map((item) =>
              runQuery(root, item.query, item.index, item.targets, glob),
            ),
          )
          const refineElapsedMs =
            Math.round((performance.now() - refineStarted) * 100) / 100

          const freshByIndex = new Map(
            freshResults.map((result) => [result.queryIndex, result]),
          )

          if (state) {
            for (const item of freshPlan) {
              const result = freshByIndex.get(item.index)
              if (result) rememberQueryResult(state, item.cacheKey, result)
            }
          }

          const probeResults = queryPlan
            .map((item) => {
              if (item.cached) {
                return reindexQueryResult(item.cached, item.index, true)
              }

              const result = freshByIndex.get(item.index)
              return result ? reindexQueryResult(result, item.index, false) : null
            })
            .filter(Boolean)
            .sort((a, b) => a.queryIndex - b.queryIndex)

          const probeRankedFiles = rankProbedFiles(rankedFiles, probeResults)
          const impactValidation = await validateImpactHypotheses(
            root,
            target,
            glob,
            probeFiles,
            probeResults,
          )
          const impactIndexShadow = impactValidation.indexStats
          const selectedFiles = selectEmitFilesWithImpact(
            probeRankedFiles,
            discoveryResults,
            impactValidation.validated,
          )
          const selectedFileSet = new Set(
            selectedFiles.map((entry) => evidenceFileKey(entry.file)),
          )
          const selectedLexicalFiles = selectedFiles.filter(
            (entry) => entry?.origin !== "impact",
          )
          const selectedLexicalFileSet = new Set(
            selectedLexicalFiles.map((entry) => evidenceFileKey(entry.file)),
          )
          const selectedImpactFiles = selectedFiles.filter(
            (entry) => entry?.origin === "impact",
          )
          const allDiscoveredFilesSelected =
            rankedFiles.length === selectedLexicalFileSet.size
          const routingActive =
            !discoveryComplete || !allDiscoveredFilesSelected || selectedImpactFiles.length > 0
          const results = filterQueryResultsToFiles(probeResults, selectedLexicalFiles)

          const probeHits = mergeHits(probeResults)
          const hits = mergeHits(results)
          const exactSpanHits = [...hits.values()].reduce(
            (total, hit) => total + (Array.isArray(hit.exactSpans) ? hit.exactSpans.length : 0),
            0,
          )
          const probedExactSpanHits = [...probeHits.values()].reduce(
            (total, hit) =>
              total + (Array.isArray(hit.exactSpans) ? hit.exactSpans.length : 0),
            0,
          )
          const selectedScanComplete = probeResults.every(
            (result) => result.scanComplete,
          )
          const scanComplete =
            discoveryComplete &&
            allDiscoveredFilesProbed &&
            selectedScanComplete
          const querySummary = [
            ...discoverySummaryFor(discoveryResults),
            ...querySummaryFor(probeResults),
          ]
          const callBudgetBytes = Math.min(MAX_OUTPUT_BYTES, remainingEvidenceBytes)
          const provisionalRoute = routingActive
            ? renderRouteMap(rankedFiles, selectedFiles, ROUTE_BODY_BUDGET_BYTES)
            : { body: [], bodyBytes: 0, retained: 0 }
          const headerReserve =
            worstCaseHeaderBytes(scanComplete, querySummary, hits.size) +
            provisionalRoute.bodyBytes

          if (callBudgetBytes <= headerReserve) {
            return await blockSearch("evidence_budget", {
              limit_bytes: MAX_TURN_EVIDENCE_BYTES,
              remaining_bytes: remainingEvidenceBytes,
              required_header_bytes: headerReserve,
            })
          }

          const bodyBudget = Math.min(
            BODY_BUDGET_BYTES,
            Math.max(0, callBudgetBytes - headerReserve),
          )

          const routeRendered = routingActive
            ? renderRouteMap(rankedFiles, selectedFiles, provisionalRoute.bodyBytes)
            : { body: [], bodyBytes: 0, retained: 0 }

          const rawRendered = await renderEvidence(root, hits, bodyBudget)
          const selectedEvidenceComplete = rawRendered.shown.size === hits.size
          const rawEvidenceComplete =
            scanComplete && allDiscoveredFilesSelected && selectedEvidenceComplete
          const rawComplete = scanComplete && rawEvidenceComplete
          const rawReasons = []

          if (!discoveryComplete) rawReasons.push("lexical_discovery_incomplete")
          else if (!allDiscoveredFilesProbed) rawReasons.push("probe_subset")
          else if (!selectedScanComplete) rawReasons.push("scan_incomplete")
          else if (!allDiscoveredFilesSelected) rawReasons.push("budgeted_emit_subset")
          if (!selectedEvidenceComplete) rawReasons.push("output_budget")

          const rawHeader = [
            `SEARCH complete=${rawComplete} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${rawEvidenceComplete} selected_evidence_complete=${selectedEvidenceComplete} candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} shown_hits=${rawRendered.shown.size}`,
            ...querySummary,
          ]

          if (rawReasons.length) {
            rawHeader.push(`INCOMPLETE reasons=${rawReasons.join(",")}`)
          }

          const rawContent = [
            ...rawHeader,
            ...(routeRendered.body.length > 0 ? ["", ...routeRendered.body] : []),
            "",
            ...rawRendered.body,
          ].join("\n")
          const rawResultBytes = bytes(rawContent)

          if (rawResultBytes > callBudgetBytes) {
            return await blockSearch("internal_budget_guard", {
              result_bytes: rawResultBytes,
              call_budget_bytes: callBudgetBytes,
            })
          }

          const pressure = evidencePressure(
            hits,
            rawRendered,
            selectedEvidenceComplete,
          )
          const distillInput = distillerHitsFromMerged(hits)
          const spansComplete = spanCaptureComplete(results)

          let representation = "raw"
          let content = rawContent
          let resultBytes = rawResultBytes
          let bodyBytes = rawRendered.bodyBytes
          let shownHits = rawRendered.shown.size
          let evidenceComplete = rawEvidenceComplete
          let complete = rawComplete

          let distillAttempted = false
          let distillReason = "not_needed"
          let distillElapsedMs = null
          let distillerElapsedMs = null
          let distillIrComplete = null
          let distillWitnessComplete = null
          let v2GroupingPreserved = null
          let hybridGroups = null
          let hybridVariants = null
          let hybridBodyBytes = null
          let hybridCoreBytes = null
          let hybridContextSamples = null
          let hybridRatio = null
          let hybridFacts = new Set()
          let variantDiversity = null
          let distillGroupsForIndex = null

          let indexReason = null
          let indexRenderComplete = null
          let indexFiles = null
          let indexSamples = null
          let indexStructuralGroups = null
          let indexDiscriminativeFacets = null
          let indexFacts = new Set()
          let refinementRequired = false

          let regionAttempted = false
          let regionReason = "not_needed"
          let regionScopes = null
          let regionSampledScopes = null
          let regionSampledHits = null
          let regionRetainedHits = null
          let regionFacts = new Set()

          let focusedCandidate = false
          let focusedAttempted = false
          let focusedReason = "not_needed"
          let focusedSupplementBytes = null
          let focusedScopeCandidates = null
          let focusedSelectedScopes = null
          let focusedReusedScopes = null
          let focusedFullScopes = null
          let focusedPartialScopes = null
          let focusedRadius = null
          let focusedCanonicalSavedBytes = null
          let focusedFacts = new Set()
          let focusedContextualizedHitLines = new Set()

          focusedCandidate =
            selectedScanComplete &&
            selectedEvidenceComplete &&
            hits.size > 0 &&
            hits.size <= FOCUSED_PROBE_MAX_LINE_HITS &&
            pressure.maxHitsPerFile <= FOCUSED_PROBE_MAX_HITS_PER_FILE &&
            spansComplete &&
            distillInput.length > 0 &&
            distillInput.length <= FOCUSED_PROBE_MAX_EXACT_MATCHES

          const shouldDistill = pressure.active || focusedCandidate

          if (!selectedScanComplete) distillReason = "selected_scan_incomplete"
          else if (!shouldDistill) distillReason = "not_needed"
          else if (!spansComplete) distillReason = "span_capture_incomplete"
          else if (distillInput.length < 1) distillReason = "no_exact_spans"
          else {
            distillAttempted = true

            const distill = await runDistiller(root, distillInput)
            distillElapsedMs = distill.elapsedMs

            if (!distill.ok) {
              distillReason = distill.reason
              if (focusedCandidate) focusedReason = `distill_${distill.reason}`
              distillIrComplete = distill.response?.ir_complete ?? false
              distillWitnessComplete = distill.response?.witness_complete ?? false
              v2GroupingPreserved = distill.response?.v2_grouping_preserved ?? null
            } else {
              distillIrComplete = true
              distillWitnessComplete = true
              v2GroupingPreserved = true
              distillGroupsForIndex = distill.response.groups
              variantDiversity = Number.isFinite(distill.response?.variant_diversity)
                ? distill.response.variant_diversity
                : null
              distillerElapsedMs = Number.isFinite(distill.response?.elapsed_ms)
                ? distill.response.elapsed_ms
                : null

              const hybridRendered = await renderHybridEvidence(
                root,
                distill.response.groups,
                bodyBudget,
              )

              hybridGroups = hybridRendered.shownGroups
              hybridVariants = hybridRendered.shownVariants
              hybridBodyBytes = hybridRendered.bodyBytes
              hybridCoreBytes = hybridRendered.coreBytes
              hybridContextSamples = hybridRendered.contextSamples
              hybridFacts = hybridRendered.facts ?? new Set()

              if (!hybridRendered.complete) {
                distillReason = hybridRendered.reason ?? "hybrid_render_incomplete"
              } else {
                const contextSampled = hybridRendered.contextSamples > 0
                const publicHybridRepresentation = routingActive
                  ? "ranked_hybrid"
                  : "hybrid"
                const hybridHeader = [
                  `SEARCH representation=${publicHybridRepresentation} complete=${scanComplete && allDiscoveredFilesSelected} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${scanComplete && allDiscoveredFilesSelected} selected_evidence_complete=true matches_complete=${scanComplete} selected_witnesses_complete=true context_complete=false context_sampled=${contextSampled} candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} exact_matches=${distillInput.length} shown_hits=${hits.size} groups=${hybridRendered.shownGroups} variants=${hybridRendered.shownVariants}`,
                  ...querySummary,
                ]

                if (routingActive) {
                  hybridHeader.push(
                    `INCOMPLETE reasons=${!discoveryComplete ? "lexical_discovery_incomplete" : !allDiscoveredFilesProbed ? "probe_subset" : "budgeted_emit_subset"}`,
                  )
                }

                const hybridContent = [
                  ...hybridHeader,
                  ...(routeRendered.body.length > 0
                    ? ["", ...routeRendered.body]
                    : []),
                  "",
                  ...hybridRendered.body,
                ].join("\n")
                const hybridResultBytes = bytes(hybridContent)
                hybridRatio = rawResultBytes > 0
                  ? Math.round((hybridResultBytes / rawResultBytes) * 1000) / 1000
                  : null

                const materiallySmaller =
                  rawResultBytes > 0 &&
                  hybridResultBytes <= rawResultBytes * HYBRID_MIN_SAVINGS_RATIO

                const hybridBeneficial =
                  pressure.active &&
                  (!selectedEvidenceComplete || materiallySmaller)

                if (hybridResultBytes > callBudgetBytes) {
                  distillReason = "hybrid_output_budget"
                } else if (!hybridBeneficial) {
                  distillReason = "no_material_size_reduction"
                } else {
                  representation = "hybrid"
                  content = hybridContent
                  resultBytes = hybridResultBytes
                  bodyBytes = hybridRendered.bodyBytes
                  shownHits = hits.size
                  evidenceComplete = scanComplete && allDiscoveredFilesSelected
                  complete = scanComplete && allDiscoveredFilesSelected
                  distillReason = "selected"
                }
              }

              if (representation !== "raw" && focusedCandidate) {
                focusedReason = "superseded_by_hybrid"
              }

              if (representation === "raw" && focusedCandidate) {
                focusedAttempted = true
                const supplementBudget = Math.min(
                  FOCUSED_SUPPLEMENT_MAX_BYTES,
                  Math.max(0, bodyBudget - rawRendered.bodyBytes),
                )
                const focusedRendered = await renderFocusedSupplement(
                  root,
                  distill.response.groups,
                  supplementBudget,
                  hits,
                  state?.evidenceLedger ?? null,
                  state?.contextualizedHitLines ?? null,
                )

                focusedSupplementBytes = focusedRendered.bodyBytes
                focusedScopeCandidates = focusedRendered.scopeCount
                focusedSelectedScopes = focusedRendered.selectedScopeCount
                focusedReusedScopes = focusedRendered.reusedScopeCount
                focusedFullScopes = focusedRendered.fullScopes
                focusedPartialScopes = focusedRendered.partialScopes
                focusedRadius = focusedRendered.radius

                if (!focusedRendered.complete) {
                  focusedReason = focusedRendered.reason ?? "supplement_incomplete"
                } else {
                  const uncoveredHits = new Map(
                    [...hits.entries()].filter(
                      ([key]) => !focusedRendered.coveredHitKeys.has(key),
                    ),
                  )
                  const seenForRaw = new Set(state?.evidenceLedger ?? [])

                  for (const fact of focusedRendered.facts ?? []) {
                    seenForRaw.add(fact)
                  }

                  const rawRemainingBudget = Math.max(
                    0,
                    bodyBudget - focusedRendered.bodyBytes,
                  )
                  const rawUncovered = await renderNovelRawEvidence(
                    root,
                    uncoveredHits,
                    rawRemainingBudget,
                    seenForRaw,
                    focusedRendered.coveredRangesByFile,
                    state?.contextualizedHitLines ?? null,
                  )
                  const uncoveredComplete = [...uncoveredHits.entries()].every(
                    ([key, hit]) =>
                      rawUncovered.shown.has(key) ||
                      hitFactsAlreadySeen(hit, state?.evidenceLedger),
                  )

                  if (!uncoveredComplete) {
                    focusedReason = "canonical_raw_budget"
                  } else {
                    const focusedBody = []

                    if (rawUncovered.body.length > 0) {
                      focusedBody.push(...rawUncovered.body)
                    }

                    if (
                      rawUncovered.body.length > 0 &&
                      focusedRendered.body.length > 0
                    ) {
                      focusedBody.push("")
                    }

                    focusedBody.push(...focusedRendered.body)

                    const shownNow = new Set([
                      ...rawUncovered.shown,
                      ...focusedRendered.shownHitKeys,
                    ])
                    const priorHits = countHitsAlreadySeen(
                      hits,
                      state?.evidenceLedger,
                    )
                    const publicFocusedRepresentation = routingActive
                      ? "ranked_focused"
                      : "focused"
                    const focusedHeader = [
                      `SEARCH representation=${publicFocusedRepresentation} complete=${scanComplete && allDiscoveredFilesSelected} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${scanComplete && allDiscoveredFilesSelected} selected_evidence_complete=true matches_complete=${scanComplete} context_complete=false context_mode=scope_guided_dedup candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} shown_hits=${shownNow.size} prior_hits=${priorHits} prior_evidence_reused=${priorHits > 0 || rawUncovered.skippedPriorLines > 0} full_scopes=${focusedRendered.fullScopes} partial_scopes=${focusedRendered.partialScopes}`,
                      ...querySummary,
                    ]

                    if (routingActive) {
                      focusedHeader.push(
                        `INCOMPLETE reasons=${!discoveryComplete ? "lexical_discovery_incomplete" : !allDiscoveredFilesProbed ? "probe_subset" : "budgeted_emit_subset"}`,
                      )
                    }
                    const focusedContent = [
                      ...focusedHeader,
                      ...(routeRendered.body.length > 0
                        ? ["", ...routeRendered.body]
                        : []),
                      "",
                      ...focusedBody,
                    ].join("\n")
                    const focusedResultBytes = bytes(focusedContent)

                    const focusedCostLimit = Math.min(
                      rawResultBytes + FOCUSED_MAX_OVERHEAD_BYTES,
                      Math.ceil(rawResultBytes * FOCUSED_MAX_OVERHEAD_RATIO),
                    )
                    const focusedCostAccepted =
                      focusedResultBytes <= focusedCostLimit

                    if (focusedResultBytes > callBudgetBytes) {
                      focusedReason = "focused_output_budget"
                    } else if (!focusedCostAccepted) {
                      focusedReason = "cost_guard"
                    } else {
                      representation = "focused"
                      content = focusedContent
                      resultBytes = focusedResultBytes
                      bodyBytes =
                        rawUncovered.bodyBytes + focusedRendered.bodyBytes
                      shownHits = shownNow.size
                      evidenceComplete = scanComplete && allDiscoveredFilesSelected
                      complete = scanComplete && allDiscoveredFilesSelected
                      distillReason = "ir_complete"
                      focusedReason = "selected"
                      focusedFacts = new Set([
                        ...rawUncovered.facts,
                        ...focusedRendered.facts,
                      ])
                      focusedContextualizedHitLines =
                        focusedRendered.contextualizedHitLines
                      focusedCanonicalSavedBytes = Math.max(
                        0,
                        rawRendered.bodyBytes +
                          focusedRendered.bodyBytes -
                          bodyBytes,
                      )
                    }
                  }
                }
              }
            }
          }


          // Dense evidence that cannot fit RAW is routed one level deeper
          // inside the selected file(s). This is intentionally sampled and
          // marked incomplete, but it gives the model concrete function/scope
          // context without forcing an INDEX -> model -> narrower-search loop.
          if (
            representation === "raw" &&
            selectedScanComplete &&
            !selectedEvidenceComplete &&
            Array.isArray(distillGroupsForIndex) &&
            distillGroupsForIndex.length > 0
          ) {
            regionAttempted = true
            const regionRendered = await renderRegionEvidence(
              root,
              distillGroupsForIndex,
              bodyBudget,
              hits,
            )

            regionReason = regionRendered.reason ?? "selected"
            regionScopes = regionRendered.scopeCount
            regionSampledScopes = regionRendered.sampledScopes
            regionSampledHits = regionRendered.sampledHits
            regionRetainedHits = regionRendered.retainedHits

            if (regionRendered.complete) {
              const publicRegionRepresentation = routingActive
                ? "ranked_region"
                : "region"
              const regionHeader = [
                `SEARCH representation=${publicRegionRepresentation} complete=false scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=false selected_evidence_complete=false matches_complete=${scanComplete} region_sampled=true refinement_required=false candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} sampled_hits=${regionRendered.sampledHits} retained_hits=${regionRendered.retainedHits} scopes=${regionRendered.sampledScopes}`,
                ...querySummary,
                `EVIDENCE_SAMPLED reason=dense_region_router exact_match_locations_preserved=true`,
              ]

              if (routingActive) {
                regionHeader.push(
                  `INCOMPLETE reasons=${!discoveryComplete ? "lexical_discovery_incomplete,region_sampled" : !allDiscoveredFilesProbed ? "probe_subset,region_sampled" : "budgeted_emit_subset,region_sampled"}`,
                )
              } else {
                regionHeader.push("INCOMPLETE reasons=region_sampled")
              }

              const regionContent = [
                ...regionHeader,
                ...(routeRendered.body.length > 0
                  ? ["", ...routeRendered.body]
                  : []),
                "",
                ...regionRendered.body,
              ].join("\n")
              const regionResultBytes = bytes(regionContent)

              if (regionResultBytes <= callBudgetBytes) {
                representation = "region"
                content = regionContent
                resultBytes = regionResultBytes
                bodyBytes = regionRendered.bodyBytes
                shownHits = regionRendered.sampledHits
                evidenceComplete = false
                complete = false
                refinementRequired = false
                regionReason = "selected"
                regionFacts = regionRendered.facts ?? new Set()
              } else {
                regionReason = "region_output_budget"
              }
            }
          }

          // INDEX is not a compressed substitute for code evidence. It is a
          // bounded routing map used only when the normal evidence cannot be
          // complete. It tells the model where to refine and explicitly
          // forbids absence conclusions from an incomplete discovery.
          if (
            representation === "raw" &&
            !routingActive &&
            (!scanComplete || !selectedEvidenceComplete)
          ) {
            const indexRendered = renderSearchIndex(
              results,
              distillGroupsForIndex,
              bodyBudget,
            )

            const lineDiscoveryComplete = scanComplete
            const absenceNotProven = !lineDiscoveryComplete
            const indexHeader = [
              `SEARCH representation=index complete=false scan_complete=${scanComplete} evidence_complete=false index_render_complete=${indexRendered.complete} refinement_required=true absence_not_proven=${absenceNotProven} collected_line_hits=${hits.size} exact_matches=${exactSpanHits} indexed_files=${indexRendered.fileCount}`,
              ...querySummary,
              `REFINE_REQUIRED action=prefer_route_match_or_narrow_file routing=match_facets`,
            ]

            if (absenceNotProven) {
              indexHeader.push(
                "ABSENCE_NOT_PROVEN reason=line_scan_incomplete do_not_conclude_no_other_matches",
              )
              indexReason = "line_scan_incomplete"
            } else {
              indexHeader.push(
                "EVIDENCE_SUMMARIZED reason=raw_output_budget inspect_focused_evidence_before_code_level_conclusions",
              )
              indexReason = "raw_output_budget"
            }

            const indexContent = [
              ...indexHeader,
              "",
              ...indexRendered.body,
            ].join("\n")
            const indexResultBytes = bytes(indexContent)

            if (indexResultBytes <= callBudgetBytes) {
              representation = "index"
              content = indexContent
              resultBytes = indexResultBytes
              bodyBytes = indexRendered.bodyBytes
              shownHits = indexRendered.sampleCount
              evidenceComplete = false
              complete = false
              refinementRequired = true
              indexRenderComplete = indexRendered.complete
              indexFiles = indexRendered.fileCount
              indexSamples = indexRendered.sampleCount
              indexStructuralGroups = indexRendered.structuralGroupsShown
              indexDiscriminativeFacets =
                indexRendered.discriminativeFacetsShown
              indexFacts = indexRendered.facts ?? new Set()
            }
          }

          // Final RAW packing is turn-aware. Prior source/context remains in
          // conversation history, so only novel lines or newly-matched spans
          // need to be emitted again.
          let rawNovelFacts = new Set()
          let rawNovelEmittedLines = null
          let rawPriorHits = null
          let rawSkippedPriorLines = null
          let rawSuppressedContextAnchors = null

          if (representation === "raw") {
            const rawNovel = await renderNovelRawEvidence(
              root,
              hits,
              bodyBudget,
              state?.evidenceLedger ?? null,
              new Map(),
              state?.contextualizedHitLines ?? null,
            )
            const priorHits = countHitsAlreadySeen(
              hits,
              state?.evidenceLedger,
            )
            const accountedHits = [...hits.entries()].every(
              ([key, hit]) =>
                rawNovel.shown.has(key) ||
                hitFactsAlreadySeen(hit, state?.evidenceLedger),
            )
            const selectedTurnEvidenceComplete =
              selectedEvidenceComplete && accountedHits
            const turnEvidenceComplete =
              scanComplete &&
              allDiscoveredFilesSelected &&
              selectedTurnEvidenceComplete
            const turnComplete = scanComplete && turnEvidenceComplete
            const rawNovelReasons = []

            if (!discoveryComplete) {
              rawNovelReasons.push("lexical_discovery_incomplete")
            } else if (!allDiscoveredFilesProbed) {
              rawNovelReasons.push("probe_subset")
            } else if (!selectedScanComplete) {
              rawNovelReasons.push("scan_incomplete")
            } else if (!allDiscoveredFilesSelected) {
              rawNovelReasons.push("budgeted_emit_subset")
            }
            if (!selectedTurnEvidenceComplete) {
              rawNovelReasons.push("output_budget")
            }

            const publicRawRepresentation = routingActive
              ? "ranked_raw"
              : "raw"
            const rawNovelHeader = [
              `SEARCH representation=${publicRawRepresentation} complete=${turnComplete} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${turnEvidenceComplete} selected_evidence_complete=${selectedTurnEvidenceComplete} candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} shown_hits=${rawNovel.shown.size} prior_hits=${priorHits} prior_evidence_reused=${priorHits > 0 || rawNovel.skippedPriorLines > 0}`,
              ...querySummary,
            ]

            if (rawNovelReasons.length) {
              rawNovelHeader.push(
                `INCOMPLETE reasons=${rawNovelReasons.join(",")}`,
              )
            }

            const rawNovelContent = [
              ...rawNovelHeader,
              ...(routeRendered.body.length > 0
                ? ["", ...routeRendered.body]
                : []),
              "",
              ...rawNovel.body,
            ].join("\n")
            const rawNovelResultBytes = bytes(rawNovelContent)

            if (rawNovelResultBytes <= callBudgetBytes) {
              content = rawNovelContent
              resultBytes = rawNovelResultBytes
              bodyBytes = rawNovel.bodyBytes
              shownHits = rawNovel.shown.size
              evidenceComplete = turnEvidenceComplete
              complete = turnComplete
              rawNovelFacts = rawNovel.facts
              rawNovelEmittedLines = rawNovel.emittedLines
              rawPriorHits = priorHits
              rawSkippedPriorLines = rawNovel.skippedPriorLines
              rawSuppressedContextAnchors =
                rawNovel.suppressedContextAnchors
            } else {
              // Safe fallback: the original bounded RAW body is already known
              // to fit. Positive hit facts are still ledgered; context-line
              // dedup simply becomes conservative for this one result.
              rawNovelFacts = positiveFactsForHits(hits)
            }
          }

          const sourceRepresentation = representation
          const finalFacts = new Set()

          if (representation === "raw") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of rawNovelFacts) finalFacts.add(fact)
          } else if (representation === "focused") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of focusedFacts) finalFacts.add(fact)
          } else if (representation === "hybrid") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of hybridFacts) finalFacts.add(fact)
          } else if (representation === "region") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of regionFacts) finalFacts.add(fact)
          } else if (representation === "index") {
            for (const fact of indexFacts) finalFacts.add(fact)
          }

          for (const fact of negativeFactsForDiscoveryResults(
            discoveryResults,
            target,
            glob,
          )) {
            finalFacts.add(fact)
          }

          for (const fact of impactEvidenceFactsForSelected(selectedFiles)) {
            finalFacts.add(fact)
          }

          const routeFacts = routeFactsForRanking(
            rankedFiles,
            selectedLexicalFileSet,
            discoveryComplete,
            target,
            glob,
          )
          const ledgerFactsBefore = state?.evidenceLedger?.size ?? 0
          const novelty = novelEvidenceFacts(state, finalFacts)
          const routeNovelty = novelRouteFacts(state, routeFacts)
          const meaningfulRouteProgress =
            routingActive && routeNovelty.novel.size > 0
          const novelFactStats = summarizeEvidenceFacts(novelty.novel)
          let ledgerFactsAdded = 0
          let routeFactsAdded = 0
          let noProgress = false
          let noProgressBlocked = false

          if (state && novelty.novel.size < 1) {
            state.consecutiveNoProgress += 1
            noProgress = true
            noProgressBlocked =
              state.consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS

            if (noProgressBlocked) {
              content =
                `SEARCH_BLOCKED reason=no_progress_loop ` +
                `source_representation=${sourceRepresentation} ` +
                `prior_evidence_reused=true no_progress_streak=${state.consecutiveNoProgress} ` +
                `action=use_prior_or_change_search_dimension`
            } else {
              content =
                `SEARCH_NO_PROGRESS reason=evidence_already_seen ` +
                `source_representation=${sourceRepresentation} ` +
                `prior_evidence_reused=true no_progress_streak=${state.consecutiveNoProgress} ` +
                `action=use_prior_or_change_search_dimension`
            }

            representation = "no_progress"
            resultBytes = bytes(content)
            bodyBytes = 0
            shownHits = 0
          } else if (state) {
            state.consecutiveNoProgress = 0
            const remembered = rememberEvidenceFacts(state, finalFacts)
            const rememberedRoutes = rememberRouteFacts(state, routeFacts)
            ledgerFactsAdded = remembered.added
            routeFactsAdded = rememberedRoutes.added

            if (sourceRepresentation === "focused") {
              rememberContextualizedHitLines(
                state,
                focusedContextualizedHitLines,
              )
            }
          }

          if (
            !noProgress &&
            routingActive &&
            (representation === "raw" ||
              representation === "focused" ||
              representation === "hybrid" ||
              representation === "region")
          ) {
            representation = `ranked_${representation}`
          }

          if (state) {
            state.evidenceBytes += resultBytes
            state.lastSeen = nowMs()
          }

          const elapsedMs = Math.round((performance.now() - started) * 100) / 100

          await writeProjectTrace(root, "search-trace.jsonl", {
            ts: nowMs(),
            protocol: SEARCH_PROTOCOL,
            sessionID,
            turnID: state?.turnID ?? null,
            project_root: root,
            attempt_index: attemptIndex,
            requested_queries: input?.queries,
            queries,
            path: target,
            glob: glob ?? null,
            file_discovery_cap_per_query: FILE_DISCOVERY_CAP_PER_QUERY,
            line_hit_cap_per_query: LINE_HIT_CAP_PER_QUERY,
            lexical_discovery_complete: discoveryComplete,
            selected_scan_complete: selectedScanComplete,
            probe_scan_complete: selectedScanComplete,
            all_discovered_files_probed: allDiscoveredFilesProbed,
            all_discovered_files_emitted: allDiscoveredFilesSelected,
            routing_active: routingActive,
            route_strategy: "query_fair_lexical8_plus_task_local_impact",
            candidate_files: rankedFiles.length,
            discovery_elapsed_ms: discoveryElapsedMs,
            refine_elapsed_ms: refineElapsedMs,
            probe_elapsed_ms: refineElapsedMs,
            impact_index_attempted: impactIndexShadow.attempted,
            impact_index_ok: impactIndexShadow.ok,
            impact_index_reason: impactIndexShadow.reason,
            impact_index_elapsed_ms: impactIndexShadow.elapsedMs,
            impact_graph_probe_cap: IMPACT_GRAPH_PROBE_MAX_FILES,
            impact_graph_emit_cap: IMPACT_GRAPH_EMIT_MAX_FILES,
            impact_validation_attempted: impactValidation.attempted,
            impact_validation_reason: impactValidation.reason,
            impact_validation_elapsed_ms: impactValidation.elapsedMs,
            impact_validation_queries: impactValidation.queryCount,
            impact_hypotheses: impactValidation.hypotheses.length,
            impact_validated: impactValidation.validated.length,
            impact_rejected: impactValidation.rejected.length,
            impact_scope_conditioned: true,
            impact_scope_seed_contexts: impactValidation.seedContexts,
            impact_scope_owner_symbols: impactValidation.ownerSymbols,
            impact_pairwise_conditioned: impactValidation.pairwiseConditioned === true,
            impact_filter_before_cap: impactIndexShadow.taskFiltersApplied === true,
            impact_filter_query_elapsed_ms: impactValidation.filterQueryElapsedMs,
            impact_refresh_fallback_attempted: impactValidation.refreshFallbackAttempted === true,
            impact_refresh_fallback_elapsed_ms: impactValidation.refreshFallbackElapsedMs,
            impact_pre_refresh_refresh_due: impactValidation.initialIndexStats?.refreshDue === true,
            impact_pre_refresh_stale_seed_files: impactValidation.initialIndexStats?.staleSeedFiles ?? 0,
            impact_pre_refresh_stale_witness_edges: impactValidation.initialIndexStats?.staleWitnessEdges ?? 0,
            impact_pre_refresh_cache_age_ms: impactValidation.initialIndexStats?.cacheAgeMs ?? null,
            impact_refresh_fallback_cause:
              impactValidation.refreshFallbackAttempted !== true
                ? null
                : ((impactValidation.initialIndexStats?.staleSeedFiles ?? 0) > 0 ||
                    (impactValidation.initialIndexStats?.staleWitnessEdges ?? 0) > 0)
                  ? "fingerprint_stale"
                  : impactValidation.initialIndexStats?.refreshDue === true
                    ? "age_or_unavailable"
                    : "validation_miss",
            impact_scope_relations_rejected: impactValidation.scopeRejected,
            impact_index_coverage_complete: impactIndexShadow.refreshComplete,
            impact_index_partial_reason: impactIndexShadow.partialReason,
            impact_index_inventory_kind: impactIndexShadow.inventoryKind,
            impact_index_local_resolved: impactIndexShadow.resolvedImports,
            impact_index_local_unresolved: impactIndexShadow.unresolvedImports,
            impact_index_local_ambiguous: impactIndexShadow.ambiguousImports,
            impact_index_external_packages: impactIndexShadow.externalPackages,
            impact_index_unsupported_aliases: impactIndexShadow.unsupportedAliases,
            impact_emitted_files: selectedImpactFiles.length,
            impact_emitted: selectedImpactFiles.map((entry) => ({
              file: entry.file,
              seed: entry.impact?.seed ?? null,
              direction: entry.impact?.direction ?? null,
              bindings: entry.impact?.bindings ?? [],
              validation_kind: entry.impact?.validationKind ?? null,
              sample_line: entry.impact?.sample?.line ?? null,
            })),
            impact_index_refresh_due: impactIndexShadow.refreshDue,
            impact_index_refresh_deferred: impactIndexShadow.refreshDeferred === true,
            impact_index_stale_seed_files: impactIndexShadow.staleSeedFiles,
            impact_index_stale_witness_edges: impactIndexShadow.staleWitnessEdges,
            impact_index_bootstrap_cache_hit: impactIndexShadow.bootstrapCacheHit === true,
            impact_index_refresh_ok: impactIndexShadow.refreshOk,
            impact_index_refresh_reason: impactIndexShadow.refreshReason,
            impact_index_refresh_elapsed_ms: impactIndexShadow.refreshElapsedMs,
            impact_index_query_elapsed_ms: impactIndexShadow.queryElapsedMs,
            impact_index_cache_age_ms: impactIndexShadow.cacheAgeMs,
            impact_index_files_total: impactIndexShadow.filesTotal,
            impact_index_files_reused: impactIndexShadow.filesReused,
            impact_index_files_reindexed: impactIndexShadow.filesReindexed,
            impact_index_files_removed: impactIndexShadow.filesRemoved,
            impact_index_imports_total: impactIndexShadow.importsTotal,
            impact_index_edges_total: impactIndexShadow.edgesTotal,
            impact_index_resolved_imports: impactIndexShadow.resolvedImports,
            impact_index_unresolved_imports: impactIndexShadow.unresolvedImports,
            impact_index_neighbors_total: impactIndexShadow.neighborsTotal,
            impact_index_neighbors_shown: impactIndexShadow.neighborsShown,
            impact_index_lexical_misses: impactIndexShadow.lexicalMisses,
            impact_index_forward_neighbors: impactIndexShadow.forwardNeighbors,
            impact_index_reverse_neighbors: impactIndexShadow.reverseNeighbors,
            impact_index_candidates: impactIndexShadow.candidates,
            impact_index_routing_active: selectedImpactFiles.length > 0,
            probe_files: probeFiles.map((entry) => ({
              file: entry.file,
              queries: [...entry.queries].sort((a, b) => a - b),
              initial_rank:
                rankedFiles.findIndex((candidate) => candidate.file === entry.file) + 1,
            })),
            lexical_probed_files: probeFileSet.size,
            impact_probed_files: impactValidation.queryCount,
            probed_files: probeFileSet.size + impactValidation.queryCount,
            lexical_emitted_files: selectedLexicalFileSet.size,
            impact_emitted_files_count: selectedImpactFiles.length,
            emitted_files: selectedFileSet.size,
            selected_files: selectedFiles.map((entry) => ({
              file: entry.file,
              origin: entry.origin ?? "lexical",
              queries: [...(entry.queries ?? [])].sort((a, b) => a - b),
              coverage: entry.coverage,
              path_affinity: entry.pathAffinity,
              rarity: entry.rarity,
              initial_rank: entry.origin === "impact" ? null : entry.initialRank ?? null,
              probe_line_hits: entry.origin === "impact" ? null : entry.probeLineHits ?? 0,
              probe_exact_matches: entry.origin === "impact" ? null : entry.probeExactMatches ?? 0,
              probe_definition_hints: entry.origin === "impact" ? null : entry.probeDefinitionHints ?? 0,
              probe_rank:
                entry.origin === "impact"
                  ? null
                  : probeRankedFiles.findIndex((candidate) => candidate.file === entry.file) + 1,
              impact_seed: entry.impact?.seed ?? null,
              impact_direction: entry.impact?.direction ?? null,
              impact_bindings: entry.impact?.bindings ?? [],
              impact_validation_kind: entry.impact?.validationKind ?? null,
            })),
            retained_unread_files: Math.max(0, rankedFiles.length - probeFileSet.size),
            retained_unemitted_files: routeRendered.retained,
            probed_unemitted_files: Math.max(0, probeFileSet.size - selectedLexicalFileSet.size),
            discovery_files_by_query: discoveryResults.map((result) => ({
              query_index: result.queryIndex,
              files: result.files?.length ?? 0,
              complete: result.scanComplete,
              capped: result.scanCapped,
              timed_out: result.timedOut,
              error: result.error ?? null,
            })),
            reused_query_count: reusedQueryCount,
            executed_query_count: executedQueryCount,
            reused_queries: queryPlan
              .filter((item) => item.cached)
              .map((item) => item.query),
            query_cache_entries: state?.queryCache?.size ?? null,
            query_cache_matches: state?.queryCacheMatches ?? null,
            representation,
            source_representation: sourceRepresentation,
            unique_hits: hits.size,
            probed_unique_hits: probeHits.size,
            exact_span_hits: exactSpanHits,
            probed_exact_span_hits: probedExactSpanHits,
            distill_input_hits: distillInput.length,
            shown_hits: shownHits,
            scan_complete: scanComplete,
            evidence_complete: evidenceComplete,
            complete,
            elapsed_ms: elapsedMs,
            output_bytes: resultBytes,
            body_bytes: bodyBytes,
            body_budget_bytes: bodyBudget,
            raw_output_bytes: rawResultBytes,
            raw_body_bytes: rawRendered.bodyBytes,
            raw_evidence_complete: rawEvidenceComplete,
            selected_evidence_complete: selectedEvidenceComplete,
            raw_novel_emitted_lines: rawNovelEmittedLines,
            raw_prior_hits: rawPriorHits,
            raw_skipped_prior_lines: rawSkippedPriorLines,
            raw_suppressed_context_anchors: rawSuppressedContextAnchors,
            focused_candidate: focusedCandidate,
            focused_attempted: focusedAttempted,
            focused_reason: focusedReason,
            focused_supplement_bytes: focusedSupplementBytes,
            focused_scope_candidates: focusedScopeCandidates,
            focused_selected_scopes: focusedSelectedScopes,
            focused_reused_scopes: focusedReusedScopes,
            focused_full_scopes: focusedFullScopes,
            focused_partial_scopes: focusedPartialScopes,
            focused_radius: focusedRadius,
            focused_canonical_saved_bytes: focusedCanonicalSavedBytes,
            focused_cost_limit_bytes:
              rawResultBytes > 0
                ? Math.min(
                    rawResultBytes + FOCUSED_MAX_OVERHEAD_BYTES,
                    Math.ceil(rawResultBytes * FOCUSED_MAX_OVERHEAD_RATIO),
                  )
                : null,
            region_attempted: regionAttempted,
            region_reason: regionReason,
            region_scopes: regionScopes,
            region_sampled_scopes: regionSampledScopes,
            region_sampled_hits: regionSampledHits,
            region_retained_hits: regionRetainedHits,
            pressure_active: pressure.active,
            pressure_reasons: pressure.reasons,
            max_hits_per_file: pressure.maxHitsPerFile,
            distill_attempted: distillAttempted,
            distill_reason: distillReason,
            distill_elapsed_ms: distillElapsedMs,
            distiller_elapsed_ms: distillerElapsedMs,
            distill_ir_complete: distillIrComplete,
            distill_witness_complete: distillWitnessComplete,
            v2_grouping_preserved: v2GroupingPreserved,
            hybrid_groups: hybridGroups,
            hybrid_variants: hybridVariants,
            hybrid_body_bytes: hybridBodyBytes,
            hybrid_core_bytes: hybridCoreBytes,
            hybrid_context_samples: hybridContextSamples,
            hybrid_ratio: hybridRatio,
            variant_diversity: variantDiversity,
            index_reason: indexReason,
            index_render_complete: indexRenderComplete,
            index_files: indexFiles,
            index_samples: indexSamples,
            index_structural_groups: indexStructuralGroups,
            index_discriminative_facets: indexDiscriminativeFacets,
            refinement_required: refinementRequired,
            ledger_facts_before: ledgerFactsBefore,
            ledger_new_facts: novelty.novel.size,
            ledger_prior_facts: novelty.prior,
            ledger_facts_added: ledgerFactsAdded,
            ledger_facts_after: state?.evidenceLedger?.size ?? null,
            ledger_saturated: state?.ledgerSaturated ?? null,
            route_ledger_new_facts: routeNovelty.novel.size,
            route_ledger_prior_facts: routeNovelty.prior,
            route_ledger_facts_added: routeFactsAdded,
            route_ledger_facts_after: state?.routeLedger?.size ?? null,
            meaningful_route_progress: meaningfulRouteProgress,
            novel_positive_facts: novelFactStats.positive,
            novel_context_facts: novelFactStats.context,
            novel_negative_facts: novelFactStats.negative,
            novel_structural_facts: novelFactStats.structural,
            novel_routing_facts: novelFactStats.routing,
            no_progress: noProgress,
            no_progress_streak: state?.consecutiveNoProgress ?? null,
            no_progress_blocked: noProgressBlocked,
            contextualized_hit_lines:
              state?.contextualizedHitLines?.size ?? null,
            turn_model_calls: state?.modelCalls ?? null,
            turn_search_attempts: state?.searchAttempts ?? null,
            turn_executed_searches: state?.executedSearches ?? null,
            turn_evidence_bytes: state?.evidenceBytes ?? null,
          })

          return {
            content,
            metadata: {
              protocol: SEARCH_PROTOCOL,
              project_root: root,
              turnID: state?.turnID ?? null,
              attempt_index: attemptIndex,
              turn_model_calls: state?.modelCalls ?? null,
              turn_executed_searches: state?.executedSearches ?? null,
              turn_evidence_bytes: state?.evidenceBytes ?? null,
              representation,
              source_representation: sourceRepresentation,
              unique_hits: hits.size,
              shown_hits: shownHits,
              scan_complete: scanComplete,
              lexical_discovery_complete: discoveryComplete,
              selected_scan_complete: selectedScanComplete,
              probe_scan_complete: selectedScanComplete,
              all_discovered_files_probed: allDiscoveredFilesProbed,
              all_discovered_files_emitted: allDiscoveredFilesSelected,
              routing_active: routingActive,
              route_strategy: "query_fair_lexical8_plus_task_local_impact",
              candidate_files: rankedFiles.length,
              discovery_elapsed_ms: discoveryElapsedMs,
              refine_elapsed_ms: refineElapsedMs,
              probe_elapsed_ms: refineElapsedMs,
            impact_index_ok: impactIndexShadow.ok,
            impact_index_reason: impactIndexShadow.reason,
            impact_index_lexical_misses: impactIndexShadow.lexicalMisses,
            impact_index_neighbors_shown: impactIndexShadow.neighborsShown,
            impact_index_cache_age_ms: impactIndexShadow.cacheAgeMs,
            impact_validation_reason: impactValidation.reason,
            impact_validated: impactValidation.validated.length,
            impact_scope_owner_symbols: impactValidation.ownerSymbols,
            impact_pairwise_conditioned: impactValidation.pairwiseConditioned === true,
            impact_scope_relations_rejected: impactValidation.scopeRejected,
            impact_index_coverage_complete: impactIndexShadow.refreshComplete,
            impact_emitted_files: selectedImpactFiles.length,
            impact_index_routing_active: selectedImpactFiles.length > 0,
              lexical_probed_files: probeFileSet.size,
              impact_probed_files: impactValidation.queryCount,
              probed_files: probeFileSet.size + impactValidation.queryCount,
              lexical_emitted_files: selectedLexicalFileSet.size,
              emitted_files: selectedFileSet.size,
              probe_files: probeFiles.map((entry) => entry.file),
              selected_files: selectedFiles.map((entry) => entry.file),
              retained_unread_files: Math.max(0, rankedFiles.length - probeFileSet.size),
              retained_unemitted_files: routeRendered.retained,
              probed_unemitted_files: Math.max(0, probeFileSet.size - selectedLexicalFileSet.size),
              reused_query_count: reusedQueryCount,
              executed_query_count: executedQueryCount,
              refinement_required: refinementRequired,
              index_reason: indexReason,
              focused_reason: focusedReason,
              region_reason: regionReason,
              evidence_complete: evidenceComplete,
              complete,
              ledger_new_facts: novelty.novel.size,
              ledger_prior_facts: novelty.prior,
              route_ledger_new_facts: routeNovelty.novel.size,
              meaningful_route_progress: meaningfulRouteProgress,
              no_progress: noProgress,
              no_progress_streak: state?.consecutiveNoProgress ?? null,
              no_progress_blocked: noProgressBlocked,
              distill_attempted: distillAttempted,
              distill_reason: distillReason,
              elapsed_ms: elapsedMs,
            },
          }
        },
      })
    }))

    await track(ctx.session.hook("context", async (event) => {
      for (const name of Object.keys(event.tools)) {
        if (name !== "search") delete event.tools[name]
      }

      if (event.agent === "compaction") return

      const sessionID =
        typeof event.sessionID === "string" && event.sessionID.length > 0
          ? event.sessionID
          : null

      const state = getSessionState(sessionID)
      if (!state) return

      const root = await rootFromSession(ctx, sessionID, state)

      // Derive the user-turn boundary synchronously from the exact model
      // context. The async public event stream is telemetry, not a correctness
      // dependency, so a slow/dropped SSE event cannot reset budgets mid-turn.
      const contextTurnID = turnIDFromContext(event)
      if (contextTurnID && state.turnID !== contextTurnID) {
        resetTurnState(state, contextTurnID, nowMs())
      } else if (!state.turnID) {
        resetTurnState(state, `implicit:${sessionID}:${nowMs()}`, nowMs())
      }

      const elapsed = Math.max(0, nowMs() - state.turnStartedAt)

      if (elapsed >= MAX_TURN_WALL_MS) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: "turn_wall_budget",
          sessionID,
          turnID: state.turnID,
          project_root: root,
          elapsed_ms: elapsed,
          limit_ms: MAX_TURN_WALL_MS,
          model_calls: state.modelCalls,
        })

        throw new Error(
          `CPU_GOVERNOR turn_wall_budget elapsed_ms=${elapsed} limit_ms=${MAX_TURN_WALL_MS}`,
        )
      }

      if (state.modelCalls >= MAX_MODEL_CALLS_PER_TURN) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: "model_call_budget",
          sessionID,
          turnID: state.turnID,
          project_root: root,
          model_calls: state.modelCalls,
          limit: MAX_MODEL_CALLS_PER_TURN,
        })

        throw new Error(
          `CPU_GOVERNOR model_call_budget calls=${state.modelCalls} limit=${MAX_MODEL_CALLS_PER_TURN}`,
        )
      }

      state.modelCalls += 1
      state.lastSeen = nowMs()

      let contextBytes = null
      try {
        contextBytes = bytes(JSON.stringify({
          system: event.system,
          messages: event.messages,
          tools: event.tools,
        }))
      } catch {
        // Best-effort telemetry.
      }

      await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
        ts: nowMs(),
        protocol: AGENT_PROTOCOL,
        kind: "model_dispatch",
        sessionID,
        turnID: state.turnID,
        project_root: root,
        agent: event.agent ?? null,
        providerID: event.model?.providerID ?? null,
        modelID: event.model?.id ?? null,
        model_call: state.modelCalls,
        turn_elapsed_ms: elapsed,
        context_bytes: contextBytes,
        message_count: Array.isArray(event.messages) ? event.messages.length : null,
        tool_count:
          event.tools && typeof event.tools === "object"
            ? Object.keys(event.tools).length
            : null,
        turn_search_attempts: state.searchAttempts,
        turn_executed_searches: state.executedSearches,
        turn_evidence_bytes: state.evidenceBytes,
      })
    }))

    return async () => {
      await unsubscribeEvents()

      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }

      sessionStates.clear()
    }
  },
}
