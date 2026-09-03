import {
  DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
  compileArgumentSynthesisDispatch,
  compileArgumentSynthesisPlan,
  materializeArgumentSynthesisGenerate,
  materializeArgumentSynthesisStream,
  zeroInferenceStreamResult,
} from "./deterministic-argument-synthesis-v1.mjs"

export const EXECUTION_CONTROL_PROTOCOL =
  "execution-control-kernel-v1"

function fail(reason, details = {}) {
  const error = new Error(`CPU_EXECUTION_CONTROL ${reason}`)
  error.name = "ExecutionControlError"
  error.code = reason
  Object.assign(error, details)
  return error
}

function toolName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256
  )
    ? value
    : null
}

function functionToolName(tool) {
  if (
    !tool ||
    typeof tool !== "object" ||
    tool.type !== "function"
  ) {
    return null
  }

  return toolName(tool.name)
}

function frozen(value) {
  return Object.freeze(value)
}


/*
 * FRONTIER AUTHORITY
 *
 * The deterministic FSM owns action identity.
 * The model may synthesize arguments for one exact action,
 * but may never choose between actions.
 */
export function assertDeterministicFrontier(names) {
  if (!Array.isArray(names)) {
    throw fail(
      "execution_control_frontier_invalid",
    )
  }

  const canonical = []

  for (const raw of names) {
    const name = toolName(raw)

    if (name == null) {
      throw fail(
        "execution_control_frontier_name_invalid",
      )
    }

    if (!canonical.includes(name)) {
      canonical.push(name)
    }
  }

  canonical.sort()

  if (canonical.length > 1) {
    throw fail(
      "execution_control_non_singleton_frontier",
      {
        frontier: canonical,
      },
    )
  }

  return frozen({
    protocol: EXECUTION_CONTROL_PROTOCOL,
    authority: "deterministic_fsm",
    selected_tool: canonical[0] ?? null,
    model_action_authority: false,
    model_argument_authority:
      canonical.length === 1,
  })
}


/*
 * PROVIDER DISPATCH CONTRACT
 *
 * This does not route. It merely converts the already
 * deterministic singleton tool surface into provider constraints.
 */
export function compileProviderDispatchContract(options) {
  const tools = Array.isArray(options?.tools)
    ? options.tools
    : []

  /*
   * Global language wrappers can also see internal OpenCode calls
   * such as compaction. Those calls are outside this authority
   * boundary and pass through.
   */
  if (tools.length !== 1) {
    return frozen({
      protocol: EXECUTION_CONTROL_PROTOCOL,
      active: false,
      reason:
        tools.length === 0
          ? "provider_tool_surface_empty"
          : "provider_tool_surface_non_singleton",
      selected_tool: null,
      model_action_authority: false,
    })
  }

  const selected = tools[0]
  const selectedName = functionToolName(selected)

  if (selectedName == null) {
    return frozen({
      protocol: EXECUTION_CONTROL_PROTOCOL,
      active: false,
      reason: "provider_tool_not_function",
      selected_tool: null,
      model_action_authority: false,
    })
  }

  return frozen({
    protocol: EXECUTION_CONTROL_PROTOCOL,
    active: true,
    reason: "singleton_function_frontier",
    selected_tool: selectedName,
    selected_tool_definition: selected,
    argument_synthesis_protocol:
      DETERMINISTIC_ARGUMENT_SYNTHESIS_PROTOCOL,
    argument_synthesis_plan:
      compileArgumentSynthesisPlan(
        selected,
      ),
    model_action_authority: false,
    model_argument_authority: true,
  })
}


function enforceProviderDispatch(
  options,
  contract,
  language,
  dispatch = null,
) {
  if (contract?.active !== true) {
    return options
  }

  const compiled =
    dispatch ??
    compileArgumentSynthesisDispatch({
      options,
      language,
      contract,
    })

  if (compiled.zero_inference === true) {
    return options
  }

  return compiled.options
}


