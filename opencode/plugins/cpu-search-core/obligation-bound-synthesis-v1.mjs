import { createHash } from "node:crypto"

export const OBLIGATION_BOUND_SYNTHESIS_PROTOCOL =
  "obligation-bound-synthesis-v1"
export const OBLIGATION_BOUND_REQUEST_PROTOCOL =
  "obligation-bound-synthesis-request-v1"
export const OBLIGATION_BOUND_SCHEMA_PROTOCOL =
  "obligation-bound-tool-schema-v1"

const PYTHON_FILE_RE = /\.(?:py|pyi)$/u
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u

function array(value) {
  return Array.isArray(value) ? value : []
}

function stableSha(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function ownKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
}

function exactKeys(value, expected) {
  const actual = ownKeys(value)
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function fail(reason, detail = reason) {
  return {
    ok: false,
    protocol: OBLIGATION_BOUND_SYNTHESIS_PROTOCOL,
    reason,
    detail,
    signature: `${OBLIGATION_BOUND_SYNTHESIS_PROTOCOL}:${detail}`,
    mutation_authority: false,
  }
}

function validSlot(row, prefix) {
  return (
    row &&
    typeof row === "object" &&
    typeof row.slot === "string" &&
    row.slot.startsWith(prefix) &&
    IDENTIFIER_RE.test(row.slot) &&
    typeof row.file === "string" &&
    row.file.length > 0
  )
}

function roles(row) {
  return new Set(array(row?.roles).filter((role) => typeof role === "string"))
}

function isPythonSlot(row) {
  return validSlot(row, "existing:") && PYTHON_FILE_RE.test(row.file)
}

function deterministicConstraints(taskRequirements) {
  const result = []
  const seen = new Set()
  for (const row of array(taskRequirements?.constraints)) {
    const kind = typeof row?.kind === "string" ? row.kind : null
    if (
      row?.required !== true ||
      !kind ||
      !IDENTIFIER_RE.test(kind) ||
      seen.has(kind)
    ) {
      continue
    }
    seen.add(kind)
    result.push(kind)
  }
  return result.sort()
}

function operation(id, obligation, slot, kind, payload_fields) {
  return Object.freeze({
    id,
    obligation,
    slot,
    kind,
    payload_fields: Object.freeze([...payload_fields]),
    model_selects_slot: false,
    model_selects_operation: false,
    mutation_authority: false,
  })
}

export function deriveObligationBoundSynthesisContract({
  capability,
  taskRequirements = null,
} = {}) {
  if (
    capability?.ready !== true ||
    capability?.mutation_authority !== true ||
    capability?.operation !== "additive_surface"
  ) {
    return fail("obligation_bound_capability_not_authorized")
  }

  const existing = array(capability.existing_slots)
  const creates = array(capability.create_slots)
  if (existing.some((row) => !validSlot(row, "existing:"))) {
    return fail("obligation_bound_existing_slot_invalid")
  }
  if (
    creates.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        typeof row.slot !== "string" ||
        !row.slot.startsWith("create:") ||
        !IDENTIFIER_RE.test(row.slot),
    )
  ) {
    return fail("obligation_bound_create_slot_invalid")
  }

  // Current additive provider semantics require one structural server owner.
  // Selection is deterministic and fail-closed: a task-anchor/route owner is
  // stronger than a generic Python context file; ambiguity never falls back
  // to model choice.
  const pythonSlots = existing.filter(isPythonSlot)
  const preferredServerSlots = pythonSlots.filter((row) => {
    const set = roles(row)
    return set.has("task_anchor_owner") || set.has("route_host")
  })
  const serverCandidates =
    preferredServerSlots.length > 0 ? preferredServerSlots : pythonSlots
  if (serverCandidates.length !== 1) {
    return fail(
      "obligation_bound_server_slot_ambiguous",
      `server_candidate_count_${serverCandidates.length}`,
    )
  }
  const server = serverCandidates[0]

  const navigationCandidates = existing.filter((row) => {
    if (row.slot === server.slot || isPythonSlot(row)) return false
    return roles(row).has("navigation_host")
  })
  if (navigationCandidates.length > 1) {
    return fail(
      "obligation_bound_navigation_slot_ambiguous",
      `navigation_candidate_count_${navigationCandidates.length}`,
    )
  }

  // The current additive capability derives a single create slot. Do not
  // silently guess semantics if a future provider exposes multiple targets.
  if (creates.length > 1) {
    return fail(
      "obligation_bound_create_slot_ambiguous",
      `create_candidate_count_${creates.length}`,
    )
  }

  const operations = []
  operations.push(
    operation(
      `op_${operations.length}`,
      "server_surface",
      server.slot,
      "python_declaration",
      ["content"],
    ),
  )

  if (navigationCandidates.length === 1) {
    operations.push(
      operation(
        `op_${operations.length}`,
        "navigation_integration",
        navigationCandidates[0].slot,
        "replacement",
        ["before", "replacement"],
      ),
    )
  }

  if (creates.length === 1) {
    operations.push(
      operation(
        `op_${operations.length}`,
        "ui_surface",
        creates[0].slot,
        "creation",
        ["relative_path", "content"],
      ),
    )
  }

  const maxOperations = Number.isSafeInteger(capability?.budgets?.max_operations)
    ? capability.budgets.max_operations
    : null
  if (
    operations.length < 1 ||
    (maxOperations !== null && operations.length > maxOperations)
  ) {
    return fail("obligation_bound_operation_budget_invalid")
  }

  const constraints = deterministicConstraints(taskRequirements)
  const payload = {
    protocol: OBLIGATION_BOUND_SYNTHESIS_PROTOCOL,
    capability_sha256:
      typeof capability.capability_sha256 === "string"
        ? capability.capability_sha256
        : null,
    operations,
    support_import_slot: server.slot,
    constraints,
    model_authority: "content_only",
  }
  const contract_sha256 = stableSha(payload)

  return {
    ok: true,
    ...payload,
    operations: Object.freeze(operations),
    constraints: Object.freeze(constraints),
    contract_sha256,
    mutation_authority: false,
  }
}

