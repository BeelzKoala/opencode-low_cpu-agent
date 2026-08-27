import {
  runFrameworkAdapters,
  sha256Text,
} from "./framework-adapter-v1.mjs"

import {
  flaskJinjaAdapter,
} from "./flask-jinja-adapter-v1.mjs"

import {
  fastapiPydanticAdapter,
} from "./fastapi-pydantic-adapter-v1.mjs"

import {
  djangoOrmAdapter,
} from "./django-orm-adapter-v1.mjs"

import {
  typescriptWebAdapter,
} from "./typescript-web-adapter-v1.mjs"

import {
  RESOURCE_EDGE_KIND,
  normalizeValidatedResourceEdge,
} from "./resource-graph-v1.mjs"

export const FRAMEWORK_RESOURCE_BRIDGE_PROTOCOL =
  "framework-resource-bridge-v1"

const ADAPTERS = Object.freeze([
  flaskJinjaAdapter,
  fastapiPydanticAdapter,
  djangoOrmAdapter,
  typescriptWebAdapter,
])

const EDGE_KIND_MAP = Object.freeze({
  DECLARES_ROUTE:
    RESOURCE_EDGE_KIND.DECLARES_ROUTE,

  RENDERS_TEMPLATE:
    RESOURCE_EDGE_KIND.RENDERS_RESOURCE,

  INCLUDES_TEMPLATE:
    RESOURCE_EDGE_KIND.INCLUDES_RESOURCE,

  EXTENDS_TEMPLATE:
    RESOURCE_EDGE_KIND.EXTENDS_RESOURCE,

  URL_FOR_ROUTE:
    RESOURCE_EDGE_KIND.TARGETS_ROUTE,

  DEFINES_SCHEMA:
    RESOURCE_EDGE_KIND.DEFINES,

  USES_SCHEMA:
    RESOURCE_EDGE_KIND.USES_SCHEMA,

  DEFINES_MODEL:
    RESOURCE_EDGE_KIND.DEFINES,

  READS_MODEL:
    RESOURCE_EDGE_KIND.READS_DATA_RESOURCE,

  WRITES_MODEL:
    RESOURCE_EDGE_KIND.WRITES_DATA_RESOURCE,
})

const NODE_PREFIX = Object.freeze({
  FILE: "file",
  SYMBOL: "symbol",
  ROUTE: "route",
  TEMPLATE: "template",
  SCHEMA: "schema",
  DATA_MODEL: "data_model",
  COMPONENT: "component",
})

function nodeID(node) {
  if (
    !node ||
    typeof node.kind !== "string" ||
    typeof node.id !== "string" ||
    node.id.length < 1
  ) {
    return null
  }

  const prefix = NODE_PREFIX[node.kind]

  if (!prefix) {
    return null
  }

  return `${prefix}:${node.id}`
}

function edgeKey(edge) {
  return [
    edge.kind,
    edge.from,
    edge.to,
    edge.witness.file,
    edge.witness.line,
  ].join("\0")
}

/*
 * Source validation here is deliberately narrow:
 *
 * - adapter operated on this exact source text;
 * - source SHA must match candidate SHA;
 * - adapter only emitted statically literal forms;
 * - witness points to a concrete physical source line.
 *
 * This proves the structural relation represented by the adapter.
 * It does NOT prove task relevance or mutation authority.
 */
