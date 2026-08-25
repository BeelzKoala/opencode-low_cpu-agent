
                  if (!owners.has(key)) {
                    owners.set(key, {
                      file,
                      symbol_kind: symbolKind,
                      symbol_name: symbolName,
                      start_line: startLine,
                      end_line: endLine,
                    })
                  }
                }

                ownerRecoveryOwners =
                  [...owners.values()].slice(0, 16)
              } else {
                ownerRecoveryReason =
                  "no_valid_owner_batches"
              }
            }
          }

          const exactStructuralGroups =
            Array.isArray(exactGroupsForCapsule) &&
            exactGroupsForCapsule.length > 0
              ? exactGroupsForCapsule
              : null

          const recoveredStructuralGroups =
            Array.isArray(ownerRecoveryGroups) &&
            ownerRecoveryGroups.length > 0
              ? ownerRecoveryGroups
              : null

          const renameMutationCapability =
            await attestRenameTargetCapability(
              root,
              state,
              queries,
              discoveryResults,
              exactStructuralGroups ?? [],
            )
          state.renameMutationCapability =
            renameMutationCapability?.ok === true
              ? renameMutationCapability
              : null

          const impactMutationCandidateRecovery =
            await recoverValidatedImpactMutationCandidateGroups(
              root,
              selectedImpactFiles,
            )

          const capsuleGroups = [
            ...(exactStructuralGroups ?? recoveredStructuralGroups ?? []),
            ...(impactMutationCandidateRecovery.groups ?? []),
          ]

          const capsuleStructuralSource =
            existingExactStructuralGroups
              ? "evidence_ir"
              : capsuleExactProbeGroups
                ? "exact_structural_probe"
                : recoveredStructuralGroups ||
                    impactMutationCandidateRecovery.groups.length > 0
                  ? "line_owner_recovery"
                  : "none"

          let editCapsule = null
          let localMutationCapability = null
          let localMutationCandidateSet = null
          let localCompetitorCheck = null
          if (mutationLocalization.eligible) {
            editCapsule = await buildEditCapsule(
              root,
              sessionID,
              state,
              capsuleGroups,
              scoutHandoff,
              capsuleStructuralSource,
              mutationLocalization,
            )

            if (editCapsule?.mutationReady === true) {
              localCompetitorCheck = await confirmLocalMutationCompetitors(
                root,
                state,
                scoutHandoff,
                editCapsule,
                rankedFiles,
                discoveryResults,
                queries,
                glob,
              )

              if (localCompetitorCheck.ok === true) {
                localMutationCandidateSet =
                  await attestLocalMutationCandidateSet(
                    root,
                    sessionID,
                    state,
                    scoutHandoff,
                    editCapsule,
                    localCompetitorCheck,
                  )

                localMutationCapability =
                  localMutationCandidateSet.primary
              }

              if (localMutationCapability?.ok === true) {
                state.localMutationHandoffPath =
                  localMutationCapability.localHandoffPath
                state.localMutationCapability = localMutationCapability
                state.localMutationCandidates =
                  localMutationCandidateSet?.candidates ?? []
                state.boundMutationTarget = null
                state.activeMutationHandoffPath = null
                applyExecutionEvent(
                  state,
                  "scout_ready",
                  "local_mutation_capability_ready",
                )
              } else {
                state.localMutationHandoffPath = null
                state.localMutationCapability = null
                state.localMutationCandidates = []
                state.boundMutationTarget = null
                state.activeMutationHandoffPath = null
                applyExecutionEvent(
                  state,
                  "scout_needs_evidence",
                  localMutationCapability?.reason ??
                    localCompetitorCheck?.reason ??
                    "local_mutation_capability_unavailable",
                )
              }
            } else {
              applyExecutionEvent(
                state,
                "scout_needs_evidence",
                "edit_capsule_unavailable",
              )
            }
          } else {
            applyExecutionEvent(
              state,
              "scout_needs_evidence",
              `mutation_localization_${mutationLocalization.reason}`,
            )
          }

          const elapsedMs = Math.round((performance.now() - started) * 100) / 100

          await writeProjectTrace(root, "search-trace.jsonl", {
            ts: nowMs(),
            protocol: SEARCH_PROTOCOL,
            sessionID,
            turnID: state?.turnID ?? null,
            project_root: root,
            attempt_index: attemptIndex,
            requested_queries: input?.queries,
            queries,
            path: target,
            glob: glob ?? null,
            requested_glob: requestedGlob ?? null,
            effective_glob: glob ?? null,
            glob_corrected: globResolution.corrected === true,
            glob_correction_reason: globResolution.reason,
            glob_inventory_complete: globResolution.inventoryComplete,
            glob_inventory_files: globResolution.inventoryFiles,
            glob_inventory_extensions: globResolution.inventoryExtensions,
            glob_inventory_cache_hit: globResolution.inventoryCacheHit,
            file_discovery_cap_per_query: FILE_DISCOVERY_CAP_PER_QUERY,
            line_hit_cap_per_query: LINE_HIT_CAP_PER_QUERY,
            lexical_discovery_complete: discoveryComplete,
            selected_scan_complete: selectedScanComplete,
            probe_scan_complete: selectedScanComplete,
            all_discovered_files_probed: allDiscoveredFilesProbed,
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
            mutation_localization_eligible:
              mutationLocalization.eligible,
            mutation_localization_reason:
              mutationLocalization.reason,
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
            edit_capsule_readiness_reason:
              editCapsule?.readinessReason ?? null,
            edit_capsule_structural_source:
              editCapsule?.structuralSource ?? null,
            edit_capsule_primary_mutation_candidate:
              editCapsule?.primaryMutationCandidate ?? null,
            edit_capsule_authorized_mutation_scope:
              editCapsule?.authorizedMutationScope ?? null,
            edit_capsule_mutation_capable_scopes:
              editCapsule?.mutationCapableScopes ?? 0,
            edit_capsule_mutation_scope_complete:
              editCapsule?.mutationScopeComplete ?? false,
            edit_capsule_context_complete:
              editCapsule?.contextComplete ?? null,
            edit_capsule_all_handoff_files_contextualized:
              editCapsule?.allHandoffFilesContextualized ?? null,
            edit_capsule_handoff_files_contextualized:
              editCapsule?.handoffFilesContextualized ?? null,
            edit_capsule_handoff_files_total:
              editCapsule?.handoffFilesTotal ?? null,
            edit_capsule_auxiliary_truncated:
              editCapsule?.auxiliaryTruncated ?? null,
            edit_capsule_omitted_scopes_by_budget:
              editCapsule?.omittedScopesByBudget ?? null,
            edit_capsule_downgraded_structural_scopes:
              editCapsule?.downgradedStructuralScopes ?? null,
            edit_capsule_readiness_blockers:
              editCapsule?.readinessBlockers ?? [],
            edit_capsule_readiness_warnings:
              editCapsule?.readinessWarnings ?? [],
            edit_capsule_coverage: editCapsule?.coverage ?? null,
            execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
            execution_state: state?.executionState ?? null,
            execution_reason: state?.executionReason ?? null,
            execution_event: state?.executionEvent ?? null,
            next_action: nextActionForExecutionState(state),
            candidate_files: rankedFiles.length,
            lexical_candidate_files: lexicalRankedFiles.length,

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

            discovery_elapsed_ms: discoveryElapsedMs,
            refine_elapsed_ms: refineElapsedMs,
            probe_elapsed_ms: refineElapsedMs,
            impact_index_attempted: impactIndexShadow.attempted,
            impact_index_ok: impactIndexShadow.ok,
            impact_index_reason: impactIndexShadow.reason,
            impact_index_elapsed_ms: impactIndexShadow.elapsedMs,
            impact_graph_probe_cap: IMPACT_GRAPH_PROBE_MAX_FILES,
            impact_graph_emit_cap: IMPACT_GRAPH_EMIT_MAX_FILES,
            impact_validation_attempted: impactValidation.attempted,
            impact_validation_reason: impactValidation.reason,
            impact_validation_elapsed_ms: impactValidation.elapsedMs,
            impact_validation_queries: impactValidation.queryCount,
            impact_hypotheses: impactValidation.hypotheses.length,
            impact_validated: impactValidation.validated.length,
            impact_rejected: impactValidation.rejected.length,

            semantic_impact_attempted:
              semanticImpactShadow.attempted,
            semantic_impact_ok:
              semanticImpactShadow.ok,
            semantic_impact_reason:
              semanticImpactShadow.reason,
            semantic_impact_elapsed_ms:
              semanticImpactShadow.elapsedMs,
            semantic_impact_queries:
              semanticImpactShadow.queries,
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
            semantic_impact_skipped:
              semanticImpactShadow.skipped,
            semantic_impact_engines:
              semanticImpactShadow.engines,
            semantic_impact_outcomes:
              semanticImpactShadow.outcomes,

            impact_scope_conditioned: true,
            impact_scope_seed_contexts: impactValidation.seedContexts,
            impact_scope_owner_symbols: impactValidation.ownerSymbols,
            impact_pairwise_conditioned: impactValidation.pairwiseConditioned === true,
            impact_filter_before_cap: impactIndexShadow.taskFiltersApplied === true,
            impact_filter_query_elapsed_ms: impactValidation.filterQueryElapsedMs,
            impact_refresh_fallback_attempted: impactValidation.refreshFallbackAttempted === true,
            impact_refresh_fallback_elapsed_ms: impactValidation.refreshFallbackElapsedMs,
            impact_pre_refresh_refresh_due: impactValidation.initialIndexStats?.refreshDue === true,
            impact_pre_refresh_stale_seed_files: impactValidation.initialIndexStats?.staleSeedFiles ?? 0,
            impact_pre_refresh_stale_witness_edges: impactValidation.initialIndexStats?.staleWitnessEdges ?? 0,
            impact_pre_refresh_cache_age_ms: impactValidation.initialIndexStats?.cacheAgeMs ?? null,
            impact_refresh_fallback_cause:
              impactValidation.refreshFallbackAttempted !== true
                ? null
                : ((impactValidation.initialIndexStats?.staleSeedFiles ?? 0) > 0 ||
                    (impactValidation.initialIndexStats?.staleWitnessEdges ?? 0) > 0)
                  ? "fingerprint_stale"
                  : impactValidation.initialIndexStats?.refreshDue === true
                    ? "age_or_unavailable"
                    : "validation_miss",
            impact_scope_relations_rejected: impactValidation.scopeRejected,
            impact_index_coverage_complete: impactIndexShadow.refreshComplete,
            impact_index_partial_reason: impactIndexShadow.partialReason,
            impact_index_inventory_kind: impactIndexShadow.inventoryKind,
            impact_index_local_resolved: impactIndexShadow.resolvedImports,
            impact_index_local_unresolved: impactIndexShadow.unresolvedImports,
            impact_index_local_ambiguous: impactIndexShadow.ambiguousImports,
            impact_index_external_packages: impactIndexShadow.externalPackages,
            impact_index_unsupported_aliases: impactIndexShadow.unsupportedAliases,
            impact_emitted_files: selectedImpactFiles.length,
            impact_emitted: selectedImpactFiles.map((entry) => ({
              file: entry.file,
              seed: entry.impact?.seed ?? null,
              direction: entry.impact?.direction ?? null,
              bindings: entry.impact?.bindings ?? [],
              validation_kind: entry.impact?.validationKind ?? null,
              sample_line: entry.impact?.sample?.line ?? null,
            })),
            impact_index_refresh_due: impactIndexShadow.refreshDue,
            impact_index_refresh_deferred: impactIndexShadow.refreshDeferred === true,
            impact_index_stale_seed_files: impactIndexShadow.staleSeedFiles,
            impact_index_stale_witness_edges: impactIndexShadow.staleWitnessEdges,
            impact_index_bootstrap_cache_hit: impactIndexShadow.bootstrapCacheHit === true,
            impact_index_refresh_ok: impactIndexShadow.refreshOk,
            impact_index_refresh_reason: impactIndexShadow.refreshReason,
            impact_index_refresh_elapsed_ms: impactIndexShadow.refreshElapsedMs,
            impact_index_query_elapsed_ms: impactIndexShadow.queryElapsedMs,
            impact_index_cache_age_ms: impactIndexShadow.cacheAgeMs,
            impact_index_files_total: impactIndexShadow.filesTotal,
            impact_index_files_reused: impactIndexShadow.filesReused,
            impact_index_files_reindexed: impactIndexShadow.filesReindexed,
            impact_index_files_removed: impactIndexShadow.filesRemoved,
            impact_index_imports_total: impactIndexShadow.importsTotal,
            impact_index_edges_total: impactIndexShadow.edgesTotal,
            impact_index_resolved_imports: impactIndexShadow.resolvedImports,
            impact_index_unresolved_imports: impactIndexShadow.unresolvedImports,
            impact_index_neighbors_total: impactIndexShadow.neighborsTotal,
            impact_index_neighbors_shown: impactIndexShadow.neighborsShown,
            impact_index_lexical_misses: impactIndexShadow.lexicalMisses,
            impact_index_forward_neighbors: impactIndexShadow.forwardNeighbors,
            impact_index_reverse_neighbors: impactIndexShadow.reverseNeighbors,
            impact_index_candidates: impactIndexShadow.candidates,
            impact_index_routing_active:
              selectedImpactFiles.length > 0,

            structural_emit_reservation_candidate:
              structuralReservationCandidate
                ? {
                    file:
                      structuralReservationCandidate.file,
                    probe_definition_hints:
                      structuralReservationCandidate
                        .probeDefinitionHints ?? 0,
                    probe_exact_matches:
                      structuralReservationCandidate
                        .probeExactMatches ?? 0,
                    probe_rank:
                      probeRankedFiles.findIndex(
                        (candidate) =>
                          candidate.file ===
                          structuralReservationCandidate.file,
                      ) + 1,
                  }
                : null,

            structural_emit_reservation_selected:
              structuralReservationCandidate
                ? selectedLexicalFileSet.has(
                    evidenceFileKey(
                      structuralReservationCandidate.file,
                    ),
                  )
                : false,

            probe_files: probeFiles.map((entry) => ({
              file: entry.file,
              queries: [...entry.queries].sort((a, b) => a - b),

              // Effective rank entering the line-probe stage.
              initial_rank:
                rankedFiles.findIndex(
                  (candidate) => candidate.file === entry.file,
                ) + 1,

              // Independent routing provenance. These values prove whether
              // BM25F/RRF changed lexical ordering; they are never authority.
              lexical_rank:
                entry.retrievalLexicalRank ?? null,
              retrieval_rank:
                entry.retrievalRank ?? null,
              bm25_rank:
                entry.retrievalBm25Rank ?? null,
              bm25f_score:
                entry.retrievalBm25fScore ?? null,
              rrf_score:
                entry.retrievalRrfScore ?? null,
              structural_complete:
                entry.retrievalStructuralComplete ?? null,
            })),
            lexical_probed_files: probeFileSet.size,
            impact_probed_files: impactValidation.queryCount,
            probed_files: probeFileSet.size + impactValidation.queryCount,
            lexical_emitted_files: selectedLexicalFileSet.size,
            impact_emitted_files_count: selectedImpactFiles.length,
            emitted_files: selectedFileSet.size,
            selected_files: selectedFiles.map((entry) => ({
              file: entry.file,
              origin: entry.origin ?? "lexical",
              queries: [...(entry.queries ?? [])].sort((a, b) => a - b),
              coverage: entry.coverage,
              path_affinity: entry.pathAffinity,
              rarity: entry.rarity,
              initial_rank: entry.origin === "impact" ? null : entry.initialRank ?? null,
              probe_line_hits: entry.origin === "impact" ? null : entry.probeLineHits ?? 0,
              probe_exact_matches: entry.origin === "impact" ? null : entry.probeExactMatches ?? 0,
              probe_definition_hints: entry.origin === "impact" ? null : entry.probeDefinitionHints ?? 0,
              probe_rank:
                entry.origin === "impact"
                  ? null
                  : probeRankedFiles.findIndex((candidate) => candidate.file === entry.file) + 1,
              impact_seed: entry.impact?.seed ?? null,
              impact_direction: entry.impact?.direction ?? null,
              impact_bindings: entry.impact?.bindings ?? [],
              impact_validation_kind: entry.impact?.validationKind ?? null,
            })),
            retained_unread_files: Math.max(0, rankedFiles.length - probeFileSet.size),
            retained_unemitted_files: routeRendered.retained,
            probed_unemitted_files: Math.max(0, probeFileSet.size - selectedLexicalFileSet.size),
            discovery_files_by_query: discoveryResults.map((result) => ({
              query_index: result.queryIndex,
              files: result.files?.length ?? 0,
              complete: result.scanComplete,
              capped: result.scanCapped,
              timed_out: result.timedOut,
              error: result.error ?? null,
              match_mode: result.matchMode ?? "exact",
              effective_query: result.effectiveQuery ?? result.query,
              compiler_tokens: result.compilerTokens ?? [],
              query_formulation_protocol:
                result.queryFormulation?.protocol ?? null,
              query_formulation:
                result.queryFormulation ?? null,
            })),
            query_compiler_fallbacks: discoveryResults
              .filter((result) => result.matchMode && result.matchMode !== "exact")
              .map((result) => ({
                query_index: result.queryIndex,
                match_mode: result.matchMode,
              })),
            query_formulation_protocol: QUERY_FORMULATION_PROTOCOL,
            query_formulation_fallbacks: discoveryResults
              .filter((result) => result.queryFormulation)
              .map((result) => ({
                query_index: result.queryIndex,
                match_mode: result.matchMode,
                branches:
                  result.queryFormulation?.branches?.length ?? 0,
                selected_files:
                  result.queryFormulation?.selected_files ?? 0,
              })),
            reused_query_count: reusedQueryCount,
            executed_query_count: executedQueryCount,
            reused_queries: queryPlan
              .filter((item) => item.cached)
              .map((item) => item.query),
            query_cache_entries: state?.queryCache?.size ?? null,
            query_cache_matches: state?.queryCacheMatches ?? null,
            representation,
            source_representation: sourceRepresentation,
            unique_hits: hits.size,
            probed_unique_hits: probeHits.size,
            exact_span_hits: exactSpanHits,
            probed_exact_span_hits: probedExactSpanHits,
            distill_input_hits: distillInput.length,
            capsule_exact_probe_attempted:
              capsuleExactProbeAttempted,
            capsule_exact_probe_reason:
              capsuleExactProbeReason,
            capsule_exact_probe_elapsed_ms:
              capsuleExactProbeElapsedMs,
            capsule_exact_probe_groups:
              Array.isArray(capsuleExactProbeGroups)
                ? capsuleExactProbeGroups.length
                : null,

            owner_recovery_input_hits: ownerRecoveryInput.length,
            owner_recovery_attempted: ownerRecoveryAttempted,
            owner_recovery_reason: ownerRecoveryReason,
            owner_recovery_elapsed_ms: ownerRecoveryElapsedMs,
            owner_recovery_observed: ownerRecoveryObserved,
            owner_recovery_distill_complete:
              ownerRecoveryDistillComplete,
            owner_recovery_location_complete:
              ownerRecoveryLocationComplete,
            owner_recovery_anchor_complete:
              ownerRecoveryAnchorComplete,
            owner_recovery_witness_complete:
              ownerRecoveryWitnessComplete,
            owner_recovery_ir_complete:
              ownerRecoveryIrComplete,
            owner_recovery_exact_span_hits:
              ownerRecoveryExactSpanHits,
            owner_recovery_mapped_hits:
              ownerRecoveryMappedHits,
            owner_recovery_group_count:
              ownerRecoveryGroupCount,
            owner_recovery_files_attempted:
              ownerRecoveryFilesAttempted,
            owner_recovery_files_accepted:
              ownerRecoveryFilesAccepted,
            owner_recovery_files_rejected:
              ownerRecoveryFilesRejected,
            owner_recovery_rejected_files:
              ownerRecoveryRejectedFiles,
            owner_recovery_owners:
              ownerRecoveryOwners,
            shown_hits: shownHits,
            scan_complete: scanComplete,
            evidence_complete: evidenceComplete,
            complete,
            elapsed_ms: elapsedMs,
            output_bytes: resultBytes,
            body_bytes: bodyBytes,
            body_budget_bytes: bodyBudget,
            raw_output_bytes: rawResultBytes,
            raw_body_bytes: rawRendered.bodyBytes,
            raw_evidence_complete: rawEvidenceComplete,
            selected_evidence_complete: selectedEvidenceComplete,
            raw_novel_emitted_lines: rawNovelEmittedLines,
            raw_prior_hits: rawPriorHits,
            raw_skipped_prior_lines: rawSkippedPriorLines,
            raw_suppressed_context_anchors: rawSuppressedContextAnchors,
            focused_candidate: focusedCandidate,
            focused_attempted: focusedAttempted,
            focused_reason: focusedReason,
            focused_supplement_bytes: focusedSupplementBytes,
            focused_scope_candidates: focusedScopeCandidates,
            focused_selected_scopes: focusedSelectedScopes,
            focused_reused_scopes: focusedReusedScopes,
            focused_full_scopes: focusedFullScopes,
            focused_partial_scopes: focusedPartialScopes,
            focused_radius: focusedRadius,
            focused_canonical_saved_bytes: focusedCanonicalSavedBytes,
            focused_cost_limit_bytes:
              rawResultBytes > 0
                ? Math.min(
                    rawResultBytes + FOCUSED_MAX_OVERHEAD_BYTES,
                    Math.ceil(rawResultBytes * FOCUSED_MAX_OVERHEAD_RATIO),
                  )
                : null,
            region_attempted: regionAttempted,
            region_reason: regionReason,
            region_scopes: regionScopes,
            region_sampled_scopes: regionSampledScopes,
            region_sampled_hits: regionSampledHits,
            region_retained_hits: regionRetainedHits,
            pressure_active: pressure.active,
            pressure_reasons: pressure.reasons,
            max_hits_per_file: pressure.maxHitsPerFile,
            distill_attempted: distillAttempted,
            distill_reason: distillReason,
            distill_elapsed_ms: distillElapsedMs,
            distiller_elapsed_ms: distillerElapsedMs,
            distill_ir_complete: distillIrComplete,
            distill_witness_complete: distillWitnessComplete,
            v2_grouping_preserved: v2GroupingPreserved,
            hybrid_groups: hybridGroups,
            hybrid_variants: hybridVariants,
            hybrid_body_bytes: hybridBodyBytes,
            hybrid_core_bytes: hybridCoreBytes,
            hybrid_context_samples: hybridContextSamples,
            hybrid_ratio: hybridRatio,
            variant_diversity: variantDiversity,
            index_reason: indexReason,
            index_render_complete: indexRenderComplete,
            index_files: indexFiles,
            index_samples: indexSamples,
            index_structural_groups: indexStructuralGroups,
            index_discriminative_facets: indexDiscriminativeFacets,
            refinement_required: refinementRequired,
            ledger_facts_before: ledgerFactsBefore,
            ledger_new_facts: novelty.novel.size,
            ledger_prior_facts: novelty.prior,
            ledger_facts_added: ledgerFactsAdded,
            ledger_facts_after: state?.evidenceLedger?.size ?? null,
            ledger_saturated: state?.ledgerSaturated ?? null,
            route_ledger_new_facts: routeNovelty.novel.size,
            route_ledger_prior_facts: routeNovelty.prior,
            route_ledger_facts_added: routeFactsAdded,
            route_ledger_facts_after: state?.routeLedger?.size ?? null,
            meaningful_route_progress: meaningfulRouteProgress,
            novel_positive_facts: novelFactStats.positive,
            novel_context_facts: novelFactStats.context,
            novel_negative_facts: novelFactStats.negative,
            novel_structural_facts: novelFactStats.structural,
            novel_routing_facts: novelFactStats.routing,
            no_progress: noProgress,
            no_progress_streak: state?.consecutiveNoProgress ?? null,
            no_progress_blocked: noProgressBlocked,
            contextualized_hit_lines:
              state?.contextualizedHitLines?.size ?? null,
            turn_model_calls: state?.modelCalls ?? null,
            turn_search_attempts: state?.searchAttempts ?? null,
            turn_executed_searches: state?.executedSearches ?? null,
            turn_evidence_bytes: state?.evidenceBytes ?? null,
          })

          // Context Boundary:
          // once deterministic Scout + structural validation has produced
          // an authorized mutation capsule, raw discovery evidence is no
          // longer model-facing. The user task remains in conversation and
          // the capsule contains the bounded source context required for the
          // only exposed next action(s): capability-derived mutation tools.
          //
          // Full Scout evidence remains persisted in search trace / handoff
          // artifacts; this changes only the next model-facing projection.
          const mutationFrontier = mutationToolsForState(state)
          const actionableContent = mutationFrontier.length > 0
            ? `${editCapsule.text}\nNEXT_ACTION=${mutationFrontier.join(",")} reason=edit_capsule_ready search_locked=true`
            : content

          return {
            content: actionableContent,
            metadata: {
              protocol: SEARCH_PROTOCOL,
              project_root: root,
              turnID: state?.turnID ?? null,
              attempt_index: attemptIndex,
              turn_model_calls: state?.modelCalls ?? null,
              turn_executed_searches: state?.executedSearches ?? null,
              turn_evidence_bytes: state?.evidenceBytes ?? null,
              representation,
              source_representation: sourceRepresentation,
              requested_glob: requestedGlob ?? null,
              effective_glob: glob ?? null,
              glob_corrected: globResolution.corrected === true,
              glob_correction_reason: globResolution.reason,
              glob_inventory_complete: globResolution.inventoryComplete,
              glob_inventory_files: globResolution.inventoryFiles,
              glob_inventory_extensions: globResolution.inventoryExtensions,
              glob_inventory_cache_hit: globResolution.inventoryCacheHit,
              query_formulation_protocol: QUERY_FORMULATION_PROTOCOL,
              query_formulation_used: discoveryResults.some(
                (result) => result?.queryFormulation != null,
              ),
              query_formulation_fallbacks: discoveryResults
                .filter((result) => result?.queryFormulation != null)
                .map((result) => ({
                  query_index: result.queryIndex,
                  match_mode: result.matchMode ?? null,
                  branches: result.queryFormulation?.branches?.length ?? 0,
                  selected_files: result.queryFormulation?.selected_files ?? 0,
                })),
              unique_hits: hits.size,
              shown_hits: shownHits,
              scan_complete: scanComplete,
              lexical_discovery_complete: discoveryComplete,
              selected_scan_complete: selectedScanComplete,
              probe_scan_complete: selectedScanComplete,
              all_discovered_files_probed: allDiscoveredFilesProbed,
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
              mutation_action_frontier: mutationFrontier,
              mutation_action_reason: resolveMutationActionForState(state).reason,
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
        },
      })
    }))

    await track(ctx.tool.transform((tools) => {
      const executeCapabilityMutation = async (rawInput, toolContext, forcedKind, toolName) => {
        const input = {
          ...(rawInput ?? {}),
          kind: forcedKind,
        }
          const started = performance.now()
          const sessionID =
            typeof toolContext?.sessionID === "string" && toolContext.sessionID.length > 0
              ? toolContext.sessionID
              : null
          const state = getSessionState(sessionID)
          const root = await rootForTool(ctx, toolContext, sessionID, state)
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
            : validateMutationShape(input)

          // Tool-schema/transport violations are not semantic patch attempts.
          // With action-specific top-level required fields these should be
          // unreachable under a conforming provider; if they reach runtime,
          // fail closed without consuming the one semantic repair.
          if (shape.ok !== true) {
            state.contractFailures += 1
            const repeated = state.contractFailureSignatures.has(shape.signature)
            state.contractFailureSignatures.add(shape.signature)
            applyExecutionEvent(state, "fatal", "tool_contract_violation")

            await trace({
              admitted: false,
              failure_layer: "tool_contract",
              reason: "tool_contract_violation",
              contract_detail: shape.detail,
              contract_signature: shape.signature,
              repeated_contract_failure: repeated,
              action: "stop",
              compiler_run: false,
              executor_run: false,
            })

            return {
              content:
                `PATCH_STOP reason=tool_contract_violation ` +
                `detail=${shape.detail} semantic_attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} ` +
                `contract_failures=${state.contractFailures} action=report_blocked`,
              metadata: {
                protocol: EXECUTION_LOOP_PROTOCOL,
                action: "stop",
                reason: "tool_contract_violation",
                detail: shape.detail,
                failure_layer: "tool_contract",
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

          state.activeMutationTool = toolName

          if (state.executionState === EXEC_STATE_REPAIR) {
            state.repairAttempts += 1
          }

          state.mutationAttempts += 1
          state.lastSeen = nowMs()

          const authorization =
            await materializeCapabilityBoundMutation(
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

            const canRetryAuthorization =
              authorization.repairable === true &&
              state.mutationAttempts < MAX_PATCH_ATTEMPTS_PER_TURN

            if (canRetryAuthorization) {
              applyExecutionEvent(
                state,
                "patch_retry",
                reason,
              )

              await trace({
                admitted: false,
                failure_layer: "scope_authorization",
                reason,
                scope_detail: detail,
                action: "retry",
                compiler_run: false,
                executor_run: false,
              })

              return {
                content:
                  `PATCH_RETRY reason=${reason} ` +
                  `detail=${detail} ` +
                  `attempts=${state.mutationAttempts}/${MAX_PATCH_ATTEMPTS_PER_TURN} ` +
                  `action=revise_semantic_owner_binding`,
                metadata: {
                  protocol: EXECUTION_LOOP_PROTOCOL,
                  action: "retry",
                  reason,
                  detail,
                  failure_layer: "scope_authorization",
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
                failure_layer: "scope_authorization",
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
                  failure_layer: "scope_authorization",
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

          const mutation =
            authorization.mutation

          const mutations = [mutation]

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
            const canRetry =
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
