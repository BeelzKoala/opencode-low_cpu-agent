import {
  resolveStructuredOutputRuntimePolicy,
} from "./structured-output-runtime-policy-v1.mjs"

import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"

export const DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL =
  "deterministic-argument-synthesis-v1"

export const DETERMINISTIC_ARGUMENT_SYNTHESIS_AUTHORITY =
  "deterministic_action_semantic_arguments_only"

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
}

function schemaBinding(tool) {
  if (!tool || typeof tool !== "object") return null

  for (const key of [
    "inputSchema",
    "input_schema",
    "parameters",
    "input",
    "schema",
    "jsonSchema",
    "json_schema",
  ]) {
    if (tool[key] && typeof tool[key] === "object") {
      return {
        path: [key],
        schema: tool[key],
      }
    }
  }

  if (tool.function && typeof tool.function === "object") {
    for (const key of ["parameters", "inputSchema", "input_schema"]) {
      if (
        tool.function[key] &&
        typeof tool.function[key] === "object"
      ) {
        return {
          path: ["function", key],
          schema: tool.function[key],
        }
      }
    }
  }

  return null
}

function selectedToolName(tool) {
  if (typeof tool?.name === "string" && tool.name) {
    return tool.name
  }
  if (
    typeof tool?.function?.name === "string" &&
    tool.function.name
  ) {
    return tool.function.name
  }
  return null
}

function replaceBoundSchema(tool, binding, schema) {
  const out = cloneJson(tool)

  if (binding.path.length === 1) {
    out[binding.path[0]] = cloneJson(schema)
    return out
  }

  out[binding.path[0]][binding.path[1]] = cloneJson(schema)
  return out
}

function constantValue(schema) {
  if (!schema || typeof schema !== "object") {
    return { fixed: false, value: undefined }
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    return { fixed: true, value: cloneJson(schema.const) }
  }

  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    return { fixed: true, value: cloneJson(schema.enum[0]) }
  }

  return { fixed: false, value: undefined }
}

/*
 * Partial-object synthesis is deliberately conservative.
 *
 * The compiler may remove a field from model authority only when the JSON
 * schema itself proves its value (const or singleton enum). Objects recurse.
 * Arrays remain model-facing unless a later benchmark proves a positional
 * projection safe; array order is often semantic in mutation protocols.
 */
function projectNode(schema) {
  const source = cloneJson(schema)
  const constant = constantValue(source)

  if (constant.fixed) {
    return {
      fully_fixed: true,
      fixed_value: constant.value,
      model_schema: null,
      plan: { kind: "fixed", value: constant.value },
      fixed_fields: 1,
      model_fields: 0,
    }
  }

  if (
    source?.type === "object" &&
    source.properties &&
    typeof source.properties === "object" &&
    !Array.isArray(source.properties)
  ) {
    const required = new Set(
      Array.isArray(source.required) ? source.required : [],
    )
    const modelProperties = {}
    const modelRequired = []
    const children = {}
    let fixedFields = 0
    let modelFields = 0

    for (const key of Object.keys(source.properties)) {
      const child = projectNode(source.properties[key])
      children[key] = child.plan
      fixedFields += child.fixed_fields
      modelFields += child.model_fields

      if (!child.fully_fixed) {
        modelProperties[key] = child.model_schema
        if (required.has(key)) modelRequired.push(key)
      }
    }

    const dynamicKeys = Object.keys(modelProperties)

    if (
      dynamicKeys.length === 0 &&
      source.additionalProperties === false
    ) {
      const fixed = {}
      for (const key of Object.keys(children)) {
        const child = children[key]
        if (child.kind !== "fixed") {
          return {
            fully_fixed: false,
            fixed_value: undefined,
            model_schema: source,
            plan: { kind: "passthrough" },
            fixed_fields: 0,
            model_fields: 1,
          }
        }
        fixed[key] = cloneJson(child.value)
      }

      return {
        fully_fixed: true,
        fixed_value: fixed,
        model_schema: null,
        plan: { kind: "fixed", value: fixed },
        fixed_fields: Math.max(fixedFields, 1),
        model_fields: 0,
      }
    }

    const modelSchema = {
      ...source,
      properties: modelProperties,
    }

    if (modelRequired.length > 0) {
      modelSchema.required = modelRequired
    } else {
      delete modelSchema.required
    }

    return {
      fully_fixed: false,
      fixed_value: undefined,
      model_schema: modelSchema,
      plan: { kind: "object", children },
      fixed_fields: fixedFields,
      model_fields: Math.max(modelFields, dynamicKeys.length),
    }
  }

  return {
    fully_fixed: false,
    fixed_value: undefined,
    model_schema: source,
    plan: { kind: "passthrough" },
    fixed_fields: 0,
    model_fields: 1,
  }
}


const PROVIDER_SAFE_MODEL_SCHEMA_PROTOCOL =
  "provider-safe-model-schema-v1"

const PROVIDER_SAFE_ANNOTATION_KEYS =
  new Set([
    "description",
    "title",
    "$comment",
    "default",
    "examples",
  ])

const PROVIDER_SAFE_RELAXED_KEYS =
  new Set([
    "pattern",
  ])

function providerSafeFail(
  reason,
  path = [],
  detail = null,
) {
  return Object.freeze({
    ok: false,
    protocol:
      PROVIDER_SAFE_MODEL_SCHEMA_PROTOCOL,
    reason,
    path: [...path],
    detail,
    semantic_authority: false,
    mutation_authority: false,
  })
}

function providerSafePrimitive(value) {
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? "integer"
      : "number"
  }
  if (value === null) return "null"
  return null
}

function providerSafeSortedUnique(values) {
  return [
    ...new Set(
      values.map((value) =>
        JSON.stringify(value)
      ),
    ),
  ]
    .sort()
    .map((value) => JSON.parse(value))
}

function providerSafeSameJson(a, b) {
  return stableSha(a) === stableSha(b)
}

