import { createHash } from "node:crypto"

export const CAUSAL_DISPATCH_CONTRACT_PROTOCOL =
  "causal-dispatch-contract-v1"

const SHA256_RE = /^[0-9a-f]{64}$/u
const OP_ID_RE = /^op_[0-9]+$/u
const TOKEN_RE = /^[A-Za-z0-9_.:-]+$/u
const SOURCE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/u
const MAX_OPERATIONS = 8

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha(value) {
  return createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("hex")
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: CAUSAL_DISPATCH_CONTRACT_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function operationView(row) {
  return Object.freeze({
    id: row.id,
    obligation: row.obligation,
    ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
  })
}

function validOperation(row) {
  return (
    row &&
    typeof row === "object" &&
    typeof row.id === "string" &&
    OP_ID_RE.test(row.id) &&
    typeof row.obligation === "string" &&
    row.obligation.length >= 1 &&
    row.obligation.length <= 128 &&
    TOKEN_RE.test(row.obligation) &&
    (
      row.kind == null ||
      (
        typeof row.kind === "string" &&
        row.kind.length >= 1 &&
        row.kind.length <= 64 &&
        TOKEN_RE.test(row.kind)
      )
    )
  )
}

function validateCanonical(contract, attestation) {
  if (
    contract?.ok !== true ||
    typeof contract.contract_sha256 !== "string" ||
    !SHA256_RE.test(contract.contract_sha256) ||
    !Array.isArray(contract.operations) ||
    contract.operations.length < 1 ||
    contract.operations.length > MAX_OPERATIONS
  ) {
    return fail("dispatch_contract_semantic_contract_invalid")
  }

  if (
    !attestation ||
    typeof attestation !== "object" ||
    attestation.contract_sha256 !== contract.contract_sha256 ||
    typeof attestation.attestation_sha256 !== "string" ||
    !SHA256_RE.test(attestation.attestation_sha256) ||
    typeof attestation.capability_fingerprint_sha256 !== "string" ||
    !SHA256_RE.test(attestation.capability_fingerprint_sha256) ||
    !Array.isArray(attestation.operation_ids) ||
    attestation.operation_ids.length !== contract.operations.length
  ) {
    return fail("dispatch_contract_semantic_attestation_invalid")
  }

  const seen = new Set()
  const operations = []

  for (let index = 0; index < contract.operations.length; index += 1) {
    const row = contract.operations[index]
    if (
      !validOperation(row) ||
      attestation.operation_ids[index] !== row.id ||
      seen.has(row.id)
    ) {
      return fail("dispatch_contract_canonical_operation_invalid", {
        operation_index: index,
      })
    }
    seen.add(row.id)
    operations.push(operationView(row))
  }

  return Object.freeze({
    ok: true,
    operations: Object.freeze(operations),
  })
}

function validBindingHash(binding) {
  if (
    typeof binding?.binding_sha256 !== "string" ||
    !SHA256_RE.test(binding.binding_sha256)
  ) {
    return false
  }
  const core = { ...binding }
  delete core.binding_sha256
  return sha(core) === binding.binding_sha256
}

function projectedFrontier({
  binding,
  operations,
  contract,
  attestation,
  executionContextSha256,
}) {
  if (
    binding?.protocol !== "source-slot-compiler-v1" ||
    binding.semantic_contract_sha256 !== contract.contract_sha256 ||
    binding.semantic_attestation_sha256 !== attestation.attestation_sha256 ||
    binding.execution_context_sha256 !== executionContextSha256 ||
    !validBindingHash(binding) ||
    !Array.isArray(binding.required_source_keys) ||
    binding.required_source_keys.length < 1 ||
    binding.required_source_keys.length > MAX_OPERATIONS ||
    !Array.isArray(binding.all_source_rows) ||
    binding.all_source_rows.length !== operations.length
  ) {
    return fail("dispatch_contract_source_binding_invalid")
  }

  const requiredKeys = [...binding.required_source_keys]
  if (
    new Set(requiredKeys).size !== requiredKeys.length ||
    requiredKeys.some(
      (key) => typeof key !== "string" || !SOURCE_KEY_RE.test(key),
    )
  ) {
    return fail("dispatch_contract_source_key_set_invalid")
  }

  const byKey = new Map()

  for (let index = 0; index < binding.all_source_rows.length; index += 1) {
    const row = binding.all_source_rows[index]
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.source_key !== "string" ||
      !SOURCE_KEY_RE.test(row.source_key) ||
      byKey.has(row.source_key) ||
      typeof row.operation_id !== "string" ||
      !Number.isSafeInteger(row.operation_index) ||
      row.operation_index < 0 ||
      row.operation_index >= operations.length
    ) {
      return fail("dispatch_contract_source_row_invalid", {
        source_row_index: index,
      })
    }

    const canonical = operations[row.operation_index]
    if (
      canonical.id !== row.operation_id ||
      canonical.obligation !== row.obligation ||
      (
        typeof canonical.kind === "string"
          ? canonical.kind !== row.kind
          : row.kind != null
      )
    ) {
      return fail("dispatch_contract_source_row_semantic_drift", {
        source_row_index: index,
      })
    }

    byKey.set(row.source_key, row)
  }

  for (const key of requiredKeys) {
    if (!byKey.has(key)) {
      return fail("dispatch_contract_source_key_unknown", {
        source_key: key,
      })
    }
  }

  const activeIds = new Set(
    requiredKeys.map((key) => byKey.get(key).operation_id),
  )
  if (activeIds.size !== requiredKeys.length) {
    return fail("dispatch_contract_operation_frontier_non_bijective")
  }

  const required = operations.filter((row) => activeIds.has(row.id))
  const preserved = operations.filter((row) => !activeIds.has(row.id))

  if (
    required.length !== requiredKeys.length ||
    required.length + preserved.length !== operations.length
  ) {
    return fail("dispatch_contract_operation_frontier_invalid")
  }

  return Object.freeze({
    ok: true,
    required: Object.freeze(required),
    preserved: Object.freeze(preserved),
    required_source_keys: Object.freeze(requiredKeys),
    binding_sha256: binding.binding_sha256,
    projection:
      preserved.length > 0 ? "causal_subset" : "canonical_full",
  })
}

