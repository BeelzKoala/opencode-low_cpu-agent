import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export const PYTHON_UNIT_CONTRACT_PROTOCOL =
  "python-unit-contract-v1"

const CONTRACT_URL =
  new URL("./python-unit-contract-v1.json", import.meta.url)

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const item of Object.values(value)) {
    deepFreeze(item)
  }
  return value
}

function canonical(value) {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === "object") {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical(value[key])
    }
    return out
  }
  return value
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ...extra,
    ok: false,
    protocol: PYTHON_UNIT_CONTRACT_PROTOCOL,
    reason,
    mutation_authority: false,
    model_authority_expansion: false,
  })
}

function loadContract() {
  let parsed
  try {
    parsed = JSON.parse(
      readFileSync(CONTRACT_URL, "utf8"),
    )
  } catch (error) {
    throw new Error(
      `python unit contract load failed: ${String(error?.message ?? error)}`,
    )
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.protocol !== PYTHON_UNIT_CONTRACT_PROTOCOL ||
    !Number.isInteger(parsed.max_units) ||
    parsed.max_units < 1 ||
    typeof parsed.identifier_pattern !== "string" ||
    !parsed.fields ||
    typeof parsed.fields !== "object" ||
    Array.isArray(parsed.fields) ||
    !parsed.kinds ||
    typeof parsed.kinds !== "object" ||
    Array.isArray(parsed.kinds)
  ) {
    throw new Error("python unit contract shape invalid")
  }

  const fieldNames = new Set(Object.keys(parsed.fields))
  const contexts = new Set(["top", "member"])

  for (const [kind, spec] of Object.entries(parsed.kinds)) {
    if (
      !kind ||
      !spec ||
      typeof spec !== "object" ||
      Array.isArray(spec) ||
      !Array.isArray(spec.contexts) ||
      spec.contexts.length < 1 ||
      spec.contexts.some((value) => !contexts.has(value)) ||
      !Array.isArray(spec.required) ||
      !Array.isArray(spec.optional)
    ) {
      throw new Error(`python unit contract kind invalid: ${kind}`)
    }

    const declared = [
      ...spec.required,
      ...spec.optional,
    ]
    if (
      new Set(declared).size !== declared.length ||
      !spec.required.includes("kind") ||
      !spec.required.includes("name") ||
      declared.some(
        (field) =>
          field !== "kind" &&
          !fieldNames.has(field),
      )
    ) {
      throw new Error(`python unit contract fields invalid: ${kind}`)
    }
  }

  return deepFreeze(parsed)
}

export const PYTHON_UNIT_CONTRACT = loadContract()

export const PYTHON_UNIT_CONTRACT_SHA256 =
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical(PYTHON_UNIT_CONTRACT),
      ),
    )
    .digest("hex")

export function pythonUnitKinds(context = "top") {
  return Object.freeze(
    Object.entries(PYTHON_UNIT_CONTRACT.kinds)
      .filter(([, spec]) =>
        spec.contexts.includes(context),
      )
      .map(([kind]) => kind),
  )
}

export function pythonUnitAllowedFields(kind) {
  const spec = PYTHON_UNIT_CONTRACT.kinds[kind]
  if (!spec) return null
  return Object.freeze([
    ...spec.required,
    ...spec.optional,
  ])
}

function fieldSchema(fieldName, spec) {
  if (spec.type === "identifier") {
    return {
      type: "string",
      pattern:
        PYTHON_UNIT_CONTRACT.identifier_pattern,
      maxLength: spec.max_length,
    }
  }

  if (spec.type === "string") {
    const schema = {
      type: "string",
      maxLength: spec.max_length,
    }
    if (Number.isInteger(spec.min_length)) {
      schema.minLength = spec.min_length
    }
    return schema
  }

  if (spec.type === "string_array") {
    const schema = {
      type: "array",
      maxItems: spec.max_items,
      items: {
        type: "string",
        minLength: spec.item_min_length ?? 0,
        maxLength: spec.item_max_length,
      },
    }
    if (Number.isInteger(spec.min_items)) {
      schema.minItems = spec.min_items
    }
    return schema
  }

  if (spec.type === "unit_array") {
    return {
      type: "array",
      minItems: spec.min_items,
      maxItems: spec.max_items,
      items: pythonUnitSchema({
        context: spec.context,
      }),
    }
  }

  throw new Error(
    `python unit contract field type unsupported: ${fieldName}:${spec.type}`,
  )
}

function variantSchema(kind) {
  const kindSpec =
    PYTHON_UNIT_CONTRACT.kinds[kind]
  if (!kindSpec) {
    throw new Error(
      `python unit contract kind unsupported: ${kind}`,
    )
  }

  const properties = {
    kind: {
      type: "string",
      enum: [kind],
    },
  }

  for (const field of [
    ...kindSpec.required,
    ...kindSpec.optional,
  ]) {
    if (field === "kind") continue
    properties[field] = fieldSchema(
      field,
      PYTHON_UNIT_CONTRACT.fields[field],
    )
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: [...kindSpec.required],
  }
}

