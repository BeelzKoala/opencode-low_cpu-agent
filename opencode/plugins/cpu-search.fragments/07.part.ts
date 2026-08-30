          let v2GroupingPreserved = null
          let hybridGroups = null
          let hybridVariants = null
          let hybridBodyBytes = null
          let hybridCoreBytes = null
          let hybridContextSamples = null
          let hybridRatio = null
          let hybridFacts = new Set()
          let variantDiversity = null
          let distillGroupsForIndex = null

          // Diagnostic-only line-owner recovery.
          //
          // This data MUST NOT feed Evidence IR rendering, index routing,
          // Edit Capsule construction, mutation readiness or authorization.
          let ownerRecoveryAttempted = false
          let ownerRecoveryReason = "not_needed"
          let ownerRecoveryElapsedMs = null
          let ownerRecoveryObserved = false
          let ownerRecoveryDistillComplete = null
          let ownerRecoveryLocationComplete = null
          let ownerRecoveryAnchorComplete = null
          let ownerRecoveryWitnessComplete = null
          let ownerRecoveryIrComplete = null
          let ownerRecoveryExactSpanHits = null
          let ownerRecoveryMappedHits = null
          let ownerRecoveryGroupCount = null
          let ownerRecoveryOwners = []
          let ownerRecoveryGroups = null
          let ownerRecoveryFilesAttempted = 0
          let ownerRecoveryFilesAccepted = 0
          let ownerRecoveryFilesRejected = 0
          let ownerRecoveryRejectedFiles = []

          // Structural localization for mutation authorization is independent
          // from model-facing evidence representation. The normal distiller
          // may be skipped when compression/focused rendering is unnecessary;
          // the capsule still needs a validated structural owner.
          let capsuleExactProbeAttempted = false
          let capsuleExactProbeReason = "not_needed"
          let capsuleExactProbeElapsedMs = null
          let capsuleExactProbeGroups = null

          let indexReason = null
          let indexRenderComplete = null
          let indexFiles = null
          let indexSamples = null
          let indexStructuralGroups = null
          let indexDiscriminativeFacets = null
          let indexFacts = new Set()
          let refinementRequired = false

          let regionAttempted = false
          let regionReason = "not_needed"
          let regionScopes = null
          let regionSampledScopes = null
          let regionSampledHits = null
          let regionRetainedHits = null
          let regionFacts = new Set()

          let focusedCandidate = false
          let focusedAttempted = false
          let focusedReason = "not_needed"
          let focusedSupplementBytes = null
          let focusedScopeCandidates = null
          let focusedSelectedScopes = null
          let focusedReusedScopes = null
          let focusedFullScopes = null
          let focusedPartialScopes = null
          let focusedRadius = null
          let focusedCanonicalSavedBytes = null
          let focusedFacts = new Set()
          let focusedContextualizedHitLines = new Set()

          focusedCandidate =
            selectedScanComplete &&
            selectedEvidenceComplete &&
            hits.size > 0 &&
            hits.size <= FOCUSED_PROBE_MAX_LINE_HITS &&
            pressure.maxHitsPerFile <= FOCUSED_PROBE_MAX_HITS_PER_FILE &&
            spansComplete &&
            distillInput.length > 0 &&
            distillInput.length <= FOCUSED_PROBE_MAX_EXACT_MATCHES

          const shouldDistill = pressure.active || focusedCandidate

          if (!selectedScanComplete) distillReason = "selected_scan_incomplete"
          else if (!shouldDistill) distillReason = "not_needed"
          else if (!spansComplete) distillReason = "span_capture_incomplete"
          else if (distillInput.length < 1) distillReason = "no_exact_spans"
          else {
            distillAttempted = true

            const distill = await runDistiller(root, distillInput)
            distillElapsedMs = distill.elapsedMs

            if (!distill.ok) {
              distillReason = distill.reason
              if (focusedCandidate) focusedReason = `distill_${distill.reason}`
              distillIrComplete = distill.response?.ir_complete ?? false
              distillWitnessComplete = distill.response?.witness_complete ?? false
              v2GroupingPreserved = distill.response?.v2_grouping_preserved ?? null
            } else {
              distillIrComplete = true
              distillWitnessComplete = true
              v2GroupingPreserved = true
              distillGroupsForIndex = distill.response.groups
              variantDiversity = Number.isFinite(distill.response?.variant_diversity)
                ? distill.response.variant_diversity
                : null
              distillerElapsedMs = Number.isFinite(distill.response?.elapsed_ms)
                ? distill.response.elapsed_ms
                : null

              const hybridRendered = await renderHybridEvidence(
                root,
                distill.response.groups,
                bodyBudget,
              )

              hybridGroups = hybridRendered.shownGroups
              hybridVariants = hybridRendered.shownVariants
              hybridBodyBytes = hybridRendered.bodyBytes
              hybridCoreBytes = hybridRendered.coreBytes
              hybridContextSamples = hybridRendered.contextSamples
              hybridFacts = hybridRendered.facts ?? new Set()

              if (!hybridRendered.complete) {
                distillReason = hybridRendered.reason ?? "hybrid_render_incomplete"
              } else {
                const contextSampled = hybridRendered.contextSamples > 0
                const publicHybridRepresentation = routingActive
                  ? "ranked_hybrid"
                  : "hybrid"
                const hybridHeader = [
                  `SEARCH representation=${publicHybridRepresentation} complete=${scanComplete && allDiscoveredFilesSelected} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${scanComplete && allDiscoveredFilesSelected} selected_evidence_complete=true matches_complete=${scanComplete} selected_witnesses_complete=true context_complete=false context_sampled=${contextSampled} candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} exact_matches=${distillInput.length} shown_hits=${hits.size} groups=${hybridRendered.shownGroups} variants=${hybridRendered.shownVariants}`,
                  ...querySummary,
                ]

                if (routingActive) {
                  hybridHeader.push(
                    `INCOMPLETE reasons=${!discoveryComplete ? "lexical_discovery_incomplete" : !allDiscoveredFilesProbed ? "probe_subset" : "budgeted_emit_subset"}`,
                  )
                }

                const hybridContent = [
                  ...hybridHeader,
                  ...(routeRendered.body.length > 0
                    ? ["", ...routeRendered.body]
                    : []),
                  "",
                  ...hybridRendered.body,
                ].join("\n")
                const hybridResultBytes = bytes(hybridContent)
                hybridRatio = rawResultBytes > 0
                  ? Math.round((hybridResultBytes / rawResultBytes) * 1000) / 1000
                  : null

                const materiallySmaller =
                  rawResultBytes > 0 &&
                  hybridResultBytes <= rawResultBytes * HYBRID_MIN_SAVINGS_RATIO

                const hybridBeneficial =
                  pressure.active &&
                  (!selectedEvidenceComplete || materiallySmaller)

                if (hybridResultBytes > callBudgetBytes) {
                  distillReason = "hybrid_output_budget"
                } else if (!hybridBeneficial) {
                  distillReason = "no_material_size_reduction"
                } else {
                  representation = "hybrid"
                  content = hybridContent
                  resultBytes = hybridResultBytes
                  bodyBytes = hybridRendered.bodyBytes
                  shownHits = hits.size
                  evidenceComplete = scanComplete && allDiscoveredFilesSelected
                  complete = scanComplete && allDiscoveredFilesSelected
                  distillReason = "selected"
                }
              }

              if (representation !== "raw" && focusedCandidate) {
                focusedReason = "superseded_by_hybrid"
              }

              if (representation === "raw" && focusedCandidate) {
                focusedAttempted = true
                const supplementBudget = Math.min(
                  FOCUSED_SUPPLEMENT_MAX_BYTES,
                  Math.max(0, bodyBudget - rawRendered.bodyBytes),
                )
                const focusedRendered = await renderFocusedSupplement(
                  root,
                  distill.response.groups,
                  supplementBudget,
                  hits,
                  state?.evidenceLedger ?? null,
                  state?.contextualizedHitLines ?? null,
                )

                focusedSupplementBytes = focusedRendered.bodyBytes
                focusedScopeCandidates = focusedRendered.scopeCount
                focusedSelectedScopes = focusedRendered.selectedScopeCount
                focusedReusedScopes = focusedRendered.reusedScopeCount
                focusedFullScopes = focusedRendered.fullScopes
                focusedPartialScopes = focusedRendered.partialScopes
                focusedRadius = focusedRendered.radius

                if (!focusedRendered.complete) {
                  focusedReason = focusedRendered.reason ?? "supplement_incomplete"
                } else {
                  const uncoveredHits = new Map(
                    [...hits.entries()].filter(
                      ([key]) => !focusedRendered.coveredHitKeys.has(key),
                    ),
                  )
                  const seenForRaw = new Set(state?.evidenceLedger ?? [])

                  for (const fact of focusedRendered.facts ?? []) {
                    seenForRaw.add(fact)
                  }

                  const rawRemainingBudget = Math.max(
                    0,
                    bodyBudget - focusedRendered.bodyBytes,
                  )
                  const rawUncovered = await renderNovelRawEvidence(
                    root,
                    uncoveredHits,
                    rawRemainingBudget,
                    seenForRaw,
                    focusedRendered.coveredRangesByFile,
                    state?.contextualizedHitLines ?? null,
                  )
                  const uncoveredComplete = [...uncoveredHits.entries()].every(
                    ([key, hit]) =>
                      rawUncovered.shown.has(key) ||
                      hitFactsAlreadySeen(hit, state?.evidenceLedger),
                  )

                  if (!uncoveredComplete) {
                    focusedReason = "canonical_raw_budget"
                  } else {
                    const focusedBody = []

                    if (rawUncovered.body.length > 0) {
                      focusedBody.push(...rawUncovered.body)
                    }

                    if (
                      rawUncovered.body.length > 0 &&
                      focusedRendered.body.length > 0
                    ) {
                      focusedBody.push("")
                    }

                    focusedBody.push(...focusedRendered.body)

                    const shownNow = new Set([
                      ...rawUncovered.shown,
                      ...focusedRendered.shownHitKeys,
                    ])
                    const priorHits = countHitsAlreadySeen(
                      hits,
                      state?.evidenceLedger,
                    )
                    const publicFocusedRepresentation = routingActive
                      ? "ranked_focused"
                      : "focused"
                    const focusedHeader = [
                      `SEARCH representation=${publicFocusedRepresentation} complete=${scanComplete && allDiscoveredFilesSelected} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${scanComplete && allDiscoveredFilesSelected} selected_evidence_complete=true matches_complete=${scanComplete} context_complete=false context_mode=scope_guided_dedup candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} shown_hits=${shownNow.size} prior_hits=${priorHits} prior_evidence_reused=${priorHits > 0 || rawUncovered.skippedPriorLines > 0} full_scopes=${focusedRendered.fullScopes} partial_scopes=${focusedRendered.partialScopes}`,
                      ...querySummary,
                    ]

                    if (routingActive) {
                      focusedHeader.push(
                        `INCOMPLETE reasons=${!discoveryComplete ? "lexical_discovery_incomplete" : !allDiscoveredFilesProbed ? "probe_subset" : "budgeted_emit_subset"}`,
                      )
                    }
                    const focusedContent = [
                      ...focusedHeader,
                      ...(routeRendered.body.length > 0
                        ? ["", ...routeRendered.body]
                        : []),
                      "",
                      ...focusedBody,
                    ].join("\n")
                    const focusedResultBytes = bytes(focusedContent)

                    const focusedCostLimit = Math.min(
                      rawResultBytes + FOCUSED_MAX_OVERHEAD_BYTES,
                      Math.ceil(rawResultBytes * FOCUSED_MAX_OVERHEAD_RATIO),
                    )
                    const focusedCostAccepted =
                      focusedResultBytes <= focusedCostLimit

                    if (focusedResultBytes > callBudgetBytes) {
                      focusedReason = "focused_output_budget"
                    } else if (!focusedCostAccepted) {
                      focusedReason = "cost_guard"
                    } else {
                      representation = "focused"
                      content = focusedContent
                      resultBytes = focusedResultBytes
                      bodyBytes =
                        rawUncovered.bodyBytes + focusedRendered.bodyBytes
                      shownHits = shownNow.size
                      evidenceComplete = scanComplete && allDiscoveredFilesSelected
                      complete = scanComplete && allDiscoveredFilesSelected
                      distillReason = "ir_complete"
                      focusedReason = "selected"
                      focusedFacts = new Set([
                        ...rawUncovered.facts,
                        ...focusedRendered.facts,
                      ])
                      focusedContextualizedHitLines =
                        focusedRendered.contextualizedHitLines
                      focusedCanonicalSavedBytes = Math.max(
                        0,
                        rawRendered.bodyBytes +
                          focusedRendered.bodyBytes -
                          bodyBytes,
                      )
                    }
                  }
                }
              }
            }
          }


          // Dense evidence that cannot fit RAW is routed one level deeper
          // inside the selected file(s). This is intentionally sampled and
          // marked incomplete, but it gives the model concrete function/scope
          // context without forcing an INDEX -> model -> narrower-search loop.
          if (
            representation === "raw" &&
            selectedScanComplete &&
            !selectedEvidenceComplete &&
            Array.isArray(distillGroupsForIndex) &&
            distillGroupsForIndex.length > 0
          ) {
            regionAttempted = true
            const regionRendered = await renderRegionEvidence(
              root,
              distillGroupsForIndex,
              bodyBudget,
              hits,
            )

            regionReason = regionRendered.reason ?? "selected"
            regionScopes = regionRendered.scopeCount
            regionSampledScopes = regionRendered.sampledScopes
            regionSampledHits = regionRendered.sampledHits
            regionRetainedHits = regionRendered.retainedHits

            if (regionRendered.complete) {
              const publicRegionRepresentation = routingActive
                ? "ranked_region"
                : "region"
              const regionHeader = [
                `SEARCH representation=${publicRegionRepresentation} complete=false scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=false selected_evidence_complete=false matches_complete=${scanComplete} region_sampled=true refinement_required=false candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} sampled_hits=${regionRendered.sampledHits} retained_hits=${regionRendered.retainedHits} scopes=${regionRendered.sampledScopes}`,
                ...querySummary,
                `EVIDENCE_SAMPLED reason=dense_region_router exact_match_locations_preserved=true`,
              ]

              if (routingActive) {
                regionHeader.push(
                  `INCOMPLETE reasons=${!discoveryComplete ? "lexical_discovery_incomplete,region_sampled" : !allDiscoveredFilesProbed ? "probe_subset,region_sampled" : "budgeted_emit_subset,region_sampled"}`,
                )
              } else {
                regionHeader.push("INCOMPLETE reasons=region_sampled")
              }

              const regionContent = [
                ...regionHeader,
                ...(routeRendered.body.length > 0
                  ? ["", ...routeRendered.body]
                  : []),
                "",
                ...regionRendered.body,
              ].join("\n")
              const regionResultBytes = bytes(regionContent)

              if (regionResultBytes <= callBudgetBytes) {
                representation = "region"
                content = regionContent
                resultBytes = regionResultBytes
                bodyBytes = regionRendered.bodyBytes
                shownHits = regionRendered.sampledHits
                evidenceComplete = false
                complete = false
                refinementRequired = false
                regionReason = "selected"
                regionFacts = regionRendered.facts ?? new Set()
              } else {
                regionReason = "region_output_budget"
              }
            }
          }

          // INDEX is not a compressed substitute for code evidence. It is a
          // bounded routing map used only when the normal evidence cannot be
          // complete. It tells the model where to refine and explicitly
          // forbids absence conclusions from an incomplete discovery.
          if (
            representation === "raw" &&
            !routingActive &&
            (!scanComplete || !selectedEvidenceComplete)
          ) {
            const indexRendered = renderSearchIndex(
              results,
              distillGroupsForIndex,
              bodyBudget,
            )

            const lineDiscoveryComplete = scanComplete
            const absenceNotProven = !lineDiscoveryComplete
            const indexHeader = [
              `SEARCH representation=index complete=false scan_complete=${scanComplete} evidence_complete=false index_render_complete=${indexRendered.complete} refinement_required=true absence_not_proven=${absenceNotProven} collected_line_hits=${hits.size} exact_matches=${exactSpanHits} indexed_files=${indexRendered.fileCount}`,
              ...querySummary,
              `REFINE_REQUIRED action=prefer_route_match_or_narrow_file routing=match_facets`,
            ]

            if (absenceNotProven) {
              indexHeader.push(
                "ABSENCE_NOT_PROVEN reason=line_scan_incomplete do_not_conclude_no_other_matches",
              )
              indexReason = "line_scan_incomplete"
            } else {
              indexHeader.push(
                "EVIDENCE_SUMMARIZED reason=raw_output_budget inspect_focused_evidence_before_code_level_conclusions",
              )
              indexReason = "raw_output_budget"
            }

            const indexContent = [
              ...indexHeader,
              "",
              ...indexRendered.body,
            ].join("\n")
            const indexResultBytes = bytes(indexContent)

            if (indexResultBytes <= callBudgetBytes) {
              representation = "index"
              content = indexContent
              resultBytes = indexResultBytes
              bodyBytes = indexRendered.bodyBytes
              shownHits = indexRendered.sampleCount
              evidenceComplete = false
              complete = false
              refinementRequired = true
              indexRenderComplete = indexRendered.complete
              indexFiles = indexRendered.fileCount
              indexSamples = indexRendered.sampleCount
              indexStructuralGroups = indexRendered.structuralGroupsShown
              indexDiscriminativeFacets =
                indexRendered.discriminativeFacetsShown
              indexFacts = indexRendered.facts ?? new Set()
            }
          }

          // Final RAW packing is turn-aware. Prior source/context remains in
          // conversation history, so only novel lines or newly-matched spans
          // need to be emitted again.
          let rawNovelFacts = new Set()
          let rawNovelEmittedLines = null
          let rawPriorHits = null
          let rawSkippedPriorLines = null
          let rawSuppressedContextAnchors = null

          if (representation === "raw") {
            const rawNovel = await renderNovelRawEvidence(
              root,
              hits,
              bodyBudget,
              state?.evidenceLedger ?? null,
              new Map(),
              state?.contextualizedHitLines ?? null,
            )
            const priorHits = countHitsAlreadySeen(
              hits,
              state?.evidenceLedger,
            )
            const accountedHits = [...hits.entries()].every(
              ([key, hit]) =>
                rawNovel.shown.has(key) ||
                hitFactsAlreadySeen(hit, state?.evidenceLedger),
            )
            const selectedTurnEvidenceComplete =
              selectedEvidenceComplete && accountedHits
            const turnEvidenceComplete =
              scanComplete &&
              allDiscoveredFilesSelected &&
              selectedTurnEvidenceComplete
            const turnComplete = scanComplete && turnEvidenceComplete
            const rawNovelReasons = []

            if (!discoveryComplete) {
              rawNovelReasons.push("lexical_discovery_incomplete")
            } else if (!allDiscoveredFilesProbed) {
              rawNovelReasons.push("probe_subset")
            } else if (!selectedScanComplete) {
              rawNovelReasons.push("scan_incomplete")
            } else if (!allDiscoveredFilesSelected) {
              rawNovelReasons.push("budgeted_emit_subset")
            }
            if (!selectedTurnEvidenceComplete) {
              rawNovelReasons.push("output_budget")
            }

            const publicRawRepresentation = routingActive
              ? "ranked_raw"
              : "raw"
            const rawNovelHeader = [
              `SEARCH representation=${publicRawRepresentation} complete=${turnComplete} scan_complete=${scanComplete} lexical_discovery_complete=${discoveryComplete} selected_scan_complete=${selectedScanComplete} evidence_complete=${turnEvidenceComplete} selected_evidence_complete=${selectedTurnEvidenceComplete} candidate_files=${rankedFiles.length} selected_files=${selectedFileSet.size} unique_hits=${hits.size} shown_hits=${rawNovel.shown.size} prior_hits=${priorHits} prior_evidence_reused=${priorHits > 0 || rawNovel.skippedPriorLines > 0}`,
              ...querySummary,
            ]

            if (rawNovelReasons.length) {
              rawNovelHeader.push(
                `INCOMPLETE reasons=${rawNovelReasons.join(",")}`,
              )
            }

            const rawNovelContent = [
              ...rawNovelHeader,
              ...(routeRendered.body.length > 0
                ? ["", ...routeRendered.body]
                : []),
              "",
              ...rawNovel.body,
            ].join("\n")
            const rawNovelResultBytes = bytes(rawNovelContent)

            if (rawNovelResultBytes <= callBudgetBytes) {
              content = rawNovelContent
              resultBytes = rawNovelResultBytes
              bodyBytes = rawNovel.bodyBytes
              shownHits = rawNovel.shown.size
              evidenceComplete = turnEvidenceComplete
              complete = turnComplete
              rawNovelFacts = rawNovel.facts
              rawNovelEmittedLines = rawNovel.emittedLines
              rawPriorHits = priorHits
              rawSkippedPriorLines = rawNovel.skippedPriorLines
              rawSuppressedContextAnchors =
                rawNovel.suppressedContextAnchors
            } else {
              // Safe fallback: the original bounded RAW body is already known
              // to fit. Positive hit facts are still ledgered; context-line
              // dedup simply becomes conservative for this one result.
              rawNovelFacts = positiveFactsForHits(hits)
            }
          }

          const sourceRepresentation = representation
          const finalFacts = new Set()

          if (representation === "raw") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of rawNovelFacts) finalFacts.add(fact)
          } else if (representation === "focused") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of focusedFacts) finalFacts.add(fact)
          } else if (representation === "hybrid") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of hybridFacts) finalFacts.add(fact)
          } else if (representation === "region") {
            for (const fact of positiveFactsForHits(hits)) finalFacts.add(fact)
            for (const fact of regionFacts) finalFacts.add(fact)
          } else if (representation === "index") {
            for (const fact of indexFacts) finalFacts.add(fact)
          }

          for (const fact of negativeFactsForDiscoveryResults(
            discoveryResults,
            target,
            glob,
          )) {
            finalFacts.add(fact)
          }

          for (const fact of impactEvidenceFactsForSelected(selectedFiles)) {
            finalFacts.add(fact)
          }

          const frameworkRouting =
            await inspectFrameworkRoutingForSelected(
              root,
              selectedFiles,
              state,
            )

          const resourceRouting =
            await inspectResourceRoutingForSelected(
              root,
              selectedFiles,
              state,
            )

          const taskCausalShadow =
            taskCausalShadowForState(
              state,
            )

          const anchorFrontierDiscovery =
            await discoverTaskAnchorFrontierFiles(
              root,
              state?.taskAnchors,
            )

          const anchorFrontierFramework =
            anchorFrontierDiscovery
              .candidate_files
              .length > 0
              ? await inspectFrameworkRoutingForSelected(
                  root,
                  anchorFrontierDiscovery
                    .candidate_files,
                  state,
                  {
                    routeTargets:
                      anchorFrontierDiscovery
                        .route_anchors,
                  },
                )
              : {
                  filesScanned: 0,
                  validatedEdges: 0,
                  rejectedEdges: 0,
                  truncated: false,
                }

          const anchorFrontier =
            resolveAnchorFrontier({
              taskAnchors:
                state?.taskAnchors,

              candidateFiles:
                anchorFrontierDiscovery
                  .candidate_files,

              searchComplete:
                anchorFrontierDiscovery
                  .search_complete,

              searchTruncated:
                anchorFrontierDiscovery
                  .search_truncated,

              inspectionTruncated:
                (
                  anchorFrontierFramework
                    ?.truncated ===
                  true
                ) ||
                (
                  (
                    anchorFrontierFramework
                      ?.skippedFiles ??
                    0
                  ) > 0
                ) ||
                (
                  (
                    anchorFrontierFramework
                      ?.filesScanned ??
                    0
                  ) !==
                  anchorFrontierDiscovery
                    .candidate_files
                    .length
                ),

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],
            })

          const hostOwnerRefinementPlan =
            planTaskBoundHostRefinement({
              taskRequirements:
                state?.taskRequirements,

              additiveLocalizationPlan:
                state?.additiveLocalizationPlan,

              anchorFrontier,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],

              selectedFiles,
            })

          /*
           * E1.7 — deterministic evidence closure.
           *
           * Exact task-anchor ownership is already source validated above.
           * If an additive UI/navigation obligation still needs host
           * relations and the exact owner was dropped by lexical emission,
           * inspect that ONE proven owner without a model round-trip.
           *
           * This is evidence refinement only. It cannot grant mutation
           * authority and cannot expand beyond the exact task-bound owner.
           */
          const hostOwnerRefinement =
            hostOwnerRefinementPlan
              .candidate_files
              .length > 0
                ? await inspectFrameworkRoutingForSelected(
                    root,
                    hostOwnerRefinementPlan
                      .candidate_files,
                    state,
                  )
                : {
                    protocol:
                      FRAMEWORK_RESOURCE_BRIDGE_PROTOCOL,
                    authority:
                      "routing_only",
                    mutationAuthority:
                      false,
                    filesScanned: 0,
                    skippedFiles: 0,
                    validatedEdges: 0,
                    rejectedEdges: 0,
                    truncated: false,
                  }

          const hostResourceInventory =
            await observedHostResourceInventory(
              root,
              state,
            )

          /*
           * Existing E1.3 stays intact as the baseline shadow.
           *
           * The frontier has already had a chance to add exact,
           * parser-validated owner edges to the same immutable
           * ResourceEdge state.
           */
          const initialHostIntegrationShadow =
            runHostIntegrationShadow({
              taskRequirements:
                state?.taskRequirements,

              taskAnchors:
                state?.taskAnchors,

              additiveLocalizationPlan:
                state?.additiveLocalizationPlan,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],

              resourceEdges:
                state?.resourceAdapterEdges
                  instanceof Map
                    ? [
                        ...state
                          .resourceAdapterEdges
                          .values(),
                      ]
                    : [],

              impactValidated:
                impactValidation
                  ?.validated ??
                [],

              frameworkTruncated:
                (
                  frameworkRouting
                    ?.truncated ===
                    true
                ) ||
                (
                  anchorFrontierFramework
                    ?.truncated ===
                    true
                ) ||
                (
                  hostOwnerRefinement
                    ?.truncated ===
                    true
                ),

              resourceTruncated:
                resourceRouting
                  ?.truncated ===
                true,
            })

          /*
           * R2 overlay:
           *
           * Raw validated ResourceEdges are passed unchanged.
           * AliasView changes equality/projection only.
           */
          const initialHostClosureContext =
            resolveHostClosureContext({
              anchorFrontier,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],

              resourceEdges:
                state?.resourceAdapterEdges
                  instanceof Map
                    ? [
                        ...state
                          .resourceAdapterEdges
                          .values(),
                      ]
                    : [],

              aliases: [],
            })

          /*
           * Resolve logical render target -> physical resource
           * through the complete/partial observed inventory.
           */
          const uiAliasResolution =
            resolveHostAliasesForNodes({
              nodes:
                initialHostClosureContext
                  ?.ui_candidate
                  ?.resource
                  ? [
                      initialHostClosureContext
                        .ui_candidate
                        .resource,
                    ]
                  : [],

              observedFiles:
                hostResourceInventory
                  .files,

              inventoryComplete:
                hostResourceInventory
                  .complete ===
                true,
            })

          const uiFollowupFiles =
            uiAliasResolution
              .aliases
              .map(
                (alias) =>
                  alias.physical_file,
              )

          const uiFollowupFramework =
            uiFollowupFiles.length > 0
              ? await inspectFrameworkRoutingForSelected(
                  root,
                  uiFollowupFiles,
                  state,
                )
              : {
                  filesScanned: 0,
                  validatedEdges: 0,
                  rejectedEdges: 0,
                  truncated: false,
                }

          const uiFollowupResource =
            uiFollowupFiles.length > 0
              ? await inspectResourceRoutingForSelected(
                  root,
                  uiFollowupFiles,
                  state,
                )
              : {
                  filesScanned: 0,
                  validatedEdges: 0,
                  rejectedEdges: 0,
                  truncated: false,
                }

          const aliasesAfterUi =
            mergeHostAliases(
              uiAliasResolution
                .aliases,
            )

          /*
           * UI physical inspection can now expose include/extends
           * relations whose source node is the physical template.
           */
          const midHostClosureContext =
            resolveHostClosureContext({
              anchorFrontier,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],

              resourceEdges:
                state?.resourceAdapterEdges
                  instanceof Map
                    ? [
                        ...state
                          .resourceAdapterEdges
                          .values(),
                      ]
                    : [],

              aliases:
                aliasesAfterUi,
            })

          const uiPhysicalSource =
            uiAliasResolution
              .aliases
              .find(
                (alias) =>
                  alias.logical_node ===
                  midHostClosureContext
                    ?.ui_candidate
                    ?.resource,
              )
              ?.physical_file ??
            null

          /*
           * Resolve every bounded included-resource candidate.
           * No "menu" filename heuristic is permitted.
           */
          const navigationAliasResolution =
            resolveHostAliasesForNodes({
              nodes:
                midHostClosureContext
                  .navigation_include_candidates ??
                [],

              sourcePath:
                uiPhysicalSource,

              observedFiles:
                hostResourceInventory
                  .files,

              inventoryComplete:
                hostResourceInventory
                  .complete ===
                true,
            })

          const navigationFollowupFiles =
            navigationAliasResolution
              .aliases
              .map(
                (alias) =>
                  alias.physical_file,
              )

          const navigationFollowupFramework =
            navigationFollowupFiles.length > 0
              ? await inspectFrameworkRoutingForSelected(
                  root,
                  navigationFollowupFiles,
                  state,
                )
              : {
                  filesScanned: 0,
                  validatedEdges: 0,
                  rejectedEdges: 0,
                  truncated: false,
                }

          const navigationFollowupResource =
            navigationFollowupFiles.length > 0
              ? await inspectResourceRoutingForSelected(
                  root,
                  navigationFollowupFiles,
                  state,
                )
              : {
                  filesScanned: 0,
                  validatedEdges: 0,
                  rejectedEdges: 0,
                  truncated: false,
                }

          /*
           * R4 target-conditioned reverse include witnesses.
           *
           * Exact literal search proposes possible includers.
           * Only parser-validated INCLUDES_RESOURCE relations
           * are added to the immutable proof graph.
           *
           * Search completeness is NOT required to prove the
           * positive predicate "shared by >= 2 includers".
           * Incomplete search simply cannot prove absence.
           */
          const navigationReverseDiscovery =
            await discoverNavigationReverseIncluderFiles(
              root,

              midHostClosureContext
                .navigation_include_candidates ??
              [],
            )

          const navigationReverseFramework =
            navigationReverseDiscovery
              .candidate_files
              .length > 0
              ? await inspectFrameworkRoutingForSelected(
                  root,

                  navigationReverseDiscovery
                    .candidate_files,

                  state,

                  {
                    includeTargets:
                      navigationReverseDiscovery
                        .target_literals,
                  },
                )
              : {
                  filesScanned: 0,
                  skippedFiles: 0,
                  validatedEdges: 0,
                  rejectedEdges: 0,
                  truncated: false,
                }

          const finalHostAliases =
            mergeHostAliases(
              aliasesAfterUi,

              navigationAliasResolution
                .aliases,
            )

          const finalHostClosureContext =
            resolveHostClosureContext({
              anchorFrontier,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],

              resourceEdges:
                state?.resourceAdapterEdges
                  instanceof Map
                    ? [
                        ...state
                          .resourceAdapterEdges
                          .values(),
                      ]
                    : [],

              aliases:
                finalHostAliases,
            })

          /*
           * Final legacy E1.3 observation is recomputed on the RAW
           * proof graph after deterministic follow-up inspection.
           *
           * No alias endpoint rewriting.
           */
          const hostIntegrationShadow =
            runHostIntegrationShadow({
              taskRequirements:
                state?.taskRequirements,

              taskAnchors:
                state?.taskAnchors,

              additiveLocalizationPlan:
                state?.additiveLocalizationPlan,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],

              resourceEdges:
                state?.resourceAdapterEdges
                  instanceof Map
                    ? [
                        ...state
                          .resourceAdapterEdges
                          .values(),
                      ]
                    : [],

              impactValidated:
                impactValidation
                  ?.validated ??
                [],

              frameworkTruncated:
                (
                  frameworkRouting
                    ?.truncated ===
                    true
                ) ||
                (
                  anchorFrontierFramework
                    ?.truncated ===
                    true
                ) ||
                (
                  hostOwnerRefinement
                    ?.truncated ===
                    true
                ) ||
                (
                  uiFollowupFramework
                    ?.truncated ===
                    true
                ) ||
                (
                  navigationFollowupFramework
                    ?.truncated ===
                    true
                ),

              resourceTruncated:
                (
                  resourceRouting
                    ?.truncated ===
                    true
                ) ||
                (
                  uiFollowupResource
                    ?.truncated ===
                    true
                ) ||
                (
                  navigationFollowupResource
                    ?.truncated ===
                    true
                ),
            })

          const hostResourceClosure =
            hostResourceClosureSummary({
              context:
                finalHostClosureContext,

              aliases:
                finalHostAliases,

              uiResolution:
                uiAliasResolution,

              navigationResolution:
                navigationAliasResolution,

              uiFramework:
                uiFollowupFramework,

              uiResource:
                uiFollowupResource,

              navigationFramework:
                navigationFollowupFramework,

              navigationResource:
                navigationFollowupResource,

              baselineHostIntegrationShadow:
                hostIntegrationShadow,

              positiveObligations:
                state
                  ?.additiveLocalizationPlan
                  ?.positive_localization_obligations ??
                [],
            })

          /*
           * E1.5 — task-bound obligation evidence.
           *
           * Host projector emits proof descriptors only.
           * Generic ABI performs A/B classification.
           * Existing task-role evidence is merged, never
           * overwritten by one producer.
           */
          const hostObligationProjection =
            projectAnchoredHostObligationProofs({
              taskRequirements:
                state?.taskRequirements,

              additiveLocalizationPlan:
                state?.additiveLocalizationPlan,

              anchorFrontier,

              hostResourceClosure,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],

              aliases:
                finalHostAliases,
            })

          const taskBoundHostEvidence =
            projectTaskBoundObligationProofs({
              coverageRequirements:
                state
                  ?.additiveLocalizationPlan
                  ?.positive_coverage_requirements,

              taskSha256:
                state
                  ?.taskRequirements
                  ?.task_sha256,

              proofs:
                hostObligationProjection
                  .proofs,
            })

          const mergedRoleEvidence =
            mergeTaskRoleEvidence({
              existing:
                state?.taskRoleEvidence ??
                [],

              incoming:
                taskBoundHostEvidence
                  .evidence,

              taskSha256:
                state
                  ?.taskRequirements
                  ?.task_sha256,
            })

          const dataCapabilityObservation =
            await resolveTaskBoundDataCapability({
              root,
              state,
              anchorFrontier,
              coverageRequirements:
                state
                  ?.additiveLocalizationPlan
                  ?.positive_coverage_requirements,
            })

          const dataObligationProjection =
            dataCapabilityObservation
              ?.projection

          const taskBoundDataEvidence =
            projectTaskBoundObligationProofs({
              coverageRequirements:
                state
                  ?.additiveLocalizationPlan
                  ?.positive_coverage_requirements,
              taskSha256:
                state
                  ?.taskRequirements
                  ?.task_sha256,
              proofs:
                dataObligationProjection
                  ?.proofs ??
                [],
            })

          const mergedDataRoleEvidence =
            mergeTaskRoleEvidence({
              existing:
                mergedRoleEvidence
                  .evidence,
              incoming:
                taskBoundDataEvidence
                  .evidence,
              taskSha256:
                state
                  ?.taskRequirements
                  ?.task_sha256,
            })

          if (state) {
            state.taskRoleEvidence =
              mergedDataRoleEvidence
                .evidence
          }

          const scoutEvidenceClosure =
            solveScoutEvidenceClosure({
              taskRequirements:
                state?.taskRequirements,

              additiveLocalizationPlan:
                state?.additiveLocalizationPlan,

              taskRoleEvidence:
                state?.taskRoleEvidence ??
                [],

              anchorFrontier,

              hostResourceClosure,

              frameworkEdges:
                state?.frameworkResourceEdges
                  instanceof Map
                    ? [
                        ...state
                          .frameworkResourceEdges
                          .values(),
                      ]
                    : [],
            })

          let scoutEvidenceProjection = {
            content: "",
            bytes: 0,
            filesShown: 0,
            truncated: false,
            abstainedFiles: 0,
          }

          const routeFacts = routeFactsForRanking(
            rankedFiles,
            selectedLexicalFileSet,
            discoveryComplete,
            target,
            glob,
          )

          for (const fact of frameworkRouting.routeFacts) {
            routeFacts.add(fact)
          }

          for (const fact of hostOwnerRefinement.routeFacts ?? []) {
            routeFacts.add(fact)
          }

          const ledgerFactsBefore = state?.evidenceLedger?.size ?? 0
          const novelty = novelEvidenceFacts(state, finalFacts)
          const routeNovelty = novelRouteFacts(state, routeFacts)
          const meaningfulRouteProgress =
            (
              routingActive ||
              frameworkRouting.validatedEdges > 0 ||
              (hostOwnerRefinement.validatedEdges ?? 0) > 0
            ) &&
            routeNovelty.novel.size > 0
          const novelFactStats = summarizeEvidenceFacts(novelty.novel)
          let ledgerFactsAdded = 0
          let routeFactsAdded = 0
          let noProgress = false
          let noProgressBlocked = false

          const priorEvidenceReused = novelty.prior > 0
          const noMeaningfulProgress =
            novelty.novel.size < 1 && !meaningfulRouteProgress

          if (state && noMeaningfulProgress) {
            state.consecutiveNoProgress += 1
            noProgress = true
            noProgressBlocked =
              state.consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS

            const noProgressReason = priorEvidenceReused
              ? "evidence_already_seen"
              : "evidence_unavailable"

            if (noProgressBlocked) {
              content =
                `SEARCH_BLOCKED reason=no_progress_loop ` +
                `source_representation=${sourceRepresentation} ` +
                `prior_evidence_reused=${priorEvidenceReused} no_progress_streak=${state.consecutiveNoProgress} ` +
                `action=use_prior_or_change_search_dimension`
            } else {
              content =
                `SEARCH_NO_PROGRESS reason=${noProgressReason} ` +
                `source_representation=${sourceRepresentation} ` +
                `prior_evidence_reused=${priorEvidenceReused} no_progress_streak=${state.consecutiveNoProgress} ` +
                `action=use_prior_or_change_search_dimension`
            }

            representation = "no_progress"
            resultBytes = bytes(content)
            bodyBytes = 0
            shownHits = 0
          } else if (state) {
            state.consecutiveNoProgress = 0
            const remembered = rememberEvidenceFacts(state, finalFacts)
            const rememberedRoutes = rememberRouteFacts(state, routeFacts)
            ledgerFactsAdded = remembered.added
            routeFactsAdded = rememberedRoutes.added

            if (sourceRepresentation === "focused") {
              rememberContextualizedHitLines(
                state,
                focusedContextualizedHitLines,
              )
            }
          }

          if (!noProgress && scoutEvidenceClosure.status !== "not_applicable") {
            const separatorBytes = content.length > 0 ? bytes("\n\n") : 0
            const remainingProjectionBytes = Math.max(
              0,
              callBudgetBytes - resultBytes - separatorBytes,
            )

            scoutEvidenceProjection =
              await renderScoutEvidenceClosureContext(
                root,
                scoutEvidenceClosure,
                remainingProjectionBytes,
              )

            if (scoutEvidenceProjection.content) {
              content = content.length > 0
                ? `${content}\n\n${scoutEvidenceProjection.content}`
                : scoutEvidenceProjection.content
              resultBytes = bytes(content)
            }
          }

          if (
            !noProgress &&
            routingActive &&
            (representation === "raw" ||
              representation === "focused" ||
              representation === "hybrid" ||
              representation === "region")
          ) {
            representation = `ranked_${representation}`
          }

          if (state) {
            state.evidenceBytes += resultBytes
            state.lastSeen = nowMs()
          }

          const scoutHandoff = await updateScoutHandoff(root, sessionID, state, {
            attemptIndex,
            queries,
            target,
            glob,
            representation,
            sourceRepresentation,
            selectedFiles,
            hits,
            discoveryComplete,
            scanComplete,
            selectedScanComplete,
            evidenceComplete,
            selectedEvidenceComplete,
            refinementRequired,
            retainedUnreadFiles: Math.max(0, rankedFiles.length - probeFileSet.size),
            retainedUnemittedFiles: routeRendered.retained,
            impactIndexCoverageComplete: impactIndexShadow.refreshComplete,
            evidenceClosure: scoutEvidenceClosure,
            noProgress,
            noProgressBlocked,
          })

          const mutationLocalization =
            scoutMutationLocalizationEligibility(
              state,
              scoutHandoff,
            )

          // First reuse structural groups produced by the normal exact-span
          // Evidence IR path, if available.
          const existingExactStructuralGroups =
            Array.isArray(distillGroupsForIndex) &&
            distillGroupsForIndex.length > 0
              ? distillGroupsForIndex
              : null

          // If model-facing evidence did not need distillation, perform a
          // separate strict exact-span probe solely for EditCapsule structural
          // ownership. This closes the spansComplete=true / shouldDistill=false
          // dead zone without changing search representation.
          if (
            mutationLocalization.eligible &&
            !existingExactStructuralGroups &&
            spansComplete &&
            distillInput.length > 0 &&
            distillInput.length <= FOCUSED_PROBE_MAX_EXACT_MATCHES
          ) {
            capsuleExactProbeAttempted = true

            const exactProbe =
              await runDistiller(root, distillInput)

            capsuleExactProbeElapsedMs =
              exactProbe.elapsedMs

            if (
              exactProbe.ok === true &&
              exactProbe.response?.ir_complete === true &&
              exactProbe.response?.location_complete === true &&
              exactProbe.response?.anchor_complete === true &&
              exactProbe.response?.witness_complete === true &&
              exactProbe.response?.distill_complete === true &&
              exactProbe.response?.truncated === false &&
              Array.isArray(exactProbe.response?.groups) &&
              exactProbe.response.groups.length > 0
            ) {
              capsuleExactProbeGroups =
                exactProbe.response.groups
              capsuleExactProbeReason =
                "exact_structural_groups_observed"
            } else {
              capsuleExactProbeReason =
                exactProbe.reason ??
                "exact_structural_probe_rejected"
            }
          } else if (
            !mutationLocalization.eligible
          ) {
            capsuleExactProbeReason =
              mutationLocalization.reason
          } else if (existingExactStructuralGroups) {
            capsuleExactProbeReason =
              "reused_existing_evidence_ir"
          } else if (!spansComplete) {
            capsuleExactProbeReason =
              "exact_spans_incomplete"
          } else if (distillInput.length < 1) {
            capsuleExactProbeReason =
              "no_exact_spans"
          } else if (
            distillInput.length >
            FOCUSED_PROBE_MAX_EXACT_MATCHES
          ) {
            capsuleExactProbeReason =
              "exact_input_cap"
          }

          const exactGroupsForCapsule =
            existingExactStructuralGroups ??
            capsuleExactProbeGroups

          // Line-only recovery is the fallback when no exact structural
          // ownership is available. It no longer depends directly on
          // spansComplete: exact spans may exist yet fail structural parsing.
          if (
            mutationLocalization.eligible &&
            !exactGroupsForCapsule
          ) {
            if (ownerRecoveryInput.length < 1) {
              ownerRecoveryReason = "no_line_hits"
            } else if (
              ownerRecoveryInput.length > FOCUSED_PROBE_MAX_LINE_HITS
            ) {
              ownerRecoveryReason = "input_cap"
            } else {
              ownerRecoveryAttempted = true

              const ownerRecoveryByFile = new Map()

              for (const hit of ownerRecoveryInput) {
                const batch =
                  ownerRecoveryByFile.get(hit.file) ?? []
                batch.push(hit)
                ownerRecoveryByFile.set(hit.file, batch)
              }

              const ownerRecoveryBatches =
                [...ownerRecoveryByFile.entries()]
                  .sort(([a], [b]) => a.localeCompare(b))

              ownerRecoveryFilesAttempted =
                ownerRecoveryBatches.length

              let elapsedTotal = 0
              let mappedTotal = 0
              let exactSpanTotal = 0
              let groupTotal = 0
              let allLocationIncomplete = true
              let allIrIncomplete = true

              const acceptedGroups = []
              const rejectedFiles = []

              for (const [file, fileHits] of ownerRecoveryBatches) {
                const ownerProbe = await runDistiller(
                  root,
                  fileHits,
                )

                elapsedTotal +=
                  Number.isFinite(ownerProbe.elapsedMs)
                    ? ownerProbe.elapsedMs
                    : 0

                const response = ownerProbe.response

                if (Number.isInteger(response?.mapped_hits)) {
                  mappedTotal += response.mapped_hits
                }

                if (Number.isInteger(response?.exact_span_hits)) {
                  exactSpanTotal += response.exact_span_hits
                }

                if (Array.isArray(response?.groups)) {
                  groupTotal += response.groups.length
                }

                if (response?.location_complete !== false) {
                  allLocationIncomplete = false
                }

                if (response?.ir_complete !== false) {
                  allIrIncomplete = false
                }

                const fileOwnerSafe =
                  ownerProbe.ok === false &&
                  ownerProbe.reason === "unsafe_ir" &&
                  response?.protocol === "evidence-distiller-v3" &&
                  response?.representation === "evidence_ir" &&
                  response?.raw_hits === fileHits.length &&
                  response?.mapped_hits === fileHits.length &&
                  response?.exact_span_hits === 0 &&
                  response?.location_complete === false &&
                  response?.anchor_complete === true &&
                  response?.witness_complete === true &&
                  response?.distill_complete === true &&
                  response?.ir_complete === false &&
                  response?.v2_grouping_preserved === true &&
                  response?.truncated === false &&
                  Array.isArray(response?.groups) &&
                  response.groups.length > 0 &&
                  response?.groups_shown ===
                    response.groups.length &&
                  response?.variants_shown ===
                    response?.variants_total

                if (fileOwnerSafe) {
                  ownerRecoveryFilesAccepted += 1
                  acceptedGroups.push(...response.groups)
                } else {
                  ownerRecoveryFilesRejected += 1

                  rejectedFiles.push({
                    file,
                    input_hits: fileHits.length,
                    reason:
                      ownerProbe.reason ??
                      "owner_contract_rejected",
                    mapped_hits:
                      Number.isInteger(response?.mapped_hits)
                        ? response.mapped_hits
                        : null,
                    unsupported:
                      Array.isArray(response?.unsupported_files)
                        ? response.unsupported_files.length
                        : null,
                    errors:
                      Array.isArray(response?.errors)
                        ? response.errors.length
                        : null,
                  })
                }
              }

              ownerRecoveryElapsedMs =
                Math.round(elapsedTotal * 100) / 100
              ownerRecoveryMappedHits = mappedTotal
              ownerRecoveryExactSpanHits = exactSpanTotal
              ownerRecoveryGroupCount = groupTotal

              ownerRecoveryLocationComplete =
                ownerRecoveryFilesAttempted > 0
                  ? !allLocationIncomplete
                  : null

              ownerRecoveryIrComplete =
                ownerRecoveryFilesAttempted > 0
                  ? !allIrIncomplete
                  : null

              ownerRecoveryDistillComplete =
                ownerRecoveryFilesAccepted > 0 &&
                ownerRecoveryFilesRejected === 0

              ownerRecoveryAnchorComplete =
                ownerRecoveryFilesAccepted > 0 &&
                ownerRecoveryFilesRejected === 0

              ownerRecoveryWitnessComplete =
                ownerRecoveryFilesAccepted > 0 &&
                ownerRecoveryFilesRejected === 0

              ownerRecoveryRejectedFiles =
                rejectedFiles.slice(0, 16)

              if (acceptedGroups.length > 0) {
                ownerRecoveryObserved = true
                ownerRecoveryGroups = acceptedGroups

                ownerRecoveryReason =
                  ownerRecoveryFilesRejected > 0
                    ? "partial_diagnostic_groups_observed"
                    : "diagnostic_groups_observed"

                const owners = new Map()

                for (const group of acceptedGroups) {
                  const file =
                    typeof group?.file === "string"
                      ? group.file
                      : null
                  const symbolKind =
                    typeof group?.symbol_kind === "string"
                      ? group.symbol_kind
                      : null
                  const symbolName =
                    typeof group?.symbol_name === "string"
                      ? group.symbol_name
                      : null
                  const startLine =
                    Number.isInteger(group?.start_line)
                      ? group.start_line
                      : null
                  const endLine =
                    Number.isInteger(group?.end_line)
                      ? group.end_line
                      : null

                  if (
                    !file ||
                    !symbolKind ||
                    !symbolName ||
                    !startLine ||
                    !endLine
                  ) {
                    continue
                  }

                  const key =
                    `${file}\0${symbolKind}\0${symbolName}` +
                    `\0${startLine}\0${endLine}`

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

            }
          }

          if (state) {
            if (localMutationCapability?.ok === true) {
              state.localMutationHandoffPath =
                localMutationCapability.localHandoffPath
              state.localMutationCapability = localMutationCapability
              state.localMutationCandidates =
                localMutationCandidateSet?.candidates ?? []
            } else {
              state.localMutationHandoffPath = null
              state.localMutationCapability = null
              state.localMutationCandidates = []
            }

            state.boundMutationTarget = null
            state.activeMutationHandoffPath = null
          }

          let additiveMutationCapability =
            deriveAdditiveMutationCapability({
              taskShape: state?.taskShape,
              evidenceClosure: scoutEvidenceClosure,
              hostResourceClosure,
            })

          let additiveMutationContext = null
          let additiveMutationHandoffPath = null
          let additiveMutationAuthority = null

          if (additiveMutationCapability?.binding_ready === true) {
            additiveMutationContext =
              await materializeAdditiveMutationContext({
                root,
                capability: additiveMutationCapability,
                maxBytes: ADDITIVE_MODEL_CONTEXT_MAX_BYTES,
              })

            if (additiveMutationContext?.ok === true) {
              const discriminator =
                `additive-${additiveMutationCapability.capability_sha256.slice(0, 16)}`
              const provisionalHandoff =
                buildAdditiveMutationHandoff({
                  searchProtocol: SEARCH_PROTOCOL,
                  sessionKey: scoutOpaqueKey(sessionID),
                  turnKey: scoutOpaqueKey(state?.turnID ?? ""),
                  generatedAtMs: nowMs(),
                  capability: additiveMutationCapability,
                  context: additiveMutationContext,
                })

              if (provisionalHandoff?.ok === true) {
                const provisionalPath =
                  await writeLocalMutationHandoff(
                    root,
                    sessionID,
                    state?.turnID,
                    provisionalHandoff.bundle,
                    discriminator,
                  )

                if (provisionalPath) {
                  const authorizedCapability =
                    await authorizeAdditiveMutationCapability({
                      root,
                      capability: additiveMutationCapability,
                      context: additiveMutationContext,
                      handoffPath: provisionalPath,
                    })

                  if (
                    authorizedCapability?.ready === true &&
                    authorizedCapability?.mutation_authority === true
                  ) {
                    const finalHandoff =
                      buildAdditiveMutationHandoff({
                        searchProtocol: SEARCH_PROTOCOL,
                        sessionKey: scoutOpaqueKey(sessionID),
                        turnKey: scoutOpaqueKey(state?.turnID ?? ""),
                        generatedAtMs: nowMs(),
                        capability: authorizedCapability,
                        context: additiveMutationContext,
                      })

                    if (finalHandoff?.ok === true) {
                      const finalPath =
                        await writeLocalMutationHandoff(
                          root,
                          sessionID,
                          state?.turnID,
                          finalHandoff.bundle,
                          discriminator,
                        )

                      if (finalPath === provisionalPath) {
                        const verifiedAuthority =
                          await verifyAdditiveMutationAuthority({
                            root,
                            capability: authorizedCapability,
                            context: additiveMutationContext,
                            handoffPath: finalPath,
                          })

                        additiveMutationAuthority =
                          verifiedAuthority

                        if (verifiedAuthority?.ok === true) {
                          additiveMutationCapability =
                            authorizedCapability
                          additiveMutationHandoffPath =
                            finalPath
                        }
                      } else {
                        additiveMutationAuthority = {
                          ok: false,
                          reason:
                            "additive_final_handoff_path_mismatch",
                        }
                      }
                    } else {
                      additiveMutationAuthority = {
                        ok: false,
                        reason:
                          finalHandoff?.reason ??
                          "additive_final_handoff_invalid",
                      }
                    }
                  } else {
                    additiveMutationAuthority = {
                      ok: false,
                      reason:
                        authorizedCapability?.reason ??
                        "additive_authority_authorization_failed",
                    }
                  }
                } else {
                  additiveMutationAuthority = {
                    ok: false,
                    reason:
                      "additive_provisional_handoff_write_failed",
                  }
                }
              } else {
                additiveMutationAuthority = {
                  ok: false,
                  reason:
                    provisionalHandoff?.reason ??
                    "additive_provisional_handoff_invalid",
                }
              }
            } else {
              additiveMutationAuthority = {
                ok: false,
                reason:
                  additiveMutationContext?.reason ??
                  "additive_context_materialization_failed",
              }
            }

            if (
              additiveMutationCapability?.mutation_authority !== true ||
              !additiveMutationHandoffPath ||
              additiveMutationAuthority?.ok !== true
            ) {
              additiveMutationCapability = Object.freeze({
                ...additiveMutationCapability,
                status: "abstained",
                reason:
                  additiveMutationAuthority?.reason ??
                  "additive_handoff_authority_unavailable",
                binding_ready: false,
                ready: false,
                mutation_authority: false,
                authority_protocol: null,
                authority_receipt: null,
                authority_sha256: null,
              })
              additiveMutationHandoffPath = null
            }
          }

          if (state) {
            state.additiveMutationCapability =
              additiveMutationCapability
            state.additiveMutationHandoffPath =
              additiveMutationHandoffPath
            state.additiveMutationContext =
              additiveMutationContext
          }

          const executionReadiness =
            resolveExecutionReadiness({
              taskShape: state?.taskShape,
              taskAction: state?.taskAction,
              mutationIntent: state?.mutationIntent,
              scoutHandoff,
              evidenceClosure: scoutEvidenceClosure,
              editCapsule,
              localCompetitorCheck,
              localMutationCapability,
              localMutationCandidates:
                localMutationCandidateSet?.candidates ?? [],
              renameMutationCapability,
              additiveMutationCapability,
              noProgressBlocked,
            })

          if (state) {
            applyExecutionReadiness(state, executionReadiness)
          }
