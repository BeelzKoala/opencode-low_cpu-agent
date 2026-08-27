import {
  EVIDENCE_BASIS,
} from "./evidence-tier-v1.mjs"

import {
  RESOURCE_EDGE_KIND,
} from "./resource-graph-v1.mjs"


export const HOST_OBLIGATION_PROJECTOR_PROTOCOL =
  "host-obligation-projector-v1"

export const HOST_OBLIGATION_PROJECTOR_AUTHORITY =
  "proof_projection_only"


function routePath(
  node,
) {
  if (
    typeof node !== "string" ||
    !node.startsWith(
      "route:",
    )
  ) {
    return null
  }

  const value =
    node.slice(
      "route:".length,
    )

  if (
    value.startsWith("/")
  ) {
    return value
  }

  const firstSpace =
    value.indexOf(" ")

  if (
    firstSpace > 0 &&
    value.slice(
      firstSpace + 1,
    ).startsWith("/")
  ) {
    return value.slice(
      firstSpace + 1,
    )
  }

  return null
}


function canonicalAliasNode(
  node,
  aliases,
) {
  if (
    typeof node !== "string"
  ) {
    return node
  }

  for (const alias of aliases ?? []) {
    if (
      alias?.logical_node ===
        node &&
      typeof alias
        ?.physical_node ===
        "string"
    ) {
      return alias.physical_node
    }
  }

  return node
}


function aliasEquivalent(
  left,
  right,
  aliases,
) {
  return (
    canonicalAliasNode(
      left,
      aliases,
    ) ===
    canonicalAliasNode(
      right,
      aliases,
    )
  )
}


function edgeKey(
  edge,
) {
  return [
    edge?.from ?? "",
    edge?.to ?? "",
    edge?.kind ?? "",
    edge?.witness?.file ?? "",
    String(
      edge?.witness?.line ?? 0,
    ).padStart(
      12,
      "0",
    ),
  ].join("\0")
}


function firstEdge(
  edges,
  predicate,
) {
  return (
    edges
      .filter(predicate)
      .sort(
        (a, b) =>
          edgeKey(a)
            .localeCompare(
              edgeKey(b),
            ),
      )[0] ??
    null
  )
}


