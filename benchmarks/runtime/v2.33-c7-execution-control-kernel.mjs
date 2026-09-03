import assert from "node:assert/strict"

import {
  EXECUTION_CONTROL_PROTOCOL,
  assertDeterministicFrontier,
  compileProviderDispatchContract,
  createTaskLeaseController,
  wrapExecutionControlledLanguage,
} from "../../opencode/plugins/cpu-search-core/execution-control-kernel-v1.mjs"


const TOOL = {
  type: "function",
  name: "execute_additive_plan",
  description: "fixture",
  inputSchema: {
    type: "object",
    properties: {
      contents: {
        type: "array",
      },
    },
    required: ["contents"],
  },
}


function generation(parts) {
  return {
    content: parts,
    finishReason: {
      unified: "tool-calls",
      raw: "tool_calls",
    },
    usage: {},
    warnings: [],
  }
}


function toolCall(
  name = "execute_additive_plan",
  id = "call-1",
) {
  return {
    type: "tool-call",
    toolCallType: "function",
    toolCallId: id,
    toolName: name,
    input: '{"contents":[]}',
  }
}


function language({
  generate,
  stream,
}) {
  return {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "fixture-model",
    supportedUrls: {},
    doGenerate: generate,
    doStream: stream,
  }
}


const OPTIONS = {
  prompt: [],
  tools: [TOOL],
  toolChoice: {
    type: "auto",
  },
}


// ============================================================
// 1. FRONTIER AUTHORITY
// ============================================================

const singleton =
  assertDeterministicFrontier([
    "execute_additive_plan",
  ])

assert.equal(
  singleton.protocol,
  EXECUTION_CONTROL_PROTOCOL,
)

assert.equal(
  singleton.selected_tool,
  "execute_additive_plan",
)

assert.equal(
  singleton.model_action_authority,
  false,
)

assert.equal(
  singleton.model_argument_authority,
  true,
)


const empty =
  assertDeterministicFrontier([])

assert.equal(
  empty.selected_tool,
  null,
)

assert.equal(
  empty.model_action_authority,
  false,
)


assert.throws(
  () =>
    assertDeterministicFrontier([
      "search",
      "execute_additive_plan",
    ]),
  /execution_control_non_singleton_frontier/u,
)


// ============================================================
// 2. PROVIDER CONTRACT
// ============================================================

const contract =
  compileProviderDispatchContract(
    OPTIONS,
  )

assert.equal(contract.active, true)

assert.equal(
  contract.selected_tool,
  "execute_additive_plan",
)

assert.equal(
  contract.model_action_authority,
  false,
)


// ============================================================
// 3. VALID GENERATE:
// exact singleton action must be forced.
// ============================================================

let observedOptions = null

const validLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async (options) => {
        observedOptions = options

        return generation([
          toolCall(),
        ])
      },

      stream: async () => {
        throw new Error(
          "unexpected doStream",
        )
      },
    }),
  )

await validLanguage.doGenerate(
  OPTIONS,
)

assert.equal(
  observedOptions.tools.length,
  1,
)

assert.deepEqual(
  observedOptions.tools[0],
  TOOL,
)

assert.deepEqual(
  observedOptions.toolChoice,
  {
    type: "required",
  },
)


// ============================================================
// 4. ZERO TOOL CALL:
// the exact E2E #4 failure class must become impossible.
// ============================================================

const textOnlyLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async () =>
        generation([
          {
            type: "text",
            text: "done",
          },
        ]),

      stream: async () => {
        throw new Error(
          "unexpected doStream",
        )
      },
    }),
  )

await assert.rejects(
  () =>
    textOnlyLanguage.doGenerate(
      OPTIONS,
    ),
  /execution_control_missing_required_tool_call/u,
)


// ============================================================
// 5. WRONG TOOL:
// do not trust provider toolChoice enforcement.
// ============================================================

const wrongToolLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async () =>
        generation([
          toolCall("search"),
        ]),

      stream: async () => {
        throw new Error(
          "unexpected doStream",
        )
      },
    }),
  )

await assert.rejects(
  () =>
    wrongToolLanguage.doGenerate(
      OPTIONS,
    ),
  /execution_control_wrong_tool_call/u,
)


// ============================================================
// 6. MULTIPLE CALLS:
// one phase transition == one action.
// ============================================================

const multiCallLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async () =>
        generation([
          toolCall(
            "execute_additive_plan",
            "call-1",
          ),
          toolCall(
            "execute_additive_plan",
            "call-2",
          ),
        ]),

      stream: async () => {
        throw new Error(
          "unexpected doStream",
        )
      },
    }),
  )

await assert.rejects(
  () =>
    multiCallLanguage.doGenerate(
      OPTIONS,
    ),
  /execution_control_multiple_tool_calls/u,
)


// ============================================================
// 7. NON-CONTROLLED PROVIDER CALLS:
// global language wrapper must not break OpenCode internal calls.
// ============================================================

let passthroughObserved = null

const passthroughLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async (options) => {
        passthroughObserved = options

        return generation([
          {
            type: "text",
            text: "internal",
          },
        ])
      },

      stream: async () => {
        throw new Error(
          "unexpected doStream",
        )
      },
    }),
  )

const noToolsOptions = {
  prompt: [],
  tools: [],
}

await passthroughLanguage.doGenerate(
  noToolsOptions,
)

assert.equal(
  passthroughObserved,
  noToolsOptions,
)


// ============================================================
// 8. STREAM FIREWALL
// ============================================================

function streamOf(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part)
      }

      controller.close()
    },
  })
}


async function consume(stream) {
  const reader = stream.getReader()
  const rows = []

  while (true) {
    const row = await reader.read()

    if (row.done) {
      break
    }

    rows.push(row.value)
  }

  return rows
}


