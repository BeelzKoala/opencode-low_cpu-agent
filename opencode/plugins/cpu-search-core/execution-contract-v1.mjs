import { createHash } from "node:crypto"

export const EXECUTION_CONTRACT_PROTOCOL =
  "additive-execution-contract-projection-v1"
export const EXECUTION_CONTRACT_AUTHORITY = "model_context_only"
export const EXECUTE_ADDITIVE_PLAN_TOOL = "execute_additive_plan"
export const ADDITIVE_PLAN_OPERATION_USAGE_PROTOCOL =
  "additive-plan-operation-usage-v2"
export const ADDITIVE_COVERAGE_FAILURE_PROTOCOL =
  "additive-coverage-failure-ir-v1"

const SHA256_RE = /^[0-9a-f]{64}$/u

function array(value) {
  return Array.isArray(value) ? value : []
}

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")
}

function normalizeFile(value) {
  if (typeof value !== "string") return null
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^file:/, "")
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

function strings(value) {
  return [...new Set(array(value).filter(
    (item) => typeof item === "string" && item.length > 0,
  ))].sort()
}

function lines(value) {
  return [...new Set(array(value).filter(
    (line) => Number.isSafeInteger(line) && line > 0,
  ))].sort((a, b) => a - b)
}

function sha(value) {
  if (typeof value !== "string") return null
  const normalized = value.toLowerCase()
  return SHA256_RE.test(normalized) ? normalized : null
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function normalizeExistingSlot(raw) {
  const slot = typeof raw?.slot === "string" ? raw.slot : null
  const file = normalizeFile(raw?.file)
  const sourceSha = sha(raw?.sha256)
  const evidenceLines = lines(raw?.evidence_lines)
  const roles = strings(raw?.roles)
  const operations = strings(raw?.allowed_operations)
  if (
    !slot ||
    !/^existing:[0-9]+$/u.test(slot) ||
    !file ||
    !sourceSha ||
    evidenceLines.length < 1 ||
    !operations.includes("replace_exact")
  ) {
    return null
  }
  return Object.freeze({
    slot,
    file,
    source_sha256: sourceSha,
    evidence_lines: Object.freeze(evidenceLines),
    roles: Object.freeze(roles),
    allowed_operations: Object.freeze(operations),
  })
}

function normalizeCreateSlot(raw) {
  const slot = typeof raw?.slot === "string" ? raw.slot : null
  const root = normalizeFile(raw?.root)
  const sourceFile = normalizeFile(raw?.source_file)
  const sourceSha = sha(raw?.source_sha256)
  const evidenceLines = lines(raw?.evidence_lines)
  const extensions = strings(raw?.allowed_extensions)
  const operations = strings(raw?.allowed_operations)
  const maxDepth = positiveInteger(raw?.max_depth)
  if (
    !slot ||
    !/^create:[0-9]+$/u.test(slot) ||
    !root ||
    !sourceFile ||
    !sourceSha ||
    evidenceLines.length < 1 ||
    extensions.length < 1 ||
    !maxDepth ||
    !operations.includes("create_file")
  ) {
    return null
  }
  return Object.freeze({
    slot,
    root,
    source_file: sourceFile,
    source_sha256: sourceSha,
    evidence_lines: Object.freeze(evidenceLines),
    allowed_extensions: Object.freeze(extensions),
    max_depth: maxDepth,
    allowed_operations: Object.freeze(operations),
  })
}

function normalizeHostBindings(raw) {
  if (raw == null) return Object.freeze({})
  if (typeof raw !== "object" || Array.isArray(raw)) return null

  const known = new Set([
    "route_owner",
    "navigation_host",
    "ui_create_source",
    "ui_resource",
    "navigation_resource",
    "navigation_topology",
  ])
  const unknown = Object.keys(raw).filter(
    (key) => raw[key] != null && !known.has(key),
  )
  if (unknown.length > 0) return null

  const result = {}
  for (const key of ["route_owner", "navigation_host", "ui_create_source"]) {
    if (raw[key] == null) continue
    const normalized = normalizeFile(raw[key])
    if (!normalized) return null
    result[key] = normalized
  }
  for (const key of ["ui_resource", "navigation_resource"]) {
    if (raw[key] == null) continue
    if (typeof raw[key] !== "string" || raw[key].length < 1) return null
    result[key] = raw[key]
  }

  if (raw.navigation_topology != null) {
    const topology = raw.navigation_topology
    if (typeof topology !== "object" || Array.isArray(topology)) return null
    const resource = typeof topology.resource === "string"
      ? topology.resource
      : null
    const physicalFile = topology.physical_file == null
      ? null
      : normalizeFile(topology.physical_file)
    const sharedIncluders = Number.isSafeInteger(topology.shared_includers)
      ? topology.shared_includers
      : null
    const internalRouteTargets = Number.isSafeInteger(topology.internal_route_targets)
      ? topology.internal_route_targets
      : null
    result.navigation_topology = Object.freeze({
      resource,
      physical_file: physicalFile,
      shared_includers: sharedIncluders,
      internal_route_targets: internalRouteTargets,
    })
  }
  return Object.freeze(result)
}
function failure(reason, extra = {}) {
  return Object.freeze({
    protocol: EXECUTION_CONTRACT_PROTOCOL,
    authority: EXECUTION_CONTRACT_AUTHORITY,
    ok: false,
    status: "abstained",
    reason,
    execution_contract_coverage_complete: false,
    routing_authority: false,
    mutation_authority: false,
    verification_authority: false,
    ...extra,
  })
}

function visibleExistingLine(slot) {
  const roles = slot.roles.length > 0 ? slot.roles.join(",") : "context"
  return (
    `SLOT ${slot.slot} op=replace_exact file=${slot.file} ` +
    `roles=${roles} anchors=${slot.evidence_lines.join(",")}`
  )
}

function visibleCreateLine(slot) {
  return (
    `SLOT ${slot.slot} op=create_file source=${slot.source_file} ` +
    `extensions=${slot.allowed_extensions.join(",")} ` +
    `max_depth=${slot.max_depth} path=relative_to_sealed_root ` +
    `anchors=${slot.evidence_lines.join(",")}`
  )
}

export function projectAdditiveExecutionContract(capability) {
  if (
    capability?.ready !== true ||
    capability?.binding_ready !== true ||
    capability?.mutation_authority !== true ||
    capability?.operation !== "additive_surface"
  ) {
    return failure("authorized_additive_capability_unavailable")
  }

  const capabilitySha = sha(capability?.capability_sha256)
  const authoritySha = sha(capability?.authority_sha256)
  if (!capabilitySha || !authoritySha) {
    return failure("execution_contract_authority_identity_invalid")
  }

  const existing = array(capability?.existing_slots)
    .map(normalizeExistingSlot)
  const creates = array(capability?.create_slots)
    .map(normalizeCreateSlot)
  if (
    existing.some((row) => row === null) ||
    creates.some((row) => row === null) ||
    existing.length + creates.length < 1
  ) {
    return failure("execution_contract_slot_invalid")
  }
  existing.sort((a, b) => a.slot.localeCompare(b.slot))
  creates.sort((a, b) => a.slot.localeCompare(b.slot))

  const slotIds = [...existing, ...creates].map((row) => row.slot)
  if (new Set(slotIds).size !== slotIds.length) {
    return failure("execution_contract_slot_duplicate")
  }

  const hostBindings = normalizeHostBindings(capability?.host_bindings)
  if (!hostBindings) {
    return failure("execution_contract_host_binding_invalid")
  }

  const budgets = Object.freeze({
    max_operations: positiveInteger(capability?.budgets?.max_operations),
    max_changed_files: positiveInteger(capability?.budgets?.max_changed_files),
    max_create_files: positiveInteger(capability?.budgets?.max_create_files),
    max_plan_bytes: positiveInteger(capability?.budgets?.max_plan_bytes),
  })
  if (Object.values(budgets).some((value) => value === null)) {
    return failure("execution_contract_budget_invalid")
  }

  const visible = Object.freeze({
    tool: EXECUTE_ADDITIVE_PLAN_TOOL,
    operation: "additive_surface",
    host_bindings: hostBindings,
    existing_slots: Object.freeze(existing.map((row) => Object.freeze({
      slot: row.slot,
      file: row.file,
      evidence_lines: row.evidence_lines,
      roles: row.roles,
      operation: "replace_exact",
    }))),
    create_slots: Object.freeze(creates.map((row) => Object.freeze({
      slot: row.slot,
      source_file: row.source_file,
      evidence_lines: row.evidence_lines,
      allowed_extensions: row.allowed_extensions,
      max_depth: row.max_depth,
      operation: "create_file",
      path_contract: "relative_to_sealed_root",
    }))),
    budgets: Object.freeze({
      max_operations: budgets.max_operations,
      max_changed_files: budgets.max_changed_files,
      max_create_files: budgets.max_create_files,
    }),
  })

  const machineEnforced = Object.freeze({
    capability_sha256: capabilitySha,
    authority_sha256: authoritySha,
    existing_preconditions: Object.freeze(existing.map((row) => Object.freeze({
      slot: row.slot,
      file: row.file,
      source_sha256: row.source_sha256,
      allowed_operations: row.allowed_operations,
    }))),
    create_preconditions: Object.freeze(creates.map((row) => Object.freeze({
      slot: row.slot,
      root: row.root,
      source_file: row.source_file,
      source_sha256: row.source_sha256,
      allowed_operations: row.allowed_operations,
    }))),
    max_plan_bytes: budgets.max_plan_bytes,
  })

  const visibleSha = stableSha(visible)
  const machineEnforcedSha = stableSha(machineEnforced)
  const contractSha = stableSha({
    protocol: EXECUTION_CONTRACT_PROTOCOL,
    visible_sha256: visibleSha,
    machine_enforced_sha256: machineEnforcedSha,
  })

  const hostParts = Object.entries(hostBindings)
    .filter(([key]) => key !== "navigation_topology")
    .map(([key, value]) => `${key}=${value}`)
  if (hostBindings.navigation_topology) {
    const topology = hostBindings.navigation_topology
    hostParts.push(
      `navigation_topology=${[
        topology.resource,
        topology.physical_file,
        topology.shared_includers,
        topology.internal_route_targets,
      ].filter((value) => value != null).join("|")}`,
    )
  }
  const lines = [
    `EXECUTION_CONTRACT protocol=${EXECUTION_CONTRACT_PROTOCOL} tool=${EXECUTE_ADDITIVE_PLAN_TOOL}`,
    ...(hostParts.length > 0 ? [`HOST ${hostParts.join(" ")}`] : []),
    ...existing.map(visibleExistingLine),
    ...creates.map(visibleCreateLine),
    `LIMIT operations<=${budgets.max_operations} files<=${budgets.max_changed_files} creates<=${budgets.max_create_files}`,
    "AUTHORITY routing=false mutation=false verification=false",
  ]

  return Object.freeze({
    protocol: EXECUTION_CONTRACT_PROTOCOL,
    authority: EXECUTION_CONTRACT_AUTHORITY,
    status: "projected",
    ok: true,
    reason: "execution_contract_semantics_covered",
    content: lines.join("\n"),
    visible,
    machine_enforced: machineEnforced,
    visible_sha256: visibleSha,
    machine_enforced_sha256: machineEnforcedSha,
    contract_sha256: contractSha,
    semantic_contract_sha256: visibleSha,
    authority_instance_sha256: authoritySha,
    execution_instance_sha256: contractSha,
    capability_sha256: capabilitySha,
    authority_sha256: authoritySha,
    execution_contract_coverage_complete: true,
    routing_authority: false,
    mutation_authority: false,
    verification_authority: false,
  })
}

function sortedIntersection(values, allowed) {
  const allowedSet = new Set(allowed)
  return [...new Set(values.filter((value) => allowedSet.has(value)))].sort()
}

const MODEL_OPERATION_FAMILIES = Object.freeze([
  Object.freeze({
    request_key: "python_imports",
    operation: "python_import",
    slot_kind: "existing",
    bit: 1n << 0n,
  }),
  Object.freeze({
    request_key: "python_declarations",
    operation: "python_declaration",
    slot_kind: "existing",
    bit: 1n << 1n,
  }),
  Object.freeze({
    request_key: "replacements",
    operation: "replacement",
    slot_kind: "existing",
    bit: 1n << 2n,
  }),
  Object.freeze({
    request_key: "creations",
    operation: "creation",
    slot_kind: "create",
    bit: 1n << 3n,
  }),
])

const MODEL_OPERATION_BY_NAME = new Map(
  MODEL_OPERATION_FAMILIES.map((row) => [row.operation, row]),
)

function operationMaskHex(mask) {
  return `0x${mask.toString(16)}`
}

function requestOperationRows(request, family) {
  return array(request?.[family.request_key])
    .map((row) => ({
      slot: typeof row?.slot === "string" ? row.slot : null,
      operation: family.operation,
      bit: family.bit,
      slot_kind: family.slot_kind,
    }))
    .filter((row) => row.slot)
}

function operationUsageBySlot(request) {
  const rows = MODEL_OPERATION_FAMILIES.flatMap(
    (family) => requestOperationRows(request, family),
  )
  const bySlot = new Map()
  for (const row of rows) {
    const prior = bySlot.get(row.slot) ?? {
      slot: row.slot,
      mask: 0n,
      operations: new Set(),
    }
    prior.mask |= row.bit
    prior.operations.add(row.operation)
    bySlot.set(row.slot, prior)
  }
  return [...bySlot.values()]
    .map((row) => Object.freeze({
      slot: row.slot,
      operation_mask: operationMaskHex(row.mask),
      operations: Object.freeze([...row.operations].sort()),
    }))
    .sort((a, b) => a.slot.localeCompare(b.slot))
}

export function observeAdditivePlanSlotUsage({ capability, request } = {}) {
  const contract = projectAdditiveExecutionContract(capability)
  if (!contract.ok) {
    return Object.freeze({
      protocol: ADDITIVE_PLAN_OPERATION_USAGE_PROTOCOL,
      legacy_protocol: "additive-plan-slot-usage-v1",
      ok: false,
      reason: contract.reason,
      observation_only: true,
    })
  }

  const availableExisting = contract.visible.existing_slots.map((row) => row.slot)
  const availableCreate = contract.visible.create_slots.map((row) => row.slot)
  const availableExistingSet = new Set(availableExisting)
  const availableCreateSet = new Set(availableCreate)
  const operationUsage = operationUsageBySlot(request)
  const rawExisting = operationUsage
    .filter((row) => row.slot.startsWith("existing:"))
    .map((row) => row.slot)
  const rawCreate = operationUsage
    .filter((row) => row.slot.startsWith("create:"))
    .map((row) => row.slot)
  const submittedExisting = sortedIntersection(rawExisting, availableExisting)
  const submittedCreate = sortedIntersection(rawCreate, availableCreate)

  return Object.freeze({
    protocol: ADDITIVE_PLAN_OPERATION_USAGE_PROTOCOL,
    legacy_protocol: "additive-plan-slot-usage-v1",
    ok: true,
    reason: "operation_usage_observed",
    observation_only: true,
    available_existing_slots: Object.freeze([...availableExisting]),
    submitted_existing_slots: Object.freeze(submittedExisting),
    unused_existing_slots: Object.freeze(
      availableExisting.filter((slot) => !submittedExisting.includes(slot)),
    ),
    unknown_existing_slots: Object.freeze(
      [...new Set(rawExisting.filter((slot) => !availableExistingSet.has(slot)))].sort(),
    ),
    available_create_slots: Object.freeze([...availableCreate]),
    submitted_create_slots: Object.freeze(submittedCreate),
    unused_create_slots: Object.freeze(
      availableCreate.filter((slot) => !submittedCreate.includes(slot)),
    ),
    unknown_create_slots: Object.freeze(
      [...new Set(rawCreate.filter((slot) => !availableCreateSet.has(slot)))].sort(),
    ),
    operations_by_slot: Object.freeze(operationUsage),
    submitted_operation_mask: operationMaskHex(
      operationUsage.reduce(
        (mask, row) => {
          let next = mask
          for (const operation of row.operations) {
            next |= MODEL_OPERATION_BY_NAME.get(operation)?.bit ?? 0n
          }
          return next
        },
        0n,
      ),
    ),
  })
}

const DIAGNOSTIC_ARRAY_FIELDS = Object.freeze([
  "required_roles",
  "covered_roles",
  "missing_roles",
  "required_slots",
  "covered_slots",
  "missing_slots",
  "missing_existing_slots",
  "missing_create_slots",
  "required_obligations",
  "covered_obligations",
  "missing_obligations",
])

function coverageFailureAllowedSlots(contract) {
  if (contract?.ok !== true) return new Set()
  return new Set([
    ...contract.visible.existing_slots.map((row) => row.slot),
    ...contract.visible.create_slots.map((row) => row.slot),
  ])
}

function normalizeMissingOperation(row, allowedSlots) {
  const obligation =
    typeof row?.obligation === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/u.test(row.obligation)
      ? row.obligation
      : null
  const slot =
    typeof row?.slot === "string" && allowedSlots.has(row.slot)
      ? row.slot
      : null
  const operation =
    typeof row?.operation === "string" &&
    MODEL_OPERATION_BY_NAME.has(row.operation)
      ? row.operation
      : null
  if (!obligation || !slot || !operation) return null

  const family = MODEL_OPERATION_BY_NAME.get(operation)
  if (
    (family.slot_kind === "existing" && !slot.startsWith("existing:")) ||
    (family.slot_kind === "create" && !slot.startsWith("create:"))
  ) {
    return null
  }

  return Object.freeze({ obligation, slot, operation })
}

function normalizeMissingRows(rows, allowedSlots) {
  if (!Array.isArray(rows) || rows.length < 1) return null
  const normalized = rows.map(
    (row) => normalizeMissingOperation(row, allowedSlots),
  )
  if (normalized.some((row) => row === null)) return null
  const dedup = new Map()
  for (const row of normalized) {
    dedup.set(`${row.obligation}\0${row.slot}\0${row.operation}`, row)
  }
  return [...dedup.values()].sort(
    (a, b) =>
      a.obligation.localeCompare(b.obligation) ||
      a.slot.localeCompare(b.slot) ||
      a.operation.localeCompare(b.operation),
  )
}

function legacyCoverageMissingRows(failure, allowedSlots) {
  const detail = typeof failure?.detail === "string"
    ? failure.detail
    : null
  if (!detail) return null
  const match = detail.match(/(?:^|\s)missing=([^\s]+)/u)
  if (!match?.[1]) return null
  const rows = []
  for (const token of match[1].split(",")) {
    const parsed = token.match(
      /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,119})@((?:existing|create):[0-9]+):([A-Za-z0-9_]+)$/u,
    )
    if (!parsed) return null
    rows.push({
      obligation: parsed[1],
      slot: parsed[2],
      operation: parsed[3],
    })
  }
  return normalizeMissingRows(rows, allowedSlots)
}

