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

          const routeFacts = routeFactsForRanking(
            rankedFiles,
            selectedLexicalFileSet,
            discoveryComplete,
            target,
            glob,
          )
          const ledgerFactsBefore = state?.evidenceLedger?.size ?? 0
          const novelty = novelEvidenceFacts(state, finalFacts)
          const routeNovelty = novelRouteFacts(state, routeFacts)
          const meaningfulRouteProgress =
            routingActive && routeNovelty.novel.size > 0
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
