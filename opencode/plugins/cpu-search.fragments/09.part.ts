              retrieval_ranker_elapsed_ms:
                retrievalRanking.elapsedMs,
              retrieval_ranker_input_files:
                retrievalRanking.inputFiles,
              retrieval_ranker_output_files:
                retrievalRanking.outputFiles,
              retrieval_ranker_degraded_files:
                retrievalRanking.degradedFiles,
              retrieval_ranker_error_files:
                retrievalRanking.errorFiles,

              refine_elapsed_ms: refineElapsedMs,
              probe_elapsed_ms: refineElapsedMs,
            impact_index_ok: impactIndexShadow.ok,
            impact_index_reason: impactIndexShadow.reason,
            impact_index_lexical_misses: impactIndexShadow.lexicalMisses,
            impact_index_neighbors_shown: impactIndexShadow.neighborsShown,
            impact_index_cache_age_ms: impactIndexShadow.cacheAgeMs,
            impact_validation_reason: impactValidation.reason,
            impact_validated: impactValidation.validated.length,
            semantic_impact_attempted:
              semanticImpactShadow.attempted,
            semantic_impact_ok:
              semanticImpactShadow.ok,
            semantic_impact_reason:
              semanticImpactShadow.reason,
            semantic_impact_confirmed:
              semanticImpactShadow.confirmed,
            semantic_impact_contradicted:
              semanticImpactShadow.contradicted,
            semantic_impact_ambiguous:
              semanticImpactShadow.ambiguous,
            semantic_impact_unresolved:
              semanticImpactShadow.unresolved,
            semantic_impact_unavailable:
              semanticImpactShadow.unavailable,
            semantic_impact_elapsed_ms:
              semanticImpactShadow.elapsedMs,
            impact_scope_owner_symbols: impactValidation.ownerSymbols,
            impact_pairwise_conditioned: impactValidation.pairwiseConditioned === true,
            impact_scope_relations_rejected: impactValidation.scopeRejected,
            impact_index_coverage_complete: impactIndexShadow.refreshComplete,
            impact_emitted_files: selectedImpactFiles.length,
            impact_index_routing_active: selectedImpactFiles.length > 0,
              lexical_probed_files: probeFileSet.size,
              impact_probed_files: impactValidation.queryCount,
              probed_files: probeFileSet.size + impactValidation.queryCount,
              lexical_emitted_files: selectedLexicalFileSet.size,
              emitted_files: selectedFileSet.size,
              probe_files: probeFiles.map((entry) => entry.file),
              selected_files: selectedFiles.map((entry) => entry.file),
              retained_unread_files: Math.max(0, rankedFiles.length - probeFileSet.size),
              retained_unemitted_files: routeRendered.retained,
              probed_unemitted_files: Math.max(0, probeFileSet.size - selectedLexicalFileSet.size),
              reused_query_count: reusedQueryCount,
              executed_query_count: executedQueryCount,
              refinement_required: refinementRequired,
              index_reason: indexReason,
              focused_reason: focusedReason,
              region_reason: regionReason,
              evidence_complete: evidenceComplete,
              complete,
              ledger_new_facts: novelty.novel.size,
              ledger_prior_facts: novelty.prior,
              route_ledger_new_facts: routeNovelty.novel.size,
              meaningful_route_progress: meaningfulRouteProgress,
              no_progress: noProgress,
              no_progress_streak: state?.consecutiveNoProgress ?? null,
              no_progress_blocked: noProgressBlocked,
              distill_attempted: distillAttempted,
              distill_reason: distillReason,
              elapsed_ms: elapsedMs,
            },
          }
        },
      })
    }))

    await track(ctx.tool.transform((tools) => {
      tools.add({
        name: EXECUTE_REPLACE_NODE_TOOL,
        description:
          "Submit exactly ONE bounded replace_node semantic mutation. " +
          "The target file, symbol, mutation kind, and authority scope are capability-derived and MUST NOT be supplied. " +
          "before is a canonical exact source slice, never a pattern; only outer whitespace and line endings are normalized deterministically. " +
          "Copy the smallest complete structural slice from the sealed preauthorized CAPSULE_SCOPE; replacement replaces exactly that slice. No fuzzy matching or authority expansion is permitted.",
        input: {
          type: "object",
          properties: {
            before: {
              type: "string",
              minLength: 1,
              maxLength: 4096,
              description: "Canonical exact structural source slice copied from a sealed preauthorized CAPSULE_SCOPE.",
            },
            replacement: {
              type: "string",
              maxLength: 4096,
              description: "Replacement for exactly before; empty string is an intentional exact deletion.",
            },
          },
          required: ["before", "replacement"],
          additionalProperties: false,
        },
        options: {
          codemode: false,
          permission: PATCH_PERMISSION_ACTION,
        },
        execute: async (input, toolContext) =>
          executeCapabilityMutationCore(
            input,
            toolContext,
            "replace_node",
            EXECUTE_REPLACE_NODE_TOOL,
          ),
      })

      tools.add({
        name: EXECUTE_RENAME_SYMBOL_TOOL,
        description:
          "Submit exactly ONE globally-authorized rename_symbol semantic mutation. " +
          "The target file, symbol, mutation kind, and handoff scope are capability-derived and MUST NOT be supplied. " +
          "This tool is exposed only when Scout has a complete global handoff and rename capability.",
        input: {
          type: "object",
          properties: {
            new_name: {
              type: "string",
              minLength: 1,
              maxLength: 256,
            },
          },
          required: ["new_name"],
          additionalProperties: false,
        },
        options: {
          codemode: false,
          permission: PATCH_PERMISSION_ACTION,
        },
        execute: async (input, toolContext) =>
          executeCapabilityMutationCore(
            input,
            toolContext,
            "rename_symbol",
            EXECUTE_RENAME_SYMBOL_TOOL,
          ),
      })
    }))

    await track(ctx.session.hook("context", async (event) => {
      if (!event?.tools || typeof event.tools !== "object") {
        throw new Error("CPU_AGENT tool_surface_missing")
      }

      // Stable model-facing surface. This filter is deliberately idempotent:
      // search and both action-specific mutation tools are never removed from
      // the materialized base surface, so a reused mutable event.tools object
      // cannot lose the next state's schema before the capability frontier is
      // applied below.
      const stableToolSurface = new Set(["search", ...MUTATION_TOOL_NAMES])
      for (const name of Object.keys(event.tools)) {
        if (!stableToolSurface.has(name)) {
          delete event.tools[name]
        }
      }

      if (event.agent === "compaction") return

      const sessionID =
        typeof event.sessionID === "string" && event.sessionID.length > 0
          ? event.sessionID
          : null

      const state = getSessionState(sessionID)
      if (!state) return

      const root = await rootFromSession(ctx, sessionID, state)

      // Derive turn identity and routing semantics from one synchronous,
      // versioned snapshot. Async public events remain telemetry only.
      const taskContextSnapshot = userTurnSnapshotFromContext(event)
      const contextTurnID = taskContextSnapshot.turnID

      // Completion safe-fail gate. Once an exact task has a verified candidate
      // but CompletionAuthorizer cannot issue terminal permission, do not pay
      // for more model turns. This is not VERIFIED authority: it is a bounded
      // safe failure that preserves the candidate and proof artifacts.
      if (state.completionSafeFail) {
        const safeFailTaskMatch = completionSafeFailMatchesTask(
          state.completionSafeFail,
          taskContextSnapshot,
        )

        if (safeFailTaskMatch.reason === "completion_safe_fail_task_turn_changed") {
          clearCompletionSafeFailState(state)
        } else if (safeFailTaskMatch.ok !== true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: safeFailTaskMatch.reason,
            completion_safe_fail_protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
            completion_safe_fail_sha256: state.completionSafeFailSha256,
            sessionID,
            turnID: state.turnID,
            task_turn_id: taskContextSnapshot.turnID,
            task_text_sha256: taskContextSnapshot.textSha256,
            project_root: root,
          })
          throw new Error(`CPU_AGENT ${safeFailTaskMatch.reason}`)
        } else if (
          state.completionSafeFailShortCircuitAttemptedSha256 !==
          state.completionSafeFailSha256
        ) {
          state.completionSafeFailShortCircuitAttemptedSha256 =
            state.completionSafeFailSha256
          state.completionSafeFailShortCircuitRequests += 1

          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "completion_safe_fail_requested",
            completion_safe_fail_protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
            completion_safe_fail_sha256: state.completionSafeFailSha256,
            completion_safe_fail_reason: state.completionSafeFail.reason,
            sessionID,
            turnID: state.turnID,
            task_turn_id: taskContextSnapshot.turnID,
            project_root: root,
            completion_safe_fail_short_circuit_requests:
              state.completionSafeFailShortCircuitRequests,
          })

          const interrupt =
            typeof ctx.session?.interrupt === "function"
              ? ctx.session.interrupt.bind(ctx.session)
              : null

          if (!interrupt) {
            state.completionSafeFailShortCircuitFailures += 1
            await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "completion_safe_fail_failed",
              reason: "session_interrupt_unavailable",
              completion_safe_fail_protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
              completion_safe_fail_sha256: state.completionSafeFailSha256,
              sessionID,
              turnID: state.turnID,
              project_root: root,
            })
            throw new Error("CPU_AGENT completion_safe_fail_interrupt_unavailable")
          }

          try {
            await interrupt({ sessionID, continue: false })
            state.completionSafeFailShortCircuits += 1
            await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "completion_safe_fail",
              completion_safe_fail_protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
              completion_safe_fail_sha256: state.completionSafeFailSha256,
              completion_safe_fail_reason: state.completionSafeFail.reason,
              sessionID,
              turnID: state.turnID,
              task_turn_id: taskContextSnapshot.turnID,
              project_root: root,
              completion_safe_fail_short_circuits:
                state.completionSafeFailShortCircuits,
            })
            return
          } catch (error) {
            state.completionSafeFailShortCircuitFailures += 1
            await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "completion_safe_fail_failed",
              reason: "session_interrupt_failed",
              error: String(error?.message ?? error),
              completion_safe_fail_protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
              completion_safe_fail_sha256: state.completionSafeFailSha256,
              sessionID,
              turnID: state.turnID,
              project_root: root,
            })
            throw new Error("CPU_AGENT completion_safe_fail_interrupt_failed")
          }
        } else if (state.completionSafeFailShortCircuits > 0) {
          return
        }
      }

      // v2.27-C terminal gate. A TerminalCommit is not new VERIFIED
      // authority: it only binds the already-persisted verifier proof to this
      // exact user turn and suppresses a redundant provider continuation.
      if (state.terminalCommit) {
        const terminalTaskMatch = terminalCommitMatchesTask(
          state.terminalCommit,
          taskContextSnapshot,
        )

        if (terminalTaskMatch.reason === "terminal_task_turn_changed") {
          clearTerminalCommitState(state)
        } else if (terminalTaskMatch.ok !== true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: terminalTaskMatch.reason,
            terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
            terminal_commit_sha256: state.terminalCommitSha256,
            sessionID,
            turnID: state.turnID,
            task_turn_id: taskContextSnapshot.turnID,
            task_text_sha256: taskContextSnapshot.textSha256,
            project_root: root,
          })
          throw new Error(
            `CPU_AGENT ${terminalTaskMatch.reason}`,
          )
        } else {
          const terminalArtifacts =
            await validateTerminalCommitArtifacts(
              root,
              state.terminalCommit,
            )

          if (terminalArtifacts.ok !== true) {
            applyExecutionEvent(
              state,
              "fatal",
              terminalArtifacts.reason,
            )
            await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "model_blocked",
              reason: terminalArtifacts.reason,
              terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
              terminal_commit_sha256: state.terminalCommitSha256,
              sessionID,
              turnID: state.turnID,
              task_turn_id: taskContextSnapshot.turnID,
              task_text_sha256: taskContextSnapshot.textSha256,
              project_root: root,
            })
            throw new Error(
              `CPU_AGENT ${terminalArtifacts.reason}`,
            )
          }

          if (
            TERMINAL_SHORT_CIRCUIT_ENABLED &&
            state.terminalShortCircuits > 0
          ) {
            await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "terminal_short_circuit_replay",
              terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
              terminal_commit_sha256: state.terminalCommitSha256,
              sessionID,
              turnID: state.turnID,
              task_turn_id: taskContextSnapshot.turnID,
              project_root: root,
            })
            return
          }

          if (
            TERMINAL_SHORT_CIRCUIT_ENABLED &&
            state.terminalShortCircuitAttemptedSha256 !==
              state.terminalCommitSha256
          ) {
            state.terminalShortCircuitAttemptedSha256 =
              state.terminalCommitSha256
            state.terminalShortCircuitRequests += 1

            await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "terminal_short_circuit_requested",
              terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
              terminal_commit_sha256: state.terminalCommitSha256,
              sessionID,
              turnID: state.turnID,
              task_turn_id: taskContextSnapshot.turnID,
              task_text_sha256: taskContextSnapshot.textSha256,
              project_root: root,
              terminal_short_circuit_requests:
                state.terminalShortCircuitRequests,
            })

            const interrupt =
              typeof ctx.session?.interrupt === "function"
                ? ctx.session.interrupt.bind(ctx.session)
                : null

            if (!interrupt) {
              state.terminalShortCircuitFailures += 1
              await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
                ts: nowMs(),
                protocol: AGENT_PROTOCOL,
                kind: "terminal_short_circuit_failed",
                reason: "session_interrupt_unavailable",
                terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
                terminal_commit_sha256: state.terminalCommitSha256,
                sessionID,
                turnID: state.turnID,
                project_root: root,
                terminal_short_circuit_failures:
                  state.terminalShortCircuitFailures,
              })
            } else {
              try {
                await interrupt({
                  sessionID,
                  continue: false,
                })
                state.terminalShortCircuits += 1
                await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
                  ts: nowMs(),
                  protocol: AGENT_PROTOCOL,
                  kind: "terminal_short_circuit",
                  terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
                  terminal_commit_sha256: state.terminalCommitSha256,
                  sessionID,
                  turnID: state.turnID,
                  task_turn_id: taskContextSnapshot.turnID,
                  project_root: root,
                  terminal_short_circuits:
                    state.terminalShortCircuits,
                })
                return
              } catch (error) {
                state.terminalShortCircuitFailures += 1
                await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
                  ts: nowMs(),
                  protocol: AGENT_PROTOCOL,
                  kind: "terminal_short_circuit_failed",
                  reason: "session_interrupt_failed",
                  error: String(error?.message ?? error),
                  terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
                  terminal_commit_sha256: state.terminalCommitSha256,
                  sessionID,
                  turnID: state.turnID,
                  project_root: root,
                  terminal_short_circuit_failures:
                    state.terminalShortCircuitFailures,
                })
              }
            }
          }
        }
      }

      if (contextTurnID && state.turnID !== contextTurnID) {
        resetTurnState(state, contextTurnID, nowMs())
      } else if (!state.turnID) {
        resetTurnState(state, `implicit:${sessionID}:${nowMs()}`, nowMs())
      }

      latchTaskContextForTurn(state, taskContextSnapshot)

      const materializedToolNames = Object.keys(event.tools).sort()
      const requiredSurface = ["search", ...MUTATION_TOOL_NAMES]
      const missingSurface = requiredSurface.filter(
        (name) => !Object.prototype.hasOwnProperty.call(event.tools, name),
      )

      if (missingSurface.length > 0) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: "permission_materialized_tool_missing",
          sessionID,
          turnID: state.turnID,
          project_root: root,
          tool_frontier_protocol: TOOL_FRONTIER_PROTOCOL,
          execution_state: state.executionState,
          missing_tools: missingSurface,
          materialized_tools: materializedToolNames,
        })

        throw new Error(
          `CPU_AGENT permission_materialized_tool_missing state=${state.executionState} ` +
          `missing=${missingSurface.join(",")}`,
        )
      }

      const allowedTools = allowedToolsForState(state)
      const allowedSet = new Set(allowedTools)
      for (const name of Object.keys(event.tools)) {
        if (!allowedSet.has(name)) delete event.tools[name]
      }
      const frontierToolNames = Object.keys(event.tools).sort()
      const frontierToolSchema = Object.fromEntries(
        frontierToolNames.map((name) => [name, event.tools[name]]),
      )
      const frontierToolSchemaSha256 = createHash("sha256")
        .update(JSON.stringify(frontierToolSchema))
        .digest("hex")
      state.visibleToolSchemaSha256 = frontierToolSchemaSha256

      const elapsed = Math.max(0, nowMs() - state.turnStartedAt)

      if (elapsed >= MAX_TURN_WALL_MS) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: "turn_wall_budget",
          sessionID,
          turnID: state.turnID,
          project_root: root,
          elapsed_ms: elapsed,
          limit_ms: MAX_TURN_WALL_MS,
          model_calls: state.modelCalls,
        })

        throw new Error(
          `CPU_GOVERNOR turn_wall_budget elapsed_ms=${elapsed} limit_ms=${MAX_TURN_WALL_MS}`,
        )
      }

      if (state.modelCalls >= MAX_MODEL_CALLS_PER_TURN) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: "model_call_budget",
          sessionID,
          turnID: state.turnID,
          project_root: root,
          model_calls: state.modelCalls,
          limit: MAX_MODEL_CALLS_PER_TURN,
        })

        throw new Error(
          `CPU_GOVERNOR model_call_budget calls=${state.modelCalls} limit=${MAX_MODEL_CALLS_PER_TURN}`,
        )
      }

      state.modelCalls += 1
      state.lastSeen = nowMs()

      let contextBytes = null
      let systemBytes = null
      let messagesBytes = null
      let toolsBytes = null
      let messageBreakdown = []

      try {
        contextBytes = bytes(JSON.stringify({
          system: event.system,
          messages: event.messages,
          tools: event.tools,
        }))

        systemBytes = bytes(JSON.stringify(event.system))
        messagesBytes = bytes(JSON.stringify(event.messages))
        toolsBytes = bytes(JSON.stringify(event.tools))

        messageBreakdown = Array.isArray(event.messages)
          ? event.messages.map((message, index) => ({
              index,
              role:
                typeof message?.role === "string"
                  ? message.role
                  : null,
              bytes: bytes(JSON.stringify(message)),
              part_count:
                Array.isArray(message?.parts)
                  ? message.parts.length
                  : null,
              content_kind: taskContextValueKind(message?.content),
              content_part_types: taskContextPartTypes(message?.content),
              parts_part_types: taskContextPartTypes(message?.parts),
              has_message_text: typeof message?.text === "string",
            }))
          : []
      } catch {
        // Best-effort telemetry.
      }

      await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
        ts: nowMs(),
        protocol: AGENT_PROTOCOL,
        kind: "model_dispatch",
        sessionID,
        turnID: state.turnID,
        task_context_protocol: state.taskContextProtocol ?? TASK_CONTEXT_PROTOCOL,
        task_context_adapter_protocol: state.taskContextAdapterProtocol ?? TASK_CONTEXT_ADAPTER_PROTOCOL,
        task_turn_id: state.taskTurnID,
        task_text_sha256: state.taskTextSha256,
        task_text_bytes: state.taskTextBytes,
        task_text_sources: state.taskTextSources,
        task_context_reason: state.taskContextReason,
        task_context_drift: state.taskContextDrift === true,
        mutation_intent_protocol: MUTATION_INTENT_PROTOCOL,
        mutation_intent: state.mutationIntent,
        mutation_intent_reason: state.mutationIntentReason,
        task_action_protocol:
          state.taskAction?.protocol ?? TASK_ACTION_PROTOCOL,
        task_action_status: state.taskAction?.status ?? null,
        task_action_operation: state.taskAction?.operation ?? null,
        action_commit_protocol: ACTION_COMMIT_PROTOCOL,
        action_commit_sha256: state.actionCommitSha256,
        action_commit_dispatches: state.actionCommitDispatches,
        terminal_commit_protocol: TERMINAL_COMMIT_PROTOCOL,
        terminal_commit_sha256: state.terminalCommitSha256,
        terminal_commit_claims: state.terminalCommitClaims,
        terminal_short_circuit_requests:
          state.terminalShortCircuitRequests,
        terminal_short_circuits: state.terminalShortCircuits,
        terminal_short_circuit_failures:
          state.terminalShortCircuitFailures,
        completion_safe_fail_protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
        completion_safe_fail_sha256: state.completionSafeFailSha256,
        completion_safe_fail_short_circuit_requests:
          state.completionSafeFailShortCircuitRequests,
        completion_safe_fail_short_circuits:
          state.completionSafeFailShortCircuits,
        completion_safe_fail_short_circuit_failures:
          state.completionSafeFailShortCircuitFailures,
        project_root: root,
        agent: event.agent ?? null,
        providerID: event.model?.providerID ?? null,
        modelID: event.model?.id ?? null,
        model_call: state.modelCalls,
        turn_elapsed_ms: elapsed,
        context_bytes: contextBytes,
        context_system_bytes: systemBytes,
        context_messages_bytes: messagesBytes,
        context_tools_bytes: toolsBytes,
        context_message_breakdown: messageBreakdown,
        message_count: Array.isArray(event.messages) ? event.messages.length : null,
        tool_count:
          event.tools && typeof event.tools === "object"
            ? Object.keys(event.tools).length
            : null,
        tool_names:
          event.tools && typeof event.tools === "object"
            ? Object.keys(event.tools).sort()
            : [],
        execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
        tool_frontier_protocol: TOOL_FRONTIER_PROTOCOL,
        mutation_tool_abi_protocol: MUTATION_TOOL_ABI_PROTOCOL,
        materialized_tool_surface: materializedToolNames,
        tool_frontier_names: frontierToolNames,
        tool_frontier_schema_sha256: frontierToolSchemaSha256,
        execution_state: state.executionState,
        execution_reason: state.executionReason,
        execution_event: state.executionEvent,
        next_action: nextActionForExecutionState(state),
        edit_capsule_path: state.editCapsulePath,
        edit_capsule_sha256: state.editCapsuleHash,
        pending_rescout: state.pendingRescout,
        turn_search_attempts: state.searchAttempts,
        turn_executed_searches: state.executedSearches,
        turn_mutation_attempts: state.mutationAttempts,
        turn_repair_attempts: state.repairAttempts,
        turn_tool_contract_failures: state.contractFailures,
        active_mutation_tool: state.activeMutationTool,
        turn_compiler_runs: state.compilerRuns,
        turn_patch_attempts: state.patchAttempts,
        turn_executor_runs: state.executorRuns,
        turn_executed_patches: state.executedPatches,
        turn_patch_accepted: state.patchAccepted,
        turn_evidence_bytes: state.evidenceBytes,
      })
    }))

    return async () => {
      await unsubscribeEvents()

      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }

      sessionStates.clear()
    }
  },
}
