import { createHash } from "node:crypto"
import {
  deriveSemanticContentSpec,
} from "./semantic-content-ir-v1.mjs"
import {
  ADDITIVE_SEMANTIC_LOWERING_PROTOCOL,
  proveAdditiveSemanticLoweringAuthority,
} from "./additive-mutation-v3.mjs"
import {
  canonicalizePythonModuleSourceFragment,
  inspectPythonSuiteItems,
  lowerPythonSourceFragment,
} from "./python-nested-semantic-ir-v1.mjs"
import {
  pythonUnitSchema,
  validatePythonUnitsContract,
} from "./python-unit-contract-v1.mjs"

export const SOURCE_SLOT_COMPILER_PROTOCOL =
  "source-slot-compiler-v1"
export const SOURCE_SLOT_REPAIR_PROTOCOL =
  "source-slot-repair-cache-v1"

const SHA256_RE = /^[0-9a-f]{64}$/u
const SOURCE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/u
const RESOURCE_REF_RE = /resource:\/\/([A-Za-z][A-Za-z0-9_]{0,63})/gu
const MAX_SOURCE_SLOTS = 8
const MAX_TOTAL_SOURCE_BYTES = 12 * 1024

const KIND_LIMITS = Object.freeze({
  python_declaration: 6144,
  replacement: 2048,
  creation: 8192,
})
export const SOURCE_SLOT_MODEL_CAPACITY_BYTES =
  Object.values(KIND_LIMITS)
    .reduce(
      (total, value) => total + value,
      0,
    )

const SOURCE_SLOT_ALLOWED_MODEL_LENGTHS =
  Object.freeze(
    [...new Set(Object.values(KIND_LIMITS))]
      .sort((a, b) => a - b),
  )


function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
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


function sourceSlotValueValid(value) {
  if (typeof value === "string") {
    return value.length > 0
  }
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  )
}

function sourceSlotValueClone(value) {
  return typeof value === "string"
    ? value
    : cloneJson(value)
}

function sourceSlotValueHash(value) {
  if (typeof value === "string") {
    return createHash("sha256")
      .update(value, "utf8")
      .digest("hex")
  }
  return sha(value)
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function notApplicable(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    not_applicable: true,
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
}

function sourceKey(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
  if (!SOURCE_KEY_RE.test(normalized)) return null
  return normalized
}

function modeForKind(kind) {
  if (kind === "replacement") return "after"
  if (kind === "creation") return "create"
  return null
}

function descriptionFor(row) {
  const obligation = String(row?.obligation ?? "semantic_change")
  if (row.kind === "python_declaration") {
    const importRule =
      row.allow_module_imports === true
        ? "Static top-level import/import-from statements may precede one or more "
        : "Do not add top-level imports in this slot; emit one or more "
    return (
      `Source for obligation ${obligation}. Normal Python module fragment for a deterministic existing Python slot. ` +
      importRule +
      "top-level def/async def declarations. Write source code only; " +
      "the value is source text itself, never a target filename/path. " +
      "Never emit AST/IR, slots, operation ids, anchors, or mutation-control fields. " +
      "Executable top-level statements and imports after declarations are rejected."
    )
  }
  if (row.kind === "replacement") {
    return (
      `Source for obligation ${obligation}. Emit only the smallest local target-family integration fragment ` +
      "for the deterministic existing anchor; do not emit a complete unrelated page/document. " +
      "Target, preimage, placement, path, and operation are compiler-owned."
    )
  }
  return (
    `Source for obligation ${obligation}. Emit the complete target-family content for the deterministic create slot. ` +
    "Do not emit a navigation-only fragment in place of the created resource. " +
    "Path, create root, placement, and operation are compiler-owned."
  )
}

function sourceSpec({ capability, contract } = {}) {
  if (
    capability?.ready !== true ||
    capability?.mutation_authority !== true ||
    typeof capability.capability_sha256 !== "string" ||
    !SHA256_RE.test(capability.capability_sha256) ||
    typeof capability.authority_sha256 !== "string" ||
    !SHA256_RE.test(capability.authority_sha256)
  ) {
    return fail("source_slot_capability_invalid")
  }
  if (
    contract?.ok !== true ||
    typeof contract.contract_sha256 !== "string" ||
    !SHA256_RE.test(contract.contract_sha256) ||
    !Array.isArray(contract.operations)
  ) {
    return fail("source_slot_contract_invalid")
  }

  const semantic = deriveSemanticContentSpec({ capability })
  if (semantic.ok !== true) {
    return fail("source_slot_semantic_spec_invalid", {
      detail: semantic.reason ?? null,
    })
  }

  if (
    semantic.operations.length < 1 ||
    semantic.operations.length > MAX_SOURCE_SLOTS ||
    semantic.operations.length !== contract.operations.length
  ) {
    return fail("source_slot_operation_cardinality_invalid")
  }

  const rows = []
  const used = new Set()
  for (let index = 0; index < semantic.operations.length; index += 1) {
    const operation = semantic.operations[index]
    const canonical = contract.operations[index]
    if (
      canonical?.id !== operation.id ||
      canonical?.kind !== operation.kind ||
      canonical?.obligation !== operation.obligation
    ) {
      return fail("source_slot_contract_semantic_drift", {
        operation_index: index,
      })
    }

    const key = sourceKey(operation.obligation)
    const limit = KIND_LIMITS[operation.kind]
    if (!Number.isSafeInteger(limit)) {
      return notApplicable("source_slot_operation_kind_unsupported", {
        operation_index: index,
        operation_kind: operation.kind ?? null,
      })
    }
    const loweringAuthority =
      proveAdditiveSemanticLoweringAuthority({
        capability,
        operation,
      })
    if (loweringAuthority.ok !== true) {
      return fail("source_slot_operation_lowering_authority_unproven", {
        operation_index: index,
        operation_kind: operation.kind ?? null,
        slot: operation.slot ?? null,
        lowering_authority_protocol:
          loweringAuthority.protocol ??
          ADDITIVE_SEMANTIC_LOWERING_PROTOCOL,
        lowering_authority_reason:
          loweringAuthority.reason ?? null,
        physical_operation:
          loweringAuthority.physical_operation ?? null,
        lowering_protocol:
          loweringAuthority.lowering_protocol ?? null,
      })
    }
    if (!key || used.has(key)) {
      return fail("source_slot_descriptor_invalid", {
        operation_index: index,
      })
    }
    used.add(key)
    rows.push(Object.freeze({
      source_key: key,
      operation_id: operation.id,
      operation_index: index,
      obligation: operation.obligation,
      kind: operation.kind,
      slot: operation.slot,
      physical_operation:
        loweringAuthority.physical_operation,
      lowering_protocol:
        loweringAuthority.lowering_protocol,
      allow_module_imports:
        operation.kind === "python_declaration" &&
        loweringAuthority.supports_python_imports === true,
      mode: modeForKind(operation.kind),
      max_bytes: limit,
    }))
  }

  // Activation is capability-derived, never obligation-name or repository-name derived.
  // The semantic planner may use any obligation labels as long as every operation
  // is bound to exactly one deterministically authorized slot.
  const source_spec_sha256 = sha(rows)
  return Object.freeze({
    ok: true,
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    capability_sha256: capability.capability_sha256,
    authority_sha256: capability.authority_sha256,
    semantic_contract_sha256: contract.contract_sha256,
    source_spec_sha256,
    rows: Object.freeze(rows),
    mutation_authority: false,
  })
}

function semanticAttestationIdentity(attestation, contractSha) {
  if (
    !attestation ||
    typeof attestation !== "object" ||
    typeof attestation.attestation_sha256 !== "string" ||
    !SHA256_RE.test(attestation.attestation_sha256) ||
    attestation.contract_sha256 !== contractSha
  ) {
    return null
  }
  return attestation.attestation_sha256
}

const SOURCE_SLOT_STRUCTURAL_CE_PROTOCOL =
  "source-slot-structural-counterexample-v1"
const RUFF_STRUCTURAL_WITNESS_PROTOCOL =
  "ruff-python-structural-witness-v1"
const RUFF_PARSER_INPUT_NORMALIZATION =
  "universal_newline_to_lf"
const TOP_LEVEL_KIND_FORBIDDEN_REASON =
  "source_fragment_top_level_kind_forbidden"

function shaText(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex")
}

function normalizeRuffParserInput(value) {
  return String(value ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
}

function pythonDeclarationStructuralContract(row) {
  if (row?.kind !== "python_declaration") return null
  if (row.allow_module_imports === true) {
    return Object.freeze({
      requirement:
        "module_fragment_static_import_prefix_then_function_declarations_only",
      allowed_node_kinds: Object.freeze([
        "Import",
        "ImportFrom",
        "FunctionDef",
      ]),
    })
  }
  return Object.freeze({
    requirement: "module_fragment_function_declarations_only",
    allowed_node_kinds: Object.freeze(["FunctionDef"]),
  })
}

function collectFailureRecords(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out
  if (Array.isArray(value)) {
    for (const item of value) collectFailureRecords(item, out, depth + 1)
    return out
  }
  if (typeof value !== "object") return out
  if (typeof value.reason === "string") out.push(value)
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "request" ||
      key === "raw_sources" ||
      key === "accepted_sources"
    ) {
      continue
    }
    if (child && typeof child === "object") {
      collectFailureRecords(child, out, depth + 1)
    }
  }
  return out
}

function structuralFailureRequiresWitness(failure) {
  return collectFailureRecords(failure).some(
    (row) => row.reason === TOP_LEVEL_KIND_FORBIDDEN_REASON,
  )
}

function failureSourceKeyForRows(rows, failure) {
  const records = collectFailureRecords(failure)
  for (const record of records) {
    if (typeof record.source_key === "string") {
      const row = rows.find((item) => item.source_key === record.source_key)
      if (row) return row.source_key
    }
    const operationId = record.operation_id ?? record.id ?? null
    if (typeof operationId === "string") {
      const row = rows.find((item) => item.operation_id === operationId)
      if (row) return row.source_key
    }
    if (Number.isSafeInteger(record.operation_index)) {
      const row = rows.find(
        (item) => item.operation_index === record.operation_index,
      )
      if (row) return row.source_key
    }
  }
  return null
}

function sourceLineForByteOffset(parserInput, startByte) {
  const prefix = Buffer.from(parserInput, "utf8").subarray(0, startByte)
  let line = 1
  for (const value of prefix) {
    if (value === 0x0a) line += 1
  }
  return line
}

function compileStructuralWitnessForFailure({
  binding,
  request,
  failure,
} = {}) {
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const source = rawSources(request)
  if (source.ok === false) return null
  const sourceKey = failureSourceKeyForRows(rows, failure)
  if (!sourceKey) return null
  const row = rows.find((item) => item.source_key === sourceKey)
  const contract = pythonDeclarationStructuralContract(row)
  if (!row || !contract) return null
  const rawSource = source[sourceKey]
  if (typeof rawSource !== "string" || rawSource.length < 1) return null

  const record = collectFailureRecords(failure).find(
    (item) =>
      item.reason === TOP_LEVEL_KIND_FORBIDDEN_REASON &&
      (
        item.source_key === sourceKey ||
        item.operation_id === row.operation_id ||
        item.id === row.operation_id ||
        item.operation_index === row.operation_index ||
        item.frontend?.reason === TOP_LEVEL_KIND_FORBIDDEN_REASON
      ),
  ) ?? collectFailureRecords(failure).find(
    (item) => item.reason === TOP_LEVEL_KIND_FORBIDDEN_REASON,
  )
  if (!record) return null

  const frontend =
    record.frontend && typeof record.frontend === "object"
      ? record.frontend
      : record
  const witness = frontend.structural_witness
  if (
    witness?.protocol !== RUFF_STRUCTURAL_WITNESS_PROTOCOL ||
    witness.parser !== "ruff_python_parser" ||
    witness.parser_input_normalization !== RUFF_PARSER_INPUT_NORMALIZATION ||
    typeof witness.node_kind !== "string" ||
    witness.node_kind.length < 1 ||
    !Number.isSafeInteger(witness.statement_index) ||
    witness.statement_index < 0 ||
    !Number.isSafeInteger(witness.start_byte) ||
    witness.start_byte < 0 ||
    !Number.isSafeInteger(witness.end_byte) ||
    witness.end_byte <= witness.start_byte ||
    witness.mutation_authority !== false
  ) {
    return null
  }

  const rewritten = rewriteResources(rawSource, rows)
  if (rewritten.ok !== true) return null
  const parserInput = normalizeRuffParserInput(rewritten.content)
  const parserBytes = Buffer.from(parserInput, "utf8")
  if (witness.end_byte > parserBytes.length) return null
  const spanBytes = parserBytes.subarray(
    witness.start_byte,
    witness.end_byte,
  )
  let sourceSpan
  try {
    sourceSpan = new TextDecoder("utf-8", { fatal: true }).decode(spanBytes)
  } catch {
    return null
  }
  if (Buffer.byteLength(sourceSpan, "utf8") !== spanBytes.length) return null

  const payload = {
    protocol: SOURCE_SLOT_STRUCTURAL_CE_PROTOCOL,
    failure: TOP_LEVEL_KIND_FORBIDDEN_REASON,
    source_key: sourceKey,
    slot: row.slot ?? null,
    operation_id: row.operation_id,
    operation_index: row.operation_index,
    frontend_protocol: RUFF_STRUCTURAL_WITNESS_PROTOCOL,
    parser: "ruff_python_parser",
    parser_input_normalization: RUFF_PARSER_INPUT_NORMALIZATION,
    node_kind: witness.node_kind,
    statement_index: witness.statement_index,
    start_byte: witness.start_byte,
    end_byte: witness.end_byte,
    line: sourceLineForByteOffset(parserInput, witness.start_byte),
    failed_source_sha256: shaText(rawSource),
    parser_input_sha256: shaText(parserInput),
    source_span_sha256: shaText(sourceSpan),
    requirement: contract.requirement,
    allowed_node_kinds: [...contract.allowed_node_kinds],
    mutation_authority: false,
  }
  return Object.freeze({
    ...payload,
    witness_sha256: sha(payload),
  })
}

function structuralWitnessRequiredKeys({ binding, failure } = {}) {
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const keys = []
  for (const record of collectFailureRecords(failure)) {
    if (record.reason !== TOP_LEVEL_KIND_FORBIDDEN_REASON) continue
    const key = failureSourceKeyForRows(rows, record)
    if (key && !keys.includes(key)) keys.push(key)
  }
  return Object.freeze(keys.sort())
}

