
export default {
  id: "cpu-agent.global",

  setup: async (ctx) => {
    const registrations = []
    const track = async (registrationPromise) => {
      registrations.push(await registrationPromise)
    }

    const unsubscribeEvents = await subscribeEvents(ctx)

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

        execute: async (input, toolContext) => {
          const started = performance.now()
          const sessionID =
            typeof toolContext?.sessionID === "string" && toolContext.sessionID.length > 0
              ? toolContext.sessionID
              : null

          const state = getSessionState(sessionID)
          const root = await rootForTool(ctx, toolContext, sessionID, state)

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
            await resolveSearchLanguageGlob(
              root,
              target,
              requestedGlob,
              state,
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
