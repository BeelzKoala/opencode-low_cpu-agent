import {
  RESOURCE_EDGE_KIND,
  normalizeValidatedResourceEdge,
} from "./resource-graph-v1.mjs"


export const HOST_INTEGRATION_SHADOW_PROTOCOL =
  "host-integration-shadow-v1"

export const HOST_OBLIGATION_SPEC_PROTOCOL =
  "host-obligation-spec-v1"

export const RESOURCE_GRAPH_VIEW_PROTOCOL =
  "resource-graph-view-v1"

export const HOST_BINDING_SHADOW_PROTOCOL =
  "host-binding-shadow-v1"

export const HOST_SHADOW_COVERAGE_PROTOCOL =
  "host-shadow-coverage-v1"


const HOST_SHADOW_AUTHORITY =
  "shadow_observation"

const MAX_GRAPH_EDGES =
  192

const MAX_BINDINGS_PER_ROLE =
  16


function validSha256(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/iu.test(value)
  )
}


function uniqueSorted(values) {
  return [
    ...new Set(
      values.filter(
        (value) =>
          typeof value === "string" &&
          value.length > 0,
      ),
    ),
  ].sort()
}


function edgeKey(edge) {
  return [
    edge.from,
    edge.kind,
    edge.to,
    edge.witness?.file ?? "",
    edge.witness?.line ?? "",
  ].join("\0")
}


function normalizeFilePath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1
  ) {
    return null
  }

  return value
    .replace(/\\/gu, "/")
    .replace(/^(?:\.\/)+/u, "")
}


function fileFromNode(node) {
  if (
    typeof node !== "string" ||
    !node.startsWith("file:")
  ) {
    return null
  }

  return normalizeFilePath(
    node.slice(
      "file:".length,
    ),
  )
}


function routeLiteralFromNode(node) {
  if (
    typeof node !== "string" ||
    !node.startsWith("route:")
  ) {
    return null
  }

  const raw =
    node.slice(
      "route:".length,
    )

  if (raw.startsWith("/")) {
    return raw
  }

  /*
   * Support graph nodes such as:
   *
   *   route:GET /reports
   *
   * without introducing generic route guessing.
   */
  const firstSpace =
    raw.indexOf(" ")

  if (
    firstSpace > 0 &&
    raw.slice(
      firstSpace + 1,
    ).startsWith("/")
  ) {
    return raw.slice(
      firstSpace + 1,
    )
  }

  return null
}


function baseShadow({
  protocol,
  status,
  reason,
  taskSha256 = null,
}) {
  return {
    protocol,
    authority:
      HOST_SHADOW_AUTHORITY,

    status,
    reason,

    task_sha256:
      validSha256(taskSha256)
        ? taskSha256.toLowerCase()
        : null,

    localization_authority:
      false,

    mutation_authority:
      false,
  }
}


/*
 * ============================================================
 * E1.3a — HostObligationSpec
 *
 * Translate additive host obligations into a typed,
 * task-bound integration specification.
 *
 * IMPORTANT:
 * TaskAnchor currently has no role/polarity annotation.
 * Therefore a route literal cannot become a protected surface
 * merely because preserve_behavior also exists.
 *
 * One route literal is retained as a conservative candidate.
 * Multiple route literals fail closed as ambiguous.
 * ============================================================
 */

