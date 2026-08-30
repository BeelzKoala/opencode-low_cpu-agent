              all_discovered_files_emitted: allDiscoveredFilesSelected,
              routing_active: routingActive,
              route_strategy: "query_fair_lexical8_plus_task_local_impact",
              scout_handoff_protocol: scoutHandoff?.protocol ?? SCOUT_HANDOFF_PROTOCOL,
              scout_handoff_path: scoutHandoff?.path ?? null,
              scout_handoff_status: scoutHandoff?.status ?? null,
              scout_handoff_files: scoutHandoff?.files ?? null,
              scout_handoff_elapsed_ms: scoutHandoff?.elapsedMs ?? null,
              scout_handoff_blocking_reasons: scoutHandoff?.blockingReasons ?? [],
              scout_handoff_partial_reasons: scoutHandoff?.partialReasons ?? [],
              scout_local_capability_protocol:
                localMutationCapability?.protocol ?? null,
              scout_local_capability_reason:
                localMutationCapability?.reason ?? null,
              scout_local_capability_detail:
                localMutationCapability?.detail ?? null,
              scout_local_replace_node_ready:
                localMutationCapability?.replaceNodeReady === true,
              scout_global_rename_ready:
                renameMutationCapability?.ok === true &&
                renameMutationCapability?.ready === true,
              scout_rename_target_protocol:
                renameMutationCapability?.protocol ?? SCOUT_RENAME_TARGET_PROTOCOL,
              scout_rename_target_reason:
                renameMutationCapability?.reason ?? null,
              scout_rename_target_ready:
                renameMutationCapability?.ok === true &&
                renameMutationCapability?.ready === true,
              scout_rename_target:
                renameMutationCapability?.target ?? null,
              scout_local_mutation_handoff:
                localMutationCapability?.localHandoffPath ?? null,
              scout_local_mutation_target:
                localMutationCapability?.target ?? null,
              scout_local_allowed_mutations:
                localMutationCapability?.allowedMutations ?? [],
              scout_owner_attestation:
                localMutationCapability?.ownerAttestation ?? null,
              scout_competitor_check:
                localCompetitorCheck ?? null,
              mutation_candidate_protocol:
                editCapsule?.mutationCandidateProtocol ?? null,
              mutation_candidate_count:
                editCapsule?.mutationCandidateCount ?? 0,
              mutation_candidates_preauthorized:
                localMutationCandidateSet?.candidates?.length ?? 0,
              mutation_candidates_rejected:
                localMutationCandidateSet?.rejected?.length ?? 0,
              impact_mutation_candidate_recovery_reason:
                impactMutationCandidateRecovery?.reason ?? null,
              impact_mutation_candidate_recovery_groups:
                impactMutationCandidateRecovery?.groups?.length ?? 0,
              edit_capsule_protocol: editCapsule?.protocol ?? null,
              edit_capsule_path: editCapsule?.path ?? null,
              edit_capsule_sha256: editCapsule?.sha256 ?? null,
              edit_capsule_mutation_ready: editCapsule?.mutationReady ?? false,
              edit_capsule_coverage: editCapsule?.coverage ?? null,
              execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
              execution_readiness_protocol: EXECUTION_READINESS_PROTOCOL,
              execution_readiness_status: executionReadiness.status,
              execution_readiness_reason: executionReadiness.reason,
              execution_readiness_failure_kind:
                executionReadiness.failure_kind,
              execution_readiness_required_mutation_shape:
                executionReadiness.required_mutation_shape,
              execution_readiness_available_mutation_operations:
                executionReadiness.available_mutation_operations,
              execution_readiness_evidence:
                executionReadiness.evidence,
              execution_readiness_mutation_authority:
                executionReadiness.mutation_authority,
              patch_permission_action: PATCH_PERMISSION_ACTION,
              execution_state: state?.executionState ?? null,
              execution_reason: state?.executionReason ?? null,
              execution_event: state?.executionEvent ?? null,
              task_context_protocol: state?.taskContextProtocol ?? TASK_CONTEXT_PROTOCOL,
              task_context_adapter_protocol: state?.taskContextAdapterProtocol ?? TASK_CONTEXT_ADAPTER_PROTOCOL,
              task_turn_id: state?.taskTurnID ?? null,
              task_text_sha256: state?.taskTextSha256 ?? null,
              task_text_bytes: state?.taskTextBytes ?? null,
              task_text_sources: state?.taskTextSources ?? [],
              task_context_reason: state?.taskContextReason ?? null,
              task_context_drift: state?.taskContextDrift === true,
              mutation_intent_protocol: MUTATION_INTENT_PROTOCOL,
              mutation_intent_router_protocol: "mutation-intent-router-v1.1-task-context",
              mutation_intent: state?.mutationIntent ?? "unknown",
              mutation_intent_reason: state?.mutationIntentReason ?? null,
              task_action_protocol:
                state?.taskAction?.protocol ?? TASK_ACTION_PROTOCOL,
              task_action_status: state?.taskAction?.status ?? null,
              task_action_operation: state?.taskAction?.operation ?? null,
              mutation_action_frontier: mutationFrontier,
              mutation_action_reason: frontierResolution.reason,
              action_commit_protocol: ACTION_COMMIT_PROTOCOL,
              action_commit_ready: actionCommitResult.ok === true,
              action_commit_reason: actionCommitResult.reason,
              action_commit_sha256:
                actionCommitResult.commit?.commit_sha256 ?? null,
              action_commit_claimed: actionCommitClaim?.ok === true,
              action_commit_dispatches: state?.actionCommitDispatches ?? 0,
              mutation_dispatch_origin:
                deterministicMutationResult
                  ? ACTION_COMMIT_DISPATCH_ORIGIN
                  : null,
              next_action: nextActionForExecutionState(state),
              candidate_files: rankedFiles.length,
              lexical_candidate_files: lexicalRankedFiles.length,
              discovery_elapsed_ms: discoveryElapsedMs,

              retrieval_ranker_attempted:
                retrievalRanking.attempted,
              retrieval_ranker_ok:
                retrievalRanking.ok,
              retrieval_ranker_reason:
                retrievalRanking.reason,
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
        }

    await track(ctx.tool.transform((tools) => {
      tools.add({
        name: "search",
        description:
          "Search the active project with 1 to 4 regular expressions in one call. " +
          "Search first performs repository-wide lexical discovery, applies bounded deterministic structural BM25F/RRF reranking when available, and keeps query fairness separate from relevance, " +
          "and probes up to eight candidates before emitting at most four evidence files in the same tool call. " +
          "Returns bounded line-numbered evidence and explicit completeness metadata. " +
          "lexical_discovery_complete=true means the file-level rg pass saw every matching file " +
          "for the requested regex/path/glob. scan_complete=true is stronger: every discovered file " +
          "was probed and every matching line was scanned. " +
          "A ROUTE block is heuristic routing only; retained_unemitted files remain lexical candidates " +
          "and must not be treated as irrelevant or absent. " +
          "Completeness is lexical: scan_complete=true means all matches for the requested " +
          "regex/path/glob were scanned across the probed universe, not that a semantic category is exhaustively absent. " +
          "evidence_complete=true means every discovered hit line is represented, not that " +
          "the surrounding function or file is fully shown. representation=focused adds bounded " +
          "containing-scope context chosen from structurally relevant non-module matches but still " +
          "does not imply whole-file context. Turn evidence is deduplicated: prior_evidence_reused=true " +
          "means omitted facts remain available in earlier tool results. Scope contextualization is one-shot " +
          "per hit within a turn; SEARCH_NO_PROGRESS means change the search dimension instead of retrying " +
          "equivalent context. representation=index is now only a narrow-scope fallback when selected line " +
          "evidence itself cannot fit or complete; broad repository routing is probed and budgeted before returning. " +
          "When Scout proves one mutation-authorized structural owner, v2.18 derives a bounded local capability even if unrelated global discovery remains partial; competing production owners fail closed. Global rename still requires a globally ready handoff. The causal controller then exposes only capability-derived action-specific mutation tools.",
        input: {
          type: "object",
          properties: {
            queries: {
              type: "array",
              minItems: 1,
              maxItems: MAX_QUERIES,
              items: { type: "string", minLength: 1, maxLength: 200 },
              description: "One to four regular expressions.",
            },
            path: {
              type: "string",
              minLength: 1,
              description: "Optional project-relative file or directory. Default: project root.",
            },
            glob: {
              type: "string",
              minLength: 1,
              description: "Optional file glob such as **/*.py.",
            },
          },
          required: ["queries"],
          additionalProperties: false,
        },
        options: {
          codemode: false,
          permission: "search",
        },

        execute: deterministicSearchExecutor,
      })
    }))

    await track(ctx.tool.transform((tools) => {
      tools.add({
        name: EXECUTE_ADDITIVE_PLAN_TOOL,
        description:
          "Submit one bounded additive plan. Always provide python_imports, python_declarations, replacements, and creations arrays; use [] when unused. " +
          "Python edits describe WHAT only: imports or new module-level declarations. Never submit Python line numbers, offsets, site ids, paths, or source preimages. " +
          "Non-Python existing slots use exact replacements. Creations remain relative to sealed create slots.",
        input: {
          type: "object",
          properties: {
            python_imports: {
              type: "array",
              minItems: 0,
              maxItems: ADDITIVE_MAX_OPERATIONS,
              items: {
                type: "object",
                properties: {
                  slot: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                    description: "Opaque Python existing-slot id.",
                  },
                  modules: {
                    type: "array",
                    minItems: 0,
                    maxItems: ADDITIVE_MAX_OPERATIONS,
                    items: {
                      type: "string",
                      minLength: 1,
                    },
                    description:
                      "Plain module imports, e.g. ['io']. No aliases or source coordinates.",
                  },
                  from_imports: {
                    type: "array",
                    minItems: 0,
                    maxItems: ADDITIVE_MAX_OPERATIONS,
                    items: {
                      type: "object",
                      properties: {
                        module: {
                          type: "string",
                          minLength: 1,
                        },
                        name: {
                          type: "string",
                          minLength: 1,
                        },
                      },
                      required: ["module", "name"],
                      additionalProperties: false,
                    },
                    description:
                      "From-import bindings, e.g. {module:'datetime', name:'datetime'}.",
                  },
                },
                required: ["slot", "modules", "from_imports"],
                additionalProperties: false,
              },
            },
            python_declarations: {
              type: "array",
              minItems: 0,
              maxItems: ADDITIVE_MAX_OPERATIONS,
              items: {
                type: "object",
                properties: {
                  slot: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                    description: "Opaque Python existing-slot id.",
                  },
                  content: {
                    type: "string",
                    minLength: 1,
                    maxLength: ADDITIVE_MAX_REPLACE_BYTES,
                    description:
                      "New top-level function/class/decorated declaration only. Imports belong in python_imports.",
                  },
                },
                required: ["slot", "content"],
                additionalProperties: false,
              },
            },
            replacements: {
              type: "array",
              minItems: 0,
              maxItems: ADDITIVE_MAX_OPERATIONS,
              description:
                "Exact replacements for non-Python existing slots only.",
              items: {
                type: "object",
                properties: {
                  slot: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                  },
                  before: {
                    type: "string",
                    minLength: 1,
                    maxLength: ADDITIVE_MAX_REPLACE_BYTES,
                  },
                  replacement: {
                    type: "string",
                    maxLength: ADDITIVE_MAX_REPLACE_BYTES,
                  },
                },
                required: ["slot", "before", "replacement"],
                additionalProperties: false,
              },
            },
            creations: {
              type: "array",
              minItems: 0,
              maxItems: ADDITIVE_MAX_CREATE_FILES,
              items: {
                type: "object",
                properties: {
                  slot: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                  },
                  relative_path: {
                    type: "string",
                    minLength: 1,
                    maxLength: ADDITIVE_MAX_REL_PATH_BYTES,
                  },
                  content: {
                    type: "string",
                    maxLength: ADDITIVE_MAX_CREATE_BYTES,
                    description:
                      "Complete UTF-8 file content. Deterministic byte budgets are rechecked at runtime.",
                  },
                },
                required: ["slot", "relative_path", "content"],
                additionalProperties: false,
              },
            },
          },
          required: ["python_imports", "python_declarations", "replacements", "creations"],
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
            "additive_surface",
            EXECUTE_ADDITIVE_PLAN_TOOL,
          ),
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
      const stableToolSurface = new Set([
        "search",
        ...MUTATION_TOOL_NAMES,
      ])
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

      if (
        state.executionReadiness?.protocol === EXECUTION_READINESS_PROTOCOL &&
        state.executionReadiness?.status === EXECUTION_READINESS_STATUS.SAFE_FAIL
      ) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: "execution_safe_fail",
          sessionID,
          turnID: state.turnID,
          project_root: root,
          execution_readiness_protocol: EXECUTION_READINESS_PROTOCOL,
          execution_readiness_status: state.executionReadiness.status,
          execution_readiness_reason: state.executionReadiness.reason,
          execution_readiness_failure_kind:
            state.executionReadiness.failure_kind,
          execution_readiness_required_mutation_shape:
            state.executionReadiness.required_mutation_shape,
          execution_state: state.executionState,
          model_calls: state.modelCalls,
        })

        throw new Error(
          `CPU_AGENT execution_safe_fail reason=${state.executionReadiness.reason}`,
        )
      }

      const materializedToolNames = Object.keys(event.tools).sort()
      const requiredSurface = [
        "search",
        ...MUTATION_TOOL_NAMES,
      ]
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

      // E2.3-A deterministic pre-Scout.
      //
      // Monotonic optimization only: routing seeds are heuristic, evidence and
      // mutation authority still come exclusively from the existing Scout.
      const deterministicScoutPlan = compileDeterministicScoutRequest({
        messages: event.messages,
        taskShape: state.taskShape,
      })
      const deterministicScoutFastpathEnabled =
        process.env.OPENCODE_CPU_ONE_CALL_EXECUTOR === "1"
      const deterministicScoutEligible =
        deterministicScoutFastpathEnabled &&
        state.modelCalls === 0 &&
        state.executionState === EXEC_STATE_LOCATE &&
        state.taskShape?.status === "compiled" &&
        state.taskShape?.shape === "additive" &&
        deterministicScoutPlan.applied === true &&
        canMergeDeterministicScoutContext(event.system) &&
        state.deterministicScoutTurnID !== state.turnID

      if (deterministicScoutEligible) {
        state.deterministicScoutTurnID = state.turnID
        const deterministicScoutStarted = performance.now()
        let deterministicScoutResult = null
        let deterministicScoutError = null

        try {
          deterministicScoutResult = await deterministicSearchExecutor(
            deterministicScoutPlan.input,
            {
              sessionID,
              directory: root,
              cwd: root,
              worktree: root,
            },
          )
        } catch (error) {
          deterministicScoutError =
            error instanceof Error ? error.message : String(error)
        }

        const deterministicScoutContent =
          typeof deterministicScoutResult?.content === "string"
            ? deterministicScoutResult.content
            : ""

        const modelContextCompilerMode =
          resolveModelContextCompilerMode(
            process.env.OPENCODE_CPU_MODEL_CONTEXT_COMPILER,
          )
        const modelContextCompilerBudget =
          resolveModelContextBudgetBytes(
            process.env.OPENCODE_CPU_MODEL_CONTEXT_MAX_BYTES,
          )
        const repairContextCompilerBudget =
          resolveRepairContextBudgetBytes(
            process.env.OPENCODE_CPU_REPAIR_CONTEXT_MAX_BYTES,
          )
        let modelContextCompilation = Object.freeze({
          protocol: MODEL_CONTEXT_COMPILER_PROTOCOL,
          status: "not_attempted",
          ok: false,
          reason: "authorized_additive_capability_unavailable",
          source_bytes: Buffer.byteLength(
            deterministicScoutContent,
            "utf8",
          ),
          compiled_bytes: 0,
          saved_bytes: 0,
          reduction_ratio: 0,
          critical_file_coverage_complete: false,
          execution_contract_coverage_complete: false,
          execution_contract_sha256: null,
          capsule_sha256: null,
          token_authority: false,
          token_count: null,
        })
        if (
          deterministicScoutContent.length > 0 &&
          state.additiveMutationCapability?.ready === true &&
          state.additiveMutationCapability?.mutation_authority === true
        ) {
          try {
            modelContextCompilation =
              await compileAdditiveExecutionCapsule({
                root,
                capability: state.additiveMutationCapability,
                baselineContent: deterministicScoutContent,
                maxBytes: modelContextCompilerBudget,
              })
          } catch (error) {
            modelContextCompilation = Object.freeze({
              protocol: MODEL_CONTEXT_COMPILER_PROTOCOL,
              status: "abstained",
              ok: false,
              reason: "context_compiler_exception",
              error: error instanceof Error ? error.message : String(error),
              source_bytes: Buffer.byteLength(
                deterministicScoutContent,
                "utf8",
              ),
              compiled_bytes: 0,
              saved_bytes: 0,
              reduction_ratio: 0,
              critical_file_coverage_complete: false,
              execution_contract_coverage_complete: false,
              execution_contract_sha256: null,
              capsule_sha256: null,
              token_authority: false,
              token_count: null,
            })
          }
        }

        let deterministicScoutSelectedContent =
          deterministicScoutContent
        let modelContextSelectedSource =
          "deterministic_scout_baseline"

        if (
          modelContextCompilerMode === "active" &&
          modelContextCompilation.ok === true &&
          modelContextCompilation
            .execution_contract_coverage_complete === true &&
          modelContextCompilation.semantic_coverage_complete === true
        ) {
          const compiledCapsule =
            snapshotCompiledExecutionCapsule(
              modelContextCompilation,
            )
          if (!compiledCapsule) {
            state.executionContextBlockReason =
              "model_context_capsule_snapshot_invalid"
            applyExecutionEvent(
              state,
              "fatal",
              state.executionContextBlockReason,
            )
            deterministicScoutSelectedContent =
              `EXECUTION_CONTEXT_BLOCKED reason=${state.executionContextBlockReason} ` +
              "action=report_blocked"
            modelContextSelectedSource =
              "execution_context_blocked"
          } else if (
            state.executionContextCapsuleSha256 &&
            state.executionContextCapsuleSha256 !==
              compiledCapsule.capsule_sha256
          ) {
            state.executionContextBlockReason =
              "execution_context_capsule_drift"
            applyExecutionEvent(
              state,
              "fatal",
              state.executionContextBlockReason,
            )
            deterministicScoutSelectedContent =
              `EXECUTION_CONTEXT_BLOCKED reason=${state.executionContextBlockReason} ` +
              "action=report_blocked"
            modelContextSelectedSource =
              "execution_context_blocked"
          } else {
            state.executionContextCapsule = compiledCapsule
            state.executionContextCapsuleSha256 =
              compiledCapsule.capsule_sha256
            state.executionContextContractSha256 =
              compiledCapsule.execution_contract_sha256
            state.executionContextBlockReason = null
            deterministicScoutSelectedContent =
              modelContextCompilation.content
            modelContextSelectedSource =
              "compiled_execution_capsule"
          }
        }

        if (
          modelContextCompilerMode === "active" &&
          state.additiveMutationCapability?.ready === true &&
          state.additiveMutationCapability
            ?.mutation_authority === true &&
          (
            modelContextCompilation.ok !== true ||
            modelContextCompilation.semantic_coverage_complete !== true
          )
        ) {
          state.executionContextBlockReason =
            typeof modelContextCompilation.reason === "string" &&
            modelContextCompilation.reason.length > 0
              ? `model_context_${modelContextCompilation.reason}`
              : "model_context_active_compile_failed"
          applyExecutionEvent(
            state,
            "fatal",
            state.executionContextBlockReason,
          )
          deterministicScoutSelectedContent =
            `EXECUTION_CONTEXT_BLOCKED reason=${state.executionContextBlockReason} ` +
            "action=report_blocked"
          modelContextSelectedSource =
            "execution_context_blocked"
        }

        state.executionContextSelectedSource =
          modelContextSelectedSource
        state.repairContextProjectionStatus = null
        state.repairContextProjectionReason = null
        state.repairContextProjectionBytes = 0
        state.repairContextProjectionSha256 = null
        state.repairContextSourceCapsuleSha256 = null

        const deterministicScoutContextMerge =
          deterministicScoutSelectedContent.length > 0
            ? mergeDeterministicScoutContext(
                event,
                deterministicScoutSelectedContent,
              )
            : Object.freeze({
                protocol: null,
                applied: false,
                reason: "content_unavailable",
                carrier_kind: null,
                carrier_index: null,
                system_entries_before: Array.isArray(event.system)
                  ? event.system.length
                  : typeof event.system === "string"
                    ? 1
                    : null,
                system_entries_after: Array.isArray(event.system)
                  ? event.system.length
                  : typeof event.system === "string"
                    ? 1
                    : null,
                content_bytes: 0,
                block_bytes: 0,
                content_sha256: null,
                content_trust: null,
              })
        const deterministicScoutContextAppended =
          deterministicScoutContextMerge.applied === true

        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "deterministic_scout_preflight",
          deterministic_scout_protocol:
            DETERMINISTIC_SCOUT_ENTRY_PROTOCOL,
          sessionID,
          turnID: state.turnID,
          project_root: root,
          enabled: deterministicScoutFastpathEnabled,
          applied: true,
          reason:
            deterministicScoutError !== null
              ? "search_executor_error"
              : deterministicScoutContextAppended
                ? "search_result_injected"
                : "search_result_unavailable",
          query_count:
            deterministicScoutPlan.input?.queries?.length ?? 0,
          queries: deterministicScoutPlan.input?.queries ?? [],
          routing_authority: false,
          mutation_authority: false,
          model_context_compiler_protocol:
            MODEL_CONTEXT_COMPILER_PROTOCOL,
          model_context_compiler_mode: modelContextCompilerMode,
          model_context_compiler_status: modelContextCompilation.status,
          model_context_compiler_reason: modelContextCompilation.reason,
          model_context_compiler_budget_bytes: modelContextCompilerBudget,
          model_context_source_bytes:
            modelContextCompilation.source_bytes ?? null,
          model_context_compiled_bytes:
            modelContextCompilation.compiled_bytes ?? null,
          model_context_saved_bytes:
            modelContextCompilation.saved_bytes ?? null,
          model_context_reduction_ratio:
            modelContextCompilation.reduction_ratio ?? null,
          model_context_critical_coverage:
            modelContextCompilation.critical_file_coverage_complete === true,
          model_context_execution_contract_coverage:
            modelContextCompilation.execution_contract_coverage_complete === true,
          model_context_execution_contract_sha256:
            modelContextCompilation.execution_contract_sha256 ?? null,
          model_context_execution_contract_bytes:
            modelContextCompilation.execution_contract_bytes ?? null,
          model_context_critical_evidence_bytes:
            modelContextCompilation.critical_evidence_bytes ?? null,
          model_context_minimum_required_bytes:
            modelContextCompilation.minimum_required_bytes ?? null,
          model_context_over_budget_bytes:
            modelContextCompilation.over_budget_bytes ?? null,
          model_context_semantic_coverage:
            modelContextCompilation.semantic_coverage_complete === true,
          model_context_semantic_coverage_sha256:
            modelContextCompilation.semantic_coverage_sha256 ?? null,
          model_context_semantic_coverage_scope_count:
            modelContextCompilation.semantic_coverage_scope_count ?? 0,
          model_context_structural_planner_protocol:
            modelContextCompilation.structural_planner_protocol ?? null,
          model_context_structural_planner_status:
            modelContextCompilation.structural_planner_status ?? null,
          model_context_structural_planner_reason:
            modelContextCompilation.structural_planner_reason ?? null,
          model_context_structural_planner_backend:
            modelContextCompilation.structural_planner_backend ?? null,
          model_context_structural_planner_elapsed_ms:
            modelContextCompilation.structural_planner_elapsed_ms ?? null,
          model_context_structural_planner_parsed_files:
            modelContextCompilation.structural_planner_parsed_files ?? 0,
          model_context_structural_planner_fallback_files:
            modelContextCompilation.structural_planner_fallback_files ?? 0,
          model_context_structural_plan_sha256:
            modelContextCompilation.structural_plan_sha256 ?? null,
          model_context_selected_evidence_levels:
            modelContextCompilation.selected_evidence_levels ?? [],
          model_context_capsule_sha256:
            state.executionContextCapsuleSha256 ??
            modelContextCompilation.capsule_sha256 ??
            null,
          model_context_token_authority:
            modelContextCompilation.token_authority === true,
          model_context_token_count:
            modelContextCompilation.token_count ?? null,
          model_context_selected_source: modelContextSelectedSource,
          repair_context_budget_bytes: repairContextCompilerBudget,
          repair_context_projection_status:
            state.repairContextProjectionStatus,
          repair_context_projection_reason:
            state.repairContextProjectionReason,
          repair_context_projection_bytes:
            state.repairContextProjectionBytes,
          repair_context_projection_sha256:
            state.repairContextProjectionSha256,
          repair_context_source_capsule_sha256:
            state.repairContextSourceCapsuleSha256,
          execution_context_block_reason:
            state.executionContextBlockReason,
          context_appended: deterministicScoutContextAppended,
          context_carrier_protocol:
            deterministicScoutContextMerge.protocol ?? null,
          context_carrier_reason:
            deterministicScoutContextMerge.reason ?? null,
          context_carrier_kind:
            deterministicScoutContextMerge.carrier_kind ?? null,
          context_carrier_index:
            deterministicScoutContextMerge.carrier_index ?? null,
          context_system_entries_before:
            deterministicScoutContextMerge.system_entries_before ?? null,
          context_system_entries_after:
            deterministicScoutContextMerge.system_entries_after ?? null,
          context_content_bytes:
            deterministicScoutContextMerge.content_bytes ?? null,
          context_block_bytes:
            deterministicScoutContextMerge.block_bytes ?? null,
          context_content_sha256:
            deterministicScoutContextMerge.content_sha256 ?? null,
          context_content_trust:
            deterministicScoutContextMerge.content_trust ?? null,
          error: deterministicScoutError,
          execution_state: state.executionState,
          execution_reason: state.executionReason,
          next_action: nextActionForExecutionState(state),
          elapsed_ms:
            Math.round(
              (performance.now() - deterministicScoutStarted) * 100,
            ) / 100,
        })
        if (
          state.executionState === EXEC_STATE_MUTATE &&
          deterministicScoutContextMerge.applied !== true
        ) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: "deterministic_context_carrier",
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            context_carrier_protocol:
              deterministicScoutContextMerge.protocol ?? null,
            context_carrier_reason:
              deterministicScoutContextMerge.reason ?? null,
            context_system_entries_before:
              deterministicScoutContextMerge.system_entries_before ?? null,
            context_system_entries_after:
              deterministicScoutContextMerge.system_entries_after ?? null,
          })
          throw new Error(
            `CPU_AGENT deterministic_context_carrier ` +
            `reason=${deterministicScoutContextMerge.reason ?? "unknown"}`,
          )
        }
      }

      const repairExecutionContextEligible =
        resolveModelContextCompilerMode(
          process.env.OPENCODE_CPU_MODEL_CONTEXT_COMPILER,
        ) === "active" &&
        state.executionState === EXEC_STATE_REPAIR &&
        state.additiveRepairLock?.repairable === true

      if (repairExecutionContextEligible) {
        const repairContextCompilerBudget =
          resolveRepairContextBudgetBytes(
            process.env.OPENCODE_CPU_REPAIR_CONTEXT_MAX_BYTES,
          )
        let repairContextProjection = Object.freeze({
          protocol: "repair-execution-context-projection-v1",
          ok: false,
          reason: "repair_execution_context_capsule_missing",
          bytes: 0,
          projection_sha256: null,
          source_capsule_sha256:
            state.executionContextCapsuleSha256,
          target_slots: Object.freeze([]),
          target_files: Object.freeze([]),
        })

        if (state.executionContextCapsule) {
          try {
            repairContextProjection =
              await buildRepairExecutionProjection({
                root,
                capsule: state.executionContextCapsule,
                capability: state.additiveMutationCapability,
                repairHint: state.additiveRepairLock,
                maxBytes: repairContextCompilerBudget,
              })
          } catch (error) {
            repairContextProjection = Object.freeze({
              protocol: "repair-execution-context-projection-v1",
              ok: false,
              reason: "repair_context_projection_exception",
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
              bytes: 0,
              projection_sha256: null,
              source_capsule_sha256:
                state.executionContextCapsuleSha256,
              target_slots: Object.freeze([]),
              target_files: Object.freeze([]),
            })
          }
        }

        let repairContextContent = null
        let repairContextSelectedSource = null
        if (repairContextProjection.ok === true) {
          repairContextContent = repairContextProjection.content
          repairContextSelectedSource =
            "persisted_execution_capsule_repair_projection"
        }

        state.repairContextProjectionStatus =
          repairContextProjection.ok === true
            ? "compiled"
            : "not_compiled"
        state.repairContextProjectionReason =
          repairContextProjection.reason ?? null
        state.repairContextProjectionBytes =
          repairContextProjection.bytes ?? 0
        state.repairContextProjectionSha256 =
          repairContextProjection.projection_sha256 ?? null
        state.repairContextSourceCapsuleSha256 =
          repairContextProjection.source_capsule_sha256 ?? null

        if (!repairContextContent) {
          state.executionContextBlockReason =
            repairContextProjection.reason ||
            "repair_context_projection_unavailable"
          applyExecutionEvent(
            state,
            "fatal",
            state.executionContextBlockReason,
          )
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "execution_context_repair_projection",
            sessionID,
            turnID: state.turnID,
            project_root: root,
            applied: false,
            reason: state.executionContextBlockReason,
            repair_context_budget_bytes:
              repairContextCompilerBudget,
            source_capsule_sha256:
              state.executionContextCapsuleSha256,
            projection_sha256:
              state.repairContextProjectionSha256,
            target_slots:
              repairContextProjection.target_slots ?? [],
            target_files:
              repairContextProjection.target_files ?? [],
            repair_protocol:
              repairContextProjection.protocol ?? null,
            coverage_failure_sha256:
              repairContextProjection.coverage_failure_sha256 ??
              state.additiveRepairLock?.coverage_failure_sha256 ??
              null,
            failed_candidate_sha256:
              repairContextProjection.failed_candidate_sha256 ??
              state.additiveRepairLock?.failed_candidate_sha256 ??
              null,
            repair_progress_status:
              state.additiveRepairLock?.repair_progress?.status ??
              null,
            repair_progress_strict:
              state.additiveRepairLock?.repair_progress
                ?.strict_progress === true,
            repair_required_bytes:
              repairContextProjection.required_bytes ?? null,
            repair_over_budget_bytes:
              repairContextProjection.over_budget_bytes ?? null,
            routing_authority: false,
            mutation_authority: false,
          })
          throw new Error(
            `CPU_AGENT execution_context_repair_blocked reason=${state.executionContextBlockReason}`,
          )
        }

        if (!canMergeDeterministicScoutContext(event.system)) {
          state.executionContextBlockReason =
            "repair_context_carrier_unsupported"
          applyExecutionEvent(
            state,
            "fatal",
            state.executionContextBlockReason,
          )
          throw new Error(
            `CPU_AGENT execution_context_repair_blocked reason=${state.executionContextBlockReason}`,
          )
        }

        const repairContextMerge =
          mergeDeterministicScoutContext(
            event,
            repairContextContent,
          )
        if (repairContextMerge.applied !== true) {
          state.executionContextBlockReason =
            `repair_context_carrier_${repairContextMerge.reason ?? "unavailable"}`
          applyExecutionEvent(
            state,
            "fatal",
            state.executionContextBlockReason,
          )
          throw new Error(
            `CPU_AGENT execution_context_repair_blocked reason=${state.executionContextBlockReason}`,
          )
        }

        state.executionContextBlockReason = null
        state.executionContextSelectedSource =
          repairContextSelectedSource
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "execution_context_repair_projection",
          sessionID,
          turnID: state.turnID,
          project_root: root,
          applied: true,
          reason: "repair_projection_injected",
          selected_source: repairContextSelectedSource,
          repair_context_budget_bytes:
            repairContextCompilerBudget,
          repair_context_bytes:
            Buffer.byteLength(repairContextContent, "utf8"),
          source_capsule_sha256:
            state.executionContextCapsuleSha256,
          projection_sha256:
            state.repairContextProjectionSha256,
          target_slots:
            repairContextProjection.target_slots ?? [],
          target_files:
            repairContextProjection.target_files ?? [],
          context_carrier_protocol:
            repairContextMerge.protocol ?? null,
          context_carrier_reason:
            repairContextMerge.reason ?? null,
          routing_authority: false,
          mutation_authority: false,
        })
      }

      const allowedTools = allowedToolsForState(state)
      const allowedSet = new Set(allowedTools)
      for (const name of Object.keys(event.tools)) {
        if (!allowedSet.has(name)) delete event.tools[name]
      }

      if (
        Object.prototype.hasOwnProperty.call(
          event.tools,
          EXECUTE_ADDITIVE_PLAN_TOOL,
        )
      ) {
        const schemaBinding = bindAdditiveToolSchemaToCapability(
          event.tools[EXECUTE_ADDITIVE_PLAN_TOOL],
          state.additiveMutationCapability,
        )
        if (schemaBinding.ok !== true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: schemaBinding.reason,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            tool_frontier_protocol: TOOL_FRONTIER_PROTOCOL,
            mutation_tool: EXECUTE_ADDITIVE_PLAN_TOOL,
          })
          throw new Error(
            `CPU_AGENT ${schemaBinding.reason} ` +
            `state=${state.executionState}`,
          )
        }
        const obligationSchemaBinding = bindObligationBoundToolSchema(
          schemaBinding.tool,
          state.additiveMutationCapability,
          state.taskRequirements,
        )
        if (obligationSchemaBinding.ok !== true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: obligationSchemaBinding.reason,
            detail: obligationSchemaBinding.detail ?? null,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            tool_frontier_protocol: TOOL_FRONTIER_PROTOCOL,
            mutation_tool: EXECUTE_ADDITIVE_PLAN_TOOL,
            obligation_bound_synthesis_protocol:
              OBLIGATION_BOUND_SYNTHESIS_PROTOCOL,
          })
          throw new Error(
            `CPU_AGENT ${obligationSchemaBinding.reason} ` +
            `state=${state.executionState}`,
          )
        }
        event.tools[EXECUTE_ADDITIVE_PLAN_TOOL] = obligationSchemaBinding.tool
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

      const governorNowMs = nowMs()
      const governorAdmission = resolveGovernorAdmission({
        nowMs: governorNowMs,
        taskStartedAt:
          state.governorTaskStartedAt ?? state.turnStartedAt,
        phaseStartedAt:
          state.governorPhaseStartedAt ?? state.turnStartedAt,
        phaseBudgetMs: MAX_TURN_WALL_MS,
        taskBudgetMs: MAX_TURN_WALL_MS * GOVERNOR_MAX_ACTIVE_PHASES,
        latencyProfile: state.modelLatencyProfile,
      })

      if (governorAdmission.admitted !== true) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: governorNowMs,
          protocol: AGENT_PROTOCOL,
          governor_protocol: GOVERNOR_LATENCY_PROTOCOL,
          time_semantics_protocol: TIME_SEMANTICS_PROTOCOL,
          governor_task_window_semantics:
            GOVERNOR_TASK_WINDOW_SEMANTICS,
          task_sla_enforced: GOVERNOR_TASK_SLA_ENFORCED,
          product_watchdog_mode: GOVERNOR_PRODUCT_WATCHDOG_MODE,
          production_hard_lease_promoted:
            GOVERNOR_PRODUCTION_HARD_LEASE_PROMOTED,
          benchmark_deadline_authority: false,
          kind: "model_blocked",
          reason: "turn_wall_admission",
          governor_reason: governorAdmission.reason,
          governor_admission_policy:
            governorAdmission.admission_policy ?? null,
          governor_admission_blocker:
            governorAdmission.admission_blocker ?? null,
          sessionID,
          turnID: state.turnID,
          project_root: root,
          execution_state: state.executionState,
          primary_execution_reason: state.executionReason ?? null,
          repair_eligible: state.executionState === EXEC_STATE_REPAIR,
          repair_dispatched: false,
          repair_block_reason:
            state.executionState === EXEC_STATE_REPAIR
              ? governorAdmission.admission_blocker ??
                governorAdmission.reason ??
                "governor_admission"
              : null,
          governor_phase: state.governorPhase,
          governor_base_phase_budget_ms:
            governorAdmission.base_phase_budget_ms ?? MAX_TURN_WALL_MS,
          governor_effective_phase_budget_ms:
            governorAdmission.effective_phase_budget_ms ?? MAX_TURN_WALL_MS,
          governor_latency_margin_ms:
            governorAdmission.reserve_margin_ms ?? 0,
          governor_required_model_window_ms:
            governorAdmission.required_model_window_ms ?? 0,
          governor_task_dispatch_headroom_ms:
            governorAdmission.task_dispatch_headroom_ms ?? null,
          governor_phase_dispatch_headroom_ms:
            governorAdmission.phase_dispatch_headroom_ms ?? null,
          phase_elapsed_ms: governorAdmission.phase_elapsed_ms ?? null,
          phase_remaining_ms: governorAdmission.phase_remaining_ms ?? null,
          task_elapsed_ms: governorAdmission.task_elapsed_ms ?? null,
          task_remaining_ms: governorAdmission.task_remaining_ms ?? null,
          observed_model_latency_reserve_ms:
            governorAdmission.reserve_ms ?? 0,
          model_latency_samples: state.modelLatencySamples ?? 0,
          model_latency_max_ms: state.modelLatencyMaxMs ?? 0,
          model_calls: state.modelCalls,
        })

        throw new Error(
          `CPU_GOVERNOR ${governorAdmission.reason} ` +
          `blocker=${governorAdmission.admission_blocker ?? "none"} ` +
          `phase=${state.governorPhase} ` +
          `phase_remaining_ms=${governorAdmission.phase_remaining_ms ?? 0} ` +
          `task_remaining_ms=${governorAdmission.task_remaining_ms ?? 0} ` +
          `reserve_ms=${governorAdmission.reserve_ms ?? 0}`,
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
      state.lastModelDispatchStartedAt = nowMs()
      state.lastSeen = state.lastModelDispatchStartedAt



      let modelViabilityCaptureControl = null
      if (state.modelCalls === 1) {
        try {
          const modelViabilityCaptureControlRaw = await readFile(
            path.resolve(
              root,
              ".opencode",
              "model-viability-capture-control.json",
            ),
          )
          const parsedModelViabilityCaptureControl = JSON.parse(
            modelViabilityCaptureControlRaw.toString("utf8"),
          )
          if (
            parsedModelViabilityCaptureControl?.protocol ===
              "model-viability-capture-control-v1" &&
            parsedModelViabilityCaptureControl?.enabled === true &&
            typeof parsedModelViabilityCaptureControl?.nonce === "string" &&
            /^[0-9a-f]{64}$/i.test(parsedModelViabilityCaptureControl.nonce) &&
            typeof parsedModelViabilityCaptureControl?.expected_task_text_sha256 === "string" &&
            /^[0-9a-f]{64}$/i.test(
              parsedModelViabilityCaptureControl.expected_task_text_sha256,
            ) &&
            state.taskTextSha256 ===
              parsedModelViabilityCaptureControl.expected_task_text_sha256
          ) {
            modelViabilityCaptureControl = parsedModelViabilityCaptureControl
          }
        } catch {
          modelViabilityCaptureControl = null
        }
      }

      if (modelViabilityCaptureControl !== null) {
        const modelViabilityRequest = {
          system: event.system ?? null,
          messages: event.messages ?? null,
          tools: event.tools ?? null,
        }
        const modelViabilityRawRequestSha256 = createHash("sha256")
          .update(JSON.stringify(modelViabilityRequest))
          .digest("hex")

        try {
          await writeProjectTrace(root, "model-viability-request.jsonl", {
            ts: nowMs(),
            protocol: "model-viability-request-capture-v1",
            kind: "model_viability_request_capture",
            capture_mode: "shadow_only",
            capture_control_protocol: modelViabilityCaptureControl.protocol,
            capture_control_nonce: modelViabilityCaptureControl.nonce,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            providerID: event.model?.providerID ?? null,
            modelID: event.model?.id ?? null,
            model_call: state.modelCalls,
            task_text_sha256: state.taskTextSha256 ?? null,
            raw_request_sha256: modelViabilityRawRequestSha256,
            tool_names:
              event.tools && typeof event.tools === "object"
                ? Object.keys(event.tools)
                : [],
            system: modelViabilityRequest.system,
            messages: modelViabilityRequest.messages,
            tools: modelViabilityRequest.tools,
            mutation_authority: false,
            scheduling_authority: false,
          })
        } catch (error) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_viability_capture_failed",
            sessionID,
            turnID: state.turnID,
            project_root: root,
            model_call: state.modelCalls,
            reason:
              error instanceof Error
                ? error.message
                : String(error),
            mutation_authority: false,
            scheduling_authority: false,
          })
        }
      }

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
        model_context_selected_source:
          state.executionContextSelectedSource,
        execution_context_capsule_sha256:
          state.executionContextCapsuleSha256,
        execution_context_contract_sha256:
          state.executionContextContractSha256,
        execution_context_block_reason:
          state.executionContextBlockReason,
        repair_context_projection_status:
          state.repairContextProjectionStatus,
        repair_context_projection_reason:
          state.repairContextProjectionReason,
        repair_context_projection_bytes:
          state.repairContextProjectionBytes,
        repair_context_projection_sha256:
          state.repairContextProjectionSha256,
        repair_context_source_capsule_sha256:
          state.repairContextSourceCapsuleSha256,
        execution_reason: state.executionReason,
        execution_event: state.executionEvent,
        execution_readiness_protocol:
          state.executionReadiness?.protocol ?? EXECUTION_READINESS_PROTOCOL,
        execution_readiness_status:
          state.executionReadiness?.status ?? null,
        execution_readiness_reason:
          state.executionReadiness?.reason ?? null,
        execution_readiness_failure_kind:
          state.executionReadiness?.failure_kind ?? null,
        execution_readiness_required_mutation_shape:
          state.executionReadiness?.required_mutation_shape ?? null,
        execution_readiness_available_mutation_operations:
          state.executionReadiness?.available_mutation_operations ?? [],
        execution_readiness_mutation_authority:
          state.executionReadiness?.mutation_authority ?? false,
        observed_model_latency_reserve_ms: modelDispatchReserveMs(state),
        governor_protocol: GOVERNOR_LATENCY_PROTOCOL,
        governor_phase: state.governorPhase ?? phaseForExecutionState(state.executionState),
        governor_phase_started_at_ms: state.governorPhaseStartedAt ?? null,
        governor_task_started_at_ms: state.governorTaskStartedAt ?? null,
        governor_base_phase_budget_ms: MAX_TURN_WALL_MS,
        governor_phase_budget_ms:
          effectivePhaseBudgetMs({
            basePhaseBudgetMs: MAX_TURN_WALL_MS,
            taskBudgetMs:
              MAX_TURN_WALL_MS * GOVERNOR_MAX_ACTIVE_PHASES,
            latencyProfile: state.modelLatencyProfile,
          }) ?? MAX_TURN_WALL_MS,
        governor_task_budget_ms:
          MAX_TURN_WALL_MS * GOVERNOR_MAX_ACTIVE_PHASES,
        model_latency_samples: state.modelLatencySamples ?? 0,
        model_latency_max_ms: state.modelLatencyMaxMs ?? 0,
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
