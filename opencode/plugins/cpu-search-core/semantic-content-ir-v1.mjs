import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import {
  compilePythonSemanticUnits,
  KOALIK_PROVENANCE_PROTOCOL,
  PYTHON_BINDING_CAPABILITY_PROTOCOL,
  PYTHON_SEMANTIC_FRONTEND_PROTOCOL,
  PYTHON_SCOPE_LATTICE_PROTOCOL,
  PYTHON_UNIT_SHELL_PROTOCOL,
} from "./python-semantic-frontend-v1.mjs"
import {
  lowerPythonNestedSemanticUnits,
  PYTHON_NESTED_UNIT_PROTOCOL,
  PYTHON_NESTED_SEMANTIC_IR_PROTOCOL,
  PYTHON_SUITE_IR_PROTOCOL,
} from "./python-nested-semantic-ir-v1.mjs"

import {
  deriveFileFamilyContract,
  renderFileFamilyContract,
  validateOperationFileFamilyContent,
} from "./file-family-contract-v1.mjs"

import {
  pythonUnitSchema,
} from "./python-unit-contract-v1.mjs"

export const SEMANTIC_CONTENT_IR_PROTOCOL = "semantic-content-ir-v1"
export const DETERMINISTIC_MATERIALIZER_PROTOCOL = "deterministic-materializer-v1"

const CONTENT_ID_RE = /^op_[0-9]+$/u
const PLACEHOLDER_RE = /@@(BEFORE|CREATE_PATH):(op_[0-9]+)@@/gu
const RESOURCE_REF_RE = /resource:\/\/(op_[0-9]+)/gu
const LEGACY_PLACEHOLDER_RE = /@@(?:BEFORE|CREATE_PATH):op_[0-9]+@@/u
const MAX_CONTENT_ITEMS = 16
const MAX_CONTENT_BYTES = 64 * 1024

const asArray = (value) => Array.isArray(value) ? value : []

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
}

function stableSha(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
}

function safeRelative(value) {
  if (typeof value !== "string") return null
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) return null
  return normalized
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: DETERMINISTIC_MATERIALIZER_PROTOCOL,
    semantic_ir_protocol: SEMANTIC_CONTENT_IR_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

export function deriveSemanticContentSpec({ capability } = {}) {
  if (capability?.ready !== true || capability?.mutation_authority !== true) {
    return fail("semantic_capability_not_authorized")
  }

  const existing = asArray(capability.existing_slots)
  const creates = asArray(capability.create_slots)
  const servers = existing.filter((slot) =>
    asArray(slot?.allowed_operations).includes("add_module_declaration") ||
    asArray(slot?.roles).includes("task_anchor_owner"),
  )
  if (servers.length !== 1) {
    return fail("semantic_server_slot_ambiguous", { candidates: servers.length })
  }

  const server = servers[0]
  const navigation = existing.filter((slot) =>
    slot?.slot !== server?.slot &&
    asArray(slot?.allowed_operations).includes("replace_exact") &&
    asArray(slot?.roles).includes("navigation_host"),
  )
  if (navigation.length > 1) {
    return fail("semantic_navigation_slot_ambiguous", { candidates: navigation.length })
  }
  if (creates.length > 1) {
    return fail("semantic_create_slot_ambiguous", { candidates: creates.length })
  }

  const operations = []
  operations.push(Object.freeze({
    id: `op_${operations.length}`,
    obligation: "server_surface",
    kind: "python_declaration",
    slot: server.slot,
    model_fields: Object.freeze(["content"]),
    content_protocol: PYTHON_NESTED_UNIT_PROTOCOL,
  }))
  if (navigation.length === 1) {
    operations.push(Object.freeze({
      id: `op_${operations.length}`,
      obligation: "navigation_integration",
      kind: "replacement",
      slot: navigation[0].slot,
      model_fields: Object.freeze(["content"]),
      deterministic_fields: Object.freeze(["before"]),
    }))
  }
  if (creates.length === 1) {
    operations.push(Object.freeze({
      id: `op_${operations.length}`,
      obligation: "ui_surface",
      kind: "creation",
      slot: creates[0].slot,
      model_fields: Object.freeze(["content"]),
      deterministic_fields: Object.freeze(["relative_path"]),
    }))
  }

  return Object.freeze({
    ok: true,
    protocol: SEMANTIC_CONTENT_IR_PROTOCOL,
    capability_sha256: capability.capability_sha256 ?? null,
    authority_sha256: capability.authority_sha256 ?? null,
    operations: Object.freeze(operations),
    content_ids: Object.freeze(operations.map((operation) => operation.id)),
    model_authority: Object.freeze({
      content: true,
      semantic_body: true,
      python_units: true,
      new_symbols: true,
      new_routes: true,
      imports: false,
      dependencies: false,
      module_bootstrap: false,
      existing_symbols: false,
      existing_routes: false,
      provenance: false,
      slot: false,
      operation: false,
      file: false,
      scope: false,
      source_preimage: false,
      create_root: false,
    }),
  })
}


