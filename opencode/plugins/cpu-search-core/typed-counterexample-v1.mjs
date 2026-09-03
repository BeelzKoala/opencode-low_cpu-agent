import { createHash } from "node:crypto"

export const TYPED_COUNTEREXAMPLE_PROTOCOL =
  "typed-counterexample-v1"
export const SOURCE_COUNTEREXAMPLE_MAX_REPAIRS = 2
export const SOURCE_COUNTEREXAMPLE_RENDER_MAX_BYTES = 144

const SHA256_RE = /^[0-9a-f]{64}$/u
const SOURCE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/u
const PROOF_STATES = new Set(["pass", "fail", "unknown"])
const MAX_LEDGER = SOURCE_COUNTEREXAMPLE_MAX_REPAIRS + 2

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

function sourceSha(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex")
}

function failure(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: TYPED_COUNTEREXAMPLE_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function proofVectorFor(reason) {
  const proof = {
    representation: "unknown",
    syntax: "unknown",
    required_declarations: "unknown",
    semantic_lowering: "unknown",
    materialization: "unknown",
    executor: "unknown",
    tests: "unknown",
    impact: "unknown",
  }

  if (reason === "source_slot_compiler_owned_value_echo") {
    proof.representation = "fail"
  } else if (reason === "source_fragment_syntax_invalid") {
    proof.representation = "pass"
    proof.syntax = "fail"
  } else if (reason === "source_fragment_declaration_missing") {
    proof.representation = "pass"
    proof.syntax = "pass"
    proof.required_declarations = "fail"
  } else if (
    reason === "source_fragment_top_level_kind_forbidden" ||
    reason === "source_fragment_imports_forbidden"
  ) {
    proof.representation = "pass"
    proof.syntax = "pass"
  }

  return Object.freeze(proof)
}

function classificationFor(reason) {
  switch (reason) {
    case "source_slot_compiler_owned_value_echo":
      return Object.freeze({
        layer: "representation",
        requirement: "source_text_not_compiler_identity",
        extended: true,
      })
    case "source_fragment_syntax_invalid":
      return Object.freeze({
        layer: "syntax",
        requirement: "valid_python_module_fragment",
        extended: true,
      })
    case "source_fragment_declaration_missing":
      return Object.freeze({
        layer: "structure",
        requirement: "top_level_def_or_async_def",
        extended: true,
      })
    case "source_fragment_top_level_kind_forbidden":
      return Object.freeze({
        layer: "structure",
        requirement: "allowed_top_level_python_constructs",
        extended: true,
      })
    case "source_fragment_imports_forbidden":
      return Object.freeze({
        layer: "structure",
        requirement: "slot_import_policy",
        extended: true,
      })
    default:
      return Object.freeze({
        layer: "frontend",
        requirement: "valid_source_fragment",
        extended: false,
      })
  }
}

function candidateSource({ request, sourceKey, priorRepairCache }) {
  const current = request?.sources?.[sourceKey]
  if (typeof current === "string" && current.length > 0) {
    return current
  }

  const preserved = priorRepairCache?.accepted_sources?.[sourceKey]
  if (typeof preserved === "string" && preserved.length > 0) {
    return preserved
  }

  return null
}

function diagnosticObjects(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return []
  if (Array.isArray(value)) {
    return value.flatMap((item) => diagnosticObjects(item, depth + 1))
  }
  return [
    value,
    ...Object.values(value).flatMap((item) =>
      diagnosticObjects(item, depth + 1),
    ),
  ]
}

function firstPositiveInteger(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = object?.[key]
      if (Number.isSafeInteger(value) && value > 0) return value
    }
  }
  return null
}

function clippedDiagnosticText(objects) {
  for (const object of objects) {
    for (const key of ["detail", "message", "error"]) {
      const value = object?.[key]
      if (typeof value !== "string" || value.length < 1) continue
      const compact = value.replace(/\s+/gu, " ").trim()
      if (!compact) continue
      return compact.slice(0, 96)
    }
  }
  return null
}

