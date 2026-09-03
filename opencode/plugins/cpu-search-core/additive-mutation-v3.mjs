import * as legacy from "./additive-mutation-v1.mjs"
import * as v2 from "./additive-mutation-v2.mjs"

import {
  CANDIDATE_STATIC_PREFLIGHT_PROTOCOL,
  PYTHON_ADDITIVE_COMPILER_PROTOCOL,
  compilePythonAdditiveEdits,
} from "./python-additive-compiler-v1.mjs"

export * from "./additive-mutation-v2.mjs"

export const ADDITIVE_MUTATION_ABI_PROTOCOL =
  "closed-additive-mutation-abi-v3"
export const ADDITIVE_SEMANTIC_LOWERING_PROTOCOL =
  "additive-semantic-lowering-authority-v1"

const DOTTED_IDENTIFIER_RE =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

function array(value) {
  return Array.isArray(value) ? value : []
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

function fail(reason, detail = null, extra = {}) {
  return {
    ok: false,
    protocol: legacy.ADDITIVE_MUTATION_PLAN_PROTOCOL,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    compiler_protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    reason,
    detail,
    repairable: false,
    mutations: [],
    mutation_authority: false,
    ...extra,
  }
}

export const MUTATION_OBLIGATION_PROTOCOL = "mutation-obligation-v1"
export const MUTATION_PLAN_COVERAGE_PROTOCOL = "mutation-plan-coverage-v1"
export const MUTATION_OBLIGATION_BINDING_PROTOCOL =
  "sealed-additive-handoff-v1"

function obligationContractMode(capability) {
  // Low-level/compiler fixtures intentionally do not carry host integration
  // bindings. Coverage is a model-facing host-bound contract, not a compiler
  // precondition.
  if (capability?.binding_ready !== true) return "not_applicable"
  if (
    capability?.authority_protocol !==
      MUTATION_OBLIGATION_BINDING_PROTOCOL
  ) {
    return "invalid_authority"
  }
  return "required"
}

const ADDITIVE_OBLIGATION_SPECS = Object.freeze([
  Object.freeze({
    id: "server_surface",
    binding: "route_owner",
    target_kind: "existing",
    required: true,
  }),
  Object.freeze({
    id: "navigation_integration",
    binding: "navigation_host",
    target_kind: "existing",
    required: false,
  }),
  Object.freeze({
    id: "ui_surface",
    binding: "ui_create_source",
    target_kind: "create",
    required: true,
  }),
])

function normalizeObligationFile(value) {
  if (typeof value !== "string") return null
  const normalized = value
    .replaceAll("\\\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^file:/, "")
  if (
    normalized.length < 1 ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null
  }
  return normalized
}

function exactExistingSlotForFile(capability, file) {
  const normalized = normalizeObligationFile(file)
  if (!normalized) return { ok: false, matches: [] }
  const matches = array(capability?.existing_slots)
    .filter((row) => normalizeObligationFile(row?.file) === normalized)
    .filter((row) => typeof row?.slot === "string" && row.slot.length > 0)
    .sort((a, b) => a.slot.localeCompare(b.slot))
  return {
    ok: matches.length === 1,
    matches,
  }
}

function exactCreateSlotForSource(capability, file) {
  const normalized = normalizeObligationFile(file)
  if (!normalized) return { ok: false, matches: [] }
  const matches = array(capability?.create_slots)
    .filter((row) => normalizeObligationFile(row?.source_file) === normalized)
    .filter((row) => typeof row?.slot === "string" && row.slot.length > 0)
    .sort((a, b) => a.slot.localeCompare(b.slot))
  return {
    ok: matches.length === 1,
    matches,
  }
}

function obligationFailure(reason, detail = null, extra = {}) {
  return fail(reason, detail, {
    obligation_protocol: MUTATION_OBLIGATION_PROTOCOL,
    coverage_protocol: MUTATION_PLAN_COVERAGE_PROTOCOL,
    ...extra,
  })
}

function expectedOperationClass(targetKind, targetFile) {
  if (targetKind === "create") return "creation"
  return /\.(?:py|pyi)$/u.test(targetFile)
    ? "python_declaration"
    : "replacement"
}

export function deriveAdditiveMutationObligations(capability) {
  if (
    capability?.ready !== true ||
    capability?.mutation_authority !== true
  ) {
    return obligationFailure(
      "additive_obligation_capability_not_authorized",
      "capability_not_authorized",
    )
  }

  const contractMode = obligationContractMode(capability)
  if (contractMode === "not_applicable") {
    return Object.freeze({
      ok: true,
      protocol: MUTATION_OBLIGATION_PROTOCOL,
      reason: "additive_obligations_not_applicable",
      applicable: false,
      obligations: Object.freeze([]),
      mutation_authority: false,
    })
  }
  if (contractMode !== "required") {
    return obligationFailure(
      "additive_obligation_contract_unresolved",
      `binding_authority=${String(capability?.authority_protocol ?? null)}`,
      { obligation_contract_mode: contractMode },
    )
  }

  const bindings =
    capability?.host_bindings &&
    typeof capability.host_bindings === "object" &&
    !Array.isArray(capability.host_bindings)
      ? capability.host_bindings
      : null
  if (!bindings) {
    return obligationFailure(
      "additive_obligation_contract_unresolved",
      "host_bindings_missing",
    )
  }

  const obligations = []
  for (const spec of ADDITIVE_OBLIGATION_SPECS) {
    const rawFile = bindings[spec.binding]
    if (rawFile === null || rawFile === undefined) {
      if (!spec.required) continue
      return obligationFailure(
        "additive_obligation_contract_unresolved",
        `binding=${spec.binding}:missing`,
        { unresolved_binding: spec.binding },
      )
    }

    const file = normalizeObligationFile(rawFile)
    if (!file) {
      return obligationFailure(
        "additive_obligation_contract_unresolved",
        `binding=${spec.binding}:invalid_file`,
        { unresolved_binding: spec.binding },
      )
    }

    const resolved =
      spec.target_kind === "existing"
        ? exactExistingSlotForFile(capability, file)
        : exactCreateSlotForSource(capability, file)
    if (!resolved.ok) {
      return obligationFailure(
        "additive_obligation_contract_unresolved",
        `binding=${spec.binding}:slot_matches=${resolved.matches.length}`,
        {
          unresolved_binding: spec.binding,
          binding_file: file,
          slot_matches: Object.freeze(
            resolved.matches.map((row) => row.slot),
          ),
        },
      )
    }

    const target = resolved.matches[0]
    obligations.push(Object.freeze({
      id: spec.id,
      binding: spec.binding,
      target_kind: spec.target_kind,
      slot: target.slot,
      file,
      operation_class: expectedOperationClass(spec.target_kind, file),
      support_operations_satisfy: false,
    }))
  }

  return Object.freeze({
    ok: true,
    protocol: MUTATION_OBLIGATION_PROTOCOL,
    reason: "additive_obligations_compiled",
    applicable: true,
    obligations: Object.freeze(obligations),
    mutation_authority: false,
  })
}

function pythonDeclarationIsSubstantive(row) {
  if (
    typeof row?.slot !== "string" ||
    typeof row?.content !== "string"
  ) {
    return false
  }
  return /(?:^|\n)(?:[ \t]*@[^\n]+\n)*[ \t]*(?:async[ \t]+def|def|class)[ \t]+[A-Za-z_][A-Za-z0-9_]*/u
    .test(row.content)
}

function substantiveOperationIndex(request) {
  const pythonDeclarations = new Set()
  const replacements = new Set()
  const creations = new Set()

  for (const row of array(request?.python_declarations)) {
    if (pythonDeclarationIsSubstantive(row)) {
      pythonDeclarations.add(row.slot)
    }
  }

  for (const row of array(request?.replacements)) {
    if (
      typeof row?.slot === "string" &&
      typeof row?.before === "string" &&
      row.before.length > 0 &&
      typeof row?.replacement === "string" &&
      row.before !== row.replacement
    ) {
      replacements.add(row.slot)
    }
  }

  for (const row of array(request?.creations)) {
    if (
      typeof row?.slot === "string" &&
      typeof row?.relative_path === "string" &&
      row.relative_path.length > 0 &&
      typeof row?.content === "string" &&
      row.content.length > 0
    ) {
      creations.add(row.slot)
    }
  }

  return { pythonDeclarations, replacements, creations }
}

function operationSatisfies(obligation, index) {
  if (obligation.operation_class === "python_declaration") {
    return index.pythonDeclarations.has(obligation.slot)
  }
  if (obligation.operation_class === "replacement") {
    return index.replacements.has(obligation.slot)
  }
  if (obligation.operation_class === "creation") {
    return index.creations.has(obligation.slot)
  }
  return false
}

export function validateAdditivePlanCoverage({ capability, request } = {}) {
  const compiled = deriveAdditiveMutationObligations(capability)
  if (compiled.ok !== true) return compiled

  const index = substantiveOperationIndex(request)
  const missing = compiled.obligations
    .filter((obligation) => !operationSatisfies(obligation, index))
    .map((obligation) => Object.freeze({
      id: obligation.id,
      slot: obligation.slot,
      operation_class: obligation.operation_class,
    }))

  if (missing.length > 0) {
    return obligationFailure(
      "additive_plan_coverage_incomplete",
      "missing=" + missing
        .map((row) => `${row.id}@${row.slot}:${row.operation_class}`)
        .join(","),
      {
        repairable: true,
        required_obligation_count: compiled.obligations.length,
        satisfied_obligation_count:
          compiled.obligations.length - missing.length,
        missing_obligations: Object.freeze(missing),
      },
    )
  }

  return Object.freeze({
    ok: true,
    protocol: MUTATION_PLAN_COVERAGE_PROTOCOL,
    reason:
      compiled.applicable === true
        ? "required_mutation_coverage_complete"
        : "mutation_obligation_coverage_not_applicable",
    applicable: compiled.applicable === true,
    obligation_protocol: MUTATION_OBLIGATION_PROTOCOL,
    required_obligation_count: compiled.obligations.length,
    satisfied_obligation_count: compiled.obligations.length,
    missing_obligations: Object.freeze([]),
    mutation_authority: false,
  })
}

export function renderAdditiveMutationObligationProjection(capability) {
  const compiled = deriveAdditiveMutationObligations(capability)
  if (compiled.ok !== true || compiled.obligations.length < 1) return ""
  const required = compiled.obligations
    .map((row) => `${row.id}@${row.slot}:${row.operation_class}`)
    .join(" ")
  return (
    `REQUIRED_MUTATION_COVERAGE protocol=${MUTATION_OBLIGATION_PROTOCOL} ` +
    `${required} python_imports=support_only all_required=true`
  )
}

function indexedFailure(reason, index, field = null) {
  return fail(reason, String(index), {
    operation_index: index,
    field,
  })
}

function isPythonTarget(target) {
  return typeof target?.file === "string" && /\.(?:py|pyi)$/u.test(target.file)
}

function semanticLoweringFailure(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: ADDITIVE_SEMANTIC_LOWERING_PROTOCOL,
    reason,
    ...extra,
    supports_python_imports: false,
    mutation_authority: false,
    authority_expansion: false,
    model_authority_expansion: false,
  })
}

