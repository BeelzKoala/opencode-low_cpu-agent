import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  DEADLINE_WINDOW_EVIDENCE_STATUS,
  RUNTIME_COST_DEADLINE_INDEX_PROTOCOL,
  RUNTIME_COST_DEADLINE_REQUEST_PROTOCOL,
  buildRuntimeCostDeadlineIndex,
  evaluateRuntimeCostDeadlineCertificate,
  materializeRuntimeCostDeadlineIndex,
  verifyRuntimeCostDeadlineIndexDocument,
} from "./runtime-cost-deadline-index-v1.mjs"

const ID = {
  providerID: "local",
  modelID: "north-mini-code-local",
  phase: "mutate",
  frontier_sha256:
    "b4211972f2332bfd367161cd82f498e524b66ce5cd28d46fcc89f03d5c3c338c",
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
  context = 12_445,
  identity = ID,
  session = "s1",
  turn = "user:1",
}) {
  return {
    providerID: identity.providerID,
    modelID: identity.modelID,
    execution_state: identity.phase,
    tool_frontier_schema_sha256: identity.frontier_sha256,
    agent_protocol: identity.agent_protocol,
    tool_frontier_protocol: identity.tool_frontier_protocol,
    mutation_tool_abi_protocol: identity.mutation_tool_abi_protocol,
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

function request(window, context = 12_445, identity = ID) {
  return {
    protocol: RUNTIME_COST_DEADLINE_REQUEST_PROTOCOL,
    identity,
    model_window_ms: window,
    context_bytes: context,
    window_kind: "effective_model_window",
  }
}

const rows = [
  observation({ call: 1, dispatch: 1_000, actionable: 100 }),
  observation({ call: 2, dispatch: 2_000, actionable: 200 }),
  observation({ call: 3, dispatch: 3_000, actionable: 300 }),
  observation({ call: 4, dispatch: 4_000, censored: 250 }),
  observation({ call: 5, dispatch: 5_000, censored: 400 }),
  observation({ call: 6, dispatch: 6_000, unresolved: true }),
  observation({ call: 7, dispatch: 7_000, unresolved: true }),
]

{
  const index = buildRuntimeCostDeadlineIndex(rows)
  assert.equal(index.protocol, RUNTIME_COST_DEADLINE_INDEX_PROTOCOL)
  assert.equal(index.series.length, 1)
  assert.equal(index.accepted_observations, 7)
  assert.equal(index.duplicate_evidence_n, 0)
  assert.equal(index.rejected_observations, 0)
  assert.equal(verifyRuntimeCostDeadlineIndexDocument(index).ok, true)

  const series = index.series[0]
  assert.deepEqual(series.actionable_times_ms, [100, 200, 300])
  assert.deepEqual(series.censored_lower_bounds_ms, [250, 400])
  assert.equal(series.unresolved_n, 2)
  assert.equal(series.replay_ready, true)

  const certificate = evaluateRuntimeCostDeadlineCertificate(
    index,
    request(275),
  )
  assert.equal(
    certificate.evidence_status,
    DEADLINE_WINDOW_EVIDENCE_STATUS.KNOWN_MISS_PRESENT,
  )
  assert.deepEqual(certificate.counts, {
    total_n: 7,
    known_meet_n: 2,
    known_miss_n: 2,
    unknown_n: 3,
    actionable_meet_n: 2,
    actionable_miss_n: 1,
    censored_known_miss_n: 1,
    censored_unknown_n: 1,
    unresolved_n: 2,
  })
  assert.deepEqual(
    certificate.historical_miss_rate_bounds.lower_exact,
    { numerator: 2, denominator: 7 },
  )
  assert.deepEqual(
    certificate.historical_miss_rate_bounds.upper_exact,
    { numerator: 5, denominator: 7 },
  )
  assert.equal(certificate.query_complexity, "O(log n)")
  assert.equal(certificate.admission_authority, false)
}

{
  // Equality semantics:
  // actionable == W meets; right-censored lower bound == W is a known miss.
  const index = buildRuntimeCostDeadlineIndex(rows)
  const certificate = evaluateRuntimeCostDeadlineCertificate(
    index,
    request(400),
  )
  assert.equal(certificate.counts.actionable_meet_n, 3)
  assert.equal(certificate.counts.actionable_miss_n, 0)
  assert.equal(certificate.counts.censored_known_miss_n, 1)
  assert.equal(certificate.counts.censored_unknown_n, 1)
}

{
  // Absence of a known miss is NOT an admission decision; unknowns remain.
  const index = buildRuntimeCostDeadlineIndex(rows)
  const certificate = evaluateRuntimeCostDeadlineCertificate(
    index,
    request(500),
  )
  assert.equal(
    certificate.evidence_status,
    DEADLINE_WINDOW_EVIDENCE_STATUS.NO_KNOWN_MISS,
  )
  assert.equal(certificate.counts.known_meet_n, 3)
  assert.equal(certificate.counts.known_miss_n, 0)
  assert.equal(certificate.counts.unknown_n, 4)
  assert.deepEqual(
    certificate.historical_miss_rate_bounds.lower_exact,
    { numerator: 0, denominator: 7 },
  )
  assert.deepEqual(
    certificate.historical_miss_rate_bounds.upper_exact,
    { numerator: 4, denominator: 7 },
  )
  assert.equal(certificate.admission_authority, false)
}

{
  // Input ordering cannot affect the index content identity.
  const a = buildRuntimeCostDeadlineIndex(rows)
  const b = buildRuntimeCostDeadlineIndex([
    rows[6], rows[2], rows[0], rows[4], rows[1], rows[5], rows[3],
  ])
  assert.deepEqual(a, b)
  assert.equal(a.content_sha256, b.content_sha256)
}

{
  // An exact duplicate execution is counted once. This prevents copied
  // benchmark artifacts from overweighting a single model call.
  const duplicate = JSON.parse(JSON.stringify(rows[0]))
  const index = buildRuntimeCostDeadlineIndex([...rows, duplicate])
  assert.equal(index.input_observations, 8)
  assert.equal(index.accepted_observations, 7)
  assert.equal(index.duplicate_evidence_n, 1)
  assert.equal(index.rejected_observations, 0)
}

{
  // Same execution identity with contradictory evidence must fail closed.
  const conflicting = {
    ...JSON.parse(JSON.stringify(rows[0])),
    dispatch_to_actionable_boundary_ms: 999,
  }
  assert.throws(
    () => buildRuntimeCostDeadlineIndex([...rows, conflicting]),
    /conflicting duplicate observation/u,
  )
}

{
  // Different frontiers remain separate exact-compatible series.
  const otherID = {
    ...ID,
    frontier_sha256: "a".repeat(64),
  }
  const index = buildRuntimeCostDeadlineIndex([
    rows[0],
    observation({
      call: 1,
      dispatch: 10_000,
      actionable: 150,
      identity: otherID,
      session: "s2",
      turn: "user:2",
    }),
  ])
  assert.equal(index.series.length, 2)
  const missing = evaluateRuntimeCostDeadlineCertificate(
    index,
    request(200, 12_445, {
      ...ID,
      frontier_sha256: "c".repeat(64),
    }),
  )
  assert.equal(
    missing.evidence_status,
    DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS,
  )
  assert.equal(missing.reason, "compatible_deadline_series_not_found")
}

{
  // Context range is diagnostic only.
  const index = buildRuntimeCostDeadlineIndex(rows)
  const certificate = evaluateRuntimeCostDeadlineCertificate(
    index,
    request(275, 50_000),
  )
  assert.equal(
    certificate.context_coverage.status,
    "outside_observed_context_range",
  )
  assert.equal(certificate.context_coverage.extrapolation, true)
  assert.equal(certificate.admission_authority, false)
}

{
  // Tampering invalidates the entire index before query.
  const index = buildRuntimeCostDeadlineIndex(rows)
  const tampered = JSON.parse(JSON.stringify(index))
  tampered.series[0].actionable_times_ms[0] = 1
  const verified = verifyRuntimeCostDeadlineIndexDocument(tampered)
  assert.equal(verified.ok, false)
  assert.equal(verified.reason, "content_sha256_mismatch")

  const certificate = evaluateRuntimeCostDeadlineCertificate(
    tampered,
    request(275),
  )
  assert.equal(
    certificate.evidence_status,
    DEADLINE_WINDOW_EVIDENCE_STATUS.NO_OBSERVATIONS,
  )
  assert.equal(certificate.reason, "deadline_index_invalid")
}

{
  // Materialization reads immutable raw artifacts and persists a cold-readable
  // content-addressed index without modifying source traces.
  const root = await mkdtemp(path.join(os.tmpdir(), "r3b2a2-deadline-"))
  try {
    const results = path.join(root, "results")
    const artifact = path.join(results, "run-a", "task-a")
    await mkdir(artifact, { recursive: true })

    const dispatch = {
      ts: 1_000,
      protocol: ID.agent_protocol,
      kind: "model_dispatch",
      sessionID: "s1",
      turnID: "user:1",
      model_call: 1,
      providerID: ID.providerID,
      modelID: ID.modelID,
      execution_state: ID.phase,
      tool_frontier_protocol: ID.tool_frontier_protocol,
      mutation_tool_abi_protocol: ID.mutation_tool_abi_protocol,
      tool_frontier_names: ["execute_additive_plan"],
      tool_frontier_schema_sha256: ID.frontier_sha256,
      context_bytes: 12_445,
    }
    const tool = {
      type: "tool_use",
      timestamp: 2_100,
      sessionID: "s1",
      part: {
        partID: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        tool: "execute_additive_plan",
        state: {
          status: "completed",
          time: { start: 2_000, end: 2_100 },
        },
      },
    }
    const result = {
      protocol: "real-task-benchmark-v1",
      cli_timed_out: false,
      cli_started_at_ms: 900,
      cli_ended_at_ms: 2_200,
    }

    const cpuPath = path.join(artifact, "cpu-agent-trace.jsonl")
    const agentPath = path.join(artifact, "agent.stdout.jsonl")
    const resultPath = path.join(artifact, "result.json")

    await writeFile(cpuPath, JSON.stringify(dispatch) + "\n", "utf8")
    await writeFile(agentPath, JSON.stringify(tool) + "\n", "utf8")
    await writeFile(resultPath, JSON.stringify(result) + "\n", "utf8")

    const before = {
      cpu: createHash("sha256").update(await readFile(cpuPath)).digest("hex"),
      agent: createHash("sha256").update(await readFile(agentPath)).digest("hex"),
      result: createHash("sha256").update(await readFile(resultPath)).digest("hex"),
    }

    const backfill = {
      protocol: "runtime-cost-backfill-v1",
      reducer_protocol: "runtime-cost-reducer-v2",
      authority: "shadow_observation",
      scheduling_authority: false,
      telemetry_conflicts: 0,
      root: results,
      discovery_truncated: false,
      artifacts: [{
        artifact_dir: artifact,
        model_observations: 1,
        telemetry_conflicts: 0,
      }],
    }
    await writeFile(
      path.join(results, "runtime-cost-backfill.json"),
      JSON.stringify(backfill, null, 2) + "\n",
      "utf8",
    )

    const output = path.join(results, "runtime-cost-deadline-index-v1.json")
    const document = await materializeRuntimeCostDeadlineIndex(results, {
      outputPath: output,
    })
    assert.equal(document.accepted_observations, 1)
    assert.equal(document.series.length, 1)
    assert.equal(document.series[0].actionable_times_ms[0], 1_000)
    assert.equal(
      typeof document.source_artifact_proofs_sha256,
      "string",
    )
    assert.equal(
      JSON.stringify(document).includes(root),
      false,
    )

    const after = {
      cpu: createHash("sha256").update(await readFile(cpuPath)).digest("hex"),
      agent: createHash("sha256").update(await readFile(agentPath)).digest("hex"),
      result: createHash("sha256").update(await readFile(resultPath)).digest("hex"),
    }
    assert.deepEqual(after, before)

    const cold = JSON.parse(await readFile(output, "utf8"))
    assert.equal(verifyRuntimeCostDeadlineIndexDocument(cold).ok, true)
    const certificate = evaluateRuntimeCostDeadlineCertificate(
      cold,
      request(900),
    )
    assert.equal(certificate.counts.known_miss_n, 1)
    assert.equal(certificate.counts.unknown_n, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

{
  // R3B2-A2 remains analysis-plane only.
  const plugin = await readFile(
    path.resolve("opencode/plugins/cpu-search.ts"),
    "utf8",
  )
  const governor = await readFile(
    path.resolve("opencode/plugins/cpu-search-core/governor-latency-v1.mjs"),
    "utf8",
  )
  assert.doesNotMatch(plugin, /runtime-cost-deadline-index-v1/u)
  assert.doesNotMatch(governor, /runtime-cost-deadline-index-v1/u)
}

console.log(
  "PASS E2.5/R3B2-A2 deadline risk certificate uses exact fixed-horizon partial identification over actionable/censored/unresolved history with O(log n) queries and no admission authority",
)
