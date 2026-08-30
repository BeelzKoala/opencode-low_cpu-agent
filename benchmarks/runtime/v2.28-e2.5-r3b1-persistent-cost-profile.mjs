import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  RUNTIME_COST_PROFILE_PROTOCOL,
  buildPersistentRuntimeCostProfile,
  lookupCompatibleRuntimeCostProfile,
  materializePersistentRuntimeCostProfile,
  normalizeRuntimeCostIdentity,
  verifyRuntimeCostProfileDocument,
} from "./runtime-cost-profile-v1.mjs"

const identity = ({
  frontier = "a".repeat(64),
  phase = "mutate",
  agentProtocol = "cpu-agent-v2.8.0-mutation-confinement-2",
  toolFrontierProtocol = "causal-tool-frontier-v2.5-deterministic-action",
  abiProtocol = "capability-mutation-tools-v2",
} = {}) => ({
  providerID: "local",
  modelID: "north-mini-code-local",
  phase,
  frontier_sha256: frontier,
  agent_protocol: agentProtocol,
  tool_frontier_protocol: toolFrontierProtocol,
  mutation_tool_abi_protocol: abiProtocol,
})

const observation = ({
  actionable = null,
  censored = null,
  unresolved = false,
  context = 12_445,
  id = identity(),
} = {}) => ({
  providerID: id.providerID,
  modelID: id.modelID,
  execution_state: id.phase,
  tool_frontier_schema_sha256: id.frontier_sha256,
  agent_protocol: id.agent_protocol,
  tool_frontier_protocol: id.tool_frontier_protocol,
  mutation_tool_abi_protocol: id.mutation_tool_abi_protocol,
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
})

{
  const doc = buildPersistentRuntimeCostProfile([
    observation({ actionable: 168_733, context: 12_445 }),
    observation({ actionable: 232_312, context: 12_445 }),
    observation({ actionable: 126_513, context: 11_000 }),
    observation({ censored: 298_425, context: 12_445 }),
    observation({ unresolved: true, context: 12_445 }),
    observation({ unresolved: true, context: null }),
  ], {
    sourceArtifacts: 6,
    sourceTelemetryConflicts: 0,
  })

  assert.equal(doc.protocol, RUNTIME_COST_PROFILE_PROTOCOL)
  assert.equal(doc.scheduling_authority, false)
  assert.equal(doc.mutation_authority, false)
  assert.equal(doc.profiles.length, 1)

  const profile = doc.profiles[0]
  assert.equal(profile.observation_n, 6)
  assert.equal(profile.actionable_n, 3)
  assert.equal(profile.censored_n, 1)
  assert.equal(profile.unresolved_n, 2)
  assert.equal(profile.actionable_p50_ms, 168_733)
  assert.equal(profile.actionable_p90_ms, 232_312)
  assert.equal(profile.actionable_max_ms, 232_312)
  assert.equal(profile.max_censored_lower_bound_ms, 298_425)
  assert.equal(profile.context_bytes_n, 5)
  assert.equal(profile.context_bytes_unknown_n, 1)
  assert.equal(profile.context_bytes_min, 11_000)
  assert.equal(profile.context_bytes_p50, 12_445)
  assert.equal(profile.context_bytes_max, 12_445)

  const verified = verifyRuntimeCostProfileDocument(doc)
  assert.equal(verified.ok, true)

  const lookup = lookupCompatibleRuntimeCostProfile(doc, identity())
  assert.equal(lookup.ok, true)
  assert.equal(lookup.reason, "exact_compatible_profile")
  assert.equal(lookup.scheduling_authority, false)
  assert.equal(lookup.profile.identity_sha256, profile.identity_sha256)

  const wrongFrontier = lookupCompatibleRuntimeCostProfile(
    doc,
    identity({ frontier: "b".repeat(64) }),
  )
  assert.equal(wrongFrontier.ok, false)
  assert.equal(wrongFrontier.reason, "compatible_profile_not_found")
}

{
  // Input order cannot change content identity.
  const rows = [
    observation({ actionable: 232_312 }),
    observation({ censored: 298_425 }),
    observation({ actionable: 168_733 }),
  ]
  const a = buildPersistentRuntimeCostProfile(rows, { sourceArtifacts: 3 })
  const b = buildPersistentRuntimeCostProfile(
    [rows[2], rows[0], rows[1]],
    { sourceArtifacts: 3 },
  )
  assert.equal(a.content_sha256, b.content_sha256)
  assert.deepEqual(a, b)
}

