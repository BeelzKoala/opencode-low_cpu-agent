import { createHash } from "node:crypto"
import path from "node:path"

export const FILE_FAMILY_CONTRACT_PROTOCOL =
  "file-family-contract-v1"

export const FILE_FAMILY_REPAIR_PROTOCOL =
  "file-family-repair-v1"

const EXTENSION_FAMILY = Object.freeze({
  ".py": "python",
  ".pyi": "python",

  ".html": "markup_template",
  ".htm": "markup_template",
  ".jinja": "markup_template",
  ".jinja2": "markup_template",
  ".j2": "markup_template",

  ".xml": "xml",

  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",

  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",

  ".css": "stylesheet",
  ".scss": "stylesheet",
  ".sass": "stylesheet",
  ".less": "stylesheet",

  ".sql": "sql",
})

const TEXT_FAMILIES = new Set([
  "markup_template",
  "xml",
  "javascript",
  "typescript",
  "stylesheet",
  "sql",
])

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: FILE_FAMILY_CONTRACT_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function normalizeExtension(value) {
  if (typeof value !== "string") return null

  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null

  const extension =
    trimmed.startsWith(".")
      ? trimmed
      : `.${trimmed}`

  return /^\.[a-z0-9]+$/u.test(extension)
    ? extension
    : null
}

function familyForExtension(extension) {
  return EXTENSION_FAMILY[extension] ?? null
}

function representationFor({
  family,
  operationKind,
} = {}) {
  if (family === "python") {
    return operationKind === "python_declaration"
      ? Object.freeze({
          representation: "python_units",
          validation: "ruff_python_frontend",
        })
      : null
  }

  if (operationKind === "python_declaration") {
    return null
  }

  if (family === "markup_template") {
    return Object.freeze({
      representation:
        operationKind === "creation"
          ? "markup_document"
          : "markup_fragment",
      validation:
        "conservative_foreign_source_guard",
    })
  }

  if (family === "xml") {
    return Object.freeze({
      representation:
        operationKind === "creation"
          ? "xml_document"
          : "xml_fragment",
      validation:
        "conservative_foreign_source_guard",
    })
  }

  if (family === "javascript") {
    return Object.freeze({
      representation: "javascript_source",
      validation:
        "conservative_foreign_source_guard",
    })
  }

  if (family === "typescript") {
    return Object.freeze({
      representation: "typescript_source",
      validation:
        "conservative_foreign_source_guard",
    })
  }

  if (family === "stylesheet") {
    return Object.freeze({
      representation: "stylesheet_source",
      validation:
        "conservative_foreign_source_guard",
    })
  }

  if (family === "sql") {
    return Object.freeze({
      representation: "sql_source",
      validation:
        "conservative_foreign_source_guard",
    })
  }

  return null
}

export function resolveFileFamily({
  file = null,
  allowedExtensions = null,
  operationKind = null,
} = {}) {
  let extensions = []

  if (typeof file === "string" && file.length > 0) {
    const extension =
      normalizeExtension(path.extname(file))

    if (!extension) {
      return fail(
        "file_family_extension_unavailable",
      )
    }

    extensions = [extension]
  } else if (Array.isArray(allowedExtensions)) {
    extensions = [
      ...new Set(
        allowedExtensions
          .map(normalizeExtension)
          .filter(Boolean),
      ),
    ].sort()

    if (
      extensions.length < 1 ||
      extensions.length !==
        allowedExtensions.length
    ) {
      return fail(
        "file_family_extension_set_invalid",
      )
    }
  } else {
    return fail(
      "file_family_target_unavailable",
    )
  }

  const families = new Set()

  for (const extension of extensions) {
    const family =
      familyForExtension(extension)

    if (!family) {
      return fail(
        "file_family_extension_unsupported",
        { extension },
      )
    }

    families.add(family)
  }

  if (families.size !== 1) {
    return fail(
      "file_family_extension_set_mixed",
      {
        extensions: Object.freeze(
          [...extensions],
        ),
      },
    )
  }

  const family = [...families][0]
  const representation =
    representationFor({
      family,
      operationKind,
    })

  if (!representation) {
    return fail(
      "file_family_operation_incompatible",
      {
        family,
        operation_kind:
          operationKind ?? null,
      },
    )
  }

  return Object.freeze({
    ok: true,
    protocol:
      FILE_FAMILY_CONTRACT_PROTOCOL,
    family,
    representation:
      representation.representation,
    validation:
      representation.validation,
    extensions: Object.freeze(
      [...extensions],
    ),
    mutation_authority: false,
  })
}

