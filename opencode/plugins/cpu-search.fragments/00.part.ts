import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  TASK_ACTION_PROTOCOL,
  compileTaskAction,
  unresolvedTaskAction,
} from "./cpu-search-core/task-action-v1.mjs"
import {
  TASK_SEARCH_PLAN_PROTOCOL,
  compileTaskSearchPlanForState,
} from "./cpu-search-core/task-search-plan-v1.mjs"
import {
  ACTION_COMMIT_DISPATCH_ORIGIN,
  ACTION_COMMIT_PROTOCOL,
  claimActionCommit,
  deriveActionCommit,
} from "./cpu-search-core/action-commit-v1.mjs"
import {
  TERMINAL_COMMIT_PROTOCOL,
  claimTerminalCommit,
  deriveTerminalCommit,
  terminalCommitMatchesTask,
} from "./cpu-search-core/terminal-commit-v1.mjs"

const MAX_QUERIES = 4
const LINE_HIT_CAP_PER_QUERY = 1000
const FILE_DISCOVERY_CAP_PER_QUERY = 5000
const PROBE_MAX_FILES = 8
const EMIT_MAX_FILES = 4
const PROBE_MATCH_SIGNAL_CAP = 3
const ROUTE_BODY_BUDGET_BYTES = 700
const CONTEXT_RADIUS = 2

const QUERY_CACHE_MAX_ENTRIES_PER_TURN = 16
const QUERY_CACHE_MAX_MATCHES_PER_TURN = 4000

const INDEX_BODY_BUDGET_BYTES = 1400
const INDEX_MAX_FILES_PER_QUERY = 5
const INDEX_MAX_STRUCTURAL_GROUPS = 6
const INDEX_FACET_TEXT_MAX = 80

const MAX_OUTPUT_BYTES = 6500
const BODY_BUDGET_BYTES = 5000
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024
const QUERY_TIMEOUT_MS = 1500

// Structural BM25F/RRF is routing-only. Failure must preserve the existing
// lexical relevance order and can never authorize mutation.
const RETRIEVAL_RANKER_PROTOCOL = "retrieval-ranker-v1"
const RETRIEVAL_RANKER_AUTHORITY = "routing_only"
const RETRIEVAL_RANKER_TIMEOUT_MS = 1500
const RETRIEVAL_RANKER_MAX_STDOUT_BYTES = 256 * 1024
const RETRIEVAL_RANKER_MAX_FILES = 32

// Semantic source validation is shadow-only in v2.24. It observes existing
// source-validated Impact edges but cannot change routing, emit, or mutation
// authority.
const SEMANTIC_RESOLVER_PROTOCOL = "semantic-resolver-v1.1"
const SEMANTIC_RESOLVER_AUTHORITY = "shadow_semantic"
const SEMANTIC_RESOLVER_TIMEOUT_MS = 1500
const SEMANTIC_RESOLVER_MAX_STDOUT_BYTES = 256 * 1024
const SEMANTIC_IMPACT_MAX_QUERIES = 8
const SEMANTIC_IMPACT_MAX_RESULTS = 8
const SEMANTIC_IMPACT_WITNESS_WINDOW_LINES = 12

const QUERY_COMPILER_MIN_TOKENS = 2
const QUERY_COMPILER_MAX_TOKENS = 6

const QUERY_FORMULATION_PROTOCOL = "query-formulation-v2"
const QUERY_FORMULATION_MAX_BRANCHES = 4
const QUERY_FORMULATION_MAX_ATOMS = 8
const QUERY_FORMULATION_MAX_ATOMS_PER_BRANCH = 5
const QUERY_FORMULATION_MIN_FILE_ATOMS = 2
const QUERY_FORMULATION_MIN_COVERAGE_RATIO = 0.5
const QUERY_FORMULATION_MAX_FILES = PROBE_MAX_FILES * 3

const QUERY_COMPILER_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "when",
  "then",
  "this",
  "that",
])

const DISTILLER_TIMEOUT_MS = 500
const DISTILLER_MAX_STDOUT_BYTES = 512 * 1024
const DISTILLER_RAW_BODY_PRESSURE_BYTES = 2500
const DISTILLER_MAX_HITS_PER_FILE = 12
const DISTILLER_IR_BUDGET_BYTES = 32 * 1024

const IMPACT_INDEX_REFRESH_TIMEOUT_MS = 800
const IMPACT_INDEX_QUERY_TIMEOUT_MS = 150
const IMPACT_INDEX_MAX_STDOUT_BYTES = 128 * 1024
const IMPACT_INDEX_MAX_SEEDS = PROBE_MAX_FILES
const IMPACT_INDEX_MAX_NEIGHBORS = 24
const IMPACT_INDEX_REFRESH_TTL_MS = 120_000
const IMPACT_GRAPH_PROBE_MAX_FILES = 2
const IMPACT_GRAPH_EMIT_MAX_FILES = 1
const IMPACT_BINDINGS_PER_CANDIDATE = 4
const IMPACT_EDGE_SYMBOL_CAP = 16
const IMPACT_VALIDATION_SYMBOL_CAP = IMPACT_EDGE_SYMBOL_CAP
const IMPACT_SCOPE_IDENTIFIER_CAP = 160
const IMPACT_FILTER_SYMBOL_CAP = IMPACT_SCOPE_IDENTIFIER_CAP
const IMPACT_VALIDATION_TIMEOUT_MS = 350
const IMPACT_VALIDATION_HIT_CAP = 8
const IMPACT_SCOPE_WINDOW_RADIUS = 12
const IMPACT_SCOPE_MAX_LINES = 180
const HYBRID_MIN_SAVINGS_RATIO = 0.75
const HYBRID_CONTEXT_RADIUS = 1
const HYBRID_CONTEXT_SAMPLES_PER_GROUP = 3

