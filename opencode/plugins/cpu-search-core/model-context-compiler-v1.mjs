import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import {
  ADDITIVE_COVERAGE_FAILURE_PROTOCOL,
  projectAdditiveExecutionContract,
  repairTargetSlots,
} from "./execution-contract-v1.mjs"
import {
  EXECUTION_CONTEXT_PLANNER_PROTOCOL,
  packExecutionContext,
  renderExecutionContractWithCoverage,
  runStructuralContextPlanner,
} from "./execution-context-planner-v1.mjs"

export const MODEL_CONTEXT_COMPILER_PROTOCOL =
  "evidence-preserving-model-context-compiler-v1"
export const MODEL_CONTEXT_COMPILER_AUTHORITY = "model_context_only"
export const MODEL_CONTEXT_COMPILER_DEFAULT_MAX_BYTES = 2200
export const MODEL_CONTEXT_COMPILER_MIN_BYTES = 512
export const MODEL_CONTEXT_COMPILER_MAX_BYTES = 4800
export const REPAIR_CONTEXT_DEFAULT_MAX_BYTES = 1800
export const REPAIR_CONTEXT_MIN_BYTES = 768
export const REPAIR_CONTEXT_MAX_BYTES = 3200

const SHA256_RE = /^[0-9a-f]{64}$/u

function array(value) {
  return Array.isArray(value) ? value : []
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
}

function stableSha(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex")
}

function normalizeFile(value) {
  if (typeof value !== "string") return null
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/^file:/u, "")
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some(
      (part) => !part || part === "." || part === "..",
    )
  ) {
    return null
  }
  return normalized
}

function boundedInteger(value, fallback) {
  const parsed =
    typeof value === "string" && /^[0-9]+$/u.test(value)
      ? Number(value)
      : Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(
    MODEL_CONTEXT_COMPILER_MAX_BYTES,
    Math.max(MODEL_CONTEXT_COMPILER_MIN_BYTES, parsed),
  )
}

export function resolveModelContextCompilerMode(value) {
  if (value === "off" || value === "shadow" || value === "active") {
    return value
  }
  return "shadow"
}

export function resolveModelContextBudgetBytes(value) {
  return boundedInteger(
    value,
    MODEL_CONTEXT_COMPILER_DEFAULT_MAX_BYTES,
  )
}

export function resolveRepairContextBudgetBytes(value) {
  const parsed =
    typeof value === "string" && /^[0-9]+$/u.test(value)
      ? Number(value)
      : Number(value)
  if (!Number.isSafeInteger(parsed)) return REPAIR_CONTEXT_DEFAULT_MAX_BYTES
  return Math.min(
    REPAIR_CONTEXT_MAX_BYTES,
    Math.max(REPAIR_CONTEXT_MIN_BYTES, parsed),
  )
}

function capabilityCriticalFiles(capability) {
  const files = new Set()
  for (const slot of array(capability?.existing_slots)) {
    const file = normalizeFile(slot?.file)
    if (file) files.add(file)
  }
  for (const slot of array(capability?.create_slots)) {
    const source = normalizeFile(slot?.source_file)
    if (source) files.add(source)
  }
  return [...files].sort()
}

function contextRow(raw) {
  const file = normalizeFile(raw?.file)
  const sha256 =
    typeof raw?.sha256 === "string"
      ? raw.sha256.toLowerCase()
      : null
  const evidenceLines = [
    ...new Set(
      array(raw?.evidence_lines).filter(
        (line) => Number.isSafeInteger(line) && line > 0,
      ),
    ),
  ].sort((a, b) => a - b)
  const roles = [
    ...new Set(
      array(raw?.roles).filter(
        (role) => typeof role === "string" && role.length > 0,
      ),
    ),
  ].sort()
  if (
    !file ||
    !sha256 ||
    !SHA256_RE.test(sha256) ||
    evidenceLines.length < 1
  ) {
    return null
  }
  return Object.freeze({
    file,
    sha256,
    evidence_lines: Object.freeze(evidenceLines),
    roles: Object.freeze(roles),
  })
}

function supportTier(row, criticalFiles) {
  if (criticalFiles.has(row.file)) return 0
  const roles = new Set(row.roles)
  if (
    roles.has("task_anchor_owner") ||
    roles.has("route_host") ||
    roles.has("ui_host") ||
    roles.has("navigation_host")
  ) {
    return 1
  }
  return 2
}