function compileRepairStructuralWitnesses({
  binding,
  request,
  failure,
} = {}) {
  const witnesses = {}
  for (const record of collectFailureRecords(failure)) {
    if (record.reason !== TOP_LEVEL_KIND_FORBIDDEN_REASON) continue
    const witness = compileStructuralWitnessForFailure({
      binding,
      request,
      failure: record,
    })
    if (!witness) continue
    const prior = witnesses[witness.source_key]
    if (prior && prior.witness_sha256 !== witness.witness_sha256) {
      return Object.freeze({})
    }
    witnesses[witness.source_key] = witness
  }
  return Object.freeze(witnesses)
}

function structuralWitnessAuthorityMatches({ hint, binding } = {}) {
  const witnesses = hint?.structural_witnesses ?? {}
  if (
    !witnesses ||
    typeof witnesses !== "object" ||
    Array.isArray(witnesses)
  ) {
    return false
  }
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const failedKeys = new Set(hint?.failed_source_keys ?? [])
  const requiredKeys = hint?.structural_witness_required_keys ?? []
  if (
    !Array.isArray(requiredKeys) ||
    new Set(requiredKeys).size !== requiredKeys.length ||
    requiredKeys.some(
      (key) => typeof key !== "string" || !failedKeys.has(key),
    ) ||
    (
      hint?.failure_reason === TOP_LEVEL_KIND_FORBIDDEN_REASON &&
      requiredKeys.length < 1
    )
  ) {
    return false
  }
  const requiredSet = new Set(requiredKeys)
  const witnessEntries = Object.entries(witnesses)
  if (
    witnessEntries.some(([key]) => !requiredSet.has(key)) ||
    requiredKeys.some((key) => !(key in witnesses))
  ) {
    return false
  }
  for (const [key, witness] of witnessEntries) {
    const row = rows.find((item) => item.source_key === key)
    const contract = pythonDeclarationStructuralContract(row)
    if (
      !row ||
      !contract ||
      witness?.protocol !== SOURCE_SLOT_STRUCTURAL_CE_PROTOCOL ||
      witness.failure !== TOP_LEVEL_KIND_FORBIDDEN_REASON ||
      witness.source_key !== key ||
      witness.slot !== (row.slot ?? null) ||
      witness.operation_id !== row.operation_id ||
      witness.operation_index !== row.operation_index ||
      witness.frontend_protocol !== RUFF_STRUCTURAL_WITNESS_PROTOCOL ||
      witness.parser !== "ruff_python_parser" ||
      witness.parser_input_normalization !== RUFF_PARSER_INPUT_NORMALIZATION ||
      typeof witness.node_kind !== "string" ||
      witness.node_kind.length < 1 ||
      !Number.isSafeInteger(witness.statement_index) ||
      witness.statement_index < 0 ||
      !Number.isSafeInteger(witness.start_byte) ||
      witness.start_byte < 0 ||
      !Number.isSafeInteger(witness.end_byte) ||
      witness.end_byte <= witness.start_byte ||
      !Number.isSafeInteger(witness.line) ||
      witness.line < 1 ||
      !SHA256_RE.test(witness.failed_source_sha256 ?? "") ||
      !SHA256_RE.test(witness.parser_input_sha256 ?? "") ||
      !SHA256_RE.test(witness.source_span_sha256 ?? "") ||
      witness.requirement !== contract.requirement ||
      !Array.isArray(witness.allowed_node_kinds) ||
      witness.allowed_node_kinds.length !== contract.allowed_node_kinds.length ||
      witness.allowed_node_kinds.some(
        (value, index) => value !== contract.allowed_node_kinds[index],
      ) ||
      witness.mutation_authority !== false ||
      typeof witness.witness_sha256 !== "string" ||
      !SHA256_RE.test(witness.witness_sha256)
    ) {
      return false
    }
    const payload = { ...witness }
    delete payload.witness_sha256
    if (sha(payload) !== witness.witness_sha256) return false
  }
  return true
}


export const SOURCE_SLOT_REPAIR_CAPSULE_PROTOCOL =
  "source-slot-repair-capsule-v2"
const MAX_REPAIR_CAPSULE_EXCERPT_BYTES = 1200
const MAX_REPAIR_CAPSULE_OFFENDING_BYTES = 512

function repairCapsuleExcerpt(source, line, offendingSource) {
  const rows = String(source ?? "").split("\n")
  const index = Number.isSafeInteger(line) ? Math.max(0, line - 1) : 0
  let lo = Math.max(0, index - 3)
  let hi = Math.min(rows.length, index + 4)
  let excerpt = rows.slice(lo, hi).join("\n")
  while (
    bytes(excerpt) > MAX_REPAIR_CAPSULE_EXCERPT_BYTES &&
    hi - lo > 1
  ) {
    if (index - lo >= hi - index - 1) lo += 1
    else hi -= 1
    excerpt = rows.slice(lo, hi).join("\n")
  }
  if (
    bytes(excerpt) > MAX_REPAIR_CAPSULE_EXCERPT_BYTES ||
    !excerpt.includes(offendingSource)
  ) {
    return offendingSource
  }
  return excerpt
}

export function buildSourceSlotRepairCapsuleV2({ source, witness } = {}) {
  if (
    typeof source !== "string" ||
    source.length < 1 ||
    witness?.protocol !== SOURCE_SLOT_STRUCTURAL_CE_PROTOCOL ||
    witness.failure !== TOP_LEVEL_KIND_FORBIDDEN_REASON ||
    !SHA256_RE.test(witness.witness_sha256 ?? "") ||
    witness.failed_source_sha256 !== shaText(source)
  ) {
    return null
  }
  const parserInput = normalizeRuffParserInput(source)
  if (witness.parser_input_sha256 !== shaText(parserInput)) return null
  const parserBytes = Buffer.from(parserInput, "utf8")
  if (
    !Number.isSafeInteger(witness.start_byte) ||
    !Number.isSafeInteger(witness.end_byte) ||
    witness.start_byte < 0 ||
    witness.end_byte <= witness.start_byte ||
    witness.end_byte > parserBytes.length
  ) {
    return null
  }
  let offendingSource
  try {
    offendingSource = new TextDecoder("utf-8", { fatal: true }).decode(
      parserBytes.subarray(witness.start_byte, witness.end_byte),
    )
  } catch {
    return null
  }
  if (
    bytes(offendingSource) < 1 ||
    bytes(offendingSource) > MAX_REPAIR_CAPSULE_OFFENDING_BYTES ||
    witness.source_span_sha256 !== shaText(offendingSource)
  ) {
    return null
  }
  const payload = {
    protocol: SOURCE_SLOT_REPAIR_CAPSULE_PROTOCOL,
    failure: witness.failure,
    source_key: witness.source_key,
    node_kind: witness.node_kind,
    statement_index: witness.statement_index,
    line: witness.line,
    requirement: witness.requirement,
    allowed_node_kinds: [...witness.allowed_node_kinds],
    offending_source: offendingSource,
    failed_source_excerpt: repairCapsuleExcerpt(
      parserInput,
      witness.line,
      offendingSource,
    ),
    failed_source_sha256: witness.failed_source_sha256,
    parser_input_sha256: witness.parser_input_sha256,
    source_span_sha256: witness.source_span_sha256,
    structural_witness_sha256: witness.witness_sha256,
    authority: "failed_source_slot_only",
    accepted_siblings_policy: "frozen_byte_preserved",
    semantic_fix_provided: false,
    mutation_authority: false,
  }
  return Object.freeze({
    ...payload,
    capsule_sha256: sha(payload),
  })
}

function compileRepairCapsulesV2({ witnesses, request } = {}) {
  const source = rawSources(request)
  if (source.ok === false) return Object.freeze({})
  const capsules = {}
  for (const [key, witness] of Object.entries(witnesses ?? {})) {
    const capsule = buildSourceSlotRepairCapsuleV2({
      source: source[key],
      witness,
    })
    if (!capsule) continue
    capsules[key] = capsule
  }
  return Object.freeze(capsules)
}

function repairCapsuleAuthorityMatches({ hint } = {}) {
  const required = hint?.structural_witness_required_keys ?? []
  const witnesses = hint?.structural_witnesses ?? {}
  const capsules = hint?.repair_capsules ?? {}
  if (
    !Array.isArray(required) ||
    !capsules ||
    typeof capsules !== "object" ||
    Array.isArray(capsules) ||
    Object.keys(capsules).some((key) => !required.includes(key)) ||
    required.some((key) => !(key in capsules))
  ) {
    return false
  }
  for (const key of required) {
    const witness = witnesses[key]
    const capsule = capsules[key]
    if (
      witness?.protocol !== SOURCE_SLOT_STRUCTURAL_CE_PROTOCOL ||
      capsule?.protocol !== SOURCE_SLOT_REPAIR_CAPSULE_PROTOCOL ||
      capsule.failure !== witness.failure ||
      capsule.source_key !== key ||
      capsule.node_kind !== witness.node_kind ||
      capsule.statement_index !== witness.statement_index ||
      capsule.line !== witness.line ||
      capsule.requirement !== witness.requirement ||
      !Array.isArray(capsule.allowed_node_kinds) ||
      capsule.allowed_node_kinds.length !== witness.allowed_node_kinds.length ||
      capsule.allowed_node_kinds.some(
        (value, index) => value !== witness.allowed_node_kinds[index],
      ) ||
      typeof capsule.offending_source !== "string" ||
      bytes(capsule.offending_source) < 1 ||
      bytes(capsule.offending_source) > MAX_REPAIR_CAPSULE_OFFENDING_BYTES ||
      typeof capsule.failed_source_excerpt !== "string" ||
      bytes(capsule.failed_source_excerpt) < 1 ||
      bytes(capsule.failed_source_excerpt) > MAX_REPAIR_CAPSULE_EXCERPT_BYTES ||
      !capsule.failed_source_excerpt.includes(capsule.offending_source) ||
      capsule.failed_source_sha256 !== witness.failed_source_sha256 ||
      capsule.parser_input_sha256 !== witness.parser_input_sha256 ||
      capsule.source_span_sha256 !== witness.source_span_sha256 ||
      capsule.structural_witness_sha256 !== witness.witness_sha256 ||
      capsule.authority !== "failed_source_slot_only" ||
      capsule.accepted_siblings_policy !== "frozen_byte_preserved" ||
      capsule.semantic_fix_provided !== false ||
      capsule.mutation_authority !== false ||
      !SHA256_RE.test(capsule.capsule_sha256 ?? "")
    ) {
      return false
    }
    const payload = { ...capsule }
    delete payload.capsule_sha256
    if (sha(payload) !== capsule.capsule_sha256) return false
  }
  return true
}

export function renderSourceSlotRepairCapsuleV2(capsule) {
  if (capsule?.protocol !== SOURCE_SLOT_REPAIR_CAPSULE_PROTOCOL) return null
  return [
    "Deterministic repair capsule:",
    `failure=${capsule.failure}`,
    `node_kind=${capsule.node_kind}`,
    `statement_index=${capsule.statement_index}`,
    `line=${capsule.line}`,
    `requirement=${capsule.requirement}`,
    `allowed_node_kinds=${capsule.allowed_node_kinds.join(",")}`,
    `offending_source=${JSON.stringify(capsule.offending_source)}`,
    "failed_source_excerpt:",
    "<<<",
    capsule.failed_source_excerpt,
    ">>>",
    "Revise only this failed source slot. Accepted sibling slots are frozen byte-for-byte. The host provides no semantic fix.",
  ].join("\n")
}

function renderStructuralCounterexampleForModel(witness) {
  if (
    witness?.protocol !== SOURCE_SLOT_STRUCTURAL_CE_PROTOCOL ||
    witness.failure !== TOP_LEVEL_KIND_FORBIDDEN_REASON
  ) {
    return null
  }
  return (
    "Deterministic structural counterexample: " +
    `failure=${witness.failure} ` +
    `node_kind=${witness.node_kind} ` +
    `statement_index=${witness.statement_index} ` +
    `line=${witness.line} ` +
    `byte_range=${witness.start_byte}:${witness.end_byte} ` +
    `failed_source_sha256=${witness.failed_source_sha256} ` +
    `parser_input_sha256=${witness.parser_input_sha256} ` +
    `source_span_sha256=${witness.source_span_sha256} ` +
    `requirement=${witness.requirement} ` +
    `allowed_node_kinds=${witness.allowed_node_kinds.join(",")}. ` +
    "Revise only this failed source slot; the host does not infer or apply a semantic fix."
  )
}

function cachePayload(cache) {
  return {
    protocol: SOURCE_SLOT_REPAIR_PROTOCOL,
    source_spec_sha256: cache.source_spec_sha256,
    capability_sha256: cache.capability_sha256,
    authority_sha256: cache.authority_sha256,
    semantic_contract_sha256: cache.semantic_contract_sha256,
    semantic_attestation_sha256: cache.semantic_attestation_sha256,
    execution_context_sha256: cache.execution_context_sha256,
    failed_source_keys: cache.failed_source_keys,
    failed_slots: cache.failed_slots,
    accepted_sources: cache.accepted_sources,
    accepted_source_hashes: cache.accepted_source_hashes,
    failure_reason: cache.failure_reason,
    failed_request_sha256: cache.failed_request_sha256,
    structural_witness_required_keys:
      cache.structural_witness_required_keys ?? [],
    structural_witnesses: cache.structural_witnesses ?? {},
    repair_capsules: cache.repair_capsules ?? {},
    mutation_authority: false,
  }
}