function withoutSlotFromArraySchema(schema) {
  if (!schema || typeof schema !== "object") return null
  const items = schema.items
  const properties = items?.properties
  if (!items || typeof items !== "object" || !properties) return null
  const { slot: _slot, ...rest } = properties
  if (!rest.modules || !rest.from_imports) return null
  return {
    ...schema,
    items: {
      ...items,
      properties: rest,
      required: ["modules", "from_imports"],
      additionalProperties: false,
    },
  }
}

function payloadSchemaForOperation(operationRow, properties) {
  if (operationRow.kind === "python_declaration") {
    const content = properties?.python_declarations?.items?.properties?.content
    if (!content) return null
    return {
      type: "object",
      properties: { content },
      required: ["content"],
      additionalProperties: false,
    }
  }
  if (operationRow.kind === "replacement") {
    const base = properties?.replacements?.items?.properties
    if (!base?.before || !base?.replacement) return null
    return {
      type: "object",
      properties: {
        before: base.before,
        replacement: base.replacement,
      },
      required: ["before", "replacement"],
      additionalProperties: false,
    }
  }
  if (operationRow.kind === "creation") {
    const base = properties?.creations?.items?.properties
    if (!base?.relative_path || !base?.content) return null
    return {
      type: "object",
      properties: {
        relative_path: base.relative_path,
        content: base.content,
      },
      required: ["relative_path", "content"],
      additionalProperties: false,
    }
  }
  return null
}

