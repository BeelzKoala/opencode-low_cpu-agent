
function selectFairReservedFiles(rankedFiles, queryResults, limit) {
  const selected = new Set()
  const coveredQueries = new Set()
  const activeQueries = (queryResults ?? [])
    .map((result) => ({
      queryIndex: result.queryIndex,
      files: Array.isArray(result?.files)
        ? [...new Set(result.files)]
        : [...new Set((result?.matches ?? []).map((match) => match.file))],
    }))
    .filter((result) => result.files.length > 0)
    .sort((a, b) => a.files.length - b.files.length || a.queryIndex - b.queryIndex)

  for (const result of activeQueries) {
    if (selected.size >= limit) break
    if (coveredQueries.has(result.queryIndex)) continue
    const fileKeys = new Set(result.files.map((file) => evidenceFileKey(file)))
    const candidate = rankedFiles.find(
      (entry) => fileKeys.has(evidenceFileKey(entry.file)) && !selected.has(entry.file),
    )
    if (!candidate) continue
    selected.add(candidate.file)
    for (const queryIndex of candidate.queries ?? []) coveredQueries.add(queryIndex)
  }

  return rankedFiles.filter((entry) => selected.has(entry.file))
}

function bestStructuralProbeCandidate(probedFiles) {
  return (probedFiles ?? []).find(
    (entry) =>
      Number.isInteger(entry?.probeDefinitionHints) &&
      entry.probeDefinitionHints > 0,
  ) ?? null
}

function impactEmitEntry(entry) {
  const primary = entry.relations?.[0] ?? {}
  const sample = entry.validationKind === "forward_scope_definition"
    ? entry.declarationMatches?.[0]
    : entry.reverseUsageMatches?.[0]
  return {
    file: entry.file,
    origin: "impact",
    queries: new Set(entry.queries ?? []),
    coverage: 0,
    pathAffinity: 0,
    rarity: 0,
    impact: {
      seed: primary.seed ?? null,
      direction: entry.validationKind === "forward_scope_definition" ? "forward" : "reverse",
      kind: primary.kind ?? null,
      bindings: entry.displayBindings ?? [],
      validationKind: entry.validationKind,
      sample: sample ?? null,
    },
  }
}

function selectEmitFilesWithImpact(probedFiles, discoveryResults, validatedImpact) {
  const selected = []
  const selectedKeys = new Set()

  const reserve = selectFairReservedFiles(
    probedFiles,
    discoveryResults,
    EMIT_MAX_FILES,
  )

  for (const entry of reserve) {
    if (selected.length >= EMIT_MAX_FILES) break
    selected.push({ ...entry, origin: "lexical" })
    selectedKeys.add(evidenceFileKey(entry.file))
  }

  // Direct lexical structural evidence has precedence over graph-derived
  // auxiliary context. The candidate is chosen from the existing post-probe
  // relevance order; this adds no new relevance score.
  //
  // This is only a routing reservation. probeDefinitionHints is never treated
  // as proof of ownership; downstream distiller/source validation must still
  // establish the actual structural owner before mutation authority exists.
  const structuralCandidate =
    bestStructuralProbeCandidate(probedFiles)

  if (
    structuralCandidate &&
    selected.length < EMIT_MAX_FILES
  ) {
    const key =
      evidenceFileKey(structuralCandidate.file)

    if (!selectedKeys.has(key)) {
      selected.push({
        ...structuralCandidate,
        origin: "lexical",
      })
      selectedKeys.add(key)
    }
  }

  let impactEmitted = 0
  for (const entry of validatedImpact ?? []) {
    if (selected.length >= EMIT_MAX_FILES || impactEmitted >= IMPACT_GRAPH_EMIT_MAX_FILES) break
    const key = evidenceFileKey(entry.file)
    if (selectedKeys.has(key)) continue
    selected.push(impactEmitEntry(entry))
    selectedKeys.add(key)
    impactEmitted += 1
  }

  for (const entry of probedFiles ?? []) {
    if (selected.length >= EMIT_MAX_FILES) break
    const key = evidenceFileKey(entry.file)
    if (selectedKeys.has(key)) continue
    selected.push({ ...entry, origin: "lexical" })
    selectedKeys.add(key)
  }

  return selected
}

function impactEvidenceFactsForSelected(selectedFiles) {
  const facts = new Set()
  for (const entry of selectedFiles ?? []) {
    if (entry?.origin !== "impact") continue
    const sample = entry?.impact?.sample
    if (typeof entry?.file === "string" && Number.isInteger(sample?.line)) {
      facts.add(hitLineFact(entry.file, sample.line))
    }
  }
  return facts
}

function integerList(values) {
  if (!Array.isArray(values)) return null

  const result = [...new Set(values)]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b)

  return result.length > 0 ? result : null
}

function lineList(values) {
  const lines = integerList(values)
  return lines ? lines.join(",") : "-"
}

function queryLabels(values) {
  const queries = integerList(values)
  return queries ? queries.map((value) => `Q${value}`).join(",") : null
}

function validateEvidenceGroup(group) {
  if (
    typeof group?.file !== "string" ||
    typeof group?.symbol_kind !== "string" ||
    typeof group?.symbol_name !== "string" ||
    typeof group?.role !== "string" ||
    typeof group?.node_kind !== "string" ||
    typeof group?.match_text !== "string" ||
    typeof group?.anchor !== "string" ||
    !Number.isInteger(group?.start_line) ||
    !Number.isInteger(group?.end_line) ||
    !Number.isInteger(group?.hit_count) ||
    group.hit_count < 1 ||
    !queryLabels(group?.queries) ||
    !Array.isArray(group?.hit_lines) ||
    !Array.isArray(group?.variants) ||
    group.variants.length < 1
  ) {
    return false
  }

  let variantHits = 0

  for (const variant of group.variants) {
    if (
      typeof variant?.subject_text !== "string" ||
      typeof variant?.statement_text !== "string" ||
      !Number.isInteger(variant?.hit_count) ||
      variant.hit_count < 1 ||
      !queryLabels(variant?.queries) ||
      !Array.isArray(variant?.hit_lines)
    ) {
      return false
    }

    variantHits += variant.hit_count
  }

  return variantHits === group.hit_count
}

async function renderHybridEvidence(root, groups, bodyBudgetBytes) {
  const core = []
  const facts = new Set()
  let coreBytes = 0

  function pushCore(line) {
    const cost = bytes(line + "\n")
    if (coreBytes + cost > bodyBudgetBytes) return false
    core.push(line)
    coreBytes += cost
    return true
  }

  for (const group of groups) {
    if (!validateEvidenceGroup(group)) {
      return {
        body: [],
        bodyBytes: 0,
        coreBytes: 0,
        complete: false,
        contextSamples: 0,
        shownGroups: 0,
        shownVariants: 0,
        reason: "invalid_group",
      }
    }

    const q = queryLabels(group.queries)
    const header =
      `${group.file}:${group.start_line}-${group.end_line} [${q}] ` +
      `symbol=${JSON.stringify(group.symbol_name)} ` +
      `role=${group.role} ` +
      `anchor=${JSON.stringify(group.anchor)} ` +
      `match=${JSON.stringify(group.match_text)} ` +
      `hits=${group.hit_count} variants=${group.variants.length} ` +
      `lines=${lineList(group.hit_lines)}` +
      (group.lines_truncated ? ",…" : "")

    if (!pushCore(header)) {
      return {
        body: core,
        bodyBytes: coreBytes,
        coreBytes,
        complete: false,
        contextSamples: 0,
        shownGroups: 0,
        shownVariants: 0,
        reason: "witness_output_budget",
      }
    }

    facts.add(groupFact(group))

    for (const variant of group.variants) {
      const vq = queryLabels(variant.queries)
      const same = variant.subject_text === variant.statement_text
      const detail = same
        ? `subject=${JSON.stringify(variant.subject_text)}`
        : `subject=${JSON.stringify(variant.subject_text)} statement=${JSON.stringify(variant.statement_text)}`

      const line =
        `  x${variant.hit_count} [${vq}] ${detail} ` +
        `lines=${lineList(variant.hit_lines)}` +
        (variant.lines_truncated ? ",…" : "")

      if (!pushCore(line)) {
        return {
          body: core,
          bodyBytes: coreBytes,
          coreBytes,
          complete: false,
          contextSamples: 0,
          shownGroups: 0,
          shownVariants: 0,
          reason: "witness_output_budget",
        }
      }

      facts.add(witnessFact(group, variant))
    }
  }

  // Witnesses are complete at this point. Context is deliberately sampled,
  // never confused with complete raw context. Samples are all-or-nothing per
  // group and use the already-proven file loader/path confinement.
  const body = [...core]
  let bodyBytes = coreBytes
  let contextSamples = 0
  const cache = new Map()

  for (const group of groups) {
    const lines = await loadLines(root, group.file, cache)
    if (!lines || lines.length < 1) continue

    for (const variant of group.variants.slice(0, HYBRID_CONTEXT_SAMPLES_PER_GROUP)) {
      const exemplar = integerList(variant.hit_lines)?.[0]
      if (!exemplar) continue

      const start = Math.max(1, exemplar - HYBRID_CONTEXT_RADIUS)
      const end = Math.min(lines.length, exemplar + HYBRID_CONTEXT_RADIUS)
      const block = [
        `  variant_context=${group.file}:${start}-${end} subject=${JSON.stringify(variant.subject_text)}`,
      ]

      for (let n = start; n <= end; n++) {
        const marker = n === exemplar ? ">" : " "
        block.push(`  ${marker} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`)
      }

      const blockBytes = block.reduce(
        (total, line) => total + bytes(line + "\n"),
        0,
      )
      if (bodyBytes + blockBytes > bodyBudgetBytes) continue

      body.push(...block)
      bodyBytes += blockBytes
      contextSamples += 1

      for (let n = start; n <= end; n++) {
        facts.add(sourceLineFact(group.file, n))
      }
    }
  }

  const shownVariants = groups.reduce(
    (total, group) => total + group.variants.length,
    0,
  )

  return {
    body,
    facts,
    bodyBytes,
    coreBytes,
    complete: true,
    contextSamples,
    shownGroups: groups.length,
    shownVariants,
    reason: null,
  }
}