function parserDiagnostic(failureValue) {
  const objects = diagnosticObjects(failureValue)
  const detail = clippedDiagnosticText(objects)
  let line = firstPositiveInteger(objects, [
    "line",
    "line_number",
    "row",
  ])
  let column = firstPositiveInteger(objects, [
    "column",
    "column_number",
    "col",
  ])

  if ((!line || !column) && detail) {
    const lineMatch = detail.match(/\bline\s+(\d+)\b/iu)
    const columnMatch = detail.match(/\b(?:column|col)\s+(\d+)\b/iu)
    if (!line && lineMatch) line = Number(lineMatch[1])
    if (!column && columnMatch) column = Number(columnMatch[1])
  }

  if (!line && !column && !detail) return null

  return Object.freeze({
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    column:
      Number.isSafeInteger(column) && column > 0 ? column : null,
    detail,
  })
}

export function deriveSourceSlotCounterexample({
  failure: observedFailure,
  request,
  binding,
  priorRepairCache = null,
} = {}) {
  const reason = observedFailure?.reason
  const sourceKey = observedFailure?.source_key
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const row = rows.find((item) => item?.source_key === sourceKey)

  if (
    typeof reason !== "string" ||
    reason.length < 1 ||
    typeof sourceKey !== "string" ||
    !SOURCE_KEY_RE.test(sourceKey) ||
    !row ||
    typeof row.operation_id !== "string" ||
    !Number.isSafeInteger(row.operation_index)
  ) {
    return failure("typed_counterexample_source_identity_invalid")
  }

  const source = candidateSource({
    request,
    sourceKey,
    priorRepairCache,
  })
  if (typeof source !== "string" || source.length < 1) {
    return failure("typed_counterexample_candidate_source_unavailable", {
      source_key: sourceKey,
    })
  }

  const classification = classificationFor(reason)
  const proofVector = proofVectorFor(reason)
  const diagnostic = parserDiagnostic(observedFailure)

  const core = {
    protocol: TYPED_COUNTEREXAMPLE_PROTOCOL,
    layer: classification.layer,
    reason,
    source_key: sourceKey,
    operation_id: row.operation_id,
    operation_index: row.operation_index,
    candidate_source_sha256: sourceSha(source),
    proof_vector: proofVector,
    requirement: classification.requirement,
    diagnostic,
    extended_repair_eligible: classification.extended,
    auto_fix: false,
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    ...core,
    counterexample_sha256: sha(core),
  })
}

const PY_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u
const SEMANTIC_FREE_NAME_MAX = 256

function semanticBindingProofVector() {
  return Object.freeze({
    representation: "pass",
    syntax: "pass",
    required_declarations: "pass",
    semantic_lowering: "fail",
    materialization: "fail",
    executor: "unknown",
    tests: "unknown",
    impact: "unknown",
  })
}

function canonicalSemanticFreeNames(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SEMANTIC_FREE_NAME_MAX
  ) {
    return null
  }

  const out = []
  const seen = new Set()
  for (const name of value) {
    if (
      typeof name !== "string" ||
      !PY_IDENTIFIER_RE.test(name) ||
      seen.has(name)
    ) {
      return null
    }
    seen.add(name)
    out.push(name)
  }

  const sorted = [...out].sort()
  if (sorted.some((name, index) => name !== out[index])) {
    return null
  }
  return Object.freeze(out)
}

