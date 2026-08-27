
function buildQueryFormulationPlan(query) {
  const rawBranches = splitTopLevelRegexAlternatives(query)
  if (
    !Array.isArray(rawBranches) ||
    rawBranches.length < 1 ||
    rawBranches.length > QUERY_FORMULATION_MAX_BRANCHES
  ) {
    return null
  }

  const branches = []
  const atoms = []
  const seen = new Set()

  for (const raw of rawBranches) {
    const branchAtoms = queryFormulationAtoms(raw)

    if (
      branchAtoms.length < 1 ||
      branchAtoms.length > QUERY_FORMULATION_MAX_ATOMS_PER_BRANCH
    ) {
      return null
    }

    branches.push({ raw, atoms: branchAtoms })

    for (const atom of branchAtoms) {
      if (seen.has(atom)) continue
      seen.add(atom)
      atoms.push(atom)
      if (atoms.length > QUERY_FORMULATION_MAX_ATOMS) return null
    }
  }

  if (
    atoms.length < QUERY_FORMULATION_MIN_FILE_ATOMS ||
    !atoms.some((atom) => /[a-z]/.test(atom))
  ) {
    return null
  }

  return {
    protocol: QUERY_FORMULATION_PROTOCOL,
    branches,
    atoms,
  }
}

function queryFormulationLineHasAtom(text, atom) {
  const line = String(text ?? "").toLowerCase()
  if (!line || !atom) return false

  if (/^\d+$/.test(atom)) {
    const escaped = escapeRegexLiteral(atom)
    return new RegExp(`(?:^|\\D)${escaped}(?=\\D|$)`).test(line)
  }

  return line.includes(atom)
}

async function runQueryFormulationDiscovery(
  root,
  query,
  queryIndex,
  target,
  glob,
  plan = null,
) {
  const formulation = plan ?? buildQueryFormulationPlan(query)
  if (!formulation) return null

  const anchorQuery =
    `(?i:${formulation.atoms.map(escapeRegexLiteral).join("|")})`

  const probe = await runQuery(
    root,
    anchorQuery,
    queryIndex,
    [target],
    glob,
  )

  if (
    probe.scanComplete !== true ||
    probe.timedOut === true ||
    probe.scanCapped === true ||
    probe.error
  ) {
    return null
  }

  const atomsByFile = new Map()
  const globalObserved = new Set()

  for (const match of probe.matches ?? []) {
    const file = evidenceFileKey(match?.file)
    if (!file) continue

    let fileAtoms = atomsByFile.get(file)
    if (!fileAtoms) {
      fileAtoms = new Set()
      atomsByFile.set(file, fileAtoms)
    }

    for (const atom of formulation.atoms) {
      if (!queryFormulationLineHasAtom(match?.text, atom)) continue
      fileAtoms.add(atom)
      globalObserved.add(atom)
    }
  }

  const scoreByFile = new Map()
  const branchEvidence = []

  formulation.branches.forEach((branch, branchIndex) => {
    const sourceBackedAtoms = branch.atoms.filter((atom) =>
      globalObserved.has(atom),
    )

    if (
      sourceBackedAtoms.length < QUERY_FORMULATION_MIN_FILE_ATOMS ||
      !sourceBackedAtoms.some((atom) => /[a-z]/.test(atom))
    ) {
      return
    }

    const requiredAtoms = Math.max(
      QUERY_FORMULATION_MIN_FILE_ATOMS,
      Math.ceil(
        sourceBackedAtoms.length * QUERY_FORMULATION_MIN_COVERAGE_RATIO,
      ),
    )

    branchEvidence.push({
      branchIndex,
      sourceBackedAtoms,
      requiredAtoms,
    })

    for (const [file, observedAtoms] of atomsByFile.entries()) {
      const matchedAtoms = sourceBackedAtoms.filter((atom) =>
        observedAtoms.has(atom),
      )

      if (matchedAtoms.length < requiredAtoms) continue

      const ratio = matchedAtoms.length / sourceBackedAtoms.length
      const prior = scoreByFile.get(file) ?? {
        file,
        maxAtoms: 0,
        maxRatio: 0,
        matchedBranches: 0,
      }

      prior.maxAtoms = Math.max(prior.maxAtoms, matchedAtoms.length)
      prior.maxRatio = Math.max(prior.maxRatio, ratio)
      prior.matchedBranches += 1
      scoreByFile.set(file, prior)
    }
  })

  const ranked = [...scoreByFile.values()].sort(
    (a, b) =>
      b.maxAtoms - a.maxAtoms ||
      b.maxRatio - a.maxRatio ||
      b.matchedBranches - a.matchedBranches ||
      a.file.localeCompare(b.file),
  )

  if (
    ranked.length < 1 ||
    ranked.length > QUERY_FORMULATION_MAX_FILES
  ) {
    return null
  }

  const files = ranked.map((entry) => entry.file)
  const allowed = new Set(files)
  const matches = (probe.matches ?? [])
    .filter((match) => allowed.has(evidenceFileKey(match?.file)))
    .map((match) => ({
      ...match,
      exactSpans: [],
      matchTexts: [],
    }))

  if (matches.length < 1) return null

  const compiledProbe = {
    ...probe,
    query,
    requestedQuery: query,
    matchMode: "token_file_cooccurrence",
    matches,
  }

  return {
    query,
    requestedQuery: query,
    effectiveQuery: anchorQuery,
    cacheQuery: `token-file:${formulation.branches
      .map((branch) => branch.atoms.join("&"))
      .join("||")}`,
    queryIndex,
    files,
    timedOut: false,
    scanCapped: false,
    error: null,
    scanComplete: true,
    matchMode: "token_file_cooccurrence",
    compilerTokens: formulation.atoms,
    compiledProbe,
    queryFormulation: {
      protocol: QUERY_FORMULATION_PROTOCOL,
      branches: formulation.branches.map((branch) => branch.atoms),
      source_backed_branches: branchEvidence.map((entry) => ({
        branch_index: entry.branchIndex,
        atoms: entry.sourceBackedAtoms,
        required_atoms: entry.requiredAtoms,
      })),
      selected_files: files.length,
    },
  }
}

function queryCompilerProbeResult(
  result,
  requestedQuery,
  matchMode,
) {
  const fallback = matchMode !== "exact"

  return {
    ...result,
    query: requestedQuery,
    matchMode,
    matches: (result?.matches ?? []).map((match) => ({
      ...match,

      // A fallback hit is real source evidence, but it is NOT an exact
      // match for the model-supplied regex. Never allow it to masquerade
      // as exact structural replacement evidence.
      exactSpans: fallback ? [] : (match.exactSpans ?? []),
      matchTexts: fallback ? [] : (match.matchTexts ?? []),
    })),
  }
}

function restrictProbeResultToTargets(result, targets) {
  const allowed = new Set(
    (targets ?? []).map((file) => evidenceFileKey(file)),
  )

  return {
    ...result,
    matches: (result?.matches ?? []).filter((match) =>
      allowed.has(evidenceFileKey(match.file)),
    ),
  }
}