export function bindObligationBoundToolSchema(
  tool,
  capability,
  taskRequirements = null,
) {
  const contract = deriveObligationBoundSynthesisContract({
    capability,
    taskRequirements,
  })
  if (contract.ok !== true) {
    return { ...contract, tool: null }
  }

  const schemaKey =
    tool?.input && typeof tool.input === "object"
      ? "input"
      : tool?.parameters && typeof tool.parameters === "object"
        ? "parameters"
        : null
  if (!schemaKey) {
    return fail("obligation_bound_schema_shape_invalid")
  }
  const schema = tool[schemaKey]
  const properties = schema?.properties
  if (!properties || typeof properties !== "object") {
    return fail("obligation_bound_schema_shape_invalid")
  }

  const supportImports = withoutSlotFromArraySchema(properties.python_imports)
  if (!supportImports) {
    return fail("obligation_bound_support_import_schema_invalid")
  }

  const requiredProperties = {}
  for (const operationRow of contract.operations) {
    const payloadSchema = payloadSchemaForOperation(operationRow, properties)
    if (!payloadSchema) {
      return fail(
        "obligation_bound_payload_schema_invalid",
        `payload_schema_${operationRow.kind}`,
      )
    }
    requiredProperties[operationRow.id] = payloadSchema
  }

  const constraintText =
    contract.constraints.length > 0
      ? ` Deterministic constraints: ${contract.constraints
          .map((kind) => `${kind}=true`)
          .join(" ")}.`
      : ""

  const boundSchema = {
    type: "object",
    properties: {
      support_imports: {
        ...supportImports,
        description:
          "Optional support imports only. Target slot is deterministic; do not submit file/slot authority.",
      },
      required_operations: {
        type: "object",
        properties: requiredProperties,
        required: contract.operations.map((row) => row.id),
        additionalProperties: false,
        description:
          "Every listed operation is mandatory. Operation kind and target are deterministic; supply payload content only.",
      },
    },
    required: ["support_imports", "required_operations"],
    additionalProperties: false,
  }

  return {
    ok: true,
    protocol: OBLIGATION_BOUND_SCHEMA_PROTOCOL,
    reason: "obligation_bound_schema_bound",
    tool: {
      ...tool,
      description:
        `${tool.description ?? ""} ` +
        "Required mutation operations are deterministic and cannot be omitted or retargeted; fill content only." +
        constraintText,
      [schemaKey]: boundSchema,
    },
    contract_sha256: contract.contract_sha256,
    required_operation_ids: Object.freeze(
      contract.operations.map((row) => row.id),
    ),
    mutation_authority: false,
  }
}

function exactPayload(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("obligation_bound_payload_invalid", `${label}_not_object`)
  }
  if (!exactKeys(value, fields)) {
    return fail("obligation_bound_payload_invalid", `${label}_fields_invalid`)
  }
  for (const field of fields) {
    if (typeof value[field] !== "string") {
      return fail("obligation_bound_payload_invalid", `${label}_${field}_invalid`)
    }
  }
  return { ok: true }
}

function normalizeSupportImports(value, slot) {
  if (!Array.isArray(value)) {
    return fail("obligation_bound_support_imports_invalid")
  }
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index]
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return fail(
        "obligation_bound_support_imports_invalid",
        `support_import_${index}_not_object`,
      )
    }
    if (!exactKeys(row, ["modules", "from_imports"])) {
      return fail(
        "obligation_bound_support_imports_invalid",
        `support_import_${index}_fields_invalid`,
      )
    }
    if (!Array.isArray(row.modules) || !Array.isArray(row.from_imports)) {
      return fail(
        "obligation_bound_support_imports_invalid",
        `support_import_${index}_arrays_invalid`,
      )
    }
    result.push({
      slot,
      modules: row.modules,
      from_imports: row.from_imports,
    })
  }
  return { ok: true, rows: result }
}

