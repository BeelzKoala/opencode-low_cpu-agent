
function ownerRecoveryResponseSafe(response, probe, inputCount) {
  return (
    probe?.ok === false &&
    probe?.reason === "unsafe_ir" &&
    response?.protocol === "evidence-distiller-v3" &&
    response?.representation === "evidence_ir" &&
    response?.raw_hits === inputCount &&
    response?.mapped_hits === inputCount &&
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
    response?.groups_shown === response.groups.length &&
    response?.variants_shown === response?.variants_total
  )
}

function mutationCandidateIdentity(scope) {
  if (!scope) return null
  return {
    file: normalizeMutationFile(scope.file),
    symbol_kind: scope.symbol_kind,
    symbol_name: scope.symbol_name,
    start_line: scope.start_line,
    end_line: scope.end_line,
  }
}

function normalizeMutationCandidateEol(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
}

function mutationCandidateStrictAncestor(outer, inner) {
  if (!outer || !inner) return false
  const outerFile = normalizeMutationFile(outer.file)
  const innerFile = normalizeMutationFile(inner.file)
  if (!outerFile || outerFile !== innerFile) return false
  if (
    !Number.isInteger(outer.start_line) ||
    !Number.isInteger(outer.end_line) ||
    !Number.isInteger(inner.start_line) ||
    !Number.isInteger(inner.end_line)
  ) return false

  const contains =
    outer.start_line <= inner.start_line &&
    outer.end_line >= inner.end_line
  const strict =
    outer.start_line < inner.start_line ||
    outer.end_line > inner.end_line
  return contains && strict
}

function reduceMostSpecificMutationCandidates(candidates) {
  const values = Array.isArray(candidates) ? candidates : []
  return values.filter(
    (candidate) =>
      !values.some(
        (other) =>
          other !== candidate &&
          mutationCandidateStrictAncestor(candidate, other),
      ),
  )
}

function normalizeMutationCandidateSlice(value) {
  return normalizeMutationCandidateEol(value).trim()
}

function mutationCandidateContainsBefore(candidate, before) {
  if (
    !candidate ||
    typeof candidate.live_source !== "string" ||
    typeof before !== "string" ||
    before.length < 1
  ) return false

  const wanted = normalizeMutationCandidateSlice(before)
  if (wanted.length < 1) return false

  const source = normalizeMutationCandidateSlice(candidate.live_source)
  if (source.includes(wanted)) return true

  const sourceLines = source.split("\n")
  const wantedLines = wanted.split("\n")
  const width = wantedLines.length

  for (let start = 0; start + width <= sourceLines.length; start++) {
    const slice = sourceLines.slice(start, start + width).join("\n")
    if (normalizeMutationCandidateSlice(slice) === wanted) return true
  }

  return false
}

function selectExactMutationCandidate(candidates, before, boundTarget = null) {
  const values = Array.isArray(candidates) ? candidates : []

  if (boundTarget) {
    const bound =
      values.find((entry) =>
        sameAuthorizedScopeIdentity(entry.target, boundTarget),
      ) ?? null

    if (!bound || !mutationCandidateContainsBefore(bound, before)) {
      return {
        ok: false,
        reason: "mutation_owner_repair_target_mismatch",
        repairable: false,
        candidate: null,
        matches: [],
      }
    }

    return {
      ok: true,
      reason: "mutation_owner_sticky_exact_match",
      repairable: false,
      candidate: bound,
      matches: [bound],
    }
  }

  const exact =
    values.filter((entry) =>
      mutationCandidateContainsBefore(entry, before),
    )

  if (exact.length < 1) {
    return {
      ok: false,
      reason: "mutation_owner_no_exact_match",
      repairable: true,
      candidate: null,
      matches: [],
    }
  }

  const mostSpecific =
    reduceMostSpecificMutationCandidates(
      exact.map((entry) => entry.target),
    )

  if (mostSpecific.length !== 1) {
    return {
      ok: false,
      reason: "mutation_owner_ambiguous_exact_match",
      repairable: true,
      candidate: null,
      matches: mostSpecific,
    }
  }

  const selectedTarget = mostSpecific[0]
  const selected =
    exact.find((entry) =>
      sameAuthorizedScopeIdentity(entry.target, selectedTarget),
    ) ?? null

  return {
    ok: selected !== null,
    reason:
      selected !== null
        ? "mutation_owner_unique_exact_match"
        : "mutation_owner_ambiguous_exact_match",
    repairable: selected === null,
    candidate: selected,
    matches: mostSpecific,
  }
}

function validatedImpactMutationCandidateHits(selectedImpactFiles) {
  const unique = new Map()

  for (const entry of selectedImpactFiles ?? []) {
    if (
      entry?.origin !== "impact" ||
      entry?.impact?.validationKind !== "forward_scope_definition"
    ) continue

    const file = evidenceFileKey(entry?.file)
    const line = entry?.impact?.sample?.line
    if (!file || !Number.isInteger(line) || line < 1) continue

    const queryIndex =
      [...(entry?.queries ?? [])]
        .filter((value) => Number.isInteger(value) && value >= 0)
        .sort((a, b) => a - b)[0]

    if (!Number.isInteger(queryIndex)) continue

    const key = `${file}\\0${line}\\0${queryIndex}`
    if (!unique.has(key)) {
      unique.set(key, {
        file,
        line,
        query: queryIndex + 1,
      })
    }
  }

  return [...unique.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.query - b.query,
  )
}

async function recoverValidatedImpactMutationCandidateGroups(
  root,
  selectedImpactFiles,
) {
  const hits = validatedImpactMutationCandidateHits(selectedImpactFiles)

  if (hits.length < 1) {
    return {
      attempted: false,
      ok: true,
      reason: "no_validated_forward_impact_candidate",
      groups: [],
      hits: 0,
      files: 0,
      rejected_files: [],
    }
  }

  if (hits.length > FOCUSED_PROBE_MAX_LINE_HITS) {
    return {
      attempted: false,
      ok: false,
      reason: "impact_candidate_hit_budget_exceeded",
      groups: [],
      hits: hits.length,
      files: 0,
      rejected_files: [],
    }
  }

  const byFile = new Map()
  for (const hit of hits) {
    const batch = byFile.get(hit.file) ?? []
    batch.push(hit)
    byFile.set(hit.file, batch)
  }

  const groups = []
  const rejected = []

  for (
    const [file, fileHits]
    of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))
  ) {
    const probe = await runDistiller(root, fileHits)
    const response = probe?.response

    if (!ownerRecoveryResponseSafe(response, probe, fileHits.length)) {
      rejected.push({
        file,
        reason:
          probe?.reason ??
          "impact_candidate_structural_validation_failed",
      })
      continue
    }

    for (const group of response.groups ?? []) {
      if (
        typeof group?.symbol_kind !== "string" ||
        typeof group?.symbol_name !== "string" ||
        group.symbol_kind === "module" ||
        group.symbol_name === "<module>" ||
        group.symbol_name === "<evidence>"
      ) continue

      groups.push({
        ...group,
        mutation_candidate_basis:
          "validated_forward_impact_definition",
      })
    }
  }

  return {
    attempted: true,
    ok: rejected.length === 0,
    reason:
      rejected.length === 0
        ? "validated_forward_impact_candidates_recovered"
        : "impact_candidate_structural_validation_partial",
    groups: rejected.length === 0 ? groups : [],
    hits: hits.length,
    files: byFile.size,
    rejected_files: rejected.slice(0, 16),
  }
}