async function renderEvidence(root, hits, bodyBudgetBytes) {
  const byFile = new Map()

  for (const [key, hit] of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, [])
    byFile.get(hit.file).push({ key, ...hit })
  }

  const cache = new Map()
  const body = []
  const shown = new Set()
  let bodyBytes = 0

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > bodyBudgetBytes) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  outer:
  for (const [file, fileHits] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = await loadLines(root, file, cache)

    if (!lines) {
      for (const hit of fileHits.sort((a, b) => a.line - b.line)) {
        const q = [...hit.queries]
          .sort((a, b) => a - b)
          .map((x) => `Q${x + 1}`)
          .join(",")

        if (!push(`${file}:${hit.line} [${q}] ${clipLine(hit.text)}`)) break outer
        shown.add(hit.key)
      }
      continue
    }

    const hitByLine = new Map()
    for (const hit of fileHits) hitByLine.set(hit.line, hit)

    const ranges = buildRanges(fileHits.map((x) => x.line), lines.length)

    for (const range of ranges) {
      if (!push(`--- ${file}:${range.start}-${range.end} ---`)) break outer

      for (let n = range.start; n <= range.end; n++) {
        const hit = hitByLine.get(n)
        let prefix = " "

        if (hit) {
          const q = [...hit.queries]
            .sort((a, b) => a - b)
            .map((x) => `Q${x + 1}`)
            .join(",")
          prefix = `>[${q}]`
        }

        if (!push(`${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`)) {
          break outer
        }

        if (hit) shown.add(hit.key)
      }
    }
  }

  return { body, shown, bodyBytes }
}

function mergeLineRanges(ranges) {
  const sorted = ranges
    .filter(
      (range) =>
        Number.isInteger(range?.start) &&
        Number.isInteger(range?.end) &&
        range.start > 0 &&
        range.end >= range.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }

  return merged
}


function addLineRange(rangesByFile, file, start, end) {
  const key = evidenceFileKey(file)
  if (!rangesByFile.has(key)) rangesByFile.set(key, [])
  rangesByFile.get(key).push({ start, end })
}

function subtractLineRanges(ranges, exclusions) {
  const excluded = mergeLineRanges(exclusions ?? [])
  if (excluded.length < 1) return mergeLineRanges(ranges ?? [])

  const result = []

  for (const range of mergeLineRanges(ranges ?? [])) {
    let cursor = range.start

    for (const cut of excluded) {
      if (cut.end < cursor) continue
      if (cut.start > range.end) break

      if (cut.start > cursor) {
        result.push({
          start: cursor,
          end: Math.min(range.end, cut.start - 1),
        })
      }

      cursor = Math.max(cursor, cut.end + 1)
      if (cursor > range.end) break
    }

    if (cursor <= range.end) result.push({ start: cursor, end: range.end })
  }

  return result
}

function lineNumbersToRanges(numbers) {
  const sorted = [...new Set(numbers)]
    .filter((line) => Number.isInteger(line) && line > 0)
    .sort((a, b) => a - b)

  const ranges = []

  for (const line of sorted) {
    const last = ranges[ranges.length - 1]

    if (last && line === last.end + 1) last.end = line
    else ranges.push({ start: line, end: line })
  }

  return ranges
}

function hitLookupByFileLine(hits) {
  const lookup = new Map()

  for (const [key, hit] of hits ?? []) {
    const fileKey = evidenceFileKey(hit.file)
    let byLine = lookup.get(fileKey)

    if (!byLine) {
      byLine = new Map()
      lookup.set(fileKey, byLine)
    }

    byLine.set(hit.line, { key, ...hit })
  }

  return lookup
}

async function renderNovelRawEvidence(
  root,
  hits,
  bodyBudgetBytes,
  seenFacts = null,
  excludedRangesByFile = new Map(),
  contextualizedHitLines = null,
) {
  const byFile = new Map()

  for (const [key, hit] of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, [])
    byFile.get(hit.file).push({ key, ...hit })
  }

  const cache = new Map()
  const body = []
  const shown = new Set()
  const facts = new Set()
  let bodyBytes = 0
  let emittedLines = 0
  let skippedPriorLines = 0
  let suppressedContextAnchors = 0

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > bodyBudgetBytes) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  outer:
  for (const [file, fileHits] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = await loadLines(root, file, cache)
    const fileKey = evidenceFileKey(file)
    const exclusions = excludedRangesByFile.get(fileKey) ?? []

    if (!lines) {
      for (const hit of fileHits.sort((a, b) => a.line - b.line)) {
        const excluded = exclusions.some(
          (range) => hit.line >= range.start && hit.line <= range.end,
        )
        if (excluded) continue

        const alreadyContextualized =
          contextualizedHitLines instanceof Set &&
          contextualizedHitLines.has(
            contextualizedHitLineKey(file, hit.line),
          )
        const lineFact = sourceLineFact(file, hit.line)
        const novelLine = !factSeen(seenFacts, lineFact)
        const novelHit = hitHasNovelPositiveFact(hit, seenFacts)

        // A prior FOCUSED scope already supplied source context for this hit.
        // A different regex matching the same hit must not manufacture
        // progress by reopening the same source location.
        if (alreadyContextualized && !novelHit) {
          suppressedContextAnchors += 1
          skippedPriorLines += 1
          continue
        }

        if (!novelLine && !novelHit) {
          skippedPriorLines += 1
          continue
        }

        const q = [...hit.queries]
          .sort((a, b) => a - b)
          .map((x) => `Q${x + 1}`)
          .join(",")

        if (!push(`${file}:${hit.line} [${q}] ${clipLine(hit.text)}`)) break outer

        facts.add(lineFact)
        for (const fact of positiveFactsForHit(hit)) facts.add(fact)
        shown.add(hit.key)
        emittedLines += 1
      }
      continue
    }

    const hitByLine = new Map()
    for (const hit of fileHits) hitByLine.set(hit.line, hit)

    // Context expansion is one-shot per hit line. Once a FOCUSED scope has
    // contextualized a hit, later regex variants matching the same hit may
    // still contribute a genuinely new positive fact, but they cannot use
    // that old hit as an anchor to expose fringe source lines outside the
    // already-shown scope.
    const contextAnchorLines = []
    const forcedNovelHitLines = []

    for (const hit of fileHits) {
      const excluded = exclusions.some(
        (range) => hit.line >= range.start && hit.line <= range.end,
      )
      if (excluded) continue

      const alreadyContextualized =
        contextualizedHitLines instanceof Set &&
        contextualizedHitLines.has(
          contextualizedHitLineKey(file, hit.line),
        )

      if (alreadyContextualized) {
        suppressedContextAnchors += 1
        if (hitHasNovelPositiveFact(hit, seenFacts)) {
          forcedNovelHitLines.push(hit.line)
        }
        continue
      }

      contextAnchorLines.push(hit.line)
    }

    const baseRanges =
      contextAnchorLines.length > 0
        ? buildRanges(contextAnchorLines, lines.length)
        : []
    const availableRanges = subtractLineRanges(baseRanges, exclusions)
    const selectedLines = new Set(forcedNovelHitLines)

    for (const range of availableRanges) {
      for (let n = range.start; n <= range.end; n++) {
        const hit = hitByLine.get(n)
        const lineFact = sourceLineFact(file, n)
        const novelLine = !factSeen(seenFacts, lineFact)
        const novelHit = hit ? hitHasNovelPositiveFact(hit, seenFacts) : false

        if (novelLine || novelHit) selectedLines.add(n)
        else skippedPriorLines += 1
      }
    }

    for (const range of lineNumbersToRanges(selectedLines)) {
      if (!push(`--- ${file}:${range.start}-${range.end} ---`)) break outer

      for (let n = range.start; n <= range.end; n++) {
        const hit = hitByLine.get(n)
        let prefix = " "

        if (hit) {
          const q = [...hit.queries]
            .sort((a, b) => a - b)
            .map((x) => `Q${x + 1}`)
            .join(",")
          prefix = `>[${q}]`
        }

        if (!push(`${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`)) {
          break outer
        }

        facts.add(sourceLineFact(file, n))
        emittedLines += 1

        if (hit) {
          for (const fact of positiveFactsForHit(hit)) facts.add(fact)
          shown.add(hit.key)
        }
      }
    }
  }

  return {
    body,
    shown,
    facts,
    bodyBytes,
    emittedLines,
    skippedPriorLines,
    suppressedContextAnchors,
  }
}

