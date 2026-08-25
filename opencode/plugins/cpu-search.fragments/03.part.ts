
function impactWindowRange(lines, lineNo, radius = IMPACT_SCOPE_WINDOW_RADIUS) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  return {
    start: Math.max(0, center - radius),
    end: Math.min(lines.length - 1, center + radius),
  }
}

function impactPythonRange(lines, lineNo) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  const hitIndent = impactIndent(lines[center])
  const defPattern = /^\s*(?:async\s+def|def|class)\s+[A-Za-z_][A-Za-z0-9_]*\b/
  let start = -1
  let baseIndent = -1

  for (let i = center; i >= Math.max(0, center - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i]
    if (!defPattern.test(line)) continue
    const indent = impactIndent(line)
    if (indent <= hitIndent) {
      start = i
      baseIndent = indent
      break
    }
  }

  if (start < 0) return impactWindowRange(lines, lineNo)
  let end = Math.min(lines.length - 1, start + IMPACT_SCOPE_MAX_LINES - 1)
  for (let i = start + 1; i < lines.length && i <= end; i += 1) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (impactIndent(lines[i]) <= baseIndent && !/^\s*@/.test(lines[i])) {
      end = i - 1
      break
    }
  }
  return { start, end }
}

function impactBraceRange(lines, lineNo) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  let balance = 0
  let start = -1
  for (let i = center; i >= Math.max(0, center - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i]
    for (let j = line.length - 1; j >= 0; j -= 1) {
      if (line[j] === "}") balance += 1
      else if (line[j] === "{") {
        if (balance === 0) {
          start = i
          break
        }
        balance -= 1
      }
    }
    if (start >= 0) break
  }
  if (start < 0) return impactWindowRange(lines, lineNo)

  balance = 0
  let end = Math.min(lines.length - 1, start + IMPACT_SCOPE_MAX_LINES - 1)
  outer: for (let i = start; i < lines.length && i <= end; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") balance += 1
      else if (ch === "}") {
        balance -= 1
        if (balance <= 0) {
          end = i
          break outer
        }
      }
    }
  }
  return { start, end }
}

function impactRangeForLanguage(lines, lineNo, language) {
  if (language === "python") return impactPythonRange(lines, lineNo)
  if (["javascript", "typescript", "css"].includes(language)) return impactBraceRange(lines, lineNo)
  return impactWindowRange(lines, lineNo)
}

function impactMergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

async function buildImpactSeedContexts(root, probeResults) {
  const byFile = new Map()
  for (const hit of mergeHits(probeResults).values()) {
    const file = evidenceFileKey(hit.file)
    let entry = byFile.get(file)
    if (!entry) {
      entry = { file, hitLines: new Set(), fallbackText: [] }
      byFile.set(file, entry)
    }
    entry.hitLines.add(hit.line)
    entry.fallbackText.push(hit.text ?? "")
  }

  const contexts = new Map()
  await Promise.all([...byFile.values()].map(async (entry) => {
    const language = impactLanguage(entry.file)
    const resolved = path.resolve(root, entry.file)
    let lines = null
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      try {
        const source = await readFile(resolved, "utf8")
        if (bytes(source) <= MAX_CONTEXT_FILE_BYTES) lines = source.split(/\r?\n/)
      } catch {}
    }

    const ranges = []
    const chunks = []
    if (lines) {
      for (const lineNo of [...entry.hitLines].slice(0, 12)) {
        ranges.push(impactRangeForLanguage(lines, lineNo, language))
      }
      for (const range of impactMergeRanges(ranges)) {
        chunks.push(lines.slice(range.start, range.end + 1).join("\n"))
      }
    } else {
      chunks.push(...entry.fallbackText)
    }

    const mergedRanges = impactMergeRanges(ranges)
    const text = chunks.join("\n")
    contexts.set(entry.file, {
      file: entry.file,
      language,
      identifiers: impactIdentifiers(text),
      ownerSymbols: impactOwnerSymbols(lines, mergedRanges, entry.hitLines, language),
      ranges: mergedRanges,
      text,
      hitLines: entry.hitLines,
    })
  }))
  return contexts
}