export function proveAdditiveSemanticLoweringAuthority({
  capability,
  operation,
} = {}) {
  if (
    capability?.ready !== true ||
    capability?.mutation_authority !== true
  ) {
    return semanticLoweringFailure(
      "semantic_lowering_capability_not_authorized",
    )
  }

  const semanticOperation =
    typeof operation?.kind === "string"
      ? operation.kind
      : null
  const slot =
    typeof operation?.slot === "string"
      ? operation.slot
      : null

  if (!semanticOperation || !slot) {
    return semanticLoweringFailure(
      "semantic_lowering_operation_invalid",
      {
        semantic_operation: semanticOperation,
        slot,
      },
    )
  }

  const collection =
    semanticOperation === "creation"
      ? capability?.create_slots
      : capability?.existing_slots

  const candidates = array(collection)
    .filter((row) => row?.slot === slot)

  if (candidates.length !== 1) {
    return semanticLoweringFailure(
      "semantic_lowering_slot_unresolved",
      {
        semantic_operation: semanticOperation,
        slot,
        slot_matches: candidates.length,
      },
    )
  }

  const target = candidates[0]
  let physicalOperation = null
  let loweringProtocol = null
  let supportsPythonImports = false

  if (semanticOperation === "python_declaration") {
    if (!isPythonTarget(target)) {
      return semanticLoweringFailure(
        "semantic_lowering_python_target_invalid",
        {
          semantic_operation: semanticOperation,
          slot,
        },
      )
    }
    physicalOperation = "replace_exact"
    loweringProtocol = PYTHON_ADDITIVE_COMPILER_PROTOCOL
    supportsPythonImports = true
  } else if (semanticOperation === "replacement") {
    if (isPythonTarget(target)) {
      return semanticLoweringFailure(
        "semantic_lowering_python_replacement_forbidden",
        {
          semantic_operation: semanticOperation,
          slot,
        },
      )
    }
    physicalOperation = "replace_exact"
    loweringProtocol = "identity"
  } else if (semanticOperation === "creation") {
    physicalOperation = "create_file"
    loweringProtocol = "identity"
  } else {
    return semanticLoweringFailure(
      "semantic_lowering_operation_unsupported",
      {
        semantic_operation: semanticOperation,
        slot,
      },
    )
  }

  const allowed = array(target?.allowed_operations)
  if (!allowed.includes(physicalOperation)) {
    return semanticLoweringFailure(
      "semantic_lowering_physical_authority_missing",
      {
        semantic_operation: semanticOperation,
        physical_operation: physicalOperation,
        lowering_protocol: loweringProtocol,
        slot,
        capability_sha256:
          capability?.capability_sha256 ?? null,
        authority_sha256:
          capability?.authority_sha256 ?? null,
      },
    )
  }

  return Object.freeze({
    ok: true,
    protocol: ADDITIVE_SEMANTIC_LOWERING_PROTOCOL,
    reason: "semantic_lowering_authority_proven",
    semantic_operation: semanticOperation,
    physical_operation: physicalOperation,
    lowering_protocol: loweringProtocol,
    slot,
    supports_python_imports: supportsPythonImports,
    capability_sha256:
      capability?.capability_sha256 ?? null,
    authority_sha256:
      capability?.authority_sha256 ?? null,
    mutation_authority: false,
    authority_expansion: false,
    model_authority_expansion: false,
  })
}