function focusedRoleScore(role) {
  if (role === "call") return 5
  if (role === "assignment") return 4
  if (role === "definition") return 3
  if (role === "import") return 2
  if (role === "reference") return 1

  // Unknown structural roles stay discovery-only. Known imports/references
  // are weak rather than impossible candidates: for wiring/type-usage tasks
  // they can be exactly the behavior the user is asking about.
  return 0
}

function focusedScopesFromGroups(groups) {
  const scopes = new Map()

  for (const group of groups ?? []) {
    if (!validateEvidenceGroup(group)) continue
    if (group.symbol_kind === "module" || group.symbol_name === "<module>") continue
    if (
      !Number.isInteger(group.start_line) ||
      !Number.isInteger(group.end_line) ||
      group.start_line < 1 ||
      group.end_line < group.start_line
    ) continue

    const key =
      `${group.file}\0${group.start_line}\0${group.end_line}` +
      `\0${group.symbol_kind}\0${group.symbol_name}`
    let scope = scopes.get(key)

    if (!scope) {
      scope = {
        file: group.file,
        start: group.start_line,
        end: group.end_line,
        symbolKind: group.symbol_kind,
        symbolName: group.symbol_name,
        hitLines: new Set(),
        anchors: new Set(),
        roles: new Set(),
        queries: new Set(),
        mutationCandidateBases: new Set(),
        hitCount: 0,
        roleScore: 0,
      }
      scopes.set(key, scope)
    }

    if (group.anchor) scope.anchors.add(group.anchor)
    for (const query of group.queries ?? []) {
      if (Number.isInteger(query) && query > 0) scope.queries.add(query)
    }
    scope.hitCount += Number.isInteger(group.hit_count) ? group.hit_count : 0
    if (group.role) {
      scope.roles.add(group.role)
      scope.roleScore = Math.max(scope.roleScore, focusedRoleScore(group.role))
    }
    if (typeof group.mutation_candidate_basis === "string") {
      scope.mutationCandidateBases.add(group.mutation_candidate_basis)
    }
    for (const line of group.hit_lines ?? []) {
      if (Number.isInteger(line) && line > 0) scope.hitLines.add(line)
    }
  }

  return [...scopes.values()]
    .filter((scope) => scope.hitLines.size > 0 && scope.roleScore > 0)
    .sort(
      (a, b) =>
        b.roleScore - a.roleScore ||
        b.queries.size - a.queries.size ||
        b.hitCount - a.hitCount ||
        b.hitLines.size - a.hitLines.size ||
        a.file.localeCompare(b.file) ||
        a.start - b.start ||
        a.end - b.end,
    )
}

function likelyTestFile(file) {
  const normalized =
    String(evidenceFileKey(file) ?? "")
      .replaceAll("\\", "/")
      .replace(/^\.\/+/, "")
      .toLowerCase()

  const parts =
    normalized.split("/").filter(Boolean)

  const base =
    parts.length > 0
      ? parts[parts.length - 1]
      : ""

  if (
    parts.some(
      (part) =>
        part === "test" ||
        part === "tests" ||
        part === "__tests__" ||
        part === "spec" ||
        part === "specs",
    )
  ) {
    return true
  }

  if (
    /^test_.+\.py$/.test(base) ||
    /.+_test\.py$/.test(base)
  ) {
    return true
  }

  if (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)
  ) {
    return true
  }

  return false
}

function scopesShareQueryEvidence(a, b) {
  const left =
    a?.queries instanceof Set
      ? a.queries
      : new Set(a?.queries ?? [])

  const right =
    b?.queries instanceof Set
      ? b.queries
      : new Set(b?.queries ?? [])

  for (const query of left) {
    if (right.has(query)) return true
  }

  return false
}

function resolvePrimaryMutationScope(primaryStructuralScopes) {
  const top =
    primaryStructuralScopes?.[0] ?? null

  if (!top) return null

  if (!likelyTestFile(top.file)) {
    return top
  }

  // Keep the existing deterministic structural order.
  // A test witness is displaced only by a non-test structural scope
  // carrying overlapping query provenance.
  const sourceAlternative =
    primaryStructuralScopes.find(
      (scope) =>
        scope !== top &&
        !likelyTestFile(scope.file) &&
        scopesShareQueryEvidence(top, scope),
    ) ?? null

  return sourceAlternative ?? top
}

