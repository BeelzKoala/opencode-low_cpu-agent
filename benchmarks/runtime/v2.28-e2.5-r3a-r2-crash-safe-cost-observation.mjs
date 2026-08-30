import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  RUNTIME_COST_OBSERVATION_PROTOCOL,
  RUNTIME_COST_REDUCER_PROTOCOL,
  RUNTIME_COST_REPORT_PROTOCOL,
  reduceRuntimeCostReport,
} from "./runtime-cost-reducer-v1.mjs"

const dispatch = ({
  ts = 1_000,
  call = 1,
  phase = "mutate",
  sessionID = "s1",
  turnID = "user:1",
} = {}) => ({
  ts,
  protocol: "cpu-agent-v2",
  kind: "model_dispatch",
  sessionID,
  turnID,
  model_call: call,
  providerID: "local",
  modelID: "north-mini-code-local",
  execution_state: phase,
  tool_frontier_schema_sha256: "a".repeat(64),
  context_bytes: 12_445,
})

const completion = ({
  ts = 1_700,
  call = 1,
  finish = "tool-calls",
  sessionID = "s1",
  turnID = "user:1",
  created = 1_100,
  completed = 1_600,
} = {}) => ({
  ts,
  protocol: "cpu-agent-v2",
  cost_observation_protocol: RUNTIME_COST_OBSERVATION_PROTOCOL,
  kind: "model_completion",
  sessionID,
  turnID,
  model_call: call,
  observed_at_ms: ts,
  message_created_at_ms: created,
  message_completed_at_ms: completed,
  messageID: `assistant:${call}`,
  finish,
  error: null,
})

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [dispatch(), completion()],
    result: {
      protocol: "real-task-benchmark-v1",
      cli_timed_out: false,
      cli_started_at_ms: 900,
      cli_ended_at_ms: 2_000,
    },
  })

  assert.equal(report.protocol, RUNTIME_COST_REPORT_PROTOCOL)
  assert.equal(report.reducer_protocol, RUNTIME_COST_REDUCER_PROTOCOL)
  assert.equal(report.scheduling_authority, false)
  assert.equal(report.mutation_authority, false)
  assert.equal(report.telemetry_conflicts.length, 0)

  const row = report.model_observations[0]
  assert.equal(row.status, "completed_observation")
  assert.equal(row.outcome, "tool_call")
  assert.equal(row.exact_model_latency_ms, null)
  assert.equal(row.exact_model_latency_available, false)
  assert.equal(row.dispatch_to_observed_ms, 700)
  assert.equal(row.dispatch_to_message_completed_ms, 600)
  assert.equal(row.message_created_to_completed_ms, 500)
  assert.equal(row.message_completion_to_observed_ms, 100)
  assert.match(row.boundary_semantics, /no_provider_latency_claim/u)
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [
      dispatch({ ts: 10_000, sessionID: "s-timeout" }),
    ],
    result: {
      protocol: "real-task-benchmark-v1",
      cli_timed_out: true,
      cli_started_at_ms: 9_000,
      cli_ended_at_ms: 310_000,
    },
  })
  const row = report.model_observations[0]
  assert.equal(row.status, "right_censored_at_cli_termination")
  assert.equal(row.censored, true)
  assert.equal(row.elapsed_lower_bound_ms, 300_000)
  assert.equal(row.exact_model_latency_ms, null)
  assert.equal(report.model_profiles_shadow[0].censored_n, 1)
  assert.equal(
    report.model_profiles_shadow[0].max_censored_lower_bound_ms,
    300_000,
  )
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [
      dispatch({ ts: 20_000, sessionID: "s-open" }),
    ],
    result: {
      protocol: "real-task-benchmark-v1",
      cli_timed_out: false,
      cli_started_at_ms: 19_000,
      cli_ended_at_ms: 25_000,
    },
  })
  const row = report.model_observations[0]
  assert.equal(row.status, "open_unresolved")
  assert.equal(row.censored, false)
  assert.equal(row.elapsed_lower_bound_ms, null)
  assert.equal(row.telemetry_gap, true)
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [
      dispatch({ sessionID: "s-no-tool" }),
      completion({
        sessionID: "s-no-tool",
        finish: "stop",
      }),
    ],
  })
  assert.equal(
    report.model_observations[0].outcome,
    "assistant_no_tool",
  )
}

