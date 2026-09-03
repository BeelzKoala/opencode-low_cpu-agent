import { createHash } from "node:crypto"
import {
  appendFile,
  mkdir,
  readFile,
} from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import {
  PHYSICAL_INFERENCE_PROTOCOL,
  createPhysicalInferenceCorrelationState,
  observePhysicalInferenceSnapshot,
  parseLlamaSlots,
} from "./physical-inference-correlation-v1.mjs"
import {
  INFERENCE_LIFECYCLE_PROTOCOL,
  createInferenceLifecycleState,
  markInferenceLogicalComplete,
  observeInferenceLifecycle,
  snapshotInferenceLifecycle,
} from "./inference-lifecycle-v1.mjs"

export const TELEMETRY_PROTOCOL =
  "koalik-telemetry-v1"

export const TELEMETRY_AUTHORITY =
  "observation_only"

export const TELEMETRY_CONTENT_POLICY =
  "metadata_hashes_counts_only"

export const TELEMETRY_PHYSICAL_INFERENCE_PROTOCOL =
  PHYSICAL_INFERENCE_PROTOCOL

const TRACE_FILE =
  "telemetry-v1.jsonl"

const DEFAULT_PROGRESS_MS = 2_000
const DEFAULT_PROGRESS_BYTES = 1_024
const DEFAULT_PROGRESS_DELTAS = 32
const DEFAULT_RESOURCE_SAMPLE_MS = 5_000
const MIN_RESOURCE_SAMPLE_MS = 1_000
const MAX_RESOURCE_SAMPLE_MS = 30_000
const LLAMA_METRICS_TIMEOUT_MS = 250
const LLAMA_SLOTS_TIMEOUT_MS = 250

const traces = new Map()

function bytes(value) {
  return Buffer.byteLength(
    String(value ?? ""),
    "utf8",
  )
}

function boundedInt(
  raw,
  fallback,
  minimum,
  maximum,
) {
  const value = Number(raw)

  if (
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  ) {
    return value
  }

  return fallback
}

function sampleIntervalMs() {
  return boundedInt(
    process.env
      .OPENCODE_CPU_TELEMETRY_SAMPLE_MS,
    DEFAULT_RESOURCE_SAMPLE_MS,
    MIN_RESOURCE_SAMPLE_MS,
    MAX_RESOURCE_SAMPLE_MS,
  )
}

function digest(value, length) {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex")
    .slice(0, length)
}

function traceKey(
  sessionID,
  turnID,
) {
  if (
    typeof sessionID !== "string" ||
    sessionID.length < 1
  ) {
    return null
  }

  return (
    sessionID +
    "\0" +
    String(turnID ?? "unbound")
  )
}

function traceIdentity(
  sessionID,
  turnID,
) {
  const key =
    traceKey(
      sessionID,
      turnID,
    )

  if (!key) return null

  return digest(
    "koalik-trace-v1\0" + key,
    32,
  )
}

function spanIdentity(
  traceID,
  discriminator,
) {
  if (!traceID) return null

  return digest(
    traceID +
    "\0" +
    String(discriminator ?? ""),
    16,
  )
}

function ensureTrace(
  sessionID,
  turnID,
) {
  const key =
    traceKey(
      sessionID,
      turnID,
    )

  if (!key) return null

  let state = traces.get(key)

  if (!state) {
    const traceID =
      traceIdentity(
        sessionID,
        turnID,
      )

    state = {
      key,
      traceID,
      sessionID,
      turnID:
        turnID ?? null,
      seq: 0,
      activeModel: null,
    }

    traces.set(
      key,
      state,
    )
  }

  return state
}

function nextSeq(state) {
  state.seq += 1
  return state.seq
}

function sourceComponent(
  sourceTraceFile,
  sourceKind,
) {
  if (
    sourceTraceFile ===
      "search-trace.jsonl"
  ) {
    return "scout"
  }

  if (
    sourceTraceFile ===
      "executor-trace.jsonl"
  ) {
    return "execution"
  }

  if (
    typeof sourceKind === "string"
  ) {
    if (
      sourceKind.includes("governor")
    ) {
      return "governor"
    }

    if (
      sourceKind.startsWith("model_") ||
      sourceKind.startsWith("provider_")
    ) {
      return "inference"
    }

    if (
      sourceKind.includes("terminal") ||
      sourceKind.includes("completion")
    ) {
      return "terminal"
    }

    if (
      sourceKind.includes("scout") ||
      sourceKind.includes("search")
    ) {
      return "scout"
    }
  }

  return "orchestrator"
}