async function attestedSource(root, row) {
  const canonicalRoot = path.resolve(root)
  const absolute = path.resolve(canonicalRoot, row.file)
  if (
    absolute !== canonicalRoot &&
    !absolute.startsWith(`${canonicalRoot}${path.sep}`)
  ) {
    return { ok: false, reason: "context_file_path_escape", source: null }
  }

  let info
  let source
  try {
    info = await stat(absolute)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) {
      return { ok: false, reason: "context_file_unavailable", source: null }
    }
    source = await readFile(absolute)
  } catch {
    return { ok: false, reason: "context_file_unavailable", source: null }
  }

  const actual = createHash("sha256").update(source).digest("hex")
  if (actual !== row.sha256) {
    return { ok: false, reason: "context_file_stale", source: null }
  }

  let text
  try {
    text = source.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(source)) {
      return { ok: false, reason: "context_file_not_utf8", source: null }
    }
  } catch {
    return { ok: false, reason: "context_file_not_utf8", source: null }
  }

  return { ok: true, reason: "attested", source: text }
}

function failure(reason, baselineContent, extra = {}) {
  return Object.freeze({
    protocol: MODEL_CONTEXT_COMPILER_PROTOCOL,
    authority: MODEL_CONTEXT_COMPILER_AUTHORITY,
    status: "abstained",
    ok: false,
    reason,
    content: "",
    source_bytes: utf8Bytes(baselineContent),
    compiled_bytes: 0,
    saved_bytes: 0,
    reduction_ratio: 0,
    critical_file_coverage_complete: false,
    execution_contract_coverage_complete: false,
    semantic_coverage_complete: false,
    semantic_coverage_sha256: null,
    semantic_coverage_scope_count: 0,
    execution_contract_sha256: null,
    execution_contract_visible_sha256: null,
    capability_sha256: null,
    authority_sha256: null,
    capsule_sha256: null,
    selected_evidence_blocks: Object.freeze([]),
    selected_evidence_levels: Object.freeze([]),
    execution_contract_bytes: null,
    critical_evidence_bytes: null,
    minimum_required_bytes: null,
    over_budget_bytes: null,
    structural_planner_protocol: EXECUTION_CONTEXT_PLANNER_PROTOCOL,
    structural_planner_status: "not_attempted",
    structural_planner_reason: null,
    structural_planner_backend: null,
    structural_planner_elapsed_ms: null,
    structural_planner_parsed_files: 0,
    structural_planner_fallback_files: 0,
    structural_plan_sha256: null,
    structural_plan: null,
    routing_authority: false,
    mutation_authority: false,
    verification_authority: false,
    token_authority: false,
    token_count: null,
    ...extra,
  })
}

function snapshotBlock(block) {
  return Object.freeze({
    file: block.file,
    sha256: block.sha256,
    evidence_lines: Object.freeze([...array(block.evidence_lines)]),
    roles: Object.freeze([...array(block.roles)]),
    tier: block.tier,
    level: block.level ?? "anchor",
    structural: block.structural === true,
    block: block.block,
  })
}

function snapshotStructuralPlan(response) {
  if (
    response?.protocol !== "context-planner-v1" ||
    response?.authority !== "representation_only" ||
    !Array.isArray(response?.files)
  ) {
    return null
  }
  const files = response.files
    .map((file) => Object.freeze({
      file: file.file,
      critical: file.critical === true,
      language: file.language ?? null,
      parse_status: file.parse_status ?? null,
      candidates: Object.freeze(array(file.candidates).map((candidate) => Object.freeze({
        level: candidate.level,
        structural: candidate.structural === true,
        raw_bytes: candidate.raw_bytes ?? null,
        covered_lines: Object.freeze([...array(candidate.covered_lines)]),
        ranges: Object.freeze(array(candidate.ranges).map((range) => Object.freeze({
          start_byte: range.start_byte,
          end_byte: range.end_byte,
          start_line: range.start_line,
          end_line: range.end_line,
        }))),
      }))),
    }))
    .sort((a, b) => a.file.localeCompare(b.file))
  return Object.freeze({
    protocol: response.protocol,
    backend: response.backend ?? null,
    authority: response.authority,
    files_total: files.length,
    parsed_files: response.parsed_files ?? 0,
    fallback_files: response.fallback_files ?? 0,
    files: Object.freeze(files),
  })
}

function structuralPlanSha256(plan) {
  return plan ? stableSha(JSON.stringify(plan)) : null
}

