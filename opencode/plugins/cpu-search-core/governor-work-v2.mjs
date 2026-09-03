export const GOVERNOR_WORK_PROTOCOL = "governor-work-v2"
export const GOVERNOR_WORK_PROFILE_PROTOCOL = "governor-work-profile-v1"
export const GOVERNOR_LEASE_PROTOCOL = "governor-inference-lease-v1"

// Jacobson/Karels estimator parameters. These are algorithm coefficients,
// not task-size or wall-clock policy limits.
const JACOBSON_ALPHA = 1 / 8
const JACOBSON_BETA = 1 / 4
const JACOBSON_K = 4
const P2_MARKERS = 5
const P2_QUANTILE = 0.95

function finitePositive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return 0
  }
}

function textFromMessages(messages) {
  if (!Array.isArray(messages)) return ""
  const parts = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    if (typeof message.text === "string") parts.push(message.text)
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text)
      }
    }
  }
  return parts.join("\n")
}

function requiredOperationCount(messages) {
  const text = textFromMessages(messages)
  const ids = new Set()
  for (const match of text.matchAll(/\bREQUIRED_OPERATION\s+id=([^\s]+)/g)) {
    ids.add(match[1])
  }
  return ids.size
}

function schemaStringBoundBytes(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return 0
  seen.add(value)

  let total = 0
  const maxLength = nonNegativeInteger(value.maxLength)
  if (maxLength != null) total += maxLength

  if (value.properties && typeof value.properties === "object") {
    for (const child of Object.values(value.properties)) {
      total += schemaStringBoundBytes(child, seen)
    }
  }

  if (value.items) {
    const perItem = schemaStringBoundBytes(value.items, seen)
    const maxItems = nonNegativeInteger(value.maxItems)
    total += maxItems != null ? perItem * maxItems : perItem
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(value[key])) continue
    const bounds = value[key].map((child) => schemaStringBoundBytes(child, seen))
    total += key === "allOf"
      ? bounds.reduce((a, b) => a + b, 0)
      : Math.max(0, ...bounds)
  }

  return total
}

function selectedToolSchema(tools, selectedTool) {
  if (!tools || typeof tools !== "object" || typeof selectedTool !== "string") {
    return null
  }
  return tools[selectedTool] ?? null
}

function capabilityPlanBoundBytes(additiveCapability) {
  return finitePositive(additiveCapability?.budgets?.max_plan_bytes)
}

export function initialP2Quantile(probability = P2_QUANTILE) {
  const p = Number(probability)
  return {
    probability: Number.isFinite(p) && p > 0 && p < 1 ? p : P2_QUANTILE,
    count: 0,
    bootstrap: [],
    q: null,
    n: null,
    np: null,
  }
}

function initializeP2(state) {
  const xs = [...state.bootstrap].sort((a, b) => a - b)
  if (xs.length < P2_MARKERS) return state
  const p = state.probability
  return {
    probability: p,
    count: xs.length,
    bootstrap: [],
    q: xs,
    n: [1, 2, 3, 4, 5],
    np: [1, 1 + 2 * p, 1 + 4 * p, 3 + 2 * p, 5],
  }
}

function parabolic(q, n, i, d) {
  const left = n[i] - n[i - 1]
  const right = n[i + 1] - n[i]
  const span = n[i + 1] - n[i - 1]
  if (left <= 0 || right <= 0 || span <= 0) return q[i]
  return q[i] + (d / span) * (
    (left + d) * (q[i + 1] - q[i]) / right +
    (right - d) * (q[i] - q[i - 1]) / left
  )
}

function linear(q, n, i, d) {
  const j = i + d
  const denominator = n[j] - n[i]
  if (denominator === 0) return q[i]
  return q[i] + d * (q[j] - q[i]) / denominator
}

export function observeP2Quantile(profile, sample) {
  const x = finitePositive(sample)
  const state = profile && typeof profile === "object"
    ? {
        probability: profile.probability,
        count: profile.count ?? 0,
        bootstrap: Array.isArray(profile.bootstrap) ? [...profile.bootstrap] : [],
        q: Array.isArray(profile.q) ? [...profile.q] : null,
        n: Array.isArray(profile.n) ? [...profile.n] : null,
        np: Array.isArray(profile.np) ? [...profile.np] : null,
      }
    : initialP2Quantile()

  if (x == null) return state

  if (!state.q || !state.n || !state.np) {
    state.bootstrap.push(x)
    state.count = state.bootstrap.length
    return state.bootstrap.length >= P2_MARKERS ? initializeP2(state) : state
  }

  const q = state.q
  const n = state.n
  const np = state.np
  const p = state.probability
  let k

  if (x < q[0]) { q[0] = x; k = 0 }
  else if (x < q[1]) k = 0
  else if (x < q[2]) k = 1
  else if (x < q[3]) k = 2
  else if (x <= q[4]) k = 3
  else { q[4] = x; k = 3 }

  for (let i = k + 1; i < P2_MARKERS; i += 1) n[i] += 1

  const increments = [0, p / 2, p, (1 + p) / 2, 1]
  for (let i = 0; i < P2_MARKERS; i += 1) np[i] += increments[i]

  for (let i = 1; i <= 3; i += 1) {
    const d = np[i] - n[i]
    const direction = d >= 1 ? 1 : d <= -1 ? -1 : 0
    if (direction === 0) continue
    if (
      (direction > 0 && n[i + 1] - n[i] <= 1) ||
      (direction < 0 && n[i - 1] - n[i] >= -1)
    ) continue

    const candidate = parabolic(q, n, i, direction)
    q[i] = q[i - 1] < candidate && candidate < q[i + 1]
      ? candidate
      : linear(q, n, i, direction)
    n[i] += direction
  }

  state.count += 1
  return state
}