export function compileHostObligationSpec({
  taskRequirements,
  taskAnchors,
  additiveLocalizationPlan,
} = {}) {
  const taskSha256 =
    taskRequirements?.task_sha256

  if (
    taskRequirements?.status !== "compiled" ||
    !validSha256(taskSha256)
  ) {
    return Object.freeze({
      ...baseShadow({
        protocol:
          HOST_OBLIGATION_SPEC_PROTOCOL,
        status:
          "unresolved",
        reason:
          "task_requirements_unavailable",
        taskSha256,
      }),

      positive_specs: [],
      protected_specs: [],

      protected_anchor_status:
        "unresolved",

      protected_route_candidates: [],
    })
  }

  if (
    taskAnchors?.status !== "compiled" ||
    taskAnchors?.task_sha256 !==
      taskSha256.toLowerCase()
  ) {
    return Object.freeze({
      ...baseShadow({
        protocol:
          HOST_OBLIGATION_SPEC_PROTOCOL,
        status:
          "unresolved",
        reason:
          "task_anchor_identity_mismatch",
        taskSha256,
      }),

      positive_specs: [],
      protected_specs: [],

      protected_anchor_status:
        "unresolved",

      protected_route_candidates: [],
    })
  }

  if (
    additiveLocalizationPlan?.status !==
      "planned" ||
    additiveLocalizationPlan?.task_kind !==
      "additive"
  ) {
    return Object.freeze({
      ...baseShadow({
        protocol:
          HOST_OBLIGATION_SPEC_PROTOCOL,
        status:
          "unresolved",
        reason:
          "additive_plan_unavailable",
        taskSha256,
      }),

      positive_specs: [],
      protected_specs: [],

      protected_anchor_status:
        "unresolved",

      protected_route_candidates: [],
    })
  }

  if (
    validSha256(
      additiveLocalizationPlan
        ?.task_sha256,
    ) &&
    additiveLocalizationPlan
      .task_sha256
      .toLowerCase() !==
        taskSha256.toLowerCase()
  ) {
    return Object.freeze({
      ...baseShadow({
        protocol:
          HOST_OBLIGATION_SPEC_PROTOCOL,
        status:
          "unresolved",
        reason:
          "additive_plan_identity_mismatch",
        taskSha256,
      }),

      positive_specs: [],
      protected_specs: [],

      protected_anchor_status:
        "unresolved",

      protected_route_candidates: [],
    })
  }

  const positiveBindings =
    Array.isArray(
      additiveLocalizationPlan
        ?.positive_localization_bindings,
    )
      ? additiveLocalizationPlan
          .positive_localization_bindings
      : []

  const protectedBindings =
    Array.isArray(
      additiveLocalizationPlan
        ?.protected_surface_bindings,
    )
      ? additiveLocalizationPlan
          .protected_surface_bindings
      : []

  const positiveSpecs =
    positiveBindings
      .filter(
        (binding) =>
          typeof binding?.obligation ===
            "string" &&
          typeof binding?.source_role ===
            "string",
      )
      .map(
        (binding) =>
          Object.freeze({
            obligation:
              binding.obligation,

            source_role:
              binding.source_role,

            polarity:
              "positive",

            source_families:
              uniqueSorted(
                additiveLocalizationPlan
                  ?.positive_localization_source_families ??
                  [],
              ),

            semantic_constraints: [],
          }),
      )

  const routeAnchors =
    (
      taskAnchors?.anchors ??
      []
    )
      .filter(
        (anchor) =>
          anchor?.kind ===
            "route_literal" &&
          typeof anchor?.value ===
            "string" &&
          anchor.value.startsWith("/"),
      )
      .map(
        (anchor) => ({
          kind:
            anchor.kind,

          value:
            anchor.value,

          index:
            anchor.index,

          authority:
            anchor.authority,
        }),
      )
      .sort(
        (a, b) =>
          a.index - b.index ||
          a.value.localeCompare(
            b.value,
          ),
      )

  let protectedAnchorStatus =
    "not_required"

  let protectedRouteCandidates = []

  if (
    protectedBindings.length > 0
  ) {
    if (routeAnchors.length === 1) {
      /*
       * Conservative association only.
       *
       * This is NOT enough for localization authority.
       * Future promotion requires role/polarity binding
       * from task text, not "only route wins".
       */
      protectedAnchorStatus =
        "single_route_candidate"

      protectedRouteCandidates =
        routeAnchors
    } else if (
      routeAnchors.length > 1
    ) {
      protectedAnchorStatus =
        "ambiguous_route_anchor_set"

      protectedRouteCandidates =
        routeAnchors.slice(
          0,
          MAX_BINDINGS_PER_ROLE,
        )
    } else {
      protectedAnchorStatus =
        "route_anchor_unavailable"
    }
  }

  const protectedSpecs =
    protectedBindings
      .filter(
        (binding) =>
          typeof binding?.obligation ===
            "string" &&
          typeof binding?.source_role ===
            "string",
      )
      .map(
        (binding) =>
          Object.freeze({
            obligation:
              binding.obligation,

            source_role:
              binding.source_role,

            polarity:
              "protected",

            source_families:
              uniqueSorted(
                additiveLocalizationPlan
                  ?.protected_surface_source_families ??
                  [],
              ),

            anchor_association:
              protectedAnchorStatus,

            route_anchor_candidates:
              protectedRouteCandidates,
          }),
      )

  return Object.freeze({
    ...baseShadow({
      protocol:
        HOST_OBLIGATION_SPEC_PROTOCOL,
      status:
        "compiled",
      reason:
        "additive_host_obligation_spec",
      taskSha256,
    }),

    positive_specs:
      positiveSpecs,

    protected_specs:
      protectedSpecs,

    protected_anchor_status:
      protectedAnchorStatus,

    protected_route_candidates:
      protectedRouteCandidates,
  })
}


