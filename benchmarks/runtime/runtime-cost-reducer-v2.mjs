import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  RUNTIME_COST_OBSERVATION_PROTOCOL,
  RUNTIME_RESOURCE_CLASS_HINT,
  reduceRuntimeCostReport as reduceV1,
} from "./runtime-cost-reducer-v1.mjs"

export const RUNTIME_COST_REDUCER_PROTOCOL = "runtime-cost-reducer-v2"
export const RUNTIME_COST_REPORT_PROTOCOL = "runtime-cost-report-v2"

function finiteMs(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function boundedString(value, max = 256) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

function delta(end, start) {
  const a = finiteMs(end)
  const b = finiteMs(start)
  if (a === null || b === null || a < b) return null
  return Math.round(a - b)
}

function keyFor(row) {
  const sessionID = boundedString(row?.sessionID, 512)
  const turnID = boundedString(row?.turnID, 512)
  const call = Number.isInteger(row?.model_call) ? row.model_call : null
  if (!sessionID || !turnID || call === null || call < 1) return null
  return `${sessionID}\u0000${turnID}\u0000${call}`
}

function rowSessionID(row) {
  return boundedString(row?.sessionID, 512)
    ?? boundedString(row?.part?.sessionID, 512)
}

function sorted(rows, field = "ts") {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .slice()
    .sort((a, b) => (finiteMs(a?.[field]) ?? 0) - (finiteMs(b?.[field]) ?? 0))
}

function nearestRank(values, q) {
  if (values.length < 1) return null
  const xs = values.slice().sort((a, b) => a - b)
  const rank = Math.max(1, Math.min(xs.length, Math.ceil(q * xs.length)))
  return xs[rank - 1]
}

function median(values) {
  if (values.length < 1) return null
  const xs = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 1 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2)
}

function completionOutcome(row) {
  if (row?.error != null) return "error"
  const finish = String(row?.finish ?? "").toLowerCase()
  if (finish.includes("cancel") || finish.includes("abort")) return "cancelled"
  if (finish.includes("tool")) return "tool_call"
  return "assistant_no_tool"
}

function completionMap(cpuRows, conflicts) {
  const out = new Map()
  for (const row of sorted(cpuRows)) {
    if (row.kind !== "model_completion") continue
    if (
      row.cost_observation_protocol !== RUNTIME_COST_OBSERVATION_PROTOCOL &&
      row.protocol !== RUNTIME_COST_OBSERVATION_PROTOCOL
    ) continue
    const key = keyFor(row)
    if (!key) {
      conflicts.push({ kind: "invalid_model_completion_identity", ts: finiteMs(row.ts) })
      continue
    }
    if (out.has(key)) {
      conflicts.push({ kind: "duplicate_model_completion", key })
      continue
    }
    out.set(key, row)
  }
  return out
}

function toolStarts(agentRows) {
  const out = []
  for (const row of Array.isArray(agentRows) ? agentRows : []) {
    if (row?.type !== "tool_use") continue
    const part = row.part
    const state = part?.state
    const start = finiteMs(state?.time?.start)
    const tool = boundedString(part?.tool, 128)
    const sessionID = rowSessionID(row)
    if (start === null || !tool || !sessionID) continue
    out.push({
      sessionID,
      tool,
      started_at_ms: start,
      ended_at_ms: finiteMs(state?.time?.end),
      messageID: boundedString(part?.messageID, 512),
      partID: boundedString(part?.partID, 512),
    })
  }
  return out.sort((a, b) => a.started_at_ms - b.started_at_ms)
}

function frontier(dispatch) {
  return new Set(
    (Array.isArray(dispatch?.tool_frontier_names) ? dispatch.tool_frontier_names : [])
      .map((value) => boundedString(value, 128))
      .filter(Boolean),
  )
}

function nextDispatchTs(dispatches, index) {
  const current = dispatches[index]
  for (let i = index + 1; i < dispatches.length; i += 1) {
    if (dispatches[i].sessionID !== current.sessionID) continue
    const ts = finiteMs(dispatches[i].ts)
    if (ts !== null) return ts
  }
  return null
}

function actionableBoundary(dispatch, nextTs, tools, conflicts) {
  const start = finiteMs(dispatch.ts)
  if (start === null) return null
  const allowed = frontier(dispatch)
  const valid = []
  for (const tool of tools) {
    if (tool.sessionID !== dispatch.sessionID) continue
    if (tool.started_at_ms < start) continue
    if (nextTs !== null && tool.started_at_ms >= nextTs) continue
    if (allowed.size > 0 && !allowed.has(tool.tool)) {
      conflicts.push({
        kind: "tool_boundary_outside_dispatch_frontier",
        sessionID: dispatch.sessionID,
        turnID: dispatch.turnID,
        model_call: dispatch.model_call,
        tool: tool.tool,
        tool_started_at_ms: tool.started_at_ms,
      })
      continue
    }
    valid.push(tool)
  }
  if (valid.length < 1) return null
  return {
    ...valid[0],
    candidate_count: valid.length,
    validation: allowed.size > 0
      ? "session_interval_and_frontier"
      : "session_interval_only",
  }
}