export function p2QuantileValue(profile) {
  if (!profile || typeof profile !== "object") return null
  if (Array.isArray(profile.q) && profile.q.length === P2_MARKERS) {
    return finitePositive(profile.q[2])
  }
  if (Array.isArray(profile.bootstrap) && profile.bootstrap.length > 0) {
    const xs = [...profile.bootstrap].sort((a, b) => a - b)
    const index = Math.min(
      xs.length - 1,
      Math.max(0, Math.ceil(profile.probability * xs.length) - 1),
    )
    return finitePositive(xs[index])
  }
  return null
}

export function initialGovernorWorkProfile() {
  return {
    protocol: GOVERNOR_WORK_PROFILE_PROTOCOL,
    samples: 0,
    srtt_ms_per_byte: null,
    rttvar_ms_per_byte: null,
    p95_ms_per_byte: initialP2Quantile(P2_QUANTILE),
    last_observed_ms: null,
    last_work_bytes: null,
  }
}

export function observeGovernorWork(profile, { elapsedMs, workBytes } = {}) {
  const elapsed = finitePositive(elapsedMs)
  const work = finitePositive(workBytes)
  const current = profile?.protocol === GOVERNOR_WORK_PROFILE_PROTOCOL
    ? profile
    : initialGovernorWorkProfile()
  if (elapsed == null || work == null) return current

  const sample = elapsed / work
  let srtt = finitePositive(current.srtt_ms_per_byte)
  let variance = finitePositive(current.rttvar_ms_per_byte)

  if (srtt == null) {
    srtt = sample
    variance = sample / 2
  } else {
    const error = Math.abs(srtt - sample)
    variance =
      (1 - JACOBSON_BETA) * (variance ?? error) +
      JACOBSON_BETA * error
    srtt =
      (1 - JACOBSON_ALPHA) * srtt +
      JACOBSON_ALPHA * sample
  }

  return {
    protocol: GOVERNOR_WORK_PROFILE_PROTOCOL,
    samples: (current.samples ?? 0) + 1,
    srtt_ms_per_byte: srtt,
    rttvar_ms_per_byte: variance,
    p95_ms_per_byte: observeP2Quantile(current.p95_ms_per_byte, sample),
    last_observed_ms: elapsed,
    last_work_bytes: work,
  }
}

export function governorUpperMsPerByte(profile) {
  if (profile?.protocol !== GOVERNOR_WORK_PROFILE_PROTOCOL) return null
  const srtt = finitePositive(profile.srtt_ms_per_byte)
  const variance = finitePositive(profile.rttvar_ms_per_byte)
  const tail = p2QuantileValue(profile.p95_ms_per_byte)
  const jacobson = srtt == null
    ? null
    : srtt + JACOBSON_K * (variance ?? srtt / 2)
  return Math.max(0, jacobson ?? 0, tail ?? 0) || null
}

