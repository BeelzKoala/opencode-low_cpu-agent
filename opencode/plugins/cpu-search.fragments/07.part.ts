              proof_disposition: proofAssessment.disposition,
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
          const canRetry =
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
          executeCapabilityMutation(
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
          executeCapabilityMutation(
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