const PROJECTED_KEYS =
  Object.freeze([
    "kind",
    "protocol",
    "reason",
    "result",
    "failure_class",
    "execution_state",
    "execution_reason",
    "execution_event",
    "next_action",
    "selected_tool",
    "proof_obligation",
    "model_call",
    "providerID",
    "modelID",
    "mutation_tool",
    "semantic_kind",
    "mutation_dispatch_origin",
    "turn_model_calls",
    "turn_search_attempts",
    "turn_executed_searches",
    "turn_mutation_attempts",
    "turn_repair_attempts",
    "turn_compiler_runs",
    "turn_executor_runs",
    "turn_patch_attempts",
    "turn_patch_accepted",
    "turn_evidence_bytes",
    "context_bytes",
    "context_system_bytes",
    "context_messages_bytes",
    "context_tools_bytes",
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "finish",
    "source",
  ])

function projectScalarFields(record) {
  const out = {}

  for (const key of PROJECTED_KEYS) {
    const value = record?.[key]

    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (value != null) {
        out[key] = value
      }
    }
  }

  return out
}

async function appendTelemetry(
  root,
  record,
) {
  if (
    typeof root !== "string" ||
    root.length < 1
  ) {
    return
  }

  try {
    const dir =
      path.join(
        root,
        ".opencode",
      )

    await mkdir(
      dir,
      {
        recursive: true,
      },
    )

    await appendFile(
      path.join(
        dir,
        TRACE_FILE,
      ),
      JSON.stringify(
        record,
      ) + "\n",
      "utf8",
    )
  } catch {
    // Observation only. Telemetry must never break task execution.
  }
}

function envelope(
  state,
  {
    component,
    operation,
    event,
    spanID = null,
    parentSpanID = null,
  },
) {
  return {
    telemetry_protocol:
      TELEMETRY_PROTOCOL,
    telemetry_authority:
      TELEMETRY_AUTHORITY,
    content_policy:
      TELEMETRY_CONTENT_POLICY,
    trace_id:
      state?.traceID ?? null,
    span_id:
      spanID,
    parent_span_id:
      parentSpanID,
    seq:
      state
        ? nextSeq(state)
        : null,
    ts_ms:
      Date.now(),
    mono_ms:
      Math.round(
        performance.now() * 1000,
      ) / 1000,
    sessionID:
      state?.sessionID ?? null,
    turnID:
      state?.turnID ?? null,
    component,
    operation,
    event,
  }
}

function modelSpanID(
  state,
  modelCall,
) {
  return spanIdentity(
    state.traceID,
    "model-call:" +
      String(modelCall ?? "unknown"),
  )
}

function stopModelSampler(
  model,
) {
  if (model?.resourceTimer) {
    clearInterval(
      model.resourceTimer,
    )
    model.resourceTimer = null
  }
}

function parsePressureLine(
  line,
) {
  const out = {}

  for (
    const field of String(
      line ?? "",
    ).trim().split(/\s+/u)
  ) {
    const [key, raw] =
      field.split("=")

    if (!key || raw == null) {
      continue
    }

    const value =
      Number(raw)

    if (Number.isFinite(value)) {
      out[key] = value
    }
  }

  return out
}

export function parseLinuxPsi(
  text,
) {
  const result = {
    some: null,
    full: null,
  }

  for (
    const line of String(
      text ?? "",
    ).split("\n")
  ) {
    if (line.startsWith("some ")) {
      result.some =
        parsePressureLine(
          line.slice(5),
        )
    } else if (
      line.startsWith("full ")
    ) {
      result.full =
        parsePressureLine(
          line.slice(5),
        )
    }
  }

  return result
}

async function readPsi(kind) {
  try {
    return parseLinuxPsi(
      await readFile(
        `/proc/pressure/${kind}`,
        "utf8",
      ),
    )
  } catch {
    return {
      some: null,
      full: null,
    }
  }
}

