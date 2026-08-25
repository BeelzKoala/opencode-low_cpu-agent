
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

async function materializeCapabilityBoundMutation(
  root,
  state,
  input,
) {
  const loaded = await readAuthorizedEditCapsule(root, state)
  if (!loaded.ok) return { ...loaded, rescout: false }

  const authorizedScopes = loaded.capsule.scopes.filter(
    (scope) =>
      scope?.context === "full" &&
      scope?.mutation_authorized === true,
  )
  if (authorizedScopes.length !== 1) {
    return {
      ok: false,
      reason: "mutation_capability_invalid",
      detail: `authorized_scope_count_${authorizedScopes.length}`,
      rescout: false,
    }
  }

  const primaryTarget = authorizedScopes[0]
  const primaryCapability = state?.localMutationCapability ?? null

  let target = null
  let capability = null
  let activeHandoffPath = null

  if (input.kind === "replace_node") {
    if (
      primaryCapability?.protocol !== SCOUT_LOCAL_CAPABILITY_PROTOCOL ||
      primaryCapability?.replaceNodeReady !== true ||
      !sameAuthorizedScopeIdentity(
        primaryTarget,
        {
          file: primaryCapability?.target?.file,
          symbol_name: primaryCapability?.target?.symbol_name,
          symbol_kind: primaryCapability?.target?.symbol_kind,
          start_line: primaryCapability?.target?.start_line,
          end_line: primaryCapability?.target?.end_line,
        },
      )
    ) {
      return {
        ok: false,
        reason: "mutation_capability_unavailable",
        detail: "local_capability_target_mismatch",
        rescout: false,
      }
    }

    const binding =
      await bindReplaceNodeMutationCandidate(
        root,
        state,
        input.before,
      )

    if (!binding.ok) {
      return {
        ok: false,
        reason: binding.reason,
        detail: binding.reason,
        repairable: binding.repairable === true,
        rescout: false,
        candidate_count: binding.candidate_count ?? null,
      }
    }

    target = binding.candidate.target
    capability = binding.candidate.capability

    if (
      !Array.isArray(capability.allowedMutations) ||
      !capability.allowedMutations.includes("replace_node")
    ) {
      return {
        ok: false,
        reason: "mutation_not_authorized_by_handoff",
        detail: "replace_node_not_in_local_capability",
        rescout: false,
      }
    }

    activeHandoffPath = capability.localHandoffPath
    state.boundMutationTarget = mutationCandidateIdentity(target)
  } else if (input.kind === "rename_symbol") {
    const renameCapability = state?.renameMutationCapability ?? null
    target = renameCapability?.target ?? null
    capability = renameCapability

    const identitySha256 = target
      ? createHash("sha256")
          .update(JSON.stringify(target))
          .digest("hex")
      : null

    if (
      renameCapability?.protocol !== SCOUT_RENAME_TARGET_PROTOCOL ||
      renameCapability?.operation !== "rename_symbol" ||
      renameCapability?.ready !== true ||
      renameCapability?.globalReady !== true ||
      renameCapability?.sourceHandoffPath !== state?.scoutHandoffPath ||
      renameCapability?.targetIdentitySha256 !== identitySha256 ||
      typeof state?.scoutHandoffPath !== "string"
    ) {
      return {
        ok: false,
        reason: "rename_target_capability_invalid",
        detail: "rename_target_capability_invalid",
        rescout: true,
      }
    }

    const renameFile = canonicalMutationFile(root, target?.file)
    let currentBody
    try {
      currentBody = await readFile(path.resolve(root, renameFile ?? ""))
    } catch {
      return {
        ok: false,
        reason: "rename_target_file_unavailable",
        detail: "rename_target_file_unavailable",
        rescout: true,
      }
    }

    const currentSha256 = createHash("sha256")
      .update(currentBody)
      .digest("hex")
    if (currentSha256 !== renameCapability.targetSourceSha256) {
      return {
        ok: false,
        reason: "rename_target_stale",
        detail: "rename_target_stale",
        rescout: true,
      }
    }

    activeHandoffPath = state.scoutHandoffPath
    state.boundMutationTarget = mutationCandidateIdentity(target)
  }

  const file = canonicalMutationFile(root, target?.file)
  const symbol =
    typeof target?.symbol_name === "string" ? target.symbol_name : ""

  if (!file || !symbol) {
    return {
      ok: false,
      reason: "mutation_capability_invalid",
      detail: "authorized_target_identity_invalid",
      rescout: false,
    }
  }

  if (
    typeof activeHandoffPath !== "string" ||
    activeHandoffPath.length < 1
  ) {
    return {
      ok: false,
      reason: "mutation_handoff_unavailable",
      detail: "operation_handoff_missing",
      rescout: false,
    }
  }

  const mutation = {
    file,
    kind: input.kind,
    symbol,
    ...(typeof input.before === "string" ? { before: input.before } : {}),
    ...(typeof input.replacement === "string"
      ? { replacement: input.replacement }
      : {}),
    ...(typeof input.new_name === "string" ? { new_name: input.new_name } : {}),
    ...(input.kind === "rename_symbol" ? { scope: "handoff" } : {}),
  }

  return {
    ok: true,
    mutation,
    handoff_path: activeHandoffPath,
    scope_context: target.context,
    target: {
      file,
      symbol,
      symbol_kind: target.symbol_kind ?? null,
      start_line: target.start_line ?? null,
      end_line: target.end_line ?? null,
    },
  }
}
const PATCH_COMPILER_RETRY_REASONS = new Set([
  "mutation_contract_invalid",
  "mutation_kind_invalid",
  "mutation_file_invalid",
  "symbol_not_found",
  "symbol_ambiguous",
  "expression_pattern_invalid",
  "expression_not_found",
  "expression_ambiguous",
  "rename_context_ambiguous",
  "rename_scope_too_large",
  "lowered_edit_budget_exceeded",
  "no_effect_plan",
  "mutation_slice_not_exact",
  "mutation_slice_ambiguous",
  "mutation_slice_not_structural",
  "mutation_slice_too_wide",
  "mutation_fragment_invalid",
  "mutation_replacement_invalid",
  "candidate_language_invalid",
])

