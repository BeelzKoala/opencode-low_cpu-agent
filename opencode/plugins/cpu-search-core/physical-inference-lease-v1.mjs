import { parseLlamaSlots } from "./physical-inference-correlation-v1.mjs"

export const PHYSICAL_INFERENCE_LEASE_PROTOCOL =
  "physical-inference-lease-v1"
export const PHYSICAL_INFERENCE_QUIESCENCE_PROTOCOL =
  "provider-quiescence-proof-v1"

const DEFAULT_HARD_LEASE_MS = 75_000
const DEFAULT_METRICS_URL = "http://127.0.0.1:8080/metrics"
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 350
const DEFAULT_QUIESCENCE_GRACE_MS = 5_000
const DEFAULT_QUIESCENCE_POLL_MS = 100
const DEFAULT_REQUIRED_ZERO_SAMPLES = 2
const DEFAULT_STALL_THRESHOLD_MS = 60_000
const DEFAULT_STALL_POLL_MS = 5_000
const MIN_STALL_THRESHOLD_MS = 1_000
const MAX_STALL_THRESHOLD_MS = 5 * 60_000
const MIN_STALL_POLL_MS = 100
const MAX_STALL_POLL_MS = 30_000
const MIN_HARD_LEASE_MS = 1_000
const MAX_HARD_LEASE_MS = 10 * 60_000
const MAX_QUIESCENCE_GRACE_MS = 30_000

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fallback
  }
  return parsed
}