export function deriveSemanticSourceCounterexample({
  failure: observedFailure,
  request,
  binding,
  repairCache,
} = {}) {
  const reason = observedFailure?.reason
  if (reason !== "semantic_python_binding_unresolved") {
    return failure("typed_counterexample_semantic_reason_not_supported")
  }

  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const operationId =
    observedFailure?.operation_id ??
    observedFailure?.id ??
    null
  const operationIndex =
    Number.isSafeInteger(observedFailure?.operation_index)
      ? observedFailure.operation_index
      : null

  const rowById =
    typeof operationId === "string"
      ? rows.find((row) => row?.operation_id === operationId)
      : null
  const rowByIndex =
    Number.isSafeInteger(operationIndex)
      ? rows.find((row) => row?.operation_index === operationIndex)
      : null

  if (
    (
      typeof observedFailure?.id === "string" &&
      observedFailure.id !== operationId
    ) ||
    !rowById ||
    !rowByIndex ||
    rowById !== rowByIndex ||
    rowById.operation_id !== operationId ||
    rowById.operation_index !== operationIndex ||
    typeof rowById.source_key !== "string" ||
    !SOURCE_KEY_RE.test(rowById.source_key) ||
    typeof rowById.slot !== "string" ||
    rowById.slot.length < 1
  ) {
    return failure("typed_counterexample_semantic_operation_identity_invalid")
  }

  const sourceKey = rowById.source_key
  const failedKeys = repairCache?.failed_source_keys
  const failedSlots = repairCache?.failed_slots
  if (
    repairCache?.repairable !== true ||
    repairCache?.mutation_authority !== false ||
    typeof repairCache?.cache_sha256 !== "string" ||
    !SHA256_RE.test(repairCache.cache_sha256) ||
    repairCache?.failure_reason !== reason ||
    !Array.isArray(failedKeys) ||
    failedKeys.length !== 1 ||
    failedKeys[0] !== sourceKey ||
    !Array.isArray(failedSlots) ||
    failedSlots.length !== 1 ||
    failedSlots[0] !== rowById.slot
  ) {
    return failure("typed_counterexample_semantic_repair_cache_invalid", {
      source_key: sourceKey,
      operation_id: operationId,
      operation_index: operationIndex,
    })
  }

  const source = request?.sources?.[sourceKey]
  if (typeof source !== "string" || source.length < 1) {
    return failure("typed_counterexample_candidate_source_unavailable", {
      source_key: sourceKey,
    })
  }

  const frontend = observedFailure?.frontend
  if (
    !frontend ||
    typeof frontend !== "object" ||
    Array.isArray(frontend) ||
    frontend.reason !== reason ||
    (
      typeof observedFailure?.frontend_reason === "string" &&
      observedFailure.frontend_reason !== reason
    )
  ) {
    return failure("typed_counterexample_semantic_frontend_witness_invalid", {
      source_key: sourceKey,
    })
  }

  const symbol = frontend.symbol
  const freeNames = canonicalSemanticFreeNames(frontend.free_names)
  if (
    typeof symbol !== "string" ||
    !PY_IDENTIFIER_RE.test(symbol) ||
    !freeNames ||
    !freeNames.includes(symbol)
  ) {
    return failure("typed_counterexample_semantic_binding_witness_invalid", {
      source_key: sourceKey,
    })
  }

  const diagnostic = Object.freeze({
    symbol,
    free_name_count: freeNames.length,
    free_names_sha256: sha(freeNames),
  })

  const core = {
    protocol: TYPED_COUNTEREXAMPLE_PROTOCOL,
    layer: "binding",
    reason,
    source_key: sourceKey,
    operation_id: operationId,
    operation_index: operationIndex,
    candidate_source_sha256: sourceSha(source),
    proof_vector: semanticBindingProofVector(),
    requirement: "all_python_free_names_resolvable",
    diagnostic,
    source_repair_cache_sha256: repairCache.cache_sha256,
    extended_repair_eligible: true,
    auto_fix: false,
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    ...core,
    counterexample_sha256: sha(core),
  })
}

const CANDIDATE_OBLIGATION_LEDGER_PROTOCOL =
  "candidate-obligation-ledger-v1"
const SYMBOL_COLLISION_MAX_IDENTIFIER_BYTES = 96