async function prepareRows({ root, capability, criticalSet, baselineContent, contractMeta }) {
  const byFile = new Map()
  for (const raw of array(capability?.context_files)) {
    const row = contextRow(raw)
    if (!row) {
      return { ok: false, result: failure("context_attestation_invalid", baselineContent, contractMeta) }
    }
    const prior = byFile.get(row.file)
    if (prior && prior.sha256 !== row.sha256) {
      return { ok: false, result: failure("context_attestation_hash_conflict", baselineContent, contractMeta) }
    }
    byFile.set(row.file, row)
  }

  const critical = [...criticalSet]
  const missingCritical = critical.filter((file) => !byFile.has(file))
  if (missingCritical.length > 0) {
    return {
      ok: false,
      result: failure("critical_context_attestation_missing", baselineContent, {
        ...contractMeta,
        critical_files: critical,
        missing_critical_files: missingCritical,
      }),
    }
  }

  const rows = [...byFile.values()]
    .map((row) => Object.freeze({
      ...row,
      tier: supportTier(row, criticalSet),
      critical: criticalSet.has(row.file),
      attested: true,
    }))
    .sort((a, b) => a.tier - b.tier || a.file.localeCompare(b.file))

  const sources = new Map()
  for (const row of rows) {
    const checked = await attestedSource(root, row)
    if (!checked.ok) {
      return {
        ok: false,
        result: failure(checked.reason, baselineContent, {
          ...contractMeta,
          failed_file: row.file,
        }),
      }
    }
    sources.set(row.file, checked.source)
  }

  return { ok: true, rows, sources }
}

