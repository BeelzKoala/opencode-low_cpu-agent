import http from "node:http"
import { setTimeout as sleep } from "node:timers/promises"

import {
  PROOF_STATE,
  createCancellationCapabilities,
  createCancellationProof,
  createExecutionLease,
  verifyHardLeaseEligibility,
} from "./execution-lease-v1.mjs"

export const SYNTHETIC_HTTP_CANCELLATION_PROBE_PROTOCOL =
  "synthetic-http-cancellation-probe-v1"

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timeout`)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function runSyntheticHttpCancellationProbe({
  lease_ms = 60,
  compute_tick_ms = 5,
  quiescence_probe_ms = 40,
  hard_timeout_ms = 2_000,
} = {}) {
  const lease = createExecutionLease({
    lease_id: "synthetic-http-probe",
    remaining_task_budget_ms: lease_ms,
    tail_reserve: {},
    now_monotonic_ms: 0,
    clock: "synthetic_probe_clock",
  })
  if (!lease.ok) throw new Error(`lease construction failed: ${lease.reason}`)

  let providerObserved = false
  let transportClosedServerSide = false
  let computeStopped = false
  let computeTicks = 0
  let computeTicksAtStop = null
  let postExpiryActionObserved = false
  let closeResolve
  const closeSeen = new Promise((resolve) => {
    closeResolve = resolve
  })

  const server = http.createServer((req, res) => {
    if (req.url !== "/probe" || req.method !== "POST") {
      res.writeHead(404)
      res.end()
      return
    }

    providerObserved = true
    res.writeHead(200, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    })
    res.write("started\n")

    const interval = setInterval(() => {
      computeTicks += 1
      if (computeStopped) postExpiryActionObserved = true
    }, compute_tick_ms)

    const stopCompute = () => {
      if (computeStopped) return
      computeStopped = true
      computeTicksAtStop = computeTicks
      clearInterval(interval)
    }

    res.on("close", () => {
      transportClosedServerSide = true
      stopCompute()
      closeResolve()
    })

    req.on("aborted", () => {
      transportClosedServerSide = true
      stopCompute()
      closeResolve()
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("synthetic server address unavailable")
  }

  const controller = new AbortController()
  let cancelRequested = false
  let clientObservedAbort = false
  let abortTimer

  try {
    abortTimer = setTimeout(() => {
      cancelRequested = true
      controller.abort(new Error("execution lease expired"))
    }, lease_ms)

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/probe`,
        {
          method: "POST",
          body: "probe",
          signal: controller.signal,
        },
      )
      await response.text()
    } catch (error) {
      clientObservedAbort =
        controller.signal.aborted === true &&
        (
          error?.name === "AbortError" ||
          /execution lease expired|abort/i.test(String(error?.message ?? error))
        )
      if (!clientObservedAbort) throw error
    }

    await withTimeout(closeSeen, hard_timeout_ms, "server close observation")

    const ticksBeforeQuiet = computeTicks
    await sleep(quiescence_probe_ms)
    const ticksAfterQuiet = computeTicks

    const capabilitiesResult = createCancellationCapabilities({
      adapter_id: "node-fetch-http-synthetic-v1",
      request_cancellation: true,
      transport_close_observable: true,
      provider_cancel_observable: true,
      compute_stop_observable: true,
    })
    if (!capabilitiesResult.ok) {
      throw new Error(`capabilities failed: ${capabilitiesResult.reason}`)
    }

    const proofResult = createCancellationProof({
      lease_id: lease.lease.lease_id,
      adapter_id: capabilitiesResult.capabilities.adapter_id,
      lease_expired: cancelRequested,
      cancel_requested:
        cancelRequested && controller.signal.aborted
          ? PROOF_STATE.PROVEN
          : PROOF_STATE.UNPROVEN,
      transport_closed:
        clientObservedAbort && transportClosedServerSide
          ? PROOF_STATE.PROVEN
          : PROOF_STATE.UNPROVEN,
      provider_cancel_observed:
        providerObserved && transportClosedServerSide
          ? PROOF_STATE.PROVEN
          : PROOF_STATE.UNPROVEN,
      compute_quiesced:
        computeStopped &&
        computeTicksAtStop !== null &&
        ticksBeforeQuiet === ticksAfterQuiet
          ? PROOF_STATE.PROVEN
          : PROOF_STATE.UNPROVEN,
      post_expiry_action_observed: postExpiryActionObserved,
      evidence: {
        compute_ticks_at_stop: computeTicksAtStop,
        compute_ticks_before_quiescence_check: ticksBeforeQuiet,
        compute_ticks_after_quiescence_check: ticksAfterQuiet,
        quiescence_probe_ms,
        transport: "node_fetch_to_node_http",
        target: "synthetic_local_server",
      },
    })
    if (!proofResult.ok) {
      throw new Error(`proof failed: ${proofResult.reason}`)
    }

    const eligibility = verifyHardLeaseEligibility(
      capabilitiesResult.capabilities,
      proofResult.proof,
    )

    return Object.freeze({
      protocol: SYNTHETIC_HTTP_CANCELLATION_PROBE_PROTOCOL,
      target: "synthetic_local_server",
      runtime_authority: false,
      production_backend_proven: false,
      lease: lease.lease,
      capabilities: capabilitiesResult.capabilities,
      proof: proofResult.proof,
      eligibility,
    })
  } finally {
    clearTimeout(abortTimer)
    await new Promise((resolve) => server.close(resolve))
  }
}