async function loadLivePreauthorizedMutationCandidates(root, state) {
  const loaded = await readAuthorizedEditCapsule(root, state)
  if (!loaded.ok) return { ...loaded, candidates: [] }

  const capsule = loaded.capsule
  const preauthorized =
    Array.isArray(state?.localMutationCandidates)
      ? state.localMutationCandidates
      : []

  if (
    capsule?.mutation_candidate_protocol !== MUTATION_CANDIDATE_SET_PROTOCOL ||
    !Number.isInteger(capsule?.mutation_candidate_count) ||
    capsule.mutation_candidate_count < 1 ||
    capsule.mutation_candidate_count > MUTATION_CANDIDATE_MAX ||
    !Array.isArray(capsule?.mutation_candidates) ||
    capsule.mutation_candidates.length !== capsule.mutation_candidate_count ||
    preauthorized.length < 1 ||
    preauthorized.length > MUTATION_CANDIDATE_MAX
  ) {
    return {
      ok: false,
      reason: "mutation_candidate_set_contract_invalid",
      candidates: [],
    }
  }

  const sealed = capsule.mutation_candidates
  const candidates = []
  const bodies = new Map()

  for (const entry of preauthorized) {
    const capability = entry?.capability
    const target = entry?.target
    if (
      capability?.protocol !== SCOUT_LOCAL_CAPABILITY_PROTOCOL ||
      capability?.replaceNodeReady !== true ||
      !Array.isArray(capability?.allowedMutations) ||
      !capability.allowedMutations.includes("replace_node") ||
      typeof capability?.localHandoffPath !== "string" ||
      !target
    ) {
      return {
        ok: false,
        reason: "mutation_candidate_capability_invalid",
        candidates: [],
      }
    }

    const metadata =
      sealed.find((candidate) =>
        sameAuthorizedScopeIdentity(candidate, target),
      ) ?? null

    if (!metadata) {
      return {
        ok: false,
        reason: "mutation_candidate_not_sealed",
        candidates: [],
      }
    }

    const file = canonicalMutationFile(root, target.file)
    if (!file) {
      return {
        ok: false,
        reason: "mutation_candidate_file_invalid",
        candidates: [],
      }
    }

    let body = bodies.get(file)
    if (!body) {
      try {
        body = await readFile(path.resolve(root, file))
      } catch {
        return {
          ok: false,
          reason: "mutation_candidate_file_unavailable",
          candidates: [],
        }
      }
      bodies.set(file, body)
    }

    const currentSha256 =
      createHash("sha256").update(body).digest("hex")

    if (
      currentSha256 !== metadata.source_sha256 ||
      currentSha256 !== capability.targetSourceSha256
    ) {
      return {
        ok: false,
        reason: "mutation_candidate_source_stale",
        candidates: [],
      }
    }

    const lines =
      normalizeMutationCandidateEol(
        body.toString("utf8"),
      ).split("\n")

    if (
      !Number.isInteger(target.start_line) ||
      !Number.isInteger(target.end_line) ||
      target.start_line < 1 ||
      target.end_line < target.start_line ||
      target.end_line > lines.length
    ) {
      return {
        ok: false,
        reason: "mutation_candidate_live_range_invalid",
        candidates: [],
      }
    }

    candidates.push({
      target,
      capability,
      live_source:
        lines.slice(target.start_line - 1, target.end_line).join("\n"),
    })
  }

  return {
    ok: true,
    capsule,
    candidates,
  }
}

async function bindReplaceNodeMutationCandidate(root, state, before) {
  const loaded =
    await loadLivePreauthorizedMutationCandidates(root, state)

  if (!loaded.ok) {
    return {
      ...loaded,
      repairable: false,
      candidate: null,
    }
  }

  const selected =
    selectExactMutationCandidate(
      loaded.candidates,
      before,
      state?.boundMutationTarget ?? null,
    )

  return {
    ...selected,
    candidate_count: loaded.candidates.length,
  }
}

async function confirmLocalMutationCompetitors(
  root,
  state,
  scoutHandoff,
  editCapsule,
  rankedFiles,
  discoveryResults,
  queries,
  glob,
) {
  const reject = (reason, detail = null, extra = {}) => ({
    ok: false,
    protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
    reason,
    detail,
    checked_files: 0,
    ...extra,
  })

  if (scoutHandoff?.status === "ready") {
    return {
      ok: true,
      protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
      reason: "global_handoff_ready",
      checked_files: 0,
      competing_owners: [],
    }
  }

  const target = editCapsule?.authorizedMutationScope
  const targetFile = canonicalMutationFile(root, target?.file)
  if (!targetFile) return reject("competitor_target_invalid")

  const targetStateFile = [...(state?.scoutFiles?.values?.() ?? [])]
    .find((entry) =>
      canonicalMutationFile(root, entry?.file) === targetFile,
    )

  const observedTargetQueries = [...(targetStateFile?.queries ?? [])]
    .filter((value) => Number.isInteger(value) && value >= 0)

  if (observedTargetQueries.length < 1) {
    return reject("competitor_query_provenance_missing")
  }

  // Compare against the most discriminative direct provenance first.
  // Generic task terms (configuration/database/etc.) must not make every
  // incidental source file a mutation competitor.
  const queryFileCounts = new Map(
    (discoveryResults ?? []).map((result) => [
      result.queryIndex,
      new Set(
        (result?.files ?? [])
          .map((file) => canonicalMutationFile(root, file))
          .filter(Boolean),
      ).size,
    ]),
  )
  const rankedTargetQueries = observedTargetQueries
    .map((queryIndex) => ({
      queryIndex,
      files: queryFileCounts.get(queryIndex) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.files - b.files || a.queryIndex - b.queryIndex)

  const minimumQueryFiles = rankedTargetQueries[0]?.files
  const targetQueries = new Set(
    rankedTargetQueries
      .filter((entry) => entry.files === minimumQueryFiles)
      .map((entry) => entry.queryIndex),
  )

  const targetIsTest = likelyTestFile(targetFile)
  const candidates = (rankedFiles ?? []).filter((entry) => {
    const file = canonicalMutationFile(root, entry?.file)
    if (!file || file === targetFile) return false
    if (!targetIsTest && likelyTestFile(file)) return false
    for (const query of entry?.queries ?? []) {
      if (targetQueries.has(query)) return true
    }
    return false
  })

  if (candidates.length > SCOUT_LOCAL_CAPABILITY_MAX_COMPETITOR_FILES) {
    return reject(
      "competitor_budget_exceeded",
      `${candidates.length}>${SCOUT_LOCAL_CAPABILITY_MAX_COMPETITOR_FILES}`,
      { candidate_files: candidates.map((entry) => entry.file).slice(0, 16) },
    )
  }

  if (candidates.length < 1) {
    return {
      ok: true,
      protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
      reason: "no_query_provenance_competitors",
      checked_files: 0,
      competing_owners: [],
    }
  }

  const results = []

  for (const queryIndex of [...targetQueries].sort((a, b) => a - b)) {
    const targets = candidates
      .filter((entry) => entry?.queries?.has?.(queryIndex))
      .map((entry) => entry.file)
      .sort()

    if (targets.length < 1) continue

    const discovery = (discoveryResults ?? []).find(
      (entry) => entry?.queryIndex === queryIndex,
    )
    const requestedQuery = queries?.[queryIndex]

    if (!discovery || typeof requestedQuery !== "string") {
      return reject("competitor_query_plan_missing", String(queryIndex))
    }

    let result
    if (discovery.compiledProbe) {
      result = restrictProbeResultToTargets(
        discovery.compiledProbe,
        targets,
      )
    } else {
      const raw = await runQuery(
        root,
        discovery.effectiveQuery ?? requestedQuery,
        queryIndex,
        targets,
        glob,
      )
      result = queryCompilerProbeResult(
        raw,
        requestedQuery,
        discovery.matchMode ?? "exact",
      )
    }

    if (
      result?.scanComplete !== true ||
      result?.timedOut === true ||
      result?.scanCapped === true ||
      result?.error
    ) {
      return reject(
        "competitor_scan_incomplete",
        `query_${queryIndex + 1}`,
      )
    }

    results.push(result)
  }

  const competitorHits = mergeHits(results)
  const recoveryHits = ownerRecoveryHitsFromMerged(competitorHits)
  const byFile = new Map()

  for (const hit of recoveryHits) {
    const file = canonicalMutationFile(root, hit.file)
    if (!file) continue
    const batch = byFile.get(file) ?? []
    batch.push({ ...hit, file })
    byFile.set(file, batch)
  }

  const competingOwners = []

  for (const entry of candidates) {
    const file = canonicalMutationFile(root, entry.file)
    if (!file) return reject("competitor_file_invalid", entry.file)

    const fileHits = byFile.get(file) ?? []
    if (fileHits.length < 1) continue

    const probe = await runDistiller(root, fileHits)
    const response = probe?.response

    if (!ownerRecoveryResponseSafe(response, probe, fileHits.length)) {
      return reject(
        "competitor_structural_validation_failed",
        file,
        { checked_files: byFile.size },
      )
    }

    for (const group of response.groups ?? []) {
      const symbolKind = group?.symbol_kind
      const symbolName = group?.symbol_name
      if (
        typeof symbolKind !== "string" ||
        typeof symbolName !== "string" ||
        symbolKind === "module" ||
        symbolName === "<module>" ||
        symbolName === "<evidence>"
      ) {
        continue
      }

      competingOwners.push({
        file,
        symbol_kind: symbolKind,
        symbol_name: symbolName,
        start_line: group.start_line ?? null,
        end_line: group.end_line ?? null,
      })
    }
  }

  if (competingOwners.length > 0) {
    return reject(
      "competing_structural_owner",
      `${competingOwners[0].file}:${competingOwners[0].symbol_name}`,
      {
        checked_files: candidates.length,
        competing_owners: competingOwners.slice(0, 8),
      },
    )
  }

  return {
    ok: true,
    protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
    reason: "bounded_competitor_confirmation_passed",
    checked_files: candidates.length,
    competing_owners: [],
  }
}

function simpleRenameIdentifierQuery(value) {
  const query = String(value ?? "")
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query)
    ? query
    : null
}

function selectRenameTargetFromExactEvidence(
  root,
  queries,
  discoveryResults,
  exactStructuralGroups,
  handoffFiles,
) {
  const reject = (reason, detail = null) => ({
    ok: false,
    reason,
    detail,
    target: null,
  })

  if (
    typeof root !== "string" ||
    !Array.isArray(queries) ||
    !Array.isArray(discoveryResults) ||
    !Array.isArray(exactStructuralGroups) ||
    !Array.isArray(handoffFiles)
  ) {
    return reject("rename_target_inputs_incomplete")
  }

  const handoffFileKeys = new Set(
    handoffFiles
      .map((entry) => canonicalMutationFile(root, entry?.file))
      .filter(Boolean),
  )
  const candidates = new Map()

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const identifier = simpleRenameIdentifierQuery(queries[queryIndex])
    if (!identifier) continue

    const result = discoveryResults[queryIndex]
    if (
      result?.scanComplete !== true ||
      result?.timedOut === true ||
      result?.scanCapped === true ||
      result?.error ||
      result?.queryFormulation != null
    ) {
      continue
    }

    const discoveryFiles = [
      ...new Set(
        (result.files ?? [])
          .map((file) => canonicalMutationFile(root, file))
          .filter(Boolean),
      ),
    ].sort()

    // A global rename target is not bound from an emitted subset. Every file
    // discovered for the exact identifier query must survive into the sealed
    // complete handoff; otherwise later closure validation would start from
    // incomplete source evidence.
    if (
      discoveryFiles.length < 1 ||
      discoveryFiles.some((file) => !handoffFileKeys.has(file))
    ) {
      continue
    }

    const queryNumber = queryIndex + 1
    const definitions = new Map()

    for (const group of exactStructuralGroups) {
      if (!validateEvidenceGroup(group)) continue
      if (group.role !== "definition") continue
      if (group.symbol_name !== identifier) continue
      if (!(group.queries ?? []).includes(queryNumber)) continue

      const file = canonicalMutationFile(root, group.file)
      if (!file || !discoveryFiles.includes(file)) continue
      if (
        !Number.isInteger(group.start_line) ||
        !Number.isInteger(group.end_line) ||
        group.start_line < 1 ||
        group.end_line < group.start_line
      ) {
        continue
      }

      const identity = {
        file,
        symbol_kind: group.symbol_kind,
        symbol_name: identifier,
        start_line: group.start_line,
        end_line: group.end_line,
      }
      const key = JSON.stringify(identity)

      if (!definitions.has(key)) {
        definitions.set(key, {
          target: identity,
          queryIndex,
          queryNumber,
          identifier,
          evidenceLines: [...new Set(group.hit_lines ?? [])]
            .filter((line) => Number.isInteger(line) && line > 0)
            .sort((a, b) => a - b),
          discoveryFiles,
          exactHitCount: Number.isInteger(group.hit_count)
            ? group.hit_count
            : 0,
        })
      }
    }

    if (definitions.size > 1) {
      return reject(
        "rename_target_ambiguous_definition",
        `query_${queryNumber}:${identifier}:definitions_${definitions.size}`,
      )
    }

    if (definitions.size === 1) {
      const candidate = [...definitions.values()][0]
      candidates.set(JSON.stringify(candidate.target), candidate)
    }
  }

  if (candidates.size < 1) {
    return reject("rename_target_not_proven")
  }
  if (candidates.size > 1) {
    return reject(
      "rename_target_multiple_exact_definitions",
      `targets_${candidates.size}`,
    )
  }

  return {
    ok: true,
    reason: "unique_exact_identifier_definition",
    ...[...candidates.values()][0],
  }
}