/*
 * ============================================================
 * E1.3b — purpose-specific ResourceGraph views
 *
 * One underlying set of validated ResourceEdges.
 * No generic reverse BFS.
 *
 * ProtectionView permits only:
 *   route <- DECLARES_ROUTE - owner
 *
 * HostView permits only explicit relation classes:
 *   owner -> RENDERS_RESOURCE
 *   resource -> INCLUDES_RESOURCE
 *   resource -> TARGETS_ROUTE
 *
 * Reverse INCLUDES_RESOURCE is exposed only as structural
 * topology ("who includes this resource?"), never traversal.
 * ============================================================
 */

export function buildResourceGraphViews({
  frameworkEdges = [],
  resourceEdges = [],
  frameworkTruncated = false,
  resourceTruncated = false,
  maxEdges = MAX_GRAPH_EDGES,
} = {}) {
  const raw = [
    ...(Array.isArray(frameworkEdges)
      ? frameworkEdges
      : []),

    ...(Array.isArray(resourceEdges)
      ? resourceEdges
      : []),
  ]

  const normalized =
    new Map()

  let rejected = 0

  for (const rawEdge of raw) {
    const edge =
      normalizeValidatedResourceEdge(
        rawEdge,
      )

    if (!edge) {
      rejected += 1
      continue
    }

    normalized.set(
      edgeKey(edge),
      edge,
    )
  }

  const allValid =
    [...normalized.values()]
      .sort(
        (a, b) =>
          edgeKey(a).localeCompare(
            edgeKey(b),
          ),
      )

  const bounded =
    allValid.slice(
      0,
      Math.max(
        1,
        Math.min(
          Number.isSafeInteger(maxEdges)
            ? maxEdges
            : MAX_GRAPH_EDGES,
          MAX_GRAPH_EDGES,
        ),
      ),
    )

  const truncated =
    frameworkTruncated === true ||
    resourceTruncated === true ||
    allValid.length > bounded.length

  const byKind =
    (kind) =>
      bounded.filter(
        (edge) =>
          edge.kind === kind,
      )

  return Object.freeze({
    protocol:
      RESOURCE_GRAPH_VIEW_PROTOCOL,

    authority:
      HOST_SHADOW_AUTHORITY,

    status:
      "observed",

    localization_authority:
      false,

    mutation_authority:
      false,

    validated_edge_count:
      bounded.length,

    rejected_edge_count:
      rejected,

    truncated,

    /*
     * Protection view:
     * only exact incoming route declaration ownership.
     */
    protection:
      Object.freeze({
        route_owner_edges:
          byKind(
            RESOURCE_EDGE_KIND
              .DECLARES_ROUTE,
          ),
      }),

    /*
     * Host view:
     * explicit relation-specific projections only.
     */
    host:
      Object.freeze({
        render_edges:
          byKind(
            RESOURCE_EDGE_KIND
              .RENDERS_RESOURCE,
          ),

        include_edges:
          byKind(
            RESOURCE_EDGE_KIND
              .INCLUDES_RESOURCE,
          ),

        target_route_edges:
          byKind(
            RESOURCE_EDGE_KIND
              .TARGETS_ROUTE,
          ),
      }),
  })
}


