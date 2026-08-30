import { createHash } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  normalizeRuntimeCostIdentity,
} from "./runtime-cost-profile-v1.mjs"
import {
  RUNTIME_COST_REDUCER_PROTOCOL,
  loadArtifactDirectory,
} from "./runtime-cost-reducer-v2.mjs"

export const RUNTIME_COST_DEADLINE_INDEX_PROTOCOL =
  "runtime-cost-deadline-index-v1"
export const RUNTIME_COST_DEADLINE_CERTIFICATE_PROTOCOL =
  "runtime-cost-deadline-certificate-v1"
export const RUNTIME_COST_DEADLINE_REQUEST_PROTOCOL =
  "runtime-cost-deadline-request-v1"
export const RUNTIME_COST_BACKFILL_PROTOCOL = "runtime-cost-backfill-v1"

export const DEADLINE_WINDOW_EVIDENCE_STATUS = Object.freeze({
  KNOWN_MISS_PRESENT: "KNOWN_MISS_PRESENT",
  NO_KNOWN_MISS: "NO_KNOWN_MISS",
  NO_OBSERVATIONS: "NO_OBSERVATIONS",
})

const DEFAULT_BACKFILL_NAME = "runtime-cost-backfill.json"
const DEFAULT_INDEX_NAME = "runtime-cost-deadline-index-v1.json"
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_ARTIFACTS = 1024

