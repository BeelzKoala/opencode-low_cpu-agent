import * as legacy from "./additive-mutation-v1.mjs"
import {
  SEALED_ADDITIVE_SITE_PROTOCOL,
  resolveSealedAdditiveInsertion,
} from "./sealed-additive-site-v1.mjs"

export * from "./additive-mutation-v1.mjs"

export const ADDITIVE_MUTATION_ABI_PROTOCOL =
  "closed-additive-mutation-abi-v2"

const SHA256_RE = /^[0-9a-f]{64}$/u

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
    reason,
    detail,
    repairable: false,
    mutations: [],
    mutation_authority: false,
    ...extra,
  }
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

export function validateAdditiveMutationRequest(request) {
  if (!exactKeys(request, ["insertions", "replacements", "creations"])) {
    return fail("additive_request_shape_invalid")
  }
  if (!Array.isArray(request.insertions)) {
    return fail("additive_insertions_array_invalid")
  }
  if (!Array.isArray(request.replacements)) {
    return fail("additive_replacements_array_invalid")
  }
  if (!Array.isArray(request.creations)) {
    return fail("additive_creations_array_invalid")
  }

  const operationCount =
    request.insertions.length +
    request.replacements.length +
    request.creations.length
  if (operationCount > legacy.ADDITIVE_MAX_OPERATIONS) {
    return fail("additive_operation_count_invalid")
  }

  const legacyShape = legacy.validateAdditiveMutationRequest({
    replacements: request.replacements,
    creations: request.creations,
  })
  if (legacyShape.ok !== true) {
    return {
      ...legacyShape,
      abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    }
  }

  const seen = new Set()
  for (let index = 0; index < request.insertions.length; index += 1) {
    const op = request.insertions[index]
    if (!exactKeys(op, ["slot", "evidence_line", "content"])) {
      return indexedFailure("additive_insertion_shape_invalid", index, "insertion")
    }
    if (
      typeof op.slot !== "string" ||
      op.slot.length < 1 ||
      op.slot.length > 64
    ) {
      return indexedFailure("additive_insertion_slot_shape_invalid", index, "slot")
    }
    if (!Number.isSafeInteger(op.evidence_line) || op.evidence_line < 1) {
      return indexedFailure(
        "additive_insertion_evidence_line_invalid",
        index,
        "evidence_line",
      )
    }
    if (
      typeof op.content !== "string" ||
      op.content.length < 1 ||
      op.content.includes("\0") ||
      Buffer.byteLength(op.content, "utf8") > legacy.ADDITIVE_MAX_REPLACE_BYTES
    ) {
      return indexedFailure("additive_insertion_content_invalid", index, "content")
    }
    const key = `${op.slot}:${op.evidence_line}`
    if (seen.has(key)) {
      return indexedFailure("additive_insertion_duplicate", index, "slot")
    }
    seen.add(key)
  }

  return {
    ok: true,
    protocol: legacy.ADDITIVE_MUTATION_PLAN_PROTOCOL,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
  }
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
  const insertionSlots = closedSlotIds(
    capability?.existing_slots,
    "existing:",
    isPythonTarget,
  )
  const replacementSlots = closedSlotIds(
    capability?.existing_slots,
    "existing:",
    (row) => !isPythonTarget(row),
  )
  const createSlots = closedSlotIds(capability?.create_slots, "create:")
  if (!insertionSlots || !replacementSlots || !createSlots || !properties) {
    return {
      ok: false,
      reason: "additive_schema_slot_identity_invalid",
      tool: null,
      mutation_authority: false,
    }
  }

  const insertions = bindSlotEnum(properties.insertions, insertionSlots)
  const replacements = bindSlotEnum(properties.replacements, replacementSlots)
  if (!insertions || !replacements) {
    return {
      ok: false,
      reason: "additive_schema_shape_invalid",
      tool: null,
      mutation_authority: false,
    }
  }

  return {
    ok: true,
    reason: "additive_schema_bound_v2",
    tool: {
      ...legacyBound.tool,
      [schemaKey]: {
        ...schema,
        properties: {
          ...properties,
          insertions,
          replacements,
        },
      },
    },
    insertion_slots: Object.freeze([...insertionSlots]),
    replacement_slots: Object.freeze([...replacementSlots]),
    create_slots: Object.freeze([...createSlots]),
    mutation_authority: false,
  }
}

