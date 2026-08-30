import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

export const EXECUTION_CONTEXT_PLANNER_PROTOCOL =
  "bounded-execution-context-planner-v1"
export const EXECUTION_CONTEXT_COVERAGE_PROTOCOL =
  "execution-context-coverage-v1"
export const STRUCTURAL_CONTEXT_PLANNER_PROTOCOL = "context-planner-v1"
export const STRUCTURAL_CONTEXT_PLANNER_AUTHORITY = "representation_only"

const STRUCTURAL_TIMEOUT_MS = 800
const STRUCTURAL_MAX_STDOUT_BYTES = 256 * 1024
const STRUCTURAL_MAX_STDERR_BYTES = 4096

const GLOBAL = Object.freeze({
  TOOL: 1n << 0n,
  OPERATION: 1n << 1n,
  BUDGETS: 1n << 2n,
})
const SLOT = Object.freeze({
  ID: 1n << 0n,
  FILE: 1n << 1n,
  OPERATION: 1n << 2n,
  ROLES: 1n << 3n,
  ANCHORS: 1n << 4n,
  EXTENSIONS: 1n << 5n,
  DEPTH: 1n << 6n,
  PATH: 1n << 7n,
})
const HOST = Object.freeze({ VALUE: 1n })
const EVIDENCE = Object.freeze({
  FILE: 1n << 0n,
  ANCHORS: 1n << 1n,
  RAW_SOURCE: 1n << 2n,
  ATTESTED: 1n << 3n,
})

const VISIBLE_KEYS = new Set([
  "tool",
  "operation",
  "host_bindings",
  "existing_slots",
  "create_slots",
  "budgets",
])
const EXISTING_KEYS = new Set([
  "slot",
  "file",
  "evidence_lines",
  "roles",
  "operation",
])
const CREATE_KEYS = new Set([
  "slot",
  "source_file",
  "evidence_lines",
  "allowed_extensions",
  "max_depth",
  "operation",
  "path_contract",
])
const HOST_KEYS = new Set([
  "route_owner",
  "navigation_host",
  "ui_create_source",
  "ui_resource",
  "navigation_resource",
  "navigation_topology",
])
const TOPOLOGY_KEYS = new Set([
  "resource",
  "physical_file",
  "shared_includers",
  "internal_route_targets",
])
const BUDGET_KEYS = new Set([
  "max_operations",
  "max_changed_files",
  "max_create_files",
])
const LEVELS = new Set([
  "anchor",
  "window1",
  "window2",
  "statement",
  "owner",
])

function array(value) {
  return Array.isArray(value) ? value : []
}

function bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
}

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")
}

function maskHex(value) {
  return `0x${value.toString(16)}`
}

function exactKeys(value, allowed) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function scope(id, required, covered) {
  return Object.freeze({
    id,
    required_mask: maskHex(required),
    covered_mask: maskHex(covered),
    complete: (covered & required) === required,
  })
}

function coverageResult(scopes) {
  const ordered = [...scopes].sort((a, b) => a.id.localeCompare(b.id))
  const complete = ordered.every((row) => row.complete)
  return Object.freeze({
    protocol: EXECUTION_CONTEXT_COVERAGE_PROTOCOL,
    complete,
    scope_count: ordered.length,
    sha256: stableSha(ordered),
    scopes: Object.freeze(ordered),
  })
}

function failure(reason, extra = {}) {
  return Object.freeze({
    protocol: EXECUTION_CONTEXT_PLANNER_PROTOCOL,
    ok: false,
    reason,
    coverage_complete: false,
    content: "",
    compiled_bytes: 0,
    selected_evidence_blocks: Object.freeze([]),
    ...extra,
  })
}