function closedSlotIds(rows, prefix, predicate = () => true) {
  if (!Array.isArray(rows)) return null
  const ids = []
  const seen = new Set()
  for (const row of rows) {
    if (!predicate(row)) continue
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
  return {
    ...arraySchema,
    maxItems: slotIds.length > 0 ? arraySchema.maxItems : 0,
    items: {
      ...items,
      properties: {
        ...properties,
        slot:
          slotIds.length > 0
            ? { ...slotBase, enum: [...slotIds] }
            : slotBase,
      },
    },
  }
}

function validatePythonImportOps(ops) {
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]
    if (!exactKeys(op, ["slot", "modules", "from_imports"])) {
      return indexedFailure("python_import_shape_invalid", index, "python_import")
    }
    if (
      typeof op.slot !== "string" ||
      op.slot.length < 1 ||
      op.slot.length > 64
    ) {
      return indexedFailure("python_import_slot_invalid", index, "slot")
    }
    if (!Array.isArray(op.modules) || !Array.isArray(op.from_imports)) {
      return indexedFailure("python_import_arrays_invalid", index, "python_import")
    }
    if (
      op.modules.length > legacy.ADDITIVE_MAX_OPERATIONS ||
      op.from_imports.length > legacy.ADDITIVE_MAX_OPERATIONS
    ) {
      return indexedFailure("python_import_atom_budget", index, "python_import")
    }
    for (const module of op.modules) {
      if (
        typeof module !== "string" ||
        !DOTTED_IDENTIFIER_RE.test(module)
      ) {
        return indexedFailure("python_import_module_invalid", index, "modules")
      }
    }
    for (const row of op.from_imports) {
      if (
        !exactKeys(row, ["module", "name"]) ||
        typeof row.module !== "string" ||
        !DOTTED_IDENTIFIER_RE.test(row.module) ||
        typeof row.name !== "string" ||
        !IDENTIFIER_RE.test(row.name)
      ) {
        return indexedFailure(
          "python_from_import_invalid",
          index,
          "from_imports",
        )
      }
    }
  }
  return { ok: true }
}