function impactFilterSymbols(values, cap = IMPACT_FILTER_SYMBOL_CAP) {
  const out = []
  const seen = new Set()
  for (const value of values ?? []) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ||
      value.length > 80 ||
      seen.has(value)
    ) continue
    seen.add(value)
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

function impactSeedFilters(seedContexts) {
  return [...seedContexts.entries()].map(([seed, context]) => ({
    seed,
    forward_bindings: impactFilterSymbols(context?.identifiers),
    reverse_source_symbols: impactFilterSymbols(context?.ownerSymbols),
  }))
}

async function runTaskFilteredImpactQuery(root, seedContexts) {
  const seedFilters = impactSeedFilters(seedContexts)
  const seeds = seedFilters.map((entry) => entry.seed)
  if (seeds.length < 1) return null
  return await runImpactIndexRequest(
    root,
    {
      mode: "neighbors",
      seed_files: seeds,
      seed_filters: seedFilters,
      max_neighbors: IMPACT_INDEX_MAX_NEIGHBORS,
      check_freshness: true,
    },
    IMPACT_INDEX_QUERY_TIMEOUT_MS,
  )
}

function impactMatchedForwardSymbols(candidate, context) {
  const { local, source, pairs } = impactRelationPairs(candidate)
  const matched = []
  if (pairs.length > 0) {
    for (const pair of pairs) {
      if (context?.identifiers?.has(pair.local)) matched.push(pair.source)
    }
    return [...new Set(matched)].slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
  }
  const matchedLocals = local.filter((value) => context?.identifiers?.has(value))
  if (matchedLocals.length < 1 || source.length > 0) return []
  return impactMemberSymbols(context, matchedLocals).slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
}

function impactMatchedReverseBindings(candidate, context) {
  const { pairs } = impactRelationPairs(candidate)
  const matched = []
  for (const pair of pairs) {
    if (context?.ownerSymbols?.has(pair.source)) matched.push(pair.local)
  }
  return [...new Set(matched)].slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
}