export function renderExecutionContractWithCoverage(contract) {
  if (
    contract?.ok !== true ||
    contract?.execution_contract_coverage_complete !== true ||
    !exactKeys(contract?.visible, VISIBLE_KEYS)
  ) {
    return failure("execution_contract_unavailable")
  }

  const visible = contract.visible
  const existing = array(visible.existing_slots)
  const creates = array(visible.create_slots)
  const host = visible.host_bindings ?? {}

  if (
    existing.some((row) => !exactKeys(row, EXISTING_KEYS)) ||
    creates.some((row) => !exactKeys(row, CREATE_KEYS)) ||
    !exactKeys(host, HOST_KEYS) ||
    !exactKeys(visible.budgets, BUDGET_KEYS) ||
    (host.navigation_topology != null &&
      !exactKeys(host.navigation_topology, TOPOLOGY_KEYS))
  ) {
    return failure("execution_contract_shape_unknown")
  }

  const lines = []
  const scopes = []

  let globalCovered = 0n
  lines.push(`EXECUTION tool=${visible.tool} operation=${visible.operation}`)
  globalCovered |= GLOBAL.TOOL | GLOBAL.OPERATION
  lines.push(
    `LIMIT operations=${visible.budgets.max_operations} ` +
    `files=${visible.budgets.max_changed_files} ` +
    `creates=${visible.budgets.max_create_files}`,
  )
  globalCovered |= GLOBAL.BUDGETS
  scopes.push(scope("global", GLOBAL.TOOL | GLOBAL.OPERATION | GLOBAL.BUDGETS, globalCovered))

  for (const row of existing) {
    let covered = 0n
    const roles = array(row.roles).length > 0 ? row.roles.join(",") : "context"
    lines.push(
      `EXISTING slot=${row.slot} file=${row.file} ` +
      `operation=${row.operation} roles=${roles} ` +
      `anchors=${array(row.evidence_lines).join(",")}`,
    )
    covered |= SLOT.ID | SLOT.FILE | SLOT.OPERATION | SLOT.ROLES | SLOT.ANCHORS
    scopes.push(scope(
      `slot:${row.slot}`,
      SLOT.ID | SLOT.FILE | SLOT.OPERATION | SLOT.ROLES | SLOT.ANCHORS,
      covered,
    ))
  }

  for (const row of creates) {
    let covered = 0n
    lines.push(
      `CREATE slot=${row.slot} source=${row.source_file} ` +
      `operation=${row.operation} extensions=${array(row.allowed_extensions).join(",")} ` +
      `max_depth=${row.max_depth} path=${row.path_contract} ` +
      `anchors=${array(row.evidence_lines).join(",")}`,
    )
    covered |=
      SLOT.ID |
      SLOT.FILE |
      SLOT.OPERATION |
      SLOT.ANCHORS |
      SLOT.EXTENSIONS |
      SLOT.DEPTH |
      SLOT.PATH
    scopes.push(scope(
      `slot:${row.slot}`,
      SLOT.ID |
        SLOT.FILE |
        SLOT.OPERATION |
        SLOT.ANCHORS |
        SLOT.EXTENSIONS |
        SLOT.DEPTH |
        SLOT.PATH,
      covered,
    ))
  }

  for (const [key, value] of Object.entries(host)) {
    if (key === "navigation_topology") {
      const topology = value ?? {}
      lines.push(
        `HOST navigation_topology ` +
        `resource=${topology.resource ?? "-"} ` +
        `physical_file=${topology.physical_file ?? "-"} ` +
        `shared_includers=${topology.shared_includers ?? "-"} ` +
        `internal_route_targets=${topology.internal_route_targets ?? "-"}`,
      )
      scopes.push(scope(`host:${key}`, HOST.VALUE, HOST.VALUE))
      continue
    }
    lines.push(`HOST ${key}=${value}`)
    scopes.push(scope(`host:${key}`, HOST.VALUE, HOST.VALUE))
  }

  lines.push("AUTHORITY routing=false mutation=false verification=false")
  const coverage = coverageResult(scopes)
  if (!coverage.complete) {
    return failure("execution_contract_render_coverage_incomplete", { coverage })
  }

  const content = lines.join("\n")
  return Object.freeze({
    protocol: EXECUTION_CONTEXT_PLANNER_PROTOCOL,
    ok: true,
    reason: "execution_contract_rendered",
    content,
    bytes: bytes(content),
    coverage,
    semantic_contract_sha256: contract.contract_sha256,
    renderer_sha256: stableSha(content),
  })
}