export async function compileAdditiveExecutionCapsule({
  root,
  capability,
  baselineContent = "",
  maxBytes = MODEL_CONTEXT_COMPILER_DEFAULT_MAX_BYTES,
  plannerBinary = undefined,
} = {}) {
  const budget = boundedInteger(maxBytes, MODEL_CONTEXT_COMPILER_DEFAULT_MAX_BYTES)
  const sourceBytes = utf8Bytes(baselineContent)

  if (
    typeof root !== "string" ||
    root.length < 1 ||
    capability?.ready !== true ||
    capability?.mutation_authority !== true
  ) {
    return failure("authorized_additive_capability_unavailable", baselineContent, { max_bytes: budget })
  }

  const executionContract = projectAdditiveExecutionContract(capability)
  if (
    executionContract.ok !== true ||
    executionContract.execution_contract_coverage_complete !== true
  ) {
    return failure(executionContract.reason ?? "execution_contract_projection_failed", baselineContent, { max_bytes: budget })
  }

  const renderedContract = renderExecutionContractWithCoverage(executionContract)
  if (!renderedContract.ok || renderedContract.coverage?.complete !== true) {
    return failure(renderedContract.reason ?? "execution_contract_render_failed", baselineContent, {
      max_bytes: budget,
      execution_contract_sha256: executionContract.contract_sha256,
    })
  }

  const contractMeta = {
    max_bytes: budget,
    execution_contract_coverage_complete: true,
    execution_contract_sha256: executionContract.contract_sha256,
    execution_contract_visible_sha256: executionContract.visible_sha256,
    semantic_contract_sha256: executionContract.visible_sha256,
    authority_instance_sha256: executionContract.authority_sha256,
    execution_instance_sha256: executionContract.contract_sha256,
    capability_sha256: executionContract.capability_sha256,
    authority_sha256: executionContract.authority_sha256,
    execution_contract_bytes: renderedContract.bytes,
  }

  const critical = capabilityCriticalFiles(capability)
  if (critical.length < 1) {
    return failure("critical_context_files_unavailable", baselineContent, contractMeta)
  }
  const criticalSet = new Set(critical)

  const prepared = await prepareRows({
    root,
    capability,
    criticalSet,
    baselineContent,
    contractMeta,
  })
  if (!prepared.ok) return prepared.result

  const structural = await runStructuralContextPlanner({
    root,
    rows: prepared.rows,
    maxBytes: budget,
    ...(plannerBinary ? { binary: plannerBinary } : {}),
  })
  if (!structural.ok) {
    return failure(structural.reason ?? "structural_context_planner_failed", baselineContent, {
      ...contractMeta,
      critical_files: critical,
      structural_planner_status: "abstained",
      structural_planner_reason: structural.reason ?? null,
      structural_planner_elapsed_ms: structural.elapsed_ms ?? null,
    })
  }

  const structuralPlan = snapshotStructuralPlan(structural.response)
  const structuralPlanSha = structuralPlanSha256(structuralPlan)
  if (!structuralPlan || !structuralPlanSha) {
    return failure("structural_context_plan_snapshot_invalid", baselineContent, {
      ...contractMeta,
      critical_files: critical,
    })
  }

  const packed = packExecutionContext({
    contract: executionContract,
    rows: prepared.rows,
    criticalFiles: criticalSet,
    sources: prepared.sources,
    structuralResponse: structuralPlan,
    maxBytes: budget,
  })
  if (!packed.ok) {
    return failure(packed.reason, baselineContent, {
      ...contractMeta,
      critical_files: critical,
      execution_contract_bytes: packed.execution_contract_bytes ?? renderedContract.bytes,
      minimum_required_bytes: packed.minimum_required_bytes ?? null,
      over_budget_bytes: packed.over_budget_bytes ?? null,
      semantic_coverage_complete: packed.coverage_complete === true,
      structural_planner_status: "planned",
      structural_planner_reason: structural.reason,
      structural_planner_backend: structural.response?.backend ?? null,
      structural_planner_elapsed_ms: structural.elapsed_ms ?? null,
      structural_planner_parsed_files: structural.response?.parsed_files ?? 0,
      structural_planner_fallback_files: structural.response?.fallback_files ?? 0,
      structural_plan_sha256: structuralPlanSha,
      failed_file: packed.failed_file ?? null,
    })
  }

  const compiledBytes = packed.compiled_bytes
  if (sourceBytes > 0 && compiledBytes >= sourceBytes) {
    return failure("compiled_context_not_smaller", baselineContent, {
      ...contractMeta,
      compiled_bytes: compiledBytes,
      minimum_required_bytes: packed.minimum_required_bytes,
      semantic_coverage_complete: packed.semantic_coverage_complete === true,
    })
  }

  const criticalEvidenceBytes = packed.selected_evidence_blocks
    .filter((block) => criticalSet.has(block.file))
    .reduce((total, block) => total + utf8Bytes(`\n\n${block.block}`), 0)
  const contentSha = stableSha(packed.content)
  const savedBytes = Math.max(0, sourceBytes - compiledBytes)

  return Object.freeze({
    protocol: MODEL_CONTEXT_COMPILER_PROTOCOL,
    authority: MODEL_CONTEXT_COMPILER_AUTHORITY,
    status: "compiled",
    ok: true,
    reason: packed.reason,
    content: packed.content,
    source_bytes: sourceBytes,
    compiled_bytes: compiledBytes,
    saved_bytes: savedBytes,
    reduction_ratio: sourceBytes > 0 ? savedBytes / sourceBytes : 0,
    max_bytes: budget,
    source_sha256: stableSha(baselineContent),
    content_sha256: contentSha,
    capsule_sha256: contentSha,
    critical_files: Object.freeze(critical),
    selected_files: packed.selected_files,
    dropped_files: packed.dropped_files,
    selected_evidence_blocks: packed.selected_evidence_blocks,
    selected_evidence_levels: packed.selected_levels,
    execution_contract_bytes: packed.execution_contract_bytes,
    critical_evidence_bytes: criticalEvidenceBytes,
    minimum_required_bytes: packed.minimum_required_bytes,
    over_budget_bytes: 0,
    critical_file_coverage_complete: true,
    execution_contract_coverage_complete: true,
    semantic_coverage_complete: packed.semantic_coverage_complete === true,
    semantic_coverage_sha256: packed.coverage_sha256,
    semantic_coverage_scope_count: packed.coverage_scope_count,
    execution_contract_sha256: executionContract.contract_sha256,
    execution_contract_visible_sha256: executionContract.visible_sha256,
    semantic_contract_sha256: executionContract.visible_sha256,
    authority_instance_sha256: executionContract.authority_sha256,
    execution_instance_sha256: executionContract.contract_sha256,
    execution_contract_machine_sha256: executionContract.machine_enforced_sha256,
    execution_contract_renderer_sha256: packed.renderer_sha256,
    capability_sha256: executionContract.capability_sha256,
    authority_sha256: executionContract.authority_sha256,
    structural_planner_protocol: structural.response?.protocol ?? null,
    structural_planner_status: "planned",
    structural_planner_reason: structural.reason,
    structural_planner_backend: structural.response?.backend ?? null,
    structural_planner_elapsed_ms: structural.elapsed_ms ?? null,
    structural_planner_parsed_files: structural.response?.parsed_files ?? 0,
    structural_planner_fallback_files: structural.response?.fallback_files ?? 0,
    structural_plan_sha256: structuralPlanSha,
    structural_plan: structuralPlan,
    routing_authority: false,
    mutation_authority: false,
    verification_authority: false,
    token_authority: false,
    token_count: null,
  })
}

