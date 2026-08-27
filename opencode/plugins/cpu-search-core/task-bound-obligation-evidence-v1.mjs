import {
  EVIDENCE_TIER_PROTOCOL,
  makeTieredRoleEvidence,
  tierCanCoverObligation,
} from "./evidence-tier-v1.mjs"


export const TASK_BOUND_OBLIGATION_EVIDENCE_PROTOCOL =
  "task-bound-obligation-evidence-v1"

export const TASK_BOUND_OBLIGATION_EVIDENCE_AUTHORITY =
  "localization_evidence_only"

export const TASK_ROLE_EVIDENCE_MAX_ITEMS =
  64


function validSha256(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/iu.test(
      value,
    )
  )
}


function requiredRoles(
  coverageRequirements,
) {
  return [
    ...new Set(
      Array.isArray(
        coverageRequirements
          ?.required_roles,
      )
        ? coverageRequirements
            .required_roles
            .filter(
              (role) =>
                typeof role ===
                  "string" &&
                role.length > 0,
            )
        : [],
    ),
  ].sort()
}


function witnessIdentity(
  witness,
) {
  return [
    witness?.file ?? "",
    witness?.sha256 ?? "",
    String(
      witness?.line ?? 0,
    ),
    witness?.extractor ?? "",
  ].join("\0")
}


function edgeIdentity(
  edge,
) {
  return [
    edge?.from ?? "",
    edge?.to ?? "",
    edge?.kind ?? "",
    witnessIdentity(
      edge?.witness,
    ),
  ].join("\0")
}


function evidenceIdentity(
  item,
) {
  return [
    item?.task_sha256 ?? "",
    item?.role ?? "",
    item?.tier ?? "",
    item?.basis ?? "",
    item?.ambiguous === true
      ? "ambiguous"
      : "clear",
    witnessIdentity(
      item?.source_proof,
    ),
    ...(item?.causal_path ?? [])
      .map(edgeIdentity),
  ].join("\0")
}


export function projectTaskBoundObligationProofs({
  coverageRequirements,
  taskSha256,
  proofs = [],
} = {}) {
  const required =
    requiredRoles(
      coverageRequirements,
    )

  const normalizedTaskSha =
    typeof taskSha256 === "string"
      ? taskSha256.toLowerCase()
      : null

  const requirementsSha =
    typeof coverageRequirements
      ?.task_sha256 === "string"
      ? coverageRequirements
          .task_sha256
          .toLowerCase()
      : null

  if (
    coverageRequirements?.status !==
      "compiled" ||
    !validSha256(
      normalizedTaskSha,
    ) ||
    requirementsSha !==
      normalizedTaskSha
  ) {
    return Object.freeze({
      protocol:
        TASK_BOUND_OBLIGATION_EVIDENCE_PROTOCOL,

      authority:
        TASK_BOUND_OBLIGATION_EVIDENCE_AUTHORITY,

      status:
        "unresolved",

      reason:
        "coverage_identity_unresolved",

      required_roles:
        Object.freeze(
          [...required],
        ),

      evidence:
        Object.freeze([]),

      rejected:
        Object.freeze([]),

      localization_authority:
        false,

      mutation_authority:
        false,
    })
  }

  const requiredSet =
    new Set(required)

  const evidence = []
  const rejected = []

  for (const proof of proofs ?? []) {
    const obligation =
      proof?.obligation

    if (
      typeof obligation !==
        "string" ||
      !requiredSet.has(
        obligation,
      )
    ) {
      rejected.push({
        obligation:
          obligation ?? null,

        reason:
          "obligation_not_required",
      })

      continue
    }

    const item =
      makeTieredRoleEvidence({
        role:
          obligation,

        taskSha256:
          normalizedTaskSha,

        basis:
          proof?.basis,

        sourceProof:
          proof?.source_proof ??
          null,

        causalPath:
          proof?.causal_path ??
          [],

        ambiguous:
          proof?.ambiguous ===
          true,

        detail:
          proof?.detail ??
          null,
      })

    if (!item) {
      rejected.push({
        obligation,

        reason:
          "invalid_evidence_descriptor",
      })

      continue
    }

    /*
     * Only A/B may enter the task-role channel.
     *
     * Ambiguous A/B evidence is intentionally retained:
     * solveObligationCoverage() must see it so ambiguity
     * dominates positive evidence fail-closed.
     */
    if (
      !tierCanCoverObligation(
        item.tier,
      )
    ) {
      rejected.push({
        obligation,

        tier:
          item.tier,

        reason:
          "tier_has_no_coverage_authority",
      })

      continue
    }

    evidence.push(item)
  }

  evidence.sort(
    (a, b) =>
      evidenceIdentity(a)
        .localeCompare(
          evidenceIdentity(b),
        ),
  )

  return Object.freeze({
    protocol:
      TASK_BOUND_OBLIGATION_EVIDENCE_PROTOCOL,

    authority:
      TASK_BOUND_OBLIGATION_EVIDENCE_AUTHORITY,

    status:
      evidence.length > 0
        ? "projected"
        : "no_authoritative_evidence",

    reason:
      evidence.length > 0
        ? "task_bound_ab_evidence_projected"
        : "task_bound_ab_evidence_unavailable",

    required_roles:
      Object.freeze(
        [...required],
      ),

    evidence:
      Object.freeze(
        [...evidence],
      ),

    rejected:
      Object.freeze(
        [...rejected],
      ),

    localization_authority:
      evidence.some(
        (item) =>
          item
            ?.localization_authority ===
          true,
      ),

    /*
     * Separate authority plane.
     * Never inferred by this module.
     */
    mutation_authority:
      false,
  })
}


