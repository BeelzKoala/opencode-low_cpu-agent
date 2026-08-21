import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

const MAX_QUERIES = 4
const DISCOVERY_CAP_PER_QUERY = 1000
const CONTEXT_RADIUS = 2

const QUERY_CACHE_MAX_ENTRIES_PER_TURN = 16
const QUERY_CACHE_MAX_MATCHES_PER_TURN = 4000

const INDEX_BODY_BUDGET_BYTES = 1400
const INDEX_MAX_FILES_PER_QUERY = 5
const INDEX_MAX_STRUCTURAL_GROUPS = 6

const MAX_OUTPUT_BYTES = 6500
const BODY_BUDGET_BYTES = 5000
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024
const QUERY_TIMEOUT_MS = 1500

const DISTILLER_TIMEOUT_MS = 500
const DISTILLER_MAX_STDOUT_BYTES = 512 * 1024
const DISTILLER_RAW_BODY_PRESSURE_BYTES = 2500
const DISTILLER_MAX_HITS_PER_FILE = 12
const DISTILLER_IR_BUDGET_BYTES = 32 * 1024
const HYBRID_MIN_SAVINGS_RATIO = 0.75
const HYBRID_CONTEXT_RADIUS = 1
const HYBRID_CONTEXT_SAMPLES_PER_GROUP = 3

const SEARCH_PROTOCOL = "search-v2.6.0-global"
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

