import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  RUNTIME_COST_AUTHORITY,
  RUNTIME_COST_LEDGER_PROTOCOL,
  RUNTIME_COST_PROFILE_SAMPLE_CAP,
  RUNTIME_COST_TRACE_PROTOCOL,
  RUNTIME_RESOURCE_CLASS,
  createRuntimeCostLedgerState,
  finishModelCostSpan,
  resetRuntimeCostLedgerTurn,
  runtimeCostRecordsFromTrace,
  startModelCostSpan,
  summarizeRuntimeCostSamples,
} from "../../opencode/plugins/cpu-search-core/runtime-cost-ledger-v1.mjs"

{
  const state = createRuntimeCostLedgerState()
  assert.equal(state.protocol, RUNTIME_COST_LEDGER_PROTOCOL)
  assert.equal(state.authority, RUNTIME_COST_AUTHORITY)

  assert.equal(resetRuntimeCostLedgerTurn(state, "user:1"), true)

  const start = startModelCostSpan(state, {
    startedAtMs: 1_000,
    sessionID: "s1",
    turnID: "user:1",
    dispatchSeq: 1,
    providerID: "local",
    modelID: "north-mini",
    phase: "mutate",
    frontierSha256: "a".repeat(64),
    contextBytes: 12_445,
  })
  assert.equal(start.ok, true)

  const finish = finishModelCostSpan(state, {
    currentTurnID: "user:1",
    observedAtMs: 1_900,
    providerStartedAtMs: 1_100,
    completedAtMs: 1_600,
    messageID: "assistant:1",
    finish: "tool-calls",
  })
  assert.equal(finish.ok, true)
  assert.equal(finish.record.protocol, RUNTIME_COST_TRACE_PROTOCOL)
  assert.equal(finish.record.authority, "shadow_observation")
  assert.equal(finish.record.mutation_authority, false)
  assert.equal(finish.record.scheduling_authority, false)
  assert.equal(finish.record.resource_class, "exclusive_cpu")
  assert.equal(finish.record.outcome, "tool_call")
  assert.equal(finish.record.elapsed_ms, 500)
  assert.equal(
    finish.record.boundary_quality,
    "assistant_message_timestamps",
  )
  // Critical regression: delayed event delivery / tool execution must not
  // inflate the model cost from 500 ms to the 900 ms observation boundary.
  assert.notEqual(finish.record.elapsed_ms, 900)
}

{
  const state = createRuntimeCostLedgerState()
  resetRuntimeCostLedgerTurn(state, "user:2")
  assert.equal(startModelCostSpan(state, {
    startedAtMs: 10_000,
    sessionID: "s2",
    turnID: "user:2",
    providerID: "local",
    modelID: "north-mini",
    phase: "mutate",
    frontierSha256: "b".repeat(64),
  }).ok, true)

  const noTool = finishModelCostSpan(state, {
    currentTurnID: "user:2",
    observedAtMs: 10_700,
    completedAtMs: 10_650,
    messageID: "assistant:2",
    finish: "stop",
  })
  assert.equal(noTool.ok, true)
  assert.equal(noTool.record.outcome, "assistant_no_tool")
  assert.equal(noTool.record.elapsed_ms, 650)
  assert.equal(noTool.record.profile_shadow.samples, 1)
}