function normalizeArgumentSynthesisActionError(
  error,
  contract,
) {
  if (
    !error ||
    error.name !==
      "ArgumentSynthesisError" ||
    typeof error.code !== "string"
  ) {
    return error
  }

  const selectedTool =
    contract?.selected_tool ?? null

  if (
    error.code ===
      "required_tool_call_cardinality_invalid" ||
    error.code ===
      "required_stream_tool_cardinality_invalid"
  ) {
    const observedCalls =
      Number.isSafeInteger(
        error.details?.observed_tool_calls,
      )
        ? error.details.observed_tool_calls
        : null

    if (observedCalls === 0) {
      return fail(
        "execution_control_missing_required_tool_call",
        {
          selected_tool:
            selectedTool,
        },
      )
    }

    if (
      observedCalls != null &&
      observedCalls > 1
    ) {
      return fail(
        "execution_control_multiple_tool_calls",
        {
          selected_tool:
            selectedTool,
          observed_calls:
            observedCalls,
        },
      )
    }

    return error
  }

  if (
    error.code ===
      "required_tool_call_name_invalid" ||
    error.code ===
      "required_stream_tool_name_invalid"
  ) {
    const observedTool =
      toolName(
        error.details?.observed_tool_name,
      )

    if (observedTool == null) {
      return fail(
        "execution_control_tool_call_name_invalid",
        {
          selected_tool:
            selectedTool,
        },
      )
    }

    return fail(
      "execution_control_wrong_tool_call",
      {
        selected_tool:
          selectedTool,
        observed_tool:
          observedTool,
      },
    )
  }

  return error
}


function materializeExecutionControlledGenerate(
  result,
  contract,
  dispatch,
) {
  try {
    return materializeArgumentSynthesisGenerate(
      result,
      contract,
      dispatch,
    )
  } catch (error) {
    throw normalizeArgumentSynthesisActionError(
      error,
      contract,
    )
  }
}


function materializeExecutionControlledStream(
  parts,
  contract,
  dispatch,
) {
  try {
    return materializeArgumentSynthesisStream(
      parts,
      contract,
      dispatch,
    )
  } catch (error) {
    throw normalizeArgumentSynthesisActionError(
      error,
      contract,
    )
  }
}


function validateGeneratedParts(parts, contract) {
  if (contract?.active !== true) {
    return
  }

  if (!Array.isArray(parts)) {
    throw fail(
      "execution_control_provider_content_invalid",
    )
  }

  const calls = parts.filter(
    (part) =>
      part &&
      typeof part === "object" &&
      part.type === "tool-call",
  )

  if (calls.length === 0) {
    throw fail(
      "execution_control_missing_required_tool_call",
      {
        selected_tool: contract.selected_tool,
      },
    )
  }

  if (calls.length > 1) {
    throw fail(
      "execution_control_multiple_tool_calls",
      {
        selected_tool: contract.selected_tool,
        observed_calls: calls.length,
      },
    )
  }

  const observed = toolName(
    calls[0]?.toolName,
  )

  if (observed == null) {
    throw fail(
      "execution_control_tool_call_name_invalid",
    )
  }

  if (observed !== contract.selected_tool) {
    throw fail(
      "execution_control_wrong_tool_call",
      {
        selected_tool: contract.selected_tool,
        observed_tool: observed,
      },
    )
  }
}


/*
 * STREAM FIREWALL
 *
 * Never forward a provider tool-call incrementally before the
 * response is proven to contain one exact permitted call.
 *
 * Current providers can expose tool execution using either:
 *   tool-input-start/delta/end
 * or:
 *   tool-call
 * or both.
 *
 * We therefore validate by call identity, not by one provider-
 * specific streaming representation.
 */