export function sourceSlotRepairAuthorityMatches({
  hint,
  capability,
  executionContextSha256,
  binding = null,
} = {}) {
  if (
    hint?.protocol !== SOURCE_SLOT_REPAIR_PROTOCOL ||
    hint?.repairable !== true ||
    capability?.ready !== true ||
    capability?.mutation_authority !== true ||
    hint.capability_sha256 !== capability.capability_sha256 ||
    hint.authority_sha256 !== capability.authority_sha256 ||
    typeof executionContextSha256 !== "string" ||
    hint.execution_context_sha256 !== executionContextSha256 ||
    typeof hint.cache_sha256 !== "string" ||
    !SHA256_RE.test(hint.cache_sha256) ||
    !Array.isArray(hint.failed_source_keys) ||
    hint.failed_source_keys.length < 1 ||
    !Array.isArray(hint.failed_slots) ||
    hint.failed_slots.length < 1 ||
    new Set(hint.failed_source_keys).size !== hint.failed_source_keys.length ||
    new Set(hint.failed_slots).size !== hint.failed_slots.length ||
    !hint.accepted_sources ||
    typeof hint.accepted_sources !== "object" ||
    Array.isArray(hint.accepted_sources) ||
    !hint.accepted_source_hashes ||
    typeof hint.accepted_source_hashes !== "object" ||
    Array.isArray(hint.accepted_source_hashes) ||
    typeof hint.failure_reason !== "string" ||
    hint.failure_reason.length < 1
  ) {
    return false
  }
  const acceptedKeys = Object.keys(hint.accepted_sources).sort()
  const acceptedHashKeys = Object.keys(hint.accepted_source_hashes).sort()
  if (
    acceptedKeys.length !== acceptedHashKeys.length ||
    acceptedKeys.some((key, index) => key !== acceptedHashKeys[index]) ||
    acceptedKeys.some((key) => {
      const value = hint.accepted_sources[key]
      const digest = hint.accepted_source_hashes[key]
      return (
        !sourceSlotValueValid(value) ||
        typeof digest !== "string" ||
        !SHA256_RE.test(digest) ||
        sourceSlotValueHash(value) !== digest
      )
    })
  ) {
    return false
  }
  if (
    binding &&
    (
      hint.source_spec_sha256 !== binding.source_spec_sha256 ||
      hint.semantic_contract_sha256 !== binding.semantic_contract_sha256 ||
      hint.semantic_attestation_sha256 !== binding.semantic_attestation_sha256
    )
  ) {
    return false
  }
  if (binding) {
    const rows = Array.isArray(binding.all_source_rows)
      ? binding.all_source_rows
      : []
    const byKey = new Map(rows.map((row) => [row.source_key, row]))
    const expectedFailedSlots = [
      ...new Set(
        hint.failed_source_keys
          .map((key) => byKey.get(key)?.slot)
          .filter((slot) => typeof slot === "string" && slot.length > 0),
      ),
    ].sort()
    if (
      hint.failed_source_keys.some((key) => !byKey.has(key)) ||
      expectedFailedSlots.length !== hint.failed_slots.length ||
      expectedFailedSlots.some((slot, index) => slot !== [...hint.failed_slots].sort()[index]) ||
      acceptedKeys.some((key) => !byKey.has(key) || hint.failed_source_keys.includes(key))
    ) {
      return false
    }
  }
  if (!structuralWitnessAuthorityMatches({ hint, binding })) {
    return false
  }
  if (!repairCapsuleAuthorityMatches({ hint })) {
    return false
  }
  return sha(cachePayload(hint)) === hint.cache_sha256
}


export function sourceSlotTypedStructuralRepairAuthorityMatches({
  hint,
  capability,
  executionContextSha256,
  binding = null,
} = {}) {
  if (
    hint?.protocol !== SOURCE_SLOT_REPAIR_PROTOCOL ||
    hint?.repairable !== false ||
    hint?.failure_reason !== TOP_LEVEL_KIND_FORBIDDEN_REASON ||
    capability?.ready !== true ||
    capability?.mutation_authority !== true ||
    hint.capability_sha256 !== capability.capability_sha256 ||
    hint.authority_sha256 !== capability.authority_sha256 ||
    typeof executionContextSha256 !== "string" ||
    hint.execution_context_sha256 !== executionContextSha256 ||
    typeof hint.cache_sha256 !== "string" ||
    !SHA256_RE.test(hint.cache_sha256) ||
    typeof hint.failed_request_sha256 !== "string" ||
    !SHA256_RE.test(hint.failed_request_sha256) ||
    !Array.isArray(hint.failed_source_keys) ||
    hint.failed_source_keys.length !== 1 ||
    !Array.isArray(hint.failed_slots) ||
    hint.failed_slots.length !== 1 ||
    !hint.accepted_sources ||
    typeof hint.accepted_sources !== "object" ||
    Array.isArray(hint.accepted_sources) ||
    !hint.accepted_source_hashes ||
    typeof hint.accepted_source_hashes !== "object" ||
    Array.isArray(hint.accepted_source_hashes)
  ) {
    return false
  }

  const failedKey = hint.failed_source_keys[0]
  const requiredWitnessKeys =
    Array.isArray(hint.structural_witness_required_keys)
      ? [...hint.structural_witness_required_keys].sort()
      : []

  if (
    requiredWitnessKeys.length !== 1 ||
    requiredWitnessKeys[0] !== failedKey
  ) {
    return false
  }

  const witnesses =
    hint.structural_witnesses &&
    typeof hint.structural_witnesses === "object" &&
    !Array.isArray(hint.structural_witnesses)
      ? hint.structural_witnesses
      : null
  const capsules =
    hint.repair_capsules &&
    typeof hint.repair_capsules === "object" &&
    !Array.isArray(hint.repair_capsules)
      ? hint.repair_capsules
      : null

  if (
    !witnesses ||
    Object.keys(witnesses).length !== 0 ||
    !capsules ||
    Object.keys(capsules).length !== 0
  ) {
    return false
  }

  const acceptedKeys =
    Object.keys(hint.accepted_sources).sort()
  const acceptedHashKeys =
    Object.keys(hint.accepted_source_hashes).sort()

  if (
    acceptedKeys.length !== acceptedHashKeys.length ||
    acceptedKeys.some(
      (key, index) => key !== acceptedHashKeys[index],
    ) ||
    acceptedKeys.some((key) => {
      const value = hint.accepted_sources[key]
      const digest = hint.accepted_source_hashes[key]
      return (
        !sourceSlotValueValid(value) ||
        typeof digest !== "string" ||
        !SHA256_RE.test(digest) ||
        sourceSlotValueHash(value) !== digest
      )
    })
  ) {
    return false
  }

  if (
    !binding ||
    hint.source_spec_sha256 !== binding.source_spec_sha256 ||
    hint.semantic_contract_sha256 !==
      binding.semantic_contract_sha256 ||
    hint.semantic_attestation_sha256 !==
      binding.semantic_attestation_sha256
  ) {
    return false
  }

  const rows = Array.isArray(binding.all_source_rows)
    ? binding.all_source_rows
    : []
  const byKey =
    new Map(rows.map((row) => [row.source_key, row]))
  const failedRow = byKey.get(failedKey)

  if (
    failedRow?.kind !== "python_declaration" ||
    typeof failedRow?.slot !== "string" ||
    failedRow.slot.length < 1 ||
    hint.failed_slots[0] !== failedRow.slot
  ) {
    return false
  }

  const canonicalKeys =
    rows
      .map((row) => row?.source_key)
      .filter(
        (key) =>
          typeof key === "string" &&
          key.length > 0,
      )
      .sort()
  const coverageKeys =
    [...new Set([failedKey, ...acceptedKeys])].sort()

  if (
    canonicalKeys.length !== coverageKeys.length ||
    canonicalKeys.some(
      (key, index) => key !== coverageKeys[index],
    ) ||
    acceptedKeys.some(
      (key) =>
        key === failedKey ||
        !byKey.has(key),
    )
  ) {
    return false
  }

  const typed = compileTypedPythonRepairSourceSchema({
    row: failedRow,
    frontierRows: [failedRow],
    structuralWitness: null,
    repairCapsule: null,
  })

  if (
    typed?.ok !== true ||
    typed?.model_authority !==
      "semantic_unit_fields_only" ||
    typed?.mutation_authority !== false ||
    typed?.schema?.type !== "object" ||
    typed?.schema?.additionalProperties !== false
  ) {
    return false
  }

  return sha(cachePayload(hint)) === hint.cache_sha256
}

function repairCacheForSpec({
  repairCache,
  spec,
  capability,
  semanticAttestationSha,
  executionContextSha256,
} = {}) {
  if (repairCache == null) return null
  const pseudoBinding = {
    source_spec_sha256: spec.source_spec_sha256,
    semantic_contract_sha256: spec.semantic_contract_sha256,
    semantic_attestation_sha256: semanticAttestationSha,
    all_source_rows: spec.rows.map((row) => ({ ...row })),
  }
  const legacyAuthorityOk =
    sourceSlotRepairAuthorityMatches({
      hint: repairCache,
      capability,
      executionContextSha256,
      binding: pseudoBinding,
    })
  const typedStructuralAuthorityOk =
    sourceSlotTypedStructuralRepairAuthorityMatches({
      hint: repairCache,
      capability,
      executionContextSha256,
      binding: pseudoBinding,
    })

  return (
    legacyAuthorityOk ||
    typedStructuralAuthorityOk
  )
    ? repairCache
    : null
}

function toolInputSchema(tool) {
  if (!tool || typeof tool !== "object") return null
  for (const key of ["input", "inputSchema", "parameters", "schema"]) {
    const value = tool[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value
    }
  }
  return null
}


const SOURCE_SLOT_TYPED_REPAIR_PROTOCOL =
  "source-slot-typed-repair-v1"
export const SOURCE_SLOT_TYPED_INITIAL_PROTOCOL =
  "source-slot-typed-initial-v1"
const TYPED_PYTHON_REPAIR_KINDS =
  Object.freeze(["function", "async_function"])

export const PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL =
  "python-repair-field-authority-v1"

const TYPED_PYTHON_REPAIR_EVIDENCE_FIELDS =
  Object.freeze(["returns"])

function emptyTypedPythonRepairFieldAuthority() {
  return Object.freeze({
    protocol: PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
    authority: "default_closed",
    allowed_fields: Object.freeze([]),
    source_sha256: null,
    model_authority: false,
    mutation_authority: false,
  })
}

export function deriveTypedPythonRepairFieldAuthority({
  repairCapsule = null,
} = {}) {
  const candidate =
    repairCapsule?.python_unit_field_authority

  if (candidate == null) {
    return Object.freeze({
      ok: true,
      field_authority:
        emptyTypedPythonRepairFieldAuthority(),
      mutation_authority: false,
    })
  }

  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    candidate.protocol !==
      PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL ||
    candidate.authority !== "source_backed" ||
    candidate.model_authority !== false ||
    candidate.mutation_authority !== false ||
    typeof candidate.source_sha256 !== "string" ||
    !SHA256_RE.test(candidate.source_sha256) ||
    !Array.isArray(candidate.allowed_fields)
  ) {
    return fail(
      "source_slot_typed_repair_field_authority_invalid",
    )
  }

  const allowed = [
    ...new Set(candidate.allowed_fields),
  ].sort()

  if (
    allowed.length !== candidate.allowed_fields.length ||
    allowed.some(
      (field) =>
        typeof field !== "string" ||
        !TYPED_PYTHON_REPAIR_EVIDENCE_FIELDS.includes(
          field,
        ),
    )
  ) {
    return fail(
      "source_slot_typed_repair_field_authority_invalid",
    )
  }

  return Object.freeze({
    ok: true,
    field_authority: Object.freeze({
      protocol:
        PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL,
      authority: "source_backed",
      allowed_fields: Object.freeze(allowed),
      source_sha256: candidate.source_sha256,
      model_authority: false,
      mutation_authority: false,
    }),
    mutation_authority: false,
  })
}

function typedPythonRepairFieldAllowed(
  fieldAuthority,
  field,
) {
  return (
    fieldAuthority?.protocol ===
      PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL &&
    fieldAuthority?.model_authority === false &&
    fieldAuthority?.mutation_authority === false &&
    Array.isArray(fieldAuthority?.allowed_fields) &&
    fieldAuthority.allowed_fields.includes(field)
  )
}

function applyTypedPythonRepairFieldAuthority(
  schema,
  fieldAuthority,
) {
  const unionKey =
    Array.isArray(schema?.oneOf)
      ? "oneOf"
      : Array.isArray(schema?.anyOf)
        ? "anyOf"
        : null
  if (!unionKey) return null

  for (const branch of schema[unionKey]) {
    if (
      !branch?.properties ||
      typeof branch.properties !== "object" ||
      Array.isArray(branch.properties)
    ) {
      return null
    }

    const required = Array.isArray(branch.required)
      ? branch.required
      : []

    for (
      const field of
      TYPED_PYTHON_REPAIR_EVIDENCE_FIELDS
    ) {
      const allowed =
        typedPythonRepairFieldAllowed(
          fieldAuthority,
          field,
        )

      if (!allowed && required.includes(field)) {
        return null
      }

      if (!allowed) {
        delete branch.properties[field]
      }
    }
  }

  return schema
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const observed = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    observed.length === wanted.length &&
    observed.every((key, index) => key === wanted[index])
  )
}

function pythonUnitKindFromSchema(branch) {
  const kind = branch?.properties?.kind
  if (typeof kind?.const === "string") return kind.const
  if (Array.isArray(kind?.enum) && kind.enum.length === 1) {
    return kind.enum[0]
  }
  return null
}


export const PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL =
  "python-repair-model-capacity-v2"
const PYTHON_REPAIR_MODEL_CAPACITY_DERIVATION =
  "frontier_share_semantic_allocation_v1"

const PYTHON_REPAIR_CAPACITY_FRONTIER_NUMERATOR = 5
const PYTHON_REPAIR_CAPACITY_FRONTIER_DENOMINATOR = 6
const PYTHON_REPAIR_CAPACITY_MIN_SERIALIZED_BYTES = 1024
const PYTHON_REPAIR_CAPACITY_HARD_FRONTIER_BYTES = 6144
const PYTHON_REPAIR_CAPACITY_JSON_RESERVE_BYTES = 320

const PYTHON_REPAIR_CAPACITY_MAX_UNITS_HARD = 3
const PYTHON_REPAIR_CAPACITY_UNIT_QUANTUM_BYTES = 1536
const PYTHON_REPAIR_CAPACITY_MULTI_UNIT_MIN_SUITE_CHARS = 1200

const PYTHON_REPAIR_CAPACITY_NAME_MIN_CHARS = 64
const PYTHON_REPAIR_CAPACITY_NAME_MAX_CHARS = 128
const PYTHON_REPAIR_CAPACITY_PARAMETERS_MIN_CHARS = 96
const PYTHON_REPAIR_CAPACITY_PARAMETERS_MAX_CHARS = 384
const PYTHON_REPAIR_CAPACITY_RETURNS_MIN_CHARS = 96
const PYTHON_REPAIR_CAPACITY_RETURNS_MAX_CHARS = 256
const PYTHON_REPAIR_CAPACITY_DECORATOR_MAX_ITEMS_HARD = 3
const PYTHON_REPAIR_CAPACITY_DECORATOR_MIN_CHARS = 96
const PYTHON_REPAIR_CAPACITY_DECORATOR_MAX_CHARS = 192
const PYTHON_REPAIR_CAPACITY_SUITE_MIN_TOTAL_CHARS = 480
const PYTHON_REPAIR_CAPACITY_SUITE_MAX_ITEMS_HARD = 8
const PYTHON_REPAIR_CAPACITY_SUITE_MIN_CHUNK_CHARS = 160
const PYTHON_REPAIR_CAPACITY_SUITE_MAX_CHUNK_CHARS = 512

function clampRepairCapacity(value, minimum, maximum) {
  return Math.max(
    minimum,
    Math.min(maximum, Math.trunc(value)),
  )
}

function repairCapacityProfileCore(profile) {
  if (!profile || typeof profile !== "object") return null
  const { profile_sha256: _ignored, ...core } = profile
  return core
}

function sealRepairCapacityProfile(core) {
  return Object.freeze({
    ...core,
    profile_sha256: sha(core),
  })
}