async function attestRenameTargetCapability(
  root,
  state,
  queries,
  discoveryResults,
  exactStructuralGroups,
) {
  const reject = (reason, detail = null) => ({
    ok: false,
    protocol: SCOUT_RENAME_TARGET_PROTOCOL,
    reason,
    detail,
    ready: false,
    globalReady: false,
    target: null,
  })

  const rel = normalizeMutationFile(state?.scoutHandoffPath)
  if (!rel.startsWith(".opencode/scout-handoffs/")) {
    return reject("rename_target_handoff_unavailable")
  }

  const handoffRoot = path.resolve(root, ".opencode", "scout-handoffs")
  const absolute = path.resolve(root, rel)
  if (
    absolute !== handoffRoot &&
    !absolute.startsWith(handoffRoot + path.sep)
  ) {
    return reject("rename_target_handoff_escape")
  }

  let raw
  let bundle
  try {
    raw = await readFile(absolute)
    bundle = JSON.parse(raw.toString("utf8"))
  } catch {
    return reject("rename_target_handoff_unreadable")
  }

  const blockingReasons = Array.isArray(bundle?.blocking_reasons)
    ? bundle.blocking_reasons
    : []
  const partialReasons = Array.isArray(bundle?.partial_reasons)
    ? bundle.partial_reasons
    : []

  if (
    bundle?.protocol !== SCOUT_HANDOFF_PROTOCOL ||
    bundle?.status !== "ready" ||
    blockingReasons.length > 0 ||
    partialReasons.length > 0
  ) {
    return reject(
      "rename_target_requires_complete_handoff",
      `${bundle?.status ?? "missing"}:${[
        ...blockingReasons,
        ...partialReasons,
      ].join(",")}`,
    )
  }

  const handoffFiles = Array.isArray(bundle.files) ? bundle.files : []
  const selected = selectRenameTargetFromExactEvidence(
    root,
    queries,
    discoveryResults,
    exactStructuralGroups,
    handoffFiles,
  )
  if (selected.ok !== true) {
    return reject(selected.reason, selected.detail ?? null)
  }

  const target = selected.target
  const targetFile = handoffFiles.find(
    (entry) => canonicalMutationFile(root, entry?.file) === target.file,
  )
  const fingerprint = targetFile?.fingerprint
  if (
    fingerprint?.kind !== "sha256" ||
    fingerprint?.strong !== true ||
    fingerprint?.evidence_fresh !== true ||
    typeof fingerprint?.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(fingerprint.sha256) ||
    targetFile?.changed_during_scout === true
  ) {
    return reject("rename_target_fingerprint_not_strong_current")
  }

  let body
  try {
    body = await readFile(path.resolve(root, target.file))
  } catch {
    return reject("rename_target_file_unavailable")
  }

  const currentSha256 = createHash("sha256").update(body).digest("hex")
  if (currentSha256 !== fingerprint.sha256) {
    return reject("rename_target_fingerprint_stale")
  }

  const targetIdentitySha256 = createHash("sha256")
    .update(JSON.stringify(target))
    .digest("hex")
  const sourceHandoffSha256 = createHash("sha256")
    .update(raw)
    .digest("hex")

  return {
    ok: true,
    protocol: SCOUT_RENAME_TARGET_PROTOCOL,
    operation: "rename_symbol",
    reason: selected.reason,
    ready: true,
    globalReady: true,
    sourceHandoffPath: rel,
    sourceHandoffSha256,
    target,
    targetIdentitySha256,
    targetSourceSha256: currentSha256,
    queryIndex: selected.queryIndex,
    queryNumber: selected.queryNumber,
    identifier: selected.identifier,
    evidenceLines: selected.evidenceLines,
    exactHitCount: selected.exactHitCount,
    discoveryFiles: selected.discoveryFiles,
  }
}