async function buildEditCapsule(
  root,
  sessionID,
  state,
  groups,
  scoutHandoff,
  structuralSource = "none",
  mutationLocalization = null,
) {
  if (
    !state ||
    !sessionID ||
    mutationLocalization?.eligible !== true
  ) {
    return null
  }

  const files = [...state.scoutFiles.values()]
    .map(serializeScoutFile)
    .sort((a, b) => a.file.localeCompare(b.file))
  const rankedStructuralScopes = focusedScopesFromGroups(groups)
    .map((scope) => {
      const file = canonicalMutationFile(root, scope?.file)
      return file ? { ...scope, file } : null
    })
    .filter(Boolean)
  const scopes = []
  const chosenScopeKeys = new Set()

  function fallbackScope(file) {
    const evidence = (file.evidence_lines ?? []).filter((line) => Number.isInteger(line) && line > 0)
    const anchor = evidence[0] ?? 1
    return {
      file: file.file,
      start: Math.max(1, anchor - EDIT_CAPSULE_WINDOW_RADIUS),
      end: Math.max(anchor, anchor + EDIT_CAPSULE_WINDOW_RADIUS),
      symbolKind: "evidence_window",
      symbolName: "<evidence>",
      hitLines: new Set(evidence),
      anchors: new Set(),
      roles: new Set(["evidence"]),
      queries: new Set(),
      hitCount: evidence.length,
      roleScore: 1,
    }
  }

  // Mutation authority has priority over auxiliary context.
  //
  // Phase 1: reserve the best available structural owner for each handoff
  // file. This avoids filename-order allocation and prevents secondary
  // scopes from starving a mutation-capable owner.
  //
  // Phase 2: spend remaining scope slots on additional structural owners.
  //
  // Phase 3: spend any remaining slots on fallback evidence windows.
  //
  // The byte budget itself is enforced transactionally during rendering.
  const structuralRank = new Map(
    rankedStructuralScopes.map((scope, index) => [
      `${scope.file}\0${scope.start}\0${scope.end}\0${scope.symbolName}`,
      index,
    ]),
  )

  const handoffFilesByCanonical = new Map()

  for (const file of files) {
    const canonical = canonicalMutationFile(root, file.file)
    if (canonical) {
      handoffFilesByCanonical.set(canonical, file)
    }
  }

  const primaryStructuralScopes = []

  for (const [canonicalFile] of handoffFilesByCanonical) {
    const structural = rankedStructuralScopes.find(
      (scope) => scope.file === canonicalFile,
    )

    if (structural) {
      primaryStructuralScopes.push(structural)
    }
  }

  primaryStructuralScopes.sort((a, b) => {
    const aKey =
      `${a.file}\0${a.start}\0${a.end}\0${a.symbolName}`
    const bKey =
      `${b.file}\0${b.start}\0${b.end}\0${b.symbolName}`

    return (
      (structuralRank.get(aKey) ?? Number.MAX_SAFE_INTEGER) -
      (structuralRank.get(bKey) ?? Number.MAX_SAFE_INTEGER)
    )
  })

  // Exactly one structural owner is allowed to carry mutation authority.
  // Its identity comes from the existing deterministic structural ranking;
  // auxiliary structural scopes remain context-only.
  const primaryMutationScope =
    resolvePrimaryMutationScope(
      primaryStructuralScopes,
    )

  const primaryMutationScopeKey =
    primaryMutationScope
      ? `${primaryMutationScope.file}\0${primaryMutationScope.start}\0${primaryMutationScope.end}\0${primaryMutationScope.symbolName}`
      : null

  function addScope(scope) {
    if (!scope || scopes.length >= EDIT_CAPSULE_MAX_SCOPES) {
      return false
    }

    const key =
      `${scope.file}\0${scope.start}\0${scope.end}\0${scope.symbolName}`

    if (chosenScopeKeys.has(key)) return false

    scopes.push(scope)
    chosenScopeKeys.add(key)
    return true
  }

  // One best structural owner per handoff file first.
  // The designated mutation owner gets first claim on the
  // unchanged transactional byte budget. addScope() deduplicates it
  // when the auxiliary structural pass reaches the same scope.
  addScope(primaryMutationScope)

  for (const scope of primaryStructuralScopes) {
    if (scopes.length >= EDIT_CAPSULE_MAX_SCOPES) break
    addScope(scope)
  }

  // Then additional validated structural scopes.
  for (const scope of rankedStructuralScopes) {
    if (scopes.length >= EDIT_CAPSULE_MAX_SCOPES) break

    // Structural metadata outside the handoff is not mutation authority.
    if (!handoffFilesByCanonical.has(scope.file)) continue

    addScope(scope)
  }

  // Only after structural allocation do fallback evidence windows consume
  // the remaining scope slots.
  const representedFiles = new Set(scopes.map((scope) => scope.file))

  for (const file of files) {
    if (scopes.length >= EDIT_CAPSULE_MAX_SCOPES) break

    const canonical = canonicalMutationFile(root, file.file)
    if (!canonical || representedFiles.has(canonical)) continue

    const fallback = fallbackScope({
      ...file,
      file: canonical,
    })

    if (addScope(fallback)) {
      representedFiles.add(canonical)
    }
  }

  const cache = new Map()
  const rendered = []
  const capsuleScopes = []

  let usedBytes = 0
  let fullScopes = 0
  let windowScopes = 0

  // Compatibility meaning:
  // `truncated` below becomes an alias for auxiliary context loss.
  // It no longer means that an already committed scope is partial.
  let auxiliaryTruncated = false
  let omittedScopesByBudget = 0
  let downgradedStructuralScopes = 0

  function blockBytes(lines) {
    let total = 0
    for (const line of lines) {
      total += bytes(line + "\n")
    }
    return total
  }

  for (const scope of scopes) {
    const lines = await loadLines(root, scope.file, cache)
    if (!lines || lines.length < 1) continue

    const start =
      Math.max(1, Math.min(scope.start, lines.length))
    const end =
      Math.max(start, Math.min(scope.end, lines.length))

    const scopeKey =
      `${scope.file}\0${scope.start}\0${scope.end}\0${scope.symbolName}`

    const primaryMutationCandidate =
      primaryMutationScopeKey !== null &&
      scopeKey === primaryMutationScopeKey

    const namedStructuralScope =
      scope.symbolKind !== "evidence_window" &&
      scope.symbolKind !== "module" &&
      scope.symbolName !== "<evidence>" &&
      scope.symbolName !== "<module>"

    const fullCandidate =
      namedStructuralScope &&
      end - start + 1 <= EDIT_CAPSULE_FULL_SCOPE_MAX_LINES

    // Test the COMPLETE full scope against the remaining byte budget before
    // granting context=full. No partial source can become mutation authority.
    let full = false

    if (fullCandidate) {
      const fullBlock = [
        `CAPSULE_SCOPE ${scope.file}:${start}-${end} symbol=${JSON.stringify(scope.symbolName)} ` +
          `kind=${scope.symbolKind} context=full authority=${primaryMutationCandidate ? "mutation" : "context"}`,
      ]

      for (let line = start; line <= end; line++) {
        fullBlock.push(
          `  ${String(line).padStart(5)} | ${clipLine(lines[line - 1])}`,
        )
      }

      const fullCost = blockBytes(fullBlock)

      if (usedBytes + fullCost <= EDIT_CAPSULE_MAX_BYTES) {
        full = true
      } else {
        // The structural owner remains useful as context, but is not allowed
        // to masquerade as a complete mutation scope.
        auxiliaryTruncated = true
        downgradedStructuralScopes += 1
      }
    }

    const selected = []

    if (full) {
      for (let line = start; line <= end; line++) {
        selected.push(line)
      }
    } else {
      const wanted = new Set()

      for (
        let line = start;
        line <= Math.min(end, start + 2);
        line++
      ) {
        wanted.add(line)
      }

      for (const hitLine of scope.hitLines ?? []) {
        if (!Number.isInteger(hitLine)) continue

        const lo =
          Math.max(start, hitLine - EDIT_CAPSULE_WINDOW_RADIUS)
        const hi =
          Math.min(end, hitLine + EDIT_CAPSULE_WINDOW_RADIUS)

        for (let line = lo; line <= hi; line++) {
          wanted.add(line)
        }
      }

      selected.push(...[...wanted].sort((a, b) => a - b))
    }

    if (selected.length < 1) continue

    // Build this scope transactionally.
    const mutationAuthorized =
      full && primaryMutationCandidate

    const block = [
      `CAPSULE_SCOPE ${scope.file}:${start}-${end} symbol=${JSON.stringify(scope.symbolName)} ` +
        `kind=${scope.symbolKind} context=${full ? "full" : "evidence_window"} ` +
        `authority=${mutationAuthorized ? "mutation" : "context"}`,
    ]

    const source = []
    let previous = null

    for (const lineNo of selected) {
      if (previous !== null && lineNo > previous + 1) {
        block.push("  … omitted …")
        source.push("… omitted …")
      }

      const text = clipLine(lines[lineNo - 1])
      const row =
        `  ${String(lineNo).padStart(5)} | ${text}`

      block.push(row)
      source.push(`${lineNo} | ${text}`)
      previous = lineNo
    }

    const blockCost = blockBytes(block)

    // Atomic scope commit: if the complete block does not fit, NONE of this
    // scope enters rendered[] or capsuleScopes[].
    if (usedBytes + blockCost > EDIT_CAPSULE_MAX_BYTES) {
      auxiliaryTruncated = true
      omittedScopesByBudget += 1
      continue
    }

    rendered.push(...block)
    usedBytes += blockCost

    capsuleScopes.push({
      file: scope.file,
      symbol_kind: scope.symbolKind,
      symbol_name: scope.symbolName,
      start_line: start,
      end_line: end,
      evidence_lines: [...(scope.hitLines ?? [])]
        .filter(Number.isInteger)
        .sort((a, b) => a - b),
      context: full ? "full" : "evidence_window",
      mutation_authorized: mutationAuthorized,
      mutation_candidate_bases:
        [...(scope.mutationCandidateBases ?? [])].sort(),
      source: source.join("\n"),
    })

    if (full) {
      fullScopes += 1
    } else {
      windowScopes += 1
    }
  }

const fileEntriesByCanonical =
    new Map(
      files
        .map((entry) => [
          canonicalMutationFile(root, entry?.file),
          entry,
        ])
        .filter(([file]) => file),
    )

  const candidateScopePool =
    capsuleScopes.filter(
      (scope) =>
        scope?.context === "full" &&
        scope?.symbol_kind !== "evidence_window" &&
        scope?.symbol_kind !== "module" &&
        scope?.symbol_name !== "<evidence>" &&
        scope?.symbol_name !== "<module>" &&
        Array.isArray(scope?.evidence_lines) &&
        scope.evidence_lines.length > 0,
    )

  const candidateScopes =
    scoutHandoff?.status === "ready"
      ? candidateScopePool.slice(0, MUTATION_CANDIDATE_MAX)
      : candidateScopePool
          .filter((scope) => scope?.mutation_authorized === true)
          .slice(0, 1)

  const mutationCandidates = []

  for (const scope of capsuleScopes) {
    scope.mutation_candidate = false
  }

  for (const scope of candidateScopes) {
    const file = canonicalMutationFile(root, scope.file)
    const fileEntry = fileEntriesByCanonical.get(file)
    const fingerprint = fileEntry?.fingerprint

    if (
      !file ||
      fingerprint?.kind !== "sha256" ||
      fingerprint?.strong !== true ||
      fingerprint?.evidence_fresh !== true ||
      typeof fingerprint?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(fingerprint.sha256) ||
      fileEntry?.changed_during_scout === true
    ) continue

    const impactRecovered =
      (scope.mutation_candidate_bases ?? [])
        .includes("validated_forward_impact_definition")

    const directStructural =
      (scope.mutation_candidate_bases ?? [])
        .includes("direct_structural_evidence")

    const exactTaskActionMatch =
      directStructural &&
      state?.taskAction?.status === "exact" &&
      state?.taskAction?.operation === "rename_symbol" &&
      state?.taskAction?.old_name === scope.symbol_name

    const evidenceAuthority =
      classifyEvidenceAuthority({
        origins: fileEntry?.origins ?? [],
        mutationCandidateBases:
          scope.mutation_candidate_bases ?? [],
        exactTaskActionMatch,
        taskCausal:
          (fileEntry?.origins ?? []).includes("task_causal"),
      })

    scope.evidence_authority = evidenceAuthority
    scope.mutation_candidate =
      evidenceAuthority.mutation_authority === true

    if (!scope.mutation_candidate) {
      scope.mutation_authorized = false
      continue
    }

    mutationCandidates.push({
      file,
      symbol_kind: scope.symbol_kind,
      symbol_name: scope.symbol_name,
      start_line: scope.start_line,
      end_line: scope.end_line,
      evidence_lines: [...scope.evidence_lines],
      source_sha256: fingerprint.sha256,
      evidence_authority: evidenceAuthority,
      structural_source:
        impactRecovered
          ? "line_owner_recovery"
          : structuralSource,
      proof_basis:
        impactRecovered
          ? "validated_forward_impact_definition"
          : "direct_structural_evidence",
    })
  }

  const strongFingerprints =
    files.length > 0 &&
    files.every(
      (file) => file.fingerprint?.strong === true,
    )

  const contextFiles = new Set(
    capsuleScopes
      .map((scope) =>
        canonicalMutationFile(root, scope.file),
      )
      .filter(Boolean),
  )

  let handoffFilesContextualized = 0

  for (const file of files) {
    const normalized =
      canonicalMutationFile(root, file.file)

    if (
      normalized !== null &&
      contextFiles.has(normalized)
    ) {
      handoffFilesContextualized += 1
    }
  }

  const allHandoffFilesContextualized =
    files.length > 0 &&
    handoffFilesContextualized === files.length

  const mutationCapableScopes =
    capsuleScopes.filter(
      (scope) =>
        scope.mutation_authorized === true &&
        scope.context === "full" &&
        scope.symbol_kind !== "evidence_window" &&
        scope.symbol_kind !== "module" &&
        scope.symbol_name !== "<evidence>" &&
        scope.symbol_name !== "<module>",
    )

  // Rendering and authorization are both single-scope contracts:
  // exactly one complete designated structural owner must survive.
  const mutationScopeComplete =
    mutationCapableScopes.length === 1

  const additiveCoverageRequirements =
    state
      ?.additiveLocalizationPlan
      ?.positive_coverage_requirements

  const additiveCoverageIdentityValid =
    state
      ?.additiveLocalizationPlan
      ?.status === "planned" &&
    additiveCoverageRequirements
      ?.status === "compiled" &&
    additiveCoverageRequirements
      ?.task_sha256 ===
      state
        ?.taskRequirements
        ?.task_sha256

  const localizationRequirements =
    additiveCoverageIdentityValid
      ? additiveCoverageRequirements
      : state?.taskRequirements

  const localizationCoverage =
    solveObligationCoverage({
      taskRequirements:
        localizationRequirements,

      evidence:
        state?.taskRoleEvidence ??
        [],
    })

  const localizationDecision =
    decideLocalization({
      taskRequirements:
        localizationRequirements,

      coveredRoles:
        localizationCoverage
          .covered_roles,

      ambiguousRoles:
        localizationCoverage
          .ambiguous_roles,

      mutationSupported:
        mutationScopeComplete &&
        mutationCandidates.length > 0,

      candidateAuthority:
        mutationCandidates.some(
          (candidate) =>
            candidate?.evidence_authority
              ?.mutation_authority === true,
        ),
    })

  const readinessBlockers = []

  if (
    localizationDecision.status !==
    LOCALIZATION_STATUS.AUTHORIZED
  ) {
    readinessBlockers.push(
      `localization_${localizationDecision.reason}`,
    )
  }

  if (!strongFingerprints) {
    readinessBlockers.push("weak_file_fingerprint")
  }

  if (!mutationScopeComplete) {
    readinessBlockers.push("mutation_scope_unavailable")
  }

  if (mutationCandidates.length < 1) {
    readinessBlockers.push("mutation_candidate_set_unavailable")
  }

  const readinessWarnings = []

  if (!allHandoffFilesContextualized) {
    readinessWarnings.push("handoff_context_incomplete")
  }

  if (auxiliaryTruncated) {
    readinessWarnings.push("capsule_budget_exhausted")
  }

  const contextComplete =
    allHandoffFilesContextualized &&
    !auxiliaryTruncated

  // Mutation authority and auxiliary model context are separate contracts.
  //
  // A complete, source-validated full structural scope may authorize the
  // bounded mutation even when some unrelated auxiliary context did not fit.
  const mutationReady =
    readinessBlockers.length === 0

  const readinessReason =
    mutationReady
      ? "scout_ready_with_mutation_scope"
      : readinessBlockers[0]

  const capsule = {
    protocol: EDIT_CAPSULE_PROTOCOL,
    render_contract: EDIT_CAPSULE_RENDER_CONTRACT,
    search_protocol: SEARCH_PROTOCOL,
    task_requirements_protocol:
      state?.taskRequirements?.protocol ?? TASK_REQUIREMENTS_PROTOCOL,
    task_requirements_status:
      state?.taskRequirements?.status ?? null,
    task_required_roles:
      state?.taskRequirements?.required_roles ?? [],
    task_required_source_families:
      state?.taskRequirements?.required_source_families ?? [],
    task_constraints:
      state?.taskRequirements?.constraints ?? [],
    scout_handoff_protocol: SCOUT_HANDOFF_PROTOCOL,
    scout_handoff: scoutHandoff.path,
    scout_handoff_status: scoutHandoff.status,
    scout_handoff_partial_reasons:
      scoutHandoff.partialReasons ?? [],
    mutation_localization_eligibility:
      mutationLocalization.reason,
    localization_requirements:
      localizationRequirements,

    localization_coverage:
      localizationCoverage,

    localization_decision:
      localizationDecision,
    generated_at_ms: nowMs(),
    mutation_ready: mutationReady,
    readiness_reason: readinessReason,
    readiness_blockers: readinessBlockers,
    readiness_warnings: readinessWarnings,
    structural_source: structuralSource,
    mutation_candidate_protocol: MUTATION_CANDIDATE_SET_PROTOCOL,
    mutation_candidate_limit: MUTATION_CANDIDATE_MAX,
    mutation_candidate_count: mutationCandidates.length,
    mutation_candidates: mutationCandidates,

    // Deterministic candidate selected before byte-budget rendering.
    // This is NOT mutation authority by itself.
    primary_mutation_candidate:
      primaryMutationScope
        ? {
            file: primaryMutationScope.file,
            symbol_kind: primaryMutationScope.symbolKind,
            symbol_name: primaryMutationScope.symbolName,
            start_line: primaryMutationScope.start,
            end_line: primaryMutationScope.end,
          }
        : null,

    // Actual post-render mutation authority.
    // Transactional rendering guarantees this scope is complete.
    authorized_mutation_scope:
      mutationCapableScopes.length === 1
        ? {
            file: mutationCapableScopes[0].file,
            symbol_kind: mutationCapableScopes[0].symbol_kind,
            symbol_name: mutationCapableScopes[0].symbol_name,
            start_line: mutationCapableScopes[0].start_line,
            end_line: mutationCapableScopes[0].end_line,
          }
        : null,

    mutation_capable_scopes: mutationCapableScopes.length,
    mutation_scope_complete: mutationScopeComplete,
    context_complete: contextComplete,
    all_handoff_files_contextualized:
      allHandoffFilesContextualized,
    handoff_files_contextualized:
      handoffFilesContextualized,
    handoff_files_total: files.length,
    auxiliary_truncated: auxiliaryTruncated,
    omitted_scopes_by_budget: omittedScopesByBudget,
    downgraded_structural_scopes:
      downgradedStructuralScopes,
    coverage:
      capsuleScopes.length > 0 &&
      fullScopes === capsuleScopes.length
        ? "full_scope"
        : fullScopes > 0
          ? "mixed"
          : "evidence_window",
    files,
    scopes: capsuleScopes,
    bytes: usedBytes,

    // Compatibility alias. This no longer means a committed scope is partial;
    // transactional rendering guarantees committed scopes are complete.
    truncated: auxiliaryTruncated,
  }
  const json = JSON.stringify(capsule, null, 2) + "\n"
  const hash = createHash("sha256").update(json).digest("hex")
  const dir = path.join(root, ".opencode", "edit-capsules")
  const key = scoutOpaqueKey(`${sessionID}:${state.turnID}:edit-capsule`)
  const finalPath = path.join(dir, `${key}.json`)
  const tempPath = `${finalPath}.${process.pid}.${nowMs()}.tmp`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tempPath, json, "utf8")
    await rename(tempPath, finalPath)
  } catch {
    await rm(tempPath, { force: true }).catch(() => {})
    return null
  }

  const rel = path.relative(root, finalPath)
  state.editCapsulePath = rel
  state.editCapsuleHash = hash
  const header =
    `EDIT_CAPSULE protocol=${EDIT_CAPSULE_PROTOCOL} mutation_ready=${mutationReady} ` +
    `context_complete=${contextComplete} coverage=${capsule.coverage} ` +
    `mutation_scopes=${mutationCapableScopes.length} scopes=${capsuleScopes.length} ` +
    `path=${rel} sha256=${hash}`
  return {
    protocol: EDIT_CAPSULE_PROTOCOL,
    path: rel,
    sha256: hash,
    mutationReady,
    readinessReason,
    readinessBlockers,
    readinessWarnings,
    structuralSource,
    mutationCandidateProtocol:
      capsule.mutation_candidate_protocol,
    mutationCandidateCount:
      capsule.mutation_candidate_count,
    mutationCandidates:
      capsule.mutation_candidates,
    scopeRecords:
      capsule.scopes,
    primaryMutationCandidate:
      capsule.primary_mutation_candidate,
    authorizedMutationScope:
      capsule.authorized_mutation_scope,
    mutationCapableScopes: mutationCapableScopes.length,
    mutationScopeComplete,
    contextComplete,
    allHandoffFilesContextualized,
    handoffFilesContextualized,
    handoffFilesTotal: files.length,
    auxiliaryTruncated,
    omittedScopesByBudget,
    downgradedStructuralScopes,
    coverage: capsule.coverage,
    scopes: capsuleScopes.length,
    bytes: usedBytes,
    truncated: auxiliaryTruncated,
    text: [header, ...rendered].join("\n"),
  }
}

