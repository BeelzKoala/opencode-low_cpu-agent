import {
  RESOURCE_EDGE_KIND,
  normalizeValidatedResourceEdge,
} from "./resource-graph-v1.mjs"

import {
  resolveObservedResource,
} from "./observed-resource-resolver-v1.mjs"


export const HOST_RESOURCE_CLOSURE_V2_PROTOCOL =
  "host-resource-closure-v2"

export const HOST_RESOURCE_ALIAS_VIEW_PROTOCOL =
  "host-resource-alias-view-v2"

export const HOST_RESOURCE_CLOSURE_AUTHORITY =
  "shadow_resolution_only"

const MAX_RESOURCE_ROOTS = 16
const MAX_ALIAS_RESOLUTIONS = 4


function normalizePath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1
  ) {
    return null
  }

  const normalized =
    value
      .replaceAll("\\", "/")
      .replace(/^\.\/+/u, "")

  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    return null
  }

  const parts =
    normalized.split("/")

  if (
    parts.some(
      (part) =>
        !part ||
        part === "..",
    )
  ) {
    return null
  }

  return parts.join("/")
}


function resourceNode(
  value,
) {
  if (
    typeof value !== "string"
  ) {
    return null
  }

  for (
    const prefix of [
      "template:",
      "component:",
    ]
  ) {
    if (
      value.startsWith(prefix)
    ) {
      const target =
        normalizePath(
          value.slice(
            prefix.length,
          ),
        )

      if (!target) {
        return null
      }

      return {
        prefix:
          prefix.slice(
            0,
            -1,
          ),

        target,
      }
    }
  }

  return null
}


function physicalNode(
  prefix,
  file,
) {
  const normalized =
    normalizePath(file)

  if (
    !normalized ||
    typeof prefix !== "string" ||
    prefix.length < 1
  ) {
    return null
  }

  return `${prefix}:${normalized}`
}


function resourceRootsForTarget(
  target,
  observedFiles,
) {
  const normalizedTarget =
    normalizePath(target)

  if (!normalizedTarget) {
    return {
      roots: [],
      truncated: false,
    }
  }

  const roots =
    new Set()

  for (
    const rawFile of
    Array.isArray(observedFiles)
      ? observedFiles
      : []
  ) {
    const file =
      normalizePath(
        rawFile,
      )

    if (!file) {
      continue
    }

    if (file === normalizedTarget) {
      roots.add(".")
      continue
    }

    const suffix =
      `/${normalizedTarget}`

    if (
      file.endsWith(
        suffix,
      )
    ) {
      const root =
        file.slice(
          0,
          -suffix.length,
        )

      if (root) {
        roots.add(root)
      }
    }
  }

  const ordered =
    [...roots].sort()

  return {
    roots:
      ordered.slice(
        0,
        MAX_RESOURCE_ROOTS,
      ),

    truncated:
      ordered.length >
      MAX_RESOURCE_ROOTS,
  }
}


function aliasKey(
  alias,
) {
  return [
    alias?.logical_node ?? "",
    alias?.physical_node ?? "",
  ].join("\0")
}


export function mergeHostAliases(
  ...groups
) {
  const entries = []

  for (const group of groups) {
    for (
      const item of
      Array.isArray(group)
        ? group
        : []
    ) {
      if (
        typeof item?.logical_node !==
          "string" ||
        typeof item?.physical_node !==
          "string" ||
        typeof item?.physical_file !==
          "string"
      ) {
        continue
      }

      entries.push(item)
    }
  }

  return [
    ...new Map(
      entries
        .sort(
          (a, b) =>
            aliasKey(a)
              .localeCompare(
                aliasKey(b),
              ),
        )
        .map(
          (item) => [
            aliasKey(item),
            item,
          ],
        ),
    ).values(),
  ]
}


