import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { inspectEvidence } from "./evidence-inspect-v1.mjs"
import {
  extractAdditiveFailureDiagnostics,
  normalizeAdditiveCoverageFailure,
  observeAdditivePlanSlotUsage,
} from "./execution-contract-v1.mjs"
import {
  classifyRepairProgress,
  snapshotFailedCandidate,
} from "./repair-convergence-v1.mjs"

export const ADDITIVE_MUTATION_CAPABILITY_PROTOCOL =
  "scout-additive-capability-v1"
export const ADDITIVE_MUTATION_PLAN_PROTOCOL = "additive-mutation-plan-v1"
export const ADDITIVE_HOST_BINDING_PROTOCOL = "typed-host-attestation-v2"
export const ADDITIVE_MUTATION_AUTHORITY_PROTOCOL =
  "sealed-additive-handoff-v1"
export const ADDITIVE_MUTATION_ABI_PROTOCOL =
  "closed-additive-mutation-abi-v1"
export const ADDITIVE_REPAIR_HINT_PROTOCOL = "additive-repair-hint-v1"
export const EXECUTE_ADDITIVE_PLAN_TOOL = "execute_additive_plan"

export const ADDITIVE_MAX_OPERATIONS = 8
export const ADDITIVE_MAX_CHANGED_FILES = 5
export const ADDITIVE_MAX_CREATE_FILES = 2
export const ADDITIVE_MAX_PLAN_BYTES = 32 * 1024
export const ADDITIVE_MAX_REPLACE_BYTES = 12 * 1024
export const ADDITIVE_MAX_CREATE_BYTES = 16 * 1024
export const ADDITIVE_MAX_REL_PATH_BYTES = 240
export const ADDITIVE_MAX_CREATE_DEPTH = 2
export const ADDITIVE_MODEL_CONTEXT_MAX_BYTES = 4800
export const ADDITIVE_HANDOFF_MAX_BYTES = 256 * 1024

const SHA256_RE = /^[0-9a-f]{64}$/iu
const HANDOFF_PREFIX = ".opencode/scout-handoffs/capabilities/"

function array(value) {
  return Array.isArray(value) ? value : []
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
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
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null
  }

  return normalized
}