export function pythonUnitSchema({
  context = "top",
} = {}) {
  const variants =
    pythonUnitKinds(context)
      .map(variantSchema)

  if (variants.length < 1) {
    throw new Error(
      `python unit contract context unsupported: ${context}`,
    )
  }

  return {
    oneOf: variants,
  }
}

function validateString(
  value,
  spec,
  {
    unitPath,
    kind,
    field,
  },
) {
  if (typeof value !== "string") {
    return fail(
      "python_unit_contract_field_type_invalid",
      {
        unit_path: unitPath,
        kind,
        field,
        expected_type: "string",
      },
    )
  }

  if (
    Number.isInteger(spec.min_length) &&
    value.length < spec.min_length
  ) {
    return fail(
      "python_unit_contract_field_length_invalid",
      {
        unit_path: unitPath,
        kind,
        field,
        min_length: spec.min_length,
      },
    )
  }

  if (
    Number.isInteger(spec.max_length) &&
    value.length > spec.max_length
  ) {
    return fail(
      "python_unit_contract_field_length_invalid",
      {
        unit_path: unitPath,
        kind,
        field,
        max_length: spec.max_length,
      },
    )
  }

  return Object.freeze({
    ok: true,
    protocol: PYTHON_UNIT_CONTRACT_PROTOCOL,
  })
}

function validateField(
  value,
  field,
  spec,
  {
    unitPath,
    kind,
  },
) {
  if (spec.type === "identifier") {
    const text = validateString(
      value,
      spec,
      {
        unitPath,
        kind,
        field,
      },
    )
    if (text.ok !== true) return text

    const expression = new RegExp(
      PYTHON_UNIT_CONTRACT.identifier_pattern,
      "u",
    )
    if (!expression.test(value)) {
      return fail(
        "python_unit_contract_identifier_invalid",
        {
          unit_path: unitPath,
          kind,
          field,
        },
      )
    }
    return text
  }

  if (spec.type === "string") {
    return validateString(
      value,
      spec,
      {
        unitPath,
        kind,
        field,
      },
    )
  }

  if (spec.type === "string_array") {
    if (!Array.isArray(value)) {
      return fail(
        "python_unit_contract_field_type_invalid",
        {
          unit_path: unitPath,
          kind,
          field,
          expected_type: "string_array",
        },
      )
    }

    if (
      Number.isInteger(spec.min_items) &&
      value.length < spec.min_items
    ) {
      return fail(
        "python_unit_contract_array_length_invalid",
        {
          unit_path: unitPath,
          kind,
          field,
          min_items: spec.min_items,
        },
      )
    }

    if (
      Number.isInteger(spec.max_items) &&
      value.length > spec.max_items
    ) {
      return fail(
        "python_unit_contract_array_length_invalid",
        {
          unit_path: unitPath,
          kind,
          field,
          max_items: spec.max_items,
        },
      )
    }

    for (
      let index = 0;
      index < value.length;
      index += 1
    ) {
      const item = validateString(
        value[index],
        {
          min_length:
            spec.item_min_length ?? 0,
          max_length:
            spec.item_max_length,
        },
        {
          unitPath,
          kind,
          field:
            `${field}[${index}]`,
        },
      )
      if (item.ok !== true) return item
    }

    return Object.freeze({
      ok: true,
      protocol: PYTHON_UNIT_CONTRACT_PROTOCOL,
    })
  }

  if (spec.type === "unit_array") {
    if (!Array.isArray(value)) {
      return fail(
        "python_unit_contract_field_type_invalid",
        {
          unit_path: unitPath,
          kind,
          field,
          expected_type: "unit_array",
        },
      )
    }

    if (
      value.length < spec.min_items ||
      value.length > spec.max_items
    ) {
      return fail(
        "python_unit_contract_array_length_invalid",
        {
          unit_path: unitPath,
          kind,
          field,
          min_items: spec.min_items,
          max_items: spec.max_items,
        },
      )
    }

    for (
      let index = 0;
      index < value.length;
      index += 1
    ) {
      const nested =
        validatePythonUnitContract(
          value[index],
          {
            context: spec.context,
            unitPath: [
              ...unitPath,
              index,
            ],
          },
        )
      if (nested.ok !== true) {
        return nested
      }
    }

    return Object.freeze({
      ok: true,
      protocol: PYTHON_UNIT_CONTRACT_PROTOCOL,
    })
  }

  return fail(
    "python_unit_contract_field_spec_invalid",
    {
      unit_path: unitPath,
      kind,
      field,
      observed_type: spec.type ?? null,
    },
  )
}