function existingSymbolCollisionProofVector() {
  return Object.freeze({
    representation: "pass",
    syntax: "pass",
    required_declarations: "fail",
    semantic_lowering: "fail",
    materialization: "fail",
    executor: "unknown",
    tests: "unknown",
    impact: "unknown",
  })
}

function canonicalSingleCollisionSymbol(value) {
  if (!Array.isArray(value) || value.length !== 1) return null
  const symbol = value[0]
  if (
    typeof symbol !== "string" ||
    !PY_IDENTIFIER_RE.test(symbol) ||
    Buffer.byteLength(symbol, "utf8") > SYMBOL_COLLISION_MAX_IDENTIFIER_BYTES
  ) {
    return null
  }
  return symbol
}

function candidateLedgerGuidance(value) {
  if (value == null) return null
  if (
    value?.ok !== true ||
    value.protocol !== CANDIDATE_OBLIGATION_LEDGER_PROTOCOL ||
    value.authority !== "observation_only" ||
    value.mutation_authority !== false ||
    typeof value.ledger_sha256 !== "string" ||
    !SHA256_RE.test(value.ledger_sha256) ||
    !Array.isArray(value.consensus_references)
  ) {
    return null
  }

  for (const row of value.consensus_references) {
    if (
      row?.authority !== "observation_only" ||
      row?.candidate_bound === true ||
      typeof row?.reference_name !== "string" ||
      typeof row?.tail_symbol !== "string" ||
      !PY_IDENTIFIER_RE.test(row.tail_symbol) ||
      !Array.isArray(row.operation_ids) ||
      row.operation_ids.length < 2 ||
      !row.operation_ids.every((id) => typeof id === "string" && /^op_[0-9]+$/u.test(id))
    ) {
      continue
    }
    return Object.freeze({
      ledger_sha256: value.ledger_sha256,
      reference_name: row.reference_name,
      tail_symbol: row.tail_symbol,
      operation_ids: Object.freeze([...row.operation_ids]),
      distinct_operation_count: row.operation_ids.length,
    })
  }

  return Object.freeze({
    ledger_sha256: value.ledger_sha256,
    reference_name: null,
    tail_symbol: null,
    operation_ids: Object.freeze([]),
    distinct_operation_count: 0,
  })
}