export function parsePrometheusMetrics(
  text,
) {
  const wanted =
    new Set([
      "llamacpp:prompt_tokens_total",
      "llamacpp:prompt_seconds_total",
      "llamacpp:prompt_tokens_seconds",
      "llamacpp:tokens_predicted_total",
      "llamacpp:tokens_predicted_seconds_total",
      "llamacpp:predicted_tokens_seconds",
      "llamacpp:kv_cache_usage_ratio",
      "llamacpp:kv_cache_tokens",
      "llamacpp:requests_processing",
      "llamacpp:requests_deferred",
      "llamacpp:n_tokens_max",
    ])

  const out = {}

  for (
    const line of String(
      text ?? "",
    ).split("\n")
  ) {
    if (
      !line ||
      line.startsWith("#")
    ) {
      continue
    }

    const match =
      /^([^\s{]+)(?:\{[^}]*\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/u
        .exec(
          line.trim(),
        )

    if (!match) continue

    const name = match[1]
    if (!wanted.has(name)) {
      continue
    }

    const value =
      Number(match[2])

    if (Number.isFinite(value)) {
      out[name] = value
    }
  }

  return out
}

async function llamaMetrics() {
  const url =
    process.env
      .OPENCODE_CPU_TELEMETRY_LLAMA_METRICS_URL

  if (
    typeof url !== "string" ||
    url.length < 1
  ) {
    return {
      available: false,
      reason:
        "metrics_url_unconfigured",
      metrics: {},
    }
  }

  if (
    typeof fetch !== "function"
  ) {
    return {
      available: false,
      reason:
        "fetch_unavailable",
      metrics: {},
    }
  }

  try {
    const controller =
      new AbortController()

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        LLAMA_METRICS_TIMEOUT_MS,
      )

    timer.unref?.()

    const response =
      await fetch(
        url,
        {
          method: "GET",
          signal:
            controller.signal,
        },
      )

    clearTimeout(timer)

    if (!response.ok) {
      return {
        available: false,
        reason:
          `http_${response.status}`,
        metrics: {},
      }
    }

    const parsed =
      parsePrometheusMetrics(
        await response.text(),
      )

    return {
      available: true,
      reason: "ok",
      metrics: parsed,
    }
  } catch (error) {
    return {
      available: false,
      reason:
        error?.name ===
          "AbortError"
          ? "timeout"
          : "unavailable",
      metrics: {},
    }
  }
}

function deriveLlamaSlotsUrl() {
  const explicit =
    process.env
      .OPENCODE_CPU_TELEMETRY_LLAMA_SLOTS_URL

  if (
    typeof explicit === "string" &&
    explicit.length > 0
  ) {
    return explicit
  }

  const metricsUrl =
    process.env
      .OPENCODE_CPU_TELEMETRY_LLAMA_METRICS_URL

  if (
    typeof metricsUrl !== "string" ||
    metricsUrl.length < 1
  ) {
    return null
  }

  try {
    const url =
      new URL(metricsUrl)

    if (
      /\/metrics\/?$/u.test(
        url.pathname,
      )
    ) {
      url.pathname =
        url.pathname.replace(
          /\/metrics\/?$/u,
          "/slots",
        )
      url.search = ""
      url.hash = ""
      return url.toString()
    }
  } catch {
    return null
  }

  return null
}

async function llamaSlots() {
  const url =
    deriveLlamaSlotsUrl()

  if (!url) {
    return {
      available: false,
      reason:
        "slots_url_unconfigured",
      slots: [],
    }
  }

  if (
    typeof fetch !== "function"
  ) {
    return {
      available: false,
      reason:
        "fetch_unavailable",
      slots: [],
    }
  }

  try {
    const controller =
      new AbortController()

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        LLAMA_SLOTS_TIMEOUT_MS,
      )

    timer.unref?.()

    const response =
      await fetch(
        url,
        {
          method: "GET",
          signal:
            controller.signal,
        },
      )

    clearTimeout(timer)

    if (!response.ok) {
      return {
        available: false,
        reason:
          `http_${response.status}`,
        slots: [],
      }
    }

    const value =
      await response.json()

    return {
      available: true,
      reason: "ok",
      slots:
        parseLlamaSlots(value),
    }
  } catch (error) {
    return {
      available: false,
      reason:
        error?.name ===
          "AbortError"
          ? "timeout"
          : "unavailable",
      slots: [],
    }
  }
}

function procInteger(
  text,
  key,
) {
  const match =
    new RegExp(
      `^${key}:\\s+(\\d+)`,
      "mu",
    ).exec(
      String(text ?? ""),
    )

  if (!match) return null

  const value = Number(match[1])
  return Number.isSafeInteger(value)
    ? value
    : null
}