function validatePythonDeclarationOps(ops) {
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]
    if (!exactKeys(op, ["slot", "content"])) {
      return indexedFailure(
        "python_declaration_shape_invalid",
        index,
        "python_declaration",
      )
    }
    if (
      typeof op.slot !== "string" ||
      op.slot.length < 1 ||
      op.slot.length > 64
    ) {
      return indexedFailure("python_declaration_slot_invalid", index, "slot")
    }
    if (
      typeof op.content !== "string" ||
      op.content.length < 1 ||
      op.content.includes("\0") ||
      Buffer.byteLength(op.content, "utf8") >
        legacy.ADDITIVE_MAX_REPLACE_BYTES
    ) {
      return indexedFailure(
        "python_declaration_content_invalid",
        index,
        "content",
      )
    }
  }
  return { ok: true }
}

export function validateAdditiveMutationRequest(request) {
  const topLevel = [
    "python_imports",
    "python_declarations",
    "replacements",
    "creations",
  ]
  if (!exactKeys(request, topLevel)) {
    return fail("additive_request_shape_invalid")
  }

  for (const key of topLevel) {
    if (!Array.isArray(request[key])) {
      return fail(`additive_${key}_array_invalid`)
    }
  }

  const operationCount =
    request.python_imports.length +
    request.python_declarations.length +
    request.replacements.length +
    request.creations.length

  if (operationCount > legacy.ADDITIVE_MAX_OPERATIONS) {
    return fail("additive_operation_count_invalid")
  }

  const imports = validatePythonImportOps(request.python_imports)
  if (imports.ok !== true) return imports

  const declarations = validatePythonDeclarationOps(
    request.python_declarations,
  )
  if (declarations.ok !== true) return declarations

  const legacyShape = legacy.validateAdditiveMutationRequest({
    replacements: request.replacements,
    creations: request.creations,
  })
  if (legacyShape.ok !== true) {
    return {
      ...legacyShape,
      abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
      compiler_protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    }
  }

  return {
    ok: true,
    protocol: legacy.ADDITIVE_MUTATION_PLAN_PROTOCOL,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    compiler_protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    operation_count: operationCount,
  }
}

