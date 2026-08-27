export const EVIDENCE_TIER_PROTOCOL =
  "evidence-tier-v1"

export const EVIDENCE_TIER =
  Object.freeze({
    A: "A",
    B: "B",
    C: "C",
    D: "D",
    H: "H",
  })

export const EVIDENCE_BASIS =
  Object.freeze({
    DIRECT_TASK_ANCHOR:
      "direct_task_anchor",

    TASK_CAUSAL_PATH:
      "task_causal_path",

    LEXICAL:
      "lexical",

    GENERIC_IMPACT:
      "generic_impact",

    HYPOTHESIS:
      "hypothesis",
  })

function validSha256(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/iu.test(value)
  )
}

function validSourceProof(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    validSha256(value.sha256) &&
    Number.isSafeInteger(value.line) &&
    value.line >= 1 &&
    typeof value.extractor === "string" &&
    value.extractor.length > 0
  )
}

function validPathEdge(edge) {
  return (
    edge &&
    typeof edge === "object" &&
    edge.validated === true &&
    typeof edge.from === "string" &&
    edge.from.length > 0 &&
    typeof edge.to === "string" &&
    edge.to.length > 0 &&
    typeof edge.kind === "string" &&
    edge.kind.length > 0 &&
    validSourceProof(edge.witness)
  )
}

function validTaskCausalPath(path) {
  return (
    Array.isArray(path) &&
    path.length >= 1 &&
    path.length <= 3 &&
    path.every(validPathEdge)
  )
}

export function classifyEvidenceTier({
  basis,
  sourceProof = null,
  causalPath = [],
} = {}) {
  if (
    basis ===
      EVIDENCE_BASIS.DIRECT_TASK_ANCHOR &&
    validSourceProof(sourceProof)
  ) {
    return EVIDENCE_TIER.A
  }

  if (
    basis ===
      EVIDENCE_BASIS.TASK_CAUSAL_PATH &&
    validSourceProof(sourceProof) &&
    validTaskCausalPath(causalPath)
  ) {
    return EVIDENCE_TIER.B
  }

  if (
    basis ===
    EVIDENCE_BASIS.LEXICAL
  ) {
    return EVIDENCE_TIER.C
  }

  if (
    basis ===
      EVIDENCE_BASIS.GENERIC_IMPACT &&
    validSourceProof(sourceProof)
  ) {
    return EVIDENCE_TIER.D
  }

  return EVIDENCE_TIER.H
}

export function tierCanCoverObligation(
  tier,
) {
  return (
    tier === EVIDENCE_TIER.A ||
    tier === EVIDENCE_TIER.B
  )
}

export function makeTieredRoleEvidence({
  role,
  taskSha256,
  basis,
  sourceProof = null,
  causalPath = [],
  ambiguous = false,
  detail = null,
} = {}) {
  if (
    typeof role !== "string" ||
    role.length < 1 ||
    !validSha256(taskSha256)
  ) {
    return null
  }

  const tier =
    classifyEvidenceTier({
      basis,
      sourceProof,
      causalPath,
    })

  const localizationAuthority =
    tierCanCoverObligation(tier) &&
    ambiguous !== true

  return Object.freeze({
    protocol:
      EVIDENCE_TIER_PROTOCOL,

    role,

    task_sha256:
      taskSha256.toLowerCase(),

    tier,
    basis,

    validated:
      localizationAuthority,

    ambiguous:
      ambiguous === true,

    localization_authority:
      localizationAuthority,

    // Separate contract. Never inferred here.
    mutation_authority:
      false,

    source_proof:
      sourceProof,

    causal_path:
      [...causalPath],

    detail,
  })
}