function stableSha(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function evidenceFile(row) {
  const file = normalizeFile(row?.file)
  const witnesses = array(row?.witnesses)
    .filter((witness) =>
      Number.isSafeInteger(witness?.line) &&
      witness.line >= 1 &&
      typeof witness?.sha256 === "string" &&
      SHA256_RE.test(witness.sha256),
    )
    .map((witness) => ({
      line: witness.line,
      sha256: witness.sha256.toLowerCase(),
      extractor:
        typeof witness.extractor === "string" && witness.extractor.length > 0
          ? witness.extractor
          : "unknown",
    }))
    .sort((a, b) => a.line - b.line || a.extractor.localeCompare(b.extractor))

  if (!file || witnesses.length < 1) return null

  const hashes = [...new Set(witnesses.map((witness) => witness.sha256))]
  if (hashes.length !== 1) return null

  return Object.freeze({
    file,
    roles: Object.freeze(
      [...new Set(array(row?.roles).filter((role) => typeof role === "string"))]
        .sort(),
    ),
    sha256: hashes[0],
    evidence_lines: Object.freeze(
      [...new Set(witnesses.map((witness) => witness.line))].sort((a, b) => a - b),
    ),
  })
}

function indexEvidenceFiles(rawRows) {
  const byFile = new Map()

  for (const raw of array(rawRows)) {
    const row = evidenceFile(raw)
    if (!row) continue

    const prior = byFile.get(row.file)
    if (!prior) {
      byFile.set(row.file, {
        file: row.file,
        roles: new Set(row.roles),
        sha256: row.sha256,
        evidence_lines: new Set(row.evidence_lines),
      })
      continue
    }

    if (prior.sha256 !== row.sha256) {
      return {
        ok: false,
        reason: "additive_evidence_file_hash_conflict",
        rows: [],
        byFile: new Map(),
      }
    }

    for (const role of row.roles) prior.roles.add(role)
    for (const line of row.evidence_lines) prior.evidence_lines.add(line)
  }

  const rows = [...byFile.values()]
    .map((row) => Object.freeze({
      file: row.file,
      roles: Object.freeze([...row.roles].sort()),
      sha256: row.sha256,
      evidence_lines: Object.freeze(
        [...row.evidence_lines].sort((a, b) => a - b),
      ),
    }))
    .sort((a, b) => a.file.localeCompare(b.file))

  return {
    ok: true,
    reason: "indexed",
    rows,
    byFile: new Map(rows.map((row) => [row.file, row])),
  }
}

function baseCapability(status, reason, extra = {}) {
  return Object.freeze({
    protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
    host_binding_protocol: ADDITIVE_HOST_BINDING_PROTOCOL,
    status,
    reason,
    binding_ready: false,
    ready: false,
    mutation_authority: false,
    ...extra,
  })
}

function structuralHostFile(host, field) {
  if (host?.structural_ready !== true) return null
  return normalizeFile(host?.[field])
}

function exactAttestedRow(byFile, file) {
  if (!file) return null
  return byFile.get(file) ?? null
}

function validateProtectedSurface(host) {
  const file = structuralHostFile(host, "owner_file")
  if (!file) {
    return { ok: false, reason: "additive_route_host_unavailable" }
  }

  if (typeof host?.owner === "string" && host.owner.startsWith("file:")) {
    const declared = normalizeFile(host.owner)
    if (declared !== file) {
      return { ok: false, reason: "additive_route_host_identity_inconsistent" }
    }
  }

  return { ok: true, file }
}

function validateUiHost(host) {
  const file = structuralHostFile(host, "physical_file")
  if (!file) return { ok: false, reason: "additive_ui_host_unavailable" }

  return {
    ok: true,
    file,
    resource:
      typeof host?.resource === "string" && host.resource.length > 0
        ? host.resource
        : null,
  }
}

function validateNavigationHost(host) {
  const file = structuralHostFile(host, "physical_file")
  if (!file) {
    return { ok: false, reason: "additive_navigation_host_unavailable" }
  }

  const resource =
    typeof host?.resource === "string" && host.resource.length > 0
      ? host.resource
      : null
  if (!resource) {
    return { ok: false, reason: "additive_navigation_resource_unavailable" }
  }

  const topology = array(host?.topology).filter((row) =>
    row?.structural_ready === true &&
    normalizeFile(row?.physical_file) === file &&
    row?.resource === resource,
  )

  if (topology.length !== 1) {
    return {
      ok: false,
      reason: "additive_navigation_topology_unproven",
    }
  }

  return {
    ok: true,
    file,
    resource,
    topology: Object.freeze({
      resource,
      physical_file: file,
      shared_includers:
        Number.isSafeInteger(topology[0]?.shared_includers)
          ? topology[0].shared_includers
          : null,
      internal_route_targets:
        Number.isSafeInteger(topology[0]?.internal_route_targets)
          ? topology[0].internal_route_targets
          : null,
    }),
  }
}

export function deriveAdditiveMutationCapability({
  taskShape = null,
  evidenceClosure = null,
  hostResourceClosure = null,
} = {}) {
  if (taskShape?.status !== "compiled" || taskShape?.shape !== "additive") {
    return baseCapability("not_applicable", "task_shape_not_additive")
  }

  if (
    evidenceClosure?.status !== "covered" ||
    evidenceClosure?.localization_authority !== true ||
    evidenceClosure?.truncated === true ||
    array(evidenceClosure?.missing_roles).length > 0 ||
    array(evidenceClosure?.ambiguous_roles).length > 0
  ) {
    return baseCapability("abstained", "localization_evidence_not_sufficient")
  }

  const indexed = indexEvidenceFiles(evidenceClosure?.files)
  if (indexed.ok !== true) {
    return baseCapability("abstained", indexed.reason)
  }

  const { rows, byFile } = indexed
  const requiredRoles = new Set(array(evidenceClosure?.required_roles))

  // Coverage, host identity and mutation authority are deliberately separate:
  //
  // 1. EvidenceClosure proves that task obligations are covered and gives
  //    strong source attestations. Its per-file roles may be propagated along
  //    a causal path, so they are never used to choose a mutation target.
  // 2. HostResourceClosure identifies exact physical hosts.
  // 3. Only a persisted, freshly re-hashed sealed handoff may later promote
  //    this bound candidate to mutation authority.
  const routeHost = validateProtectedSurface(
    hostResourceClosure?.protected_surface,
  )
  if (routeHost.ok !== true) {
    return baseCapability("abstained", routeHost.reason)
  }

  const routeRow = exactAttestedRow(byFile, routeHost.file)
  if (!routeRow) {
    return baseCapability("abstained", "additive_route_host_unattested")
  }

  const uiHost = validateUiHost(hostResourceClosure?.ui_candidate)
  if (uiHost.ok !== true) {
    return baseCapability("abstained", uiHost.reason)
  }

  const createSource = exactAttestedRow(byFile, uiHost.file)
  if (!createSource) {
    return baseCapability("abstained", "additive_ui_host_unattested")
  }

  let navigationRow = null
  let navigationBinding = null
  if (requiredRoles.has("navigation_host")) {
    const navigationHost = validateNavigationHost(
      hostResourceClosure?.navigation_candidate,
    )
    if (navigationHost.ok !== true) {
      return baseCapability("abstained", navigationHost.reason)
    }

    navigationRow = exactAttestedRow(byFile, navigationHost.file)
    if (!navigationRow) {
      return baseCapability(
        "abstained",
        "additive_navigation_host_unattested",
      )
    }
    navigationBinding = navigationHost
  }

  const createRoot = path.posix.dirname(createSource.file)
  const extension = path.posix.extname(createSource.file).toLowerCase()
  if (!createRoot || createRoot === "." || !extension) {
    return baseCapability("abstained", "additive_ui_create_root_invalid")
  }

  const mutable = new Map([[routeRow.file, routeRow]])
  if (navigationRow) mutable.set(navigationRow.file, navigationRow)

  if (mutable.size < 1 || mutable.size > ADDITIVE_MAX_CHANGED_FILES - 1) {
    return baseCapability("abstained", "additive_existing_target_budget")
  }

  const existingSlots = [...mutable.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((row, index) => Object.freeze({
      slot: `existing:${index}`,
      file: row.file,
      sha256: row.sha256,
      evidence_lines: Object.freeze([...row.evidence_lines]),
      // Roles are context metadata only. They are intentionally not part of
      // target identity or authorization.
      roles: Object.freeze([...row.roles]),
      allowed_operations: Object.freeze(["replace_exact"]),
    }))

  const createSlots = [Object.freeze({
    slot: "create:0",
    root: createRoot,
    source_file: createSource.file,
    source_sha256: createSource.sha256,
    evidence_lines: Object.freeze([...createSource.evidence_lines]),
    allowed_extensions: Object.freeze([extension]),
    max_depth: ADDITIVE_MAX_CREATE_DEPTH,
    allowed_operations: Object.freeze(["create_file"]),
  })]

  const contextFiles = rows.map((row) => Object.freeze({
    file: row.file,
    sha256: row.sha256,
    evidence_lines: Object.freeze([...row.evidence_lines]),
    roles: Object.freeze([...row.roles]),
  }))

  const hostBindings = Object.freeze({
    route_owner: routeRow.file,
    navigation_host: navigationRow?.file ?? null,
    ui_create_source: createSource.file,
    ui_resource: uiHost.resource,
    navigation_resource: navigationBinding?.resource ?? null,
    navigation_topology: navigationBinding?.topology ?? null,
  })

  const payload = {
    protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
    host_binding_protocol: ADDITIVE_HOST_BINDING_PROTOCOL,
    operation: "additive_surface",
    task_shape: "additive",
    host_bindings: hostBindings,
    existing_slots: existingSlots,
    create_slots: createSlots,
    context_files: contextFiles,
    budgets: {
      max_operations: ADDITIVE_MAX_OPERATIONS,
      max_changed_files: ADDITIVE_MAX_CHANGED_FILES,
      max_create_files: ADDITIVE_MAX_CREATE_FILES,
      max_plan_bytes: ADDITIVE_MAX_PLAN_BYTES,
    },
  }

  return baseCapability("bound", "typed_hosts_intersect_attested_sources", {
    ...payload,
    binding_ready: true,
    capability_sha256: stableSha(payload),
  })
}

function additiveHandoffBindingPayload({ capability, context } = {}) {
  return {
    protocol: "scout-handoff-v1",
    scope_mode: "additive_mutation_capability",
    capability_protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
    authority_protocol: ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
    sealed_context_sha256: context?.context_sha256 ?? null,
    allowed_mutations: ["replace_exact", "create_file"],
    capability_sha256: capability?.capability_sha256 ?? null,
    existing_slots: array(capability?.existing_slots).map((slot) => ({
      slot: slot.slot,
      file: slot.file,
      sha256: slot.sha256,
      evidence_lines: [...array(slot.evidence_lines)],
      allowed_operations: [...array(slot.allowed_operations)],
    })),
    create_slots: array(capability?.create_slots).map((slot) => ({
      slot: slot.slot,
      root: slot.root,
      source_file: slot.source_file,
      source_sha256: slot.source_sha256,
      evidence_lines: [...array(slot.evidence_lines)],
      allowed_extensions: [...array(slot.allowed_extensions)],
      max_depth: slot.max_depth,
      allowed_operations: [...array(slot.allowed_operations)],
    })),
    context_files: array(capability?.context_files).map((row) => ({
      file: row.file,
      sha256: row.sha256,
      evidence_lines: [...array(row.evidence_lines)],
    })),
  }
}

function additiveHandoffBindingSha(args) {
  return stableSha(additiveHandoffBindingPayload(args))
}

export function buildAdditiveMutationHandoff({
  searchProtocol,
  sessionKey,
  turnKey,
  generatedAtMs = null,
  capability,
  context = null,
} = {}) {
  if (
    capability?.binding_ready !== true ||
    typeof capability?.capability_sha256 !== "string" ||
    context?.ok !== true ||
    context?.context_sha256 !==
      stableSha({
        capability: capability.capability_sha256,
        content: context.content,
      })
  ) {
    return { ok: false, reason: "additive_handoff_inputs_invalid" }
  }

  const files = array(capability.context_files).map((row) => ({
    file: row.file,
    origins: ["evidence_closure"],
    evidence_lines: [...row.evidence_lines],
    changed_during_scout: false,
    fingerprint: {
      kind: "sha256",
      strong: true,
      sha256: row.sha256,
      evidence_fresh: true,
    },
  }))

  const handoffBindingSha = additiveHandoffBindingSha({
    capability,
    context,
  })

  return {
    ok: true,
    bundle: {
      protocol: "scout-handoff-v1",
      search_protocol: searchProtocol,
      session_key: sessionKey,
      turn_key: turnKey,
      generated_at_ms: Number.isFinite(generatedAtMs) ? generatedAtMs : null,
      status:
        capability?.mutation_authority === true ? "ready" : "provisional",
      blocking_reasons: [],
      partial_reasons: [],
      scope_mode: "additive_mutation_capability",
      capability_protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
      authority_protocol: ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
      sealed_context_sha256: context.context_sha256,
      handoff_binding_sha256: handoffBindingSha,
      allowed_mutations: ["replace_exact", "create_file"],
      additive_capability: capability,
      authority_receipt: capability?.authority_receipt ?? null,
      files,
    },
  }
}

function normalizedHandoffPath(root, handoffPath) {
  const rel = normalizeFile(handoffPath)
  if (
    typeof root !== "string" ||
    root.length < 1 ||
    !rel ||
    !rel.startsWith(HANDOFF_PREFIX) ||
    !rel.endsWith(".json")
  ) {
    return null
  }

  const canonicalRoot = path.resolve(root)
  const absolute = path.resolve(root, rel)
  if (
    absolute === canonicalRoot ||
    !absolute.startsWith(`${canonicalRoot}${path.sep}`)
  ) {
    return null
  }

  return { rel, absolute }
}

async function readBoundedHandoff(root, handoffPath) {
  const resolved = normalizedHandoffPath(root, handoffPath)
  if (!resolved) return { ok: false, reason: "additive_handoff_path_invalid" }

  let raw
  try {
    const info = await stat(resolved.absolute)
    if (!info.isFile() || info.size < 2 || info.size > ADDITIVE_HANDOFF_MAX_BYTES) {
      return { ok: false, reason: "additive_handoff_file_invalid" }
    }
    raw = await readFile(resolved.absolute)
  } catch {
    return { ok: false, reason: "additive_handoff_unavailable" }
  }

  let bundle
  try {
    bundle = JSON.parse(raw.toString("utf8"))
  } catch {
    return { ok: false, reason: "additive_handoff_json_invalid" }
  }

  return {
    ok: true,
    rel: resolved.rel,
    raw,
    bundle,
    handoff_sha256: createHash("sha256").update(raw).digest("hex"),
  }
}

function handoffMatches({
  bundle,
  capability,
  context,
  requireAuthority,
} = {}) {
  const expectedBindingSha = additiveHandoffBindingSha({
    capability,
    context,
  })
  if (
    bundle?.protocol !== "scout-handoff-v1" ||
    bundle?.scope_mode !== "additive_mutation_capability" ||
    bundle?.capability_protocol !== ADDITIVE_MUTATION_CAPABILITY_PROTOCOL ||
    bundle?.authority_protocol !== ADDITIVE_MUTATION_AUTHORITY_PROTOCOL ||
    bundle?.sealed_context_sha256 !== context?.context_sha256 ||
    bundle?.handoff_binding_sha256 !== expectedBindingSha ||
    JSON.stringify(bundle?.allowed_mutations) !==
      JSON.stringify(["replace_exact", "create_file"]) ||
    bundle?.additive_capability?.capability_sha256 !==
      capability?.capability_sha256
  ) {
    return false
  }

  if (requireAuthority === true) {
    return (
      bundle?.status === "ready" &&
      bundle?.additive_capability?.mutation_authority === true &&
      bundle?.additive_capability?.authority_protocol ===
        ADDITIVE_MUTATION_AUTHORITY_PROTOCOL &&
      bundle?.additive_capability?.authority_sha256 ===
        capability?.authority_sha256 &&
      bundle?.authority_receipt?.receipt_sha256 ===
        capability?.authority_receipt?.receipt_sha256
    )
  }

  return (
    bundle?.status === "provisional" &&
    bundle?.additive_capability?.binding_ready === true &&
    bundle?.additive_capability?.mutation_authority !== true
  )
}

export async function authorizeAdditiveMutationCapability({
  root,
  capability,
  context,
  handoffPath,
} = {}) {
  if (
    capability?.binding_ready !== true ||
    capability?.ready === true ||
    capability?.mutation_authority === true ||
    context?.ok !== true ||
    typeof context?.context_sha256 !== "string"
  ) {
    return baseCapability("abstained", "additive_authority_inputs_invalid")
  }

  const persisted = await readBoundedHandoff(root, handoffPath)
  if (persisted.ok !== true) {
    return baseCapability("abstained", persisted.reason)
  }

  if (
    !handoffMatches({
      bundle: persisted.bundle,
      capability,
      context,
      requireAuthority: false,
    })
  ) {
    return baseCapability("abstained", "additive_provisional_handoff_mismatch")
  }

  const receiptPayload = {
    protocol: ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
    capability_sha256: capability.capability_sha256,
    context_sha256: context.context_sha256,
    handoff_binding_sha256: additiveHandoffBindingSha({
      capability,
      context,
    }),
    handoff_path: persisted.rel,
    provisional_handoff_sha256: persisted.handoff_sha256,
  }
  const receipt = Object.freeze({
    ...receiptPayload,
    receipt_sha256: stableSha(receiptPayload),
  })

  return Object.freeze({
    ...capability,
    status: "ready",
    reason: "sealed_additive_handoff_authorized",
    binding_ready: true,
    ready: true,
    mutation_authority: true,
    authority_protocol: ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
    authority_receipt: receipt,
    authority_sha256: receipt.receipt_sha256,
    handoff_path: persisted.rel,
  })
}

export async function verifyAdditiveMutationAuthority({
  root,
  capability,
  context,
  handoffPath,
} = {}) {
  if (
    capability?.ready !== true ||
    capability?.mutation_authority !== true ||
    capability?.authority_protocol !== ADDITIVE_MUTATION_AUTHORITY_PROTOCOL ||
    capability?.authority_receipt?.receipt_sha256 !== capability?.authority_sha256
  ) {
    return { ok: false, reason: "additive_authority_not_ready" }
  }

  const persisted = await readBoundedHandoff(root, handoffPath)
  if (persisted.ok !== true) return persisted

  if (
    !handoffMatches({
      bundle: persisted.bundle,
      capability,
      context,
      requireAuthority: true,
    })
  ) {
    return { ok: false, reason: "additive_authorized_handoff_mismatch" }
  }

  return {
    ok: true,
    protocol: ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
    reason: "sealed_additive_handoff_verified",
    handoff_path: persisted.rel,
    handoff_sha256: persisted.handoff_sha256,
    authority_sha256: capability.authority_sha256,
  }
}

const ADDITIVE_REPAIRABLE_PLAN_REASONS = new Set([
  "additive_plan_coverage_incomplete",
  "additive_empty_transaction",
  "additive_replace_before_empty",
  "additive_replace_before_too_large",
  "additive_replace_replacement_too_large",
  "additive_replace_nul",
  "additive_replace_no_change",
  "additive_replace_preimage_reused",
  "additive_create_relative_path_too_large",
  "additive_create_relative_path_absolute",
  "additive_create_relative_path_separator_invalid",
  "additive_create_relative_path_invalid",
  "additive_create_relative_path_depth_exceeded",
  "additive_create_relative_path_restates_root",
  "additive_create_content_too_large",
  "additive_create_content_nul",
  "additive_create_extension_invalid",
  "additive_create_duplicate",
  "additive_create_file_budget",
  "additive_changed_file_budget",
  "additive_plan_byte_budget",
])

function planFailure(reason, detail = null, extra = {}) {
  return {
    ok: false,
    protocol: ADDITIVE_MUTATION_PLAN_PROTOCOL,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    reason,
    detail,
    repairable: ADDITIVE_REPAIRABLE_PLAN_REASONS.has(reason),
    mutations: [],
    mutation_authority: false,
    ...extra,
  }
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  )
}

function indexedFailure(reason, index, field = null, extra = {}) {
  return planFailure(reason, String(index), {
    operation_index: index,
    field,
    ...extra,
  })
}

export function isAdditivePlanFailureRepairable(reason) {
  return ADDITIVE_REPAIRABLE_PLAN_REASONS.has(reason)
}

export function validateAdditiveMutationRequest(request) {
  if (!exactKeys(request, ["replacements", "creations"])) {
    return planFailure("additive_request_shape_invalid")
  }

  if (!Array.isArray(request.replacements)) {
    return planFailure("additive_replacements_array_invalid")
  }
  if (!Array.isArray(request.creations)) {
    return planFailure("additive_creations_array_invalid")
  }

  if (request.creations.length > ADDITIVE_MAX_CREATE_FILES) {
    return planFailure("additive_create_file_budget")
  }

  const operationCount = request.replacements.length + request.creations.length
  if (operationCount > ADDITIVE_MAX_OPERATIONS) {
    return planFailure("additive_operation_count_invalid")
  }

  for (let index = 0; index < request.replacements.length; index += 1) {
    const op = request.replacements[index]
    if (!exactKeys(op, ["slot", "before", "replacement"])) {
      return indexedFailure(
        "additive_replace_shape_invalid",
        index,
        "replacement",
      )
    }
    if (typeof op.slot !== "string" || op.slot.length < 1 || op.slot.length > 64) {
      return indexedFailure("additive_replace_slot_shape_invalid", index, "slot")
    }
    if (typeof op.before !== "string" || op.before.length < 1) {
      return indexedFailure("additive_replace_before_shape_invalid", index, "before")
    }
    if (typeof op.replacement !== "string") {
      return indexedFailure(
        "additive_replace_replacement_shape_invalid",
        index,
        "replacement",
      )
    }
  }

  for (let index = 0; index < request.creations.length; index += 1) {
    const op = request.creations[index]
    if (!exactKeys(op, ["slot", "relative_path", "content"])) {
      return indexedFailure("additive_create_shape_invalid", index, "creation")
    }
    if (typeof op.slot !== "string" || op.slot.length < 1 || op.slot.length > 64) {
      return indexedFailure("additive_create_slot_shape_invalid", index, "slot")
    }
    if (typeof op.relative_path !== "string" || op.relative_path.length < 1) {
      return indexedFailure(
        "additive_create_relative_path_shape_invalid",
        index,
        "relative_path",
      )
    }
    if (typeof op.content !== "string") {
      return indexedFailure("additive_create_content_shape_invalid", index, "content")
    }
  }

  return {
    ok: true,
    protocol: ADDITIVE_MUTATION_PLAN_PROTOCOL,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    operation_count: operationCount,
  }
}

function validateCreateRelativePath(relativePath, target, index) {
  if (utf8Bytes(relativePath) > ADDITIVE_MAX_REL_PATH_BYTES) {
    return indexedFailure(
      "additive_create_relative_path_too_large",
      index,
      "relative_path",
    )
  }
  if (
    relativePath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(relativePath)
  ) {
    return indexedFailure(
      "additive_create_relative_path_absolute",
      index,
      "relative_path",
    )
  }
  if (relativePath.includes("\\")) {
    return indexedFailure(
      "additive_create_relative_path_separator_invalid",
      index,
      "relative_path",
    )
  }
  if (relativePath.includes("\0")) {
    return indexedFailure(
      "additive_create_relative_path_invalid",
      index,
      "relative_path",
    )
  }

  const sealedRoot = normalizeFile(target?.root)
  if (!sealedRoot) {
    return indexedFailure(
      "additive_create_slot_invalid",
      index,
      "slot",
    )
  }

  if (relativePath === sealedRoot) {
    return indexedFailure(
      "additive_create_relative_path_restates_root",
      index,
      "relative_path",
    )
  }

  const exactRootPrefix = `${sealedRoot}/`
  const canonicalRelativePath =
    relativePath.startsWith(exactRootPrefix)
      ? relativePath.slice(exactRootPrefix.length)
      : relativePath

  const parts = canonicalRelativePath.split("/")
  if (
    parts.length < 1 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    return indexedFailure(
      "additive_create_relative_path_invalid",
      index,
      "relative_path",
    )
  }

  const maxDepth =
    Number.isSafeInteger(target?.max_depth) && target.max_depth >= 1
      ? Math.min(target.max_depth, ADDITIVE_MAX_CREATE_DEPTH)
      : ADDITIVE_MAX_CREATE_DEPTH
  if (parts.length > maxDepth) {
    return indexedFailure(
      "additive_create_relative_path_depth_exceeded",
      index,
      "relative_path",
    )
  }

  return {
    ok: true,
    relative_path: canonicalRelativePath,
    sealed_root: sealedRoot,
    canonicalized: canonicalRelativePath !== relativePath,
  }
}

export function buildAdditiveRepairHint({
  failure,
  capability,
  request,
  executionContextSha256 = null,
  previousRepairHint = null,
} = {}) {
  const reason =
    typeof failure?.reason === "string"
      ? failure.reason
      : "additive_plan_invalid"
  const baseRepairable = isAdditivePlanFailureRepairable(reason)
  const operationIndex =
    Number.isSafeInteger(failure?.operation_index) &&
    failure.operation_index >= 0
      ? failure.operation_index
      : null
  const field =
    typeof failure?.field === "string" && failure.field.length > 0
      ? failure.field
      : null
  const capabilitySha =
    typeof capability?.capability_sha256 === "string"
      ? capability.capability_sha256
      : null
  const authoritySha =
    typeof capability?.authority_sha256 === "string"
      ? capability.authority_sha256
      : null
  const contextSha =
    typeof executionContextSha256 === "string" &&
    executionContextSha256.length > 0
      ? executionContextSha256
      : null
  const slotUsage = observeAdditivePlanSlotUsage({
    capability,
    request,
  })
  const coverageFailure = normalizeAdditiveCoverageFailure({
    failure,
    capability,
  })
  const failureDiagnostics =
    extractAdditiveFailureDiagnostics(
      failure,
      { capability },
    )
  const failedCandidate = snapshotFailedCandidate({
    request,
    slotUsage,
  })
  const repairProgress = classifyRepairProgress({
    previousFailure: previousRepairHint?.coverage_failure ?? null,
    currentFailure: coverageFailure,
  })
  const repairable =
    baseRepairable &&
    repairProgress.allow_retry !== false

  const payload = {
    protocol: ADDITIVE_REPAIR_HINT_PROTOCOL,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    repairable,
    reason,
    operation_index: operationIndex,
    field,
    capability_sha256: capabilitySha,
    authority_sha256: authoritySha,
    execution_context_sha256: contextSha,
    failed_candidate_sha256: failedCandidate.request_sha256,
    failed_candidate: failedCandidate,
    slot_usage: slotUsage,
    coverage_failure: coverageFailure,
    coverage_failure_sha256:
      coverageFailure?.failure_sha256 ?? null,
    failure_diagnostics: failureDiagnostics,
    repair_progress: repairProgress,
    mutation_authority: false,
  }
  return Object.freeze({
    ...payload,
    hint_sha256: stableSha(payload),
  })
}

export function additiveRepairAuthorityMatches({
  hint,
  capability,
  executionContextSha256 = null,
} = {}) {
  const contextIdentityMatches =
    executionContextSha256 == null
      ? hint?.execution_context_sha256 == null
      : hint?.execution_context_sha256 ===
        executionContextSha256
  return (
    hint?.protocol === ADDITIVE_REPAIR_HINT_PROTOCOL &&
    hint?.repairable === true &&
    typeof hint?.capability_sha256 === "string" &&
    typeof hint?.authority_sha256 === "string" &&
    capability?.ready === true &&
    capability?.mutation_authority === true &&
    capability?.authority_protocol ===
      ADDITIVE_MUTATION_AUTHORITY_PROTOCOL &&
    hint.capability_sha256 === capability?.capability_sha256 &&
    hint.authority_sha256 === capability?.authority_sha256 &&
    contextIdentityMatches
  )
}
export function materializeAdditiveMutationPlan({ capability, request } = {}) {
  if (capability?.ready !== true || capability?.mutation_authority !== true) {
    return planFailure("additive_capability_not_authorized")
  }

  const shape = validateAdditiveMutationRequest(request)
  if (shape.ok !== true) return shape

  if (shape.operation_count < 1) {
    return planFailure("additive_empty_transaction")
  }
  const replacements = request.replacements
  const creations = request.creations
  const existing = new Map(
    array(capability.existing_slots).map((row) => [row.slot, row]),
  )
  const creates = new Map(
    array(capability.create_slots).map((row) => [row.slot, row]),
  )
  const mutations = []
  const changedFiles = new Set()
  const createFiles = new Set()
  const usedReplacePreimages = new Set()
  let planBytes = 0

  for (let index = 0; index < replacements.length; index += 1) {
    const op = replacements[index]
    const target = existing.get(op.slot)
    if (!target) {
      return indexedFailure(
        "additive_replace_slot_invalid",
        index,
        "slot",
      )
    }

    const before = op.before
    const preimageKey = `${target.file}\0${before}`
    if (usedReplacePreimages.has(preimageKey)) {
      return indexedFailure(
        "additive_replace_preimage_reused",
        index,
        "before",
      )
    }
    const replacement = op.replacement
    if (before.length < 1) {
      return indexedFailure(
        "additive_replace_before_empty",
        index,
        "before",
      )
    }
    if (utf8Bytes(before) > ADDITIVE_MAX_REPLACE_BYTES) {
      return indexedFailure(
        "additive_replace_before_too_large",
        index,
        "before",
      )
    }
    if (utf8Bytes(replacement) > ADDITIVE_MAX_REPLACE_BYTES) {
      return indexedFailure(
        "additive_replace_replacement_too_large",
        index,
        "replacement",
      )
    }
    if (before.includes("\0") || replacement.includes("\0")) {
      return indexedFailure(
        "additive_replace_nul",
        index,
        before.includes("\0") ? "before" : "replacement",
      )
    }
    if (before === replacement) {
      return indexedFailure(
        "additive_replace_no_change",
        index,
        "replacement",
      )
    }

    planBytes += utf8Bytes(before) + utf8Bytes(replacement)
    usedReplacePreimages.add(preimageKey)
    changedFiles.add(target.file)
    mutations.push({
      kind: "replace_exact",
      file: target.file,
      symbol: "<additive>",
      before,
      replacement,
    })
  }

  for (let index = 0; index < creations.length; index += 1) {
    const op = creations[index]
    const target = creates.get(op.slot)
    if (!target) {
      return indexedFailure(
        "additive_create_slot_invalid",
        index,
        "slot",
      )
    }

    const relative = validateCreateRelativePath(
      op.relative_path,
      target,
      index,
    )
    if (relative.ok !== true) return relative

    if (utf8Bytes(op.content) > ADDITIVE_MAX_CREATE_BYTES) {
      return indexedFailure(
        "additive_create_content_too_large",
        index,
        "content",
      )
    }
    if (op.content.includes("\0")) {
      return indexedFailure(
        "additive_create_content_nul",
        index,
        "content",
      )
    }

    const extension = path.posix.extname(relative.relative_path).toLowerCase()
    if (!array(target.allowed_extensions).includes(extension)) {
      return indexedFailure(
        "additive_create_extension_invalid",
        index,
        "relative_path",
      )
    }

    const file = normalizeFile(
      path.posix.join(relative.sealed_root, relative.relative_path),
    )
    if (
      !file ||
      (file !== relative.sealed_root &&
        !file.startsWith(`${relative.sealed_root}/`))
    ) {
      return indexedFailure(
        "additive_create_relative_path_invalid",
        index,
        "relative_path",
      )
    }
    if (createFiles.has(file)) {
      return indexedFailure(
        "additive_create_duplicate",
        index,
        "relative_path",
      )
    }

    planBytes += utf8Bytes(op.content)
    createFiles.add(file)
    changedFiles.add(file)
    mutations.push({
      kind: "create_file",
      file,
      symbol: "<additive>",
      content: op.content,
    })
  }

  if (createFiles.size > ADDITIVE_MAX_CREATE_FILES) {
    return planFailure("additive_create_file_budget")
  }
  if (changedFiles.size > ADDITIVE_MAX_CHANGED_FILES) {
    return planFailure("additive_changed_file_budget")
  }
  if (planBytes > ADDITIVE_MAX_PLAN_BYTES) {
    return planFailure("additive_plan_byte_budget")
  }

  return {
    ok: true,
    protocol: ADDITIVE_MUTATION_PLAN_PROTOCOL,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    capability_sha256: capability.capability_sha256,
    authority_sha256: capability.authority_sha256,
    mutations,
    changed_files: [...changedFiles].sort(),
    operation_count: mutations.length,
    replacement_count: replacements.length,
    creation_count: creations.length,
    plan_bytes: planBytes,

    // The sealed capability/handoff is authority. The model-authored plan is
    // only data inside that authority and must never become an authority root.
    mutation_authority: false,
  }
}

function roleRadius(roles) {
  const set = new Set(array(roles))
  if (set.has("ui_host")) return 12
  if (set.has("task_anchor_owner") || set.has("route_host")) return 8
  if (set.has("navigation_host")) return 8
  return 4
}
function contextAnchorRadius(roles, anchorCount) {
  if (!Number.isSafeInteger(anchorCount) || anchorCount < 1) return null
  const baseRadius = roleRadius(roles)
  const maxLines = 2 * baseRadius + 1
  if (anchorCount > maxLines) return null
  return Math.max(
    0,
    Math.floor((maxLines - anchorCount) / (2 * anchorCount)),
  )
}


function contextPriority(row, mutableFiles, createSource) {
  if (mutableFiles.has(row.file)) return 0
  if (row.file === createSource) return 1
  return 2
}

export async function materializeAdditiveMutationContext({
  root,
  capability,
  maxBytes = ADDITIVE_MODEL_CONTEXT_MAX_BYTES,
} = {}) {
  if (
    typeof root !== "string" ||
    root.length < 1 ||
    capability?.binding_ready !== true ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 256
  ) {
    return {
      ok: false,
      protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
      reason: "additive_context_inputs_invalid",
      content: "",
      bytes: 0,
    }
  }

  const mutableFiles = new Set(array(capability.existing_slots).map((slot) => slot.file))
  const createSource = capability.create_slots?.[0]?.source_file ?? null
  const rows = [...array(capability.context_files)]
    .sort((a, b) =>
      contextPriority(a, mutableFiles, createSource) -
        contextPriority(b, mutableFiles, createSource) ||
      String(a.file).localeCompare(String(b.file)),
    )

  const lines = []
  let used = 0
  let filesShown = 0
  let truncated = false

  for (const row of rows) {
    const file = normalizeFile(row?.file)
    const digest = typeof row?.sha256 === "string" ? row.sha256.toLowerCase() : null
    const evidenceLines = array(row?.evidence_lines)
      .filter((line) => Number.isSafeInteger(line) && line > 0)
      .sort((a, b) => a - b)

    if (!file || !digest || !SHA256_RE.test(digest) || evidenceLines.length < 1) {
      return {
        ok: false,
        protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
        reason: "additive_context_attestation_invalid",
        content: "",
        bytes: 0,
      }
    }

    const absolute = path.resolve(root, file)
    const canonicalRoot = path.resolve(root)
    if (absolute !== canonicalRoot && !absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
      return {
        ok: false,
        protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
        reason: "additive_context_path_escape",
        content: "",
        bytes: 0,
      }
    }

    let source
    try {
      const info = await stat(absolute)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) {
        throw new Error("source budget")
      }
      source = await readFile(absolute)
    } catch {
      return {
        ok: false,
        protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
        reason: "additive_context_source_unavailable",
        content: "",
        bytes: 0,
      }
    }

    const actual = createHash("sha256").update(source).digest("hex")
    if (actual !== digest) {
      return {
        ok: false,
        protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
        reason: "additive_context_source_stale",
        content: "",
        bytes: 0,
      }
    }

    const critical =
      mutableFiles.has(file) || file === createSource
    const anchorRadius =
      contextAnchorRadius(row.roles, evidenceLines.length)
    if (anchorRadius === null) {
      truncated = true
      if (critical) {
        return {
          ok: false,
          protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
          reason: "additive_context_critical_anchor_budget",
          content: "",
          bytes: 0,
        }
      }
      continue
    }
    const excerptByLine = new Map()
    for (const evidenceLine of evidenceLines) {
      const inspection = inspectEvidence({
        request: {
          file,
          line: evidenceLine,
          radius: anchorRadius,
        },
        allowed_files: [{
          file,
          sha256: digest,
          evidence_lines: evidenceLines,
        }],
        source,
      })
      if (inspection?.status !== "OK") {
        return {
          ok: false,
          protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
          reason:
            `additive_context_${inspection?.reason ?? "inspect_abstained"}`,
          content: "",
          bytes: 0,
        }
      }
      for (const item of inspection.excerpt ?? []) {
        if (!Number.isSafeInteger(item?.line) || item.line < 1) continue
        if (!excerptByLine.has(item.line)) {
          excerptByLine.set(item.line, item)
        }
      }
    }
    for (const evidenceLine of evidenceLines) {
      if (!excerptByLine.has(evidenceLine)) {
        return {
          ok: false,
          protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
          reason: "additive_context_anchor_missing",
          content: "",
          bytes: 0,
        }
      }
    }
    const excerpt = [...excerptByLine.values()]
      .sort((a, b) => a.line - b.line)
    const block = [
      `SEALED_CONTEXT file=${file} roles=${array(row.roles).join(",") || "context"} ` +
        `anchors=${evidenceLines.join(",")} anchor_radius=${anchorRadius} ` +
        `sha256=${digest} mutation_authority=false`,
      ...excerpt.map((item) =>
        `${String(item.line).padStart(5)} | ${String(item.text).slice(0, 360)}`,
      ),
    ].join("\n")
    const cost = utf8Bytes(`${lines.length ? "\n\n" : ""}${block}`)

    if (used + cost > maxBytes) {
      truncated = true
      // Mutable targets and the create-source example are mutation-critical.
      if (mutableFiles.has(file) || file === createSource) {
        return {
          ok: false,
          protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
          reason: "additive_context_critical_budget",
          content: "",
          bytes: 0,
        }
      }
      continue
    }

    lines.push(block)
    used += cost
    filesShown += 1
  }

  const content = lines.join("\n\n")
  return {
    ok: true,
    protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
    reason: truncated ? "bounded_context_truncated" : "bounded_context_complete",
    content,
    bytes: utf8Bytes(content),
    files_shown: filesShown,
    truncated,
    context_sha256: stableSha({ capability: capability.capability_sha256, content }),
    mutation_authority: false,
  }
}