export function bindAdditiveToolSchemaToCapability(tool, capability) {
  const legacyBound = legacy.bindAdditiveToolSchemaToCapability(tool, capability)
  if (legacyBound.ok !== true) return legacyBound

  const schemaKey =
    legacyBound.tool?.input && typeof legacyBound.tool.input === "object"
      ? "input"
      : legacyBound.tool?.parameters &&
          typeof legacyBound.tool.parameters === "object"
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

  const schema = legacyBound.tool[schemaKey]
  const properties = schema?.properties
  const pythonSlots = closedSlotIds(
    capability?.existing_slots,
    "existing:",
    isPythonTarget,
  )
  const replacementSlots = closedSlotIds(
    capability?.existing_slots,
    "existing:",
    (row) => !isPythonTarget(row),
  )
  if (!pythonSlots || !replacementSlots || !properties) {
    return {
      ok: false,
      reason: "additive_schema_slot_identity_invalid",
      tool: null,
      mutation_authority: false,
    }
  }

  const pythonImports = bindSlotEnum(properties.python_imports, pythonSlots)
  const pythonDeclarations = bindSlotEnum(
    properties.python_declarations,
    pythonSlots,
  )
  const replacements = bindSlotEnum(
    properties.replacements,
    replacementSlots,
  )

  if (!pythonImports || !pythonDeclarations || !replacements) {
    return {
      ok: false,
      reason: "additive_schema_shape_invalid",
      tool: null,
      mutation_authority: false,
    }
  }

  return {
    ok: true,
    reason: "additive_schema_bound_v3",
    tool: {
      ...legacyBound.tool,
      [schemaKey]: {
        ...schema,
        properties: {
          ...properties,
          python_imports: pythonImports,
          python_declarations: pythonDeclarations,
          replacements,
        },
      },
    },
    python_slots: Object.freeze([...pythonSlots]),
    replacement_slots: Object.freeze([...replacementSlots]),
    create_slots: Object.freeze([
      ...(legacyBound.create_slots ?? []),
    ]),
    mutation_authority: false,
  }
}

function mergePythonOps(request, capability) {
  const existing = new Map(
    array(capability?.existing_slots).map((row) => [row.slot, row]),
  )
  const grouped = new Map()

  function groupFor(slot) {
    const target = existing.get(slot)
    if (!target || !isPythonTarget(target)) return null
    let group = grouped.get(slot)
    if (!group) {
      group = {
        target,
        modules: new Set(),
        from_imports: new Map(),
        declarations: [],
      }
      grouped.set(slot, group)
    }
    return group
  }

  for (let index = 0; index < request.python_imports.length; index += 1) {
    const op = request.python_imports[index]
    const group = groupFor(op.slot)
    if (!group) {
      return indexedFailure("python_import_slot_unauthorized", index, "slot")
    }
    for (const module of op.modules) group.modules.add(module)
    for (const row of op.from_imports) {
      group.from_imports.set(`${row.module}\0${row.name}`, row)
    }
  }

  for (
    let index = 0;
    index < request.python_declarations.length;
    index += 1
  ) {
    const op = request.python_declarations[index]
    const group = groupFor(op.slot)
    if (!group) {
      return indexedFailure(
        "python_declaration_slot_unauthorized",
        index,
        "slot",
      )
    }
    group.declarations.push(op.content)
  }

  for (let index = 0; index < request.replacements.length; index += 1) {
    const op = request.replacements[index]
    const target = existing.get(op.slot)
    if (!target) {
      return indexedFailure("additive_existing_slot_invalid", index, "slot")
    }
    if (isPythonTarget(target)) {
      return indexedFailure(
        "additive_python_text_replacement_forbidden",
        index,
        "before",
      )
    }
  }

  return { ok: true, grouped }
}