export function normalizeAdditiveCoverageFailure({
  failure,
  capability,
  contract: suppliedContract = null,
} = {}) {
  const contract =
    suppliedContract?.ok === true
      ? suppliedContract
      : projectAdditiveExecutionContract(capability)
  if (contract?.ok !== true) return null
  const allowedSlots = coverageFailureAllowedSlots(contract)

  const structuredSources = [
    failure?.coverage_failure?.missing,
    failure?.failure_ir?.missing,
    failure?.coverage?.failure_ir?.missing,
    failure?.coverage?.missing_operations,
  ]
  let missing = null
  let source = null
  for (const rows of structuredSources) {
    if (!Array.isArray(rows) || rows.length < 1) continue
    missing = normalizeMissingRows(rows, allowedSlots)
    if (!missing) return null
    source = "structured_validator"
    break
  }

  if (!missing && failure?.reason === "additive_plan_coverage_incomplete") {
    missing = legacyCoverageMissingRows(failure, allowedSlots)
    if (missing) source = "legacy_detail_projection"
  }
  if (!missing || missing.length < 1) return null

  let mask = 0n
  for (const row of missing) {
    mask |= MODEL_OPERATION_BY_NAME.get(row.operation)?.bit ?? 0n
  }
  const payload = {
    protocol: ADDITIVE_COVERAGE_FAILURE_PROTOCOL,
    reason:
      typeof failure?.reason === "string"
        ? failure.reason
        : "additive_plan_coverage_incomplete",
    source,
    missing: Object.freeze(missing),
    missing_slots: Object.freeze(
      [...new Set(missing.map((row) => row.slot))].sort(),
    ),
    missing_obligations: Object.freeze(
      [...new Set(missing.map((row) => row.obligation))].sort(),
    ),
    missing_operation_mask: operationMaskHex(mask),
    mutation_authority: false,
  }
  return Object.freeze({
    ...payload,
    failure_sha256: stableSha(payload),
  })
}