function parseProcStat(text) {
  const value =
    String(text ?? "")
  const close =
    value.lastIndexOf(")")

  if (close < 0) return null

  const fields =
    value
      .slice(close + 2)
      .trim()
      .split(/\s+/u)

  // fields[0] is proc stat field 3 (state).
  const numberAt = (index) => {
    const n = Number(fields[index])
    return Number.isFinite(n)
      ? n
      : null
  }

  return {
    state:
      fields[0] ?? null,
    minor_page_faults:
      numberAt(7),
    major_page_faults:
      numberAt(9),
    user_cpu_ticks:
      numberAt(11),
    system_cpu_ticks:
      numberAt(12),
  }
}

function parseProcIo(text) {
  const out = {}

  for (
    const line of String(
      text ?? "",
    ).split("\n")
  ) {
    const match =
      /^([a-z_]+):\s+(\d+)$/u.exec(
        line.trim(),
      )

    if (!match) continue

    const value = Number(match[2])
    if (Number.isSafeInteger(value)) {
      out[match[1]] = value
    }
  }

  return out
}

async function configuredLlamaPid() {
  const direct =
    Number(
      process.env
        .OPENCODE_CPU_TELEMETRY_LLAMA_PID,
    )

  if (
    Number.isSafeInteger(direct) &&
    direct > 1
  ) {
    return {
      pid: direct,
      source: "env",
    }
  }

  const pidFile =
    process.env
      .OPENCODE_CPU_TELEMETRY_LLAMA_PID_FILE

  if (
    typeof pidFile !== "string" ||
    pidFile.length < 1
  ) {
    return null
  }

  try {
    const value = Number(
      (
        await readFile(
          pidFile,
          "utf8",
        )
      ).trim(),
    )

    if (
      Number.isSafeInteger(value) &&
      value > 1
    ) {
      return {
        pid: value,
        source: "pidfile",
      }
    }
  } catch {
    return null
  }

  return null
}

async function llamaProcessSnapshot() {
  const configured =
    await configuredLlamaPid()

  if (!configured) {
    return {
      available: false,
      reason:
        "llama_pid_unconfigured",
      pid: null,
      source: null,
    }
  }

  const base =
    `/proc/${configured.pid}`

  try {
    const [
      statText,
      statusText,
      ioText,
    ] = await Promise.all([
      readFile(
        `${base}/stat`,
        "utf8",
      ),
      readFile(
        `${base}/status`,
        "utf8",
      ),
      readFile(
        `${base}/io`,
        "utf8",
      ).catch(() => ""),
    ])

    const stat =
      parseProcStat(statText) ?? {}
    const io =
      parseProcIo(ioText)

    return {
      available: true,
      reason: "ok",
      pid: configured.pid,
      source:
        configured.source,
      state:
        stat.state ?? null,
      user_cpu_ticks:
        stat.user_cpu_ticks ?? null,
      system_cpu_ticks:
        stat.system_cpu_ticks ?? null,
      minor_page_faults:
        stat.minor_page_faults ?? null,
      major_page_faults:
        stat.major_page_faults ?? null,
      rss_kib:
        procInteger(
          statusText,
          "VmRSS",
        ),
      vm_size_kib:
        procInteger(
          statusText,
          "VmSize",
        ),
      read_bytes:
        io.read_bytes ?? null,
      write_bytes:
        io.write_bytes ?? null,
    }
  } catch {
    return {
      available: false,
      reason:
        "llama_proc_unavailable",
      pid: configured.pid,
      source:
        configured.source,
    }
  }
}


async function resourceSnapshot() {
  const usage =
    process.resourceUsage()
  const memory =
    process.memoryUsage()

  const [
    cpuPressure,
    memoryPressure,
    ioPressure,
    llama,
    slots,
    llamaProcess,
  ] = await Promise.all([
    readPsi("cpu"),
    readPsi("memory"),
    readPsi("io"),
    llamaMetrics(),
    llamaSlots(),
    llamaProcessSnapshot(),
  ])

  return {
    process: {
      pid: process.pid,
      role:
        "orchestrator",
      user_cpu_usec:
        usage.userCPUTime,
      system_cpu_usec:
        usage.systemCPUTime,
      max_rss_kib:
        usage.maxRSS,
      minor_page_faults:
        usage.minorPageFault,
      major_page_faults:
        usage.majorPageFault,
      voluntary_context_switches:
        usage.voluntaryContextSwitches,
      involuntary_context_switches:
        usage.involuntaryContextSwitches,
      rss_bytes:
        memory.rss,
      heap_used_bytes:
        memory.heapUsed,
      external_bytes:
        memory.external,
    },
    llama_process:
      llamaProcess,
    psi: {
      cpu: cpuPressure,
      memory: memoryPressure,
      io: ioPressure,
    },
    llama_metrics_available:
      llama.available,
    llama_metrics_reason:
      llama.reason,
    llama_metrics:
      llama.metrics,
    llama_slots_available:
      slots.available,
    llama_slots_reason:
      slots.reason,
    llama_slots:
      slots.slots,
  }
}

