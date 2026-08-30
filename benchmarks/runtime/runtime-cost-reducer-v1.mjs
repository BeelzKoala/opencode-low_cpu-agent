import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const RUNTIME_COST_REDUCER_PROTOCOL = "runtime-cost-reducer-v1"
export const RUNTIME_COST_REPORT_PROTOCOL = "runtime-cost-report-v1"
export const RUNTIME_COST_OBSERVATION_PROTOCOL = "runtime-cost-observation-v1"

export const RUNTIME_RESOURCE_CLASS_HINT = Object.freeze({
  EXCLUSIVE_CPU: "exclusive_cpu",
  CPU_BOUNDED: "cpu_bounded",
  IO_MIXED: "io_mixed",
  MUTATION_SERIAL: "mutation_serial",
})

const MODEL_DISPATCH_KIND = "model_dispatch"
const MODEL_COMPLETION_KIND = "model_completion"

function finiteMs(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function boundedString(value, max = 256) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

function nonNegativeDelta(end, start) {
  const a = finiteMs(end)
  const b = finiteMs(start)
  if (a === null || b === null || a < b) return null
  return Math.round(a - b)
}

function observationKey(row) {
  const sessionID = boundedString(row?.sessionID, 512)
  const turnID = boundedString(row?.turnID, 512)
  const modelCall = Number.isInteger(row?.model_call) ? row.model_call : null
  if (!sessionID || !turnID || modelCall === null || modelCall < 1) return null
  return `${sessionID}\u0000${turnID}\u0000${modelCall}`
}

function classifyCompletion(row) {
  if (row?.error != null) return "error"
  const finish = String(row?.finish ?? "").toLowerCase()
  if (finish.includes("cancel") || finish.includes("abort")) return "cancelled"
  if (finish.includes("tool")) return "tool_call"
  return "assistant_no_tool"
}

function sortedRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .slice()
    .sort((a, b) => (finiteMs(a.ts) ?? 0) - (finiteMs(b.ts) ?? 0))
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

function profileKey(row) {
  return JSON.stringify({
    providerID: boundedString(row.providerID, 128),
    modelID: boundedString(row.modelID, 128),
    phase: boundedString(row.execution_state, 64),
    frontier_sha256: boundedString(row.tool_frontier_schema_sha256, 128),
  })
}

function modelObservations(cpuRows, result) {
  const dispatches = sortedRows(cpuRows).filter(
    (row) => row.kind === MODEL_DISPATCH_KIND,
  )
  const completions = sortedRows(cpuRows).filter(
    (row) =>
      row.kind === MODEL_COMPLETION_KIND &&
      (
        row.cost_observation_protocol === RUNTIME_COST_OBSERVATION_PROTOCOL ||
        row.protocol === RUNTIME_COST_OBSERVATION_PROTOCOL
      ),
  )

  const dispatchByKey = new Map()
  const completionByKey = new Map()
  const conflicts = []

  for (const row of dispatches) {
    const key = observationKey(row)
    if (!key) {
      conflicts.push({
        kind: "invalid_model_dispatch_identity",
        ts: finiteMs(row.ts),
      })
      continue
    }
    if (dispatchByKey.has(key)) {
      conflicts.push({
        kind: "duplicate_model_dispatch",
        key,
      })
      continue
    }
    dispatchByKey.set(key, row)
  }

  for (const row of completions) {
    const key = observationKey(row)
    if (!key) {
      conflicts.push({
        kind: "invalid_model_completion_identity",
        ts: finiteMs(row.ts),
      })
      continue
    }
    if (completionByKey.has(key)) {
      conflicts.push({
        kind: "duplicate_model_completion",
        key,
      })
      continue
    }
    completionByKey.set(key, row)
  }

  const cliEndedAtMs = finiteMs(result?.cli_ended_at_ms)
  const cliTimedOut = result?.cli_timed_out === true
  const rows = []

  for (const [key, dispatch] of dispatchByKey.entries()) {
    const completion = completionByKey.get(key) ?? null
    const dispatchAtMs = finiteMs(dispatch.ts)

    if (completion) {
      const observedAtMs =
        finiteMs(completion.observed_at_ms) ??
        finiteMs(completion.ts)
      const createdAtMs = finiteMs(completion.message_created_at_ms)
      const completedAtMs = finiteMs(completion.message_completed_at_ms)

      rows.push(Object.freeze({
        kind: "model_cost_observation",
        status: "completed_observation",
        censored: false,
        exact_model_latency_ms: null,
        exact_model_latency_available: false,
        boundary_semantics:
          "multiple_observed_boundaries_no_provider_latency_claim",
        sessionID: dispatch.sessionID,
        turnID: dispatch.turnID,
        model_call: dispatch.model_call,
        providerID: boundedString(dispatch.providerID, 128),
        modelID: boundedString(dispatch.modelID, 128),
        execution_state: boundedString(dispatch.execution_state, 64),
        tool_frontier_schema_sha256:
          boundedString(dispatch.tool_frontier_schema_sha256, 128),
        context_bytes: Number.isFinite(dispatch.context_bytes)
          ? Math.max(0, Math.trunc(dispatch.context_bytes))
          : null,
        outcome: classifyCompletion(completion),
        dispatch_at_ms: dispatchAtMs,
        observed_at_ms: observedAtMs,
        message_created_at_ms: createdAtMs,
        message_completed_at_ms: completedAtMs,
        dispatch_to_observed_ms:
          nonNegativeDelta(observedAtMs, dispatchAtMs),
        dispatch_to_message_completed_ms:
          nonNegativeDelta(completedAtMs, dispatchAtMs),
        message_created_to_completed_ms:
          nonNegativeDelta(completedAtMs, createdAtMs),
        message_completion_to_observed_ms:
          nonNegativeDelta(observedAtMs, completedAtMs),
        finish: boundedString(completion.finish, 128),
        error: boundedString(completion.error, 256),
        messageID: boundedString(completion.messageID, 512),
        resource_class_hint: RUNTIME_RESOURCE_CLASS_HINT.EXCLUSIVE_CPU,
        scheduling_authority: false,
        mutation_authority: false,
      }))
      completionByKey.delete(key)
      continue
    }

    const censored =
      cliTimedOut &&
      dispatchAtMs !== null &&
      cliEndedAtMs !== null &&
      cliEndedAtMs >= dispatchAtMs

    rows.push(Object.freeze({
      kind: "model_cost_observation",
      status: censored
        ? "right_censored_at_cli_termination"
        : "open_unresolved",
      censored,
      exact_model_latency_ms: null,
      exact_model_latency_available: false,
      boundary_semantics: censored
        ? "dispatch_survived_until_observed_cli_termination"
        : "dispatch_without_completion_boundary",
      sessionID: dispatch.sessionID,
      turnID: dispatch.turnID,
      model_call: dispatch.model_call,
      providerID: boundedString(dispatch.providerID, 128),
      modelID: boundedString(dispatch.modelID, 128),
      execution_state: boundedString(dispatch.execution_state, 64),
      tool_frontier_schema_sha256:
        boundedString(dispatch.tool_frontier_schema_sha256, 128),
      context_bytes: Number.isFinite(dispatch.context_bytes)
        ? Math.max(0, Math.trunc(dispatch.context_bytes))
        : null,
      outcome: null,
      dispatch_at_ms: dispatchAtMs,
      observed_at_ms: null,
      message_created_at_ms: null,
      message_completed_at_ms: null,
      elapsed_lower_bound_ms: censored
        ? nonNegativeDelta(cliEndedAtMs, dispatchAtMs)
        : null,
      resource_class_hint: RUNTIME_RESOURCE_CLASS_HINT.EXCLUSIVE_CPU,
      scheduling_authority: false,
      mutation_authority: false,
      telemetry_gap: !censored,
    }))
  }

  for (const [key, completion] of completionByKey.entries()) {
    conflicts.push({
      kind: "orphan_model_completion",
      key,
      ts: finiteMs(completion.ts),
    })
  }

  return { rows, conflicts }
}

function pushStage(out, {
  stage,
  substage = null,
  elapsedMs,
  resourceClassHint,
  costKind,
  sourceTrace,
  sourceProtocol,
  sourceKind = null,
}) {
  const elapsed = finiteMs(elapsedMs)
  if (elapsed === null) return

  out.push(Object.freeze({
    kind: "runtime_stage_cost",
    stage,
    substage,
    elapsed_ms: Math.round(elapsed * 100) / 100,
    resource_class_hint: resourceClassHint,
    cost_kind: costKind,
    source_trace: sourceTrace,
    source_protocol: boundedString(sourceProtocol, 128),
    source_kind: boundedString(sourceKind, 128),
    scheduling_authority: false,
    mutation_authority: false,
  }))
}

function stageCosts(searchRows, executorRows, cpuRows) {
  const out = []

  for (const row of sortedRows(cpuRows)) {
    if (row.kind !== "deterministic_scout_preflight") continue
    pushStage(out, {
      stage: "deterministic_scout_preflight",
      elapsedMs: row.elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.IO_MIXED,
      costKind: "aggregate",
      sourceTrace: "cpu-agent-trace.jsonl",
      sourceProtocol: row.protocol,
      sourceKind: row.kind,
    })
  }

  for (const row of sortedRows(searchRows)) {
    const common = {
      sourceTrace: "search-trace.jsonl",
      sourceProtocol: row.protocol,
      sourceKind: row.kind,
    }
    pushStage(out, {
      ...common,
      stage: "scout_search",
      elapsedMs: row.elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.IO_MIXED,
      costKind: "aggregate",
    })
    pushStage(out, {
      ...common,
      stage: "scout_lexical_discovery",
      elapsedMs: row.discovery_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.IO_MIXED,
      costKind: "component",
    })
    pushStage(out, {
      ...common,
      stage: "retrieval_ranker",
      elapsedMs: row.retrieval_ranker_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.CPU_BOUNDED,
      costKind: "component",
    })
    pushStage(out, {
      ...common,
      stage: "impact_index",
      elapsedMs: row.impact_index_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.CPU_BOUNDED,
      costKind: "component",
    })
    pushStage(out, {
      ...common,
      stage: "impact_validation",
      elapsedMs: row.impact_validation_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.CPU_BOUNDED,
      costKind: "component",
    })
    pushStage(out, {
      ...common,
      stage: "semantic_impact",
      elapsedMs: row.semantic_impact_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.CPU_BOUNDED,
      costKind: "component",
    })
  }

  for (const row of sortedRows(executorRows)) {
    const common = {
      sourceTrace: "executor-trace.jsonl",
      sourceProtocol: row.protocol,
      sourceKind: row.kind,
    }
    pushStage(out, {
      ...common,
      stage: "mutation_tool",
      elapsedMs: row.tool_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.MUTATION_SERIAL,
      costKind: "aggregate",
    })
    pushStage(out, {
      ...common,
      stage: "patch_compiler",
      elapsedMs: row.compiler_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.CPU_BOUNDED,
      costKind: "component",
    })
    pushStage(out, {
      ...common,
      stage: "patch_executor",
      elapsedMs: row.executor_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.MUTATION_SERIAL,
      costKind: "component",
    })
    pushStage(out, {
      ...common,
      stage: "invariant_verifier",
      elapsedMs: row.verifier_elapsed_ms,
      resourceClassHint: RUNTIME_RESOURCE_CLASS_HINT.CPU_BOUNDED,
      costKind: "component",
    })
  }

  return out
}

function buildProfiles(modelRows) {
  const groups = new Map()

  for (const row of modelRows) {
    const key = profileKey(row)
    const group = groups.get(key) ?? {
      identity: JSON.parse(key),
      completed_dispatch_to_message_completed_ms: [],
      completed_dispatch_to_observed_ms: [],
      censored_lower_bounds_ms: [],
      outcomes: {},
    }

    if (
      row.status === "completed_observation" &&
      Number.isFinite(row.dispatch_to_message_completed_ms)
    ) {
      group.completed_dispatch_to_message_completed_ms.push(
        row.dispatch_to_message_completed_ms,
      )
    }
    if (
      row.status === "completed_observation" &&
      Number.isFinite(row.dispatch_to_observed_ms)
    ) {
      group.completed_dispatch_to_observed_ms.push(
        row.dispatch_to_observed_ms,
      )
    }
    if (
      row.censored === true &&
      Number.isFinite(row.elapsed_lower_bound_ms)
    ) {
      group.censored_lower_bounds_ms.push(row.elapsed_lower_bound_ms)
    }
    const outcome = row.outcome ?? row.status
    group.outcomes[outcome] = (group.outcomes[outcome] ?? 0) + 1
    groups.set(key, group)
  }

  return [...groups.values()]
    .map((group) => {
      const completed = group.completed_dispatch_to_message_completed_ms
      const observed = group.completed_dispatch_to_observed_ms
      const censored = group.censored_lower_bounds_ms
      return Object.freeze({
        identity: group.identity,
        completed_n: completed.length,
        censored_n: censored.length,
        completed_dispatch_to_message_completed_p50_ms: median(completed),
        completed_dispatch_to_message_completed_p90_ms:
          nearestRank(completed, 0.90),
        completed_dispatch_to_observed_p50_ms: median(observed),
        completed_dispatch_to_observed_p90_ms:
          nearestRank(observed, 0.90),
        max_censored_lower_bound_ms:
          censored.length > 0 ? Math.max(...censored) : null,
        outcomes: group.outcomes,
        scheduling_authority: false,
      })
    })
    .sort((a, b) =>
      JSON.stringify(a.identity).localeCompare(JSON.stringify(b.identity)),
    )
}

export function reduceRuntimeCostReport({
  cpuAgentRows = [],
  searchRows = [],
  executorRows = [],
  result = {},
} = {}) {
  const model = modelObservations(cpuAgentRows, result)
  const stages = stageCosts(searchRows, executorRows, cpuAgentRows)

  return Object.freeze({
    protocol: RUNTIME_COST_REPORT_PROTOCOL,
    reducer_protocol: RUNTIME_COST_REDUCER_PROTOCOL,
    observation_protocol: RUNTIME_COST_OBSERVATION_PROTOCOL,
    authority: "shadow_observation",
    scheduling_authority: false,
    mutation_authority: false,
    source_result_protocol: boundedString(result?.protocol, 128),
    cli_timed_out: result?.cli_timed_out === true,
    cli_started_at_ms: finiteMs(result?.cli_started_at_ms),
    cli_ended_at_ms: finiteMs(result?.cli_ended_at_ms),
    model_observations: model.rows,
    model_profiles_shadow: buildProfiles(model.rows),
    stage_costs: stages,
    telemetry_conflicts: model.conflicts,
  })
}

async function readJson(pathname) {
  try {
    return JSON.parse(await readFile(pathname, "utf8"))
  } catch {
    return {}
  }
}

async function readJsonLines(pathname) {
  try {
    const body = await readFile(pathname, "utf8")
    const out = []
    for (const line of body.split(/\r?\n/u)) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === "object") out.push(value)
      } catch {
        // Reducer is best-effort telemetry and never fabricates invalid rows.
      }
    }
    return out
  } catch {
    return []
  }
}

export async function reduceArtifactDirectory(artifactDir) {
  const root = path.resolve(artifactDir)
  const report = reduceRuntimeCostReport({
    cpuAgentRows: await readJsonLines(path.join(root, "cpu-agent-trace.jsonl")),
    searchRows: await readJsonLines(path.join(root, "search-trace.jsonl")),
    executorRows: await readJsonLines(path.join(root, "executor-trace.jsonl")),
    result: await readJson(path.join(root, "result.json")),
  })
  await writeFile(
    path.join(root, "runtime-cost-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  )
  return report
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const artifactDir = process.argv[2]
  if (!artifactDir) {
    console.error("usage: node runtime-cost-reducer-v1.mjs <artifact-dir>")
    process.exitCode = 2
  } else {
    try {
      const report = await reduceArtifactDirectory(artifactDir)
      console.log(
        `PASS ${RUNTIME_COST_REDUCER_PROTOCOL} ` +
        `model=${report.model_observations.length} ` +
        `stages=${report.stage_costs.length} ` +
        `conflicts=${report.telemetry_conflicts.length}`,
      )
    } catch (error) {
      console.error(String(error?.stack ?? error))
      process.exitCode = 1
    }
  }
}