function impactMemberSymbols(context, bindings) {
  const out = new Set()
  for (const binding of [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))]) {
    const pattern = new RegExp(`\\b${regexEscape(binding)}\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, "g")
    for (const match of context?.text?.matchAll(pattern) ?? []) {
      out.add(match[1])
      if (out.size >= IMPACT_VALIDATION_SYMBOL_CAP) return [...out]
    }
  }
  return [...out]
}

async function impactExpansionScope(root, target) {
  if (target === "." || target === "./" || target === "") return { kind: "root", root }
  const candidate = path.resolve(root, target)
  let resolved
  let info
  try {
    resolved = await realpath(candidate)
    info = await stat(resolved)
  } catch {
    return { kind: "blocked", reason: "target_unavailable" }
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return { kind: "blocked", reason: "target_outside_root" }
  if (info.isFile()) return { kind: "blocked", reason: "explicit_file_scope" }
  if (!info.isDirectory()) return { kind: "blocked", reason: "target_not_directory" }
  return { kind: "directory", root: resolved }
}

function impactFileAllowedByScope(root, file, scope) {
  if (!scope || scope.kind === "blocked") return false
  const resolved = path.resolve(root, evidenceFileKey(file))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false
  if (scope.kind === "root") return true
  return resolved === scope.root || resolved.startsWith(scope.root + path.sep)
}

function buildImpactHypotheses(impactStats, probeFiles, seedContexts, root, scope) {
  if (!impactStats?.ok || !Array.isArray(impactStats?.candidates)) return { hypotheses: [], rejectedByScope: 0 }

  const lexical = new Set((probeFiles ?? []).map((entry) => evidenceFileKey(entry.file)))
  const seedQueries = new Map((probeFiles ?? []).map((entry) => [evidenceFileKey(entry.file), new Set(entry.queries ?? [])]))
  const grouped = new Map()
  let rejectedByScope = 0

  for (const candidate of impactStats.candidates) {
    const file = evidenceFileKey(candidate?.file)
    const seed = evidenceFileKey(candidate?.seed)
    if (!file || !seed || lexical.has(file)) continue
    if (candidate?.confidence !== "exact_local") continue
    if (!impactFileAllowedByScope(root, file, scope)) continue

    const context = seedContexts.get(seed)
    if (!context) {
      rejectedByScope += 1
      continue
    }

    let forwardSymbols = []
    let reverseBindings = []
    if (candidate.direction === "forward") {
      forwardSymbols = impactMatchedForwardSymbols(candidate, context)
    } else if (candidate.direction === "reverse") {
      reverseBindings = impactMatchedReverseBindings(candidate, context)
    }

    if (forwardSymbols.length < 1 && reverseBindings.length < 1) {
      rejectedByScope += 1
      continue
    }

    const rawLocal = impactSymbolArray(candidate?.bindings)
    const rawSource = impactSymbolArray(candidate?.source_symbols)
    let entry = grouped.get(file)
    if (!entry) {
      entry = {
        file,
        queries: new Set(),
        relations: [],
        forwardSymbols: new Set(),
        reverseBindings: new Set(),
        displayBindings: new Set(),
        hasForward: false,
        hasReverse: false,
      }
      grouped.set(file, entry)
    }

    for (const queryIndex of seedQueries.get(seed) ?? []) entry.queries.add(queryIndex)
    for (const symbol of forwardSymbols) entry.forwardSymbols.add(symbol)
    for (const binding of reverseBindings) entry.reverseBindings.add(binding)
    for (const value of [...rawLocal, ...rawSource]) entry.displayBindings.add(value)
    entry.hasForward ||= candidate.direction === "forward"
    entry.hasReverse ||= candidate.direction === "reverse"
    entry.relations.push({ ...candidate, file, seed, bindings: rawLocal, source_symbols: rawSource })
  }

  const hypotheses = [...grouped.values()]
    .map((entry) => ({
      ...entry,
      forwardSymbols: [...entry.forwardSymbols].slice(0, IMPACT_VALIDATION_SYMBOL_CAP),
      reverseBindings: [...entry.reverseBindings].slice(0, IMPACT_VALIDATION_SYMBOL_CAP),
      displayBindings: [...entry.displayBindings].slice(0, IMPACT_BINDINGS_PER_CANDIDATE),
    }))
    .filter((entry) => entry.forwardSymbols.length > 0 || entry.reverseBindings.length > 0)
    .sort(
      (a, b) =>
        Number(b.hasForward) - Number(a.hasForward) ||
        b.queries.size - a.queries.size ||
        (b.forwardSymbols.length + b.reverseBindings.length) - (a.forwardSymbols.length + a.reverseBindings.length) ||
        a.file.localeCompare(b.file),
    )
    // This is the actual graph-file probe budget. We deliberately do not hide
    // extra deterministic file reads behind a larger "validation pool".
    .slice(0, IMPACT_GRAPH_PROBE_MAX_FILES)

  return { hypotheses, rejectedByScope }
}

function runImpactValidationQuery(root, file, bindings, glob) {
  return new Promise((resolve) => {
    const escaped = [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))].map(regexEscape)
    if (escaped.length < 1) {
      resolve({ ok: false, reason: "no_bindings", matches: [], scanComplete: true, elapsedMs: 0 })
      return
    }
    const pattern = escaped.length === 1 ? escaped[0] : `(?:${escaped.join("|")})`
    const args = ["--json", "--color", "never", "--max-columns", "500", "--max-columns-preview"]
    appendSearchGlobs(args, glob)
    args.push("--", pattern, file)

    const started = performance.now()
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    const matches = []
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let capped = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, pattern, matches, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, IMPACT_VALIDATION_TIMEOUT_MS)

    function consume(line) {
      if (!line.trim() || capped) return
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event?.type !== "match") return
      const matchFile = event.data?.path?.text
      const lineNo = event.data?.line_number
      if (typeof matchFile !== "string" || !Number.isInteger(lineNo)) return
      if (isReservedAgentEvidencePath(matchFile)) return
      if (matches.length >= IMPACT_VALIDATION_HIT_CAP) { capped = true; child.kill("SIGTERM"); return }
      matches.push({ file: matchFile, line: lineNo, text: event.data?.lines?.text ?? "", exactMatches: Array.isArray(event.data?.submatches) ? event.data.submatches.length : 0 })
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
      while (true) {
        const pos = stdout.indexOf("\n")
        if (pos < 0) break
        consume(stdout.slice(0, pos))
        stdout = stdout.slice(pos + 1)
      }
    })
    child.stderr.on("data", (chunk) => { if (stderr.length < 2000) stderr += chunk.toString("utf8") })
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", scanComplete: false, error: String(error?.message ?? error) }))
    child.on("close", (code) => {
      if (!capped && stdout.trim()) consume(stdout)
      if (timedOut) return finish({ ok: false, reason: "timeout", scanComplete: false, error: stderr.trim() || null })
      if (capped) return finish({ ok: true, reason: "hit_cap", scanComplete: false, error: null })
      if (code !== 0 && code !== 1) return finish({ ok: false, reason: "exit_error", scanComplete: false, error: stderr.trim() || `rg exited with status ${code}` })
      finish({ ok: true, reason: "complete", scanComplete: true, error: null })
    })
  })
}

function impactDefinitionMatch(text, bindings) {
  const line = String(text ?? "").trim()
  if (!line) return false
  for (const binding of bindings ?? []) {
    const name = regexEscape(binding)
    const patterns = [
      new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:def|class|function|interface|type|enum)\\s+${name}\\b`),
      new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`),
      new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|type|const|static)\\s+${name}\\b`),
    ]
    if (patterns.some((pattern) => pattern.test(line))) return true
  }
  return false
}