async function emitResourceSample(
  root,
  state,
  model,
  trigger,
) {
  if (
    !state ||
    !model
  ) {
    return
  }

  const sample =
    await resourceSnapshot()

  const monoMs =
    performance.now()

  const physical =
    observePhysicalInferenceSnapshot(
      model.physicalInference,
      {
        metrics:
          sample.llama_metrics,
        slots:
          sample.llama_slots,
        metrics_available:
          sample.llama_metrics_available === true,
        slots_available:
          sample.llama_slots_available === true,
        mono_ms:
          monoMs,
      },
    )

  const lifecycle =
    observeInferenceLifecycle(
      model.inferenceLifecycle,
      physical,
      monoMs,
    )

  const resourceSpanID =
    spanIdentity(
      state.traceID,
      "resources",
    )

  await appendTelemetry(
    root,
    {
      ...envelope(
        state,
        {
          component:
            "resources",
          operation:
            "resource_sample",
          event:
            "sample",
          spanID:
            resourceSpanID,
          parentSpanID:
            model.spanID,
        },
      ),
      trigger,
      model_call:
        model.modelCall,
      ...sample,
      physical_inference:
        physical,
      inference_lifecycle:
        lifecycle.snapshot,
    },
  )

  if (
    physical.server_progress_observed ||
    physical.task_transition ||
    physical.multiple_physical_tasks_observed ||
    lifecycle.changed
  ) {
    await appendTelemetry(
      root,
      {
        ...envelope(
          state,
          {
            component:
              "inference",
            operation:
              "physical_inference",
            event:
              physical.task_transition
                ? "task_transition"
                : "progress",
            spanID:
              model.spanID,
          },
        ),
        model_call:
          model.modelCall,
        physical_inference_protocol:
          PHYSICAL_INFERENCE_PROTOCOL,
        correlation_strategy:
          physical.correlation_strategy,
        correlated_slot_id:
          physical.correlated_slot_id,
        correlated_task_id:
          physical.correlated_task_id,
        task_transition:
          physical.task_transition,
        task_transitions_total:
          physical.task_transitions_total,
        physical_task_ids_seen:
          physical.physical_task_ids_seen,
        physical_task_cardinality_observed:
          physical.physical_task_cardinality_observed,
        multiple_physical_tasks_observed:
          physical.multiple_physical_tasks_observed,
        request_scoped_counter_progress:
          physical.request_scoped_counter_progress,
        slot_decoded:
          physical.slot_decoded,
        slot_decoded_interval:
          physical.slot_decoded_interval,
        global_prompt_tokens_delta:
          physical.global_prompt_tokens_delta,
        global_predicted_tokens_delta:
          physical.global_predicted_tokens_delta,
        interval_prompt_tokens_delta:
          physical.interval_prompt_tokens_delta,
        interval_predicted_tokens_delta:
          physical.interval_predicted_tokens_delta,
        server_context_high_water_tokens:
          physical.server_context_high_water_tokens,
        server_requests_processing:
          physical.server_requests_processing,
        server_requests_deferred:
          physical.server_requests_deferred,
        server_progress_kind:
          physical.server_progress_kind,
        server_progress_events:
          physical.server_progress_events,
        stall_authority: false,
        mutation_authority: false,
        inference_lifecycle:
          lifecycle.snapshot,
        content_captured: false,
      },
    )
  }
}

function startModelSampler(
  root,
  state,
  model,
) {
  if (
    !state ||
    !model ||
    model.resourceTimer
  ) {
    return
  }

  void emitResourceSample(
    root,
    state,
    model,
    "model_dispatch",
  )

  const timer =
    setInterval(
      () => {
        if (
          state.activeModel !==
          model
        ) {
          clearInterval(timer)
          return
        }

        void emitResourceSample(
          root,
          state,
          model,
          "periodic",
        )
      },
      sampleIntervalMs(),
    )

  timer.unref?.()
  model.resourceTimer = timer
}