async function runCompiledDiscovery(
  root,
  query,
  queryIndex,
  target,
  glob,
) {
  const exact = await runFileDiscovery(
    root,
    query,
    queryIndex,
    target,
    glob,
  )

  const exactResult = {
    ...exact,
    query,
    requestedQuery: query,
    effectiveQuery: query,
    cacheQuery: `exact:${query}`,
    matchMode: "exact",
    compilerTokens: [],
    compiledProbe: null,
  }

  const exactCompleteZero =
    exact.scanComplete === true &&
    exact.timedOut !== true &&
    exact.scanCapped !== true &&
    !exact.error &&
    (exact.files?.length ?? 0) === 0

  if (
    !exactCompleteZero ||
    !queryCompilerEligible(query)
  ) {
    return exactResult
  }

  // Stage 1: preserve regex semantics and only relax case.
  const foldedQuery = queryCompilerCasefoldRegex(query)

  const folded = await runFileDiscovery(
    root,
    foldedQuery,
    queryIndex,
    target,
    glob,
  )

  if ((folded.files?.length ?? 0) > 0) {
    return {
      ...folded,
      query,
      requestedQuery: query,
      effectiveQuery: foldedQuery,
      cacheQuery: `casefold:${foldedQuery}`,
      matchMode: "casefold",
      compilerTokens: queryCompilerTokens(query),
      compiledProbe: null,
    }
  }

  // Do not build stronger routing claims on top of an incomplete fallback.
  const foldedCompleteZero =
    folded.scanComplete === true &&
    folded.timedOut !== true &&
    folded.scanCapped !== true &&
    !folded.error &&
    (folded.files?.length ?? 0) === 0

  if (!foldedCompleteZero) {
    return exactResult
  }

  const formulationPlan = buildQueryFormulationPlan(query)

  // Stage 2a: top-level alternation is usually a set of independent search
  // hypotheses. Requiring every token from every alternative on one line is
  // structurally impossible, so try bounded same-file co-occurrence first.
  if ((formulationPlan?.branches?.length ?? 0) > 1) {
    const formulated = await runQueryFormulationDiscovery(
      root,
      query,
      queryIndex,
      target,
      glob,
      formulationPlan,
    )
    if (formulated) return formulated
  }

  // Stage 2b: order-independent recovery, but only when ALL significant
  // query tokens occur on the SAME physical source line.
  //
  // One longest token is used as a cheap rg anchor; JS then validates
  // complete co-occurrence. This avoids permutations/lookaheads and keeps
  // the operation bounded to one additional rg scan.
  const tokens = queryCompilerTokens(query)

  if (tokens.length < QUERY_COMPILER_MIN_TOKENS) {
    return exactResult
  }

  const anchorToken = queryCompilerAnchorToken(tokens)
  if (!anchorToken) return exactResult

  const anchorQuery =
    `(?i:${escapeRegexLiteral(anchorToken)})`

  const anchorProbe = await runQuery(
    root,
    anchorQuery,
    queryIndex,
    [target],
    glob,
  )

  if (
    anchorProbe.scanComplete !== true ||
    anchorProbe.timedOut === true ||
    anchorProbe.scanCapped === true ||
    anchorProbe.error
  ) {
    return exactResult
  }

  const matches = (anchorProbe.matches ?? [])
    .filter((match) => {
      const line = String(match?.text ?? "").toLowerCase()
      return tokens.every((token) => line.includes(token))
    })
    .map((match) => ({
      ...match,
      exactSpans: [],
      matchTexts: [],
    }))

  if (matches.length < 1) {
    const formulated = await runQueryFormulationDiscovery(
      root,
      query,
      queryIndex,
      target,
      glob,
      formulationPlan,
    )
    return formulated ?? exactResult
  }

  const files = [
    ...new Set(
      matches
        .map((match) => match.file)
        .filter((file) => typeof file === "string" && file.length > 0),
    ),
  ]

  const compiledProbe = {
    ...anchorProbe,
    query,
    requestedQuery: query,
    matchMode: "token_line_cooccurrence",
    matches,
  }

  return {
    query,
    requestedQuery: query,
    effectiveQuery: anchorQuery,
    cacheQuery: `token-line:${tokens.join("|")}`,
    queryIndex,
    files,
    timedOut: false,
    scanCapped: false,
    error: null,
    scanComplete: true,
    matchMode: "token_line_cooccurrence",
    compilerTokens: tokens,
    compiledProbe,
  }
}

function pathAffinity(file, queryIndices, queryTokensByIndex) {
  const normalized = evidenceFileKey(file).toLowerCase()
  const base = path.posix.basename(normalized)
  const stem = base.replace(/\.[^.]+$/, "")
  let score = 0

  for (const queryIndex of queryIndices ?? []) {
    for (const token of queryTokensByIndex.get(queryIndex) ?? []) {
      if (stem === token) score += 4
      else if (stem.includes(token)) score += 2
      else if (normalized.includes(token)) score += 1
    }
  }

  return score
}

function rankDiscoveredFiles(discoveryResults) {
  const byFile = new Map()
  const queryFileCounts = new Map()
  const queryTokensByIndex = new Map(
    (discoveryResults ?? []).map((result) => [
      result.queryIndex,
      queryPathTokens(result.query),
    ]),
  )

  for (const result of discoveryResults ?? []) {
    const unique = [...new Set(result?.files ?? [])]
    queryFileCounts.set(result.queryIndex, unique.length)

    for (const file of unique) {
      let entry = byFile.get(file)

      if (!entry) {
        entry = {
          file,
          queries: new Set(),
          coverage: 0,
          pathAffinity: 0,
          rarity: 0,
        }
        byFile.set(file, entry)
      }

      entry.queries.add(result.queryIndex)
    }
  }

  for (const entry of byFile.values()) {
    entry.coverage = entry.queries.size
    entry.pathAffinity = pathAffinity(
      entry.file,
      entry.queries,
      queryTokensByIndex,
    )
    entry.rarity = [...entry.queries].reduce((score, queryIndex) => {
      const count = Math.max(1, queryFileCounts.get(queryIndex) ?? 1)
      return score + 1 / count
    }, 0)
  }

  // Relevance stays separate from fairness.
  //
  // Query specificity is intentionally only a tertiary tie-break:
  //
  //   coverage > path affinity > provenance specificity > stable path
  //
  // Therefore a weak rare query can never outrank stronger multi-query
  // coverage or a better path match. It only replaces the previous
  // arbitrary filename tie-break when lexical evidence is otherwise equal.
  //
  // The signal is free: discovery already measured the number of files
  // matched by every query, so this adds no repository scan or model call.
  return [...byFile.values()].sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.pathAffinity - a.pathAffinity ||
      b.rarity - a.rarity ||
      a.file.localeCompare(b.file),
  )
}



function semanticResolverBinary() {
  const override = process.env.OPENCODE_SEMANTIC_RESOLVER
  if (typeof override === "string" && override.length > 0) {
    return override
  }

  const dir = runtimeStackDirectory()
  if (!dir) return null

  return path.join(dir, "opencode-semantic-resolver")
}

function semanticLanguageForFile(file) {
  const lower = String(file ?? "").toLowerCase()

  if (lower.endsWith(".py") || lower.endsWith(".pyi")) {
    return "python"
  }

  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "typescript"
  }

  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "javascript"
  }

  return null
}

function semanticExpectedImpactTarget(relation) {
  if (relation?.direction === "forward") {
    return evidenceFileKey(relation?.file)
  }

  if (relation?.direction === "reverse") {
    return evidenceFileKey(relation?.seed)
  }

  return ""
}

function semanticSpecCursorOffset(spec) {
  const value = String(spec ?? "")
  if (!value) return 0

  const slash = Math.max(
    value.lastIndexOf("/"),
    value.lastIndexOf("\\"),
  )

  if (slash >= 0 && slash + 1 < value.length) {
    return slash + 1
  }

  const dot = value.lastIndexOf(".")
  if (dot >= 0 && dot + 1 < value.length) {
    return dot + 1
  }

  return 0
}

function semanticLineWindow(text, oneBasedLine, maxLines) {
  if (
    !Number.isInteger(oneBasedLine) ||
    oneBasedLine < 1 ||
    !Number.isInteger(maxLines) ||
    maxLines < 1
  ) {
    return null
  }

  let line = 1
  let start = 0

  while (line < oneBasedLine) {
    const next = text.indexOf("\n", start)
    if (next < 0) return null
    start = next + 1
    line += 1
  }

  let end = start

  for (let index = 0; index < maxLines; index += 1) {
    const next = text.indexOf("\n", end)
    if (next < 0) {
      end = text.length
      break
    }

    end = next + 1
  }

  return { start, end }
}

