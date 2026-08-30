import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  RUNTIME_COST_REDUCER_PROTOCOL,
  loadArtifactDirectory,
} from "./runtime-cost-reducer-v2.mjs"

export const RUNTIME_COST_PROFILE_PROTOCOL = "runtime-cost-profile-v1"
export const RUNTIME_COST_PROFILE_AUTHORITY = "shadow_observation"
export const RUNTIME_COST_BACKFILL_PROTOCOL = "runtime-cost-backfill-v1"

const REQUIRED_IDENTITY_FIELDS = Object.freeze([
  "providerID",
  "modelID",
  "phase",
  "frontier_sha256",
  "agent_protocol",
  "tool_frontier_protocol",
  "mutation_tool_abi_protocol",
])

const DEFAULT_BACKFILL_NAME = "runtime-cost-backfill.json"
const DEFAULT_PROFILE_NAME = "runtime-cost-profile-v1.json"
const MAX_BACKFILL_BYTES = 4 * 1024 * 1024
const MAX_ARTIFACTS = 1024

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function boundedString(value, max = 512) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= max ? trimmed : null
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex")
}

function nearestRank(values, q) {
  if (values.length < 1) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil(q * sorted.length)))
  return sorted[rank - 1]
}

function median(values) {
  if (values.length < 1) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function sortedObject(input) {
  const out = {}
  for (const key of Object.keys(input ?? {}).sort()) {
    out[key] = input[key]
  }
  return out
}

export function normalizeRuntimeCostIdentity(value) {
  const source = value && typeof value === "object" ? value : {}
  const identity = {
    providerID: boundedString(source.providerID, 128),
    modelID: boundedString(source.modelID, 128),
    phase: boundedString(source.phase ?? source.execution_state, 64),
    frontier_sha256: boundedString(
      source.frontier_sha256 ?? source.tool_frontier_schema_sha256,
      128,
    ),
    agent_protocol: boundedString(source.agent_protocol, 128),
    tool_frontier_protocol: boundedString(source.tool_frontier_protocol, 128),
    mutation_tool_abi_protocol:
      boundedString(source.mutation_tool_abi_protocol, 128),
  }

  const missing = REQUIRED_IDENTITY_FIELDS.filter(
    (field) => !identity[field],
  )
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      reason: "identity_incomplete",
      missing,
      identity,
    })
  }

  return Object.freeze({
    ok: true,
    reason: "identity_complete",
    identity: Object.freeze(identity),
    identity_sha256: sha256Canonical(identity),
  })
}

function normalizedEvidenceRow(row) {
  const identity = normalizeRuntimeCostIdentity(row)
  if (!identity.ok) {
    return {
      ok: false,
      reason: identity.reason,
      missing: identity.missing,
    }
  }

  const actionable = finiteNonNegative(row.dispatch_to_actionable_boundary_ms)
  const censoredLowerBound = row.censored === true
    ? finiteNonNegative(row.elapsed_lower_bound_ms)
    : null
  const contextBytes = finiteNonNegative(row.context_bytes)
  const status = boundedString(row.status, 128)
  const outcome = boundedString(row.outcome, 128)

  if (actionable === null && censoredLowerBound === null && status !== "open_unresolved") {
    return {
      ok: false,
      reason: "observation_boundary_unusable",
      identity: identity.identity,
    }
  }

  return {
    ok: true,
    identity: identity.identity,
    identity_sha256: identity.identity_sha256,
    evidence: Object.freeze({
      identity_sha256: identity.identity_sha256,
      status,
      outcome,
      actionable_ms: actionable,
      censored_lower_bound_ms: censoredLowerBound,
      unresolved: status === "open_unresolved",
      context_bytes: contextBytes,
    }),
  }
}

