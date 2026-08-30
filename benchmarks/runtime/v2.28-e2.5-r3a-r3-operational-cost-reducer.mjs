import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  RUNTIME_COST_REDUCER_PROTOCOL,
  RUNTIME_COST_REPORT_PROTOCOL,
  reduceRuntimeCostReport,
} from "./runtime-cost-reducer-v2.mjs"
import {
  RUNTIME_COST_BACKFILL_PROTOCOL,
  aggregateBackfillReports,
  backfillRuntimeCostTree,
} from "./runtime-cost-backfill-v1.mjs"

const dispatch = ({
  ts = 1_000,
  call = 1,
  sessionID = "s1",
  turnID = "user:1",
  frontier = ["execute_additive_plan"],
  frontierSha = "a".repeat(64),
  agentProtocol = "cpu-agent-v2.8.0-mutation-confinement-2",
} = {}) => ({
  ts,
  protocol: agentProtocol,
  kind: "model_dispatch",
  sessionID,
  turnID,
  model_call: call,
  providerID: "local",
  modelID: "north-mini-code-local",
  execution_state: "mutate",
  tool_frontier_protocol: "causal-tool-frontier-v2.5-deterministic-action",
  mutation_tool_abi_protocol: "capability-mutation-tools-v2",
  tool_frontier_names: frontier,
  tool_frontier_schema_sha256: frontierSha,
  context_bytes: 12_445,
})

const toolUse = ({
  sessionID = "s1",
  tool = "execute_additive_plan",
  start = 2_000,
  end = 2_100,
  messageID = "assistant:1",
} = {}) => ({
  type: "tool_use",
  timestamp: end,
  sessionID,
  part: {
    partID: `${messageID}:part`,
    sessionID,
    messageID,
    type: "tool",
    tool,
    state: {
      status: "completed",
      time: { start, end },
    },
  },
})

const completion = ({
  ts = 2_300,
  call = 1,
  sessionID = "s1",
  turnID = "user:1",
  finish = "stop",
  completed = 2_200,
} = {}) => ({
  ts,
  protocol: "cpu-agent-v2.8.0-mutation-confinement-2",
  cost_observation_protocol: "runtime-cost-observation-v1",
  kind: "model_completion",
  sessionID,
  turnID,
  model_call: call,
  observed_at_ms: ts,
  message_completed_at_ms: completed,
  finish,
  error: null,
})

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [dispatch()],
    agentRows: [toolUse({ start: 233_312, end: 254_374 })],
  })
  assert.equal(report.protocol, RUNTIME_COST_REPORT_PROTOCOL)
  assert.equal(report.reducer_protocol, RUNTIME_COST_REDUCER_PROTOCOL)
  assert.equal(report.telemetry_conflicts.length, 0)
  const row = report.model_observations[0]
  assert.equal(row.status, "actionable_tool_boundary")
  assert.equal(row.operational_boundary_kind, "first_tool_start")
  assert.equal(row.dispatch_to_actionable_boundary_ms, 232_312)
  assert.equal(row.actionable_tool, "execute_additive_plan")
  assert.equal(row.exact_model_latency_ms, null)
  assert.equal(row.telemetry_gap, false)
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [dispatch({ ts: 10_000 })],
    agentRows: [toolUse({ start: 20_000, end: 50_000 })],
  })
  assert.equal(report.model_observations[0].dispatch_to_actionable_boundary_ms, 10_000)
  assert.notEqual(report.model_observations[0].dispatch_to_actionable_boundary_ms, 40_000)
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [
      dispatch({ ts: 10_000, call: 1 }),
      dispatch({ ts: 20_000, call: 2 }),
    ],
    agentRows: [toolUse({ start: 25_000, messageID: "assistant:2" })],
  })
  assert.equal(report.model_observations[0].status, "open_unresolved")
  assert.equal(report.model_observations[1].status, "actionable_tool_boundary")
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [dispatch()],
    agentRows: [toolUse({ tool: "search" })],
  })
  assert.equal(report.model_observations[0].status, "open_unresolved")
  assert.equal(
    report.telemetry_conflicts.some((row) => row.kind === "tool_boundary_outside_dispatch_frontier"),
    true,
  )
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [
      dispatch({ sessionID: "s-no-tool" }),
      completion({ sessionID: "s-no-tool" }),
    ],
  })
  const row = report.model_observations[0]
  assert.equal(row.status, "message_completion_boundary")
  assert.equal(row.outcome, "assistant_no_tool")
  assert.equal(row.dispatch_to_actionable_boundary_ms, 1_200)
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [dispatch({ ts: 10_000, sessionID: "s-timeout" })],
    result: {
      protocol: "real-task-benchmark-v1",
      cli_timed_out: true,
      cli_started_at_ms: 9_000,
      cli_ended_at_ms: 310_000,
    },
  })
  const row = report.model_observations[0]
  assert.equal(row.status, "right_censored_at_cli_termination")
  assert.equal(row.elapsed_lower_bound_ms, 300_000)
}