function typedPythonRepairReturnsAllowed(fieldAuthority) {
  return (
    Array.isArray(fieldAuthority?.allowed_fields) &&
    fieldAuthority.allowed_fields.includes("returns")
  )
}

function normalizeRepairCapacityFrontierRows(row, frontierRows) {
  const rows =
    Array.isArray(frontierRows) && frontierRows.length > 0
      ? frontierRows
      : [row]

  const normalized = []
  const seen = new Set()

  for (const candidate of rows) {
    const key = candidate?.source_key
    const maxBytes = candidate?.max_bytes

    if (
      typeof key !== "string" ||
      key.length < 1 ||
      seen.has(key) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    ) {
      return null
    }

    seen.add(key)
    normalized.push({ source_key: key, max_bytes: maxBytes })
  }

  if (
    typeof row?.source_key !== "string" ||
    !seen.has(row.source_key)
  ) {
    return null
  }

  return normalized.sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  )
}

function repairFrontierCapacityGeometry(row, frontierRows) {
  const normalized = normalizeRepairCapacityFrontierRows(
    row,
    frontierRows,
  )
  if (!normalized) return null

  const frontierCanonicalBytes = normalized.reduce(
    (sum, candidate) => sum + candidate.max_bytes,
    0,
  )

  if (
    !Number.isSafeInteger(frontierCanonicalBytes) ||
    frontierCanonicalBytes < 1
  ) {
    return null
  }

  const frontierEnvelopeBytes = Math.min(
    PYTHON_REPAIR_CAPACITY_HARD_FRONTIER_BYTES,
    Math.floor(
      (frontierCanonicalBytes *
        PYTHON_REPAIR_CAPACITY_FRONTIER_NUMERATOR) /
        PYTHON_REPAIR_CAPACITY_FRONTIER_DENOMINATOR,
    ),
  )

  const rowShareBytes = Math.floor(
    (frontierEnvelopeBytes * row.max_bytes) /
      frontierCanonicalBytes,
  )

  const standaloneRowCeilingBytes = Math.floor(
    (row.max_bytes * PYTHON_REPAIR_CAPACITY_FRONTIER_NUMERATOR) /
      PYTHON_REPAIR_CAPACITY_FRONTIER_DENOMINATOR,
  )

  const serializedMaxBytes = Math.min(
    row.max_bytes,
    standaloneRowCeilingBytes,
    rowShareBytes,
  )

  return Object.freeze({
    frontier_source_count: normalized.length,
    frontier_source_capacity_bytes: frontierCanonicalBytes,
    frontier_generation_envelope_bytes: frontierEnvelopeBytes,
    row_frontier_share_bytes: rowShareBytes,
    serialized_max_bytes: serializedMaxBytes,
  })
}

function capacityForUnitCount({
  serializedMaxBytes,
  unitCount,
  returnsAllowed,
}) {
  const usable = Math.max(
    0,
    serializedMaxBytes - PYTHON_REPAIR_CAPACITY_JSON_RESERVE_BYTES,
  )
  const perUnitBudget = Math.floor(usable / unitCount)

  const nameMaxChars = clampRepairCapacity(
    Math.floor((perUnitBudget * 6) / 100),
    PYTHON_REPAIR_CAPACITY_NAME_MIN_CHARS,
    PYTHON_REPAIR_CAPACITY_NAME_MAX_CHARS,
  )
  const parametersMaxChars = clampRepairCapacity(
    Math.floor((perUnitBudget * 12) / 100),
    PYTHON_REPAIR_CAPACITY_PARAMETERS_MIN_CHARS,
    PYTHON_REPAIR_CAPACITY_PARAMETERS_MAX_CHARS,
  )
  const returnsMaxChars = clampRepairCapacity(
    Math.floor((perUnitBudget * 8) / 100),
    PYTHON_REPAIR_CAPACITY_RETURNS_MIN_CHARS,
    PYTHON_REPAIR_CAPACITY_RETURNS_MAX_CHARS,
  )
  const decoratorMaxItems = clampRepairCapacity(
    Math.floor(perUnitBudget / 1200),
    1,
    PYTHON_REPAIR_CAPACITY_DECORATOR_MAX_ITEMS_HARD,
  )
  const decoratorMaxChars = clampRepairCapacity(
    Math.floor((perUnitBudget * 7) / 100),
    PYTHON_REPAIR_CAPACITY_DECORATOR_MIN_CHARS,
    PYTHON_REPAIR_CAPACITY_DECORATOR_MAX_CHARS,
  )

  const fixedSemanticChars =
    nameMaxChars +
    parametersMaxChars +
    decoratorMaxItems * decoratorMaxChars +
    (returnsAllowed ? returnsMaxChars : 0) +
    128

  const suiteBudget = perUnitBudget - fixedSemanticChars
  if (suiteBudget < PYTHON_REPAIR_CAPACITY_SUITE_MIN_TOTAL_CHARS) {
    return null
  }

  const suiteMaxItems = clampRepairCapacity(
    Math.ceil(suiteBudget / 384),
    3,
    PYTHON_REPAIR_CAPACITY_SUITE_MAX_ITEMS_HARD,
  )
  const suiteChunkMaxChars = clampRepairCapacity(
    Math.floor(suiteBudget / suiteMaxItems),
    PYTHON_REPAIR_CAPACITY_SUITE_MIN_CHUNK_CHARS,
    PYTHON_REPAIR_CAPACITY_SUITE_MAX_CHUNK_CHARS,
  )

  return Object.freeze({
    name_max_chars: nameMaxChars,
    parameters_max_chars: parametersMaxChars,
    returns_max_chars: returnsMaxChars,
    decorator_max_items: decoratorMaxItems,
    decorator_max_chars: decoratorMaxChars,
    suite_max_items: suiteMaxItems,
    suite_chunk_max_chars: suiteChunkMaxChars,
    suite_total_chars_per_unit:
      suiteMaxItems * suiteChunkMaxChars,
  })
}

export function deriveTypedPythonRepairModelCapacity({
  row,
  frontierRows = null,
  fieldAuthority = null,
} = {}) {
  if (
    row?.kind !== "python_declaration" ||
    typeof row?.source_key !== "string" ||
    row.source_key.length < 1 ||
    !Number.isSafeInteger(row?.max_bytes) ||
    row.max_bytes < 1
  ) {
    return fail("source_slot_typed_repair_capacity_row_invalid")
  }

  const geometry = repairFrontierCapacityGeometry(row, frontierRows)
  if (!geometry) {
    return fail("source_slot_typed_repair_capacity_frontier_invalid")
  }

  if (
    geometry.serialized_max_bytes <
    PYTHON_REPAIR_CAPACITY_MIN_SERIALIZED_BYTES
  ) {
    return fail("source_slot_typed_repair_capacity_too_small", {
      source_slot_max_bytes: row.max_bytes,
      frontier_source_count: geometry.frontier_source_count,
      frontier_source_capacity_bytes:
        geometry.frontier_source_capacity_bytes,
      row_frontier_share_bytes: geometry.row_frontier_share_bytes,
      serialized_max_bytes: geometry.serialized_max_bytes,
    })
  }

  const returnsAllowed = typedPythonRepairReturnsAllowed(fieldAuthority)
  const candidateUnitCount = clampRepairCapacity(
    Math.floor(
      geometry.serialized_max_bytes /
        PYTHON_REPAIR_CAPACITY_UNIT_QUANTUM_BYTES,
    ),
    1,
    PYTHON_REPAIR_CAPACITY_MAX_UNITS_HARD,
  )

  let selected = null
  let selectedUnitCount = null

  for (
    let unitCount = candidateUnitCount;
    unitCount >= 1;
    unitCount -= 1
  ) {
    const candidate = capacityForUnitCount({
      serializedMaxBytes: geometry.serialized_max_bytes,
      unitCount,
      returnsAllowed,
    })
    if (!candidate) continue
    if (
      unitCount > 1 &&
      candidate.suite_total_chars_per_unit <
        PYTHON_REPAIR_CAPACITY_MULTI_UNIT_MIN_SUITE_CHARS
    ) {
      continue
    }
    selected = candidate
    selectedUnitCount = unitCount
    break
  }

  if (!selected || !Number.isSafeInteger(selectedUnitCount)) {
    return fail("source_slot_typed_repair_capacity_unavailable", {
      source_slot_max_bytes: row.max_bytes,
      serialized_max_bytes: geometry.serialized_max_bytes,
      returns_allowed: returnsAllowed,
    })
  }

  const core = Object.freeze({
    protocol: PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL,
    derivation: PYTHON_REPAIR_MODEL_CAPACITY_DERIVATION,
    source_slot_max_bytes: row.max_bytes,
    frontier_source_count: geometry.frontier_source_count,
    frontier_source_capacity_bytes:
      geometry.frontier_source_capacity_bytes,
    frontier_generation_envelope_bytes:
      geometry.frontier_generation_envelope_bytes,
    row_frontier_share_bytes: geometry.row_frontier_share_bytes,
    serialized_max_bytes: geometry.serialized_max_bytes,
    max_units: selectedUnitCount,
    name_max_chars: selected.name_max_chars,
    parameters_max_chars: selected.parameters_max_chars,
    returns_max_chars: selected.returns_max_chars,
    decorator_max_items: selected.decorator_max_items,
    decorator_max_chars: selected.decorator_max_chars,
    suite_max_items: selected.suite_max_items,
    suite_chunk_max_chars: selected.suite_chunk_max_chars,
    suite_total_chars_per_unit: selected.suite_total_chars_per_unit,
    returns_authorized: returnsAllowed,
    repo_size_authority: false,
    wall_time_widening_authority: false,
    governor_widening_authority: false,
    model_authority: false,
    mutation_authority: false,
  })

  return Object.freeze({
    ok: true,
    capacity_profile: sealRepairCapacityProfile(core),
    mutation_authority: false,
  })
}

function validRepairCapacityProfile(profile) {
  const core = repairCapacityProfileCore(profile)
  if (
    !core ||
    profile.protocol !== PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL ||
    profile.derivation !== PYTHON_REPAIR_MODEL_CAPACITY_DERIVATION ||
    typeof profile.profile_sha256 !== "string" ||
    !SHA256_RE.test(profile.profile_sha256) ||
    sha(core) !== profile.profile_sha256 ||
    profile.repo_size_authority !== false ||
    profile.wall_time_widening_authority !== false ||
    profile.governor_widening_authority !== false ||
    profile.model_authority !== false ||
    profile.mutation_authority !== false
  ) {
    return false
  }

  const integerFields = [
    "source_slot_max_bytes",
    "frontier_source_count",
    "frontier_source_capacity_bytes",
    "frontier_generation_envelope_bytes",
    "row_frontier_share_bytes",
    "serialized_max_bytes",
    "max_units",
    "name_max_chars",
    "parameters_max_chars",
    "returns_max_chars",
    "decorator_max_items",
    "decorator_max_chars",
    "suite_max_items",
    "suite_chunk_max_chars",
    "suite_total_chars_per_unit",
  ]

  if (
    integerFields.some(
      (field) =>
        !Number.isSafeInteger(profile[field]) ||
        profile[field] < 0,
    )
  ) {
    return false
  }

  return (
    profile.frontier_source_count >= 1 &&
    profile.frontier_source_capacity_bytes >= profile.source_slot_max_bytes &&
    profile.frontier_generation_envelope_bytes <=
      PYTHON_REPAIR_CAPACITY_HARD_FRONTIER_BYTES &&
    profile.row_frontier_share_bytes <=
      profile.frontier_generation_envelope_bytes &&
    profile.serialized_max_bytes <= profile.row_frontier_share_bytes &&
    profile.serialized_max_bytes <= profile.source_slot_max_bytes &&
    profile.max_units >= 1 &&
    profile.max_units <= PYTHON_REPAIR_CAPACITY_MAX_UNITS_HARD &&
    profile.name_max_chars <= PYTHON_REPAIR_CAPACITY_NAME_MAX_CHARS &&
    profile.parameters_max_chars <=
      PYTHON_REPAIR_CAPACITY_PARAMETERS_MAX_CHARS &&
    profile.returns_max_chars <= PYTHON_REPAIR_CAPACITY_RETURNS_MAX_CHARS &&
    profile.decorator_max_items <=
      PYTHON_REPAIR_CAPACITY_DECORATOR_MAX_ITEMS_HARD &&
    profile.decorator_max_chars <=
      PYTHON_REPAIR_CAPACITY_DECORATOR_MAX_CHARS &&
    profile.suite_max_items <= PYTHON_REPAIR_CAPACITY_SUITE_MAX_ITEMS_HARD &&
    profile.suite_chunk_max_chars <=
      PYTHON_REPAIR_CAPACITY_SUITE_MAX_CHUNK_CHARS
  )
}

function standaloneTypedPythonRepairCapacity(fieldAuthority) {
  const row = {
    source_key: "standalone",
    kind: "python_declaration",
    max_bytes: 3072,
  }
  return deriveTypedPythonRepairModelCapacity({
    row,
    frontierRows: [row],
    fieldAuthority,
  })
}

function tightenRepairStringSchema(property, maxLength) {
  if (
    !property ||
    typeof property !== "object" ||
    Array.isArray(property) ||
    property.type !== "string"
  ) {
    return false
  }
  property.maxLength = Math.min(
    Number.isSafeInteger(property.maxLength)
      ? property.maxLength
      : maxLength,
    maxLength,
  )
  return true
}

function tightenRepairStringArraySchema(
  property,
  { maxItems, itemMaxLength },
) {
  if (
    !property ||
    typeof property !== "object" ||
    Array.isArray(property) ||
    property.type !== "array" ||
    !property.items ||
    typeof property.items !== "object" ||
    Array.isArray(property.items) ||
    property.items.type !== "string"
  ) {
    return false
  }
  property.maxItems = Math.min(
    Number.isSafeInteger(property.maxItems)
      ? property.maxItems
      : maxItems,
    maxItems,
  )
  property.items.maxLength = Math.min(
    Number.isSafeInteger(property.items.maxLength)
      ? property.items.maxLength
      : itemMaxLength,
    itemMaxLength,
  )
  return true
}

function applyTypedPythonRepairModelCapacity(schema, capacityProfile) {
  if (!validRepairCapacityProfile(capacityProfile)) return null
  const unionKey =
    Array.isArray(schema?.oneOf)
      ? "oneOf"
      : Array.isArray(schema?.anyOf)
        ? "anyOf"
        : null
  if (!unionKey) return null

  for (const branch of schema[unionKey]) {
    const properties = branch?.properties
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return null
    }
    if (!tightenRepairStringSchema(properties.name, capacityProfile.name_max_chars)) {
      return null
    }
    if (
      properties.parameters &&
      !tightenRepairStringSchema(
        properties.parameters,
        capacityProfile.parameters_max_chars,
      )
    ) {
      return null
    }
    if (
      properties.returns &&
      !tightenRepairStringSchema(
        properties.returns,
        capacityProfile.returns_max_chars,
      )
    ) {
      return null
    }
    if (
      properties.decorators &&
      !tightenRepairStringArraySchema(properties.decorators, {
        maxItems: capacityProfile.decorator_max_items,
        itemMaxLength: capacityProfile.decorator_max_chars,
      })
    ) {
      return null
    }
    if (
      !tightenRepairStringArraySchema(properties.suite, {
        maxItems: capacityProfile.suite_max_items,
        itemMaxLength: capacityProfile.suite_chunk_max_chars,
      })
    ) {
      return null
    }
  }
  return schema
}