async function semanticImpactQueryForRelation(
  root,
  relation,
  id,
) {
  const witnessFile = evidenceFileKey(relation?.witness_file)
  const expectedFile = semanticExpectedImpactTarget(relation)
  const spec =
    typeof relation?.spec === "string"
      ? relation.spec
      : ""
  const witnessLine = relation?.witness_line
  const language = semanticLanguageForFile(witnessFile)

  if (
    !witnessFile ||
    !expectedFile ||
    !spec ||
    !language ||
    !Number.isInteger(witnessLine) ||
    witnessLine < 1
  ) {
    return {
      ok: false,
      reason: "unsupported_relation",
    }
  }

  const resolved = path.resolve(root, witnessFile)

  if (
    resolved !== root &&
    !resolved.startsWith(root + path.sep)
  ) {
    return {
      ok: false,
      reason: "witness_outside_root",
    }
  }

  let canonical
  let info
  let source

  try {
    canonical = await realpath(resolved)

    if (
      canonical !== root &&
      !canonical.startsWith(root + path.sep)
    ) {
      return {
        ok: false,
        reason: "witness_realpath_outside_root",
      }
    }

    info = await stat(canonical)

    if (
      !info.isFile() ||
      info.size > MAX_CONTEXT_FILE_BYTES
    ) {
      return {
        ok: false,
        reason: "witness_file_budget",
      }
    }

    source = await readFile(canonical, "utf8")
  } catch {
    return {
      ok: false,
      reason: "witness_unavailable",
    }
  }

  const window = semanticLineWindow(
    source,
    witnessLine,
    SEMANTIC_IMPACT_WITNESS_WINDOW_LINES,
  )

  if (!window) {
    return {
      ok: false,
      reason: "witness_line_invalid",
    }
  }

  const fragment = source.slice(window.start, window.end)
  const occurrences = []

  let cursor = 0

  while (true) {
    const found = fragment.indexOf(spec, cursor)
    if (found < 0) break

    occurrences.push(found)

    if (occurrences.length > 1) break

    cursor = found + Math.max(1, spec.length)
  }

  if (occurrences.length !== 1) {
    return {
      ok: false,
      reason:
        occurrences.length === 0
          ? "module_spec_not_found"
          : "module_spec_ambiguous",
    }
  }

  const charOffset =
    window.start +
    occurrences[0] +
    semanticSpecCursorOffset(spec)

  const byteOffset =
    Buffer.byteLength(
      source.slice(0, charOffset),
      "utf8",
    )

  return {
    ok: true,
    language,
    expectedFile,
    relation: {
      file: evidenceFileKey(relation?.file),
      seed: evidenceFileKey(relation?.seed),
      direction: relation?.direction ?? null,
      witness_file: witnessFile,
      witness_line: witnessLine,
      spec,
    },
    query: {
      id,
      operation: "definition",
      file: witnessFile,
      byte_offset: byteOffset,
      max_results: SEMANTIC_IMPACT_MAX_RESULTS,
    },
  }
}

