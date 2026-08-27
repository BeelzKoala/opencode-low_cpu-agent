import {
  tierCanCoverObligation,
} from "./evidence-tier-v1.mjs"

export const OBLIGATION_COVERAGE_PROTOCOL =
  "obligation-coverage-v1"

function uniqueSorted(values) {
  return [
    ...new Set(values),
  ].sort()
}

export function solveObligationCoverage({
  taskRequirements,
  evidence = [],
} = {}) {
  const required =
    Array.isArray(
      taskRequirements?.required_roles,
    )
      ? uniqueSorted(
          taskRequirements.required_roles
            .filter(
              (role) =>
                typeof role === "string" &&
                role.length > 0,
            ),
        )
      : []

  const taskSha256 =
    typeof taskRequirements?.task_sha256 ===
      "string"
      ? taskRequirements.task_sha256
          .toLowerCase()
      : null

  if (
    taskRequirements?.status !==
      "compiled" ||
    !taskSha256
  ) {
    return Object.freeze({
      protocol:
        OBLIGATION_COVERAGE_PROTOCOL,

      status:
        "unresolved",

      required_roles:
        required,

      covered_roles: [],
      missing_roles:
        required,

      ambiguous_roles: [],

      accepted_evidence: [],
      rejected_evidence: [],

      reason:
        "task_requirements_unresolved",
    })
  }

  const requiredSet =
    new Set(required)

  const accepted = []
  const rejected = []

  const covered = new Set()
  const ambiguous = new Set()

  for (const item of evidence) {
    const role =
      item?.role

    let reason = null

    if (
      typeof role !== "string" ||
      !requiredSet.has(role)
    ) {
      reason =
        "role_not_required"
    } else if (
      item?.task_sha256 !==
      taskSha256
    ) {
      reason =
        "task_identity_mismatch"
    } else if (
      !tierCanCoverObligation(
        item?.tier,
      )
    ) {
      reason =
        "tier_has_no_coverage_authority"
    } else if (
      item?.ambiguous === true
    ) {
      ambiguous.add(role)
      reason =
        "authoritative_evidence_ambiguous"
    } else if (
      item?.validated !== true ||
      item?.localization_authority !== true
    ) {
      reason =
        "evidence_not_authoritative"
    }

    if (reason !== null) {
      rejected.push({
        role:
          role ?? null,

        tier:
          item?.tier ?? null,

        reason,
      })
      continue
    }

    accepted.push(item)
    covered.add(role)
  }

  /*
   * Fail closed:
   * authoritative ambiguity dominates a positive observation
   * for the same required role.
   */
  for (const role of ambiguous) {
    covered.delete(role)
  }

  const coveredRoles =
    [...covered].sort()

  const ambiguousRoles =
    [...ambiguous].sort()

  const missingRoles =
    required.filter(
      (role) =>
        !covered.has(role) &&
        !ambiguous.has(role),
    )

  let status
  let reason

  if (ambiguousRoles.length > 0) {
    status = "ambiguous"
    reason =
      "required_role_evidence_ambiguous"
  } else if (missingRoles.length > 0) {
    status = "insufficient"
    reason =
      "required_role_evidence_missing"
  } else {
    status = "covered"
    reason =
      "required_role_evidence_covered"
  }

  return Object.freeze({
    protocol:
      OBLIGATION_COVERAGE_PROTOCOL,

    status,
    reason,

    required_roles:
      required,

    covered_roles:
      coveredRoles,

    missing_roles:
      missingRoles,

    ambiguous_roles:
      ambiguousRoles,

    accepted_evidence:
      accepted,

    rejected_evidence:
      rejected,
  })
}