function providerSafeFixedValue(schema) {
  if (
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema)
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        schema,
        "const",
      )
    ) {
      return {
        fixed: true,
        value: cloneJson(schema.const),
      }
    }
    if (
      Array.isArray(schema.enum) &&
      schema.enum.length === 1
    ) {
      return {
        fixed: true,
        value: cloneJson(schema.enum[0]),
      }
    }
  }
  return {
    fixed: false,
    value: undefined,
  }
}

function providerSafeProjectNode(
  schema,
  path,
  stats,
) {
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return providerSafeFail(
      "provider_schema_node_invalid",
      path,
    )
  }

  const unionKey =
    Array.isArray(schema.oneOf)
      ? "oneOf"
      : Array.isArray(schema.anyOf)
        ? "anyOf"
        : null

  if (unionKey != null) {
    const allowedAtUnion =
      new Set([
        unionKey,
        "description",
        "title",
        "$comment",
      ])
    const unexpected =
      Object.keys(schema).filter(
        (key) => !allowedAtUnion.has(key),
      )
    if (unexpected.length > 0) {
      return providerSafeFail(
        "provider_schema_union_siblings_unsupported",
        path,
        unexpected.sort(),
      )
    }

    const branches = schema[unionKey]
    if (
      branches.length < 2 ||
      branches.length > 8
    ) {
      return providerSafeFail(
        "provider_schema_union_cardinality_unsupported",
        path,
        branches.length,
      )
    }

    const projected = []
    for (
      let index = 0;
      index < branches.length;
      index += 1
    ) {
      const branch =
        providerSafeProjectNode(
          branches[index],
          [...path, unionKey, index],
          stats,
        )
      if (branch.ok !== true) return branch
      projected.push(branch.schema)
    }

    if (
      projected.some(
        (branch) =>
          branch?.type !== "object" ||
          !branch.properties ||
          typeof branch.properties !==
            "object" ||
          Array.isArray(branch.properties),
      )
    ) {
      return providerSafeFail(
        "provider_schema_union_non_object",
        path,
      )
    }

    const first = projected[0]
    const firstKeys =
      Object.keys(first.properties).sort()
    const firstRequiredOriginal =
      Array.isArray(first.required)
        ? [...first.required]
        : []
    const firstRequired =
      [...firstRequiredOriginal].sort()
    const firstAdditional =
      first.additionalProperties === false

    for (
      let index = 1;
      index < projected.length;
      index += 1
    ) {
      const branch = projected[index]
      const keys =
        Object.keys(branch.properties).sort()
      const required =
        Array.isArray(branch.required)
          ? [...branch.required].sort()
          : []
      if (
        !providerSafeSameJson(
          keys,
          firstKeys,
        ) ||
        !providerSafeSameJson(
          required,
          firstRequired,
        ) ||
        (
          branch.additionalProperties ===
            false
        ) !== firstAdditional
      ) {
        return providerSafeFail(
          "provider_schema_union_shape_mismatch",
          path,
        )
      }
    }

    const mergedProperties = {}
    let discriminatorCount = 0

    for (const key of firstKeys) {
      const values =
        projected.map(
          (branch) =>
            branch.properties[key],
        )
      if (
        values.every(
          (value) =>
            providerSafeSameJson(
              value,
              values[0],
            ),
        )
      ) {
        mergedProperties[key] =
          cloneJson(values[0])
        continue
      }

      const fixed =
        values.map(
          providerSafeFixedValue,
        )
      if (
        fixed.some(
          (entry) => entry.fixed !== true,
        )
      ) {
        return providerSafeFail(
          "provider_schema_union_non_discriminator_difference",
          [...path, "properties", key],
        )
      }

      const primitiveKinds =
        fixed.map((entry) =>
          providerSafePrimitive(entry.value)
        )
      const primitive =
        primitiveKinds[0]
      if (
        primitive == null ||
        primitiveKinds.some(
          (kind) => kind !== primitive,
        )
      ) {
        return providerSafeFail(
          "provider_schema_union_discriminator_type_mismatch",
          [...path, "properties", key],
        )
      }

      discriminatorCount += 1
      if (discriminatorCount > 1) {
        return providerSafeFail(
          "provider_schema_union_multiple_discriminators",
          path,
        )
      }

      mergedProperties[key] = {
        type: primitive,
        enum: providerSafeSortedUnique(
          fixed.map((entry) => entry.value),
        ),
      }
    }

    if (discriminatorCount !== 1) {
      return providerSafeFail(
        "provider_schema_union_discriminator_missing",
        path,
      )
    }

    stats.flattened_unions += 1

    const merged = {
      type: "object",
      properties: mergedProperties,
    }
    if (firstRequiredOriginal.length > 0) {
      merged.required =
        [...new Set(firstRequiredOriginal)]
    }
    if (firstAdditional) {
      merged.additionalProperties = false
    }

    return {
      ok: true,
      schema: merged,
    }
  }

  const fixed =
    providerSafeFixedValue(schema)
  if (fixed.fixed) {
    const primitive =
      providerSafePrimitive(fixed.value)
    if (primitive == null) {
      return providerSafeFail(
        "provider_schema_const_type_unsupported",
        path,
      )
    }
    return {
      ok: true,
      schema: {
        type: primitive,
        enum: [cloneJson(fixed.value)],
      },
    }
  }

  const type = schema.type

  if (type === "object") {
    if (
      !schema.properties ||
      typeof schema.properties !==
        "object" ||
      Array.isArray(schema.properties)
    ) {
      return providerSafeFail(
        "provider_schema_object_properties_invalid",
        path,
      )
    }

    const allowed =
      new Set([
        "type",
        "properties",
        "required",
        "additionalProperties",
        ...PROVIDER_SAFE_ANNOTATION_KEYS,
      ])
    const unexpected =
      Object.keys(schema).filter(
        (key) => !allowed.has(key),
      )
    if (unexpected.length > 0) {
      return providerSafeFail(
        "provider_schema_object_keyword_unsupported",
        path,
        unexpected.sort(),
      )
    }

    if (
      schema.additionalProperties != null &&
      schema.additionalProperties !== false
    ) {
      return providerSafeFail(
        "provider_schema_additional_properties_unsupported",
        path,
      )
    }

    const properties = {}
    for (
      const key of
      Object.keys(schema.properties).sort()
    ) {
      const child =
        providerSafeProjectNode(
          schema.properties[key],
          [...path, "properties", key],
          stats,
        )
      if (child.ok !== true) return child
      properties[key] = child.schema
    }

    const required =
      Array.isArray(schema.required)
        ? [...schema.required]
        : []
    if (
      required.some(
        (key) =>
          typeof key !== "string" ||
          !Object.prototype.hasOwnProperty.call(
            properties,
            key,
          ),
      )
    ) {
      return providerSafeFail(
        "provider_schema_required_invalid",
        path,
      )
    }

    for (const key of Object.keys(schema)) {
      if (
        PROVIDER_SAFE_ANNOTATION_KEYS.has(
          key,
        )
      ) {
        stats.dropped_annotations += 1
      }
    }

    const out = {
      type: "object",
      properties,
    }
    if (required.length > 0) {
      out.required =
        [...new Set(required)]
    }
    if (
      schema.additionalProperties === false
    ) {
      out.additionalProperties = false
    }
    return {
      ok: true,
      schema: out,
    }
  }

  if (type === "array") {
    const allowed =
      new Set([
        "type",
        "items",
        "minItems",
        "maxItems",
        ...PROVIDER_SAFE_ANNOTATION_KEYS,
      ])
    const unexpected =
      Object.keys(schema).filter(
        (key) => !allowed.has(key),
      )
    if (unexpected.length > 0) {
      return providerSafeFail(
        "provider_schema_array_keyword_unsupported",
        path,
        unexpected.sort(),
      )
    }
    if (
      !schema.items ||
      typeof schema.items !== "object" ||
      Array.isArray(schema.items)
    ) {
      return providerSafeFail(
        "provider_schema_array_items_invalid",
        path,
      )
    }

    const child =
      providerSafeProjectNode(
        schema.items,
        [...path, "items"],
        stats,
      )
    if (child.ok !== true) return child

    const out = {
      type: "array",
      items: child.schema,
    }
    for (
      const key of ["minItems", "maxItems"]
    ) {
      if (schema[key] != null) {
        if (
          !Number.isSafeInteger(schema[key]) ||
          schema[key] < 0
        ) {
          return providerSafeFail(
            "provider_schema_array_bound_invalid",
            [...path, key],
          )
        }
        out[key] = schema[key]
      }
    }
    if (
      out.minItems != null &&
      out.maxItems != null &&
      out.minItems > out.maxItems
    ) {
      return providerSafeFail(
        "provider_schema_array_bounds_inverted",
        path,
      )
    }

    for (const key of Object.keys(schema)) {
      if (
        PROVIDER_SAFE_ANNOTATION_KEYS.has(
          key,
        )
      ) {
        stats.dropped_annotations += 1
      }
    }

    return {
      ok: true,
      schema: out,
    }
  }

  const scalarTypes =
    new Set([
      "string",
      "integer",
      "number",
      "boolean",
      "null",
    ])

  if (!scalarTypes.has(type)) {
    return providerSafeFail(
      "provider_schema_type_unsupported",
      path,
      type ?? null,
    )
  }

  const allowed =
    new Set([
      "type",
      "enum",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      ...PROVIDER_SAFE_ANNOTATION_KEYS,
      ...PROVIDER_SAFE_RELAXED_KEYS,
    ])
  const unexpected =
    Object.keys(schema).filter(
      (key) => !allowed.has(key),
    )
  if (unexpected.length > 0) {
    return providerSafeFail(
      "provider_schema_scalar_keyword_unsupported",
      path,
      unexpected.sort(),
    )
  }

  const out = { type }

  if (schema.enum != null) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length < 1 ||
      schema.enum.length > 64
    ) {
      return providerSafeFail(
        "provider_schema_enum_invalid",
        path,
      )
    }
    const enumValues =
      providerSafeSortedUnique(schema.enum)
    if (
      enumValues.some(
        (value) =>
          providerSafePrimitive(value) !== type &&
          !(
            type === "number" &&
            providerSafePrimitive(value) ===
              "integer"
          ),
      )
    ) {
      return providerSafeFail(
        "provider_schema_enum_type_mismatch",
        path,
      )
    }
    out.enum = enumValues
  }

  for (
    const key of ["minLength", "maxLength"]
  ) {
    if (schema[key] != null) {
      if (
        type !== "string" ||
        !Number.isSafeInteger(schema[key]) ||
        schema[key] < 0
      ) {
        return providerSafeFail(
          "provider_schema_string_bound_invalid",
          [...path, key],
        )
      }
      out[key] = schema[key]
    }
  }

  for (
    const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ]
  ) {
    if (schema[key] != null) {
      if (
        !(
          type === "integer" ||
          type === "number"
        ) ||
        typeof schema[key] !== "number" ||
        !Number.isFinite(schema[key])
      ) {
        return providerSafeFail(
          "provider_schema_numeric_bound_invalid",
          [...path, key],
        )
      }
      out[key] = schema[key]
    }
  }

  if (
    out.minLength != null &&
    out.maxLength != null &&
    out.minLength > out.maxLength
  ) {
    return providerSafeFail(
      "provider_schema_string_bounds_inverted",
      path,
    )
  }

  if (
    Object.prototype.hasOwnProperty.call(
      schema,
      "pattern",
    )
  ) {
    if (
      type !== "string" ||
      typeof schema.pattern !== "string"
    ) {
      return providerSafeFail(
        "provider_schema_pattern_invalid",
        [...path, "pattern"],
      )
    }
    stats.dropped_patterns += 1
  }

  for (const key of Object.keys(schema)) {
    if (
      PROVIDER_SAFE_ANNOTATION_KEYS.has(key)
    ) {
      stats.dropped_annotations += 1
    }
  }

  return {
    ok: true,
    schema: out,
  }
}