function aliasEquivalent(
  left,
  right,
  aliases,
) {
  if (
    left === right &&
    typeof left === "string"
  ) {
    return true
  }

  if (
    typeof left !== "string" ||
    typeof right !== "string"
  ) {
    return false
  }

  for (
    const alias of
    Array.isArray(aliases)
      ? aliases
      : []
  ) {
    const logical =
      alias?.logical_node

    const physical =
      alias?.physical_node

    if (
      !logical ||
      !physical
    ) {
      continue
    }

    if (
      (
        left === logical &&
        right === physical
      ) ||
      (
        left === physical &&
        right === logical
      )
    ) {
      return true
    }
  }

  return false
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

  for (
    const alias of
    Array.isArray(aliases)
      ? aliases
      : []
  ) {
    if (
      alias?.physical_node ===
      node &&
      typeof alias?.logical_node ===
        "string"
    ) {
      return alias.logical_node
    }
  }

  return node
}


function physicalFileForNode(
  node,
  aliases,
) {
  for (
    const alias of
    Array.isArray(aliases)
      ? aliases
      : []
  ) {
    if (
      alias?.logical_node === node ||
      alias?.physical_node === node
    ) {
      return (
        normalizePath(
          alias?.physical_file,
        ) ??
        null
      )
    }
  }

  return null
}


function normalizeEdges(
  frameworkEdges,
  resourceEdges,
) {
  const edges = []
  const rejected = []

  for (
    const rawEdge of [
      ...(
        Array.isArray(frameworkEdges)
          ? frameworkEdges
          : []
      ),
      ...(
        Array.isArray(resourceEdges)
          ? resourceEdges
          : []
      ),
    ]
  ) {
    const edge =
      normalizeValidatedResourceEdge(
        rawEdge,
      )

    if (!edge) {
      rejected.push(rawEdge)
      continue
    }

    edges.push(edge)
  }

  const unique =
    [
      ...new Map(
        edges
          .sort(
            (a, b) =>
              [
                a.kind,
                a.from,
                a.to,
                a?.witness?.file ?? "",
                a?.witness?.line ?? 0,
              ]
                .join("\0")
                .localeCompare(
                  [
                    b.kind,
                    b.from,
                    b.to,
                    b?.witness?.file ?? "",
                    b?.witness?.line ?? 0,
                  ].join("\0"),
                ),
          )
          .map(
            (edge) => [
              [
                edge.kind,
                edge.from,
                edge.to,
                edge?.witness?.file ?? "",
                edge?.witness?.line ?? 0,
              ].join("\0"),
              edge,
            ],
          ),
      ).values(),
    ]

  return {
    edges:
      unique,

    rejected:
      rejected.length,
  }
}


function resolveOneAlias({
  logicalNode,
  sourcePath = null,
  observedFiles,
  inventoryComplete,
}) {
  const resource =
    resourceNode(
      logicalNode,
    )

  if (!resource) {
    return {
      status:
        "unsupported",

      logical_node:
        logicalNode,

      alias:
        null,

      resolver:
        null,
    }
  }

  const rootResult =
    resourceRootsForTarget(
      resource.target,
      observedFiles,
    )

  /*
   * Truncating possible resource roots and then claiming a
   * unique resolution would be false evidence.
   */
  if (
    rootResult.truncated === true
  ) {
    return {
      status:
        "incomplete",

      logical_node:
        logicalNode,

      alias:
        null,

      resolver:
        null,

      reason:
        "resource_root_budget",
    }
  }

  const resolved =
    resolveObservedResource({
      target:
        resource.target,

      sourcePath,
      observedFiles,

      resourceRoots:
        rootResult.roots,

      inventoryComplete:
        inventoryComplete === true,
    })

  if (
    resolved.status !==
      "resolved" ||
    !resolved.resolved_file
  ) {
    return {
      status:
        resolved.status,

      logical_node:
        logicalNode,

      alias:
        null,

      resolver:
        resolved,
    }
  }

  const physical =
    physicalNode(
      resource.prefix,
      resolved.resolved_file,
    )

  if (!physical) {
    return {
      status:
        "invalid",

      logical_node:
        logicalNode,

      alias:
        null,

      resolver:
        resolved,
    }
  }

  return {
    status:
      "resolved",

    logical_node:
      logicalNode,

    resolver:
      resolved,

    alias: Object.freeze({
      protocol:
        HOST_RESOURCE_ALIAS_VIEW_PROTOCOL,

      authority:
        HOST_RESOURCE_CLOSURE_AUTHORITY,

      logical_node:
        logicalNode,

      physical_node:
        physical,

      physical_file:
        resolved.resolved_file,

      resource_root:
        rootResult.roots.length === 1
          ? rootResult.roots[0]
          : null,

      proof:
        "observed_resource_resolver",

      resolver_protocol:
        resolved.protocol,

      inventory_complete:
        resolved.inventory_complete ===
        true,

      localization_authority:
        false,

      mutation_authority:
        false,
    }),
  }
}


