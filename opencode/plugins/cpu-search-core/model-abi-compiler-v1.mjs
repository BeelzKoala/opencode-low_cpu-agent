import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

export const MODEL_ABI_COMPILER_PROTOCOL =
  "model-abi-compiler-v1"

const COMPILER_TIMEOUT_MS = 1500
const COMPILER_MAX_BUFFER_BYTES =
  2 * 1024 * 1024
const DEFAULT_MIN_SAVINGS_BYTES = 64

const cache = new Map()
let unavailableReason = null

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function stableSha(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
}

function schemaBinding(tool) {
  if (
    tool?.input &&
    typeof tool.input === "object" &&
    !Array.isArray(tool.input)
  ) {
    return {
      key: "input",
      schema: tool.input,
    }
  }

  if (
    tool?.parameters &&
    typeof tool.parameters === "object" &&
    !Array.isArray(tool.parameters)
  ) {
    return {
      key: "parameters",
      schema: tool.parameters,
    }
  }

  return null
}

function compilerPath() {
  const configured =
    typeof process.env
      .OPENCODE_MODEL_ABI_COMPILER ===
      "string" &&
    process.env.OPENCODE_MODEL_ABI_COMPILER
      .length > 0
      ? process.env
          .OPENCODE_MODEL_ABI_COMPILER
      : null

  if (configured) {
    return existsSync(configured)
      ? configured
      : null
  }

  const installed = fileURLToPath(
    new URL(
      "../.bin/opencode-model-abi-compiler",
      import.meta.url,
    ),
  )

  return existsSync(installed)
    ? installed
    : null
}

function baseResult(
  schema,
  reason,
  {
    cacheHit = false,
    compilerAvailable = false,
  } = {},
) {
  const bytes = Buffer.byteLength(
    JSON.stringify(schema),
    "utf8",
  )

  return Object.freeze({
    ok: true,
    protocol: MODEL_ABI_COMPILER_PROTOCOL,
    applied: false,
    action: "base_retained",
    reason,
    schema,
    base_bytes: bytes,
    candidate_bytes: bytes,
    selected_bytes: bytes,
    saved_bytes: 0,
    constraint_present: false,
    satisfiable: null,
    subset_of_base: null,
    subset_of_constraint: null,
    equivalent_to_base: null,
    exact: false,
    cache_hit: cacheHit,
    compiler_available:
      compilerAvailable,
    mutation_authority: false,
    model_authority_expansion: false,
  })
}

