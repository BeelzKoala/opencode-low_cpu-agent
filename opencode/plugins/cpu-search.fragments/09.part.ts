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
          "Submit semantic content only for the deterministic REQUIRED_OPERATION ids emitted by Scout. " +
          "The model MUST NOT choose files, slots, mutation kinds, source preimages, create roots, or physical paths. " +
          "For replacement operations use @@BEFORE:op_N@@ where the exact sealed preimage must be preserved. " +
          "For creation operations use @@CREATE_PATH:op_N@@ anywhere another content item must reference the deterministic created path. " +
          "Return every required id exactly once and no extra ids.",
        input: {
          type: "object",
          properties: {
            contents: {
              type: "array",
              minItems: 1,
              maxItems: ADDITIVE_MAX_OPERATIONS,
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    pattern: "^op_[0-9]+$",
                  },
                  content: {
                    type: "string",
                    minLength: 1,
                    maxLength: ADDITIVE_MAX_CREATE_BYTES,
                  },
                },
                required: ["id", "content"],
                additionalProperties: false,
              },
            },
          },
          required: ["contents"],
          additionalProperties: false,
        },
        options: {
          codemode: false,
          permission: PATCH_PERMISSION_ACTION,
        },
        execute: async (input, toolContext) => {
          const sessionID =
            typeof toolContext?.sessionID === "string" &&
            toolContext.sessionID.length > 0
              ? toolContext.sessionID
              : null
          const state = getSessionState(sessionID)
            // C7-R4 EXECUTION PERMIT: additive pre-materialization claim.
            // Synchronous claim before root lookup and semantic materializer.
            // Failure still consumes this model-dispatch generation.
            const executionPermit =
              claimMutationExecutionPermit(
                state,
                mutationExecutionPermitOptions(
                  state,
                  EXECUTE_ADDITIVE_PLAN_TOOL,
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

          const root = await rootForTool(
            ctx,
            toolContext,
            sessionID,
            state,
          )
          const activeSemanticMutationContract =
            state?.activeSemanticMutationContract ?? null
          const activeSourceSlotContract =
            state?.activeSourceSlotContract ?? null
          const sourceSlotModelViewActive =
            activeSourceSlotContract?.model_view?.protocol ===
              MODEL_VIEW_COMPILER_PROTOCOL
          const atomicModelViewActive =
            sourceSlotModelViewActive &&
            state?.executionState === EXEC_STATE_MUTATE &&
            state?.sourceSlotRepairCache == null &&
            state?.additiveRepairLock == null &&
            activeSourceSlotContract
              ?.atomic_model_view?.protocol ===
              ATOMIC_MODEL_VIEW_PROTOCOL

          const atomicModelViewAccumulation =
            atomicModelViewActive
              ? accumulateAtomicModelViewRequest({
                  plan:
                    activeSourceSlotContract.model_view,
                  assembly:
                    state?.atomicModelViewAssembly ?? null,
                  request: input,
                  turnID:
                    state?.turnID ?? null,
                })
              : null

          if (
            atomicModelViewActive &&
            atomicModelViewAccumulation?.ok === true &&
            atomicModelViewAccumulation.complete !== true
          ) {
            // Atomic assembly is candidate-state only. Commit only the validated
            // in-memory unit and return before source-slot rehydration, semantic
            // materialization, patch compilation, or Executor.
            state.atomicModelViewAssembly =
              atomicModelViewAccumulation.assembly
            state.lastSeen = nowMs()

            await writeProjectTrace(
              root,
              "cpu-agent-trace.jsonl",
              {
                ts: nowMs(),
                protocol: AGENT_PROTOCOL,
                kind:
                  "atomic_model_view_unit_accepted",
                reason:
                  "atomic_model_view_pending",
                sessionID,
                turnID: state.turnID,
                project_root: root,
                execution_state:
                  state.executionState,
                atomic_model_view_protocol:
                  ATOMIC_MODEL_VIEW_PROTOCOL,
                accepted_hole:
                  atomicModelViewAccumulation.accepted_hole,
                next_hole:
                  atomicModelViewAccumulation.next_hole,
                atomic_unit_index:
                  atomicModelViewAccumulation.accepted_count - 1,
                atomic_unit_count:
                  atomicModelViewAccumulation.unit_count,
                accepted_count:
                  atomicModelViewAccumulation.accepted_count,
                partial_materialization: false,
                semantic_attempt_consumed: false,
                repair_attempt: false,
                compiler_run: false,
                executor_run: false,
                mutation_authority: false,
              },
            )

            // PATCH_RETRY is the existing nonterminal tool-result transport
            // understood by the host loop. Deliberately DO NOT emit a
            // patch_retry FSM event: atomic assembly remains MUTATE, is not
            // repair, and consumes no semantic patch attempt.
            return {
              content:
                `PATCH_RETRY reason=atomic_model_view_pending ` +
                `accepted=${atomicModelViewAccumulation.accepted_hole} ` +
                `next=${atomicModelViewAccumulation.next_hole} ` +
                "action=submit_next_atomic_hole",
              metadata: {
                protocol:
                  ATOMIC_MODEL_VIEW_PROTOCOL,
                action:
                  "continue_atomic_model_view",
                reason:
                  "atomic_model_view_pending",
                execution_state:
                  state.executionState,
                accepted_hole:
                  atomicModelViewAccumulation.accepted_hole,
                next_hole:
                  atomicModelViewAccumulation.next_hole,
                atomic_unit_index:
                  atomicModelViewAccumulation.accepted_count - 1,
                atomic_unit_count:
                  atomicModelViewAccumulation.unit_count,
                accepted_count:
                  atomicModelViewAccumulation.accepted_count,
                partial_materialization: false,
                semantic_attempt_consumed: false,
                repair_attempt: false,
                compiler_run: false,
                executor_run: false,
                mutation_authority: false,
              },
            }
          }

          if (
            atomicModelViewActive &&
            atomicModelViewAccumulation?.ok !== true
          ) {
            // Invalid atomic payload is never retained. Feed the exact
            // Model View failure into the existing R26 fail-closed path.
            state.atomicModelViewAssembly = null
          }

          if (
            atomicModelViewActive &&
            atomicModelViewAccumulation?.ok === true &&
            atomicModelViewAccumulation.complete === true
          ) {
            // Join happens only in memory. The complete request is then passed
            // through the unchanged full R26 normalization before any source
            // rehydration or materialization.
            state.atomicModelViewAssembly = null
            input =
              atomicModelViewAccumulation.request
          }

          const sourceSlotModelNormalization =
            atomicModelViewActive &&
            atomicModelViewAccumulation?.ok !== true
              ? atomicModelViewAccumulation
              : sourceSlotModelViewActive
                ? normalizeSourceSlotModelViewRequest({
                    plan:
                      activeSourceSlotContract.model_view,
                    request: input,
                  })
                : {
                    ok: true,
                    protocol:
                      MODEL_VIEW_COMPILER_PROTOCOL,
                    reason:
                      "model_view_passthrough",
                    request: input,
                    mutation_authority: false,
                  }

          if (
            sourceSlotModelViewActive &&
            sourceSlotModelNormalization.ok === true
          ) {
            // Model-only codec names terminate here. Every downstream
            // compiler/materializer continues on the canonical {sources} ABI.
            input =
              sourceSlotModelNormalization.request
          }

          const sourceSlotRehydration =
            sourceSlotModelNormalization.ok !== true
              ? sourceSlotModelNormalization
              : activeSourceSlotContract?.protocol ===
                    SOURCE_SLOT_COMPILER_PROTOCOL &&
                  activeSemanticMutationContract?.protocol ===
                    SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL
                ? await rehydrateSourceSlotRequest({
                    binding:
                      activeSourceSlotContract.binding,
                    request: input,
                    capability:
                      state?.additiveMutationCapability,
                    contract:
                      activeSemanticMutationContract.contract,
                    semanticAttestation:
                      activeSemanticMutationContract.attestation,
                    repairCache:
                      state?.sourceSlotRepairCache ?? null,
                    executionContextSha256:
                      state?.executionContextCapsuleSha256,
                  })
                : {
                    ok: true,
                    protocol:
                      SOURCE_SLOT_COMPILER_PROTOCOL,
                    reason:
                      "source_slot_passthrough_not_applicable",
                    request: input,
                    mutation_authority: false,
                  }

          if (sourceSlotRehydration.ok !== true) {
            const priorRepairCache =
              state?.sourceSlotRepairCache ?? null
            const modelViewNonRepairable =
              modelViewFailureIsNonRepairable(
                sourceSlotRehydration.reason,
              )
            const repairCache =
              !modelViewNonRepairable &&
              activeSourceSlotContract?.binding
                ? buildSourceSlotRepairCache({
                    binding:
                      activeSourceSlotContract.binding,
                    request: input,
                    failure: sourceSlotRehydration,
                    capability:
                      state?.additiveMutationCapability,
                    executionContextSha256:
                      state?.executionContextCapsuleSha256,
                    priorRepairCache,
                  })
                : null
            const legacyRepairAuthorityOk =
              repairCache?.repairable === true &&
              sourceSlotRepairAuthorityMatches({
                hint: repairCache,
                capability:
                  state?.additiveMutationCapability,
                executionContextSha256:
                  state?.executionContextCapsuleSha256,
                binding:
                  activeSourceSlotContract?.binding ?? null,
              })
            const typedStructuralRepairAuthorityOk =
              repairCache != null &&
              sourceSlotTypedStructuralRepairAuthorityMatches({
                hint: repairCache,
                capability:
                  state?.additiveMutationCapability,
                executionContextSha256:
                  state?.executionContextCapsuleSha256,
                binding:
                  activeSourceSlotContract?.binding ?? null,
              })
            const repairAuthorityOk =
              legacyRepairAuthorityOk ||
              typedStructuralRepairAuthorityOk
            const typedCounterexample =
              activeSourceSlotContract?.binding
                ? deriveSourceSlotCounterexample({
                    failure: sourceSlotRehydration,
                    request: input,
                    binding:
                      activeSourceSlotContract.binding,
                    priorRepairCache,
                  })
                : null
            const repairAdmission =
              state &&
              repairAuthorityOk &&
              typedCounterexample?.ok === true
                ? decideSourceCounterexampleRepairAdmission({
                    counterexample:
                      typedCounterexample,
                    priorLedger:
                      state.sourceCounterexampleLedger,
                    repairDispatches:
                      state.sourceRepairDispatches,
                    failureCount:
                      state.sourceCounterexampleFailures,
                  })
                : null

            if (
              state &&
              repairAuthorityOk &&
              typedCounterexample?.ok === true &&
              repairAdmission?.ok === true
            ) {
              const nextSourceCounterexampleFailures =
                repairAdmission.next_failure_count
              const nextSourceCounterexampleLedger =
                [...repairAdmission.next_ledger]
              const nextRepairAttempts =
                state.executionState === EXEC_STATE_REPAIR
                  ? state.repairAttempts + 1
                  : state.repairAttempts

              if (repairAdmission.admit_retry === true) {
                const nextSourceRepairDispatches =
                  repairAdmission.next_repair_dispatches
                const nextAdditiveRepairLock =
                  Object.freeze({
                    ...repairCache,
                    tool:
                      EXECUTE_ADDITIVE_PLAN_TOOL,
                    typed_counterexample:
                      typedCounterexample,
                  })
                const preparedToolResult =
                  prepareCounterexampleToolResult({
                    protocol:
                      typedCounterexample.protocol,
                    content:
                      `PATCH_RETRY reason=${sourceSlotRehydration.reason} ` +
                      `source_key=${sourceSlotRehydration.source_key ?? "unknown"} ` +
                      "action=revise_failed_source_slot",
                    metadata: {
                      protocol:
                        typedCounterexample.protocol,
                      action: "retry",
                      reason:
                        sourceSlotRehydration.reason,
                      source_key:
                        sourceSlotRehydration.source_key ?? null,
                      preserved_source_keys:
                        Object.keys(
                          repairCache.accepted_sources ?? {},
                        ).sort(),
                      accepted_source_hashes:
                        repairCache.accepted_source_hashes,
                      cache_sha256:
                        repairCache.cache_sha256,
                      typed_counterexample_protocol:
                        typedCounterexample.protocol,
                      typed_counterexample_sha256:
                        typedCounterexample.counterexample_sha256,
                      typed_counterexample_layer:
                        typedCounterexample.layer,
                      typed_counterexample_proof_vector:
                        typedCounterexample.proof_vector,
                      source_counterexample_failures:
                        nextSourceCounterexampleFailures,
                      source_repair_dispatches:
                        nextSourceRepairDispatches,
                      source_repair_admission_reason:
                        repairAdmission.reason,
                      mutation_authority: false,
                    },
                  })

                if (preparedToolResult.ok !== true) {
                  const preparedFailureResult =
                    prepareCounterexampleToolResult({
                      protocol:
                        typedCounterexample.protocol,
                      content:
                        `PATCH_STOP reason=${preparedToolResult.reason} ` +
                        `cause=${sourceSlotRehydration.reason} ` +
                        "action=report_blocked",
                      metadata: {
                        protocol:
                          typedCounterexample.protocol,
                        action: "stop",
                        reason:
                          preparedToolResult.reason,
                        cause:
                          sourceSlotRehydration.reason,
                        mutation_authority: false,
                      },
                    })

                  if (preparedFailureResult.ok !== true) {
                    return {
                      content:
                        "PATCH_STOP reason=counterexample_tool_result_internal_failure " +
                        `cause=${sourceSlotRehydration.reason} ` +
                        "action=report_blocked",
                      metadata: {
                        protocol:
                          typedCounterexample.protocol,
                        action: "stop",
                        reason:
                          "counterexample_tool_result_internal_failure",
                        cause:
                          sourceSlotRehydration.reason,
                        mutation_authority: false,
                      },
                    }
                  }

                  // Terminal transaction commit point: a complete wire-safe
                  // STOP exists before any repair/FSM state mutation.
                  state.sourceSlotRepairCache = null
                  state.additiveRepairLock = null
                  applyExecutionEvent(
                    state,
                    "fatal",
                    preparedToolResult.reason,
                  )
                  return preparedFailureResult.result
                }

                // Transaction commit point: every operation above is pure or
                // local. No repair/FSM state changes occur before the complete
                // tool result has survived a JSON round-trip.
                state.sourceCounterexampleFailures =
                  nextSourceCounterexampleFailures
                state.sourceCounterexampleLedger =
                  nextSourceCounterexampleLedger
                state.repairAttempts =
                  nextRepairAttempts
                state.sourceRepairDispatches =
                  nextSourceRepairDispatches
                state.activeMutationTool =
                  EXECUTE_ADDITIVE_PLAN_TOOL
                state.sourceSlotRepairCache =
                  repairCache
                state.additiveRepairLock =
                  nextAdditiveRepairLock

                applyExecutionEvent(
                  state,
                  "patch_retry",
                  sourceSlotRehydration.reason,
                )

                return preparedToolResult.result
              }
            }

            const compositeCompatibilityRetry =
              state &&
              repairAuthorityOk &&
              sourceSlotRehydration.reason ===
                "source_slot_composite_invalid" &&
              Array.isArray(repairCache?.failed_source_keys) &&
              repairCache.failed_source_keys.length > 0 &&
              state.sourceRepairDispatches === 0

            if (compositeCompatibilityRetry) {
              if (
                state.executionState ===
                  EXEC_STATE_REPAIR
              ) {
                state.repairAttempts += 1
              }
              state.sourceRepairDispatches = 1
              state.activeMutationTool =
                EXECUTE_ADDITIVE_PLAN_TOOL
              state.sourceSlotRepairCache = repairCache
              state.additiveRepairLock =
                Object.freeze({
                  ...repairCache,
                  tool:
                    EXECUTE_ADDITIVE_PLAN_TOOL,
                })
              state.lastSeen = nowMs()
              applyExecutionEvent(
                state,
                "patch_retry",
                sourceSlotRehydration.reason,
              )
              return {
                content:
                  `PATCH_RETRY reason=${sourceSlotRehydration.reason} ` +
                  `source_keys=${repairCache.failed_source_keys.join(",")} ` +
                  "action=revise_failed_source_slots",
                metadata: {
                  protocol:
                    SOURCE_SLOT_REPAIR_PROTOCOL,
                  action: "retry",
                  reason:
                    sourceSlotRehydration.reason,
                  source_key: null,
                  failed_source_keys:
                    repairCache.failed_source_keys,
                  preserved_source_keys:
                    Object.keys(
                      repairCache.accepted_sources ?? {},
                    ).sort(),
                  accepted_source_hashes:
                    repairCache.accepted_source_hashes,
                  cache_sha256:
                    repairCache.cache_sha256,
                  typed_counterexample_protocol: null,
                  typed_counterexample_sha256: null,
                  typed_counterexample_layer:
                    "composite_compatibility",
                  source_counterexample_failures:
                    state.sourceCounterexampleFailures,
                  source_repair_dispatches:
                    state.sourceRepairDispatches,
                  source_repair_admission_reason:
                    "source_counterexample_composite_causal_once",
                  mutation_authority: false,
                },
              }
            }

            if (state) {
              state.sourceSlotRepairCache = null
              state.additiveRepairLock = null
              applyExecutionEvent(
                state,
                "fatal",
                sourceSlotRehydration.reason,
              )
            }
            return {
              content:
                `PATCH_STOP reason=${sourceSlotRehydration.reason} ` +
                `source_key=${sourceSlotRehydration.source_key ?? "unknown"} ` +
                "action=report_blocked",
              metadata: {
                protocol:
                  SOURCE_SLOT_COMPILER_PROTOCOL,
                action: "stop",
                reason:
                  sourceSlotRehydration.reason,
                source_key:
                  sourceSlotRehydration.source_key ?? null,
                typed_counterexample_protocol:
                  typedCounterexample?.ok === true
                    ? typedCounterexample.protocol
                    : null,
                typed_counterexample_sha256:
                  typedCounterexample?.ok === true
                    ? typedCounterexample.counterexample_sha256
                    : null,
                typed_counterexample_layer:
                  typedCounterexample?.ok === true
                    ? typedCounterexample.layer
                    : null,
                source_counterexample_failures:
                  state?.sourceCounterexampleFailures ?? null,
                source_repair_dispatches:
                  state?.sourceRepairDispatches ?? null,
                source_repair_admission_reason:
                  repairAdmission?.reason ??
                  "source_counterexample_not_admitted",
                mutation_authority: false,
              },
            }
          }

          const semanticInput =
            sourceSlotRehydration.request
          const semanticObligationValidation =
            activeSemanticMutationContract?.protocol ===
            SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL
              ? validateSemanticObligationRequest({
                  request: semanticInput,
                  capability:
                    state?.additiveMutationCapability,
                  contract:
                    activeSemanticMutationContract.contract,
                  attestation:
                    activeSemanticMutationContract.attestation,
                })
              : {
                  ok: false,
                  reason:
                    "semantic_obligation_attestation_missing",
                }

          if (semanticObligationValidation.ok !== true) {
            if (state) {
              applyExecutionEvent(
                state,
                "fatal",
                semanticObligationValidation.reason,
              )
            }
            return {
              content:
                `PATCH_STOP reason=${semanticObligationValidation.reason} ` +
                "action=report_blocked",
              metadata: {
                protocol:
                  SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
                action: "stop",
                reason:
                  semanticObligationValidation.reason,
                contract_sha256:
                  activeSemanticMutationContract
                    ?.contract?.contract_sha256 ?? null,
                attestation_sha256:
                  activeSemanticMutationContract
                    ?.attestation?.attestation_sha256 ?? null,
                mutation_authority: false,
              },
            }
          }

          const candidateObligationLedger =
            deriveCandidateObligationLedger({
              request: semanticInput,
              binding:
                activeSourceSlotContract?.binding ?? null,
            })

          const materialized =
            await materializeSemanticAdditiveRequest({
              root,
              capability: state?.additiveMutationCapability,
              request: semanticInput,
              pythonImportHints:
                sourceSlotRehydration.python_import_hints ?? null,
            })

          if (materialized.ok !== true) {
            const sourceRepairCache =
              activeSourceSlotContract?.binding
                ? buildSourceSlotRepairCache({
                    binding:
                      activeSourceSlotContract.binding,
                    request: input,
                    failure: materialized,
                    priorRepairCache:
                      state?.sourceSlotRepairCache ?? null,
                    capability:
                      state?.additiveMutationCapability,
                    executionContextSha256:
                      state?.executionContextCapsuleSha256,
                  })
                : null
            if (
              sourceRepairCache?.repairable === true &&
              sourceSlotRepairAuthorityMatches({
                hint: sourceRepairCache,
                capability:
                  state?.additiveMutationCapability,
                executionContextSha256:
                  state?.executionContextCapsuleSha256,
                binding:
                  activeSourceSlotContract?.binding ?? null,
              })
            ) {
              state.sourceSlotRepairCache =
                sourceRepairCache
            } else if (state) {
              state.sourceSlotRepairCache = null
            }


            // R7-R6: existing-symbol collision is a hard Python frontend
            // witness. Candidate-coherence facts are guidance only; they
            // cannot create or widen repair authority.
            const symbolCollisionRepairEligible =
              materialized.reason ===
                "semantic_python_existing_symbol_forbidden"

            const symbolCollisionRepairAuthorityOk =
              state &&
              symbolCollisionRepairEligible &&
              activeSourceSlotContract?.binding &&
              sourceRepairCache?.repairable === true &&
              Array.isArray(sourceRepairCache.failed_source_keys) &&
              sourceRepairCache.failed_source_keys.length === 1 &&
              sourceSlotRepairAuthorityMatches({
                hint: sourceRepairCache,
                capability: state?.additiveMutationCapability,
                executionContextSha256: state?.executionContextCapsuleSha256,
                binding: activeSourceSlotContract.binding,
              })

            const symbolCollisionCounterexample =
              symbolCollisionRepairAuthorityOk
                ? deriveExistingSymbolSourceCounterexample({
                    failure: materialized,
                    request: input,
                    binding: activeSourceSlotContract.binding,
                    repairCache: sourceRepairCache,
                    candidateLedger:
                      candidateObligationLedger?.ok === true
                        ? candidateObligationLedger
                        : null,
                  })
                : null

            const symbolCollisionRepairAdmission =
              state && symbolCollisionCounterexample?.ok === true
                ? decideSourceCounterexampleRepairAdmission({
                    counterexample: symbolCollisionCounterexample,
                    priorLedger: state.sourceCounterexampleLedger,
                    repairDispatches: state.sourceRepairDispatches,
                    failureCount: state.sourceCounterexampleFailures,
                  })
                : null

            if (
              state &&
              symbolCollisionRepairAuthorityOk &&
              symbolCollisionCounterexample?.ok === true &&
              symbolCollisionRepairAdmission?.ok === true
            ) {
              const nextSourceCounterexampleFailures =
                symbolCollisionRepairAdmission.next_failure_count
              const nextSourceCounterexampleLedger =
                [...symbolCollisionRepairAdmission.next_ledger]
              const nextRepairAttempts =
                state.executionState === EXEC_STATE_REPAIR
                  ? state.repairAttempts + 1
                  : state.repairAttempts

              if (symbolCollisionRepairAdmission.admit_retry === true) {
                const failedSourceKey = sourceRepairCache.failed_source_keys[0]
                const collisionSymbol =
                  symbolCollisionCounterexample.diagnostic.collision_symbol
                const nextSourceRepairDispatches =
                  symbolCollisionRepairAdmission.next_repair_dispatches
                const nextAdditiveRepairLock = Object.freeze({
                  ...sourceRepairCache,
                  tool: EXECUTE_ADDITIVE_PLAN_TOOL,
                  typed_counterexample: symbolCollisionCounterexample,
                })

                const preparedToolResult = prepareCounterexampleToolResult({
                  protocol: symbolCollisionCounterexample.protocol,
                  content:
                    `PATCH_RETRY reason=${materialized.reason} ` +
                    `source_key=${failedSourceKey} ` +
                    `collision_symbol=${collisionSymbol} ` +
                    "action=revise_failed_source_slot",
                  metadata: {
                    protocol: symbolCollisionCounterexample.protocol,
                    action: "retry",
                    reason: materialized.reason,
                    source_key: failedSourceKey,
                    operation_id: symbolCollisionCounterexample.operation_id,
                    operation_index: symbolCollisionCounterexample.operation_index,
                    collision_symbol: collisionSymbol,
                    preserved_source_keys: Object.keys(
                      sourceRepairCache.accepted_sources ?? {},
                    ).sort(),
                    accepted_source_hashes: sourceRepairCache.accepted_source_hashes,
                    source_repair_cache_sha256: sourceRepairCache.cache_sha256,
                    typed_counterexample_protocol: symbolCollisionCounterexample.protocol,
                    typed_counterexample_sha256: symbolCollisionCounterexample.counterexample_sha256,
                    typed_counterexample_layer: symbolCollisionCounterexample.layer,
                    typed_counterexample_proof_vector: symbolCollisionCounterexample.proof_vector,
                    candidate_obligation_ledger_protocol:
                      candidateObligationLedger?.ok === true
                        ? candidateObligationLedger.protocol
                        : null,
                    candidate_obligation_ledger_sha256:
                      symbolCollisionCounterexample.diagnostic.candidate_obligation_ledger_sha256,
                    candidate_guidance_authority:
                      symbolCollisionCounterexample.diagnostic.candidate_guidance_authority,
                    candidate_consensus_reference:
                      symbolCollisionCounterexample.diagnostic.consensus_reference_name,
                    candidate_consensus_symbol:
                      symbolCollisionCounterexample.diagnostic.consensus_symbol,
                    source_counterexample_failures: nextSourceCounterexampleFailures,
                    source_repair_dispatches: nextSourceRepairDispatches,
                    source_repair_admission_reason: symbolCollisionRepairAdmission.reason,
                    semantic_attempt_consumed: false,
                    compiler_run: false,
                    executor_run: false,
                    mutation_authority: false,
                  },
                })

                if (preparedToolResult.ok !== true) {
                  const preparedFailureResult = prepareCounterexampleToolResult({
                    protocol: symbolCollisionCounterexample.protocol,
                    content:
                      `PATCH_STOP reason=${preparedToolResult.reason} ` +
                      `cause=${materialized.reason} action=report_blocked`,
                    metadata: {
                      protocol: symbolCollisionCounterexample.protocol,
                      action: "stop",
                      reason: preparedToolResult.reason,
                      cause: materialized.reason,
                      mutation_authority: false,
                    },
                  })

                  if (preparedFailureResult.ok !== true) {
                    return {
                      content:
                        "PATCH_STOP reason=counterexample_tool_result_internal_failure " +
                        `cause=${materialized.reason} action=report_blocked`,
                      metadata: {
                        protocol: symbolCollisionCounterexample.protocol,
                        action: "stop",
                        reason: "counterexample_tool_result_internal_failure",
                        cause: materialized.reason,
                        mutation_authority: false,
                      },
                    }
                  }

                  // Terminal transaction commit point: STOP is wire-safe first.
                  state.sourceSlotRepairCache = null
                  state.additiveRepairLock = null
                  applyExecutionEvent(state, "fatal", preparedToolResult.reason)
                  return preparedFailureResult.result
                }

                // Transaction commit point: candidate observation never mutates
                // authority; RETRY is wire-safe before any FSM/ledger commit.
                state.sourceCounterexampleFailures = nextSourceCounterexampleFailures
                state.sourceCounterexampleLedger = nextSourceCounterexampleLedger
                state.repairAttempts = nextRepairAttempts
                state.sourceRepairDispatches = nextSourceRepairDispatches
                state.activeMutationTool = EXECUTE_ADDITIVE_PLAN_TOOL
                state.sourceSlotRepairCache = sourceRepairCache
                state.additiveRepairLock = nextAdditiveRepairLock
                applyExecutionEvent(state, "patch_retry", materialized.reason)
                return preparedToolResult.result
              }

              const preparedStopResult = prepareCounterexampleToolResult({
                protocol: symbolCollisionCounterexample.protocol,
                content:
                  `PATCH_STOP reason=${symbolCollisionRepairAdmission.reason} ` +
                  `cause=${materialized.reason} ` +
                  `source_key=${symbolCollisionCounterexample.source_key} ` +
                  "action=report_blocked",
                metadata: {
                  protocol: symbolCollisionCounterexample.protocol,
                  action: "stop",
                  reason: symbolCollisionRepairAdmission.reason,
                  cause: materialized.reason,
                  source_key: symbolCollisionCounterexample.source_key,
                  collision_symbol: symbolCollisionCounterexample.diagnostic.collision_symbol,
                  typed_counterexample_protocol: symbolCollisionCounterexample.protocol,
                  typed_counterexample_sha256: symbolCollisionCounterexample.counterexample_sha256,
                  candidate_obligation_ledger_sha256:
                    symbolCollisionCounterexample.diagnostic.candidate_obligation_ledger_sha256,
                  source_counterexample_failures: nextSourceCounterexampleFailures,
                  source_repair_dispatches: state.sourceRepairDispatches,
                  semantic_attempt_consumed: false,
                  mutation_authority: false,
                },
              })

              if (preparedStopResult.ok !== true) {
                return {
                  content:
                    "PATCH_STOP reason=counterexample_tool_result_internal_failure " +
                    `cause=${materialized.reason} action=report_blocked`,
                  metadata: {
                    protocol: symbolCollisionCounterexample.protocol,
                    action: "stop",
                    reason: "counterexample_tool_result_internal_failure",
                    cause: materialized.reason,
                    mutation_authority: false,
                  },
                }
              }

              // Terminal transaction commit point: STOP is wire-safe first.
              state.sourceCounterexampleFailures = nextSourceCounterexampleFailures
              state.sourceCounterexampleLedger = nextSourceCounterexampleLedger
              state.repairAttempts = nextRepairAttempts
              state.sourceSlotRepairCache = null
              state.additiveRepairLock = null
              applyExecutionEvent(state, "fatal", symbolCollisionRepairAdmission.reason)
              return preparedStopResult.result
            }

            // R7-R4-H: an exact existing-route collision is a deterministic
            // negative witness. Under sealed single-source authority it may
            // re-open only that source slot; the collision guard itself stays
            // unchanged and legacy/no-source-slot behavior remains terminal.
            const routeCollisionRepairEligible =
              materialized.reason ===
                "semantic_python_existing_route_forbidden"
            const routeCollisionRepairAuthorityOk =
              state &&
              routeCollisionRepairEligible &&
              activeSourceSlotContract?.binding &&
              sourceRepairCache?.repairable === true &&
              Array.isArray(
                sourceRepairCache.failed_source_keys,
              ) &&
              sourceRepairCache.failed_source_keys.length === 1 &&
              sourceSlotRepairAuthorityMatches({
                hint: sourceRepairCache,
                capability:
                  state?.additiveMutationCapability,
                executionContextSha256:
                  state?.executionContextCapsuleSha256,
                binding:
                  activeSourceSlotContract.binding,
              })

            const routeCollisionCounterexample =
              routeCollisionRepairAuthorityOk
                ? deriveExistingRouteSourceCounterexample({
                    failure: materialized,
                    request: input,
                    binding:
                      activeSourceSlotContract.binding,
                    repairCache:
                      sourceRepairCache,
                  })
                : null

            const routeCollisionRepairAdmission =
              state &&
              routeCollisionCounterexample?.ok === true
                ? decideSourceCounterexampleRepairAdmission({
                    counterexample:
                      routeCollisionCounterexample,
                    priorLedger:
                      state.sourceCounterexampleLedger,
                    repairDispatches:
                      state.sourceRepairDispatches,
                    failureCount:
                      state.sourceCounterexampleFailures,
                  })
                : null

            if (
              state &&
              routeCollisionRepairAuthorityOk &&
              routeCollisionCounterexample?.ok === true &&
              routeCollisionRepairAdmission?.ok === true
            ) {
              const nextSourceCounterexampleFailures =
                routeCollisionRepairAdmission.next_failure_count
              const nextSourceCounterexampleLedger =
                [...routeCollisionRepairAdmission.next_ledger]
              const nextRepairAttempts =
                state.executionState === EXEC_STATE_REPAIR
                  ? state.repairAttempts + 1
                  : state.repairAttempts

              if (
                routeCollisionRepairAdmission.admit_retry === true
              ) {
                const failedSourceKey =
                  sourceRepairCache.failed_source_keys[0]
                const collisionRoute =
                  routeCollisionCounterexample
                    .diagnostic.collision_route
                const nextSourceRepairDispatches =
                  routeCollisionRepairAdmission
                    .next_repair_dispatches
                const nextAdditiveRepairLock =
                  Object.freeze({
                    ...sourceRepairCache,
                    tool:
                      EXECUTE_ADDITIVE_PLAN_TOOL,
                    typed_counterexample:
                      routeCollisionCounterexample,
                  })

                const preparedToolResult =
                  prepareCounterexampleToolResult({
                    protocol:
                      routeCollisionCounterexample.protocol,
                    content:
                      `PATCH_RETRY reason=${materialized.reason} ` +
                      `source_key=${failedSourceKey} ` +
                      `collision_route=${JSON.stringify(collisionRoute)} ` +
                      "action=revise_failed_source_slot",
                    metadata: {
                      protocol:
                        routeCollisionCounterexample.protocol,
                      action: "retry",
                      reason:
                        materialized.reason,
                      source_key:
                        failedSourceKey,
                      operation_id:
                        routeCollisionCounterexample.operation_id,
                      operation_index:
                        routeCollisionCounterexample.operation_index,
                      collision_route:
                        collisionRoute,
                      preserved_source_keys:
                        Object.keys(
                          sourceRepairCache.accepted_sources ?? {},
                        ).sort(),
                      accepted_source_hashes:
                        sourceRepairCache.accepted_source_hashes,
                      source_repair_cache_sha256:
                        sourceRepairCache.cache_sha256,
                      typed_counterexample_protocol:
                        routeCollisionCounterexample.protocol,
                      typed_counterexample_sha256:
                        routeCollisionCounterexample
                          .counterexample_sha256,
                      typed_counterexample_layer:
                        routeCollisionCounterexample.layer,
                      typed_counterexample_proof_vector:
                        routeCollisionCounterexample.proof_vector,
                      source_counterexample_failures:
                        nextSourceCounterexampleFailures,
                      source_repair_dispatches:
                        nextSourceRepairDispatches,
                      source_repair_admission_reason:
                        routeCollisionRepairAdmission.reason,
                      semantic_attempt_consumed: false,
                      compiler_run: false,
                      executor_run: false,
                      mutation_authority: false,
                    },
                  })

                if (preparedToolResult.ok !== true) {
                  const preparedFailureResult =
                    prepareCounterexampleToolResult({
                      protocol:
                        routeCollisionCounterexample.protocol,
                      content:
                        `PATCH_STOP reason=${preparedToolResult.reason} ` +
                        `cause=${materialized.reason} ` +
                        "action=report_blocked",
                      metadata: {
                        protocol:
                          routeCollisionCounterexample.protocol,
                        action: "stop",
                        reason:
                          preparedToolResult.reason,
                        cause:
                          materialized.reason,
                        mutation_authority: false,
                      },
                    })

                  if (preparedFailureResult.ok !== true) {
                    return {
                      content:
                        "PATCH_STOP reason=counterexample_tool_result_internal_failure " +
                        `cause=${materialized.reason} ` +
                        "action=report_blocked",
                      metadata: {
                        protocol:
                          routeCollisionCounterexample.protocol,
                        action: "stop",
                        reason:
                          "counterexample_tool_result_internal_failure",
                        cause:
                          materialized.reason,
                        mutation_authority: false,
                      },
                    }
                  }

                  // Terminal transaction commit point: a complete wire-safe
                  // STOP exists before any repair/FSM state mutation.
                  state.sourceSlotRepairCache = null
                  state.additiveRepairLock = null
                  applyExecutionEvent(
                    state,
                    "fatal",
                    preparedToolResult.reason,
                  )
                  return preparedFailureResult.result
                }

                // Transaction commit point: the complete wire result is already
                // JSON-roundtripped before any counterexample/FSM state change.
                state.sourceCounterexampleFailures =
                  nextSourceCounterexampleFailures
                state.sourceCounterexampleLedger =
                  nextSourceCounterexampleLedger
                state.repairAttempts =
                  nextRepairAttempts
                state.sourceRepairDispatches =
                  nextSourceRepairDispatches
                state.activeMutationTool =
                  EXECUTE_ADDITIVE_PLAN_TOOL
                state.sourceSlotRepairCache =
                  sourceRepairCache
                state.additiveRepairLock =
                  nextAdditiveRepairLock

                applyExecutionEvent(
                  state,
                  "patch_retry",
                  materialized.reason,
                )

                return preparedToolResult.result
              }

              const preparedStopResult =
                prepareCounterexampleToolResult({
                  protocol:
                    routeCollisionCounterexample.protocol,
                  content:
                    `PATCH_STOP reason=${routeCollisionRepairAdmission.reason} ` +
                    `cause=${materialized.reason} ` +
                    `source_key=${routeCollisionCounterexample.source_key} ` +
                    "action=report_blocked",
                  metadata: {
                    protocol:
                      routeCollisionCounterexample.protocol,
                    action: "stop",
                    reason:
                      routeCollisionRepairAdmission.reason,
                    cause:
                      materialized.reason,
                    source_key:
                      routeCollisionCounterexample.source_key,
                    collision_route:
                      routeCollisionCounterexample
                        .diagnostic.collision_route,
                    typed_counterexample_protocol:
                      routeCollisionCounterexample.protocol,
                    typed_counterexample_sha256:
                      routeCollisionCounterexample
                        .counterexample_sha256,
                    source_counterexample_failures:
                      nextSourceCounterexampleFailures,
                    source_repair_dispatches:
                      state.sourceRepairDispatches,
                    semantic_attempt_consumed: false,
                    mutation_authority: false,
                  },
                })

              if (preparedStopResult.ok !== true) {
                return {
                  content:
                    "PATCH_STOP reason=counterexample_tool_result_internal_failure " +
                    `cause=${materialized.reason} ` +
                    "action=report_blocked",
                  metadata: {
                    protocol:
                      routeCollisionCounterexample.protocol,
                    action: "stop",
                    reason:
                      "counterexample_tool_result_internal_failure",
                    cause:
                      materialized.reason,
                    mutation_authority: false,
                  },
                }
              }

              // Terminal transaction commit point: the STOP result is wire-safe
              // before ledger/cache/FSM state changes.
              state.sourceCounterexampleFailures =
                nextSourceCounterexampleFailures
              state.sourceCounterexampleLedger =
                nextSourceCounterexampleLedger
              state.repairAttempts =
                nextRepairAttempts
              state.sourceSlotRepairCache = null
              state.additiveRepairLock = null

              applyExecutionEvent(
                state,
                "fatal",
                routeCollisionRepairAdmission.reason,
              )

              return preparedStopResult.result
            }

            // R7-R4-G: a deterministic semantic binding counterexample may
            // re-open exactly one sealed source slot. Legacy semantic repair
            // policy remains unchanged outside this authority-bound path.
            const semanticSourceRepairEligible =
              materialized.reason ===
                "semantic_python_binding_unresolved"
            const semanticSourceRepairAuthorityOk =
              state &&
              semanticSourceRepairEligible &&
              activeSourceSlotContract?.binding &&
              sourceRepairCache?.repairable === true &&
              Array.isArray(
                sourceRepairCache.failed_source_keys,
              ) &&
              sourceRepairCache.failed_source_keys.length === 1 &&
              sourceSlotRepairAuthorityMatches({
                hint: sourceRepairCache,
                capability:
                  state?.additiveMutationCapability,
                executionContextSha256:
                  state?.executionContextCapsuleSha256,
                binding:
                  activeSourceSlotContract.binding,
              })

            const semanticSourceCounterexample =
              semanticSourceRepairAuthorityOk
                ? deriveSemanticSourceCounterexample({
                    failure: materialized,
                    request: input,
                    binding:
                      activeSourceSlotContract.binding,
                    repairCache:
                      sourceRepairCache,
                  })
                : null

            const semanticSourceRepairAdmission =
              state &&
              semanticSourceCounterexample?.ok === true
                ? decideSourceCounterexampleRepairAdmission({
                    counterexample:
                      semanticSourceCounterexample,
                    priorLedger:
                      state.sourceCounterexampleLedger,
                    repairDispatches:
                      state.sourceRepairDispatches,
                    failureCount:
                      state.sourceCounterexampleFailures,
                  })
                : null

            if (
              state &&
              semanticSourceRepairAuthorityOk &&
              semanticSourceCounterexample?.ok === true &&
              semanticSourceRepairAdmission?.ok === true
            ) {
              const nextSourceCounterexampleFailures =
                semanticSourceRepairAdmission.next_failure_count
              const nextSourceCounterexampleLedger =
                [...semanticSourceRepairAdmission.next_ledger]
              const nextRepairAttempts =
                state.executionState === EXEC_STATE_REPAIR
                  ? state.repairAttempts + 1
                  : state.repairAttempts

              if (
                semanticSourceRepairAdmission.admit_retry === true
              ) {
                const failedSourceKey =
                  sourceRepairCache.failed_source_keys[0]
                const unresolvedSymbol =
                  semanticSourceCounterexample
                    .diagnostic.symbol
                const nextSourceRepairDispatches =
                  semanticSourceRepairAdmission
                    .next_repair_dispatches
                const nextAdditiveRepairLock =
                  Object.freeze({
                    ...sourceRepairCache,
                    tool:
                      EXECUTE_ADDITIVE_PLAN_TOOL,
                    typed_counterexample:
                      semanticSourceCounterexample,
                  })

                const preparedToolResult =
                  prepareCounterexampleToolResult({
                    protocol:
                      semanticSourceCounterexample.protocol,
                    content:
                      `PATCH_RETRY reason=${materialized.reason} ` +
                      `source_key=${failedSourceKey} ` +
                      `unresolved=${unresolvedSymbol} ` +
                      "action=revise_failed_source_slot",
                    metadata: {
                      protocol:
                        semanticSourceCounterexample.protocol,
                      action: "retry",
                      reason:
                        materialized.reason,
                      source_key:
                        failedSourceKey,
                      operation_id:
                        semanticSourceCounterexample.operation_id,
                      operation_index:
                        semanticSourceCounterexample.operation_index,
                      unresolved_symbol:
                        unresolvedSymbol,
                      preserved_source_keys:
                        Object.keys(
                          sourceRepairCache.accepted_sources ?? {},
                        ).sort(),
                      accepted_source_hashes:
                        sourceRepairCache.accepted_source_hashes,
                      source_repair_cache_sha256:
                        sourceRepairCache.cache_sha256,
                      typed_counterexample_protocol:
                        semanticSourceCounterexample.protocol,
                      typed_counterexample_sha256:
                        semanticSourceCounterexample
                          .counterexample_sha256,
                      typed_counterexample_layer:
                        semanticSourceCounterexample.layer,
                      typed_counterexample_proof_vector:
                        semanticSourceCounterexample.proof_vector,
                      source_counterexample_failures:
                        nextSourceCounterexampleFailures,
                      source_repair_dispatches:
                        nextSourceRepairDispatches,
                      source_repair_admission_reason:
                        semanticSourceRepairAdmission.reason,
                      semantic_attempt_consumed: false,
                      compiler_run: false,
                      executor_run: false,
                      mutation_authority: false,
                    },
                  })

                if (preparedToolResult.ok !== true) {
                  const preparedFailureResult =
                    prepareCounterexampleToolResult({
                      protocol:
                        semanticSourceCounterexample.protocol,
                      content:
                        `PATCH_STOP reason=${preparedToolResult.reason} ` +
                        `cause=${materialized.reason} ` +
                        "action=report_blocked",
                      metadata: {
                        protocol:
                          semanticSourceCounterexample.protocol,
                        action: "stop",
                        reason:
                          preparedToolResult.reason,
                        cause:
                          materialized.reason,
                        mutation_authority: false,
                      },
                    })

                  if (preparedFailureResult.ok !== true) {
                    return {
                      content:
                        "PATCH_STOP reason=counterexample_tool_result_internal_failure " +
                        `cause=${materialized.reason} ` +
                        "action=report_blocked",
                      metadata: {
                        protocol:
                          semanticSourceCounterexample.protocol,
                        action: "stop",
                        reason:
                          "counterexample_tool_result_internal_failure",
                        cause:
                          materialized.reason,
                        mutation_authority: false,
                      },
                    }
                  }

                  // Terminal transaction commit point: a complete wire-safe
                  // STOP exists before any repair/FSM state mutation.
                  state.sourceSlotRepairCache = null
                  state.additiveRepairLock = null
                  applyExecutionEvent(
                    state,
                    "fatal",
                    preparedToolResult.reason,
                  )
                  return preparedFailureResult.result
                }

                // Transaction commit point: no counterexample/FSM state writes
                // happen before the complete tool result is wire-safe.
                state.sourceCounterexampleFailures =
                  nextSourceCounterexampleFailures
                state.sourceCounterexampleLedger =
                  nextSourceCounterexampleLedger
                state.repairAttempts =
                  nextRepairAttempts
                state.sourceRepairDispatches =
                  nextSourceRepairDispatches
                state.activeMutationTool =
                  EXECUTE_ADDITIVE_PLAN_TOOL
                state.sourceSlotRepairCache =
                  sourceRepairCache
                state.additiveRepairLock =
                  nextAdditiveRepairLock

                applyExecutionEvent(
                  state,
                  "patch_retry",
                  materialized.reason,
                )

                return preparedToolResult.result
              }

              const preparedStopResult =
                prepareCounterexampleToolResult({
                  protocol:
                    semanticSourceCounterexample.protocol,
                  content:
                    `PATCH_STOP reason=${semanticSourceRepairAdmission.reason} ` +
                    `cause=${materialized.reason} ` +
                    `source_key=${semanticSourceCounterexample.source_key} ` +
                    "action=report_blocked",
                  metadata: {
                    protocol:
                      semanticSourceCounterexample.protocol,
                    action: "stop",
                    reason:
                      semanticSourceRepairAdmission.reason,
                    cause:
                      materialized.reason,
                    source_key:
                      semanticSourceCounterexample.source_key,
                    unresolved_symbol:
                      semanticSourceCounterexample
                        .diagnostic.symbol,
                    typed_counterexample_protocol:
                      semanticSourceCounterexample.protocol,
                    typed_counterexample_sha256:
                      semanticSourceCounterexample
                        .counterexample_sha256,
                    source_counterexample_failures:
                      nextSourceCounterexampleFailures,
                    source_repair_dispatches:
                      state.sourceRepairDispatches,
                    semantic_attempt_consumed: false,
                    mutation_authority: false,
                  },
                })

              if (preparedStopResult.ok !== true) {
                return {
                  content:
                    "PATCH_STOP reason=counterexample_tool_result_internal_failure " +
                    `cause=${materialized.reason} ` +
                    "action=report_blocked",
                  metadata: {
                    protocol:
                      semanticSourceCounterexample.protocol,
                    action: "stop",
                    reason:
                      "counterexample_tool_result_internal_failure",
                    cause:
                      materialized.reason,
                    mutation_authority: false,
                  },
                }
              }

              // Terminal transaction commit point: the STOP result is wire-safe
              // before ledger/cache/FSM state changes.
              state.sourceCounterexampleFailures =
                nextSourceCounterexampleFailures
              state.sourceCounterexampleLedger =
                nextSourceCounterexampleLedger
              state.repairAttempts =
                nextRepairAttempts
              state.sourceSlotRepairCache = null
              state.additiveRepairLock = null

              applyExecutionEvent(
                state,
                "fatal",
                semanticSourceRepairAdmission.reason,
              )

              return preparedStopResult.result
            }

            const fileFamilyRepairable =
              materialized.reason ===
                "semantic_file_family_mismatch"

            const pythonSemanticRepairable =
              pythonSemanticFailureIsRepairable(
                materialized,
              )

            if (
              state &&
              (
                fileFamilyRepairable ||
                pythonSemanticRepairable
              )
            ) {
              if (
                state.activeMutationTool &&
                state.activeMutationTool !==
                  EXECUTE_ADDITIVE_PLAN_TOOL
              ) {
                state.additiveRepairLock = null
                applyExecutionEvent(
                  state,
                  "fatal",
                  "mutation_action_changed_during_attempt",
                )

                return {
                  content:
                    "PATCH_STOP " +
                    "reason=mutation_action_changed_during_attempt " +
                    "action=report_blocked",
                  metadata: {
                    protocol:
                      SEMANTIC_CONTENT_IR_PROTOCOL,
                    action: "stop",
                    reason:
                      "mutation_action_changed_during_attempt",
                    failure_layer:
                      "orchestrator_contract",
                    mutation_authority: false,
                  },
                }
              }

              if (
                state.mutationAttempts <
                MAX_PATCH_ATTEMPTS_PER_TURN
              ) {
                state.activeMutationTool =
                  EXECUTE_ADDITIVE_PLAN_TOOL

                if (
                  state.executionState ===
                  EXEC_STATE_REPAIR
                ) {
                  state.repairAttempts += 1
                }

                state.mutationAttempts += 1
                state.lastSeen = nowMs()

                const repairHint =
                  fileFamilyRepairable
                    ? buildFileFamilyRepairHint({
                        failure: materialized,
                        capability:
                          state.additiveMutationCapability,
                        request: semanticInput,
                        executionContextSha256:
                          state.executionContextCapsuleSha256,
                      })
                    : buildPythonSemanticRepairHint({
                        failure: materialized,
                        capability:
                          state.additiveMutationCapability,
                        request: semanticInput,
                        executionContextSha256:
                          state.executionContextCapsuleSha256,
                      })

                const repairAuthorityOk =
                  fileFamilyRepairable
                    ? fileFamilyRepairAuthorityMatches({
                        hint: repairHint,
                        capability:
                          state.additiveMutationCapability,
                        executionContextSha256:
                          state.executionContextCapsuleSha256,
                      })
                    : pythonSemanticRepairAuthorityMatches({
                        hint: repairHint,
                        capability:
                          state.additiveMutationCapability,
                        executionContextSha256:
                          state.executionContextCapsuleSha256,
                      })

                if (
                  repairHint.repairable === true &&
                  repairAuthorityOk &&
                  state.mutationAttempts <
                    MAX_PATCH_ATTEMPTS_PER_TURN
                ) {
                  state.additiveRepairLock =
                    Object.freeze({
                      ...repairHint,
                      tool:
                        EXECUTE_ADDITIVE_PLAN_TOOL,
                    })

                  applyExecutionEvent(
                    state,
                    "patch_retry",
                    materialized.reason,
                  )

                  return {
                    content:
                      `PATCH_RETRY reason=${materialized.reason} ` +
                      `operation_id=${materialized.operation_id ?? materialized.id ?? "unknown"} ` +
                      `unit_index=${materialized.unit_index ?? "unknown"} ` +
                      `suite_index=${materialized.suite_index ?? "unknown"} ` +
                      `field=${materialized.field ?? "unknown"} ` +
                `symbol=${materialized.symbol ?? "unknown"} ` +
                      `expected_family=${materialized.file_family ?? "unknown"} ` +
                      `expected_representation=${materialized.representation ?? "unknown"} ` +
                      `attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} ` +
                      "action=revise_additive_transaction",
                    metadata: {
                      protocol:
                        SEMANTIC_CONTENT_IR_PROTOCOL,
                      materializer_protocol:
                        materialized.protocol ??
                        null,
                      repair_protocol:
                        repairHint.protocol ??
                        null,
                      action: "retry",
                      reason:
                        materialized.reason,
                      failure_layer:
                        "synthesis_validation",
                      operation_id:
                        materialized.operation_id ??
                        materialized.id ??
                        null,
                      operation_index:
                        materialized.operation_index ??
                        null,
                      unit_index:
                        materialized.unit_index ??
                        null,
                      unit_path:
                        materialized.unit_path ??
                        null,
                      suite_index:
                        materialized.suite_index ??
                        null,
                      field:
                        materialized.field ??
                        null,
                      symbol:
                        materialized.symbol ??
                        null,
                      free_names:
                        Array.isArray(materialized.free_names)
                          ? [...materialized.free_names]
                          : null,
                      free_names_total:
                        materialized.free_names_total ??
                        null,
                      free_names_truncated:
                        materialized.free_names_truncated === true,
                      repo_python_files_scanned:
                        materialized.repo_python_files_scanned ??
                        null,
                      repo_python_bytes_scanned:
                        materialized.repo_python_bytes_scanned ??
                        null,
                      diagnostic_authority:
                        materialized.diagnostic_authority ??
                        null,
                      file_family:
                        materialized.file_family ??
                        null,
                      representation:
                        materialized.representation ??
                        null,
                      foreign_family:
                        materialized.foreign_family ??
                        null,
                      mutation_authority: false,
                    },
                  }
                }
              }

              state.additiveRepairLock = null
            }

            if (state) {
              state.sourceSlotRepairCache = null
              applyExecutionEvent(
                state,
                "fatal",
                materialized.reason,
              )
            }

            return {
              content:
                `PATCH_STOP reason=${materialized.reason} ` +
                `operation_id=${materialized.operation_id ?? materialized.id ?? "unknown"} ` +
                `unit_index=${materialized.unit_index ?? "unknown"} ` +
                `suite_index=${materialized.suite_index ?? "unknown"} ` +
                `field=${materialized.field ?? "unknown"} ` +
                `symbol=${materialized.symbol ?? "unknown"} ` +
                `expected_family=${materialized.file_family ?? "unknown"} ` +
                `expected_representation=${materialized.representation ?? "unknown"} ` +
                "action=report_blocked",
              metadata: {
                protocol:
                  SEMANTIC_CONTENT_IR_PROTOCOL,
                materializer_protocol:
                  materialized.protocol ??
                  null,
                action: "stop",
                reason:
                  materialized.reason,
                failure_layer:
                  (
                    fileFamilyRepairable ||
                    pythonSemanticRepairable
                  )
                    ? "synthesis_validation"
                    : "semantic_materialization",
                operation_id:
                  materialized.operation_id ??
                  materialized.id ??
                  null,
                operation_index:
                  materialized.operation_index ??
                  null,
                unit_index:
                  materialized.unit_index ??
                  null,
                unit_path:
                  materialized.unit_path ??
                  null,
                suite_index:
                  materialized.suite_index ??
                  null,
                field:
                  materialized.field ??
                  null,
                symbol:
                  materialized.symbol ??
                  null,
                free_names:
                  Array.isArray(materialized.free_names)
                    ? [...materialized.free_names]
                    : null,
                free_names_total:
                  materialized.free_names_total ??
                  null,
                free_names_truncated:
                  materialized.free_names_truncated === true,
                repo_python_files_scanned:
                  materialized.repo_python_files_scanned ??
                  null,
                repo_python_bytes_scanned:
                  materialized.repo_python_bytes_scanned ??
                  null,
                diagnostic_authority:
                  materialized.diagnostic_authority ??
                  null,
                file_family:
                  materialized.file_family ??
                  null,
                representation:
                  materialized.representation ??
                  null,
                foreign_family:
                  materialized.foreign_family ??
                  null,
                mutation_authority: false,
              },
            }
          }

          try {
            const physicalResult =
              await executeCapabilityMutationCore(
                materialized.request,
                toolContext,
                "additive_surface",
                EXECUTE_ADDITIVE_PLAN_TOOL,
              )
          if (
            state &&
            typeof physicalResult?.content === "string" &&
            physicalResult.content.includes("PATCH_READY")
          ) {
            state.sourceSlotRepairCache = null
          }
          return physicalResult
          } catch (error) {
            const runtimeFaultName =
              typeof error?.name === "string" &&
              error.name.length > 0
                ? error.name
                : "Error"
            const runtimeFaultMessage =
              String(
                error?.message ??
                error ??
                "unknown runtime fault",
              )
                .replace(/\s+/gu, " ")
                .slice(0, 240)
            const runtimeFaultDetail =
              `${runtimeFaultName}: ${runtimeFaultMessage}`

            if (state) {
              state.sourceSlotRepairCache = null
              state.additiveRepairLock = null
              applyExecutionEvent(
                state,
                "fatal",
                "tool_runtime_fault",
              )
            }

            try {
              await writeProjectTrace(
                root,
                "executor-trace.jsonl",
                {
                  ts: nowMs(),
                  protocol: EXECUTION_LOOP_PROTOCOL,
                  sessionID,
                  turnID: state?.turnID ?? null,
                  project_root: root,
                  failure_layer: "runtime_fault",
                  reason: "tool_runtime_fault",
                  runtime_fault_name: runtimeFaultName,
                  runtime_fault_message: runtimeFaultMessage,
                  action: "stop",
                  compiler_run: false,
                  executor_run: false,
                  mutation_authority: false,
                },
              )
            } catch {
              // Telemetry is best-effort. Fault containment must not escape.
            }

            return {
              content:
                "PATCH_STOP reason=tool_runtime_fault " +
                "action=report_blocked",
              metadata: {
                protocol: EXECUTION_LOOP_PROTOCOL,
                action: "stop",
                reason: "tool_runtime_fault",
                failure_layer: "runtime_fault",
                detail: runtimeFaultDetail,
                runtime_fault_name: runtimeFaultName,
                runtime_fault_message: runtimeFaultMessage,
                semantic_attempt_consumed: false,
                compiler_run: false,
                executor_run: false,
                mutation_authority: false,
              },
            }
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

    if (
      !ctx?.aisdk ||
      typeof ctx.aisdk.hook !== "function"
    ) {
      throw new Error(
        "CPU_AGENT bounded_mutation_inference_language_hook_unavailable",
      )
    }

    await track(
      ctx.aisdk.hook("language", (event) => {
        const modelID =
          event?.model?.api?.id ??
          event?.model?.modelID ??
          event?.model?.id ??
          null

        const baseLanguage =
          event?.language ??
          (
            typeof event?.sdk?.languageModel === "function" &&
            typeof modelID === "string" &&
            modelID.length > 0
              ? event.sdk.languageModel(modelID)
              : null
          )

        if (!baseLanguage) {
          throw new Error(
            "CPU_AGENT bounded_mutation_inference_language_unavailable",
          )
        }

        const modelOutputLimitCandidates = [
          event?.model?.limit?.output,
          event?.model?.limits?.output,
        ]
        const modelOutputLimit =
          modelOutputLimitCandidates.find(
            (value) =>
              Number.isFinite(Number(value)) &&
              Number(value) > 0,
          ) ?? null

        event.language =
          wrapExecutionControlledLanguage(
            wrapBoundedMutationLanguage(
              baseLanguage,
              {
                providerID:
                  event?.model?.providerID ?? null,
                modelID,
                modelOutputLimit,
              },
            ),
          )
      }),
    )

    /*
     * R7-R23 Native Provider Wire Authority.
     * Native OpenAI-compatible routes can bypass the AISDK language
     * wrapper, so the actual Request is the final enforcement boundary.
     */
    await track(
      ctx.session.hook(
        "http.request",
        async (event) => {
          await rewriteNativeOpenAICompatibleMutationRequest(
            event,
            {
              mutationToolNames:
                MUTATION_TOOL_NAMES,
            },
          )
        },
      ),
    )

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

      // C10-R3A:
      // task wall time is retained strictly as an SLA/cost observation.
      // It has no cancellation or solver authority. Execution terminates on
      // VERIFIED, impossible deterministic frontier, bounded-attempt
      // exhaustion, or proven no-progress instead.
      const executionControlTaskDeadlineAtMs =
        (
          state.governorTaskStartedAt ??
          state.turnStartedAt
        ) +
        (
          MAX_TURN_WALL_MS *
          GOVERNOR_MAX_ACTIVE_PHASES
        )

      state.executionControlTaskDeadlineAtMs =
        executionControlTaskDeadlineAtMs

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
        process.env.OPENCODE_CPU_ONE_CALL_EXECUTOR !== "0"
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

        const boundExecutionContextRequired =
          state.additiveMutationCapability?.ready === true &&
          state.additiveMutationCapability
            ?.mutation_authority === true
        const modelContextCompilerPolicy =
          resolveModelContextCompilerPolicy(
            process.env.OPENCODE_CPU_MODEL_CONTEXT_COMPILER,
            {
              boundExecutionContextRequired,
            },
          )
        const modelContextCompilerMode =
          modelContextCompilerPolicy.effective_mode
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

        if (
          modelContextCompilerPolicy.blocked === true
        ) {
          state.executionContextBlockReason =
            modelContextCompilerPolicy.reason
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

        if (
          boundExecutionContextRequired &&
          modelContextCompilerPolicy.blocked !== true &&
          state.executionContextBlockReason == null &&
          (
            modelContextSelectedSource !==
              "compiled_execution_capsule" ||
            typeof state
              .executionContextCapsuleSha256 !==
              "string" ||
            !/^[0-9a-f]{64}$/u.test(
              state.executionContextCapsuleSha256,
            ) ||
            typeof state
              .executionContextContractSha256 !==
              "string" ||
            !/^[0-9a-f]{64}$/u.test(
              state.executionContextContractSha256,
            )
          )
        ) {
          state.executionContextBlockReason =
            "execution_context_handoff_unproven"
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
          model_context_compiler_configured_mode:
            modelContextCompilerPolicy.configured_mode,
          model_context_compiler_configured_explicit:
            modelContextCompilerPolicy.configured_explicit,
          model_context_compiler_policy_protocol:
            modelContextCompilerPolicy.protocol,
          model_context_compiler_policy_reason:
            modelContextCompilerPolicy.reason,
          model_context_compiler_promoted:
            modelContextCompilerPolicy.promoted === true,
          model_context_bound_execution_context_required:
            modelContextCompilerPolicy
              .bound_execution_context_required === true,
          model_context_selected_capsule_sha256:
            state.executionContextCapsuleSha256 ?? null,
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
          state.executionContextBlockReason
        ) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: state.executionContextBlockReason,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            execution_context_selected_source:
              state.executionContextSelectedSource,
            execution_context_capsule_sha256:
              state.executionContextCapsuleSha256,
            execution_context_contract_sha256:
              state.executionContextContractSha256,
            model_context_compiler_policy_protocol:
              modelContextCompilerPolicy.protocol,
            model_context_compiler_configured_mode:
              modelContextCompilerPolicy.configured_mode,
            model_context_compiler_effective_mode:
              modelContextCompilerPolicy.effective_mode,
            model_context_compiler_policy_reason:
              modelContextCompilerPolicy.reason,
            mutation_authority: false,
          })
          throw new Error(
            `CPU_AGENT ${state.executionContextBlockReason} ` +
            `state=${state.executionState}`,
          )
        }

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
        state.executionState === EXEC_STATE_REPAIR &&
        state.additiveRepairLock?.repairable === true &&
        state.executionContextCapsule != null &&
        typeof state.executionContextCapsuleSha256 ===
          "string" &&
        /^[0-9a-f]{64}$/u.test(
          state.executionContextCapsuleSha256,
        ) &&
        (
          state.executionContextSelectedSource ===
            "compiled_execution_capsule" ||
          state.executionContextSelectedSource ===
            "persisted_execution_capsule_repair_projection"
        )

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
        const canonicalObligationContract =
          deriveObligationBoundSynthesisContract({
            capability:
              state.additiveMutationCapability,
            taskRequirements:
              state.taskRequirements,
          })

        if (canonicalObligationContract.ok !== true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: canonicalObligationContract.reason,
            detail: canonicalObligationContract.detail ?? null,
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
            `CPU_AGENT ${canonicalObligationContract.reason} ` +
            `state=${state.executionState}`,
          )
        }

        const semanticSchemaBinding =
          bindSemanticContentToolSchemaToCapability(
            event.tools[EXECUTE_ADDITIVE_PLAN_TOOL],
            state.additiveMutationCapability,
          )

        if (semanticSchemaBinding.ok !== true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: semanticSchemaBinding.reason,
            detail: semanticSchemaBinding.detail ?? null,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            tool_frontier_protocol: TOOL_FRONTIER_PROTOCOL,
            mutation_tool: EXECUTE_ADDITIVE_PLAN_TOOL,
            semantic_content_ir_protocol:
              SEMANTIC_CONTENT_IR_PROTOCOL,
          })
          throw new Error(
            `CPU_AGENT ${semanticSchemaBinding.reason} ` +
            `state=${state.executionState}`,
          )
        }

        const semanticObligationBinding =
          bindSemanticObligationContract({
            semanticBinding: semanticSchemaBinding,
            capability: state.additiveMutationCapability,
            contract: canonicalObligationContract,
          })

        if (semanticObligationBinding.ok !== true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: semanticObligationBinding.reason,
            detail: semanticObligationBinding.detail ?? null,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            tool_frontier_protocol: TOOL_FRONTIER_PROTOCOL,
            mutation_tool: EXECUTE_ADDITIVE_PLAN_TOOL,
            semantic_obligation_bridge_protocol:
              SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
            contract_sha256:
              canonicalObligationContract.contract_sha256 ?? null,
          })
          throw new Error(
            `CPU_AGENT ${semanticObligationBinding.reason} ` +
            `state=${state.executionState}`,
          )
        }

        const sourceSlotSchemaBinding =
          bindSourceSlotToolSchema({
            tool: semanticObligationBinding.tool,
            capability: state.additiveMutationCapability,
            contract: canonicalObligationContract,
            semanticAttestation:
              semanticObligationBinding.attestation,
            repairCache:
              state.sourceSlotRepairCache,
            typedInitialPython: true,
            executionContextSha256:
              state.executionContextCapsuleSha256,
          })

        await writeProjectTrace(
          root,
          "cpu-agent-trace.jsonl",
          {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "source_slot_negotiation",
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            source_slot_compiler_protocol:
              SOURCE_SLOT_COMPILER_PROTOCOL,
            applied:
              sourceSlotSchemaBinding.ok === true,
            not_applicable:
              sourceSlotSchemaBinding.not_applicable === true,
            reason:
              sourceSlotSchemaBinding.reason ?? null,
            model_schema_bytes:
              sourceSlotSchemaBinding.model_schema_bytes ?? null,
            binding_sha256:
              sourceSlotSchemaBinding.binding?.binding_sha256 ?? null,
            required_source_keys:
              sourceSlotSchemaBinding.binding?.required_source_keys ??
              [],
            capability_sha256:
              state.additiveMutationCapability?.capability_sha256 ??
              null,
            authority_sha256:
              state.additiveMutationCapability?.authority_sha256 ??
              null,
            execution_context_capsule_sha256:
              state.executionContextCapsuleSha256,
            mutation_authority: false,
          },
        )

        if (
          sourceSlotSchemaBinding.ok !== true &&
          sourceSlotSchemaBinding.not_applicable !== true
        ) {
          state.sourceSlotRepairCache = null
          state.activeSourceSlotContract = null
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason: sourceSlotSchemaBinding.reason,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            source_slot_compiler_protocol:
              SOURCE_SLOT_COMPILER_PROTOCOL,
            mutation_authority: false,
          })
          throw new Error(
            `CPU_AGENT ${sourceSlotSchemaBinding.reason} ` +
            `state=${state.executionState}`,
          )
        }

        const pythonDependencyEvidence =
          sourceSlotSchemaBinding.ok === true
            ? await inspectPythonDependencyEvidence(root)
            : null

        const repairWitnessBinding =
          sourceSlotSchemaBinding.ok === true
            ? compileRepairWitnessClosure({
                tool: sourceSlotSchemaBinding.tool,
                binding: sourceSlotSchemaBinding.binding,
                repairCache: state.sourceSlotRepairCache,
                repairLock: state.additiveRepairLock,
                dependencyEvidence: pythonDependencyEvidence,
              })
            : null

        if (
          sourceSlotSchemaBinding.ok === true &&
          repairWitnessBinding?.ok !== true
        ) {
          state.activeSourceSlotContract = null
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason:
              repairWitnessBinding?.reason ??
              "repair_witness_closure_unavailable",
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            repair_witness_closure_protocol:
              REPAIR_WITNESS_CLOSURE_PROTOCOL,
            mutation_authority: false,
          })
          throw new Error(
            `CPU_AGENT ${
              repairWitnessBinding?.reason ??
              "repair_witness_closure_unavailable"
            } state=${state.executionState}`,
          )
        }

        if (repairWitnessBinding?.ok === true) {
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "repair_witness_closure",
            reason:
              repairWitnessBinding.repair_active === true
                ? "counterexample_guided_repair_witness_bound"
                : "initial_source_witness_bound",
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state: state.executionState,
            repair_witness_closure_protocol:
              REPAIR_WITNESS_CLOSURE_PROTOCOL,
            python_dependency_evidence_protocol:
              PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
            dependency_evidence_status:
              repairWitnessBinding.dependency_evidence_status,
            source_keys:
              repairWitnessBinding.source_keys,
            repair_active:
              repairWitnessBinding.repair_active === true,
            unresolved_symbol:
              repairWitnessBinding.unresolved_symbol ?? null,
            authority_expansion: false,
            mutation_authority: false,
          })
        }

        const sourceSlotModelView =
          sourceSlotSchemaBinding.ok === true
            ? compileSourceSlotModelView({
                tool:
                  repairWitnessBinding.tool,
                binding:
                  sourceSlotSchemaBinding.binding,
                capability:
                  state.additiveMutationCapability,
              })
            : null

        const residualModelViewEnabled =
          sourceSlotSchemaBinding.ok === true &&
          sourceSlotModelView?.ok === true &&
          residualModelViewRuntimeEnabled()

        if (
          sourceSlotSchemaBinding.ok === true &&
          sourceSlotModelView?.ok !== true
        ) {
          state.activeSourceSlotContract = null
          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "model_blocked",
              reason:
                sourceSlotModelView?.reason ??
                "model_view_compile_failed",
              sessionID,
              turnID: state.turnID,
              project_root: root,
              execution_state:
                state.executionState,
              model_view_compiler_protocol:
                MODEL_VIEW_COMPILER_PROTOCOL,
              mutation_authority: false,
            },
          )
          throw new Error(
            "CPU_AGENT " +
              String(
                sourceSlotModelView?.reason ??
                  "model_view_compile_failed",
              ) +
              ` state=${state.executionState}`,
          )
        }

        if (
          sourceSlotModelView?.ok === true
        ) {
          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind:
                "source_slot_model_view_compilation",
              reason:
                sourceSlotModelView.reason,
              sessionID,
              turnID: state.turnID,
              project_root: root,
              execution_state:
                state.executionState,
              model_view_compiler_protocol:
                MODEL_VIEW_COMPILER_PROTOCOL,
              model_schema_bytes:
                sourceSlotModelView.model_schema_bytes,
              model_schema_sha256:
                sourceSlotModelView.model_schema_sha256,
              required_holes:
                sourceSlotModelView.plan.required_holes,
              hole_count:
                sourceSlotModelView.plan.required_holes.length,
              frontier_codec_count:
                sourceSlotModelView.frontier_codec_count,
              frontier_family_count:
                sourceSlotModelView.frontier_family_count,
              annotation_independent_semantics:
                sourceSlotModelView.annotation_independent_semantics,
              compiler_identity_fields_exposed:
                sourceSlotModelView.compiler_identity_fields_exposed,
              model_file_authority: false,
              model_slot_authority: false,
              model_operation_authority: false,
              model_calls_added: 0,
              residual_model_view_protocol:
                RESIDUAL_MODEL_VIEW_PROTOCOL,
              residual_model_view_enabled:
                residualModelViewEnabled,
              residual_normal_physical_model_calls:
                residualModelViewEnabled ? 1 : null,
              residual_repair_physical_model_calls_max:
                residualModelViewEnabled ? 1 : null,
              mutation_authority: false,
            },
          )
        }

        const atomicModelViewEnabled =
          sourceSlotSchemaBinding.ok === true &&
          sourceSlotModelView?.ok === true &&
          residualModelViewEnabled !== true &&
          atomicModelViewRuntimeEnabled()

        const atomicModelViewProjection =
          atomicModelViewEnabled
            ? compileAtomicModelViewProjection({
                tool:
                  sourceSlotModelView.tool,
                plan:
                  sourceSlotModelView.plan,
                assembly:
                  state?.atomicModelViewAssembly ?? null,
                turnID:
                  state?.turnID ?? null,
              })
            : null

        if (
          atomicModelViewEnabled &&
          atomicModelViewProjection?.ok !== true
        ) {
          state.atomicModelViewAssembly = null
          state.activeSourceSlotContract = null
          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "atomic_model_view_projection",
              reason:
                atomicModelViewProjection?.reason ??
                "atomic_model_view_projection_failed",
              sessionID,
              turnID: state.turnID,
              project_root: root,
              execution_state:
                state.executionState,
              atomic_model_view_protocol:
                ATOMIC_MODEL_VIEW_PROTOCOL,
              mutation_authority: false,
            },
          )
          throw new Error(
            "CPU_AGENT " +
              String(
                atomicModelViewProjection?.reason ??
                  "atomic_model_view_projection_failed",
              ) +
              ` state=${state.executionState}`,
          )
        }

        if (atomicModelViewProjection?.ok === true) {
          state.atomicModelViewAssembly =
            atomicModelViewProjection.assembly
          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "atomic_model_view_projection",
              reason:
                atomicModelViewProjection.reason,
              sessionID,
              turnID: state.turnID,
              project_root: root,
              execution_state:
                state.executionState,
              atomic_model_view_protocol:
                ATOMIC_MODEL_VIEW_PROTOCOL,
              current_hole:
                atomicModelViewProjection.current_hole,
              current_representation:
                atomicModelViewProjection.current_representation,
              unit_index:
                atomicModelViewProjection.unit_index,
              unit_count:
                atomicModelViewProjection.unit_count,
              accepted_count:
                atomicModelViewProjection.accepted_count,
              remaining_count:
                atomicModelViewProjection.remaining_count,
              partial_materialization: false,
              model_calls_added:
                atomicModelViewProjection.model_calls_added,
              mutation_authority: false,
            },
          )
        } else if (!atomicModelViewEnabled) {
          state.atomicModelViewAssembly = null
        }

        event.tools[EXECUTE_ADDITIVE_PLAN_TOOL] =
          sourceSlotSchemaBinding.ok === true
            ? atomicModelViewProjection?.ok === true
              ? atomicModelViewProjection.tool
              : sourceSlotModelView.tool
            : semanticObligationBinding.tool
        state.activeSemanticMutationContract = {
          protocol: SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
          contract: canonicalObligationContract,
          attestation: semanticObligationBinding.attestation,
        }
        state.activeSourceSlotContract =
          sourceSlotSchemaBinding.ok === true
            ? {
                protocol: SOURCE_SLOT_COMPILER_PROTOCOL,
                binding: sourceSlotSchemaBinding.binding,
                model_view:
                  sourceSlotModelView.plan,
                residual_model_view:
                  residualModelViewEnabled
                    ? {
                        protocol:
                          RESIDUAL_MODEL_VIEW_PROTOCOL,
                        plan_sha256:
                          sourceSlotModelView.plan.plan_sha256,
                        required_holes:
                          sourceSlotModelView.plan.required_holes,
                        normal_physical_model_calls: 1,
                        repair_physical_model_calls_max: 1,
                        partial_materialization: false,
                        mutation_authority: false,
                      }
                    : null,
                atomic_model_view:
                  atomicModelViewProjection?.ok === true
                    ? {
                        protocol:
                          ATOMIC_MODEL_VIEW_PROTOCOL,
                        plan_sha256:
                          sourceSlotModelView.plan.plan_sha256,
                        current_hole:
                          atomicModelViewProjection.current_hole,
                        unit_index:
                          atomicModelViewProjection.unit_index,
                        unit_count:
                          atomicModelViewProjection.unit_count,
                        partial_materialization:
                          false,
                        mutation_authority:
                          false,
                      }
                    : null,
              }
            : null
        if (sourceSlotSchemaBinding.ok !== true) {
          state.sourceSlotRepairCache = null
          state.atomicModelViewAssembly = null
        }
      }

      const frontierToolNames = Object.keys(event.tools).sort()

      const executionControlFrontier =
        assertDeterministicFrontier(
          frontierToolNames,
        )

      state.executionControlSelectedAction =
        executionControlFrontier.selected_tool

      const structuredMutationControlRequired =
        structuredMutationControlRequiredForState(
          state,
          executionControlFrontier.selected_tool,
        )
      const structuredMutationControlEnvelope =
        structuredMutationControlRequired
          ? buildStructuredMutationControlEnvelope(
              state,
              executionControlFrontier.selected_tool,
            )
          : null

      if (
        structuredMutationControlRequired &&
        structuredMutationControlEnvelope == null
      ) {
        applyExecutionEvent(
          state,
          "fatal",
          "structured_control_boundary_unavailable",
        )
        await writeProjectTrace(
          root,
          "cpu-agent-trace.jsonl",
          {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason:
              "structured_control_boundary_unavailable",
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state:
              state.executionState,
            selected_action:
              executionControlFrontier.selected_tool,
            execution_context_selected_source:
              state.executionContextSelectedSource,
            structured_mutation_control_protocol:
              STRUCTURED_MUTATION_CONTROL_PROTOCOL,
            mutation_authority: false,
          },
        )
        throw new Error(
          "CPU_AGENT structured_control_boundary_unavailable " +
            `state=${state.executionState}`,
        )
      }

      const goalDirectedDecision =
        decideGoalDirectedCompute({
          execution_state:
            state.executionState,
          selected_tool:
            executionControlFrontier.selected_tool,
          frontier_size:
            frontierToolNames.length,
          patch_accepted:
            state.patchAccepted === true,
          model_calls:
            state.modelCalls,
          max_model_calls:
            MAX_MODEL_CALLS_PER_TURN,
          search_attempts:
            state.searchAttempts,
          max_search_attempts:
            MAX_SEARCH_ATTEMPTS_PER_TURN,
          mutation_attempts:
            state.mutationAttempts,
          max_mutation_attempts:
            MAX_PATCH_ATTEMPTS_PER_TURN,
          exact_no_progress: false,
        })

      state.lastGoalDirectedDecision =
        goalDirectedDecision

      await writeProjectTrace(
        root,
        "cpu-agent-trace.jsonl",
        {
          ts: nowMs(),
          protocol:
            AGENT_PROTOCOL,
          goal_directed_governor_protocol:
            GOAL_DIRECTED_GOVERNOR_PROTOCOL,
          kind:
            "goal_directed_compute",
          admitted:
            goalDirectedDecision.admitted,
          reason:
            goalDirectedDecision.reason,
          objective:
            goalDirectedDecision.objective,
          proof_obligation:
            goalDirectedDecision.proof_obligation,
          decision_basis:
            goalDirectedDecision.decision_basis,
          success_probability:
            goalDirectedDecision.success_probability,
          probability_authority:
            goalDirectedDecision.probability_authority,
          runtime_cost_authority:
            goalDirectedDecision.runtime_cost_authority,
          wall_time_authority:
            goalDirectedDecision.wall_time_authority,
          selected_tool:
            goalDirectedDecision.selected_tool,
          execution_state:
            goalDirectedDecision.execution_state,
          sessionID,
          turnID:
            state.turnID,
          project_root:
            root,
          mutation_authority: false,
        },
      )

      if (
        goalDirectedDecision.admitted !== true
      ) {
        applyExecutionEvent(
          state,
          "fatal",
          goalDirectedDecision.reason,
        )

        throw new Error(
          "CPU_GOAL_DIRECTED_GOVERNOR " +
          goalDirectedDecision.reason +
          " state=" +
          String(
            state.executionState,
          ) +
          " obligation=" +
          String(
            goalDirectedDecision.proof_obligation,
          ),
        )
      }

      // E3.4 Mutation Phase Compiler:
      // once the deterministic FSM has a singleton mutation frontier and a
      // sealed canonical mutation envelope, conversation history is no longer
      // model-facing authority. Compile a fresh phase-local model envelope and
      // project annotations out of the provider-facing tool schema. Executable
      // tool semantics, Mutation IR, compiler, executor and verifier are
      // unchanged.
      const mutationPhaseCompilation =
        compileMutationPhaseContext({
          executionState: state.executionState,
          frontierToolNames,
          taskText: taskContextSnapshot?.text ?? "",
          messages: event.messages,
          system: event.system,
          controlEnvelope:
            structuredMutationControlEnvelope,
          modelView:
            state?.activeSourceSlotContract?.model_view ??
            null,
        })

      if (
        structuredMutationControlRequired &&
        (
          mutationPhaseCompilation.applied !== true ||
          mutationPhaseCompilation
            .control_context_applied !== true
        )
      ) {
        applyExecutionEvent(
          state,
          "fatal",
          "structured_control_phase_compile_failed",
        )
        await writeProjectTrace(
          root,
          "cpu-agent-trace.jsonl",
          {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "model_blocked",
            reason:
              "structured_control_phase_compile_failed",
            detail:
              mutationPhaseCompilation
                .control_context_reason ??
              mutationPhaseCompilation.reason ??
              null,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state:
              state.executionState,
            selected_action:
              executionControlFrontier.selected_tool,
            structured_mutation_control_protocol:
              STRUCTURED_MUTATION_CONTROL_PROTOCOL,
            mutation_authority: false,
          },
        )
        throw new Error(
          "CPU_AGENT structured_control_phase_compile_failed " +
            `state=${state.executionState}`,
        )
      }

      const mutationToolSchemaProjection =
        projectMutationToolSchemas({
          tools: event.tools,
          frontierToolNames,
          active: mutationPhaseCompilation.applied === true,
        })

      const modelViewFinalAbiOwned =
        modelViewOwnsFinalModelAbi(
          state
            ?.activeSourceSlotContract
            ?.model_view ??
            null,
        )

      const modelAbiCompilation =
        compileModelFacingToolSchemas({
          tools: event.tools,
          frontierToolNames,
          active:
            mutationPhaseCompilation.applied ===
              true &&
            !modelViewFinalAbiOwned,
        })

      state.modelAbiCompilation =
        modelAbiCompilation

      await writeProjectTrace(
        root,
        "cpu-agent-trace.jsonl",
        {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_abi_compilation",
          model_abi_compiler_protocol:
            MODEL_ABI_COMPILER_PROTOCOL,
          applied:
            modelAbiCompilation.applied,
          reason:
            modelAbiCompilation.reason,
          tools_examined:
            modelAbiCompilation.tools_examined,
          tools_projected:
            modelAbiCompilation.tools_projected,
          base_schema_bytes:
            modelAbiCompilation.base_schema_bytes,
          selected_schema_bytes:
            modelAbiCompilation.selected_schema_bytes,
          saved_bytes:
            modelAbiCompilation.saved_bytes,
          cache_hits:
            modelAbiCompilation.cache_hits,
          compiler_available:
            modelAbiCompilation.compiler_available,
          final_model_abi_owner:
            modelViewFinalAbiOwned
              ? MODEL_VIEW_COMPILER_PROTOCOL
              : MODEL_ABI_COMPILER_PROTOCOL,
          generic_model_abi_projection_skipped:
            modelViewFinalAbiOwned,
          mutation_authority: false,
        },
      )

      if (mutationPhaseCompilation.applied === true) {
        event.system = mutationPhaseCompilation.system
        event.messages = mutationPhaseCompilation.messages
      }

      const frontierToolSchema = Object.fromEntries(
        frontierToolNames.map((name) => [name, event.tools[name]]),
      )
      const frontierToolSchemaSha256 = createHash("sha256")
        .update(JSON.stringify(frontierToolSchema))
        .digest("hex")
      state.visibleToolSchemaSha256 = frontierToolSchemaSha256

      const elapsed = Math.max(0, nowMs() - state.turnStartedAt)

      const governorNowMs = nowMs()
      const governorSelectedTool =
        frontierToolNames.length === 1
          ? frontierToolNames[0]
          : nextActionForExecutionState(state)
      const governorWorkEstimate = estimateGovernorDispatchWork({
        system: event.system,
        messages: event.messages,
        tools: event.tools,
        selectedTool: governorSelectedTool,
        additiveCapability: state.additiveMutationCapability,
      })
      const governorInferenceLease = deriveGovernorInferenceLease({
        profile: state.governorWorkProfile,
        work: governorWorkEstimate,
        bootstrapLeaseMs: MAX_TURN_WALL_MS,
        legacyReserveMs: modelDispatchReserveMs(state),
      })
      const governorAdaptiveWindows = adaptiveGovernorWindows({
        nowMs: governorNowMs,
        taskStartedAt:
          state.governorTaskStartedAt ?? state.turnStartedAt,
        phaseStartedAt:
          state.governorPhaseStartedAt ?? state.turnStartedAt,
        basePhaseBudgetMs: MAX_TURN_WALL_MS,
        baseTaskBudgetMs:
          MAX_TURN_WALL_MS * GOVERNOR_MAX_ACTIVE_PHASES,
        inferenceLeaseMs: governorInferenceLease.lease_ms,
      })
      const governorAdmission = resolveGovernorAdmission({
        nowMs: governorNowMs,
        taskStartedAt:
          state.governorTaskStartedAt ?? state.turnStartedAt,
        phaseStartedAt:
          state.governorPhaseStartedAt ?? state.turnStartedAt,
        phaseBudgetMs: governorAdaptiveWindows.phase_budget_ms,
        taskBudgetMs: governorAdaptiveWindows.task_budget_ms,
        latencyProfile: state.modelLatencyProfile,
      })

      if (governorAdmission.admitted !== true) {
        await writeProjectTrace(
          root,
          "cpu-agent-trace.jsonl",
          {
            ts: governorNowMs,
            protocol: AGENT_PROTOCOL,
            governor_protocol:
              GOVERNOR_LATENCY_PROTOCOL,
            time_semantics_protocol:
              TIME_SEMANTICS_PROTOCOL,
            kind:
              "governor_time_observation",
            would_admit:
              governorAdmission.admitted === true,
            observed_reason:
              governorAdmission.reason ?? null,
            observed_blocker:
              governorAdmission.admission_blocker ?? null,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            execution_state:
              state.executionState,
            phase_elapsed_ms:
              governorAdmission.phase_elapsed_ms ?? null,
            phase_remaining_ms:
              governorAdmission.phase_remaining_ms ?? null,
            task_elapsed_ms:
              governorAdmission.task_elapsed_ms ?? null,
            task_remaining_ms:
              governorAdmission.task_remaining_ms ?? null,
            observed_model_latency_reserve_ms:
              governorAdmission.reserve_ms ?? 0,
            solver_authority:
              "observation_only",
            mutation_authority: false,
          },
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


      // Deterministic fatal is already a terminal decision. No further
      // semantic uncertainty exists, so provider dispatch is forbidden.
      if (
        state.executionState === EXEC_STATE_SAFE_FAIL &&
        state.executionEvent === "fatal"
      ) {
        if (!state.fatalSafeFail) {
          const derivedFatal = deriveFatalSafeFail(
            state,
            state.executionReason,
          )
          if (derivedFatal.ok === true) {
            const claim = claimFatalSafeFail(
              state,
              derivedFatal.commit,
            )
            if (claim.ok !== true) {
              await writeProjectTrace(
                root,
                "cpu-agent-trace.jsonl",
                {
                  ts: nowMs(),
                  protocol: AGENT_PROTOCOL,
                  kind: "model_blocked",
                  reason: claim.reason,
                  fatal_safe_fail_protocol:
                    FATAL_SAFE_FAIL_PROTOCOL,
                  sessionID,
                  turnID: state.turnID,
                  project_root: root,
                },
              )
              throw new Error(
                `CPU_AGENT ${claim.reason}`,
              )
            }
          }
        }

        if (!state.fatalSafeFail) {
          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "model_blocked",
              reason:
                "fatal_safe_fail_identity_unavailable",
              fatal_safe_fail_protocol:
                FATAL_SAFE_FAIL_PROTOCOL,
              sessionID,
              turnID: state.turnID,
              project_root: root,
            },
          )
          throw new Error(
            "CPU_AGENT fatal_safe_fail_identity_unavailable",
          )
        }

        const match = fatalSafeFailMatchesState(
          state.fatalSafeFail,
          state,
        )

        if (match.ok !== true) {
          if (
            match.reason ===
              "fatal_safe_fail_task_turn_changed" ||
            match.reason ===
              "fatal_safe_fail_turn_changed"
          ) {
            clearFatalSafeFailState(state)
          }

          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "model_blocked",
              reason: match.reason,
              fatal_safe_fail_protocol:
                FATAL_SAFE_FAIL_PROTOCOL,
              fatal_safe_fail_sha256:
                state.fatalSafeFailSha256,
              sessionID,
              turnID: state.turnID,
              project_root: root,
            },
          )
          throw new Error(
            `CPU_AGENT ${match.reason}`,
          )
        }

        if (
          state.fatalSafeFailShortCircuitAttemptedSha256 ===
          state.fatalSafeFailSha256
        ) {
          if (state.fatalSafeFailShortCircuits > 0) {
            return
          }

          throw new Error(
            "CPU_AGENT fatal_safe_fail_short_circuit_incomplete",
          )
        }

        state.fatalSafeFailShortCircuitAttemptedSha256 =
          state.fatalSafeFailSha256
        state.fatalSafeFailShortCircuitRequests += 1

        await writeProjectTrace(
          root,
          "cpu-agent-trace.jsonl",
          {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            kind: "fatal_safe_fail_requested",
            fatal_safe_fail_protocol:
              FATAL_SAFE_FAIL_PROTOCOL,
            fatal_safe_fail_sha256:
              state.fatalSafeFailSha256,
            fatal_safe_fail_reason:
              state.fatalSafeFail.reason,
            fatal_safe_fail_identity_mode:
              state.fatalSafeFail.identity_mode,
            sessionID,
            turnID: state.turnID,
            project_root: root,
            fatal_safe_fail_short_circuit_requests:
              state.fatalSafeFailShortCircuitRequests,
          },
        )

        const interrupt =
          typeof ctx.session?.interrupt === "function"
            ? ctx.session.interrupt.bind(ctx.session)
            : null

        if (!interrupt) {
          state.fatalSafeFailShortCircuitFailures += 1

          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "fatal_safe_fail_failed",
              reason: "session_interrupt_unavailable",
              fatal_safe_fail_protocol:
                FATAL_SAFE_FAIL_PROTOCOL,
              fatal_safe_fail_sha256:
                state.fatalSafeFailSha256,
              sessionID,
              turnID: state.turnID,
              project_root: root,
            },
          )

          throw new Error(
            "CPU_AGENT fatal_safe_fail_interrupt_unavailable",
          )
        }

        try {
          await interrupt({
            sessionID,
            continue: false,
          })

          state.fatalSafeFailShortCircuits += 1

          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "fatal_safe_fail",
              fatal_safe_fail_protocol:
                FATAL_SAFE_FAIL_PROTOCOL,
              fatal_safe_fail_sha256:
                state.fatalSafeFailSha256,
              fatal_safe_fail_reason:
                state.fatalSafeFail.reason,
              fatal_safe_fail_identity_mode:
                state.fatalSafeFail.identity_mode,
              sessionID,
              turnID: state.turnID,
              project_root: root,
              fatal_safe_fail_short_circuits:
                state.fatalSafeFailShortCircuits,
            },
          )

          return
        } catch (error) {
          state.fatalSafeFailShortCircuitFailures += 1

          await writeProjectTrace(
            root,
            "cpu-agent-trace.jsonl",
            {
              ts: nowMs(),
              protocol: AGENT_PROTOCOL,
              kind: "fatal_safe_fail_failed",
              reason: "session_interrupt_failed",
              error: String(error?.message ?? error),
              fatal_safe_fail_protocol:
                FATAL_SAFE_FAIL_PROTOCOL,
              fatal_safe_fail_sha256:
                state.fatalSafeFailSha256,
              sessionID,
              turnID: state.turnID,
              project_root: root,
            },
          )

          throw new Error(
            "CPU_AGENT fatal_safe_fail_interrupt_failed",
          )
        }
      }

      const qualifiedComputeNow = nowMs()
      const qualifiedComputeTaskStart =
        Number.isSafeInteger(state.governorTaskStartedAt)
          ? state.governorTaskStartedAt
          : state.turnStartedAt
      const qualifiedComputeTaskDeadline =
        Number.isSafeInteger(state.executionControlTaskDeadlineAtMs)
          ? state.executionControlTaskDeadlineAtMs
          : Number.isSafeInteger(qualifiedComputeTaskStart)
            ? qualifiedComputeTaskStart +
              MAX_TURN_WALL_MS * GOVERNOR_MAX_ACTIVE_PHASES
            : null

      const qualifiedComputePlan = deriveQualifiedComputePlan({
        tools: event.tools,
        selectedTool: governorSelectedTool,
        baseOutputCap: null,
        nowMs: qualifiedComputeNow,
        taskDeadlineAtMs: qualifiedComputeTaskDeadline,
      })

      await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
        ts: qualifiedComputeNow,
        protocol: AGENT_PROTOCOL,
        kind: "qualified_compute_admission",
        qualified_compute_protocol: QUALIFIED_COMPUTE_PROTOCOL,
        sessionID,
        turnID: state.turnID,
        project_root: root,
        active: qualifiedComputePlan.active === true,
        reason: qualifiedComputePlan.reason ?? null,
        selected_tool: governorSelectedTool,
        active_source_count: qualifiedComputePlan.active_source_count ?? null,
        active_source_keys: qualifiedComputePlan.active_source_keys ?? null,
        active_source_capacity_bytes:
          qualifiedComputePlan.active_source_capacity_bytes ?? null,
        total_source_capacity_bytes:
          qualifiedComputePlan.total_source_capacity_bytes ?? null,
        frontier_fraction:
          qualifiedComputePlan.frontier_fraction ?? null,
        lease_policy:
          qualifiedComputePlan.lease_policy ?? null,
        fixed_inference_reserve_ms:
          qualifiedComputePlan.fixed_inference_reserve_ms ?? null,
        scalable_inference_budget_ms:
          qualifiedComputePlan.scalable_inference_budget_ms ?? null,
        min_hard_lease_ms:
          qualifiedComputePlan.min_hard_lease_ms ?? null,
        max_hard_lease_ms:
          qualifiedComputePlan.max_hard_lease_ms ?? null,
        qualified_compute_provider_output_cap_tokens:
          qualifiedComputePlan.output_cap_tokens ?? null,
        hard_lease_ms: qualifiedComputePlan.hard_lease_ms ?? null,
        teardown_reserve_ms: qualifiedComputePlan.teardown_reserve_ms ?? null,
        required_window_ms: qualifiedComputePlan.required_window_ms ?? null,
        task_deadline_at_ms: qualifiedComputePlan.task_deadline_at_ms ?? null,
        task_remaining_ms: qualifiedComputePlan.task_remaining_ms ?? null,
        admission_allowed: qualifiedComputePlan.admission_allowed === true,
        deadline_extension_ms: qualifiedComputePlan.deadline_extension_ms ?? 0,
        mutation_authority: false,
      })

      if (
        qualifiedComputePlan.active === true &&
        qualifiedComputePlan.admission_allowed !== true
      ) {
        const reason = "qualified_compute_admission_rejected"
        applyExecutionEvent(state, "fatal", reason)
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason,
          qualified_compute_protocol: QUALIFIED_COMPUTE_PROTOCOL,
          qualified_compute_reason: qualifiedComputePlan.reason,
          sessionID,
          turnID: state.turnID,
          project_root: root,
          model_calls_before_block: state.modelCalls,
          active_source_count: qualifiedComputePlan.active_source_count ?? null,
          active_source_keys:
            qualifiedComputePlan.active_source_keys ?? null,
          active_source_capacity_bytes:
            qualifiedComputePlan.active_source_capacity_bytes ?? null,
          total_source_capacity_bytes:
            qualifiedComputePlan.total_source_capacity_bytes ?? null,
          frontier_fraction:
            qualifiedComputePlan.frontier_fraction ?? null,
          lease_policy:
            qualifiedComputePlan.lease_policy ?? null,
          fixed_inference_reserve_ms:
            qualifiedComputePlan.fixed_inference_reserve_ms ?? null,
          scalable_inference_budget_ms:
            qualifiedComputePlan.scalable_inference_budget_ms ?? null,
          min_hard_lease_ms:
            qualifiedComputePlan.min_hard_lease_ms ?? null,
          max_hard_lease_ms:
            qualifiedComputePlan.max_hard_lease_ms ?? null,
          hard_lease_ms: qualifiedComputePlan.hard_lease_ms ?? null,
          teardown_reserve_ms: qualifiedComputePlan.teardown_reserve_ms ?? null,
          task_remaining_ms: qualifiedComputePlan.task_remaining_ms ?? null,
          required_window_ms: qualifiedComputePlan.required_window_ms ?? null,
          deadline_extension_ms: qualifiedComputePlan.deadline_extension_ms ?? 0,
          mutation_authority: false,
        })
        throw new Error(`CPU_AGENT ${reason}`)
      }
      const physicalLeaseBudget =
        deriveGovernorPhysicalLease({
          inferenceLeaseMs:
            governorInferenceLease.lease_ms ?? null,
          inferenceLeaseSource:
            governorInferenceLease.source ?? null,
          taskRemainingMs:
            qualifiedComputePlan.task_remaining_ms ?? null,
          phaseRemainingMs:
            governorAdmission.phase_remaining_ms ?? null,
          teardownReserveMs:
            qualifiedComputePlan.teardown_reserve_ms ?? 0,
        })

      if (physicalLeaseBudget.ok !== true) {
        const reason =
          physicalLeaseBudget.reason ??
          "governor_physical_lease_unavailable"
        applyExecutionEvent(state, "fatal", reason)
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason,
          physical_inference_lease_protocol:
            PHYSICAL_INFERENCE_LEASE_PROTOCOL,
          governor_physical_lease_protocol:
            physicalLeaseBudget.protocol ?? null,
          governor_physical_lease_source:
            physicalLeaseBudget.source ?? null,
          governor_inference_lease_ms:
            governorInferenceLease.lease_ms ?? null,
          governor_inference_lease_source:
            governorInferenceLease.source ?? null,
          governor_task_remaining_ms:
            qualifiedComputePlan.task_remaining_ms ?? null,
          teardown_reserve_ms:
            qualifiedComputePlan.teardown_reserve_ms ?? 0,
          sessionID,
          turnID: state.turnID,
          project_root: root,
          execution_state: state.executionState,
          mutation_authority: false,
        })
        throw new Error(
          `CPU_PHYSICAL_INFERENCE_LEASE ${reason}`,
        )
      }

      const physicalLeasePriorFailure =
        physicalInferenceLeaseController.failure({
          sessionID,
          turnID: state.turnID,
        })
      if (physicalLeasePriorFailure) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: physicalLeasePriorFailure.reason,
          physical_inference_lease_protocol:
            PHYSICAL_INFERENCE_LEASE_PROTOCOL,
          production_hard_lease_promoted: true,
          sessionID,
          turnID: state.turnID,
          project_root: root,
          execution_state: state.executionState,
          mutation_authority: false,
        })
        throw new Error(
          `CPU_PHYSICAL_INFERENCE_LEASE ${physicalLeasePriorFailure.reason}`,
        )
      }

      const physicalInterrupt =
        typeof ctx.session?.interrupt === "function"
          ? () => ctx.session.interrupt({ sessionID, continue: false })
          : null
      const physicalLeasePreflight =
        await physicalInferenceLeaseController.preflight({
          interrupt: physicalInterrupt,
        })
      if (physicalLeasePreflight.ok !== true) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: physicalLeasePreflight.reason,
          physical_inference_lease_protocol:
            PHYSICAL_INFERENCE_LEASE_PROTOCOL,
          physical_inference_hard_lease_ms:
            physicalLeasePreflight.hard_lease_ms ?? null,
          physical_inference_metrics_url:
            physicalLeasePreflight.metrics_url ?? null,
          production_hard_lease_promoted: true,
          sessionID,
          turnID: state.turnID,
          project_root: root,
          execution_state: state.executionState,
          mutation_authority: false,
        })
        throw new Error(
          `CPU_PHYSICAL_INFERENCE_LEASE ${physicalLeasePreflight.reason}`,
        )
      }

      state.modelCalls += 1
      state.lastModelDispatchStartedAt = nowMs()
      state.lastGovernorDispatchWorkBytes =
        governorWorkEstimate.work_bytes
      state.lastGovernorDispatchInputBytes =
        governorWorkEstimate.input_bytes
      state.lastGovernorInferenceLeaseMs =
        governorInferenceLease.lease_ms
      state.lastGovernorLeaseSource =
        governorInferenceLease.source
      state.lastSeen = state.lastModelDispatchStartedAt

      const physicalLeaseModelCall = state.modelCalls
      const physicalLeaseArm = physicalInferenceLeaseController.arm({
        sessionID,
        turnID: state.turnID,
        modelCall: physicalLeaseModelCall,
        hardLeaseMs: physicalLeaseBudget.lease_ms,
        providerID: event.model?.providerID ?? null,
        modelID: event.model?.id ?? null,
        interrupt: physicalInterrupt,
        isCurrent: () =>
          state.turnID != null &&
          state.modelCalls === physicalLeaseModelCall,
        onEvent: async (leaseEvent) => {
          if (leaseEvent?.kind === "physical_inference_lease_terminal") {
            state.executionControlHardDeadlineInterrupts =
              Number.isFinite(state.executionControlHardDeadlineInterrupts)
                ? state.executionControlHardDeadlineInterrupts + 1
                : 1
            applyExecutionEvent(state, "fatal", leaseEvent.reason)
          }
          await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
            ts: nowMs(),
            protocol: AGENT_PROTOCOL,
            ...leaseEvent,
            project_root: root,
            execution_state: state.executionState,
            production_hard_lease_promoted: true,
            physical_inference_enforcement_authority:
              "owned_progress_stall_plus_phase_bounded_hard_lease_plus_post_interrupt_quiescence",
            mutation_authority: false,
          })
        },
      })
      if (physicalLeaseArm.ok !== true) {
        await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
          ts: nowMs(),
          protocol: AGENT_PROTOCOL,
          kind: "model_blocked",
          reason: physicalLeaseArm.reason,
          physical_inference_lease_protocol:
            PHYSICAL_INFERENCE_LEASE_PROTOCOL,
          production_hard_lease_promoted: true,
          sessionID,
          turnID: state.turnID,
          project_root: root,
          execution_state: state.executionState,
          mutation_authority: false,
        })
        throw new Error(
          `CPU_PHYSICAL_INFERENCE_LEASE ${physicalLeaseArm.reason}`,
        )
      }



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
        physical_inference_lease_protocol:
          PHYSICAL_INFERENCE_LEASE_PROTOCOL,
        physical_inference_hard_lease_ms:
          physicalLeaseArm.hard_lease_ms,
        physical_inference_default_hard_lease_ms:
          physicalLeaseArm.default_hard_lease_ms ?? null,
        physical_inference_lease_source:
          physicalLeaseBudget.source ?? null,
        physical_inference_policy_authority: "governor",
        governor_physical_lease_protocol:
          physicalLeaseBudget.protocol ?? null,
        governor_inference_lease_estimate_ms:
          governorInferenceLease.lease_ms ?? null,
        governor_task_remaining_ms:
          physicalLeaseBudget.task_remaining_ms ?? null,
        governor_phase_remaining_ms:
          physicalLeaseBudget.phase_remaining_ms ?? null,
        physical_inference_teardown_reserve_ms:
          physicalLeaseBudget.teardown_reserve_ms ?? 0,
        inference_stall_interrupt_armed:
          physicalLeaseArm.stall_interrupt_armed === true,
        inference_stall_threshold_ms:
          physicalLeaseArm.stall_threshold_ms ?? null,
        inference_stall_poll_ms:
          physicalLeaseArm.stall_poll_ms ?? null,
        inference_stall_authority:
          physicalLeaseArm.stall_authority ?? null,
        physical_inference_preflight_reason:
          physicalLeasePreflight.reason,
        physical_inference_predispatch_authority:
          physicalLeasePreflight.predispatch_authority ?? null,
        physical_inference_quiescence_required_before_dispatch:
          physicalLeasePreflight.quiescence_required_before_dispatch === true,
        physical_inference_quiescence_role:
          physicalLeasePreflight.quiescence_role ?? null,
        physical_inference_enforcement_authority:
          "owned_progress_stall_plus_phase_bounded_hard_lease_plus_post_interrupt_quiescence",
        production_hard_lease_promoted: true,
        turn_elapsed_ms: elapsed,
        context_bytes: contextBytes,
        context_system_bytes: systemBytes,
        context_messages_bytes: messagesBytes,
        context_tools_bytes: toolsBytes,
        context_message_breakdown: messageBreakdown,
        mutation_phase_compiler_protocol:
          mutationPhaseCompilation?.protocol ?? MUTATION_PHASE_COMPILER_PROTOCOL,
        mutation_phase_compiler_applied:
          mutationPhaseCompilation?.applied === true,
        mutation_phase_compiler_reason:
          mutationPhaseCompilation?.reason ?? null,
        mutation_phase_source_system_bytes:
          mutationPhaseCompilation?.source_system_bytes ?? null,
        mutation_phase_source_messages_bytes:
          mutationPhaseCompilation?.source_messages_bytes ?? null,
        mutation_phase_projected_system_bytes:
          mutationPhaseCompilation?.projected_system_bytes ?? null,
        mutation_phase_projected_messages_bytes:
          mutationPhaseCompilation?.projected_messages_bytes ?? null,
        mutation_phase_reduction_bytes:
          mutationPhaseCompilation?.reduction_bytes ?? 0,
        mutation_phase_envelope_sha256:
          mutationPhaseCompilation?.envelope_sha256 ?? null,
        mutation_phase_sha256:
          mutationPhaseCompilation?.phase_sha256 ?? null,
      structured_mutation_control_required:
        structuredMutationControlRequired,
      structured_mutation_control_protocol:
        mutationPhaseCompilation
          ?.structured_control_protocol ??
        STRUCTURED_MUTATION_CONTROL_PROTOCOL,
      structured_mutation_control_applied:
        mutationPhaseCompilation
          ?.structured_control_applied === true,
      structured_mutation_control_reason:
        mutationPhaseCompilation
          ?.structured_control_reason ?? null,
      structured_mutation_control_source:
        mutationPhaseCompilation
          ?.structured_control_source ?? null,
      structured_mutation_control_required_operations:
        mutationPhaseCompilation
          ?.structured_control_required_operations ?? null,
      repair_history_elided:
        mutationPhaseCompilation
          ?.repair_history_elided === true,
      control_context_protocol:
        mutationPhaseCompilation
          .control_context_protocol ??
        CONTROL_CONTEXT_LAYER_PROTOCOL,
      control_context_applied:
        mutationPhaseCompilation
          .control_context_applied ===
        true,
      control_context_reason:
        mutationPhaseCompilation
          .control_context_reason ??
        null,
      control_context_action:
        mutationPhaseCompilation
          .control_context_action ??
        null,
      control_context_required_operations:
        mutationPhaseCompilation
          .control_context_required_operations ??
        null,
      control_context_source_bytes:
        mutationPhaseCompilation
          .control_context_source_bytes ??
        null,
      control_context_projected_bytes:
        mutationPhaseCompilation
          .control_context_projected_bytes ??
        null,
      control_context_saved_bytes:
        mutationPhaseCompilation
          .control_context_saved_bytes ??
        0,
      control_context_sha256:
        mutationPhaseCompilation
          .control_context_sha256 ??
        null,
      evidence_context_sha256:
        mutationPhaseCompilation
          .evidence_context_sha256 ??
        null,
      control_context_mutation_authority:
        false,
        mutation_phase_selected_tool:
          mutationPhaseCompilation?.selected_tool ?? null,
        mutation_phase_system_projection_mode:
          mutationPhaseCompilation?.system_projection_mode ?? null,
        mutation_phase_system_projection_reason:
          mutationPhaseCompilation?.system_projection_reason ?? null,
        mutation_phase_system_carrier_index:
          mutationPhaseCompilation?.system_carrier_index ?? null,
        mutation_phase_system_carrier_shape_sha256:
          mutationPhaseCompilation?.system_carrier_shape_sha256 ?? null,
        mutation_phase_message_projection_mode:
          mutationPhaseCompilation?.message_projection_mode ?? null,
        mutation_phase_message_projection_reason:
          mutationPhaseCompilation?.message_projection_reason ?? null,
        mutation_phase_message_carrier_index:
          mutationPhaseCompilation?.message_carrier_index ?? null,
        mutation_phase_message_carrier_role:
          mutationPhaseCompilation?.message_carrier_role ?? null,
        mutation_phase_message_carrier_shape_sha256:
          mutationPhaseCompilation?.message_carrier_shape_sha256 ?? null,
        mutation_tool_schema_projection_applied:
          mutationToolSchemaProjection?.applied === true,
        mutation_tool_schema_projection_reason:
          mutationToolSchemaProjection?.reason ?? null,
        mutation_tool_schema_source_bytes:
          mutationToolSchemaProjection?.source_bytes ?? null,
        mutation_tool_schema_projected_bytes:
          mutationToolSchemaProjection?.projected_bytes ?? null,
        mutation_tool_schema_reduction_bytes:
          mutationToolSchemaProjection?.reduction_bytes ?? 0,
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
        governor_work_protocol: GOVERNOR_WORK_PROTOCOL,
        governor_lease_protocol:
          governorInferenceLease.protocol,
        governor_lease_authority: "cost_observation_only",
        governor_work_input_bytes:
          governorWorkEstimate.input_bytes,
        governor_work_output_bound_bytes:
          governorWorkEstimate.output_bound_bytes,
        governor_work_output_bound_source:
          governorWorkEstimate.output_bound_source,
        governor_work_required_operations:
          governorWorkEstimate.required_operations,
        governor_work_estimate_bytes:
          governorWorkEstimate.work_bytes,
        governor_work_profile_samples:
          governorInferenceLease.profile_samples,
        governor_work_srtt_ms_per_byte:
          governorInferenceLease.srtt_ms_per_byte,
        governor_work_rttvar_ms_per_byte:
          governorInferenceLease.rttvar_ms_per_byte,
        governor_work_p95_ms_per_byte:
          governorInferenceLease.p95_ms_per_byte,
        governor_work_upper_ms_per_byte:
          governorInferenceLease.upper_ms_per_byte,
        governor_inference_lease_ms:
          governorInferenceLease.lease_ms,
        governor_inference_lease_source:
          governorInferenceLease.source,
        governor_dynamic_phase_budget_ms:
          governorAdaptiveWindows.phase_budget_ms,
        governor_dynamic_task_budget_ms:
          governorAdaptiveWindows.task_budget_ms,
        governor_mutation_authority: false,
        execution_control_protocol:
          EXECUTION_CONTROL_PROTOCOL,
        execution_control_selected_action:
          state.executionControlSelectedAction ?? null,
        execution_control_model_action_authority:
          false,
        execution_control_task_deadline_at_ms:
          state.executionControlTaskDeadlineAtMs ?? null,
        execution_control_task_window_authority:
          "observation_only",
        goal_directed_governor_protocol:
          GOAL_DIRECTED_GOVERNOR_PROTOCOL,
        goal_directed_objective:
          state.lastGoalDirectedDecision?.objective ?? null,
        goal_directed_reason:
          state.lastGoalDirectedDecision?.reason ?? null,
        goal_directed_proof_obligation:
          state.lastGoalDirectedDecision?.proof_obligation ?? null,
        goal_directed_probability:
          state.lastGoalDirectedDecision?.success_probability ?? null,
        goal_directed_probability_authority:
          state.lastGoalDirectedDecision?.probability_authority ?? null,
        execution_control_hard_deadline_interrupts:
          state.executionControlHardDeadlineInterrupts ?? 0,
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
      await stopAllTelemetrySamplers()

      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }

      sessionStates.clear()
    }
  },
}