async function attestLocalMutationCapability(
  root,
  sessionID,
  state,
  scoutHandoff,
  editCapsule,
  competitorCheck,
  targetOverride = null,
) {
  const reject = (reason, detail = null) => ({
    ok: false,
    protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
    reason,
    detail,
    globalReady: false,
    replaceNodeReady: false,
    renameSymbolReady: false,
    localHandoffPath: null,
    target: null,
  })

  if (
    !root ||
    !sessionID ||
    !state ||
    !scoutHandoff?.path ||
    editCapsule?.mutationReady !== true ||
    competitorCheck?.ok !== true
  ) {
    return reject("capability_inputs_incomplete")
  }

  const eligibility = scoutMutationLocalizationEligibility(
    state,
    scoutHandoff,
  )
  if (!eligibility.eligible) {
    return reject("localization_not_eligible", eligibility.reason ?? null)
  }

  const rel = normalizeMutationFile(scoutHandoff.path)
  if (!rel.startsWith(".opencode/scout-handoffs/")) {
    return reject("source_handoff_path_invalid")
  }

  const handoffRoot = path.resolve(root, ".opencode", "scout-handoffs")
  const absolute = path.resolve(root, rel)
  if (
    absolute !== handoffRoot &&
    !absolute.startsWith(handoffRoot + path.sep)
  ) {
    return reject("source_handoff_path_escape")
  }

  let raw
  let bundle
  try {
    raw = await readFile(absolute)
    bundle = JSON.parse(raw.toString("utf8"))
  } catch {
    return reject("source_handoff_unreadable")
  }

  if (bundle?.protocol !== SCOUT_HANDOFF_PROTOCOL) {
    return reject("source_handoff_protocol_mismatch")
  }

  const blockingReasons = Array.isArray(bundle.blocking_reasons)
    ? bundle.blocking_reasons
    : []
  const partialReasons = Array.isArray(bundle.partial_reasons)
    ? bundle.partial_reasons
    : []

  if (blockingReasons.length > 0) {
    return reject("source_handoff_blocked", blockingReasons.join(","))
  }

  const globalReady =
    bundle.status === "ready" && partialReasons.length === 0
  const localPartialReady =
    bundle.status === "partial" &&
    localCapabilityPartialReasonsAllowed(partialReasons)

  if (!globalReady && !localPartialReady) {
    return reject(
      "source_handoff_not_locally_sufficient",
      `${bundle.status ?? "missing"}:${partialReasons.join(",")}`,
    )
  }

  const loaded = await readAuthorizedEditCapsule(root, state)
  if (!loaded.ok) {
    return reject("edit_capsule_attestation_failed", loaded.reason ?? null)
  }

  const capsule = loaded.capsule
  const authorizedScopes = (capsule.scopes ?? []).filter(
    (scope) =>
      scope?.mutation_authorized === true &&
      scope?.context === "full",
  )
  if (authorizedScopes.length !== 1) {
    return reject("authorized_scope_cardinality", String(authorizedScopes.length))
  }

  const initialTarget = authorizedScopes[0]
  if (!sameAuthorizedScopeIdentity(initialTarget, capsule.authorized_mutation_scope)) {
    return reject("authorized_scope_attestation_mismatch")
  }

  let target = initialTarget
  let candidateMeta = null

  if (targetOverride) {
    candidateMeta =
      (editCapsule?.mutationCandidates ?? [])
        .find((candidate) =>
          sameAuthorizedScopeIdentity(candidate, targetOverride),
        ) ?? null

    if (!candidateMeta) {
      return reject("mutation_candidate_not_preauthorized")
    }

    const candidateScope =
      (editCapsule?.scopeRecords ?? [])
        .find((scope) =>
          scope?.context === "full" &&
          scope?.mutation_candidate === true &&
          sameAuthorizedScopeIdentity(scope, candidateMeta),
        ) ?? null

    if (!candidateScope) {
      return reject("mutation_candidate_scope_missing")
    }

    if (
      !globalReady &&
      !sameAuthorizedScopeIdentity(initialTarget, candidateScope)
    ) {
      return reject("partial_candidate_rebind_requires_rescout")
    }

    target = candidateScope
  }

  if (
    typeof target.symbol_name !== "string" ||
    target.symbol_name.length < 1 ||
    target.symbol_name === "<module>" ||
    target.symbol_name === "<evidence>" ||
    !Number.isInteger(target.start_line) ||
    !Number.isInteger(target.end_line) ||
    target.start_line < 1 ||
    target.end_line < target.start_line
  ) {
    return reject("authorized_scope_identity_invalid")
  }

  const wantedFile = canonicalMutationFile(root, target.file)
  if (!wantedFile) return reject("authorized_scope_file_invalid")

  const handoffFiles = Array.isArray(bundle.files) ? bundle.files : []
  const targetFile = handoffFiles.find(
    (file) => canonicalMutationFile(root, file?.file) === wantedFile,
  )
  if (!targetFile) return reject("authorized_file_not_in_handoff")

  if (
    !globalReady &&
    !(Array.isArray(targetFile.origins) && targetFile.origins.includes("lexical"))
  ) {
    return reject("partial_target_requires_direct_lexical_origin")
  }

  const fingerprint = targetFile.fingerprint
  if (
    fingerprint?.kind !== "sha256" ||
    fingerprint?.strong !== true ||
    fingerprint?.evidence_fresh !== true ||
    typeof fingerprint?.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(fingerprint.sha256) ||
    targetFile.changed_during_scout === true
  ) {
    return reject("target_fingerprint_not_strong_current")
  }

  // Re-read the target now. The derived handoff must carry a current source
  // hash, not merely trust a prior Scout observation.
  let currentBody
  try {
    currentBody = await readFile(path.resolve(root, wantedFile))
  } catch {
    return reject("target_file_unavailable")
  }
  const currentSha256 = createHash("sha256").update(currentBody).digest("hex")
  if (currentSha256 !== fingerprint.sha256) {
    return reject("target_fingerprint_stale")
  }

  const attestationTargetFile = {
    ...targetFile,
    evidence_lines:
      [...new Set([
        ...(targetFile.evidence_lines ?? []),
        ...(candidateMeta?.evidence_lines ?? []),
      ])]
        .filter((line) => Number.isInteger(line) && line > 0)
        .sort((a, b) => a - b),
  }

  const attestationCapsule =
    targetOverride
      ? {
          ...editCapsule,
          mutationReady: true,
          structuralSource:
            candidateMeta?.structural_source ??
            editCapsule?.structuralSource ??
            "candidate_set",
          primaryMutationCandidate:
            mutationCandidateIdentity(target),
          authorizedMutationScope:
            mutationCandidateIdentity(target),
        }
      : editCapsule

  const ownerAttestation = buildOwnerAttestation(
    attestationCapsule,
    target,
    attestationTargetFile,
  )
  if (!ownerAttestation.ok) {
    return reject(
      "target_owner_evidence_unavailable",
      ownerAttestation.reason,
    )
  }

  const attestedEvidenceLines = ownerAttestation.evidence_lines

  const sourceHandoffSha256 = createHash("sha256").update(raw).digest("hex")
  const identity = {
    file: wantedFile,
    symbol_kind: target.symbol_kind,
    symbol_name: target.symbol_name,
    start_line: target.start_line,
    end_line: target.end_line,
  }
  const identitySha256 = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")

  const capability = {
    protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
    operation: "replace_node",
    allowed_mutations: [...SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS],
    basis: "single_full_source_validated_owner",
    owner_attestation: ownerAttestation,
    source_handoff: rel,
    source_handoff_sha256: sourceHandoffSha256,
    source_handoff_status: bundle.status,
    source_partial_reasons: partialReasons,
    edit_capsule: editCapsule.path,
    edit_capsule_sha256: editCapsule.sha256,
    target: identity,
    target_identity_sha256: identitySha256,
    target_source_sha256: currentSha256,
    attested_evidence_lines: attestedEvidenceLines,
    competitor_confirmation: competitorCheck,
    global_discovery_complete: globalReady,
  }

  const localBundle = {
    protocol: SCOUT_HANDOFF_PROTOCOL,
    search_protocol: SEARCH_PROTOCOL,
    session_key: scoutOpaqueKey(sessionID),
    turn_key: scoutOpaqueKey(state.turnID ?? ""),
    generated_at_ms: nowMs(),
    status: "ready",
    blocking_reasons: [],
    partial_reasons: [],
    scope_mode: "local_mutation_capability",
    capability_protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
    allowed_mutations: [...SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS],
    owner_attestation: ownerAttestation,
    source_handoff: rel,
    source_handoff_sha256: sourceHandoffSha256,
    source_handoff_status: bundle.status,
    source_partial_reasons: partialReasons,
    edit_capsule: editCapsule.path,
    edit_capsule_sha256: editCapsule.sha256,
    capability,
    budgets: bundle.budgets ?? {},
    searches: bundle.searches ?? [],
    files: [
      {
        ...targetFile,
        file: wantedFile,
        evidence_lines: attestedEvidenceLines,
        fingerprint: {
          ...fingerprint,
          sha256: currentSha256,
          strong: true,
          evidence_fresh: true,
        },
        changed_during_scout: false,
      },
    ],
  }

  const localHandoffPath = await writeLocalMutationHandoff(
    root,
    sessionID,
    state.turnID,
    localBundle,
    targetOverride ? identitySha256 : "primary",
  )
  if (!localHandoffPath) {
    return reject("local_mutation_handoff_write_failed")
  }

  return {
    ok: true,
    protocol: SCOUT_LOCAL_CAPABILITY_PROTOCOL,
    reason: globalReady
      ? "global_ready_local_scope_attested"
      : "partial_global_local_scope_attested",
    globalReady,
    replaceNodeReady: true,
    // Rename authority is a distinct capability derived from exact symbol
    // identity. A replace-node owner must never implicitly authorize rename.
    renameSymbolReady: false,
    sourceHandoffPath: rel,
    localHandoffPath,
    target: identity,
    targetSourceSha256: currentSha256,
    sourcePartialReasons: partialReasons,
    competitorCheck,
    allowedMutations: [...SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS],
    ownerAttestation,
  }
}