export async function materializeAdditiveMutationPlan({
  root,
  capability,
  request,
  compilePython = compilePythonAdditiveEdits,
} = {}) {
  if (capability?.ready !== true || capability?.mutation_authority !== true) {
    return fail("additive_capability_not_authorized")
  }

  const shape = validateAdditiveMutationRequest(request)
  if (shape.ok !== true) return shape

  const obligationCoverage = validateAdditivePlanCoverage({
    capability,
    request,
  })
  if (obligationCoverage.ok !== true) return obligationCoverage

  const merged = mergePythonOps(request, capability)
  if (merged.ok !== true) return merged

  const lowered = [...request.replacements]
  const receipts = []

  for (const [, group] of [...merged.grouped.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const compiled = await compilePython({
      root,
      target: group.target,
      modules: [...group.modules].sort(),
      fromImports: [...group.from_imports.values()].sort(
        (a, b) =>
          a.module.localeCompare(b.module) ||
          a.name.localeCompare(b.name),
      ),
      declarations: group.declarations,
      maxReplacementBytes: legacy.ADDITIVE_MAX_REPLACE_BYTES,
    })
    if (compiled.ok !== true) {
      return fail(
        compiled.reason ?? "python_typed_ir_compile_failed",
        compiled.detail ?? null,
        {
          compiler_failure_protocol:
            compiled.protocol ?? PYTHON_ADDITIVE_COMPILER_PROTOCOL,
        },
      )
    }

    for (const edit of compiled.edits) {
      lowered.push({
        slot: group.target.slot,
        before: edit.before,
        replacement: edit.replacement,
      })
    }
    receipts.push(compiled.candidate_receipt)
  }

  const legacyPlan = legacy.materializeAdditiveMutationPlan({
    capability,
    request: {
      replacements: lowered,
      creations: request.creations,
    },
  })
  if (legacyPlan.ok !== true) {
    return {
      ...legacyPlan,
      abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
      compiler_protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    }
  }

  return {
    ...legacyPlan,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    model_abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    compiler_protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    candidate_preflight_protocol: CANDIDATE_STATIC_PREFLIGHT_PROTOCOL,
    candidate_receipts: Object.freeze(receipts),
    python_compiled_files: receipts.length,
  }
}

export function renderAdditiveMutationCapability(capability) {
  const legacyText = legacy.renderAdditiveMutationCapability(capability)
  if (!legacyText) return ""

  return legacyText
    .split("\n")
    .map((line) => {
      if (line.startsWith("MUTATION_ABI protocol=")) {
        return (
          `MUTATION_ABI protocol=${ADDITIVE_MUTATION_ABI_PROTOCOL} ` +
          "python_imports=[] python_declarations=[] replacements=[] creations=[]"
        )
      }
      if (line.startsWith("Use execute_additive_plan only.")) {
        return (
          "Use execute_additive_plan only. For Python existing slots, describe WHAT only: " +
          "python_imports and python_declarations. Never submit Python before/preimage, " +
          "line numbers, offsets, site ids, or repository paths. " +
          "Non-Python existing slots keep exact replacements."
        )
      }
      if (line.startsWith("slot=existing:")) {
        const file = /\bfile=(\S+)/u.exec(line)?.[1] ?? null
        if (file && /\.(?:py|pyi)$/u.test(file)) {
          let migrated = line.replace(
            " op=replace_exact ",
            " ops=add_imports,add_module_declaration ",
          )
          migrated = migrated.replace(
            " evidence_lines=",
            " physical_selector=model_forbidden preimage=model_forbidden evidence_lines_internal=",
          )
          return migrated
        }
      }
      return line
    })
    .concat(renderAdditiveMutationObligationProjection(capability))
    .filter((line) => line.length > 0)
    .join("\n")
}