function operationFailure(
  reason,
  extra = {},
) {
  return Object.freeze({
    ok: false,
    protocol:
      SEMANTIC_CONTENT_IR_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}


export function bindSemanticContentToolSchemaToCapability(
  tool,
  capability,
) {
  const spec = deriveSemanticContentSpec({ capability })
  if (spec.ok !== true) return spec

  const fileFamilyContract =
    deriveFileFamilyContract({
      operations: spec.operations,
      capability,
    })

  if (fileFamilyContract.ok !== true) {
    return operationFailure(
      "semantic_file_family_contract_invalid",
      {
        family_reason:
          fileFamilyContract.reason ??
          null,
        file_family_contract:
          fileFamilyContract,
      },
    )
  }

  const schemaKey =
    tool?.input && typeof tool.input === "object"
      ? "input"
      : tool?.parameters && typeof tool.parameters === "object"
        ? "parameters"
        : null
  if (!schemaKey) {
    return operationFailure("semantic_schema_not_applicable")
  }

  const schema = tool[schemaKey]
  const properties = schema?.properties
  const contents = properties?.contents
  const items = contents?.items
  const itemProperties = items?.properties
  const id = itemProperties?.id

  if (
    !properties ||
    !contents ||
    !items ||
    typeof items !== "object" ||
    !itemProperties ||
    typeof itemProperties !== "object" ||
    !id ||
    typeof id !== "object"
  ) {
    return operationFailure("semantic_schema_shape_invalid")
  }

  const pythonNameSchema = {
    type: "string",
    pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
    maxLength: 256,
  }

  const unitSchema =
    pythonUnitSchema({ context: "top" })

const semanticPayloadSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: ["text", "python_units"],
      },
      text: {
        type: "string",
        minLength: 1,
        maxLength: MAX_CONTENT_BYTES,
      },
      mode: {
        type: "string",
        enum: ["before", "after", "replace", "create"],
      },
      units: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: unitSchema,
      },
    },
    required: ["kind"],
    description:
      "Typed semantic payload. Python additive operations MUST use " +
      "kind=python_units. Replacement operations MUST use kind=text with " +
      "mode=before|after|replace. Creation operations MUST use kind=text " +
      "with mode=create. resource://op_N is the only model-facing resource " +
      "reference. Imports, dependency declarations, existing symbol mutation, " +
      "physical paths/preimages and Koalik provenance are compiler-owned.",
  }

  const semanticProperties =
    semanticPayloadSchema.properties

  const payloadSchemaForOperation = (operation) => {
    if (operation?.kind === "python_declaration") {
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            ...semanticProperties.kind,
            enum: ["python_units"],
          },
          units: semanticProperties.units,
        },
        required: ["kind", "units"],
      }
    }

    if (operation?.kind === "replacement") {
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            ...semanticProperties.kind,
            enum: ["text"],
          },
          mode: {
            ...semanticProperties.mode,
            enum: ["before", "after", "replace"],
          },
          text: semanticProperties.text,
        },
        required: ["kind", "mode", "text"],
      }
    }

    if (operation?.kind === "creation") {
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            ...semanticProperties.kind,
            enum: ["text"],
          },
          mode: {
            ...semanticProperties.mode,
            enum: ["create"],
          },
          text: semanticProperties.text,
        },
        required: ["kind", "mode", "text"],
      }
    }

    return null
  }

  const exactItemSchemas = spec.operations.map(
    (operation) => {
      const content = payloadSchemaForOperation(operation)
      if (!content) return null

      return {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            ...id,
            enum: [operation.id],
          },
          content,
        },
        required: ["id", "content"],
      }
    },
  )

  if (exactItemSchemas.some((item) => item === null)) {
    return operationFailure(
      "semantic_operation_schema_unsupported",
    )
  }

  const boundContents = {
    ...contents,
    minItems: spec.content_ids.length,
    maxItems: spec.content_ids.length,
    items: {
      ...items,
      properties: {
        ...itemProperties,
        id: {
          ...id,
          enum: [...spec.content_ids],
        },
        content: semanticPayloadSchema,
      },
      required: ["id", "content"],
      additionalProperties: false,
      oneOf: exactItemSchemas,
    },
  }

  return Object.freeze({
    ok: true,
    protocol: SEMANTIC_CONTENT_IR_PROTOCOL,
    reason: "semantic_schema_bound",
    tool: {
      ...tool,
      description: [
        tool?.description ?? "",
        renderFileFamilyContract(
          fileFamilyContract,
        ),
      ]
        .filter(
          (value) =>
            typeof value === "string" &&
            value.length > 0,
        )
        .join("\n"),
      [schemaKey]: {
        ...schema,
        properties: {
          ...properties,
          contents: boundContents,
        },
      },
    },
    content_ids: spec.content_ids,
    operation_count: spec.operations.length,
    python_unit_protocol: PYTHON_NESTED_UNIT_PROTOCOL,
    mutation_authority: false,
    model_authority: spec.model_authority,
  })
}

