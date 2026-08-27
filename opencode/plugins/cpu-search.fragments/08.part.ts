            glob_inventory_extensions: globResolution.inventoryExtensions,
            glob_inventory_cache_hit: globResolution.inventoryCacheHit,

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
            source_family_resolved_roles:
              globResolution.sourceFamilyPlan?.resolved_roles ?? [],
            source_family_unresolved_roles:
              globResolution.sourceFamilyPlan?.unresolved_roles ?? [],
            source_family_selected_families:
              globResolution.sourceFamilyPlan?.selected_families ?? [],
            source_family_added_extensions:
              globResolution.sourceFamilyPlan?.added_extensions ?? [],
            glob_role_broadened:
              globResolution.roleBroadened === true,

            file_discovery_cap_per_query: FILE_DISCOVERY_CAP_PER_QUERY,
            line_hit_cap_per_query: LINE_HIT_CAP_PER_QUERY,
            lexical_discovery_complete: discoveryComplete,
            selected_scan_complete: selectedScanComplete,
            probe_scan_complete: selectedScanComplete,
            all_discovered_files_probed: allDiscoveredFilesProbed,
            all_discovered_files_emitted: allDiscoveredFilesSelected,
            routing_active: routingActive,
            route_strategy: "query_fair_lexical8_plus_task_local_impact",
            framework_resource_bridge_protocol:
              frameworkRouting.protocol,
            framework_routing_authority:
              frameworkRouting.authority,
            framework_routing_mutation_authority:
              frameworkRouting.mutationAuthority,
            framework_routing_files_scanned:
              frameworkRouting.filesScanned,
            framework_routing_skipped_files:
              frameworkRouting.skippedFiles,
            framework_routing_frameworks:
              frameworkRouting.frameworks,
            framework_routing_witnesses:
              frameworkRouting.witnesses,
            framework_routing_edge_candidates:
              frameworkRouting.edgeCandidates,
            framework_resource_edges_validated:
              frameworkRouting.validatedEdges,
            framework_resource_edges_rejected:
              frameworkRouting.rejectedEdges,
            framework_resource_edge_kinds:
              frameworkRouting.edgeKinds,
            framework_resource_edges_truncated:
              frameworkRouting.truncated,
            resource_adapter_bridge_protocol:
              resourceRouting.protocol,
            resource_adapter_routing_authority:
              resourceRouting.authority,
            resource_adapter_mutation_authority:
              resourceRouting.mutationAuthority,
            resource_adapter_files_scanned:
              resourceRouting.filesScanned,
            resource_adapter_skipped_files:
              resourceRouting.skippedFiles,
            resource_adapter_families:
              resourceRouting.families,
            resource_adapter_witnesses:
              resourceRouting.witnesses,
            resource_adapter_edge_candidates:
              resourceRouting.edgeCandidates,
            resource_adapter_edges_validated:
              resourceRouting.validatedEdges,
            resource_adapter_edges_rejected:
              resourceRouting.rejectedEdges,
            resource_adapter_edge_kinds:
              resourceRouting.edgeKinds,
            resource_adapter_edges_truncated:
              resourceRouting.truncated,

            task_anchor_protocol:
              state?.taskAnchors?.protocol ??
              TASK_ANCHOR_PROTOCOL,
            task_anchor_status:
              state?.taskAnchors?.status ?? null,
            task_anchor_count:
              state?.taskAnchors?.anchors?.length ??
              0,
            task_anchor_kinds:
              [
                ...new Set(
                  (
                    state?.taskAnchors?.anchors ??
                    []
                  ).map(
                    (item) =>
                      item.kind,
                  ),
                ),
              ].sort(),
            task_anchor_truncated:
              state?.taskAnchors?.truncated ===
              true,

            task_shape_protocol:
              state?.taskShape?.protocol ??
              TASK_SHAPE_PROTOCOL,
            task_shape_authority:
              state?.taskShape?.authority ?? null,
            task_shape_status:
              state?.taskShape?.status ?? null,
            task_shape_shape:
              state?.taskShape?.shape ?? null,
            task_shape_reason:
              state?.taskShape?.reason ?? null,
            task_shape_additive_evidence:
              (
                state?.taskShape
                  ?.additive_evidence ??
                []
              )
                .map(
                  (item) => ({
                    rule:
                      item.rule,
                    verb:
                      item.verb,
                    surface:
                      item.surface,
                    index:
                      item.index,
                  }),
                )
                .slice(
                  0,
                  8,
                ),
            task_shape_conflict_evidence:
              (
                state?.taskShape
                  ?.conflict_evidence ??
                []
              )
                .map(
                  (item) => ({
                    verb:
                      item.verb,
                    index:
                      item.index,
                  }),
                )
                .slice(
                  0,
                  8,
                ),
            task_shape_localization_authority:
              state?.taskShape
                ?.localization_authority ??
              false,
            task_shape_mutation_authority:
              state?.taskShape
                ?.mutation_authority ??
              false,

            additive_localization_plan_protocol:
              state?.additiveLocalizationPlan
                ?.protocol ??
              ADDITIVE_LOCALIZATION_PLAN_PROTOCOL,
            additive_localization_plan_authority:
              state?.additiveLocalizationPlan
                ?.authority ??
              null,
            additive_localization_plan_status:
              state?.additiveLocalizationPlan
                ?.status ??
              null,
            additive_localization_plan_reason:
              state?.additiveLocalizationPlan
                ?.reason ??
              null,
            additive_localization_plan_task_kind:
              state?.additiveLocalizationPlan
                ?.task_kind ??
              null,

            additive_localization_positive_obligations:
              state?.additiveLocalizationPlan
                ?.positive_localization_obligations ??
              [],

            additive_localization_positive_bindings:
              (
                state?.additiveLocalizationPlan
                  ?.positive_localization_bindings ??
                []
              ).slice(
                0,
                16,
              ),

            additive_localization_positive_source_families:
              state?.additiveLocalizationPlan
                ?.positive_localization_source_families ??
              [],

            additive_localization_protected_obligations:
              state?.additiveLocalizationPlan
                ?.protected_surface_obligations ??
              [],

            additive_localization_protected_bindings:
              (
                state?.additiveLocalizationPlan
                  ?.protected_surface_bindings ??
                []
              ).slice(
                0,
                16,
              ),

            additive_localization_protected_source_families:
              state?.additiveLocalizationPlan
                ?.protected_surface_source_families ??
              [],

            additive_localization_implementation_roles:
              state?.additiveLocalizationPlan
                ?.implementation_verification_roles ??
              [],

            additive_localization_policy_roles:
              state?.additiveLocalizationPlan
                ?.policy_roles ??
              [],

            additive_localization_plan_localization_authority:
              state?.additiveLocalizationPlan
                ?.localization_authority ??
              false,

            additive_localization_plan_mutation_authority:
              state?.additiveLocalizationPlan
                ?.mutation_authority ??
              false,

            anchor_frontier_protocol:
              anchorFrontier.protocol,
            anchor_frontier_status:
              anchorFrontier.status,
            anchor_frontier_reason:
              anchorFrontier.reason,
            anchor_frontier_route_anchor:
              anchorFrontier.route_anchor,
            anchor_frontier_candidate_files:
              anchorFrontier.candidate_files,
            anchor_frontier_search_complete:
              anchorFrontier.search_complete,
            anchor_frontier_search_truncated:
              anchorFrontier.search_truncated,
            anchor_frontier_inspection_truncated:
              anchorFrontier.inspection_truncated,
            anchor_frontier_owner:
              anchorFrontier.owner,
            anchor_frontier_owner_file:
              anchorFrontier.owner_file,
            anchor_frontier_owner_candidates:
              anchorFrontier.owner_candidates,
            anchor_frontier_localization_authority:
              anchorFrontier.localization_authority,
            anchor_frontier_mutation_authority:
              anchorFrontier.mutation_authority,

            host_resource_inventory_protocol:
              hostResourceInventory.protocol,
            host_resource_inventory_files:
              hostResourceInventory.files.length,
            host_resource_inventory_complete:
              hostResourceInventory.complete,
            host_resource_inventory_truncated:
              hostResourceInventory.truncated,
            host_resource_inventory_timed_out:
              hostResourceInventory.timed_out,
            host_resource_inventory_cache_hit:
              hostResourceInventory.cache_hit,

            host_resource_closure_protected_surface:
              hostResourceClosure.protected_surface,
            host_resource_closure_ui_candidate:
              hostResourceClosure.ui_candidate,
            host_resource_closure_navigation_candidate:
              hostResourceClosure.navigation_candidate,
            host_resource_closure_structurally_ready:
              hostResourceClosure.structurally_ready,
            host_resource_closure_structurally_missing:
              hostResourceClosure.structurally_missing,
            host_resource_closure_semantically_ready:
              hostResourceClosure.semantically_ready,
            host_resource_closure_positive_complete:
              hostResourceClosure.positive_complete,

            host_obligation_projector_protocol:
              hostObligationProjection
                .protocol,

            host_obligation_projector_status:
              hostObligationProjection
                .status,

            host_obligation_projector_proofs:
              hostObligationProjection
                .proofs
                .map(
                  (item) =>
                    item.obligation,
                ),

            task_bound_host_evidence_protocol:
              taskBoundHostEvidence
                .protocol,

            task_bound_host_evidence_status:
              taskBoundHostEvidence
                .status,

            task_bound_host_evidence:
              taskBoundHostEvidence
                .evidence
                .map(
                  (item) => ({
                    role:
                      item.role,

                    tier:
                      item.tier,

                    ambiguous:
                      item.ambiguous ===
                      true,

                    localization_authority:
                      item.localization_authority ===
                      true,

                    mutation_authority:
                      item.mutation_authority ===
                      true,
                  }),
                ),

            task_role_evidence_merge_status:
              mergedRoleEvidence
                .status,

            task_role_evidence_merge_truncated:
              mergedRoleEvidence
                .truncated ===
              true,

            task_role_evidence_roles:
              mergedRoleEvidence
                .evidence
                .map(
                  (item) =>
                    item.role,
                ),


            host_resource_closure_protocol:
              hostResourceClosure.protocol,
            host_resource_closure_status:
              hostResourceClosure.status,
            host_resource_aliases:
              (
                hostResourceClosure
                  .aliases ??
                []
              )
                .map(
                  (item) => ({
                    logical_node:
                      item.logical_node,
                    physical_node:
                      item.physical_node,
                    physical_file:
                      item.physical_file,
                    resource_root:
                      item.resource_root,
                    proof:
                      item.proof,
                  }),
                )
                .slice(
                  0,
                  16,
                ),
            host_resource_followup_files:
              hostResourceClosure
                .followup_files ??
              [],
            host_resource_followup_truncated:
              hostResourceClosure
                .followup_truncated ===
              true,
            navigation_reverse_protocol:
              navigationReverseDiscovery
                .protocol,

            navigation_reverse_target_literals:
              navigationReverseDiscovery
                .target_literals,

            navigation_reverse_candidate_files:
              navigationReverseDiscovery
                .candidate_files,

            navigation_reverse_search_complete:
              navigationReverseDiscovery
                .search_complete,

            navigation_reverse_search_truncated:
              navigationReverseDiscovery
                .search_truncated,

            navigation_reverse_elapsed_ms:
              navigationReverseDiscovery
                .elapsed_ms,

            navigation_reverse_framework_files_scanned:
              navigationReverseFramework
                .filesScanned,

            navigation_reverse_framework_skipped_files:
              navigationReverseFramework
                .skippedFiles,

            navigation_reverse_framework_edges_validated:
              navigationReverseFramework
                .validatedEdges,

            navigation_reverse_framework_edges_rejected:
              navigationReverseFramework
                .rejectedEdges,

            navigation_reverse_framework_truncated:
              navigationReverseFramework
                .truncated ===
              true,

            host_resource_followup_framework_files_scanned:
              hostResourceClosure
                .framework_files_scanned ??
              0,
            host_resource_followup_framework_edges_validated:
              hostResourceClosure
                .framework_edges_validated ??
              0,
            host_resource_followup_resource_files_scanned:
              hostResourceClosure
                .resource_files_scanned ??
              0,
            host_resource_followup_resource_edges_validated:
              hostResourceClosure
                .resource_edges_validated ??
              0,
            host_resource_closure_localization_authority:
              hostResourceClosure
                .localization_authority,
            host_resource_closure_mutation_authority:
              hostResourceClosure
                .mutation_authority,

            host_integration_shadow_protocol:
              hostIntegrationShadow.protocol ??
              HOST_INTEGRATION_SHADOW_PROTOCOL,
            host_integration_shadow_authority:
              hostIntegrationShadow.authority,
            host_integration_shadow_status:
              hostIntegrationShadow.status,
            host_integration_shadow_reason:
              hostIntegrationShadow.reason,
            host_integration_shadow_localization_authority:
              hostIntegrationShadow.localization_authority,
            host_integration_shadow_mutation_authority:
              hostIntegrationShadow.mutation_authority,

            host_obligation_spec_status:
              hostIntegrationShadow
                .obligation_spec
                ?.status ??
              null,
            host_obligation_spec_positive:
              (
                hostIntegrationShadow
                  .obligation_spec
                  ?.positive_specs ??
                []
              )
                .map(
                  (item) =>
                    item.obligation,
                )
                .slice(
                  0,
                  16,
                ),
            host_obligation_spec_protected_anchor_status:
              hostIntegrationShadow
                .obligation_spec
                ?.protected_anchor_status ??
              null,
            host_obligation_spec_protected_routes:
              (
                hostIntegrationShadow
                  .obligation_spec
                  ?.protected_route_candidates ??
                []
              )
                .map(
                  (item) =>
                    item.value,
                )
                .slice(
                  0,
                  8,
                ),

            host_graph_view_validated_edges:
              hostIntegrationShadow
                .graph_views
                ?.validated_edge_count ??
              0,
            host_graph_view_rejected_edges:
              hostIntegrationShadow
                .graph_views
                ?.rejected_edge_count ??
              0,
            host_graph_view_truncated:
              hostIntegrationShadow
                .graph_views
                ?.truncated ===
              true,

            host_protected_surface:
              hostIntegrationShadow
                .bindings
                ?.protected_surface
                ? {
                    status:
                      hostIntegrationShadow
                        .bindings
                        .protected_surface
                        .status,

                    route_anchor:
                      hostIntegrationShadow
                        .bindings
                        .protected_surface
                        .route_anchor ??
                      null,

                    owner:
                      hostIntegrationShadow
                        .bindings
                        .protected_surface
                        .owner ??
                      null,

                    owner_candidates:
                      (
                        hostIntegrationShadow
                          .bindings
                          .protected_surface
                          .owner_candidates ??
                        []
                      ).slice(
                        0,
                        8,
                      ),

                    structural_ready:
                      hostIntegrationShadow
                        .bindings
                        .protected_surface
                        .structural_ready ===
                      true,

                    semantic_ready:
                      hostIntegrationShadow
                        .bindings
                        .protected_surface
                        .semantic_ready ===
                      true,

                    reason:
                      hostIntegrationShadow
                        .bindings
                        .protected_surface
                        .reason,
                  }
                : null,

            host_ui_candidate:
              hostIntegrationShadow
                .bindings
                ?.ui_host
                ? {
                    status:
                      hostIntegrationShadow
                        .bindings
                        .ui_host
                        .status,

                    owner:
                      hostIntegrationShadow
                        .bindings
                        .ui_host
                        .owner ??
                      null,

                    resource:
                      hostIntegrationShadow
                        .bindings
                        .ui_host
                        .resource ??
                      null,

                    candidates:
                      (
                        hostIntegrationShadow
                          .bindings
                          .ui_host
                          .candidates ??
                        []
                      ).slice(
                        0,
                        8,
                      ),

                    structural_ready:
                      hostIntegrationShadow
                        .bindings
                        .ui_host
                        .structural_ready ===
                      true,

                    semantic_ready:
                      hostIntegrationShadow
                        .bindings
                        .ui_host
                        .semantic_ready ===
                      true,

                    reason:
                      hostIntegrationShadow
                        .bindings
                        .ui_host
                        .reason,
                  }
                : null,

            host_navigation_candidate:
              hostIntegrationShadow
                .bindings
                ?.navigation_host
                ? {
                    status:
                      hostIntegrationShadow
                        .bindings
                        .navigation_host
                        .status,

                    resource:
                      hostIntegrationShadow
                        .bindings
                        .navigation_host
                        .resource ??
                      null,

                    candidates:
                      (
                        hostIntegrationShadow
                          .bindings
                          .navigation_host
                          .candidates ??
                        []
                      ).slice(
                        0,
                        8,
                      ),

                    structural_ready:
                      hostIntegrationShadow
                        .bindings
                        .navigation_host
                        .structural_ready ===
                      true,

                    semantic_ready:
                      hostIntegrationShadow
                        .bindings
                        .navigation_host
                        .semantic_ready ===
                      true,

                    reason:
                      hostIntegrationShadow
                        .bindings
                        .navigation_host
                        .reason,
                  }
                : null,

            host_data_access_candidate:
              hostIntegrationShadow
                .bindings
                ?.data_access_capability
                ? {
                    status:
                      hostIntegrationShadow
                        .bindings
                        .data_access_capability
                        .status,

                    candidate:
                      hostIntegrationShadow
                        .bindings
                        .data_access_capability
                        .candidate ??
                      null,

                    candidates:
                      (
                        hostIntegrationShadow
                          .bindings
                          .data_access_capability
                          .candidates ??
                        []
                      ).slice(
                        0,
                        8,
                      ),

                    source_identity_status:
                      hostIntegrationShadow
                        .bindings
                        .data_access_capability
                        .source_identity_status,

                    structural_ready:
                      hostIntegrationShadow
                        .bindings
                        .data_access_capability
                        .structural_ready ===
                      true,

                    semantic_ready:
                      hostIntegrationShadow
                        .bindings
                        .data_access_capability
                        .semantic_ready ===
                      true,

                    reason:
                      hostIntegrationShadow
                        .bindings
                        .data_access_capability
                        .reason,
                  }
                : null,

            host_shadow_coverage_status:
              hostIntegrationShadow
                .coverage
                ?.status ??
              null,
            host_shadow_coverage_structurally_ready:
              hostIntegrationShadow
                .coverage
                ?.structurally_ready ??
              [],
            host_shadow_coverage_structurally_missing:
              hostIntegrationShadow
                .coverage
                ?.structurally_missing ??
              [],
            host_shadow_coverage_semantically_ready:
              hostIntegrationShadow
                .coverage
                ?.semantically_ready ??
              [],
            host_shadow_coverage_semantic_blockers:
              (
                hostIntegrationShadow
                  .coverage
                  ?.semantic_blockers ??
                []
              ).slice(
                0,
                16,
              ),
            host_shadow_coverage_positive_complete:
              hostIntegrationShadow
                .coverage
                ?.positive_complete ===
              true,

            task_causal_shadow_protocol:
              taskCausalShadow.protocol ??
              TASK_CAUSAL_SHADOW_PROTOCOL,
            task_causal_shadow_authority:
              taskCausalShadow.authority,
            task_causal_shadow_localization_authority:
              taskCausalShadow
                .localization_authority,
            task_causal_shadow_mutation_authority:
              taskCausalShadow
                .mutation_authority,
            task_causal_shadow_status:
              taskCausalShadow.status,
            task_causal_shadow_seed_count:
              taskCausalShadow.seed_count,

            task_causal_shadow_bound_nodes:
              (
                taskCausalShadow
                  .bound_anchors ??
                []
              )
                .map(
                  (item) =>
                    item.node,
                )
                .slice(
                  0,
                  16,
                ),

            task_causal_shadow_unbound_anchors:
              (
                taskCausalShadow
                  .unbound_anchors ??
                []
              )
                .map(
                  (item) => ({
                    kind:
                      item.kind,
                    value:
                      item.value,
                    reason:
                      item.reason,
                  }),
                )
                .slice(
                  0,
                  16,
                ),

            task_causal_shadow_ambiguous_anchors:
              (
                taskCausalShadow
                  .ambiguous_anchors ??
                []
              ).slice(
                0,
                8,
              ),

            task_causal_shadow_reached_nodes:
              (
                taskCausalShadow
                  .closure?.nodes ??
                []
              )
                .map(
                  (item) =>
                    item.id,
                )
                .slice(
                  0,
                  TASK_CAUSAL_SHADOW_MAX_NODES,
                ),

            task_causal_shadow_edges_considered:
              taskCausalShadow
                .closure
                ?.edges_considered ??
              0,

            task_causal_shadow_truncated:
              taskCausalShadow
                .closure
                ?.truncated ===
              true,
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
          const frontierResolution = resolveMutationActionForState(state)
          const actionCommitResult = deriveActionCommit({
            state,
            editCapsule,
            frontier: frontierResolution,
            renameToolName: EXECUTE_RENAME_SYMBOL_TOOL,
            renameCapabilityProtocol: SCOUT_RENAME_TARGET_PROTOCOL,
          })

          let actionCommitClaim = null
          let deterministicMutationResult = null

          if (actionCommitResult.ok === true) {
            actionCommitClaim =
              claimActionCommit(state, actionCommitResult.commit)

            if (actionCommitClaim.ok === true) {
              deterministicMutationResult =
                await executeCapabilityMutationCore(
                  { new_name: actionCommitResult.commit.new_name },
                  toolContext,
                  "rename_symbol",
                  EXECUTE_RENAME_SYMBOL_TOOL,
                  {
                    origin: ACTION_COMMIT_DISPATCH_ORIGIN,
                    actionCommit: actionCommitResult.commit,
                  },
                )
            } else {
              applyExecutionEvent(state, "fatal", actionCommitClaim.reason)
            }
          }

          const baseActionContent = editCapsule?.text ?? content
          const actionableContent =
            deterministicMutationResult
              ? `${baseActionContent}\nACTION_COMMIT protocol=${ACTION_COMMIT_PROTOCOL} sha256=${actionCommitResult.commit.commit_sha256} origin=${ACTION_COMMIT_DISPATCH_ORIGIN}\n${deterministicMutationResult.content}`
              : actionCommitResult.ok === true && actionCommitClaim?.ok !== true
                ? `${baseActionContent}\nACTION_COMMIT_STOP reason=${actionCommitClaim?.reason ?? "action_commit_claim_failed"} action=report_blocked`
                : mutationFrontier.length > 0
                  ? `${baseActionContent}\nNEXT_ACTION=${mutationFrontier.join(",")} reason=edit_capsule_ready search_locked=true`
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
