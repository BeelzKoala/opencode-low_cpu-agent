import {
  SOURCE_SLOT_COMPILER_PROTOCOL,
  deriveSourceSlotSchemaFrontier,
} from "./source-slot-compiler-v1.mjs"

export const QUALIFIED_COMPUTE_PROTOCOL =
  "qualified-compute-admission-v1"

// Existing 150s lease remains the conservative maximum. R7-R5-B
// couples only qualified single-source repair work to its sealed frontier.
export const QUALIFIED_REPAIR_HARD_LEASE_MS = 150_000
export const QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS = 30_000
export const QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS =
  QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS
export const QUALIFIED_REPAIR_MIN_HARD_LEASE_MS =
  QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS * 2
export const QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS =
  QUALIFIED_REPAIR_HARD_LEASE_MS -
  QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS
export const QUALIFIED_REPAIR_MIN_OUTPUT_TOKENS = 512

const TARGET_TOOL = "execute_additive_plan"

function positiveInt(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.max(1, Math.floor(number))
}

function safeMs(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function toolName(tool, fallback = null) {
  const value = tool?.name ?? tool?.toolName ?? tool?.id ?? fallback
  return typeof value === "string" && value.length > 0 ? value : null
}

function toolEntries(tools) {
  if (Array.isArray(tools)) {
    return tools.map((tool) => ({ name: toolName(tool), tool }))
  }
  if (tools && typeof tools === "object") {
    return Object.entries(tools).map(([name, tool]) => ({
      name: toolName(tool, name),
      tool,
    }))
  }
  return []
}

export function selectQualifiedSourceSlotTool(
  tools,
  selectedTool = TARGET_TOOL,
) {
  const matches = toolEntries(tools).filter((row) => row.name === selectedTool)
  return matches.length === 1 ? matches[0].tool : null
}

export function deriveQualifiedComputePlan({
  tools,
  selectedTool = TARGET_TOOL,
  baseOutputCap = null,
  nowMs = null,
  taskDeadlineAtMs = null,
} = {}) {
  const tool = selectQualifiedSourceSlotTool(tools, selectedTool)
  const frontier = deriveSourceSlotSchemaFrontier(tool)

  if (
    frontier?.ok !== true ||
    frontier.protocol !== SOURCE_SLOT_COMPILER_PROTOCOL ||
    frontier.active_source_count !== 1
  ) {
    return Object.freeze({
      ok: true,
      protocol: QUALIFIED_COMPUTE_PROTOCOL,
      active: false,
      reason:
        frontier?.reason ?? "qualified_compute_single_source_frontier_absent",
      selected_tool: selectedTool,
      frontier_protocol: frontier?.protocol ?? null,
      active_source_count: frontier?.active_source_count ?? null,
      output_cap_tokens: null,
      hard_lease_ms: null,
      teardown_reserve_ms: null,
      task_deadline_at_ms: safeMs(taskDeadlineAtMs) ? taskDeadlineAtMs : null,
      task_remaining_ms:
        safeMs(nowMs) && safeMs(taskDeadlineAtMs)
          ? Math.max(0, taskDeadlineAtMs - nowMs)
          : null,
      admission_allowed: true,
      deadline_extension_ms: 0,
      mutation_authority: false,
    })
  }

  const frontierActiveBytes =
    frontier.active_source_capacity_bytes
  const frontierTotalBytes =
    frontier.total_source_capacity_bytes
  const frontierFraction =
    frontierActiveBytes / frontierTotalBytes

  const baseCap = positiveInt(baseOutputCap)
  const scaledCap =
    baseCap == null
      ? null
      : Math.max(
          QUALIFIED_REPAIR_MIN_OUTPUT_TOKENS,
          Math.min(
            baseCap,
            Math.ceil(
              baseCap *
                frontierActiveBytes /
                frontierTotalBytes,
            ),
          ),
        )

  const frontierScaledLeaseMs =
    QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS +
    Math.ceil(
      QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS *
        frontierActiveBytes /
        frontierTotalBytes,
    )

  const hardLeaseMs =
    Math.max(
      QUALIFIED_REPAIR_MIN_HARD_LEASE_MS,
      Math.min(
        QUALIFIED_REPAIR_HARD_LEASE_MS,
        frontierScaledLeaseMs,
      ),
    )

  const deadlineKnown = safeMs(nowMs) && safeMs(taskDeadlineAtMs)
  const remainingMs =
    deadlineKnown ? Math.max(0, taskDeadlineAtMs - nowMs) : null
  const requiredMs =
    hardLeaseMs + QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS
  const admissionAllowed =
    !deadlineKnown ||
    (nowMs < taskDeadlineAtMs && remainingMs >= requiredMs)

  return Object.freeze({
    ok: true,
    protocol: QUALIFIED_COMPUTE_PROTOCOL,
    active: true,
    reason: admissionAllowed
      ? "qualified_single_source_repair_admitted"
      : "qualified_single_source_repair_exceeds_task_remaining",
    selected_tool: selectedTool,
    frontier_protocol: frontier.protocol,
    active_source_keys: frontier.active_source_keys,
    active_source_count: frontier.active_source_count,
    active_source_capacity_bytes: frontier.active_source_capacity_bytes,
    total_source_capacity_bytes: frontier.total_source_capacity_bytes,
    frontier_fraction: frontierFraction,
    lease_policy: "frontier_coupled_affine_v1",
    fixed_inference_reserve_ms:
      QUALIFIED_REPAIR_FIXED_INFERENCE_RESERVE_MS,
    scalable_inference_budget_ms:
      QUALIFIED_REPAIR_SCALABLE_INFERENCE_BUDGET_MS,
    min_hard_lease_ms:
      QUALIFIED_REPAIR_MIN_HARD_LEASE_MS,
    max_hard_lease_ms:
      QUALIFIED_REPAIR_HARD_LEASE_MS,
    base_output_cap_tokens: baseCap,
    output_cap_tokens: scaledCap,
    output_cap_authority:
      baseCap == null ? "frontier_observation_only" : "frontier_provider_bound",
    hard_lease_ms: hardLeaseMs,
    teardown_reserve_ms: QUALIFIED_REPAIR_TEARDOWN_RESERVE_MS,
    required_window_ms: requiredMs,
    task_deadline_at_ms: deadlineKnown ? taskDeadlineAtMs : null,
    task_remaining_ms: remainingMs,
    admission_allowed: admissionAllowed,
    deadline_extension_ms: 0,
    mutation_authority: false,
  })
}

export function qualifiedAbortSignal(originalSignal, hardLeaseMs) {
  const lease = positiveInt(hardLeaseMs)
  if (!lease || typeof AbortSignal?.timeout !== "function") {
    return Object.freeze({
      signal: originalSignal,
      timeout_signal: null,
      qualified: false,
      mutation_authority: false,
    })
  }

  const timeoutSignal = AbortSignal.timeout(lease)

  if (!originalSignal) {
    return Object.freeze({
      signal: timeoutSignal,
      timeout_signal: timeoutSignal,
      qualified: true,
      mutation_authority: false,
    })
  }

  if (typeof AbortSignal?.any === "function") {
    return Object.freeze({
      signal: AbortSignal.any([originalSignal, timeoutSignal]),
      timeout_signal: timeoutSignal,
      qualified: true,
      mutation_authority: false,
    })
  }

  const controller = new AbortController()
  const forward = (signal) => {
    if (controller.signal.aborted) return
    try {
      controller.abort(signal.reason)
    } catch {
      controller.abort()
    }
  }

  if (originalSignal.aborted) {
    forward(originalSignal)
  } else {
    originalSignal.addEventListener(
      "abort",
      () => forward(originalSignal),
      { once: true },
    )
  }
  timeoutSignal.addEventListener(
    "abort",
    () => forward(timeoutSignal),
    { once: true },
  )

  return Object.freeze({
    signal: controller.signal,
    timeout_signal: timeoutSignal,
    qualified: true,
    mutation_authority: false,
  })
}