function summarizeGroup(group) {
  const actionable = group.evidence
    .map((row) => row.actionable_ms)
    .filter(Number.isFinite)
  const censored = group.evidence
    .map((row) => row.censored_lower_bound_ms)
    .filter(Number.isFinite)
  const contexts = group.evidence
    .map((row) => row.context_bytes)
    .filter(Number.isFinite)
  const unresolvedN = group.evidence.filter((row) => row.unresolved === true).length
  const outcomes = {}

  for (const row of group.evidence) {
    const key = row.outcome ?? row.status ?? "unknown"
    outcomes[key] = (outcomes[key] ?? 0) + 1
  }

  const evidenceSorted = group.evidence.slice().sort((a, b) =>
    canonicalize(a).localeCompare(canonicalize(b))
  )

  return Object.freeze({
    identity: group.identity,
    identity_sha256: group.identity_sha256,
    evidence_sha256: sha256Canonical(evidenceSorted),
    observation_n: group.evidence.length,
    actionable_n: actionable.length,
    censored_n: censored.length,
    unresolved_n: unresolvedN,
    actionable_p50_ms: median(actionable),
    actionable_p90_ms: nearestRank(actionable, 0.90),
    actionable_max_ms: actionable.length > 0 ? Math.max(...actionable) : null,
    max_censored_lower_bound_ms:
      censored.length > 0 ? Math.max(...censored) : null,
    context_bytes_n: contexts.length,
    context_bytes_unknown_n: group.evidence.length - contexts.length,
    context_bytes_min: contexts.length > 0 ? Math.min(...contexts) : null,
    context_bytes_p50: median(contexts),
    context_bytes_p90: nearestRank(contexts, 0.90),
    context_bytes_max: contexts.length > 0 ? Math.max(...contexts) : null,
    outcomes: sortedObject(outcomes),
    authority: RUNTIME_COST_PROFILE_AUTHORITY,
    scheduling_authority: false,
    mutation_authority: false,
  })
}

export function buildPersistentRuntimeCostProfile(
  observations,
  {
    sourceArtifacts = 0,
    sourceTelemetryConflicts = 0,
    sourceDiscoveryTruncated = false,
  } = {},
) {
  const rows = Array.isArray(observations) ? observations : []
  const groups = new Map()
  const rejected = {}

  for (const row of rows) {
    const normalized = normalizedEvidenceRow(row)
    if (!normalized.ok) {
      rejected[normalized.reason] = (rejected[normalized.reason] ?? 0) + 1
      continue
    }

    const key = normalized.identity_sha256
    const group = groups.get(key) ?? {
      identity: normalized.identity,
      identity_sha256: normalized.identity_sha256,
      evidence: [],
    }

    if (canonicalize(group.identity) !== canonicalize(normalized.identity)) {
      throw new Error("identity hash collision")
    }

    group.evidence.push(normalized.evidence)
    groups.set(key, group)
  }

  const profiles = [...groups.values()]
    .map(summarizeGroup)
    .sort((a, b) => a.identity_sha256.localeCompare(b.identity_sha256))

  const acceptedN = profiles.reduce((sum, profile) => sum + profile.observation_n, 0)
  const evidenceDigestInput = profiles.map((profile) => ({
    identity_sha256: profile.identity_sha256,
    evidence_sha256: profile.evidence_sha256,
    observation_n: profile.observation_n,
  }))

  const payload = {
    protocol: RUNTIME_COST_PROFILE_PROTOCOL,
    reducer_protocol: RUNTIME_COST_REDUCER_PROTOCOL,
    authority: RUNTIME_COST_PROFILE_AUTHORITY,
    scheduling_authority: false,
    mutation_authority: false,
    source_artifacts: Number.isInteger(sourceArtifacts) && sourceArtifacts >= 0
      ? sourceArtifacts
      : 0,
    source_telemetry_conflicts:
      Number.isInteger(sourceTelemetryConflicts) && sourceTelemetryConflicts >= 0
        ? sourceTelemetryConflicts
        : 0,
    source_discovery_truncated: sourceDiscoveryTruncated === true,
    input_observations: rows.length,
    accepted_observations: acceptedN,
    rejected_observations: rows.length - acceptedN,
    rejection_reasons: sortedObject(rejected),
    source_evidence_sha256: sha256Canonical(evidenceDigestInput),
    profiles,
  }

  return Object.freeze({
    ...payload,
    content_sha256: sha256Canonical(payload),
  })
}