function repairCapacityStringWithin(value, maxChars) {
  return typeof value === "string" && Array.from(value).length <= maxChars
}

export function validateTypedPythonRepairModelCapacity(units, capacityProfile) {
  if (!validRepairCapacityProfile(capacityProfile)) {
    return fail("source_slot_typed_repair_capacity_profile_invalid")
  }
  if (
    !Array.isArray(units) ||
    units.length < 1 ||
    units.length > capacityProfile.max_units
  ) {
    return fail("source_slot_typed_repair_unit_budget_exceeded", {
      max_units: capacityProfile.max_units,
    })
  }

  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex]
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) continue

    if (!repairCapacityStringWithin(unit.name, capacityProfile.name_max_chars)) {
      return fail("source_slot_typed_repair_name_budget_exceeded", {
        unit_index: unitIndex,
        field: "name",
        max_chars: capacityProfile.name_max_chars,
      })
    }
    if (
      Object.hasOwn(unit, "parameters") &&
      !repairCapacityStringWithin(
        unit.parameters,
        capacityProfile.parameters_max_chars,
      )
    ) {
      return fail("source_slot_typed_repair_parameters_budget_exceeded", {
        unit_index: unitIndex,
        field: "parameters",
        max_chars: capacityProfile.parameters_max_chars,
      })
    }
    if (
      Object.hasOwn(unit, "returns") &&
      !repairCapacityStringWithin(unit.returns, capacityProfile.returns_max_chars)
    ) {
      return fail("source_slot_typed_repair_returns_budget_exceeded", {
        unit_index: unitIndex,
        field: "returns",
        max_chars: capacityProfile.returns_max_chars,
      })
    }
    if (Object.hasOwn(unit, "decorators")) {
      if (
        !Array.isArray(unit.decorators) ||
        unit.decorators.length > capacityProfile.decorator_max_items
      ) {
        return fail("source_slot_typed_repair_decorator_budget_exceeded", {
          unit_index: unitIndex,
          field: "decorators",
          max_items: capacityProfile.decorator_max_items,
        })
      }
      for (
        let decoratorIndex = 0;
        decoratorIndex < unit.decorators.length;
        decoratorIndex += 1
      ) {
        if (
          !repairCapacityStringWithin(
            unit.decorators[decoratorIndex],
            capacityProfile.decorator_max_chars,
          )
        ) {
          return fail("source_slot_typed_repair_decorator_budget_exceeded", {
            unit_index: unitIndex,
            decorator_index: decoratorIndex,
            field: "decorators",
            max_chars: capacityProfile.decorator_max_chars,
          })
        }
      }
    }
    if (
      !Array.isArray(unit.suite) ||
      unit.suite.length < 1 ||
      unit.suite.length > capacityProfile.suite_max_items
    ) {
      return fail("source_slot_typed_repair_suite_budget_exceeded", {
        unit_index: unitIndex,
        field: "suite",
        max_items: capacityProfile.suite_max_items,
      })
    }
    for (let suiteIndex = 0; suiteIndex < unit.suite.length; suiteIndex += 1) {
      if (
        !repairCapacityStringWithin(
          unit.suite[suiteIndex],
          capacityProfile.suite_chunk_max_chars,
        )
      ) {
        return fail("source_slot_typed_repair_suite_budget_exceeded", {
          unit_index: unitIndex,
          suite_index: suiteIndex,
          field: "suite",
          max_chars: capacityProfile.suite_chunk_max_chars,
        })
      }
    }
  }

  const serializedBytes = Buffer.byteLength(stableJson({ units }), "utf8")
  if (serializedBytes > capacityProfile.serialized_max_bytes) {
    return fail("source_slot_typed_repair_payload_budget_exceeded", {
      serialized_bytes: serializedBytes,
      max_bytes: capacityProfile.serialized_max_bytes,
    })
  }

  return Object.freeze({
    ok: true,
    protocol: PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL,
    capacity_profile_sha256: capacityProfile.profile_sha256,
    serialized_bytes: serializedBytes,
    mutation_authority: false,
  })
}

function typedRepairSchemaGenerationCapacity(row) {
  const description = String(row?.description ?? "")
  if (
    !description.includes(
      `repair_model_capacity=${PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL}`,
    )
  ) {
    return null
  }

  const match = description.match(
    /(?:^|; )serialized_max_bytes=(\d+)(?:;|$)/,
  )
  if (!match) return null
  const value = Number(match[1])
  return (
    Number.isSafeInteger(value) &&
    value >= PYTHON_REPAIR_CAPACITY_MIN_SERIALIZED_BYTES &&
    value <= PYTHON_REPAIR_CAPACITY_HARD_FRONTIER_BYTES
      ? value
      : null
  )
}

export const TYPED_PYTHON_REPAIR_SEMANTIC_HOLE_PROTOCOL =
  "typed-python-repair-semantic-hole-v1"

const TYPED_PYTHON_REPAIR_PARAMETER_PATTERN =
  String.raw`^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*|\*[A-Za-z_][A-Za-z0-9_]*|\*\*[A-Za-z_][A-Za-z0-9_]*|/|\*)(?:\s*,\s*(?:[A-Za-z_][A-Za-z0-9_]*|\*[A-Za-z_][A-Za-z0-9_]*|\*\*[A-Za-z_][A-Za-z0-9_]*|/|\*))*)?\s*$`

const TYPED_PYTHON_REPAIR_DECORATOR_PATTERN =
  String.raw`^\s*@?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\([^\r\n]*\))?\s*$`

// Generation guard only. Ruff AST is the semantic authority below.
const TYPED_PYTHON_REPAIR_SUITE_GENERATION_PATTERN =
  String.raw`^\s*(?:(?:return|raise|break|continue)(?:\s+\S[\s\S]*)?|(?:[rRuUbBfF]{0,2})(?:"[\s\S]*"|'[\s\S]*')|[A-Za-z_][A-Za-z0-9_]*(?:\s+\S[\s\S]*|[^A-Za-z0-9_\s][\s\S]*))\s*$`

const TYPED_PYTHON_REPAIR_PARAMETER_TOKEN_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*|\*[A-Za-z_][A-Za-z0-9_]*|\*\*[A-Za-z_][A-Za-z0-9_]*|\/|\*)$/u

const TYPED_PYTHON_REPAIR_DECORATOR_RE =
  /^@?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\([^\r\n]*\))?$/u

const TYPED_PYTHON_REPAIR_RESERVED_PARAMETER_NAMES = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield",
])

function appendRepairSemanticDescription(target, text) {
  if (!target || typeof target !== "object") return false
  const previous = typeof target.description === "string"
    ? target.description.trim()
    : ""
  target.description = [previous, text].filter(Boolean).join(" ")
  return true
}

function applyRepairStringPattern(property, pattern, description) {
  if (
    !property ||
    typeof property !== "object" ||
    Array.isArray(property) ||
    property.type !== "string" ||
    (typeof property.pattern === "string" && property.pattern !== pattern)
  ) return false

  property.pattern = pattern
  appendRepairSemanticDescription(property, description)
  return true
}

function applyTypedPythonRepairSemanticHoleSchema(schema) {
  const unionKey = Array.isArray(schema?.oneOf)
    ? "oneOf"
    : Array.isArray(schema?.anyOf)
      ? "anyOf"
      : null
  if (!unionKey) return null

  for (const branch of schema[unionKey]) {
    const properties = branch?.properties
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return null
    }

    if (
      properties.parameters &&
      !applyRepairStringPattern(
        properties.parameters,
        TYPED_PYTHON_REPAIR_PARAMETER_PATTERN,
        "REPAIR_PARAMETER_AUTHORITY=unannotated_names_only; annotations and defaults are default-closed in typed repair.",
      )
    ) return null

    if (properties.decorators) {
      const decorators = properties.decorators
      if (
        decorators?.type !== "array" ||
        !decorators.items ||
        typeof decorators.items !== "object" ||
        Array.isArray(decorators.items) ||
        !applyRepairStringPattern(
          decorators.items,
          TYPED_PYTHON_REPAIR_DECORATOR_PATTERN,
          "REPAIR_DECORATOR_AUTHORITY=dotted_name_or_single_line_call; prose, role metadata and multiline source are forbidden.",
        )
      ) return null
    }

    const suite = properties.suite
    if (
      suite?.type !== "array" ||
      !suite.items ||
      typeof suite.items !== "object" ||
      Array.isArray(suite.items) ||
      !applyRepairStringPattern(
        suite.items,
        TYPED_PYTHON_REPAIR_SUITE_GENERATION_PATTERN,
        "REPAIR_SUITE_GENERATION_GUARD=statement_shaped; Ruff AST remains semantic authority.",
      )
    ) return null
  }

  return schema
}

function repairParameterName(token) {
  if (token === "/" || token === "*") return null
  return token.replace(/^\*{1,2}/u, "")
}

function validateTypedPythonRepairParameters(raw, unitIndex) {
  if (raw == null || raw === "") {
    return Object.freeze({ ok: true, mutation_authority: false })
  }
  if (typeof raw !== "string") {
    return fail("source_slot_typed_repair_parameter_surface_invalid", {
      unit_index: unitIndex,
      field: "parameters",
    })
  }

  const tokens = raw.split(",").map((value) => value.trim())
  if (
    tokens.length < 1 ||
    tokens.some((token) => !TYPED_PYTHON_REPAIR_PARAMETER_TOKEN_RE.test(token))
  ) {
    return fail("source_slot_typed_repair_parameter_surface_invalid", {
      unit_index: unitIndex,
      field: "parameters",
      parameter_authority: "unannotated_names_only",
    })
  }

  const names = new Set()
  let slashSeen = false
  let keywordBoundarySeen = false
  let varargSeen = false
  let kwargSeen = false
  let ordinaryBeforeSlash = 0

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (token === "/") {
      if (slashSeen || keywordBoundarySeen || ordinaryBeforeSlash < 1 || index === tokens.length - 1) {
        return fail("source_slot_typed_repair_parameter_layout_invalid", {
          unit_index: unitIndex,
          parameter_index: index,
          field: "parameters",
        })
      }
      slashSeen = true
      continue
    }

    if (token === "*") {
      if (keywordBoundarySeen || varargSeen || kwargSeen || index === tokens.length - 1) {
        return fail("source_slot_typed_repair_parameter_layout_invalid", {
          unit_index: unitIndex,
          parameter_index: index,
          field: "parameters",
        })
      }
      keywordBoundarySeen = true
      continue
    }

    if (token.startsWith("**")) {
      if (kwargSeen || index !== tokens.length - 1) {
        return fail("source_slot_typed_repair_parameter_layout_invalid", {
          unit_index: unitIndex,
          parameter_index: index,
          field: "parameters",
        })
      }
      kwargSeen = true
      keywordBoundarySeen = true
    } else if (token.startsWith("*")) {
      if (varargSeen || keywordBoundarySeen || kwargSeen) {
        return fail("source_slot_typed_repair_parameter_layout_invalid", {
          unit_index: unitIndex,
          parameter_index: index,
          field: "parameters",
        })
      }
      varargSeen = true
      keywordBoundarySeen = true
    } else if (!keywordBoundarySeen) {
      ordinaryBeforeSlash += 1
    }

    const name = repairParameterName(token)
    if (
      !name ||
      TYPED_PYTHON_REPAIR_RESERVED_PARAMETER_NAMES.has(name) ||
      names.has(name)
    ) {
      return fail("source_slot_typed_repair_parameter_name_invalid", {
        unit_index: unitIndex,
        parameter_index: index,
        field: "parameters",
      })
    }
    names.add(name)
  }

  return Object.freeze({ ok: true, mutation_authority: false })
}

function suiteObservationHasExecutableStatement(observation) {
  const shapes = Array.isArray(observation?.statement_shapes)
    ? observation.statement_shapes
    : null
  if (!shapes) return false

  for (const chunk of shapes) {
    if (!Array.isArray(chunk)) return false
    for (const shape of chunk) {
      if (shape !== "bare_name_expr" && shape !== "string_literal_expr") {
        return true
      }
    }
  }
  return false
}

export function validateTypedPythonRepairSemanticHoles(units) {
  if (!Array.isArray(units)) {
    return fail("source_slot_typed_repair_semantic_hole_units_invalid")
  }

  const unitNames = new Set()

  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex]
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) continue

    if (typeof unit.name === "string" && unitNames.has(unit.name)) {
      return fail("source_slot_typed_repair_duplicate_unit_name", {
        unit_index: unitIndex,
        field: "name",
      })
    }
    if (typeof unit.name === "string") unitNames.add(unit.name)

    const parameters = validateTypedPythonRepairParameters(
      unit.parameters ?? "",
      unitIndex,
    )
    if (parameters.ok !== true) return parameters

    if (Array.isArray(unit.decorators)) {
      for (let decoratorIndex = 0; decoratorIndex < unit.decorators.length; decoratorIndex += 1) {
        const decorator = unit.decorators[decoratorIndex]
        if (
          typeof decorator !== "string" ||
          !TYPED_PYTHON_REPAIR_DECORATOR_RE.test(decorator.trim())
        ) {
          return fail("source_slot_typed_repair_decorator_surface_invalid", {
            unit_index: unitIndex,
            decorator_index: decoratorIndex,
            field: "decorators",
          })
        }
      }
    }

    const suiteObservation = inspectPythonSuiteItems(unit.suite)
    if (suiteObservation.ok !== true) {
      return fail(
        suiteObservation.reason ?? "source_slot_typed_repair_suite_observation_failed",
        {
          unit_index: unitIndex,
          field: "suite",
          suite_protocol: suiteObservation.suite_protocol ?? null,
          parser_detail: suiteObservation.parser_detail ?? null,
        },
      )
    }

    if (!suiteObservationHasExecutableStatement(suiteObservation)) {
      return fail("source_slot_typed_repair_inert_suite", {
        unit_index: unitIndex,
        field: "suite",
        statement_shapes: suiteObservation.statement_shapes,
        semantic_authority: "ruff_python_ast",
      })
    }
  }

  return Object.freeze({
    ok: true,
    protocol: TYPED_PYTHON_REPAIR_SEMANTIC_HOLE_PROTOCOL,
    parameter_authority: "unannotated_names_only",
    parameter_defaults_authorized: false,
    parameter_annotations_authorized: false,
    decorator_authority: "dotted_name_or_single_line_call",
    suite_authority: "ruff_python_ast_statement_shapes",
    duplicate_unit_names_forbidden: true,
    model_authority: false,
    mutation_authority: false,
  })
}


