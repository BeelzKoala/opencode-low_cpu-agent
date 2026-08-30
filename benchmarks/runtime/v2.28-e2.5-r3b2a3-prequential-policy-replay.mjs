import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  buildRuntimeCostDeadlineIndex,
} from "./runtime-cost-deadline-index-v1.mjs"
import {
  PREQUENTIAL_DECISION,
  PREQUENTIAL_OUTCOME,
  RUNTIME_COST_PREQUENTIAL_REPLAY_PROTOCOL,
  RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL,
  computeRuntimeCostPolicyParetoFrontier,
  runRuntimeCostPrequentialReplay,
} from "./runtime-cost-prequential-replay-v1.mjs"

const ID = {
  providerID: "local",
  modelID: "north-mini-code-local",
  phase: "mutate",
  frontier_sha256: "b".repeat(64),
  agent_protocol: "cpu-agent-v2.8.0-mutation-confinement-2",
  tool_frontier_protocol: "causal-tool-frontier-v2.5-deterministic-action",
  mutation_tool_abi_protocol: "capability-mutation-tools-v2",
}

function observation({
  call,
  dispatch,
  actionable = null,
  censored = null,
  unresolved = false,
  context = 12_000,
  session = "s1",
  turn = "user:1",
}) {
  return {
    providerID: ID.providerID,
    modelID: ID.modelID,
    execution_state: ID.phase,
    tool_frontier_schema_sha256: ID.frontier_sha256,
    agent_protocol: ID.agent_protocol,
    tool_frontier_protocol: ID.tool_frontier_protocol,
    mutation_tool_abi_protocol: ID.mutation_tool_abi_protocol,
    sessionID: session,
    turnID: turn,
    model_call: call,
    dispatch_at_ms: dispatch,
    context_bytes: context,
    status:
      actionable !== null
        ? "actionable_tool_boundary"
        : censored !== null
          ? "right_censored_at_cli_termination"
          : unresolved
            ? "open_unresolved"
            : "message_completion_boundary",
    outcome: actionable !== null ? "tool_call" : null,
    censored: censored !== null,
    dispatch_to_actionable_boundary_ms: actionable,
    elapsed_lower_bound_ms: censored,
  }
}

const rows = [
  observation({ call: 1, dispatch: 1_000, actionable: 100 }),
  observation({ call: 2, dispatch: 2_000, censored: 400 }),
  observation({ call: 3, dispatch: 3_000, actionable: 150 }),
  observation({ call: 4, dispatch: 4_000, actionable: 350 }),
  observation({ call: 5, dispatch: 5_000, unresolved: true }),
  observation({ call: 6, dispatch: 6_000, actionable: 180 }),
]

const spec = {
  protocol: RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL,
  scenarios: [{ id: "w250", identity: ID, model_window_ms: 250 }],
  policies: [
    { id: "any-known-miss", min_known_miss_n: 1 },
    { id: "repeat-known-miss", min_known_miss_n: 2 },
    {
      id: "bounded4-any-miss",
      min_known_miss_n: 1,
      min_bounded_n: 4,
    },
    {
      id: "miss-lower-quarter",
      min_known_miss_n: 1,
      min_total_n: 4,
      min_miss_lower_bound: { numerator: 1, denominator: 4 },
    },
    {
      id: "miss-and-low-unknown",
      min_known_miss_n: 1,
      min_total_n: 4,
      max_unknown_fraction: { numerator: 1, denominator: 4 },
    },
  ],
}