const PROVIDER_GRAMMAR_LITERAL_REPETITION_LIMIT =
  2000

function relaxProviderGrammarRepetitionBounds(
  value,
  stats,
) {
  if (Array.isArray(value)) {
    for (const child of value) {
      relaxProviderGrammarRepetitionBounds(
        child,
        stats,
      )
    }
    return
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return
  }

  for (
    const key of [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
    ]
  ) {
    if (
      Number.isSafeInteger(value[key]) &&
      value[key] >=
        PROVIDER_GRAMMAR_LITERAL_REPETITION_LIMIT
    ) {
      delete value[key]
      stats
        .dropped_oversized_repetition_bounds +=
        1
    }
  }

  for (const child of Object.values(value)) {
    relaxProviderGrammarRepetitionBounds(
      child,
      stats,
    )
  }
}

export function compileProviderSafeModelSchema(
  schema,
) {
  const stats = {
    flattened_unions: 0,
    dropped_patterns: 0,
    dropped_annotations: 0,
    dropped_oversized_repetition_bounds: 0,
  }

  const projected =
    providerSafeProjectNode(
      schema,
      [],
      stats,
    )

  if (projected.ok !== true) {
    return projected
  }

  /*
   * Wire-only relaxation for llama.cpp grammar compilation.
   * Canonical schema validation remains authoritative after generation.
   */
  const providerSchema =
    cloneJson(projected.schema)

  relaxProviderGrammarRepetitionBounds(
    providerSchema,
    stats,
  )

  const sourceSha =
    stableSha(schema)
  const projectedSha =
    stableSha(providerSchema)

  return Object.freeze({
    ok: true,
    protocol:
      PROVIDER_SAFE_MODEL_SCHEMA_PROTOCOL,
    reason:
      "provider_safe_schema_projected",
    schema:
      cloneJson(providerSchema),
    source_schema_sha256:
      sourceSha,
    projected_schema_sha256:
      projectedSha,
    flattened_unions:
      stats.flattened_unions,
    dropped_patterns:
      stats.dropped_patterns,
    dropped_annotations:
      stats.dropped_annotations,
    dropped_oversized_repetition_bounds:
      stats
        .dropped_oversized_repetition_bounds,
    generation_constraints_relaxed:
      stats.dropped_patterns > 0 ||
      stats
        .dropped_oversized_repetition_bounds >
        0,
    semantic_authority: false,
    canonical_validation_required: true,
    mutation_authority: false,
  })
}

