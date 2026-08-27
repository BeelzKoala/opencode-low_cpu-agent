export const ADDITIVE_LOCALIZATION_PLAN_PROTOCOL =
  "additive-localization-plan-v1"

export const ADDITIVE_LOCALIZATION_PLAN_AUTHORITY =
  "planning_only"

export const ADDITIVE_TASK_KIND =
  "additive"

export const LOCALIZATION_OBLIGATION =
  Object.freeze({
    SERVER_HOST:
      "server_host",

    UI_HOST:
      "ui_host",

    NAVIGATION_HOST:
      "navigation_host",

    DATA_ACCESS_CAPABILITY:
      "data_access_capability",

    PROTECTED_SURFACE:
      "protected_surface",
  })

/*
 * Critical semantic boundary:
 *
 * TaskRequirements roles describe what the resulting change must do.
 *
 * Additive localization obligations describe what PRE-EXISTING
 * repository capability/surface must be found before mutation.
 *
 * Therefore:
 *
 *   server_endpoint != server_host
 *   ui_surface      != ui_host
 *   navigation      != navigation_host
 *   data_access     != data_access_capability
 *
 * A new endpoint/page must not be required to exist before we create it.
 */

const POSITIVE_ROLE_TO_OBLIGATION =
  Object.freeze({
    server_endpoint:
      LOCALIZATION_OBLIGATION.SERVER_HOST,

    ui_surface:
      LOCALIZATION_OBLIGATION.UI_HOST,

    navigation:
      LOCALIZATION_OBLIGATION.NAVIGATION_HOST,

    data_access:
      LOCALIZATION_OBLIGATION.DATA_ACCESS_CAPABILITY,
  })

const PROTECTED_ROLE_TO_OBLIGATION =
  Object.freeze({
    preserve_behavior:
      LOCALIZATION_OBLIGATION.PROTECTED_SURFACE,
  })

const IMPLEMENTATION_VERIFICATION_ROLES =
  new Set([
    "data_schema",
    "output_artifact",
    "input_validation",
    "test_surface",
    "configuration",
  ])

const POLICY_ROLES =
  new Set([
    "dependency_policy",
  ])

const KNOWN_ROLES =
  new Set([
    ...Object.keys(
      POSITIVE_ROLE_TO_OBLIGATION,
    ),

    ...Object.keys(
      PROTECTED_ROLE_TO_OBLIGATION,
    ),

    ...IMPLEMENTATION_VERIFICATION_ROLES,
    ...POLICY_ROLES,
  ])

const OBLIGATION_SOURCE_FAMILIES =
  Object.freeze({
    [LOCALIZATION_OBLIGATION.SERVER_HOST]:
      Object.freeze([
        "server_code",
      ]),

    [LOCALIZATION_OBLIGATION.UI_HOST]:
      Object.freeze([
        "client_code",
        "ui_resource",
      ]),

    [LOCALIZATION_OBLIGATION.NAVIGATION_HOST]:
      Object.freeze([
        "client_code",
        "server_code",
        "ui_resource",
      ]),

    [LOCALIZATION_OBLIGATION.DATA_ACCESS_CAPABILITY]:
      Object.freeze([
        "data_query",
        "server_code",
      ]),

    [LOCALIZATION_OBLIGATION.PROTECTED_SURFACE]:
      Object.freeze([
        "client_code",
        "server_code",
        "ui_resource",
      ]),
  })

function uniqueSorted(values) {
  return [
    ...new Set(
      Array.isArray(values)
        ? values.filter(
            (value) =>
              typeof value === "string" &&
              value.length > 0,
          )
        : [],
    ),
  ].sort()
}

function bindingsFor(
  requiredRoles,
  mapping,
) {
  return requiredRoles
    .filter(
      (role) =>
        Object.prototype.hasOwnProperty.call(
          mapping,
          role,
        ),
    )
    .map(
      (sourceRole) => ({
        source_role:
          sourceRole,

        obligation:
          mapping[sourceRole],
      }),
    )
    .sort(
      (a, b) =>
        a.obligation.localeCompare(
          b.obligation,
        ) ||
        a.source_role.localeCompare(
          b.source_role,
        ),
    )
}

function obligationsFromBindings(
  bindings,
) {
  return uniqueSorted(
    bindings.map(
      (item) =>
        item.obligation,
    ),
  )
}

function sourceFamiliesForObligations(
  obligations,
) {
  const result = new Set()

  for (const obligation of obligations) {
    for (
      const family of
      OBLIGATION_SOURCE_FAMILIES[
        obligation
      ] ?? []
    ) {
      result.add(family)
    }
  }

  return [...result].sort()
}