export function materializeObligationBoundAdditiveRequest({
  capability,
  taskRequirements = null,
  request,
} = {}) {
  const contract = deriveObligationBoundSynthesisContract({
    capability,
    taskRequirements,
  })
  if (contract.ok !== true) return contract

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return fail("obligation_bound_request_invalid", "request_not_object")
  }
  if (!exactKeys(request, ["required_operations", "support_imports"])) {
    return fail("obligation_bound_request_invalid", "request_fields_invalid")
  }

  const support = normalizeSupportImports(
    request.support_imports,
    contract.support_import_slot,
  )
  if (support.ok !== true) return support

  const required = request.required_operations
  if (!required || typeof required !== "object" || Array.isArray(required)) {
    return fail(
      "obligation_bound_required_operations_invalid",
      "required_operations_not_object",
    )
  }
  const operationIds = contract.operations.map((row) => row.id)
  if (!exactKeys(required, operationIds)) {
    return fail(
      "obligation_bound_required_operations_invalid",
      "required_operation_set_mismatch",
    )
  }

  const translated = {
    python_imports: support.rows,
    python_declarations: [],
    replacements: [],
    creations: [],
  }

  for (const operationRow of contract.operations) {
    const payload = required[operationRow.id]
    const payloadShape = exactPayload(
      payload,
      operationRow.payload_fields,
      operationRow.id,
    )
    if (payloadShape.ok !== true) return payloadShape

    if (operationRow.kind === "python_declaration") {
      if (payload.content.length < 1) {
        return fail(
          "obligation_bound_payload_invalid",
          `${operationRow.id}_content_empty`,
        )
      }
      translated.python_declarations.push({
        slot: operationRow.slot,
        content: payload.content,
      })
      continue
    }
    if (operationRow.kind === "replacement") {
      if (payload.before.length < 1) {
        return fail(
          "obligation_bound_payload_invalid",
          `${operationRow.id}_before_empty`,
        )
      }
      translated.replacements.push({
        slot: operationRow.slot,
        before: payload.before,
        replacement: payload.replacement,
      })
      continue
    }
    if (operationRow.kind === "creation") {
      if (payload.relative_path.length < 1) {
        return fail(
          "obligation_bound_payload_invalid",
          `${operationRow.id}_relative_path_empty`,
        )
      }
      translated.creations.push({
        slot: operationRow.slot,
        relative_path: payload.relative_path,
        content: payload.content,
      })
      continue
    }
    return fail(
      "obligation_bound_operation_kind_invalid",
      operationRow.kind,
    )
  }

  return {
    ok: true,
    protocol: OBLIGATION_BOUND_REQUEST_PROTOCOL,
    reason: "obligation_bound_request_materialized",
    contract_sha256: contract.contract_sha256,
    request: translated,
    required_operation_count: contract.operations.length,
    mutation_authority: false,
  }
}