function resolveProviderSafeModelSchema(
  plan,
) {
  if (
    !plan?.model_schema ||
    typeof plan.model_schema !== "object" ||
    Array.isArray(plan.model_schema)
  ) {
    return providerSafeFail(
      "provider_schema_model_schema_invalid",
      [],
    )
  }

  const hasProjectionMetadata =
    plan.provider_schema_projection != null
  const hasProjectedSchema =
    plan.provider_model_schema != null
  const hasExplicitProviderState =
    hasProjectionMetadata ||
    hasProjectedSchema

  if (hasExplicitProviderState) {
    if (
      plan?.provider_schema_projection?.ok !== true ||
      !plan?.provider_model_schema ||
      typeof plan.provider_model_schema !== "object" ||
      Array.isArray(plan.provider_model_schema)
    ) {
      return providerSafeFail(
        "provider_schema_explicit_projection_unavailable",
        [],
      )
    }

    return Object.freeze({
      ok: true,
      protocol:
        PROVIDER_SAFE_MODEL_SCHEMA_PROTOCOL,
      reason:
        "provider_safe_schema_precompiled",
      source: "precompiled_plan",
      schema: cloneJson(
        plan.provider_model_schema,
      ),
      source_schema_sha256:
        stableSha(plan.model_schema),
      projected_schema_sha256:
        stableSha(
          plan.provider_model_schema,
        ),
      semantic_authority: false,
      canonical_validation_required: true,
      mutation_authority: false,
    })
  }

  const compiled =
    compileProviderSafeModelSchema(
      plan.model_schema,
    )
  if (compiled.ok !== true) {
    return compiled
  }

  return Object.freeze({
    ...compiled,
    reason:
      "provider_safe_schema_legacy_inline_projection",
    source: "legacy_inline_projection",
  })
}

function mergeByPlan(plan, modelValue) {
  if (!plan || typeof plan !== "object") {
    throw new Error("ARG_SYNTH merge_plan_invalid")
  }

  if (plan.kind === "fixed") return cloneJson(plan.value)
  if (plan.kind === "passthrough") return cloneJson(modelValue)

  if (plan.kind === "object") {
    if (
      !modelValue ||
      typeof modelValue !== "object" ||
      Array.isArray(modelValue)
    ) {
      throw new Error("ARG_SYNTH model_object_invalid")
    }

    const out = {}

    for (const key of Object.keys(plan.children)) {
      const child = plan.children[key]
      if (child.kind === "fixed") {
        out[key] = mergeByPlan(child, undefined)
      } else if (
        Object.prototype.hasOwnProperty.call(modelValue, key)
      ) {
        out[key] = mergeByPlan(child, modelValue[key])
      }
    }

    // Preserve optional/additional dynamic fields. Existing tool-schema and
    // semantic validators remain the final mutation authority.
    for (const key of Object.keys(modelValue)) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) {
        out[key] = cloneJson(modelValue[key])
      }
    }

    return out
  }

  throw new Error("ARG_SYNTH merge_plan_kind_invalid")
}

