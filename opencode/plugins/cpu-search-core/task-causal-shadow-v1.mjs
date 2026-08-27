import {
  boundedTaskCausalClosure,
} from "./resource-graph-v1.mjs"

export const TASK_CAUSAL_SHADOW_PROTOCOL =
  "task-causal-shadow-v1"

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

function graphNodes(edges) {
  const nodes =
    new Set()

  for (const edge of edges) {
    if (
      typeof edge?.from ===
        "string" &&
      edge.from.length > 0
    ) {
      nodes.add(edge.from)
    }

    if (
      typeof edge?.to ===
        "string" &&
      edge.to.length > 0
    ) {
      nodes.add(edge.to)
    }
  }

  return nodes
}

function routeCandidates(
  anchor,
  nodes,
) {
  const wanted =
    anchor.value

  const matches = []

  for (const node of nodes) {
    if (
      node ===
      `route:${wanted}`
    ) {
      matches.push(node)
      continue
    }

    if (
      !node.startsWith(
        "route:",
      )
    ) {
      continue
    }

    const raw =
      node.slice(
        "route:".length,
      )

    const firstSpace =
      raw.indexOf(" ")

    if (firstSpace < 1) {
      continue
    }

    const method =
      raw
        .slice(
          0,
          firstSpace,
        )
        .toUpperCase()

    const route =
      raw.slice(
        firstSpace + 1,
      )

    if (
      HTTP_METHODS.has(method) &&
      route === wanted
    ) {
      matches.push(node)
    }
  }

  return [
    ...new Set(matches),
  ].sort()
}

function identifierCandidates(
  anchor,
  nodes,
) {
  const prefixes = [
    "data_resource:",
    "schema:",
    "data_model:",
    "symbol:",
  ]

  const full =
    []

  for (const prefix of prefixes) {
    const node =
      `${prefix}${anchor.value}`

    if (nodes.has(node)) {
      full.push(node)
    }
  }

  if (full.length > 0) {
    return full.sort()
  }

  if (
    anchor.kind !==
      "qualified_identifier"
  ) {
    return []
  }

  const tail =
    anchor.value
      .split(".")
      .at(-1)

  if (
    !tail ||
    tail === anchor.value
  ) {
    return []
  }

  const tailMatches = []

  for (const prefix of prefixes) {
    const node =
      `${prefix}${tail}`

    if (nodes.has(node)) {
      tailMatches.push(node)
    }
  }

  return tailMatches.sort()
}

function candidatesForAnchor(
  anchor,
  nodes,
) {
  if (
    anchor.kind ===
    "route_literal"
  ) {
    return routeCandidates(
      anchor,
      nodes,
    )
  }

  if (
    anchor.kind ===
      "identifier" ||
    anchor.kind ===
      "qualified_identifier"
  ) {
    return identifierCandidates(
      anchor,
      nodes,
    )
  }

  /*
   * artifact_extension and future observational anchors
   * intentionally cannot become graph seeds here.
   */
  return []
}

export function runTaskCausalShadow({
  taskAnchors,
  edges = [],
  maxHops = 3,
  maxNodes = 48,
  maxEdges = 96,
} = {}) {
  if (
    taskAnchors?.status !==
      "compiled"
  ) {
    return Object.freeze({
      protocol:
        TASK_CAUSAL_SHADOW_PROTOCOL,

      authority:
        "shadow_observation",

      localization_authority:
        false,

      mutation_authority:
        false,

      status:
        "unresolved",

      seed_count: 0,

      bound_anchors: [],
      unbound_anchors: [],
      ambiguous_anchors: [],

      closure: null,

      reason:
        "task_anchors_unresolved",
    })
  }

  const safeEdges =
    Array.isArray(edges)
      ? edges.slice(
          0,
          maxEdges,
        )
      : []

  const nodes =
    graphNodes(safeEdges)

  const bound = []
  const unbound = []
  const ambiguous = []

  for (
    const anchor of
    taskAnchors.anchors ?? []
  ) {
    const candidates =
      candidatesForAnchor(
        anchor,
        nodes,
      )

    if (
      anchor.kind ===
      "artifact_extension"
    ) {
      unbound.push({
        kind:
          anchor.kind,

        value:
          anchor.value,

        reason:
          "non_graph_anchor",
      })
      continue
    }

    if (
      candidates.length === 0
    ) {
      unbound.push({
        kind:
          anchor.kind,

        value:
          anchor.value,

        reason:
          "graph_node_not_observed",
      })
      continue
    }

    if (
      candidates.length > 1
    ) {
      ambiguous.push({
        kind:
          anchor.kind,

        value:
          anchor.value,

        candidates:
          candidates.slice(
            0,
            8,
          ),
      })
      continue
    }

    bound.push({
      kind:
        anchor.kind,

      value:
        anchor.value,

      node:
        candidates[0],
    })
  }

  const seedNodes =
    [
      ...new Set(
        bound.map(
          (item) =>
            item.node,
        ),
      ),
    ].sort()

  const seeds =
    seedNodes.map(
      (id) => ({
        id,
        score: 1,
        task_causal: true,
      }),
    )

  const closure =
    seeds.length > 0
      ? boundedTaskCausalClosure({
          seeds,
          edges:
            safeEdges,

          maxHops:
            Math.min(
              3,
              Math.max(
                0,
                maxHops,
              ),
            ),

          maxNodes:
            Math.min(
              64,
              Math.max(
                1,
                maxNodes,
              ),
            ),

          maxEdges:
            Math.min(
              128,
              Math.max(
                1,
                maxEdges,
              ),
            ),
        })
      : null

  return Object.freeze({
    protocol:
      TASK_CAUSAL_SHADOW_PROTOCOL,

    authority:
      "shadow_observation",

    /*
     * Critical boundary:
     * observing a causal-looking path is NOT yet role evidence.
     */
    localization_authority:
      false,

    mutation_authority:
      false,

    status:
      "observed",

    task_sha256:
      taskAnchors.task_sha256,

    seed_count:
      seeds.length,

    bound_anchors:
      bound,

    unbound_anchors:
      unbound,

    ambiguous_anchors:
      ambiguous,

    closure,

    reason:
      "shadow_only",
  })
}