function runSemanticResolverBatch(
  root,
  language,
  planned,
) {
  return new Promise((resolve) => {
    const binary = semanticResolverBinary()

    if (!binary) {
      resolve({
        ok: false,
        reason: "binary_unavailable",
        language,
        elapsedMs: 0,
      })
      return
    }

    const started = performance.now()

    let child

    try {
      child = spawn(binary, [], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      resolve({
        ok: false,
        reason: "spawn_error",
        language,
        elapsedMs:
          Math.round(
            (performance.now() - started) * 100,
          ) / 100,
      })
      return
    }

    let stdout = []
    let stdoutBytes = 0
    let stderr = ""
    let timedOut = false
    let outputLimited = false
    let settled = false

    const elapsed = () =>
      Math.round(
        (performance.now() - started) * 100,
      ) / 100

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, SEMANTIC_RESOLVER_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (
        stdoutBytes >
        SEMANTIC_RESOLVER_MAX_STDOUT_BYTES
      ) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }

      stdout.push(Buffer.from(chunk))
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString("utf8")
      }
    })

    child.on("error", () => {
      finish({
        ok: false,
        reason: "spawn_error",
        language,
        elapsedMs: elapsed(),
      })
    })

    child.on("close", (code) => {
      if (timedOut) {
        finish({
          ok: false,
          reason: "timeout",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      if (outputLimited) {
        finish({
          ok: false,
          reason: "stdout_limit",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      if (code !== 0) {
        finish({
          ok: false,
          reason: "exit_error",
          language,
          elapsedMs: elapsed(),
          error: stderr.trim() || null,
        })
        return
      }

      let response

      try {
        response = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        )
      } catch {
        finish({
          ok: false,
          reason: "invalid_json",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      const expectedIds =
        new Set(
          planned.map((entry) => entry.query.id),
        )

      const results = response?.results

      const ids =
        Array.isArray(results)
          ? results.map((entry) => entry?.id)
          : []

      const validIds =
        ids.length === expectedIds.size &&
        new Set(ids).size === ids.length &&
        ids.every((id) => expectedIds.has(id))

      if (
        response?.protocol !== SEMANTIC_RESOLVER_PROTOCOL ||
        response?.authority !== SEMANTIC_RESOLVER_AUTHORITY ||
        typeof response?.engine !== "string" ||
        !response.engine ||
        !Array.isArray(results) ||
        !validIds
      ) {
        finish({
          ok: false,
          reason: "response_contract_invalid",
          language,
          elapsedMs: elapsed(),
        })
        return
      }

      finish({
        ok: true,
        reason: "resolved",
        language,
        engine: response.engine,
        elapsedMs: elapsed(),
        response,
      })
    })

    const request = {
      protocol: SEMANTIC_RESOLVER_PROTOCOL,
      root,
      language,
      queries:
        planned.map((entry) => entry.query),
    }

    child.stdin.end(
      JSON.stringify(request),
      "utf8",
    )
  })
}

async function runSemanticImpactShadow(
  root,
  validatedImpact,
) {
  const sourceValidated =
    Array.isArray(validatedImpact)
      ? validatedImpact
      : []

  if (sourceValidated.length < 1) {
    return {
      attempted: false,
      ok: true,
      reason: "no_source_validated_impact",
      elapsedMs: 0,
      queries: 0,
      confirmed: 0,
      contradicted: 0,
      ambiguous: 0,
      unresolved: 0,
      unavailable: 0,
      skipped: 0,
      engines: [],
      outcomes: [],
    }
  }

  const started = performance.now()
  const planned = []
  const seen = new Set()
  let skipped = 0

  outer:
  for (const hypothesis of sourceValidated) {
    for (const relation of hypothesis?.relations ?? []) {
      if (planned.length >= SEMANTIC_IMPACT_MAX_QUERIES) {
        break outer
      }

      const expectedFile =
        semanticExpectedImpactTarget(relation)

      const key = [
        evidenceFileKey(relation?.witness_file),
        relation?.witness_line,
        relation?.spec,
        expectedFile,
      ].join("\0")

      if (seen.has(key)) continue
      seen.add(key)

      const entry =
        await semanticImpactQueryForRelation(
          root,
          relation,
          `impact-semantic-${planned.length + 1}`,
        )

      if (!entry.ok) {
        skipped += 1
        continue
      }

      planned.push(entry)
    }
  }

  if (planned.length < 1) {
    return {
      attempted: false,
      ok: true,
      reason: "no_supported_semantic_witnesses",
      elapsedMs:
        Math.round(
          (performance.now() - started) * 100,
        ) / 100,
      queries: 0,
      confirmed: 0,
      contradicted: 0,
      ambiguous: 0,
      unresolved: 0,
      unavailable: 0,
      skipped,
      engines: [],
      outcomes: [],
    }
  }

  const byLanguage = new Map()

  for (const entry of planned) {
    const batch =
      byLanguage.get(entry.language) ?? []
    batch.push(entry)
    byLanguage.set(entry.language, batch)
  }

  const batches =
    await Promise.all(
      [...byLanguage.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([language, entries]) =>
          runSemanticResolverBatch(
            root,
            language,
            entries,
          ),
        ),
    )

  const batchByLanguage =
    new Map(
      batches.map((batch) => [
        batch.language,
        batch,
      ]),
    )

  const outcomes = []

  for (const plan of planned) {
    const batch =
      batchByLanguage.get(plan.language)

    if (!batch?.ok) {
      outcomes.push({
        verdict: "unavailable",
        expected_file: plan.expectedFile,
        actual_file: null,
        engine: null,
        reason:
          batch?.reason ??
          "batch_unavailable",
        ...plan.relation,
      })
      continue
    }

    const result =
      batch.response.results.find(
        (entry) =>
          entry?.id === plan.query.id,
      )

    if (!result) {
      outcomes.push({
        verdict: "unavailable",
        expected_file: plan.expectedFile,
        actual_file: null,
        engine: batch.engine,
        reason: "result_missing",
        ...plan.relation,
      })
      continue
    }

    const locations =
      Array.isArray(result?.locations)
        ? result.locations
        : []

    let verdict = "unresolved"
    let actualFile = null
    let reason = result?.status ?? "unknown"

    if (
      result?.status === "resolved" &&
      result?.bounded_complete === true &&
      locations.length === 1
    ) {
      actualFile =
        evidenceFileKey(locations[0]?.file)

      verdict =
        actualFile === plan.expectedFile
          ? "confirmed"
          : "contradicted"

      reason =
        verdict === "confirmed"
          ? "semantic_target_match"
          : "semantic_target_mismatch"
    } else if (
      result?.status === "ambiguous" ||
      result?.bounded_complete !== true ||
      locations.length > 1
    ) {
      verdict = "ambiguous"
      reason = "semantic_result_ambiguous"
    } else if (
      result?.status === "unsupported" ||
      result?.status === "error"
    ) {
      verdict = "unavailable"
    }

    outcomes.push({
      verdict,
      expected_file: plan.expectedFile,
      actual_file: actualFile,
      engine: batch.engine,
      reason,
      ...plan.relation,
    })
  }

  const count = (verdict) =>
    outcomes.filter(
      (entry) => entry.verdict === verdict,
    ).length

  const confirmed = count("confirmed")
  const contradicted = count("contradicted")
  const ambiguous = count("ambiguous")
  const unresolved = count("unresolved")
  const unavailable = count("unavailable")
  const allBatchesOk =
    batches.every((batch) => batch.ok)

  return {
    attempted: true,
    ok: allBatchesOk,
    reason:
      !allBatchesOk
        ? "resolver_partial"
        : contradicted > 0
          ? "semantic_contradictions_observed"
          : confirmed > 0
            ? "semantic_confirmations_observed"
            : "semantic_no_confirmation",
    elapsedMs:
      Math.round(
        (performance.now() - started) * 100,
      ) / 100,
    queries: planned.length,
    confirmed,
    contradicted,
    ambiguous,
    unresolved,
    unavailable,
    skipped,
    engines:
      [...new Set(
        batches
          .map((batch) => batch.engine)
          .filter(Boolean),
      )].sort(),
    outcomes: outcomes.slice(
      0,
      SEMANTIC_IMPACT_MAX_QUERIES,
    ),
  }
}

function retrievalRankerBinary() {
  const override = process.env.OPENCODE_RETRIEVAL_RANKER
  if (typeof override === "string" && override.length > 0) {
    return override
  }

  const dir = runtimeStackDirectory()
  if (!dir) return null

  return path.join(dir, "opencode-retrieval-ranker")
}

function retrievalRankerQuery(queries) {
  /*
   * Reuse the already-proven lexical tokenization used by Scout path
   * relevance. Do not pass regex punctuation into BM25F.
   *
   * Preserve first-seen order so identical search input is reproducible.
   */
  const terms = []
  const seen = new Set()

  for (const query of queries ?? []) {
    for (const term of queryPathTokens(query)) {
      if (seen.has(term)) continue
      seen.add(term)
      terms.push(term)

      if (terms.length >= 32) {
        return terms.join(" ")
      }
    }
  }

  return terms.join(" ")
}

function retrievalRankerFallback(
  rankedFiles,
  reason,
  extra = {},
) {
  return {
    attempted: extra.attempted === true,
    ok: false,
    reason,
    elapsedMs:
      Number.isFinite(extra.elapsedMs)
        ? extra.elapsedMs
        : 0,
    inputFiles:
      Number.isInteger(extra.inputFiles)
        ? extra.inputFiles
        : 0,
    outputFiles: 0,
    degradedFiles: 0,
    errorFiles: 0,
    rankedFiles,
  }
}

function validateRetrievalRankerResponse(
  response,
  candidates,
) {
  if (
    response?.protocol !== RETRIEVAL_RANKER_PROTOCOL ||
    response?.authority !== RETRIEVAL_RANKER_AUTHORITY ||
    !Array.isArray(response?.results)
  ) {
    return {
      ok: false,
      reason: "response_contract_invalid",
    }
  }

  const allowed = new Set(
    candidates.map((entry) =>
      evidenceFileKey(entry.file),
    ),
  )

  const seen = new Set()

  for (
    let index = 0;
    index < response.results.length;
    index += 1
  ) {
    const result = response.results[index]
    const file = evidenceFileKey(result?.file)

    if (
      !file ||
      !allowed.has(file) ||
      seen.has(file) ||
      result?.rank !== index + 1 ||
      !Number.isFinite(result?.rrf_score) ||
      !Number.isFinite(result?.bm25f_score)
    ) {
      return {
        ok: false,
        reason: "result_contract_invalid",
      }
    }

    seen.add(file)
  }

  return {
    ok: true,
    reason: "ranked",
  }
}

function runRetrievalRanker(
  root,
  queries,
  lexicalRankedFiles,
) {
  return new Promise((resolve) => {
    const query = retrievalRankerQuery(queries)

    const candidates =
      (lexicalRankedFiles ?? [])
        .slice(0, RETRIEVAL_RANKER_MAX_FILES)

    if (candidates.length < 2) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "not_needed",
        ),
      )
      return
    }

    if (!query) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "no_query_terms",
        ),
      )
      return
    }

    const binary = retrievalRankerBinary()

    if (!binary) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "binary_unavailable",
        ),
      )
      return
    }

    const started = performance.now()

    let child

    try {
      child = spawn(binary, [], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      resolve(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "spawn_error",
          {
            attempted: true,
            inputFiles: candidates.length,
            elapsedMs:
              Math.round(
                (performance.now() - started) * 100,
              ) / 100,
          },
        ),
      )
      return
    }

    let stdout = []
    let stdoutBytes = 0
    let stderr = ""
    let timedOut = false
    let outputLimited = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const elapsed = () =>
      Math.round(
        (performance.now() - started) * 100,
      ) / 100

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, RETRIEVAL_RANKER_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (
        stdoutBytes >
        RETRIEVAL_RANKER_MAX_STDOUT_BYTES
      ) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }

      stdout.push(Buffer.from(chunk))
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString("utf8")
      }
    })

    child.on("error", () => {
      finish(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "spawn_error",
          {
            attempted: true,
            inputFiles: candidates.length,
            elapsedMs: elapsed(),
          },
        ),
      )
    })

    child.on("close", (code) => {
      if (settled) return

      if (timedOut) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "timeout",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      if (outputLimited) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "stdout_limit",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      if (code !== 0) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "nonzero_exit",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      let response

      try {
        response = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        )
      } catch {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            "invalid_json",
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      const contract =
        validateRetrievalRankerResponse(
          response,
          candidates,
        )

      if (!contract.ok) {
        finish(
          retrievalRankerFallback(
            lexicalRankedFiles,
            contract.reason,
            {
              attempted: true,
              inputFiles: candidates.length,
              elapsedMs: elapsed(),
            },
          ),
        )
        return
      }

      const originalByFile = new Map(
        candidates.map((entry, index) => [
          evidenceFileKey(entry.file),
          {
            entry,
            lexicalRank: index + 1,
          },
        ]),
      )

      const reranked = []
      const rerankedKeys = new Set()

      for (const result of response.results) {
        const key = evidenceFileKey(result.file)
        const original = originalByFile.get(key)

        if (!original) continue

        reranked.push({
          ...original.entry,

          // Routing telemetry only. These fields are never mutation
          // authority and are not consumed as semantic evidence.
          retrievalRank: result.rank,
          retrievalRrfScore:
            result.rrf_score,
          retrievalBm25fScore:
            result.bm25f_score,
          retrievalLexicalRank:
            result.exact_rank ?? original.lexicalRank,
          retrievalBm25Rank:
            result.bm25_rank ?? null,
          retrievalStructuralComplete:
            result.structural_complete === true,
        })

        rerankedKeys.add(key)
      }

      /*
       * A candidate rejected by the ranker (for example >2 MiB) is not
       * declared irrelevant. Keep it in the candidate universe in its
       * original relative order after the successfully reranked prefix.
       */
      for (const entry of candidates) {
        const key = evidenceFileKey(entry.file)
        if (!rerankedKeys.has(key)) {
          reranked.push(entry)
        }
      }

      // Files outside the bounded rerank prefix retain original order.
      const tail =
        lexicalRankedFiles.slice(candidates.length)

      finish({
        attempted: true,
        ok: true,
        reason:
          (response.errors?.length ?? 0) > 0
            ? "ranked_partial"
            : "ranked",
        elapsedMs: elapsed(),
        inputFiles: candidates.length,
        outputFiles: response.results.length,
        degradedFiles:
          Array.isArray(response.degraded_files)
            ? response.degraded_files.length
            : 0,
        errorFiles:
          Array.isArray(response.errors)
            ? response.errors.length
            : 0,
        rankedFiles: [
          ...reranked,
          ...tail,
        ],
      })
    })

    try {
      child.stdin.end(
        JSON.stringify({
          root,
          query,
          files: candidates.map(
            (entry, index) => ({
              file: evidenceFileKey(entry.file),

              // retrieval-ranker-v1 calls this exact_rank. In live Scout
              // this is the deterministic lexical relevance rank.
              exact_rank: index + 1,
            }),
          ),
          max_results:
            RETRIEVAL_RANKER_MAX_FILES,
        }),
      )
    } catch {
      child.kill("SIGKILL")

      finish(
        retrievalRankerFallback(
          lexicalRankedFiles,
          "stdin_error",
          {
            attempted: true,
            inputFiles: candidates.length,
            elapsedMs: elapsed(),
          },
        ),
      )
    }
  })
}