function routeOwnerCandidates(
  views,
  routeLiteral,
) {
  const owners =
    new Map()

  for (
    const edge of
    views?.protection
      ?.route_owner_edges ??
      []
  ) {
    if (
      routeLiteralFromNode(
        edge.to,
      ) !== routeLiteral
    ) {
      continue
    }

    let entry =
      owners.get(
        edge.from,
      )

    if (!entry) {
      entry = {
        owner:
          edge.from,

        proofs: [],
      }

      owners.set(
        edge.from,
        entry,
      )
    }

    entry.proofs.push(edge)
  }

  return [
    ...owners.values(),
  ].sort(
    (a, b) =>
      a.owner.localeCompare(
        b.owner,
      ),
  )
}


function renderedCandidates(
  views,
  owner,
) {
  const candidates =
    new Map()

  for (
    const edge of
    views?.host?.render_edges ??
    []
  ) {
    if (edge.from !== owner) {
      continue
    }

    let entry =
      candidates.get(
        edge.to,
      )

    if (!entry) {
      entry = {
        resource:
          edge.to,

        proofs: [],
      }

      candidates.set(
        edge.to,
        entry,
      )
    }

    entry.proofs.push(edge)
  }

  return [
    ...candidates.values(),
  ].sort(
    (a, b) =>
      a.resource.localeCompare(
        b.resource,
      ),
  )
}


function includedResourceCandidates(
  views,
  uiResources,
) {
  const uiSet =
    new Set(
      uiResources,
    )

  const candidates =
    new Map()

  for (
    const edge of
    views?.host?.include_edges ??
    []
  ) {
    if (!uiSet.has(edge.from)) {
      continue
    }

    let entry =
      candidates.get(
        edge.to,
      )

    if (!entry) {
      entry = {
        resource:
          edge.to,

        direct_proofs: [],
      }

      candidates.set(
        edge.to,
        entry,
      )
    }

    entry.direct_proofs.push(
      edge,
    )
  }

  const allIncludes =
    views?.host
      ?.include_edges ??
    []

  const allTargets =
    views?.host
      ?.target_route_edges ??
    []

  return [
    ...candidates.values(),
  ]
    .map(
      (candidate) => {
        const includers =
          uniqueSorted(
            allIncludes
              .filter(
                (edge) =>
                  edge.to ===
                    candidate.resource,
              )
              .map(
                (edge) =>
                  edge.from,
              ),
          )

        const routeTargets =
          uniqueSorted(
            allTargets
              .filter(
                (edge) =>
                  edge.from ===
                    candidate.resource,
              )
              .map(
                (edge) =>
                  edge.to,
              ),
          )

        const sharedTopology =
          includers.length >= 2 &&
          routeTargets.length >= 2

        return {
          ...candidate,

          includers,
          includer_count:
            includers.length,

          route_targets:
            routeTargets,

          route_target_count:
            routeTargets.length,

          shared_navigation_topology:
            sharedTopology,
        }
      },
    )
    .sort(
      (a, b) =>
        Number(
          b.shared_navigation_topology,
        ) -
          Number(
            a.shared_navigation_topology,
          ) ||
        b.includer_count -
          a.includer_count ||
        b.route_target_count -
          a.route_target_count ||
        a.resource.localeCompare(
          b.resource,
        ),
    )
}