const FOCUSED_PROBE_MAX_LINE_HITS = 24
const FOCUSED_PROBE_MAX_EXACT_MATCHES = 32
const FOCUSED_PROBE_MAX_HITS_PER_FILE = 8
const FOCUSED_MAX_SCOPES = 3
const FOCUSED_SUPPLEMENT_MAX_BYTES = 2600
const FOCUSED_FULL_SCOPE_MAX_LINES = 96
const FOCUSED_SCOPE_HEADER_LINES = 3
const FOCUSED_WINDOW_RADII = [20, 12, 6, 2]
const FOCUSED_MIN_SUPPLEMENT_BYTES = 128
const FOCUSED_MAX_OVERHEAD_BYTES = 256
const FOCUSED_MAX_OVERHEAD_RATIO = 1.12

const REGION_MAX_SCOPES = 3
const REGION_BODY_BUDGET_BYTES = 2200
const REGION_SAMPLE_HITS_PER_SCOPE = 3
const REGION_SAMPLE_RADIUS = 1

const EVIDENCE_LEDGER_MAX_FACTS_PER_TURN = 12000
const ROUTE_LEDGER_MAX_FACTS_PER_TURN = 4000
const CONTEXTUALIZED_HITS_MAX_PER_TURN = 4000
const MAX_CONSECUTIVE_NO_PROGRESS = 2

// Final Scout boundary. Search semantics stay bounded; the new work is a
// deterministic, machine-readable handoff for the next execution stage.
const SCOUT_HANDOFF_PROTOCOL = "scout-handoff-v1"
const SCOUT_LOCAL_CAPABILITY_PROTOCOL = "scout-local-capability-v1"
const SCOUT_RENAME_TARGET_PROTOCOL = "scout-rename-target-v2"
const SCOUT_OWNER_ATTESTATION_PROTOCOL = "owner-attestation-v1"
const SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS = Object.freeze(["replace_node"])
const SCOUT_LOCAL_CAPABILITY_MAX_COMPETITOR_FILES = 4
const SCOUT_LOCAL_CAPABILITY_ALLOWED_PARTIAL_REASONS = new Set([
  "retained_unread_files",
  "retained_unemitted_files",
  "evidence_incomplete",
  "impact_index_partial",
])
const SCOUT_HANDOFF_HASH_MAX_BYTES = 8 * 1024 * 1024
const SCOUT_HANDOFF_MAX_LINES_PER_FILE = 32

// Mutation/action plane. Search semantics stay independent: the model submits
// semantic intent, while compiler/executor/verifier deterministically bind it
// to capability-authorized source and bounded physical mutation.
const PATCH_COMPILER_PROTOCOL = "patch-compiler-v2"
const PATCH_MUTATION_PROTOCOL = "mutation-plan-v1"
const PATCH_TOOL_PROTOCOL = "semantic-mutation-tool-v1"
const MUTATION_TOOL_ABI_PROTOCOL = "capability-mutation-tools-v2"
const EXECUTE_REPLACE_NODE_TOOL = "execute_replace_node"
const EXECUTE_RENAME_SYMBOL_TOOL = "execute_rename_symbol"
const MUTATION_TOOL_NAMES = Object.freeze([
  EXECUTE_REPLACE_NODE_TOOL,
  EXECUTE_RENAME_SYMBOL_TOOL,
])
const PATCH_PERMISSION_ACTION = "execute_patch"
const PATCH_EXECUTOR_PROTOCOL = "patch-executor-v3"
const PATCH_EDIT_PROTOCOL = "edit-script-v3-certified-slice"
const MUTATION_CONFINEMENT_PROTOCOL = "mutation-slice-v1"
const CANDIDATE_VALIDITY_PROTOCOL = "candidate-validity-v1"
const EXECUTION_LOOP_PROTOCOL = "execution-loop-v1"
const PATCH_RECEIPT_PROTOCOL = "patch-receipt-v1"
const INVARIANT_VERIFIER_PROTOCOL = "invariant-verifier-v2"
const VERIFICATION_RECEIPT_PROTOCOL = "verification-receipt-v1"
const COMPLETION_AUTHORIZER_REQUEST_PROTOCOL = "completion-authorizer-request-v1"
const COMPLETION_AUTHORIZER_PROTOCOL = "completion-authorizer-v1"
const COMPLETION_AUTHORIZER_POLICY = "exact-rename-v1"
const COMPLETION_SAFE_FAIL_PROTOCOL = "completion-safe-fail-v1"
const COMPLETION_SAFE_FAIL_OUTCOME = "SAFE_FAIL"
// Wall-clock limits in the deterministic mutation plane are hard liveness
// watchdogs, not capability or correctness budgets. Actual mutation scope is
// bounded independently by files, edits, lines, bytes, checks, evidence and
// attempt budgets. Keep one conservative ceiling so transient CPU/I/O pressure
// cannot turn the same valid bounded plan into a different correctness result.
const PATCH_STAGE_HARD_WATCHDOG_MS = 30_000

const PATCH_COMPILER_TIMEOUT_MS = PATCH_STAGE_HARD_WATCHDOG_MS
const PATCH_COMPILER_MAX_STDOUT_BYTES = 256 * 1024
const PATCH_EXECUTOR_TIMEOUT_MS = PATCH_STAGE_HARD_WATCHDOG_MS
const PATCH_EXECUTOR_MAX_STDOUT_BYTES = 256 * 1024
const INVARIANT_VERIFIER_TIMEOUT_MS = PATCH_STAGE_HARD_WATCHDOG_MS
const INVARIANT_VERIFIER_MAX_STDOUT_BYTES = 256 * 1024
// Native completion authorization benchmarks at ~1 ms median / ~1.4 ms p95.
// This is only a liveness watchdog. Timeout/ABSTAIN withholds terminal
// optimization; the verified PATCH_READY candidate remains valid and the
// ordinary agent loop may continue.
const COMPLETION_AUTHORIZER_TIMEOUT_MS = 500
const COMPLETION_AUTHORIZER_MAX_STDOUT_BYTES = 64 * 1024
const MAX_PATCH_ATTEMPTS_PER_TURN = 2