async function renderFocusedSupplement(
  root,
  groups,
  maxBytes,
  hits,
  seenFacts = null,
  contextualizedHitLines = null,
) {
  const budget = Math.min(FOCUSED_SUPPLEMENT_MAX_BYTES, Math.max(0, maxBytes))
  const allCandidateScopes = focusedScopesFromGroups(groups)
  const reusableScopes = []
  const eligibleScopes = []

  for (const scope of allCandidateScopes) {
    const scopeAlreadySeen = factSeen(seenFacts, scopeFact(scope))
    const hasUncontextualizedHit = [...scope.hitLines].some(
      (line) =>
        !(contextualizedHitLines instanceof Set) ||
        !contextualizedHitLines.has(
          contextualizedHitLineKey(scope.file, line),
        ),
    )

    if (scopeAlreadySeen || !hasUncontextualizedHit) {
      reusableScopes.push(scope)
      continue
    }

    eligibleScopes.push(scope)
  }

  const scopes = eligibleScopes.slice(0, FOCUSED_MAX_SCOPES)

  if (budget < FOCUSED_MIN_SUPPLEMENT_BYTES || scopes.length < 1) {
    let reason = "supplement_budget"

    if (allCandidateScopes.length < 1) reason = "no_behavior_scope"
    else if (eligibleScopes.length < 1) reason = "scope_already_contextualized"

    return {
      body: [],
      facts: new Set(),
      bodyBytes: 0,
      complete: false,
      scopeCount: allCandidateScopes.length,
      selectedScopeCount: scopes.length,
      reusedScopeCount: reusableScopes.length,
      fullScopes: 0,
      partialScopes: 0,
      radius: null,
      coveredRangesByFile: new Map(),
      coveredHitKeys: new Set(),
      shownHitKeys: new Set(),
      contextualizedHitLines: new Set(),
      emittedLines: 0,
      reason,
    }
  }

  const cache = new Map()
  const hitLookup = hitLookupByFileLine(hits)

  async function build({ allowFull, radius }) {
    const body = []
    const facts = new Set()
    const coveredRangesByFile = new Map()
    const coveredHitKeys = new Set()
    const shownHitKeys = new Set()
    const contextualized = new Set()
    let bodyBytes = 0
    let fullScopes = 0
    let partialScopes = 0
    let emittedLines = 0

    function push(line) {
      const cost = bytes(line + "\n")
      if (bodyBytes + cost > budget) return false
      body.push(line)
      bodyBytes += cost
      return true
    }

    for (const scope of scopes) {
      const lines = await loadLines(root, scope.file, cache)
      if (!lines || lines.length < 1) {
        return { complete: false, reason: "file_unavailable" }
      }

      const start = Math.max(1, Math.min(scope.start, lines.length))
      const end = Math.max(start, Math.min(scope.end, lines.length))
      const useFull = allowFull && end - start + 1 <= FOCUSED_FULL_SCOPE_MAX_LINES
      const anchors = [...scope.anchors].slice(0, 4)
      const scopeKey = scopeFact(scope)
      const fileKey = evidenceFileKey(scope.file)
      const byLine = hitLookup.get(fileKey) ?? new Map()

      let ranges
      if (useFull) {
        ranges = [{ start, end }]
      } else {
        const headerEnd = Math.min(end, start + FOCUSED_SCOPE_HEADER_LINES - 1)
        ranges = mergeLineRanges([
          { start, end: headerEnd },
          ...[...scope.hitLines].map((line) => ({
            start: Math.max(start, line - radius),
            end: Math.min(end, line + radius),
          })),
        ])
      }

      const selectedLines = []

      for (const range of ranges) {
        for (let n = range.start; n <= range.end; n++) {
          const hit = byLine.get(n)
          const lineNovel = !factSeen(seenFacts, sourceLineFact(scope.file, n))
          const hitNovel = hit ? hitHasNovelPositiveFact(hit, seenFacts) : false

          if (lineNovel || hitNovel) selectedLines.push(n)
        }
      }

      const selectedRanges = lineNumbersToRanges(selectedLines)
      const priorLinesOmitted =
        ranges.reduce((total, range) => total + range.end - range.start + 1, 0) -
        selectedLines.length

      if (!push(
        `SCOPE_CONTEXT ${scope.file}:${start}-${end} ` +
          `symbol=${JSON.stringify(scope.symbolName)} kind=${scope.symbolKind} ` +
          `hits=${scope.hitLines.size} context=${useFull ? "full_turn" : `window±${radius}`}` +
          ` prior_lines_omitted=${Math.max(0, priorLinesOmitted)}` +
          (anchors.length > 0 ? ` anchors=${JSON.stringify(anchors)}` : ""),
      )) {
        return { complete: false, reason: "supplement_budget" }
      }

      facts.add(scopeKey)

      if (useFull) fullScopes += 1
      else partialScopes += 1

      let previousEnd = null

      for (const range of selectedRanges) {
        if (previousEnd !== null && range.start > previousEnd + 1) {
          const omitted = range.start - previousEnd - 1
          if (!push(`  … prior/unsampled scope context omitted ${omitted} lines …`)) {
            return { complete: false, reason: "supplement_budget" }
          }
        }

        for (let n = range.start; n <= range.end; n++) {
          const hit = byLine.get(n)
          let prefix = " "

          if (hit) {
            const q = [...hit.queries]
              .sort((a, b) => a - b)
              .map((x) => `Q${x + 1}`)
              .join(",")
            prefix = `>[${q}]`
          }

          if (!push(
            `  ${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`,
          )) {
            return { complete: false, reason: "supplement_budget" }
          }

          addLineRange(coveredRangesByFile, scope.file, n, n)
          facts.add(sourceLineFact(scope.file, n))
          emittedLines += 1

          if (hit) {
            coveredHitKeys.add(hit.key)
            shownHitKeys.add(hit.key)
            for (const fact of positiveFactsForHit(hit)) facts.add(fact)
          }
        }

        previousEnd = range.end
      }

      for (const [hitKey, hit] of byLine) {
        if (hit.line < start || hit.line > end) continue

        coveredHitKeys.add(hit.key)
        contextualized.add(contextualizedHitLineKey(hit.file, hit.line))
      }
    }

    for (const [file, ranges] of coveredRangesByFile) {
      coveredRangesByFile.set(file, mergeLineRanges(ranges))
    }

    return {
      body,
      facts,
      bodyBytes,
      complete: true,
      scopeCount: allCandidateScopes.length,
      selectedScopeCount: scopes.length,
      reusedScopeCount: reusableScopes.length,
      fullScopes,
      partialScopes,
      radius,
      coveredRangesByFile,
      coveredHitKeys,
      shownHitKeys,
      contextualizedHitLines: contextualized,
      emittedLines,
      reason: null,
    }
  }

  const strategies = [
    { allowFull: true, radius: FOCUSED_WINDOW_RADII[0] },
    ...FOCUSED_WINDOW_RADII.map((radius) => ({ allowFull: false, radius })),
  ]
  let fallback = null

  for (const strategy of strategies) {
    const rendered = await build(strategy)
    fallback = rendered

    if (
      rendered.complete &&
      rendered.bodyBytes >= FOCUSED_MIN_SUPPLEMENT_BYTES
    ) {
      return rendered
    }
  }

  return {
    body: fallback?.body ?? [],
    facts: fallback?.facts ?? new Set(),
    bodyBytes: fallback?.bodyBytes ?? 0,
    complete: false,
    scopeCount: allCandidateScopes.length,
    selectedScopeCount: scopes.length,
    reusedScopeCount: reusableScopes.length,
    fullScopes: fallback?.fullScopes ?? 0,
    partialScopes: fallback?.partialScopes ?? 0,
    radius: fallback?.radius ?? null,
    coveredRangesByFile: fallback?.coveredRangesByFile ?? new Map(),
    coveredHitKeys: fallback?.coveredHitKeys ?? new Set(),
    shownHitKeys: fallback?.shownHitKeys ?? new Set(),
    contextualizedHitLines: fallback?.contextualizedHitLines ?? new Set(),
    emittedLines: fallback?.emittedLines ?? 0,
    reason: fallback?.reason ?? "supplement_budget",
  }
}