function closedAdditiveSlotIds(rows, prefix) {
  const ids = []
  const seen = new Set()
  for (const row of array(rows)) {
    const slot =
      typeof row?.slot === "string" && row.slot.startsWith(prefix)
        ? row.slot
        : null
    if (!slot || seen.has(slot)) return null
    seen.add(slot)
    ids.push(slot)
  }
  return ids.sort()
}

function bindSlotEnum(arraySchema, slotIds) {
  const items = arraySchema?.items
  const properties = items?.properties
  const slot = properties?.slot
  if (
    !arraySchema ||
    typeof arraySchema !== "object" ||
    !items ||
    typeof items !== "object" ||
    !properties ||
    typeof properties !== "object" ||
    !slot ||
    typeof slot !== "object"
  ) {
    return null
  }

  const { enum: _priorEnum, ...slotBase } = slot
  const boundSlot =
    slotIds.length > 0
      ? { ...slotBase, enum: [...slotIds] }
      : slotBase

  return {
    ...arraySchema,
    maxItems: slotIds.length > 0 ? arraySchema.maxItems : 0,
    items: {
      ...items,
      properties: {
        ...properties,
        slot: boundSlot,
      },
    },
  }
}

export function bindAdditiveToolSchemaToCapability(tool, capability) {
  if (
    capability?.protocol !== ADDITIVE_MUTATION_CAPABILITY_PROTOCOL ||
    capability?.ready !== true ||
    capability?.mutation_authority !== true ||
    capability?.operation !== "additive_surface"
  ) {
    return {
      ok: false,
      reason: "additive_schema_capability_not_authorized",
      tool: null,
      mutation_authority: false,
    }
  }

  const existingSlots =
    closedAdditiveSlotIds(capability.existing_slots, "existing:")
  const createSlots =
    closedAdditiveSlotIds(capability.create_slots, "create:")
  if (!existingSlots || !createSlots) {
    return {
      ok: false,
      reason: "additive_schema_slot_identity_invalid",
      tool: null,
      mutation_authority: false,
    }
  }

  const schemaKey =
    tool?.input && typeof tool.input === "object"
      ? "input"
      : tool?.parameters && typeof tool.parameters === "object"
        ? "parameters"
        : null
  if (!schemaKey) {
    return {
      ok: false,
      reason: "additive_schema_shape_invalid",
      tool: null,
      mutation_authority: false,
    }
  }

  const schema = tool[schemaKey]
  const properties = schema?.properties
  const replacements = bindSlotEnum(
    properties?.replacements,
    existingSlots,
  )
  const creations = bindSlotEnum(
    properties?.creations,
    createSlots,
  )
  if (!properties || !replacements || !creations) {
    return {
      ok: false,
      reason: "additive_schema_shape_invalid",
      tool: null,
      mutation_authority: false,
    }
  }

  return {
    ok: true,
    reason: "additive_schema_bound",
    tool: {
      ...tool,
      [schemaKey]: {
        ...schema,
        properties: {
          ...properties,
          replacements,
          creations,
        },
      },
    },
    existing_slots: Object.freeze([...existingSlots]),
    create_slots: Object.freeze([...createSlots]),
    mutation_authority: false,
  }
}