function identity(row) {
  return {
    providerID: boundedString(row.providerID, 128),
    modelID: boundedString(row.modelID, 128),
    phase: boundedString(row.execution_state, 64),
    frontier_sha256: boundedString(row.tool_frontier_schema_sha256, 128),
    agent_protocol: boundedString(row.agent_protocol, 128),
    tool_frontier_protocol: boundedString(row.tool_frontier_protocol, 128),
    mutation_tool_abi_protocol: boundedString(row.mutation_tool_abi_protocol, 128),
  }
}

export function buildRuntimeCostProfiles(rows) {
  const groups = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = identity(row)
    const key = JSON.stringify(id)
    const group = groups.get(key) ?? {
      identity: id,
      actionable: [],
      censored: [],
      unresolved: 0,
      outcomes: {},
    }
    if (Number.isFinite(row.dispatch_to_actionable_boundary_ms) && row.censored !== true) {
      group.actionable.push(row.dispatch_to_actionable_boundary_ms)
    }
    if (row.censored === true && Number.isFinite(row.elapsed_lower_bound_ms)) {
      group.censored.push(row.elapsed_lower_bound_ms)
    }
    if (row.status === "open_unresolved") group.unresolved += 1
    const outcome = row.outcome ?? row.status
    group.outcomes[outcome] = (group.outcomes[outcome] ?? 0) + 1
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    identity: group.identity,
    actionable_n: group.actionable.length,
    censored_n: group.censored.length,
    unresolved_n: group.unresolved,
    actionable_p50_ms: median(group.actionable),
    actionable_p90_ms: nearestRank(group.actionable, 0.90),
    actionable_max_ms: group.actionable.length ? Math.max(...group.actionable) : null,
    max_censored_lower_bound_ms: group.censored.length ? Math.max(...group.censored) : null,
    outcomes: group.outcomes,
    scheduling_authority: false,
  })).sort((a, b) => JSON.stringify(a.identity).localeCompare(JSON.stringify(b.identity)))
}

function operationalModelRows(cpuRows, agentRows, result) {
  const dispatches = sorted(cpuRows).filter((row) => row.kind === "model_dispatch")
  const conflicts = []
  const completions = completionMap(cpuRows, conflicts)
  const tools = toolStarts(agentRows)
  const seen = new Set()
  const rows = []
  const cliEnd = finiteMs(result?.cli_ended_at_ms)
  const cliTimedOut = result?.cli_timed_out === true

  for (let index = 0; index < dispatches.length; index += 1) {
    const dispatch = dispatches[index]
    const key = keyFor(dispatch)
    if (!key) {
      conflicts.push({ kind: "invalid_model_dispatch_identity", ts: finiteMs(dispatch.ts) })
      continue
    }
    if (seen.has(key)) {
      conflicts.push({ kind: "duplicate_model_dispatch", key })
      continue
    }
    seen.add(key)

    const dispatchAt = finiteMs(dispatch.ts)
    const completion = completions.get(key) ?? null
    const tool = actionableBoundary(dispatch, nextDispatchTs(dispatches, index), tools, conflicts)
    const common = {
      kind: "model_cost_observation",
      exact_model_latency_ms: null,
      exact_model_latency_available: false,
      sessionID: dispatch.sessionID,
      turnID: dispatch.turnID,
      model_call: dispatch.model_call,
      providerID: boundedString(dispatch.providerID, 128),
      modelID: boundedString(dispatch.modelID, 128),
      execution_state: boundedString(dispatch.execution_state, 64),
      tool_frontier_schema_sha256: boundedString(dispatch.tool_frontier_schema_sha256, 128),
      agent_protocol: boundedString(dispatch.protocol, 128),
      tool_frontier_protocol: boundedString(dispatch.tool_frontier_protocol, 128),
      mutation_tool_abi_protocol: boundedString(dispatch.mutation_tool_abi_protocol, 128),
      context_bytes: Number.isFinite(dispatch.context_bytes) ? Math.max(0, Math.trunc(dispatch.context_bytes)) : null,
      dispatch_at_ms: dispatchAt,
      resource_class_hint: RUNTIME_RESOURCE_CLASS_HINT.EXCLUSIVE_CPU,
      scheduling_authority: false,
      mutation_authority: false,
    }

    if (tool) {
      if (completion && completionOutcome(completion) === "assistant_no_tool") {
        conflicts.push({ kind: "completion_tool_boundary_contradiction", key, tool: tool.tool })
      }
      rows.push({
        ...common,
        status: "actionable_tool_boundary",
        censored: false,
        telemetry_gap: false,
        outcome: "tool_call",
        boundary_semantics: "dispatch_to_first_validated_tool_start_operational_cost",
        operational_boundary_kind: "first_tool_start",
        actionable_tool: tool.tool,
        actionable_tool_started_at_ms: tool.started_at_ms,
        actionable_tool_ended_at_ms: tool.ended_at_ms,
        actionable_boundary_validation: tool.validation,
        actionable_candidate_count: tool.candidate_count,
        dispatch_to_actionable_boundary_ms: delta(tool.started_at_ms, dispatchAt),
      })
      if (completion) completions.delete(key)
      continue
    }

    if (completion) {
      const observed = finiteMs(completion.observed_at_ms) ?? finiteMs(completion.ts)
      const completed = finiteMs(completion.message_completed_at_ms)
      rows.push({
        ...common,
        status: "message_completion_boundary",
        censored: false,
        telemetry_gap: false,
        outcome: completionOutcome(completion),
        boundary_semantics: "message_completion_operational_boundary_no_provider_latency_claim",
        operational_boundary_kind: "message_completion",
        dispatch_to_actionable_boundary_ms: delta(completed ?? observed, dispatchAt),
        observed_at_ms: observed,
        message_created_at_ms: finiteMs(completion.message_created_at_ms),
        message_completed_at_ms: completed,
      })
      completions.delete(key)
      continue
    }

    const censored = cliTimedOut && dispatchAt !== null && cliEnd !== null && cliEnd >= dispatchAt
    rows.push({
      ...common,
      status: censored ? "right_censored_at_cli_termination" : "open_unresolved",
      censored,
      telemetry_gap: !censored,
      outcome: null,
      boundary_semantics: censored
        ? "dispatch_survived_until_observed_cli_termination"
        : "dispatch_without_actionable_or_completion_boundary",
      operational_boundary_kind: null,
      dispatch_to_actionable_boundary_ms: null,
      elapsed_lower_bound_ms: censored ? delta(cliEnd, dispatchAt) : null,
    })
  }

  for (const [key, completion] of completions.entries()) {
    conflicts.push({ kind: "orphan_model_completion", key, ts: finiteMs(completion.ts) })
  }
  return { rows, conflicts }
}