function leaseKey(sessionID, turnID) {
  if (typeof sessionID !== "string" || sessionID.length < 1) return null
  if (typeof turnID !== "string" || turnID.length < 1) return null
  return `${sessionID}\u0000${turnID}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function timeoutSignal(ms) {
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    return AbortSignal.timeout(Math.max(1, ms))
  }
  return undefined
}

export function physicalInferenceLeaseDefaults(env = process.env) {
  return Object.freeze({
    hard_lease_ms: positiveInt(
      env?.OPENCODE_CPU_PHYSICAL_INFERENCE_HARD_LEASE_MS,
      DEFAULT_HARD_LEASE_MS,
      MIN_HARD_LEASE_MS,
      MAX_HARD_LEASE_MS,
    ),
    metrics_url:
      typeof env?.OPENCODE_CPU_PROVIDER_METRICS_URL === "string" &&
      env.OPENCODE_CPU_PROVIDER_METRICS_URL.trim().length > 0
        ? env.OPENCODE_CPU_PROVIDER_METRICS_URL.trim()
        : DEFAULT_METRICS_URL,
    preflight_timeout_ms: positiveInt(
      env?.OPENCODE_CPU_PROVIDER_PREFLIGHT_TIMEOUT_MS,
      DEFAULT_PREFLIGHT_TIMEOUT_MS,
      50,
      5_000,
    ),
    quiescence_grace_ms: positiveInt(
      env?.OPENCODE_CPU_PROVIDER_QUIESCENCE_GRACE_MS,
      DEFAULT_QUIESCENCE_GRACE_MS,
      100,
      MAX_QUIESCENCE_GRACE_MS,
    ),
    quiescence_poll_ms: positiveInt(
      env?.OPENCODE_CPU_PROVIDER_QUIESCENCE_POLL_MS,
      DEFAULT_QUIESCENCE_POLL_MS,
      10,
      2_000,
    ),
    required_zero_samples: positiveInt(
      env?.OPENCODE_CPU_PROVIDER_REQUIRED_ZERO_SAMPLES,
      DEFAULT_REQUIRED_ZERO_SAMPLES,
      1,
      5,
    ),
    stall_threshold_ms: positiveInt(
      env?.OPENCODE_CPU_INFERENCE_STALL_THRESHOLD_MS,
      DEFAULT_STALL_THRESHOLD_MS,
      MIN_STALL_THRESHOLD_MS,
      MAX_STALL_THRESHOLD_MS,
    ),
    stall_poll_ms: positiveInt(
      env?.OPENCODE_CPU_INFERENCE_STALL_POLL_MS,
      DEFAULT_STALL_POLL_MS,
      MIN_STALL_POLL_MS,
      MAX_STALL_POLL_MS,
    ),
  })
}

export function parseLlamaQuiescenceMetrics(text) {
  const body = String(text ?? "")
  const processingMatch = body.match(
    /^llamacpp:requests_processing\s+([0-9]+(?:\.[0-9]+)?)\s*$/mu,
  )
  const deferredMatch = body.match(
    /^llamacpp:requests_deferred\s+([0-9]+(?:\.[0-9]+)?)\s*$/mu,
  )
  if (!processingMatch || !deferredMatch) {
    return Object.freeze({
      ok: false,
      reason: "provider_metrics_shape_unrecognized",
      processing: null,
      deferred: null,
      quiescent: false,
      mutation_authority: false,
    })
  }

  const processing = Number(processingMatch[1])
  const deferred = Number(deferredMatch[1])
  if (!Number.isFinite(processing) || !Number.isFinite(deferred)) {
    return Object.freeze({
      ok: false,
      reason: "provider_metrics_value_invalid",
      processing: null,
      deferred: null,
      quiescent: false,
      mutation_authority: false,
    })
  }

  return Object.freeze({
    ok: true,
    reason: null,
    processing,
    deferred,
    quiescent: processing === 0 && deferred === 0,
    mutation_authority: false,
  })
}

export async function sampleProviderQuiescence({
  fetchImpl = globalThis.fetch,
  metricsUrl = DEFAULT_METRICS_URL,
  timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return Object.freeze({
      ok: false,
      reason: "provider_metrics_fetch_unavailable",
      processing: null,
      deferred: null,
      quiescent: false,
      mutation_authority: false,
    })
  }

  try {
    const response = await fetchImpl(metricsUrl, {
      method: "GET",
      cache: "no-store",
      signal: timeoutSignal(timeoutMs),
    })
    if (!response || response.ok !== true || typeof response.text !== "function") {
      return Object.freeze({
        ok: false,
        reason: "provider_metrics_http_failure",
        status: Number.isInteger(response?.status) ? response.status : null,
        processing: null,
        deferred: null,
        quiescent: false,
        mutation_authority: false,
      })
    }
    const parsed = parseLlamaQuiescenceMetrics(await response.text())
    return Object.freeze({
      ...parsed,
      status: Number.isInteger(response.status) ? response.status : 200,
      metrics_url: metricsUrl,
      mutation_authority: false,
    })
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: "provider_metrics_fetch_failed",
      error: String(error?.message ?? error),
      processing: null,
      deferred: null,
      quiescent: false,
      metrics_url: metricsUrl,
      mutation_authority: false,
    })
  }
}

export async function proveProviderQuiescence({
  fetchImpl = globalThis.fetch,
  metricsUrl = DEFAULT_METRICS_URL,
  graceMs = DEFAULT_QUIESCENCE_GRACE_MS,
  pollMs = DEFAULT_QUIESCENCE_POLL_MS,
  requiredZeroSamples = DEFAULT_REQUIRED_ZERO_SAMPLES,
  sampleTimeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
  nowFn = Date.now,
  sleepFn = sleep,
} = {}) {
  const start = nowFn()
  let attempts = 0
  let consecutiveZero = 0
  let last = null

  while (true) {
    attempts += 1
    last = await sampleProviderQuiescence({
      fetchImpl,
      metricsUrl,
      timeoutMs: sampleTimeoutMs,
    })

    if (last.ok === true && last.quiescent === true) {
      consecutiveZero += 1
      if (consecutiveZero >= requiredZeroSamples) {
        return Object.freeze({
          ok: true,
          protocol: PHYSICAL_INFERENCE_QUIESCENCE_PROTOCOL,
          reason: "provider_quiescence_proven",
          proven: true,
          attempts,
          consecutive_zero_samples: consecutiveZero,
          elapsed_ms: Math.max(0, nowFn() - start),
          processing: last.processing,
          deferred: last.deferred,
          metrics_url: metricsUrl,
          mutation_authority: false,
        })
      }
    } else {
      consecutiveZero = 0
    }

    const elapsed = Math.max(0, nowFn() - start)
    if (elapsed >= graceMs) {
      return Object.freeze({
        ok: false,
        protocol: PHYSICAL_INFERENCE_QUIESCENCE_PROTOCOL,
        reason:
          last?.ok === true
            ? "provider_quiescence_not_reached"
            : last?.reason ?? "provider_quiescence_unobserved",
        proven: false,
        attempts,
        consecutive_zero_samples: consecutiveZero,
        elapsed_ms: elapsed,
        processing: last?.processing ?? null,
        deferred: last?.deferred ?? null,
        metrics_url: metricsUrl,
        mutation_authority: false,
      })
    }

    await sleepFn(Math.min(pollMs, Math.max(0, graceMs - elapsed)))
  }
}

export function createPhysicalInferenceLeaseController({
  env = process.env,
  hardLeaseMs = null,
  metricsUrl = null,
  slotsUrl = null,
  preflightTimeoutMs = null,
  quiescenceGraceMs = null,
  quiescencePollMs = null,
  requiredZeroSamples = null,
  stallThresholdMs = null,
  stallPollMs = null,
  fetchImpl = globalThis.fetch,
  nowFn = Date.now,
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  sleepFn = sleep,
} = {}) {
  const defaults = physicalInferenceLeaseDefaults(env)
  const config = Object.freeze({
    hard_lease_ms: positiveInt(
      hardLeaseMs,
      defaults.hard_lease_ms,
      MIN_HARD_LEASE_MS,
      MAX_HARD_LEASE_MS,
    ),
    metrics_url:
      typeof metricsUrl === "string" && metricsUrl.length > 0
        ? metricsUrl
        : defaults.metrics_url,
    preflight_timeout_ms: positiveInt(
      preflightTimeoutMs,
      defaults.preflight_timeout_ms,
      50,
      5_000,
    ),
    quiescence_grace_ms: positiveInt(
      quiescenceGraceMs,
      defaults.quiescence_grace_ms,
      100,
      MAX_QUIESCENCE_GRACE_MS,
    ),
    quiescence_poll_ms: positiveInt(
      quiescencePollMs,
      defaults.quiescence_poll_ms,
      10,
      2_000,
    ),
    required_zero_samples: positiveInt(
      requiredZeroSamples,
      defaults.required_zero_samples,
      1,
      5,
    ),
    stall_threshold_ms: positiveInt(
      stallThresholdMs,
      defaults.stall_threshold_ms,
      MIN_STALL_THRESHOLD_MS,
      MAX_STALL_THRESHOLD_MS,
    ),
    stall_poll_ms: positiveInt(
      stallPollMs,
      defaults.stall_poll_ms,
      MIN_STALL_POLL_MS,
      MAX_STALL_POLL_MS,
    ),
    slots_url: (() => {
      if (typeof slotsUrl === "string" && slotsUrl.length > 0) return slotsUrl
      const explicit =
        env?.OPENCODE_CPU_TELEMETRY_LLAMA_SLOTS_URL ??
        env?.OPENCODE_CPU_PROVIDER_SLOTS_URL
      if (typeof explicit === "string" && explicit.trim().length > 0) {
        return explicit.trim()
      }
      try {
        const url = new URL(
          typeof metricsUrl === "string" && metricsUrl.length > 0
            ? metricsUrl
            : defaults.metrics_url,
        )
        if (/\/metrics\/?$/u.test(url.pathname)) {
          url.pathname = url.pathname.replace(/\/metrics\/?$/u, "/slots")
          url.search = ""
          url.hash = ""
          return url.toString()
        }
      } catch {
        return null
      }
      return null
    })(),
  })

  const active = new Map()
  const failures = new Map()

  async function emit(record, event) {
    if (typeof record?.onEvent !== "function") return
    try {
      await record.onEvent(Object.freeze({
        protocol: PHYSICAL_INFERENCE_LEASE_PROTOCOL,
        sessionID: record.sessionID,
        turnID: record.turnID,
        model_call: record.modelCall,
        providerID: record.providerID,
        modelID: record.modelID,
        hard_lease_ms: record.hardLeaseMs ?? config.hard_lease_ms,
        mutation_authority: false,
        ...event,
      }))
    } catch {
      // Telemetry must never weaken cancellation.
    }
  }

  function terminalize(record, row) {
    const key = leaseKey(record.sessionID, record.turnID)
    if (!key) return null
    const terminal = Object.freeze({
      protocol: PHYSICAL_INFERENCE_LEASE_PROTOCOL,
      sessionID: record.sessionID,
      turnID: record.turnID,
      model_call: record.modelCall,
      providerID: record.providerID,
      modelID: record.modelID,
      hard_lease_ms: record.hardLeaseMs ?? config.hard_lease_ms,
      mutation_authority: false,
      ...row,
    })
    failures.set(key, terminal)
    return terminal
  }

  async function expire(record, cause = "hard_lease") {
    const key = leaseKey(record.sessionID, record.turnID)
    if (!key || active.get(key) !== record) return
    active.delete(key)
    clearTimerFn(record.timer)
    if (record.progressTimer != null) {
      clearIntervalFn(record.progressTimer)
      record.progressTimer = null
    }

    if (typeof record.isCurrent === "function") {
      let current = false
      try {
        current = record.isCurrent() === true
      } catch {
        current = false
      }
      if (!current) {
        await emit(record, {
          kind: "physical_inference_lease_completed",
          reason: "dispatch_superseded_before_deadline",
          elapsed_ms: Math.max(0, nowFn() - record.startedAt),
          quiescence_proven: null,
        })
        return
      }
    }

    await emit(record, {
      kind:
        cause === "stall"
          ? "physical_inference_stall_detected"
          : "physical_inference_lease_expired",
      reason:
        cause === "stall"
          ? "stall_threshold_reached"
          : "hard_lease_deadline_reached",
      elapsed_ms: Math.max(0, nowFn() - record.startedAt),
      stall_threshold_ms:
        cause === "stall" ? config.stall_threshold_ms : null,
      last_progress_at_ms: record.lastProgressAt ?? null,
      exact_progress_observed: record.exactProgressObserved === true,
    })

    // The public OpenCode completion/event stream can lag behind the provider.
    // Before interrupting, cheaply ask the provider whether inference is still
    // physically active. An already-idle backend means the model completed and
    // only host bookkeeping is late; do not kill tool execution in that case.
    const boundary = await sampleProviderQuiescence({
      fetchImpl,
      metricsUrl: config.metrics_url,
      timeoutMs: config.preflight_timeout_ms,
    })
    if (boundary.ok === true && boundary.quiescent === true) {
      await emit(record, {
        kind: "physical_inference_lease_completed",
        reason: "provider_idle_at_deadline_boundary",
        elapsed_ms: Math.max(0, nowFn() - record.startedAt),
        processing: boundary.processing,
        deferred: boundary.deferred,
        quiescence_proven: true,
      })
      return
    }

    let interruptError = null
    try {
      await record.interrupt()
    } catch (error) {
      interruptError = String(error?.message ?? error)
    }

    await emit(record, {
      kind: "physical_inference_interrupt_result",
      reason:
        interruptError == null
          ? "session_interrupt_completed"
          : "session_interrupt_failed",
      interrupt_ok: interruptError == null,
      interrupt_error: interruptError,
    })

    if (interruptError != null) {
      const terminal = terminalize(record, {
        kind: "physical_inference_lease_terminal",
        reason: "physical_inference_interrupt_failed",
        quiescence_proven: false,
        interrupt_ok: false,
        interrupt_error: interruptError,
      })
      await emit(record, terminal)
      return
    }

    const proof = await proveProviderQuiescence({
      fetchImpl,
      metricsUrl: config.metrics_url,
      graceMs: config.quiescence_grace_ms,
      pollMs: config.quiescence_poll_ms,
      requiredZeroSamples: config.required_zero_samples,
      sampleTimeoutMs: config.preflight_timeout_ms,
      nowFn,
      sleepFn,
    })

    await emit(record, {
      kind: "physical_inference_quiescence",
      reason: proof.reason,
      quiescence_proven: proof.proven === true,
      quiescence_attempts: proof.attempts,
      quiescence_elapsed_ms: proof.elapsed_ms,
      consecutive_zero_samples: proof.consecutive_zero_samples,
      processing: proof.processing,
      deferred: proof.deferred,
    })

    const terminal = terminalize(record, {
      kind: "physical_inference_lease_terminal",
      reason:
        proof.proven === true
          ? (
              cause === "stall"
                ? "physical_inference_stall_exceeded"
                : "physical_inference_hard_lease_exceeded"
            )
          : "physical_inference_quiescence_unproven",
      quiescence_proven: proof.proven === true,
      interrupt_ok: true,
      quiescence_attempts: proof.attempts,
      quiescence_elapsed_ms: proof.elapsed_ms,
    })
    await emit(record, terminal)
  }

  async function sampleOwnedProgress(record) {
    const key = leaseKey(record?.sessionID, record?.turnID)
    if (!key || active.get(key) !== record) {
      return Object.freeze({
        ok: false,
        reason: "physical_inference_active_lease_missing",
        stall_authority: false,
        mutation_authority: false,
      })
    }
    if (
      active.size !== 1 ||
      typeof config.slots_url !== "string" ||
      config.slots_url.length < 1 ||
      typeof fetchImpl !== "function"
    ) {
      record.stallAuthority = false
      return Object.freeze({
        ok: true,
        reason: "stall_progress_authority_unavailable",
        stall_authority: false,
        exact_progress_observed: record.exactProgressObserved === true,
        mutation_authority: false,
      })
    }

    let slots
    try {
      const signal = timeoutSignal(config.preflight_timeout_ms)
      const response = await fetchImpl(config.slots_url, {
        method: "GET",
        ...(signal ? { signal } : {}),
      })
      if (!response?.ok || typeof response.json !== "function") throw new Error("slots_unavailable")
      slots = parseLlamaSlots(await response.json())
    } catch {
      record.stallAuthority = false
      return Object.freeze({
        ok: true,
        reason: "stall_progress_probe_unavailable",
        stall_authority: false,
        exact_progress_observed: record.exactProgressObserved === true,
        mutation_authority: false,
      })
    }

    const processing = slots.filter((row) => row?.is_processing === true)
    if (processing.length !== 1) {
      record.stallAuthority = false
      return Object.freeze({
        ok: true,
        reason:
          processing.length === 0
            ? "stall_progress_no_processing_slot"
            : "stall_progress_ambiguous_processing_slots",
        processing_slots: processing.length,
        stall_authority: false,
        exact_progress_observed: record.exactProgressObserved === true,
        mutation_authority: false,
      })
    }

    const slot = processing[0]
    const prompt = Number.isSafeInteger(slot.n_prompt_tokens_processed)
      ? slot.n_prompt_tokens_processed
      : null
    const decoded = Number.isSafeInteger(slot.n_decoded)
      ? slot.n_decoded
      : null
    if (prompt == null && decoded == null) {
      record.stallAuthority = false
      return Object.freeze({
        ok: true,
        reason: "stall_progress_exact_counters_unavailable",
        stall_authority: false,
        exact_progress_observed: record.exactProgressObserved === true,
        mutation_authority: false,
      })
    }

    const identity = `${slot.id}:${slot.id_task ?? "unknown"}`
    const value = Math.max(0, prompt ?? 0) + Math.max(0, decoded ?? 0)
    const now = nowFn()
    const changedIdentity = record.progressIdentity !== identity
    const advanced = record.progressValue == null || value > record.progressValue

    if (changedIdentity || advanced) {
      record.progressIdentity = identity
      record.progressValue = value
      record.lastProgressAt = now
      record.exactProgressObserved = true
      record.stallAuthority = true
      await emit(record, {
        kind: "physical_inference_progress",
        reason: changedIdentity
          ? "owned_slot_identity_progress"
          : "owned_slot_counter_progress",
        stall_authority: true,
        exact_progress_observed: true,
        correlated_slot_id: slot.id ?? null,
        correlated_task_id: slot.id_task ?? null,
        prompt_tokens_processed: prompt,
        decoded_tokens: decoded,
        last_progress_at_ms: now,
      })
      return Object.freeze({
        ok: true,
        reason: "owned_slot_progress_observed",
        stall_authority: true,
        exact_progress_observed: true,
        last_progress_at_ms: now,
        mutation_authority: false,
      })
    }

    const gap = Number.isFinite(record.lastProgressAt)
      ? Math.max(0, now - record.lastProgressAt)
      : null
    if (
      record.exactProgressObserved === true &&
      record.stallAuthority === true &&
      gap != null &&
      gap >= config.stall_threshold_ms
    ) {
      await expire(record, "stall")
      return Object.freeze({
        ok: false,
        reason: "physical_inference_stall_threshold_reached",
        interrupted: true,
        stall_authority: true,
        exact_progress_observed: true,
        stall_elapsed_ms: gap,
        stall_threshold_ms: config.stall_threshold_ms,
        mutation_authority: false,
      })
    }

    return Object.freeze({
      ok: true,
      reason: "owned_slot_no_new_progress_below_threshold",
      stall_authority: record.stallAuthority === true,
      exact_progress_observed: record.exactProgressObserved === true,
      stall_elapsed_ms: gap,
      stall_threshold_ms: config.stall_threshold_ms,
      mutation_authority: false,
    })
  }

  async function pollProgress({ sessionID, turnID } = {}) {
    const key = leaseKey(sessionID, turnID)
    const record = key ? active.get(key) ?? null : null
    if (!record) {
      return Object.freeze({
        ok: false,
        reason: "physical_inference_active_lease_missing",
        mutation_authority: false,
      })
    }
    return sampleOwnedProgress(record)
  }

  async function preflight({ interrupt } = {}) {
    if (typeof interrupt !== "function") {
      return Object.freeze({
        ok: false,
        protocol: PHYSICAL_INFERENCE_LEASE_PROTOCOL,
        reason: "physical_inference_interrupt_unavailable",
        hard_lease_ms: config.hard_lease_ms,
        mutation_authority: false,
      })
    }

    // Pre-dispatch admission is ownership-local. Global provider quiescence is
    // not a valid prerequisite here: this hook can run after OpenCode has
    // already entered the provider lifecycle, so requests_processing may
    // legitimately include the very request being admitted. Requiring global
    // idle at this boundary creates a self-blocking causal cycle.
    //
    // Backend quiescence remains authoritative only after a hard-lease
    // interrupt, where it proves that the owned physical inference actually
    // terminated before the task can progress or terminalize.
    return Object.freeze({
      ok: true,
      protocol: PHYSICAL_INFERENCE_LEASE_PROTOCOL,
      reason: "physical_inference_preflight_ready",
      hard_lease_ms: config.hard_lease_ms,
      metrics_url: config.metrics_url,
      attempts: 0,
      elapsed_ms: 0,
      consecutive_zero_samples: 0,
      processing: null,
      deferred: null,
      predispatch_authority: "owned_lease_state_only",
      quiescence_required_before_dispatch: false,
      quiescence_role: "post_interrupt_confirmation_only",
      mutation_authority: false,
    })
  }

  function failure({ sessionID, turnID } = {}) {
    const key = leaseKey(sessionID, turnID)
    return key ? failures.get(key) ?? null : null
  }

  function arm({
    sessionID,
    turnID,
    modelCall,
    hardLeaseMs = null,
    providerID = null,
    modelID = null,
    interrupt,
    isCurrent = null,
    onEvent = null,
  } = {}) {
    const key = leaseKey(sessionID, turnID)
    if (!key) {
      return Object.freeze({
        ok: false,
        reason: "physical_inference_identity_invalid",
        mutation_authority: false,
      })
    }
    if (!Number.isSafeInteger(modelCall) || modelCall < 1) {
      return Object.freeze({
        ok: false,
        reason: "physical_inference_model_call_invalid",
        mutation_authority: false,
      })
    }
    if (typeof interrupt !== "function") {
      return Object.freeze({
        ok: false,
        reason: "physical_inference_interrupt_unavailable",
        mutation_authority: false,
      })
    }
    const priorFailure = failures.get(key)
    if (priorFailure) {
      return Object.freeze({
        ok: false,
        reason: priorFailure.reason,
        terminal: priorFailure,
        mutation_authority: false,
      })
    }

    const prior = active.get(key)
    if (prior) {
      if (prior.modelCall >= modelCall) {
        return Object.freeze({
          ok: false,
          reason: "physical_inference_active_lease_conflict",
          active_model_call: prior.modelCall,
          mutation_authority: false,
        })
      }
      clearTimerFn(prior.timer)
      if (prior.progressTimer != null) clearIntervalFn(prior.progressTimer)
      active.delete(key)
      void emit(prior, {
        kind: "physical_inference_lease_completed",
        reason: "next_dispatch_proves_prior_completion",
        elapsed_ms: Math.max(0, nowFn() - prior.startedAt),
        quiescence_proven: null,
      })
    }

    const effectiveHardLeaseMs = positiveInt(
      hardLeaseMs,
      config.hard_lease_ms,
      MIN_HARD_LEASE_MS,
      MAX_HARD_LEASE_MS,
    )

    const record = {
      sessionID,
      turnID,
      modelCall,
      hardLeaseMs: effectiveHardLeaseMs,
      providerID,
      modelID,
      interrupt,
      isCurrent,
      onEvent,
      startedAt: nowFn(),
      timer: null,
      progressTimer: null,
      progressIdentity: null,
      progressValue: null,
      lastProgressAt: null,
      exactProgressObserved: false,
      stallAuthority: false,
    }
    const callback = () => expire(record, "hard_lease")
    record.timer = setTimerFn(callback, effectiveHardLeaseMs)
    record.timer?.unref?.()
    active.set(key, record)
    if (typeof config.slots_url === "string" && config.slots_url.length > 0) {
      record.progressTimer = setIntervalFn(
        () => { void sampleOwnedProgress(record) },
        config.stall_poll_ms,
      )
      record.progressTimer?.unref?.()
    }

    return Object.freeze({
      ok: true,
      protocol: PHYSICAL_INFERENCE_LEASE_PROTOCOL,
      reason: "physical_inference_hard_lease_armed",
      model_call: modelCall,
      hard_lease_ms: effectiveHardLeaseMs,
        default_hard_lease_ms: config.hard_lease_ms,
        lease_policy_authority: "caller_governor_or_default",
      metrics_url: config.metrics_url,
      slots_url: config.slots_url,
      stall_interrupt_armed:
        typeof config.slots_url === "string" && config.slots_url.length > 0,
      stall_threshold_ms: config.stall_threshold_ms,
      stall_poll_ms: config.stall_poll_ms,
      stall_authority: "owned_singleton_slot_monotonic_counters_only",
      mutation_authority: false,
    })
  }

  function complete({ sessionID, turnID, modelCall = null, reason = "model_completed" } = {}) {
    const key = leaseKey(sessionID, turnID)
    if (!key) return Object.freeze({ completed: false, reason: "identity_invalid" })
    const record = active.get(key)
    if (!record) {
      return Object.freeze({
        completed: false,
        reason: failures.has(key) ? "already_terminal" : "no_active_lease",
      })
    }
    if (modelCall != null && modelCall !== record.modelCall) {
      return Object.freeze({
        completed: false,
        reason: "model_call_mismatch",
        active_model_call: record.modelCall,
      })
    }
    clearTimerFn(record.timer)
    if (record.progressTimer != null) clearIntervalFn(record.progressTimer)
    active.delete(key)
    return Object.freeze({
      completed: true,
      protocol: PHYSICAL_INFERENCE_LEASE_PROTOCOL,
      reason,
      model_call: record.modelCall,
      elapsed_ms: Math.max(0, nowFn() - record.startedAt),
      hard_lease_ms: record.hardLeaseMs ?? config.hard_lease_ms,
      mutation_authority: false,
    })
  }

  function dropSession(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length < 1) return
    const prefix = `${sessionID}\u0000`
    for (const [key, record] of active) {
      if (!key.startsWith(prefix)) continue
      clearTimerFn(record.timer)
      if (record.progressTimer != null) clearIntervalFn(record.progressTimer)
      active.delete(key)
    }
    for (const key of failures.keys()) {
      if (key.startsWith(prefix)) failures.delete(key)
    }
  }

  async function shutdown() {
    for (const record of active.values()) {
      clearTimerFn(record.timer)
      if (record.progressTimer != null) clearIntervalFn(record.progressTimer)
    }
    active.clear()
    failures.clear()
  }

  return Object.freeze({
    protocol: PHYSICAL_INFERENCE_LEASE_PROTOCOL,
    config,
    preflight,
    arm,
    complete,
    pollProgress,
    failure,
    dropSession,
    shutdown,
  })
}