function selectFairFiles(rankedFiles, queryResults, limit) {
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
    .sort(
      (a, b) =>
        a.files.length - b.files.length || a.queryIndex - b.queryIndex,
    )

  // Fairness is a reservation rule, not a relevance score. Reserve one direct
  // candidate for every non-empty query first, then fill the remaining slots
  // from the caller-provided relevance order.
  for (const result of activeQueries) {
    if (selected.size >= limit) break
    if (coveredQueries.has(result.queryIndex)) continue

    const fileKeys = new Set(result.files.map((file) => evidenceFileKey(file)))
    const candidate = rankedFiles.find(
      (entry) =>
        fileKeys.has(evidenceFileKey(entry.file)) &&
        !selected.has(entry.file),
    )

    if (candidate) {
      selected.add(candidate.file)
      for (const queryIndex of candidate.queries ?? []) {
        coveredQueries.add(queryIndex)
      }
    }
  }

  for (const entry of rankedFiles) {
    if (selected.size >= limit) break
    if (selected.has(entry.file)) continue
    selected.add(entry.file)
    for (const queryIndex of entry.queries ?? []) coveredQueries.add(queryIndex)
  }

  return rankedFiles.filter((entry) => selected.has(entry.file))
}

function selectProbeFiles(rankedFiles, discoveryResults) {
  return selectFairFiles(rankedFiles, discoveryResults, PROBE_MAX_FILES)
}

function declarationHint(text) {
  const line = String(text ?? "").trim()
  if (!line) return 0

  return /^(?:export\s+)?(?:async\s+)?(?:def|class|function|interface|type|enum|struct|trait|fn)\b/.test(
    line,
  )
    ? 1
    : 0
}

function rankProbedFiles(rankedFiles, probeResults) {
  const byFile = new Map(
    (rankedFiles ?? []).map((entry, index) => [
      evidenceFileKey(entry.file),
      {
        ...entry,
        initialRank: index + 1,
        probeLineHits: 0,
        probeExactMatches: 0,
        probeDefinitionHints: 0,
      },
    ]),
  )

  for (const result of probeResults ?? []) {
    for (const match of result?.matches ?? []) {
      const entry = byFile.get(evidenceFileKey(match.file))
      if (!entry) continue

      entry.probeLineHits += 1
      entry.probeExactMatches += Array.isArray(match.exactSpans)
        ? match.exactSpans.length
        : 0
      entry.probeDefinitionHints += declarationHint(match.text)
    }
  }

  // Probe evidence is deliberately weak. Coverage/path still dominate. The
  // extra line scan only breaks otherwise-ambiguous candidates using a bounded
  // definition hint and a capped exact-match signal; raw hit volume can never
  // grow without bound into a relevance score.
  return [...byFile.values()].sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.pathAffinity - a.pathAffinity ||
      b.probeDefinitionHints - a.probeDefinitionHints ||
      Math.min(PROBE_MATCH_SIGNAL_CAP, b.probeExactMatches) -
        Math.min(PROBE_MATCH_SIGNAL_CAP, a.probeExactMatches) ||
      a.initialRank - b.initialRank ||
      a.file.localeCompare(b.file),
  )
}

function selectEmitFiles(probedFiles, discoveryResults) {
  return selectFairFiles(probedFiles, discoveryResults, EMIT_MAX_FILES)
}

function filterQueryResultsToFiles(results, selectedFiles) {
  const allowed = new Set(
    (selectedFiles ?? []).map((entry) => evidenceFileKey(entry.file)),
  )

  return (results ?? []).map((result) => ({
    ...result,
    matches: (result.matches ?? []).filter((match) =>
      allowed.has(evidenceFileKey(match.file)),
    ),
  }))
}

function discoverySummaryFor(results) {
  return (results ?? []).map((result) => {
    let count = String(result.files?.length ?? 0)
    if (result.scanCapped) count = `>=${FILE_DISCOVERY_CAP_PER_QUERY}`

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

    return `Q${result.queryIndex + 1} files=${count} discovery=${state}${matchDetail}${errorDetail}`
  })
}

function renderRouteMap(rankedFiles, selectedFiles, bodyBudgetBytes) {
  const budget = Math.min(ROUTE_BODY_BUDGET_BYTES, bodyBudgetBytes)
  const body = []
  let bodyBytes = 0

  function push(line) {
    const cost = bytes(line + "\n")
    if (bodyBytes + cost > budget) return false
    body.push(line)
    bodyBytes += cost
    return true
  }

  const lexicalSelected = (selectedFiles ?? []).filter((entry) => entry?.origin !== "impact")
  const retained = Math.max(0, rankedFiles.length - lexicalSelected.length)
  push(`ROUTE emitted=${selectedFiles.length} retained=${retained}`)

  for (const entry of selectedFiles) {
    if (entry?.origin === "impact") {
      const binding = (entry.impact?.bindings ?? []).join(",") || "-"
      const via = entry.impact?.seed ?? "-"
      const direction = entry.impact?.direction ?? "-"
      const validation = entry.impact?.validationKind ?? "-"
      if (!push(`  ${entry.file} [IMPACT via=${via} direction=${direction} binding=${binding} validated=${validation}]`)) break
      const sample = entry.impact?.sample
      if (Number.isInteger(sample?.line)) {
        if (!push(`    > ${sample.line} | ${clipLine(sample.text, 220)}`)) break
      }
      continue
    }

    const q = [...entry.queries]
      .sort((a, b) => a - b)
      .map((value) => `Q${value + 1}`)
      .join(",")
    if (!push(`  ${entry.file} [${q}]`)) break
  }

  if (retained > 0) push(`  +${retained} lexical candidates retained_unemitted`)
  return { body, bodyBytes, retained }
}