function impactCandidatesForOwner(
  impactValidated,
  owner,
) {
  const ownerFile =
    fileFromNode(owner)

  if (!ownerFile) {
    return []
  }

  const candidates =
    new Map()

  for (
    const entry of
    Array.isArray(impactValidated)
      ? impactValidated
      : []
  ) {
    if (
      entry?.validated !== true ||
      entry?.validationKind !==
        "forward_scope_definition"
    ) {
      continue
    }

    const targetFile =
      normalizeFilePath(
        entry?.file,
      )

    if (!targetFile) {
      continue
    }

    for (
      const relation of
      Array.isArray(
        entry?.relations,
      )
        ? entry.relations
        : []
    ) {
      if (
        relation?.direction !==
          "forward" ||
        normalizeFilePath(
          relation?.seed,
        ) !== ownerFile
      ) {
        continue
      }

      const bindings =
        uniqueSorted([
          ...(
            Array.isArray(
              entry?.displayBindings,
            )
              ? entry.displayBindings
              : []
          ),

          ...(
            Array.isArray(
              entry?.forwardSymbols,
            )
              ? entry.forwardSymbols
              : []
          ),

          ...(
            Array.isArray(
              relation?.bindings,
            )
              ? relation.bindings
              : []
          ),
        ])

      const key =
        `${targetFile}\0` +
        bindings.join("\0")

      if (!candidates.has(key)) {
        candidates.set(
          key,
          {
            target_file:
              targetFile,

            seed_file:
              ownerFile,

            bindings,

            validation_kind:
              entry.validationKind,

            relation_kind:
              relation?.kind ??
              null,

            relation_spec:
              relation?.spec ??
              null,

            witness_file:
              normalizeFilePath(
                relation
                  ?.witness_file,
              ),

            witness_line:
              Number.isSafeInteger(
                relation
                  ?.witness_line,
              )
                ? relation.witness_line
                : null,

            /*
             * Deliberately unresolved.
             *
             * "A validated dependency exists" is NOT equal to
             * "this is the provider requested by the task".
             */
            source_identity_status:
              "unresolved",
          },
        )
      }
    }
  }

  return [
    ...candidates.values(),
  ]
    .sort(
      (a, b) =>
        a.target_file.localeCompare(
          b.target_file,
        ) ||
        a.bindings
          .join("\0")
          .localeCompare(
            b.bindings.join("\0"),
          ),
    )
    .slice(
      0,
      MAX_BINDINGS_PER_ROLE,
    )
}


/*
 * ============================================================
 * E1.3c — HostBindingShadow
 *
 * Compose the proof primitives.
 *
 * Nothing here creates Tier A/B role evidence.
 * Nothing writes role-evidence state.
 * Nothing becomes mutation authority.
 * ============================================================
 */