export function validateSemanticContentRequest({ spec, request } = {}) {
  if (spec?.ok !== true) return fail("semantic_spec_unavailable")
  if (!exactKeys(request, ["contents"]) || !Array.isArray(request.contents)) {
    return fail("semantic_request_shape_invalid")
  }
  if (request.contents.length < 1 || request.contents.length > MAX_CONTENT_ITEMS) {
    return fail("semantic_content_count_invalid")
  }

  const byId = new Map(spec.operations.map((operation) => [operation.id, operation]))
  const expected = new Set(spec.content_ids)
  const observed = new Set()
  let contentBytes = 0

  for (let index = 0; index < request.contents.length; index += 1) {
    const item = request.contents[index]
    if (!exactKeys(item, ["id", "content"])) {
      return fail("semantic_content_item_shape_invalid", {
        operation_index: index,
      })
    }

    if (
      typeof item.id !== "string" ||
      !CONTENT_ID_RE.test(item.id) ||
      !expected.has(item.id) ||
      observed.has(item.id)
    ) {
      return fail("semantic_content_id_invalid", {
        operation_index: index,
        id: item?.id ?? null,
      })
    }

    const operation = byId.get(item.id)
    const payload = item.content
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("semantic_content_payload_invalid", { id: item.id })
    }

    if (operation?.kind === "python_declaration") {
      if (
        !exactKeys(payload, ["kind", "units"]) ||
        payload.kind !== "python_units" ||
        !Array.isArray(payload.units) ||
        payload.units.length < 1 ||
        payload.units.length > 8
      ) {
        return fail("semantic_python_unit_payload_invalid", { id: item.id })
      }

      for (let unitIndex = 0; unitIndex < payload.units.length; unitIndex += 1) {
        const unit = payload.units[unitIndex]
        if (
          !unit ||
          typeof unit !== "object" ||
          Array.isArray(unit) ||
          ![
            "function",
            "async_function",
            "class",
            "assignment",
          ].includes(unit.kind) ||
          typeof unit.name !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(unit.name)
        ) {
          return fail("semantic_python_unit_shape_invalid", {
            id: item.id,
            unit_index: unitIndex,
          })
        }
      }
    } else if (operation?.kind === "replacement") {
      if (
        !exactKeys(payload, ["kind", "mode", "text"]) ||
        payload.kind !== "text" ||
        !["before", "after", "replace"].includes(payload.mode) ||
        typeof payload.text !== "string" ||
        payload.text.length < 1
      ) {
        return fail("semantic_text_payload_invalid", { id: item.id })
      }
    } else if (operation?.kind === "creation") {
      if (
        !exactKeys(payload, ["kind", "mode", "text"]) ||
        payload.kind !== "text" ||
        payload.mode !== "create" ||
        typeof payload.text !== "string" ||
        payload.text.length < 1
      ) {
        return fail("semantic_text_payload_invalid", { id: item.id })
      }
    } else {
      return fail("semantic_operation_kind_unsupported", {
        id: item.id,
        kind: operation?.kind ?? null,
      })
    }

    observed.add(item.id)
    contentBytes += utf8Bytes(JSON.stringify(payload))
  }

  if (
    observed.size !== expected.size ||
    [...expected].some((id) => !observed.has(id))
  ) {
    return fail("semantic_content_coverage_incomplete", {
      expected: [...expected],
      observed: [...observed],
    })
  }

  if (contentBytes > MAX_CONTENT_BYTES) {
    return fail("semantic_content_budget_exceeded", {
      content_bytes: contentBytes,
      max_bytes: MAX_CONTENT_BYTES,
    })
  }

  return Object.freeze({
    ok: true,
    protocol: SEMANTIC_CONTENT_IR_PROTOCOL,
    python_unit_protocol: PYTHON_NESTED_UNIT_PROTOCOL,
    content_count: observed.size,
    content_bytes: contentBytes,
  })
}

async function verifyFileIdentity(root, slot) {
  const rel = safeRelative(slot?.file)
  const expectedSha =
    typeof slot?.sha256 === "string" && /^[0-9a-f]{64}$/iu.test(slot.sha256)
      ? slot.sha256.toLowerCase()
      : null
  if (!rel || !expectedSha) return fail("semantic_slot_identity_unavailable")

  const canonicalRoot = path.resolve(root)
  const absolute = path.resolve(root, rel)
  if (absolute === canonicalRoot || !absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
    return fail("semantic_slot_path_escape")
  }

  let raw
  try {
    raw = await readFile(absolute)
  } catch {
    return fail("semantic_slot_file_unavailable", { file: rel })
  }
  const observedSha = createHash("sha256").update(raw).digest("hex")
  if (observedSha !== expectedSha) {
    return fail("semantic_slot_occ_conflict", {
      file: rel,
      expected_sha256: expectedSha,
      observed_sha256: observedSha,
    })
  }
  return Object.freeze({ ok: true, file: rel, raw, text: raw.toString("utf8") })
}