function restrictedPythonRepairUnitSchema(
  fieldAuthority,
  capacityProfile,
) {
  const schema = cloneJson(pythonUnitSchema({ context: "top" }))
  const unionKey =
    Array.isArray(schema?.oneOf)
      ? "oneOf"
      : Array.isArray(schema?.anyOf)
        ? "anyOf"
        : null
  if (!unionKey) return null

  const selected = schema[unionKey].filter((branch) =>
    TYPED_PYTHON_REPAIR_KINDS.includes(
      pythonUnitKindFromSchema(branch),
    ),
  )
  const observedKinds = selected
    .map(pythonUnitKindFromSchema)
    .sort()

  if (
    selected.length !== TYPED_PYTHON_REPAIR_KINDS.length ||
    observedKinds.join(",") !==
      [...TYPED_PYTHON_REPAIR_KINDS].sort().join(",")
  ) {
    return null
  }

  schema[unionKey] = selected

  const fieldRestricted =
    applyTypedPythonRepairFieldAuthority(
      schema,
      fieldAuthority,
    )
  if (!fieldRestricted) return null

  const capacityRestricted =
    applyTypedPythonRepairModelCapacity(
      fieldRestricted,
      capacityProfile,
    )
  if (!capacityRestricted) return null

  return applyTypedPythonRepairSemanticHoleSchema(
    capacityRestricted,
  )
}

export function compileTypedPythonRepairSourceSchema({
  row,
  frontierRows = null,
  structuralWitness = null,
  repairCapsule = null,
} = {}) {
  if (
    row?.kind !== "python_declaration" ||
    !Number.isSafeInteger(row?.max_bytes) ||
    row.max_bytes < 1
  ) {
    return fail("source_slot_typed_repair_row_invalid")
  }

  const fieldAuthorityResult =
    deriveTypedPythonRepairFieldAuthority({
      repairCapsule,
    })
  if (fieldAuthorityResult.ok !== true) {
    return fieldAuthorityResult
  }
  const fieldAuthority =
    fieldAuthorityResult.field_authority

  const capacityResult =
    deriveTypedPythonRepairModelCapacity({
      row,
      frontierRows,
      fieldAuthority,
    })
  if (capacityResult.ok !== true) {
    return capacityResult
  }
  const capacityProfile =
    capacityResult.capacity_profile

  const itemSchema =
    restrictedPythonRepairUnitSchema(
      fieldAuthority,
      capacityProfile,
    )
  if (!itemSchema) {
    return fail("source_slot_typed_repair_contract_unavailable")
  }

  const repairEvidence =
    renderSourceSlotRepairCapsuleV2(repairCapsule) ??
    renderStructuralCounterexampleForModel(structuralWitness)

  return Object.freeze({
    ok: true,
    protocol: SOURCE_SLOT_TYPED_REPAIR_PROTOCOL,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        units: {
          type: "array",
          minItems: 1,
          maxItems:
            capacityProfile.max_units,
          items: itemSchema,
          description: [
            "Typed Python declaration delta.",
            "Emit only function or async_function units.",
            "Raw module text, top-level assignments, classes, and whole-module replay are not representable.",
            repairEvidence,
          ].filter(Boolean).join(" "),
        },
      },
      required: ["units"],
      description: [
        "SOURCE_REPRESENTATION=typed_python_units",
        `protocol=${SOURCE_SLOT_TYPED_REPAIR_PROTOCOL}`,
        "allowed_kinds=function|async_function",
        "raw_module_text=forbidden",
        "whole_module_replay=forbidden",
        `semantic_hole_protocol=${TYPED_PYTHON_REPAIR_SEMANTIC_HOLE_PROTOCOL}`,
        "parameter_annotations=default_closed",
        "parameter_defaults=default_closed",
        "parameter_surface=unannotated_names_only",
        "decorator_surface=dotted_name_or_single_line_call",
        "suite_semantic_authority=ruff_python_ast",
        "inert_suite=forbidden",
        "duplicate_unit_names=forbidden",
        `repair_model_capacity=${PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL}`,
        `capacity_derivation=${capacityProfile.derivation}`,
        `capacity_profile_sha256=${capacityProfile.profile_sha256}`,
        `frontier_source_count=${capacityProfile.frontier_source_count}`,
        `frontier_source_capacity_bytes=${capacityProfile.frontier_source_capacity_bytes}`,
        `frontier_generation_envelope_bytes=${capacityProfile.frontier_generation_envelope_bytes}`,
        `row_frontier_share_bytes=${capacityProfile.row_frontier_share_bytes}`,
        `source_slot_max_bytes=${capacityProfile.source_slot_max_bytes}`,
        `serialized_max_bytes=${capacityProfile.serialized_max_bytes}`,
        `max_units=${capacityProfile.max_units}`,
        `suite_max_items=${capacityProfile.suite_max_items}`,
        `suite_chunk_max_chars=${capacityProfile.suite_chunk_max_chars}`,
        "repo_size_widening=false",
        "wall_time_widening=false",
        "governor_widening=false",
        `returns_authority=${fieldAuthority.authority}`,
        repairEvidence,
      ].filter(Boolean).join("; "),
    },
    capacity_bytes: row.max_bytes,
    field_authority: fieldAuthority,
    capacity_profile: capacityProfile,
    semantic_hole_protocol:
      TYPED_PYTHON_REPAIR_SEMANTIC_HOLE_PROTOCOL,
    mutation_authority: false,
    model_authority: "semantic_unit_fields_only",
  })
}

export function validateTypedPythonRepairSource(
  value,
  {
    fieldAuthority = null,
    capacityProfile = null,
  } = {},
) {
  if (!exactObjectKeys(value, ["units"])) {
    return fail("source_slot_typed_repair_required")
  }
  if (
    !Array.isArray(value.units) ||
    value.units.length < 1
  ) {
    return fail("source_slot_typed_repair_units_invalid")
  }

  const effectiveFieldAuthority =
    fieldAuthority ??
    emptyTypedPythonRepairFieldAuthority()

  if (
    effectiveFieldAuthority.protocol !==
      PYTHON_REPAIR_FIELD_AUTHORITY_PROTOCOL ||
    effectiveFieldAuthority.model_authority !== false ||
    effectiveFieldAuthority.mutation_authority !== false ||
    !Array.isArray(
      effectiveFieldAuthority.allowed_fields,
    )
  ) {
    return fail(
      "source_slot_typed_repair_field_authority_invalid",
    )
  }

  for (
    let unitIndex = 0;
    unitIndex < value.units.length;
    unitIndex += 1
  ) {
    const unit = value.units[unitIndex]
    if (
      !unit ||
      typeof unit !== "object" ||
      Array.isArray(unit)
    ) {
      continue
    }

    for (
      const field of
      TYPED_PYTHON_REPAIR_EVIDENCE_FIELDS
    ) {
      if (
        Object.hasOwn(unit, field) &&
        !typedPythonRepairFieldAllowed(
          effectiveFieldAuthority,
          field,
        )
      ) {
        return fail(
          "source_slot_typed_repair_field_unauthorized",
          {
            unit_index: unitIndex,
            field,
            field_authority:
              effectiveFieldAuthority.authority ??
              null,
          },
        )
      }
    }
  }

  let effectiveCapacityProfile =
    capacityProfile

  if (effectiveCapacityProfile == null) {
    const standaloneCapacity =
      standaloneTypedPythonRepairCapacity(
        effectiveFieldAuthority,
      )
    if (standaloneCapacity.ok !== true) {
      return standaloneCapacity
    }
    effectiveCapacityProfile =
      standaloneCapacity.capacity_profile
  }

  const capacityAdmission =
    validateTypedPythonRepairModelCapacity(
      value.units,
      effectiveCapacityProfile,
    )
  if (capacityAdmission.ok !== true) {
    return capacityAdmission
  }

  const semanticHoleAdmission =
    validateTypedPythonRepairSemanticHoles(
      value.units,
    )
  if (semanticHoleAdmission.ok !== true) {
    return semanticHoleAdmission
  }

  const admission = validatePythonUnitsContract(value.units)
  if (admission?.ok !== true) {
    return fail(
      admission?.reason ?? "source_slot_typed_repair_contract_invalid",
      { detail: admission?.detail ?? null },
    )
  }

  for (let unitIndex = 0; unitIndex < value.units.length; unitIndex += 1) {
    const kind = value.units[unitIndex]?.kind
    if (!TYPED_PYTHON_REPAIR_KINDS.includes(kind)) {
      return fail("source_slot_typed_repair_kind_forbidden", {
        unit_index: unitIndex,
        unit_kind: kind ?? null,
      })
    }
  }

  return Object.freeze({
    ok: true,
    protocol: SOURCE_SLOT_TYPED_REPAIR_PROTOCOL,
    units: cloneJson(value.units),
    mutation_authority: false,
  })
}

function rewriteTypedRepairValue(value, rows) {
  if (typeof value === "string") {
    const rewritten = rewriteResources(value, rows)
    if (rewritten.ok !== true) return rewritten
    return Object.freeze({ ok: true, value: rewritten.content })
  }
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const rewritten = rewriteTypedRepairValue(item, rows)
      if (rewritten.ok !== true) return rewritten
      out.push(rewritten.value)
    }
    return Object.freeze({ ok: true, value: out })
  }
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const rewritten = rewriteTypedRepairValue(item, rows)
      if (rewritten.ok !== true) return rewritten
      out[key] = rewritten.value
    }
    return Object.freeze({ ok: true, value: out })
  }
  return Object.freeze({ ok: true, value })
}

function typedRepairSchemaCapacity(row) {
  const units = row?.properties?.units
  if (
    row?.type !== "object" ||
    row?.additionalProperties !== false ||
    !Array.isArray(row?.required) ||
    row.required.length !== 1 ||
    row.required[0] !== "units" ||
    units?.type !== "array" ||
    units.minItems !== 1 ||
    !Number.isSafeInteger(units.maxItems) ||
    units.maxItems < 1 ||
    units.maxItems > PYTHON_REPAIR_CAPACITY_MAX_UNITS_HARD ||
    !units.items ||
    typeof units.items !== "object"
  ) {
    return null
  }

  const description = String(row.description ?? "")
  if (
    !description.includes("SOURCE_REPRESENTATION=typed_python_units") ||
    !description.includes(SOURCE_SLOT_TYPED_REPAIR_PROTOCOL) ||
    !description.includes(
      `repair_model_capacity=${PYTHON_REPAIR_MODEL_CAPACITY_PROTOCOL}`,
    )
  ) {
    return null
  }

  return KIND_LIMITS.python_declaration
}

export function deriveSourceSlotSchemaFrontier(tool) {
  const schema = toolInputSchema(tool)
  const sources =
    schema?.properties?.sources ??
    schema?.properties?.holes

  if (
    !sources ||
    typeof sources !== "object" ||
    Array.isArray(sources) ||
    sources.type !== "object" ||
    sources.additionalProperties !== false ||
    !sources.properties ||
    typeof sources.properties !== "object" ||
    Array.isArray(sources.properties) ||
    !Array.isArray(sources.required)
  ) {
    return fail("source_slot_model_frontier_schema_unavailable", {
      not_applicable: true,
    })
  }

  const required = [...sources.required]
  const unique = [...new Set(required)]
  if (
    required.length < 1 ||
    unique.length !== required.length ||
    unique.some(
      (key) =>
        typeof key !== "string" ||
        !SOURCE_KEY_RE.test(key) ||
        !Object.prototype.hasOwnProperty.call(sources.properties, key),
    )
  ) {
    return fail("source_slot_model_frontier_required_invalid")
  }

  let activeBytes = 0
  let activeModelGenerationBytes = 0

  for (const key of unique) {
    const row = sources.properties[key]
    const maxLength = row?.maxLength

    if (
      row?.type === "string" &&
      Number.isSafeInteger(maxLength) &&
      maxLength >= 1 &&
      SOURCE_SLOT_ALLOWED_MODEL_LENGTHS.includes(maxLength)
    ) {
      activeBytes += maxLength
      activeModelGenerationBytes += maxLength
      continue
    }

    const typedCapacity = typedRepairSchemaCapacity(row)
    const typedGenerationCapacity =
      typedRepairSchemaGenerationCapacity(row)

    if (
      Number.isSafeInteger(typedCapacity) &&
      typedCapacity >= 1 &&
      SOURCE_SLOT_ALLOWED_MODEL_LENGTHS.includes(typedCapacity) &&
      Number.isSafeInteger(typedGenerationCapacity) &&
      typedGenerationCapacity >= 1 &&
      typedGenerationCapacity <= typedCapacity
    ) {
      activeBytes += typedCapacity
      activeModelGenerationBytes += typedGenerationCapacity
      continue
    }

    return fail("source_slot_model_frontier_capacity_invalid", {
      source_key: key,
    })
  }

  if (activeBytes < 1 || activeBytes > SOURCE_SLOT_MODEL_CAPACITY_BYTES) {
    return fail("source_slot_model_frontier_total_invalid")
  }

  return Object.freeze({
    ok: true,
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    reason: "source_slot_model_frontier_derived",
    active_source_keys: Object.freeze([...unique].sort()),
    active_source_count: unique.length,
    active_source_capacity_bytes: activeBytes,
    active_model_generation_capacity_bytes:
      activeModelGenerationBytes,
    total_source_capacity_bytes: SOURCE_SLOT_MODEL_CAPACITY_BYTES,
    model_generation_fraction:
      activeModelGenerationBytes /
      SOURCE_SLOT_MODEL_CAPACITY_BYTES,
    mutation_authority: false,
  })
}

function schemaForRows(
  rows,
  structuralWitnesses = null,
  repairCapsules = null,
  {
    typedPython = false,
    typedRepair = false,
  } = {},
) {
  const properties = {}
  const required = []

  for (const row of rows) {
    if (typedPython && row.kind === "python_declaration") {
      const typed = compileTypedPythonRepairSourceSchema({
        row,
        frontierRows: typedRepair ? rows : [row],
        structuralWitness:
          structuralWitnesses?.[row.source_key] ?? null,
        repairCapsule:
          repairCapsules?.[row.source_key] ?? null,
      })
      if (typed.ok !== true) return null
      properties[row.source_key] = typed.schema
    } else {
      properties[row.source_key] = {
        type: "string",
        minLength: 1,
        maxLength: row.max_bytes,
        description: [
          descriptionFor(row),
          renderSourceSlotRepairCapsuleV2(
            repairCapsules?.[row.source_key],
          ) ?? renderStructuralCounterexampleForModel(
            structuralWitnesses?.[row.source_key],
          ),
        ].filter(Boolean).join(" "),
      }
    }
    required.push(row.source_key)
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      sources: {
        type: "object",
        additionalProperties: false,
        properties,
        required,
      },
    },
    required: ["sources"],
  }
}