function sampleScopeHitLines(scope, limit = REGION_SAMPLE_HITS_PER_SCOPE) {
  const lines = [...(scope?.hitLines ?? [])]
    .filter((line) => Number.isInteger(line) && line > 0)
    .sort((a, b) => a - b)

  if (lines.length <= limit) return lines

  const picks = [lines[0]]
  if (limit >= 3) picks.push(lines[Math.floor((lines.length - 1) / 2)])
  if (limit >= 2) picks.push(lines[lines.length - 1])

  return [...new Set(picks)].slice(0, limit).sort((a, b) => a - b)
}

async function renderRegionEvidence(root, groups, maxBytes, hits) {
  const budget = Math.min(REGION_BODY_BUDGET_BYTES, Math.max(0, maxBytes))
  const scopes = focusedScopesFromGroups(groups).slice(0, REGION_MAX_SCOPES)

  if (budget < FOCUSED_MIN_SUPPLEMENT_BYTES || scopes.length < 1) {
    return {
      body: [],
      facts: new Set(),
      bodyBytes: 0,
      complete: false,
      scopeCount: scopes.length,
      sampledScopes: 0,
      sampledHits: 0,
      retainedHits: hits?.size ?? 0,
      reason: scopes.length < 1 ? "no_behavior_scope" : "region_budget",
    }
  }

  const body = []
  const facts = new Set()
  const cache = new Map()
  const hitLookup = hitLookupByFileLine(hits)
  let bodyBytes = 0
  let sampledScopes = 0
  let sampledHits = 0
  const sampledHitKeys = new Set()

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > budget) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  for (const scope of scopes) {
    const lines = await loadLines(root, scope.file, cache)
    if (!lines || lines.length < 1) continue

    const start = Math.max(1, Math.min(scope.start, lines.length))
    const end = Math.max(start, Math.min(scope.end, lines.length))
    const samples = sampleScopeHitLines(scope)
    const q = [...scope.queries]
      .sort((a, b) => a - b)
      .map((value) => `Q${value}`)
      .join(",")
    const anchors = [...scope.anchors].slice(0, 4)

    const header =
      `REGION_CONTEXT ${scope.file}:${start}-${end} [${q}] ` +
      `symbol=${JSON.stringify(scope.symbolName)} kind=${scope.symbolKind} ` +
      `hits=${scope.hitCount} sampled_hit_lines=${samples.length}` +
      (anchors.length > 0 ? ` anchors=${JSON.stringify(anchors)}` : "")

    if (!push(header)) break
    facts.add(scopeFact(scope))

    const ranges = mergeLineRanges([
      { start, end: Math.min(end, start + FOCUSED_SCOPE_HEADER_LINES - 1) },
      ...samples.map((line) => ({
        start: Math.max(start, line - REGION_SAMPLE_RADIUS),
        end: Math.min(end, line + REGION_SAMPLE_RADIUS),
      })),
    ])

    const byLine = hitLookup.get(evidenceFileKey(scope.file)) ?? new Map()
    let previousEnd = null

    for (const range of ranges) {
      if (previousEnd !== null && range.start > previousEnd + 1) {
        if (!push(`  … sampled region context omitted ${range.start - previousEnd - 1} lines …`)) {
          return {
            body,
            facts,
            bodyBytes,
            complete: sampledScopes > 0,
            scopeCount: scopes.length,
            sampledScopes,
            sampledHits,
            retainedHits: Math.max(0, (hits?.size ?? 0) - sampledHitKeys.size),
            reason: sampledScopes > 0 ? null : "region_budget",
          }
        }
      }

      for (let n = range.start; n <= range.end; n++) {
        const hit = byLine.get(n)
        let prefix = " "

        if (hit) {
          const labels = [...hit.queries]
            .sort((a, b) => a - b)
            .map((value) => `Q${value + 1}`)
            .join(",")
          prefix = `>[${labels}]`
        }

        if (!push(
          `  ${prefix.padEnd(9)} ${String(n).padStart(5)} | ${clipLine(lines[n - 1])}`,
        )) {
          return {
            body,
            facts,
            bodyBytes,
            complete: sampledScopes > 0,
            scopeCount: scopes.length,
            sampledScopes,
            sampledHits,
            retainedHits: Math.max(0, (hits?.size ?? 0) - sampledHitKeys.size),
            reason: sampledScopes > 0 ? null : "region_budget",
          }
        }

        facts.add(sourceLineFact(scope.file, n))
        if (hit && !sampledHitKeys.has(hit.key)) {
          sampledHitKeys.add(hit.key)
          sampledHits += 1
          for (const fact of positiveFactsForHit(hit)) facts.add(fact)
        }
      }

      previousEnd = range.end
    }

    sampledScopes += 1
  }

  return {
    body,
    facts,
    bodyBytes,
    complete: sampledScopes > 0,
    scopeCount: scopes.length,
    sampledScopes,
    sampledHits,
    retainedHits: Math.max(0, (hits?.size ?? 0) - sampledHitKeys.size),
    reason: sampledScopes > 0 ? null : "no_renderable_scope",
  }
}