// v2.16-B: deterministic runtime identity.
// The installer is authoritative for cryptographic hashes. The plugin reads
// the small manifest and performs cheap path/size checks; it never hashes
// ~40 MB binaries on the patch hot path.
const RUNTIME_STACK_PROTOCOL = "runtime-stack-v1"
const RUNTIME_STACK_MANIFEST = ".runtime-stack-v1.json"
const RUNTIME_STACK_COMPONENTS = {
  compiler: "opencode-patch-compiler",
  executor: "opencode-patch-executor",
  verifier: "opencode-invariant-verifier",
  impact_index: "opencode-impact-index",
}

let runtimeStackManifestCache = null

// v2.15-B: explicit causal controller. The model never chooses between tools
// when deterministic preconditions already identify the only valid next action.
const EXECUTION_FSM_PROTOCOL = "causal-execution-fsm-v1"
const TOOL_FRONTIER_PROTOCOL = "causal-tool-frontier-v2.5-deterministic-action"
const TASK_CONTEXT_PROTOCOL = "task-context-v1"
const TASK_CONTEXT_ADAPTER_PROTOCOL = "task-context-adapter-v1.1-json-string"
const MUTATION_INTENT_PROTOCOL = "mutation-intent-grammar-v1"
const TASK_CONTEXT_MAX_TEXT_BYTES = 16 * 1024
const TASK_CONTEXT_MAX_PARTS = 64
const TASK_CONTEXT_MAX_REPORTED_PART_TYPES = 16
const TASK_CONTEXT_MAX_REPORTED_SOURCES = 8
const EDIT_CAPSULE_PROTOCOL = "edit-capsule-v1"
const EDIT_CAPSULE_RENDER_CONTRACT = "transactional-scope-v1"
const PROOF_OBLIGATION_PROTOCOL = "proof-obligation-v1"
const EXEC_STATE_LOCATE = "locate"
const EXEC_STATE_MUTATE = "mutate"
const EXEC_STATE_REPAIR = "repair"
const EXEC_STATE_DONE = "done"
const EXEC_STATE_SAFE_FAIL = "safe_fail"
const EDIT_CAPSULE_MAX_BYTES = 4600
const EDIT_CAPSULE_MAX_SCOPES = 4
const EDIT_CAPSULE_FULL_SCOPE_MAX_LINES = 80
const EDIT_CAPSULE_WINDOW_RADIUS = 6
const MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"
const MUTATION_CANDIDATE_MAX = EDIT_CAPSULE_MAX_SCOPES

const SEARCH_PROTOCOL = "search-v2.24.0-semantic-impact-shadow"
const AGENT_PROTOCOL = "cpu-agent-v2.8.0-mutation-confinement-2"

const MAX_SEARCH_ATTEMPTS_PER_TURN = 6
const MAX_EXECUTED_SEARCHES_PER_TURN = 4
const MAX_TURN_EVIDENCE_BYTES = 8192

const MAX_MODEL_CALLS_PER_TURN = 4
const MAX_TURN_WALL_MS = 120_000

// v2.27-C: proof-carrying terminalization. The verifier remains authority;
// this layer only prevents a redundant provider turn after immutable proof.
const TERMINAL_ARTIFACT_MAX_BYTES = 512 * 1024
const TERMINAL_SHORT_CIRCUIT_ENABLED =
  process.env.OPENCODE_CPU_AGENT_TERMINAL_SHORT_CIRCUIT !== "0"

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_TRACKED_SESSIONS = 256

const EXCLUDES = [
  "!.git/**",
  "!.opencode/**",
  "!.agentbench/**",
  "!node_modules/**",
  "!**/node_modules/**",
  "!.venv/**",
  "!**/.venv/**",
  "!venv/**",
  "!**/venv/**",
  "!__pycache__/**",
  "!**/__pycache__/**",
  "!dist/**",
  "!**/dist/**",
  "!build/**",
  "!**/build/**",
]

const SOURCE_GLOB_INVENTORY_PROTOCOL = "source-glob-inventory-v1"
const SOURCE_GLOB_INVENTORY_TIMEOUT_MS = 500
const SOURCE_GLOB_INVENTORY_MAX_FILES = 20_000
const SOURCE_GLOB_INVENTORY_MAX_STDOUT_BYTES = 2 * 1024 * 1024
const SOURCE_GLOB_FALLBACK_MAX_EXTENSIONS = 12
const SOURCE_LANGUAGE_EXTENSIONS = Object.freeze([
  "py",
  "pyi",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "sql",
])
const SOURCE_LANGUAGE_EXTENSION_SET = new Set(SOURCE_LANGUAGE_EXTENSIONS)

function appendSearchGlobs(args, glob) {
  // ripgrep glob precedence is order-sensitive.
  // User glob constrains search first; reserved exclusions are applied last
  // and are therefore authoritative.
  if (glob) args.push("-g", glob)

  for (const pattern of EXCLUDES) {
    args.push("-g", pattern)
  }
}

function sourceExtensionFromFile(file) {
  const normalized = evidenceFileKey(file).toLowerCase()
  const ext = path.posix.extname(normalized)
  return ext.startsWith(".") ? ext.slice(1) : ""
}

function parseSimpleLanguageGlob(glob) {
  if (
    typeof glob !== "string" ||
    glob.length < 1 ||
    glob.startsWith("!") ||
    glob.includes("\\")
  ) {
    return null
  }

  let match = /^(.*\*)\.([a-z0-9]+)$/.exec(glob)
  let extensions = null

  if (match) {
    extensions = [match[2]]
  } else {
    match = /^(.*\*)\.\{([a-z0-9]+(?:,[a-z0-9]+)+)\}$/.exec(glob)
    if (match) extensions = match[2].split(",")
  }

  if (!match || !extensions) return null

  const unique = [...new Set(extensions)]
  if (
    unique.length < 1 ||
    unique.some((ext) => !SOURCE_LANGUAGE_EXTENSION_SET.has(ext))
  ) {
    return null
  }

  return {
    prefix: match[1],
    extensions: unique,
  }
}

function buildLanguageGlob(prefix, extensions) {
  const unique = [...new Set(extensions ?? [])]
    .filter((ext) => SOURCE_LANGUAGE_EXTENSION_SET.has(ext))
    .sort()

  if (unique.length < 1) return null
  if (unique.length === 1) return `${prefix}.${unique[0]}`
  return `${prefix}.{${unique.join(",")}}`
}