{
  const replay = runRuntimeCostPrequentialReplay(
    buildRuntimeCostDeadlineIndex(rows),
    spec,
  )
  assert.equal(replay.protocol, RUNTIME_COST_PREQUENTIAL_REPLAY_PROTOCOL)
  assert.equal(replay.status, "REPLAYED")
  assert.equal(replay.admission_authority, false)
  assert.equal(replay.policy_selection_authority, false)
  assert.equal(replay.promotion_authority, false)

  const scenario = replay.scenarios[0]
  assert.equal(
    scenario.replay_semantics,
    "strict-past-prequential-with-equal-timestamp-batching",
  )
  const anyMiss = scenario.policy_results.find(
    (row) => row.policy.id === "any-known-miss",
  )
  assert.deepEqual(anyMiss.metrics, {
    decision_n: 6,
    block_n: 4,
    legacy_n: 2,
    blocked_known_miss_n: 1,
    blocked_known_meet_n: 2,
    blocked_unknown_n: 1,
    legacy_known_miss_n: 1,
    legacy_known_meet_n: 1,
    legacy_unknown_n: 0,
    blocked_known_miss_cost_lower_bound_ms: 350,
    blocked_known_meet_cost_ms: 330,
  })
  assert.equal(
    anyMiss.decision_trace[1].decision,
    PREQUENTIAL_DECISION.LEGACY,
  )
  assert.equal(
    anyMiss.decision_trace[1].actual_outcome_at_window,
    PREQUENTIAL_OUTCOME.KNOWN_MISS,
  )
  assert.equal(anyMiss.decision_trace[1].prior_known_miss_n, 0)
  assert.equal(anyMiss.decision_trace[2].prior_known_miss_n, 1)
  assert.equal(
    anyMiss.decision_trace[2].decision,
    PREQUENTIAL_DECISION.BLOCK,
  )
  assert.ok(scenario.pareto_frontier_policy_ids.length >= 1)
  for (const row of scenario.policy_results) {
    if (!scenario.pareto_frontier_policy_ids.includes(row.policy.id)) {
      assert.ok(row.dominated_by.length >= 1)
    }
  }
}

{
  // Pareto logic is tested independently from replay outcomes.
  const frontier = computeRuntimeCostPolicyParetoFrontier([
    {
      policy_id: "better",
      metrics: {
        blocked_known_miss_n: 2,
        blocked_known_miss_cost_lower_bound_ms: 500,
        blocked_known_meet_n: 0,
        blocked_known_meet_cost_ms: 0,
        blocked_unknown_n: 0,
      },
    },
    {
      policy_id: "worse",
      metrics: {
        blocked_known_miss_n: 2,
        blocked_known_miss_cost_lower_bound_ms: 500,
        blocked_known_meet_n: 1,
        blocked_known_meet_cost_ms: 100,
        blocked_unknown_n: 0,
      },
    },
  ])
  assert.deepEqual(frontier, ["better"])
}

{
  // Equal timestamp is one strict-past batch.
  const replay = runRuntimeCostPrequentialReplay(
    buildRuntimeCostDeadlineIndex([
      observation({
        call: 1,
        dispatch: 1_000,
        censored: 400,
        session: "a",
        turn: "u:a",
      }),
      observation({
        call: 1,
        dispatch: 1_000,
        actionable: 100,
        session: "b",
        turn: "u:b",
      }),
      observation({
        call: 1,
        dispatch: 2_000,
        actionable: 120,
        session: "c",
        turn: "u:c",
      }),
    ]),
    {
      protocol: RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL,
      scenarios: [{ id: "w250", identity: ID, model_window_ms: 250 }],
      policies: [{ id: "any", min_known_miss_n: 1 }],
    },
  )
  const trace = replay.scenarios[0].policy_results[0].decision_trace
  assert.equal(trace[0].prior_total_n, 0)
  assert.equal(trace[1].prior_total_n, 0)
  assert.equal(trace[0].decision, PREQUENTIAL_DECISION.LEGACY)
  assert.equal(trace[1].decision, PREQUENTIAL_DECISION.LEGACY)
  assert.equal(trace[2].prior_total_n, 2)
  assert.equal(trace[2].prior_known_miss_n, 1)
  assert.equal(trace[2].decision, PREQUENTIAL_DECISION.BLOCK)
}

