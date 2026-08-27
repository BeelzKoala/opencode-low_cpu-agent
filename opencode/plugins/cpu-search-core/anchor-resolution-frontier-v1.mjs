import {
  RESOURCE_EDGE_KIND,
  normalizeValidatedResourceEdge,
} from "./resource-graph-v1.mjs"


export const ANCHOR_RESOLUTION_FRONTIER_PROTOCOL =
  "anchor-resolution-frontier-v1"

export const ANCHOR_RESOLUTION_FRONTIER_AUTHORITY =
  "shadow_resolution_only"

const HTTP_METHODS =
  new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ])


function normalizeFile(value) {
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


export function routeAnchorValues(
  taskAnchors,
) {
  const anchors =
    Array.isArray(taskAnchors)
      ? taskAnchors
      : (
          Array.isArray(
            taskAnchors?.anchors,
          )
            ? taskAnchors.anchors
            : []
        )

  return [
    ...new Set(
      anchors
        .filter(
          (anchor) =>
            anchor?.kind ===
              "route_literal" &&
            typeof anchor?.value ===
              "string" &&
            anchor.value.startsWith("/"),
        )
        .map(
          (anchor) =>
            anchor.value,
        ),
    ),
  ].sort()
}


function routeNodeMatches(
  node,
  route,
) {
  if (
    node ===
    `route:${route}`
  ) {
    return true
  }

  if (
    typeof node !== "string" ||
    !node.startsWith("route:")
  ) {
    return false
  }

  const raw =
    node.slice(
      "route:".length,
    )

  const firstSpace =
    raw.indexOf(" ")

  if (firstSpace < 1) {
    return false
  }

  const method =
    raw
      .slice(
        0,
        firstSpace,
      )
      .toUpperCase()

  const candidateRoute =
    raw.slice(
      firstSpace + 1,
    )

  return (
    HTTP_METHODS.has(method) &&
    candidateRoute === route
  )
}


function ownerFileFromNode(
  node,
) {
  if (
    typeof node !== "string" ||
    !node.startsWith("file:")
  ) {
    return null
  }

  return normalizeFile(
    node.slice(
      "file:".length,
    ),
  )
}


function baseResult({
  status,
  reason,
  routeAnchors,
  candidateFiles,
  searchComplete,
  searchTruncated,
  inspectionTruncated,
  routeAnchor = null,
  owner = null,
  ownerFile = null,
  ownerCandidates = [],
  proofs = [],
}) {
  return Object.freeze({
    protocol:
      ANCHOR_RESOLUTION_FRONTIER_PROTOCOL,

    authority:
      ANCHOR_RESOLUTION_FRONTIER_AUTHORITY,

    status,
    reason,

    route_anchors:
      routeAnchors,

    route_anchor:
      routeAnchor,

    candidate_files:
      candidateFiles,

    search_complete:
      searchComplete === true,

    search_truncated:
      searchTruncated === true,

    inspection_truncated:
      inspectionTruncated === true,

    owner,

    owner_file:
      ownerFile,

    owner_candidates:
      ownerCandidates,

    proofs,

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}


export function resolveAnchorFrontier({
  taskAnchors,
  candidateFiles = [],
  searchComplete = false,
  searchTruncated = false,
  inspectionTruncated = false,
  frameworkEdges = [],
} = {}) {
  const routeAnchors =
    routeAnchorValues(
      taskAnchors,
    )

  const candidates =
    [
      ...new Set(
        candidateFiles
          .map(normalizeFile)
          .filter(Boolean),
      ),
    ].sort()

  if (routeAnchors.length < 1) {
    return baseResult({
      status:
        "unresolved",

      reason:
        "route_anchor_unavailable",

      routeAnchors,
      candidateFiles:
        candidates,

      searchComplete,
      searchTruncated,
      inspectionTruncated,
    })
  }

  /*
   * TaskAnchor currently has no role/polarity binding.
   *
   * Multiple route literals therefore cannot be collapsed into
   * one protected owner without inventing semantics.
   */
  if (routeAnchors.length !== 1) {
    return baseResult({
      status:
        "ambiguous",

      reason:
        "ambiguous_route_anchor_set",

      routeAnchors,
      candidateFiles:
        candidates,

      searchComplete,
      searchTruncated,
      inspectionTruncated,
    })
  }

  const route =
    routeAnchors[0]

  if (
    searchComplete !== true ||
    searchTruncated === true
  ) {
    return baseResult({
      status:
        "incomplete",

      reason:
        "anchor_exact_search_incomplete",

      routeAnchors,
      routeAnchor:
        route,

      candidateFiles:
        candidates,

      searchComplete,
      searchTruncated,
      inspectionTruncated,
    })
  }

  if (
    inspectionTruncated === true
  ) {
    return baseResult({
      status:
        "incomplete",

      reason:
        "anchor_candidate_inspection_incomplete",

      routeAnchors,
      routeAnchor:
        route,

      candidateFiles:
        candidates,

      searchComplete,
      searchTruncated,
      inspectionTruncated,
    })
  }

  const candidateSet =
    new Set(candidates)

  const owners =
    new Set()

  const proofs = []

  for (
    const rawEdge of
    Array.isArray(frameworkEdges)
      ? frameworkEdges
      : []
  ) {
    const edge =
      normalizeValidatedResourceEdge(
        rawEdge,
      )

    if (!edge) {
      continue
    }

    if (
      edge.kind !==
        RESOURCE_EDGE_KIND.DECLARES_ROUTE ||
      !routeNodeMatches(
        edge.to,
        route,
      )
    ) {
      continue
    }

    const witnessFile =
      normalizeFile(
        edge?.witness?.file,
      )

    /*
     * The parser proof must come from one of the exact-literal
     * candidates inspected by this frontier. This prevents an
     * unrelated pre-existing graph edge from satisfying the
     * frontier certificate.
     */
    if (
      !witnessFile ||
      !candidateSet.has(
        witnessFile,
      )
    ) {
      continue
    }

    const ownerFile =
      ownerFileFromNode(
        edge.from,
      )

    if (!ownerFile) {
      continue
    }

    owners.add(
      edge.from,
    )

    proofs.push({
      route,
      owner:
        edge.from,

      owner_file:
        ownerFile,

      witness_file:
        witnessFile,

      witness_line:
        edge?.witness?.line ??
        null,

      kind:
        edge.kind,
    })
  }

  const ownerCandidates =
    [...owners].sort()

  if (ownerCandidates.length < 1) {
    return baseResult({
      status:
        "unresolved",

      reason:
        "validated_route_owner_not_found",

      routeAnchors,
      routeAnchor:
        route,

      candidateFiles:
        candidates,

      searchComplete,
      searchTruncated,
      inspectionTruncated,

      ownerCandidates,
      proofs,
    })
  }

  if (ownerCandidates.length > 1) {
    return baseResult({
      status:
        "ambiguous",

      reason:
        "competing_validated_route_owners",

      routeAnchors,
      routeAnchor:
        route,

      candidateFiles:
        candidates,

      searchComplete,
      searchTruncated,
      inspectionTruncated,

      ownerCandidates,
      proofs,
    })
  }

  const owner =
    ownerCandidates[0]

  return baseResult({
    status:
      "bound",

    reason:
      "unique_exact_route_owner",

    routeAnchors,
    routeAnchor:
      route,

    candidateFiles:
      candidates,

    searchComplete,
    searchTruncated,
    inspectionTruncated,

    owner,

    ownerFile:
      ownerFileFromNode(
        owner,
      ),

    ownerCandidates,
    proofs,
  })
}