function rawLines(text) {
  const matches = String(text).match(/.*?(?:\r\n|\n|\r|$)/gu) ?? []
  return matches.filter((line, index) => !(line === "" && index === matches.length - 1))
}

const lineBody = (line) => String(line ?? "").replace(/(?:\r\n|\n|\r)$/u, "")

function deriveNavigationPreimage(text, evidenceLines) {
  const lines = rawLines(text)
  const anchors = asArray(evidenceLines)
    .filter((line) => Number.isSafeInteger(line) && line >= 1 && line <= lines.length)
    .map((line) => line - 1)

  const candidates = new Map()
  for (const anchor of anchors) {
    let start = -1
    for (let index = anchor; index >= 0 && anchor - index <= 96; index -= 1) {
      if (/<li(?:\s|>)/iu.test(lineBody(lines[index]))) {
        start = index
        break
      }
    }
    if (start < 0) continue

    let end = -1
    for (let index = anchor; index < lines.length && index - anchor <= 96; index += 1) {
      if (/<\/li>/iu.test(lineBody(lines[index]))) {
        end = index
        break
      }
    }
    if (end < start || !(start <= anchor && anchor <= end)) continue
    const raw = lines.slice(start, end + 1).join("")
    if (raw) candidates.set(`${start}:${end}`, { start, end, raw })
  }

  if (candidates.size !== 1) {
    return fail("semantic_navigation_preimage_ambiguous", {
      candidates: candidates.size,
    })
  }
  const selected = [...candidates.values()][0]
  return Object.freeze({
    ok: true,
    before: selected.raw,
    start_line: selected.start + 1,
    end_line: selected.end + 1,
  })
}

const SEMANTIC_RESOURCE_NAMING_PROTOCOL =
  "semantic-resource-naming-v1"

const GENERIC_RESOURCE_WORDS = new Set([
  "page",
  "view",
  "handler",
  "route",
  "endpoint",
  "screen",
  "template",
  "surface",
  "ui",
  "new",
])

function normalizeResourceStem(value) {
  if (typeof value !== "string" || value.length < 1) return null
  const snake = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase()
    .replace(/_(?:page|view|handler|route|endpoint|screen|template)$/u, "")
    .replace(/^_+|_+$/gu, "")
  if (!snake || snake.length > 96) return null
  if (GENERIC_RESOURCE_WORDS.has(snake)) return null
  return snake
}

function sourceFamilyStem(sourceFile) {
  const source = safeRelative(sourceFile)
  if (!source) return null
  const base = path.posix.basename(source)
  const ext = path.posix.extname(base)
  const rawStem = ext ? base.slice(0, -ext.length) : base
  const reduced = rawStem
    .replace(/_(?:task|page|view|index|template|screen)$/iu, "")
    .replace(/^_+|_+$/gu, "")
  return normalizeResourceStem(reduced) ?? normalizeResourceStem(rawStem)
}

function routeStemFromPrefix(prefix) {
  const routePattern =
    /@\s*[A-Za-z_][A-Za-z0-9_.]*\.route\(\s*["']([^"']+)["']/gu
  const matches = [...String(prefix).matchAll(routePattern)]
  if (matches.length < 1) return null
  const route = matches[matches.length - 1][1]
  const parts = route
    .split("/")
    .filter((part) => part && !/[<>{}:]/u.test(part))
  if (parts.length < 1) return null
  return normalizeResourceStem(parts[parts.length - 1])
}

function functionStemFromPrefix(prefix) {
  const matches = [
    ...String(prefix).matchAll(
      /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu,
    ),
  ]
  if (matches.length < 1) return null
  return normalizeResourceStem(matches[matches.length - 1][1])
}

function combineFamilyAndStem(family, stem) {
  if (!stem) return null
  if (!family || stem === family || stem.startsWith(`${family}_`)) {
    return stem
  }
  return normalizeResourceStem(`${family}_${stem}`)
}

function inferSemanticResourceStem({
  createSlot,
  obligation,
} = {}) {
  const family = sourceFamilyStem(createSlot?.source_file)
  const obligationStem = normalizeResourceStem(obligation)
  const stem = combineFamilyAndStem(family, obligationStem) ?? family
  if (!stem) {
    return operationFailure("semantic_create_name_unavailable", {
      protocol: SEMANTIC_RESOURCE_NAMING_PROTOCOL,
    })
  }
  return Object.freeze({
    ok: true,
    protocol: SEMANTIC_RESOURCE_NAMING_PROTOCOL,
    stem,
    source: "sealed_capability",
    fallback: false,
    model_authority: false,
  })
}

function deriveDeterministicCreatePath({
  createSlot,
  obligation,
  operationId,
  contentById,
} = {}) {
  const extensions = asArray(createSlot?.allowed_extensions)
    .filter(
      (value) =>
        typeof value === "string" && /^\.[A-Za-z0-9]+$/u.test(value),
    )
    .map((value) => value.toLowerCase())

  if (extensions.length !== 1) {
    return operationFailure("semantic_create_path_inputs_invalid")
  }

  const naming = inferSemanticResourceStem({
    createSlot,
    obligation,
  })
  if (naming.ok !== true) return naming

  return Object.freeze({
    ok: true,
    protocol: SEMANTIC_RESOURCE_NAMING_PROTOCOL,
    relative_path: `${naming.stem}${extensions[0]}`,
    naming_source: naming.source,
    naming_fallback: naming.fallback,
    physical_path_model_authority: false,
  })
}

async function assertCreateTargetAbsent(root, createSlot, relativePath) {
  const rootRel = safeRelative(createSlot?.root)
  const leaf = safeRelative(relativePath)
  if (!rootRel || !leaf) return fail("semantic_create_target_invalid")
  const canonicalRoot = path.resolve(root, rootRel)
  const absolute = path.resolve(canonicalRoot, leaf)
  if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
    return fail("semantic_create_target_escape")
  }
  try {
    await stat(absolute)
    return fail("semantic_create_path_collision", { relative_path: leaf })
  } catch (error) {
    if (error?.code !== "ENOENT") return fail("semantic_create_target_stat_failed")
  }
  return Object.freeze({ ok: true, relative_path: leaf })
}