function unresolvedPlan({
  taskSha256 = null,
  requiredRoles = [],
  unknownRoles = [],
  reason,
} = {}) {
  return Object.freeze({
    protocol:
      ADDITIVE_LOCALIZATION_PLAN_PROTOCOL,

    authority:
      ADDITIVE_LOCALIZATION_PLAN_AUTHORITY,

    status:
      "unresolved",

    reason,

    task_kind:
      null,

    task_sha256:
      taskSha256,

    required_roles:
      Object.freeze(
        uniqueSorted(
          requiredRoles,
        ),
      ),

    positive_localization_obligations:
      Object.freeze([]),

    positive_localization_bindings:
      Object.freeze([]),

    positive_localization_source_families:
      Object.freeze([]),

    protected_surface_obligations:
      Object.freeze([]),

    protected_surface_bindings:
      Object.freeze([]),

    protected_surface_source_families:
      Object.freeze([]),

    implementation_verification_roles:
      Object.freeze([]),

    policy_roles:
      Object.freeze([]),

    unknown_roles:
      Object.freeze(
        uniqueSorted(
          unknownRoles,
        ),
      ),

    positive_coverage_requirements:
      null,

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}

export function planAdditiveLocalization({
  taskRequirements,
  taskKind,
} = {}) {
  const requiredRoles =
    uniqueSorted(
      taskRequirements?.required_roles,
    )

  const taskSha256 =
    typeof taskRequirements?.task_sha256 ===
      "string"
      ? taskRequirements.task_sha256
          .toLowerCase()
      : null

  if (
    taskRequirements?.status !==
      "compiled" ||
    !/^[0-9a-f]{64}$/.test(
      taskSha256 ?? "",
    )
  ) {
    return unresolvedPlan({
      taskSha256,
      requiredRoles,
      reason:
        "task_requirements_unresolved",
    })
  }

  /*
   * Never infer additivity from required roles.
   * Runtime wiring is forbidden until a deterministic task-shape
   * classifier exists.
   */
  if (
    taskKind !==
    ADDITIVE_TASK_KIND
  ) {
    return unresolvedPlan({
      taskSha256,
      requiredRoles,
      reason:
        "task_kind_not_explicit_additive",
    })
  }

  const unknownRoles =
    requiredRoles.filter(
      (role) =>
        !KNOWN_ROLES.has(
          role,
        ),
    )

  if (
    unknownRoles.length > 0
  ) {
    return unresolvedPlan({
      taskSha256,
      requiredRoles,
      unknownRoles,
      reason:
        "unknown_required_role",
    })
  }

  const positiveBindings =
    bindingsFor(
      requiredRoles,
      POSITIVE_ROLE_TO_OBLIGATION,
    )

  const protectedBindings =
    bindingsFor(
      requiredRoles,
      PROTECTED_ROLE_TO_OBLIGATION,
    )

  const positiveObligations =
    obligationsFromBindings(
      positiveBindings,
    )

  const protectedObligations =
    obligationsFromBindings(
      protectedBindings,
    )

  const implementationRoles =
    requiredRoles.filter(
      (role) =>
        IMPLEMENTATION_VERIFICATION_ROLES
          .has(role),
    )

  const policyRoles =
    requiredRoles.filter(
      (role) =>
        POLICY_ROLES.has(
          role,
        ),
    )

  /*
   * Existing obligation solver can consume this projection because
   * its role vocabulary is intentionally string-based.
   *
   * This still grants NO authority by itself.
   * A/B task-bound evidence remains required separately.
   */
  const positiveCoverageRequirements =
    Object.freeze({
      status:
        "compiled",

      task_sha256:
        taskSha256,

      required_roles:
        Object.freeze(
          [...positiveObligations],
        ),
    })

  return Object.freeze({
    protocol:
      ADDITIVE_LOCALIZATION_PLAN_PROTOCOL,

    authority:
      ADDITIVE_LOCALIZATION_PLAN_AUTHORITY,

    status:
      "planned",

    reason:
      "explicit_additive_task",

    task_kind:
      ADDITIVE_TASK_KIND,

    task_sha256:
      taskSha256,

    required_roles:
      Object.freeze(
        [...requiredRoles],
      ),

    positive_localization_obligations:
      Object.freeze(
        [...positiveObligations],
      ),

    positive_localization_bindings:
      Object.freeze(
        positiveBindings.map(
          (item) =>
            Object.freeze({
              ...item,
            }),
        ),
      ),

    positive_localization_source_families:
      Object.freeze(
        sourceFamiliesForObligations(
          positiveObligations,
        ),
      ),

    protected_surface_obligations:
      Object.freeze(
        [...protectedObligations],
      ),

    protected_surface_bindings:
      Object.freeze(
        protectedBindings.map(
          (item) =>
            Object.freeze({
              ...item,
            }),
        ),
      ),

    protected_surface_source_families:
      Object.freeze(
        sourceFamiliesForObligations(
          protectedObligations,
        ),
      ),

    implementation_verification_roles:
      Object.freeze(
        [...implementationRoles],
      ),

    policy_roles:
      Object.freeze(
        [...policyRoles],
      ),

    unknown_roles:
      Object.freeze([]),

    positive_coverage_requirements:
      positiveCoverageRequirements,

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}
