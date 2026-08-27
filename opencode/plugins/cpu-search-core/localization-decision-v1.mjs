export const LOCALIZATION_DECISION_PROTOCOL =
  "localization-decision-v1"

export const LOCALIZATION_STATUS = Object.freeze({
  INSUFFICIENT: "INSUFFICIENT",
  AMBIGUOUS: "AMBIGUOUS",
  READY_UNSUPPORTED: "READY_UNSUPPORTED",
  AUTHORIZED: "AUTHORIZED",
})

function stringSet(values) {
  return new Set(
    Array.isArray(values)
      ? values.filter(
          (value) => typeof value === "string" && value.length > 0,
        )
      : [],
  )
}

export function decideLocalization({
  taskRequirements = null,
  coveredRoles = [],
  ambiguousRoles = [],
  mutationSupported = false,
  candidateAuthority = false,
  blockers = [],
} = {}) {
  const required = stringSet(
    taskRequirements?.required_roles,
  )
  const covered = stringSet(coveredRoles)
  const ambiguous = stringSet(ambiguousRoles)
  const blockerList = Array.isArray(blockers)
    ? blockers.filter(
        (value) => typeof value === "string" && value.length > 0,
      )
    : []

  const missingRoles =
    [...required]
      .filter((role) => !covered.has(role))
      .sort()

  const relevantAmbiguity =
    [...ambiguous]
      .filter(
        (role) => required.size === 0 || required.has(role),
      )
      .sort()

  let status
  let reason

  if (blockerList.length > 0) {
    status = LOCALIZATION_STATUS.INSUFFICIENT
    reason = blockerList[0]
  } else if (missingRoles.length > 0) {
    status = LOCALIZATION_STATUS.INSUFFICIENT
    reason = "required_role_evidence_missing"
  } else if (relevantAmbiguity.length > 0) {
    status = LOCALIZATION_STATUS.AMBIGUOUS
    reason = "required_role_evidence_ambiguous"
  } else if (!candidateAuthority) {
    status = LOCALIZATION_STATUS.INSUFFICIENT
    reason = "mutation_authority_not_proven"
  } else if (!mutationSupported) {
    status = LOCALIZATION_STATUS.READY_UNSUPPORTED
    reason = "mutation_capability_unavailable"
  } else {
    status = LOCALIZATION_STATUS.AUTHORIZED
    reason = "task_localization_authorized"
  }

  return {
    protocol: LOCALIZATION_DECISION_PROTOCOL,
    status,
    reason,
    required_roles: [...required].sort(),
    covered_roles: [...covered].sort(),
    missing_roles: missingRoles,
    ambiguous_roles: relevantAmbiguity,
    mutation_supported: mutationSupported === true,
    candidate_authority: candidateAuthority === true,
    blockers: blockerList,
  }
}
