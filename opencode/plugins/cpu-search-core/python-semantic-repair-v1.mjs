import { createHash } from "node:crypto"

export const PYTHON_SEMANTIC_REPAIR_PROTOCOL =
  "python-semantic-repair-v1"

const REPAIRABLE_REASONS = new Set([
  "semantic_suite_item_syntax_invalid",
  "semantic_suite_item_statement_count_invalid",
  "semantic_suite_item_empty",
  "python_nested_unit_fields_invalid",
  "python_nested_repeated_member_cycle",
  "python_nested_class_member_identity_conflict",
  "python_nested_suite_missing",
  "python_nested_class_members_invalid",
  "python_nested_class_unsupported",
  "python_nested_kind_unsupported",
  "ruff_python_syntax_invalid",
])

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
}

function payloadFrom({
  failure,
  capability,
  request,
  executionContextSha256,
} = {}) {
  return {
    protocol:
      PYTHON_SEMANTIC_REPAIR_PROTOCOL,
    reason:
      failure?.reason ?? null,
    operation_id:
      failure?.operation_id ??
      failure?.id ??
      null,
    operation_index:
      Number.isSafeInteger(
        failure?.operation_index,
      )
        ? failure.operation_index
        : null,
    unit_index:
      Number.isSafeInteger(
        failure?.unit_index,
      )
        ? failure.unit_index
        : null,
    unit_path:
      Array.isArray(
        failure?.unit_path,
      )
        ? [...failure.unit_path]
        : null,
    suite_index:
      Number.isSafeInteger(
        failure?.suite_index,
      )
        ? failure.suite_index
        : null,
    field:
      typeof failure?.field ===
      "string"
        ? failure.field
        : null,
    unexpected_fields:
      Array.isArray(
        failure?.unexpected_fields,
      )
        ? [...failure.unexpected_fields]
        : null,
    frontend_reason:
      failure?.frontend_reason ??
      failure?.reason ??
      null,
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

export function pythonSemanticFailureIsRepairable(
  failure,
) {
  const reason =
    failure?.reason

  if (
    typeof reason !== "string" ||
    !REPAIRABLE_REASONS.has(reason)
  ) {
    return false
  }

  const operationId =
    failure?.operation_id ??
    failure?.id

  if (
    typeof operationId !== "string" ||
    !Number.isSafeInteger(
      failure?.operation_index,
    )
  ) {
    return false
  }

  if (
    reason.startsWith(
      "semantic_suite_item_",
    )
  ) {
    return (
      Number.isSafeInteger(
        failure?.unit_index,
      ) &&
      Number.isSafeInteger(
        failure?.suite_index,
      ) &&
      failure?.field === "suite"
    )
  }

  return true
}

export function buildPythonSemanticRepairHint({
  failure,
  capability,
  request,
  executionContextSha256,
} = {}) {
  const payload =
    payloadFrom({
      failure,
      capability,
      request,
      executionContextSha256,
    })

  const repairable =
    pythonSemanticFailureIsRepairable(
      failure,
    ) &&
    capability?.ready === true &&
    capability?.mutation_authority ===
      true &&
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

export function pythonSemanticRepairAuthorityMatches({
  hint,
  capability,
  executionContextSha256,
} = {}) {
  if (
    hint?.protocol !==
      PYTHON_SEMANTIC_REPAIR_PROTOCOL ||
    hint?.repairable !== true ||
    capability?.ready !== true ||
    capability?.mutation_authority !==
      true ||
    hint.capability_sha256 !==
      capability.capability_sha256 ||
    hint.authority_sha256 !==
      capability.authority_sha256 ||
    typeof executionContextSha256 !==
      "string" ||
    hint.execution_context_sha256 !==
      executionContextSha256 ||
    typeof hint.hint_sha256 !==
      "string"
  ) {
    return false
  }

  const payload = {
    protocol:
      PYTHON_SEMANTIC_REPAIR_PROTOCOL,
    reason:
      hint.reason ?? null,
    operation_id:
      hint.operation_id ?? null,
    operation_index:
      Number.isSafeInteger(
        hint.operation_index,
      )
        ? hint.operation_index
        : null,
    unit_index:
      Number.isSafeInteger(
        hint.unit_index,
      )
        ? hint.unit_index
        : null,
    unit_path:
      Array.isArray(
        hint.unit_path,
      )
        ? [...hint.unit_path]
        : null,
    suite_index:
      Number.isSafeInteger(
        hint.suite_index,
      )
        ? hint.suite_index
        : null,
    field:
      hint.field ?? null,
    unexpected_fields:
      Array.isArray(
        hint.unexpected_fields,
      )
        ? [...hint.unexpected_fields]
        : null,
    frontend_reason:
      hint.frontend_reason ?? null,
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