export function validatePythonUnitContract(
  unit,
  {
    context = "top",
    unitPath = [],
  } = {},
) {
  if (
    !unit ||
    typeof unit !== "object" ||
    Array.isArray(unit)
  ) {
    return fail(
      "python_unit_contract_shape_invalid",
      {
        unit_path: unitPath,
      },
    )
  }

  const kind =
    typeof unit.kind === "string"
      ? unit.kind
      : null
  const kindSpec =
    kind
      ? PYTHON_UNIT_CONTRACT.kinds[kind]
      : null

  if (
    !kindSpec ||
    !kindSpec.contexts.includes(context)
  ) {
    return fail(
      "python_unit_contract_kind_invalid",
      {
        unit_path: unitPath,
        kind,
        context,
        allowed_kinds:
          pythonUnitKinds(context),
        field: "kind",
      },
    )
  }

  const allowed =
    pythonUnitAllowedFields(kind)
  const allowedSet = new Set(allowed)
  const actual = Object.keys(unit)
  const unexpected = actual
    .filter((field) => !allowedSet.has(field))
    .sort()

  if (unexpected.length > 0) {
    return fail(
      "python_unit_contract_fields_invalid",
      {
        unit_path: unitPath,
        kind,
        context,
        field: unexpected[0],
        unexpected_fields:
          Object.freeze(
            unexpected.slice(0, 8),
          ),
        allowed_fields: allowed,
      },
    )
  }

  const missing =
    kindSpec.required
      .filter(
        (field) =>
          !Object.hasOwn(unit, field),
      )
      .sort()

  if (missing.length > 0) {
    return fail(
      "python_unit_contract_required_field_missing",
      {
        unit_path: unitPath,
        kind,
        context,
        field: missing[0],
        missing_fields:
          Object.freeze(
            missing.slice(0, 8),
          ),
        allowed_fields: allowed,
      },
    )
  }

  for (const field of actual) {
    if (field === "kind") continue
    const fieldSpec =
      PYTHON_UNIT_CONTRACT.fields[field]
    if (!fieldSpec) {
      return fail(
        "python_unit_contract_field_spec_missing",
        {
          unit_path: unitPath,
          kind,
          field,
        },
      )
    }

    const checked =
      validateField(
        unit[field],
        field,
        fieldSpec,
        {
          unitPath,
          kind,
        },
      )
    if (checked.ok !== true) {
      return checked
    }
  }

  return Object.freeze({
    ok: true,
    protocol: PYTHON_UNIT_CONTRACT_PROTOCOL,
    contract_sha256:
      PYTHON_UNIT_CONTRACT_SHA256,
    unit_path: unitPath,
    kind,
    context,
    mutation_authority: false,
    model_authority_expansion: false,
  })
}

export function validatePythonUnitsContract(
  units,
) {
  if (!Array.isArray(units)) {
    return fail(
      "python_unit_contract_units_invalid",
      {
        field: "units",
      },
    )
  }

  if (
    units.length < 1 ||
    units.length >
      PYTHON_UNIT_CONTRACT.max_units
  ) {
    return fail(
      "python_unit_contract_units_length_invalid",
      {
        field: "units",
        max_units:
          PYTHON_UNIT_CONTRACT.max_units,
      },
    )
  }

  for (
    let index = 0;
    index < units.length;
    index += 1
  ) {
    const checked =
      validatePythonUnitContract(
        units[index],
        {
          context: "top",
          unitPath: [index],
        },
      )
    if (checked.ok !== true) {
      return checked
    }
  }

  return Object.freeze({
    ok: true,
    protocol: PYTHON_UNIT_CONTRACT_PROTOCOL,
    contract_sha256:
      PYTHON_UNIT_CONTRACT_SHA256,
    units: units.length,
    mutation_authority: false,
    model_authority_expansion: false,
  })
}

export function projectPythonUnitContractFailure(
  result,
) {
  if (!result || result.ok === true) {
    return null
  }

  return Object.freeze({
    protocol:
      result.protocol ??
      PYTHON_UNIT_CONTRACT_PROTOCOL,
    reason: result.reason ?? null,
    unit_path:
      Array.isArray(result.unit_path)
        ? result.unit_path.slice(0, 8)
        : [],
    kind:
      typeof result.kind === "string"
        ? result.kind
        : null,
    field:
      typeof result.field === "string"
        ? result.field
        : null,
    unexpected_fields:
      Array.isArray(result.unexpected_fields)
        ? result.unexpected_fields.slice(0, 8)
        : [],
    missing_fields:
      Array.isArray(result.missing_fields)
        ? result.missing_fields.slice(0, 8)
        : [],
    allowed_fields:
      Array.isArray(result.allowed_fields)
        ? result.allowed_fields.slice(0, 16)
        : [],
    mutation_authority: false,
  })
}