export function renderAdditiveMutationCapability(capability) {
  if (capability?.ready !== true || capability?.mutation_authority !== true) return ""

  const lines = [
    `ADDITIVE_CAPABILITY protocol=${ADDITIVE_MUTATION_CAPABILITY_PROTOCOL} sha256=${capability.capability_sha256}`,
    `MUTATION_ABI protocol=${ADDITIVE_MUTATION_ABI_PROTOCOL} replacements=[] creations=[]`,
    "Use execute_additive_plan only. Existing files and create roots are already sealed. Never submit repository paths, absolute paths, or create-root paths.",
  ]

  for (const slot of capability.existing_slots ?? []) {
    lines.push(
      `slot=${slot.slot} op=replace_exact reuse=allowed_distinct_preimages ` +
        `file=${slot.file} roles=${array(slot.roles).join(",") || "context"} ` +
        `evidence_lines=${slot.evidence_lines.join(",")}`,
    )
  }
  for (const slot of capability.create_slots ?? []) {
    lines.push(
      `slot=${slot.slot} op=create_file relative_path_only=true ` +
        `sealed_root_prefix=canonicalized ` +
        `extensions=${slot.allowed_extensions.join(",")} max_depth=${slot.max_depth}`,
    )
  }

  lines.push(
    `budgets operations<=${ADDITIVE_MAX_OPERATIONS} ` +
      `files<=${ADDITIVE_MAX_CHANGED_FILES} creates<=${ADDITIVE_MAX_CREATE_FILES}`,
  )

  return lines.join("\n")
}