export function renderObligationBoundSynthesisContract(
  capability,
  taskRequirements = null,
) {
  const contract = deriveObligationBoundSynthesisContract({
    capability,
    taskRequirements,
  })
  if (contract.ok !== true) return ""

  const lines = [
    `MODEL_TOOL_ABI protocol=semantic-content-ir-v1 shape=contents[id,content] physical_lowering=closed-additive-mutation-abi-v3\nSYNTHESIS_TRANSACTION protocol=${OBLIGATION_BOUND_SYNTHESIS_PROTOCOL} ` +
      `sha256=${contract.contract_sha256} content_only=true all_required=true`,
  ]
  for (const row of contract.operations) {
    lines.push(
      `REQUIRED_OPERATION id=${row.id} obligation=${row.obligation} ` +
        `slot=${row.slot} operation=${row.kind} ` +
        `payload=${row.kind === "python_declaration" ? "content{kind=python_units,units[]}" : row.kind === "replacement" ? "content{kind=text,mode=before|after|replace,text} preimage=compiler_owned" : "content{kind=text,mode=create,text} create_path=compiler_owned"}`,
    )
  }
  // Compatibility markers remain additive until every consumer has migrated.
  // Do not repurpose or remove the frozen content-only authority token.
  lines.push(
    `SUPPORT_IMPORTS slot=${contract.support_import_slot} optional=true ` +
      "support_only=true target=model_forbidden",
  )
  lines.push(
    `PYTHON_SEMANTIC_SHELL slot=${contract.support_import_slot} ` +
      "mode=typed_units protocol=python-unit-shell-v2 " +
      "imports=model_forbidden dependencies=model_forbidden " +
      "module_bootstrap=model_forbidden existing_symbols=model_forbidden " +
      "existing_routes=model_forbidden",
  )
  lines.push(
    "PYTHON_UNIT_SHELL protocol=python-unit-shell-v2 " +
      "kinds=function,async_function,class,assignment " +
      "shape=content{kind=python_units,units[]} " +
      "functions=suite[ruff_validated_statement_chunk] classes=members[typed_member] " +
      "outer_indent=compiler_owned raw_body=model_forbidden " +
      "imports=zero_authority_hints globals=model_forbidden nonlocals=model_forbidden",
  )
  lines.push(
    "NON_PYTHON_CONTENT protocol=semantic-text-v2 " +
      "shape=content{kind=text,mode,text} modes=before,after,replace,create " +
      "preimage=compiler_owned create_path=compiler_owned placeholders=model_forbidden " +
      "resource_ref=resource://op_N",
  )
  lines.push(
    "SEMANTIC_CANONICALIZER protocol=semantic-canonicalizer-v1 " +
      "parser=ruff_python_parser authority=monotonic_reducer " +
      "wrapper=exact_unwrap static_imports=zero_authority_hints " +
      "dynamic_imports=fail_closed ambiguity=fail_closed",
  )
  lines.push(
    "PYTHON_BINDING_LINKER existing_source=true repo_import_index=true " +
      "stdlib=true declared_dependencies=true unknown=fail_closed " +
      "aliases=compiler_canonicalized parser=ruff_python_parser",
  )
  lines.push(
    "PROVENANCE agent=koalik protocol=koalik-provenance-v1 " +
      "marker=compiler_generated timestamp=ledger_only model_authority=false",
  )
  if (contract.constraints.length > 0) {
    lines.push(
      `MUTATION_CONSTRAINTS ${contract.constraints
        .map((kind) => `${kind}=true`)
        .join(" ")}`,
    )
  }
  // Frozen producer/consumer compatibility marker. New authority detail is
  // emitted separately so old context projectors remain valid during migration.
  lines.push(
    "MODEL_AUTHORITY content_only=true slot=false operation=false " +
      "file=false scope=false",
  )
  lines.push(
    "MODEL_AUTHORITY_V2 semantic_suite=true python_units=true new_symbols=true " +
      "new_routes=true imports=false dependencies=false module_bootstrap=false " +
      "existing_symbols=false existing_routes=false provenance=false " +
      "slot=false operation=false file=false scope=false preimage=false " +
      "create_path=false",
  )
  return lines.join("\n")
}

export const MUTATION_CONTEXT_PROJECTION_PROTOCOL =
  "mutation-context-projection-v1"
export const MUTATION_CONTEXT_PROJECTION_ANCHOR_RADIUS = 2

function mutationContextBytes(value) {
  return Buffer.byteLength(typeof value === "string" ? value : "", "utf8")
}

function mutationContextToken(line, key) {
  const prefix = `${key}=`
  return line
    .trim()
    .split(/\s+/u)
    .find((token) => token.startsWith(prefix)) ?? null
}