async function attestLocalMutationCandidateSet(
  root,
  sessionID,
  state,
  scoutHandoff,
  editCapsule,
  competitorCheck,
) {
  const candidates =
    Array.isArray(editCapsule?.mutationCandidates)
      ? editCapsule.mutationCandidates
      : []

  const initial = editCapsule?.authorizedMutationScope ?? null
  const globalReady = scoutHandoff?.status === "ready"

  const eligibleCandidates =
    globalReady
      ? candidates
      : candidates.filter((candidate) =>
          sameAuthorizedScopeIdentity(candidate, initial),
        )

  const preauthorized = []
  const rejected = []

  for (const candidate of eligibleCandidates) {
    const capability = await attestLocalMutationCapability(
      root,
      sessionID,
      state,
      scoutHandoff,
      editCapsule,
      competitorCheck,
      candidate,
    )

    if (capability?.ok === true) {
      preauthorized.push({
        target: capability.target,
        capability,
      })
    } else {
      rejected.push({
        target: mutationCandidateIdentity(candidate),
        reason: capability?.reason ?? "candidate_attestation_failed",
        detail: capability?.detail ?? null,
      })
    }
  }

  const primary =
    preauthorized.find((entry) =>
      sameAuthorizedScopeIdentity(entry.target, initial),
    )?.capability ?? null

  return {
    ok: primary?.ok === true && preauthorized.length > 0,
    protocol: MUTATION_CANDIDATE_SET_PROTOCOL,
    primary,
    candidates: preauthorized,
    rejected,
  }
}

const sessionStates = new Map()

function dropSessionState(sessionID) {
  sessionStates.delete(sessionID)
}

function evictOldestSession() {
  let oldestID = null
  let oldestSeen = Infinity

  for (const [sessionID, state] of sessionStates) {
    if (state.lastSeen < oldestSeen) {
      oldestSeen = state.lastSeen
      oldestID = sessionID
    }
  }

  if (oldestID !== null) sessionStates.delete(oldestID)
}

function pruneSessionStates(now = nowMs()) {
  for (const [sessionID, state] of sessionStates) {
    if (now - state.lastSeen > SESSION_TTL_MS) sessionStates.delete(sessionID)
  }
}

function getSessionState(sessionID) {
  if (!sessionID) return null

  const now = nowMs()
  pruneSessionStates(now)

  let state = sessionStates.get(sessionID)

  if (!state) {
    while (sessionStates.size >= MAX_TRACKED_SESSIONS) evictOldestSession()

    state = {
      root: null,
      turnID: null,
      turnStartedAt: 0,
      modelCalls: 0,
      searchAttempts: 0,
      executedSearches: 0,
      evidenceBytes: 0,
      signatures: new Set(),
      queryCache: new Map(),
      sourceInventoryCache: new Map(),
      evidenceLedger: new Set(),
      routeLedger: new Set(),
      taskAnchors: null,
      taskShape: null,
      additiveLocalizationPlan: null,
      frameworkResourceEdges: new Map(),
      resourceAdapterEdges: new Map(),
      contextualizedHitLines: new Set(),
      consecutiveNoProgress: 0,
      ledgerSaturated: false,
      queryCacheMatches: 0,
      seenUsageMessages: new Set(),
      scoutSearches: [],
      scoutFiles: new Map(),
      scoutHandoffPath: null,
      localMutationHandoffPath: null,
      localMutationCapability: null,
      localMutationCandidates: [],
      renameMutationCapability: null,
      activeMutationHandoffPath: null,
      boundMutationTarget: null,
      mutationAttempts: 0,
      repairAttempts: 0,
      compilerRuns: 0,
      patchAttempts: 0,
      executorRuns: 0,
      executedPatches: 0,
      patchSignatures: new Set(),
      contractFailureSignatures: new Set(),
      contractFailures: 0,
      activeMutationTool: null,
      additiveRepairLock: null,
      taskContextProtocol: TASK_CONTEXT_PROTOCOL,
      taskContextAdapterProtocol: TASK_CONTEXT_ADAPTER_PROTOCOL,
      taskContextLatched: false,
      taskTurnID: null,
      taskTextSha256: null,
      taskTextBytes: 0,
      taskTextSources: [],
      taskContextShape: null,
      taskContextReason: "unresolved",
      taskContextDrift: false,
      taskAction: null,
      taskRequirements: null,
      taskRoleEvidence: [],
      dataCapabilityObservation: null,
      actionCommitSha256: null,
      actionCommitDispatches: 0,
      terminalCommit: null,
      terminalCommitSha256: null,
      terminalCommitClaims: 0,
      terminalShortCircuitAttemptedSha256: null,
      terminalShortCircuitRequests: 0,
      terminalShortCircuits: 0,
      terminalShortCircuitFailures: 0,
      completionSafeFail: null,
      completionSafeFailSha256: null,
      completionSafeFailClaims: 0,
      completionSafeFailShortCircuitAttemptedSha256: null,
      completionSafeFailShortCircuitRequests: 0,
      completionSafeFailShortCircuits: 0,
      completionSafeFailShortCircuitFailures: 0,
      mutationIntent: "unknown",
      mutationIntentReason: "unresolved",
      visibleToolSchemaSha256: null,
      patchAccepted: false,
      patchReceiptPath: null,
      executionState: EXEC_STATE_LOCATE,
      executionReason: "session_start",
      executionEvent: "session_start",
      executionReadiness: initialExecutionReadiness("session_start"),
      additiveMutationCapability: null,
      additiveMutationHandoffPath: null,
      additiveMutationContext: null,
      executionContextCapsule: null,
      executionContextCapsuleSha256: null,
      executionContextContractSha256: null,
      executionContextBlockReason: null,
      executionContextSelectedSource: null,
      repairContextProjectionStatus: null,
      repairContextProjectionReason: null,
      repairContextProjectionBytes: 0,
      repairContextProjectionSha256: null,
      repairContextSourceCapsuleSha256: null,
      lastModelDispatchStartedAt: null,
      modelLatencySamples: 0,
      modelLatencyMaxMs: 0,
      modelLatencyProfile: initialLatencyProfile(),
      governorTaskStartedAt: now,
      governorPhaseStartedAt: now,
      governorPhase: phaseForExecutionState(EXEC_STATE_LOCATE),
      editCapsulePath: null,
      editCapsuleHash: null,
      proofObligations: [],
      pendingRescout: null,
      lastSeen: now,
    }

    sessionStates.set(sessionID, state)
  }

  state.lastSeen = now
  return state
}

function resetTurnState(state, turnID, startedAt = nowMs()) {
  state.turnID = turnID
  state.turnStartedAt = startedAt
  state.modelCalls = 0
  state.searchAttempts = 0
  state.executedSearches = 0
  state.evidenceBytes = 0
  state.signatures.clear()
  state.queryCache.clear()
  state.sourceInventoryCache.clear()
  state.evidenceLedger.clear()
  state.routeLedger.clear()
  state.frameworkResourceEdges = new Map()
  state.resourceAdapterEdges = new Map()
  state.contextualizedHitLines.clear()
  state.consecutiveNoProgress = 0
  state.ledgerSaturated = false
  state.queryCacheMatches = 0
  state.seenUsageMessages.clear()
  state.scoutSearches = []
  state.scoutFiles = new Map()
  state.scoutHandoffPath = null
  state.localMutationHandoffPath = null
  state.localMutationCapability = null
  state.localMutationCandidates = []
  state.renameMutationCapability = null
  state.activeMutationHandoffPath = null
  state.boundMutationTarget = null
  state.mutationAttempts = 0
  state.repairAttempts = 0
  state.compilerRuns = 0
  state.patchAttempts = 0
  state.executorRuns = 0
  state.executedPatches = 0
  state.patchSignatures.clear()
  state.contractFailureSignatures.clear()
  state.contractFailures = 0
  state.activeMutationTool = null
  state.additiveRepairLock = null
  state.taskContextProtocol = TASK_CONTEXT_PROTOCOL
  state.taskContextAdapterProtocol = TASK_CONTEXT_ADAPTER_PROTOCOL
  state.taskContextLatched = false
  state.taskTurnID = null
  state.taskTextSha256 = null
  state.taskTextBytes = 0
  state.taskTextSources = []
  state.taskContextShape = null
  state.taskContextReason = "unresolved"
  state.taskContextDrift = false
  state.taskAction = null
  state.taskRequirements = null
  state.taskAnchors = null
  state.taskShape = null
  state.additiveLocalizationPlan = null
  state.taskRoleEvidence = []
  state.dataCapabilityObservation = null
  state.actionCommitSha256 = null
  state.actionCommitDispatches = 0
  state.mutationIntent = "unknown"
  state.mutationIntentReason = "unresolved"
  state.visibleToolSchemaSha256 = null
  state.patchAccepted = false
  state.patchReceiptPath = null
  state.executionState = EXEC_STATE_LOCATE
  state.executionReason = "turn_start"
  state.executionEvent = "turn_start"
  state.executionReadiness = initialExecutionReadiness("turn_start")
  state.additiveMutationCapability = null
  state.additiveMutationHandoffPath = null
  state.additiveMutationContext = null
  state.executionContextCapsule = null
  state.executionContextCapsuleSha256 = null
  state.executionContextContractSha256 = null
  state.executionContextBlockReason = null
  state.executionContextSelectedSource = null
  state.repairContextProjectionStatus = null
  state.repairContextProjectionReason = null
  state.repairContextProjectionBytes = 0
  state.repairContextProjectionSha256 = null
  state.repairContextSourceCapsuleSha256 = null
  state.lastModelDispatchStartedAt = null
  state.modelLatencySamples = 0
  state.modelLatencyMaxMs = 0
  state.modelLatencyProfile = initialLatencyProfile()
  state.governorTaskStartedAt = startedAt
  state.governorPhaseStartedAt = startedAt
  state.governorPhase = phaseForExecutionState(EXEC_STATE_LOCATE)
  state.editCapsulePath = null
  state.editCapsuleHash = null
  state.proofObligations = []
  state.pendingRescout = null
  state.lastSeen = nowMs()
}