{
  const state = createRuntimeCostLedgerState()
  resetRuntimeCostLedgerTurn(state, "user:new")
  startModelCostSpan(state, {
    startedAtMs: 20_000,
    sessionID: "s3",
    turnID: "user:new",
    providerID: "local",
    modelID: "north-mini",
    phase: "repair",
    frontierSha256: "c".repeat(64),
  })
  const stale = finishModelCostSpan(state, {
    currentTurnID: "user:old",
    observedAtMs: 20_500,
    finish: "stop",
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.reason, "runtime_cost_model_completion_stale_turn")
  assert.ok(state.activeModel)
}

{
  const state = createRuntimeCostLedgerState()
  resetRuntimeCostLedgerTurn(state, "user:4")
  assert.equal(startModelCostSpan(state, {
    startedAtMs: 30_000,
    sessionID: "s4",
    turnID: "user:4",
  }).ok, true)
  const overlap = startModelCostSpan(state, {
    startedAtMs: 30_001,
    sessionID: "s4",
    turnID: "user:4",
  })
  assert.equal(overlap.ok, false)
  assert.equal(overlap.reason, "runtime_cost_model_span_already_active")
}

{
  const profile = summarizeRuntimeCostSamples([
    115_714,
    126_513,
    147_646,
    168_733,
    279_374,
  ])
  assert.equal(profile.samples, 5)
  assert.equal(profile.p50_ms, 147_646)
  assert.equal(profile.p90_ms, 279_374)
  assert.equal(profile.max_ms, 279_374)

  const bounded = createRuntimeCostLedgerState()
  resetRuntimeCostLedgerTurn(bounded, "user:bounded")
  for (let index = 0; index < RUNTIME_COST_PROFILE_SAMPLE_CAP + 3; index += 1) {
    assert.equal(startModelCostSpan(bounded, {
      startedAtMs: 40_000 + index * 100,
      sessionID: "bounded",
      turnID: "user:bounded",
      providerID: "local",
      modelID: "north-mini",
      phase: "mutate",
      frontierSha256: "d".repeat(64),
    }).ok, true)
    assert.equal(finishModelCostSpan(bounded, {
      currentTurnID: "user:bounded",
      observedAtMs: 40_050 + index * 100,
      finish: "stop",
    }).ok, true)
  }
  const onlyProfile = [...bounded.profiles.values()][0]
  assert.equal(onlyProfile.length, RUNTIME_COST_PROFILE_SAMPLE_CAP)
}

{
  const search = runtimeCostRecordsFromTrace("search-trace.jsonl", {
    ts: 50_000,
    protocol: "search-v2",
    sessionID: "s5",
    turnID: "user:5",
    elapsed_ms: 850,
    discovery_elapsed_ms: 68,
    retrieval_ranker_elapsed_ms: 109,
    impact_index_elapsed_ms: 3,
    impact_validation_elapsed_ms: 4,
    semantic_impact_elapsed_ms: 241,
  })
  assert.equal(search[0].stage, "scout_search")
  assert.equal(search[0].cost_kind, "aggregate")
  assert.equal(search[0].resource_class, RUNTIME_RESOURCE_CLASS.IO_MIXED)
  assert.equal(search.some((row) => row.stage === "semantic_impact"), true)
  assert.equal(
    search.find((row) => row.stage === "semantic_impact").resource_class,
    RUNTIME_RESOURCE_CLASS.CPU_BOUNDED,
  )

  const mutation = runtimeCostRecordsFromTrace("executor-trace.jsonl", {
    ts: 60_000,
    protocol: "execution-loop-v1",
    sessionID: "s5",
    turnID: "user:5",
    tool_elapsed_ms: 62.82,
    compiler_elapsed_ms: 10,
    executor_elapsed_ms: 20,
    verifier_elapsed_ms: 30,
  })
  assert.equal(mutation[0].stage, "mutation_tool")
  assert.equal(mutation[0].cost_kind, "aggregate")
  assert.equal(
    mutation.find((row) => row.stage === "patch_executor").resource_class,
    RUNTIME_RESOURCE_CLASS.MUTATION_SERIAL,
  )
}

{
  const scout = runtimeCostRecordsFromTrace("cpu-agent-trace.jsonl", {
    ts: 70_000,
    protocol: "cpu-agent-v2",
    kind: "deterministic_scout_preflight",
    sessionID: "s6",
    turnID: "user:6",
    elapsed_ms: 674.07,
  })
  assert.equal(scout.length, 1)
  assert.equal(scout[0].stage, "deterministic_scout_preflight")
  assert.equal(scout[0].scheduling_authority, false)
}

{
  // Production wiring contract: R3A must be observation-only.
  const partsDir = path.resolve("opencode/plugins/cpu-search.fragments")
  const fragments = []
  for (let index = 0; index < 10; index += 1) {
    const name = `${String(index).padStart(2, "0")}.part.ts`
    try {
      fragments.push(await readFile(path.join(partsDir, name), "utf8"))
    } catch {
      // Fragment manifests are authoritative; this loop is only a cheap
      // source check and tolerates absent numeric slots.
    }
  }
  const source = fragments.join("\n")
  assert.equal(
    (source.match(/runtime-cost-ledger-v1\.mjs/g) ?? []).length,
    1,
  )
  assert.equal(
    (source.match(/runtimeCostLedger: createRuntimeCostLedgerState\(\)/g) ?? []).length,
    1,
  )
  assert.equal(
    (source.match(/startModelCostSpan\(state\.runtimeCostLedger/g) ?? []).length,
    1,
  )
  assert.equal(
    (source.match(/finishModelCostSpan\(state\.runtimeCostLedger/g) ?? []).length,
    1,
  )
  assert.match(source, /runtimeCostRecordsFromTrace\(fileName, record\)/u)
  assert.doesNotMatch(source, /runtimeCost.*interrupt/u)
  assert.doesNotMatch(source, /runtimeCost.*allowedTools/u)
}

console.log(
  "PASS E2.5/R3A Runtime Cost Ledger records truthful bounded shadow costs without changing scheduling authority",
)
