import { createHash } from "node:crypto"

export const FRAMEWORK_ADAPTER_PROTOCOL = "framework-adapter-v1"
export const FRAMEWORK_WITNESS_PROTOCOL = "framework-witness-v1"
export const FRAMEWORK_EDGE_PROTOCOL = "framework-edge-candidate-v1"

export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex")
}

export function lineForIndex(text, index) {
  return text.slice(0, Math.max(0, index)).split("\n").length
}

export function regexMatches(pattern, text) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`

  return [...String(text).matchAll(new RegExp(pattern.source, flags))]
}

export function makeWitness({
  adapter,
  framework,
  kind,
  sourcePath,
  text,
  index,
  target = null,
  detail = null,
}) {
  const sourceSha256 = sha256Text(text)
  const line = lineForIndex(text, index)

  return Object.freeze({
    protocol: FRAMEWORK_WITNESS_PROTOCOL,
    adapter,
    framework,
    kind,
    source_path: sourcePath,
    source_sha256: sourceSha256,
    line,
    target,
    detail,
    confidence: "structural_literal",
  })
}

export function makeEdgeCandidate({
  adapter,
  framework,
  kind,
  sourcePath,
  witness,
  from,
  to,
}) {
  if (!witness || witness.source_path !== sourcePath) {
    throw new Error("edge witness/source mismatch")
  }

  return Object.freeze({
    protocol: FRAMEWORK_EDGE_PROTOCOL,
    adapter,
    framework,
    kind,
    source_path: sourcePath,
    source_sha256: witness.source_sha256,
    witness_line: witness.line,
    witness_kind: witness.kind,
    from,
    to,
    confidence: "structural_literal",
    mutation_authority: false,
  })
}

function witnessKey(item) {
  return [
    item.framework,
    item.kind,
    item.source_path,
    item.line,
    item.target ?? "",
  ].join("\0")
}

function edgeKey(item) {
  return [
    item.framework,
    item.kind,
    item.source_path,
    item.witness_line,
    item.from?.id ?? "",
    item.to?.id ?? "",
  ].join("\0")
}

export function runFrameworkAdapters({
  sourcePath,
  text,
  adapters,
  maxWitnesses = 64,
  maxEdges = 64,
  edgeCandidateFilter = null,
  truncateOnWitnesses = true,
}) {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length < 1 ||
    typeof text !== "string" ||
    !Array.isArray(adapters)
  ) {
    throw new Error("invalid framework adapter input")
  }

  if (
    edgeCandidateFilter !== null &&
    typeof edgeCandidateFilter !== "function"
  ) {
    throw new Error(
      "invalid framework edge candidate filter",
    )
  }

  const witnesses = []
  const edgeCandidates = []
  const frameworks = []

  for (const adapter of adapters) {
    if (
      !adapter ||
      typeof adapter.id !== "string" ||
      typeof adapter.detect !== "function" ||
      typeof adapter.inspect !== "function"
    ) {
      throw new Error("invalid framework adapter")
    }

    const detection = adapter.detect({ sourcePath, text })

    if (!detection?.matched) {
      continue
    }

    frameworks.push(adapter.framework)

    const result = adapter.inspect({
      sourcePath,
      text,
      maxWitnesses,
      maxEdges,
    })

    for (const witness of result?.witnesses ?? []) {
      witnesses.push(witness)
    }

    for (const edge of result?.edge_candidates ?? []) {
      edgeCandidates.push(edge)
    }
  }

  const uniqueWitnesses = [
    ...new Map(
      witnesses
        .sort((a, b) => witnessKey(a).localeCompare(witnessKey(b)))
        .map((item) => [witnessKey(item), item]),
    ).values(),
  ].slice(0, maxWitnesses)

  const relevantEdgeCandidates =
    edgeCandidateFilter
      ? edgeCandidates.filter(
          edgeCandidateFilter,
        )
      : edgeCandidates

  const uniqueEdges = [
    ...new Map(
      relevantEdgeCandidates
        .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))
        .map((item) => [edgeKey(item), item]),
    ).values(),
  ].slice(0, maxEdges)

  return Object.freeze({
    protocol: FRAMEWORK_ADAPTER_PROTOCOL,
    source_path: sourcePath,
    source_sha256: sha256Text(text),
    frameworks: [...new Set(frameworks)].sort(),
    witnesses: uniqueWitnesses,
    edge_candidates: uniqueEdges,
    truncated:
      (
        truncateOnWitnesses === true &&
        witnesses.length > maxWitnesses
      ) ||
      relevantEdgeCandidates.length > maxEdges,
  })
}