function sourceInventoryCacheKey(target, prefix) {
  return JSON.stringify({
    protocol: SOURCE_GLOB_INVENTORY_PROTOCOL,
    target,
    prefix,
  })
}

function runSourceGlobInventory(root, target, prefix) {
  return new Promise((resolve) => {
    const patterns = SOURCE_LANGUAGE_EXTENSIONS.map(
      (ext) => `${prefix}.${ext}`,
    )

    const args = ["--files", "-0"]
    for (const pattern of patterns) args.push("-g", pattern)
    for (const pattern of EXCLUDES) args.push("-g", pattern)
    args.push("--", target)

    const child = spawn("rg", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const counts = new Map()
    let files = 0
    let stdoutBytes = 0
    let stderr = ""
    let pending = ""
    let timedOut = false
    let scanCapped = false
    let settled = false
    let spawnError = null

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, SOURCE_GLOB_INVENTORY_TIMEOUT_MS)

    function consumeFile(raw) {
      if (!raw || scanCapped) return

      files += 1
      if (files > SOURCE_GLOB_INVENTORY_MAX_FILES) {
        scanCapped = true
        child.kill("SIGKILL")
        return
      }

      const ext = sourceExtensionFromFile(raw)
      if (!SOURCE_LANGUAGE_EXTENSION_SET.has(ext)) return
      counts.set(ext, (counts.get(ext) ?? 0) + 1)
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > SOURCE_GLOB_INVENTORY_MAX_STDOUT_BYTES) {
        scanCapped = true
        child.kill("SIGKILL")
        return
      }

      pending += chunk.toString("utf8")
      let index
      while ((index = pending.indexOf("\0")) >= 0) {
        consumeFile(pending.slice(0, index))
        pending = pending.slice(index + 1)
        if (scanCapped) break
      }
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      spawnError = String(error?.message ?? error)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (pending.length > 0 && !scanCapped) consumeFile(pending)

      const exitOk = code === 0 || code === 1
      const error = spawnError ?? (!exitOk && !timedOut && !scanCapped
        ? (stderr.trim() || `rg_exit_${code}`)
        : null)
      const complete =
        !timedOut &&
        !scanCapped &&
        !error

      resolve({
        protocol: SOURCE_GLOB_INVENTORY_PROTOCOL,
        complete,
        timedOut,
        scanCapped,
        error,
        files,
        extensions: Object.fromEntries(
          [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
      })
    })
  })
}

async function sourceGlobInventory(root, target, prefix, state) {
  const key = sourceInventoryCacheKey(target, prefix)
  const cached = state?.sourceInventoryCache?.get(key)
  if (cached) return { ...cached, cacheHit: true }

  const result = await runSourceGlobInventory(root, target, prefix)

  if (state?.sourceInventoryCache instanceof Map) {
    state.sourceInventoryCache.set(key, result)
  }

  return { ...result, cacheHit: false }
}

async function resolveSearchLanguageGlob(root, target, requestedGlob, state) {
  const base = {
    protocol: SOURCE_GLOB_INVENTORY_PROTOCOL,
    requestedGlob: requestedGlob ?? null,
    effectiveGlob: requestedGlob,
    corrected: false,
    reason: null,
    inventoryComplete: null,
    inventoryFiles: 0,
    inventoryExtensions: {},
    inventoryCacheHit: false,
  }

  const parsed = parseSimpleLanguageGlob(requestedGlob)
  if (!parsed) return base

  let info
  try {
    info = await stat(path.resolve(root, target))
  } catch {
    return {
      ...base,
      reason: "target_stat_unavailable",
    }
  }

  if (info.isFile()) {
    const ext = sourceExtensionFromFile(target)
    if (
      !SOURCE_LANGUAGE_EXTENSION_SET.has(ext) ||
      parsed.extensions.includes(ext)
    ) {
      return {
        ...base,
        reason: "explicit_file_glob_compatible",
      }
    }

    return {
      ...base,
      effectiveGlob: undefined,
      corrected: true,
      reason: "explicit_file_path_overrides_absent_language_glob",
      inventoryComplete: true,
      inventoryFiles: 1,
      inventoryExtensions: { [ext]: 1 },
    }
  }

  if (!info.isDirectory()) {
    return {
      ...base,
      reason: "target_not_file_or_directory",
    }
  }

  const inventory = await sourceGlobInventory(
    root,
    target,
    parsed.prefix,
    state,
  )

  const resultBase = {
    ...base,
    inventoryComplete: inventory.complete === true,
    inventoryFiles: inventory.files ?? 0,
    inventoryExtensions: inventory.extensions ?? {},
    inventoryCacheHit: inventory.cacheHit === true,
  }

  if (inventory.complete !== true) {
    return {
      ...resultBase,
      reason: "source_inventory_incomplete",
    }
  }

  if (
    parsed.extensions.some(
      (ext) => (inventory.extensions?.[ext] ?? 0) > 0,
    )
  ) {
    return {
      ...resultBase,
      reason: "requested_language_present",
    }
  }

  const fallbackExtensions = Object.keys(inventory.extensions ?? {})
    .filter((ext) => (inventory.extensions?.[ext] ?? 0) > 0)
    .sort()

  if (fallbackExtensions.length < 1) {
    return {
      ...resultBase,
      reason: "no_supported_source_files",
    }
  }

  if (fallbackExtensions.length > SOURCE_GLOB_FALLBACK_MAX_EXTENSIONS) {
    return {
      ...resultBase,
      reason: "fallback_extension_set_too_wide",
    }
  }

  const effectiveGlob = buildLanguageGlob(
    parsed.prefix,
    fallbackExtensions,
  )

  if (!effectiveGlob) {
    return {
      ...resultBase,
      reason: "fallback_glob_unavailable",
    }
  }

  return {
    ...resultBase,
    effectiveGlob,
    corrected: true,
    reason: "requested_language_absent",
  }
}

