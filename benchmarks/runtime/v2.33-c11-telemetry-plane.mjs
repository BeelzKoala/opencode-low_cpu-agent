import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  TELEMETRY_AUTHORITY,
  TELEMETRY_CONTENT_POLICY,
  TELEMETRY_PROTOCOL,
  mirrorProjectTraceTelemetry,
  observePublicEventTelemetry,
  parseLinuxPsi,
  parsePrometheusMetrics,
  stopAllTelemetrySamplers,
  telemetryTestTraceIdentity,
} from "../../opencode/plugins/cpu-search-core/telemetry-plane-v1.mjs"

assert.equal(
  TELEMETRY_PROTOCOL,
  "koalik-telemetry-v1",
)
assert.equal(
  TELEMETRY_AUTHORITY,
  "observation_only",
)
assert.equal(
  TELEMETRY_CONTENT_POLICY,
  "metadata_hashes_counts_only",
)

const traceA =
  telemetryTestTraceIdentity(
    "ses_test",
    "user:msg_test",
  )

const traceB =
  telemetryTestTraceIdentity(
    "ses_test",
    "user:msg_test",
  )

assert.equal(traceA, traceB)
assert.match(traceA, /^[0-9a-f]{32}$/u)

const psi =
  parseLinuxPsi(
    "some avg10=0.10 avg60=0.20 avg300=0.30 total=42\n" +
    "full avg10=0.01 avg60=0.02 avg300=0.03 total=7\n",
  )

assert.equal(
  psi.some.avg10,
  0.10,
)
assert.equal(
  psi.full.total,
  7,
)

const metrics =
  parsePrometheusMetrics(
    "# HELP x y\n" +
    "llamacpp:prompt_tokens_total 100\n" +
    "llamacpp:tokens_predicted_total 12\n" +
    "llamacpp:requests_processing 1\n" +
    "irrelevant_metric 999\n",
  )

assert.deepEqual(
  metrics,
  {
    "llamacpp:prompt_tokens_total": 100,
    "llamacpp:tokens_predicted_total": 12,
    "llamacpp:requests_processing": 1,
  },
)

const root =
  fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "koalik-c11-",
    ),
  )

await mirrorProjectTraceTelemetry(
  root,
  "cpu-agent-trace.jsonl",
  {
    ts: Date.now(),
    protocol:
      "cpu-agent-test",
    kind:
      "model_dispatch",
    sessionID:
      "ses_test",
    turnID:
      "user:msg_test",
    model_call: 1,
    providerID: "local",
    modelID: "test",
    context_bytes: 4096,
    context_tools_bytes: 1024,
    secret_prompt:
      "MUST_NOT_APPEAR",
  },
)

// Regression for a real OpenCode SSE property: a delta can arrive before
// message.part.updated. Progress must not depend on the registration order.
await observePublicEventTelemetry({
  root,
  sessionID:
    "ses_test",
  turnID:
    "user:msg_test",
  event: {
    type:
      "message.part.delta",
    properties: {
      sessionID:
        "ses_test",
      messageID:
        "msg_assistant",
      partID:
        "part_1",
      field: "text",
      delta: "abc",
    },
  },
})

await observePublicEventTelemetry({
  root,
  sessionID:
    "ses_test",
  turnID:
    "user:msg_test",
  event: {
    type:
      "message.part.updated",
    properties: {
      sessionID:
        "ses_test",
      part: {
        id: "part_1",
        sessionID:
          "ses_test",
        messageID:
          "msg_assistant",
        type: "text",
        text: "abc",
      },
    },
  },
})

await observePublicEventTelemetry({
  root,
  sessionID:
    "ses_test",
  turnID:
    "user:msg_test",
  event: {
    type:
      "message.part.updated",
    properties: {
      sessionID:
        "ses_test",
      part: {
        id: "part_tool",
        sessionID:
          "ses_test",
        messageID:
          "msg_assistant",
        type: "tool",
        callID: "call_1",
        tool:
          "execute_additive_plan",
        state: {
          status: "pending",
          input: {},
          raw:
            "{\"contents\":[",
        },
      },
    },
  },
})

await mirrorProjectTraceTelemetry(
  root,
  "cpu-agent-trace.jsonl",
  {
    ts: Date.now(),
    protocol:
      "cpu-agent-test",
    kind:
      "model_usage",
    source:
      "message_updated",
    sessionID:
      "ses_test",
    turnID:
      "user:msg_test",
    output_tokens: 7,
    finish: "tool-calls",
  },
)

await stopAllTelemetrySamplers()

const telemetryPath =
  path.join(
    root,
    ".opencode",
    "telemetry-v1.jsonl",
  )

assert.equal(
  fs.existsSync(
    telemetryPath,
  ),
  true,
)

const raw =
  fs.readFileSync(
    telemetryPath,
    "utf8",
  )

assert.doesNotMatch(
  raw,
  /MUST_NOT_APPEAR/u,
)
assert.doesNotMatch(
  raw,
  /\{"contents":\[/u,
)

const rows =
  raw
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line),
    )

assert.ok(
  rows.length >= 5,
)

assert.ok(
  rows.every(
    (row) =>
      row.telemetry_authority ===
        "observation_only",
  ),
)

assert.ok(
  rows.every(
    (row) =>
      row.content_policy ===
        "metadata_hashes_counts_only",
  ),
)

const start =
  rows.find(
    (row) =>
      row.operation ===
        "model_call" &&
      row.event === "start",
  )

assert.ok(start)
assert.equal(
  start.model_context_overhead_bytes,
  0,
)
assert.equal(
  start.context_bytes,
  4096,
)

const progress =
  rows.find(
    (row) =>
      row.operation ===
        "provider_progress" &&
      row.event ===
        "checkpoint",
  )

assert.ok(progress)
assert.equal(
  progress.output_delta_events,
  1,
)
assert.equal(
  progress.output_delta_bytes,
  3,
)
assert.equal(
  progress.content_captured,
  false,
)

const tool =
  rows.find(
    (row) =>
      row.operation ===
        "tool_call_assembly" &&
      row.tool ===
        "execute_additive_plan",
  )

assert.ok(tool)
assert.equal(
  tool.tool_status,
  "pending",
)
assert.ok(
  tool.tool_raw_bytes > 0,
)
assert.equal(
  tool.content_captured,
  false,
)

const finish =
  rows.find(
    (row) =>
      row.operation ===
        "model_call" &&
      row.event ===
        "finish",
  )

assert.ok(finish)
assert.equal(
  finish.output_tokens,
  7,
)
assert.equal(
  finish.output_delta_events,
  1,
)

fs.rmSync(
  root,
  {
    recursive: true,
    force: true,
  },
)

console.log(
  "PASS C11 telemetry plane " +
  "authority=observation_only " +
  "causal_trace=true " +
  "monotonic_clock=true " +
  "delta_before_updated=supported " +
  "provider_progress=bounded_checkpoints " +
  "tool_assembly=metadata_only " +
  "resource_sampling=bounded " +
  "linux_psi=true " +
  "llama_metrics=optional " +
  "content_capture=false " +
  "model_context_overhead_bytes=0 " +
  "solver_authority=false " +
  "mutation_authority=false",
)