export function runHostBindingShadow({
  hostObligationSpec,
  graphViews,
  impactValidated = [],
} = {}) {
  if (
    hostObligationSpec?.status !==
      "compiled"
  ) {
    return Object.freeze({
      ...baseShadow({
        protocol:
          HOST_BINDING_SHADOW_PROTOCOL,
        status:
          "unresolved",
        reason:
          "host_obligation_spec_unavailable",
        taskSha256:
          hostObligationSpec
            ?.task_sha256,
      }),

      protected_surface: null,
      ui_host: null,
      navigation_host: null,
      data_access_capability: null,
    })
  }

  if (
    graphViews?.status !==
      "observed"
  ) {
    return Object.freeze({
      ...baseShadow({
        protocol:
          HOST_BINDING_SHADOW_PROTOCOL,
        status:
          "unresolved",
        reason:
          "resource_graph_view_unavailable",
        taskSha256:
          hostObligationSpec
            ?.task_sha256,
      }),

      protected_surface: null,
      ui_host: null,
      navigation_host: null,
      data_access_capability: null,
    })
  }

  const graphComplete =
    graphViews.truncated !== true

  /*
   * Protected/context surface.
   */
  let protectedSurface = {
    status:
      "not_required",

    anchor_association:
      hostObligationSpec
        .protected_anchor_status,

    route_anchor:
      null,

    owner_candidates: [],

    structural_ready:
      false,

    semantic_ready:
      false,

    reason:
      "protected_surface_not_required",
  }

  const protectedRequired =
    (
      hostObligationSpec
        .protected_specs ??
      []
    ).some(
      (spec) =>
        spec.obligation ===
          "protected_surface",
    )

  if (protectedRequired) {
    const routeCandidates =
      hostObligationSpec
        .protected_route_candidates ??
      []

    if (
      hostObligationSpec
        .protected_anchor_status ===
          "ambiguous_route_anchor_set"
    ) {
      protectedSurface = {
        ...protectedSurface,

        status:
          "ambiguous",

        reason:
          "protected_route_anchor_ambiguous",
      }
    } else if (
      routeCandidates.length === 1
    ) {
      const route =
        routeCandidates[0].value

      const owners =
        routeOwnerCandidates(
          graphViews,
          route,
        )

      if (owners.length === 1) {
        protectedSurface = {
          status:
            "context_bound_candidate",

          anchor_association:
            hostObligationSpec
              .protected_anchor_status,

          route_anchor:
            route,

          owner:
            owners[0].owner,

          owner_candidates:
            owners.map(
              (item) =>
                item.owner,
            ),

          proof_edges:
            owners[0]
              .proofs,

          /*
           * Unique ownership is structural only when
           * the graph observation itself was not truncated.
           */
          structural_ready:
            graphComplete,

          /*
           * Still false because role/polarity association
           * of TaskAnchor is not yet proven.
           */
          semantic_ready:
            false,

          reason:
            graphComplete
              ? "unique_route_owner_context"
              : "unique_route_owner_but_graph_truncated",
        }
      } else if (
        owners.length > 1
      ) {
        protectedSurface = {
          ...protectedSurface,

          status:
            "ambiguous",

          route_anchor:
            route,

          owner_candidates:
            owners.map(
              (item) =>
                item.owner,
            ),

          reason:
            "multiple_route_owners",
        }
      } else {
        protectedSurface = {
          ...protectedSurface,

          status:
            "unresolved",

          route_anchor:
            route,

          reason:
            "route_owner_not_observed",
        }
      }
    } else {
      protectedSurface = {
        ...protectedSurface,

        status:
          "unresolved",

        reason:
          "protected_route_anchor_unavailable",
      }
    }
  }

  const owner =
    typeof protectedSurface
      ?.owner === "string"
      ? protectedSurface.owner
      : null

  /*
   * UI host:
   * context owner -> rendered resource.
   */
  let uiHost = {
    status:
      "unresolved",

    owner,

    candidates: [],

    structural_ready:
      false,

    semantic_ready:
      false,

    reason:
      owner
        ? "rendered_resource_not_observed"
        : "context_owner_unavailable",
  }

  if (owner) {
    const rendered =
      renderedCandidates(
        graphViews,
        owner,
      )

    if (rendered.length === 1) {
      uiHost = {
        status:
          "context_bound_candidate",

        owner,

        resource:
          rendered[0]
            .resource,

        candidates:
          rendered.map(
            (item) =>
              item.resource,
          ),

        proof_edges:
          rendered[0]
            .proofs,

        structural_ready:
          graphComplete,

        /*
         * The owner came from a protected-context candidate,
         * not yet a role-bound positive task anchor.
         */
        semantic_ready:
          false,

        reason:
          graphComplete
            ? "unique_rendered_resource_in_context"
            : "unique_rendered_resource_but_graph_truncated",
      }
    } else if (
      rendered.length > 1
    ) {
      uiHost = {
        ...uiHost,

        status:
          "ambiguous",

        candidates:
          rendered
            .map(
              (item) =>
                item.resource,
            )
            .slice(
              0,
              MAX_BINDINGS_PER_ROLE,
            ),

        reason:
          "multiple_rendered_resources_in_context",
      }
    }
  }

  /*
   * Navigation host:
   * UI resource -> included shared topology.
   *
   * No filename heuristics:
   * "menu", "navbar", "sidebar" are irrelevant.
   */
  let navigationHost = {
    status:
      "unresolved",

    candidates: [],

    structural_ready:
      false,

    semantic_ready:
      false,

    reason:
      "navigation_resource_not_observed",
  }

  const uiResource =
    typeof uiHost?.resource ===
      "string"
      ? uiHost.resource
      : null

  if (uiResource) {
    const included =
      includedResourceCandidates(
        graphViews,
        [uiResource],
      )

    if (included.length === 1) {
      const candidate =
        included[0]

      const topologyReady =
        graphComplete &&
        candidate
          .shared_navigation_topology ===
            true

      navigationHost = {
        status:
          topologyReady
            ? "structural_candidate"
            : "context_candidate",

        resource:
          candidate.resource,

        candidates:
          included.map(
            (item) => ({
              resource:
                item.resource,

              includer_count:
                item.includer_count,

              route_target_count:
                item.route_target_count,

              shared_navigation_topology:
                item.shared_navigation_topology,
            }),
          ),

        proof_edges:
          candidate
            .direct_proofs,

        includers:
          candidate.includers,

        route_targets:
          candidate.route_targets,

        structural_ready:
          topologyReady,

        semantic_ready:
          false,

        reason:
          topologyReady
            ? "shared_navigation_topology_observed"
            : graphComplete
              ? "included_resource_not_yet_shared_navigation"
              : "navigation_graph_truncated",
      }
    } else if (
      included.length > 1
    ) {
      navigationHost = {
        ...navigationHost,

        status:
          "ambiguous",

        candidates:
          included
            .map(
              (item) => ({
                resource:
                  item.resource,

                includer_count:
                  item.includer_count,

                route_target_count:
                  item.route_target_count,

                shared_navigation_topology:
                  item.shared_navigation_topology,
              }),
            )
            .slice(
              0,
              MAX_BINDINGS_PER_ROLE,
            ),

        reason:
          "multiple_included_resources_in_ui_context",
      }
    }
  }

  /*
   * Data access:
   * context owner -> validated forward dependency.
   *
   * This deliberately does NOT equate any validated dependency
   * with the task-requested database/provider.
   */
  let dataAccess = {
    status:
      "unresolved",

    candidates: [],

    source_identity_status:
      "unresolved",

    structural_ready:
      false,

    semantic_ready:
      false,

    reason:
      owner
        ? "validated_data_access_candidate_unavailable"
        : "context_owner_unavailable",
  }

  if (owner) {
    const candidates =
      impactCandidatesForOwner(
        impactValidated,
        owner,
      )

    if (candidates.length === 1) {
      dataAccess = {
        status:
          "structural_candidate",

        candidate:
          candidates[0],

        candidates,

        source_identity_status:
          "unresolved",

        /*
         * Dependency relationship itself is proven.
         * Provider/task identity is not.
         */
        structural_ready:
          true,

        semantic_ready:
          false,

        reason:
          "validated_dependency_provider_identity_unresolved",
      }
    } else if (
      candidates.length > 1
    ) {
      dataAccess = {
        status:
          "ambiguous",

        candidates,

        source_identity_status:
          "unresolved",

        structural_ready:
          false,

        semantic_ready:
          false,

        reason:
          "multiple_validated_dependency_candidates",
      }
    }
  }

  return Object.freeze({
    ...baseShadow({
      protocol:
        HOST_BINDING_SHADOW_PROTOCOL,
      status:
        "observed",
      reason:
        "host_binding_candidates_composed",
      taskSha256:
        hostObligationSpec
          .task_sha256,
    }),

    graph_complete:
      graphComplete,

    protected_surface:
      protectedSurface,

    ui_host:
      uiHost,

    navigation_host:
      navigationHost,

    data_access_capability:
      dataAccess,
  })
}


