import {
  runResourceAdapters,
  resourceSha256,
} from "./resource-adapter-v1.mjs"

import {
  genericHtmlJsAdapter,
} from "./generic-html-js-adapter-v1.mjs"

import {
  reactJsxRouterAdapter,
} from "./react-jsx-router-adapter-v1.mjs"

import {
  vueSfcAdapter,
} from "./vue-sfc-adapter-v1.mjs"

import {
  sqlResourceAdapter,
} from "./sql-resource-adapter-v1.mjs"

import {
  RESOURCE_EDGE_KIND,
  normalizeValidatedResourceEdge,
} from "./resource-graph-v1.mjs"

export const RESOURCE_ADAPTER_BRIDGE_PROTOCOL =
  "resource-adapter-bridge-v1"

const ADAPTERS = Object.freeze([
  genericHtmlJsAdapter,
  reactJsxRouterAdapter,
  vueSfcAdapter,
  sqlResourceAdapter,
])

const EDGE_KIND_MAP = Object.freeze({
  TARGETS_ROUTE:
    RESOURCE_EDGE_KIND.TARGETS_ROUTE,

  FETCHES_ROUTE:
    RESOURCE_EDGE_KIND.FETCHES_ROUTE,

  DECLARES_ROUTE:
    RESOURCE_EDGE_KIND.DECLARES_ROUTE,

  ROUTE_TO_COMPONENT:
    RESOURCE_EDGE_KIND.ROUTE_TO_COMPONENT,

  READS_DATA_RESOURCE:
    RESOURCE_EDGE_KIND.READS_DATA_RESOURCE,

  WRITES_DATA_RESOURCE:
    RESOURCE_EDGE_KIND.WRITES_DATA_RESOURCE,
})

const NODE_PREFIX = Object.freeze({
  FILE: "file",
  ROUTE: "route",
  COMPONENT: "component",
  DATA_RESOURCE: "data_resource",
})

function nodeID(value) {
  if (
    !value ||
    typeof value.kind !== "string" ||
    typeof value.id !== "string" ||
    value.id.length < 1
  ) {
    return null
  }

  const prefix =
    NODE_PREFIX[value.kind]

  if (!prefix) {
    return null
  }

  return `${prefix}:${value.id}`
}

function edgeKey(edge) {
  return [
    edge.kind,
    edge.from,
    edge.to,
    edge.witness.file,
    edge.witness.line,
    edge.witness.sha256,
  ].join("\0")
}

export function inspectResourceAdapterFile({
  sourcePath,
  text,
  maxWitnesses = 64,
  maxEdges = 64,
} = {}) {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length < 1 ||
    typeof text !== "string"
  ) {
    throw new Error(
      "invalid resource adapter bridge input",
    )
  }

  const sourceSha256 =
    resourceSha256(text)

  const inspected =
    runResourceAdapters({
      sourcePath,
      text,
      adapters: ADAPTERS,
      maxWitnesses,
      maxEdges,
    })

  const resourceEdges = []
  const rejected = []

  for (
    const candidate of
    inspected.edge_candidates
  ) {
    const kind =
      EDGE_KIND_MAP[candidate.kind]

    const from =
      nodeID(candidate.from)

    const to =
      nodeID(candidate.to)

    if (
      !kind ||
      !from ||
      !to ||
      candidate.validated !== true ||
      candidate.mutation_authority !== false ||
      candidate.source_path !== sourcePath ||
      candidate.source_sha256 !== sourceSha256
    ) {
      rejected.push({
        kind:
          candidate.kind ?? null,
        reason:
          "bridge_contract_rejected",
      })
      continue
    }

    const edge =
      normalizeValidatedResourceEdge({
        validated: true,

        from,
        to,
        kind,

        confidence: 1,

        witness: {
          file:
            sourcePath,

          sha256:
            sourceSha256,

          line:
            candidate.witness_line,

          extractor:
            candidate.adapter,
        },
      })

    if (!edge) {
      rejected.push({
        kind:
          candidate.kind ?? null,
        reason:
          "resource_graph_contract_rejected",
      })
      continue
    }

    resourceEdges.push(edge)
  }

  const uniqueEdges = [
    ...new Map(
      resourceEdges
        .sort((a, b) =>
          edgeKey(a).localeCompare(
            edgeKey(b),
          ),
        )
        .map((edge) => [
          edgeKey(edge),
          edge,
        ]),
    ).values(),
  ]

  return Object.freeze({
    protocol:
      RESOURCE_ADAPTER_BRIDGE_PROTOCOL,

    authority:
      "routing_only",

    mutation_authority:
      false,

    source_path:
      sourcePath,

    source_sha256:
      sourceSha256,

    families:
      inspected.families,

    witnesses:
      inspected.witnesses,

    edge_candidates:
      inspected.edge_candidates,

    resource_edges:
      uniqueEdges,

    rejected_edge_candidates:
      rejected,

    truncated:
      inspected.truncated,
  })
}