function createModelState(
  state,
  record,
) {
  const call =
    Number.isSafeInteger(
      record?.model_call,
    )
      ? record.model_call
      : null

  const spanID =
    modelSpanID(
      state,
      call,
    )

  return {
    spanID,
    modelCall: call,
    dispatchedMono:
      performance.now(),
    firstProgressMono: null,
    lastProgressMono: null,
    maxProgressGapMs: 0,
    deltaEvents: 0,
    deltaBytes: 0,
    lastCheckpointMono: null,
    checkpointDeltaEvents: 0,
    checkpointDeltaBytes: 0,
    toolRawBytesMax: 0,
    toolInputBytesMax: 0,
    toolStatus: null,
    partTypes: new Map(),
    resourceTimer: null,
    physicalInference:
      createPhysicalInferenceCorrelationState({
        dispatched_mono_ms:
          performance.now(),
      }),
    inferenceLifecycle:
      createInferenceLifecycleState({
        logical_model_call: call,
        dispatched_mono_ms:
          performance.now(),
      }),
  }
}

function maybeProgressCheckpoint(
  root,
  state,
  model,
  {
    force = false,
    progressKind = "unknown",
    partID = null,
    field = null,
  } = {},
) {
  if (
    !root ||
    !state ||
    !model
  ) {
    return
  }

  const now =
    performance.now()

  const elapsed =
    model.lastCheckpointMono == null
      ? Infinity
      : now -
        model.lastCheckpointMono

  const bytesSince =
    model.deltaBytes -
    model.checkpointDeltaBytes

  const deltasSince =
    model.deltaEvents -
    model.checkpointDeltaEvents

  if (
    !force &&
    elapsed < DEFAULT_PROGRESS_MS &&
    bytesSince <
      DEFAULT_PROGRESS_BYTES &&
    deltasSince <
      DEFAULT_PROGRESS_DELTAS
  ) {
    return
  }

  model.lastCheckpointMono =
    now
  model.checkpointDeltaBytes =
    model.deltaBytes
  model.checkpointDeltaEvents =
    model.deltaEvents

  void appendTelemetry(
    root,
    {
      ...envelope(
        state,
        {
          component:
            "inference",
          operation:
            "provider_progress",
          event:
            "checkpoint",
          spanID:
            model.spanID,
        },
      ),
      model_call:
        model.modelCall,
      progress_kind:
        progressKind,
      part_id_hash:
        partID
          ? digest(
              partID,
              16,
            )
          : null,
      field:
        typeof field === "string"
          ? field
          : null,
      output_delta_events:
        model.deltaEvents,
      output_delta_bytes:
        model.deltaBytes,
      tool_raw_bytes_max:
        model.toolRawBytesMax,
      tool_input_bytes_max:
        model.toolInputBytesMax,
      first_progress_ms:
        model.firstProgressMono == null
          ? null
          : Math.round(
              (
                model.firstProgressMono -
                model.dispatchedMono
              ) *
              1000,
            ) / 1000,
      since_last_progress_ms:
        model.lastProgressMono == null
          ? null
          : Math.round(
              (
                now -
                model.lastProgressMono
              ) *
              1000,
            ) / 1000,
      max_progress_gap_ms:
        Math.round(
          model.maxProgressGapMs *
          1000,
        ) / 1000,
      content_captured: false,
    },
  )
}

function observeProgress(
  model,
  deltaBytes,
  {
    countDelta = true,
  } = {},
) {
  const now =
    performance.now()

  if (
    model.firstProgressMono == null
  ) {
    model.firstProgressMono =
      now
  }

  if (
    model.lastProgressMono != null
  ) {
    model.maxProgressGapMs =
      Math.max(
        model.maxProgressGapMs,
        now -
          model.lastProgressMono,
      )
  }

  model.lastProgressMono = now

  if (countDelta) {
    model.deltaEvents += 1
    model.deltaBytes +=
      Math.max(
        0,
        deltaBytes,
      )
  }
}

function safeJsonBytes(value) {
  try {
    return bytes(
      JSON.stringify(value),
    )
  } catch {
    return null
  }
}