export function verifyRuntimeCostProfileDocument(document) {
  if (!document || typeof document !== "object") {
    return Object.freeze({ ok: false, reason: "document_invalid" })
  }
  if (document.protocol !== RUNTIME_COST_PROFILE_PROTOCOL) {
    return Object.freeze({ ok: false, reason: "protocol_mismatch" })
  }
  if (document.reducer_protocol !== RUNTIME_COST_REDUCER_PROTOCOL) {
    return Object.freeze({ ok: false, reason: "reducer_protocol_mismatch" })
  }
  if (
    document.authority !== RUNTIME_COST_PROFILE_AUTHORITY ||
    document.scheduling_authority !== false ||
    document.mutation_authority !== false
  ) {
    return Object.freeze({ ok: false, reason: "authority_contract_invalid" })
  }
  if (!Array.isArray(document.profiles)) {
    return Object.freeze({ ok: false, reason: "profiles_invalid" })
  }

  const contentSha = boundedString(document.content_sha256, 128)
  if (!contentSha) {
    return Object.freeze({ ok: false, reason: "content_sha256_missing" })
  }

  const payload = { ...document }
  delete payload.content_sha256
  const expected = sha256Canonical(payload)
  if (expected !== contentSha) {
    return Object.freeze({
      ok: false,
      reason: "content_sha256_mismatch",
      expected,
      actual: contentSha,
    })
  }

  const identityHashes = new Set()
  for (const profile of document.profiles) {
    const identity = normalizeRuntimeCostIdentity(profile?.identity)
    if (!identity.ok) {
      return Object.freeze({
        ok: false,
        reason: "profile_identity_invalid",
        detail: identity.reason,
      })
    }
    if (identity.identity_sha256 !== profile.identity_sha256) {
      return Object.freeze({
        ok: false,
        reason: "profile_identity_sha256_mismatch",
      })
    }
    if (identityHashes.has(profile.identity_sha256)) {
      return Object.freeze({
        ok: false,
        reason: "duplicate_profile_identity",
      })
    }
    identityHashes.add(profile.identity_sha256)
    if (
      profile.authority !== RUNTIME_COST_PROFILE_AUTHORITY ||
      profile.scheduling_authority !== false ||
      profile.mutation_authority !== false
    ) {
      return Object.freeze({
        ok: false,
        reason: "profile_authority_contract_invalid",
      })
    }
  }

  return Object.freeze({
    ok: true,
    reason: "verified",
    content_sha256: contentSha,
    profile_count: document.profiles.length,
  })
}

export function lookupCompatibleRuntimeCostProfile(document, requestedIdentity) {
  const verified = verifyRuntimeCostProfileDocument(document)
  if (!verified.ok) {
    return Object.freeze({
      ok: false,
      reason: "profile_document_invalid",
      detail: verified.reason,
      scheduling_authority: false,
    })
  }

  const identity = normalizeRuntimeCostIdentity(requestedIdentity)
  if (!identity.ok) {
    return Object.freeze({
      ok: false,
      reason: identity.reason,
      missing: identity.missing,
      scheduling_authority: false,
    })
  }

  const matches = document.profiles.filter(
    (profile) => profile.identity_sha256 === identity.identity_sha256,
  )
  if (matches.length === 0) {
    return Object.freeze({
      ok: false,
      reason: "compatible_profile_not_found",
      identity_sha256: identity.identity_sha256,
      scheduling_authority: false,
    })
  }
  if (matches.length !== 1) {
    return Object.freeze({
      ok: false,
      reason: "compatible_profile_ambiguous",
      identity_sha256: identity.identity_sha256,
      scheduling_authority: false,
    })
  }

  return Object.freeze({
    ok: true,
    reason: "exact_compatible_profile",
    identity_sha256: identity.identity_sha256,
    profile: matches[0],
    authority: RUNTIME_COST_PROFILE_AUTHORITY,
    scheduling_authority: false,
    mutation_authority: false,
  })
}

async function readJsonBounded(pathname, maxBytes) {
  const body = await readFile(pathname, "utf8")
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new Error(`input too large: ${pathname}`)
  }
  return JSON.parse(body)
}