export function reduceRuntimeCostReport({
  cpuAgentRows = [],
  agentRows = [],
  searchRows = [],
  executorRows = [],
  result = {},
} = {}) {
  const base = reduceV1({ cpuAgentRows, searchRows, executorRows, result })
  const model = operationalModelRows(cpuAgentRows, agentRows, result)
  return Object.freeze({
    ...base,
    protocol: RUNTIME_COST_REPORT_PROTOCOL,
    reducer_protocol: RUNTIME_COST_REDUCER_PROTOCOL,
    model_observations: model.rows,
    model_profiles_shadow: buildRuntimeCostProfiles(model.rows),
    telemetry_conflicts: model.conflicts,
  })
}

async function readJson(pathname) {
  try { return JSON.parse(await readFile(pathname, "utf8")) } catch { return {} }
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
      } catch {}
    }
    return out
  } catch { return [] }
}

export async function loadArtifactDirectory(artifactDir) {
  const root = path.resolve(artifactDir)
  return reduceRuntimeCostReport({
    cpuAgentRows: await readJsonLines(path.join(root, "cpu-agent-trace.jsonl")),
    agentRows: await readJsonLines(path.join(root, "agent.stdout.jsonl")),
    searchRows: await readJsonLines(path.join(root, "search-trace.jsonl")),
    executorRows: await readJsonLines(path.join(root, "executor-trace.jsonl")),
    result: await readJson(path.join(root, "result.json")),
  })
}

export async function reduceArtifactDirectory(artifactDir) {
  const root = path.resolve(artifactDir)
  const report = await loadArtifactDirectory(root)
  await writeFile(path.join(root, "runtime-cost-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8")
  return report
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const artifactDir = process.argv[2]
  if (!artifactDir) {
    console.error("usage: node runtime-cost-reducer-v2.mjs <artifact-dir>")
    process.exitCode = 2
  } else {
    try {
      const report = await reduceArtifactDirectory(artifactDir)
      const actionable = report.model_observations.filter((row) => Number.isFinite(row.dispatch_to_actionable_boundary_ms)).length
      console.log(`PASS ${RUNTIME_COST_REDUCER_PROTOCOL} model=${report.model_observations.length} actionable=${actionable} stages=${report.stage_costs.length} conflicts=${report.telemetry_conflicts.length}`)
    } catch (error) {
      console.error(String(error?.stack ?? error))
      process.exitCode = 1
    }
  }
}