function substitutePlaceholders(content, deterministicValues) {
  let unresolved = null
  const substituted = String(content).replace(
    PLACEHOLDER_RE,
    (raw, kind, id) => {
      const key = `${kind}:${id}`
      if (!deterministicValues.has(key)) {
        unresolved = raw
        return raw
      }
      return deterministicValues.get(key)
    },
  )
  if (unresolved !== null || /@@(?:BEFORE|CREATE_PATH):op_[0-9]+@@/u.test(substituted)) {
    return fail("semantic_placeholder_unresolved", { placeholder: unresolved })
  }
  return Object.freeze({ ok: true, content: substituted })
}

function substituteResourceRefs(value, creationPath) {
  if (LEGACY_PLACEHOLDER_RE.test(String(value))) {
    return fail("semantic_placeholder_model_forbidden")
  }
  let unresolved = null
  const text = String(value).replace(
    RESOURCE_REF_RE,
    (raw, id) => {
      if (!creationPath.has(id)) {
        unresolved = raw
        return raw
      }
      return creationPath.get(id)
    },
  )
  if (unresolved !== null || RESOURCE_REF_RE.test(text)) {
    RESOURCE_REF_RE.lastIndex = 0
    return fail("semantic_resource_ref_unresolved", { resource_ref: unresolved })
  }
  RESOURCE_REF_RE.lastIndex = 0
  return Object.freeze({ ok: true, content: text })
}

function substituteResourceRefsInPythonUnit(
  unit,
  creationPath,
) {
  if (
    !unit ||
    typeof unit !== "object" ||
    Array.isArray(unit)
  ) {
    return fail(
      "semantic_python_unit_payload_invalid",
    )
  }

  const row = { ...unit }

  for (
    const field of [
      "parameters",
      "returns",
      "annotation",
      "value",
    ]
  ) {
    if (typeof row[field] !== "string") continue

    const replaced =
      substituteResourceRefs(
        row[field],
        creationPath,
      )

    if (replaced.ok !== true) {
      return replaced
    }

    row[field] = replaced.content
  }

  for (
    const field of [
      "decorators",
      "bases",
      "suite",
    ]
  ) {
    if (!Array.isArray(row[field])) continue

    const values = []

    for (const value of row[field]) {
      if (typeof value !== "string") {
        return fail(
          "semantic_python_unit_payload_invalid",
          { field },
        )
      }

      const replaced =
        substituteResourceRefs(
          value,
          creationPath,
        )

      if (replaced.ok !== true) {
        return replaced
      }

      values.push(replaced.content)
    }

    row[field] = values
  }

  if (Array.isArray(row.members)) {
    const members = []

    for (const member of row.members) {
      const replaced =
        substituteResourceRefsInPythonUnit(
          member,
          creationPath,
        )

      if (replaced.ok !== true) {
        return replaced
      }

      members.push(replaced.unit)
    }

    row.members = members
  }

  return Object.freeze({
    ok: true,
    unit: Object.freeze(row),
  })
}

function substituteResourceRefsInUnits(
  units,
  creationPath,
) {
  if (!Array.isArray(units)) {
    return fail(
      "semantic_python_unit_payload_invalid",
    )
  }

  const out = []

  for (const unit of units) {
    const replaced =
      substituteResourceRefsInPythonUnit(
        unit,
        creationPath,
      )

    if (replaced.ok !== true) {
      return replaced
    }

    out.push(replaced.unit)
  }

  return Object.freeze({
    ok: true,
    units: Object.freeze(out),
  })
}