function validateStreamParts(parts, contract) {
  if (contract?.active !== true) {
    return
  }

  const calls = new Map()
  let finishToolCalls = false

  const observe = (
    idRaw,
    nameRaw,
    evidence,
  ) => {
    const id =
      typeof idRaw === "string" &&
      idRaw.length > 0
        ? idRaw
        : null

    const name = toolName(nameRaw)

    if (id == null || name == null) {
      throw fail(
        "execution_control_stream_call_invalid",
      )
    }

    const existing = calls.get(id)

    if (
      existing &&
      existing.name !== name
    ) {
      throw fail(
        "execution_control_stream_call_conflict",
        {
          call_id: id,
          first_tool: existing.name,
          observed_tool: name,
        },
      )
    }

    const row = existing ?? {
      id,
      name,
      start: false,
      end: false,
      delta: false,
      final: false,
    }

    row[evidence] = true
    calls.set(id, row)
  }

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue
    }

    if (part.type === "tool-input-start") {
      observe(
        part.id ?? part.toolCallId,
        part.toolName,
        "start",
      )
      continue
    }

    if (part.type === "tool-call-delta") {
      observe(
        part.toolCallId ?? part.id,
        part.toolName,
        "delta",
      )
      continue
    }

    if (part.type === "tool-call") {
      observe(
        part.toolCallId ?? part.id,
        part.toolName,
        "final",
      )
      continue
    }

    if (part.type === "tool-input-end") {
      const id =
        part.id ?? part.toolCallId

      const row = calls.get(id)

      if (!row) {
        throw fail(
          "execution_control_stream_end_without_start",
          {
            call_id: id ?? null,
          },
        )
      }

      row.end = true
      continue
    }

    if (part.type === "finish") {
      const unified =
        part.finishReason?.unified ??
        part.finishReason

      if (
        unified === "tool-calls" ||
        unified === "tool_calls"
      ) {
        finishToolCalls = true
      }
    }
  }

  if (calls.size === 0) {
    throw fail(
      "execution_control_missing_required_tool_call",
      {
        selected_tool: contract.selected_tool,
      },
    )
  }

  if (calls.size > 1) {
    throw fail(
      "execution_control_multiple_tool_calls",
      {
        selected_tool: contract.selected_tool,
        observed_calls: calls.size,
      },
    )
  }

  const call = [...calls.values()][0]

  if (call.name !== contract.selected_tool) {
    throw fail(
      "execution_control_wrong_tool_call",
      {
        selected_tool: contract.selected_tool,
        observed_tool: call.name,
      },
    )
  }

  const complete =
    call.final === true ||
    (
      call.start === true &&
      call.end === true
    ) ||
    (
      call.delta === true &&
      finishToolCalls
    )

  if (!complete) {
    throw fail(
      "execution_control_incomplete_tool_call",
      {
        selected_tool: contract.selected_tool,
      },
    )
  }
}



export const FIRST_ACTION_COMMIT_PROTOCOL =
  "execution-first-action-commit-v1"

export function classifyFirstActionPrefix(parts, contract) {
  if (contract?.active !== true) {
    return frozen({
      protocol: FIRST_ACTION_COMMIT_PROTOCOL,
      state: "not_applicable",
      call_id: null,
      completion: null,
      mutation_authority: false,
    })
  }

  const calls = new Map()

  const observe = (idRaw, nameRaw, evidence) => {
    const id =
      typeof idRaw === "string" && idRaw.length > 0
        ? idRaw
        : null
    const name = toolName(nameRaw)

    if (id == null || name == null) {
      throw fail("execution_control_stream_call_invalid")
    }

    const prior = calls.get(id)
    if (prior && prior.name !== name) {
      throw fail("execution_control_stream_call_conflict", {
        call_id: id,
        first_tool: prior.name,
        observed_tool: name,
      })
    }

    if (name !== contract.selected_tool) {
      throw fail("execution_control_wrong_tool_call", {
        selected_tool: contract.selected_tool,
        observed_tool: name,
      })
    }

    const row = prior ?? {
      id,
      name,
      start: false,
      end: false,
      final: false,
    }
    row[evidence] = true
    calls.set(id, row)

    if (calls.size > 1) {
      throw fail("execution_control_multiple_tool_calls", {
        selected_tool: contract.selected_tool,
        observed_calls: calls.size,
      })
    }
  }

  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue

    if (part.type === "tool-input-start") {
      observe(
        part.id ?? part.toolCallId,
        part.toolName,
        "start",
      )
      continue
    }

    if (part.type === "tool-input-end") {
      const id = part.id ?? part.toolCallId
      const row = calls.get(id)
      if (!row || row.start !== true) {
        throw fail("execution_control_stream_end_without_start", {
          call_id: id ?? null,
        })
      }
      row.end = true
      continue
    }

    if (part.type === "tool-call") {
      observe(
        part.toolCallId ?? part.id,
        part.toolName,
        "final",
      )
    }
  }

  if (calls.size === 0) {
    return frozen({
      protocol: FIRST_ACTION_COMMIT_PROTOCOL,
      state: "pending",
      call_id: null,
      completion: null,
      mutation_authority: false,
    })
  }

  const row = [...calls.values()][0]
  const completion =
    row.final === true
      ? "final_tool_call"
      : row.start === true && row.end === true
        ? "tool_input_end"
        : null

  return frozen({
    protocol: FIRST_ACTION_COMMIT_PROTOCOL,
    state: completion ? "complete" : "pending",
    call_id: row.id,
    completion,
    mutation_authority: false,
  })
}