function isReservedAgentEvidencePath(raw) {
  const normalized = String(raw ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")

  return (
    normalized === ".opencode" ||
    normalized.startsWith(".opencode/")
  )
}

function bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8")
}

function nowMs() {
  return Date.now()
}

function clipLine(text, max = 500) {
  const line = String(text ?? "").replace(/\r?\n/g, "").trimEnd()
  return line.length <= max ? line : line.slice(0, max) + " …[line clipped]"
}

async function normalizeDirectory(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null

  try {
    const resolved = await realpath(raw)
    const info = await stat(resolved)
    return info.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

async function writeProjectTrace(root, fileName, record) {
  if (!root) return

  try {
    const dir = path.join(root, ".opencode")
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, fileName), JSON.stringify(record) + "\n", "utf8")
  } catch {
    // Telemetry is best-effort and must never break the agent.
  }
}

function scoutOpaqueKey(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 20)
}

function clearTerminalCommitState(state) {
  if (!state) return
  state.terminalCommit = null
  state.terminalCommitSha256 = null
  state.terminalCommitClaims = 0
  state.terminalShortCircuitAttemptedSha256 = null
  state.terminalShortCircuitRequests = 0
  state.terminalShortCircuits = 0
  state.terminalShortCircuitFailures = 0
}

function clearCompletionSafeFailState(state) {
  if (!state) return
  state.completionSafeFail = null
  state.completionSafeFailSha256 = null
  state.completionSafeFailClaims = 0
  state.completionSafeFailShortCircuitAttemptedSha256 = null
  state.completionSafeFailShortCircuitRequests = 0
  state.completionSafeFailShortCircuits = 0
  state.completionSafeFailShortCircuitFailures = 0
}

function completionSafeFailMatchesTask(commit, snapshot) {
  if (!commit || commit.protocol !== COMPLETION_SAFE_FAIL_PROTOCOL) {
    return { ok: false, reason: "completion_safe_fail_invalid" }
  }
  if (!snapshot?.ok || typeof snapshot.turnID !== "string") {
    return { ok: false, reason: "completion_safe_fail_task_unresolved" }
  }
  if (commit.user_turn_id !== snapshot.turnID) {
    return { ok: false, reason: "completion_safe_fail_task_turn_changed" }
  }
  if (commit.task_sha256 !== snapshot.textSha256) {
    return { ok: false, reason: "completion_safe_fail_task_text_drift" }
  }
  return { ok: true, reason: "completion_safe_fail_task_match" }
}

function deriveCompletionSafeFail({
  state,
  persisted,
  completionAuthorization,
}) {
  if (!state || !persisted || !completionAuthorization) {
    return { ok: false, reason: "completion_safe_fail_missing_input" }
  }
  if (completionAuthorization.applicable !== true) {
    return { ok: false, reason: "completion_safe_fail_not_applicable" }
  }
  if (completionAuthorizationPermitsTerminal(completionAuthorization)) {
    return { ok: false, reason: "completion_safe_fail_already_certified" }
  }
  const patchSha = persisted?.receipt?.patch_sha256
  const actionCommitSha = persisted?.receipt?.action_commit_sha256
  if (
    typeof state.taskTurnID !== "string" ||
    typeof state.taskTextSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(state.taskTextSha256) ||
    typeof persisted.path !== "string" ||
    typeof persisted.verificationPath !== "string" ||
    typeof persisted.receiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(persisted.receiptSha256) ||
    typeof persisted.verificationSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(persisted.verificationSha256) ||
    typeof patchSha !== "string" ||
    !/^[0-9a-f]{64}$/.test(patchSha) ||
    typeof actionCommitSha !== "string" ||
    !/^[0-9a-f]{64}$/.test(actionCommitSha)
  ) {
    return { ok: false, reason: "completion_safe_fail_identity_invalid" }
  }

  const canonical = {
    protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
    outcome: COMPLETION_SAFE_FAIL_OUTCOME,
    reason: completionAuthorization.reason ?? "completion_authorizer_unavailable",
    completion_authorizer_transport_ok:
      completionAuthorization.transport_ok === true,
    completion_authorizer_decision:
      completionAuthorization.decision ?? null,
    user_turn_id: state.taskTurnID,
    task_sha256: state.taskTextSha256,
    action_commit_sha256: actionCommitSha,
    patch_receipt_path: persisted.path,
    patch_receipt_sha256: persisted.receiptSha256,
    verification_receipt_path: persisted.verificationPath,
    verification_receipt_sha256: persisted.verificationSha256,
    patch_sha256: patchSha,
  }
  const commitSha256 = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
  return {
    ok: true,
    reason: "completion_safe_fail_ready",
    commit: { ...canonical, commit_sha256: commitSha256 },
  }
}

function claimCompletionSafeFail(state, commit) {
  if (
    !state ||
    commit?.protocol !== COMPLETION_SAFE_FAIL_PROTOCOL ||
    !/^[0-9a-f]{64}$/.test(commit?.commit_sha256 ?? "")
  ) {
    return { ok: false, reason: "completion_safe_fail_invalid" }
  }
  if (state.completionSafeFailSha256) {
    return {
      ok: state.completionSafeFailSha256 === commit.commit_sha256,
      reason:
        state.completionSafeFailSha256 === commit.commit_sha256
          ? "completion_safe_fail_duplicate"
          : "completion_safe_fail_conflict",
    }
  }
  state.completionSafeFail = commit
  state.completionSafeFailSha256 = commit.commit_sha256
  state.completionSafeFailClaims = 1
  return { ok: true, reason: "completion_safe_fail_claimed" }
}

async function terminalArtifactSha256(root, rawPath) {
  if (
    !root ||
    typeof rawPath !== "string" ||
    rawPath.length < 1 ||
    rawPath.startsWith("/") ||
    rawPath.includes("\0")
  ) {
    return null
  }

  const resolved = path.resolve(root, rawPath)
  if (
    resolved === root ||
    !resolved.startsWith(root + path.sep)
  ) {
    return null
  }

  try {
    const info = await stat(resolved)
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > TERMINAL_ARTIFACT_MAX_BYTES
    ) {
      return null
    }
    const body = await readFile(resolved)
    return createHash("sha256").update(body).digest("hex")
  } catch {
    return null
  }
}