export function snapshotCompiledExecutionCapsule(compilation) {
  if (
    compilation?.ok !== true ||
    compilation?.status !== "compiled" ||
    compilation?.critical_file_coverage_complete !== true ||
    compilation?.execution_contract_coverage_complete !== true ||
    compilation?.semantic_coverage_complete !== true ||
    typeof compilation?.content !== "string" ||
    typeof compilation?.capsule_sha256 !== "string" ||
    typeof compilation?.structural_plan_sha256 !== "string" ||
    structuralPlanSha256(compilation?.structural_plan) !==
      compilation.structural_plan_sha256 ||
    stableSha(compilation.content) !== compilation.capsule_sha256
  ) {
    return null
  }
  return Object.freeze({
    protocol: MODEL_CONTEXT_COMPILER_PROTOCOL,
    capsule_sha256: compilation.capsule_sha256,
    content: compilation.content,
    compiled_bytes: compilation.compiled_bytes,
    execution_contract_sha256: compilation.execution_contract_sha256,
    execution_contract_visible_sha256: compilation.execution_contract_visible_sha256,
    semantic_contract_sha256:
      compilation.semantic_contract_sha256 ??
      compilation.execution_contract_visible_sha256,
    authority_instance_sha256:
      compilation.authority_instance_sha256 ??
      compilation.authority_sha256,
    execution_instance_sha256:
      compilation.execution_instance_sha256 ??
      compilation.execution_contract_sha256,
    execution_contract_renderer_sha256: compilation.execution_contract_renderer_sha256,
    capability_sha256: compilation.capability_sha256,
    authority_sha256: compilation.authority_sha256,
    semantic_coverage_sha256: compilation.semantic_coverage_sha256,
    semantic_coverage_scope_count: compilation.semantic_coverage_scope_count,
    critical_files: Object.freeze([...array(compilation.critical_files)]),
    selected_files: Object.freeze([...array(compilation.selected_files)]),
    selected_evidence_blocks: Object.freeze(array(compilation.selected_evidence_blocks).map(snapshotBlock)),
    selected_evidence_levels: Object.freeze(array(compilation.selected_evidence_levels).map((row) => Object.freeze({ ...row }))),
    structural_plan_sha256: compilation.structural_plan_sha256,
    structural_plan: compilation.structural_plan,
    execution_contract_bytes: compilation.execution_contract_bytes ?? null,
    critical_evidence_bytes: compilation.critical_evidence_bytes ?? null,
    minimum_required_bytes: compilation.minimum_required_bytes ?? null,
    execution_contract_coverage_complete: true,
    critical_file_coverage_complete: true,
    semantic_coverage_complete: true,
    routing_authority: false,
    mutation_authority: false,
    verification_authority: false,
  })
}

export async function verifyCompiledExecutionCapsule({ root, capsule, capability } = {}) {
  if (
    typeof root !== "string" ||
    root.length < 1 ||
    capsule?.protocol !== MODEL_CONTEXT_COMPILER_PROTOCOL ||
    capsule?.execution_contract_coverage_complete !== true ||
    capsule?.critical_file_coverage_complete !== true ||
    capsule?.semantic_coverage_complete !== true ||
    typeof capsule?.semantic_coverage_sha256 !== "string" ||
    typeof capsule?.structural_plan_sha256 !== "string" ||
    structuralPlanSha256(capsule?.structural_plan) !==
      capsule.structural_plan_sha256 ||
    typeof capsule?.content !== "string" ||
    stableSha(capsule.content) !== capsule?.capsule_sha256
  ) {
    return Object.freeze({ ok: false, reason: "execution_context_capsule_invalid" })
  }

  const contract = projectAdditiveExecutionContract(capability)
  const rendered = renderExecutionContractWithCoverage(contract)
  if (
    contract.ok !== true ||
    rendered.ok !== true ||
    rendered.coverage?.complete !== true ||
    contract.contract_sha256 !== capsule.execution_contract_sha256 ||
    contract.visible_sha256 !== capsule.execution_contract_visible_sha256 ||
    rendered.renderer_sha256 !== capsule.execution_contract_renderer_sha256 ||
    contract.capability_sha256 !== capsule.capability_sha256 ||
    contract.authority_sha256 !== capsule.authority_sha256
  ) {
    return Object.freeze({
      ok: false,
      reason: "execution_context_capsule_authority_drift",
      current_contract_sha256: contract.contract_sha256 ?? null,
      expected_contract_sha256: capsule.execution_contract_sha256 ?? null,
    })
  }

  for (const block of array(capsule.selected_evidence_blocks)) {
    const row = contextRow(block)
    if (!row) return Object.freeze({ ok: false, reason: "execution_context_capsule_evidence_invalid" })
    const checked = await attestedSource(root, row)
    if (!checked.ok) {
      return Object.freeze({ ok: false, reason: checked.reason, failed_file: row.file })
    }
  }

  return Object.freeze({
    ok: true,
    reason: "execution_context_capsule_verified",
    capsule_sha256: capsule.capsule_sha256,
    execution_contract_sha256: contract.contract_sha256,
    semantic_coverage_sha256: capsule.semantic_coverage_sha256,
  })
}