/*
 * ============================================================
 * E1.3d — structural + semantic shadow coverage
 *
 * This is NOT ObligationCoverage authority.
 *
 * It answers two different questions:
 *
 * structural_ready:
 *   did we observe the necessary integration topology?
 *
 * semantic_ready:
 *   is that topology sufficiently task-bound for authority?
 *
 * Keeping these separate prevents "good graph edge"
 * from silently becoming "correct task evidence".
 * ============================================================
 */

export function assessHostShadowCoverage({
  hostObligationSpec,
  hostBindingShadow,
} = {}) {
  if (
    hostObligationSpec?.status !==
      "compiled" ||
    hostBindingShadow?.status !==
      "observed"
  ) {
    return Object.freeze({
      ...baseShadow({
        protocol:
          HOST_SHADOW_COVERAGE_PROTOCOL,
        status:
          "unresolved",
        reason:
          "host_shadow_inputs_unavailable",
        taskSha256:
          hostObligationSpec
            ?.task_sha256,
      }),

      obligations: [],
      structurally_ready: [],
      structurally_missing: [],
      semantically_ready: [],
      semantic_blockers: [],
    })
  }

  const required =
    uniqueSorted(
      (
        hostObligationSpec
          .positive_specs ??
        []
      ).map(
        (spec) =>
          spec.obligation,
      ),
    )

  const bindingFor =
    (obligation) => {
      if (
        obligation ===
        "ui_host"
      ) {
        return hostBindingShadow
          .ui_host
      }

      if (
        obligation ===
        "navigation_host"
      ) {
        return hostBindingShadow
          .navigation_host
      }

      if (
        obligation ===
        "data_access_capability"
      ) {
        return hostBindingShadow
          .data_access_capability
      }

      /*
       * server_host and future host obligations
       * fail closed until an explicit composer exists.
       */
      return null
    }

  const obligations =
    required.map(
      (obligation) => {
        const binding =
          bindingFor(
            obligation,
          )

        return {
          obligation,

          status:
            binding?.status ??
            "unresolved",

          structural_ready:
            binding
              ?.structural_ready ===
              true,

          semantic_ready:
            binding
              ?.semantic_ready ===
              true,

          reason:
            binding?.reason ??
            "binding_composer_unavailable",
        }
      },
    )

  const structurallyReady =
    obligations
      .filter(
        (item) =>
          item.structural_ready,
      )
      .map(
        (item) =>
          item.obligation,
      )

  const structurallyMissing =
    obligations
      .filter(
        (item) =>
          !item.structural_ready,
      )
      .map(
        (item) =>
          item.obligation,
      )

  const semanticallyReady =
    obligations
      .filter(
        (item) =>
          item.semantic_ready,
      )
      .map(
        (item) =>
          item.obligation,
      )

  const semanticBlockers =
    obligations
      .filter(
        (item) =>
          !item.semantic_ready,
      )
      .map(
        (item) => ({
          obligation:
            item.obligation,

          reason:
            item.reason,
        }),
      )

  let status

  if (
    structurallyMissing.length > 0
  ) {
    status =
      "insufficient_structural_context"
  } else if (
    semanticBlockers.length > 0
  ) {
    status =
      "structural_complete_semantic_blocked"
  } else {
    /*
     * This state is observational only.
     * Even all-semantic-ready shadow evidence does not
     * promote LocalizationDecision in E1.3.
     */
    status =
      "shadow_semantic_ready"
  }

  return Object.freeze({
    ...baseShadow({
      protocol:
        HOST_SHADOW_COVERAGE_PROTOCOL,
      status,
      reason:
        status,
      taskSha256:
        hostObligationSpec
          .task_sha256,
    }),

    obligations,

    structurally_ready:
      structurallyReady,

    structurally_missing:
      structurallyMissing,

    semantically_ready:
      semanticallyReady,

    semantic_blockers:
      semanticBlockers,

    positive_complete:
      false,
  })
}