function transitionExecutionState(current, event) {
  if (event === "turn_start") return EXEC_STATE_LOCATE
  if (event === "scout_ready") return EXEC_STATE_MUTATE
  if (event === "scout_needs_evidence") return EXEC_STATE_LOCATE
  if (event === "readiness_safe_fail") return EXEC_STATE_SAFE_FAIL
  if (event === "patch_retry") return EXEC_STATE_REPAIR
  if (event === "patch_rescout") return EXEC_STATE_LOCATE
  if (event === "patch_ready") return EXEC_STATE_DONE
  if (event === "verification_repair") return EXEC_STATE_REPAIR
  if (event === "verification_rescout") return EXEC_STATE_LOCATE
  if (event === "fatal") return EXEC_STATE_SAFE_FAIL
  return current
}

function applyExecutionReadiness(state, readiness) {
  if (!state || !readiness || readiness.protocol !== EXECUTION_READINESS_PROTOCOL) {
    return applyExecutionEvent(
      state,
      "fatal",
      "execution_readiness_invalid",
    )
  }

  state.executionReadiness = readiness
  return applyExecutionEvent(
    state,
    readiness.execution_event,
    readiness.reason,
  )
}

function observeModelLatencyAtToolBoundary(state, observedAt = nowMs()) {
  if (!state || !Number.isFinite(state.lastModelDispatchStartedAt)) return null

  const elapsed = Math.max(0, observedAt - state.lastModelDispatchStartedAt)
  state.lastModelDispatchStartedAt = null
  state.modelLatencySamples = (state.modelLatencySamples ?? 0) + 1
  state.modelLatencyMaxMs = Math.max(state.modelLatencyMaxMs ?? 0, elapsed)
  state.modelLatencyProfile = observeLatency(state.modelLatencyProfile, elapsed)
  return elapsed
}

function modelDispatchReserveMs(state) {
  if (!state) return 0
  return latencyReserveMs(state.modelLatencyProfile)
}

function allowedToolsForExecutionState(executionState) {
  if (executionState === EXEC_STATE_LOCATE) return ["search"]
  if (executionState === EXEC_STATE_MUTATE || executionState === EXEC_STATE_REPAIR) {
    return [...MUTATION_TOOL_NAMES]
  }
  return []
}

function resolveMutationActionForState(state) {
  if (
    state?.executionState !== EXEC_STATE_MUTATE &&
    state?.executionState !== EXEC_STATE_REPAIR
  ) {
    return { tool: null, reason: "not_mutation_state" }
  }

  const capability = state?.localMutationCapability ?? null
  const replaceReady =
    capability?.replaceNodeReady === true &&
    Array.isArray(state?.localMutationCandidates) &&
    state.localMutationCandidates.length > 0

  const renameCapability = state?.renameMutationCapability ?? null
  const renameReady =
    renameCapability?.protocol === SCOUT_RENAME_TARGET_PROTOCOL &&
    renameCapability?.ready === true &&
    renameCapability?.globalReady === true &&
    renameCapability?.operation === "rename_symbol" &&
    renameCapability?.sourceHandoffPath === state?.scoutHandoffPath &&
    typeof state?.scoutHandoffPath === "string" &&
    state.scoutHandoffPath.length > 0

  const additiveCapability = state?.additiveMutationCapability ?? null
  const additiveReady =
    additiveCapability?.protocol === ADDITIVE_MUTATION_CAPABILITY_PROTOCOL &&
    additiveCapability?.ready === true &&
    additiveCapability?.mutation_authority === true &&
    additiveCapability?.operation === "additive_surface" &&
    typeof state?.additiveMutationHandoffPath === "string" &&
    state.additiveMutationHandoffPath.length > 0

  if (
    state.executionState === EXEC_STATE_REPAIR &&
    typeof state.activeMutationTool === "string"
  ) {
    if (state.activeMutationTool === EXECUTE_RENAME_SYMBOL_TOOL && renameReady) {
      return { tool: EXECUTE_RENAME_SYMBOL_TOOL, reason: "repair_sticky_rename" }
    }
    if (state.activeMutationTool === EXECUTE_REPLACE_NODE_TOOL && replaceReady) {
      return { tool: EXECUTE_REPLACE_NODE_TOOL, reason: "repair_sticky_replace" }
    }
    if (state.activeMutationTool === EXECUTE_ADDITIVE_PLAN_TOOL && additiveReady) {
      return { tool: EXECUTE_ADDITIVE_PLAN_TOOL, reason: "repair_sticky_additive" }
    }
    return { tool: null, reason: "repair_capability_unavailable" }
  }

  const selected =
    state?.executionReadiness?.selected_mutation_operation ?? null

  if (selected === "additive_surface") {
    return additiveReady
      ? { tool: EXECUTE_ADDITIVE_PLAN_TOOL, reason: "readiness_additive_authorized" }
      : { tool: null, reason: "additive_capability_unavailable" }
  }

  if (selected === "rename_symbol") {
    return renameReady
      ? { tool: EXECUTE_RENAME_SYMBOL_TOOL, reason: "readiness_rename_authorized" }
      : { tool: null, reason: "rename_capability_unavailable" }
  }

  if (selected === "replace_node") {
    return replaceReady
      ? { tool: EXECUTE_REPLACE_NODE_TOOL, reason: "readiness_replace_authorized" }
      : { tool: null, reason: "replace_capability_unavailable" }
  }

  return { tool: null, reason: "readiness_operation_unresolved" }
}


function mutationToolsForState(state) {
  const resolution = resolveMutationActionForState(state)
  return resolution.tool ? [resolution.tool] : []
}


function allowedToolsForState(state) {
  if (!state) return []

  const readinessStatus = state.executionReadiness?.status ?? null

  if (state.executionState === EXEC_STATE_LOCATE) {
    return readinessStatus === EXECUTION_READINESS_STATUS.SAFE_FAIL ||
      readinessStatus === EXECUTION_READINESS_STATUS.READY_TO_MUTATE
      ? []
      : ["search"]
  }

  if (state.executionState === EXEC_STATE_MUTATE) {
    if (readinessStatus !== EXECUTION_READINESS_STATUS.READY_TO_MUTATE) {
      return []
    }
    return mutationToolsForState(state)
  }

  if (state.executionState === EXEC_STATE_REPAIR) {
    return mutationToolsForState(state)
  }

  return []
}

function applyExecutionEvent(state, event, reason, details = null) {
  if (!state) return null
  const previous = state.executionState
  const previousPhase = phaseForExecutionState(previous)
  const next = transitionExecutionState(previous, event)
  const nextPhase = phaseForExecutionState(next)
  const observedAt = nowMs()

  state.executionState = next
  state.executionReason = reason ?? event
  state.executionEvent = event

  if (previousPhase !== nextPhase) {
    state.governorPhase = nextPhase
    state.governorPhaseStartedAt = observedAt
  }

  if (event !== "patch_rescout" && event !== "verification_rescout") {
    state.pendingRescout = null
  } else {
    state.pendingRescout = details ?? { reason: reason ?? event }
    state.activeMutationTool = null
    state.additiveRepairLock = null
    state.executionReadiness =
      initialExecutionReadiness(reason ?? event)
  }

  state.lastSeen = observedAt
  return next
}


function toolAllowedForExecutionState(state, toolName) {
  if (!state) return false
  return allowedToolsForState(state).includes(toolName)
}

function nextActionForExecutionState(state) {
  const tools = allowedToolsForState(state)
  return tools[0] ?? "report_result"
}

function normalizeSessionID(event) {
  if (
    typeof event?.type === "string" &&
    event.type.startsWith("session.") &&
    typeof event?.properties?.info?.id === "string"
  ) {
    return event.properties.info.id
  }

  return (
    event?.sessionID ??
    event?.properties?.sessionID ??
    event?.properties?.info?.sessionID ??
    event?.properties?.part?.sessionID ??
    event?.part?.sessionID ??
    null
  )
}

async function rootFromSession(ctx, sessionID, state = null) {
  if (state?.root) return state.root
  if (!sessionID) return null

  try {
    const info = await ctx.session.get({ sessionID })
    const root = await normalizeDirectory(info?.location?.directory)
    if (root && state) state.root = root
    return root
  } catch {
    return null
  }
}