export function estimateGovernorDispatchWork({
  system,
  messages,
  tools,
  selectedTool,
  additiveCapability = null,
} = {}) {
  const systemBytes = jsonBytes(system)
  const messageBytes = jsonBytes(messages)
  const toolBytes = jsonBytes(tools)
  const inputBytes = systemBytes + messageBytes + toolBytes
  const operations = requiredOperationCount(messages)

  // Structural limits and expected generation are intentionally separate.
  // max_plan_bytes / schema maxLength are acceptance rails, not work demand.
  const capabilityCeiling =
    capabilityPlanBoundBytes(additiveCapability)
  const schemaCeiling =
    schemaStringBoundBytes(
      selectedToolSchema(tools, selectedTool),
    )

  const ceilingCandidates = [
    capabilityCeiling,
    schemaCeiling > 0 ? schemaCeiling : null,
  ].filter((value) => value != null)

  const outputCeilingBytes =
    ceilingCandidates.length > 0
      ? Math.min(...ceilingCandidates)
      : null

  const outputCeilingSource =
    capabilityCeiling != null && schemaCeiling > 0
      ? "min_sealed_capability_max_plan_bytes_tool_schema_structural_bound"
      : capabilityCeiling != null
        ? "sealed_capability_max_plan_bytes"
        : schemaCeiling > 0
          ? "tool_schema_structural_bound"
          : null

  // Zero-invented-constant expectation proxy: use already-observed
  // model-facing surfaces until provider-side decode telemetry exists.
  const uncappedExpectedOutputBytes =
    Math.max(messageBytes, toolBytes)

  const expectedOutputBytes =
    outputCeilingBytes != null
      ? Math.min(
          uncappedExpectedOutputBytes,
          outputCeilingBytes,
        )
      : uncappedExpectedOutputBytes

  const semanticPhase =
    operations > 0 &&
    typeof selectedTool === "string" &&
    selectedTool.length > 0

  const expectedOutputSourceBase =
    semanticPhase
      ? "semantic_model_facing_surface_proxy"
      : "model_facing_surface_proxy"

  const expectedOutputSource =
    outputCeilingBytes != null &&
    expectedOutputBytes < uncappedExpectedOutputBytes
      ? `${expectedOutputSourceBase}_capped_by_safety_ceiling`
      : expectedOutputSourceBase

  const prefillBytes = inputBytes
  const decodeExpectedBytes = expectedOutputBytes

  return {
    protocol: GOVERNOR_WORK_PROTOCOL,

    // Compatibility fields consumed by the current trace/harness.
    // They now represent expected output work, never a physical maximum.
    output_bound_bytes: expectedOutputBytes,
    output_bound_source: expectedOutputSource,

    input_bytes: inputBytes,
    system_bytes: systemBytes,
    message_bytes: messageBytes,
    tool_bytes: toolBytes,

    // Explicit dimensions for a future provider-specific prefill/decode model.
    prefill_bytes: prefillBytes,
    expected_output_bytes: expectedOutputBytes,
    expected_output_source: expectedOutputSource,
    decode_expected_bytes: decodeExpectedBytes,

    // Safety-only rails.
    output_ceiling_bytes: outputCeilingBytes,
    output_ceiling_source: outputCeilingSource,
    decode_ceiling_bytes: outputCeilingBytes,

    required_operations: operations,
    work_bytes: prefillBytes + decodeExpectedBytes,
    work_model_separated: true,
    mutation_authority: false,
  }
}

export function deriveGovernorInferenceLease({
  profile,
  work,
  bootstrapLeaseMs,
  legacyReserveMs = 0,
} = {}) {
  const workBytes = finitePositive(work?.work_bytes)
  const bootstrap = finitePositive(bootstrapLeaseMs) ?? 0
  const legacy = finitePositive(legacyReserveMs) ?? 0
  const upper = governorUpperMsPerByte(profile)

  let adaptive = 0
  let source = "bootstrap"
  if (workBytes != null && upper != null) {
    adaptive = Math.ceil(workBytes * upper)
    source = "jacobson_p2_work_normalized"
  }

  return {
    protocol: GOVERNOR_LEASE_PROTOCOL,
    lease_ms: Math.max(bootstrap, legacy, adaptive),
    source,
    work_bytes: workBytes ?? 0,
    upper_ms_per_byte: upper,
    profile_samples: profile?.samples ?? 0,
    srtt_ms_per_byte: profile?.srtt_ms_per_byte ?? null,
    rttvar_ms_per_byte: profile?.rttvar_ms_per_byte ?? null,
    p95_ms_per_byte: p2QuantileValue(profile?.p95_ms_per_byte),
    bootstrap_ms: bootstrap,
    legacy_reserve_ms: legacy,
    mutation_authority: false,
  }
}

export function adaptiveGovernorWindows({
  nowMs,
  taskStartedAt,
  phaseStartedAt,
  basePhaseBudgetMs,
  baseTaskBudgetMs,
  inferenceLeaseMs,
} = {}) {
  const now = finitePositive(nowMs) ?? 0
  const taskStarted = finitePositive(taskStartedAt) ?? now
  const phaseStarted = finitePositive(phaseStartedAt) ?? now
  const basePhase = finitePositive(basePhaseBudgetMs) ?? 0
  const baseTask = finitePositive(baseTaskBudgetMs) ?? 0
  const lease = finitePositive(inferenceLeaseMs) ?? 0
  const taskElapsed = Math.max(0, now - taskStarted)
  const phaseElapsed = Math.max(0, now - phaseStarted)

  return {
    phase_budget_ms: Math.ceil(Math.max(basePhase, phaseElapsed + lease)),
    task_budget_ms: Math.ceil(Math.max(baseTask, taskElapsed + lease)),
    phase_elapsed_ms: phaseElapsed,
    task_elapsed_ms: taskElapsed,
    lease_ms: lease,
  }
}