/*
 * ============================================================
 * Composite entry point.
 * ============================================================
 */

export function runHostIntegrationShadow({
  taskRequirements,
  taskAnchors,
  additiveLocalizationPlan,

  frameworkEdges = [],
  resourceEdges = [],

  impactValidated = [],

  frameworkTruncated = false,
  resourceTruncated = false,

  maxEdges = MAX_GRAPH_EDGES,
} = {}) {
  const spec =
    compileHostObligationSpec({
      taskRequirements,
      taskAnchors,
      additiveLocalizationPlan,
    })

  const views =
    buildResourceGraphViews({
      frameworkEdges,
      resourceEdges,
      frameworkTruncated,
      resourceTruncated,
      maxEdges,
    })

  const bindings =
    runHostBindingShadow({
      hostObligationSpec:
        spec,

      graphViews:
        views,

      impactValidated,
    })

  const coverage =
    assessHostShadowCoverage({
      hostObligationSpec:
        spec,

      hostBindingShadow:
        bindings,
    })

  return Object.freeze({
    protocol:
      HOST_INTEGRATION_SHADOW_PROTOCOL,

    authority:
      HOST_SHADOW_AUTHORITY,

    status:
      spec.status === "compiled"
        ? "observed"
        : "unresolved",

    reason:
      spec.status === "compiled"
        ? "composite_host_shadow_observed"
        : spec.reason,

    task_sha256:
      spec.task_sha256,

    localization_authority:
      false,

    mutation_authority:
      false,

    obligation_spec:
      spec,

    graph_views:
      views,

    bindings,

    coverage,
  })
}