function slotFileMap(contract) {
  const bySlot = new Map()
  for (const row of array(contract?.visible?.existing_slots)) bySlot.set(row.slot, row.file)
  for (const row of array(contract?.visible?.create_slots)) bySlot.set(row.slot, row.source_file)
  return bySlot
}

function compactFailureDelta(repairHint, targets) {
  const parts = [`FAIL reason=${repairHint?.reason ?? "additive_plan_invalid"}`]
  if (Number.isSafeInteger(repairHint?.operation_index)) parts.push(`operation_index=${repairHint.operation_index}`)
  if (typeof repairHint?.field === "string" && repairHint.field.length > 0) parts.push(`field=${repairHint.field}`)
  const diagnostics = repairHint?.failure_diagnostics ?? {}
  for (const field of ["missing_roles", "missing_slots", "missing_obligations"]) {
    const values = array(diagnostics?.[field])
    if (values.length > 0) parts.push(`${field}=${values.join(",")}`)
  }
  const usage = repairHint?.slot_usage ?? {}
  if (array(usage.unused_existing_slots).length > 0) parts.push(`unused_existing_slots=${usage.unused_existing_slots.join(",")}`)
  if (array(usage.unused_create_slots).length > 0) parts.push(`unused_create_slots=${usage.unused_create_slots.join(",")}`)
  if (targets?.slots?.length > 0) {
    parts.push(`repair_focus_slots=${targets.slots.join(",")}`)
    parts.push(`repair_focus_reason=${targets.reason}`)
  }
  return parts.join(" ")
}

async function buildLegacyRepairExecutionProjection({
  root,
  capsule,
  capability,
  repairHint,
  maxBytes = REPAIR_CONTEXT_DEFAULT_MAX_BYTES,
  plannerBinary = undefined,
} = {}) {
  const budget = resolveRepairContextBudgetBytes(maxBytes)
  const verified = await verifyCompiledExecutionCapsule({ root, capsule, capability })
  if (!verified.ok) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v1",
      reason: verified.reason,
      max_bytes: budget,
      source_capsule_sha256: capsule?.capsule_sha256 ?? null,
    })
  }
  if (
    typeof repairHint?.execution_context_sha256 !== "string" ||
    repairHint.execution_context_sha256 !== capsule.capsule_sha256
  ) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v1",
      reason: "repair_execution_context_identity_mismatch",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }

  const contract = projectAdditiveExecutionContract(capability)
  const targets = repairTargetSlots({ contract, hint: repairHint })
  const bySlot = slotFileMap(contract)
  const targetFiles = [...new Set(targets.slots.map((slot) => bySlot.get(slot)).filter(Boolean))].sort()
  const delta = compactFailureDelta(repairHint, targets)
  const deltaBytes = utf8Bytes(`\n${delta}`)
  if (deltaBytes >= budget) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v1",
      reason: "repair_failure_delta_over_budget",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }

  const blocksByFile = new Map(array(capsule.selected_evidence_blocks).map((block) => [block.file, block]))
  const missingTargetFiles = targetFiles.filter((file) => !blocksByFile.has(file))
  if (missingTargetFiles.length > 0) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v1",
      reason: "repair_target_evidence_missing",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
      missing_target_files: Object.freeze(missingTargetFiles),
    })
  }

  const rows = []
  const sources = new Map()
  for (const file of targetFiles) {
    const row = contextRow(blocksByFile.get(file))
    if (!row) {
      return Object.freeze({ ok: false, protocol: "repair-execution-context-projection-v1", reason: "repair_target_evidence_invalid", max_bytes: budget })
    }
    const checked = await attestedSource(root, row)
    if (!checked.ok) {
      return Object.freeze({ ok: false, protocol: "repair-execution-context-projection-v1", reason: checked.reason, max_bytes: budget, failed_file: file })
    }
    rows.push(Object.freeze({ ...row, tier: 0, critical: true, attested: true }))
    sources.set(file, checked.source)
  }

  const persistedPlan = capsule.structural_plan
  const targetPlanFiles = array(persistedPlan?.files)
    .filter((file) => targetFiles.includes(file.file))
  if (targetPlanFiles.length !== targetFiles.length) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v1",
      reason: "repair_structural_plan_target_missing",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }
  const repairStructuralPlan = Object.freeze({
    ...persistedPlan,
    files_total: targetPlanFiles.length,
    parsed_files: targetPlanFiles.filter((file) => file.parse_status === "parsed").length,
    fallback_files: targetPlanFiles.filter((file) => file.parse_status !== "parsed").length,
    files: Object.freeze(targetPlanFiles),
  })

  const packed = packExecutionContext({
    contract,
    rows,
    criticalFiles: new Set(targetFiles),
    sources,
    structuralResponse: repairStructuralPlan,
    maxBytes: budget - deltaBytes,
  })
  if (!packed.ok) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v1",
      reason: `repair_${packed.reason}`,
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
      target_slots: targets.slots,
      target_files: Object.freeze(targetFiles),
      minimum_required_bytes: packed.minimum_required_bytes ?? null,
    })
  }

  const content = `${packed.content}\n${delta}`
  if (utf8Bytes(content) > budget) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v1",
      reason: "repair_context_over_budget",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }
  const projectionSha = stableSha(content)
  return Object.freeze({
    ok: true,
    protocol: "repair-execution-context-projection-v1",
    reason: "repair_projection_from_verified_capsule",
    content,
    bytes: utf8Bytes(content),
    max_bytes: budget,
    projection_sha256: projectionSha,
    source_capsule_sha256: capsule.capsule_sha256,
    source_contract_sha256: capsule.execution_contract_sha256,
    source_semantic_coverage_sha256: capsule.semantic_coverage_sha256,
    source_structural_plan_sha256: capsule.structural_plan_sha256,
    target_slots: targets.slots,
    target_files: Object.freeze(targetFiles),
    target_reason: targets.reason,
    target_observation_only: targets.observation_only === true,
    selected_evidence_levels: packed.selected_levels,
    execution_contract_coverage_complete: true,
    semantic_coverage_complete: true,
    routing_authority: false,
    mutation_authority: false,
    verification_authority: false,
  })
}

