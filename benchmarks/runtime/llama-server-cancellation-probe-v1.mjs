import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  PROOF_STATE,
  createCancellationCapabilities,
  createCancellationProof,
} from "./execution-lease-v1.mjs"

export const LLAMA_CANCELLATION_PROBE_PROTOCOL =
  "llama-server-cancellation-probe-v1"

const REQUIRED_METRICS = Object.freeze([
  "llamacpp:tokens_predicted_total",
  "llamacpp:n_decode_total",
  "llamacpp:requests_processing",
  "llamacpp:requests_deferred",
])

const DEFAULTS = Object.freeze({
  startup_timeout_ms: 60_000,
  retirement_timeout_ms: 5_000,
  transport_close_timeout_ms: 2_000,
  poll_interval_ms: 100,
  quiescence_interval_ms: 1_000,
  quiescence_samples: 3,
  max_tokens: 256,
  max_response_bytes: 256 * 1024,
  request_temperature: 0,
})

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}_timeout`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function fetchTextBounded(url, {
  timeout_ms = 2_000,
  max_bytes = 2 * 1024 * 1024,
  method = "GET",
  headers,
  body,
  signal,
} = {}) {
  const controller = signal ? null : new AbortController()
  const timeout = signal
    ? null
    : setTimeout(() => controller.abort(new Error("fetch timeout")), timeout_ms)
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: signal ?? controller.signal,
      cache: "no-store",
    })
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > max_bytes) {
      throw new Error("response_too_large")
    }
    return { response, text }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function fetchJsonBounded(url, options = {}) {
  const { response, text } = await fetchTextBounded(url, options)
  if (!response.ok) {
    throw new Error(`http_${response.status}`)
  }
  return JSON.parse(text)
}

function parseMetrics(text) {
  const values = new Map()
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue
    const match = /^([A-Za-z0-9_:]+)\s+(-?(?:\d+(?:\.\d+)?|\.\d+))$/u.exec(
      line.trim(),
    )
    if (!match) continue
    const value = Number(match[2])
    if (Number.isFinite(value)) values.set(match[1], value)
  }

  const out = {}
  for (const name of REQUIRED_METRICS) {
    const value = values.get(name)
    if (!Number.isFinite(value)) {
      throw new Error(`required_metric_missing:${name}`)
    }
    out[name] = value
  }
  return Object.freeze(out)
}

async function readMetrics(baseUrl) {
  const { response, text } = await fetchTextBounded(`${baseUrl}/metrics`)
  if (!response.ok) throw new Error(`metrics_http_${response.status}`)
  return parseMetrics(text)
}

async function readSlots(baseUrl) {
  const slots = await fetchJsonBounded(`${baseUrl}/slots`)
  if (!Array.isArray(slots)) throw new Error("slots_not_array")
  return slots
}

function slotIdentity(slot) {
  if (!slot || typeof slot !== "object") return null
  const id = safeInt(slot.id)
  const idTask = Number.isSafeInteger(slot.id_task) ? slot.id_task : null
  if (id === null || idTask === null) return null

  // llama.cpp exposes decode progress under next_token.n_decoded.
  // Older/alternate fixtures may expose a top-level n_decoded; keep that as
  // compatibility-only observation without making it the preferred shape.
  const nestedDecoded = safeInt(slot?.next_token?.n_decoded)
  const legacyDecoded = safeInt(slot.n_decoded)
  return Object.freeze({
    id,
    id_task: idTask,
    is_processing: slot.is_processing === true,
    n_decoded: nestedDecoded ?? legacyDecoded,
    n_decoded_source:
      nestedDecoded !== null
        ? "next_token.n_decoded"
        : legacyDecoded !== null
          ? "top_level_compat"
          : null,
  })
}

function samePinnedTask(slot, pinned) {
  return (
    slot &&
    slot.id === pinned.id &&
    slot.id_task === pinned.id_task
  )
}

function metricDelta(after, before, name) {
  return after[name] - before[name]
}

async function preflight(baseUrl, expectedModel) {
  const health = await fetchJsonBounded(`${baseUrl}/health`)
  if (health?.status !== "ok") throw new Error("health_not_ok")

  const props = await fetchJsonBounded(`${baseUrl}/props`, {
    max_bytes: 4 * 1024 * 1024,
  })
  const modelAlias = boundedString(props?.model_alias, 256)
  const buildInfo = boundedString(props?.build_info, 512)
  if (!modelAlias) throw new Error("model_alias_missing")
  if (expectedModel && modelAlias !== expectedModel) {
    throw new Error(
      `model_alias_mismatch:expected=${expectedModel}:actual=${modelAlias}`,
    )
  }
  if (!buildInfo) throw new Error("build_info_missing")
  if (props?.total_slots !== 1) {
    throw new Error(`total_slots_not_one:${props?.total_slots}`)
  }
  if (props?.endpoint_slots !== true) throw new Error("slots_endpoint_disabled")
  if (props?.endpoint_metrics !== true) {
    throw new Error("metrics_endpoint_disabled")
  }

  const slots = await readSlots(baseUrl)
  if (slots.length !== 1) throw new Error(`slot_count_not_one:${slots.length}`)
  const idleSlot = slotIdentity(slots[0])
  if (!idleSlot) throw new Error("slot_identity_invalid")
  if (idleSlot.is_processing) throw new Error("slot_not_idle")

  const metrics = await readMetrics(baseUrl)
  if (metrics["llamacpp:requests_processing"] !== 0) {
    throw new Error("requests_processing_nonzero")
  }
  if (metrics["llamacpp:requests_deferred"] !== 0) {
    throw new Error("requests_deferred_nonzero")
  }

  return Object.freeze({
    health_status: health.status,
    backend_family: "llama.cpp",
    build_info: buildInfo,
    model_alias: modelAlias,
    total_slots: props.total_slots,
    endpoint_slots: props.endpoint_slots,
    endpoint_metrics: props.endpoint_metrics,
    slot_before: idleSlot,
    metrics_before: metrics,
    props_sha256: sha256Canonical(props),
  })
}

async function waitForPinnedTask(baseUrl, idleSlot, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const slots = await readSlots(baseUrl)
    if (slots.length !== 1) throw new Error("slot_count_changed")
    const slot = slotIdentity(slots[0])
    if (!slot) throw new Error("slot_identity_invalid_during_request")
    if (slot.is_processing) {
      if (slot.id !== idleSlot.id) {
        throw new Error("unexpected_slot_id")
      }
      if (slot.id_task < 0) throw new Error("processing_task_id_invalid")
      return slot
    }
    await sleep(pollMs)
  }
  throw new Error("task_pin_timeout")
}

function parseSseContent(buffer) {
  let clientContentObserved = false
  let parsedEvents = 0
  for (const line of buffer.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const row = JSON.parse(payload)
      parsedEvents += 1
      const choices = Array.isArray(row?.choices) ? row.choices : []
      for (const choice of choices) {
        const delta = choice?.delta
        const content =
          typeof delta?.content === "string"
            ? delta.content
            : typeof choice?.text === "string"
              ? choice.text
              : ""
        if (content.length > 0) clientContentObserved = true
      }
    } catch {
      // Partial/unknown SSE payloads are not positive generation evidence.
    }
  }
  return { clientContentObserved, parsedEvents }
}

async function waitForClientGenerationEvidence(
  response,
  controller,
  timeoutMs,
  maxBytes,
) {
  if (!response.ok) throw new Error(`completion_http_${response.status}`)
  if (!response.body) throw new Error("completion_stream_missing")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let bytes = 0
  let parsedEvents = 0
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const { value, done } = await withTimeout(
      reader.read(),
      remaining,
      "generation_stream",
    )
    if (done) throw new Error("stream_ended_before_generation_evidence")
    bytes += value?.byteLength ?? 0
    if (bytes > maxBytes) throw new Error("stream_evidence_budget_exceeded")
    buffer += decoder.decode(value, { stream: true })

    const parsed = parseSseContent(buffer)
    parsedEvents = Math.max(parsedEvents, parsed.parsedEvents)
    if (parsed.clientContentObserved) {
      return Object.freeze({
        reader,
        bytes_observed: bytes,
        parsed_sse_events: parsedEvents,
        client_generation_observed: true,
      })
    }

    const lastNewline = buffer.lastIndexOf("\n")
    if (lastNewline >= 0) buffer = buffer.slice(lastNewline + 1)
  }

  controller.abort(new Error("generation evidence timeout"))
  throw new Error("client_generation_evidence_timeout")
}

async function waitForServerGenerationEvidence(
  baseUrl,
  beforeMetrics,
  pinned,
  timeoutMs,
  pollMs,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [metrics, slots] = await Promise.all([
      readMetrics(baseUrl),
      readSlots(baseUrl),
    ])
    if (slots.length !== 1) throw new Error("slot_count_changed")
    const slot = slotIdentity(slots[0])
    if (!samePinnedTask(slot, pinned) || !slot.is_processing) {
      throw new Error("pinned_task_retired_before_server_generation_evidence")
    }

    const tokenDelta = metricDelta(
      metrics,
      beforeMetrics,
      "llamacpp:tokens_predicted_total",
    )
    const decodeDelta = metricDelta(
      metrics,
      beforeMetrics,
      "llamacpp:n_decode_total",
    )

    // Per-task slot progress is the authoritative live generation witness.
    // Prometheus totals are recorded diagnostically because some llama.cpp
    // builds publish cumulative counters only after task retirement.
    if (slot.n_decoded !== null && slot.n_decoded > 0) {
      return Object.freeze({
        metrics_at_generation_start: metrics,
        slot_at_generation_start: slot,
        slot_n_decoded: slot.n_decoded,
        slot_n_decoded_source: slot.n_decoded_source,
        tokens_predicted_delta: tokenDelta,
        decode_delta: decodeDelta,
        live_global_metrics_advanced: tokenDelta > 0 && decodeDelta > 0,
        server_generation_observed: true,
        server_generation_evidence: "pinned_slot_decode_progress",
      })
    }
    await sleep(pollMs)
  }
  throw new Error("server_generation_evidence_timeout")
}

async function observeTransportTermination(reader, timeoutMs, maxBytes) {
  let bytes = 0
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    try {
      const { value, done } = await withTimeout(
        reader.read(),
        remaining,
        "post_abort_stream",
      )
      if (done) {
        return Object.freeze({
          state: PROOF_STATE.PROVEN,
          reason: "stream_closed",
          buffered_bytes_after_abort: bytes,
        })
      }
      bytes += value?.byteLength ?? 0
      if (bytes > maxBytes) {
        return Object.freeze({
          state: PROOF_STATE.UNPROVEN,
          reason: "post_abort_buffer_budget_exceeded",
          buffered_bytes_after_abort: bytes,
        })
      }
    } catch (error) {
      if (
        error?.name === "AbortError" ||
        /abort|execution lease expired|terminated|fetch/u.test(
          String(error?.message ?? error).toLowerCase(),
        )
      ) {
        return Object.freeze({
          state: PROOF_STATE.PROVEN,
          reason: "stream_abort_observed",
          buffered_bytes_after_abort: bytes,
        })
      }
      return Object.freeze({
        state: PROOF_STATE.UNPROVEN,
        reason: `stream_error:${String(error?.message ?? error)}`,
        buffered_bytes_after_abort: bytes,
      })
    }
  }

  return Object.freeze({
    state: PROOF_STATE.UNPROVEN,
    reason: "transport_close_timeout",
    buffered_bytes_after_abort: bytes,
  })
}

async function waitForTaskRetirement(
  baseUrl,
  pinned,
  timeoutMs,
  pollMs,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [slots, metrics] = await Promise.all([
      readSlots(baseUrl),
      readMetrics(baseUrl),
    ])
    if (slots.length !== 1) throw new Error("slot_count_changed")
    const slot = slotIdentity(slots[0])
    const pinnedStillProcessing =
      samePinnedTask(slot, pinned) && slot.is_processing

    if (
      !pinnedStillProcessing &&
      metrics["llamacpp:requests_processing"] === 0 &&
      metrics["llamacpp:requests_deferred"] === 0
    ) {
      return Object.freeze({
        slot_at_retirement: slot,
        metrics_at_retirement: metrics,
        pinned_task_retired: true,
      })
    }
    await sleep(pollMs)
  }

  return Object.freeze({
    slot_at_retirement: null,
    metrics_at_retirement: await readMetrics(baseUrl),
    pinned_task_retired: false,
  })
}

async function observeQuiescence(
  baseUrl,
  pinned,
  samples,
  intervalMs,
) {
  const snapshots = []
  for (let index = 0; index < samples; index += 1) {
    const [slots, metrics] = await Promise.all([
      readSlots(baseUrl),
      readMetrics(baseUrl),
    ])
    if (slots.length !== 1) throw new Error("slot_count_changed")
    const slot = slotIdentity(slots[0])
    snapshots.push(Object.freeze({
      sample: index,
      slot,
      metrics,
    }))
    if (index + 1 < samples) await sleep(intervalMs)
  }

  const first = snapshots[0]
  const frozen = snapshots.every((row) =>
    row.metrics["llamacpp:tokens_predicted_total"] ===
      first.metrics["llamacpp:tokens_predicted_total"] &&
    row.metrics["llamacpp:n_decode_total"] ===
      first.metrics["llamacpp:n_decode_total"] &&
    row.metrics["llamacpp:requests_processing"] === 0 &&
    row.metrics["llamacpp:requests_deferred"] === 0 &&
    !(samePinnedTask(row.slot, pinned) && row.slot.is_processing)
  )

  return Object.freeze({
    compute_quiesced: frozen,
    snapshots: Object.freeze(snapshots),
    window_ms: (samples - 1) * intervalMs,
  })
}

function finalizeReceipt(payload) {
  const base = {
    protocol: LLAMA_CANCELLATION_PROBE_PROTOCOL,
    authority: "probe_evidence",
    admission_authority: false,
    scheduling_authority: false,
    mutation_authority: false,
    production_transport_proven: false,
    production_hard_lease_eligible: false,
    ...payload,
  }
  return Object.freeze({
    ...base,
    content_sha256: sha256Canonical(base),
  })
}

export async function runLlamaServerCancellationProbe({
  base_url = "http://127.0.0.1:8080",
  expected_model = null,
  startup_timeout_ms = DEFAULTS.startup_timeout_ms,
  retirement_timeout_ms = DEFAULTS.retirement_timeout_ms,
  transport_close_timeout_ms = DEFAULTS.transport_close_timeout_ms,
  poll_interval_ms = DEFAULTS.poll_interval_ms,
  quiescence_interval_ms = DEFAULTS.quiescence_interval_ms,
  quiescence_samples = DEFAULTS.quiescence_samples,
  max_tokens = DEFAULTS.max_tokens,
  max_response_bytes = DEFAULTS.max_response_bytes,
  prompt =
    "Write consecutive positive integers, one per line, continuing until stopped.",
} = {}) {
  const baseUrl = boundedString(base_url, 1024)?.replace(/\/+$/u, "")
  const expectedModel = expected_model === null
    ? null
    : boundedString(expected_model, 256)
  if (!baseUrl || (expected_model !== null && !expectedModel)) {
    return finalizeReceipt({
      status: "EVIDENCE_INSUFFICIENT",
      reason: "probe_config_invalid",
      production_backend_proven: false,
    })
  }

  const ints = {
    startup_timeout_ms: safeInt(startup_timeout_ms, 1, 10 * 60_000),
    retirement_timeout_ms: safeInt(retirement_timeout_ms, 1, 60_000),
    transport_close_timeout_ms: safeInt(
      transport_close_timeout_ms,
      1,
      60_000,
    ),
    poll_interval_ms: safeInt(poll_interval_ms, 10, 5_000),
    quiescence_interval_ms: safeInt(
      quiescence_interval_ms,
      50,
      30_000,
    ),
    quiescence_samples: safeInt(quiescence_samples, 2, 16),
    max_tokens: safeInt(max_tokens, 8, 4_096),
    max_response_bytes: safeInt(
      max_response_bytes,
      4_096,
      4 * 1024 * 1024,
    ),
  }
  if (Object.values(ints).some((value) => value === null)) {
    return finalizeReceipt({
      status: "EVIDENCE_INSUFFICIENT",
      reason: "probe_config_invalid",
      production_backend_proven: false,
    })
  }

  let pre = null
  let pinned = null
  let clientStart = null
  let serverStart = null
  let retirement = null
  let quiescence = null
  let transport = null
  const controller = new AbortController()
  let reader = null

  try {
    pre = await preflight(baseUrl, expectedModel)

    const requestPromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: pre.model_alias,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        temperature: DEFAULTS.request_temperature,
        max_tokens: ints.max_tokens,
      }),
      signal: controller.signal,
      cache: "no-store",
    })

    pinned = await waitForPinnedTask(
      baseUrl,
      pre.slot_before,
      ints.startup_timeout_ms,
      ints.poll_interval_ms,
    )

    const response = await withTimeout(
      requestPromise,
      ints.startup_timeout_ms,
      "completion_headers",
    )

    clientStart = await waitForClientGenerationEvidence(
      response,
      controller,
      ints.startup_timeout_ms,
      ints.max_response_bytes,
    )
    reader = clientStart.reader

    serverStart = await waitForServerGenerationEvidence(
      baseUrl,
      pre.metrics_before,
      pinned,
      Math.min(5_000, ints.startup_timeout_ms),
      ints.poll_interval_ms,
    )

    controller.abort(new Error("execution lease expired"))

    transport = await observeTransportTermination(
      reader,
      ints.transport_close_timeout_ms,
      ints.max_response_bytes,
    )

    retirement = await waitForTaskRetirement(
      baseUrl,
      pinned,
      ints.retirement_timeout_ms,
      ints.poll_interval_ms,
    )

    quiescence = await observeQuiescence(
      baseUrl,
      pinned,
      ints.quiescence_samples,
      ints.quiescence_interval_ms,
    )

    const capabilitiesResult = createCancellationCapabilities({
      adapter_id: "llama-server-openai-stream-direct-v1",
      request_cancellation: true,
      transport_close_observable: true,
      provider_cancel_observable: true,
      compute_stop_observable: true,
    })
    if (!capabilitiesResult.ok) {
      throw new Error(`capabilities_failed:${capabilitiesResult.reason}`)
    }

    const proofResult = createCancellationProof({
      lease_id: `llama-probe:${pinned.id_task}`,
      adapter_id: capabilitiesResult.capabilities.adapter_id,
      lease_expired: true,
      cancel_requested:
        controller.signal.aborted
          ? PROOF_STATE.PROVEN
          : PROOF_STATE.UNPROVEN,
      transport_closed: transport.state,
      provider_cancel_observed:
        retirement.pinned_task_retired
          ? PROOF_STATE.PROVEN
          : PROOF_STATE.UNPROVEN,
      compute_quiesced:
        quiescence.compute_quiesced
          ? PROOF_STATE.PROVEN
          : PROOF_STATE.UNPROVEN,
      post_expiry_action_observed:
        quiescence.compute_quiesced !== true,
      evidence: {
        backend_build: pre.build_info,
        model_alias: pre.model_alias,
        pinned_slot_id: pinned.id,
        pinned_task_id: pinned.id_task,
        client_generation_observed:
          clientStart.client_generation_observed === true,
        server_generation_observed:
          serverStart.server_generation_observed === true,
        tokens_predicted_delta_before_abort:
          serverStart.tokens_predicted_delta,
        decode_delta_before_abort: serverStart.decode_delta,
        transport_reason: transport.reason,
        pinned_task_retired: retirement.pinned_task_retired,
        quiescence_window_ms: quiescence.window_ms,
      },
    })
    if (!proofResult.ok) {
      throw new Error(`proof_failed:${proofResult.reason}`)
    }

    const productionBackendProven =
      clientStart.client_generation_observed === true &&
      serverStart.server_generation_observed === true &&
      retirement.pinned_task_retired === true &&
      quiescence.compute_quiesced === true &&
      proofResult.proof.hard_lease_eligible === true

    return finalizeReceipt({
      status: productionBackendProven ? "PROVEN" : "UNPROVEN",
      reason: productionBackendProven
        ? "active_generation_cancelled_and_compute_quiesced"
        : "backend_cancellation_not_fully_proven",
      backend_scope: Object.freeze({
        backend_family: pre.backend_family,
        build_info: pre.build_info,
        model_alias: pre.model_alias,
        endpoint: "/v1/chat/completions",
        response_mode: "stream",
        cancellation_mechanism: "client_transport_abort",
        total_slots: pre.total_slots,
        props_sha256: pre.props_sha256,
      }),
      preflight: pre,
      task_binding: Object.freeze({
        slot_id: pinned.id,
        id_task: pinned.id_task,
      }),
      generation_start: Object.freeze({
        client: Object.freeze({
          bytes_observed: clientStart.bytes_observed,
          parsed_sse_events: clientStart.parsed_sse_events,
          client_generation_observed:
            clientStart.client_generation_observed,
        }),
        server: serverStart,
      }),
      cancellation: Object.freeze({
        transport,
        retirement,
      }),
      quiescence,
      capabilities: capabilitiesResult.capabilities,
      proof: proofResult.proof,
      production_backend_proven: productionBackendProven,
    })
  } catch (error) {
    if (!controller.signal.aborted) {
      controller.abort(new Error("probe failed closed"))
    }
    if (reader) {
      try {
        await reader.cancel()
      } catch {
        // Best-effort cleanup only; receipt remains fail-closed.
      }
    }

    return finalizeReceipt({
      status: "EVIDENCE_INSUFFICIENT",
      reason: "probe_failed_closed",
      detail: String(error?.message ?? error),
      backend_scope: pre
        ? Object.freeze({
            backend_family: pre.backend_family,
            build_info: pre.build_info,
            model_alias: pre.model_alias,
            endpoint: "/v1/chat/completions",
            response_mode: "stream",
            cancellation_mechanism: "client_transport_abort",
            total_slots: pre.total_slots,
            props_sha256: pre.props_sha256,
          })
        : null,
      preflight: pre,
      task_binding: pinned
        ? Object.freeze({
            slot_id: pinned.id,
            id_task: pinned.id_task,
          })
        : null,
      generation_start: clientStart || serverStart
        ? Object.freeze({
            client: clientStart
              ? Object.freeze({
                  bytes_observed: clientStart.bytes_observed,
                  parsed_sse_events: clientStart.parsed_sse_events,
                  client_generation_observed:
                    clientStart.client_generation_observed,
                })
              : null,
            server: serverStart,
          })
        : null,
      cancellation: retirement || transport
        ? Object.freeze({ transport, retirement })
        : null,
      quiescence,
      production_backend_proven: false,
    })
  }
}

function parseCli(argv) {
  const out = {
    base_url: "http://127.0.0.1:8080",
    expected_model: null,
    output: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--base-url" && next) {
      out.base_url = next
      i += 1
    } else if (arg === "--model" && next) {
      out.expected_model = next
      i += 1
    } else if (arg === "--out" && next) {
      out.output = next
      i += 1
    } else if (arg === "--startup-timeout-ms" && next) {
      out.startup_timeout_ms = Number(next)
      i += 1
    } else if (arg === "--quiescence-interval-ms" && next) {
      out.quiescence_interval_ms = Number(next)
      i += 1
    } else if (arg === "--quiescence-samples" && next) {
      out.quiescence_samples = Number(next)
      i += 1
    } else {
      throw new Error(`unknown_or_incomplete_argument:${arg}`)
    }
  }
  return out
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const args = parseCli(process.argv.slice(2))
    const receipt = await runLlamaServerCancellationProbe(args)
    const text = JSON.stringify(receipt, null, 2) + "\n"
    if (args.output) {
      await writeFile(path.resolve(args.output), text, "utf8")
    }
    process.stdout.write(text)
    process.exitCode = receipt.status === "PROVEN" ? 0 : 3
  } catch (error) {
    console.error(String(error?.stack ?? error))
    process.exitCode = 2
  }
}