export async function materializeAdditiveMutationPlan({
  root,
  capability,
  request,
  resolveSite = resolveSealedAdditiveInsertion,
} = {}) {
  if (capability?.ready !== true || capability?.mutation_authority !== true) {
    return fail("additive_capability_not_authorized")
  }

  const shape = validateAdditiveMutationRequest(request)
  if (shape.ok !== true) return shape

  const existing = new Map(
    array(capability.existing_slots).map((row) => [row.slot, row]),
  )
  const lowered = []

  for (let index = 0; index < request.replacements.length; index += 1) {
    const op = request.replacements[index]
    const target = existing.get(op.slot)
    if (!target) {
      return indexedFailure("additive_existing_slot_invalid", index, "slot")
    }
    if (isPythonTarget(target)) {
      return indexedFailure(
        "additive_python_preimage_model_forbidden",
        index,
        "before",
      )
    }
    lowered.push(op)
  }

  for (let index = 0; index < request.insertions.length; index += 1) {
    const op = request.insertions[index]
    const target = existing.get(op.slot)
    if (!target) {
      return indexedFailure("additive_existing_slot_invalid", index, "slot")
    }
    if (!isPythonTarget(target)) {
      return indexedFailure(
        "additive_insertion_language_unsupported",
        index,
        "slot",
      )
    }
    if (
      typeof target.sha256 !== "string" ||
      !SHA256_RE.test(target.sha256) ||
      !array(target.evidence_lines).includes(op.evidence_line)
    ) {
      return indexedFailure(
        "additive_insertion_evidence_line_unattested",
        index,
        "evidence_line",
      )
    }

    const resolved = await resolveSite({
      root,
      target,
      evidenceLine: op.evidence_line,
      content: op.content,
      maxReplacementBytes: legacy.ADDITIVE_MAX_REPLACE_BYTES,
    })
    if (resolved.ok !== true) {
      return fail(resolved.reason ?? "additive_site_resolution_failed", String(index), {
        operation_index: index,
        field: "evidence_line",
        sealed_site_protocol: resolved.protocol ?? SEALED_ADDITIVE_SITE_PROTOCOL,
        sealed_site_detail: resolved.detail ?? null,
      })
    }

    lowered.push({
      slot: op.slot,
      before: resolved.before,
      replacement: resolved.replacement,
    })
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
      model_abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    }
  }

  return {
    ...legacyPlan,
    abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    model_abi_protocol: ADDITIVE_MUTATION_ABI_PROTOCOL,
    sealed_additive_site_protocol: SEALED_ADDITIVE_SITE_PROTOCOL,
    insertion_count: request.insertions.length,
  }
}

export function renderAdditiveMutationCapability(capability) {
  const legacyText = legacy.renderAdditiveMutationCapability(capability)
  if (!legacyText) return ""

  const lines = legacyText.split("\n")
  const rendered = []
  let sawAbi = false

  for (const line of lines) {
    if (line.startsWith("MUTATION_ABI protocol=")) {
      rendered.push(
        `MUTATION_ABI protocol=${ADDITIVE_MUTATION_ABI_PROTOCOL} ` +
          "insertions=[] replacements=[] creations=[]",
      )
      sawAbi = true
      continue
    }

    if (line.startsWith("Use execute_additive_plan only.")) {
      rendered.push(
        "Use execute_additive_plan only. Python existing slots use insertions; " +
          "never reconstruct, copy, or concatenate a Python before/preimage. " +
          "Non-Python existing slots keep exact replacements. " +
          "Never submit repository paths, absolute paths, offsets, or create-root paths.",
      )
      continue
    }

    if (line.startsWith("slot=existing:")) {
      const fileMatch = /\bfile=(\S+)/u.exec(line)
      if (fileMatch && /\.(?:py|pyi)$/u.test(fileMatch[1])) {
        let migrated = line.replace(
          " op=replace_exact ",
          " op=insert_at_sealed_site ",
        )
        migrated = migrated.replace(
          " evidence_lines=",
          " preimage=model_forbidden evidence_line_required=true evidence_lines=",
        )
        rendered.push(migrated)
        continue
      }
    }

    rendered.push(line)
  }

  if (!sawAbi) {
    rendered.splice(
      1,
      0,
      `MUTATION_ABI protocol=${ADDITIVE_MUTATION_ABI_PROTOCOL} ` +
        "insertions=[] replacements=[] creations=[]",
    )
  }
  return rendered.join("\n")
}