function querySummaryFor(results) {
  return results.map((result) => {
    let count = String(result.matches.length)
    if (result.scanCapped) count = `>=${LINE_HIT_CAP_PER_QUERY}`

    let state = "complete"
    if (result.timedOut) state = "timeout"
    else if (result.scanCapped) state = "scan_cap"
    else if (result.error) state = "error"

    const errorDetail = result.error
      ? ` error=${JSON.stringify(clipLine(result.error, 240))}`
      : ""
    const matchDetail =
      result.matchMode && result.matchMode !== "exact"
        ? ` match=${result.matchMode}`
        : ""

    return `Q${result.queryIndex + 1} probed_line_hits=${count} probe_scan=${state}${matchDetail}${errorDetail}`
  })
}

function exactSpansInResult(result) {
  return Array.isArray(result?.matches)
    ? result.matches.reduce(
        (total, match) =>
          total + (Array.isArray(match?.exactSpans) ? match.exactSpans.length : 0),
        0,
      )
    : 0
}

function normalizeIndexFacetText(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!normalized) return null
  return normalized.length <= INDEX_FACET_TEXT_MAX
    ? normalized
    : normalized.slice(0, INDEX_FACET_TEXT_MAX) + " …"
}

function indexFacetStats(result) {
  const facets = new Map()

  for (const match of result?.matches ?? []) {
    for (const rawText of match?.matchTexts ?? []) {
      const text = normalizeIndexFacetText(rawText)
      if (!text) continue

      let entry = facets.get(text)
      if (!entry) {
        entry = {
          text,
          exactMatches: 0,
          files: new Set(),
          firstFile: null,
          firstLine: null,
          sample: null,
        }
        facets.set(text, entry)
      }

      entry.exactMatches += 1
      if (typeof match?.file === "string") entry.files.add(match.file)

      const line = match?.line
      const shouldReplace =
        entry.firstFile == null ||
        String(match.file ?? "").localeCompare(String(entry.firstFile)) < 0 ||
        (match.file === entry.firstFile &&
          Number.isInteger(line) &&
          (!Number.isInteger(entry.firstLine) || line < entry.firstLine))

      if (shouldReplace) {
        entry.firstFile = match?.file ?? null
        entry.firstLine = Number.isInteger(line) ? line : null
        entry.sample = clipLine(match?.text, 120)
      }
    }
  }

  return [...facets.values()]
}