function pythonImportHintsByOperation(spec, value) {
  if (value == null) {
    return Object.freeze({
      ok: true,
      byOperation: new Map(),
    })
  }
  if (!Array.isArray(value) || value.length > MAX_CONTENT_ITEMS) {
    return fail("semantic_python_import_hint_sidecar_invalid")
  }

  const operationById = new Map(
    asArray(spec?.operations).map((row) => [row.id, row]),
  )
  const byOperation = new Map()
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index]
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !["operation_id", "slot", "hints"].includes(key)) ||
      typeof row.operation_id !== "string" ||
      typeof row.slot !== "string" ||
      !Array.isArray(row.hints) ||
      row.hints.length > 128
    ) {
      return fail("semantic_python_import_hint_sidecar_row_invalid", {
        hint_index: index,
      })
    }
    const operation = operationById.get(row.operation_id)
    if (
      !operation ||
      operation.kind !== "python_declaration" ||
      operation.slot !== row.slot ||
      byOperation.has(row.operation_id)
    ) {
      return fail("semantic_python_import_hint_sidecar_authority_invalid", {
        operation_id: row.operation_id,
      })
    }

    const hints = []
    for (let hintIndex = 0; hintIndex < row.hints.length; hintIndex += 1) {
      const hint = row.hints[hintIndex]
      if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
        return fail("semantic_python_import_hint_sidecar_hint_invalid", {
          operation_id: row.operation_id,
          hint_index: hintIndex,
        })
      }
      const fields = Object.keys(hint)
      const allowed = new Set([
        "kind", "module", "name", "local", "canonical", "alias", "source",
      ])
      const required = ["kind", "module", "local", "canonical", "source"]
      if (
        fields.some((field) => !allowed.has(field)) ||
        required.some((field) => typeof hint[field] !== "string" || hint[field].length < 1) ||
        hint.source !== "model_static_import_hint" ||
        !["module", "from"].includes(hint.kind) ||
        (hint.alias != null && (typeof hint.alias !== "string" || hint.alias.length < 1)) ||
        (hint.kind === "module" && hint.name != null) ||
        (hint.kind === "from" && (typeof hint.name !== "string" || hint.name.length < 1))
      ) {
        return fail("semantic_python_import_hint_sidecar_hint_invalid", {
          operation_id: row.operation_id,
          hint_index: hintIndex,
        })
      }
      hints.push(Object.freeze({ ...hint }))
    }
    byOperation.set(row.operation_id, Object.freeze(hints))
  }
  return Object.freeze({ ok: true, byOperation })
}


const PYTHON_FRONTEND_DIAGNOSTIC_MAX_NAMES = 32
const PYTHON_FRONTEND_DIAGNOSTIC_MAX_SYMBOL_BYTES = 256

function boundedDiagnosticName(value) {
  if (typeof value !== "string" || value.length < 1) {
    return null
  }
  if (
    Buffer.byteLength(value, "utf8") >
    PYTHON_FRONTEND_DIAGNOSTIC_MAX_SYMBOL_BYTES
  ) {
    return null
  }
  return value
}

export function projectPythonFrontendDiagnostic(
  compiled,
) {
  const symbol = boundedDiagnosticName(
    compiled?.symbol,
  )

  const observedFreeNames = Array.isArray(
    compiled?.free_names,
  )
    ? compiled.free_names
        .map(boundedDiagnosticName)
        .filter(Boolean)
    : []

  const freeNames = [
    ...new Set(observedFreeNames),
  ].sort()

  const boundedFreeNames = freeNames.slice(
    0,
    PYTHON_FRONTEND_DIAGNOSTIC_MAX_NAMES,
  )

  const repoPythonFilesScanned =
    Number.isSafeInteger(
      compiled?.repo_python_files_scanned,
    ) &&
    compiled.repo_python_files_scanned >= 0
      ? compiled.repo_python_files_scanned
      : null

  const repoPythonBytesScanned =
    Number.isSafeInteger(
      compiled?.repo_python_bytes_scanned,
    ) &&
    compiled.repo_python_bytes_scanned >= 0
      ? compiled.repo_python_bytes_scanned
      : null

  return Object.freeze({
    symbol,
    free_names:
      boundedFreeNames.length > 0
        ? Object.freeze(boundedFreeNames)
        : null,
    free_names_total: freeNames.length,
    free_names_truncated:
      freeNames.length > boundedFreeNames.length,
    repo_python_files_scanned:
      repoPythonFilesScanned,
    repo_python_bytes_scanned:
      repoPythonBytesScanned,
    diagnostic_authority:
      "python_semantic_frontend",
    mutation_authority: false,
  })
}