function runQuery(root, query, queryIndex, targets, glob) {
  return new Promise((resolve) => {
    const searchTargets = Array.isArray(targets) ? targets : [targets]

    if (searchTargets.length < 1) {
      resolve({
        query,
        queryIndex,
        matches: [],
        timedOut: false,
        scanCapped: false,
        error: null,
        scanComplete: true,
      })
      return
    }

    const args = [
      "--json",
      "--color",
      "never",
      "--max-columns",
      "500",
      "--max-columns-preview",
    ]

    appendSearchGlobs(args, glob)
    args.push("--", query, ...searchTargets)

    const child = spawn("rg", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const matches = []
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let scanCapped = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, QUERY_TIMEOUT_MS)

    function consume(line) {
      if (!line.trim() || scanCapped) return

      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }

      if (event?.type !== "match") return

      const file = event.data?.path?.text
      const lineNo = event.data?.line_number
      if (typeof file !== "string" || !Number.isInteger(lineNo)) return
      if (isReservedAgentEvidencePath(file)) return

      // Exactly LINE_HIT_CAP_PER_QUERY hits are complete; the next hit proves truncation.
      if (matches.length >= LINE_HIT_CAP_PER_QUERY) {
        scanCapped = true
        child.kill("SIGTERM")
        return
      }

      matches.push({
        file,
        line: lineNo,
        text: event.data?.lines?.text ?? "",
        queryIndex,
        exactSpans: exactSpansFromRgMatch(event.data, queryIndex),
        matchTexts: exactMatchTextsFromRgMatch(event.data),
      })
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
        matches,
        timedOut,
        scanCapped,
        error: String(error?.message ?? error),
        scanComplete: false,
      })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (!scanCapped && stdout.trim()) consume(stdout)
      if (settled) return
      settled = true

      let error = null
      if (!timedOut && !scanCapped && code !== 0 && code !== 1) {
        error = stderr.trim() || `rg exited with status ${code}`
      }

      resolve({
        query,
        queryIndex,
        matches,
        timedOut,
        scanCapped,
        error,
        scanComplete: !timedOut && !scanCapped && !error,
      })
    })
  })
}

async function loadLines(root, rel, cache) {
  const candidate = path.resolve(root, rel)

  let resolved
  try {
    resolved = await realpath(candidate)
  } catch {
    return null
  }

  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null

  let info
  try {
    info = await stat(resolved)
  } catch {
    return null
  }

  if (!info.isFile() || info.size > MAX_CONTEXT_FILE_BYTES) return null

  if (!cache.has(resolved)) {
    try {
      const text = await readFile(resolved, "utf8")
      cache.set(resolved, text.split(/\r?\n/))
    } catch {
      return null
    }
  }

  return cache.get(resolved)
}

function buildRanges(hitLines, totalLines) {
  const sorted = [...new Set(hitLines)].sort((a, b) => a - b)
  const ranges = []

  for (const line of sorted) {
    const start = Math.max(1, line - CONTEXT_RADIUS)
    const end = Math.min(totalLines, line + CONTEXT_RADIUS)
    const last = ranges[ranges.length - 1]

    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }

  return ranges
}

function mergeHits(results) {
  const hits = new Map()

  for (const result of results) {
    for (const match of result.matches) {
      const key = `${match.file}:${match.line}`
      let item = hits.get(key)

      if (!item) {
        item = {
          file: match.file,
          line: match.line,
          text: match.text,
          queries: new Set(),
          exactSpans: [],
        }
        hits.set(key, item)
      }

      item.queries.add(result.queryIndex)
      if (Array.isArray(match.exactSpans)) item.exactSpans.push(...match.exactSpans)
    }
  }

  return hits
}

function spanCaptureComplete(results) {
  return results.every((result) =>
    result.matches.every(
      (match) => Array.isArray(match.exactSpans) && match.exactSpans.length > 0,
    ),
  )
}

function distillerHitsFromMerged(hits) {
  const unique = new Map()

  for (const hit of hits.values()) {
    for (const span of hit.exactSpans ?? []) {
      const startByte = span?.startByte
      const endByte = span?.endByte
      const queryIndex = span?.queryIndex

      if (
        !Number.isSafeInteger(startByte) ||
        !Number.isSafeInteger(endByte) ||
        !Number.isInteger(queryIndex) ||
        startByte < 0 ||
        endByte <= startByte
      ) {
        continue
      }

      const key = `${hit.file}\0${startByte}\0${endByte}`
      const query = queryIndex + 1
      const existing = unique.get(key)

      if (!existing || query < existing.query) {
        unique.set(key, {
          file: hit.file,
          line: hit.line,
          query,
          start_byte: startByte,
          end_byte: endByte,
        })
      }
    }
  }

  return [...unique.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.start_byte - b.start_byte ||
      a.end_byte - b.end_byte ||
      a.query - b.query,
  )
}

