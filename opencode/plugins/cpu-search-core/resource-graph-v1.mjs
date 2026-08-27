
export const RESOURCE_GRAPH_PROTOCOL =
  "resource-graph-v1"

export const RESOURCE_GRAPH_AUTHORITY =
  "routing_task_causal_only"

export const RESOURCE_NODE_KIND = Object.freeze({
  FILE: "file",
  SYMBOL: "symbol",
  ROUTE: "route",
  TEMPLATE: "template",
  SCHEMA: "schema",
  DATA_MODEL: "data_model",
  COMPONENT: "component",
  RESOURCE: "resource",
  DATA_RESOURCE: "data_resource",
  TEST: "test",
  CONFIG: "config",
})

export const RESOURCE_EDGE_KIND = Object.freeze({
  DEFINES: "defines",
  IMPORTS: "imports",
  CALLS: "calls",

  DECLARES_ROUTE: "declares_route",
  RENDERS_RESOURCE: "renders_resource",
  INCLUDES_RESOURCE: "includes_resource",
  EXTENDS_RESOURCE: "extends_resource",
  TARGETS_ROUTE: "targets_route",
  FETCHES_ROUTE: "fetches_route",
  ROUTE_TO_COMPONENT: "route_to_component",
  USES_SCHEMA: "uses_schema",

  READS_DATA_RESOURCE: "reads_data_resource",
  WRITES_DATA_RESOURCE: "writes_data_resource",

  REGISTERED_BY: "registered_by",
  TESTS: "tests",
})

const EDGE_KINDS =
  new Set(Object.values(RESOURCE_EDGE_KIND))

function validNodeID(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512
}

function validSha256(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{64}$/iu.test(value)
}

function validWitness(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    value.file.length <= 1024 &&
    validSha256(value.sha256) &&
    Number.isSafeInteger(value.line) &&
    value.line >= 1 &&
    typeof value.extractor === "string" &&
    value.extractor.length > 0 &&
    value.extractor.length <= 128
  )
}

/*
 * This function does NOT promote a hypothesis to validated evidence.
 * `validated:true` must already come from a source validator.
 * It only checks the proof-carrying edge ABI.
 */
export function normalizeValidatedResourceEdge(value) {
  if (
    !value ||
    value.validated !== true ||
    !validNodeID(value.from) ||
    !validNodeID(value.to) ||
    value.from === value.to ||
    !EDGE_KINDS.has(value.kind) ||
    !Number.isFinite(value.confidence) ||
    value.confidence <= 0 ||
    value.confidence > 1 ||
    !validWitness(value.witness)
  ) {
    return null
  }

  return {
    protocol: RESOURCE_GRAPH_PROTOCOL,
    authority: "validated_relation_only",

    from: value.from,
    to: value.to,
    kind: value.kind,

    confidence: value.confidence,
    validated: true,

    witness: {
      file: value.witness.file,
      sha256: value.witness.sha256.toLowerCase(),
      line: value.witness.line,
      extractor: value.witness.extractor,
    },
  }
}

function normalizedSeeds(seeds, maxNodes) {
  const out = []

  for (const seed of Array.isArray(seeds) ? seeds : []) {
    if (
      !seed ||
      seed.task_causal !== true ||
      !validNodeID(seed.id)
    ) {
      continue
    }

    const score =
      Number.isFinite(seed.score) &&
      seed.score > 0 &&
      seed.score <= 1
        ? seed.score
        : 1

    out.push({
      id: seed.id,
      score,
      hops: 0,
      path: [seed.id],
      edge_path: [],
      witnesses: [],
      task_causal: true,
    })
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.id.localeCompare(b.id),
  )

  const unique = []
  const seen = new Set()

  for (const item of out) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    unique.push(item)
    if (unique.length >= maxNodes) break
  }

  return unique
}

function pathKey(record) {
  return record.path.join("\u0000")
}

function better(candidate, previous) {
  if (!previous) return true

  const delta = candidate.score - previous.score

  if (Math.abs(delta) > 1e-12) {
    return delta > 0
  }

  if (candidate.hops !== previous.hops) {
    return candidate.hops < previous.hops
  }

  return pathKey(candidate) < pathKey(previous)
}