export function compileArgumentSynthesisPlan(tool) {
  const selectedTool = selectedToolName(tool)
  const binding = schemaBinding(tool)

  if (!selectedTool) {
    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      active: false,
      reason: "selected_tool_name_unavailable",
      selected_tool: null,
      model_action_authority: false,
    })
  }

  if (!binding) {
    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      active: false,
      reason: "selected_tool_schema_unavailable",
      selected_tool: selectedTool,
      model_action_authority: false,
    })
  }

  const projected = projectNode(binding.schema)
  const providerSchemaProjection =
    projected.fully_fixed
      ? null
      : compileProviderSafeModelSchema(
          projected.model_schema,
        )
  const modelTool = projected.fully_fixed
    ? null
    : replaceBoundSchema(tool, binding, projected.model_schema)

  return Object.freeze({
    protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
    authority: DETERMINISTIC_ARGUMENT_SYNTHESIS_AUTHORITY,
    active: true,
    reason: projected.fully_fixed
      ? "arguments_fully_deterministic"
      : "semantic_arguments_required",
    selected_tool: selectedTool,
    schema_sha256: stableSha(binding.schema),
    full_schema: cloneJson(binding.schema),
    model_schema: projected.fully_fixed
      ? null
      : cloneJson(projected.model_schema),
    provider_model_schema:
      providerSchemaProjection?.ok === true
        ? cloneJson(
            providerSchemaProjection.schema,
          )
        : null,
    provider_schema_projection:
      providerSchemaProjection == null
        ? null
        : Object.freeze({
            ...providerSchemaProjection,
            schema: undefined,
          }),
    model_tool: modelTool,
    merge_plan: projected.plan,
    fixed_fields: projected.fixed_fields,
    model_fields: projected.model_fields,
    zero_inference: projected.fully_fixed === true,
    model_action_authority: false,
    model_argument_authority: projected.fully_fixed
      ? "none"
      : "semantic_holes_only",
    generated_tool_name_bytes: 0,
  })
}

function openAICompatibleProviderOptionsKey(language) {
  const provider =
    typeof language?.provider === "string"
      ? language.provider.trim()
      : ""

  if (provider.length < 1 || provider.length > 256) {
    return null
  }

  const key = provider.split(".")[0]?.trim() ?? ""

  if (
    key.length < 1 ||
    key.length > 128 ||
    /[\x00-\x1f\x7f]/u.test(key)
  ) {
    return null
  }

  return key
}

export function selectArgumentSynthesisTransport(language, plan) {
  if (plan?.active !== true) {
    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      mode: "required_singleton_tool",
      reason: "schema_projection_unavailable",
      constrained_generation: true,
      zero_inference: false,
      backend: null,
      runtime_policy: null,
      wire_mode: null,
      provider_options_key: null,
    })
  }

  if (plan.zero_inference === true) {
    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      mode: "zero_inference",
      reason: "arguments_fully_deterministic",
      constrained_generation: true,
      zero_inference: true,
      backend: "deterministic",
      runtime_policy: null,
      wire_mode: "none",
      provider_options_key: null,
    })
  }

  const runtimePolicy =
    resolveStructuredOutputRuntimePolicy(
      language,
    )

  if (runtimePolicy.active === true) {
    if (runtimePolicy.backend === "llguidance") {
      const providerOptionsKey =
        openAICompatibleProviderOptionsKey(
          language,
        )

      if (providerOptionsKey == null) {
        return Object.freeze({
          protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
          mode: "required_singleton_tool",
          reason:
            "llguidance_openai_compatible_provider_key_unavailable",
          constrained_generation: true,
          zero_inference: false,
          backend: null,
          runtime_policy: runtimePolicy,
          wire_mode: null,
          provider_options_key: null,
        })
      }

      return Object.freeze({
        protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
        mode: "json_schema",
        reason: runtimePolicy.reason,
        constrained_generation: true,
        zero_inference: false,
        backend: "llguidance",
        runtime_policy: runtimePolicy,
        wire_mode:
          "openai_compatible_raw_json_schema",
        provider_options_key:
          providerOptionsKey,
      })
    }

    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      mode: "json_schema",
      reason: runtimePolicy.reason,
      constrained_generation: true,
      zero_inference: false,
      backend: runtimePolicy.backend,
      runtime_policy: runtimePolicy,
      wire_mode: "provider_native",
      provider_options_key: null,
    })
  }

  return Object.freeze({
    protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
    mode: "required_singleton_tool",
    reason: "structured_outputs_unavailable_required_tool_fallback",
    constrained_generation: true,
    zero_inference: false,
    backend: null,
    runtime_policy: runtimePolicy,
    wire_mode: null,
    provider_options_key: null,
  })
}


const PROVIDER_SCHEMA_DIAGNOSTIC_PROTOCOL =
  "provider-schema-wire-identity-v1"
const PROVIDER_SCHEMA_DIAGNOSTIC_ENV =
  "OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC"
const PROVIDER_SCHEMA_DIAGNOSTIC_PATH_ENV =
  "OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC_PATH"

function providerSchemaKeywordCounts(schema) {
  const counts = {
    oneOf: 0,
    anyOf: 0,
    pattern: 0,
    const: 0,
    enum: 0,
    additionalProperties: 0,
    minLength: 0,
    maxLength: 0,
    minItems: 0,
    maxItems: 0,
  }

  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    if (!value || typeof value !== "object") return

    for (const [key, child] of Object.entries(value)) {
      if (
        Object.prototype.hasOwnProperty.call(
          counts,
          key,
        )
      ) {
        counts[key] += 1
      }
      walk(child)
    }
  }

  walk(schema)
  return counts
}