export function resolveStructuralContextPlannerBinary(value = process.env.OPENCODE_CONTEXT_PLANNER) {
  if (typeof value === "string" && value.length > 0) return value
  const runtimeDir =
    typeof process.env.OPENCODE_RUNTIME_DIR === "string" &&
    process.env.OPENCODE_RUNTIME_DIR.length > 0
      ? process.env.OPENCODE_RUNTIME_DIR
      : path.join(os.homedir(), ".local", "libexec", "opencode-cpu-agent")
  const installed = path.join(runtimeDir, "opencode-context-planner")
  if (existsSync(installed)) return installed

  // Repository-local fallback exists only for development/CI after the Rust
  // target has been built. Installed plugins still require the attested
  // runtime-stack component above.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const repositoryBuild = path.resolve(
    moduleDir,
    "../../../rust/evidence-distiller/target/release/opencode-context-planner",
  )
  return repositoryBuild
}

function deterministicLineFallback(rows, maxBytes, reason, error = null) {
  const files = rows.map((row) => {
    const anchors = [...new Set(array(row.evidence_lines))]
      .filter((line) => Number.isSafeInteger(line) && line > 0)
      .sort((a, b) => a - b)
    const bounds = (radius) => anchors.map((line) => ({
      start_byte: null,
      end_byte: null,
      start_line: Math.max(1, line - radius),
      end_line: line + radius,
    }))
    return Object.freeze({
      file: row.file,
      critical: row.critical === true,
      language: null,
      parse_status: "planner_unavailable",
      candidates: Object.freeze([
        Object.freeze({
          level: "anchor",
          structural: false,
          ranges: Object.freeze(bounds(0)),
          raw_bytes: null,
          covered_lines: Object.freeze(anchors),
        }),
        Object.freeze({
          level: "window1",
          structural: false,
          ranges: Object.freeze(bounds(1)),
          raw_bytes: null,
          covered_lines: Object.freeze(anchors),
        }),
        Object.freeze({
          level: "window2",
          structural: false,
          ranges: Object.freeze(bounds(2)),
          raw_bytes: null,
          covered_lines: Object.freeze(anchors),
        }),
      ]),
    })
  })
  return Object.freeze({
    ok: true,
    reason: "structural_line_fallback",
    degraded: true,
    fallback_reason: reason,
    error,
    elapsed_ms: 0,
    response: Object.freeze({
      protocol: STRUCTURAL_CONTEXT_PLANNER_PROTOCOL,
      backend: "deterministic-line-fallback",
      authority: STRUCTURAL_CONTEXT_PLANNER_AUTHORITY,
      byte_authority: false,
      budget_bytes: maxBytes ?? 0,
      files_total: files.length,
      parsed_files: 0,
      fallback_files: files.length,
      elapsed_ms: 0,
      files: Object.freeze(files),
    }),
  })
}