function impactLineContainsBinding(text, bindings) {
  const line = String(text ?? "")
  return [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))]
    .some((binding) => new RegExp(`\\b${regexEscape(binding)}\\b`).test(line))
}

async function validateImpactHypotheses(root, target, glob, probeFiles, probeResults) {
  const scope = await impactExpansionScope(root, target)
  const emptyStats = impactIndexShadowStats({
    attempted: false, ok: false, reason: scope.kind === "blocked" ? scope.reason : "not_queried",
    elapsedMs: 0, refreshDue: false, refreshDeferred: false, refresh: null, query: null,
  }, probeFiles)
  if (scope.kind === "blocked") {
    return {
      attempted: false, reason: scope.reason, hypotheses: [], validated: [], rejected: [], elapsedMs: 0,
      queryCount: 0, scopeRejected: 0, seedContexts: 0, ownerSymbols: 0,
      filterQueryUsed: false, filterQueryElapsedMs: null, refreshFallbackAttempted: false,
      refreshFallbackElapsedMs: null, pairwiseConditioned: true, indexStats: emptyStats,
    }
  }

  const seedContexts = await buildImpactSeedContexts(root, probeResults)
  const ownerSymbols = [...seedContexts.values()].reduce((sum, context) => sum + (context.ownerSymbols?.size ?? 0), 0)
  let filterQueryUsed = false
  let filterQueryElapsedMs = null
  let refreshFallbackAttempted = false
  let refreshFallbackElapsedMs = null
  let refresh = null

  async function queryTaskGraph(reason) {
    const query = await runTaskFilteredImpactQuery(root, seedContexts)
    filterQueryUsed = query != null
    if (query) filterQueryElapsedMs = (filterQueryElapsedMs ?? 0) + (query.elapsedMs ?? 0)
    return query ? impactStatsForTaskQuery(query, probeFiles, reason, refresh) : emptyStats
  }

  async function validateStats(stats) {
    const built = buildImpactHypotheses(stats, probeFiles, seedContexts, root, scope)
    const hypotheses = built.hypotheses
    if (hypotheses.length < 1) {
      return {
        attempted: false,
        reason: stats?.ok ? "no_scope_relevant_hypotheses" : "impact_index_unavailable",
        hypotheses: [], validated: [], rejected: [], elapsedMs: 0, queryCount: 0,
        scopeRejected: built.rejectedByScope,
      }
    }

    const started = performance.now()
    const checks = await Promise.all(hypotheses.map(async (hypothesis) => {
      const validationTerms = [...new Set([...hypothesis.forwardSymbols, ...hypothesis.reverseBindings])]
      const validation = await runImpactValidationQuery(root, hypothesis.file, validationTerms, glob)
      const matches = validation.matches ?? []
      const declarationMatches = matches.filter((match) => impactDefinitionMatch(match.text, hypothesis.forwardSymbols))
      const reverseWitnessLines = new Set(
        hypothesis.relations
          .filter((relation) => relation.direction === "reverse" && evidenceFileKey(relation.witness_file) === evidenceFileKey(hypothesis.file) && Number.isInteger(relation.witness_line))
          .map((relation) => relation.witness_line),
      )
      const reverseUsageMatches = matches.filter(
        (match) => !reverseWitnessLines.has(match.line) && impactLineContainsBinding(match.text, hypothesis.reverseBindings),
      )
      const forwardValidated = hypothesis.forwardSymbols.length > 0 && declarationMatches.length > 0
      const reverseValidated = hypothesis.reverseBindings.length > 0 && reverseUsageMatches.length > 0
      const validated = validation.ok && (forwardValidated || reverseValidated)

      return {
        ...hypothesis,
        validation,
        validated,
        validationKind: forwardValidated ? "forward_scope_definition" : reverseValidated ? "reverse_scope_usage" : null,
        declarationMatches,
        reverseUsageMatches,
      }
    }))

    const validated = checks.filter((entry) => entry.validated).sort(
      (a, b) =>
        Number(b.validationKind === "forward_scope_definition") - Number(a.validationKind === "forward_scope_definition") ||
        b.queries.size - a.queries.size || a.file.localeCompare(b.file),
    )
    return {
      attempted: true,
      reason: validated.length > 0 ? "validated_scope_conditioned" : "all_rejected",
      hypotheses,
      validated,
      rejected: checks.filter((entry) => !entry.validated),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      queryCount: checks.length,
      scopeRejected: built.rejectedByScope,
    }
  }

  let indexStats = await queryTaskGraph("impact_task_filtered")
  const initialIndexStats = {
    refreshDue: indexStats?.refreshDue === true,
    staleSeedFiles: Number(indexStats?.staleSeedFiles ?? 0),
    staleWitnessEdges: Number(indexStats?.staleWitnessEdges ?? 0),
    reason: indexStats?.reason ?? null,
    cacheAgeMs: indexStats?.cacheAgeMs ?? null,
  }
  let result = await validateStats(indexStats)

  // A stale graph is only a hypothesis. We can reuse a source-validated edge
  // when its import witness file is unchanged. If task-local routing misses and
  // the helper reports age/fingerprint staleness (or no readable cache), do one
  // synchronous refresh and one filtered retry.
  if (result.validated.length < 1 && indexStats.refreshDue === true) {
    refreshFallbackAttempted = true
    refresh = await runImpactIndexRequest(root, { mode: "refresh" }, IMPACT_INDEX_REFRESH_TIMEOUT_MS)
    refreshFallbackElapsedMs = refresh?.elapsedMs ?? null
    if (refresh?.ok === true && refresh.response?.ready === true) {
      indexStats = await queryTaskGraph("impact_refreshed_task_filtered")
      indexStats.refresh = refresh
      indexStats.refreshOk = true
      indexStats.refreshElapsedMs = refresh.elapsedMs ?? null
      result = await validateStats(indexStats)
    }
  }

  return {
    ...result,
    seedContexts: seedContexts.size,
    ownerSymbols,
    filterQueryUsed,
    filterQueryElapsedMs,
    refreshFallbackAttempted,
    refreshFallbackElapsedMs,
    initialIndexStats,
    pairwiseConditioned: true,
    indexStats,
  }
}

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

    scope.mutation_candidate = true

    mutationCandidates.push({
      file,
      symbol_kind: scope.symbol_kind,
      symbol_name: scope.symbol_name,
      start_line: scope.start_line,
      end_line: scope.end_line,
      evidence_lines: [...scope.evidence_lines],
      source_sha256: fingerprint.sha256,
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

  const readinessBlockers = []

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
    scout_handoff_protocol: SCOUT_HANDOFF_PROTOCOL,
    scout_handoff: scoutHandoff.path,
    scout_handoff_status: scoutHandoff.status,
    scout_handoff_partial_reasons:
      scoutHandoff.partialReasons ?? [],
    mutation_localization_eligibility:
      mutationLocalization.reason,
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
