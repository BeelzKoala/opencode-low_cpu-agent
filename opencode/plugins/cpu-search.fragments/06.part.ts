
export default {
  id: "cpu-agent.global",

  setup: async (ctx) => {
    const registrations = []
    const track = async (registrationPromise) => {
      registrations.push(await registrationPromise)
    }

    const unsubscribeEvents = await subscribeEvents(ctx)

    // C7-R4: one server-side mutation capability per model dispatch.
    const mutationExecutionPermitOptions = (
      state,
      requestedTool,
    ) => ({
      turnID: state?.turnID ?? null,
      dispatchGeneration:
        state?.modelCalls ?? null,
      selectedTool:
        nextActionForExecutionState(state),
      requestedTool,
      editCapsuleSha256:
        state?.editCapsuleHash ??
        state?.editCapsuleSha256 ??
        null,
    })

    const mutationPermitStop = (permit) => ({
      content:
        `PATCH_STOP reason=${permit?.reason ?? "mutation_execution_permit_invalid"} ` +
        "action=report_blocked",
      metadata: {
        protocol:
          permit?.protocol ??
          EXECUTION_PERMIT_PROTOCOL,
        action: "stop",
        reason:
          permit?.reason ??
          "mutation_execution_permit_invalid",
        failure_layer: "execution_permit",
        execution_permit_dispatch_generation:
          permit?.dispatch_generation ?? null,
        execution_permit_selected_tool:
          permit?.selected_tool ?? null,
        execution_permit_requested_tool:
          permit?.requested_tool ?? null,
        execution_permit_edit_capsule_sha256:
          permit?.edit_capsule_sha256 ?? null,
        execution_permit_claims:
          permit?.claims ?? null,
        execution_permit_max_claims: 1,
        mutation_authority: false,
      },
    })

    const executeCapabilityMutationCore = async (
      rawInput,
      toolContext,
      forcedKind,
      toolName,
      dispatch = null,
    ) => {
      const input = {
        ...(rawInput ?? {}),
        kind: forcedKind,
      }
        const dispatchOrigin =
        dispatch?.origin === ACTION_COMMIT_DISPATCH_ORIGIN
          ? ACTION_COMMIT_DISPATCH_ORIGIN
          : "model_tool"
      const actionCommit =
        dispatchOrigin === ACTION_COMMIT_DISPATCH_ORIGIN
          ? dispatch?.actionCommit ?? null
          : null
      const started = performance.now()
        const sessionID =
          typeof toolContext?.sessionID === "string" && toolContext.sessionID.length > 0
            ? toolContext.sessionID
            : null
        const state = getSessionState(sessionID)
          // C7-R4 EXECUTION PERMIT: common mutation core.
          // Additive semantic input claims before materialization. ActionCommit
          // keeps its existing deterministic single-flight authority.
          const executionPermit =
            dispatchOrigin === ACTION_COMMIT_DISPATCH_ORIGIN
              ? {
                  ok: true,
                  protocol:
                    EXECUTION_PERMIT_PROTOCOL,
                  reason:
                    "action_commit_single_flight_authority",
                  dispatch_generation:
                    state?.modelCalls ?? null,
                  selected_tool: toolName,
                  requested_tool: toolName,
                  edit_capsule_sha256:
                    state?.editCapsuleHash ??
                    state?.editCapsuleSha256 ??
                    null,
                  claims: 1,
                  max_claims: 1,
                  mutation_authority: false,
                }
              : forcedKind === "additive_surface"
                ? validateClaimedMutationExecutionPermit(
                    state,
                    mutationExecutionPermitOptions(
                      state,
                      toolName,
                    ),
                  )
                : claimMutationExecutionPermit(
                    state,
                    mutationExecutionPermitOptions(
                      state,
                      toolName,
                    ),
                  )

          if (executionPermit.ok !== true) {
            if (state) {
              applyExecutionEvent(
                state,
                "fatal",
                executionPermit.reason,
              )
            }
            return mutationPermitStop(
              executionPermit,
            )
          }

        const root = await rootForTool(ctx, toolContext, sessionID, state)
        const observedModelLatencyMs =
          observeModelLatencyAtToolBoundary(state)
        const runtimeIdentity = await runtimeStackIdentity()

        const trace = async (record) => {
          await writeProjectTrace(root, "executor-trace.jsonl", {
            ts: nowMs(),
            protocol: EXECUTION_LOOP_PROTOCOL,
            sessionID,
            turnID: state?.turnID ?? null,
            project_root: root,
            mutation_attempt: state?.mutationAttempts ?? null,
            repair_attempts: state?.repairAttempts ?? null,
            compiler_runs: state?.compilerRuns ?? null,
            patch_attempt: state?.patchAttempts ?? null,
            executor_runs: state?.executorRuns ?? null,
            executed_patches: state?.executedPatches ?? null,
            turn_model_calls: state?.modelCalls ?? null,
            observed_model_latency_ms: observedModelLatencyMs,
            model_latency_samples: state?.modelLatencySamples ?? 0,
            model_latency_max_ms: state?.modelLatencyMaxMs ?? 0,
            scout_handoff_path: state?.scoutHandoffPath ?? null,
            edit_capsule_path: state?.editCapsulePath ?? null,
            bound_mutation_target: state?.boundMutationTarget ?? null,
            preauthorized_mutation_candidates:
              state?.localMutationCandidates?.length ?? 0,
            execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
            execution_state: state?.executionState ?? null,
            execution_reason: state?.executionReason ?? null,
            mutation_tool_abi_protocol: MUTATION_TOOL_ABI_PROTOCOL,
            mutation_tool: toolName,
            semantic_kind: forcedKind,
            obligation_bound_synthesis_protocol:
              forcedKind === "additive_surface"
                ? OBLIGATION_BOUND_SYNTHESIS_PROTOCOL
                : null,
            mutation_dispatch_origin: dispatchOrigin,
            action_commit_protocol: actionCommit?.protocol ?? null,
            action_commit_sha256: actionCommit?.commit_sha256 ?? null,
            tool_contract_failures: state?.contractFailures ?? null,
            ...runtimeIdentity,
            ...record,
            tool_elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
          })
        }

        if (!root || !state) {
          await trace({ admitted: false, reason: "session_root_unavailable", action: "stop" })
          return { content: "PATCH_STOP reason=session_root_unavailable action=report_blocked" }
        }
        if (
          dispatchOrigin === ACTION_COMMIT_DISPATCH_ORIGIN &&
          (
            actionCommit?.protocol !== ACTION_COMMIT_PROTOCOL ||
            actionCommit?.operation !== "rename_symbol" ||
            actionCommit?.tool !== toolName ||
            actionCommit?.task_sha256 !== state.taskTextSha256 ||
            actionCommit?.new_name !== rawInput?.new_name ||
            actionCommit?.old_name !==
              state?.renameMutationCapability?.target?.symbol_name ||
            actionCommit?.scout_handoff_path !== state.scoutHandoffPath ||
            actionCommit?.target_identity_sha256 !==
              state?.renameMutationCapability?.targetIdentitySha256 ||
            actionCommit?.target_source_sha256 !==
              state?.renameMutationCapability?.targetSourceSha256 ||
            actionCommit?.commit_sha256 !== state.actionCommitSha256
          )
        ) {
          applyExecutionEvent(state, "fatal", "action_commit_stale")
          await trace({ admitted: false, reason: "action_commit_stale", action: "stop" })
          return {
            content: "PATCH_STOP reason=action_commit_stale action=report_blocked",
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason: "action_commit_stale",
            },
          }
        }

        const exactTaskRename =
          state?.taskAction?.protocol === TASK_ACTION_PROTOCOL &&
          state?.taskAction?.status === "exact" &&
          state?.taskAction?.operation === "rename_symbol" &&
          state?.taskAction?.task_sha256 === state?.taskTextSha256

        if (
          forcedKind === "rename_symbol" &&
          exactTaskRename &&
          rawInput?.new_name !== state.taskAction.new_name
        ) {
          applyExecutionEvent(state, "fatal", "task_action_argument_mismatch")
          await trace({
            admitted: false,
            reason: "task_action_argument_mismatch",
            action: "stop",
          })
          return {
            content:
              "PATCH_STOP reason=task_action_argument_mismatch " +
              "action=report_blocked",
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason: "task_action_argument_mismatch",
            },
          }
        }
        if (!toolAllowedForExecutionState(state, toolName)) {
          const next = nextActionForExecutionState(state)
          const action = state.executionState === EXEC_STATE_LOCATE ? "rescout" : "stop"
          await trace({ admitted: false, reason: "causal_frontier", action, execution_state: state.executionState })
          return {
            content: `${action === "rescout" ? "PATCH_RESCOUT" : "PATCH_STOP"} reason=causal_frontier state=${state.executionState} action=${next}`,
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action,
              reason: "causal_frontier",
              execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
              execution_state: state.executionState,
              next_action: next,
            },
          }
        }
        if (!state.scoutHandoffPath) {
          applyExecutionEvent(state, "patch_rescout", "scout_handoff_missing", { reason: "scout_handoff_missing" })
          await trace({ admitted: false, reason: "scout_handoff_missing", action: "rescout" })
          return {
            content: "PATCH_RESCOUT reason=scout_handoff_missing action=search_first",
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "rescout", reason: "scout_handoff_missing" },
          }
        }
        if (state.patchAccepted) {
          applyExecutionEvent(state, "patch_ready", "patch_already_accepted")
          await trace({ admitted: false, reason: "patch_already_accepted", action: "stop", receipt_path: state.patchReceiptPath })
          return {
            content: `PATCH_STOP reason=patch_already_accepted receipt=${state.patchReceiptPath ?? "unknown"} action=use_receipt`,
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason: "patch_already_accepted", receipt_path: state.patchReceiptPath },
          }
        }
        if (state.mutationAttempts >= MAX_PATCH_ATTEMPTS_PER_TURN) {
          applyExecutionEvent(state, "fatal", "mutation_attempt_budget")
          await trace({
            admitted: false,
            reason: "mutation_attempt_budget",
            action: "stop",
          })
          return {
            content:
              `PATCH_STOP reason=mutation_attempt_budget ` +
              `attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} ` +
              `action=report_blocked`,
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason: "mutation_attempt_budget",
            },
          }
        }

        const forbiddenRawAuthorityField = [
          "kind",
          "file",
          "symbol",
          "scope",
        ].find((field) => mutationFieldPresent(rawInput, field))

        const shape = forbiddenRawAuthorityField
          ? mutationShapeFailure(
              forcedKind,
              `action_tool_forbids_${forbiddenRawAuthorityField}`,
            )
          : forcedKind === "additive_surface"
            // R7-R6-B: `kind` is orchestration metadata, not part of the
            // exact physical additive ABI. The source-slot/semantic frontend
            // already materialized a sealed physical request before this core.
            ? validateAdditiveMutationRequest(rawInput)
            : validateMutationShape(input)

        const contractDetail =
          (
            typeof shape?.detail === "string" &&
            shape.detail.length > 0
          )
            ? shape.detail
            : (
                typeof shape?.reason === "string" &&
                shape.reason.length > 0
              )
              ? shape.reason
              : "mutation_contract_invalid"

        const contractSignature =
          (
            typeof shape?.signature === "string" &&
            shape.signature.length > 0
          )
            ? shape.signature
            : `${forcedKind}:${contractDetail}`

        // Tool-schema/transport violations are not semantic patch attempts.
        // With action-specific top-level required fields these should be
        // unreachable under a conforming provider; if they reach runtime,
        // fail closed without consuming the one semantic repair.
        if (shape.ok !== true) {
          state.contractFailures += 1
          const repeated =
            state.contractFailureSignatures.has(
              contractSignature,
            )
          state.contractFailureSignatures.add(
            contractSignature,
          )
          applyExecutionEvent(
            state,
            "fatal",
            "tool_contract_violation",
          )

          await trace({
            admitted: false,
            failure_layer: "tool_contract",
            reason: "tool_contract_violation",
            contract_reason:
              shape?.reason ?? null,
            contract_detail:
              contractDetail,
            contract_signature:
              contractSignature,
            repeated_contract_failure:
              repeated,
            action: "stop",
            compiler_run: false,
            executor_run: false,
          })

          return {
            content:
              `PATCH_STOP reason=tool_contract_violation ` +
              `detail=${contractDetail} ` +
              `semantic_attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} ` +
              `contract_failures=${state.contractFailures} ` +
              "action=report_blocked",
            metadata: {
              protocol:
                EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason:
                "tool_contract_violation",
              contract_reason:
                shape?.reason ?? null,
              detail:
                contractDetail,
              contract_signature:
                contractSignature,
              failure_layer:
                "tool_contract",
              semantic_attempt_consumed: false,
              compiler_run: false,
              executor_run: false,
            },
          }
        }

        if (
          state.activeMutationTool &&
          state.activeMutationTool !== toolName
        ) {
          applyExecutionEvent(state, "fatal", "mutation_action_changed_during_attempt")
          await trace({
            admitted: false,
            failure_layer: "orchestrator_contract",
            reason: "mutation_action_changed_during_attempt",
            previous_tool: state.activeMutationTool,
            attempted_tool: toolName,
            action: "stop",
            compiler_run: false,
            executor_run: false,
          })
          return {
            content:
              `PATCH_STOP reason=mutation_action_changed_during_attempt ` +
              `expected=${state.activeMutationTool} got=${toolName} action=report_blocked`,
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason: "mutation_action_changed_during_attempt",
              failure_layer: "orchestrator_contract",
              compiler_run: false,
              executor_run: false,
            },
          }
        }

        if (
          forcedKind === "additive_surface" &&
          state.executionState === EXEC_STATE_REPAIR &&
          state.additiveRepairLock
        ) {
          const repairAuthorityOk =
            state.additiveRepairLock?.tool === toolName &&
            (
              additiveRepairAuthorityMatches({
                hint: state.additiveRepairLock,
                capability:
                  state.additiveMutationCapability,
                executionContextSha256:
                  state.executionContextCapsuleSha256,
              }) ||
              fileFamilyRepairAuthorityMatches({
                hint: state.additiveRepairLock,
                capability:
                  state.additiveMutationCapability,
                executionContextSha256:
                  state.executionContextCapsuleSha256,
              }) ||
              pythonSemanticRepairAuthorityMatches({
                hint: state.additiveRepairLock,
                capability:
                  state.additiveMutationCapability,
                executionContextSha256:
                  state.executionContextCapsuleSha256,
              }) ||
              // R7-R3 source-slot repair authority: only an attested
              // byte-preserving source cache may narrow a repair dispatch.
              sourceSlotRepairAuthorityMatches({
                hint: state.additiveRepairLock,
                capability:
                  state.additiveMutationCapability,
                executionContextSha256:
                  state.executionContextCapsuleSha256,
                binding:
                  state.activeSourceSlotContract?.binding ?? null,
              })
            )

          if (!repairAuthorityOk) {
            state.additiveRepairLock = null
            applyExecutionEvent(
              state,
              "fatal",
              "additive_repair_authority_drift",
            )
            await trace({
              admitted: false,
              failure_layer: "orchestrator_contract",
              reason: "additive_repair_authority_drift",
              action: "stop",
              compiler_run: false,
              executor_run: false,
            })
            return {
              content:
                "PATCH_STOP reason=additive_repair_authority_drift " +
                "action=report_blocked",
              metadata: {
                protocol: EXECUTION_LOOP_PROTOCOL,
                action: "stop",
                reason: "additive_repair_authority_drift",
                failure_layer: "orchestrator_contract",
                compiler_run: false,
                executor_run: false,
              },
            }
          }
        }

        if (
          forcedKind === "additive_surface" &&
          state.executionContextBlockReason
        ) {
          const contextBlockReason =
            state.executionContextBlockReason
          applyExecutionEvent(
            state,
            "fatal",
            contextBlockReason,
          )
          await trace({
            admitted: false,
            failure_layer: "orchestrator_contract",
            reason: contextBlockReason,
            action: "stop",
            compiler_run: false,
            executor_run: false,
          })
          return {
            content:
              `PATCH_STOP reason=${contextBlockReason} ` +
              "action=report_blocked",
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason: contextBlockReason,
              failure_layer: "orchestrator_contract",
              compiler_run: false,
              executor_run: false,
            },
          }
        }
        state.activeMutationTool = toolName

        if (state.executionState === EXEC_STATE_REPAIR) {
          state.repairAttempts += 1
        }

        state.mutationAttempts += 1
        state.lastSeen = nowMs()

        const authorization =
          forcedKind === "additive_surface"
            ? await (async () => {
                const plan = await materializeAdditiveMutationPlan({
                  root,
                  capability: state.additiveMutationCapability,
                  request: rawInput,
                })
                if (plan.ok === true) {
                  return {
                    ...plan,
                    handoff_path: state.additiveMutationHandoffPath,
                  }
                }

                const repairHint = buildAdditiveRepairHint({
                  failure: plan,
                  capability: state.additiveMutationCapability,
                  request: rawInput,
                  executionContextSha256:
                    state.executionContextCapsuleSha256,
                  previousRepairHint:
                    state.additiveRepairLock,
                })
                return {
                  ...plan,
                  repairable: repairHint.repairable === true,
                  rescout: false,
                  repair_hint: repairHint,
                }
              })()
            : await materializeCapabilityBoundMutation(
                root,
                state,
                input,
              )

        if (authorization.ok !== true) {
          const reason =
            typeof authorization.reason === "string"
              ? authorization.reason
              : "mutation_scope_unavailable"

          const detail =
            typeof authorization.detail === "string"
              ? authorization.detail
              : reason

          const authorizationFailureLayer =
            forcedKind === "additive_surface" &&
            reason === "additive_plan_coverage_incomplete"
              ? "synthesis_validation"
              : "scope_authorization"

          const canRetryAuthorization =
            authorization.repairable === true &&
            state.mutationAttempts < MAX_PATCH_ATTEMPTS_PER_TURN

          if (canRetryAuthorization) {
            const additiveRepairHint =
              forcedKind === "additive_surface"
                ? authorization.repair_hint ?? null
                : null

            if (forcedKind === "additive_surface") {
              if (
                additiveRepairHint?.repairable !== true ||
                !additiveRepairAuthorityMatches({
                  hint: additiveRepairHint,
                  capability: state.additiveMutationCapability,
                  executionContextSha256:
                    state.executionContextCapsuleSha256,
                })
              ) {
                state.additiveRepairLock = null
                applyExecutionEvent(
                  state,
                  "fatal",
                  "additive_repair_authority_unavailable",
                )
                return {
                  content:
                    "PATCH_STOP reason=additive_repair_authority_unavailable " +
                    "action=report_blocked",
                  metadata: {
                    protocol: EXECUTION_LOOP_PROTOCOL,
                    action: "stop",
                    reason: "additive_repair_authority_unavailable",
                    failure_layer: "orchestrator_contract",
                    compiler_run: false,
                    executor_run: false,
                  },
                }
              }

              state.additiveRepairLock = Object.freeze({
                ...additiveRepairHint,
                tool: toolName,
              })
            }

            applyExecutionEvent(
              state,
              "patch_retry",
              reason,
            )

            await trace({
              admitted: false,
              failure_layer: authorizationFailureLayer,
              reason,
              scope_detail: detail,
              repair_hint: additiveRepairHint,
              action: "retry",
              compiler_run: false,
              executor_run: false,
            })

            const repairAction =
              forcedKind === "additive_surface"
                ? "revise_additive_transaction"
                : "revise_semantic_owner_binding"
            const repairDetail =
              additiveRepairHint
                ? ` repair_protocol=${ADDITIVE_REPAIR_HINT_PROTOCOL}` +
                  ` operation_index=${additiveRepairHint.operation_index ?? "none"}` +
                  ` field=${additiveRepairHint.field ?? "none"}`
                : ""
            const repairCoverageDetail =
              additiveRepairHint
                ? [
                    [
                      "missing_slots",
                      additiveRepairHint.failure_diagnostics
                        ?.missing_slots,
                    ],
                    [
                      "missing_roles",
                      additiveRepairHint.failure_diagnostics
                        ?.missing_roles,
                    ],
                    [
                      "missing_obligations",
                      additiveRepairHint.failure_diagnostics
                        ?.missing_obligations,
                    ],
                    [
                      "observed_unused_existing_slots",
                      additiveRepairHint.slot_usage
                        ?.unused_existing_slots,
                    ],
                    [
                      "observed_unused_create_slots",
                      additiveRepairHint.slot_usage
                        ?.unused_create_slots,
                    ],
                  ]
                    .filter(([, values]) =>
                      Array.isArray(values) && values.length > 0,
                    )
                    .map(([key, values]) =>
                      ` ${key}=${values.join(",")}`,
                    )
                    .join("")
                : ""

            return {
              content:
                `PATCH_RETRY reason=${reason} ` +
                `detail=${detail} ` +
                `attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN}` +
                repairDetail +
                repairCoverageDetail +
                ` action=${repairAction}`,
              metadata: {
                protocol: EXECUTION_LOOP_PROTOCOL,
                action: "retry",
                reason,
                detail,
                repair_hint: additiveRepairHint,
                failure_layer: authorizationFailureLayer,
                compiler_run: false,
                executor_run: false,
              },
            }
          }

          if (authorization.rescout === true) {
            applyExecutionEvent(
              state,
              "patch_rescout",
              reason,
              {
                reason,
                detail,
              },
            )

            await trace({
              admitted: false,
              failure_layer: authorizationFailureLayer,
              reason,
              scope_detail: detail,
              action: "rescout",
              compiler_run: false,
              executor_run: false,
            })

            return {
              content:
                `PATCH_RESCOUT reason=${reason} ` +
                `detail=${detail} ` +
                `attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} ` +
                `action=refine_search`,
              metadata: {
                protocol: EXECUTION_LOOP_PROTOCOL,
                action: "rescout",
                reason,
                detail,
                failure_layer: authorizationFailureLayer,
                compiler_run: false,
                executor_run: false,
              },
            }
          }

          applyExecutionEvent(
            state,
            "fatal",
            reason,
          )

          await trace({
            admitted: false,
            failure_layer: "internal_contract",
            reason,
            scope_detail: detail,
            action: "stop",
            compiler_run: false,
            executor_run: false,
          })

          return {
            content:
              `PATCH_STOP reason=${reason} ` +
              `detail=${detail} action=report_blocked`,
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason,
              detail,
              failure_layer: "internal_contract",
              compiler_run: false,
              executor_run: false,
            },
          }
        }

        if (forcedKind === "additive_surface") {
          state.additiveRepairLock = null
        }

        const mutations =
          Array.isArray(authorization.mutations)
            ? authorization.mutations
            : [authorization.mutation]

        const activeMutationHandoffPath =
          authorization.handoff_path

        if (
          typeof activeMutationHandoffPath !== "string" ||
          activeMutationHandoffPath.length < 1
        ) {
          applyExecutionEvent(state, "fatal", "mutation_handoff_unavailable")
          await trace({
            admitted: false,
            reason: "mutation_handoff_unavailable",
            action: "stop",
            compiler_run: false,
            executor_run: false,
          })
          return {
            content:
              "PATCH_STOP reason=mutation_handoff_unavailable action=report_blocked",
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "stop",
              reason: "mutation_handoff_unavailable",
            },
          }
        }

        state.activeMutationHandoffPath = activeMutationHandoffPath
        state.compilerRuns += 1

        const compiled = await runPatchCompiler(root, {
          root,
          handoff: activeMutationHandoffPath,
          mutation_protocol: PATCH_MUTATION_PROTOCOL,
          mutations,
        })
        if (!compiled.ok) {
          const reason = `compiler_${compiled.reason}`
          applyExecutionEvent(state, "fatal", reason)
          await trace({ admitted: false, reason, action: "stop", compiler_elapsed_ms: compiled.elapsedMs })
          return {
            content: `PATCH_STOP reason=${reason} action=report_blocked`,
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason },
          }
        }
        const compilerResponse = compiled.response
        if (compilerResponse?.ok !== true) {
          const reason = typeof compilerResponse?.reason === "string" ? compilerResponse.reason : "compiler_rejected"
          const needsRescout = PATCH_COMPILER_RESCOUT_REASONS.has(reason)
          const deterministicCapacityStop =
            deterministicCapacityFailureIsTerminal(
              reason,
              dispatchOrigin,
            )
          const canRetry =
            !deterministicCapacityStop &&
            PATCH_COMPILER_RETRY_REASONS.has(reason) &&
            state.mutationAttempts < MAX_PATCH_ATTEMPTS_PER_TURN
          const action = needsRescout ? "rescout" : canRetry ? "retry" : "stop"
          if (needsRescout) {
            applyExecutionEvent(state, "patch_rescout", reason, { reason, mutation_index: compilerResponse?.mutation_index ?? null })
          } else if (canRetry) {
            applyExecutionEvent(state, "patch_retry", reason)
          } else {
            applyExecutionEvent(state, "fatal", reason)
          }
          await trace({
            admitted: false,
            reason,
            action,
            compiler_elapsed_ms: compiled.elapsedMs,
            compiler_mutation_index: compilerResponse?.mutation_index ?? null,
            compiler_dropped_noops: compilerResponse?.dropped_noops ?? 0,
            compiler_dropped_duplicates: compilerResponse?.dropped_duplicates ?? 0,
            executor_run: false,
          })
          if (needsRescout) {
            return {
              content: `PATCH_RESCOUT reason=${reason} mutation_index=${compilerResponse?.mutation_index ?? "none"} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=refine_search`,
              metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "rescout", reason },
            }
          }
          if (canRetry) {
            return {
              content: `PATCH_RETRY reason=${reason} mutation_index=${compilerResponse?.mutation_index ?? "none"} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=revise_semantic_plan`,
              metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "retry", reason },
            }
          }
          return {
            content: `PATCH_STOP reason=${reason} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=report_blocked`,
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason },
          }
        }

        state.patchAttempts += 1

        const signature = patchPlanSignature(compilerResponse)
        if (state.patchSignatures.has(signature)) {
          applyExecutionEvent(state, "fatal", "duplicate_patch_plan")
          await trace({ admitted: false, reason: "duplicate_patch_plan", action: "stop", plan_signature: signature, compiler_elapsed_ms: compiled.elapsedMs, executor_run: false })
          return {
            content: `PATCH_STOP reason=duplicate_patch_plan attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=revise_or_stop`,
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason: "duplicate_patch_plan" },
          }
        }
        state.patchSignatures.add(signature)
        state.executorRuns += 1
        state.executedPatches += 1

        const result = await runPatchExecutor(root, {
          root,
          handoff: activeMutationHandoffPath,
          mode: "guarded",
          edit_protocol: PATCH_EDIT_PROTOCOL,
          edits: compilerResponse?.edits ?? [],
          checks: compilerResponse?.checks ?? [],
        })

        if (!result.ok) {
          const reason = `executor_${result.reason}`
          applyExecutionEvent(state, "fatal", reason)
          await trace({ admitted: false, reason, action: "stop", plan_signature: signature, compiler_elapsed_ms: compiled.elapsedMs, executor_elapsed_ms: result.elapsedMs })
          return {
            content: `PATCH_STOP reason=${reason} action=report_blocked`,
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason },
          }
        }

        const response = result.response
        if (response?.admitted === true) {
          const proofObligations = proofObligationsForMutations(mutations)
          state.proofObligations = proofObligations
          const verified = await runInvariantVerifier(root, {
            root,
            handoff: activeMutationHandoffPath,
            patch: response?.patch ?? "",
            compiler_protocol: PATCH_COMPILER_PROTOCOL,
            mutation_protocol: PATCH_MUTATION_PROTOCOL,
            mutations,
            changed_files: compilerResponse?.changed_files ?? [],
            edits: compilerResponse?.edits ?? [],
          })
          if (!verified.ok) {
            const reason = `verifier_${verified.reason}`
            applyExecutionEvent(state, "fatal", reason)
            await trace({ admitted: false, reason, action: "stop", plan_signature: signature, compiler_elapsed_ms: compiled.elapsedMs, executor_elapsed_ms: result.elapsedMs, verifier_elapsed_ms: verified.elapsedMs })
            return {
              content: `PATCH_STOP reason=${reason} action=report_blocked`,
              metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason },
            }
          }
          const verificationResponse = verified.response
          const proofAssessment = assessProofObligations(verificationResponse, proofObligations)
          if (!proofAssessment.ok) {
            const failedProofs = compactProofFailure(proofAssessment)
            const canRepair =
              proofAssessment.disposition === "repair" &&
              state.mutationAttempts < MAX_PATCH_ATTEMPTS_PER_TURN
            if (proofAssessment.disposition === "rescout") {
              applyExecutionEvent(state, "verification_rescout", "proof_obligation_failed", {
                reason: "proof_obligation_failed",
                failed: proofAssessment.failed,
              })
              await trace({ admitted: false, reason: "proof_obligation_failed", action: "rescout", failed_proofs: failedProofs, plan_signature: signature, compiler_elapsed_ms: compiled.elapsedMs, executor_elapsed_ms: result.elapsedMs, verifier_elapsed_ms: verified.elapsedMs })
              return {
                content: `PATCH_RESCOUT reason=proof_obligation_failed failed=${failedProofs} action=refine_search`,
                metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "rescout", reason: "proof_obligation_failed", proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL, failed_proofs: proofAssessment.failed },
              }
            }
            if (canRepair) {
              applyExecutionEvent(state, "verification_repair", "proof_obligation_failed")
              await trace({ admitted: false, reason: "proof_obligation_failed", action: "retry", failed_proofs: failedProofs, plan_signature: signature, compiler_elapsed_ms: compiled.elapsedMs, executor_elapsed_ms: result.elapsedMs, verifier_elapsed_ms: verified.elapsedMs })
              return {
                content: `PATCH_RETRY reason=proof_obligation_failed failed=${failedProofs} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=revise_semantic_plan`,
                metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "retry", reason: "proof_obligation_failed", proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL, failed_proofs: proofAssessment.failed },
              }
            }
            applyExecutionEvent(state, "fatal", "proof_obligation_failed")
            await trace({ admitted: false, reason: "proof_obligation_failed", action: "stop", failed_proofs: failedProofs, plan_signature: signature, compiler_elapsed_ms: compiled.elapsedMs, executor_elapsed_ms: result.elapsedMs, verifier_elapsed_ms: verified.elapsedMs })
            return {
              content: `PATCH_STOP reason=proof_obligation_failed failed=${failedProofs} action=report_blocked`,
              metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason: "proof_obligation_failed", proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL, failed_proofs: proofAssessment.failed },
            }
          }
          let taskProofPlan = null
          let taskProofAssessment = null
          let taskProofElapsedMs = 0

          if (forcedKind === "additive_surface") {
            taskProofPlan =
              compileTaskProofObligations(
                state?.taskRequirements,
              )

            if (taskProofPlan?.ok !== true) {
              const reason =
                `task_proof_compile_${taskProofPlan?.reason ?? "failed"}`

              applyExecutionEvent(
                state,
                "fatal",
                reason,
              )

              await trace({
                admitted: false,
                reason,
                action: "stop",
                task_proof_compiler_protocol:
                  TASK_PROOF_COMPILER_PROTOCOL,
                task_proof_compile_detail:
                  taskProofPlan?.detail ?? null,
                plan_signature: signature,
                compiler_elapsed_ms:
                  compiled.elapsedMs,
                executor_elapsed_ms:
                  result.elapsedMs,
                verifier_elapsed_ms:
                  verified.elapsedMs,
              })

              return {
                content:
                  `PATCH_STOP reason=${reason} action=report_blocked`,
                metadata: {
                  protocol:
                    EXECUTION_LOOP_PROTOCOL,
                  action: "stop",
                  reason,
                },
              }
            }

            const taskProofResult =
              await runTaskProofEvaluator(
                root,
                {
                  root,
                  patch:
                    response?.patch ?? "",
                  changed_files:
                    compilerResponse
                      ?.changed_files ?? [],
                  mutations,
                  structural_verifier:
                    verificationResponse,
                  obligations:
                    taskProofPlan.obligations,
                },
              )

            taskProofElapsedMs =
              taskProofResult?.elapsedMs ?? 0

            if (taskProofResult?.ok !== true) {
              const reason =
                `task_proof_transport_${taskProofResult?.reason ?? "failed"}`

              applyExecutionEvent(
                state,
                "fatal",
                reason,
              )

              await trace({
                admitted: false,
                reason,
                action: "stop",
                task_proof_compiler_protocol:
                  TASK_PROOF_COMPILER_PROTOCOL,
                task_proof_evaluator_protocol:
                  TASK_PROOF_EVALUATOR_PROTOCOL,
                plan_signature: signature,
                compiler_elapsed_ms:
                  compiled.elapsedMs,
                executor_elapsed_ms:
                  result.elapsedMs,
                verifier_elapsed_ms:
                  verified.elapsedMs,
                task_proof_elapsed_ms:
                  taskProofElapsedMs,
              })

              return {
                content:
                  `PATCH_STOP reason=${reason} action=report_blocked`,
                metadata: {
                  protocol:
                    EXECUTION_LOOP_PROTOCOL,
                  action: "stop",
                  reason,
                },
              }
            }

            taskProofAssessment =
              taskProofResult.response

            if (!taskProofPasses(taskProofAssessment)) {
              const failedTaskProofs =
                Array.isArray(
                  taskProofAssessment?.checks,
                )
                  ? taskProofAssessment.checks
                      .filter(
                        (item) =>
                          item?.pass !== true,
                      )
                      .slice(0, 8)
                  : []

              const canRepair =
                state.mutationAttempts <
                MAX_PATCH_ATTEMPTS_PER_TURN

              if (canRepair) {
                applyExecutionEvent(
                  state,
                  "verification_repair",
                  "task_proof_failed",
                  {
                    reason:
                      "task_proof_failed",
                    failed:
                      failedTaskProofs,
                  },
                )

                await trace({
                  admitted: false,
                  reason:
                    "task_proof_failed",
                  action: "repair",
                  failed_task_proofs:
                    failedTaskProofs,
                  task_proof_compiler_protocol:
                    TASK_PROOF_COMPILER_PROTOCOL,
                  task_proof_evaluator_protocol:
                    TASK_PROOF_EVALUATOR_PROTOCOL,
                  plan_signature: signature,
                  compiler_elapsed_ms:
                    compiled.elapsedMs,
                  executor_elapsed_ms:
                    result.elapsedMs,
                  verifier_elapsed_ms:
                    verified.elapsedMs,
                  task_proof_elapsed_ms:
                    taskProofElapsedMs,
                })

                return {
                  content:
                    `PATCH_REPAIR reason=task_proof_failed ` +
                    `failed=${JSON.stringify(failedTaskProofs)} ` +
                    `attempt=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN}`,
                  metadata: {
                    protocol:
                      EXECUTION_LOOP_PROTOCOL,
                    action: "repair",
                    reason:
                      "task_proof_failed",
                    failed_task_proofs:
                      failedTaskProofs,
                  },
                }
              }

              applyExecutionEvent(
                state,
                "fatal",
                "task_proof_failed",
              )

              await trace({
                admitted: false,
                reason:
                  "task_proof_failed",
                action: "stop",
                failed_task_proofs:
                  failedTaskProofs,
                task_proof_compiler_protocol:
                  TASK_PROOF_COMPILER_PROTOCOL,
                task_proof_evaluator_protocol:
                  TASK_PROOF_EVALUATOR_PROTOCOL,
                plan_signature: signature,
                compiler_elapsed_ms:
                  compiled.elapsedMs,
                executor_elapsed_ms:
                  result.elapsedMs,
                verifier_elapsed_ms:
                  verified.elapsedMs,
                task_proof_elapsed_ms:
                  taskProofElapsedMs,
              })

              return {
                content:
                  "PATCH_STOP reason=task_proof_failed action=report_blocked",
                metadata: {
                  protocol:
                    EXECUTION_LOOP_PROTOCOL,
                  action: "stop",
                  reason:
                    "task_proof_failed",
                  failed_task_proofs:
                    failedTaskProofs,
                },
              }
            }
          }

          const persisted = await writePatchReceipt(
            root,
            sessionID,
            state,
            response,
            compilerResponse,
            verificationResponse,
            proofAssessment,
            { origin: dispatchOrigin, actionCommit },
            taskProofAssessment,
          )
          if (!persisted) {
            applyExecutionEvent(state, "fatal", "receipt_write_failed")
            await trace({ admitted: false, reason: "receipt_write_failed", action: "stop", plan_signature: signature, compiler_elapsed_ms: compiled.elapsedMs, executor_elapsed_ms: result.elapsedMs })
            return {
              content: "PATCH_STOP reason=receipt_write_failed action=report_blocked",
              metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason: "receipt_write_failed" },
            }
          }
          const completionAuthorization =
            await observeCompletionAuthorization(
              root,
              sessionID,
              state,
              persisted,
              proofAssessment,
              dispatchOrigin,
              actionCommit,
            )

          state.patchAccepted = true
          state.patchReceiptPath = persisted.path
          applyExecutionEvent(state, "patch_ready", "verification_passed")

          // Native CompletionAuthorizer is the only permission to create a
          // TerminalCommit. ABSTAIN/transport failure withholds only the
          // terminal optimization; the verified patch remains PATCH_READY and
          // the ordinary agent loop may continue.
          const completionAuthorized =
            completionAuthorizationPermitsTerminal(
              completionAuthorization,
            )

          const taskProofTerminalAuthorized =
            forcedKind === "additive_surface" &&
            taskProofPasses(
              taskProofAssessment,
            )

          const terminalAuthorized =
            completionAuthorized ||
            taskProofTerminalAuthorized

          const terminalPolicy =
            taskProofTerminalAuthorized
              ? TASK_PROOF_TERMINAL_POLICY
              : COMPLETION_AUTHORIZER_POLICY

          let completionSafeFail = null
          let completionSafeFailClaim = null
          if (!terminalAuthorized) {
            const completionSafeFailResult = deriveCompletionSafeFail({
              state,
              persisted,
              completionAuthorization,
            })
            if (completionSafeFailResult.ok === true) {
              completionSafeFailClaim = claimCompletionSafeFail(
                state,
                completionSafeFailResult.commit,
              )
              if (completionSafeFailClaim.ok === true) {
                completionSafeFail = completionSafeFailResult.commit
                await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
                  ts: nowMs(),
                  protocol: AGENT_PROTOCOL,
                  kind: "completion_safe_fail_commit",
                  completion_safe_fail_protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
                  completion_safe_fail_sha256:
                    completionSafeFail.commit_sha256,
                  completion_safe_fail_reason: completionSafeFail.reason,
                  completion_authorizer_transport_ok:
                    completionAuthorization.transport_ok,
                  completion_authorizer_decision:
                    completionAuthorization.decision,
                  sessionID,
                  turnID: state.turnID,
                  task_turn_id: state.taskTurnID,
                  task_sha256: state.taskTextSha256,
                  action_commit_sha256:
                    completionSafeFail.action_commit_sha256,
                  patch_receipt: completionSafeFail.patch_receipt_path,
                  verification_receipt:
                    completionSafeFail.verification_receipt_path,
                  patch_sha256: completionSafeFail.patch_sha256,
                  project_root: root,
                })
              }
            }
          }

          const terminalCommitResult = terminalAuthorized
            ? deriveTerminalCommit({
                state,
                persisted,
                proofAssessment,
                terminalPolicy,
                taskProofAssessment,
              })
            : {
                ok: false,
                reason:
                  completionAuthorization.applicable !== true
                    ? "completion_authorizer_not_applicable"
                    : completionAuthorization.transport_ok !== true
                      ? "completion_authorizer_unavailable"
                      : completionAuthorization.decision !== "CERTIFY"
                        ? "completion_authorizer_abstain"
                        : "completion_certificate_invalid",
              }
          let terminalCommit = null
          let terminalClaim = null
          if (terminalCommitResult.ok === true) {
            terminalClaim = claimTerminalCommit(
              state,
              terminalCommitResult.commit,
            )
            if (terminalClaim.ok === true) {
              terminalCommit = terminalCommitResult.commit
              await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
                ts: nowMs(),
                protocol: AGENT_PROTOCOL,
                kind: "terminal_commit",
                terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
                terminal_commit_sha256: terminalCommit.commit_sha256,
                completion_authorizer_protocol:
                  COMPLETION_AUTHORIZER_PROTOCOL,
                completion_authorizer_authority:
                  "terminal_permission",
                completion_authorizer_permits_terminal:
                  completionAuthorized,
                completion_certificate_sha256:
                  completionAuthorization.certificate_sha256,
                sessionID,
                turnID: state.turnID,
                task_turn_id: state.taskTurnID,
                task_sha256: state.taskTextSha256,
                project_root: root,
                proof_disposition: "pass",
                patch_receipt: terminalCommit.patch_receipt_path,
                verification_receipt:
                  terminalCommit.verification_receipt_path,
                patch_sha256: terminalCommit.patch_sha256,
              })
            }
          }

          await trace({
            admitted: true,
            reason: null,
            action: "ready",
            plan_signature: signature,
            compiler_elapsed_ms: compiled.elapsedMs,
            compiler_mutations_requested: compilerResponse?.mutations_requested ?? 0,
            compiler_mutations_effective: compilerResponse?.mutations_effective ?? 0,
            compiler_dropped_noops: compilerResponse?.dropped_noops ?? 0,
            compiler_dropped_duplicates: compilerResponse?.dropped_duplicates ?? 0,
            compiler_lowered_edits: compilerResponse?.lowered_edits ?? 0,
            executor_elapsed_ms: result.elapsedMs,
            verifier_elapsed_ms: verified.elapsedMs,
            invariant_verifier_protocol: INVARIANT_VERIFIER_PROTOCOL,
            invariants_total: verificationResponse?.invariants_total ?? 0,
            invariants_passed: verificationResponse?.invariants_passed ?? 0,
            proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL,
            proof_obligations: proofAssessment.obligations.map((item) => item.id),
            proof_disposition: proofAssessment.disposition,
            terminal_commit_protocol:
              terminalCommit?.protocol ?? null,
            terminal_commit_sha256:
              terminalCommit?.commit_sha256 ?? null,
            terminal_commit_reason:
              terminalCommitResult.reason,
            terminal_commit_claim_reason:
              terminalClaim?.reason ?? null,
            completion_safe_fail_protocol:
              completionSafeFail?.protocol ?? null,
            completion_safe_fail_sha256:
              completionSafeFail?.commit_sha256 ?? null,
            completion_safe_fail_claim_reason:
              completionSafeFailClaim?.reason ?? null,
            completion_authorizer_protocol:
              COMPLETION_AUTHORIZER_PROTOCOL,
            completion_authorizer_authority:
              "terminal_permission",
            completion_authorizer_permits_terminal:
              completionAuthorized,
            task_proof_terminal_authorized:
              taskProofTerminalAuthorized,
            terminal_policy:
              terminalPolicy,
            task_proof_protocol:
              taskProofAssessment?.protocol ?? null,
            task_proof_checks_total:
              taskProofAssessment?.checks_total ?? 0,
            task_proof_checks_failed:
              taskProofAssessment?.checks_failed ?? 0,
            task_proof_elapsed_ms:
              taskProofElapsedMs,
            completion_authorizer_applicable:
              completionAuthorization.applicable,
            completion_authorizer_transport_ok:
              completionAuthorization.transport_ok,
            completion_authorizer_decision:
              completionAuthorization.decision,
            completion_authorizer_reason:
              completionAuthorization.reason,
            completion_certificate_sha256:
              completionAuthorization.certificate_sha256,
            completion_authorizer_elapsed_ms:
              completionAuthorization.elapsed_ms,
            verification_receipt: persisted.verificationPath,
            receipt_path: persisted.path,
            patch_path: persisted.receipt.patch_path,
            patch_sha256: persisted.receipt.patch_sha256,
            changed_files: response.changed_files ?? [],
            changed_lines: response.changed_lines ?? 0,
            patch_bytes: response.patch_bytes ?? 0,
            structural_edits: response.structural_edits ?? 0,
            repo_mutated: response.repo_mutated === true,
          })
          return {
            content:
              `PATCH_READY receipt=${persisted.path} changed_files=${(response.changed_files ?? []).length} ` +
              `changed_lines=${response.changed_lines ?? 0} semantic_mutations=${compilerResponse?.mutations_effective ?? 0} ` +
              `lowered_edits=${compilerResponse?.lowered_edits ?? 0} normalized=${(compilerResponse?.dropped_noops ?? 0) + (compilerResponse?.dropped_duplicates ?? 0)} ` +
              `invariants=${verificationResponse?.invariants_passed ?? 0}/${verificationResponse?.invariants_total ?? 0} ` +
              `proofs=${proofAssessment.obligations.length}/${proofAssessment.obligations.length} ` +
              `capsule=${state.editCapsulePath ?? "none"} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} repo_mutated=false`,
            metadata: {
              protocol: EXECUTION_LOOP_PROTOCOL,
              action: "ready",
              receipt_protocol: PATCH_RECEIPT_PROTOCOL,
              receipt_path: persisted.path,
              verification_receipt: persisted.verificationPath,
              verification_protocol: VERIFICATION_RECEIPT_PROTOCOL,
              terminal_commit_protocol:
                terminalCommit?.protocol ?? null,
              terminal_commit_sha256:
                terminalCommit?.commit_sha256 ?? null,
              terminal_commit_reason:
                terminalCommitResult.reason,
              invariant_verifier_protocol: INVARIANT_VERIFIER_PROTOCOL,
              invariants_total: verificationResponse?.invariants_total ?? 0,
              invariants_passed: verificationResponse?.invariants_passed ?? 0,
              proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL,
              proof_obligations: proofAssessment.obligations,
              edit_capsule_protocol: EDIT_CAPSULE_PROTOCOL,
              edit_capsule_path: state.editCapsulePath,
              edit_capsule_sha256: state.editCapsuleHash,
              execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
              execution_state: state.executionState,
              compiler_protocol: PATCH_COMPILER_PROTOCOL,
              mutation_protocol: PATCH_MUTATION_PROTOCOL,
                patch_tool_protocol: PATCH_TOOL_PROTOCOL,
              mutation_dispatch_origin: dispatchOrigin,
              execution_permit_protocol:
                executionPermit?.protocol ??
                EXECUTION_PERMIT_PROTOCOL,
              execution_permit_reason:
                executionPermit?.reason ?? null,
              execution_permit_dispatch_generation:
                executionPermit?.dispatch_generation ??
                null,
              execution_permit_selected_tool:
                executionPermit?.selected_tool ?? null,
              execution_permit_requested_tool:
                executionPermit?.requested_tool ?? null,
              execution_permit_edit_capsule_sha256:
                executionPermit?.edit_capsule_sha256 ??
                null,
              execution_permit_claims:
                executionPermit?.claims ?? null,
              execution_permit_max_claims: 1,
              action_commit_protocol: actionCommit?.protocol ?? null,
              action_commit_sha256: actionCommit?.commit_sha256 ?? null,
              semantic_mutations: compilerResponse?.mutations_effective ?? 0,
              lowered_edits: compilerResponse?.lowered_edits ?? 0,
              changed_files: response.changed_files ?? [],
              changed_lines: response.changed_lines ?? 0,
              patch_bytes: response.patch_bytes ?? 0,
              truncated: false,
            },
          }
        }

        const reason = typeof response?.reason === "string" ? response.reason : "executor_rejected"
        const deterministicCapacityStop =
          deterministicCapacityFailureIsTerminal(
            reason,
            dispatchOrigin,
          )
        const canRetry =
          !deterministicCapacityStop &&
          PATCH_RETRY_REASONS.has(reason) &&
          state.mutationAttempts < MAX_PATCH_ATTEMPTS_PER_TURN
        const needsRescout = PATCH_RESCOUT_REASONS.has(reason)
        const action = needsRescout ? "rescout" : canRetry ? "retry" : "stop"
        if (needsRescout) {
          applyExecutionEvent(state, "patch_rescout", reason, { reason, allowed_files: response?.allowed_files ?? [] })
        } else if (canRetry) {
          applyExecutionEvent(state, "patch_retry", reason)
        } else {
          applyExecutionEvent(state, "fatal", reason)
        }
        await trace({
          admitted: false,
          reason,
          action,
          plan_signature: signature,
          compiler_elapsed_ms: compiled.elapsedMs,
          compiler_lowered_edits: compilerResponse?.lowered_edits ?? 0,
          executor_elapsed_ms: result.elapsedMs,
          executor_diagnostic:
            result.diagnostic ?? null,
          allowed_files: response?.allowed_files ?? [],
          changed_files: response?.changed_files ?? [],
        })

        if (needsRescout) {
          return {
            content: `PATCH_RESCOUT reason=${reason} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=refine_search`,
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "rescout", reason, allowed_files: response?.allowed_files ?? [] },
          }
        }
        if (canRetry) {
          return {
            content: `PATCH_RETRY reason=${reason} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=revise_semantic_plan`,
            metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "retry", reason },
          }
        }
        return {
          content: `PATCH_STOP reason=${reason} attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} action=report_blocked`,
          metadata: { protocol: EXECUTION_LOOP_PROTOCOL, action: "stop", reason },
        }
    }

    // E2.3-A: one Scout implementation, two entry paths.
    const deterministicSearchExecutor = async (input, toolContext) => {
          const started = performance.now()
          const sessionID =
            typeof toolContext?.sessionID === "string" && toolContext.sessionID.length > 0
              ? toolContext.sessionID
              : null

          const state = getSessionState(sessionID)
          const root = await rootForTool(ctx, toolContext, sessionID, state)
          const observedModelLatencyMs =
            observeModelLatencyAtToolBoundary(state)

          if (!root) {
            return {
              content: "SEARCH_ERROR: cannot resolve active project root for this session.",
            }
          }

          if (state && !state.turnID) {
            resetTurnState(state, `implicit:${sessionID}:${nowMs()}`, nowMs())
          }

          if (state && !toolAllowedForExecutionState(state, "search")) {
            return {
              content: `SEARCH_BLOCKED reason=causal_frontier state=${state.executionState} action=${nextActionForExecutionState(state)}`,
              metadata: {
                protocol: SEARCH_PROTOCOL,
                blocked: true,
                reason: "causal_frontier",
                execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
                execution_state: state.executionState,
                next_action: nextActionForExecutionState(state),
              },
            }
          }

          let attemptIndex = null
          let taskSearchPlan = null
          if (state) {
            state.searchAttempts += 1
            state.lastSeen = nowMs()
            attemptIndex = state.searchAttempts
          }

          const blockSearch = async (reason, extra = {}) => {
            await writeProjectTrace(root, "search-trace.jsonl", {
              ts: nowMs(),
              protocol: SEARCH_PROTOCOL,
              sessionID,
              turnID: state?.turnID ?? null,
              project_root: root,
              blocked: true,
              reason,
              attempt_index: attemptIndex,
              turn_model_calls: state?.modelCalls ?? null,
              turn_search_attempts: state?.searchAttempts ?? null,
              turn_executed_searches: state?.executedSearches ?? null,
              turn_evidence_bytes: state?.evidenceBytes ?? null,
              task_search_plan_protocol:
                taskSearchPlan?.protocol ?? TASK_SEARCH_PLAN_PROTOCOL,
              task_search_plan_applied: taskSearchPlan?.applied ?? false,
              task_search_plan_reason: taskSearchPlan?.reason ?? "not_compiled",
              task_search_requested_queries:
                taskSearchPlan?.requested_queries ?? null,
              task_search_effective_queries:
                taskSearchPlan?.effective_queries ?? null,
              task_search_requested_path:
                taskSearchPlan?.requested_path ?? null,
              task_search_effective_path:
                taskSearchPlan?.effective_path ?? null,
              task_search_requested_glob:
                taskSearchPlan?.requested_glob ?? null,
              task_search_effective_glob:
                taskSearchPlan?.effective_glob ?? null,
              ...extra,
            })

            return {
              content: `SEARCH_BLOCKED reason=${reason} action=use_prior_or_refine`,
              metadata: { protocol: SEARCH_PROTOCOL, blocked: true, reason },
            }
          }

          if (state && state.searchAttempts > MAX_SEARCH_ATTEMPTS_PER_TURN) {
            return await blockSearch("attempt_budget", {
              limit: MAX_SEARCH_ATTEMPTS_PER_TURN,
            })
          }

          let queries = input?.queries
          if (
            !Array.isArray(queries) ||
            queries.length < 1 ||
            queries.length > MAX_QUERIES ||
            queries.some(
              (query) =>
                typeof query !== "string" || query.length < 1 || query.length > 200,
            )
          ) {
            return {
              content: "SEARCH_ERROR: queries must contain 1..4 strings of 1..200 characters.",
            }
          }

          const requestedQueries = [...new Set(queries)]
          const requestedPath =
            typeof input?.path === "string" && input.path.length > 0
              ? input.path
              : "."
          const modelRequestedGlob =
            typeof input?.glob === "string" && input.glob.length > 0
              ? input.glob
              : undefined

          taskSearchPlan = compileTaskSearchPlanForState(
            state,
            requestedQueries,
            requestedPath,
            modelRequestedGlob,
            buildLanguageGlob("**/*", SOURCE_LANGUAGE_EXTENSIONS),
          )
          queries = taskSearchPlan.effective_queries

          await writeProjectTrace(root, "search-trace.jsonl", {
            ts: nowMs(),
            protocol: SEARCH_PROTOCOL,
            kind: "task_search_plan",
            sessionID,
            turnID: state?.turnID ?? null,
            project_root: root,
            task_action_protocol: state?.taskAction?.protocol ?? null,
            task_action_status: state?.taskAction?.status ?? null,
            task_action_operation: state?.taskAction?.operation ?? null,
            task_action_old_name: state?.taskAction?.old_name ?? null,
            task_action_new_name: state?.taskAction?.new_name ?? null,
            task_requirements_protocol:
              state?.taskRequirements?.protocol ??
              TASK_REQUIREMENTS_PROTOCOL,
            task_requirements_status:
              state?.taskRequirements?.status ?? null,
            task_required_roles:
              state?.taskRequirements?.required_roles ?? [],
            task_required_source_families:
              state?.taskRequirements?.required_source_families ?? [],
            task_constraints:
              state?.taskRequirements?.constraints ?? [],
            task_search_plan_protocol: taskSearchPlan.protocol,
            task_search_plan_applied: taskSearchPlan.applied,
            task_search_plan_reason: taskSearchPlan.reason,
            task_search_requested_queries: taskSearchPlan.requested_queries,
            task_search_effective_queries: taskSearchPlan.effective_queries,
            task_search_requested_path: taskSearchPlan.requested_path,
            task_search_effective_path: taskSearchPlan.effective_path,
            task_search_requested_glob: taskSearchPlan.requested_glob,
            task_search_effective_glob: taskSearchPlan.effective_glob,
          })

          let target
          try {
            target = await safeTarget(root, taskSearchPlan.effective_path)
          } catch (error) {
            return { content: "SEARCH_ERROR: " + String(error?.message ?? error) }
          }

          const requestedGlob = taskSearchPlan.effective_glob ?? undefined

          const globResolution =
            await resolveTaskSourceFamilyGlob(
              root,
              target,
              requestedGlob,
              state,
            )

          await writeProjectTrace(
            root,
            "search-trace.jsonl",
            {
              ts: nowMs(),
              protocol: SEARCH_PROTOCOL,
              kind: "source_family_plan",
              sessionID,
              turnID: state?.turnID ?? null,
              project_root: root,

              repo_capability_protocol:
                globResolution.repoCapability?.protocol ??
                REPO_CAPABILITY_PROTOCOL,
              repo_capability_inventory_complete:
                globResolution.repoCapability?.inventory_complete ??
                false,
              repo_capability_absence_claims_allowed:
                globResolution.repoCapability
                  ?.absence_claims_allowed ?? false,

              source_family_plan_protocol:
                globResolution.sourceFamilyPlan?.protocol ??
                SOURCE_FAMILY_PLAN_PROTOCOL,
              source_family_plan_applied:
                globResolution.sourceFamilyPlan?.applied === true,
              source_family_plan_reason:
                globResolution.sourceFamilyPlan?.reason ?? null,

              source_family_required_roles:
                globResolution.sourceFamilyPlan?.required_roles ?? [],
              source_family_initially_covered_roles:
                globResolution.sourceFamilyPlan
                  ?.initially_covered_roles ?? [],
              source_family_resolved_roles:
                globResolution.sourceFamilyPlan?.resolved_roles ?? [],
              source_family_unresolved_roles:
                globResolution.sourceFamilyPlan?.unresolved_roles ?? [],
              source_family_selected_families:
                globResolution.sourceFamilyPlan
                  ?.selected_families ?? [],
              source_family_added_extensions:
                globResolution.sourceFamilyPlan
                  ?.added_extensions ?? [],

              requested_glob: requestedGlob ?? null,
              effective_glob:
                globResolution.effectiveGlob ?? null,
              glob_role_broadened:
                globResolution.roleBroadened === true,
            },
          )

          const glob = globResolution.effectiveGlob
          const signature = searchSignature(queries, target, glob)

          if (state && state.signatures.has(signature)) {
            return await blockSearch("duplicate_search", {
              queries,
              path: target,
              glob: glob ?? null,
              requested_glob: requestedGlob ?? null,
              effective_glob: glob ?? null,
              glob_correction_reason: globResolution.reason,
            })
          }

          const remainingEvidenceBytes = state
            ? Math.max(0, MAX_TURN_EVIDENCE_BYTES - state.evidenceBytes)
            : MAX_OUTPUT_BYTES

          if (state && remainingEvidenceBytes <= 0) {
            return await blockSearch("evidence_budget", {
              limit_bytes: MAX_TURN_EVIDENCE_BYTES,
            })
          }

          // Every new search now starts with a file-level lexical discovery
          // pass. This is deliberate: routing must not depend on a possibly
          // truncated stream of line hits from one noisy file.
          if (
            state &&
            state.executedSearches >= MAX_EXECUTED_SEARCHES_PER_TURN
          ) {
            return await blockSearch("executed_search_budget", {
              limit: MAX_EXECUTED_SEARCHES_PER_TURN,
              queries,
              path: target,
              glob: glob ?? null,
              requested_glob: requestedGlob ?? null,
              effective_glob: glob ?? null,
              glob_correction_reason: globResolution.reason,
            })
          }

          if (state) {
            state.signatures.add(signature)
            state.executedSearches += 1
          }

          const discoveryStarted = performance.now()
          const discoveryResults = await Promise.all(
            queries.map((query, index) =>
              runCompiledDiscovery(
                root,
                query,
                index,
                target,
                glob,
              ),
            ),
          )
          const discoveryElapsedMs =
            Math.round((performance.now() - discoveryStarted) * 100) / 100

          const discoveryComplete = discoveryResults.every(
            (result) => result.scanComplete,
          )
          const lexicalRankedFiles =
            rankDiscoveredFiles(discoveryResults)

          const retrievalRanking =
            await runRetrievalRanker(
              root,
              queries,
              lexicalRankedFiles,
            )

          const rankedFiles =
            retrievalRanking.rankedFiles

          const probeFiles =
            selectProbeFiles(
              rankedFiles,
              discoveryResults,
            )
          const probeFileSet = new Set(probeFiles.map((entry) => entry.file))
          const allDiscoveredFilesProbed =
            rankedFiles.length === probeFileSet.size

          const queryPlan = queries.map((query, index) => {
            const discoveryResult = discoveryResults.find(
              (result) => result.queryIndex === index,
            )

            const effectiveQuery =
              discoveryResult?.effectiveQuery ?? query
            const matchMode =
              discoveryResult?.matchMode ?? "exact"
            const cacheQuery =
              discoveryResult?.cacheQuery ?? effectiveQuery

            const targets = probeFiles
              .filter((entry) => entry.queries.has(index))
              .map((entry) => entry.file)
              .sort()

            const cacheKey = queryCacheKey(
              root,
              cacheQuery,
              target,
              glob,
              targets,
            )

            const cached =
              state?.queryCache?.get(cacheKey) ?? null

            const compiledProbe =
              discoveryResult?.compiledProbe
                ? restrictProbeResultToTargets(
                    discoveryResult.compiledProbe,
                    targets,
                  )
                : null

            return {
              query,
              effectiveQuery,
              matchMode,
              index,
              targets,
              cacheKey,
              cached,
              compiledProbe,
            }
          })

          const freshPlan = queryPlan.filter(
            (item) => !item.cached && !item.compiledProbe,
          )

          const reusedQueryCount = queryPlan.filter(
            (item) => Boolean(item.cached),
          ).length

          const compiledQueryCount = queryPlan.filter(
            (item) => Boolean(item.compiledProbe),
          ).length

          const executedQueryCount =
            freshPlan.filter(
              (item) => item.targets.length > 0,
            ).length +
            compiledQueryCount

          const refineStarted = performance.now()

          const freshResults = await Promise.all(
            freshPlan.map(async (item) => {
              const raw = await runQuery(
                root,
                item.effectiveQuery,
                item.index,
                item.targets,
                glob,
              )

              return queryCompilerProbeResult(
                raw,
                item.query,
                item.matchMode,
              )
            }),
          )

          const refineElapsedMs =
            Math.round((performance.now() - refineStarted) * 100) / 100

          const freshByIndex = new Map(
            freshResults.map((result) => [result.queryIndex, result]),
          )

          if (state) {
            for (const item of queryPlan) {
              if (item.cached) continue

              const result =
                item.compiledProbe ??
                freshByIndex.get(item.index)

              if (result) {
                rememberQueryResult(
                  state,
                  item.cacheKey,
                  result,
                )
              }
            }
          }

          const probeResults = queryPlan
            .map((item) => {
              if (item.cached) {
                return reindexQueryResult(
                  item.cached,
                  item.index,
                  true,
                )
              }

              if (item.compiledProbe) {
                return reindexQueryResult(
                  item.compiledProbe,
                  item.index,
                  false,
                )
              }

              const result = freshByIndex.get(item.index)

              return result
                ? reindexQueryResult(
                    result,
                    item.index,
                    false,
                  )
                : null
            })
            .filter(Boolean)
            .sort((a, b) => a.queryIndex - b.queryIndex)

          const probeRankedFiles = rankProbedFiles(
            rankedFiles,
            probeResults,
          )
          const structuralReservationCandidate =
            bestStructuralProbeCandidate(probeRankedFiles)

          const impactValidation = await validateImpactHypotheses(
            root,
            target,
            glob,
            probeFiles,
            probeResults,
          )
          const impactIndexShadow = impactValidation.indexStats
          const semanticImpactShadow =
            await runSemanticImpactShadow(
              root,
              impactValidation.validated,
            )

          // v2.24 shadow only: existing source-validated Impact routing remains
          // authoritative until real-repo semantic telemetry proves zero false
          // confirmations.
          const selectedFiles = selectEmitFilesWithImpact(
            probeRankedFiles,
            discoveryResults,
            impactValidation.validated,
          )
          const selectedFileSet = new Set(
            selectedFiles.map((entry) => evidenceFileKey(entry.file)),
          )
          const selectedLexicalFiles = selectedFiles.filter(
            (entry) => entry?.origin !== "impact",
          )
          const selectedLexicalFileSet = new Set(
            selectedLexicalFiles.map((entry) => evidenceFileKey(entry.file)),
          )
          const selectedImpactFiles = selectedFiles.filter(
            (entry) => entry?.origin === "impact",
          )
          const allDiscoveredFilesSelected =
            rankedFiles.length === selectedLexicalFileSet.size
          const routingActive =
            !discoveryComplete || !allDiscoveredFilesSelected || selectedImpactFiles.length > 0
          const results = filterQueryResultsToFiles(probeResults, selectedLexicalFiles)

          const probeHits = mergeHits(probeResults)
          const hits = mergeHits(results)
          const exactSpanHits = [...hits.values()].reduce(
            (total, hit) => total + (Array.isArray(hit.exactSpans) ? hit.exactSpans.length : 0),
            0,
          )
          const probedExactSpanHits = [...probeHits.values()].reduce(
            (total, hit) =>
              total + (Array.isArray(hit.exactSpans) ? hit.exactSpans.length : 0),
            0,
          )
          const selectedScanComplete = probeResults.every(
            (result) => result.scanComplete,
          )
          const scanComplete =
            discoveryComplete &&
            allDiscoveredFilesProbed &&
            selectedScanComplete
          const querySummary = [
            ...discoverySummaryFor(discoveryResults),
            ...querySummaryFor(probeResults),
          ]
          const callBudgetBytes = Math.min(MAX_OUTPUT_BYTES, remainingEvidenceBytes)
          const provisionalRoute = routingActive
            ? renderRouteMap(
                rankedFiles,
                selectedFiles,
                ROUTE_BODY_BUDGET_BYTES,
              )
            : { body: [], bodyBytes: 0, retained: 0 }

          const reserveHeader = rawHeaderReserveLines({
            scanComplete,
            discoveryComplete,
            selectedScanComplete,
            candidateFiles: rankedFiles.length,
            selectedFiles: selectedFileSet.size,
            uniqueHits: hits.size,
            querySummary,
          })

          const headerReserve = bytes([
            ...reserveHeader,
            ...(provisionalRoute.body.length > 0
              ? ["", ...provisionalRoute.body]
              : []),
            "",
          ].join("\n"))

          if (callBudgetBytes <= headerReserve) {
            return await blockSearch("evidence_budget", {
              limit_bytes: MAX_TURN_EVIDENCE_BYTES,
              remaining_bytes: remainingEvidenceBytes,
              required_header_bytes: headerReserve,
            })
          }

          const bodyBudget = Math.min(
            BODY_BUDGET_BYTES,
            Math.max(0, callBudgetBytes - headerReserve),
          )

          const routeRendered = routingActive
            ? renderRouteMap(rankedFiles, selectedFiles, provisionalRoute.bodyBytes)
            : { body: [], bodyBytes: 0, retained: 0 }

          const rawRendered = await renderEvidence(root, hits, bodyBudget)
          const selectedEvidenceComplete = rawRendered.shown.size === hits.size
          const rawEvidenceComplete =
            scanComplete && allDiscoveredFilesSelected && selectedEvidenceComplete
          const rawComplete = scanComplete && rawEvidenceComplete
          const rawReasons = []

          if (!discoveryComplete) rawReasons.push("lexical_discovery_incomplete")
          else if (!allDiscoveredFilesProbed) rawReasons.push("probe_subset")
          else if (!selectedScanComplete) rawReasons.push("scan_incomplete")
          else if (!allDiscoveredFilesSelected) rawReasons.push("budgeted_emit_subset")
          if (!selectedEvidenceComplete) rawReasons.push("output_budget")

          const rawHeader = [
            ...(globResolution.corrected
              ? [
                  `GLOB_CORRECTED requested=${JSON.stringify(requestedGlob)} effective=${JSON.stringify(glob ?? null)} reason=${globResolution.reason}`,
                ]
              : []),
            `SEARCH complete=${rawComplete} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${rawEvidenceComplete} selected_evidence_complete=${selectedEvidenceComplete} candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} shown_hits=${rawRendered.shown.size}`,
            ...querySummary,
          ]

          if (rawReasons.length) {
            rawHeader.push(`INCOMPLETE reasons=${rawReasons.join(",")}`)
          }

          const rawContent = [
            ...rawHeader,
            ...(routeRendered.body.length > 0 ? ["", ...routeRendered.body] : []),
            "",
            ...rawRendered.body,
          ].join("\n")
          const rawResultBytes = bytes(rawContent)

          if (rawResultBytes > callBudgetBytes) {
            return await blockSearch("internal_budget_guard", {
              stage: "raw_pack",
              result_bytes: rawResultBytes,
              call_budget_bytes: callBudgetBytes,
              reserved_header_bytes: headerReserve,
              rendered_body_bytes: rawRendered.bodyBytes,
              route_body_bytes: routeRendered.bodyBytes,
              overflow_bytes: rawResultBytes - callBudgetBytes,
            })
          }

          const pressure = evidencePressure(
            hits,
            rawRendered,
            selectedEvidenceComplete,
          )
          const distillInput = distillerHitsFromMerged(hits)
          const ownerRecoveryInput = ownerRecoveryHitsFromMerged(hits)
          const spansComplete = spanCaptureComplete(results)

          let representation = "raw"
          let content = rawContent
          let resultBytes = rawResultBytes
          let bodyBytes = rawRendered.bodyBytes
          let shownHits = rawRendered.shown.size
          let evidenceComplete = rawEvidenceComplete
          let complete = rawComplete

          let distillAttempted = false
          let distillReason = "not_needed"
          let distillElapsedMs = null
          let distillerElapsedMs = null
          let distillIrComplete = null
          let distillWitnessComplete = null