function emitLlGuidanceProviderSchemaDiagnostic({
  contract,
  plan,
  transport,
  resolvedProviderSchema,
  schema,
  responseFormat,
} = {}) {
  if (
    process?.env?.[
      PROVIDER_SCHEMA_DIAGNOSTIC_ENV
    ] !== "1"
  ) {
    return
  }

  const schemaSha = stableSha(schema)
  const providerProjectionSha =
    plan?.provider_schema_projection
      ?.projected_schema_sha256 ??
    (
      plan?.provider_model_schema
        ? stableSha(plan.provider_model_schema)
        : null
    )

  const record = {
    protocol:
      PROVIDER_SCHEMA_DIAGNOSTIC_PROTOCOL,
    authority: "observation_only",
    selected_tool:
      contract?.selected_tool ?? null,
    backend:
      transport?.backend ?? null,
    wire_mode:
      transport?.wire_mode ?? null,
    provider_options_key:
      transport?.provider_options_key ?? null,
    resolved_source:
      resolvedProviderSchema?.source ?? null,
    resolved_reason:
      resolvedProviderSchema?.reason ?? null,
    schema_sha256: schemaSha,
    schema_bytes:
      Buffer.byteLength(
        JSON.stringify(schema),
        "utf8",
      ),
    provider_projection_sha256:
      providerProjectionSha,
    provider_projection_match:
      typeof providerProjectionSha === "string"
        ? schemaSha === providerProjectionSha
        : null,
    model_schema_sha256:
      plan?.model_schema
        ? stableSha(plan.model_schema)
        : null,
    model_schema_match:
      plan?.model_schema
        ? schemaSha ===
          stableSha(plan.model_schema)
        : null,
    generic_response_format_type:
      responseFormat?.type ?? null,
    raw_response_format_type:
      "json_schema",
    strict: true,
    keyword_counts:
      providerSchemaKeywordCounts(schema),
    schema,
    semantic_authority: false,
    mutation_authority: false,
  }

  const diagnosticPath =
    process?.env?.[
      PROVIDER_SCHEMA_DIAGNOSTIC_PATH_ENV
    ]?.trim?.() ?? ""

  if (diagnosticPath.length > 0) {
    try {
      appendFileSync(
        diagnosticPath,
        JSON.stringify(record) + "\n",
        {
          encoding: "utf8",
          flag: "a",
        },
      )
      return
    } catch (error) {
      console.error(
        "KOALIK_PROVIDER_SCHEMA_DIAGNOSTIC_WRITE_FAILED " +
        JSON.stringify({
          protocol:
            PROVIDER_SCHEMA_DIAGNOSTIC_PROTOCOL,
          authority: "observation_only",
          error:
            String(error?.message ?? error),
          semantic_authority: false,
          mutation_authority: false,
        }),
      )
    }
  }

  console.error(
    "KOALIK_PROVIDER_SCHEMA_DIAGNOSTIC_V1 " +
    JSON.stringify(record),
  )
}

export function compileLlGuidanceOpenAICompatibleWireOptions({
  options,
  contract,
  plan,
  transport,
} = {}) {
  if (
    transport?.backend !== "llguidance" ||
    transport?.wire_mode !==
      "openai_compatible_raw_json_schema"
  ) {
    throw new Error(
      "ARG_SYNTH llguidance_wire_transport_invalid",
    )
  }

  const providerOptionsKey =
    transport.provider_options_key

  if (
    typeof providerOptionsKey !== "string" ||
    providerOptionsKey.length < 1
  ) {
    throw new Error(
      "ARG_SYNTH llguidance_provider_options_key_invalid",
    )
  }

  if (
    !plan?.model_schema ||
    typeof plan.model_schema !== "object" ||
    Array.isArray(plan.model_schema)
  ) {
    throw new Error(
      "ARG_SYNTH llguidance_model_schema_invalid",
    )
  }

  const resolvedProviderSchema =
    resolveProviderSafeModelSchema(plan)
  if (resolvedProviderSchema.ok !== true) {
    throw new Error(
      "ARG_SYNTH llguidance_provider_schema_projection_unavailable " +
      String(
        resolvedProviderSchema.reason ??
          "provider_schema_projection_failed",
      ),
    )
  }

  const root =
    options?.providerOptions == null
      ? {}
      : options.providerOptions

  if (
    !root ||
    typeof root !== "object" ||
    Array.isArray(root)
  ) {
    throw new Error(
      "ARG_SYNTH provider_options_root_invalid",
    )
  }

  const existing =
    root[providerOptionsKey] == null
      ? {}
      : root[providerOptionsKey]

  if (
    !existing ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    throw new Error(
      "ARG_SYNTH provider_options_namespace_invalid",
    )
  }

  if (
    Object.prototype.hasOwnProperty.call(
      existing,
      "response_format",
    )
  ) {
    throw new Error(
      "ARG_SYNTH raw_response_format_conflict",
    )
  }

  const schema = cloneJson(
    resolvedProviderSchema.schema,
  )

  const responseFormat =
    Object.freeze({
      // Keep the generic SDK path in plain JSON mode so the
      // OpenAI-compatible adapter does not claim native schema
      // support. The exact schema is injected into the raw wire
      // field below and enforced by the attested llama.cpp backend.
      type: "json",
    })

  emitLlGuidanceProviderSchemaDiagnostic({
    contract,
    plan,
    transport,
    resolvedProviderSchema,
    schema,
    responseFormat,
  })

  return Object.freeze({
    responseFormat,
    providerOptions: Object.freeze({
      ...root,
      [providerOptionsKey]: Object.freeze({
        ...existing,
        response_format: Object.freeze({
          type: "json_schema",
          json_schema: Object.freeze({
            name:
              `args_${contract.selected_tool}`,
            strict: true,
            schema,
          }),
        }),
      }),
    }),
  })
}

const ARGUMENT_SYNTHESIS_TRANSPORT_OBSERVATION_PROTOCOL =
  "argument-synthesis-transport-observation-v1"