export function bindSourceSlotToolSchema({
  tool,
  capability,
  contract,
  semanticAttestation,
  repairCache = null,
  typedInitialPython = false,
  executionContextSha256,
} = {}) {
  const spec = sourceSpec({ capability, contract })
  if (spec.ok !== true) return spec
  const attestationSha = semanticAttestationIdentity(
    semanticAttestation,
    spec.semantic_contract_sha256,
  )
  if (!attestationSha) return fail("source_slot_semantic_attestation_invalid")
  if (
    typeof executionContextSha256 !== "string" ||
    !SHA256_RE.test(executionContextSha256)
  ) {
    return fail("source_slot_execution_context_invalid")
  }

  const schemaKey =
    tool?.input && typeof tool.input === "object"
      ? "input"
      : tool?.parameters && typeof tool.parameters === "object"
        ? "parameters"
        : null
  if (!schemaKey) return fail("source_slot_tool_schema_unavailable")

  const activeCache = repairCacheForSpec({
    repairCache,
    spec,
    capability,
    semanticAttestationSha: attestationSha,
    executionContextSha256,
  })
  const failed = new Set(activeCache?.failed_source_keys ?? [])
  const rows = activeCache
    ? spec.rows.filter((row) => failed.has(row.source_key))
    : [...spec.rows]
  if (rows.length < 1) return fail("source_slot_repair_frontier_empty")

  const schema = schemaForRows(
    rows,
    activeCache?.structural_witnesses ?? null,
    activeCache?.repair_capsules ?? null,
    {
      typedPython:
        typedInitialPython === true ||
        activeCache != null,
      typedRepair: activeCache != null,
    },
  )
  if (schema == null) {
    return fail("source_slot_typed_repair_schema_unavailable")
  }

  const typedRepairFieldAuthorityBySource = {}
  const typedRepairModelCapacityBySource = {}
  const typedPythonActive =
    typedInitialPython === true ||
    activeCache != null

  if (typedPythonActive) {
    for (const row of rows) {
      if (row.kind !== "python_declaration") continue

      const authorityResult =
        deriveTypedPythonRepairFieldAuthority({
          repairCapsule:
            activeCache?.repair_capsules?.[
              row.source_key
            ] ?? null,
        })

      if (authorityResult.ok !== true) {
        return authorityResult
      }

      typedRepairFieldAuthorityBySource[
        row.source_key
      ] = authorityResult.field_authority

      const capacityResult =
        deriveTypedPythonRepairModelCapacity({
          row,
          frontierRows: activeCache != null ? rows : [row],
          fieldAuthority:
            authorityResult.field_authority,
        })
      if (capacityResult.ok !== true) {
        return capacityResult
      }

      typedRepairModelCapacityBySource[
        row.source_key
      ] = capacityResult.capacity_profile
    }
  }

  const schema_sha256 = sha(schema)
  const bindingCore = {
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    capability_sha256: spec.capability_sha256,
    authority_sha256: spec.authority_sha256,
    semantic_contract_sha256: spec.semantic_contract_sha256,
    semantic_attestation_sha256: attestationSha,
    execution_context_sha256: executionContextSha256,
    source_spec_sha256: spec.source_spec_sha256,
    model_schema_sha256: schema_sha256,
    repair_cache_sha256: activeCache?.cache_sha256 ?? null,
    required_source_keys: rows.map((row) => row.source_key),
    ...(
      typedInitialPython === true
        ? {
            typed_initial_protocol:
              activeCache == null
                ? SOURCE_SLOT_TYPED_INITIAL_PROTOCOL
                : null,
            typed_initial_source_keys:
              activeCache == null
                ? rows
                    .filter(
                      (row) =>
                        row.kind === "python_declaration",
                    )
                    .map((row) => row.source_key)
                : [],
          }
        : {}
    ),
    typed_repair_protocol:
      activeCache != null
        ? SOURCE_SLOT_TYPED_REPAIR_PROTOCOL
        : null,
    typed_repair_source_keys:
      activeCache != null
        ? rows
            .filter((row) => row.kind === "python_declaration")
            .map((row) => row.source_key)
        : [],
    typed_repair_field_authority_by_source:
      typedPythonActive
        ? typedRepairFieldAuthorityBySource
        : {},
    typed_repair_semantic_hole_protocol:
      activeCache != null
        ? TYPED_PYTHON_REPAIR_SEMANTIC_HOLE_PROTOCOL
        : null,
    typed_repair_model_capacity_by_source:
      typedPythonActive
        ? typedRepairModelCapacityBySource
        : {},
    all_source_rows: spec.rows.map((row) => ({ ...row })),
    mutation_authority: false,
  }
  const binding = Object.freeze({
    ...bindingCore,
    binding_sha256: sha(bindingCore),
  })
  const resourceKeys = spec.rows.map((row) => row.source_key).join(",")
  const typedRepairKeys =
    activeCache != null
      ? rows
          .filter((row) => row.kind === "python_declaration")
          .map((row) => row.source_key)
      : []
  const typedInitialKeys =
    activeCache == null &&
    typedInitialPython === true
      ? rows
          .filter((row) => row.kind === "python_declaration")
          .map((row) => row.source_key)
      : []
  const typedPythonKeys =
    typedRepairKeys.length > 0
      ? typedRepairKeys
      : typedInitialKeys
  const description = [
    typedRepairKeys.length > 0
      ? "Repair is representation-bounded: Python declaration repair slots use typed Python units enforced by the tool JSON Schema; non-Python failed slots remain bounded source text."
      : typedInitialKeys.length > 0
        ? "Initial Python declaration slots use typed Python units enforced by the tool JSON Schema; non-Python slots remain bounded source text."
        : "Submit only normal source text for deterministic semantic source slots.",
    typedRepairKeys.length > 0
      ? `Typed Python repair keys: ${typedRepairKeys.join(",")}. Raw Python module text is not accepted for those keys.`
      : typedInitialKeys.length > 0
        ? `Typed Python initial keys: ${typedInitialKeys.join(",")}. Raw Python module text is not accepted for those keys.`
        : "Each value is source text itself; never return a target filename/path as the value.",
    typedPythonKeys.length > 0
      ? "Do not serialize compiler-owned operation ids, files, paths, modes, anchors, or mutation control fields."
      : "Do not serialize AST, Python unit IR, operation ids, files, paths, modes, anchors, or mutation control fields.",
    `Cross-resource references may use resource://<key>; allowed keys: ${resourceKeys}.`,
    activeCache
      ? `Repair only these failed source slots: ${rows.map((row) => row.source_key).join(",")}. Other slots are preserved byte-for-byte by the host.`
      : "Return every required source key exactly once.",
  ].join(" ")

  return Object.freeze({
    ok: true,
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    reason: activeCache ? "source_slot_repair_schema_bound" : "source_slot_schema_bound",
    tool: {
      ...tool,
      description,
      [schemaKey]: schema,
    },
    binding,
    model_schema_bytes: bytes(stableJson(schema)),
    repair_active: activeCache != null,
    mutation_authority: false,
  })
}

function validateBinding({ binding, capability, contract, semanticAttestation, executionContextSha256 }) {
  const spec = sourceSpec({ capability, contract })
  if (spec.ok !== true) return spec
  const attestationSha = semanticAttestationIdentity(
    semanticAttestation,
    spec.semantic_contract_sha256,
  )
  if (!attestationSha) return fail("source_slot_semantic_attestation_invalid")
  if (
    binding?.protocol !== SOURCE_SLOT_COMPILER_PROTOCOL ||
    binding.capability_sha256 !== spec.capability_sha256 ||
    binding.authority_sha256 !== spec.authority_sha256 ||
    binding.semantic_contract_sha256 !== spec.semantic_contract_sha256 ||
    binding.semantic_attestation_sha256 !== attestationSha ||
    binding.execution_context_sha256 !== executionContextSha256 ||
    binding.source_spec_sha256 !== spec.source_spec_sha256 ||
    typeof binding.binding_sha256 !== "string" ||
    !SHA256_RE.test(binding.binding_sha256)
  ) {
    return fail("source_slot_binding_drift")
  }
  const core = { ...binding }
  delete core.binding_sha256
  if (sha(core) !== binding.binding_sha256) {
    return fail("source_slot_binding_hash_mismatch")
  }
  return Object.freeze({ ok: true, spec, attestationSha })
}

function rewriteResources(text, rows) {
  const byKey = new Map(rows.map((row) => [row.source_key, row.operation_id]))
  let bad = null
  const content = String(text).replace(
    RESOURCE_REF_RE,
    (_full, key) => {
      const operationId = byKey.get(key)
      if (!operationId) {
        bad = key
        return _full
      }
      return `resource://${operationId}`
    },
  )
  if (bad) {
    return fail("source_slot_resource_reference_unknown", {
      resource_key: bad,
    })
  }
  if (/resource:\/\/op_[0-9]+/u.test(String(text))) {
    return fail("source_slot_internal_operation_reference_forbidden")
  }
  return Object.freeze({ ok: true, content })
}

function compilerOwnedSourceIdentities({
  capability,
  binding,
} = {}) {
  const identities = new Map()

  const add = (kind, value) => {
    if (typeof value !== "string" || value.length < 1) return
    if (!identities.has(value)) identities.set(value, kind)
  }

  for (
    const row of
    Array.isArray(binding?.all_source_rows)
      ? binding.all_source_rows
      : []
  ) {
    add("source_key", row?.source_key)
    add("operation_id", row?.operation_id)
  }

  for (
    const slot of
    Array.isArray(capability?.existing_slots)
      ? capability.existing_slots
      : []
  ) {
    add("slot_id", slot?.slot)
    add("target_file", slot?.file)
  }

  for (
    const slot of
    Array.isArray(capability?.create_slots)
      ? capability.create_slots
      : []
  ) {
    add("slot_id", slot?.slot)
    add("source_file", slot?.source_file)
  }

  const hostBindings =
    capability?.host_bindings &&
    typeof capability.host_bindings === "object" &&
    !Array.isArray(capability.host_bindings)
      ? capability.host_bindings
      : {}

  for (const value of Object.values(hostBindings)) {
    if (typeof value === "string") add("host_identity", value)
  }

  return identities
}

export function classifyCompilerOwnedSourceValue({
  value,
  capability,
  binding,
} = {}) {
  if (typeof value !== "string") return null

  const normalized = value.trim()
  if (!normalized) return null

  const echoKind =
    compilerOwnedSourceIdentities({
      capability,
      binding,
    }).get(normalized)

  if (!echoKind) return null

  return Object.freeze({
    matched: true,
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    reason: "source_slot_compiler_owned_value_echo",
    echo_kind: echoKind,
    echo_sha256: createHash("sha256")
      .update(normalized, "utf8")
      .digest("hex"),
    mutation_authority: false,
  })
}

function rawSources(request) {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    !request.sources ||
    typeof request.sources !== "object" ||
    Array.isArray(request.sources) ||
    Object.keys(request).length !== 1
  ) {
    return fail("source_slot_request_shape_invalid")
  }
  return request.sources
}

