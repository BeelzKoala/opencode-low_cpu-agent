import { createHash } from "node:crypto"

export const SOURCE_SLOT_MODEL_HOLE_PROTOCOL =
  "source-slot-model-hole-v1"

const HOLE_ID_RE = /^h([0-7])$/u
const RESOURCE_REF_RE =
  /resource:\/\/([A-Za-z][A-Za-z0-9_]{0,63})/gu

const ANNOTATION_KEYS = new Set([
  "description",
  "title",
  "$comment",
  "examples",
  "default",
])

const NON_REPAIRABLE_REASONS = new Set([
  "source_slot_model_hole_request_invalid",
  "source_slot_model_hole_keys_invalid",
  "source_slot_model_hole_value_invalid",
  "source_slot_model_resource_identity_forbidden",
  "source_slot_model_resource_unknown",
  "source_slot_compiler_owned_value_echo",
])

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol:
      SOURCE_SLOT_MODEL_HOLE_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

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
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(value[key])}`,
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha(value) {
  return createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("hex")
}

function toolSchemaSlot(tool) {
  if (!tool || typeof tool !== "object") return null

  for (
    const key of [
      "input",
      "inputSchema",
      "parameters",
      "schema",
    ]
  ) {
    const schema = tool[key]
    if (
      schema &&
      typeof schema === "object" &&
      !Array.isArray(schema)
    ) {
      return { key, schema }
    }
  }
  return null
}

function bindingRows(binding) {
  const rows =
    Array.isArray(binding?.all_source_rows)
      ? binding.all_source_rows
      : []

  return rows
    .filter(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.source_key === "string" &&
        row.source_key.length > 0 &&
        typeof row.operation_id === "string" &&
        row.operation_id.length > 0 &&
        Number.isSafeInteger(row.operation_index) &&
        row.operation_index >= 0 &&
        row.operation_index < 8 &&
        typeof row.kind === "string" &&
        row.kind.length > 0,
    )
    .map((row) => ({
      source_key: row.source_key,
      operation_id: row.operation_id,
      operation_index: row.operation_index,
      kind: row.kind,
      slot:
        typeof row.slot === "string"
          ? row.slot
          : null,
      max_bytes:
        Number.isSafeInteger(row.max_bytes)
          ? row.max_bytes
          : null,
    }))
    .sort(
      (a, b) =>
        a.operation_index - b.operation_index ||
        a.source_key.localeCompare(b.source_key),
    )
}

function compilerIdentityStrings(rows) {
  const out = new Set()
  for (const row of rows) {
    for (
      const value of [
        row.source_key,
        row.operation_id,
        row.slot,
      ]
    ) {
      if (
        typeof value === "string" &&
        value.length > 0
      ) {
        out.add(value)
      }
    }
  }

  return [...out].sort(
    (a, b) =>
      b.length - a.length ||
      a.localeCompare(b),
  )
}

function redactAnnotation(value, identities) {
  let text = String(value ?? "")
  for (const identity of identities) {
    text = text
      .split(identity)
      .join("<compiler-owned>")
  }
  return text
}

function projectSchemaValue(value, identities) {
  if (Array.isArray(value)) {
    return value.map(
      (item) =>
        projectSchemaValue(item, identities),
    )
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return value
  }

  const out = {}
  for (
    const [key, child]
    of Object.entries(value)
  ) {
    if (
      ANNOTATION_KEYS.has(key) &&
      typeof child === "string"
    ) {
      out[key] =
        redactAnnotation(child, identities)
      continue
    }

    out[key] =
      projectSchemaValue(child, identities)
  }
  return out
}

function genericHoleDescription(rows) {
  const descriptors = rows.map(
    (row) =>
      `h${row.operation_index}=${row.kind}`,
  )

  return (
    "Return semantic implementation payload only in opaque holes. " +
    "The compiler owns files, paths, slots, operation ids, preimages, " +
    "placement and mutation kinds. " +
    "Hole hN corresponds to deterministic REQUIRED operation position N; " +
    "the hole id is routing only, not repository identity. " +
    "Cross-hole references use resource://hN. " +
    "Never return a filename/path merely to identify a target. " +
    `Active holes: ${descriptors.join("; ")}.`
  )
}

export function projectSourceSlotModelHoles({
  tool,
  binding,
} = {}) {
  const slot = toolSchemaSlot(tool)
  if (!slot) {
    return fail("source_slot_model_schema_unavailable")
  }

  const schema = slot.schema
  const sources = schema?.properties?.sources

  if (
    schema?.type !== "object" ||
    schema?.additionalProperties !== false ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties) ||
    Object.keys(schema.properties).length !== 1 ||
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
    return fail("source_slot_model_schema_shape_invalid")
  }

  const required = [...sources.required]
  const uniqueRequired = [...new Set(required)]

  if (
    required.length < 1 ||
    required.length > 8 ||
    uniqueRequired.length !== required.length ||
    !Array.isArray(schema.required) ||
    schema.required.length !== 1 ||
    schema.required[0] !== "sources"
  ) {
    return fail("source_slot_model_required_invalid")
  }

  const rows = bindingRows(binding)
  if (rows.length < 1) {
    return fail("source_slot_model_binding_invalid")
  }

  const rowByKey =
    new Map(
      rows.map(
        (row) => [
          row.source_key,
          row,
        ],
      ),
    )

  const activeRows = []
  for (const key of required) {
    const row = rowByKey.get(key)
    if (
      !row ||
      !Object.prototype.hasOwnProperty.call(
        sources.properties,
        key,
      )
    ) {
      return fail(
        "source_slot_model_binding_drift",
        { source_key: key },
      )
    }
    activeRows.push(row)
  }

  activeRows.sort(
    (a, b) =>
      a.operation_index - b.operation_index ||
      a.source_key.localeCompare(b.source_key),
  )

  const holeIds =
    activeRows.map(
      (row) =>
        `h${row.operation_index}`,
    )

  if (
    new Set(holeIds).size !== holeIds.length ||
    holeIds.some(
      (id) => !HOLE_ID_RE.test(id),
    )
  ) {
    return fail("source_slot_model_hole_id_invalid")
  }

  const identities =
    compilerIdentityStrings(rows)
  const holeProperties = {}
  const bindings = []

  for (const row of activeRows) {
    const hole =
      `h${row.operation_index}`

    holeProperties[hole] =
      projectSchemaValue(
        cloneJson(
          sources.properties[
            row.source_key
          ],
        ),
        identities,
      )

    bindings.push(
      Object.freeze({
        hole,
        source_key: row.source_key,
        operation_id: row.operation_id,
        operation_index: row.operation_index,
        kind: row.kind,
        slot: row.slot,
        max_bytes: row.max_bytes,
      }),
    )
  }

  const projectedSchema =
    Object.freeze({
      type: "object",
      properties:
        Object.freeze({
          holes:
            Object.freeze({
              type: "object",
              properties:
                Object.freeze(holeProperties),
              required:
                Object.freeze([...holeIds]),
              additionalProperties: false,
            }),
        }),
      required:
        Object.freeze(["holes"]),
      additionalProperties: false,
    })

  const projectedTool = {
    ...tool,
    description:
      genericHoleDescription(activeRows),
    [slot.key]: projectedSchema,
  }

  const projectionPayload = {
    protocol:
      SOURCE_SLOT_MODEL_HOLE_PROTOCOL,
    source_binding_sha256:
      typeof binding?.binding_sha256 === "string"
        ? binding.binding_sha256
        : null,
    source_spec_sha256:
      typeof binding?.source_spec_sha256 === "string"
        ? binding.source_spec_sha256
        : null,
    required_holes:
      [...holeIds],
    bindings:
      bindings.map(
        (row) => ({ ...row }),
      ),
    model_owned_fields:
      ["semantic_payload"],
    compiler_owned_fields:
      [
        "source_key",
        "operation_id",
        "slot",
        "file",
        "path",
        "preimage",
        "placement",
        "mutation_kind",
      ],
    compiler_identity_fields_exposed: 0,
    mutation_authority: false,
  }

  const projection =
    Object.freeze({
      ...projectionPayload,
      projection_sha256:
        sha(projectionPayload),
    })

  return Object.freeze({
    ok: true,
    protocol:
      SOURCE_SLOT_MODEL_HOLE_PROTOCOL,
    reason:
      "compiler_owned_source_identity_erased",
    tool:
      Object.freeze(projectedTool),
    projection,
    model_schema_sha256:
      sha(projectedSchema),
    model_schema_bytes:
      Buffer.byteLength(
        JSON.stringify(projectedSchema),
        "utf8",
      ),
    compiler_identity_fields_exposed: 0,
    mutation_authority: false,
  })
}

function projectionRows(projection) {
  if (
    projection?.protocol !==
      SOURCE_SLOT_MODEL_HOLE_PROTOCOL ||
    !Array.isArray(projection.bindings) ||
    !Array.isArray(projection.required_holes) ||
    typeof projection.projection_sha256 !== "string"
  ) {
    return null
  }

  const payload = {
    protocol: projection.protocol,
    source_binding_sha256:
      projection.source_binding_sha256 ?? null,
    source_spec_sha256:
      projection.source_spec_sha256 ?? null,
    required_holes:
      [...projection.required_holes],
    bindings:
      projection.bindings.map(
        (row) => ({ ...row }),
      ),
    model_owned_fields:
      [...(projection.model_owned_fields ?? [])],
    compiler_owned_fields:
      [...(projection.compiler_owned_fields ?? [])],
    compiler_identity_fields_exposed:
      projection.compiler_identity_fields_exposed,
    mutation_authority:
      projection.mutation_authority,
  }

  if (
    sha(payload) !==
      projection.projection_sha256
  ) {
    return null
  }

  const rows = projection.bindings
  const holes =
    rows.map((row) => row?.hole)

  if (
    rows.length < 1 ||
    new Set(holes).size !== rows.length ||
    holes.some(
      (hole) =>
        typeof hole !== "string" ||
        !HOLE_ID_RE.test(hole),
    )
  ) {
    return null
  }

  return rows
}

function rewriteHoleResources(
  value,
  byHole,
  compilerIdentities,
) {
  if (typeof value === "string") {
    let failed = null

    const rewritten =
      value.replace(
        RESOURCE_REF_RE,
        (_whole, token) => {
          const row =
            byHole.get(token)

          if (row) {
            return (
              "resource://" +
              row.source_key
            )
          }

          if (
            compilerIdentities.has(token) ||
            /^op_[0-9]+$/u.test(token)
          ) {
            failed =
              fail(
                "source_slot_model_resource_identity_forbidden",
                { resource: token },
              )
            return _whole
          }

          failed =
            fail(
              "source_slot_model_resource_unknown",
              { resource: token },
            )
          return _whole
        },
      )

    return failed ??
      Object.freeze({
        ok: true,
        value: rewritten,
      })
  }

  if (Array.isArray(value)) {
    const out = []
    for (const child of value) {
      const rewritten =
        rewriteHoleResources(
          child,
          byHole,
          compilerIdentities,
        )
      if (rewritten.ok !== true) {
        return rewritten
      }
      out.push(rewritten.value)
    }
    return Object.freeze({
      ok: true,
      value: out,
    })
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const out = {}
    for (
      const [key, child]
      of Object.entries(value)
    ) {
      const rewritten =
        rewriteHoleResources(
          child,
          byHole,
          compilerIdentities,
        )
      if (rewritten.ok !== true) {
        return rewritten
      }
      out[key] = rewritten.value
    }
    return Object.freeze({
      ok: true,
      value: out,
    })
  }

  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Object.freeze({
      ok: true,
      value,
    })
  }

  return fail("source_slot_model_hole_value_invalid")
}

export function normalizeSourceSlotModelHoleRequest({
  projection,
  request,
} = {}) {
  const rows =
    projectionRows(projection)

  if (!rows) {
    return fail(
      "source_slot_model_projection_invalid",
    )
  }

  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== 1 ||
    !request.holes ||
    typeof request.holes !== "object" ||
    Array.isArray(request.holes)
  ) {
    return fail(
      "source_slot_model_hole_request_invalid",
    )
  }

  const expected =
    [...projection.required_holes].sort()
  const actual =
    Object.keys(request.holes).sort()

  if (
    expected.length !== actual.length ||
    expected.some(
      (hole, index) =>
        hole !== actual[index],
    )
  ) {
    return fail(
      "source_slot_model_hole_keys_invalid",
      {
        expected_holes:
          Object.freeze(expected),
        actual_holes:
          Object.freeze(actual),
      },
    )
  }

  const byHole =
    new Map(
      rows.map(
        (row) => [
          row.hole,
          row,
        ],
      ),
    )

  const compilerIdentities =
    new Set()

  for (const row of rows) {
    for (
      const value of [
        row.source_key,
        row.operation_id,
        row.slot,
      ]
    ) {
      if (
        typeof value === "string" &&
        value.length > 0
      ) {
        compilerIdentities.add(value)
      }
    }
  }

  const sources = {}

  for (const hole of expected) {
    const row =
      byHole.get(hole)

    if (!row) {
      return fail(
        "source_slot_model_projection_invalid",
      )
    }

    const rewritten =
      rewriteHoleResources(
        request.holes[hole],
        byHole,
        compilerIdentities,
      )

    if (rewritten.ok !== true) {
      return rewritten
    }

    sources[row.source_key] =
      cloneJson(rewritten.value)
  }

  return Object.freeze({
    ok: true,
    protocol:
      SOURCE_SLOT_MODEL_HOLE_PROTOCOL,
    reason:
      "model_holes_joined_to_compiler_sources",
    request:
      Object.freeze({
        sources:
          Object.freeze(sources),
      }),
    hole_count: expected.length,
    compiler_joined: true,
    model_file_authority: false,
    model_slot_authority: false,
    model_operation_authority: false,
    mutation_authority: false,
  })
}

export function sourceSlotModelHoleFailureIsNonRepairable(
  reason,
) {
  return (
    typeof reason === "string" &&
    NON_REPAIRABLE_REASONS.has(reason)
  )
}