export function runStructuralContextPlanner({
  root,
  rows,
  maxBytes,
  binary = resolveStructuralContextPlannerBinary(),
  timeoutMs = STRUCTURAL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    if (typeof root !== "string" || root.length < 1 || !Array.isArray(rows) || rows.length < 1) {
      resolve({ ok: false, reason: "structural_request_invalid", elapsed_ms: 0 })
      return
    }
    const started = performance.now()
    let child
    try {
      child = spawn(binary, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) {
      resolve(deterministicLineFallback(
        rows,
        maxBytes,
        "structural_spawn_error",
        String(error?.message ?? error),
      ))
      return
    }
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
        elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > STRUCTURAL_MAX_STDOUT_BYTES) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= STRUCTURAL_MAX_STDERR_BYTES) return
      const remaining = STRUCTURAL_MAX_STDERR_BYTES - stderrBytes
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
      stderr.push(Buffer.from(kept))
      stderrBytes += kept.length
    })
    child.stdin.on("error", () => {})
    child.on("error", (error) => finish(
      deterministicLineFallback(
        rows,
        maxBytes,
        "structural_spawn_error",
        String(error?.message ?? error),
      ),
    ))
    child.on("close", (code, signal) => {
      if (settled) return
      const error = Buffer.concat(stderr).toString("utf8").trim() || null
      if (timedOut) return finish(
        deterministicLineFallback(rows, maxBytes, "structural_timeout", error),
      )
      if (outputLimited) return finish(
        deterministicLineFallback(rows, maxBytes, "structural_stdout_limit", error),
      )
      if (code !== 0) return finish(
        deterministicLineFallback(
          rows,
          maxBytes,
          `structural_exit_error:${code}:${signal ?? "none"}`,
          error,
        ),
      )
      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (parseError) {
        return finish(deterministicLineFallback(
          rows,
          maxBytes,
          "structural_invalid_json",
          String(parseError?.message ?? parseError),
        ))
      }
      const checked = validateStructuralResponse(response, rows)
      if (!checked.ok) {
        return finish(deterministicLineFallback(
          rows,
          maxBytes,
          checked.reason,
        ))
      }
      finish({
        ok: true,
        reason: "structural_plan_ready",
        degraded: false,
        response,
      })
    })
    try {
      child.stdin.end(JSON.stringify({
        protocol: "context-plan-request-v1",
        root,
        budget_bytes: maxBytes,
        files: rows.map((row) => ({
          file: row.file,
          evidence_lines: row.evidence_lines,
          critical: row.critical === true,
        })),
      }))
    } catch (error) {
      child.kill("SIGKILL")
      finish(deterministicLineFallback(
        rows,
        maxBytes,
        "structural_stdin_error",
        String(error?.message ?? error),
      ))
    }
  })
}

function rangesCover(ranges, lines) {
  return lines.every((line) => ranges.some(
    (range) => range.start_line <= line && line <= range.end_line,
  ))
}

export function validateStructuralResponse(response, rows) {
  if (
    response?.protocol !== STRUCTURAL_CONTEXT_PLANNER_PROTOCOL ||
    response?.authority !== STRUCTURAL_CONTEXT_PLANNER_AUTHORITY ||
    !Array.isArray(response?.files)
  ) {
    return { ok: false, reason: "structural_protocol_invalid" }
  }
  const expected = new Map(rows.map((row) => [row.file, row]))
  if (response.files.length !== expected.size) {
    return { ok: false, reason: "structural_file_set_incomplete" }
  }
  const seen = new Set()
  for (const file of response.files) {
    const row = expected.get(file?.file)
    if (!row || seen.has(file.file) || !Array.isArray(file?.candidates)) {
      return { ok: false, reason: "structural_file_invalid" }
    }
    seen.add(file.file)
    if (!file.candidates.some((candidate) => candidate?.level === "anchor")) {
      return { ok: false, reason: "structural_anchor_candidate_missing" }
    }
    for (const candidate of file.candidates) {
      if (!LEVELS.has(candidate?.level) || !Array.isArray(candidate?.ranges)) {
        return { ok: false, reason: "structural_candidate_invalid" }
      }
      const ranges = candidate.ranges
      if (
        ranges.length < 1 ||
        ranges.some((range) =>
          !Number.isSafeInteger(range?.start_line) ||
          !Number.isSafeInteger(range?.end_line) ||
          range.start_line < 1 ||
          range.end_line < range.start_line ||
          (
            candidate.structural === true &&
            (
              !Number.isSafeInteger(range?.start_byte) ||
              !Number.isSafeInteger(range?.end_byte) ||
              range.start_byte < 0 ||
              range.end_byte <= range.start_byte
            )
          ) ||
          (
            candidate.structural !== true &&
            !(
              (range?.start_byte == null && range?.end_byte == null) ||
              (
                Number.isSafeInteger(range?.start_byte) &&
                Number.isSafeInteger(range?.end_byte) &&
                range.start_byte >= 0 &&
                range.end_byte > range.start_byte
              )
            )
          ),
        ) ||
        !rangesCover(ranges, row.evidence_lines)
      ) {
        return { ok: false, reason: "structural_candidate_coverage_invalid" }
      }
    }
  }
  return { ok: true, reason: "structural_response_valid" }
}