export function mergeTaskRoleEvidence({
  existing = [],
  incoming = [],
  taskSha256,
  maxItems =
    TASK_ROLE_EVIDENCE_MAX_ITEMS,
} = {}) {
  const normalizedTaskSha =
    typeof taskSha256 === "string"
      ? taskSha256.toLowerCase()
      : null

  if (
    !validSha256(
      normalizedTaskSha,
    ) ||
    !Number.isSafeInteger(
      maxItems,
    ) ||
    maxItems < 1
  ) {
    return Object.freeze({
      protocol:
        TASK_BOUND_OBLIGATION_EVIDENCE_PROTOCOL,

      status:
        "unresolved",

      reason:
        "merge_identity_unresolved",

      evidence:
        Object.freeze([]),

      truncated:
        false,
    })
  }

  const merged =
    new Map()

  for (const item of [
    ...(existing ?? []),
    ...(incoming ?? []),
  ]) {
    /*
     * Only canonical Evidence Tier objects from this task
     * survive into the authoritative channel.
     */
    if (
      item?.protocol !==
        EVIDENCE_TIER_PROTOCOL ||
      item?.task_sha256 !==
        normalizedTaskSha ||
      typeof item?.role !==
        "string" ||
      item.role.length < 1
    ) {
      continue
    }

    merged.set(
      evidenceIdentity(item),
      item,
    )
  }

  const ordered =
    [...merged.entries()]
      .sort(
        ([a], [b]) =>
          a.localeCompare(b),
      )
      .map(
        ([, item]) =>
          item,
      )

  /*
   * Dropping an ambiguous proof because of a budget could
   * accidentally turn ambiguity into positive coverage.
   *
   * Therefore budget overflow invalidates the entire merged
   * role-evidence view for this iteration.
   */
  if (
    ordered.length >
    maxItems
  ) {
    return Object.freeze({
      protocol:
        TASK_BOUND_OBLIGATION_EVIDENCE_PROTOCOL,

      status:
        "truncated",

      reason:
        "task_role_evidence_budget_exceeded",

      evidence:
        Object.freeze([]),

      truncated:
        true,
    })
  }

  return Object.freeze({
    protocol:
      TASK_BOUND_OBLIGATION_EVIDENCE_PROTOCOL,

    status:
      "merged",

    reason:
      "task_role_evidence_merged",

    evidence:
      Object.freeze(
        [...ordered],
      ),

    truncated:
      false,
  })
}