export function inspectFrameworkResourceFile({
  sourcePath,
  text,
  maxWitnesses = 64,
  maxEdges = 64,
  routeTargets = null,
  includeTargets = null,
} = {}) {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length < 1 ||
    typeof text !== "string"
  ) {
    throw new Error("invalid framework resource input")
  }

  const sourceSha256 = sha256Text(text)

  const routeTargetSet =
    Array.isArray(routeTargets)
      ? new Set(
          routeTargets.filter(
            (value) =>
              typeof value === "string" &&
              value.startsWith("/"),
          ),
        )
      : null

  const includeTargetSet =
    Array.isArray(includeTargets)
      ? new Set(
          includeTargets
            .filter(
              (value) =>
                typeof value === "string" &&
                value.length > 0,
            )
            .map(
              (value) =>
                value.startsWith(
                  "template:",
                )
                  ? value.slice(
                      "template:".length,
                    )
                  : value,
            ),
        )
      : null

  const routeScoped =
    routeTargetSet instanceof Set

  const includeScoped =
    includeTargetSet instanceof Set

  const relationScoped =
    routeScoped ||
    includeScoped

  const edgeCandidateFilter =
    relationScoped
      ? (candidate) => {
          if (
            routeScoped &&
            candidate?.kind ===
              "DECLARES_ROUTE"
          ) {
            const routeID =
              candidate?.to?.id

            if (
              typeof routeID !== "string"
            ) {
              return false
            }

            if (
              routeTargetSet.has(
                routeID,
              )
            ) {
              return true
            }

            /*
             * Some adapters encode method-qualified routes:
             *   GET /path
             */
            const firstSpace =
              routeID.indexOf(" ")

            return (
              firstSpace > 0 &&
              routeTargetSet.has(
                routeID.slice(
                  firstSpace + 1,
                ),
              )
            )
          }

          if (
            includeScoped &&
            candidate?.kind ===
              "INCLUDES_TEMPLATE"
          ) {
            const resourceID =
              candidate?.to?.id

            return (
              typeof resourceID ===
                "string" &&
              includeTargetSet.has(
                resourceID.startsWith(
                  "template:",
                )
                  ? resourceID.slice(
                      "template:".length,
                    )
                  : resourceID,
              )
            )
          }

          return false
        }
      : null

  const inspected = runFrameworkAdapters({
    sourcePath,
    text,
    adapters: ADAPTERS,

    /*
     * Relation-scoped proof ignores unrelated framework
     * witnesses/edges. Only the requested validated relation
     * participates in bounded completeness.
     */
    maxWitnesses:
      relationScoped
        ? 0
        : maxWitnesses,

    maxEdges,

    edgeCandidateFilter,

    truncateOnWitnesses:
      !relationScoped,
  })

  const resourceEdges = []
  const rejected = []

  for (const candidate of inspected.edge_candidates) {
    const graphKind =
      EDGE_KIND_MAP[candidate.kind]

    const from = nodeID(candidate.from)
    const to = nodeID(candidate.to)

    if (
      !graphKind ||
      !from ||
      !to ||
      candidate.mutation_authority !== false ||
      candidate.source_path !== sourcePath ||
      candidate.source_sha256 !== sourceSha256
    ) {
      rejected.push({
        kind: candidate.kind ?? null,
        reason: "bridge_contract_rejected",
      })
      continue
    }

    const edge = normalizeValidatedResourceEdge({
      validated: true,
      from,
      to,
      kind: graphKind,

      // This is structural-literal proof, not a probabilistic score.
      confidence: 1,

      witness: {
        file: sourcePath,
        sha256: sourceSha256,
        line: candidate.witness_line,
        extractor: candidate.adapter,
      },
    })

    if (!edge) {
      rejected.push({
        kind: candidate.kind ?? null,
        reason: "resource_graph_contract_rejected",
      })
      continue
    }

    resourceEdges.push(edge)
  }

  const uniqueEdges = [
    ...new Map(
      resourceEdges
        .sort((a, b) =>
          edgeKey(a).localeCompare(edgeKey(b)),
        )
        .map((edge) => [edgeKey(edge), edge]),
    ).values(),
  ]

  return Object.freeze({
    protocol:
      FRAMEWORK_RESOURCE_BRIDGE_PROTOCOL,

    authority:
      "routing_only",

    mutation_authority:
      false,

    source_path:
      sourcePath,

    source_sha256:
      sourceSha256,

    frameworks:
      inspected.frameworks,

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