{
  const a = reduceRuntimeCostReport({
    cpuAgentRows: [dispatch({ frontierSha: "a".repeat(64) })],
    agentRows: [toolUse({ start: 2_000 })],
  })
  const b = reduceRuntimeCostReport({
    cpuAgentRows: [dispatch({
      sessionID: "s2",
      turnID: "user:2",
      frontierSha: "b".repeat(64),
    })],
    agentRows: [toolUse({ sessionID: "s2", start: 3_000 })],
  })
  const aggregate = aggregateBackfillReports([{ report: a }, { report: b }])
  assert.equal(aggregate.protocol, RUNTIME_COST_BACKFILL_PROTOCOL)
  assert.equal(aggregate.compatible_profiles_shadow.length, 2)
  assert.equal(aggregate.model_observations, 2)
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [{
      ts: 50_000,
      protocol: "cpu-agent-v2",
      kind: "deterministic_scout_preflight",
      elapsed_ms: 652.59,
    }],
    searchRows: [{
      ts: 50_000,
      protocol: "search-v2",
      elapsed_ms: 650.72,
      semantic_impact_elapsed_ms: 155.09,
    }],
    executorRows: [{
      ts: 60_000,
      protocol: "execution-loop-v1",
      tool_elapsed_ms: 18.74,
      compiler_elapsed_ms: 13.42,
    }],
  })
  const byStage = new Map(report.stage_costs.map((row) => [row.stage, row]))
  assert.equal(byStage.get("scout_search").cost_kind, "aggregate")
  assert.equal(byStage.get("semantic_impact").cost_kind, "component")
  assert.equal(byStage.get("mutation_tool").resource_class_hint, "mutation_serial")
}

{
  const root = await mkdtemp(path.join(os.tmpdir(), "r3a-r3-backfill-"))
  const artifact = path.join(root, "old-run", "task")
  await mkdir(artifact, { recursive: true })
  await writeFile(
    path.join(artifact, "cpu-agent-trace.jsonl"),
    JSON.stringify(dispatch()) + "\n",
    "utf8",
  )
  await writeFile(
    path.join(artifact, "agent.stdout.jsonl"),
    JSON.stringify(toolUse({ start: 2_000 })) + "\n",
    "utf8",
  )
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify({ protocol: "real-task-benchmark-v1", cli_timed_out: false }),
    "utf8",
  )
  const result = await backfillRuntimeCostTree(root, { maxArtifacts: 8 })
  assert.equal(result.artifacts_scanned, 1)
  assert.equal(result.model_observations, 1)
  await access(path.join(root, "runtime-cost-backfill.json"))
  let childReportExists = true
  try { await access(path.join(artifact, "runtime-cost-report.json")) } catch { childReportExists = false }
  assert.equal(childReportExists, false)
}

{
  const partsDir = path.resolve("opencode/plugins/cpu-search.fragments")
  const fragments = []
  for (let index = 0; index < 10; index += 1) {
    const name = `${String(index).padStart(2, "0")}.part.ts`
    try { fragments.push(await readFile(path.join(partsDir, name), "utf8")) } catch {}
  }
  const source = fragments.join("\n")
  const harness = await readFile(path.resolve("benchmarks/runtime/v2.17-real-task.py"), "utf8")

  assert.equal((source.match(/kind: "model_completion"/g) ?? []).length, 1)
  assert.match(source, /runtime-cost-observation-v1/u)
  assert.doesNotMatch(source, /runtime-cost-reducer-v2/u)
  assert.match(harness, /runtime-cost-reducer-v2\.mjs/u)
  assert.doesNotMatch(harness, /runtime-cost-reducer-v1\.mjs/u)
}

console.log(
  "PASS E2.5/R3A-R3 operational actionable-boundary reducer + compatible historical backfill contract",
)