{
  // No unconditional blocking policy can be represented.
  const replay = runRuntimeCostPrequentialReplay(
    buildRuntimeCostDeadlineIndex(rows),
    {
      protocol: RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL,
      scenarios: [{ id: "w250", identity: ID, model_window_ms: 250 }],
      policies: [{ id: "bad", min_known_miss_n: 0 }],
    },
  )
  assert.equal(replay.status, "EVIDENCE_INSUFFICIENT")
  assert.equal(replay.reason, "spec_semantic_invalid")
}

{
  // Exact integer cross-products: 1/3 prior miss lower bound meets 1/3.
  const replay = runRuntimeCostPrequentialReplay(
    buildRuntimeCostDeadlineIndex(rows),
    {
      protocol: RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL,
      scenarios: [{ id: "w250", identity: ID, model_window_ms: 250 }],
      policies: [{
        id: "exact-third",
        min_known_miss_n: 1,
        min_total_n: 3,
        min_miss_lower_bound: { numerator: 1, denominator: 3 },
      }],
    },
  )
  const trace = replay.scenarios[0].policy_results[0].decision_trace
  assert.equal(trace[3].prior_total_n, 3)
  assert.equal(trace[3].prior_known_miss_n, 1)
  assert.equal(trace[3].decision, PREQUENTIAL_DECISION.BLOCK)
}

{
  // Context condition uses only prior context evidence.
  const replay = runRuntimeCostPrequentialReplay(
    buildRuntimeCostDeadlineIndex([
      observation({ call: 1, dispatch: 1_000, censored: 400, context: 10_000 }),
      observation({ call: 2, dispatch: 2_000, actionable: 100, context: 50_000 }),
    ]),
    {
      protocol: RUNTIME_COST_PREQUENTIAL_SPEC_PROTOCOL,
      scenarios: [{ id: "w250", identity: ID, model_window_ms: 250 }],
      policies: [{
        id: "context-safe",
        min_known_miss_n: 1,
        require_context_in_observed_range: true,
      }],
    },
  )
  const trace = replay.scenarios[0].policy_results[0].decision_trace
  assert.equal(trace[1].prior_known_miss_n, 1)
  assert.equal(trace[1].current_context_inside_prior_range, false)
  assert.equal(trace[1].decision, PREQUENTIAL_DECISION.LEGACY)
}

{
  // Canonical chronological index removes input-order dependence.
  const a = runRuntimeCostPrequentialReplay(
    buildRuntimeCostDeadlineIndex(rows),
    spec,
  )
  const b = runRuntimeCostPrequentialReplay(
    buildRuntimeCostDeadlineIndex([
      rows[5], rows[1], rows[4], rows[0], rows[3], rows[2],
    ]),
    spec,
  )
  assert.deepEqual(a, b)
  assert.equal(a.content_sha256, b.content_sha256)
}

{
  // Tampered source evidence fails closed before replay.
  const index = buildRuntimeCostDeadlineIndex(rows)
  const tampered = JSON.parse(JSON.stringify(index))
  tampered.series[0].observation_stream[0].duration_ms = 999
  const replay = runRuntimeCostPrequentialReplay(tampered, spec)
  assert.equal(replay.status, "EVIDENCE_INSUFFICIENT")
  assert.equal(replay.reason, "deadline_index_invalid")
}

{
  const plugin = await readFile(
    path.resolve("opencode/plugins/cpu-search.ts"),
    "utf8",
  )
  const governor = await readFile(
    path.resolve("opencode/plugins/cpu-search-core/governor-latency-v1.mjs"),
    "utf8",
  )
  assert.doesNotMatch(plugin, /runtime-cost-prequential-replay-v1/u)
  assert.doesNotMatch(governor, /runtime-cost-prequential-replay-v1/u)
}

console.log(
  "PASS E2.5/R3B2-A3 strict-past prequential replay compares negative-only policies with exact count/rational conditions and Pareto dominance without look-ahead or Governor authority",
)