export function resolveHostAliasesForNodes({
  nodes = [],
  sourcePath = null,
  observedFiles = [],
  inventoryComplete = false,
  maxAliases = MAX_ALIAS_RESOLUTIONS,
} = {}) {
  const logicalNodes =
    [
      ...new Set(
        (
          Array.isArray(nodes)
            ? nodes
            : []
        )
          .filter(
            (node) =>
              typeof node ===
                "string",
          ),
      ),
    ].sort()

  const limit =
    Math.max(
      0,
      Math.min(
        Number.isSafeInteger(
          maxAliases,
        )
          ? maxAliases
          : MAX_ALIAS_RESOLUTIONS,

        MAX_ALIAS_RESOLUTIONS,
      ),
    )

  const selected =
    logicalNodes.slice(
      0,
      limit,
    )

  const resolutions =
    selected.map(
      (logicalNode) =>
        resolveOneAlias({
          logicalNode,
          sourcePath,
          observedFiles,
          inventoryComplete,
        }),
    )

  const aliases =
    resolutions
      .map(
        (item) =>
          item.alias,
      )
      .filter(Boolean)

  const truncated =
    logicalNodes.length >
    selected.length

  let status

  if (truncated) {
    status =
      "incomplete"
  } else if (
    aliases.length ===
      logicalNodes.length &&
    logicalNodes.length > 0
  ) {
    status =
      "resolved"
  } else if (
    resolutions.some(
      (item) =>
        item.status ===
        "ambiguous",
    )
  ) {
    status =
      "ambiguous"
  } else if (
    logicalNodes.length < 1
  ) {
    status =
      "empty"
  } else {
    status =
      "partial"
  }

  return Object.freeze({
    protocol:
      HOST_RESOURCE_ALIAS_VIEW_PROTOCOL,

    authority:
      HOST_RESOURCE_CLOSURE_AUTHORITY,

    status,

    requested_nodes:
      logicalNodes,

    aliases:
      mergeHostAliases(
        aliases,
      ),

    resolutions,

    truncated,

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}


export function resolveHostClosureContext({
  anchorFrontier,
  frameworkEdges = [],
  resourceEdges = [],
  aliases = [],
} = {}) {
  const normalized =
    normalizeEdges(
      frameworkEdges,
      resourceEdges,
    )

  const edges =
    normalized.edges

  const owner =
    anchorFrontier?.status ===
      "bound"
      ? anchorFrontier.owner
      : null

  const protectedSurface =
    Object.freeze({
      status:
        owner
          ? "context_bound"
          : "unresolved",

      route_anchor:
        anchorFrontier
          ?.route_anchor ??
        null,

      owner,

      owner_file:
        anchorFrontier
          ?.owner_file ??
        null,

      structural_ready:
        Boolean(owner),

      reason:
        owner
          ? "exact_anchor_frontier_owner"
          : (
              anchorFrontier
                ?.reason ??
              "anchor_owner_unavailable"
            ),

      semantic_ready:
        false,
    })

  const rendered =
    owner
      ? [
          ...new Set(
            edges
              .filter(
                (edge) =>
                  edge.kind ===
                    RESOURCE_EDGE_KIND.RENDERS_RESOURCE &&
                  edge.from ===
                    owner,
              )
              .map(
                (edge) =>
                  edge.to,
              ),
          ),
        ].sort()
      : []

  const uiResource =
    rendered.length === 1
      ? rendered[0]
      : null

  const uiPhysicalFile =
    uiResource
      ? physicalFileForNode(
          uiResource,
          aliases,
        )
      : null

  const uiCandidate =
    Object.freeze({
      status:
        rendered.length === 1
          ? (
              uiPhysicalFile
                ? "resolved_physical_host"
                : "logical_host_candidate"
            )
          : (
              rendered.length > 1
                ? "ambiguous"
                : "unresolved"
            ),

      owner,

      resource:
        uiResource,

      physical_file:
        uiPhysicalFile,

      candidates:
        rendered,

      structural_ready:
        Boolean(
          owner &&
          uiResource &&
          uiPhysicalFile,
        ),

      semantic_ready:
        false,

      reason:
        rendered.length === 1
          ? (
              uiPhysicalFile
                ? "unique_render_resolved_physical"
                : "unique_render_requires_resource_resolution"
            )
          : (
              rendered.length > 1
                ? "multiple_rendered_resources"
                : "rendered_resource_not_observed"
            ),
    })

  const includeCandidates =
    uiResource
      ? [
          ...new Set(
            edges
              .filter(
                (edge) =>
                  edge.kind ===
                    RESOURCE_EDGE_KIND.INCLUDES_RESOURCE &&
                  aliasEquivalent(
                    edge.from,
                    uiResource,
                    aliases,
                  ),
              )
              .map(
                (edge) =>
                  edge.to,
              ),
          ),
        ].sort()
      : []

  const topology =
    includeCandidates.map(
      (resource) => {
        const includers =
          [
            ...new Set(
              edges
                .filter(
                  (edge) =>
                    edge.kind ===
                      RESOURCE_EDGE_KIND.INCLUDES_RESOURCE &&
                    aliasEquivalent(
                      edge.to,
                      resource,
                      aliases,
                    ),
                )
                .map(
                  (edge) =>
                    canonicalAliasNode(
                      edge.from,
                      aliases,
                    ),
                ),
            ),
          ].sort()

        const routeTargets =
          [
            ...new Set(
              edges
                .filter(
                  (edge) =>
                    edge.kind ===
                      RESOURCE_EDGE_KIND.TARGETS_ROUTE &&
                    aliasEquivalent(
                      edge.from,
                      resource,
                      aliases,
                    ),
                )
                .map(
                  (edge) =>
                    edge.to,
                ),
            ),
          ].sort()

        const physicalFile =
          physicalFileForNode(
            resource,
            aliases,
          )

        return {
          resource,
          physical_file:
            physicalFile,

          includers,
          route_targets:
            routeTargets,

          shared_includers:
            includers.length,

          internal_route_targets:
            routeTargets.length,

          structural_ready:
            Boolean(
              physicalFile &&
              includers.length >= 2 &&
              routeTargets.length >= 2
            ),
        }
      },
    )

  const readyNavigation =
    topology.filter(
      (item) =>
        item.structural_ready ===
        true,
    )

  let navigationResource = null
  let navigationStatus
  let navigationReason
  let navigationReady = false

  if (readyNavigation.length === 1) {
    navigationResource =
      readyNavigation[0]
        .resource

    navigationStatus =
      "resolved_structural_host"

    navigationReason =
      "shared_included_resource_with_internal_routes"

    navigationReady = true
  } else if (readyNavigation.length > 1) {
    navigationStatus =
      "ambiguous"

    navigationReason =
      "multiple_navigation_topology_candidates"
  } else if (
    includeCandidates.length === 1
  ) {
    navigationResource =
      includeCandidates[0]

    navigationStatus =
      "structural_candidate"

    navigationReason =
      "navigation_topology_incomplete"
  } else if (
    includeCandidates.length > 1
  ) {
    navigationStatus =
      "ambiguous_or_incomplete"

    navigationReason =
      "multiple_included_resources_without_unique_navigation_topology"
  } else {
    navigationStatus =
      "unresolved"

    navigationReason =
      "included_resource_not_observed"
  }

  const selectedTopology =
    navigationResource
      ? (
          topology.find(
            (item) =>
              item.resource ===
              navigationResource,
          ) ??
          null
        )
      : null

  const navigationCandidate =
    Object.freeze({
      status:
        navigationStatus,

      resource:
        navigationResource,

      physical_file:
        selectedTopology
          ?.physical_file ??
        null,

      include_candidates:
        includeCandidates,

      topology,

      structural_ready:
        navigationReady,

      semantic_ready:
        false,

      reason:
        navigationReason,
    })

  return Object.freeze({
    protocol:
      HOST_RESOURCE_CLOSURE_V2_PROTOCOL,

    authority:
      HOST_RESOURCE_CLOSURE_AUTHORITY,

    status:
      owner
        ? "context_observed"
        : "owner_unavailable",

    validated_edges:
      edges.length,

    rejected_edges:
      normalized.rejected,

    protected_surface:
      protectedSurface,

    ui_candidate:
      uiCandidate,

    navigation_candidate:
      navigationCandidate,

    navigation_include_candidates:
      includeCandidates,

    aliases_used:
      mergeHostAliases(
        aliases,
      ),

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}


function structuralDataReady(
  baselineHostIntegrationShadow,
) {
  return (
    baselineHostIntegrationShadow
      ?.bindings
      ?.data_access_capability
      ?.structural_ready ===
    true
  )
}


export function hostResourceClosureSummary({
  context,
  aliases = [],
  uiResolution = null,
  navigationResolution = null,
  uiFramework = null,
  uiResource = null,
  navigationFramework = null,
  navigationResource = null,
  baselineHostIntegrationShadow = null,
  positiveObligations = [],
} = {}) {
  const required =
    [
      ...new Set(
        (
          Array.isArray(
            positiveObligations,
          )
            ? positiveObligations
            : []
        )
          .filter(
            (item) =>
              typeof item ===
                "string",
          ),
      ),
    ].sort()

  const ready =
    new Set()

  if (
    context
      ?.ui_candidate
      ?.structural_ready ===
    true
  ) {
    ready.add(
      "ui_host",
    )
  }

  if (
    context
      ?.navigation_candidate
      ?.structural_ready ===
    true
  ) {
    ready.add(
      "navigation_host",
    )
  }

  if (
    structuralDataReady(
      baselineHostIntegrationShadow,
    )
  ) {
    ready.add(
      "data_access_capability",
    )
  }

  const structurallyReady =
    required
      .filter(
        (obligation) =>
          ready.has(
            obligation,
          ),
      )
      .sort()

  const structurallyMissing =
    required
      .filter(
        (obligation) =>
          !ready.has(
            obligation,
          ),
      )
      .sort()

  const followupFiles =
    [
      ...new Set([
        ...(
          uiResolution
            ?.aliases ??
          []
        ).map(
          (alias) =>
            alias.physical_file,
        ),
        ...(
          navigationResolution
            ?.aliases ??
          []
        ).map(
          (alias) =>
            alias.physical_file,
        ),
      ].filter(Boolean)),
    ].sort()

  const followupTruncated =
    (
      uiResolution?.truncated ===
      true
    ) ||
    (
      navigationResolution
        ?.truncated ===
      true
    )

  const frameworkFilesScanned =
    (
      uiFramework
        ?.filesScanned ??
      0
    ) +
    (
      navigationFramework
        ?.filesScanned ??
      0
    )

  const frameworkEdgesValidated =
    (
      uiFramework
        ?.validatedEdges ??
      0
    ) +
    (
      navigationFramework
        ?.validatedEdges ??
      0
    )

  const resourceFilesScanned =
    (
      uiResource
        ?.filesScanned ??
      0
    ) +
    (
      navigationResource
        ?.filesScanned ??
      0
    )

  const resourceEdgesValidated =
    (
      uiResource
        ?.validatedEdges ??
      0
    ) +
    (
      navigationResource
        ?.validatedEdges ??
      0
    )

  return Object.freeze({
    protocol:
      HOST_RESOURCE_CLOSURE_V2_PROTOCOL,

    authority:
      HOST_RESOURCE_CLOSURE_AUTHORITY,

    status:
      structurallyMissing.length < 1
        ? "structural_context_observed"
        : "partial_structural_context",

    aliases:
      mergeHostAliases(
        aliases,
      ),

    followup_files:
      followupFiles,

    followup_truncated:
      followupTruncated,

    framework_files_scanned:
      frameworkFilesScanned,

    framework_edges_validated:
      frameworkEdgesValidated,

    resource_files_scanned:
      resourceFilesScanned,

    resource_edges_validated:
      resourceEdgesValidated,

    protected_surface:
      context
        ?.protected_surface ??
      null,

    ui_candidate:
      context
        ?.ui_candidate ??
      null,

    navigation_candidate:
      context
        ?.navigation_candidate ??
      null,

    structurally_ready:
      structurallyReady,

    structurally_missing:
      structurallyMissing,

    semantically_ready: [],

    positive_complete:
      false,

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}