const PATCH_COMPILER_RESCOUT_REASONS = new Set([
  "handoff_not_ready",
  "local_capability_invalid",
  "handoff_scope_mode_invalid",
  "mutation_not_authorized_by_handoff",
  "handoff_scope_empty",
  "handoff_file_invalid",
  "handoff_file_unavailable",
  "file_outside_handoff",
  "evidence_anchor_missing",
  "rename_scope_incomplete",
])

const PATCH_RETRY_REASONS = new Set([
  "edit_contract_invalid",
  "check_contract_invalid",
  "precondition_not_unique",
  "ast_pattern_invalid",
  "ast_metavariables_unsupported",
  "ast_precondition_ambiguous",
  "ast_precondition_not_found",
  "no_effect",
  "candidate_syntax_invalid",
  "postcondition_failed",
  "changed_file_budget_exceeded",
  "changed_line_budget_exceeded",
  "patch_budget_exceeded",
])

const PATCH_RESCOUT_REASONS = new Set([
  "handoff_not_ready",
  "handoff_scope_too_large",
  "handoff_scope_empty",
  "handoff_file_invalid",
  "handoff_fingerprint_weak",
  "handoff_fingerprint_missing",
  "handoff_file_unavailable",
  "stale_fingerprint",
  "file_outside_handoff",
  "check_file_outside_handoff",
  "evidence_anchor_missing",
  "edit_outside_evidence_radius",
  "worktree_baseline_missing",
  "worktree_baseline_mismatch",
  "source_changed_during_execution",
])