async function validateTerminalCommitArtifacts(root, commit) {
  const checks = await Promise.all([
    terminalArtifactSha256(root, commit?.patch_receipt_path),
    terminalArtifactSha256(root, commit?.verification_receipt_path),
    terminalArtifactSha256(root, commit?.patch_path),
  ])

  if (checks[0] !== commit?.patch_receipt_sha256) {
    return { ok: false, reason: "terminal_patch_receipt_stale" }
  }
  if (checks[1] !== commit?.verification_receipt_sha256) {
    return { ok: false, reason: "terminal_verification_receipt_stale" }
  }
  if (checks[2] !== commit?.patch_sha256) {
    return { ok: false, reason: "terminal_patch_stale" }
  }

  return { ok: true, reason: "terminal_artifacts_match" }
}

function scoutFingerprintKey(fingerprint) {
  if (!fingerprint) return null
  if (fingerprint.kind === "sha256" && typeof fingerprint.sha256 === "string") {
    return `sha256:${fingerprint.sha256}`
  }
  if (Number.isFinite(fingerprint.size) && Number.isFinite(fingerprint.mtime_ms)) {
    return `stat:${fingerprint.size}:${fingerprint.mtime_ms}`
  }
  return null
}

function scoutNormalizeWitnessText(text) {
  return String(text ?? "").replace(/\r?\n$/, "")
}

async function scoutFileFingerprint(root, rawFile, witnesses = []) {
  const file = evidenceFileKey(rawFile)
  if (!file) return null
  const resolved = path.resolve(root, file)
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null

  try {
    const info = await stat(resolved)
    if (!info.isFile()) return null
    const base = { size: info.size, mtime_ms: Math.trunc(info.mtimeMs) }
    if (info.size > SCOUT_HANDOFF_HASH_MAX_BYTES) {
      return { kind: "size_mtime", strong: false, ...base }
    }
    const body = await readFile(resolved)
    const lines = body.toString("utf8").split(/\r?\n/)
    let evidenceFresh = true
    let witnessesChecked = 0
    for (const witness of witnesses) {
      if (!Number.isInteger(witness?.line) || typeof witness?.text !== "string") continue
      witnessesChecked += 1
      if (scoutNormalizeWitnessText(lines[witness.line - 1] ?? "") !== scoutNormalizeWitnessText(witness.text)) {
        evidenceFresh = false
        break
      }
    }
    return {
      kind: "sha256",
      strong: true,
      sha256: createHash("sha256").update(body).digest("hex"),
      evidence_fresh: evidenceFresh,
      witnesses_checked: witnessesChecked,
      ...base,
    }
  } catch {
    return null
  }
}

async function writeLocalMutationHandoff(
  root,
  sessionID,
  turnID,
  bundle,
  discriminator = "primary",
) {
  if (!root || !sessionID || !bundle) return null

  const dir = path.join(
    root,
    ".opencode",
    "scout-handoffs",
    "capabilities",
  )
  const key = scoutOpaqueKey(
    `${sessionID}:${turnID ?? ""}:local-mutation:${discriminator}`,
  )
  const finalPath = path.join(dir, `${key}.json`)
  const tempPath = `${finalPath}.${process.pid}.${nowMs()}.tmp`

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      tempPath,
      JSON.stringify(bundle, null, 2) + "\n",
      "utf8",
    )
    await rename(tempPath, finalPath)
    return path.relative(root, finalPath)
  } catch {
    await rm(tempPath, { force: true }).catch(() => {})
    return null
  }
}

async function writeScoutHandoff(root, sessionID, bundle) {
  if (!root || !sessionID) return null
  const dir = path.join(root, ".opencode", "scout-handoffs")
  const finalPath = path.join(dir, `${scoutOpaqueKey(sessionID)}.json`)
  const tempPath = `${finalPath}.${process.pid}.${nowMs()}.tmp`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tempPath, JSON.stringify(bundle, null, 2) + "\n", "utf8")
    await rename(tempPath, finalPath)
    return path.relative(root, finalPath)
  } catch {
    await rm(tempPath, { force: true }).catch(() => {})
    return null
  }
}

function scoutEvidenceWitnesses(hits, selectedFiles) {
  const selected = new Set((selectedFiles ?? []).map((entry) => evidenceFileKey(entry?.file)))
  const witnesses = new Map()
  const push = (file, line, text) => {
    if (!file || !selected.has(file) || !Number.isInteger(line) || typeof text !== "string") return
    if (!witnesses.has(file)) witnesses.set(file, [])
    const values = witnesses.get(file)
    if (values.length < SCOUT_HANDOFF_MAX_LINES_PER_FILE) values.push({ line, text })
  }
  for (const hit of hits?.values?.() ?? []) push(evidenceFileKey(hit?.file), hit?.line, hit?.text)
  for (const entry of selectedFiles ?? []) {
    push(evidenceFileKey(entry?.file), entry?.impact?.sample?.line, entry?.impact?.sample?.text)
  }
  return witnesses
}

function scoutEvidenceLines(hits, selectedFiles) {
  const selected = new Set((selectedFiles ?? []).map((entry) => evidenceFileKey(entry?.file)))
  const lines = new Map()
  for (const hit of hits?.values?.() ?? []) {
    const file = evidenceFileKey(hit?.file)
    if (!file || !selected.has(file) || !Number.isInteger(hit?.line)) continue
    if (!lines.has(file)) lines.set(file, new Set())
    lines.get(file).add(hit.line)
  }
  for (const entry of selectedFiles ?? []) {
    const file = evidenceFileKey(entry?.file)
    const line = entry?.impact?.sample?.line
    if (!file || !Number.isInteger(line)) continue
    if (!lines.has(file)) lines.set(file, new Set())
    lines.get(file).add(line)
  }
  return lines
}