export function deriveCausalDispatchContract({
  semanticContract,
  semanticAttestation,
  sourceSlotBinding = null,
  executionState,
  selectedAction,
  selectedSource,
  executionContextCapsuleSha256,
  executionContractSha256,
} = {}) {
  const canonical =
    validateCanonical(semanticContract, semanticAttestation)
  if (canonical.ok !== true) return canonical

  if (
    typeof executionState !== "string" ||
    executionState.length < 1 ||
    typeof selectedAction !== "string" ||
    selectedAction.length < 1 ||
    typeof selectedSource !== "string" ||
    selectedSource.length < 1 ||
    typeof executionContextCapsuleSha256 !== "string" ||
    !SHA256_RE.test(executionContextCapsuleSha256) ||
    typeof executionContractSha256 !== "string" ||
    !SHA256_RE.test(executionContractSha256)
  ) {
    return fail("dispatch_contract_execution_identity_invalid")
  }

  const frontier =
    sourceSlotBinding == null
      ? Object.freeze({
          ok: true,
          required: canonical.operations,
          preserved: Object.freeze([]),
          required_source_keys: Object.freeze([]),
          binding_sha256: null,
          projection: "canonical_full",
        })
      : projectedFrontier({
          binding: sourceSlotBinding,
          operations: canonical.operations,
          contract: semanticContract,
          attestation: semanticAttestation,
          executionContextSha256:
            executionContextCapsuleSha256,
        })

  if (frontier.ok !== true) return frontier

  const requiredOperations =
    frontier.required.map(operationView)
  const activeOperationIds =
    requiredOperations.map((row) => row.id)
  const preservedOperationIds =
    frontier.preserved.map((row) => row.id)

  const core = {
    protocol: CAUSAL_DISPATCH_CONTRACT_PROTOCOL,
    semantic_contract_sha256:
      semanticContract.contract_sha256,
    semantic_attestation_sha256:
      semanticAttestation.attestation_sha256,
    capability_fingerprint_sha256:
      semanticAttestation.capability_fingerprint_sha256,
    execution_context_capsule_sha256:
      executionContextCapsuleSha256,
    execution_contract_sha256:
      executionContractSha256,
    source_binding_sha256:
      frontier.binding_sha256,
    execution_state: executionState,
    selected_action: selectedAction,
    selected_source: selectedSource,
    source_projection: frontier.projection,
    required_source_keys:
      [...frontier.required_source_keys],
    active_operation_ids: activeOperationIds,
    preserved_operation_ids: preservedOperationIds,
    canonical_operation_count:
      canonical.operations.length,
    active_operation_count:
      activeOperationIds.length,
    required_operations: requiredOperations,
    mutation_authority: false,
  }

  return Object.freeze({
    ok: true,
    reason:
      frontier.projection === "causal_subset"
        ? "dispatch_contract_causal_frontier_projected"
        : "dispatch_contract_canonical_frontier",
    ...core,
    dispatch_contract_sha256: sha(core),
  })
}