export async function mirrorProjectTraceTelemetry(
  root,
  sourceTraceFile,
  record,
) {
  if (
    !record ||
    typeof record !== "object"
  ) {
    return
  }

  const sessionID =
    typeof record.sessionID === "string"
      ? record.sessionID
      : null

  const turnID =
    typeof record.turnID === "string"
      ? record.turnID
      : (
          typeof record.task_turn_id === "string"
            ? record.task_turn_id
            : null
        )

  const state =
    ensureTrace(
      sessionID,
      turnID,
    )

  if (!state) return

  const sourceKind =
    typeof record.kind === "string"
      ? record.kind
      : null

  if (
    sourceKind === "model_dispatch"
  ) {
    stopModelSampler(
      state.activeModel,
    )

    state.activeModel =
      createModelState(
        state,
        record,
      )

    await appendTelemetry(
      root,
      {
        ...envelope(
          state,
          {
            component:
              "inference",
            operation:
              "model_call",
            event:
              "start",
            spanID:
              state.activeModel.spanID,
          },
        ),
        source_trace_file:
          sourceTraceFile,
        ...projectScalarFields(
          record,
        ),
        physical_inference_protocol:
          PHYSICAL_INFERENCE_PROTOCOL,
        inference_lifecycle_protocol:
          INFERENCE_LIFECYCLE_PROTOCOL,
        client_progress_signal:
          "opencode_public_events",
        server_progress_signal:
          "llama_slots_and_metrics",
        content_captured: false,
        model_context_overhead_bytes: 0,
      },
    )

    startModelSampler(
      root,
      state,
      state.activeModel,
    )

    return
  }

  if (
    sourceKind === "model_usage"
  ) {
    const model =
      state.activeModel

    if (model) {
      const logicalCompleteMono =
        performance.now()

      markInferenceLogicalComplete(
        model.inferenceLifecycle,
        logicalCompleteMono,
      )

      // One exact post-response snapshot closes the logical->physical
      // ownership handshake without making quiescence solver authority.
      await emitResourceSample(
        root,
        state,
        model,
        "model_finish",
      )

      stopModelSampler(
        model,
      )

      const now =
        performance.now()

      await appendTelemetry(
        root,
        {
          ...envelope(
            state,
            {
              component:
                "inference",
              operation:
                "model_call",
              event:
                "finish",
              spanID:
                model.spanID,
            },
          ),
          source_trace_file:
            sourceTraceFile,
          ...projectScalarFields(
            record,
          ),
          model_call:
            model.modelCall,
          duration_ms:
            Math.round(
              (
                now -
                model.dispatchedMono
              ) *
              1000,
            ) / 1000,
          time_to_first_progress_ms:
            model.firstProgressMono ==
              null
              ? null
              : Math.round(
                  (
                    model.firstProgressMono -
                    model.dispatchedMono
                  ) *
                  1000,
                ) / 1000,
          last_progress_age_ms:
            model.lastProgressMono ==
              null
              ? null
              : Math.round(
                  (
                    now -
                    model.lastProgressMono
                  ) *
                  1000,
                ) / 1000,
          output_delta_events:
            model.deltaEvents,
          output_delta_bytes:
            model.deltaBytes,
          tool_raw_bytes_max:
            model.toolRawBytesMax,
          tool_input_bytes_max:
            model.toolInputBytesMax,
          max_progress_gap_ms:
            Math.round(
              model.maxProgressGapMs *
              1000,
            ) / 1000,
          inference_lifecycle:
            snapshotInferenceLifecycle(
              model.inferenceLifecycle,
            ),
          content_captured: false,
        },
      )

      state.activeModel = null
      return
    }
  }

  await appendTelemetry(
    root,
    {
      ...envelope(
        state,
        {
          component:
            sourceComponent(
              sourceTraceFile,
              sourceKind,
            ),
          operation:
            sourceKind ??
            sourceTraceFile
              .replace(
                /\.jsonl$/u,
                "",
              ),
          event:
            "observation",
          spanID:
            spanIdentity(
              state.traceID,
              (
                sourceTraceFile +
                ":" +
                String(
                  sourceKind ??
                  "record",
                ) +
                ":" +
                String(
                  state.seq + 1,
                )
              ),
            ),
        },
      ),
      source_trace_file:
        sourceTraceFile,
      ...projectScalarFields(
        record,
      ),
      content_captured: false,
    },
  )
}