function exactSlot(rows, slot) {
  const matches =
    Array.isArray(rows)
      ? rows.filter(
          (row) => row?.slot === slot,
        )
      : []

  return matches.length === 1
    ? matches[0]
    : null
}

function bindOperation({
  operation,
  capability,
} = {}) {
  if (
    !operation ||
    typeof operation !== "object" ||
    typeof operation.id !== "string" ||
    typeof operation.slot !== "string" ||
    typeof operation.kind !== "string"
  ) {
    return fail(
      "file_family_operation_invalid",
    )
  }

  if (
    operation.kind ===
      "python_declaration" ||
    operation.kind === "replacement"
  ) {
    const slot =
      exactSlot(
        capability?.existing_slots,
        operation.slot,
      )

    if (!slot) {
      return fail(
        "file_family_existing_slot_unbound",
        {
          operation_id: operation.id,
          slot: operation.slot,
        },
      )
    }

    const resolved =
      resolveFileFamily({
        file: slot.file,
        operationKind: operation.kind,
      })

    if (resolved.ok !== true) {
      return fail(
        resolved.reason,
        {
          operation_id: operation.id,
          slot: operation.slot,
          operation_kind:
            operation.kind,
          target_kind: "existing",
          family_detail: resolved,
        },
      )
    }

    return Object.freeze({
      ok: true,
      operation_id: operation.id,
      slot: operation.slot,
      operation_kind: operation.kind,
      target_kind: "existing",
      family: resolved.family,
      representation:
        resolved.representation,
      validation:
        resolved.validation,
      extensions: resolved.extensions,
      mutation_authority: false,
    })
  }

  if (operation.kind === "creation") {
    const slot =
      exactSlot(
        capability?.create_slots,
        operation.slot,
      )

    if (!slot) {
      return fail(
        "file_family_create_slot_unbound",
        {
          operation_id: operation.id,
          slot: operation.slot,
        },
      )
    }

    const resolved =
      resolveFileFamily({
        allowedExtensions:
          slot.allowed_extensions,
        operationKind: operation.kind,
      })

    if (resolved.ok !== true) {
      return fail(
        resolved.reason,
        {
          operation_id: operation.id,
          slot: operation.slot,
          operation_kind:
            operation.kind,
          target_kind: "creation",
          family_detail: resolved,
        },
      )
    }

    return Object.freeze({
      ok: true,
      operation_id: operation.id,
      slot: operation.slot,
      operation_kind: operation.kind,
      target_kind: "creation",
      family: resolved.family,
      representation:
        resolved.representation,
      validation:
        resolved.validation,
      extensions: resolved.extensions,
      mutation_authority: false,
    })
  }

  return fail(
    "file_family_operation_kind_unsupported",
    {
      operation_id:
        operation.id ?? null,
      operation_kind:
        operation.kind ?? null,
    },
  )
}