function emitArgumentSynthesisTransportObservation({
  contract,
  plan,
  transport,
  language,
} = {}) {
  if (
    process?.env?.[
      PROVIDER_SCHEMA_DIAGNOSTIC_ENV
    ] !== "1"
  ) {
    return
  }

  const record = {
    protocol:
      ARGUMENT_SYNTHESIS_TRANSPORT_OBSERVATION_PROTOCOL,
    authority: "observation_only",
    stage: "transport_selected",

    selected_tool:
      contract?.selected_tool ?? null,
    contract_active:
      contract?.active === true,

    plan_active:
      plan?.active === true,
    plan_reason:
      plan?.reason ?? null,
    plan_zero_inference:
      plan?.zero_inference === true,
    model_schema_sha256:
      plan?.model_schema
        ? stableSha(plan.model_schema)
        : null,
    provider_schema_projection_ok:
      plan?.provider_schema_projection
        ?.ok === true,
    provider_schema_projection_reason:
      plan?.provider_schema_projection
        ?.reason ?? null,
    provider_model_schema_sha256:
      plan?.provider_model_schema
        ? stableSha(
            plan.provider_model_schema,
          )
        : null,

    language_provider:
      language?.provider ?? null,
    language_model_id:
      language?.modelId ?? null,
    language_structured_outputs:
      language?.supportsStructuredOutputs === true,

    transport_mode:
      transport?.mode ?? null,
    transport_reason:
      transport?.reason ?? null,
    backend:
      transport?.backend ?? null,
    wire_mode:
      transport?.wire_mode ?? null,
    provider_options_key:
      transport?.provider_options_key ?? null,

    semantic_authority: false,
    mutation_authority: false,
  }

  const diagnosticPath =
    process?.env?.[
      PROVIDER_SCHEMA_DIAGNOSTIC_PATH_ENV
    ]?.trim?.() ?? ""

  /*
   * Explicit diagnostic path is intentionally fail-closed:
   * when the operator requests durable evidence, silently losing
   * that evidence would make the experiment invalid.
   *
   * This has no production effect because the whole branch is
   * opt-in via PROVIDER_SCHEMA_DIAGNOSTIC_ENV.
   */
  if (diagnosticPath.length > 0) {
    appendFileSync(
      diagnosticPath,
      JSON.stringify(record) + "\\n",
      {
        encoding: "utf8",
        flag: "a",
      },
    )
    return
  }

  console.error(
    "KOALIK_ARGUMENT_SYNTHESIS_TRANSPORT_V1 " +
    JSON.stringify(record),
  )
}


export function compileArgumentSynthesisDispatch({
  options,
  language,
  contract,
} = {}) {
  if (contract?.active !== true) {
    /*
     * Diagnostic invariant:
     * every invocation of this compiler is observable when the
     * explicit diagnostic channel is enabled, including passthrough.
     *
     * This closes the ambiguity between:
     *   - compiler not invoked
     *   - compiler invoked with inactive contract
     */
    emitArgumentSynthesisTransportObservation({
      contract,
      plan:
        contract?.argument_synthesis_plan ?? null,
      transport: Object.freeze({
        mode: "passthrough",
        reason:
          "contract_inactive_passthrough_observed",
        backend: null,
        wire_mode: null,
        provider_options_key: null,
      }),
      language,
    })

    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      active: false,
      mode: "passthrough",
      options,
      plan: contract?.argument_synthesis_plan ?? null,
      zero_inference: false,
    })
  }

  const plan = contract.argument_synthesis_plan
  const transport = selectArgumentSynthesisTransport(language, plan)

  emitArgumentSynthesisTransportObservation({
    contract,
    plan,
    transport,
    language,
  })

  if (transport.mode === "zero_inference") {
    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      active: true,
      mode: transport.mode,
      options: null,
      plan,
      transport,
      zero_inference: true,
    })
  }

  if (transport.mode === "json_schema") {
    const llguidanceWire =
      transport.backend === "llguidance"
        ? compileLlGuidanceOpenAICompatibleWireOptions({
            options,
            contract,
            plan,
            transport,
          })
        : null

    return Object.freeze({
      protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
      active: true,
      mode: transport.mode,
      options: {
        ...options,
        tools: [],
        toolChoice: undefined,
        responseFormat:
          llguidanceWire?.responseFormat ??
          {
            type: "json",
            schema: cloneJson(plan.model_schema),
            name: `args_${contract.selected_tool}`,
            description:
              "Return only arguments for the already-selected deterministic action.",
          },
        ...(
          llguidanceWire == null
            ? {}
            : {
                providerOptions:
                  llguidanceWire.providerOptions,
              }
        ),
      },
      plan,
      transport,
      zero_inference: false,
    })
  }

  const modelTool = plan?.active === true && plan.model_tool
    ? plan.model_tool
    : contract.selected_tool_definition

  return Object.freeze({
    protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
    active: true,
    mode: "required_singleton_tool",
    options: {
      ...options,
      tools: [modelTool],
      // AI SDK OpenAI-compatible adapters lower this to tool_choice="required".
      toolChoice: { type: "required" },
    },
    plan,
    transport,
    zero_inference: false,
  })
}

function parseJsonText(text, reason) {
  if (typeof text !== "string" || text.trim().length < 1) {
    throw new Error(`ARG_SYNTH ${reason}_empty`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`ARG_SYNTH ${reason}_json_invalid`)
  }
}

function parseStructuredGenerate(parts) {
  if (!Array.isArray(parts)) {
    throw new Error("ARG_SYNTH provider_content_invalid")
  }
  const text = parts
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
  return parseJsonText(text, "structured_output")
}

function argumentSynthesisFailure(
  code,
  details = {},
) {
  const error =
    new Error(`ARG_SYNTH ${code}`)

  error.name =
    "ArgumentSynthesisError"
  error.code = code
  error.details =
    Object.freeze({
      ...details,
    })

  return error
}


function parseToolInput(value) {
  if (typeof value === "string") return parseJsonText(value, "tool_input")
  if (value && typeof value === "object") return cloneJson(value)
  throw new Error("ARG_SYNTH tool_input_invalid")
}

function parseRequiredGenerate(parts, selectedTool) {
  if (!Array.isArray(parts)) {
    throw new Error("ARG_SYNTH provider_content_invalid")
  }
  const calls = parts.filter(
    (part) => part && typeof part === "object" && part.type === "tool-call",
  )
  if (calls.length !== 1) {
    throw argumentSynthesisFailure(
      "required_tool_call_cardinality_invalid",
      {
        observed_tool_calls:
          calls.length,
      },
    )
  }
  if (calls[0].toolName !== selectedTool) {
    throw argumentSynthesisFailure(
      "required_tool_call_name_invalid",
      {
        expected_tool_name:
          selectedTool,
        observed_tool_name:
          calls[0]?.toolName ?? null,
      },
    )
  }
  return parseToolInput(calls[0].input)
}