function serializeScoutFile(entry) {
  return {
    file: entry.file,
    origins: [...entry.origins].sort(),
    queries: [...entry.queries].sort((a, b) => a - b),
    evidence_lines: [...entry.evidenceLines].sort((a, b) => a - b).slice(0, SCOUT_HANDOFF_MAX_LINES_PER_FILE),
    evidence_lines_truncated: entry.evidenceLines.size > SCOUT_HANDOFF_MAX_LINES_PER_FILE,
    fingerprint: entry.fingerprint,
    changed_during_scout: entry.changedDuringScout === true,
    impact: [...entry.impact.values()].sort((a, b) =>
      String(a.seed).localeCompare(String(b.seed)) ||
      String(a.direction).localeCompare(String(b.direction)) ||
      String(a.validation_kind).localeCompare(String(b.validation_kind)),
    ),
  }
}

async function updateScoutHandoff(root, sessionID, state, snapshot) {
  if (!state || !sessionID) return null
  const started = performance.now()
  const lineMap = scoutEvidenceLines(snapshot.hits, snapshot.selectedFiles)
  const witnessMap = scoutEvidenceWitnesses(snapshot.hits, snapshot.selectedFiles)
  const fingerprints = await Promise.all((snapshot.selectedFiles ?? []).map(async (selected) => {
    const file = evidenceFileKey(selected?.file)
    return {
      selected,
      file,
      fingerprint: await scoutFileFingerprint(root, selected?.file, witnessMap.get(file) ?? []),
    }
  }))

  for (const item of fingerprints) {
    if (!item.file) continue
    let entry = state.scoutFiles.get(item.file)
    if (!entry) {
      entry = {
        file: item.file, origins: new Set(), queries: new Set(), evidenceLines: new Set(),
        fingerprint: item.fingerprint, changedDuringScout: false, impact: new Map(),
      }
      state.scoutFiles.set(item.file, entry)
    } else {
      const before = scoutFingerprintKey(entry.fingerprint)
      const after = scoutFingerprintKey(item.fingerprint)
      if (before && after && before !== after) entry.changedDuringScout = true
      if (item.fingerprint) entry.fingerprint = item.fingerprint
    }

    entry.origins.add(item.selected?.origin === "impact" ? "impact" : "lexical")
    for (const query of item.selected?.queries ?? []) {
      if (Number.isInteger(query)) entry.queries.add(query)
    }
    for (const line of lineMap.get(item.file) ?? []) entry.evidenceLines.add(line)

    if (item.selected?.origin === "impact") {
      const relation = {
        seed: evidenceFileKey(item.selected?.impact?.seed),
        direction: item.selected?.impact?.direction ?? null,
        bindings: [...new Set(item.selected?.impact?.bindings ?? [])].slice(0, IMPACT_BINDINGS_PER_CANDIDATE),
        validation_kind: item.selected?.impact?.validationKind ?? null,
        sample_line: Number.isInteger(item.selected?.impact?.sample?.line) ? item.selected.impact.sample.line : null,
      }
      const key = JSON.stringify(relation)
      entry.impact.set(key, relation)
    }
  }

  state.scoutSearches.push({
    attempt_index: snapshot.attemptIndex,
    queries: snapshot.queries,
    path: snapshot.target,
    glob: snapshot.glob ?? null,
    representation: snapshot.representation,
    source_representation: snapshot.sourceRepresentation,
    lexical_discovery_complete: snapshot.discoveryComplete,
    scan_complete: snapshot.scanComplete,
    selected_scan_complete: snapshot.selectedScanComplete,
    evidence_complete: snapshot.evidenceComplete,
    selected_evidence_complete: snapshot.selectedEvidenceComplete,
    refinement_required: snapshot.refinementRequired,
    retained_unread_files: snapshot.retainedUnreadFiles,
    retained_unemitted_files: snapshot.retainedUnemittedFiles,
    selected_files: (snapshot.selectedFiles ?? []).map((entry) => evidenceFileKey(entry?.file)).filter(Boolean),
    impact_index_coverage_complete: snapshot.impactIndexCoverageComplete,
    no_progress: snapshot.noProgress === true,
    no_progress_blocked: snapshot.noProgressBlocked === true,
  })

  if (state.scoutSearches.length > MAX_EXECUTED_SEARCHES_PER_TURN) state.scoutSearches.shift()

  const files = [...state.scoutFiles.values()].map(serializeScoutFile).sort((a, b) => a.file.localeCompare(b.file))
  const latest = state.scoutSearches[state.scoutSearches.length - 1] ?? null
  const blockingReasons = []
  const partialReasons = []

  if (files.length < 1) blockingReasons.push("no_localized_files")
  if (latest?.refinement_required === true) blockingReasons.push("refinement_required")
  if (files.some((entry) => !entry.fingerprint)) blockingReasons.push("fingerprint_unavailable")
  if (files.some((entry) => entry.fingerprint?.strong !== true)) blockingReasons.push("weak_fingerprint")
  if (files.some((entry) => entry.fingerprint?.evidence_fresh === false)) blockingReasons.push("evidence_changed_before_handoff")
  if (files.some((entry) => entry.changed_during_scout === true)) blockingReasons.push("file_changed_during_scout")

  if (latest?.lexical_discovery_complete === false) partialReasons.push("lexical_discovery_incomplete")
  if ((latest?.retained_unread_files ?? 0) > 0) partialReasons.push("retained_unread_files")
  if ((latest?.retained_unemitted_files ?? 0) > 0) partialReasons.push("retained_unemitted_files")
  if (latest?.evidence_complete === false) partialReasons.push("evidence_incomplete")
  if (latest?.impact_index_coverage_complete === false) partialReasons.push("impact_index_partial")

  const status = blockingReasons.length > 0 ? "blocked" : partialReasons.length > 0 ? "partial" : "ready"
  const bundle = {
    protocol: SCOUT_HANDOFF_PROTOCOL,
    search_protocol: SEARCH_PROTOCOL,
    session_key: scoutOpaqueKey(sessionID),
    turn_key: scoutOpaqueKey(state.turnID ?? ""),
    generated_at_ms: nowMs(),
    status,
    blocking_reasons: [...new Set(blockingReasons)],
    partial_reasons: [...new Set(partialReasons)],
    budgets: {
      model_calls: state.modelCalls,
      search_attempts: state.searchAttempts,
      executed_searches: state.executedSearches,
      evidence_bytes: state.evidenceBytes,
    },
    searches: state.scoutSearches,
    files,
  }
  const handoffPath = await writeScoutHandoff(root, sessionID, bundle)
  state.scoutHandoffPath = handoffPath
  state.localMutationHandoffPath = null
  state.localMutationCapability = null
  state.localMutationCandidates = []
  state.renameMutationCapability = null
  state.activeMutationHandoffPath = null
  state.boundMutationTarget = null
  return {
    protocol: SCOUT_HANDOFF_PROTOCOL,
    path: handoffPath,
    status,
    files: files.length,
    blockingReasons: bundle.blocking_reasons,
    partialReasons: bundle.partial_reasons,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
  }
}