function ownerRecoveryHitsFromMerged(hits) {
  const unique = new Map()

  for (const hit of hits.values()) {
    if (
      typeof hit?.file !== "string" ||
      hit.file.length < 1 ||
      !Number.isInteger(hit?.line) ||
      hit.line < 1
    ) {
      continue
    }

    const queryIndex = [...(hit.queries ?? [])]
      .filter((value) => Number.isInteger(value) && value >= 0)
      .sort((a, b) => a - b)[0]

    if (!Number.isInteger(queryIndex)) continue

    const key = `${hit.file}\0${hit.line}`

    if (!unique.has(key)) {
      unique.set(key, {
        file: hit.file,
        line: hit.line,
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

function maxHitsInOneFile(hits) {
  const counts = new Map()
  let max = 0

  for (const hit of hits.values()) {
    const count = (counts.get(hit.file) ?? 0) + 1
    counts.set(hit.file, count)
    if (count > max) max = count
  }

  return max
}

function evidencePressure(hits, rawRendered, rawEvidenceComplete) {
  const reasons = []
  const maxHitsPerFile = maxHitsInOneFile(hits)

  if (!rawEvidenceComplete) reasons.push("raw_output_budget")
  if (rawRendered.bodyBytes >= DISTILLER_RAW_BODY_PRESSURE_BYTES) {
    reasons.push("raw_body_bytes")
  }
  if (maxHitsPerFile >= DISTILLER_MAX_HITS_PER_FILE) {
    reasons.push("hits_per_file")
  }

  return {
    active: reasons.length > 0,
    reasons,
    maxHitsPerFile,
  }
}

function distillerBinary() {
  const override = process.env.OPENCODE_EVIDENCE_DISTILLER
  if (typeof override === "string" && override.length > 0) return override

  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null

  return path.join(
    home,
    ".local",
    "libexec",
    "opencode-cpu-agent",
    "opencode-evidence-distiller",
  )
}

function runDistiller(root, hits) {
  return new Promise((resolve) => {
    const binary = distillerBinary()

    if (!binary) {
      resolve({
        ok: false,
        reason: "binary_path_unavailable",
        elapsedMs: 0,
      })
      return
    }

    const started = performance.now()
    const child = spawn(binary, [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let outputLimited = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      resolve({
        ...result,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, DISTILLER_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (stdoutBytes > DISTILLER_MAX_STDOUT_BYTES) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }

      stdout.push(Buffer.from(chunk))
    })

    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 4096) return

      const remaining = 4096 - stderrBytes
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
      stderr.push(Buffer.from(kept))
      stderrBytes += kept.length
    })

    child.stdin.on("error", () => {
      // spawn/close handlers determine the final fallback reason.
    })

    child.on("error", (error) => {
      finish({
        ok: false,
        reason: "spawn_error",
        error: String(error?.message ?? error),
      })
    })

    child.on("close", (code, signal) => {
      if (settled) return

      const stderrText = Buffer.concat(stderr).toString("utf8").trim()

      if (timedOut) {
        finish({
          ok: false,
          reason: "timeout",
          error: stderrText || null,
        })
        return
      }

      if (outputLimited) {
        finish({
          ok: false,
          reason: "stdout_limit",
          error: stderrText || null,
        })
        return
      }

      if (code !== 0) {
        finish({
          ok: false,
          reason: "exit_error",
          exitCode: code,
          signal: signal ?? null,
          error: stderrText || null,
        })
        return
      }

      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (error) {
        finish({
          ok: false,
          reason: "invalid_json",
          error: String(error?.message ?? error),
        })
        return
      }

      // Rolling-upgrade compatibility: an old v2 helper is recognized, but its
      // summary-only output is never allowed to replace raw evidence. v3 keeps
      // v2's grouping idea inside enriched groups and adds witness variants.
      if (response?.protocol === "evidence-distiller-v2") {
        finish({
          ok: false,
          reason: "legacy_v2_summary_only",
          response,
        })
        return
      }

      if (
        response?.protocol !== "evidence-distiller-v3" ||
        response?.representation !== "evidence_ir" ||
        response?.ir_complete !== true ||
        response?.location_complete !== true ||
        response?.anchor_complete !== true ||
        response?.witness_complete !== true ||
        response?.v2_grouping_preserved !== true ||
        response?.raw_hits !== hits.length ||
        !Array.isArray(response?.groups) ||
        response.groups.length < 1 ||
        response?.groups_shown !== response.groups.length ||
        response?.variants_shown !== response?.variants_total
      ) {
        finish({
          ok: false,
          reason: "unsafe_ir",
          response,
        })
        return
      }

      finish({
        ok: true,
        reason: "ir_complete",
        response,
      })
    })

    try {
      child.stdin.end(
        JSON.stringify({
          root,
          hits,
          budget_bytes: DISTILLER_IR_BUDGET_BYTES,
        }),
      )
    } catch (error) {
      child.kill("SIGKILL")
      finish({
        ok: false,
        reason: "stdin_error",
        error: String(error?.message ?? error),
      })
    }
  })
}


function runtimeStackDirectory() {
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(home, ".local", "libexec", "opencode-cpu-agent")
}

function emptyRuntimeStackIdentity(status) {
  return {
    runtime_stack_protocol: RUNTIME_STACK_PROTOCOL,
    runtime_stack_status: status,
    runtime_git_head: null,
    runtime_manifest_sha256: null,
    runtime_manifest_compiler_sha256: null,
    runtime_manifest_executor_sha256: null,
    runtime_manifest_verifier_sha256: null,
    runtime_manifest_impact_index_sha256: null,
  }
}

function runtimeStackOverridesActive() {
  return [
    "OPENCODE_PATCH_COMPILER",
    "OPENCODE_PATCH_EXECUTOR",
    "OPENCODE_INVARIANT_VERIFIER",
    "OPENCODE_IMPACT_INDEX",
  ].some((name) => {
    const value = process.env[name]
    return typeof value === "string" && value.length > 0
  })
}

function parseRuntimeStackManifest(raw) {
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    return null
  }

  if (
    manifest?.protocol !== RUNTIME_STACK_PROTOCOL ||
    typeof manifest?.git_head !== "string" ||
    !manifest.git_head.length ||
    typeof manifest?.components !== "object" ||
    manifest.components === null
  ) {
    return null
  }

  const records = {}
  for (const [key, binary] of Object.entries(RUNTIME_STACK_COMPONENTS)) {
    const record = manifest.components[binary]
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.sha256) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0
    ) {
      return null
    }
    records[key] = {
      binary,
      sha256: record.sha256,
      bytes: record.bytes,
    }
  }

  return {
    git_head: manifest.git_head,
    records,
  }
}

async function runtimeStackIdentity() {
  const dir = runtimeStackDirectory()
  if (!dir) return emptyRuntimeStackIdentity("home_unavailable")

  const manifestPath = path.join(dir, RUNTIME_STACK_MANIFEST)

  try {
    const manifestStat = await stat(manifestPath)
    if (!manifestStat.isFile()) {
      return emptyRuntimeStackIdentity("manifest_missing")
    }

    const cacheKey = `${manifestStat.size}:${manifestStat.mtimeMs}`
    let cached = runtimeStackManifestCache

    if (!cached || cached.path !== manifestPath || cached.key !== cacheKey) {
      const raw = await readFile(manifestPath, "utf8")
      const parsed = parseRuntimeStackManifest(raw)

      cached = {
        path: manifestPath,
        key: cacheKey,
        parsed,
        manifestSha256: createHash("sha256").update(raw).digest("hex"),
      }
      runtimeStackManifestCache = cached
    }

    if (!cached.parsed) {
      return emptyRuntimeStackIdentity("manifest_invalid")
    }

    const identity = {
      runtime_stack_protocol: RUNTIME_STACK_PROTOCOL,
      runtime_stack_status: "manifest_loaded",
      runtime_git_head: cached.parsed.git_head,
      runtime_manifest_sha256: cached.manifestSha256,
      runtime_manifest_compiler_sha256: cached.parsed.records.compiler.sha256,
      runtime_manifest_executor_sha256: cached.parsed.records.executor.sha256,
      runtime_manifest_verifier_sha256: cached.parsed.records.verifier.sha256,
      runtime_manifest_impact_index_sha256: cached.parsed.records.impact_index.sha256,
    }

    // An override can point at binaries unrelated to the installed manifest.
    // Never present manifest hashes as actual runtime identity in that case.
    if (runtimeStackOverridesActive()) {
      return {
        ...identity,
        runtime_stack_status: "override_unverified",
      }
    }

    for (const record of Object.values(cached.parsed.records)) {
      let binaryStat
      try {
        binaryStat = await stat(path.join(dir, record.binary))
      } catch {
        return {
          ...identity,
          runtime_stack_status: "binary_missing",
        }
      }

      if (!binaryStat.isFile()) {
        return {
          ...identity,
          runtime_stack_status: "binary_missing",
        }
      }

      if (binaryStat.size !== record.bytes) {
        return {
          ...identity,
          runtime_stack_status: "binary_size_mismatch",
        }
      }
    }

    return {
      ...identity,
      runtime_stack_status: "manifest_size_checked",
    }
  } catch {
    return emptyRuntimeStackIdentity("manifest_missing")
  }
}


function patchCompilerBinary() {
  const override = process.env.OPENCODE_PATCH_COMPILER
  if (typeof override === "string" && override.length > 0) return override
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(home, ".local", "libexec", "opencode-cpu-agent", "opencode-patch-compiler")
}

function patchExecutorBinary() {
  const override = process.env.OPENCODE_PATCH_EXECUTOR
  if (typeof override === "string" && override.length > 0) return override
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(home, ".local", "libexec", "opencode-cpu-agent", "opencode-patch-executor")
}

function invariantVerifierBinary() {
  const override = process.env.OPENCODE_INVARIANT_VERIFIER
  if (typeof override === "string" && override.length > 0) return override
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(home, ".local", "libexec", "opencode-cpu-agent", "opencode-invariant-verifier")
}

