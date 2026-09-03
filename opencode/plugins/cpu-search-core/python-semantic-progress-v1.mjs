import { createHash } from "node:crypto"

export const PYTHON_SEMANTIC_PROGRESS_PROTOCOL =
  "python-semantic-progress-v1"

function text(value) {
  return (
    typeof value === "string" &&
    value.length > 0
  )
    ? value
    : null
}

function stableUnitPayload(unit) {
  if (
    !unit ||
    typeof unit !== "object" ||
    Array.isArray(unit)
  ) {
    return null
  }

  const kind = text(unit.kind)
  const name = text(unit.name)

  if (!kind || !name) {
    return null
  }

  return {
    identity: `${kind}:${name}`,
    serialized: JSON.stringify(unit),
  }
}

export function fingerprintPythonSemanticUnit(unit) {
  const payload = stableUnitPayload(unit)

  if (!payload) {
    return Object.freeze({
      ok: false,
      protocol:
        PYTHON_SEMANTIC_PROGRESS_PROTOCOL,
      reason:
        "python_semantic_progress_unit_invalid",
      identity: null,
      fingerprint_sha256: null,
      mutation_authority: false,
    })
  }

  return Object.freeze({
    ok: true,
    protocol:
      PYTHON_SEMANTIC_PROGRESS_PROTOCOL,
    reason:
      "python_semantic_progress_fingerprinted",
    identity:
      payload.identity,
    fingerprint_sha256:
      createHash("sha256")
        .update(payload.serialized)
        .digest("hex"),
    mutation_authority: false,
  })
}

export function createPythonClassMemberProgressLedger() {
  const byIdentity = new Map()
  const fingerprints = new Set()

  const observe = (unit) => {
    const fingerprint =
      fingerprintPythonSemanticUnit(unit)

    if (fingerprint.ok !== true) {
      return fingerprint
    }

    const previous =
      byIdentity.get(
        fingerprint.identity,
      ) ?? null

    if (
      fingerprints.has(
        fingerprint.fingerprint_sha256,
      )
    ) {
      return Object.freeze({
        ...fingerprint,
        ok: false,
        reason:
          "python_nested_repeated_member_cycle",
        previous_fingerprint_sha256:
          previous,
        exact_repeat: true,
        identity_conflict: false,
        mutation_authority: false,
      })
    }

    if (
      previous &&
      previous !==
        fingerprint.fingerprint_sha256
    ) {
      return Object.freeze({
        ...fingerprint,
        ok: false,
        reason:
          "python_nested_class_member_identity_conflict",
        previous_fingerprint_sha256:
          previous,
        exact_repeat: false,
        identity_conflict: true,
        mutation_authority: false,
      })
    }

    byIdentity.set(
      fingerprint.identity,
      fingerprint.fingerprint_sha256,
    )
    fingerprints.add(
      fingerprint.fingerprint_sha256,
    )

    return Object.freeze({
      ...fingerprint,
      ok: true,
      reason:
        "python_semantic_progress_novel",
      exact_repeat: false,
      identity_conflict: false,
      mutation_authority: false,
    })
  }

  return Object.freeze({
    protocol:
      PYTHON_SEMANTIC_PROGRESS_PROTOCOL,
    observe,
    mutation_authority: false,
  })
}
