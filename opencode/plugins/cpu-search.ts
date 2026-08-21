import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

const MAX_QUERIES = 4
const SCAN_CAP_PER_QUERY = 100
const CONTEXT_RADIUS = 2

const MAX_OUTPUT_BYTES = 6500
const BODY_BUDGET_BYTES = 5000
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024
const QUERY_TIMEOUT_MS = 1500

const SEARCH_PROTOCOL = "search-v2.3.2-global"
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

      // Exactly 100 hits are complete; the 101st proves truncation.
      if (matches.length >= SCAN_CAP_PER_QUERY) {
        scanCapped = true
        child.kill("SIGTERM")
        return
      }

      matches.push({
        file,
        line: lineNo,
        text: event.data?.lines?.text ?? "",
        queryIndex,
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
        }
        hits.set(key, item)
      }

      item.queries.add(result.queryIndex)
    }
  }

  return hits
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
    if (result.scanCapped) count = `>=${SCAN_CAP_PER_QUERY}`

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

          if (state && state.executedSearches >= MAX_EXECUTED_SEARCHES_PER_TURN) {
            return await blockSearch("executed_search_budget", {
              limit: MAX_EXECUTED_SEARCHES_PER_TURN,
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

          if (state) {
            state.signatures.add(signature)
            state.executedSearches += 1
          }

          const results = await Promise.all(
            queries.map((query, index) => runQuery(root, query, index, target, glob)),
          )

          const hits = mergeHits(results)
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

          const rendered = await renderEvidence(root, hits, bodyBudget)
          const evidenceComplete = rendered.shown.size === hits.size
          const complete = scanComplete && evidenceComplete
          const reasons = []

          if (!scanComplete) reasons.push("scan_incomplete")
          if (!evidenceComplete) reasons.push("output_budget")

          const header = [
            `SEARCH complete=${complete} scan_complete=${scanComplete} evidence_complete=${evidenceComplete} unique_hits=${hits.size} shown_hits=${rendered.shown.size}`,
            ...querySummary,
          ]

          if (reasons.length) header.push(`INCOMPLETE reasons=${reasons.join(",")}`)

          const content = [...header, "", ...rendered.body].join("\n")
          const resultBytes = bytes(content)

          if (resultBytes > callBudgetBytes) {
            return await blockSearch("internal_budget_guard", {
              result_bytes: resultBytes,
              call_budget_bytes: callBudgetBytes,
            })
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
            unique_hits: hits.size,
            shown_hits: rendered.shown.size,
            scan_complete: scanComplete,
            evidence_complete: evidenceComplete,
            complete,
            elapsed_ms: elapsedMs,
            output_bytes: resultBytes,
            body_bytes: rendered.bodyBytes,
            body_budget_bytes: bodyBudget,
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
              unique_hits: hits.size,
              shown_hits: rendered.shown.size,
              scan_complete: scanComplete,
              evidence_complete: evidenceComplete,
              complete,
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
