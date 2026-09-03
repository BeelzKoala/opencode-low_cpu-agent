import { createHash } from "node:crypto"

export const SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL =
  "semantic-obligation-bridge-v1"

function array(value) {
  return Array.isArray(value) ? value : []
}

function fail(reason, detail = reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
    reason,
    detail,
    mutation_authority: false,
    ...extra,
  })
}

function canonical(value) {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === "object") {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      if (typeof item === "undefined" || typeof item === "function") continue
      out[key] = canonical(item)
    }
    return out
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  return String(value)
}

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}

function contractSha(contract) {
  const value = contract?.contract_sha256
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/iu.test(value)
  )
    ? value.toLowerCase()
    : null
}

function capabilityFingerprint(capability) {
  if (!capability || typeof capability !== "object") return null
  return stableSha(capability)
}

function exactOperationIds(contract) {
  const rows = array(contract?.operations)
  if (rows.length < 1) return null

  const ids = []
  const seen = new Set()
  for (const row of rows) {
    const id =
      typeof row?.id === "string" &&
      /^op_[0-9]+$/u.test(row.id)
        ? row.id
        : null
    if (!id || seen.has(id)) return null
    seen.add(id)
    ids.push(id)
  }
  return Object.freeze(ids)
}

function sameStrings(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((item) => value.includes(item))
  )
}

function exactPropertyNames(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false
  }

  return sameStrings(Object.keys(value), expected)
}

function operationSchemaBranch(items, operation) {
  const branches = array(items?.oneOf)

  for (const branch of branches) {
    const ids = array(branch?.properties?.id?.enum)
    if (
      ids.length === 1 &&
      ids[0] === operation?.id
    ) {
      return branch
    }
  }

  return null
}

function operationSchemaMatches(branch, operation) {
  if (
    !branch ||
    branch.type !== "object" ||
    branch.additionalProperties !== false ||
    !sameStrings(
      branch.required,
      ["id", "content"],
    ) ||
    !exactPropertyNames(
      branch.properties,
      ["id", "content"],
    )
  ) {
    return false
  }

  const idEnum = array(branch.properties.id?.enum)

  if (
    idEnum.length !== 1 ||
    idEnum[0] !== operation?.id
  ) {
    return false
  }

  const content = branch.properties.content
  const fields = content?.properties

  if (
    content?.type !== "object" ||
    content.additionalProperties !== false ||
    !fields ||
    typeof fields !== "object"
  ) {
    return false
  }

  if (operation?.kind === "python_declaration") {
    return (
      sameStrings(
        content.required,
        ["kind", "units"],
      ) &&
      exactPropertyNames(
        fields,
        ["kind", "units"],
      ) &&
      sameStrings(
        fields.kind?.enum,
        ["python_units"],
      ) &&
      fields.units?.type === "array"
    )
  }

  if (operation?.kind === "replacement") {
    return (
      sameStrings(
        content.required,
        ["kind", "mode", "text"],
      ) &&
      exactPropertyNames(
        fields,
        ["kind", "mode", "text"],
      ) &&
      sameStrings(fields.kind?.enum, ["text"]) &&
      sameStrings(
        fields.mode?.enum,
        ["before", "after", "replace"],
      ) &&
      fields.text?.type === "string"
    )
  }

  if (operation?.kind === "creation") {
    return (
      sameStrings(
        content.required,
        ["kind", "mode", "text"],
      ) &&
      exactPropertyNames(
        fields,
        ["kind", "mode", "text"],
      ) &&
      sameStrings(fields.kind?.enum, ["text"]) &&
      sameStrings(fields.mode?.enum, ["create"]) &&
      fields.text?.type === "string"
    )
  }

  return false
}

function toolSchemaView(tool) {
  const key =
    tool?.input && typeof tool.input === "object"
      ? "input"
      : tool?.parameters &&
          typeof tool.parameters === "object"
        ? "parameters"
        : null
  if (!key) return null

  const schema = tool[key]
  const contents = schema?.properties?.contents
  const items = contents?.items
  const fields = items?.properties
  if (
    !schema ||
    !contents ||
    contents.type !== "array" ||
    !items ||
    typeof items !== "object" ||
    !fields?.id ||
    !fields?.content
  ) {
    return null
  }

  return Object.freeze({
    key,
    schema,
    contents,
    items,
    fields,
  })
}

