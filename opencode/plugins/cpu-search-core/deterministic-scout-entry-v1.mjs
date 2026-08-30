import {
  DETERMINISTIC_CONTEXT_CARRIER_PROTOCOL,
  canMergeDeterministicContext,
  mergeDeterministicContext,
} from "./deterministic-context-carrier-v1.mjs"

export const DETERMINISTIC_SCOUT_ENTRY_PROTOCOL =
  "deterministic-scout-entry-v1"

const MAX_QUERIES = 4
const MAX_QUERY_CHARS = 200
const MAX_TASK_CHARS = 24 * 1024

const STOPWORDS = new Set([
  "add", "added", "also", "and", "api", "button", "change", "create",
  "data", "download", "endpoint", "existing", "export", "file", "filter",
  "for", "from", "function", "generate", "get", "html", "into", "make",
  "new", "page", "parameter", "preserve", "report", "request", "route",
  "seller", "should", "the", "this", "type", "use", "user", "with",
  "добавить", "данные", "для", "новый", "отчет", "отчёт", "страница",
  "эндпоинт", "эндпойнт",
])

const ARTIFACT_TOKENS = new Set([
  "xlsx", "xls", "csv", "json", "html", "xml", "sql", "pdf",
])

function textParts(value, out) {
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (!Array.isArray(value)) return

  for (const part of value) {
    if (typeof part === "string") {
      out.push(part)
      continue
    }
    if (!part || typeof part !== "object") continue
    for (const key of ["text", "content", "value"]) {
      if (typeof part[key] === "string") out.push(part[key])
    }
  }
}

export function taskTextFromModelMessages(messages) {
  if (!Array.isArray(messages)) return ""

  const chunks = []
  for (const message of messages) {
    if (message?.role !== "user") continue
    textParts(message?.content, chunks)
  }

  let text = chunks.join("\n").trim()
  if (!text) return ""

  const taskMarker = text.lastIndexOf("TASK:")
  if (taskMarker >= 0) {
    text = text.slice(taskMarker + "TASK:".length).trim()
  }

  if (text.length > MAX_TASK_CHARS) {
    text = text.slice(0, MAX_TASK_CHARS)
  }
  return text
}

function normalizedToken(value) {
  const token = String(value ?? "")
    .trim()
    .replace(/^[`"'([{<]+/u, "")
    .replace(/[`"')\]}>.,;:!?]+$/u, "")
  if (!token || token.length > MAX_QUERY_CHARS) return null
  return token
}

function tokenScore(token) {
  const lower = token.toLowerCase()
  if (STOPWORDS.has(lower)) return -1000

  let score = 0
  if (token.startsWith("/")) score += 16
  if (token.includes("_")) score += 14
  if (token.includes(".")) score += 12
  if (/[A-Z].*[A-Z]/u.test(token)) score += 7
  if (/[a-z][A-Z]/u.test(token)) score += 7
  if (/\d/u.test(token)) score += 3
  if (ARTIFACT_TOKENS.has(lower)) score += 6
  score += Math.min(6, Math.floor(token.length / 5))
  return score
}

function structuralToken(token) {
  const lower = token.toLowerCase()
  return (
    token.startsWith("/") ||
    token.includes("_") ||
    token.includes(".") ||
    /[a-z][A-Z]/u.test(token) ||
    ARTIFACT_TOKENS.has(lower)
  )
}

export function compileDeterministicScoutRequest({
  messages = null,
  taskShape = null,
} = {}) {
  if (
    taskShape?.status !== "compiled" ||
    taskShape?.shape !== "additive"
  ) {
    return Object.freeze({
      protocol: DETERMINISTIC_SCOUT_ENTRY_PROTOCOL,
      applied: false,
      reason: "task_shape_not_additive",
      input: null,
      routing_authority: false,
      mutation_authority: false,
    })
  }

  const text = taskTextFromModelMessages(messages)
  if (!text) {
    return Object.freeze({
      protocol: DETERMINISTIC_SCOUT_ENTRY_PROTOCOL,
      applied: false,
      reason: "task_text_unavailable",
      input: null,
      routing_authority: false,
      mutation_authority: false,
    })
  }

  const candidates = new Map()

  const add = (raw) => {
    const token = normalizedToken(raw)
    if (!token || token.length < 3) return
    const lower = token.toLowerCase()
    const score = tokenScore(token)
    if (score < 4) return
    const previous = candidates.get(lower)
    if (!previous || score > previous.score) {
      candidates.set(lower, { token, score })
    }

    if (token.includes(".")) {
      for (const part of token.split(".")) {
        if (part && part !== token) add(part)
      }
    }
  }

  for (const match of text.matchAll(
    /\/[A-Za-z0-9_.~:@%+,-]+(?:\/[A-Za-z0-9_.~:@%+,-]+)*/gu,
  )) {
    add(match[0])
  }

  for (const match of text.matchAll(
    /\b[A-Za-z_][A-Za-z0-9_.-]{2,199}\b/gu,
  )) {
    add(match[0])
  }

  const ranked = [...candidates.values()]
    .sort((a, b) =>
      b.score - a.score ||
      b.token.length - a.token.length ||
      a.token.localeCompare(b.token),
    )

  const structural = ranked.filter((row) => structuralToken(row.token))
  if (structural.length < 2) {
    return Object.freeze({
      protocol: DETERMINISTIC_SCOUT_ENTRY_PROTOCOL,
      applied: false,
      reason: "high_signal_query_seed_insufficient",
      input: null,
      routing_authority: false,
      mutation_authority: false,
    })
  }

  const selected = []
  const seen = new Set()

  for (const row of [...structural, ...ranked]) {
    const key = row.token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(row.token)
    if (selected.length >= MAX_QUERIES) break
  }

  return Object.freeze({
    protocol: DETERMINISTIC_SCOUT_ENTRY_PROTOCOL,
    applied: true,
    reason: "additive_high_signal_query_seed",
    input: Object.freeze({
      queries: Object.freeze(selected),
      path: ".",
    }),
    query_count: selected.length,
    routing_authority: false,
    mutation_authority: false,
  })
}

const DETERMINISTIC_SCOUT_CONTEXT_PRODUCER = "deterministic_scout"

export function canMergeDeterministicScoutContext(system) {
  return canMergeDeterministicContext(system)
}

export function mergeDeterministicScoutContext(
  event,
  content,
  { protocol = DETERMINISTIC_SCOUT_ENTRY_PROTOCOL } = {},
) {
  const result = mergeDeterministicContext(event, content, {
    producer: DETERMINISTIC_SCOUT_CONTEXT_PRODUCER,
    producerProtocol: protocol,
  })
  return Object.freeze({
    ...result,
    scout_protocol: protocol,
    context_carrier_protocol: DETERMINISTIC_CONTEXT_CARRIER_PROTOCOL,
  })
}

export function canAppendDeterministicScoutContext(system) {
  return typeof system === "string" || Array.isArray(system)
}

export function appendDeterministicScoutContext(
  event,
  content,
  { protocol = DETERMINISTIC_SCOUT_ENTRY_PROTOCOL } = {},
) {
  if (
    !event ||
    typeof content !== "string" ||
    content.length < 1 ||
    !canAppendDeterministicScoutContext(event.system)
  ) {
    return false
  }

  const block =
    `DETERMINISTIC_SCOUT protocol=${protocol} ` +
    `routing_authority=false mutation_authority=false\n${content}`

  if (typeof event.system === "string") {
    event.system = `${event.system}\n\n${block}`
    return true
  }

  event.system.push(block)
  return true
}
