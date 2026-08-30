import assert from "node:assert/strict"
import http from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  LLAMA_CANCELLATION_PROBE_PROTOCOL,
  runLlamaServerCancellationProbe,
} from "./llama-server-cancellation-probe-v1.mjs"

function metricsText(state) {
  return [
    `llamacpp:tokens_predicted_total ${state.publishedTokens}`,
    `llamacpp:n_decode_total ${state.publishedDecodes}`,
    `llamacpp:requests_processing ${state.processing ? 1 : 0}`,
    "llamacpp:requests_deferred 0",
    "",
  ].join("\n")
}

async function startMock({ stopOnDisconnect, publishMetricsLive = true }) {
  const state = {
    processing: false,
    idTask: -1,
    tokens: 100,
    decodes: 200,
    publishedTokens: 100,
    publishedDecodes: 200,
    interval: null,
    disconnected: false,
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    if (req.method === "GET" && req.url === "/props") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({
        model_alias: "mock-model",
        build_info: "b9999-mockabcdef",
        total_slots: 1,
        endpoint_slots: true,
        endpoint_metrics: true,
      }))
      return
    }
    if (req.method === "GET" && req.url === "/slots") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify([{
        id: 0,
        id_task: state.idTask,
        is_processing: state.processing,
        next_token: {
          has_next_token: state.processing,
          n_decoded: Math.max(0, state.decodes - 200),
        },
      }]))
      return
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.setHeader("content-type", "text/plain")
      res.end(metricsText(state))
      return
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      state.processing = true
      state.idTask = 42
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      })

      state.interval = setInterval(() => {
        state.tokens += 1
        state.decodes += 1
        if (publishMetricsLive) {
          state.publishedTokens = state.tokens
          state.publishedDecodes = state.decodes
        }
        if (!state.disconnected) {
          res.write(
            'data: {"choices":[{"delta":{"content":"1\\n"}}]}\n\n',
          )
        }
      }, 20)

      res.on("close", () => {
        state.disconnected = true
        if (stopOnDisconnect) {
          clearInterval(state.interval)
          state.interval = null
          state.publishedTokens = state.tokens
          state.publishedDecodes = state.decodes
          setTimeout(() => {
            state.processing = false
            state.idTask = -1
          }, 20)
        } else {
          setTimeout(() => {
            state.processing = false
            state.idTask = -1
          }, 350)
          setTimeout(() => {
            if (state.interval) {
              clearInterval(state.interval)
              state.interval = null
            }
            state.publishedTokens = state.tokens
            state.publishedDecodes = state.decodes
          }, 600)
        }
      })
      return
    }

    res.statusCode = 404
    res.end()
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("mock address unavailable")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      if (state.interval) clearInterval(state.interval)
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

{
  const mock = await startMock({ stopOnDisconnect: true, publishMetricsLive: false })
  try {
    const result = await runLlamaServerCancellationProbe({
      base_url: mock.baseUrl,
      expected_model: "mock-model",
      startup_timeout_ms: 2_000,
      retirement_timeout_ms: 1_000,
      transport_close_timeout_ms: 1_000,
      poll_interval_ms: 20,
      quiescence_interval_ms: 80,
      quiescence_samples: 3,
      max_tokens: 64,
    })

    assert.equal(result.protocol, LLAMA_CANCELLATION_PROBE_PROTOCOL)
    assert.equal(result.status, "PROVEN")
    assert.equal(result.production_backend_proven, true)
    assert.equal(result.production_transport_proven, false)
    assert.equal(result.production_hard_lease_eligible, false)
    assert.equal(result.task_binding.id_task, 42)
    assert.equal(
      result.generation_start.client.client_generation_observed,
      true,
    )
    assert.equal(
      result.generation_start.server.server_generation_observed,
      true,
    )
    assert.ok(result.generation_start.server.slot_n_decoded > 0)
    assert.equal(
      result.generation_start.server.slot_n_decoded_source,
      "next_token.n_decoded",
    )
    assert.equal(
      result.generation_start.server.server_generation_evidence,
      "pinned_slot_decode_progress",
    )
    assert.equal(
      result.generation_start.server.live_global_metrics_advanced,
      false,
    )
    assert.equal(result.generation_start.server.tokens_predicted_delta, 0)
    assert.equal(result.generation_start.server.decode_delta, 0)
    assert.equal(result.cancellation.retirement.pinned_task_retired, true)
    assert.equal(result.quiescence.compute_quiesced, true)
    assert.equal(result.proof.compute_quiesced, "PROVEN")
    assert.equal(result.proof.hard_lease_eligible, true)
  } finally {
    await mock.close()
  }
}

{
  const mock = await startMock({ stopOnDisconnect: false })
  try {
    const result = await runLlamaServerCancellationProbe({
      base_url: mock.baseUrl,
      expected_model: "mock-model",
      startup_timeout_ms: 2_000,
      retirement_timeout_ms: 1_000,
      transport_close_timeout_ms: 1_000,
      poll_interval_ms: 20,
      quiescence_interval_ms: 80,
      quiescence_samples: 3,
      max_tokens: 64,
    })

    assert.notEqual(result.status, "PROVEN")
    assert.equal(result.production_backend_proven, false)
    assert.equal(result.production_hard_lease_eligible, false)
  } finally {
    await mock.close()
  }
}

{
  const mock = await startMock({ stopOnDisconnect: true })
  try {
    const result = await runLlamaServerCancellationProbe({
      base_url: mock.baseUrl,
      expected_model: "wrong-model",
      startup_timeout_ms: 500,
      poll_interval_ms: 20,
      quiescence_interval_ms: 50,
      quiescence_samples: 2,
    })
    assert.equal(result.status, "EVIDENCE_INSUFFICIENT")
    assert.equal(result.production_backend_proven, false)
    assert.match(result.detail, /model_alias_mismatch/u)
  } finally {
    await mock.close()
  }
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
  assert.doesNotMatch(plugin, /llama-server-cancellation-probe-v1/u)
  assert.doesNotMatch(governor, /llama-server-cancellation-probe-v1/u)
}

console.log(
  "PASS E2.5/R3C-A2 event-synchronized llama-server cancellation probe binds a live request to id_task, requires client+server generation evidence before abort, proves decode quiescence after retirement, and withholds production transport authority",
)