export function deriveExistingSymbolSourceCounterexample({
  failure: observedFailure,
  request,
  binding,
  repairCache,
  candidateLedger = null,
} = {}) {
  const reason = observedFailure?.reason
  if (reason !== "semantic_python_existing_symbol_forbidden") {
    return failure("typed_counterexample_symbol_reason_not_supported")
  }

  const rows = Array.isArray(binding?.all_source_rows) ? binding.all_source_rows : []
  const operationId = observedFailure?.operation_id ?? observedFailure?.id ?? null
  const operationIndex = Number.isSafeInteger(observedFailure?.operation_index)
    ? observedFailure.operation_index
    : null
  const rowById = typeof operationId === "string"
    ? rows.find((row) => row?.operation_id === operationId)
    : null
  const rowByIndex = Number.isSafeInteger(operationIndex)
    ? rows.find((row) => row?.operation_index === operationIndex)
    : null

  if (
    (typeof observedFailure?.id === "string" && observedFailure.id !== operationId) ||
    !rowById ||
    !rowByIndex ||
    rowById !== rowByIndex ||
    rowById.operation_id !== operationId ||
    rowById.operation_index !== operationIndex ||
    typeof rowById.source_key !== "string" ||
    !SOURCE_KEY_RE.test(rowById.source_key) ||
    typeof rowById.slot !== "string" ||
    rowById.slot.length < 1
  ) {
    return failure("typed_counterexample_symbol_operation_identity_invalid")
  }

  const sourceKey = rowById.source_key
  const failedKeys = repairCache?.failed_source_keys
  const failedSlots = repairCache?.failed_slots
  if (
    repairCache?.repairable !== true ||
    repairCache?.mutation_authority !== false ||
    typeof repairCache?.cache_sha256 !== "string" ||
    !SHA256_RE.test(repairCache.cache_sha256) ||
    repairCache?.failure_reason !== reason ||
    !Array.isArray(failedKeys) ||
    failedKeys.length !== 1 ||
    failedKeys[0] !== sourceKey ||
    !Array.isArray(failedSlots) ||
    failedSlots.length !== 1 ||
    failedSlots[0] !== rowById.slot
  ) {
    return failure("typed_counterexample_symbol_repair_cache_invalid", {
      source_key: sourceKey,
      operation_id: operationId,
      operation_index: operationIndex,
    })
  }

  const source = request?.sources?.[sourceKey]
  if (typeof source !== "string" || source.length < 1) {
    return failure("typed_counterexample_candidate_source_unavailable", { source_key: sourceKey })
  }

  const frontend = observedFailure?.frontend
  if (
    !frontend ||
    typeof frontend !== "object" ||
    Array.isArray(frontend) ||
    frontend.reason !== reason ||
    (typeof observedFailure?.frontend_reason === "string" && observedFailure.frontend_reason !== reason)
  ) {
    return failure("typed_counterexample_symbol_frontend_witness_invalid", { source_key: sourceKey })
  }

  const collisionSymbol = canonicalSingleCollisionSymbol(frontend.symbols)
  if (!collisionSymbol) {
    return failure("typed_counterexample_symbol_collision_witness_invalid", { source_key: sourceKey })
  }

  const guidance = candidateLedgerGuidance(candidateLedger)
  const diagnostic = Object.freeze({
    collision_symbol: collisionSymbol,
    collision_symbol_sha256: sha(collisionSymbol),
    candidate_obligation_ledger_sha256: guidance?.ledger_sha256 ?? null,
    consensus_reference_name: guidance?.reference_name ?? null,
    consensus_symbol: guidance?.tail_symbol ?? null,
    consensus_operation_ids: guidance?.operation_ids ?? Object.freeze([]),
    consensus_count: guidance?.distinct_operation_count ?? 0,
    candidate_guidance_authority: "observation_only",
  })

  const core = {
    protocol: TYPED_COUNTEREXAMPLE_PROTOCOL,
    layer: "sym_collision",
    reason,
    source_key: sourceKey,
    operation_id: operationId,
    operation_index: operationIndex,
    candidate_source_sha256: sourceSha(source),
    proof_vector: existingSymbolCollisionProofVector(),
    requirement: "fresh_symbol",
    diagnostic,
    source_repair_cache_sha256: repairCache.cache_sha256,
    extended_repair_eligible: true,
    auto_fix: false,
    mutation_authority: false,
  }

  return Object.freeze({ ok: true, ...core, counterexample_sha256: sha(core) })
}

const ROUTE_COLLISION_MAX_BYTES = 48
const ROUTE_CONTROL_RE = /[\u0000-\u001f\u007f]/u

function routeCollisionProofVector() {
  return Object.freeze({
    representation: "pass",
    syntax: "pass",
    required_declarations: "pass",
    semantic_lowering: "fail",
    materialization: "fail",
    executor: "unknown",
    tests: "unknown",
    impact: "unknown",
  })
}

function canonicalSingleRouteCollision(value) {
  if (!Array.isArray(value) || value.length !== 1) return null
  const route = value[0]
  if (
    typeof route !== "string" ||
    route.length < 1 ||
    !route.startsWith("/") ||
    ROUTE_CONTROL_RE.test(route) ||
    Buffer.byteLength(route, "utf8") > ROUTE_COLLISION_MAX_BYTES
  ) {
    return null
  }
  return route
}