function artifactPathFromBackfill(resultsRoot, backfill, artifact) {
  const originalRoot = boundedString(backfill?.root, 4096)
  const originalArtifact = boundedString(artifact?.artifact_dir, 4096)
  if (!originalRoot || !originalArtifact) {
    throw new Error("backfill artifact path invalid")
  }

  const relative = path.relative(path.resolve(originalRoot), path.resolve(originalArtifact))
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("backfill artifact escapes source root")
  }

  const candidate = path.resolve(resultsRoot, relative)
  const root = path.resolve(resultsRoot)
  const relativeToCurrent = path.relative(root, candidate)
  if (
    relativeToCurrent.startsWith(`..${path.sep}`) ||
    relativeToCurrent === ".." ||
    path.isAbsolute(relativeToCurrent)
  ) {
    throw new Error("resolved artifact escapes current results root")
  }
  return candidate
}

export async function materializePersistentRuntimeCostProfile(
  resultsRoot,
  {
    backfillPath = path.join(resultsRoot, DEFAULT_BACKFILL_NAME),
    outputPath = path.join(resultsRoot, DEFAULT_PROFILE_NAME),
  } = {},
) {
  const backfill = await readJsonBounded(backfillPath, MAX_BACKFILL_BYTES)

  if (backfill?.protocol !== RUNTIME_COST_BACKFILL_PROTOCOL) {
    throw new Error("backfill protocol mismatch")
  }
  if (backfill?.reducer_protocol !== RUNTIME_COST_REDUCER_PROTOCOL) {
    throw new Error("backfill reducer protocol mismatch")
  }
  if (
    backfill?.authority !== RUNTIME_COST_PROFILE_AUTHORITY ||
    backfill?.scheduling_authority !== false
  ) {
    throw new Error("backfill authority contract invalid")
  }
  if (backfill?.telemetry_conflicts !== 0) {
    throw new Error("backfill contains telemetry conflicts")
  }
  if (!Array.isArray(backfill?.artifacts)) {
    throw new Error("backfill artifacts invalid")
  }
  if (backfill.artifacts.length > MAX_ARTIFACTS) {
    throw new Error("backfill artifact budget exceeded")
  }

  const observations = []
  const seenArtifacts = new Set()

  for (const artifact of backfill.artifacts) {
    const artifactDir = artifactPathFromBackfill(resultsRoot, backfill, artifact)
    if (seenArtifacts.has(artifactDir)) {
      throw new Error("duplicate backfill artifact")
    }
    seenArtifacts.add(artifactDir)

    const report = await loadArtifactDirectory(artifactDir)
    if (Array.isArray(report.telemetry_conflicts) && report.telemetry_conflicts.length > 0) {
      throw new Error(`artifact telemetry conflict: ${artifactDir}`)
    }
    observations.push(
      ...(Array.isArray(report.model_observations)
        ? report.model_observations
        : []),
    )
  }

  const document = buildPersistentRuntimeCostProfile(observations, {
    sourceArtifacts: backfill.artifacts.length,
    sourceTelemetryConflicts: backfill.telemetry_conflicts,
    sourceDiscoveryTruncated: backfill.discovery_truncated === true,
  })
  const verified = verifyRuntimeCostProfileDocument(document)
  if (!verified.ok) {
    throw new Error(`materialized profile failed verification: ${verified.reason}`)
  }

  await writeFile(
    outputPath,
    JSON.stringify(document, null, 2) + "\n",
    "utf8",
  )

  const persisted = await readJsonBounded(outputPath, MAX_BACKFILL_BYTES)
  const persistedVerification = verifyRuntimeCostProfileDocument(persisted)
  if (!persistedVerification.ok) {
    throw new Error(
      `persisted profile failed verification: ${persistedVerification.reason}`,
    )
  }

  return document
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const resultsRoot = process.argv[2]
  const outputPath = process.argv[3]

  if (!resultsRoot) {
    console.error(
      "usage: node runtime-cost-profile-v1.mjs <results-root> [output-json]",
    )
    process.exitCode = 2
  } else {
    try {
      const document = await materializePersistentRuntimeCostProfile(
        path.resolve(resultsRoot),
        outputPath
          ? { outputPath: path.resolve(outputPath) }
          : {},
      )
      console.log(
        `PASS ${RUNTIME_COST_PROFILE_PROTOCOL} ` +
        `profiles=${document.profiles.length} ` +
        `accepted=${document.accepted_observations} ` +
        `rejected=${document.rejected_observations} ` +
        `sha256=${document.content_sha256}`,
      )
    } catch (error) {
      console.error(String(error?.stack ?? error))
      process.exitCode = 1
    }
  }
}