{
  // Different compatibility identities must never collapse into one profile.
  const a = observation({
    actionable: 100_000,
    id: identity({ frontier: "a".repeat(64) }),
  })
  const b = observation({
    actionable: 101_000,
    id: identity({ frontier: "b".repeat(64) }),
  })
  const doc = buildPersistentRuntimeCostProfile([a, b])
  assert.equal(doc.profiles.length, 2)
}

{
  // Incomplete identity is rejected, never assigned to a broad fallback.
  const broken = observation({ actionable: 100_000 })
  broken.modelID = null
  const doc = buildPersistentRuntimeCostProfile([broken])
  assert.equal(doc.accepted_observations, 0)
  assert.equal(doc.rejected_observations, 1)
  assert.equal(doc.rejection_reasons.identity_incomplete, 1)
}

{
  // Tampering invalidates lookup.
  const doc = buildPersistentRuntimeCostProfile([
    observation({ actionable: 100_000 }),
  ])
  const tampered = JSON.parse(JSON.stringify(doc))
  tampered.profiles[0].actionable_p50_ms = 1
  const verified = verifyRuntimeCostProfileDocument(tampered)
  assert.equal(verified.ok, false)
  assert.equal(verified.reason, "content_sha256_mismatch")
  const lookup = lookupCompatibleRuntimeCostProfile(tampered, identity())
  assert.equal(lookup.ok, false)
  assert.equal(lookup.reason, "profile_document_invalid")
}

{
  // Materialization is persistent and restart-readable from immutable raw traces.
  const root = await mkdtemp(path.join(os.tmpdir(), "r3b1-profile-"))
  try {
    const results = path.join(root, "results")
    const artifact = path.join(results, "run-a", "task-a")
    await mkdir(artifact, { recursive: true })

    const dispatch = {
      ts: 1_000,
      protocol: "cpu-agent-v2.8.0-mutation-confinement-2",
      kind: "model_dispatch",
      sessionID: "s1",
      turnID: "user:1",
      model_call: 1,
      providerID: "local",
      modelID: "north-mini-code-local",
      execution_state: "mutate",
      tool_frontier_protocol: "causal-tool-frontier-v2.5-deterministic-action",
      mutation_tool_abi_protocol: "capability-mutation-tools-v2",
      tool_frontier_names: ["execute_additive_plan"],
      tool_frontier_schema_sha256: "a".repeat(64),
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

    await writeFile(
      path.join(artifact, "cpu-agent-trace.jsonl"),
      JSON.stringify(dispatch) + "\n",
      "utf8",
    )
    await writeFile(
      path.join(artifact, "agent.stdout.jsonl"),
      JSON.stringify(tool) + "\n",
      "utf8",
    )
    await writeFile(
      path.join(artifact, "result.json"),
      JSON.stringify({
        protocol: "real-task-benchmark-v1",
        cli_timed_out: false,
        cli_started_at_ms: 900,
        cli_ended_at_ms: 2_200,
      }) + "\n",
      "utf8",
    )

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

    const output = path.join(results, "runtime-cost-profile-v1.json")
    const document = await materializePersistentRuntimeCostProfile(results, {
      outputPath: output,
    })
    assert.equal(document.profiles.length, 1)
    assert.equal(document.profiles[0].actionable_p50_ms, 1_000)

    // Simulate a cold reader: parse the persisted file and verify exact lookup.
    const cold = JSON.parse(await readFile(output, "utf8"))
    assert.equal(verifyRuntimeCostProfileDocument(cold).ok, true)
    assert.equal(
      lookupCompatibleRuntimeCostProfile(cold, identity()).ok,
      true,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

{
  // Production authority boundary: R3B1 must not be imported by the plugin.
  const plugin = await readFile(
    path.resolve("opencode/plugins/cpu-search.ts"),
    "utf8",
  )
  const governor = await readFile(
    path.resolve("opencode/plugins/cpu-search-core/governor-latency-v1.mjs"),
    "utf8",
  )
  assert.doesNotMatch(plugin, /runtime-cost-profile-v1/u)
  assert.doesNotMatch(governor, /runtime-cost-profile-v1/u)
}

console.log(
  "PASS E2.5/R3B1 persistent compatible cost profile remains content-addressed shadow evidence with exact cold lookup",
)