function candidateByLevel(filePlan, level) {
  return array(filePlan?.candidates).find((candidate) => candidate?.level === level) ?? null
}

function candidateSequence(filePlan) {
  if (filePlan?.parse_status === "parsed") {
    return ["anchor", "statement", "owner"]
      .map((level) => candidateByLevel(filePlan, level))
      .filter(Boolean)
  }
  return ["anchor", "window1", "window2"]
    .map((level) => candidateByLevel(filePlan, level))
    .filter(Boolean)
}

function renderEvidenceCandidate({ row, source, candidate }) {
  const sourceLines = String(source).split(/\r?\n/u)
  const emitted = new Map()
  for (const range of candidate.ranges) {
    const start = Math.max(1, range.start_line)
    const end = Math.min(sourceLines.length, range.end_line)
    for (let line = start; line <= end; line += 1) {
      if (!emitted.has(line)) emitted.set(line, sourceLines[line - 1] ?? "")
    }
  }
  if (!row.evidence_lines.every((line) => emitted.has(line))) return null
  const header =
    `SOURCE file=${row.file} level=${candidate.level} ` +
    `anchors=${row.evidence_lines.join(",")}`
  const body = [...emitted.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, text]) => `${line}|${text}`)
  return Object.freeze({
    block: [header, ...body].join("\n"),
    level: candidate.level,
    structural: candidate.structural === true,
    rendered_lines: body.length,
  })
}

function evidenceCoverage(row, selected) {
  const required = EVIDENCE.FILE | EVIDENCE.ANCHORS | EVIDENCE.RAW_SOURCE | EVIDENCE.ATTESTED
  let covered = 0n
  if (selected?.block?.includes(`file=${row.file}`)) covered |= EVIDENCE.FILE
  if (selected && row.evidence_lines.length > 0) covered |= EVIDENCE.ANCHORS
  if (selected?.rendered_lines > 0) covered |= EVIDENCE.RAW_SOURCE
  if (row.attested === true) covered |= EVIDENCE.ATTESTED
  return scope(`evidence:${row.file}`, required, covered)
}

function replaceBlock(content, oldBlock, newBlock) {
  if (!oldBlock) return `${content}\n\n${newBlock}`
  const needle = `\n\n${oldBlock}`
  if (!content.includes(needle)) return null
  return content.replace(needle, `\n\n${newBlock}`)
}