export async function rehydrateSourceSlotRequest({
  binding,
  request,
  capability,
  contract,
  semanticAttestation,
  repairCache = null,
  executionContextSha256,
} = {}) {
  const checked = validateBinding({
    binding,
    capability,
    contract,
    semanticAttestation,
    executionContextSha256,
  })
  if (checked.ok !== true) return checked
  const spec = checked.spec
  const raw = rawSources(request)
  if (raw.ok === false) return raw

  const activeCache = repairCacheForSpec({
    repairCache,
    spec,
    capability,
    semanticAttestationSha: checked.attestationSha,
    executionContextSha256,
  })
  if ((binding.repair_cache_sha256 ?? null) !== (activeCache?.cache_sha256 ?? null)) {
    return fail("source_slot_repair_cache_binding_drift")
  }

  const required = new Set(binding.required_source_keys ?? [])
  const observed = Object.keys(raw)
  if (
    observed.length !== required.size ||
    observed.some((key) => !required.has(key))
  ) {
    return fail("source_slot_request_key_set_invalid", {
      required_source_keys: [...required].sort(),
      observed_source_keys: [...observed].sort(),
    })
  }

  const merged = { ...(activeCache?.accepted_sources ?? {}) }
  for (const key of observed) merged[key] = raw[key]
  const allKeys = new Set(spec.rows.map((row) => row.source_key))
  if (
    Object.keys(merged).length !== allKeys.size ||
    Object.keys(merged).some((key) => !allKeys.has(key))
  ) {
    return fail("source_slot_merged_key_set_invalid")
  }

  let total = 0
  const contents = []
  const pythonImportHints = []
  const failures = []

  function recordFailure(row, result) {
    failures.push(Object.freeze({
      source_key: row.source_key,
      operation_id: row.operation_id,
      operation_index: row.operation_index,
      slot: row.slot,
      reason: result?.reason ?? "source_slot_validation_failed",
      detail: result?.detail ?? null,
      frontend: result?.frontend ?? null,
    }))
  }

  for (const row of spec.rows) {
    const source = merged[row.source_key]
    const typedInitialActive =
      activeCache == null &&
      row.kind === "python_declaration" &&
      binding?.typed_initial_protocol ===
        SOURCE_SLOT_TYPED_INITIAL_PROTOCOL &&
      Array.isArray(binding?.typed_initial_source_keys) &&
      binding.typed_initial_source_keys.includes(row.source_key)
    const typedRepairActive =
      activeCache != null &&
      row.kind === "python_declaration" &&
      Array.isArray(binding?.typed_repair_source_keys) &&
      binding.typed_repair_source_keys.includes(row.source_key)
    const typedPythonActive =
      typedInitialActive ||
      typedRepairActive

    if (typedPythonActive) {
      const typed = validateTypedPythonRepairSource(
        source,
        {
          fieldAuthority:
            binding
              ?.typed_repair_field_authority_by_source
              ?.[row.source_key] ??
            null,
          capacityProfile:
            binding
              ?.typed_repair_model_capacity_by_source
              ?.[row.source_key] ??
            null,
        },
      )
      if (typed.ok !== true) {
        recordFailure(row, typed)
        continue
      }

      const ownershipViolation =
        classifyCompilerOwnedSourceValue({
          value: stableJson(source),
          capability,
          binding,
        })

      if (ownershipViolation) {
        return fail(ownershipViolation.reason, {
          source_key: row.source_key,
          operation_id: row.operation_id,
          operation_index: row.operation_index,
          echo_kind: ownershipViolation.echo_kind,
          echo_sha256: ownershipViolation.echo_sha256,
        })
      }

      const size = bytes(stableJson(source))
      total += size
      if (size > row.max_bytes || total > MAX_TOTAL_SOURCE_BYTES) {
        recordFailure(row, fail("source_slot_source_budget_exceeded", {
          source_bytes: size,
          max_source_bytes: row.max_bytes,
          total_source_bytes: total,
          max_total_source_bytes: MAX_TOTAL_SOURCE_BYTES,
        }))
        continue
      }

      const rewritten = rewriteTypedRepairValue(
        typed.units,
        spec.rows,
      )
      if (rewritten.ok !== true) {
        recordFailure(row, rewritten)
        continue
      }

      const rewrittenAdmission =
        validateTypedPythonRepairSource(
          {
            units: rewritten.value,
          },
          {
            fieldAuthority:
              binding
                ?.typed_repair_field_authority_by_source
                ?.[row.source_key] ??
              null,
            capacityProfile:
              binding
                ?.typed_repair_model_capacity_by_source
                ?.[row.source_key] ??
              null,
          },
        )
      if (rewrittenAdmission.ok !== true) {
        recordFailure(row, rewrittenAdmission)
        continue
      }

      contents.push({
        id: row.operation_id,
        content: {
          kind: "python_units",
          units: cloneJson(rewrittenAdmission.units),
        },
      })
      continue
    }

    if (typeof source !== "string" || source.length < 1) {
      recordFailure(row, fail("source_slot_source_invalid"))
      continue
    }

    const ownershipViolation =
      classifyCompilerOwnedSourceValue({
        value: source,
        capability,
        binding,
      })

    if (ownershipViolation) {
      return fail(ownershipViolation.reason, {
        source_key: row.source_key,
        operation_id: row.operation_id,
        operation_index: row.operation_index,
        echo_kind: ownershipViolation.echo_kind,
        echo_sha256: ownershipViolation.echo_sha256,
      })
    }

    const size = bytes(source)
    total += size
    if (size > row.max_bytes || total > MAX_TOTAL_SOURCE_BYTES) {
      recordFailure(row, fail("source_slot_source_budget_exceeded", {
        source_bytes: size,
        max_source_bytes: row.max_bytes,
        total_source_bytes: total,
        max_total_source_bytes: MAX_TOTAL_SOURCE_BYTES,
      }))
      continue
    }

    const rewritten = rewriteResources(source, spec.rows)
    if (rewritten.ok !== true) {
      recordFailure(row, rewritten)
      continue
    }

    if (row.kind === "python_declaration") {
      let lowered = await lowerPythonSourceFragment(rewritten.content)
      if (
        lowered.ok !== true &&
        lowered.reason === "source_fragment_import_after_declaration" &&
        row.allow_module_imports === true
      ) {
        const canonicalized =
          await canonicalizePythonModuleSourceFragment(rewritten.content)
        if (canonicalized.ok === true) {
          lowered = await lowerPythonSourceFragment(canonicalized.source)
          if (lowered.ok !== true) {
            return fail("source_fragment_canonicalization_reparse_failed", {
              source_key: row.source_key,
              operation_id: row.operation_id,
              operation_index: row.operation_index,
              canonicalizer_protocol:
                canonicalized.canonicalizer_protocol ?? null,
              frontend: lowered,
            })
          }
        }
      }
      if (lowered.ok !== true) {
        recordFailure(
          row,
          fail(lowered.reason ?? "source_slot_python_lowering_failed", {
            frontend: lowered,
          }),
        )
        continue
      }
      if (
        Array.isArray(lowered.module_imports) &&
        lowered.module_imports.length > 0 &&
        row.allow_module_imports !== true
      ) {
        recordFailure(
          row,
          fail("source_slot_python_import_capability_forbidden"),
        )
        continue
      }
      if (Array.isArray(lowered.module_imports) && lowered.module_imports.length > 0) {
        pythonImportHints.push(Object.freeze({
          operation_id: row.operation_id,
          slot: row.slot,
          hints: Object.freeze(
            lowered.module_imports.map((intent) => Object.freeze(cloneJson(intent))),
          ),
        }))
      }
      contents.push({
        id: row.operation_id,
        content: {
          kind: "python_units",
          units: cloneJson(lowered.units),
        },
      })
      continue
    }

    contents.push({
      id: row.operation_id,
      content: {
        kind: "text",
        mode: row.mode,
        text: rewritten.content,
      },
    })
  }

  if (failures.length > 0) {
    const sourceKeys = [...new Set(failures.map((row) => row.source_key))].sort()
    const first = failures[0]
    return fail(first.reason, {
      source_key: sourceKeys[0] ?? null,
      source_keys: Object.freeze(sourceKeys),
      source_failures: Object.freeze(failures),
    })
  }

  return Object.freeze({
    ok: true,
    protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
    reason: activeCache ? "source_slot_repair_rehydrated" : "source_slot_rehydrated",
    request: Object.freeze({ contents: Object.freeze(contents) }),
    raw_sources: Object.freeze({ ...merged }),
    python_import_hints: Object.freeze(pythonImportHints),
    python_import_hints_sha256: sha(
      pythonImportHints.map((row) => ({
        operation_id: row.operation_id,
        slot: row.slot,
        hints: row.hints.map((intent) => ({ ...intent })),
      })),
    ),
    source_spec_sha256: spec.source_spec_sha256,
    source_bytes: total,
    preserved_source_keys: Object.freeze(Object.keys(activeCache?.accepted_sources ?? {}).sort()),
    mutation_authority: false,
  })
}



function directFailedSourceKey(binding, failure) {
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const operationId = failure?.operation_id ?? failure?.id ?? null

  if (typeof failure?.source_key === "string") {
    const row = rows.find(
      (item) => item.source_key === failure.source_key,
    )
    return row ? row.source_key : null
  }
  if (typeof operationId === "string") {
    const row = rows.find(
      (item) => item.operation_id === operationId,
    )
    return row?.source_key ?? null
  }
  if (Number.isSafeInteger(failure?.operation_index)) {
    return rows.find(
      (item) => item.operation_index === failure.operation_index,
    )?.source_key ?? null
  }
  return null
}

function canonicalSourceKeySet(binding, values) {
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []

  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > rows.length
  ) {
    return null
  }

  const observed = new Set()
  for (const value of values) {
    if (typeof value !== "string" || observed.has(value)) {
      return null
    }
    if (!rows.some((row) => row.source_key === value)) {
      return null
    }
    observed.add(value)
  }

  const canonical = rows
    .map((row) => row.source_key)
    .filter((key) => observed.has(key))

  return canonical.length === values.length
    ? canonical
    : null
}

function canonicalFailureItemSet(binding, items) {
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []

  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > rows.length
  ) {
    return null
  }

  const observed = []
  const seen = new Set()

  for (const item of items) {
    const key = directFailedSourceKey(binding, item)
    if (!key || seen.has(key)) return null
    seen.add(key)
    observed.push(key)
  }

  return canonicalSourceKeySet(binding, observed)
}

function sameSourceKeySet(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((key, index) => key === b[index])
  )
}

function failedSourceKeys(binding, failure) {
  const isComposite =
    failure?.reason === "source_slot_composite_invalid"

  if (!isComposite) {
    const direct = directFailedSourceKey(binding, failure)
    return direct ? [direct] : null
  }

  const witnesses = []

  for (const field of ["source_keys", "failed_source_keys"]) {
    const values = failure?.[field]
    if (values == null) continue
    const canonical = canonicalSourceKeySet(binding, values)
    if (!canonical) return null
    witnesses.push(canonical)
  }

  for (const field of ["source_failures", "failures"]) {
    const values = failure?.[field]
    if (values == null) continue
    const canonical = canonicalFailureItemSet(binding, values)
    if (!canonical) return null
    witnesses.push(canonical)
  }

  if (witnesses.length < 1) return null

  const canonical = witnesses[0]
  if (
    witnesses.some(
      (candidate) => !sameSourceKeySet(canonical, candidate),
    )
  ) {
    return null
  }

  const direct = directFailedSourceKey(binding, failure)
  if (direct && !canonical.includes(direct)) {
    return null
  }

  return canonical
}

function buildSourceSlotRepairCacheBase({
  binding,
  request,
  failure,
  capability,
  executionContextSha256,
  priorRepairCache = null,
} = {}) {
  const raw = rawSources(request)
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const sourceMap = raw.ok === false ? null : raw
  const allKeys = rows.map((row) => row.source_key)
  const allKeySet = new Set(allKeys)
  const requiredKeys = Array.isArray(binding?.required_source_keys)
    ? [...binding.required_source_keys]
    : []
  const requiredSet = new Set(requiredKeys)
  const failedKeys = failedSourceKeys(binding, failure)
  const failedSet = new Set(failedKeys ?? [])
  const observedKeys = sourceMap == null
    ? []
    : Object.keys(sourceMap).sort()
  const expectedObservedKeys = [...requiredKeys].sort()

  const priorAuthorityOk =
    priorRepairCache == null ||
    (
      sourceSlotRepairAuthorityMatches({
        hint: priorRepairCache,
        capability,
        executionContextSha256,
        binding,
      }) &&
      typeof binding?.repair_cache_sha256 === "string" &&
      binding.repair_cache_sha256 === priorRepairCache.cache_sha256
    )

  const identityOk =
    capability?.ready === true &&
    capability?.mutation_authority === true &&
    binding?.capability_sha256 === capability.capability_sha256 &&
    binding?.authority_sha256 === capability.authority_sha256 &&
    binding?.execution_context_sha256 === executionContextSha256

  const requestFrontierOk =
    sourceMap != null &&
    requiredKeys.length > 0 &&
    requiredSet.size === requiredKeys.length &&
    observedKeys.length === expectedObservedKeys.length &&
    observedKeys.every(
      (key, index) =>
        key === expectedObservedKeys[index] && allKeySet.has(key),
    )

  const failureFrontierOk =
    Array.isArray(failedKeys) &&
    failedKeys.length > 0 &&
    failedSet.size === failedKeys.length &&
    failedKeys.every(
      (key) => allKeySet.has(key) && requiredSet.has(key),
    )

  const repairableBase =
    identityOk &&
    requestFrontierOk &&
    failureFrontierOk &&
    priorAuthorityOk

  const accepted = {}
  if (repairableBase && priorRepairCache) {
    for (const [key, value] of Object.entries(
      priorRepairCache.accepted_sources ?? {},
    )) {
      if (
        !failedSet.has(key) &&
        allKeySet.has(key) &&
        sourceSlotValueValid(value)
      ) {
        accepted[key] =
          sourceSlotValueClone(value)
      }
    }
  }
  if (repairableBase) {
    for (const [key, value] of Object.entries(sourceMap)) {
      if (
        !failedSet.has(key) &&
        allKeySet.has(key) &&
        sourceSlotValueValid(value)
      ) {
        accepted[key] =
          sourceSlotValueClone(value)
      }
    }
  }
  for (const key of failedSet) delete accepted[key]

  const acceptedKeys = Object.keys(accepted).sort()
  const coverageKeys = [
    ...new Set([...acceptedKeys, ...(failedKeys ?? [])]),
  ].sort()
  const canonicalKeys = [...allKeys].sort()
  const coverageComplete =
    repairableBase &&
    coverageKeys.length === canonicalKeys.length &&
    coverageKeys.every(
      (key, index) => key === canonicalKeys[index],
    )

  const finalRepairable = repairableBase && coverageComplete
  const finalFailedKeys = finalRepairable ? [...failedKeys] : []
  const acceptedSources = finalRepairable ? accepted : {}
  const acceptedSourceHashes = Object.fromEntries(
    Object.entries(acceptedSources)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        sourceSlotValueHash(value),
      ]),
  )
  const failedSlots = finalRepairable
    ? [
        ...new Set(
          rows
            .filter((row) => failedSet.has(row.source_key))
            .map((row) => row.slot)
            .filter(
              (slot) => typeof slot === "string" && slot.length > 0,
            ),
        ),
      ].sort()
    : []

  const payload = {
    protocol: SOURCE_SLOT_REPAIR_PROTOCOL,
    source_spec_sha256: binding?.source_spec_sha256 ?? null,
    capability_sha256: binding?.capability_sha256 ?? null,
    authority_sha256: binding?.authority_sha256 ?? null,
    semantic_contract_sha256:
      binding?.semantic_contract_sha256 ?? null,
    semantic_attestation_sha256:
      binding?.semantic_attestation_sha256 ?? null,
    execution_context_sha256:
      binding?.execution_context_sha256 ?? null,
    failed_source_keys: finalFailedKeys,
    failed_slots: failedSlots,
    accepted_sources: acceptedSources,
    accepted_source_hashes: acceptedSourceHashes,
    failure_reason:
      typeof failure?.reason === "string" && failure.reason.length > 0
        ? failure.reason
        : "source_slot_failure_unknown",
    failed_request_sha256:
      request && typeof request === "object" ? sha(request) : null,
    mutation_authority: false,
  }
  return Object.freeze({
    ...payload,
    repairable: finalRepairable,
    cache_sha256: sha(payload),
  })
}

export function buildSourceSlotRepairCache(args = {}) {
  const base = buildSourceSlotRepairCacheBase(args)
  const structuralWitnesses = compileRepairStructuralWitnesses({
    binding: args.binding,
    request: args.request,
    failure: args.failure,
  })
  const requiredWitnessKeys = structuralWitnessRequiredKeys({
    binding: args.binding,
    failure: args.failure,
  })
  const repairCapsules = compileRepairCapsulesV2({
    witnesses: structuralWitnesses,
    request: args.request,
  })
  const witnessRequired = structuralFailureRequiresWitness(args.failure)
  const failedKeys = new Set(
    Array.isArray(base?.failed_source_keys)
      ? base.failed_source_keys
      : [],
  )
  const witnessCovered =
    !witnessRequired ||
    (
      requiredWitnessKeys.length > 0 &&
      requiredWitnessKeys.every(
        (key) =>
          failedKeys.has(key) &&
          structuralWitnesses[key] != null,
      )
    )
  const repairCapsuleCovered =
    !witnessRequired ||
    requiredWitnessKeys.every(
      (key) => repairCapsules[key] != null,
    )
  const payloadCarrier = {
    ...base,
    structural_witness_required_keys: requiredWitnessKeys,
    structural_witnesses: structuralWitnesses,
    repair_capsules: repairCapsules,
  }
  const payload = cachePayload(payloadCarrier)
  return Object.freeze({
    ...base,
    structural_witness_required_keys: requiredWitnessKeys,
    structural_witnesses: structuralWitnesses,
    repair_capsules: repairCapsules,
    repairable:
      base?.repairable === true &&
      witnessCovered &&
      repairCapsuleCovered,
    cache_sha256: sha(payload),
  })
}