export function bindSemanticObligationContract({
  semanticBinding,
  capability,
  contract,
} = {}) {
  if (semanticBinding?.ok !== true) {
    return fail(
      "semantic_obligation_semantic_schema_not_bound",
      semanticBinding?.reason ?? null,
    )
  }
  if (contract?.ok !== true) {
    return fail("semantic_obligation_contract_not_ready")
  }

  const view = toolSchemaView(semanticBinding.tool)
  if (!view) {
    return fail("semantic_obligation_schema_shape_invalid")
  }

  const requiredIds = exactOperationIds(contract)
  const observedIds = array(view.fields.id.enum)
  const observedContractSha = contractSha(contract)
  const capabilitySha = capabilityFingerprint(capability)

  if (!requiredIds) {
    return fail("semantic_obligation_operation_ids_invalid")
  }
  if (!observedContractSha) {
    return fail("semantic_obligation_contract_identity_invalid")
  }
  if (!capabilitySha) {
    return fail("semantic_obligation_capability_identity_invalid")
  }

  if (
    observedIds.length !== requiredIds.length ||
    observedIds.some((id, index) => id !== requiredIds[index])
  ) {
    return fail(
      "semantic_obligation_schema_contract_drift",
      "semantic_ids_do_not_match_canonical_contract",
      {
        contract_operation_ids: requiredIds,
        semantic_operation_ids: observedIds,
      },
    )
  }

  const operations = array(contract.operations)
  const branches = array(view.items.oneOf)

  if (branches.length !== requiredIds.length) {
    return fail(
      "semantic_obligation_operation_schema_unbound",
      "semantic_operation_schema_count_mismatch",
      {
        expected: requiredIds.length,
        observed: branches.length,
      },
    )
  }

  for (const operation of operations) {
    const branch =
      operationSchemaBranch(view.items, operation)

    if (!operationSchemaMatches(branch, operation)) {
      return fail(
        "semantic_obligation_operation_schema_drift",
        operation?.id ?? "unknown_operation",
        {
          operation_id: operation?.id ?? null,
          operation_kind: operation?.kind ?? null,
        },
      )
    }
  }

  const boundSchema = {
    ...view.schema,
    properties: {
      ...view.schema.properties,
      contents: {
        ...view.contents,
        minItems: requiredIds.length,
        maxItems: requiredIds.length,
        items: {
          ...view.items,
          properties: {
            ...view.fields,
            id: {
              ...view.fields.id,
              enum: [...requiredIds],
            },
          },
          required: ["id", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["contents"],
    additionalProperties: false,
  }

  const attestationPayload = {
    protocol: SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
    contract_sha256: observedContractSha,
    capability_fingerprint_sha256: capabilitySha,
    operation_ids: [...requiredIds],
  }

  return Object.freeze({
    ok: true,
    protocol: SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
    reason: "semantic_obligation_schema_bound",
    tool: {
      ...semanticBinding.tool,
      [view.key]: boundSchema,
    },
    contract,
    attestation: Object.freeze({
      ...attestationPayload,
      attestation_sha256: stableSha(attestationPayload),
    }),
    required_operation_ids: requiredIds,
    mutation_authority: false,
  })
}

export function validateSemanticObligationRequest({
  request,
  capability,
  contract,
  attestation,
} = {}) {
  if (contract?.ok !== true) {
    return fail("semantic_obligation_contract_not_ready")
  }

  const operations = array(contract?.operations)
  const requiredIds = exactOperationIds(contract)
  const observedContractSha = contractSha(contract)
  const capabilitySha = capabilityFingerprint(capability)
  if (!requiredIds || !observedContractSha || !capabilitySha) {
    return fail("semantic_obligation_identity_unavailable")
  }

  const attestationPayload = {
    protocol: SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
    contract_sha256: observedContractSha,
    capability_fingerprint_sha256: capabilitySha,
    operation_ids: [...requiredIds],
  }
  const expectedAttestationSha = stableSha(attestationPayload)

  if (
    attestation?.protocol !==
      SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL ||
    attestation?.attestation_sha256 !==
      expectedAttestationSha
  ) {
    return fail("semantic_obligation_attestation_mismatch")
  }

  if (attestation.contract_sha256 !== observedContractSha) {
    return fail("semantic_obligation_contract_drift")
  }
  if (
    attestation.capability_fingerprint_sha256 !==
    capabilitySha
  ) {
    return fail("semantic_obligation_capability_drift")
  }

  const contents = request?.contents
  if (!Array.isArray(contents)) {
    return fail("semantic_obligation_contents_invalid")
  }
  if (contents.length !== requiredIds.length) {
    return fail(
      "semantic_obligation_coverage_count_mismatch",
      "semantic_content_count_does_not_match_contract",
      {
        expected: requiredIds.length,
        observed: contents.length,
      },
    )
  }

  const operationById = new Map(
    operations.map((operation) => [operation?.id, operation]),
  )
  const expected = new Set(requiredIds)
  const seen = new Set()

  for (const row of contents) {
    const id =
      typeof row?.id === "string"
        ? row.id
        : null

    if (!id || !expected.has(id)) {
      return fail(
        "semantic_obligation_unknown_operation_id",
        id ?? "missing_id",
      )
    }
    if (seen.has(id)) {
      return fail(
        "semantic_obligation_duplicate_operation_id",
        id,
      )
    }

    const operation = operationById.get(id)
    const content = row?.content
    if (
      !content ||
      typeof content !== "object" ||
      Array.isArray(content)
    ) {
      return fail("semantic_obligation_content_invalid", id)
    }

    const operationKind =
      typeof operation?.kind === "string"
        ? operation.kind
        : null

    if (operationKind === "python_declaration") {
      if (
        content.kind !== "python_units" ||
        !Array.isArray(content.units) ||
        content.units.length < 1
      ) {
        return fail(
          "semantic_obligation_python_units_invalid",
          id,
        )
      }
    } else if (operationKind === "replacement") {
      if (
        content.kind !== "text" ||
        !["before", "after", "replace"].includes(content.mode) ||
        typeof content.text !== "string" ||
        content.text.length < 1
      ) {
        return fail(
          "semantic_obligation_text_content_invalid",
          id,
        )
      }
    } else if (operationKind === "creation") {
      if (
        content.kind !== "text" ||
        content.mode !== "create" ||
        typeof content.text !== "string" ||
        content.text.length < 1
      ) {
        return fail(
          "semantic_obligation_text_content_invalid",
          id,
        )
      }
    } else {
      return fail(
        "semantic_obligation_operation_kind_invalid",
        operationKind ?? id,
        { id, operation_kind: operationKind },
      )
    }

    seen.add(id)
  }

  const missing = requiredIds.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    return fail(
      "semantic_obligation_coverage_incomplete",
      missing.join(","),
      { missing },
    )
  }

  return Object.freeze({
    ok: true,
    protocol: SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
    reason: "semantic_obligation_request_valid",
    contract_sha256: observedContractSha,
    capability_fingerprint_sha256: capabilitySha,
    attestation_sha256: expectedAttestationSha,
    required_operation_ids: requiredIds,
    coverage_complete: true,
    mutation_authority: false,
  })
}