function compactRepairHostBindings(hostBindings) {
  const parts = []
  for (const [key, value] of Object.entries(hostBindings ?? {})) {
    if (value == null) continue
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
  }
  return parts.length > 0 ? `HOST ${parts.join(" ")}` : null
}

function repairTargetLine(contract, slot) {
  const existing = array(contract?.visible?.existing_slots)
    .find((row) => row.slot === slot)
  if (existing) {
    return (
      `TARGET slot=${slot} file=${existing.file} ` +
      `roles=${array(existing.roles).join(",") || "context"} ` +
      `anchors=${array(existing.evidence_lines).join(",")}`
    )
  }
  const create = array(contract?.visible?.create_slots)
    .find((row) => row.slot === slot)
  if (create) {
    return (
      `TARGET slot=${slot} source=${create.source_file} ` +
      `extensions=${array(create.allowed_extensions).join(",")} ` +
      `max_depth=${create.max_depth} ` +
      `path=${create.path_contract}`
    )
  }
  return null
}

function coverageFailureRepairLines(repairHint) {
  const failure = repairHint?.coverage_failure
  if (
    failure?.protocol !== ADDITIVE_COVERAGE_FAILURE_PROTOCOL ||
    !Array.isArray(failure?.missing) ||
    failure.missing.length < 1
  ) {
    return null
  }
  const lines = []
  for (const row of failure.missing) {
    if (
      typeof row?.obligation !== "string" ||
      typeof row?.slot !== "string" ||
      typeof row?.operation !== "string"
    ) {
      return null
    }
    lines.push(
      `MISSING obligation=${row.obligation} ` +
      `slot=${row.slot} operation=${row.operation}`,
    )
  }
  return lines
}