function selectIndexFacets(facets) {
  if (!Array.isArray(facets) || facets.length < 1) {
    return { dominant: null, discriminative: null }
  }

  const dominant = [...facets].sort(
    (a, b) =>
      b.exactMatches - a.exactMatches ||
      b.files.size - a.files.size ||
      a.text.localeCompare(b.text),
  )[0]

  const alternatives = facets.filter((entry) => entry !== dominant)
  const discriminative = alternatives.length
    ? [...alternatives].sort((a, b) => {
        // Repeated match text is a stronger routing signal than an accidental
        // singleton created by a wide wildcard branch. Among repeated facets,
        // prefer the smaller support: it is more discriminative, not more
        // semantically important.
        const aSingleton = a.exactMatches < 2 ? 1 : 0
        const bSingleton = b.exactMatches < 2 ? 1 : 0

        return (
          aSingleton - bSingleton ||
          a.exactMatches - b.exactMatches ||
          a.files.size - b.files.size ||
          a.text.localeCompare(b.text)
        )
      })[0]
    : null

  return { dominant, discriminative }
}

function renderSearchIndex(results, groups, bodyBudgetBytes) {
  const budget = Math.min(INDEX_BODY_BUDGET_BYTES, bodyBudgetBytes)
  const body = []
  const facts = new Set()
  let bodyBytes = 0
  let complete = true
  let sampleCount = 0
  let structuralGroupsShown = 0
  let discriminativeFacetsShown = 0
  const uniqueFiles = new Set()
  const queryEntries = []

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > budget) {
      complete = false
      return false
    }

    body.push(line)
    bodyBytes += cost
    return true
  }

  for (const result of results) {
    const byFile = new Map()

    for (const match of result.matches ?? []) {
      const file = match?.file
      if (typeof file !== "string") continue

      uniqueFiles.add(file)

      let entry = byFile.get(file)
      if (!entry) {
        entry = {
          file,
          lineHits: 0,
          exactMatches: 0,
          firstLine: match.line,
          sample: clipLine(match.text, 120),
        }
        byFile.set(file, entry)
      }

      entry.lineHits += 1
      entry.exactMatches += Array.isArray(match.exactSpans)
        ? match.exactSpans.length
        : 0

      if (
        Number.isInteger(match.line) &&
        (!Number.isInteger(entry.firstLine) || match.line < entry.firstLine)
      ) {
        entry.firstLine = match.line
        entry.sample = clipLine(match.text, 120)
      }
    }

    const exactMatches = exactSpansInResult(result)
    const facets = indexFacetStats(result)
    const selectedFacets = selectIndexFacets(facets)
    const rankedFiles = [...byFile.values()].sort(
      (a, b) =>
        b.exactMatches - a.exactMatches ||
        b.lineHits - a.lineHits ||
        a.file.localeCompare(b.file),
    )

    queryEntries.push({
      result,
      byFile,
      exactMatches,
      facets,
      selectedFacets,
      rankedFiles,
    })
  }

  // Pass 1: routing core. Every query gets visibility before any query gets
  // extra file samples. This prevents an early broad query from consuming the
  // index body budget and hiding later, narrower query evidence.
  for (const entry of queryEntries) {
    const { result, byFile, exactMatches, facets, selectedFacets } = entry
    const dominant = selectedFacets.dominant
    const discriminative = selectedFacets.discriminative

    let line =
      `Q${result.queryIndex + 1} index files=${byFile.size} ` +
      `collected_lines=${result.matches.length} exact_matches=${exactMatches}`

    if (dominant) {
      line +=
        ` dominant=${JSON.stringify(dominant.text)}` +
        `:${dominant.exactMatches}`
    }

    if (discriminative) {
      line +=
        ` route=${JSON.stringify(discriminative.text)}` +
        `:${discriminative.exactMatches}` +
        ` route_files=${discriminative.files.size}`

      if (discriminative.firstFile) {
        line += ` route_at=${discriminative.firstFile}`
        if (Number.isInteger(discriminative.firstLine)) {
          line += `:${discriminative.firstLine}`
        }
      }
    }

    if (facets.length > 0) line += ` facets=${facets.length}`

    if (!push(line)) break

    facts.add(indexSummaryFact(result, byFile.size, exactMatches))
    if (dominant) facts.add(indexFacetFact("dominant", dominant))
    if (discriminative) {
      facts.add(indexFacetFact("discriminative", discriminative))
      discriminativeFacetsShown += 1
    }
  }

  // Pass 2: bounded file details, round-robin by rank across queries.
  if (complete) {
    for (let rank = 0; rank < INDEX_MAX_FILES_PER_QUERY; rank += 1) {
      let addedAtThisRank = false

      for (const entry of queryEntries) {
        const fileEntry = entry.rankedFiles[rank]
        if (!fileEntry) continue
        addedAtThisRank = true

        const line =
          `  Q${entry.result.queryIndex + 1} ${fileEntry.file} ` +
          `lines=${fileEntry.lineHits} exact=${fileEntry.exactMatches}` +
          (Number.isInteger(fileEntry.firstLine)
            ? ` sample_line=${fileEntry.firstLine}`
            : "") +
          (fileEntry.sample
            ? ` sample=${JSON.stringify(fileEntry.sample)}`
            : "")

        if (!push(line)) break
        facts.add(indexFileFact(fileEntry))
        sampleCount += fileEntry.sample ? 1 : 0
      }

      if (!complete || !addedAtThisRank) break
    }
  }

  if (complete && Array.isArray(groups) && groups.length > 0) {
    if (push(`STRUCTURAL_MAP groups=${groups.length}`)) {
      const rankedGroups = [...groups].sort(
        (a, b) =>
          (b?.hit_count ?? 0) - (a?.hit_count ?? 0) ||
          String(a?.file ?? "").localeCompare(String(b?.file ?? "")) ||
          (a?.start_line ?? 0) - (b?.start_line ?? 0),
      )

      const shown = rankedGroups.slice(0, INDEX_MAX_STRUCTURAL_GROUPS)

      for (const group of shown) {
        const q = queryLabels(group?.queries)
        if (!q) continue

        const line =
          `  ${group.file}:${group.start_line}-${group.end_line} [${q}] ` +
          `symbol=${JSON.stringify(group.symbol_name)} ` +
          `role=${group.role} anchor=${JSON.stringify(group.anchor)} ` +
          `hits=${group.hit_count} variants=${group.variants?.length ?? 0}`

        if (!push(line)) break
        facts.add(groupFact(group))
        structuralGroupsShown += 1
      }

      if (complete && rankedGroups.length > shown.length) {
        push(`  … +${rankedGroups.length - shown.length} structural groups`)
      }
    }
  }

  return {
    body,
    facts,
    bodyBytes,
    complete,
    fileCount: uniqueFiles.size,
    sampleCount,
    structuralGroupsShown,
    discriminativeFacetsShown,
  }
}