function queryCacheKey(root, query, target, glob) {
  return JSON.stringify({
    root,
    query,
    path: target,
    glob: glob ?? null,
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

function runQuery(root, query, queryIndex, target, glob) {
  return new Promise((resolve) => {
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
    args.push("--", query, target)

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

      // Exactly DISCOVERY_CAP_PER_QUERY hits are complete; the next hit proves truncation.
      if (matches.length >= DISCOVERY_CAP_PER_QUERY) {
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
    }
  }

  const shownVariants = groups.reduce(
    (total, group) => total + group.variants.length,
    0,
  )

  return {
    body,
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

function querySummaryFor(results) {
  return results.map((result) => {
    let count = String(result.matches.length)
    if (result.scanCapped) count = `>=${DISCOVERY_CAP_PER_QUERY}`

    let state = "complete"
    if (result.timedOut) state = "timeout"
    else if (result.scanCapped) state = "scan_cap"
    else if (result.error) state = "error"

    const errorDetail = result.error
      ? ` error=${JSON.stringify(clipLine(result.error, 240))}`
      : ""

    return `Q${result.queryIndex + 1} hits=${count} state=${state}${errorDetail}`
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

function renderSearchIndex(results, groups, bodyBudgetBytes) {
  const budget = Math.min(INDEX_BODY_BUDGET_BYTES, bodyBudgetBytes)
  const body = []
  let bodyBytes = 0
  let complete = true
  let sampleCount = 0
  let structuralGroupsShown = 0
  const uniqueFiles = new Set()

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

  outer:
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
          sample: clipLine(match.text, 160),
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
        entry.sample = clipLine(match.text, 160)
      }
    }

    const exactMatches = exactSpansInResult(result)
    if (
      !push(
        `Q${result.queryIndex + 1} index files=${byFile.size} ` +
          `collected_lines=${result.matches.length} exact_matches=${exactMatches}`,
      )
    ) {
      break
    }

    const ranked = [...byFile.values()].sort(
      (a, b) =>
        b.exactMatches - a.exactMatches ||
        b.lineHits - a.lineHits ||
        a.file.localeCompare(b.file),
    )

    const shown = ranked.slice(0, INDEX_MAX_FILES_PER_QUERY)

    for (const entry of shown) {
      const line =
        `  ${entry.file} lines=${entry.lineHits} exact=${entry.exactMatches}` +
        (Number.isInteger(entry.firstLine)
          ? ` sample_line=${entry.firstLine}`
          : "") +
        (entry.sample
          ? ` sample=${JSON.stringify(entry.sample)}`
          : "")

      if (!push(line)) break outer
      sampleCount += entry.sample ? 1 : 0
    }

    if (ranked.length > shown.length) {
      if (!push(`  … +${ranked.length - shown.length} files`)) break
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
        structuralGroupsShown += 1
      }

      if (complete && rankedGroups.length > shown.length) {
        push(`  … +${rankedGroups.length - shown.length} structural groups`)
      }
    }
  }

  return {
    body,
    bodyBytes,
    complete,
    fileCount: uniqueFiles.size,
    sampleCount,
    structuralGroupsShown,
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
          "Returns bounded line-numbered evidence and explicit completeness metadata.",
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

          const queryPlan = queries.map((query, index) => {
            const cacheKey = queryCacheKey(root, query, target, glob)
            const cached = state?.queryCache?.get(cacheKey) ?? null

            return {
              query,
              index,
              cacheKey,
              cached,
            }
          })

          const freshPlan = queryPlan.filter((item) => !item.cached)
          const reusedQueryCount = queryPlan.length - freshPlan.length
          const executedQueryCount = freshPlan.length

          // `executedSearches` counts tool executions that actually start rg.
          // A fully reused exact-query subset consumes an attempt/evidence
          // budget, but not an executed-search slot.
          if (
            state &&
            freshPlan.length > 0 &&
            state.executedSearches >= MAX_EXECUTED_SEARCHES_PER_TURN
          ) {
            return await blockSearch("executed_search_budget", {
              limit: MAX_EXECUTED_SEARCHES_PER_TURN,
              queries,
              path: target,
              glob: glob ?? null,
              reused_query_count: reusedQueryCount,
              executed_query_count: executedQueryCount,
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

          if (state) {
            state.signatures.add(signature)
            if (freshPlan.length > 0) state.executedSearches += 1
          }

          const freshResults = await Promise.all(
            freshPlan.map((item) =>
              runQuery(root, item.query, item.index, target, glob),
            ),
          )

          const freshByIndex = new Map(
            freshResults.map((result) => [result.queryIndex, result]),
          )

          if (state) {
            for (const item of freshPlan) {
              const result = freshByIndex.get(item.index)
              if (result) rememberQueryResult(state, item.cacheKey, result)
            }
          }

          const results = queryPlan
            .map((item) => {
              if (item.cached) {
                return reindexQueryResult(item.cached, item.index, true)
              }

              const result = freshByIndex.get(item.index)
              return result ? reindexQueryResult(result, item.index, false) : null
            })
            .filter(Boolean)
            .sort((a, b) => a.queryIndex - b.queryIndex)

          const hits = mergeHits(results)
          const exactSpanHits = [...hits.values()].reduce(
            (total, hit) => total + (Array.isArray(hit.exactSpans) ? hit.exactSpans.length : 0),
            0,
          )
          const scanComplete = results.every((result) => result.scanComplete)
          const querySummary = querySummaryFor(results)
          const callBudgetBytes = Math.min(MAX_OUTPUT_BYTES, remainingEvidenceBytes)
          const headerReserve = worstCaseHeaderBytes(scanComplete, querySummary, hits.size)

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

          const rawRendered = await renderEvidence(root, hits, bodyBudget)
          const rawEvidenceComplete = rawRendered.shown.size === hits.size
          const rawComplete = scanComplete && rawEvidenceComplete
          const rawReasons = []

          if (!scanComplete) rawReasons.push("scan_incomplete")
          if (!rawEvidenceComplete) rawReasons.push("output_budget")

          const rawHeader = [
            `SEARCH complete=${rawComplete} scan_complete=${scanComplete} evidence_complete=${rawEvidenceComplete} unique_hits=${hits.size} shown_hits=${rawRendered.shown.size}`,
            ...querySummary,
          ]

          if (rawReasons.length) {
            rawHeader.push(`INCOMPLETE reasons=${rawReasons.join(",")}`)
          }

          const rawContent = [...rawHeader, "", ...rawRendered.body].join("\n")
          const rawResultBytes = bytes(rawContent)

          if (rawResultBytes > callBudgetBytes) {
            return await blockSearch("internal_budget_guard", {
              result_bytes: rawResultBytes,
              call_budget_bytes: callBudgetBytes,
            })
          }

          const pressure = evidencePressure(hits, rawRendered, rawEvidenceComplete)
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
          let variantDiversity = null
          let distillGroupsForIndex = null

          let indexReason = null
          let indexRenderComplete = null
          let indexFiles = null
          let indexSamples = null
          let indexStructuralGroups = null
          let refinementRequired = false

          if (!scanComplete) distillReason = "scan_incomplete"
          else if (!pressure.active) distillReason = "not_needed"
          else if (!spansComplete) distillReason = "span_capture_incomplete"
          else if (distillInput.length < 1) distillReason = "no_exact_spans"
          else {
            distillAttempted = true

            const distill = await runDistiller(root, distillInput)
            distillElapsedMs = distill.elapsedMs

            if (!distill.ok) {
              distillReason = distill.reason
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

              if (!hybridRendered.complete) {
                distillReason = hybridRendered.reason ?? "hybrid_render_incomplete"
              } else {
                const contextSampled = hybridRendered.contextSamples > 0
                const hybridHeader = [
                  `SEARCH representation=hybrid complete=true scan_complete=true evidence_complete=true matches_complete=true witnesses_complete=true context_complete=false context_sampled=${contextSampled} unique_hits=${hits.size} exact_matches=${distillInput.length} shown_hits=${hits.size} groups=${hybridRendered.shownGroups} variants=${hybridRendered.shownVariants}`,
                  ...querySummary,
                ]

                const hybridContent = [
                  ...hybridHeader,
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
                  !rawEvidenceComplete || materiallySmaller

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
                  evidenceComplete = true
                  complete = true
                  distillReason = "selected"
                }
              }
            }
          }

          // INDEX is not a compressed substitute for code evidence. It is a
          // bounded routing map used only when the normal evidence cannot be
          // complete. It tells the model where to refine and explicitly
          // forbids absence conclusions from an incomplete discovery.
          if (
            representation === "raw" &&
            (!scanComplete || !rawEvidenceComplete)
          ) {
            const indexRendered = renderSearchIndex(
              results,
              distillGroupsForIndex,
              bodyBudget,
            )

            const discoveryComplete = scanComplete
            const absenceNotProven = !discoveryComplete
            const indexHeader = [
              `SEARCH representation=index complete=false scan_complete=${scanComplete} evidence_complete=false index_render_complete=${indexRendered.complete} refinement_required=true absence_not_proven=${absenceNotProven} collected_line_hits=${hits.size} exact_matches=${exactSpanHits} indexed_files=${indexRendered.fileCount}`,
              ...querySummary,
              `REFINE_REQUIRED action=search_narrower_by_file_or_api`,
            ]

            if (absenceNotProven) {
              indexHeader.push(
                "ABSENCE_NOT_PROVEN reason=discovery_incomplete do_not_conclude_no_other_matches",
              )
              indexReason = "discovery_incomplete"
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
            }
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
            discovery_cap_per_query: DISCOVERY_CAP_PER_QUERY,
            reused_query_count: reusedQueryCount,
            executed_query_count: executedQueryCount,
            reused_queries: queryPlan
              .filter((item) => item.cached)
              .map((item) => item.query),
            query_cache_entries: state?.queryCache?.size ?? null,
            query_cache_matches: state?.queryCacheMatches ?? null,
            representation,
            unique_hits: hits.size,
            exact_span_hits: exactSpanHits,
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
            refinement_required: refinementRequired,
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
              unique_hits: hits.size,
              shown_hits: shownHits,
              scan_complete: scanComplete,
              reused_query_count: reusedQueryCount,
              executed_query_count: executedQueryCount,
              refinement_required: refinementRequired,
              index_reason: indexReason,
              evidence_complete: evidenceComplete,
              complete,
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