async function rootForTool(ctx, toolContext, sessionID, state) {
  const direct =
    (await normalizeDirectory(toolContext?.directory)) ??
    (await normalizeDirectory(toolContext?.worktree))

  if (direct) {
    if (state) state.root = direct
    return direct
  }

  return await rootFromSession(ctx, sessionID, state)
}

function searchSignature(queries, target, glob) {
  return JSON.stringify({
    queries: [...queries].sort(),
    path: target,
    glob: glob ?? null,
  })
}

function queryCacheKey(root, query, target, glob, files = null) {
  return JSON.stringify({
    root,
    query,
    path: target,
    glob: glob ?? null,
    files: Array.isArray(files) ? [...files].sort() : null,
  })
}

function reindexQueryResult(result, queryIndex, reused = false) {
  return {
    ...result,
    queryIndex,
    reused,
    matches: Array.isArray(result?.matches)
      ? result.matches.map((match) => ({
          ...match,
          queryIndex,
          exactSpans: Array.isArray(match?.exactSpans)
            ? match.exactSpans.map((span) => ({
                ...span,
                queryIndex,
              }))
            : [],
        }))
      : [],
  }
}

function cacheableQueryResult(result) {
  return (
    result &&
    !result.timedOut &&
    !result.error &&
    (result.scanComplete || result.scanCapped) &&
    Array.isArray(result.matches)
  )
}

function rememberQueryResult(state, key, result) {
  if (!state || !cacheableQueryResult(result)) return false
  if (state.queryCache.has(key)) return true
  if (state.queryCache.size >= QUERY_CACHE_MAX_ENTRIES_PER_TURN) return false

  const matchCount = result.matches.length
  if (
    state.queryCacheMatches + matchCount >
    QUERY_CACHE_MAX_MATCHES_PER_TURN
  ) {
    return false
  }

  state.queryCache.set(key, reindexQueryResult(result, 0, false))
  state.queryCacheMatches += matchCount
  return true
}


function evidenceFileKey(file) {
  const normalized = path.posix.normalize(
    String(file ?? "").replace(/\\/g, "/"),
  )

  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

function evidenceFact(kind, parts) {
  return `${kind}\0${JSON.stringify(parts)}`
}

function sourceLineFact(file, line) {
  return evidenceFact("line", [evidenceFileKey(file), line])
}

function hitLineFact(file, line) {
  return evidenceFact("hit", [evidenceFileKey(file), line])
}

function exactSpanFact(file, startByte, endByte) {
  return evidenceFact("span", [evidenceFileKey(file), startByte, endByte])
}

function scopeFact(scope) {
  return evidenceFact("scope", [
    evidenceFileKey(scope?.file),
    scope?.start,
    scope?.end,
    scope?.symbolKind,
    scope?.symbolName,
  ])
}

function groupFact(group) {
  return evidenceFact("group", [
    evidenceFileKey(group?.file),
    group?.start_line,
    group?.end_line,
    group?.symbol_kind,
    group?.symbol_name,
    group?.role,
    group?.anchor,
    group?.match_text,
  ])
}

function witnessFact(group, variant) {
  return evidenceFact("witness", [
    evidenceFileKey(group?.file),
    group?.start_line,
    group?.end_line,
    group?.symbol_kind,
    group?.symbol_name,
    group?.role,
    group?.anchor,
    variant?.subject_text,
    variant?.statement_text,
    integerList(variant?.hit_lines) ?? [],
  ])
}

function negativeQueryFact(result, target, glob) {
  return evidenceFact("negative", [
    result?.query,
    target,
    glob ?? null,
  ])
}

function indexSummaryFact(result, fileCount, exactMatches) {
  return evidenceFact("index_summary", [
    result?.scanComplete === true,
    result?.scanCapped === true,
    fileCount,
    result?.matches?.length ?? 0,
    exactMatches,
  ])
}

function indexFileFact(entry) {
  return evidenceFact("index_file", [
    evidenceFileKey(entry?.file),
    entry?.lineHits,
    entry?.exactMatches,
    entry?.firstLine ?? null,
    entry?.sample ?? null,
  ])
}

function indexFacetFact(kind, entry) {
  return evidenceFact("index_facet", [
    kind,
    entry?.text ?? null,
    entry?.exactMatches ?? 0,
    entry?.files?.size ?? 0,
    evidenceFileKey(entry?.firstFile),
    entry?.firstLine ?? null,
  ])
}

function routeCandidateFact(entry, selected, target, glob) {
  return evidenceFact("route_candidate", [
    evidenceFileKey(entry?.file),
    [...(entry?.queries ?? [])].sort((a, b) => a - b),
    selected === true,
    target,
    glob ?? null,
  ])
}

function routeSummaryFact(discoveryComplete, candidateCount, selectedCount) {
  return evidenceFact("route_summary", [
    discoveryComplete === true,
    candidateCount,
    selectedCount,
  ])
}

function routeFactsForRanking(
  rankedFiles,
  selectedFileSet,
  discoveryComplete,
  target,
  glob,
) {
  const facts = new Set([
    routeSummaryFact(
      discoveryComplete,
      rankedFiles?.length ?? 0,
      selectedFileSet?.size ?? 0,
    ),
  ])

  for (const entry of rankedFiles ?? []) {
    if (!(selectedFileSet instanceof Set) || !selectedFileSet.has(entry.file)) {
      continue
    }

    facts.add(
      routeCandidateFact(
        entry,
        true,
        target,
        glob,
      ),
    )
  }

  return facts
}

function contextualizedHitLineKey(file, line) {
  return `${evidenceFileKey(file)}\0${line}`
}

function positiveFactsForHit(hit) {
  const facts = new Set()

  if (typeof hit?.file !== "string" || !Number.isInteger(hit?.line)) {
    return facts
  }

  facts.add(hitLineFact(hit.file, hit.line))

  for (const span of hit.exactSpans ?? []) {
    if (
      Number.isSafeInteger(span?.startByte) &&
      Number.isSafeInteger(span?.endByte) &&
      span.startByte >= 0 &&
      span.endByte > span.startByte
    ) {
      facts.add(exactSpanFact(hit.file, span.startByte, span.endByte))
    }
  }

  return facts
}

function positiveFactsForHits(hits) {
  const facts = new Set()

  for (const hit of hits?.values?.() ?? []) {
    for (const fact of positiveFactsForHit(hit)) facts.add(fact)
  }

  return facts
}

function negativeFactsForResults(results, target, glob) {
  const facts = new Set()

  for (const result of results ?? []) {
    if (
      result?.scanComplete === true &&
      !result?.error &&
      !result?.timedOut &&
      Array.isArray(result?.matches) &&
      result.matches.length === 0
    ) {
      facts.add(negativeQueryFact(result, target, glob))
    }
  }

  return facts
}

function negativeFactsForDiscoveryResults(results, target, glob) {
  const facts = new Set()

  for (const result of results ?? []) {
    if (
      result?.scanComplete === true &&
      !result?.error &&
      !result?.timedOut &&
      Array.isArray(result?.files) &&
      result.files.length === 0
    ) {
      facts.add(negativeQueryFact(result, target, glob))
    }
  }

  return facts
}

function factSeen(seenFacts, fact) {
  return seenFacts instanceof Set && seenFacts.has(fact)
}

function hitHasNovelPositiveFact(hit, seenFacts) {
  for (const fact of positiveFactsForHit(hit)) {
    if (!factSeen(seenFacts, fact)) return true
  }

  return false
}

function hitFactsAlreadySeen(hit, seenFacts) {
  const facts = positiveFactsForHit(hit)
  if (facts.size < 1) return false

  for (const fact of facts) {
    if (!factSeen(seenFacts, fact)) return false
  }

  return true
}

function countHitsAlreadySeen(hits, seenFacts) {
  let count = 0

  for (const hit of hits?.values?.() ?? []) {
    if (hitFactsAlreadySeen(hit, seenFacts)) count += 1
  }

  return count
}

function novelEvidenceFacts(state, facts) {
  const novel = new Set()
  let prior = 0

  for (const fact of facts ?? []) {
    if (state?.evidenceLedger?.has(fact)) prior += 1
    else novel.add(fact)
  }

  return { novel, prior }
}

function novelRouteFacts(state, facts) {
  const novel = new Set()
  let prior = 0

  for (const fact of facts ?? []) {
    if (state?.routeLedger?.has(fact)) prior += 1
    else novel.add(fact)
  }

  return { novel, prior }
}

function rememberEvidenceFacts(state, facts) {
  if (!state?.evidenceLedger) return { added: 0, saturated: false }

  let added = 0

  for (const fact of facts ?? []) {
    if (state.evidenceLedger.has(fact)) continue

    if (state.evidenceLedger.size >= EVIDENCE_LEDGER_MAX_FACTS_PER_TURN) {
      state.ledgerSaturated = true
      return { added, saturated: true }
    }

    state.evidenceLedger.add(fact)
    added += 1
  }

  return {
    added,
    saturated: state.ledgerSaturated === true,
  }
}

function rememberRouteFacts(state, facts) {
  if (!state?.routeLedger) return { added: 0, saturated: false }

  let added = 0

  for (const fact of facts ?? []) {
    if (state.routeLedger.has(fact)) continue
    if (state.routeLedger.size >= ROUTE_LEDGER_MAX_FACTS_PER_TURN) {
      return { added, saturated: true }
    }

    state.routeLedger.add(fact)
    added += 1
  }

  return { added, saturated: false }
}

function rememberContextualizedHitLines(state, keys) {
  if (!state?.contextualizedHitLines) return

  for (const key of keys ?? []) {
    if (state.contextualizedHitLines.size >= CONTEXTUALIZED_HITS_MAX_PER_TURN) {
      return
    }

    state.contextualizedHitLines.add(key)
  }
}

function evidenceFactKind(fact) {
  if (typeof fact !== "string") return "other"
  const pos = fact.indexOf("\0")
  return pos >= 0 ? fact.slice(0, pos) : fact
}

function summarizeEvidenceFacts(facts) {
  const result = {
    positive: 0,
    context: 0,
    negative: 0,
    structural: 0,
    routing: 0,
    other: 0,
  }

  for (const fact of facts ?? []) {
    const kind = evidenceFactKind(fact)

    if (kind === "hit" || kind === "span") result.positive += 1
    else if (kind === "line") result.context += 1
    else if (kind === "negative") result.negative += 1
    else if (kind === "scope" || kind === "group" || kind === "witness") {
      result.structural += 1
    } else if (kind === "index_summary" || kind === "index_file") {
      result.routing += 1
    } else {
      result.other += 1
    }
  }

  return result
}

async function safeTarget(root, raw = ".") {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("path must be a non-empty relative path")
  }

  if (path.isAbsolute(raw)) {
    const resolvedAbsolute = await realpath(raw)

    if (resolvedAbsolute === root) {
      return "."
    }

    throw new Error("absolute paths are disabled")
  }

  const candidate = path.resolve(root, raw)
  const resolved = await realpath(candidate)

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("path escapes project root")
  }

  return path.relative(root, resolved) || "."
}