export function packExecutionContext({
  contract,
  rows,
  criticalFiles,
  sources,
  structuralResponse,
  maxBytes,
} = {}) {
  const renderedContract = renderExecutionContractWithCoverage(contract)
  if (!renderedContract.ok) return renderedContract
  const budget = Number(maxBytes)
  if (!Number.isSafeInteger(budget) || budget < 1) return failure("context_budget_invalid")

  const planByFile = new Map(array(structuralResponse?.files).map((row) => [row.file, row]))
  const rowByFile = new Map(rows.map((row) => [row.file, row]))
  const critical = [...criticalFiles].sort()
  const selected = new Map()
  let content = renderedContract.content

  for (const file of critical) {
    const row = rowByFile.get(file)
    const filePlan = planByFile.get(file)
    const candidate = candidateByLevel(filePlan, "anchor")
    const source = sources.get(file)
    if (!row || !candidate || typeof source !== "string") {
      return failure("critical_context_plan_missing", {
        failed_file: file,
        execution_contract_bytes: renderedContract.bytes,
      })
    }
    const rendered = renderEvidenceCandidate({ row, source, candidate })
    if (!rendered) return failure("critical_context_anchor_coverage_lost", { failed_file: file })
    const next = `${content}\n\n${rendered.block}`
    if (bytes(next) > budget) {
      return failure("required_context_over_budget", {
        failed_file: file,
        execution_contract_bytes: renderedContract.bytes,
        minimum_required_bytes: bytes(next),
        over_budget_bytes: bytes(next) - budget,
      })
    }
    content = next
    selected.set(file, rendered)
  }

  const minimumRequiredBytes = bytes(content)

  // Deterministic monotonic enrichment. Parsed files use structural levels;
  // unsupported/invalid parse files use bounded line windows. No relevance
  // score or model call participates in this selection.
  for (const file of critical) {
    const row = rowByFile.get(file)
    const filePlan = planByFile.get(file)
    const source = sources.get(file)
    const sequence = candidateSequence(filePlan)
    for (const candidate of sequence.slice(1)) {
      const rendered = renderEvidenceCandidate({ row, source, candidate })
      if (!rendered) continue
      const prior = selected.get(file)
      const candidateContent = replaceBlock(content, prior?.block, rendered.block)
      if (candidateContent && bytes(candidateContent) <= budget) {
        content = candidateContent
        selected.set(file, rendered)
      }
    }
  }

  const optional = rows
    .filter((row) => !criticalFiles.has(row.file))
    .sort((a, b) => a.tier - b.tier || a.file.localeCompare(b.file))
  const droppedFiles = []
  for (const row of optional) {
    const filePlan = planByFile.get(row.file)
    const candidate = candidateByLevel(filePlan, "anchor")
    const source = sources.get(row.file)
    if (!candidate || typeof source !== "string") {
      droppedFiles.push(row.file)
      continue
    }
    const rendered = renderEvidenceCandidate({ row, source, candidate })
    if (!rendered) {
      droppedFiles.push(row.file)
      continue
    }
    const next = `${content}\n\n${rendered.block}`
    if (bytes(next) > budget) {
      droppedFiles.push(row.file)
      continue
    }
    content = next
    selected.set(row.file, rendered)
  }

  const evidenceScopes = critical.map((file) =>
    evidenceCoverage(rowByFile.get(file), selected.get(file)),
  )
  const evidenceCoverageProof = coverageResult(evidenceScopes)
  if (!evidenceCoverageProof.complete) {
    return failure("critical_evidence_coverage_incomplete", {
      evidence_coverage: evidenceCoverageProof,
    })
  }

  const selectedBlocks = rows
    .filter((row) => selected.has(row.file))
    .sort((a, b) => a.tier - b.tier || a.file.localeCompare(b.file))
    .map((row) => {
      const rendered = selected.get(row.file)
      return Object.freeze({
        file: row.file,
        sha256: row.sha256,
        evidence_lines: Object.freeze([...row.evidence_lines]),
        roles: Object.freeze([...row.roles]),
        tier: row.tier,
        level: rendered.level,
        structural: rendered.structural,
        block: rendered.block,
      })
    })

  const selectedLevels = Object.freeze(selectedBlocks.map((row) => Object.freeze({
    file: row.file,
    level: row.level,
    structural: row.structural,
  })))

  return Object.freeze({
    protocol: EXECUTION_CONTEXT_PLANNER_PROTOCOL,
    ok: true,
    reason: droppedFiles.length > 0
      ? "bounded_context_with_optional_drops"
      : "bounded_context_complete",
    content,
    compiled_bytes: bytes(content),
    execution_contract_bytes: renderedContract.bytes,
    minimum_required_bytes: minimumRequiredBytes,
    over_budget_bytes: 0,
    semantic_coverage_complete: true,
    contract_coverage: renderedContract.coverage,
    evidence_coverage: evidenceCoverageProof,
    coverage_scope_count:
      renderedContract.coverage.scope_count + evidenceCoverageProof.scope_count,
    coverage_sha256: stableSha({
      contract: renderedContract.coverage.sha256,
      evidence: evidenceCoverageProof.sha256,
    }),
    renderer_sha256: renderedContract.renderer_sha256,
    selected_evidence_blocks: Object.freeze(selectedBlocks),
    selected_levels: selectedLevels,
    selected_files: Object.freeze(selectedBlocks.map((row) => row.file)),
    dropped_files: Object.freeze(droppedFiles),
  })
}