function boundedString(value, max = 512) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function safeMs(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
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

function sortedObject(input) {
  const out = {}
  for (const key of Object.keys(input ?? {}).sort()) out[key] = input[key]
  return out
}

function upperBound(sorted, value) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (sorted[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function lowerBound(sorted, value) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function exactFraction(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || numerator < 0) return null
  if (!Number.isSafeInteger(denominator) || denominator <= 0) return null
  return Object.freeze({ numerator, denominator })
}

function eventIdentity(row) {
  const sessionID = boundedString(row?.sessionID, 512)
  const turnID = boundedString(row?.turnID, 512)
  const modelCall =
    Number.isSafeInteger(row?.model_call) && row.model_call >= 1
      ? row.model_call
      : null
  const dispatchAtMs = safeMs(row?.dispatch_at_ms)

  if (!sessionID || !turnID || modelCall === null || dispatchAtMs === null) {
    return null
  }

  return Object.freeze({
    sessionID,
    turnID,
    model_call: modelCall,
    dispatch_at_ms: dispatchAtMs,
  })
}

function normalizeObservation(row) {
  const identity = normalizeRuntimeCostIdentity(row)
  if (!identity.ok) {
    return Object.freeze({
      ok: false,
      reason: identity.reason,
    })
  }

  const eventID = eventIdentity(row)
  if (!eventID) {
    return Object.freeze({
      ok: false,
      reason: "observation_identity_incomplete",
    })
  }

  const actionableMs = safeMs(row?.dispatch_to_actionable_boundary_ms)
  const censoredLowerBoundMs =
    row?.censored === true ? safeMs(row?.elapsed_lower_bound_ms) : null
  const unresolved = row?.status === "open_unresolved"
  const contextBytes =
    row?.context_bytes === null || row?.context_bytes === undefined
      ? null
      : safeMs(row.context_bytes)

  const truthyKinds =
    Number(actionableMs !== null) +
    Number(censoredLowerBoundMs !== null) +
    Number(unresolved)

  if (truthyKinds !== 1) {
    return Object.freeze({
      ok: false,
      reason: "observation_boundary_ambiguous",
    })
  }

  const kind =
    actionableMs !== null
      ? "actionable"
      : censoredLowerBoundMs !== null
        ? "right_censored"
        : "unresolved"

  const durationMs =
    kind === "actionable"
      ? actionableMs
      : kind === "right_censored"
        ? censoredLowerBoundMs
        : null

  const evidenceIdentity = {
    profile_identity_sha256: identity.identity_sha256,
    ...eventID,
  }
  const evidenceID = sha256Canonical(evidenceIdentity)

  return Object.freeze({
    ok: true,
    identity: identity.identity,
    identity_sha256: identity.identity_sha256,
    evidence_id_sha256: evidenceID,
    event: Object.freeze({
      evidence_id_sha256: evidenceID,
      dispatch_at_ms: eventID.dispatch_at_ms,
      sessionID: eventID.sessionID,
      turnID: eventID.turnID,
      model_call: eventID.model_call,
      kind,
      duration_ms: durationMs,
      context_bytes: contextBytes,
      outcome: boundedString(row?.outcome, 128),
      status: boundedString(row?.status, 128),
    }),
  })
}

function buildSeries(group) {
  const observationStream = group.events
    .slice()
    .sort((a, b) =>
      a.dispatch_at_ms - b.dispatch_at_ms ||
      a.evidence_id_sha256.localeCompare(b.evidence_id_sha256)
    )

  const actionableTimesMs = observationStream
    .filter((event) => event.kind === "actionable")
    .map((event) => event.duration_ms)
    .sort((a, b) => a - b)

  const censoredLowerBoundsMs = observationStream
    .filter((event) => event.kind === "right_censored")
    .map((event) => event.duration_ms)
    .sort((a, b) => a - b)

  const unresolvedN = observationStream.filter(
    (event) => event.kind === "unresolved",
  ).length

  const contexts = observationStream
    .map((event) => event.context_bytes)
    .filter((value) => value !== null)
    .sort((a, b) => a - b)

  const evidenceDigestInput = observationStream.map((event) => ({
    evidence_id_sha256: event.evidence_id_sha256,
    dispatch_at_ms: event.dispatch_at_ms,
    kind: event.kind,
    duration_ms: event.duration_ms,
    context_bytes: event.context_bytes,
  }))

  return Object.freeze({
    identity: group.identity,
    identity_sha256: group.identity_sha256,
    evidence_sha256: sha256Canonical(evidenceDigestInput),
    observation_n: observationStream.length,
    actionable_n: actionableTimesMs.length,
    censored_n: censoredLowerBoundsMs.length,
    unresolved_n: unresolvedN,
    context_bytes_n: contexts.length,
    context_bytes_unknown_n: observationStream.length - contexts.length,
    context_bytes_min: contexts.length > 0 ? contexts[0] : null,
    context_bytes_max:
      contexts.length > 0 ? contexts[contexts.length - 1] : null,
    actionable_times_ms: Object.freeze(actionableTimesMs),
    censored_lower_bounds_ms: Object.freeze(censoredLowerBoundsMs),
    observation_stream: Object.freeze(observationStream),
    replay_ready: true,
    authority: "shadow_observation",
    admission_authority: false,
    scheduling_authority: false,
    mutation_authority: false,
  })
}

export function buildRuntimeCostDeadlineIndex(
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
  const evidenceByID = new Map()
  let duplicateEvidenceN = 0

  for (const row of rows) {
    const normalized = normalizeObservation(row)
    if (!normalized.ok) {
      rejected[normalized.reason] = (rejected[normalized.reason] ?? 0) + 1
      continue
    }

    const prior = evidenceByID.get(normalized.evidence_id_sha256)
    if (prior) {
      if (canonicalize(prior.event) !== canonicalize(normalized.event)) {
        throw new Error(
          `conflicting duplicate observation: ${normalized.evidence_id_sha256}`,
        )
      }
      duplicateEvidenceN += 1
      continue
    }
    evidenceByID.set(normalized.evidence_id_sha256, normalized)

    const key = normalized.identity_sha256
    const group = groups.get(key) ?? {
      identity: normalized.identity,
      identity_sha256: normalized.identity_sha256,
      events: [],
    }

    if (canonicalize(group.identity) !== canonicalize(normalized.identity)) {
      throw new Error("identity hash collision")
    }

    group.events.push(normalized.event)
    groups.set(key, group)
  }

  const series = [...groups.values()]
    .map(buildSeries)
    .sort((a, b) => a.identity_sha256.localeCompare(b.identity_sha256))

  const acceptedObservations = series.reduce(
    (sum, item) => sum + item.observation_n,
    0,
  )

  const payload = {
    protocol: RUNTIME_COST_DEADLINE_INDEX_PROTOCOL,
    reducer_protocol: RUNTIME_COST_REDUCER_PROTOCOL,
    authority: "shadow_observation",
    admission_authority: false,
    scheduling_authority: false,
    mutation_authority: false,
    source_artifacts:
      Number.isSafeInteger(sourceArtifacts) && sourceArtifacts >= 0
        ? sourceArtifacts
        : 0,
    source_telemetry_conflicts:
      Number.isSafeInteger(sourceTelemetryConflicts) &&
      sourceTelemetryConflicts >= 0
        ? sourceTelemetryConflicts
        : 0,
    source_discovery_truncated: sourceDiscoveryTruncated === true,
    input_observations: rows.length,
    accepted_observations: acceptedObservations,
    duplicate_evidence_n: duplicateEvidenceN,
    rejected_observations:
      rows.length - acceptedObservations - duplicateEvidenceN,
    rejection_reasons: sortedObject(rejected),
    series,
  }

  return Object.freeze({
    ...payload,
    content_sha256: sha256Canonical(payload),
  })
}

export function verifyRuntimeCostDeadlineIndexDocument(document) {
  if (!document || typeof document !== "object") {
    return Object.freeze({ ok: false, reason: "document_invalid" })
  }
  if (document.protocol !== RUNTIME_COST_DEADLINE_INDEX_PROTOCOL) {
    return Object.freeze({ ok: false, reason: "protocol_mismatch" })
  }
  if (document.reducer_protocol !== RUNTIME_COST_REDUCER_PROTOCOL) {
    return Object.freeze({ ok: false, reason: "reducer_protocol_mismatch" })
  }
  if (
    document.authority !== "shadow_observation" ||
    document.admission_authority !== false ||
    document.scheduling_authority !== false ||
    document.mutation_authority !== false
  ) {
    return Object.freeze({ ok: false, reason: "authority_contract_invalid" })
  }
  if (!Array.isArray(document.series)) {
    return Object.freeze({ ok: false, reason: "series_invalid" })
  }

  const contentSha256 = boundedString(document.content_sha256, 128)
  if (!contentSha256) {
    return Object.freeze({ ok: false, reason: "content_sha256_missing" })
  }
  const payload = { ...document }
  delete payload.content_sha256
  const expected = sha256Canonical(payload)
  if (expected !== contentSha256) {
    return Object.freeze({
      ok: false,
      reason: "content_sha256_mismatch",
      expected,
      actual: contentSha256,
    })
  }

  const seen = new Set()
  for (const item of document.series) {
    const identity = normalizeRuntimeCostIdentity(item?.identity)
    if (!identity.ok) {
      return Object.freeze({
        ok: false,
        reason: "series_identity_invalid",
      })
    }
    if (identity.identity_sha256 !== item.identity_sha256) {
      return Object.freeze({
        ok: false,
        reason: "series_identity_sha256_mismatch",
      })
    }
    if (seen.has(item.identity_sha256)) {
      return Object.freeze({
        ok: false,
        reason: "duplicate_series_identity",
      })
    }
    seen.add(item.identity_sha256)

    if (
      item.authority !== "shadow_observation" ||
      item.admission_authority !== false ||
      item.scheduling_authority !== false ||
      item.mutation_authority !== false
    ) {
      return Object.freeze({
        ok: false,
        reason: "series_authority_contract_invalid",
      })
    }

    if (
      !Array.isArray(item.actionable_times_ms) ||
      !Array.isArray(item.censored_lower_bounds_ms) ||
      !Array.isArray(item.observation_stream)
    ) {
      return Object.freeze({
        ok: false,
        reason: "series_event_arrays_invalid",
      })
    }

    for (let index = 1; index < item.actionable_times_ms.length; index += 1) {
      if (item.actionable_times_ms[index - 1] > item.actionable_times_ms[index]) {
        return Object.freeze({
          ok: false,
          reason: "actionable_times_not_sorted",
        })
      }
    }
    for (
      let index = 1;
      index < item.censored_lower_bounds_ms.length;
      index += 1
    ) {
      if (
        item.censored_lower_bounds_ms[index - 1] >
        item.censored_lower_bounds_ms[index]
      ) {
        return Object.freeze({
          ok: false,
          reason: "censored_bounds_not_sorted",
        })
      }
    }
    for (let index = 1; index < item.observation_stream.length; index += 1) {
      if (
        item.observation_stream[index - 1].dispatch_at_ms >
        item.observation_stream[index].dispatch_at_ms
      ) {
        return Object.freeze({
          ok: false,
          reason: "observation_stream_not_sorted",
        })
      }
    }

    const rederivedActionable = []
    const rederivedCensored = []
    let rederivedUnresolvedN = 0
    const rederivedContexts = []
    const evidenceIDs = new Set()
    const evidenceDigestInput = []

    for (const event of item.observation_stream) {
      const evidenceID = boundedString(event?.evidence_id_sha256, 128)
      const dispatchAtMs = safeMs(event?.dispatch_at_ms)
      const contextBytes =
        event?.context_bytes === null || event?.context_bytes === undefined
          ? null
          : safeMs(event.context_bytes)

      if (!evidenceID || dispatchAtMs === null) {
        return Object.freeze({
          ok: false,
          reason: "observation_stream_event_invalid",
        })
      }
      if (evidenceIDs.has(evidenceID)) {
        return Object.freeze({
          ok: false,
          reason: "duplicate_observation_evidence_id",
        })
      }
      evidenceIDs.add(evidenceID)

      if (event.kind === "actionable") {
        const duration = safeMs(event.duration_ms)
        if (duration === null) {
          return Object.freeze({
            ok: false,
            reason: "actionable_event_duration_invalid",
          })
        }
        rederivedActionable.push(duration)
      } else if (event.kind === "right_censored") {
        const duration = safeMs(event.duration_ms)
        if (duration === null) {
          return Object.freeze({
            ok: false,
            reason: "censored_event_duration_invalid",
          })
        }
        rederivedCensored.push(duration)
      } else if (event.kind === "unresolved") {
        if (event.duration_ms !== null) {
          return Object.freeze({
            ok: false,
            reason: "unresolved_event_duration_present",
          })
        }
        rederivedUnresolvedN += 1
      } else {
        return Object.freeze({
          ok: false,
          reason: "observation_stream_kind_invalid",
        })
      }

      if (contextBytes !== null) rederivedContexts.push(contextBytes)
      evidenceDigestInput.push({
        evidence_id_sha256: evidenceID,
        dispatch_at_ms: dispatchAtMs,
        kind: event.kind,
        duration_ms: event.duration_ms,
        context_bytes: contextBytes,
      })
    }

    rederivedActionable.sort((a, b) => a - b)
    rederivedCensored.sort((a, b) => a - b)
    rederivedContexts.sort((a, b) => a - b)

    if (canonicalize(rederivedActionable) !== canonicalize(item.actionable_times_ms)) {
      return Object.freeze({
        ok: false,
        reason: "actionable_times_rederive_mismatch",
      })
    }
    if (
      canonicalize(rederivedCensored) !==
      canonicalize(item.censored_lower_bounds_ms)
    ) {
      return Object.freeze({
        ok: false,
        reason: "censored_bounds_rederive_mismatch",
      })
    }
    if (rederivedUnresolvedN !== item.unresolved_n) {
      return Object.freeze({
        ok: false,
        reason: "unresolved_count_rederive_mismatch",
      })
    }
    if (
      item.observation_n !== item.observation_stream.length ||
      item.actionable_n !== rederivedActionable.length ||
      item.censored_n !== rederivedCensored.length
    ) {
      return Object.freeze({
        ok: false,
        reason: "series_count_rederive_mismatch",
      })
    }

    const expectedContextN = rederivedContexts.length
    const expectedContextUnknownN =
      item.observation_stream.length - expectedContextN
    const expectedContextMin =
      expectedContextN > 0 ? rederivedContexts[0] : null
    const expectedContextMax =
      expectedContextN > 0
        ? rederivedContexts[rederivedContexts.length - 1]
        : null

    if (
      item.context_bytes_n !== expectedContextN ||
      item.context_bytes_unknown_n !== expectedContextUnknownN ||
      item.context_bytes_min !== expectedContextMin ||
      item.context_bytes_max !== expectedContextMax
    ) {
      return Object.freeze({
        ok: false,
        reason: "context_summary_rederive_mismatch",
      })
    }

    if (sha256Canonical(evidenceDigestInput) !== item.evidence_sha256) {
      return Object.freeze({
        ok: false,
        reason: "series_evidence_sha256_mismatch",
      })
    }
  }

  return Object.freeze({
    ok: true,
    reason: "verified",
    content_sha256: contentSha256,
    series_count: document.series.length,
  })
}

export function lookupRuntimeCostDeadlineSeries(document, requestedIdentity) {
  const verified = verifyRuntimeCostDeadlineIndexDocument(document)
  if (!verified.ok) {
    return Object.freeze({
      ok: false,
      reason: "deadline_index_invalid",
      detail: verified.reason,
      admission_authority: false,
      scheduling_authority: false,
    })
  }

  const identity = normalizeRuntimeCostIdentity(requestedIdentity)
  if (!identity.ok) {
    return Object.freeze({
      ok: false,
      reason: identity.reason,
      admission_authority: false,
      scheduling_authority: false,
    })
  }

  const matches = document.series.filter(
    (item) => item.identity_sha256 === identity.identity_sha256,
  )
  if (matches.length === 0) {
    return Object.freeze({
      ok: false,
      reason: "compatible_deadline_series_not_found",
      identity_sha256: identity.identity_sha256,
      admission_authority: false,
      scheduling_authority: false,
    })
  }
  if (matches.length !== 1) {
    return Object.freeze({
      ok: false,
      reason: "compatible_deadline_series_ambiguous",
      identity_sha256: identity.identity_sha256,
      admission_authority: false,
      scheduling_authority: false,
    })
  }

  return Object.freeze({
    ok: true,
    reason: "exact_compatible_deadline_series",
    identity_sha256: identity.identity_sha256,
    series: matches[0],
    authority: "shadow_observation",
    admission_authority: false,
    scheduling_authority: false,
    mutation_authority: false,
  })
}

function contextCoverage(series, requestedContextBytes) {
  const min = safeMs(series?.context_bytes_min)
  const max = safeMs(series?.context_bytes_max)
  const observedN =
    Number.isSafeInteger(series?.context_bytes_n) && series.context_bytes_n >= 0
      ? series.context_bytes_n
      : 0
  const unknownN =
    Number.isSafeInteger(series?.context_bytes_unknown_n) &&
    series.context_bytes_unknown_n >= 0
      ? series.context_bytes_unknown_n
      : 0

  if (requestedContextBytes === null) {
    return Object.freeze({
      status: "requested_context_not_supplied",
      extrapolation: true,
      requested_context_bytes: null,
      observed_context_n: observedN,
      unknown_context_n: unknownN,
      observed_min_bytes: min,
      observed_max_bytes: max,
    })
  }
  if (min === null || max === null || observedN < 1) {
    return Object.freeze({
      status: "profile_context_range_unavailable",
      extrapolation: true,
      requested_context_bytes: requestedContextBytes,
      observed_context_n: observedN,
      unknown_context_n: unknownN,
      observed_min_bytes: min,
      observed_max_bytes: max,
    })
  }
  if (requestedContextBytes < min || requestedContextBytes > max) {
    return Object.freeze({
      status: "outside_observed_context_range",
      extrapolation: true,
      requested_context_bytes: requestedContextBytes,
      observed_context_n: observedN,
      unknown_context_n: unknownN,
      observed_min_bytes: min,
      observed_max_bytes: max,
    })
  }

  return Object.freeze({
    status: "inside_observed_context_range",
    extrapolation: false,
    requested_context_bytes: requestedContextBytes,
    observed_context_n: observedN,
    unknown_context_n: unknownN,
    observed_min_bytes: min,
    observed_max_bytes: max,
  })
}

function certificateResult(payload) {
  const base = {
    protocol: RUNTIME_COST_DEADLINE_CERTIFICATE_PROTOCOL,
    authority: "shadow_observation",
    admission_authority: false,
    scheduling_authority: false,
    mutation_authority: false,
    ...payload,
  }
  return Object.freeze({
    ...base,
    content_sha256: sha256Canonical(base),
  })
}

export function evaluateRuntimeCostDeadlineCertificate(document, request) {
  if (!request || typeof request !== "object") {
    return certificateResult({
      evidence_status: DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS,
      reason: "request_invalid",
      request: null,
      compatible_series: null,
      counts: null,
      historical_miss_rate_bounds: null,
      context_coverage: null,
    })
  }
  if (request.protocol !== RUNTIME_COST_DEADLINE_REQUEST_PROTOCOL) {
    return certificateResult({
      evidence_status: DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS,
      reason: "request_protocol_mismatch",
      request: null,
      compatible_series: null,
      counts: null,
      historical_miss_rate_bounds: null,
      context_coverage: null,
    })
  }

  const modelWindowMs = safeMs(request.model_window_ms)
  const contextBytes =
    request.context_bytes === null || request.context_bytes === undefined
      ? null
      : safeMs(request.context_bytes)

  if (modelWindowMs === null) {
    return certificateResult({
      evidence_status: DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS,
      reason: "model_window_invalid",
      request: null,
      compatible_series: null,
      counts: null,
      historical_miss_rate_bounds: null,
      context_coverage: null,
    })
  }
  if (
    request.context_bytes !== null &&
    request.context_bytes !== undefined &&
    contextBytes === null
  ) {
    return certificateResult({
      evidence_status: DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS,
      reason: "context_bytes_invalid",
      request: null,
      compatible_series: null,
      counts: null,
      historical_miss_rate_bounds: null,
      context_coverage: null,
    })
  }

  const lookup = lookupRuntimeCostDeadlineSeries(document, request.identity)
  if (!lookup.ok) {
    return certificateResult({
      evidence_status: DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS,
      reason: lookup.reason,
      detail: lookup.detail ?? null,
      request: Object.freeze({
        protocol: RUNTIME_COST_DEADLINE_REQUEST_PROTOCOL,
        identity: request.identity,
        model_window_ms: modelWindowMs,
        context_bytes: contextBytes,
        window_kind: boundedString(request.window_kind, 64) ?? "effective",
      }),
      compatible_series: null,
      counts: null,
      historical_miss_rate_bounds: null,
      context_coverage: null,
    })
  }

  const series = lookup.series
  const actionable = series.actionable_times_ms
  const censored = series.censored_lower_bounds_ms

  const actionableMeetN = upperBound(actionable, modelWindowMs)
  const actionableMissN = actionable.length - actionableMeetN

  // A right-censored observation with lower bound >= W proves that the
  // actionable boundary was not reached by W. A smaller lower bound remains
  // unknown at W and is never point-imputed.
  const firstCensoredKnownMiss = lowerBound(censored, modelWindowMs)
  const censoredKnownMissN = censored.length - firstCensoredKnownMiss
  const censoredUnknownN = firstCensoredKnownMiss
  const unresolvedN = series.unresolved_n

  const knownMeetN = actionableMeetN
  const knownMissN = actionableMissN + censoredKnownMissN
  const unknownN = censoredUnknownN + unresolvedN
  const totalN = knownMeetN + knownMissN + unknownN

  const lower = totalN > 0 ? exactFraction(knownMissN, totalN) : null
  const upper =
    totalN > 0 ? exactFraction(knownMissN + unknownN, totalN) : null

  const evidenceStatus =
    totalN === 0
      ? DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS
      : knownMissN > 0
        ? DEADLINE_WINDOW_EVIDENCE_STATUS.KNOWN_MISS_PRESENT
        : DEADLINE_WINDOW_EVIDENCE_STATUS.NO_KNOWN_MISS

  return certificateResult({
    evidence_status: evidenceStatus,
    reason:
      totalN === 0
        ? "no_compatible_observations"
        : knownMissN > 0
          ? "compatible_history_contains_known_deadline_miss"
          : "compatible_history_contains_no_known_deadline_miss",
    request: Object.freeze({
      protocol: RUNTIME_COST_DEADLINE_REQUEST_PROTOCOL,
      identity: request.identity,
      model_window_ms: modelWindowMs,
      context_bytes: contextBytes,
      window_kind: boundedString(request.window_kind, 64) ?? "effective",
    }),
    compatible_series: Object.freeze({
      identity: series.identity,
      identity_sha256: series.identity_sha256,
      evidence_sha256: series.evidence_sha256,
      replay_ready: series.replay_ready === true,
    }),
    counts: Object.freeze({
      total_n: totalN,
      known_meet_n: knownMeetN,
      known_miss_n: knownMissN,
      unknown_n: unknownN,
      actionable_meet_n: actionableMeetN,
      actionable_miss_n: actionableMissN,
      censored_known_miss_n: censoredKnownMissN,
      censored_unknown_n: censoredUnknownN,
      unresolved_n: unresolvedN,
    }),
    historical_miss_rate_bounds:
      totalN > 0
        ? Object.freeze({
            lower_exact: lower,
            upper_exact: upper,
            interpretation:
              "partial_identification_over_exact_compatible_history",
          })
        : null,
    context_coverage: contextCoverage(series, contextBytes),
    query_complexity: "O(log n)",
  })
}

async function readJsonBounded(pathname) {
  const body = await readFile(pathname, "utf8")
  if (Buffer.byteLength(body, "utf8") > MAX_JSON_BYTES) {
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

  const relative = path.relative(
    path.resolve(originalRoot),
    path.resolve(originalArtifact),
  )
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("backfill artifact escapes source root")
  }

  const root = path.resolve(resultsRoot)
  const candidate = path.resolve(root, relative)
  const relativeToCurrent = path.relative(root, candidate)
  if (
    relativeToCurrent === ".." ||
    relativeToCurrent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToCurrent)
  ) {
    throw new Error("resolved artifact escapes current results root")
  }
  return candidate
}

async function fileSha256(pathname) {
  const body = await readFile(pathname)
  return createHash("sha256").update(body).digest("hex")
}

export async function materializeRuntimeCostDeadlineIndex(
  resultsRoot,
  {
    backfillPath = path.join(resultsRoot, DEFAULT_BACKFILL_NAME),
    outputPath = path.join(resultsRoot, DEFAULT_INDEX_NAME),
  } = {},
) {
  const backfill = await readJsonBounded(backfillPath)

  if (backfill?.protocol !== RUNTIME_COST_BACKFILL_PROTOCOL) {
    throw new Error("backfill protocol mismatch")
  }
  if (backfill?.reducer_protocol !== RUNTIME_COST_REDUCER_PROTOCOL) {
    throw new Error("backfill reducer protocol mismatch")
  }
  if (
    backfill?.authority !== "shadow_observation" ||
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
  const artifactProofs = []

  for (const artifact of backfill.artifacts) {
    const artifactDir = artifactPathFromBackfill(resultsRoot, backfill, artifact)
    if (seenArtifacts.has(artifactDir)) {
      throw new Error("duplicate backfill artifact")
    }
    seenArtifacts.add(artifactDir)

    const tracked = [
      "cpu-agent-trace.jsonl",
      "agent.stdout.jsonl",
      "search-trace.jsonl",
      "executor-trace.jsonl",
      "result.json",
    ]
    const before = {}
    for (const name of tracked) {
      const pathname = path.join(artifactDir, name)
      try {
        const info = await stat(pathname)
        if (info.isFile()) before[name] = await fileSha256(pathname)
      } catch {
        // Optional trace absent.
      }
    }

    const report = await loadArtifactDirectory(artifactDir)
    if (
      Array.isArray(report.telemetry_conflicts) &&
      report.telemetry_conflicts.length > 0
    ) {
      throw new Error(`artifact telemetry conflict: ${artifactDir}`)
    }

    const after = {}
    for (const [name] of Object.entries(before)) {
      const pathname = path.join(artifactDir, name)
      after[name] = await fileSha256(pathname)
      if (after[name] !== before[name]) {
        throw new Error(`raw artifact mutated during materialization: ${pathname}`)
      }
    }

    const artifactRelpath = path.relative(
      path.resolve(resultsRoot),
      artifactDir,
    ).split(path.sep).join("/")
    if (!artifactRelpath || artifactRelpath.startsWith("../")) {
      throw new Error("artifact relative identity invalid")
    }
    artifactProofs.push({
      artifact_relpath: artifactRelpath,
      raw_trace_sha256: sortedObject(before),
    })
    observations.push(
      ...(Array.isArray(report.model_observations)
        ? report.model_observations
        : []),
    )
  }

  const document = buildRuntimeCostDeadlineIndex(observations, {
    sourceArtifacts: backfill.artifacts.length,
    sourceTelemetryConflicts: backfill.telemetry_conflicts,
    sourceDiscoveryTruncated: backfill.discovery_truncated === true,
  })

  const payload = {
    ...document,
    source_artifact_proofs_sha256: sha256Canonical(
      artifactProofs
        .slice()
        .sort((a, b) =>
          a.artifact_relpath.localeCompare(b.artifact_relpath)
        ),
    ),
  }
  delete payload.content_sha256
  const finalDocument = Object.freeze({
    ...payload,
    content_sha256: sha256Canonical(payload),
  })

  const verified = verifyRuntimeCostDeadlineIndexDocument(finalDocument)
  if (!verified.ok) {
    throw new Error(
      `materialized deadline index failed verification: ${verified.reason}`,
    )
  }

  await writeFile(
    outputPath,
    JSON.stringify(finalDocument, null, 2) + "\n",
    "utf8",
  )

  const persisted = await readJsonBounded(outputPath)
  const persistedVerification =
    verifyRuntimeCostDeadlineIndexDocument(persisted)
  if (!persistedVerification.ok) {
    throw new Error(
      `persisted deadline index failed verification: ` +
      persistedVerification.reason,
    )
  }

  return finalDocument
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const command = process.argv[2]

  if (command === "materialize") {
    const resultsRoot = process.argv[3]
    const outputPath = process.argv[4]
    if (!resultsRoot) {
      console.error(
        "usage: node runtime-cost-deadline-index-v1.mjs " +
        "materialize <results-root> [output-json]",
      )
      process.exitCode = 2
    } else {
      try {
        const document = await materializeRuntimeCostDeadlineIndex(
          path.resolve(resultsRoot),
          outputPath ? { outputPath: path.resolve(outputPath) } : {},
        )
        console.log(
          `PASS ${RUNTIME_COST_DEADLINE_INDEX_PROTOCOL} ` +
          `series=${document.series.length} ` +
          `accepted=${document.accepted_observations} ` +
          `duplicates=${document.duplicate_evidence_n} ` +
          `rejected=${document.rejected_observations} ` +
          `sha256=${document.content_sha256}`,
        )
      } catch (error) {
        console.error(String(error?.stack ?? error))
        process.exitCode = 1
      }
    }
  } else if (command === "query") {
    const indexPath = process.argv[3]
    const requestPath = process.argv[4]
    const outputPath = process.argv[5]
    if (!indexPath || !requestPath) {
      console.error(
        "usage: node runtime-cost-deadline-index-v1.mjs " +
        "query <index-json> <request-json> [output-json]",
      )
      process.exitCode = 2
    } else {
      try {
        const document = await readJsonBounded(path.resolve(indexPath))
        const request = await readJsonBounded(path.resolve(requestPath))
        const certificate = evaluateRuntimeCostDeadlineCertificate(
          document,
          request,
        )
        if (outputPath) {
          await writeFile(
            path.resolve(outputPath),
            JSON.stringify(certificate, null, 2) + "\n",
            "utf8",
          )
        }
        console.log(JSON.stringify(certificate, null, 2))
      } catch (error) {
        console.error(String(error?.stack ?? error))
        process.exitCode = 1
      }
    }
  } else {
    console.error(
      "usage: node runtime-cost-deadline-index-v1.mjs " +
      "<materialize|query> ...",
    )
    process.exitCode = 2
  }
}
