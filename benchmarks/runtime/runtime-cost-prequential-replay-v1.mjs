import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  lookupRuntimeCostDeadlineSeries,
  verifyRuntimeCostDeadlineIndexDocument,
} from "./runtime-cost-deadline-index-v1.mjs"

export const RUNTIME_COST_PREQUENTIAL_REPLAY_PROTOCOL =
  "runtime-cost-prequential-replay-v1"
export const RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL =
  "runtime-cost-prequential-spec-v1"

export const PREQUENTIAL_DECISION = Object.freeze({
  BLOCK: "BLOCK",
  LEGACY: "LEGACY",
})

export const PREQUENTIAL_OUTCOME = Object.freeze({
  KNOWN_MEET: "KNOWN_MEET",
  KNOWN_MISS: "KNOWN_MISS",
  UNKNOWN: "UNKNOWN",
})

const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_SCENARIOS = 16
const MAX_POLICIES = 16
const MAX_DECISION_CELLS = 100_000

function boundedString(value, max = 512) {
  if (typeof value !== "string") return null
  const text = value.trim()
  return text && text.length <= max ? text : null
}

function safeInt(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`,
    ).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex")
}

function normalizeRatio(value, field) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== "object") throw new Error(`${field} invalid`)
  const numerator = safeInt(value.numerator, 0, 1024)
  const denominator = safeInt(value.denominator, 1, 1024)
  if (numerator === null || denominator === null || numerator > denominator) {
    throw new Error(`${field} invalid`)
  }
  return Object.freeze({ numerator, denominator })
}

function ratioAtLeast(num, den, threshold) {
  if (!threshold) return true
  if (den <= 0) return false
  return num * threshold.denominator >= threshold.numerator * den
}

function ratioAtMost(num, den, threshold) {
  if (!threshold) return true
  if (den <= 0) return false
  return num * threshold.denominator <= threshold.numerator * den
}

function normalizePolicy(raw, seen) {
  if (!raw || typeof raw !== "object") throw new Error("policy invalid")
  const id = boundedString(raw.id, 96)
  if (!id) throw new Error("policy id invalid")
  if (seen.has(id)) throw new Error(`duplicate policy id: ${id}`)
  seen.add(id)

  const minKnownMissN = safeInt(raw.min_known_miss_n, 1, 1024)
  const minTotalN =
    raw.min_total_n === undefined ? 0 : safeInt(raw.min_total_n, 0, 1024)
  const minBoundedN =
    raw.min_bounded_n === undefined ? 0 : safeInt(raw.min_bounded_n, 0, 1024)

  if (minKnownMissN === null || minTotalN === null || minBoundedN === null) {
    throw new Error(`policy ${id}: invalid count threshold`)
  }

  return Object.freeze({
    id,
    policy_family: "negative_evidence_only_v1",
    min_known_miss_n: minKnownMissN,
    min_total_n: minTotalN,
    min_bounded_n: minBoundedN,
    min_miss_lower_bound: normalizeRatio(
      raw.min_miss_lower_bound ?? null,
      `policy ${id}: min_miss_lower_bound`,
    ),
    max_unknown_fraction: normalizeRatio(
      raw.max_unknown_fraction ?? null,
      `policy ${id}: max_unknown_fraction`,
    ),
    require_context_in_observed_range:
      raw.require_context_in_observed_range === true,
  })
}

function normalizeScenario(raw, seen) {
  if (!raw || typeof raw !== "object") throw new Error("scenario invalid")
  const id = boundedString(raw.id, 96)
  if (!id) throw new Error("scenario id invalid")
  if (seen.has(id)) throw new Error(`duplicate scenario id: ${id}`)
  seen.add(id)

  const modelWindowMs = safeInt(raw.model_window_ms, 0)
  if (modelWindowMs === null) {
    throw new Error(`scenario ${id}: model_window_ms invalid`)
  }
  if (!raw.identity || typeof raw.identity !== "object") {
    throw new Error(`scenario ${id}: identity missing`)
  }

  return Object.freeze({
    id,
    identity: raw.identity,
    model_window_ms: modelWindowMs,
  })
}

export function normalizePrequentialReplaySpec(spec) {
  if (!spec || typeof spec !== "object") {
    return Object.freeze({ ok: false, reason: "spec_invalid" })
  }
  if (spec.protocol !== RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL) {
    return Object.freeze({ ok: false, reason: "spec_protocol_mismatch" })
  }
  if (
    !Array.isArray(spec.scenarios) ||
    spec.scenarios.length < 1 ||
    spec.scenarios.length > MAX_SCENARIOS
  ) {
    return Object.freeze({ ok: false, reason: "scenarios_invalid" })
  }
  if (
    !Array.isArray(spec.policies) ||
    spec.policies.length < 1 ||
    spec.policies.length > MAX_POLICIES
  ) {
    return Object.freeze({ ok: false, reason: "policies_invalid" })
  }

  try {
    const scenarioIDs = new Set()
    const policyIDs = new Set()
    return Object.freeze({
      ok: true,
      reason: "normalized",
      spec: Object.freeze({
        protocol: RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL,
        scenarios: Object.freeze(
          spec.scenarios.map((row) => normalizeScenario(row, scenarioIDs)),
        ),
        policies: Object.freeze(
          spec.policies.map((row) => normalizePolicy(row, policyIDs)),
        ),
      }),
    })
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: "spec_semantic_invalid",
      detail: String(error?.message ?? error),
    })
  }
}

function classifyAtWindow(event, windowMs) {
  if (event.kind === "actionable") {
    return Object.freeze({
      outcome:
        event.duration_ms <= windowMs
          ? PREQUENTIAL_OUTCOME.KNOWN_MEET
          : PREQUENTIAL_OUTCOME.KNOWN_MISS,
      observed_cost_ms: event.duration_ms,
      cost_semantics: "exact_actionable_cost",
    })
  }

  if (event.kind === "right_censored") {
    if (event.duration_ms >= windowMs) {
      return Object.freeze({
        outcome: PREQUENTIAL_OUTCOME.KNOWN_MISS,
        observed_cost_ms: event.duration_ms,
        cost_semantics: "censored_cost_lower_bound",
      })
    }
    return Object.freeze({
      outcome: PREQUENTIAL_OUTCOME.UNKNOWN,
      observed_cost_ms: null,
      cost_semantics: "censored_before_horizon",
    })
  }

  return Object.freeze({
    outcome: PREQUENTIAL_OUTCOME.UNKNOWN,
    observed_cost_ms: null,
    cost_semantics: "unresolved",
  })
}

function emptyHistory() {
  return {
    total_n: 0,
    known_meet_n: 0,
    known_miss_n: 0,
    unknown_n: 0,
    bounded_n: 0,
    context_bytes_n: 0,
    context_bytes_min: null,
    context_bytes_max: null,
  }
}

function addHistory(history, event, classified) {
  history.total_n += 1
  if (classified.outcome === PREQUENTIAL_OUTCOME.KNOWN_MEET) {
    history.known_meet_n += 1
    history.bounded_n += 1
  } else if (classified.outcome === PREQUENTIAL_OUTCOME.KNOWN_MISS) {
    history.known_miss_n += 1
    history.bounded_n += 1
  } else {
    history.unknown_n += 1
  }

  if (event.context_bytes !== null) {
    history.context_bytes_n += 1
    history.context_bytes_min =
      history.context_bytes_min === null
        ? event.context_bytes
        : Math.min(history.context_bytes_min, event.context_bytes)
    history.context_bytes_max =
      history.context_bytes_max === null
        ? event.context_bytes
        : Math.max(history.context_bytes_max, event.context_bytes)
  }
}

function contextInside(history, event) {
  return (
    event.context_bytes !== null &&
    history.context_bytes_n > 0 &&
    history.context_bytes_min !== null &&
    history.context_bytes_max !== null &&
    event.context_bytes >= history.context_bytes_min &&
    event.context_bytes <= history.context_bytes_max
  )
}

function policyDecision(policy, history, event) {
  if (history.known_miss_n < policy.min_known_miss_n) {
    return PREQUENTIAL_DECISION.LEGACY
  }
  if (history.total_n < policy.min_total_n) {
    return PREQUENTIAL_DECISION.LEGACY
  }
  if (history.bounded_n < policy.min_bounded_n) {
    return PREQUENTIAL_DECISION.LEGACY
  }
  if (
    !ratioAtLeast(
      history.known_miss_n,
      history.total_n,
      policy.min_miss_lower_bound,
    )
  ) {
    return PREQUENTIAL_DECISION.LEGACY
  }
  if (
    !ratioAtMost(
      history.unknown_n,
      history.total_n,
      policy.max_unknown_fraction,
    )
  ) {
    return PREQUENTIAL_DECISION.LEGACY
  }
  if (
    policy.require_context_in_observed_range &&
    !contextInside(history, event)
  ) {
    return PREQUENTIAL_DECISION.LEGACY
  }
  return PREQUENTIAL_DECISION.BLOCK
}

function emptyMetrics() {
  return {
    decision_n: 0,
    block_n: 0,
    legacy_n: 0,
    blocked_known_miss_n: 0,
    blocked_known_meet_n: 0,
    blocked_unknown_n: 0,
    legacy_known_miss_n: 0,
    legacy_known_meet_n: 0,
    legacy_unknown_n: 0,
    blocked_known_miss_cost_lower_bound_ms: 0,
    blocked_known_meet_cost_ms: 0,
  }
}

function updateMetrics(metrics, decision, classified) {
  metrics.decision_n += 1
  const blocked = decision === PREQUENTIAL_DECISION.BLOCK
  metrics[blocked ? "block_n" : "legacy_n"] += 1

  if (classified.outcome === PREQUENTIAL_OUTCOME.KNOWN_MISS) {
    metrics[blocked ? "blocked_known_miss_n" : "legacy_known_miss_n"] += 1
    if (blocked) {
      metrics.blocked_known_miss_cost_lower_bound_ms +=
        classified.observed_cost_ms
    }
  } else if (classified.outcome === PREQUENTIAL_OUTCOME.KNOWN_MEET) {
    metrics[blocked ? "blocked_known_meet_n" : "legacy_known_meet_n"] += 1
    if (blocked) {
      metrics.blocked_known_meet_cost_ms += classified.observed_cost_ms
    }
  } else {
    metrics[blocked ? "blocked_unknown_n" : "legacy_unknown_n"] += 1
  }
}

function dominatesMetrics(a, b) {
  const noWorse =
    a.blocked_known_miss_n >= b.blocked_known_miss_n &&
    a.blocked_known_miss_cost_lower_bound_ms >=
      b.blocked_known_miss_cost_lower_bound_ms &&
    a.blocked_known_meet_n <= b.blocked_known_meet_n &&
    a.blocked_known_meet_cost_ms <= b.blocked_known_meet_cost_ms &&
    a.blocked_unknown_n <= b.blocked_unknown_n

  if (!noWorse) return false

  return (
    a.blocked_known_miss_n > b.blocked_known_miss_n ||
    a.blocked_known_miss_cost_lower_bound_ms >
      b.blocked_known_miss_cost_lower_bound_ms ||
    a.blocked_known_meet_n < b.blocked_known_meet_n ||
    a.blocked_known_meet_cost_ms < b.blocked_known_meet_cost_ms ||
    a.blocked_unknown_n < b.blocked_unknown_n
  )
}

export function computeRuntimeCostPolicyParetoFrontier(policyMetrics) {
  if (!Array.isArray(policyMetrics)) return Object.freeze([])
  const frontier = []
  for (const candidate of policyMetrics) {
    const dominatedBy = policyMetrics
      .filter((other) => other.policy_id !== candidate.policy_id)
      .filter((other) => dominatesMetrics(other.metrics, candidate.metrics))
      .map((other) => other.policy_id)
      .sort()
    if (dominatedBy.length === 0) frontier.push(candidate.policy_id)
  }
  return Object.freeze(frontier.sort())
}

function batches(events) {
  const out = []
  let current = null
  for (const event of events) {
    if (!current || current.dispatch_at_ms !== event.dispatch_at_ms) {
      current = { dispatch_at_ms: event.dispatch_at_ms, events: [] }
      out.push(current)
    }
    current.events.push(event)
  }
  return out
}

function replayScenario(series, scenario, policies) {
  const cells = series.observation_stream.length * policies.length
  if (cells > MAX_DECISION_CELLS) throw new Error("decision cell budget exceeded")

  const history = emptyHistory()
  const metrics = new Map(policies.map((p) => [p.id, emptyMetrics()]))
  const traces = new Map(policies.map((p) => [p.id, []]))

  for (const batch of batches(series.observation_stream)) {
    const prior = Object.freeze({ ...history })
    const classified = batch.events.map((event) => ({
      event,
      classified: classifyAtWindow(event, scenario.model_window_ms),
    }))

    // Strict-past semantics: all equal-timestamp events see the same prior
    // history. The whole batch is committed only after every decision.
    for (const row of classified) {
      for (const policy of policies) {
        const decision = policyDecision(policy, prior, row.event)
        updateMetrics(metrics.get(policy.id), decision, row.classified)
        traces.get(policy.id).push(Object.freeze({
          evidence_id_sha256: row.event.evidence_id_sha256,
          dispatch_at_ms: row.event.dispatch_at_ms,
          history_cutoff_exclusive_ms: row.event.dispatch_at_ms,
          prior_total_n: prior.total_n,
          prior_known_meet_n: prior.known_meet_n,
          prior_known_miss_n: prior.known_miss_n,
          prior_unknown_n: prior.unknown_n,
          prior_bounded_n: prior.bounded_n,
          current_context_bytes: row.event.context_bytes,
          current_context_inside_prior_range: contextInside(prior, row.event),
          decision,
          actual_outcome_at_window: row.classified.outcome,
          observed_cost_ms: row.classified.observed_cost_ms,
          cost_semantics: row.classified.cost_semantics,
        }))
      }
    }

    for (const row of classified) addHistory(history, row.event, row.classified)
  }

  const policyResults = policies.map((policy) => Object.freeze({
    policy,
    metrics: Object.freeze({ ...metrics.get(policy.id) }),
    decision_trace: Object.freeze(traces.get(policy.id)),
  }))

  const frontier = computeRuntimeCostPolicyParetoFrontier(
    policyResults.map((row) => ({
      policy_id: row.policy.id,
      metrics: row.metrics,
    })),
  )

  const withDominance = policyResults.map((row) => Object.freeze({
    ...row,
    dominated_by: Object.freeze(
      policyResults
        .filter((other) => other.policy.id !== row.policy.id)
        .filter((other) => dominatesMetrics(other.metrics, row.metrics))
        .map((other) => other.policy.id)
        .sort(),
    ),
  }))

  return Object.freeze({
    scenario,
    compatible_series: Object.freeze({
      identity: series.identity,
      identity_sha256: series.identity_sha256,
      evidence_sha256: series.evidence_sha256,
      observation_n: series.observation_n,
    }),
    replay_semantics:
      "strict-past-prequential-with-equal-timestamp-batching",
    policy_results: Object.freeze(withDominance),
    pareto_frontier_policy_ids: frontier,
  })
}

function result(payload) {
  const base = {
    protocol: RUNTIME_COST_PREQUENTIAL_REPLAY_PROTOCOL,
    authority: "shadow_observation",
    admission_authority: false,
    scheduling_authority: false,
    mutation_authority: false,
    policy_selection_authority: false,
    promotion_authority: false,
    ...payload,
  }
  return Object.freeze({
    ...base,
    content_sha256: sha256Canonical(base),
  })
}

export function runRuntimeCostPrequentialReplay(indexDocument, spec) {
  const verified = verifyRuntimeCostDeadlineIndexDocument(indexDocument)
  if (!verified.ok) {
    return result({
      status: "EVIDENCE_INSUFFICIENT",
      reason: "deadline_index_invalid",
      detail: verified.reason,
      normalized_spec: null,
      scenarios: Object.freeze([]),
    })
  }

  const normalized = normalizePrequentialReplaySpec(spec)
  if (!normalized.ok) {
    return result({
      status: "EVIDENCE_INSUFFICIENT",
      reason: normalized.reason,
      detail: normalized.detail ?? null,
      normalized_spec: null,
      scenarios: Object.freeze([]),
    })
  }

  try {
    let decisionCells = 0
    const scenarioRows = []

    for (const scenario of normalized.spec.scenarios) {
      const lookup = lookupRuntimeCostDeadlineSeries(
        indexDocument,
        scenario.identity,
      )
      if (!lookup.ok) {
        scenarioRows.push(Object.freeze({
          status: "EVIDENCE_INSUFFICIENT",
          reason: lookup.reason,
          scenario,
          policy_results: Object.freeze([]),
          pareto_frontier_policy_ids: Object.freeze([]),
        }))
        continue
      }

      decisionCells +=
        lookup.series.observation_stream.length *
        normalized.spec.policies.length
      if (decisionCells > MAX_DECISION_CELLS) {
        throw new Error("global decision cell budget exceeded")
      }

      scenarioRows.push(Object.freeze({
        status: "REPLAYED",
        reason: "strict_past_history_only",
        ...replayScenario(
          lookup.series,
          scenario,
          normalized.spec.policies,
        ),
      }))
    }

    return result({
      status: "REPLAYED",
      reason: "prequential_replay_complete",
      source_index_content_sha256: indexDocument.content_sha256,
      normalized_spec: normalized.spec,
      decision_cells: decisionCells,
      scenarios: Object.freeze(scenarioRows),
    })
  } catch (error) {
    return result({
      status: "EVIDENCE_INSUFFICIENT",
      reason: "replay_failed_closed",
      detail: String(error?.message ?? error),
      source_index_content_sha256: indexDocument.content_sha256,
      normalized_spec: normalized.spec,
      scenarios: Object.freeze([]),
    })
  }
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
  const indexPath = process.argv[2]
  const specPath = process.argv[3]
  const outputPath = process.argv[4]

  if (!indexPath || !specPath) {
    console.error(
      "usage: node runtime-cost-prequential-replay-v1.mjs " +
      "<deadline-index-json> <spec-json> [output-json]",
    )
    process.exitCode = 2
  } else {
    try {
      const indexDocument = await readJsonBounded(path.resolve(indexPath))
      const spec = await readJsonBounded(path.resolve(specPath))
      const replay = runRuntimeCostPrequentialReplay(indexDocument, spec)
      if (outputPath) {
        await writeFile(
          path.resolve(outputPath),
          JSON.stringify(replay, null, 2) + "\n",
          "utf8",
        )
      }
      console.log(JSON.stringify(replay, null, 2))
    } catch (error) {
      console.error(String(error?.stack ?? error))
      process.exitCode = 1
    }
  }
}
