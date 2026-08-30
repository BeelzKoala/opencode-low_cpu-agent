import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  lookupCompatibleRuntimeCostProfile,
  verifyRuntimeCostProfileDocument,
} from "./runtime-cost-profile-v1.mjs"

export const RUNTIME_COST_ADMISSION_EVIDENCE_PROTOCOL =
  "runtime-cost-admission-evidence-v1"
export const RUNTIME_COST_ADMISSION_REQUEST_PROTOCOL =
  "runtime-cost-admission-request-v1"

export const ADMISSION_EVIDENCE_SIGNAL = Object.freeze({
  OBSERVED_WINDOW_VIOLATION: "OBSERVED_WINDOW_VIOLATION",
  NO_OBSERVED_WINDOW_VIOLATION: "NO_OBSERVED_WINDOW_VIOLATION",
  EVIDENCE_INSUFFICIENT: "EVIDENCE_INSUFFICIENT",
})

const MAX_JSON_BYTES = 4 * 1024 * 1024

function boundedString(value, max = 256) {
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

function safeAdd(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null
  const value = a + b
  return Number.isSafeInteger(value) ? value : null
}

function maxFinite(values) {
  const valid = values.filter((value) => Number.isFinite(value))
  return valid.length > 0 ? Math.max(...valid) : null
}

function normalizeRequest(request) {
  if (!request || typeof request !== "object") {
    return { ok: false, reason: "request_invalid" }
  }
  if (request.protocol !== RUNTIME_COST_ADMISSION_REQUEST_PROTOCOL) {
    return { ok: false, reason: "request_protocol_mismatch" }
  }

  const remainingWindowMs = safeMs(request.remaining_window_ms)
  const deterministicTailReserveMs =
    safeMs(request.deterministic_tail_reserve_ms)
  const safetyMarginMs = safeMs(request.safety_margin_ms)
  const contextBytes =
    request.context_bytes === null || request.context_bytes === undefined
      ? null
      : safeMs(request.context_bytes)
  const windowKind = boundedString(request.window_kind, 64) ?? "effective"

  if (remainingWindowMs === null) {
    return { ok: false, reason: "remaining_window_invalid" }
  }
  if (deterministicTailReserveMs === null) {
    return { ok: false, reason: "deterministic_tail_reserve_invalid" }
  }
  if (safetyMarginMs === null) {
    return { ok: false, reason: "safety_margin_invalid" }
  }
  if (
    request.context_bytes !== null &&
    request.context_bytes !== undefined &&
    contextBytes === null
  ) {
    return { ok: false, reason: "context_bytes_invalid" }
  }
  if (!request.identity || typeof request.identity !== "object") {
    return { ok: false, reason: "identity_missing" }
  }

  const reservedNonModelMs = safeAdd(
    deterministicTailReserveMs,
    safetyMarginMs,
  )
  if (reservedNonModelMs === null) {
    return { ok: false, reason: "reserve_overflow" }
  }

  return {
    ok: true,
    request: Object.freeze({
      protocol: RUNTIME_COST_ADMISSION_REQUEST_PROTOCOL,
      identity: request.identity,
      remaining_window_ms: remainingWindowMs,
      deterministic_tail_reserve_ms: deterministicTailReserveMs,
      safety_margin_ms: safetyMarginMs,
      reserved_non_model_ms: reservedNonModelMs,
      available_model_window_ms:
        Math.max(0, remainingWindowMs - reservedNonModelMs),
      context_bytes: contextBytes,
      window_kind: windowKind,
    }),
  }
}

function contextCoverage(profile, requestedContextBytes) {
  const observedN = Number.isSafeInteger(profile?.context_bytes_n)
    ? profile.context_bytes_n
    : 0
  const unknownN = Number.isSafeInteger(profile?.context_bytes_unknown_n)
    ? profile.context_bytes_unknown_n
    : 0
  const min = safeMs(profile?.context_bytes_min)
  const max = safeMs(profile?.context_bytes_max)

  if (requestedContextBytes === null) {
    return Object.freeze({
      status: "requested_context_not_supplied",
      requested_context_bytes: null,
      observed_context_n: observedN,
      unknown_context_n: unknownN,
      observed_min_bytes: min,
      observed_max_bytes: max,
      extrapolation: true,
    })
  }
  if (min === null || max === null || observedN < 1) {
    return Object.freeze({
      status: "profile_context_range_unavailable",
      requested_context_bytes: requestedContextBytes,
      observed_context_n: observedN,
      unknown_context_n: unknownN,
      observed_min_bytes: min,
      observed_max_bytes: max,
      extrapolation: true,
    })
  }
  if (requestedContextBytes < min || requestedContextBytes > max) {
    return Object.freeze({
      status: "outside_observed_context_range",
      requested_context_bytes: requestedContextBytes,
      observed_context_n: observedN,
      unknown_context_n: unknownN,
      observed_min_bytes: min,
      observed_max_bytes: max,
      extrapolation: true,
    })
  }

  return Object.freeze({
    status: "inside_observed_context_range",
    requested_context_bytes: requestedContextBytes,
    observed_context_n: observedN,
    unknown_context_n: unknownN,
    observed_min_bytes: min,
    observed_max_bytes: max,
    extrapolation: false,
  })
}

function summarizeHistoricalEvidence(profile) {
  const observationN = Number.isSafeInteger(profile?.observation_n)
    ? Math.max(0, profile.observation_n)
    : 0
  const actionableN = Number.isSafeInteger(profile?.actionable_n)
    ? Math.max(0, profile.actionable_n)
    : 0
  const censoredN = Number.isSafeInteger(profile?.censored_n)
    ? Math.max(0, profile.censored_n)
    : 0
  const unresolvedN = Number.isSafeInteger(profile?.unresolved_n)
    ? Math.max(0, profile.unresolved_n)
    : 0

  const completedP50 = safeMs(profile?.actionable_p50_ms)
  const completedP90 = safeMs(profile?.actionable_p90_ms)
  const completedMax = safeMs(profile?.actionable_max_ms)
  const censoredLowerBound = safeMs(profile?.max_censored_lower_bound_ms)

  const observedFloor = maxFinite([
    completedMax,
    censoredLowerBound,
  ])
  const floorSources = []
  if (
    observedFloor !== null &&
    completedMax !== null &&
    completedMax === observedFloor
  ) {
    floorSources.push("completed_max")
  }
  if (
    observedFloor !== null &&
    censoredLowerBound !== null &&
    censoredLowerBound === observedFloor
  ) {
    floorSources.push("censored_lower_bound")
  }

  return Object.freeze({
    observation_n: observationN,
    actionable_n: actionableN,
    censored_n: censoredN,
    unresolved_n: unresolvedN,
    bounded_observation_n: actionableN + censoredN,
    empirical_completed_p50_ms: completedP50,
    empirical_completed_p90_ms: completedP90,
    empirical_completed_max_ms: completedMax,
    max_censored_lower_bound_ms: censoredLowerBound,
    historical_observed_cost_floor_ms: observedFloor,
    historical_observed_cost_floor_sources: Object.freeze(floorSources),
  })
}

function makeResult(payload) {
  const base = {
    protocol: RUNTIME_COST_ADMISSION_EVIDENCE_PROTOCOL,
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

export function evaluateRuntimeCostAdmissionEvidence(
  profileDocument,
  request,
) {
  const normalized = normalizeRequest(request)
  if (!normalized.ok) {
    return makeResult({
      signal: ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
      reason: normalized.reason,
      request: null,
      compatible_profile: null,
      historical_evidence: null,
      context_coverage: null,
      observed_window_exceedance_ms: null,
      headroom_to_historical_observed_floor_ms: null,
      extrapolation_flags: Object.freeze(["request_invalid"]),
    })
  }

  const req = normalized.request
  const verified = verifyRuntimeCostProfileDocument(profileDocument)
  if (!verified.ok) {
    return makeResult({
      signal: ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
      reason: "profile_document_invalid",
      detail: verified.reason,
      request: req,
      compatible_profile: null,
      historical_evidence: null,
      context_coverage: null,
      observed_window_exceedance_ms: null,
      headroom_to_historical_observed_floor_ms: null,
      extrapolation_flags: Object.freeze(["profile_document_invalid"]),
    })
  }

  const lookup = lookupCompatibleRuntimeCostProfile(
    profileDocument,
    req.identity,
  )
  if (!lookup.ok) {
    return makeResult({
      signal: ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
      reason: lookup.reason,
      request: req,
      compatible_profile: null,
      historical_evidence: null,
      context_coverage: null,
      observed_window_exceedance_ms: null,
      headroom_to_historical_observed_floor_ms: null,
      extrapolation_flags: Object.freeze(["no_exact_compatible_profile"]),
    })
  }

  const profile = lookup.profile
  const historical = summarizeHistoricalEvidence(profile)
  const context = contextCoverage(profile, req.context_bytes)
  const flags = []

  if (historical.unresolved_n > 0) {
    flags.push("unresolved_observations_present")
  }
  if (historical.censored_n > 0) {
    flags.push("censored_observations_present")
  }
  if (context.extrapolation) {
    flags.push(context.status)
  }

  const floor = historical.historical_observed_cost_floor_ms
  const available = req.available_model_window_ms

  if (historical.bounded_observation_n < 1 || floor === null) {
    return makeResult({
      signal: ADMISSION_EVIDENCE_SIGNAL.EVIDENCE_INSUFFICIENT,
      reason: "no_bounded_historical_cost_observation",
      request: req,
      compatible_profile: Object.freeze({
        identity: profile.identity,
        identity_sha256: profile.identity_sha256,
        evidence_sha256: profile.evidence_sha256,
      }),
      historical_evidence: historical,
      context_coverage: context,
      observed_window_exceedance_ms: null,
      headroom_to_historical_observed_floor_ms: null,
      extrapolation_flags: Object.freeze(flags),
    })
  }

  const delta = available - floor
  if (floor > available) {
    return makeResult({
      signal: ADMISSION_EVIDENCE_SIGNAL.OBSERVED_WINDOW_VIOLATION,
      reason: "compatible_history_contains_cost_above_available_window",
      request: req,
      compatible_profile: Object.freeze({
        identity: profile.identity,
        identity_sha256: profile.identity_sha256,
        evidence_sha256: profile.evidence_sha256,
      }),
      historical_evidence: historical,
      context_coverage: context,
      observed_window_exceedance_ms: floor - available,
      headroom_to_historical_observed_floor_ms: delta,
      extrapolation_flags: Object.freeze(flags),
    })
  }

  return makeResult({
    signal: ADMISSION_EVIDENCE_SIGNAL.NO_OBSERVED_WINDOW_VIOLATION,
    reason: "available_window_not_below_historical_observed_floor",
    request: req,
    compatible_profile: Object.freeze({
      identity: profile.identity,
      identity_sha256: profile.identity_sha256,
      evidence_sha256: profile.evidence_sha256,
    }),
    historical_evidence: historical,
    context_coverage: context,
    observed_window_exceedance_ms: 0,
    headroom_to_historical_observed_floor_ms: delta,
    extrapolation_flags: Object.freeze(flags),
  })
}

async function readJsonBounded(pathname) {
  const body = await readFile(pathname, "utf8")
  if (Buffer.byteLength(body, "utf8") > MAX_JSON_BYTES) {
    throw new Error(`input too large: ${pathname}`)
  }
  return JSON.parse(body)
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const profilePath = process.argv[2]
  const requestPath = process.argv[3]
  const outputPath = process.argv[4]

  if (!profilePath || !requestPath) {
    console.error(
      "usage: node runtime-cost-admission-evidence-v1.mjs " +
      "<profile-json> <request-json> [output-json]",
    )
    process.exitCode = 2
  } else {
    try {
      const profile = await readJsonBounded(path.resolve(profilePath))
      const request = await readJsonBounded(path.resolve(requestPath))
      const evidence = evaluateRuntimeCostAdmissionEvidence(profile, request)

      if (outputPath) {
        await writeFile(
          path.resolve(outputPath),
          JSON.stringify(evidence, null, 2) + "\n",
          "utf8",
        )
      }

      console.log(JSON.stringify(evidence, null, 2))
    } catch (error) {
      console.error(String(error?.stack ?? error))
      process.exitCode = 1
    }
  }
}