function queueSort(a, b) {
  return (
    b.score - a.score ||
    a.hops - b.hops ||
    a.id.localeCompare(b.id) ||
    pathKey(a).localeCompare(pathKey(b))
  )
}

/*
 * Bounded best-first task-causal propagation.
 *
 * Score is best-path multiplication:
 *
 *   child = parent * edge_confidence
 *
 * Parallel paths are NEVER summed. This prevents hub amplification.
 */
export function boundedTaskCausalClosure({
  seeds = [],
  edges = [],
  maxHops = 3,
  maxNodes = 64,
  maxEdges = 128,
} = {}) {
  const hopLimit =
    Number.isSafeInteger(maxHops) && maxHops >= 0
      ? maxHops
      : 3

  const nodeLimit =
    Number.isSafeInteger(maxNodes) && maxNodes > 0
      ? maxNodes
      : 64

  const edgeLimit =
    Number.isSafeInteger(maxEdges) && maxEdges > 0
      ? maxEdges
      : 128

  const rawEdges =
    Array.isArray(edges) ? edges : []

  const validatedEdges =
    rawEdges
      .map(normalizeValidatedResourceEdge)
      .filter(Boolean)

  validatedEdges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      b.confidence - a.confidence ||
      a.kind.localeCompare(b.kind) ||
      a.to.localeCompare(b.to) ||
      a.witness.file.localeCompare(b.witness.file) ||
      a.witness.line - b.witness.line,
  )

  const adjacency = new Map()

  for (const edge of validatedEdges) {
    let list = adjacency.get(edge.from)

    if (!list) {
      list = []
      adjacency.set(edge.from, list)
    }

    list.push(edge)
  }

  const seedRecords =
    normalizedSeeds(seeds, nodeLimit)

  const best = new Map()
  const queue = []

  for (const seed of seedRecords) {
    best.set(seed.id, seed)
    queue.push(seed)
  }

  let edgesConsidered = 0
  let truncated = seedRecords.length < (
    Array.isArray(seeds) ? seeds.length : 0
  )

  outer:
  while (queue.length > 0) {
    queue.sort(queueSort)
    const current = queue.shift()

    const authoritative = best.get(current.id)

    if (
      !authoritative ||
      authoritative.score !== current.score ||
      authoritative.hops !== current.hops ||
      pathKey(authoritative) !== pathKey(current)
    ) {
      continue
    }

    if (current.hops >= hopLimit) continue

    for (const edge of adjacency.get(current.id) ?? []) {
      if (edgesConsidered >= edgeLimit) {
        truncated = true
        break outer
      }

      edgesConsidered += 1

      if (current.path.includes(edge.to)) {
        continue
      }

      const candidate = {
        id: edge.to,
        score: current.score * edge.confidence,
        hops: current.hops + 1,

        path: [
          ...current.path,
          edge.to,
        ],

        edge_path: [
          ...current.edge_path,
          {
            from: edge.from,
            to: edge.to,
            kind: edge.kind,
            confidence: edge.confidence,
          },
        ],

        witnesses: [
          ...current.witnesses,
          edge.witness,
        ],

        task_causal: true,
      }

      const previous = best.get(candidate.id)

      if (!better(candidate, previous)) {
        continue
      }

      if (!previous && best.size >= nodeLimit) {
        truncated = true
        continue
      }

      best.set(candidate.id, candidate)
      queue.push(candidate)
    }
  }

  const nodes =
    [...best.values()].sort(queueSort)

  return {
    protocol: RESOURCE_GRAPH_PROTOCOL,
    authority: RESOURCE_GRAPH_AUTHORITY,

    routing_only: true,
    task_causal: true,

    max_hops: hopLimit,
    max_nodes: nodeLimit,
    max_edges: edgeLimit,

    seed_count: seedRecords.length,
    validated_edges: validatedEdges.length,
    invalid_edges_ignored:
      rawEdges.length - validatedEdges.length,

    edges_considered: edgesConsidered,
    truncated,

    nodes,
  }
}