function completionAuthorizerBinary() {
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(
    home,
    ".local",
    "libexec",
    "opencode-cpu-agent",
    "opencode-completion-authorizer",
  )
}

function patchPlanSignature(compiled) {
  return createHash("sha256")
    .update(JSON.stringify({ edits: compiled?.edits ?? [], checks: compiled?.checks ?? [] }))
    .digest("hex")
    .slice(0, 24)
}


function mutationFieldPresent(input, key) {
  return Object.prototype.hasOwnProperty.call(input ?? {}, key)
}

function mutationShapeFailure(kind, detail) {
  const normalizedKind =
    typeof kind === "string" && kind.length > 0
      ? kind
      : "unknown"

  return {
    ok: false,
    reason: "mutation_shape_invalid",
    detail,
    signature: `${normalizedKind}:${detail}`,
  }
}

function validateMutationShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return mutationShapeFailure(
      "unknown",
      "input_not_object",
    )
  }

  const has = (key) =>
    mutationFieldPresent(input, key)

  // Mutation target is capability-bound in 2.0.
  // A model must never choose or repeat file/symbol identity.
  if (has("file") || has("symbol")) {
    return mutationShapeFailure(
      input.kind,
      "target_fields_forbidden_capability_bound",
    )
  }

  if (input.kind === "replace_node") {
    const missing = []

    if (
      typeof input.before !== "string" ||
      input.before.length < 1
    ) {
      missing.push("before")
    }

    if (typeof input.replacement !== "string") {
      missing.push("replacement")
    }

    if (missing.length > 0) {
      return mutationShapeFailure(
        input.kind,
        `replace_node_requires_${missing.join("_")}`,
      )
    }

    const forbidden = [
      "body",
      "after",
      "new_name",
      "scope",
    ].filter(has)

    if (forbidden.length > 0) {
      return mutationShapeFailure(
        input.kind,
        `replace_node_forbids_${forbidden.sort().join("_")}`,
      )
    }

    return { ok: true }
  }

  if (input.kind === "rename_symbol") {
    if (
      typeof input.new_name !== "string" ||
      input.new_name.length < 1
    ) {
      return mutationShapeFailure(
        input.kind,
        "rename_symbol_requires_new_name",
      )
    }

    const forbidden = [
      "body",
      "before",
      "replacement",
      "after",
      "scope",
    ].filter(has)

    if (forbidden.length > 0) {
      return mutationShapeFailure(
        input.kind,
        `rename_symbol_forbids_${forbidden.sort().join("_")}`,
      )
    }

    return { ok: true }
  }

  return mutationShapeFailure(
    input.kind,
    "mutation_kind_unknown",
  )
}

function normalizeMutationFile(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
}

function canonicalMutationFile(root, value) {
  if (
    typeof root !== "string" ||
    root.length < 1 ||
    typeof value !== "string" ||
    value.length < 1
  ) {
    return null
  }

  const normalizedInput = value.replaceAll("\\", "/")
  const rootAbs = path.resolve(root)

  const candidateAbs = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(rootAbs, normalizedInput)

  const rel = path.relative(rootAbs, candidateAbs)

  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  ) {
    return null
  }

  return normalizeMutationFile(rel)
}

async function readAuthorizedEditCapsule(root, state) {
  const rel = state?.editCapsulePath

  if (
    typeof root !== "string" ||
    typeof rel !== "string" ||
    rel.length < 1 ||
    path.isAbsolute(rel)
  ) {
    return {
      ok: false,
      reason: "edit_capsule_unavailable",
    }
  }

  const normalized = normalizeMutationFile(rel)

  if (!normalized.startsWith(".opencode/edit-capsules/")) {
    return {
      ok: false,
      reason: "edit_capsule_path_invalid",
    }
  }

  const capsuleRoot = path.resolve(
    root,
    ".opencode",
    "edit-capsules",
  )

  const absolute = path.resolve(root, normalized)

  if (
    absolute !== capsuleRoot &&
    !absolute.startsWith(capsuleRoot + path.sep)
  ) {
    return {
      ok: false,
      reason: "edit_capsule_path_escape",
    }
  }

  let raw

  try {
    raw = await readFile(absolute, "utf8")
  } catch {
    return {
      ok: false,
      reason: "edit_capsule_read_failed",
    }
  }

  if (
    typeof state?.editCapsuleHash === "string" &&
    state.editCapsuleHash.length > 0
  ) {
    const actual = createHash("sha256")
      .update(raw)
      .digest("hex")

    if (actual !== state.editCapsuleHash) {
      return {
        ok: false,
        reason: "edit_capsule_hash_mismatch",
      }
    }
  }

  let capsule

  try {
    capsule = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      reason: "edit_capsule_json_invalid",
    }
  }

  if (
    capsule?.protocol !== EDIT_CAPSULE_PROTOCOL ||
    capsule?.render_contract !== EDIT_CAPSULE_RENDER_CONTRACT ||
    capsule?.mutation_ready !== true ||
    capsule?.mutation_scope_complete !== true ||
    capsule?.mutation_capable_scopes !== 1 ||
    !Array.isArray(capsule?.scopes)
  ) {
    return {
      ok: false,
      reason: "edit_capsule_contract_invalid",
    }
  }

  const authorizedScopes =
    capsule.scopes.filter(
      (scope) =>
        scope?.mutation_authorized === true &&
        scope?.context === "full",
    )

  if (authorizedScopes.length !== 1) {
    return {
      ok: false,
      reason: "edit_capsule_authority_invalid",
    }
  }

  const authorized = authorizedScopes[0]
  const attested = capsule?.authorized_mutation_scope

  const authorizedFile =
    canonicalMutationFile(root, authorized?.file)

  const attestedFile =
    canonicalMutationFile(root, attested?.file)

  if (
    !authorizedFile ||
    !attestedFile ||
    authorizedFile !== attestedFile ||
    authorized?.symbol_name !== attested?.symbol_name ||
    authorized?.symbol_kind !== attested?.symbol_kind ||
    authorized?.start_line !== attested?.start_line ||
    authorized?.end_line !== attested?.end_line
  ) {
    return {
      ok: false,
      reason: "edit_capsule_authority_attestation_mismatch",
    }
  }

  const expectedSourceLines =
    authorized.end_line - authorized.start_line + 1

  const actualSourceLines =
    typeof authorized?.source === "string" &&
    authorized.source.length > 0
      ? authorized.source.split("\n").length
      : 0

  if (
    !Number.isInteger(expectedSourceLines) ||
    expectedSourceLines < 1 ||
    actualSourceLines !== expectedSourceLines
  ) {
    return {
      ok: false,
      reason: "edit_capsule_full_scope_incomplete",
    }
  }

if (
    capsule?.mutation_candidate_protocol !== MUTATION_CANDIDATE_SET_PROTOCOL ||
    capsule?.mutation_candidate_limit !== MUTATION_CANDIDATE_MAX ||
    !Array.isArray(capsule?.mutation_candidates) ||
    !Number.isInteger(capsule?.mutation_candidate_count) ||
    capsule.mutation_candidate_count !== capsule.mutation_candidates.length ||
    capsule.mutation_candidate_count < 1 ||
    capsule.mutation_candidate_count > MUTATION_CANDIDATE_MAX
  ) {
    return {
      ok: false,
      reason: "edit_capsule_candidate_set_invalid",
    }
  }

  for (const candidate of capsule.mutation_candidates) {
    const matches = capsule.scopes.filter(
      (scope) =>
        scope?.mutation_candidate === true &&
        scope?.context === "full" &&
        sameAuthorizedScopeIdentity(scope, candidate),
    )

    if (matches.length !== 1) {
      return {
        ok: false,
        reason: "edit_capsule_candidate_attestation_mismatch",
      }
    }
  }

  return {
    ok: true,
    capsule,
  }
}