let streamOptions = null

const validStreamLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async () => {
        throw new Error(
          "unexpected doGenerate",
        )
      },

      stream: async (options) => {
        streamOptions = options

        return {
          stream: streamOf([
            {
              type:
                "tool-input-start",
              id: "stream-call-1",
              toolName:
                "execute_additive_plan",
            },
            {
              type:
                "tool-input-delta",
              id: "stream-call-1",
              delta:
                '{"contents":[]}',
            },
            {
              type:
                "tool-input-end",
              id: "stream-call-1",
            },
            {
              type: "finish",
              finishReason: {
                unified:
                  "tool-calls",
                raw:
                  "tool_calls",
              },
              usage: {},
            },
          ]),
        }
      },
    }),
  )

const validStream =
  await validStreamLanguage.doStream(
    OPTIONS,
  )

const rows =
  await consume(
    validStream.stream,
  )

const forwardedToolCalls =
  rows.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      row.type === "tool-call",
  )

assert.equal(
  forwardedToolCalls.length,
  1,
)

assert.equal(
  forwardedToolCalls[0].toolName,
  "execute_additive_plan",
)

assert.deepEqual(
  JSON.parse(
    forwardedToolCalls[0].input,
  ),
  {
    contents: [],
  },
)

assert.equal(
  rows.some(
    (row) =>
      row?.type === "tool-input-start" ||
      row?.type === "tool-input-delta" ||
      row?.type === "tool-input-end",
  ),
  false,
)

assert.equal(
  rows.filter(
    (row) =>
      row?.type === "finish",
  ).length,
  1,
)

assert.deepEqual(
  streamOptions.toolChoice,
  {
    type: "required",
  },
)


// ============================================================
// 9. STREAM TEXT-ONLY:
// must fail before forwarding a legal phase transition.
// ============================================================

const invalidStreamLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async () => {
        throw new Error(
          "unexpected doGenerate",
        )
      },

      stream: async () => ({
        stream: streamOf([
          {
            type: "text-start",
            id: "text-1",
          },
          {
            type: "text-delta",
            id: "text-1",
            delta: "done",
          },
          {
            type: "text-end",
            id: "text-1",
          },
          {
            type: "finish",
            finishReason: {
              unified: "stop",
              raw: "stop",
            },
            usage: {},
          },
        ]),
      }),
    }),
  )

const invalidStream =
  await invalidStreamLanguage.doStream(
    OPTIONS,
  )

await assert.rejects(
  () =>
    consume(
      invalidStream.stream,
    ),
  /execution_control_missing_required_tool_call/u,
)


// ============================================================
// 10. STREAM WRONG TOOL
// ============================================================

const wrongStreamLanguage =
  wrapExecutionControlledLanguage(
    language({
      generate: async () => {
        throw new Error(
          "unexpected doGenerate",
        )
      },

      stream: async () => ({
        stream: streamOf([
          {
            type:
              "tool-input-start",
            id: "wrong-1",
            toolName: "search",
          },
          {
            type:
              "tool-input-end",
            id: "wrong-1",
          },
        ]),
      }),
    }),
  )

const wrongStream =
  await wrongStreamLanguage.doStream(
    OPTIONS,
  )

await assert.rejects(
  () =>
    consume(
      wrongStream.stream,
    ),
  /execution_control_wrong_tool_call/u,
)


// ============================================================
// 11. HARD LEASE:
// old/stale timers must never interrupt a newer turn.
// ============================================================

let fakeNow = 1_000
const timers = []
const interrupts = []

const leases =
  createTaskLeaseController({
    now: () => fakeNow,

    setTimer: (fn, ms) => {
      const timer = {
        fn,
        ms,
        cancelled: false,
        unref() {},
      }

      timers.push(timer)
      return timer
    },

    clearTimer: (timer) => {
      timer.cancelled = true
    },

    interruptSession:
      async (sessionID) => {
        interrupts.push(sessionID)
      },
  })


const lease1 =
  leases.arm({
    sessionID: "session-A",
    turnID: "turn-1",
    deadlineAtMs: 1_500,
  })

assert.equal(
  lease1.remaining_ms,
  500,
)

assert.equal(
  timers[0].ms,
  500,
)


fakeNow = 1_100

const lease2 =
  leases.arm({
    sessionID: "session-A",
    turnID: "turn-2",
    deadlineAtMs: 1_800,
  })

assert.equal(
  timers[0].cancelled,
  true,
)

assert.equal(
  lease2.remaining_ms,
  700,
)

/*
 * Simulate a stale callback racing after cancellation.
 * Token ownership must make it harmless.
 */
await timers[0].fn()

assert.deepEqual(
  interrupts,
  [],
)


await timers[1].fn()

assert.deepEqual(
  interrupts,
  ["session-A"],
)


// ============================================================
// 12. DISARM
// ============================================================

fakeNow = 2_000

leases.arm({
  sessionID: "session-B",
  turnID: "turn-1",
  deadlineAtMs: 2_500,
})

const timerB =
  timers.at(-1)

assert.equal(
  leases.disarm("session-B"),
  true,
)

assert.equal(
  timerB.cancelled,
  true,
)

await timerB.fn()

assert.deepEqual(
  interrupts,
  ["session-A"],
)

leases.dispose()


console.log(
  "PASS C7 execution control kernel " +
    "frontier=deterministic " +
    "singleton_action=sealed " +
    "tool_choice=exact " +
    "zero_call=fail_closed " +
    "wrong_call=fail_closed " +
    "multi_call=fail_closed " +
    "stream=transactional " +
    "stale_lease=harmless " +
    "hard_deadline=interrupt " +
    "model_action_authority=false " +
    "model_context_overhead_bytes=0",
)