function proofObligationsForMutations(mutations) {
  const obligations = [
    { id: "changed_file_set", check_kind: "changed_file_set", disposition: "fatal" },
    { id: "replay_exact", check_kind: "replay_exact", disposition: "fatal" },
    { id: "ast_parse", check_kind: "ast_parse", disposition: "fatal" },
    { id: "candidate_validity_barrier", check_kind: "candidate_validity_barrier", disposition: "fatal" },
    { id: "top_level_conservation", check_kind: "top_level_conservation", disposition: "repair" },
    { id: "target_cardinality", check_kind: "target_cardinality", disposition: "repair" },
  ]
  if ((mutations ?? []).some((mutation) => mutation?.kind === "replace_node")) {
    obligations.push(
      { id: "replace_node_confinement", check_kind: "replace_node_confinement", disposition: "repair" },
    )
  }
  if ((mutations ?? []).some((mutation) => mutation?.kind === "rename_symbol")) {
    obligations.push(
      { id: "rename_identifier_delta", check_kind: "rename_identifier_delta", disposition: "repair" },
      { id: "rename_syntactic_closure", check_kind: "rename_global_closure", disposition: "rescout" },
    )
  }
  return obligations.map((obligation) => ({ protocol: PROOF_OBLIGATION_PROTOCOL, ...obligation }))
}

function assessProofObligations(verificationResponse, obligations) {
  const checks = Array.isArray(verificationResponse?.checks) ? verificationResponse.checks : []
  const byKind = new Map()
  for (const check of checks) {
    if (!check || typeof check.kind !== "string") continue
    if (!byKind.has(check.kind)) byKind.set(check.kind, [])
    byKind.get(check.kind).push(check)
  }

  const failed = []
  for (const obligation of obligations ?? []) {
    const rows = byKind.get(obligation.check_kind) ?? []
    const pass = rows.length > 0 && rows.every((row) => row?.pass === true)
    if (!pass) failed.push({
      id: obligation.id,
      check_kind: obligation.check_kind,
      disposition: obligation.disposition,
      details: rows.filter((row) => row?.pass !== true).map((row) => ({ file: row?.file ?? null, detail: row?.detail ?? null })),
    })
  }
  if (verificationResponse?.worktree_cleaned !== true) {
    failed.push({ id: "worktree_cleanup", check_kind: "worktree_cleaned", disposition: "fatal", details: [] })
  }

  let disposition = "pass"
  if (failed.some((item) => item.disposition === "fatal")) disposition = "fatal"
  else if (failed.some((item) => item.disposition === "rescout")) disposition = "rescout"
  else if (failed.length > 0) disposition = "repair"

  return {
    protocol: PROOF_OBLIGATION_PROTOCOL,
    ok: failed.length === 0,
    disposition,
    obligations: obligations ?? [],
    failed,
  }
}

function compactProofFailure(assessment) {
  return (assessment?.failed ?? []).map((item) => item.id).join(",") || "unknown"
}