export function createFirstActionCommitStream({
  stream,
  contract,
  dispatch,
} = {}) {
  if (
    contract?.active !== true ||
    dispatch?.active !== true ||
    dispatch?.mode !== "required_singleton_tool" ||
    !stream ||
    typeof stream.getReader !== "function"
  ) {
    throw fail("execution_control_first_action_stream_invalid")
  }

  const reader = stream.getReader()
  let upstreamDone = false
  let downstreamCancelled = false

  const cancelUpstream = (reason) => {
    if (upstreamDone) return
    upstreamDone = true
    Promise.resolve(reader.cancel(reason)).catch(() => {})
  }

  return new ReadableStream({
    async start(controller) {
      const buffered = []

      try {
        while (!downstreamCancelled) {
          const next = await reader.read()

          if (next.done) {
            upstreamDone = true
            const materialized =
              materializeExecutionControlledStream(
                buffered,
                contract,
                dispatch,
              )
            validateStreamParts(materialized, contract)
            for (const chunk of materialized) {
              controller.enqueue(chunk)
            }
            controller.close()
            return
          }

          buffered.push(next.value)

          const prefix =
            classifyFirstActionPrefix(
              buffered,
              contract,
            )

          if (prefix.state !== "complete") continue

          const materialized =
            materializeExecutionControlledStream(
              buffered,
              contract,
              dispatch,
            )
          validateStreamParts(materialized, contract)

          for (const chunk of materialized) {
            controller.enqueue(chunk)
          }
          controller.close()

          cancelUpstream(
            `${FIRST_ACTION_COMMIT_PROTOCOL}:committed`,
          )
          return
        }
      } catch (error) {
        if (!downstreamCancelled) controller.error(error)
        cancelUpstream(
          `${FIRST_ACTION_COMMIT_PROTOCOL}:failed`,
        )
      }
    },

    cancel(reason) {
      downstreamCancelled = true
      cancelUpstream(
        reason ??
          `${FIRST_ACTION_COMMIT_PROTOCOL}:downstream_cancel`,
      )
    },
  })
}


export function wrapExecutionControlledLanguage(language) {
  if (
    !language ||
    typeof language !== "object"
  ) {
    throw fail(
      "execution_control_language_invalid",
    )
  }

  return new Proxy(language, {
    get(target, property, receiver) {
      if (property === "doGenerate") {
        if (
          typeof target.doGenerate !== "function"
        ) {
          return undefined
        }

        return async (options) => {
          const contract =
            compileProviderDispatchContract(
              options,
            )

          const dispatch =
            compileArgumentSynthesisDispatch({
              options,
              language: target,
              contract,
            })

          const rawResult =
            dispatch.zero_inference === true
              ? null
              : await target.doGenerate.call(
                  target,
                  enforceProviderDispatch(
                    options,
                    contract,
                    target,
                    dispatch,
                  ),
                )

          const result =
            materializeExecutionControlledGenerate(
              rawResult,
              contract,
              dispatch,
            )

          if (contract.active === true) {
            if (
              !result ||
              typeof result !== "object"
            ) {
              throw fail(
                "execution_control_provider_result_invalid",
              )
            }

            validateGeneratedParts(
              result.content,
              contract,
            )
          }

          return result
        }
      }

      if (property === "doStream") {
        if (
          typeof target.doStream !== "function"
        ) {
          return undefined
        }

        return async (options) => {
          const contract =
            compileProviderDispatchContract(
              options,
            )

          const dispatch =
            compileArgumentSynthesisDispatch({
              options,
              language: target,
              contract,
            })

          if (
            contract.active === true &&
            dispatch.zero_inference === true
          ) {
            const zero =
              zeroInferenceStreamResult(
                contract,
                dispatch,
              )

            const buffered = []
            const guarded =
              zero.stream.pipeThrough(
                new TransformStream({
                  transform(chunk) {
                    buffered.push(chunk)
                  },
                  flush(controller) {
                    validateStreamParts(
                      buffered,
                      contract,
                    )
                    for (const chunk of buffered) {
                      controller.enqueue(chunk)
                    }
                  },
                }),
              )

            return {
              ...zero,
              stream: guarded,
            }
          }

          const result =
            await target.doStream.call(
              target,
              enforceProviderDispatch(
                options,
                contract,
                target,
                dispatch,
              ),
            )

          if (contract.active !== true) {
            return result
          }

          if (
            !result ||
            typeof result !== "object" ||
            !result.stream ||
            typeof result.stream.pipeThrough !==
              "function"
          ) {
            throw fail(
              "execution_control_provider_stream_invalid",
            )
          }

          /*
           * First-action commit is valid only for the exact
           * required-singleton dispatch transport. Other active
           * execution-control paths retain the proven transactional
           * EOF barrier.
           */
          if (
            dispatch.active === true &&
            dispatch.mode === "required_singleton_tool"
          ) {
            return {
              ...result,
              stream: createFirstActionCommitStream({
                stream: result.stream,
                contract,
                dispatch,
              }),
            }
          }

          const buffered = []

          const guarded =
            result.stream.pipeThrough(
              new TransformStream({
                transform(chunk) {
                  buffered.push(chunk)
                },

                flush(controller) {
                  const materialized =
                    materializeExecutionControlledStream(
                      buffered,
                      contract,
                      dispatch,
                    )

                  validateStreamParts(
                    materialized,
                    contract,
                  )

                  for (const chunk of materialized) {
                    controller.enqueue(chunk)
                  }
                },
              }),
            )

          return {
            ...result,
            stream: guarded,
          }
        }
      }

      return Reflect.get(
        target,
        property,
        receiver,
      )
    },
  })
}