export function deriveFileFamilyContract({
  operations,
  capability,
} = {}) {
  if (
    !Array.isArray(operations) ||
    operations.length < 1
  ) {
    return fail(
      "file_family_operations_unavailable",
    )
  }

  if (
    capability?.ready !== true ||
    capability?.mutation_authority !== true
  ) {
    return fail(
      "file_family_capability_not_authorized",
    )
  }

  const rows = []
  const ids = new Set()

  for (const operation of operations) {
    if (
      typeof operation?.id !== "string" ||
      ids.has(operation.id)
    ) {
      return fail(
        "file_family_operation_identity_invalid",
      )
    }

    ids.add(operation.id)

    const row =
      bindOperation({
        operation,
        capability,
      })

    if (row.ok !== true) {
      return row
    }

    rows.push(row)
  }

  const payload = {
    protocol:
      FILE_FAMILY_CONTRACT_PROTOCOL,
    capability_sha256:
      capability.capability_sha256 ??
      null,
    authority_sha256:
      capability.authority_sha256 ??
      null,
    operations: rows.map((row) => ({
      operation_id: row.operation_id,
      slot: row.slot,
      operation_kind:
        row.operation_kind,
      target_kind: row.target_kind,
      family: row.family,
      representation:
        row.representation,
      validation: row.validation,
      extensions: [...row.extensions],
    })),
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    ...payload,
    operations: Object.freeze(
      rows.map((row) =>
        Object.freeze({ ...row }),
      ),
    ),
    contract_sha256:
      stableSha(payload),
  })
}

export function renderFileFamilyContract(
  contract,
) {
  if (contract?.ok !== true) return ""

  const lines = [
    `FILE_FAMILY_CONTRACT protocol=${FILE_FAMILY_CONTRACT_PROTOCOL} ` +
      "authority=compiler_owned model_retarget=false",
  ]

  for (
    const row of
    contract.operations ?? []
  ) {
    lines.push(
      `FILE_FAMILY_OPERATION id=${row.operation_id} ` +
        `family=${row.family} ` +
        `representation=${row.representation} ` +
        `validation=${row.validation} ` +
        "content_must_match_target_family=true",
    )
  }

  return lines.join("\n")
}

function significantLines(text) {
  return String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("#"),
    )
    .slice(0, 12)
}