function compactAdditiveCapabilityForMutation(content) {
  const lines = typeof content === "string" ? content.split(/\r?\n/u) : []
  const projected = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith("Use execute_additive_plan only.")) {
      continue
    }

    if (line.startsWith("ADDITIVE_CAPABILITY ")) {
      projected.push(
        [
          "ADDITIVE_CAPABILITY",
          mutationContextToken(line, "protocol"),
          mutationContextToken(line, "sha256"),
        ]
          .filter(Boolean)
          .join(" "),
      )
      continue
    }

    if (line.startsWith("MUTATION_ABI ")) {
      const protocol = mutationContextToken(line, "protocol")
      projected.push(
        [
          "MUTATION_ABI",
          protocol,
          "content_fields=python_imports,python_declarations,replacements,creations",
        ]
          .filter(Boolean)
          .join(" "),
      )
      continue
    }

    if (line.startsWith("slot=existing:")) {
      projected.push(
        [
          mutationContextToken(line, "slot"),
          mutationContextToken(line, "ops"),
          mutationContextToken(line, "op"),
          mutationContextToken(line, "file"),
          mutationContextToken(line, "roles"),
        ]
          .filter(Boolean)
          .join(" "),
      )
      continue
    }

    if (line.startsWith("slot=create:")) {
      projected.push(
        [
          mutationContextToken(line, "slot"),
          mutationContextToken(line, "op"),
          mutationContextToken(line, "relative_path_only"),
          mutationContextToken(line, "sealed_root_prefix"),
          mutationContextToken(line, "extensions"),
          mutationContextToken(line, "max_depth"),
        ]
          .filter(Boolean)
          .join(" "),
      )
      continue
    }

    if (
      line.startsWith("budgets ") ||
      line.startsWith("REQUIRED_MUTATION_COVERAGE ")
    ) {
      projected.push(line)
      continue
    }

    // Unknown capability lines are retained. Projection is an optimization
    // boundary, never an authority-dropping parser.
    projected.push(rawLine)
  }

  return projected.filter(Boolean).join("\n")
}

function projectSealedMutationContext(content) {
  const source = typeof content === "string" ? content.trim() : ""
  if (!source) {
    return {
      ok: false,
      reason: "mutation_context_empty",
      content: source,
      sections: 0,
      projected_sections: 0,
    }
  }

  const sections = source.split(/\n\s*\n(?=SEALED_CONTEXT\s)/u)
  const rendered = []
  let projectedSections = 0

  for (const section of sections) {
    const lines = section.split(/\r?\n/u)
    const header = lines[0]?.trim() ?? ""

    if (!header.startsWith("SEALED_CONTEXT ")) {
      rendered.push(section)
      continue
    }

    const anchorsToken = mutationContextToken(header, "anchors")
    const anchors = (anchorsToken?.slice("anchors=".length) ?? "")
      .split(",")
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0)

    const numbered = lines
      .slice(1)
      .map((line) => {
        const match = /^\s*(\d+)\s*\|\s?(.*)$/u.exec(line)
        if (!match) return null
        return {
          number: Number.parseInt(match[1], 10),
          line,
        }
      })
      .filter(Boolean)

    if (anchors.length === 0 || numbered.length === 0) {
      // Missing structural anchors means "do not optimize this section".
      rendered.push(section)
      continue
    }

    const kept = numbered.filter((row) =>
      anchors.some(
        (anchor) =>
          Math.abs(row.number - anchor) <=
          MUTATION_CONTEXT_PROJECTION_ANCHOR_RADIUS,
      ),
    )

    const everyAnchorWitnessed = anchors.every((anchor) =>
      kept.some(
        (row) =>
          Math.abs(row.number - anchor) <=
          MUTATION_CONTEXT_PROJECTION_ANCHOR_RADIUS,
      ),
    )

    if (!everyAnchorWitnessed || kept.length === 0) {
      rendered.push(section)
      continue
    }

    const compactHeader = [
      "SEALED_CONTEXT",
      mutationContextToken(header, "file"),
      mutationContextToken(header, "roles"),
      anchorsToken,
    ]
      .filter(Boolean)
      .join(" ")

    rendered.push([compactHeader, ...kept.map((row) => row.line)].join("\n"))
    projectedSections += 1
  }

  return {
    ok: true,
    reason:
      projectedSections > 0
        ? "anchor_local_projection"
        : "projection_not_applicable",
    content: rendered.join("\n\n"),
    sections: sections.length,
    projected_sections: projectedSections,
  }
}