function parseStructuredStream(parts) {
  let text = ""
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text-delta" && typeof part.delta === "string") {
      text += part.delta
    } else if (part.type === "text" && typeof part.text === "string") {
      text += part.text
    }
  }
  return parseJsonText(text, "structured_stream")
}

function parseRequiredStream(parts, selectedTool) {
  const finalCalls = (parts ?? []).filter(
    (part) => part && typeof part === "object" && part.type === "tool-call",
  )
  if (finalCalls.length === 1) {
    if (finalCalls[0].toolName !== selectedTool) {
      throw argumentSynthesisFailure(
        "required_stream_tool_name_invalid",
        {
          expected_tool_name:
            selectedTool,
          observed_tool_name:
            finalCalls[0]?.toolName ?? null,
        },
      )
    }
    return parseToolInput(finalCalls[0].input)
  }
  if (finalCalls.length > 1) {
    throw argumentSynthesisFailure(
      "required_stream_tool_cardinality_invalid",
      {
        observed_tool_calls:
          finalCalls.length,
        representation:
          "final_tool_call",
      },
    )
  }

  const calls = new Map()
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue
    if (part.type === "tool-input-start") {
      const id = part.id ?? part.toolCallId
      if (typeof id !== "string" || !id) continue
      calls.set(id, {
        name: part.toolName,
        text: "",
      })
    } else if (part.type === "tool-input-delta") {
      const id = part.id ?? part.toolCallId
      const row = calls.get(id)
      if (row && typeof part.delta === "string") row.text += part.delta
    }
  }

  if (calls.size !== 1) {
    throw argumentSynthesisFailure(
      "required_stream_tool_cardinality_invalid",
      {
        observed_tool_calls:
          calls.size,
        representation:
          "stream_tool_input",
      },
    )
  }
  const row = [...calls.values()][0]
  if (row.name !== selectedTool) {
    throw argumentSynthesisFailure(
      "required_stream_tool_name_invalid",
      {
        expected_tool_name:
          selectedTool,
        observed_tool_name:
          row.name ?? null,
      },
    )
  }
  return parseJsonText(row.text, "required_stream_tool_input")
}

function fullArguments(plan, modelValue) {
  if (plan?.active !== true) return cloneJson(modelValue)
  return mergeByPlan(plan.merge_plan, modelValue)
}

function syntheticToolCall(selectedTool, args, dispatch = null) {
  return {
    type: "tool-call",
    toolCallId: `deterministic:${selectedTool}`,
    toolName: selectedTool,
    input: JSON.stringify(args),
    providerMetadata: {
      koalik: {
        protocol: DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
        generatedToolNameBytes: 0,
        modelActionAuthority: false,
        structuredOutputMode:
          dispatch?.mode ?? null,
        structuredOutputBackend:
          dispatch?.transport?.backend ?? null,
        structuredOutputWireMode:
          dispatch?.transport?.wire_mode ?? null,
        structuredOutputProviderOptionsKey:
          dispatch?.transport?.provider_options_key ?? null,
        structuredOutputRuntimeProofSha256:
          dispatch?.transport?.runtime_policy?.proof_sha256 ?? null,
      },
    },
  }
}

export function materializeArgumentSynthesisGenerate(result, contract, dispatch) {
  if (contract?.active !== true || dispatch?.active !== true) return result

  let modelValue
  if (dispatch.mode === "zero_inference") {
    modelValue = {}
  } else if (dispatch.mode === "json_schema") {
    if (!result || typeof result !== "object") {
      throw new Error("ARG_SYNTH provider_result_invalid")
    }
    modelValue = parseStructuredGenerate(result.content)
  } else if (dispatch.mode === "required_singleton_tool") {
    if (!result || typeof result !== "object") {
      throw new Error("ARG_SYNTH provider_result_invalid")
    }
    modelValue = parseRequiredGenerate(result.content, contract.selected_tool)
  } else {
    return result
  }

  const args = fullArguments(dispatch.plan, modelValue)

  return {
    ...(result ?? {}),
    content: [syntheticToolCall(contract.selected_tool, args, dispatch)],
    finishReason: {
      unified: "tool-calls",
      raw: result?.finishReason?.raw ?? (dispatch.mode === "zero_inference" ? "deterministic" : dispatch.mode),
    },
    usage: result?.usage ?? {
      inputTokens: { total: 0 },
      outputTokens: { total: 0 },
      raw: { deterministic_zero_inference: dispatch.mode === "zero_inference" },
    },
    warnings: result?.warnings ?? [],
    request: result?.request ?? { body: null },
    response: result?.response ?? { body: null },
  }
}

function streamPrefix(parts) {
  return (parts ?? []).filter(
    (part) =>
      part &&
      typeof part === "object" &&
      (part.type === "stream-start" || part.type === "response-metadata"),
  )
}

function streamFinish(parts, raw) {
  const observed = [...(parts ?? [])]
    .reverse()
    .find((part) => part && typeof part === "object" && part.type === "finish")
  return {
    ...(observed ?? { type: "finish" }),
    type: "finish",
    finishReason: {
      unified: "tool-calls",
      raw: observed?.finishReason?.raw ?? raw,
    },
  }
}

export function materializeArgumentSynthesisStream(parts, contract, dispatch) {
  if (contract?.active !== true || dispatch?.active !== true) return parts

  let modelValue
  if (dispatch.mode === "zero_inference") {
    modelValue = {}
  } else if (dispatch.mode === "json_schema") {
    modelValue = parseStructuredStream(parts)
  } else if (dispatch.mode === "required_singleton_tool") {
    modelValue = parseRequiredStream(parts, contract.selected_tool)
  } else {
    return parts
  }

  const args = fullArguments(dispatch.plan, modelValue)

  return [
    ...streamPrefix(parts),
    syntheticToolCall(contract.selected_tool, args, dispatch),
    streamFinish(parts, dispatch.mode),
  ]
}

export function zeroInferenceStreamResult(contract, dispatch) {
  const parts = materializeArgumentSynthesisStream([], contract, dispatch)
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    }),
    request: { body: null },
    response: { headers: undefined },
  }
}