function empty(
  reason,
) {
  return Object.freeze({
    protocol:
      HOST_OBLIGATION_PROJECTOR_PROTOCOL,

    authority:
      HOST_OBLIGATION_PROJECTOR_AUTHORITY,

    status:
      "unresolved",

    reason,

    proofs:
      Object.freeze([]),

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}


export function projectAnchoredHostObligationProofs({
  taskRequirements,
  additiveLocalizationPlan,
  anchorFrontier,
  hostResourceClosure,
  frameworkEdges = [],
  aliases = [],
} = {}) {
  const taskSha =
    typeof taskRequirements
      ?.task_sha256 === "string"
      ? taskRequirements
          .task_sha256
          .toLowerCase()
      : null

  const planSha =
    typeof additiveLocalizationPlan
      ?.task_sha256 === "string"
      ? additiveLocalizationPlan
          .task_sha256
          .toLowerCase()
      : null

  if (
    taskRequirements?.status !==
      "compiled" ||
    additiveLocalizationPlan
      ?.status !== "planned" ||
    !taskSha ||
    planSha !== taskSha
  ) {
    return empty(
      "task_plan_identity_unresolved",
    )
  }

  const coverageRequirements =
    additiveLocalizationPlan
      ?.positive_coverage_requirements

  if (
    coverageRequirements
      ?.status !== "compiled" ||
    coverageRequirements
      ?.task_sha256 !== taskSha
  ) {
    return empty(
      "positive_coverage_requirements_unresolved",
    )
  }

  const required =
    new Set(
      coverageRequirements
        ?.required_roles ??
      [],
    )

  const owner =
    anchorFrontier?.owner

  const routeAnchor =
    anchorFrontier
      ?.route_anchor

  if (
    anchorFrontier?.status !==
      "bound" ||
    typeof owner !== "string" ||
    !owner.startsWith(
      "file:",
    ) ||
    typeof routeAnchor !==
      "string" ||
    !routeAnchor.startsWith("/")
  ) {
    return empty(
      "exact_task_anchor_owner_unavailable",
    )
  }

  const protectedSurface =
    hostResourceClosure
      ?.protected_surface

  if (
    protectedSurface
      ?.structural_ready !== true ||
    protectedSurface
      ?.owner !== owner ||
    protectedSurface
      ?.route_anchor !==
      routeAnchor
  ) {
    return empty(
      "protected_surface_not_task_bound",
    )
  }

  const edges =
    Array.isArray(
      frameworkEdges,
    )
      ? frameworkEdges.filter(
          (edge) =>
            edge?.validated === true,
        )
      : []

  /*
   * Exact route declaration proves that the owner file
   * is task-bound context.
   */
  const anchorEdge =
    firstEdge(
      edges,
      (edge) =>
        edge.kind ===
          RESOURCE_EDGE_KIND
            .DECLARES_ROUTE &&
        edge.from === owner &&
        routePath(
          edge.to,
        ) === routeAnchor,
    )

  if (!anchorEdge) {
    return empty(
      "task_anchor_source_proof_unavailable",
    )
  }

  const proofs = []

  const ui =
    hostResourceClosure
      ?.ui_candidate

  let renderEdge = null

  if (
    required.has(
      "ui_host",
    ) &&
    ui?.structural_ready ===
      true &&
    ui?.owner === owner &&
    typeof ui?.resource ===
      "string"
  ) {
    renderEdge =
      firstEdge(
        edges,
        (edge) =>
          edge.kind ===
            RESOURCE_EDGE_KIND
              .RENDERS_RESOURCE &&
          edge.from === owner &&
          aliasEquivalent(
            edge.to,
            ui.resource,
            aliases,
          ),
      )

    if (renderEdge) {
      proofs.push(
        Object.freeze({
          obligation:
            "ui_host",

          basis:
            EVIDENCE_BASIS
              .TASK_CAUSAL_PATH,

          /*
           * Direct exact task-anchor source witness.
           */
          source_proof:
            anchorEdge.witness,

          /*
           * Task-bound owner -> observed UI host.
           */
          causal_path:
            Object.freeze([
              renderEdge,
            ]),

          ambiguous:
            false,

          detail:
            Object.freeze({
              task_anchor:
                routeAnchor,

              task_owner:
                owner,

              target:
                ui.resource,

              producer:
                HOST_OBLIGATION_PROJECTOR_PROTOCOL,
            }),
        }),
      )
    }
  }

  const navigation =
    hostResourceClosure
      ?.navigation_candidate

  if (
    renderEdge &&
    required.has(
      "navigation_host",
    ) &&
    navigation
      ?.structural_ready === true &&
    typeof navigation
      ?.resource === "string" &&
    typeof ui?.resource ===
      "string"
  ) {
    const includeEdge =
      firstEdge(
        edges,
        (edge) =>
          edge.kind ===
            RESOURCE_EDGE_KIND
              .INCLUDES_RESOURCE &&
          aliasEquivalent(
            edge.from,
            ui.resource,
            aliases,
          ) &&
          aliasEquivalent(
            edge.to,
            navigation.resource,
            aliases,
          ),
      )

    if (includeEdge) {
      proofs.push(
        Object.freeze({
          obligation:
            "navigation_host",

          basis:
            EVIDENCE_BASIS
              .TASK_CAUSAL_PATH,

          source_proof:
            anchorEdge.witness,

          /*
           * owner -> UI -> navigation.
           *
           * Alias equivalence is validated above without
           * rewriting either immutable ResourceEdge.
           */
          causal_path:
            Object.freeze([
              renderEdge,
              includeEdge,
            ]),

          ambiguous:
            false,

          detail:
            Object.freeze({
              task_anchor:
                routeAnchor,

              task_owner:
                owner,

              ui_target:
                ui.resource,

              target:
                navigation.resource,

              producer:
                HOST_OBLIGATION_PROJECTOR_PROTOCOL,
            }),
        }),
      )
    }
  }

  /*
   * Deliberately no data_access_capability here.
   *
   * Generic dependency/Impact evidence is Tier D.
   * A later producer may cover data access only after an
   * independently task-bound provider path is proven.
   */

  return Object.freeze({
    protocol:
      HOST_OBLIGATION_PROJECTOR_PROTOCOL,

    authority:
      HOST_OBLIGATION_PROJECTOR_AUTHORITY,

    status:
      proofs.length > 0
        ? "proofs_projected"
        : "no_supported_host_path",

    reason:
      proofs.length > 0
        ? "anchored_host_relations_observed"
        : "supported_host_relation_unavailable",

    proofs:
      Object.freeze(
        [...proofs],
      ),

    /*
     * Producer output is not itself authority.
     * Generic E1.5 evidence ABI performs A/B classification.
     */
    localization_authority:
      false,

    mutation_authority:
      false,
  })
}