export function deriveExistingRouteSourceCounterexample({
  failure: observedFailure,
  request,
  binding,
  repairCache,
} = {}) {
  const reason = observedFailure?.reason
  if (reason !== "semantic_python_existing_route_forbidden") {
    return failure("typed_counterexample_route_reason_not_supported")
  }

  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const operationId =
    observedFailure?.operation_id ??
    observedFailure?.id ??
    null
  const operationIndex =
    Number.isSafeInteger(observedFailure?.operation_index)
      ? observedFailure.operation_index
      : null

  const rowById =
    typeof operationId === "string"
      ? rows.find((row) => row?.operation_id === operationId)
      : null
  const rowByIndex =
    Number.isSafeInteger(operationIndex)
      ? rows.find((row) => row?.operation_index === operationIndex)
      : null

  if (
    !rowById ||
    !rowByIndex ||
    rowById !== rowByIndex ||
    rowById.operation_id !== operationId ||
    rowById.operation_index !== operationIndex ||
    typeof rowById.source_key !== "string" ||
    !SOURCE_KEY_RE.test(rowById.source_key) ||
    typeof rowById.slot !== "string" ||
    rowById.slot.length < 1
  ) {
    return failure("typed_counterexample_route_operation_identity_invalid")
  }

  const sourceKey = rowById.source_key
  const failedKeys = repairCache?.failed_source_keys
  const failedSlots = repairCache?.failed_slots
  if (
    repairCache?.repairable !== true ||
    repairCache?.mutation_authority !== false ||
    typeof repairCache?.cache_sha256 !== "string" ||
    !SHA256_RE.test(repairCache.cache_sha256) ||
    repairCache?.failure_reason !== reason ||
    !Array.isArray(failedKeys) ||
    failedKeys.length !== 1 ||
    failedKeys[0] !== sourceKey ||
    !Array.isArray(failedSlots) ||
    failedSlots.length !== 1 ||
    failedSlots[0] !== rowById.slot
  ) {
    return failure("typed_counterexample_route_repair_cache_invalid", {
      source_key: sourceKey,
      operation_id: operationId,
      operation_index: operationIndex,
    })
  }

  const source = request?.sources?.[sourceKey]
  if (typeof source !== "string" || source.length < 1) {
    return failure("typed_counterexample_candidate_source_unavailable", {
      source_key: sourceKey,
    })
  }

  const frontend = observedFailure?.frontend
  if (
    !frontend ||
    typeof frontend !== "object" ||
    Array.isArray(frontend) ||
    frontend.reason !== reason ||
    (
      typeof observedFailure?.frontend_reason === "string" &&
      observedFailure.frontend_reason !== reason
    )
  ) {
    return failure("typed_counterexample_route_frontend_witness_invalid", {
      source_key: sourceKey,
    })
  }

  const collisionRoute = canonicalSingleRouteCollision(frontend.routes)
  if (!collisionRoute) {
    return failure("typed_counterexample_route_collision_witness_invalid", {
      source_key: sourceKey,
    })
  }

  const diagnostic = Object.freeze({
    collision_route: collisionRoute,
    collision_route_sha256: sha(collisionRoute),
  })

  const core = {
    protocol: TYPED_COUNTEREXAMPLE_PROTOCOL,
    layer: "route_collision",
    reason,
    source_key: sourceKey,
    operation_id: operationId,
    operation_index: operationIndex,
    candidate_source_sha256: sourceSha(source),
    proof_vector: routeCollisionProofVector(),
    requirement: "noncolliding_route",
    diagnostic,
    source_repair_cache_sha256: repairCache.cache_sha256,
    extended_repair_eligible: true,
    auto_fix: false,
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    ...core,
    counterexample_sha256: sha(core),
  })
}

export const COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL =
  "counterexample-tool-result-v1"

function freezeJsonTree(value) {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) {
    for (const item of value) freezeJsonTree(item)
    return Object.freeze(value)
  }
  for (const item of Object.values(value)) freezeJsonTree(item)
  return Object.freeze(value)
}