function exactSpansFromRgMatch(data, queryIndex) {
  const absoluteOffset = data?.absolute_offset
  const submatches = data?.submatches
  const lineText = data?.lines?.text

  if (
    !Number.isSafeInteger(absoluteOffset) ||
    absoluteOffset < 0 ||
    !Array.isArray(submatches) ||
    typeof lineText !== "string"
  ) {
    return []
  }

  // ripgrep JSON offsets are byte offsets. submatch start/end are relative to
  // data.lines, while absolute_offset is the byte offset of that data block
  // in the searched file. Keep these as bytes all the way into Rust.
  const lineBytes = bytes(lineText)
  const spans = []

  for (const submatch of submatches) {
    const start = submatch?.start
    const end = submatch?.end

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > lineBytes
    ) {
      continue
    }

    const startByte = absoluteOffset + start
    const endByte = absoluteOffset + end

    if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)) {
      continue
    }

    spans.push({
      queryIndex,
      startByte,
      endByte,
    })
  }

  return spans
}

function exactMatchTextsFromRgMatch(data) {
  const submatches = data?.submatches
  if (!Array.isArray(submatches)) return []

  const texts = []
  for (const submatch of submatches) {
    const text = submatch?.match?.text
    if (typeof text === "string" && text.length > 0) texts.push(text)
  }

  return texts
}

function runFileDiscovery(root, query, queryIndex, target, glob) {
  return new Promise((resolve) => {
    const args = [
      "--files-with-matches",
      "--null",
      "--color",
      "never",
    ]

    appendSearchGlobs(args, glob)
    args.push("--", query, target)

    const child = spawn("rg", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const files = []
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let scanCapped = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, QUERY_TIMEOUT_MS)

    function consume(file) {
      if (!file || scanCapped) return
      if (isReservedAgentEvidencePath(file)) return

      // Exactly FILE_DISCOVERY_CAP_PER_QUERY files are complete; observing
      // one more file proves that lexical file discovery is truncated.
      if (files.length >= FILE_DISCOVERY_CAP_PER_QUERY) {
        scanCapped = true
        child.kill("SIGTERM")
        return
      }

      files.push(file)
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")

      while (true) {
        const pos = stdout.indexOf("\0")
        if (pos < 0) break
        consume(stdout.slice(0, pos))
        stdout = stdout.slice(pos + 1)
      }
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 3000) stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true

      resolve({
        query,
        queryIndex,
        files,
        timedOut,
        scanCapped,
        error: String(error?.message ?? error),
        scanComplete: false,
      })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (!scanCapped && stdout.length > 0) consume(stdout.replace(/\0+$/, ""))
      if (settled) return
      settled = true

      let error = null
      if (!timedOut && !scanCapped && code !== 0 && code !== 1) {
        error = stderr.trim() || `rg exited with status ${code}`
      }

      resolve({
        query,
        queryIndex,
        files,
        timedOut,
        scanCapped,
        error,
        scanComplete: !timedOut && !scanCapped && !error,
      })
    })
  })
}

function queryPathTokens(query) {
  const chunks = String(query ?? "").match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g)
  if (!chunks) return []

  const tokens = new Set()

  for (const chunk of chunks) {
    const whole = chunk.toLowerCase()
    if (whole.length >= 3) tokens.add(whole)

    const split = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-\s]+/)

    for (const part of split) {
      if (part.length >= 3) tokens.add(part.toLowerCase())
    }
  }

  return [...tokens].slice(0, 8)
}


function escapeRegexLiteral(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function queryCompilerTokens(query) {
  const chunks = String(query ?? "").match(
    /[A-Za-z][A-Za-z0-9_-]{2,}/g,
  )

  if (!chunks) return []

  const tokens = []
  const seen = new Set()

  const add = (raw) => {
    const token = String(raw ?? "").toLowerCase()

    if (
      token.length < 3 ||
      token.length > 32 ||
      QUERY_COMPILER_STOPWORDS.has(token) ||
      seen.has(token)
    ) {
      return
    }

    seen.add(token)
    tokens.push(token)
  }

  for (const chunk of chunks) {
    const split = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-\s]+/)

    for (const part of split) add(part)
  }

  return tokens.slice(0, QUERY_COMPILER_MAX_TOKENS)
}

function queryCompilerEligible(query) {
  const tokens = queryCompilerTokens(query)

  // This fallback only runs after authoritative exact-zero discovery.
  // Requiring model-generated `.*` made ordinary natural-language
  // compound queries unnecessarily expensive.
  return tokens.length >= QUERY_COMPILER_MIN_TOKENS
}

function queryCompilerCasefoldRegex(query) {
  return `(?i:${String(query ?? "")})`
}

function queryCompilerAnchorToken(tokens) {
  return [...tokens].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  )[0] ?? null
}

function splitTopLevelRegexAlternatives(query) {
  const text = String(query ?? "")
  const branches = []
  let current = ""
  let escaped = false
  let classDepth = 0
  let parenDepth = 0

  for (const ch of text) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === "\\") {
      current += ch
      escaped = true
      continue
    }

    if (ch === "[" && classDepth === 0) {
      classDepth = 1
      current += ch
      continue
    }

    if (ch === "]" && classDepth === 1) {
      classDepth = 0
      current += ch
      continue
    }

    if (classDepth === 0) {
      if (ch === "(") {
        parenDepth += 1
        current += ch
        continue
      }

      if (ch === ")") {
        if (parenDepth < 1) return null
        parenDepth -= 1
        current += ch
        continue
      }

      if (ch === "|" && parenDepth === 0) {
        if (!current.trim()) return null
        branches.push(current)
        current = ""
        if (branches.length >= QUERY_FORMULATION_MAX_BRANCHES) return null
        continue
      }
    }

    current += ch
  }

  if (escaped || classDepth !== 0 || parenDepth !== 0 || !current.trim()) {
    return null
  }

  branches.push(current)
  return branches
}

function queryFormulationAtoms(fragment) {
  const chunks = String(fragment ?? "").match(
    /[A-Za-z][A-Za-z0-9_-]{2,}|\d{2,8}/g,
  )

  if (!chunks) return []

  const atoms = []
  const seen = new Set()

  const add = (raw) => {
    const atom = String(raw ?? "").toLowerCase()
    if (
      atom.length < 2 ||
      atom.length > 32 ||
      QUERY_COMPILER_STOPWORDS.has(atom) ||
      seen.has(atom)
    ) {
      return
    }

    seen.add(atom)
    atoms.push(atom)
  }

  for (const chunk of chunks) {
    if (/^\d+$/.test(chunk)) {
      add(chunk)
      continue
    }

    const parts = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-\s]+/)

    for (const part of parts) add(part)
  }

  return atoms
}