async function buildCoverageRepairExecutionProjection({
  root,
  capsule,
  capability,
  repairHint,
  maxBytes,
} = {}) {
  const budget = resolveRepairContextBudgetBytes(maxBytes)
  const verified = await verifyCompiledExecutionCapsule({
    root,
    capsule,
    capability,
  })
  if (!verified.ok) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v2",
      reason: verified.reason,
      max_bytes: budget,
      source_capsule_sha256: capsule?.capsule_sha256 ?? null,
    })
  }
  if (
    typeof repairHint?.execution_context_sha256 !== "string" ||
    repairHint.execution_context_sha256 !== capsule.capsule_sha256
  ) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v2",
      reason: "repair_execution_context_identity_mismatch",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }

  const missingLines = coverageFailureRepairLines(repairHint)
  if (!missingLines) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v2",
      reason: "repair_coverage_failure_ir_invalid",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }

  const contract = projectAdditiveExecutionContract(capability)
  if (!contract.ok) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v2",
      reason: contract.reason,
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }
  const targets = repairTargetSlots({
    contract,
    hint: repairHint,
  })
  if (
    targets.reason !== "coverage_failure_ir" ||
    targets.observation_only === true ||
    targets.slots.length < 1
  ) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v2",
      reason: "repair_coverage_target_not_authoritative",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }

  const bySlot = slotFileMap(contract)
  const targetFiles = [...new Set(
    targets.slots
      .map((slot) => bySlot.get(slot))
      .filter(Boolean),
  )].sort()
  if (targetFiles.length < 1) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v2",
      reason: "repair_target_evidence_missing",
      max_bytes: budget,
      source_capsule_sha256: capsule.capsule_sha256,
    })
  }

  const blocksByFile = new Map(
    array(capsule.selected_evidence_blocks)
      .map((block) => [block.file, block]),
  )
  const evidenceBlocks = []
  const evidenceLevels = []
  for (const file of targetFiles) {
    const block = blocksByFile.get(file)
    const row = contextRow(block)
    if (!row || typeof block?.block !== "string") {
      return Object.freeze({
        ok: false,
        protocol: "repair-execution-context-projection-v2",
        reason: "repair_target_evidence_invalid",
        max_bytes: budget,
        failed_file: file,
      })
    }
    const checked = await attestedSource(root, row)
    if (!checked.ok) {
      return Object.freeze({
        ok: false,
        protocol: "repair-execution-context-projection-v2",
        reason: checked.reason,
        max_bytes: budget,
        failed_file: file,
      })
    }
    evidenceBlocks.push(block.block)
    evidenceLevels.push(Object.freeze({
      file,
      level: block.level ?? "anchor",
      structural: block.structural === true,
    }))
  }

  const lines = [
    (
      "REPAIR_DELTA protocol=repair-delta-v1 " +
      `source_capsule=${capsule.capsule_sha256} ` +
      `failed_candidate=${repairHint?.failed_candidate_sha256 ?? "unknown"}`
    ),
  ]
  const host = compactRepairHostBindings(contract.visible.host_bindings)
  if (host) lines.push(host)
  for (const slot of targets.slots) {
    const line = repairTargetLine(contract, slot)
    if (!line) {
      return Object.freeze({
        ok: false,
        protocol: "repair-execution-context-projection-v2",
        reason: "repair_target_contract_invalid",
        max_bytes: budget,
        failed_slot: slot,
      })
    }
    lines.push(line)
  }
  lines.push(...missingLines)

  const usage = array(repairHint?.slot_usage?.operations_by_slot)
  for (const row of usage) {
    lines.push(
      `SUBMITTED slot=${row?.slot ?? "unknown"} ` +
      `operations=${array(row?.operations).join(",") || "none"} ` +
      `mask=${row?.operation_mask ?? "0x0"}`,
    )
  }

  const progress = repairHint?.repair_progress
  if (progress?.protocol === "repair-convergence-v1") {
    lines.push(
      `PROGRESS status=${progress.status} ` +
      `strict=${progress.strict_progress === true}`,
    )
  }

  const header = lines.join("\n")
  const content = [header, ...evidenceBlocks].join("\n\n")
  const bytes = utf8Bytes(content)
  if (bytes > budget) {
    return Object.freeze({
      ok: false,
      protocol: "repair-execution-context-projection-v2",
      reason: "repair_delta_context_over_budget",
      max_bytes: budget,
      required_bytes: bytes,
      over_budget_bytes: bytes - budget,
      source_capsule_sha256: capsule.capsule_sha256,
      target_slots: targets.slots,
      target_files: Object.freeze(targetFiles),
    })
  }

  return Object.freeze({
    ok: true,
    protocol: "repair-execution-context-projection-v2",
    reason: "repair_delta_from_verified_capsule",
    content,
    bytes,
    max_bytes: budget,
    projection_sha256: stableSha(content),
    source_capsule_sha256: capsule.capsule_sha256,
    source_contract_sha256: capsule.execution_contract_sha256,
    source_semantic_contract_sha256:
      capsule.semantic_contract_sha256 ??
      capsule.execution_contract_visible_sha256,
    source_semantic_coverage_sha256:
      capsule.semantic_coverage_sha256,
    source_structural_plan_sha256:
      capsule.structural_plan_sha256,
    coverage_failure_sha256:
      repairHint?.coverage_failure_sha256 ?? null,
    failed_candidate_sha256:
      repairHint?.failed_candidate_sha256 ?? null,
    target_slots: targets.slots,
    target_files: Object.freeze(targetFiles),
    target_reason: targets.reason,
    target_observation_only: false,
    selected_evidence_levels: Object.freeze(evidenceLevels),
    execution_contract_coverage_complete: true,
    semantic_coverage_complete: true,
    routing_authority: false,
    mutation_authority: false,
    verification_authority: false,
  })
}

export async function buildRepairExecutionProjection(options = {}) {
  const coverageFailure = options?.repairHint?.coverage_failure
  if (
    coverageFailure?.protocol === ADDITIVE_COVERAGE_FAILURE_PROTOCOL &&
    Array.isArray(coverageFailure?.missing) &&
    coverageFailure.missing.length > 0
  ) {
    return buildCoverageRepairExecutionProjection(options)
  }
  return buildLegacyRepairExecutionProjection(options)
}