{
  const row = dispatch({ sessionID: "s-dup" })
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [row, { ...row }],
  })
  assert.equal(
    report.telemetry_conflicts.some(
      (item) => item.kind === "duplicate_model_dispatch",
    ),
    true,
  )
}

{
  const report = reduceRuntimeCostReport({
    cpuAgentRows: [{
      ts: 50_000,
      protocol: "cpu-agent-v2",
      kind: "deterministic_scout_preflight",
      elapsed_ms: 848.08,
    }],
    searchRows: [{
      ts: 50_000,
      protocol: "search-v2",
      elapsed_ms: 831,
      discovery_elapsed_ms: 39.07,
      retrieval_ranker_elapsed_ms: 74.45,
      impact_index_elapsed_ms: 1.85,
      impact_validation_elapsed_ms: 3.15,
      semantic_impact_elapsed_ms: 359.6,
    }],
    executorRows: [{
      ts: 60_000,
      protocol: "execution-loop-v1",
      tool_elapsed_ms: 62.82,
      compiler_elapsed_ms: 10,
      executor_elapsed_ms: 20,
      verifier_elapsed_ms: 30,
    }],
  })

  const byStage = new Map(
    report.stage_costs.map((row) => [row.stage, row]),
  )
  assert.equal(
    byStage.get("deterministic_scout_preflight").resource_class_hint,
    "io_mixed",
  )
  assert.equal(
    byStage.get("semantic_impact").resource_class_hint,
    "cpu_bounded",
  )
  assert.equal(
    byStage.get("patch_executor").resource_class_hint,
    "mutation_serial",
  )
  assert.equal(byStage.get("scout_search").cost_kind, "aggregate")
  assert.equal(byStage.get("semantic_impact").cost_kind, "component")
}

{
  const partsDir = path.resolve("opencode/plugins/cpu-search.fragments")
  const fragments = []
  for (let index = 0; index < 10; index += 1) {
    const name = `${String(index).padStart(2, "0")}.part.ts`
    try {
      fragments.push(await readFile(path.join(partsDir, name), "utf8"))
    } catch {
      // Source contract below is fail-closed on required markers.
    }
  }
  const source = fragments.join("\n")
  const harness = await readFile(
    path.resolve("benchmarks/runtime/v2.17-real-task.py"),
    "utf8",
  )
  const reducerSource = await readFile(
    path.resolve("benchmarks/runtime/runtime-cost-reducer-v1.mjs"),
    "utf8",
  )

  assert.match(
    source,
    /const RUNTIME_COST_OBSERVATION_PROTOCOL = "runtime-cost-observation-v1"/u,
  )
  assert.equal(
    (source.match(/kind: "model_completion"/g) ?? []).length,
    1,
  )
  assert.match(source, /cost_observation_protocol: RUNTIME_COST_OBSERVATION_PROTOCOL/u)
  assert.match(source, /model_call: state\.modelCalls/u)

  // R3A online aggregation is retired from current production authority.
  assert.doesNotMatch(source, /runtimeCostLedger/u)
  assert.doesNotMatch(source, /startModelCostSpan/u)
  assert.doesNotMatch(source, /finishModelCostSpan/u)
  assert.doesNotMatch(source, /runtimeCostRecordsFromTrace/u)
  assert.doesNotMatch(source, /RUNTIME_COST_TRACE_FILE/u)
  assert.doesNotMatch(source, /runtime-cost-ledger-v1\.mjs/u)

  assert.match(harness, /"cli_started_at_ms": agent\["started_at_ms"\]/u)
  assert.match(harness, /"cli_ended_at_ms": agent\["ended_at_ms"\]/u)
  assert.match(harness, /runtime-cost-reducer-v1\.mjs/u)
  // The harness invokes the reducer; the reducer owns the report filename.
  // Requiring the report filename to appear in harness source couples the
  // gate to an implementation detail and caused the original R3A-R2 failure.
  assert.match(reducerSource, /runtime-cost-report\.json/u)
}

console.log(
  "PASS E2.5/R3A-R2 crash-safe model cost observation + deterministic reducer contract",
)