/*
 * HARD TASK LEASE
 *
 * This layer does not invent budget policy.
 * Governor supplies an absolute deadline; Execution Control gives
 * that deadline actual cancellation authority.
 */
export function createTaskLeaseController({
  interruptSession,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = null,
} = {}) {
  if (
    typeof interruptSession !== "function"
  ) {
    throw fail(
      "execution_control_interrupt_unavailable",
    )
  }

  const leases = new Map()

  const disarm = (sessionID) => {
    const current =
      leases.get(sessionID)

    if (!current) {
      return false
    }

    clearTimer(current.timer)
    leases.delete(sessionID)
    return true
  }

  const arm = ({
    sessionID,
    turnID,
    deadlineAtMs,
    onExpire = null,
  }) => {
    if (
      typeof sessionID !== "string" ||
      sessionID.length === 0
    ) {
      throw fail(
        "execution_control_session_invalid",
      )
    }

    if (
      typeof turnID !== "string" ||
      turnID.length === 0
    ) {
      throw fail(
        "execution_control_turn_invalid",
      )
    }

    if (!Number.isFinite(deadlineAtMs)) {
      throw fail(
        "execution_control_deadline_invalid",
      )
    }

    disarm(sessionID)

    const token = Symbol(
      `${sessionID}:${turnID}`,
    )

    const expire = async () => {
      const current =
        leases.get(sessionID)

      if (
        !current ||
        current.token !== token
      ) {
        return
      }

      leases.delete(sessionID)

      try {
        if (typeof onExpire === "function") {
          const allow =
            await onExpire({
              protocol:
                EXECUTION_CONTROL_PROTOCOL,
              sessionID,
              turnID,
              deadlineAtMs,
            })

          if (allow === false) {
            return
          }
        }

        await interruptSession(
          sessionID,
        )
      } catch (error) {
        if (typeof onError === "function") {
          try {
            onError(
              error,
              {
                sessionID,
                turnID,
                deadlineAtMs,
              },
            )
          } catch {
            // Telemetry cannot create execution authority.
          }
        }
      }
    }

    const remainingMs =
      Math.max(
        0,
        deadlineAtMs - now(),
      )

    const timer =
      setTimer(
        expire,
        remainingMs,
      )

    timer?.unref?.()

    leases.set(
      sessionID,
      {
        token,
        timer,
        deadlineAtMs,
      },
    )

    return frozen({
      protocol:
        EXECUTION_CONTROL_PROTOCOL,
      sessionID,
      turnID,
      deadline_at_ms: deadlineAtMs,
      remaining_ms: remainingMs,
      authority:
        "governor_absolute_deadline",
    })
  }

  const dispose = () => {
    for (
      const sessionID
      of [...leases.keys()]
    ) {
      disarm(sessionID)
    }
  }

  return frozen({
    protocol:
      EXECUTION_CONTROL_PROTOCOL,
    arm,
    disarm,
    dispose,
  })
}