function scoutMutationLocalizationEligibility(state, scoutHandoff) {
  const latest =
    state?.scoutSearches?.[state.scoutSearches.length - 1] ?? null

  if (!scoutHandoff?.path) {
    return { eligible: false, reason: "handoff_unavailable" }
  }

  if (
    Array.isArray(scoutHandoff.blockingReasons) &&
    scoutHandoff.blockingReasons.length > 0
  ) {
    return { eligible: false, reason: "handoff_has_blockers" }
  }

  if (scoutHandoff.status === "blocked") {
    return { eligible: false, reason: "handoff_blocked" }
  }

  if ((scoutHandoff.files ?? 0) < 1) {
    return { eligible: false, reason: "no_localized_files" }
  }

  if (!latest) {
    return { eligible: false, reason: "search_snapshot_unavailable" }
  }

  if (latest.lexical_discovery_complete !== true) {
    return { eligible: false, reason: "lexical_discovery_incomplete" }
  }

  // v2.18: global scan_complete is a DISCOVERY completeness fact, not a
  // prerequisite for proving one already-selected structural owner.
  if (latest.selected_scan_complete !== true) {
    return { eligible: false, reason: "selected_scan_incomplete" }
  }

  if (latest.refinement_required === true) {
    return { eligible: false, reason: "refinement_required" }
  }

  if (latest.no_progress_blocked === true) {
    return { eligible: false, reason: "no_progress_blocked" }
  }

  return {
    eligible: true,
    reason:
      scoutHandoff.status === "ready"
        ? "ready_handoff_selected_source_scan"
        : "partial_handoff_selected_source_scan",
  }
}

function localCapabilityPartialReasonsAllowed(reasons) {
  const values = Array.isArray(reasons) ? reasons : []
  return (
    values.length > 0 &&
    values.every((reason) =>
      SCOUT_LOCAL_CAPABILITY_ALLOWED_PARTIAL_REASONS.has(reason),
    )
  )
}

function sameAuthorizedScopeIdentity(a, b) {
  if (!a || !b) return false
  return (
    normalizeMutationFile(a.file) === normalizeMutationFile(b.file) &&
    a.symbol_name === b.symbol_name &&
    a.symbol_kind === b.symbol_kind &&
    a.start_line === b.start_line &&
    a.end_line === b.end_line
  )
}

function ownerEvidenceDistance(line, target) {
  if (!Number.isInteger(line) || !target) return Number.MAX_SAFE_INTEGER
  if (line < target.start_line) return target.start_line - line
  if (line > target.end_line) return line - target.end_line
  return 0
}

function buildOwnerAttestation(editCapsule, target, targetFile) {
  const reject = (reason) => ({
    ok: false,
    protocol: SCOUT_OWNER_ATTESTATION_PROTOCOL,
    reason,
    evidence_lines: [],
    structural_source: null,
    max_distance_lines: null,
  })

  if (!target || !targetFile) return reject("owner_attestation_inputs_missing")

  const evidenceLines = [...new Set(
    (targetFile.evidence_lines ?? [])
      .filter((line) => Number.isInteger(line) && line > 0),
  )].sort((a, b) => a - b)

  if (evidenceLines.length < 1) {
    return reject("owner_attestation_evidence_missing")
  }

  const boundedEvidenceLines = evidenceLines.filter(
    (line) => ownerEvidenceDistance(line, target) <= EDIT_CAPSULE_WINDOW_RADIUS,
  )

  if (boundedEvidenceLines.length < 1) {
    return reject("owner_attestation_evidence_too_far")
  }

  const directEvidenceLines = boundedEvidenceLines.filter(
    (line) => ownerEvidenceDistance(line, target) === 0,
  )

  if (directEvidenceLines.length > 0) {
    return {
      ok: true,
      protocol: SCOUT_OWNER_ATTESTATION_PROTOCOL,
      reason: "direct_owner_evidence",
      evidence_lines: directEvidenceLines,
      structural_source: editCapsule?.structuralSource ?? null,
      max_distance_lines: 0,
    }
  }

  // Evidence immediately adjacent to an owner (for example a Python/TS
  // decorator or annotation) is accepted only when the deterministic
  // structural pipeline independently selected and transactionally
  // authorized exactly this owner. Capability code consumes this generic
  // certificate and does not special-case a recovery algorithm or language.
  if (
    editCapsule?.mutationReady === true &&
    typeof editCapsule?.structuralSource === "string" &&
    editCapsule.structuralSource !== "none" &&
    sameAuthorizedScopeIdentity(
      target,
      editCapsule?.primaryMutationCandidate,
    ) &&
    sameAuthorizedScopeIdentity(
      target,
      editCapsule?.authorizedMutationScope,
    )
  ) {
    return {
      ok: true,
      protocol: SCOUT_OWNER_ATTESTATION_PROTOCOL,
      reason: "structural_owner_certificate",
      evidence_lines: boundedEvidenceLines,
      structural_source: editCapsule.structuralSource,
      max_distance_lines: Math.max(
        ...boundedEvidenceLines.map((line) => ownerEvidenceDistance(line, target)),
      ),
    }
  }

  return reject("owner_attestation_structural_identity_unproven")
}

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