export function compileModelFacingSchema({
  schema,
  constraint = null,
  minSavingsBytes =
    DEFAULT_MIN_SAVINGS_BYTES,
} = {}) {
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return baseResult(
      {},
      "schema_invalid",
    )
  }

  const request = {
    protocol:
      MODEL_ABI_COMPILER_PROTOCOL,
    mode: "compile",
    schema,
    constraint:
      constraint &&
      typeof constraint === "object" &&
      !Array.isArray(constraint)
        ? constraint
        : null,
    min_savings_bytes:
      Number.isSafeInteger(
        minSavingsBytes,
      ) &&
      minSavingsBytes >= 0
        ? minSavingsBytes
        : DEFAULT_MIN_SAVINGS_BYTES,
  }

  const cacheKey = stableSha(request)
  const cached = cache.get(cacheKey)

  if (cached) {
    return Object.freeze({
      ...cloneJson(cached),
      cache_hit: true,
    })
  }

  if (unavailableReason) {
    const fallback = baseResult(
      schema,
      unavailableReason,
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  const binary = compilerPath()

  if (!binary) {
    unavailableReason =
      "model_abi_compiler_unavailable"

    const fallback = baseResult(
      schema,
      unavailableReason,
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  let child

  try {
    child = spawnSync(
      binary,
      [],
      {
        input: JSON.stringify(request),
        encoding: "utf8",
        timeout: COMPILER_TIMEOUT_MS,
        maxBuffer:
          COMPILER_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    )
  } catch {
    const fallback = baseResult(
      schema,
      "model_abi_compiler_spawn_failed",
      {
        compilerAvailable: true,
      },
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  if (child.error) {
    const code =
      child.error.code === "ETIMEDOUT"
        ? "model_abi_compiler_timeout"
        : "model_abi_compiler_process_error"

    const fallback = baseResult(
      schema,
      code,
      {
        compilerAvailable: true,
      },
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  if (child.status !== 0) {
    const fallback = baseResult(
      schema,
      "model_abi_compiler_nonzero",
      {
        compilerAvailable: true,
      },
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  let parsed

  try {
    parsed = JSON.parse(
      String(child.stdout ?? ""),
    )
  } catch {
    const fallback = baseResult(
      schema,
      "model_abi_compiler_output_invalid",
      {
        compilerAvailable: true,
      },
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  if (
    parsed?.ok !== true ||
    parsed?.protocol !==
      MODEL_ABI_COMPILER_PROTOCOL ||
    !parsed.schema ||
    typeof parsed.schema !== "object" ||
    Array.isArray(parsed.schema) ||
    parsed.model_authority_expansion !==
      false ||
    parsed.mutation_authority !== false
  ) {
    const fallback = baseResult(
      schema,
      "model_abi_compiler_contract_invalid",
      {
        compilerAvailable: true,
      },
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  const baseBytes =
    Buffer.byteLength(
      JSON.stringify(schema),
      "utf8",
    )

  const selectedBytes =
    Buffer.byteLength(
      JSON.stringify(parsed.schema),
      "utf8",
    )

  if (
    selectedBytes > baseBytes ||
    parsed.selected_bytes !==
      selectedBytes ||
    parsed.base_bytes !== baseBytes
  ) {
    const fallback = baseResult(
      schema,
      "model_abi_compiler_cost_invariant_failed",
      {
        compilerAvailable: true,
      },
    )
    cache.set(cacheKey, fallback)
    return fallback
  }

  const projected =
    parsed.action === "projected" &&
    selectedBytes < baseBytes

  const result = Object.freeze({
    ok: true,
    protocol:
      MODEL_ABI_COMPILER_PROTOCOL,
    applied: projected,
    action:
      projected
        ? "projected"
        : "base_retained",
    reason:
      typeof parsed.reason ===
        "string"
        ? parsed.reason
        : "model_abi_compiler_reason_missing",
    schema:
      projected
        ? parsed.schema
        : schema,
    base_bytes: baseBytes,
    candidate_bytes:
      Number.isSafeInteger(
        parsed.candidate_bytes,
      )
        ? parsed.candidate_bytes
        : selectedBytes,
    selected_bytes:
      projected
        ? selectedBytes
        : baseBytes,
    saved_bytes:
      projected
        ? baseBytes -
          selectedBytes
        : 0,
    constraint_present:
      parsed.constraint_present === true,
    satisfiable:
      typeof parsed.satisfiable ===
        "boolean"
        ? parsed.satisfiable
        : null,
    subset_of_base:
      typeof parsed.subset_of_base ===
        "boolean"
        ? parsed.subset_of_base
        : null,
    subset_of_constraint:
      typeof parsed
        .subset_of_constraint ===
        "boolean"
        ? parsed.subset_of_constraint
        : null,
    equivalent_to_base:
      typeof parsed
        .equivalent_to_base ===
        "boolean"
        ? parsed.equivalent_to_base
        : null,
    exact: parsed.exact === true,
    cache_hit: false,
    compiler_available: true,
    mutation_authority: false,
    model_authority_expansion: false,
  })

  cache.set(cacheKey, result)
  return result
}

export function compileModelFacingToolSchemas({
  tools,
  frontierToolNames,
  active = false,
  minSavingsBytes =
    DEFAULT_MIN_SAVINGS_BYTES,
} = {}) {
  const names =
    Array.isArray(frontierToolNames)
      ? [...frontierToolNames]
      : []

  if (
    active !== true ||
    !tools ||
    typeof tools !== "object" ||
    Array.isArray(tools)
  ) {
    return Object.freeze({
      ok: true,
      protocol:
        MODEL_ABI_COMPILER_PROTOCOL,
      applied: false,
      reason:
        active === true
          ? "tool_registry_invalid"
          : "model_abi_compiler_inactive",
      tools_examined: 0,
      tools_projected: 0,
      base_schema_bytes: 0,
      selected_schema_bytes: 0,
      saved_bytes: 0,
      cache_hits: 0,
      compiler_available:
        unavailableReason === null,
      mutation_authority: false,
      model_authority_expansion:
        false,
    })
  }

  let toolsExamined = 0
  let toolsProjected = 0
  let baseSchemaBytes = 0
  let selectedSchemaBytes = 0
  let cacheHits = 0
  let compilerAvailable = true
  const reasons = []

  for (const name of names) {
    const tool = tools[name]
    const binding =
      schemaBinding(tool)

    if (!binding) continue

    toolsExamined += 1

    const compiled =
      compileModelFacingSchema({
        schema: binding.schema,
        minSavingsBytes,
      })

    baseSchemaBytes +=
      compiled.base_bytes
    selectedSchemaBytes +=
      compiled.selected_bytes

    if (compiled.cache_hit === true) {
      cacheHits += 1
    }

    if (
      compiled.compiler_available !==
      true
    ) {
      compilerAvailable = false
    }

    reasons.push(
      `${name}:${compiled.reason}`,
    )

    if (compiled.applied !== true) {
      continue
    }

    tools[name] = {
      ...tool,
      [binding.key]: compiled.schema,
    }
    toolsProjected += 1
  }

  return Object.freeze({
    ok: true,
    protocol:
      MODEL_ABI_COMPILER_PROTOCOL,
    applied:
      toolsProjected > 0,
    reason:
      toolsProjected > 0
        ? "model_abi_projection_applied"
        : reasons.join(",") ||
          "no_model_schema_binding",
    tools_examined: toolsExamined,
    tools_projected: toolsProjected,
    base_schema_bytes:
      baseSchemaBytes,
    selected_schema_bytes:
      selectedSchemaBytes,
    saved_bytes:
      Math.max(
        0,
        baseSchemaBytes -
          selectedSchemaBytes,
      ),
    cache_hits: cacheHits,
    compiler_available:
      compilerAvailable,
    mutation_authority: false,
    model_authority_expansion: false,
  })
}

export function resetModelAbiCompilerCacheForTest() {
  cache.clear()
  unavailableReason = null
}