export function extractAdditiveFailureDiagnostics(
  failure,
  { capability = null, contract = null } = {},
) {
  const sources = [failure, failure?.coverage]
  const diagnostics = {}
  for (const field of DIAGNOSTIC_ARRAY_FIELDS) {
    for (const source of sources) {
      const values = strings(source?.[field])
      if (values.length > 0) {
        diagnostics[field] = Object.freeze(values)
        break
      }
    }
  }
  const explicitSlot = typeof failure?.slot === "string"
    ? failure.slot
    : typeof failure?.coverage?.slot === "string"
      ? failure.coverage.slot
      : null
  if (explicitSlot) diagnostics.slot = explicitSlot

  const coverageFailure = normalizeAdditiveCoverageFailure({
    failure,
    capability,
    contract,
  })
  if (coverageFailure) {
    diagnostics.missing_slots = coverageFailure.missing_slots
    diagnostics.missing_obligations = coverageFailure.missing_obligations
    diagnostics.coverage_failure_sha256 = coverageFailure.failure_sha256
    diagnostics.coverage_failure_source = coverageFailure.source
  }
  return Object.freeze(diagnostics)
}

export function repairTargetSlots({ contract, hint } = {}) {
  if (contract?.ok !== true) {
    return Object.freeze({
      slots: Object.freeze([]),
      reason: "execution_contract_unavailable",
      observation_only: true,
    })
  }
  const allowed = new Set([
    ...contract.visible.existing_slots.map((row) => row.slot),
    ...contract.visible.create_slots.map((row) => row.slot),
  ])

  const coverageFailure = hint?.coverage_failure
  if (
    coverageFailure?.protocol === ADDITIVE_COVERAGE_FAILURE_PROTOCOL &&
    Array.isArray(coverageFailure?.missing)
  ) {
    const slots = coverageFailure.missing
      .map((row) => typeof row?.slot === "string" ? row.slot : null)
      .filter((slot) => slot && allowed.has(slot))
    if (slots.length > 0) {
      return Object.freeze({
        slots: Object.freeze([...new Set(slots)].sort()),
        reason: "coverage_failure_ir",
        observation_only: false,
      })
    }
  }

  const diagnostics = hint?.failure_diagnostics ?? {}
  const explicit = [
    ...strings(diagnostics.missing_slots),
    ...strings(diagnostics.missing_existing_slots),
    ...strings(diagnostics.missing_create_slots),
    ...(typeof diagnostics.slot === "string" ? [diagnostics.slot] : []),
  ].filter((slot) => allowed.has(slot))
  if (explicit.length > 0) {
    return Object.freeze({
      slots: Object.freeze([...new Set(explicit)].sort()),
      reason: "validator_failure_diagnostics",
      observation_only: false,
    })
  }

  if (hint?.reason === "additive_plan_coverage_incomplete") {
    const usage = hint?.slot_usage ?? {}
    const unused = [
      ...strings(usage.unused_existing_slots),
      ...strings(usage.unused_create_slots),
    ].filter((slot) => allowed.has(slot))
    if (unused.length > 0) {
      return Object.freeze({
        slots: Object.freeze([...new Set(unused)].sort()),
        reason: "unused_slot_observation",
        observation_only: true,
      })
    }
  }

  return Object.freeze({
    slots: Object.freeze([...allowed].sort()),
    reason: "full_contract_fallback",
    observation_only: true,
  })
}