export function projectObligationBoundMutationContext({
  capabilityText,
  synthesisText,
  contextText,
}) {
  const capability =
    typeof capabilityText === "string" ? capabilityText.trim() : ""
  const synthesis =
    typeof synthesisText === "string" ? synthesisText.trim() : ""
  const context =
    typeof contextText === "string" ? contextText.trim() : ""

  const sourceContent = [capability, synthesis, context]
    .filter(Boolean)
    .join("\n\n")
  const sourceBytes = mutationContextBytes(sourceContent)

  if (
    !capability.includes("REQUIRED_MUTATION_COVERAGE ") ||
    !synthesis.includes(
      `SYNTHESIS_TRANSACTION protocol=${OBLIGATION_BOUND_SYNTHESIS_PROTOCOL}`,
    ) ||
    !synthesis.includes("REQUIRED_OPERATION ") ||
    !(
      synthesis.includes("MODEL_AUTHORITY content_only=true") ||
      synthesis.includes("MODEL_AUTHORITY_V2 semantic_body=true")
    ) ||
    !context.includes("SEALED_CONTEXT ")
  ) {
    return {
      ok: false,
      protocol: MUTATION_CONTEXT_PROJECTION_PROTOCOL,
      reason: "projection_contract_incomplete",
      content: sourceContent,
      source_bytes: sourceBytes,
      projected_bytes: sourceBytes,
      reduction_bytes: 0,
      projected_sections: 0,
      anchor_radius: MUTATION_CONTEXT_PROJECTION_ANCHOR_RADIUS,
      projection_sha256: null,
      mutation_authority: false,
    }
  }

  const compactCapability =
    compactAdditiveCapabilityForMutation(capability)
  const projectedContext = projectSealedMutationContext(context)

  if (projectedContext.ok !== true) {
    return {
      ok: false,
      protocol: MUTATION_CONTEXT_PROJECTION_PROTOCOL,
      reason: projectedContext.reason,
      content: sourceContent,
      source_bytes: sourceBytes,
      projected_bytes: sourceBytes,
      reduction_bytes: 0,
      projected_sections: 0,
      anchor_radius: MUTATION_CONTEXT_PROJECTION_ANCHOR_RADIUS,
      projection_sha256: null,
      mutation_authority: false,
    }
  }

  const content = [
    `MUTATION_CONTENT_ENVELOPE protocol=${MUTATION_CONTEXT_PROJECTION_PROTOCOL} ` +
      "minimal_complete=true explanations=false optional_changes=false",
    compactCapability,
    synthesis,
    projectedContext.content,
    "CONTENT_POLICY smallest_complete_implementation=true " +
      "reuse_existing_patterns=true no_explanation=true",
  ]
    .filter(Boolean)
    .join("\n\n")

  const projectedBytes = mutationContextBytes(content)

  // Compression is never allowed to enlarge the model-facing contract.
  if (projectedBytes >= sourceBytes) {
    return {
      ok: true,
      protocol: MUTATION_CONTEXT_PROJECTION_PROTOCOL,
      reason: "projection_no_size_gain",
      content: sourceContent,
      source_bytes: sourceBytes,
      projected_bytes: sourceBytes,
      reduction_bytes: 0,
      projected_sections: projectedContext.projected_sections,
      anchor_radius: MUTATION_CONTEXT_PROJECTION_ANCHOR_RADIUS,
      projection_sha256: stableSha(sourceContent),
      mutation_authority: false,
    }
  }

  return {
    ok: true,
    protocol: MUTATION_CONTEXT_PROJECTION_PROTOCOL,
    reason: "projection_applied",
    content,
    source_bytes: sourceBytes,
    projected_bytes: projectedBytes,
    reduction_bytes: sourceBytes - projectedBytes,
    projected_sections: projectedContext.projected_sections,
    anchor_radius: MUTATION_CONTEXT_PROJECTION_ANCHOR_RADIUS,
    projection_sha256: stableSha(content),
    mutation_authority: false,
  }
}