export function prepareCounterexampleToolResult({
  protocol,
  content,
  metadata,
} = {}) {
  if (
    typeof protocol !== "string" ||
    protocol.length < 1 ||
    typeof content !== "string" ||
    content.length < 1 ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.protocol !== protocol
  ) {
    return Object.freeze({
      ok: false,
      protocol: COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL,
      reason: "counterexample_tool_result_contract_invalid",
      mutation_authority: false,
    })
  }

  let wire
  try {
    wire = JSON.stringify({ content, metadata })
  } catch {
    return Object.freeze({
      ok: false,
      protocol: COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL,
      reason: "counterexample_tool_result_not_serializable",
      mutation_authority: false,
    })
  }

  if (typeof wire !== "string" || wire.length < 2) {
    return Object.freeze({
      ok: false,
      protocol: COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL,
      reason: "counterexample_tool_result_not_serializable",
      mutation_authority: false,
    })
  }

  let parsed
  try {
    parsed = JSON.parse(wire)
  } catch {
    return Object.freeze({
      ok: false,
      protocol: COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL,
      reason: "counterexample_tool_result_roundtrip_invalid",
      mutation_authority: false,
    })
  }

  if (
    typeof parsed?.content !== "string" ||
    parsed.content !== content ||
    !parsed?.metadata ||
    typeof parsed.metadata !== "object" ||
    Array.isArray(parsed.metadata) ||
    parsed.metadata.protocol !== protocol
  ) {
    return Object.freeze({
      ok: false,
      protocol: COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL,
      reason: "counterexample_tool_result_roundtrip_invalid",
      mutation_authority: false,
    })
  }

  return Object.freeze({
    ok: true,
    protocol: COUNTEREXAMPLE_TOOL_RESULT_PROTOCOL,
    result: freezeJsonTree(parsed),
    mutation_authority: false,
  })
}

function validCounterexample(counterexample) {
  return (
    counterexample?.ok === true &&
    counterexample.protocol === TYPED_COUNTEREXAMPLE_PROTOCOL &&
    typeof counterexample.counterexample_sha256 === "string" &&
    SHA256_RE.test(counterexample.counterexample_sha256) &&
    typeof counterexample.candidate_source_sha256 === "string" &&
    SHA256_RE.test(counterexample.candidate_source_sha256) &&
    typeof counterexample.source_key === "string" &&
    SOURCE_KEY_RE.test(counterexample.source_key) &&
    counterexample.proof_vector &&
    typeof counterexample.proof_vector === "object" &&
    Object.values(counterexample.proof_vector).every((state) =>
      PROOF_STATES.has(state),
    ) &&
    counterexample.mutation_authority === false
  )
}

function normalizedLedger(value) {
  if (!Array.isArray(value)) return []
  const rows = []
  for (const row of value.slice(-MAX_LEDGER)) {
    if (
      typeof row?.candidate_source_sha256 !== "string" ||
      !SHA256_RE.test(row.candidate_source_sha256) ||
      typeof row?.counterexample_sha256 !== "string" ||
      !SHA256_RE.test(row.counterexample_sha256)
    ) {
      continue
    }
    rows.push(Object.freeze({
      candidate_source_sha256: row.candidate_source_sha256,
      counterexample_sha256: row.counterexample_sha256,
    }))
  }
  return rows
}