function runJsonBinary(binary, root, request, protocol, timeoutMs, stdoutLimit) {
  return new Promise((resolve) => {
    if (!binary) {
      resolve({ ok: false, reason: "binary_path_unavailable", elapsedMs: 0 })
      return
    }
    const started = performance.now()
    const child = spawn(binary, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
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
      resolve({ ...result, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > stdoutLimit) {
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
    child.stdin.on("error", () => {})
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", error: String(error?.message ?? error) }))
    child.on("close", (code, signal) => {
      if (settled) return
      const stderrText = Buffer.concat(stderr).toString("utf8").trim()
      if (timedOut) return finish({ ok: false, reason: "timeout", error: stderrText || null })
      if (outputLimited) return finish({ ok: false, reason: "stdout_limit", error: stderrText || null })
      if (code !== 0) return finish({ ok: false, reason: "exit_error", exitCode: code, signal: signal ?? null, error: stderrText || null })
      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (error) {
        return finish({ ok: false, reason: "invalid_json", error: String(error?.message ?? error) })
      }
      if (response?.protocol !== protocol) {
        return finish({ ok: false, reason: "protocol_mismatch", response })
      }
      finish({
        ok: true,
        reason: "ok",
        response,
        diagnostic: stderrText || null,
      })
    })
    try {
      child.stdin.end(JSON.stringify(request))
    } catch (error) {
      child.kill("SIGKILL")
      finish({ ok: false, reason: "stdin_error", error: String(error?.message ?? error) })
    }
  })
}

function runPatchCompiler(root, request) {
  return runJsonBinary(
    patchCompilerBinary(),
    root,
    request,
    PATCH_COMPILER_PROTOCOL,
    PATCH_COMPILER_TIMEOUT_MS,
    PATCH_COMPILER_MAX_STDOUT_BYTES,
  )
}

function runPatchExecutor(root, request) {
  return runJsonBinary(
    patchExecutorBinary(),
    root,
    request,
    PATCH_EXECUTOR_PROTOCOL,
    PATCH_EXECUTOR_TIMEOUT_MS,
    PATCH_EXECUTOR_MAX_STDOUT_BYTES,
  )
}

function runInvariantVerifier(root, request) {
  return runJsonBinary(
    invariantVerifierBinary(),
    root,
    request,
    INVARIANT_VERIFIER_PROTOCOL,
    INVARIANT_VERIFIER_TIMEOUT_MS,
    INVARIANT_VERIFIER_MAX_STDOUT_BYTES,
  )
}

async function writePatchReceipt(root, sessionID, state, executorResponse, compilerResponse, verificationResponse, proofAssessment) {
  const patch = typeof executorResponse?.patch === "string" ? executorResponse.patch : null
  if (!patch || !sessionID || !state?.turnID) return null

  const dir = path.join(root, ".opencode", "patches")
  const key = scoutOpaqueKey(`${sessionID}:${state.turnID}`)
  const patchPath = path.join(dir, `${key}.diff`)
  const receiptPath = path.join(dir, `${key}.json`)
  const verificationPath = path.join(dir, `${key}.verify.json`)
  const nonce = `${process.pid}.${nowMs()}`
  const patchTemp = `${patchPath}.${nonce}.tmp`
  const receiptTemp = `${receiptPath}.${nonce}.tmp`
  const verificationTemp = `${verificationPath}.${nonce}.tmp`
  const receipt = {
    protocol: PATCH_RECEIPT_PROTOCOL,
    verification_protocol: VERIFICATION_RECEIPT_PROTOCOL,
    verification_receipt: path.relative(root, verificationPath),
    execution_protocol: EXECUTION_LOOP_PROTOCOL,
    mutation_tool_abi_protocol: MUTATION_TOOL_ABI_PROTOCOL,
    mutation_tool: state.activeMutationTool,
    visible_tool_schema_sha256: state.visibleToolSchemaSha256,
    tool_contract_failures: state.contractFailures,
    compiler_protocol: PATCH_COMPILER_PROTOCOL,
    mutation_protocol: PATCH_MUTATION_PROTOCOL,
    executor_protocol: PATCH_EXECUTOR_PROTOCOL,
    edit_protocol: PATCH_EDIT_PROTOCOL,
    search_protocol: SEARCH_PROTOCOL,
    turn_key: scoutOpaqueKey(state.turnID),
    generated_at_ms: nowMs(),
    scout_handoff:
      state.activeMutationHandoffPath ?? state.scoutHandoffPath,
    discovery_handoff: state.scoutHandoffPath,
    mutation_capability_protocol:
      state.activeMutationTool === EXECUTE_RENAME_SYMBOL_TOOL
        ? state.renameMutationCapability?.protocol ?? null
        : state.localMutationCapability?.protocol ?? null,
    mutation_capability_target:
      state.activeMutationTool === EXECUTE_RENAME_SYMBOL_TOOL
        ? state.renameMutationCapability?.target ?? null
        : state.localMutationCapability?.target ?? null,
    rename_target_capability_protocol:
      state.renameMutationCapability?.protocol ?? null,
    rename_target_capability_target:
      state.renameMutationCapability?.target ?? null,
    mutation_confinement_protocol:
      (compilerResponse?.edits ?? []).some((edit) => edit?.kind === "replace_slice")
        ? MUTATION_CONFINEMENT_PROTOCOL
        : null,
    mutation_confinements:
      (compilerResponse?.edits ?? [])
        .filter((edit) => edit?.kind === "replace_slice" && edit?.confinement)
        .map((edit) => edit.confinement),
    edit_capsule_protocol: EDIT_CAPSULE_PROTOCOL,
    edit_capsule: state.editCapsulePath,
    edit_capsule_sha256: state.editCapsuleHash,
    execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
    proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL,
    proof_obligations: proofAssessment?.obligations ?? [],
    proof_disposition: proofAssessment?.disposition ?? null,
    patch_path: path.relative(root, patchPath),
    patch_sha256: createHash("sha256").update(patch).digest("hex"),
    attempts_used: state.mutationAttempts,
    mutation_attempts_used: state.mutationAttempts,
    repair_attempts_used: state.repairAttempts,
    compiler_runs: state.compilerRuns,
    patch_attempts_used: state.patchAttempts,
    executor_runs: state.executorRuns,
    mutations_requested: compilerResponse?.mutations_requested ?? null,
    mutations_effective: compilerResponse?.mutations_effective ?? null,
    compiler_dropped_noops: compilerResponse?.dropped_noops ?? null,
    compiler_dropped_duplicates: compilerResponse?.dropped_duplicates ?? null,
    compiler_lowered_edits: compilerResponse?.lowered_edits ?? null,
    compiler_checks_generated: compilerResponse?.checks_generated ?? null,
    changed_files: executorResponse.changed_files ?? [],
    changed_lines: executorResponse.changed_lines ?? 0,
    patch_bytes: executorResponse.patch_bytes ?? bytes(patch),
    changes: executorResponse.changes ?? [],
    syntax_checked_files: executorResponse.syntax_checked_files ?? [],
    postconditions_checked: executorResponse.postconditions_checked ?? 0,
    structural_edits: executorResponse.structural_edits ?? 0,
    git_diff_check: executorResponse.git_diff_check === true,
    git_apply_check: executorResponse.git_apply_check === true,
    repo_mutated: executorResponse.repo_mutated === true,
    invariant_verifier_protocol: verificationResponse?.protocol ?? null,
    invariants_total: verificationResponse?.invariants_total ?? null,
    invariants_passed: verificationResponse?.invariants_passed ?? null,
    invariants_failed: verificationResponse?.invariants_failed ?? null,
  }

  try {
    await mkdir(dir, { recursive: true })
    const verificationReceipt = {
      protocol: VERIFICATION_RECEIPT_PROTOCOL,
      generated_at_ms: nowMs(),
      patch_receipt: path.relative(root, receiptPath),
      patch_sha256: receipt.patch_sha256,
      edit_capsule: state.editCapsulePath,
      edit_capsule_sha256: state.editCapsuleHash,
      proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL,
      proof_assessment: proofAssessment,
      verifier: verificationResponse,
    }
    await writeFile(patchTemp, patch, "utf8")
    await writeFile(receiptTemp, JSON.stringify(receipt, null, 2) + "\n", "utf8")
    await writeFile(verificationTemp, JSON.stringify(verificationReceipt, null, 2) + "\n", "utf8")
    await rename(patchTemp, patchPath)
    await rename(receiptTemp, receiptPath)
    await rename(verificationTemp, verificationPath)
    return { path: path.relative(root, receiptPath), verificationPath: path.relative(root, verificationPath), receipt, verificationReceipt }
  } catch {
    await rm(patchTemp, { force: true }).catch(() => {})
    await rm(receiptTemp, { force: true }).catch(() => {})
    await rm(verificationTemp, { force: true }).catch(() => {})
    await rm(patchPath, { force: true }).catch(() => {})
    await rm(receiptPath, { force: true }).catch(() => {})
    await rm(verificationPath, { force: true }).catch(() => {})
    return null
  }
}


function impactIndexBinary() {
  const override = process.env.OPENCODE_IMPACT_INDEX
  if (typeof override === "string" && override.length > 0) return override
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(home, ".local", "libexec", "opencode-cpu-agent", "opencode-impact-index")
}

function runImpactIndexRequest(root, request, timeoutMs) {
  return new Promise((resolve) => {
    const binary = impactIndexBinary()
    if (!binary) {
      resolve({ ok: false, reason: "binary_path_unavailable", elapsedMs: 0 })
      return
    }
    const started = performance.now()
    const child = spawn(binary, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
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
      resolve({ ...result, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > IMPACT_INDEX_MAX_STDOUT_BYTES) {
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
    child.stdin.on("error", () => {})
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", error: String(error?.message ?? error) }))
    child.on("close", (code, signal) => {
      if (settled) return
      const stderrText = Buffer.concat(stderr).toString("utf8").trim()
      if (timedOut) return finish({ ok: false, reason: "timeout", error: stderrText || null })
      if (outputLimited) return finish({ ok: false, reason: "stdout_limit", error: stderrText || null })
      if (code !== 0) return finish({ ok: false, reason: "exit_error", exitCode: code, signal: signal ?? null, error: stderrText || null })
      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (error) {
        return finish({ ok: false, reason: "invalid_json", error: String(error?.message ?? error) })
      }
      if (response?.protocol !== "impact-index-v1") return finish({ ok: false, reason: "protocol_mismatch", response })
      finish({ ok: true, reason: "ok", response })
    })
    try {
      child.stdin.end(JSON.stringify({ root, ...request }))
    } catch (error) {
      child.kill("SIGKILL")
      finish({ ok: false, reason: "stdin_error", error: String(error?.message ?? error) })
    }
  })
}

function impactIndexShadowStats(result, lexicalFiles) {
  const lexical = new Set((lexicalFiles ?? []).map((entry) =>
    evidenceFileKey(typeof entry === "string" ? entry : entry?.file),
  ))
  const neighbors = result?.ok && Array.isArray(result?.query?.response?.neighbors)
    ? result.query.response.neighbors
    : []
  const lexicalMisses = neighbors.filter((neighbor) =>
    typeof neighbor?.file === "string" && !lexical.has(evidenceFileKey(neighbor.file)),
  )
  const refresh = result?.refresh?.response ?? null
  const query = result?.query?.response ?? null

  return {
    attempted: result?.attempted === true,
    ok: result?.ok === true,
    reason: result?.reason ?? "unknown",
    elapsedMs: result?.elapsedMs ?? 0,
    refreshDue: result?.refreshDue === true,
    refreshDeferred: result?.refreshDeferred === true,
    refreshOk:
      result?.refresh?.ok === true &&
      refresh?.mode === "refresh" &&
      refresh?.ready === true,
    refreshComplete: query?.coverage_complete ?? refresh?.coverage_complete ?? refresh?.refresh_complete ?? null,
    partialReason: query?.partial_reason ?? refresh?.partial_reason ?? null,
    inventoryKind: query?.inventory_kind ?? refresh?.inventory_kind ?? null,
    refreshReason: result?.refresh?.reason ?? null,
    refreshElapsedMs: result?.refresh?.elapsedMs ?? null,
    queryElapsedMs: result?.query?.elapsedMs ?? null,
    cacheAgeMs: query?.cache_age_ms ?? null,
    staleSeedFiles: query?.stale_seed_files ?? 0,
    staleWitnessEdges: query?.stale_witness_edges ?? 0,
    taskFiltersApplied: query?.task_filters_applied === true,
    bootstrapCacheHit: false,
    filesTotal: query?.files_total ?? refresh?.files_total ?? null,
    filesReused: refresh?.files_reused ?? null,
    filesReindexed: refresh?.files_reindexed ?? null,
    filesRemoved: refresh?.files_removed ?? null,
    importsTotal: query?.imports_total ?? refresh?.imports_total ?? null,
    edgesTotal: query?.edges_total ?? refresh?.edges_total ?? null,
    resolvedImports: query?.local_resolved ?? refresh?.local_resolved ?? refresh?.resolved_imports ?? null,
    unresolvedImports: query?.local_unresolved ?? refresh?.local_unresolved ?? null,
    ambiguousImports: query?.local_ambiguous ?? refresh?.local_ambiguous ?? null,
    externalPackages: query?.external_package ?? refresh?.external_package ?? null,
    unsupportedAliases: query?.unsupported_alias ?? refresh?.unsupported_alias ?? null,
    unsupportedDynamic: query?.unsupported_dynamic ?? refresh?.unsupported_dynamic ?? null,
    neighborsTotal: query?.neighbors_total ?? null,
    neighborsShown: neighbors.length,
    lexicalMisses: lexicalMisses.length,
    forwardNeighbors: neighbors.filter((neighbor) => neighbor?.direction === "forward").length,
    reverseNeighbors: neighbors.filter((neighbor) => neighbor?.direction === "reverse").length,
    candidates: lexicalMisses.slice(0, IMPACT_INDEX_MAX_NEIGHBORS).map((neighbor) => ({
      file: neighbor.file,
      seed: neighbor.seed,
      direction: neighbor.direction,
      kind: neighbor.kind,
      confidence: neighbor.confidence,
      witness_file: neighbor.witness_file,
      witness_line: neighbor.witness_line,
      spec: neighbor.spec,
      bindings: Array.isArray(neighbor.bindings) ? neighbor.bindings : [],
      source_symbols: Array.isArray(neighbor.source_symbols) ? neighbor.source_symbols : [],
      binding_pairs: Array.isArray(neighbor.binding_pairs) ? neighbor.binding_pairs : [],
      witness: neighbor.witness ?? null,
    })),
  }
}

function impactStatsForTaskQuery(queryResult, lexicalFiles, reason = "impact_task_filtered", refresh = null) {
  const response = queryResult?.response ?? null
  const age = Number(response?.cache_age_ms)
  const ready =
    queryResult?.ok === true &&
    response?.mode === "neighbors" &&
    response?.ready === true &&
    Array.isArray(response?.neighbors)
  const staleSeedFiles = Number(response?.stale_seed_files ?? 0)
  const staleWitnessEdges = Number(response?.stale_witness_edges ?? 0)
  const refreshDue =
    queryResult?.ok === true && (
      !ready ||
      !Number.isFinite(age) ||
      age >= IMPACT_INDEX_REFRESH_TTL_MS ||
      staleSeedFiles > 0 ||
      staleWitnessEdges > 0
    )
  return impactIndexShadowStats({
    attempted: true,
    ok: ready,
    reason: ready ? reason : queryResult?.reason ?? "query_unavailable",
    elapsedMs: queryResult?.elapsedMs ?? 0,
    refreshDue,
    refreshDeferred: ready && refreshDue,
    refresh,
    query: queryResult,
  }, lexicalFiles)
}

function regexEscape(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function impactSymbolArray(values, cap = IMPACT_EDGE_SYMBOL_CAP) {
  const out = []
  for (const value of values ?? []) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ||
      value.length > 80
    ) continue
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

function impactBindingList(values) {
  return [...new Set(impactSymbolArray(values, IMPACT_BINDINGS_PER_CANDIDATE))]
}

function impactRelationPairs(candidate) {
  const local = impactSymbolArray(candidate?.bindings)
  const source = impactSymbolArray(candidate?.source_symbols)
  const explicit = []
  for (const pair of candidate?.binding_pairs ?? []) {
    const localName = typeof pair?.local === "string" ? pair.local : null
    const sourceName = typeof pair?.source === "string" ? pair.source : null
    if (!localName || !sourceName) continue
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(localName) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sourceName)) continue
    explicit.push({ local: localName, source: sourceName })
    if (explicit.length >= IMPACT_EDGE_SYMBOL_CAP) break
  }
  if (explicit.length > 0) return { local, source, pairs: explicit }

  // Fail-open only for identity mappings. Old caches are rejected by cache
  // version, but this keeps helper skew conservative instead of guessing alias
  // alignment from two independently ordered arrays.
  const pairs = []
  if (local.length === source.length && local.every((value, index) => value === source[index])) {
    for (let i = 0; i < local.length; i += 1) pairs.push({ local: local[i], source: source[i] })
  }
  return { local, source, pairs }
}

function impactLanguage(file) {
  const base = path.basename(String(file ?? "")).toLowerCase()
  if (base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "docker"
  const ext = path.extname(base).slice(1)
  if (ext === "py") return "python"
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript"
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript"
  if (["html", "htm"].includes(ext)) return "html"
  if (ext === "css") return "css"
  if (["xml", "xsd", "xsl", "xslt"].includes(ext)) return "xml"
  if (ext === "sql") return "sql"
  return "other"
}

function impactIdentifiers(text) {
  const out = new Set()
  const stop = new Set([
    "and", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "def", "default", "do", "else", "except", "export", "extends", "false", "finally", "for",
    "from", "function", "if", "import", "in", "interface", "let", "new", "none", "null", "of",
    "pass", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "var",
    "while", "with", "yield",
  ])
  const pattern = /[A-Za-z_$][A-Za-z0-9_$]*/g
  for (const match of String(text ?? "").matchAll(pattern)) {
    const value = match[0]
    // One-character local aliases are common in Python/JS/TS (for example
    // `import { handle as h } ...`). Candidate matching remains exact and is
    // followed by source validation, so retaining them is safer than silently
    // losing a real dependency edge.
    if (value.length < 1 || stop.has(value.toLowerCase())) continue
    out.add(value)
    if (out.size >= IMPACT_SCOPE_IDENTIFIER_CAP) break
  }
  return out
}

function impactDeclaredSymbols(line, language) {
  const text = String(line ?? "").trim()
  const out = new Set()
  const patterns = language === "python"
    ? [
        /^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/,
      ]
    : [
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:export\s+)?(?:default\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:(?:public|private|protected|static|readonly|async|abstract|override|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\)\s*(?::[^={]+)?\s*\{?/,
      ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match?.[1]) continue
    const value = match[1]
    if (!["if", "for", "while", "switch", "catch", "function", "constructor"].includes(value)) out.add(value)
  }
  return out
}

function impactPythonOwnerSymbols(lines, ranges, hitLines) {
  const owners = new Set()
  for (const range of ranges ?? []) {
    const start = Math.max(0, range.start ?? 0)
    for (const value of impactDeclaredSymbols(lines[start] ?? "", "python")) owners.add(value)
    const baseIndent = impactIndent(lines[start] ?? "")
    let ceilingIndent = baseIndent
    for (let i = start - 1; i >= Math.max(0, start - IMPACT_SCOPE_MAX_LINES); i -= 1) {
      const line = lines[i] ?? ""
      const match = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
      if (!match) continue
      const indent = impactIndent(line)
      if (indent < ceilingIndent) {
        owners.add(match[1]); ceilingIndent = indent
        if (indent === 0) break
      }
    }
  }
  for (const lineNo of hitLines ?? []) {
    for (const value of impactDeclaredSymbols(lines[Math.max(0, lineNo - 1)] ?? "", "python")) owners.add(value)
  }
  return owners
}

function impactBraceEnclosingOwner(lines, start) {
  let depth = 0
  for (let i = start - 1; i >= Math.max(0, start - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i] ?? ""
    for (let j = line.length - 1; j >= 0; j -= 1) {
      const ch = line[j]
      if (ch === "}") depth += 1
      else if (ch === "{") {
        if (depth > 0) depth -= 1
        else {
          for (const value of impactDeclaredSymbols(line, "typescript")) return value
        }
      }
    }
  }
  return null
}

function impactBraceOwnerSymbols(lines, ranges, hitLines, language) {
  const owners = new Set()
  for (const range of ranges ?? []) {
    const start = Math.max(0, range.start ?? 0)
    const end = Math.min(lines.length - 1, start + 5)
    for (let i = Math.max(0, start - 2); i <= end; i += 1) {
      for (const value of impactDeclaredSymbols(lines[i] ?? "", language)) owners.add(value)
    }
    const enclosing = impactBraceEnclosingOwner(lines, start)
    if (enclosing) owners.add(enclosing)
  }
  for (const lineNo of hitLines ?? []) {
    for (const value of impactDeclaredSymbols(lines[Math.max(0, lineNo - 1)] ?? "", language)) owners.add(value)
  }
  return owners
}

function impactOwnerSymbols(lines, ranges, hitLines, language) {
  if (!Array.isArray(lines)) return new Set()
  if (language === "python") return impactPythonOwnerSymbols(lines, ranges, hitLines)
  if (["javascript", "typescript"].includes(language)) return impactBraceOwnerSymbols(lines, ranges, hitLines, language)
  return new Set()
}

function impactIndent(line) {
  const match = String(line ?? "").match(/^[ \t]*/)
  return match ? match[0].replace(/\t/g, "    ").length : 0
}