export async function observePublicEventTelemetry({
  root,
  event,
  sessionID,
  turnID,
}) {
  const state =
    ensureTrace(
      sessionID,
      turnID,
    )

  if (
    !state ||
    !event ||
    typeof event !== "object"
  ) {
    return
  }

  const model =
    state.activeModel

  if (!model) {
    return
  }

  const type =
    event.type

  const properties =
    event.properties ??
    event

  if (
    type ===
      "message.part.delta"
  ) {
    const delta =
      typeof properties.delta ===
        "string"
        ? properties.delta
        : ""

    const partID =
      typeof properties.partID ===
        "string"
        ? properties.partID
        : null

    const partType =
      partID
        ? (
            model.partTypes.get(
              partID,
            ) ??
            "unknown"
          )
        : "unknown"

    observeProgress(
      model,
      bytes(delta),
    )

    maybeProgressCheckpoint(
      root,
      state,
      model,
      {
        force:
          model.deltaEvents === 1,
        progressKind:
          partType,
        partID,
        field:
          properties.field ?? null,
      },
    )

    return
  }

  if (
    type ===
      "message.part.updated"
  ) {
    const part =
      properties.part

    if (
      !part ||
      typeof part !== "object"
    ) {
      return
    }

    if (
      typeof part.id === "string" &&
      typeof part.type === "string"
    ) {
      model.partTypes.set(
        part.id,
        part.type,
      )
    }

    if (
      part.type === "text" ||
      part.type === "reasoning"
    ) {
      const snapshotBytes =
        typeof part.text === "string"
          ? bytes(part.text)
          : null

      await appendTelemetry(
        root,
        {
          ...envelope(
            state,
            {
              component:
                "inference",
              operation:
                "provider_part",
              event:
                "snapshot",
              spanID:
                model.spanID,
            },
          ),
          model_call:
            model.modelCall,
          part_type:
            part.type,
          part_id_hash:
            typeof part.id === "string"
              ? digest(
                  part.id,
                  16,
                )
              : null,
          snapshot_bytes:
            snapshotBytes,
          content_captured: false,
        },
      )

      return
    }

    if (part.type === "tool") {
      const status =
        typeof part.state?.status ===
          "string"
          ? part.state.status
          : null

      const rawBytes =
        typeof part.state?.raw ===
          "string"
          ? bytes(
              part.state.raw,
            )
          : null

      const inputBytes =
        part.state?.input != null
          ? safeJsonBytes(
              part.state.input,
            )
          : null

      if (
        Number.isFinite(rawBytes)
      ) {
        model.toolRawBytesMax =
          Math.max(
            model.toolRawBytesMax,
            rawBytes,
          )
      }

      if (
        Number.isFinite(inputBytes)
      ) {
        model.toolInputBytesMax =
          Math.max(
            model.toolInputBytesMax,
            inputBytes,
          )
      }

      const stateChanged =
        status !==
        model.toolStatus

      model.toolStatus = status

      if (
        stateChanged ||
        Number.isFinite(rawBytes) ||
        Number.isFinite(inputBytes)
      ) {
        observeProgress(
          model,
          0,
          {
            countDelta: false,
          },
        )
      }

      await appendTelemetry(
        root,
        {
          ...envelope(
            state,
            {
              component:
                "inference",
              operation:
                "tool_call_assembly",
              event:
                "state",
              spanID:
                model.spanID,
            },
          ),
          model_call:
            model.modelCall,
          part_id_hash:
            typeof part.id === "string"
              ? digest(
                  part.id,
                  16,
                )
              : null,
          call_id_hash:
            typeof part.callID ===
              "string"
              ? digest(
                  part.callID,
                  16,
                )
              : null,
          tool:
            typeof part.tool === "string"
              ? part.tool
              : null,
          tool_status:
            status,
          tool_raw_bytes:
            rawBytes,
          tool_input_bytes:
            inputBytes,
          content_captured: false,
        },
      )

      maybeProgressCheckpoint(
        root,
        state,
        model,
        {
          force:
            stateChanged,
          progressKind:
            "tool",
          partID:
            part.id ?? null,
          field:
            status,
        },
      )

      return
    }

    if (
      part.type === "step-finish"
    ) {
      maybeProgressCheckpoint(
        root,
        state,
        model,
        {
          force: true,
          progressKind:
            "step-finish",
          partID:
            part.id ?? null,
          field:
            part.reason ?? null,
        },
      )
    }

    return
  }

  if (
    type === "session.error"
  ) {
    await appendTelemetry(
      root,
      {
        ...envelope(
          state,
          {
            component:
              "inference",
            operation:
              "provider_stream",
            event:
              "error",
            spanID:
              model.spanID,
          },
        ),
        model_call:
          model.modelCall,
        error_name:
          typeof properties.error?.name ===
            "string"
            ? properties.error.name
            : null,
        content_captured: false,
      },
    )
  }
}

export async function stopAllTelemetrySamplers() {
  for (const state of traces.values()) {
    stopModelSampler(
      state.activeModel,
    )
    state.activeModel = null
  }
}

export function telemetryTestTraceIdentity(
  sessionID,
  turnID,
) {
  return traceIdentity(
    sessionID,
    turnID,
  )
}
