import { createHash } from "node:crypto"

export const RESOURCE_ADAPTER_PROTOCOL =
  "resource-adapter-v1"

export const RESOURCE_WITNESS_PROTOCOL =
  "resource-witness-v1"

export const RESOURCE_EDGE_CANDIDATE_PROTOCOL =
  "resource-edge-candidate-v1"

export function resourceSha256(text) {
  return createHash("sha256")
    .update(String(text), "utf8")
    .digest("hex")
}

export function resourceLineForIndex(text, index) {
  return String(text)
    .slice(0, Math.max(0, index))
    .split("\n").length
}

export function resourceRegexMatches(pattern, text) {
  const flags =
    pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`

  return [
    ...String(text).matchAll(
      new RegExp(pattern.source, flags),
    ),
  ]
}

export function makeResourceWitness({
  adapter,
  family,
  kind,
  sourcePath,
  text,
  index,
  target = null,
  detail = null,
  validated = true,
  validation = "source_literal",
}) {
  return Object.freeze({
    protocol: RESOURCE_WITNESS_PROTOCOL,

    adapter,
    family,
    kind,

    source_path: sourcePath,
    source_sha256: resourceSha256(text),
    line: resourceLineForIndex(text, index),

    target,
    detail,

    validated:
      validated === true,

    validation,
  })
}

export function makeResourceEdgeCandidate({
  adapter,
  family,
  kind,
  sourcePath,
  witness,
  from,
  to,
}) {
  if (
    !witness ||
    witness.source_path !== sourcePath
  ) {
    throw new Error(
      "resource edge witness/source mismatch",
    )
  }

  return Object.freeze({
    protocol:
      RESOURCE_EDGE_CANDIDATE_PROTOCOL,

    adapter,
    family,
    kind,

    source_path: sourcePath,
    source_sha256:
      witness.source_sha256,

    witness_line:
      witness.line,

    witness_kind:
      witness.kind,

    validated:
      witness.validated === true,

    validation:
      witness.validation,

    from,
    to,

    // Adapters never own mutation authority.
    mutation_authority: false,
  })
}

function witnessKey(item) {
  return [
    item.adapter,
    item.kind,
    item.source_path,
    item.line,
    item.target ?? "",
  ].join("\0")
}

function edgeKey(item) {
  return [
    item.adapter,
    item.kind,
    item.source_path,
    item.witness_line,
    item.from?.kind ?? "",
    item.from?.id ?? "",
    item.to?.kind ?? "",
    item.to?.id ?? "",
  ].join("\0")
}

export function runResourceAdapters({
  sourcePath,
  text,
  adapters,
  maxWitnesses = 64,
  maxEdges = 64,
}) {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length < 1 ||
    typeof text !== "string" ||
    !Array.isArray(adapters)
  ) {
    throw new Error(
      "invalid resource adapter input",
    )
  }

  const witnesses = []
  const edges = []
  const families = []

  for (const adapter of adapters) {
    if (
      !adapter ||
      typeof adapter.id !== "string" ||
      typeof adapter.detect !== "function" ||
      typeof adapter.inspect !== "function"
    ) {
      throw new Error(
        "invalid resource adapter",
      )
    }

    const detection =
      adapter.detect({
        sourcePath,
        text,
      })

    if (!detection?.matched) {
      continue
    }

    families.push(adapter.family)

    const result =
      adapter.inspect({
        sourcePath,
        text,
        maxWitnesses,
        maxEdges,
      })

    witnesses.push(
      ...(result?.witnesses ?? []),
    )

    edges.push(
      ...(result?.edge_candidates ?? []),
    )
  }

  const uniqueWitnesses = [
    ...new Map(
      witnesses
        .sort((a, b) =>
          witnessKey(a).localeCompare(
            witnessKey(b),
          ),
        )
        .map((item) => [
          witnessKey(item),
          item,
        ]),
    ).values(),
  ].slice(0, maxWitnesses)

  const uniqueEdges = [
    ...new Map(
      edges
        .sort((a, b) =>
          edgeKey(a).localeCompare(
            edgeKey(b),
          ),
        )
        .map((item) => [
          edgeKey(item),
          item,
        ]),
    ).values(),
  ].slice(0, maxEdges)

  return Object.freeze({
    protocol:
      RESOURCE_ADAPTER_PROTOCOL,

    authority:
      "routing_only",

    mutation_authority:
      false,

    source_path:
      sourcePath,

    source_sha256:
      resourceSha256(text),

    families:
      [...new Set(families)].sort(),

    witnesses:
      uniqueWitnesses,

    edge_candidates:
      uniqueEdges,

    truncated:
      witnesses.length > maxWitnesses ||
      edges.length > maxEdges,
  })
}