export function decideSourceCounterexampleRepairAdmission({
  counterexample,
  priorLedger = [],
  repairDispatches = 0,
  failureCount = 0,
} = {}) {
  const ledger = normalizedLedger(priorLedger)
  const dispatches =
    Number.isSafeInteger(repairDispatches) && repairDispatches >= 0
      ? repairDispatches
      : 0
  const failures =
    Number.isSafeInteger(failureCount) && failureCount >= 0
      ? failureCount
      : 0

  if (!validCounterexample(counterexample)) {
    return Object.freeze({
      ok: false,
      admit_retry: false,
      reason: "source_counterexample_invalid",
      next_repair_dispatches: dispatches,
      next_failure_count: failures,
      next_ledger: Object.freeze(ledger),
      mutation_authority: false,
    })
  }

  const entry = Object.freeze({
    candidate_source_sha256:
      counterexample.candidate_source_sha256,
    counterexample_sha256:
      counterexample.counterexample_sha256,
  })
  const duplicate = ledger.some(
    (row) =>
      row.candidate_source_sha256 === entry.candidate_source_sha256,
  )
  const nextLedger = Object.freeze(
    [...ledger, entry].slice(-MAX_LEDGER),
  )
  const nextFailureCount = failures + 1

  let reason = "source_counterexample_repair_admitted"
  let admit = true

  if (duplicate) {
    reason = "source_counterexample_no_progress"
    admit = false
  } else if (dispatches >= SOURCE_COUNTEREXAMPLE_MAX_REPAIRS) {
    reason = "source_counterexample_repair_ceiling"
    admit = false
  } else if (
    dispatches >= 1 &&
    counterexample.extended_repair_eligible !== true
  ) {
    reason = "source_counterexample_extended_repair_unproven"
    admit = false
  }

  return Object.freeze({
    ok: true,
    admit_retry: admit,
    reason,
    next_repair_dispatches: admit ? dispatches + 1 : dispatches,
    next_failure_count: nextFailureCount,
    next_ledger: nextLedger,
    mutation_authority: false,
  })
}

function proofGlyph(value) {
  if (value === "pass") return "+"
  if (value === "fail") return "-"
  return "?"
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
}

export function renderTypedCounterexampleForModel(counterexample) {
  if (!validCounterexample(counterexample)) return null

  const proof = counterexample.proof_vector
  const parts = [
    `CE ${counterexample.layer}`,
    `src=${counterexample.source_key}`,
    `proof=R${proofGlyph(proof.representation)},S${proofGlyph(proof.syntax)},D${proofGlyph(proof.required_declarations)}`,
    `require=${counterexample.requirement}`,
  ]

  if (Number.isSafeInteger(counterexample?.diagnostic?.line)) {
    const column = Number.isSafeInteger(counterexample?.diagnostic?.column)
      ? counterexample.diagnostic.column
      : "?"
    parts.push(`at=${counterexample.diagnostic.line}:${column}`)
  }
  if (
    typeof counterexample?.diagnostic?.symbol === "string" &&
    PY_IDENTIFIER_RE.test(counterexample.diagnostic.symbol)
  ) {
    parts.push(`unresolved=${counterexample.diagnostic.symbol}`)
  }
  if (
    typeof counterexample?.diagnostic?.collision_route === "string"
  ) {
    parts.push(
      `collision_route=${JSON.stringify(
        counterexample.diagnostic.collision_route,
      )}`,
    )
  }
  if (
    typeof counterexample?.diagnostic?.collision_symbol === "string" &&
    PY_IDENTIFIER_RE.test(counterexample.diagnostic.collision_symbol)
  ) {
    parts.push(`exists=${counterexample.diagnostic.collision_symbol}`)
  }
  if (
    typeof counterexample?.diagnostic?.consensus_symbol === "string" &&
    PY_IDENTIFIER_RE.test(counterexample.diagnostic.consensus_symbol)
  ) {
    parts.push(`hint=${counterexample.diagnostic.consensus_symbol}`)
  }
  parts.push("auto_fix=false")

  while (parts.length > 1) {
    const rendered = parts.join(" ")
    if (utf8Bytes(rendered) <= SOURCE_COUNTEREXAMPLE_RENDER_MAX_BYTES) {
      return rendered
    }
    parts.splice(parts.length - 2, 1)
  }

  const fallback = `CE ${counterexample.layer}`
  return utf8Bytes(fallback) <= SOURCE_COUNTEREXAMPLE_RENDER_MAX_BYTES
    ? fallback
    : null
}