function pythonDefinitionLine(line) {
  return (
    /^(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/u
      .test(line) ||
    /^class\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?\s*:/u
      .test(line)
  )
}

function standalonePythonSignal(text) {
  const lines = significantLines(text)

  if (lines.length < 1) return null

  const first = lines[0]

  if (
    /^#!.*\bpython(?:[0-9.]*)?\b/iu.test(
      first,
    )
  ) {
    return "python_shebang"
  }

  if (pythonDefinitionLine(first)) {
    return "python_definition"
  }

  if (
    /^if\s+__name__\s*==\s*["']__main__["']\s*:/u
      .test(first)
  ) {
    return "python_main_guard"
  }

  if (first.startsWith("@")) {
    let index = 0

    while (
      index < lines.length &&
      lines[index].startsWith("@") &&
      index < 6
    ) {
      index += 1
    }

    if (
      index < lines.length &&
      pythonDefinitionLine(
        lines[index],
      )
    ) {
      return "python_decorated_definition"
    }
  }

  if (
    /^(?:from\s+[A-Za-z_][A-Za-z0-9_.]*\s+import\s+|import\s+[A-Za-z_][A-Za-z0-9_.]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$)/u
      .test(first)
  ) {
    for (
      let index = 1;
      index < Math.min(lines.length, 8);
      index += 1
    ) {
      if (
        pythonDefinitionLine(
          lines[index],
        )
      ) {
        return "python_import_definition"
      }

      if (
        lines[index].startsWith("@") &&
        index + 1 < lines.length &&
        pythonDefinitionLine(
          lines[index + 1],
        )
      ) {
        return "python_import_decorated_definition"
      }
    }
  }

  return null
}

export function validateOperationFileFamilyContent({
  contract,
  text,
} = {}) {
  if (
    !contract ||
    typeof contract !== "object" ||
    typeof contract.family !== "string" ||
    typeof contract.representation !==
      "string"
  ) {
    return fail(
      "file_family_operation_contract_invalid",
    )
  }

  if (contract.family === "python") {
    return fail(
      "file_family_python_text_forbidden",
      {
        family: contract.family,
        representation:
          contract.representation,
      },
    )
  }

  if (!TEXT_FAMILIES.has(contract.family)) {
    return fail(
      "file_family_text_family_unsupported",
      {
        family:
          contract.family ?? null,
      },
    )
  }

  if (typeof text !== "string") {
    return fail(
      "file_family_content_invalid",
      {
        family: contract.family,
        representation:
          contract.representation,
      },
    )
  }

  const pythonSignal =
    standalonePythonSignal(text)

  if (pythonSignal) {
    return fail(
      "file_family_foreign_python_source",
      {
        family: contract.family,
        representation:
          contract.representation,
        foreign_family: "python",
        signal: pythonSignal,
      },
    )
  }

  return Object.freeze({
    ok: true,
    protocol:
      FILE_FAMILY_CONTRACT_PROTOCOL,
    family: contract.family,
    representation:
      contract.representation,
    validation:
      contract.validation ??
      "conservative_foreign_source_guard",
    validation_strength:
      "conservative_family_compatibility",
    mutation_authority: false,
  })
}

function repairPayload({
  failure,
  capability,
  request,
  executionContextSha256,
} = {}) {
  return {
    protocol:
      FILE_FAMILY_REPAIR_PROTOCOL,
    reason:
      failure?.reason ?? null,
    operation_id:
      failure?.id ?? null,
    operation_index:
      Number.isSafeInteger(
        failure?.operation_index,
      )
        ? failure.operation_index
        : null,
    field:
      failure?.field ?? null,
    file_family:
      failure?.file_family ?? null,
    representation:
      failure?.representation ?? null,
    foreign_family:
      failure?.foreign_family ?? null,
    capability_sha256:
      capability?.capability_sha256 ??
      null,
    authority_sha256:
      capability?.authority_sha256 ??
      null,
    execution_context_sha256:
      executionContextSha256 ?? null,
    failed_request_sha256:
      request &&
      typeof request === "object"
        ? stableSha(request)
        : null,
    mutation_authority: false,
  }
}

export function buildFileFamilyRepairHint({
  failure,
  capability,
  request,
  executionContextSha256,
} = {}) {
  const payload =
    repairPayload({
      failure,
      capability,
      request,
      executionContextSha256,
    })

  const repairable =
    failure?.reason ===
      "semantic_file_family_mismatch" &&
    typeof payload.operation_id ===
      "string" &&
    Number.isSafeInteger(
      payload.operation_index,
    ) &&
    typeof payload.file_family ===
      "string" &&
    typeof payload.representation ===
      "string" &&
    typeof payload.capability_sha256 ===
      "string" &&
    typeof payload.authority_sha256 ===
      "string" &&
    typeof payload.execution_context_sha256 ===
      "string" &&
    typeof payload.failed_request_sha256 ===
      "string"

  return Object.freeze({
    ...payload,
    repairable,
    hint_sha256:
      stableSha(payload),
  })
}

export function fileFamilyRepairAuthorityMatches({
  hint,
  capability,
  executionContextSha256,
} = {}) {
  if (
    hint?.protocol !==
      FILE_FAMILY_REPAIR_PROTOCOL ||
    hint?.repairable !== true ||
    capability?.ready !== true ||
    capability?.mutation_authority !== true ||
    hint.capability_sha256 !==
      capability.capability_sha256 ||
    hint.authority_sha256 !==
      capability.authority_sha256 ||
    typeof executionContextSha256 !==
      "string" ||
    hint.execution_context_sha256 !==
      executionContextSha256 ||
    typeof hint.hint_sha256 !== "string"
  ) {
    return false
  }

  const payload = {
    protocol:
      FILE_FAMILY_REPAIR_PROTOCOL,
    reason: hint.reason ?? null,
    operation_id:
      hint.operation_id ?? null,
    operation_index:
      Number.isSafeInteger(
        hint.operation_index,
      )
        ? hint.operation_index
        : null,
    field: hint.field ?? null,
    file_family:
      hint.file_family ?? null,
    representation:
      hint.representation ?? null,
    foreign_family:
      hint.foreign_family ?? null,
    capability_sha256:
      hint.capability_sha256 ?? null,
    authority_sha256:
      hint.authority_sha256 ?? null,
    execution_context_sha256:
      hint.execution_context_sha256 ??
      null,
    failed_request_sha256:
      hint.failed_request_sha256 ??
      null,
    mutation_authority: false,
  }

  return (
    stableSha(payload) ===
    hint.hint_sha256
  )
}