export async function materializeSemanticAdditiveRequest({
  root,
  capability,
  request,
  pythonImportHints = null,
} = {}) {
  if (typeof root !== "string" || root.length < 1) {
    return fail("semantic_project_root_unavailable")
  }

  const spec = deriveSemanticContentSpec({ capability })
  if (spec.ok !== true) return spec
  const importHints = pythonImportHintsByOperation(spec, pythonImportHints)
  if (importHints.ok !== true) return importHints
  const shape = validateSemanticContentRequest({ spec, request })
  if (shape.ok !== true) return shape

  const fileFamilyContract =
    deriveFileFamilyContract({
      operations: spec.operations,
      capability,
    })

  if (fileFamilyContract.ok !== true) {
    return fail(
      "semantic_file_family_contract_invalid",
      {
        family_reason:
          fileFamilyContract.reason ??
          null,
        file_family_contract:
          fileFamilyContract,
      },
    )
  }

  const fileFamilyById = new Map(
    fileFamilyContract.operations.map(
      (row) => [
        row.operation_id,
        row,
      ],
    ),
  )

  const contentById = new Map(request.contents.map((item) => [item.id, item.content]))
  const existing = new Map(asArray(capability.existing_slots).map((slot) => [slot.slot, slot]))
  const creates = new Map(asArray(capability.create_slots).map((slot) => [slot.slot, slot]))

  for (
    let operationIndex = 0;
    operationIndex < spec.operations.length;
    operationIndex += 1
  ) {
    const operation =
      spec.operations[operationIndex]

    if (
      operation.kind ===
      "python_declaration"
    ) {
      continue
    }

    const payload =
      contentById.get(operation.id)

    const familyContract =
      fileFamilyById.get(operation.id)

    const familyCheck =
      validateOperationFileFamilyContent({
        contract: familyContract,
        text: payload?.text,
      })

    if (familyCheck.ok !== true) {
      return fail(
        "semantic_file_family_mismatch",
        {
          id: operation.id,
          operation_index:
            operationIndex,
          field: "content",
          file_family:
            familyContract?.family ??
            null,
          representation:
            familyContract
              ?.representation ??
            null,
          family_reason:
            familyCheck.reason ??
            null,
          foreign_family:
            familyCheck
              ?.foreign_family ??
            null,
          family_signal:
            familyCheck.signal ??
            null,
        },
      )
    }
  }

  const replacementBefore = new Map()
  const creationPath = new Map()

  for (const operation of spec.operations) {
    if (operation.kind === "replacement") {
      const slot = existing.get(operation.slot)
      const identity = await verifyFileIdentity(root, slot)
      if (identity.ok !== true) return identity
      const preimage = deriveNavigationPreimage(identity.text, slot?.evidence_lines)
      if (preimage.ok !== true) return preimage
      replacementBefore.set(operation.id, preimage.before)
    }
    if (operation.kind === "creation") {
      const slot = creates.get(operation.slot)
      const derived = deriveDeterministicCreatePath({
        createSlot: slot,
        obligation: operation.obligation,
        operationId: operation.id,
        contentById,
      })
      if (derived.ok !== true) return derived
      const absent = await assertCreateTargetAbsent(root, slot, derived.relative_path)
      if (absent.ok !== true) return absent
      creationPath.set(operation.id, derived.relative_path)
    }
  }

  const python_imports = []
  const python_declarations = []
  const replacements = []
  const creations = []
  const python_frontend_rows = []

  for (const operation of spec.operations) {
    const payload = contentById.get(operation.id)

    if (operation.kind === "python_declaration") {
      const slot = existing.get(operation.slot)
      const identity = await verifyFileIdentity(root, slot)
      if (identity.ok !== true) return identity

      if (
        payload?.kind !== "python_units" ||
        !Array.isArray(payload.units)
      ) {
        return fail("semantic_python_unit_payload_invalid", {
          id: operation.id,
        })
      }

      const resourceUnits = substituteResourceRefsInUnits(
        payload.units,
        creationPath,
      )
      if (resourceUnits.ok !== true) return resourceUnits

      const nested =
        lowerPythonNestedSemanticUnits(
          resourceUnits.units,
        )

      if (nested.ok !== true) {
        const operationIndex =
          spec.operations.findIndex(
            (row) =>
              row.id === operation.id,
          )

        return fail(
          nested.reason ??
            "semantic_python_nested_ir_failed",
          {
            id: operation.id,
            operation_id:
              operation.id,
            operation_index:
              operationIndex >= 0
                ? operationIndex
                : null,
            unit_index:
              Number.isSafeInteger(
                nested.unit_index,
              )
                ? nested.unit_index
                : null,
            unit_path:
              Array.isArray(
                nested.unit_path,
              )
                ? [...nested.unit_path]
                : null,
            suite_index:
              Number.isSafeInteger(
                nested.suite_index,
              )
                ? nested.suite_index
                : null,
            field:
              typeof nested.field ===
              "string"
                ? nested.field
                : Array.isArray(
                      nested.unexpected_fields,
                    ) &&
                    nested.unexpected_fields.length === 1
                  ? nested.unexpected_fields[0]
                  : null,
            unexpected_fields:
              Array.isArray(
                nested.unexpected_fields,
              )
                ? [...nested.unexpected_fields]
                : null,
            nested_ir_protocol:
              nested.protocol ??
              PYTHON_NESTED_SEMANTIC_IR_PROTOCOL,
            suite_protocol:
              nested.suite_protocol ??
              PYTHON_SUITE_IR_PROTOCOL,
            frontend: nested,
          },
        )
      }

      const compiled = await compilePythonSemanticUnits({
        root,
        target_file: identity.file,
        source: identity.text,
        units: nested.units,
        module_import_hints:
          importHints.byOperation.get(operation.id) ?? [],
        operation_id: operation.id,
        capability_sha256: capability?.capability_sha256 ?? null,
      })
      if (compiled.ok !== true) {
        const operationIndex =
          spec.operations.findIndex(
            (row) =>
              row.id === operation.id,
          )

        return fail(
          compiled.reason ??
            "semantic_python_frontend_failed",
          {
            id: operation.id,
            operation_id:
              operation.id,
            operation_index:
              operationIndex >= 0
                ? operationIndex
                : null,
            unit_index:
              Number.isSafeInteger(
                compiled.unit_index,
              )
                ? compiled.unit_index
                : null,
            unit_path:
              Array.isArray(
                compiled.unit_path,
              )
                ? [...compiled.unit_path]
                : null,
            suite_index:
              Number.isSafeInteger(
                compiled.suite_index,
              )
                ? compiled.suite_index
                : null,
            field:
              typeof compiled.field ===
              "string"
                ? compiled.field
                : null,
            ...projectPythonFrontendDiagnostic(
              compiled,
            ),
            frontend_reason:
              compiled.reason ?? null,
            frontend: compiled,
          },
        )
      }

      if (compiled.modules.length || compiled.from_imports.length) {
        python_imports.push({
          slot: operation.slot,
          modules: [...compiled.modules],
          from_imports: [...compiled.from_imports],
        })
      }
      python_declarations.push({
        slot: operation.slot,
        content: compiled.declaration,
      })
      python_frontend_rows.push({
        operation_id: operation.id,
        protocol: compiled.protocol,
        canonicalizer_protocol: compiled.canonicalizer_protocol,
        ruff_bridge_protocol: compiled.ruff_bridge_protocol,
        binding_protocol: compiled.binding_protocol,
        provenance_protocol: compiled.provenance_protocol,
        bindings: compiled.bindings,
        alias_rewrites: compiled.alias_rewrites,
        normalizations: compiled.normalizations,
        model_import_hints: compiled.model_import_hints,
        scope_protocol: compiled.scope_protocol,
        scope_sha256: compiled.scope_sha256,
        scoped_imports: compiled.scoped_imports,
        scope_summary: compiled.scope_summary,
        authority_expansion: compiled.authority_expansion,
        provenance: compiled.provenance,
      })
      continue
    }

    if (
      payload?.kind !== "text" ||
      typeof payload.text !== "string" ||
      typeof payload.mode !== "string"
    ) {
      return fail("semantic_text_payload_invalid", {
        id: operation.id,
      })
    }
    const resourceText = substituteResourceRefs(
      payload.text,
      creationPath,
    )
    if (resourceText.ok !== true) return resourceText

    if (operation.kind === "replacement") {
      const before = replacementBefore.get(operation.id)
      if (!before) return fail("semantic_preimage_missing", { id: operation.id })
      let replacement = null
      if (payload.mode === "before") {
        replacement = `${resourceText.content}${before}`
      } else if (payload.mode === "after") {
        replacement = `${before}${resourceText.content}`
      } else if (payload.mode === "replace") {
        replacement = resourceText.content
      } else {
        return fail("semantic_text_mode_invalid", {
          id: operation.id,
          mode: payload.mode,
        })
      }
      replacements.push({
        slot: operation.slot,
        before,
        replacement,
      })
      continue
    }

    if (operation.kind === "creation") {
      if (payload.mode !== "create") {
        return fail("semantic_text_mode_invalid", {
          id: operation.id,
          mode: payload.mode,
        })
      }
      const relative_path = creationPath.get(operation.id)
      if (!relative_path) return fail("semantic_create_path_missing", { id: operation.id })
      creations.push({
        slot: operation.slot,
        relative_path,
        content: resourceText.content,
      })
      continue
    }

    return fail("semantic_operation_kind_unsupported", {
      id: operation.id,
      kind: operation.kind,
    })
  }

  const materialized = {
    python_imports,
    python_declarations,
    replacements,
    creations,
  }
  return Object.freeze({
    ok: true,
    protocol: DETERMINISTIC_MATERIALIZER_PROTOCOL,
    semantic_ir_protocol: SEMANTIC_CONTENT_IR_PROTOCOL,
    spec_sha256: stableSha(spec),
    content_sha256: stableSha(request),
    request: Object.freeze(materialized),
    operation_count: spec.operations.length,
    content_bytes: shape.content_bytes,
    python_frontend_protocol: PYTHON_SEMANTIC_FRONTEND_PROTOCOL,
    python_unit_protocol: PYTHON_NESTED_UNIT_PROTOCOL,
    python_binding_protocol: PYTHON_BINDING_CAPABILITY_PROTOCOL,
    provenance_protocol: KOALIK_PROVENANCE_PROTOCOL,
    python_frontend: Object.freeze(python_frontend_rows),
    mutation_authority: false,
    model_authority: spec.model_authority,
  })
}
