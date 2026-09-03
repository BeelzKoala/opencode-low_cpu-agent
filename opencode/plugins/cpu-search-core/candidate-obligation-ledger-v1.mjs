import { createHash } from "node:crypto"

export const CANDIDATE_OBLIGATION_LEDGER_PROTOCOL =
  "candidate-obligation-ledger-v1"
export const CANDIDATE_REFERENCE_ADAPTER_PROTOCOL =
  "candidate-reference-adapters-v1"

const SOURCE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/u
const PY_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u
const QUALIFIED_NAME_RE =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u
const MAX_OPERATIONS = 16
const MAX_REFERENCES = 64
const MAX_REFERENCE_BYTES = 128

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha(value) {
  return createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("hex")
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: CANDIDATE_OBLIGATION_LEDGER_PROTOCOL,
    authority: "observation_only",
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function operationRows(binding) {
  const raw = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : null
  if (!raw || raw.length < 1 || raw.length > MAX_OPERATIONS) return null

  const rows = []
  const ids = new Set()
  const indexes = new Set()
  const sourceKeys = new Set()

  for (const row of raw) {
    const operationId = row?.operation_id
    const operationIndex = row?.operation_index
    const sourceKey = row?.source_key
    const obligation = row?.obligation
    const kind = row?.kind
    if (
      typeof operationId !== "string" ||
      !/^op_[0-9]+$/u.test(operationId) ||
      !Number.isSafeInteger(operationIndex) ||
      operationIndex < 0 ||
      typeof sourceKey !== "string" ||
      !SOURCE_KEY_RE.test(sourceKey) ||
      typeof obligation !== "string" ||
      obligation.length < 1 ||
      typeof kind !== "string" ||
      kind.length < 1 ||
      ids.has(operationId) ||
      indexes.has(operationIndex) ||
      sourceKeys.has(sourceKey)
    ) {
      return null
    }
    ids.add(operationId)
    indexes.add(operationIndex)
    sourceKeys.add(sourceKey)
    rows.push(Object.freeze({
      operation_id: operationId,
      operation_index: operationIndex,
      source_key: sourceKey,
      obligation,
      kind,
    }))
  }

  return Object.freeze([...rows].sort(
    (a, b) =>
      a.operation_index - b.operation_index ||
      a.operation_id.localeCompare(b.operation_id),
  ))
}

function contentByOperation(request) {
  const contents = request?.contents
  if (!Array.isArray(contents) || contents.length < 1 || contents.length > MAX_OPERATIONS) {
    return null
  }
  const out = new Map()
  for (const item of contents) {
    const id = item?.id
    if (
      typeof id !== "string" ||
      !/^op_[0-9]+$/u.test(id) ||
      !item?.content ||
      typeof item.content !== "object" ||
      Array.isArray(item.content) ||
      out.has(id)
    ) {
      return null
    }
    out.set(id, item.content)
  }
  return out
}

function pythonDeclarations(content, row) {
  if (content?.kind !== "python_units" || !Array.isArray(content?.units)) return []
  const rows = []
  for (let unitIndex = 0; unitIndex < content.units.length; unitIndex += 1) {
    const name = content.units[unitIndex]?.name
    if (typeof name !== "string" || !PY_IDENTIFIER_RE.test(name)) continue
    rows.push(Object.freeze({
      operation_id: row.operation_id,
      operation_index: row.operation_index,
      source_key: row.source_key,
      obligation: row.obligation,
      symbol: name,
      unit_index: unitIndex,
      fact_authority: "candidate_source_observation",
    }))
  }
  return rows
}

function exactJinjaUrlForReferences(text, row) {
  if (typeof text !== "string" || text.length < 1) return []
  const re = /\burl_for\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\1/gu
  const rows = []
  let match
  while ((match = re.exec(text)) !== null) {
    const referenceName = match[2]
    if (!QUALIFIED_NAME_RE.test(referenceName) || utf8Bytes(referenceName) > MAX_REFERENCE_BYTES) {
      continue
    }
    const tailSymbol = referenceName.split(".").at(-1)
    if (typeof tailSymbol !== "string" || !PY_IDENTIFIER_RE.test(tailSymbol)) continue
    rows.push(Object.freeze({
      operation_id: row.operation_id,
      operation_index: row.operation_index,
      source_key: row.source_key,
      obligation: row.obligation,
      reference_kind: "qualified_named_reference",
      reference_name: referenceName,
      tail_symbol: tailSymbol,
      adapter: "jinja_url_for_exact_v1",
      fact_authority: "candidate_source_observation",
    }))
    if (rows.length >= MAX_REFERENCES) break
  }
  return rows
}

function exactReferences(content, row) {
  if (content?.kind !== "text" || typeof content?.text !== "string") return []
  return exactJinjaUrlForReferences(content.text, row)
}

function consensusReferences(references, declarations) {
  const declared = new Set(declarations.map((row) => row.symbol))
  const groups = new Map()
  for (const row of references) {
    const bucket = groups.get(row.reference_name) ?? []
    bucket.push(row)
    groups.set(row.reference_name, bucket)
  }

  const out = []
  for (const [referenceName, rows] of groups) {
    const operationIds = [...new Set(rows.map((row) => row.operation_id))].sort()
    if (operationIds.length < 2) continue
    const sourceKeys = [...new Set(rows.map((row) => row.source_key))].sort()
    const tailSymbol = rows[0].tail_symbol
    out.push(Object.freeze({
      reference_name: referenceName,
      tail_symbol: tailSymbol,
      operation_ids: Object.freeze(operationIds),
      source_keys: Object.freeze(sourceKeys),
      reference_count: rows.length,
      distinct_operation_count: operationIds.length,
      candidate_bound: declared.has(tailSymbol),
      authority: "observation_only",
    }))
  }

  return Object.freeze(out.sort(
    (a, b) =>
      b.distinct_operation_count - a.distinct_operation_count ||
      a.reference_name.localeCompare(b.reference_name),
  ))
}

export function deriveCandidateObligationLedger({ request, binding } = {}) {
  const operations = operationRows(binding)
  if (!operations) return fail("candidate_obligation_operation_binding_invalid")
  const contents = contentByOperation(request)
  if (!contents) return fail("candidate_obligation_content_set_invalid")

  const requiredIds = operations.map((row) => row.operation_id)
  if (contents.size !== requiredIds.length || requiredIds.some((id) => !contents.has(id))) {
    return fail("candidate_obligation_content_operation_mismatch")
  }

  const declarations = []
  const references = []
  for (const row of operations) {
    const content = contents.get(row.operation_id)
    declarations.push(...pythonDeclarations(content, row))
    references.push(...exactReferences(content, row))
    if (references.length > MAX_REFERENCES) {
      return fail("candidate_obligation_reference_budget_exceeded")
    }
  }

  const declarationRows = Object.freeze([...declarations].sort(
    (a, b) => a.operation_index - b.operation_index || a.symbol.localeCompare(b.symbol),
  ))
  const referenceRows = Object.freeze([...references].sort(
    (a, b) => a.operation_index - b.operation_index || a.reference_name.localeCompare(b.reference_name),
  ))
  const consensus = consensusReferences(referenceRows, declarationRows)

  const core = {
    protocol: CANDIDATE_OBLIGATION_LEDGER_PROTOCOL,
    reference_adapter_protocol: CANDIDATE_REFERENCE_ADAPTER_PROTOCOL,
    authority: "observation_only",
    operation_count: operations.length,
    operations,
    declared_symbols: declarationRows,
    references: referenceRows,
    consensus_references: consensus,
    candidate_unbound_consensus_count: consensus.filter((row) => row.candidate_bound !== true).length,
    mutation_authority: false,
  }

  return Object.freeze({ ok: true, ...core, ledger_sha256: sha(core) })
}
