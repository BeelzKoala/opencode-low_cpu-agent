import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const REPAIR_WITNESS_CLOSURE_PROTOCOL =
  "repair-witness-closure-v1"
export const PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL =
  "python-dependency-evidence-v1"

const MAX_DEPENDENCY_ITEMS = 32
const MAX_DEPENDENCY_TEXT_BYTES = 768
const DEFAULT_DEPENDENCY_TIMEOUT_MS = 4_000
const MAX_HELPER_STDOUT_BYTES = 128 * 1024
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: REPAIR_WITNESS_CLOSURE_PROTOCOL,
    reason,
    mutation_authority: false,
    model_authority: false,
    ...extra,
  })
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8")
}

function helperPath() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, "python-semantic-frontend-v1.py")
}

function boundedStrings(values, limit = MAX_DEPENDENCY_ITEMS) {
  if (!Array.isArray(values)) return []
  const out = []
  const seen = new Set()
  for (const raw of values) {
    const value = String(raw ?? "").trim()
    if (!value || value.length > 128 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= limit) break
  }
  return out.sort((a, b) => a.localeCompare(b))
}

function validateDependencyEvidence(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.protocol !== PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL ||
    value.mutation_authority !== false ||
    value.model_import_authority !== false ||
    value.absence_authority !== false
  ) {
    return Object.freeze({
      ok: false,
      protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
      reason: "python_dependency_evidence_invalid",
      mutation_authority: false,
      model_import_authority: false,
      absence_authority: false,
    })
  }

  return Object.freeze({
    ok: value.ok === true,
    protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
    reason: value.reason ?? null,
    declared_distributions: Object.freeze(
      boundedStrings(value.declared_distributions),
    ),
    declared_modules: Object.freeze(
      boundedStrings(value.declared_modules),
    ),
    manifest_files: Object.freeze(
      boundedStrings(value.manifest_files, 16),
    ),
    truncated: value.truncated === true,
    mutation_authority: false,
    model_import_authority: false,
    absence_authority: false,
  })
}

export async function inspectPythonDependencyEvidence(
  root,
  {
    timeoutMs = DEFAULT_DEPENDENCY_TIMEOUT_MS,
    python = process.env.OPENCODE_PYTHON ?? "python3",
  } = {},
) {
  if (typeof root !== "string" || root.length < 1) {
    return validateDependencyEvidence({
      ok: false,
      protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
      reason: "python_dependency_root_invalid",
      mutation_authority: false,
      model_import_authority: false,
      absence_authority: false,
    })
  }

  return await new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false

    const child = spawn(
      python,
      ["-S", helperPath(), "--dependency-evidence", root],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: process.env,
      },
    )

    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(validateDependencyEvidence(value))
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({
        ok: false,
        protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
        reason: "python_dependency_evidence_timeout",
        mutation_authority: false,
        model_import_authority: false,
        absence_authority: false,
      })
    }, timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (bytes(stdout) > MAX_HELPER_STDOUT_BYTES) {
        child.kill("SIGKILL")
        finish({
          ok: false,
          protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
          reason: "python_dependency_evidence_output_budget",
          mutation_authority: false,
          model_import_authority: false,
          absence_authority: false,
        })
      }
    })

    child.stderr.on("data", (chunk) => {
      if (bytes(stderr) < 16 * 1024) stderr += chunk
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      finish({
        ok: false,
        protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
        reason: "python_dependency_evidence_spawn_failed",
        detail: error?.code ?? error?.name ?? "spawn_error",
        mutation_authority: false,
        model_import_authority: false,
        absence_authority: false,
      })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (settled) return
      if (code !== 0) {
        finish({
          ok: false,
          protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
          reason: "python_dependency_evidence_process_failed",
          rc: code,
          stderr: stderr.slice(0, 2048),
          mutation_authority: false,
          model_import_authority: false,
          absence_authority: false,
        })
        return
      }

      try {
        finish(JSON.parse(stdout))
      } catch {
        finish({
          ok: false,
          protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
          reason: "python_dependency_evidence_output_invalid",
          mutation_authority: false,
          model_import_authority: false,
          absence_authority: false,
        })
      }
    })
  })
}

function schemaObject(tool) {
  if (tool?.input && typeof tool.input === "object") {
    return { key: "input", schema: tool.input }
  }
  if (tool?.parameters && typeof tool.parameters === "object") {
    return { key: "parameters", schema: tool.parameters }
  }
  return null
}

function sourceProperties(tool) {
  const holder = schemaObject(tool)
  const properties =
    holder?.schema?.properties?.sources?.properties
  if (
    !holder ||
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return null
  }
  return { ...holder, properties }
}

function rowMap(binding) {
  const rows = Array.isArray(binding?.all_source_rows)
    ? binding.all_source_rows
    : []
  const out = new Map()
  for (const row of rows) {
    const key = row?.source_key
    if (typeof key !== "string" || !key) continue
    out.set(key, row)
  }
  return out
}

function typedPythonUnitsProperty(property) {
  return (
    property?.type === "object" &&
    property?.additionalProperties === false &&
    Array.isArray(property?.required) &&
    property.required.length === 1 &&
    property.required[0] === "units" &&
    property?.properties?.units?.type === "array"
  )
}

function representationWitness(
  row,
  repairActive,
  property = null,
) {
  if (
    row?.kind === "python_declaration" &&
    repairActive &&
    typedPythonUnitsProperty(property)
  ) {
    return [
      "SOURCE_REPRESENTATION=typed_python_units",
      "structural_authority=json_schema_llguidance",
      "allowed_kinds=function|async_function",
      "raw_module_text=not_accepted",
      "whole_module_replay=unrepresentable",
      "repair_mode=replace_failed_delta_only",
    ].join("; ")
  }

  if (row?.kind === "python_declaration") {
    const allowed = row?.allow_module_imports === false
      ? "FunctionDef|AsyncFunctionDef"
      : "Import|ImportFrom|FunctionDef|AsyncFunctionDef"

    return [
      "SOURCE_REPRESENTATION=python_module_delta",
      `allowed_top_level=${allowed}`,
      row?.allow_module_imports === false
        ? "module_imports=forbidden"
        : "module_imports=prefix_only",
      "executable_top_level=forbidden",
      "existing_module_replay=forbidden",
      "output=new_declarations_only",
      repairActive
        ? "repair_mode=replace_failed_delta_only"
        : "repair_mode=initial_delta",
    ].join("; ")
  }

  if (row?.kind === "replacement") {
    return [
      "SOURCE_REPRESENTATION=exact_replacement_delta",
      "file_wrapper=forbidden",
      "output=replacement_content_only",
      repairActive
        ? "repair_mode=replace_failed_delta_only"
        : "repair_mode=initial_delta",
    ].join("; ")
  }

  if (row?.kind === "creation") {
    return [
      "SOURCE_REPRESENTATION=new_file_content",
      "existing_file_replay=forbidden",
      "output=new_file_content_only",
      repairActive
        ? "repair_mode=replace_failed_delta_only"
        : "repair_mode=initial_delta",
    ].join("; ")
  }

  return [
    "SOURCE_REPRESENTATION=bounded_source_delta",
    "output=source_content_only",
    repairActive
      ? "repair_mode=replace_failed_delta_only"
      : "repair_mode=initial_delta",
  ].join("; ")
}

function counterexampleForKey(repairLock, sourceKey) {
  const counterexample = repairLock?.typed_counterexample
  if (
    !counterexample ||
    typeof counterexample !== "object" ||
    counterexample.mutation_authority === true
  ) {
    return null
  }

  const failedKeys = Array.isArray(repairLock?.failed_source_keys)
    ? repairLock.failed_source_keys
    : []
  const ceSourceKey =
    counterexample.source_key ??
    counterexample.diagnostic?.source_key ??
    null

  if (
    ceSourceKey !== sourceKey &&
    !failedKeys.includes(sourceKey)
  ) {
    return null
  }

  const reason =
    typeof counterexample.reason === "string"
      ? counterexample.reason
      : typeof repairLock?.failure_reason === "string"
        ? repairLock.failure_reason
        : null
  const layer =
    typeof counterexample.layer === "string"
      ? counterexample.layer
      : null

  const unresolvedRaw =
    counterexample.diagnostic?.unresolved_symbol ??
    counterexample.unresolved_symbol ??
    counterexample.diagnostic?.symbol ??
    counterexample.symbol ??
    null
  const unresolved =
    typeof unresolvedRaw === "string" &&
    IDENTIFIER_RE.test(unresolvedRaw)
      ? unresolvedRaw
      : null

  if (!reason && !layer && !unresolved) return null

  return Object.freeze({
    reason,
    layer,
    unresolved_symbol: unresolved,
  })
}

function renderCounterexample(value) {
  if (!value) return null
  const fields = []
  if (value.reason) fields.push(`reason=${value.reason}`)
  if (value.layer) fields.push(`layer=${value.layer}`)
  if (value.unresolved_symbol) {
    fields.push(`unresolved_symbol=${value.unresolved_symbol}`)
    fields.push(
      "reuse_unresolved_symbol=forbidden_without_new_source_evidence",
    )
  }
  return fields.length
    ? `COUNTEREXAMPLE ${fields.join("; ")}`
    : null
}

function renderDependencyEvidence(value) {
  if (value?.ok !== true) {
    return "DEPENDENCY_EVIDENCE=unavailable; invent_external_dependency=forbidden"
  }

  const distributions = boundedStrings(value.declared_distributions)
  const modules = boundedStrings(value.declared_modules)

  const parts = [
    "DEPENDENCY_EVIDENCE=source_backed_positive_only",
    "absence_claims=forbidden",
    "invent_external_dependency=forbidden",
  ]

  if (distributions.length) {
    parts.push(
      `declared_distributions=${distributions.join(",")}`,
    )
  }
  if (modules.length) {
    parts.push(
      `declared_python_modules=${modules.join(",")}`,
    )
  }

  let rendered = parts.join("; ")
  while (
    bytes(rendered) > MAX_DEPENDENCY_TEXT_BYTES &&
    parts.length > 3
  ) {
    parts.pop()
    rendered = parts.join("; ")
  }
  return rendered
}

function appendDescription(existing, additions) {
  const text = [
    typeof existing === "string" ? existing.trim() : "",
    ...additions.filter(
      (value) => typeof value === "string" && value.trim(),
    ),
  ]
    .filter(Boolean)
    .join(" ")

  return text
}

export function compileRepairWitnessClosure({
  tool,
  binding,
  repairCache = null,
  repairLock = null,
  dependencyEvidence = null,
} = {}) {
  const sourceSchema = sourceProperties(tool)
  if (!sourceSchema) {
    return fail("repair_witness_tool_schema_unavailable")
  }

  const byKey = rowMap(binding)
  const sourceKeys = Object.keys(sourceSchema.properties).sort()
  if (sourceKeys.length < 1) {
    return fail("repair_witness_source_frontier_empty")
  }

  if (sourceKeys.some((key) => !byKey.has(key))) {
    return fail("repair_witness_binding_incomplete")
  }

  const failedKeys = new Set(
    Array.isArray(repairCache?.failed_source_keys)
      ? repairCache.failed_source_keys
      : [],
  )
  const repairActive = failedKeys.size > 0

  if (
    repairActive &&
    sourceKeys.some((key) => !failedKeys.has(key))
  ) {
    return fail("repair_witness_frontier_widened")
  }

  const cloned = cloneJson(tool)
  const clonedHolder = schemaObject(cloned)
  const clonedProperties =
    clonedHolder.schema.properties.sources.properties

  const witnesses = {}
  let unresolvedSymbol = null

  for (const sourceKey of sourceKeys) {
    const row = byKey.get(sourceKey)
    const representation =
      representationWitness(
        row,
        repairActive,
        clonedProperties[sourceKey],
      )
    const counterexample =
      counterexampleForKey(repairLock, sourceKey)
    const counterexampleText =
      renderCounterexample(counterexample)
    const dependencyText =
      row?.kind === "python_declaration"
        ? renderDependencyEvidence(dependencyEvidence)
        : null

    clonedProperties[sourceKey].description =
      appendDescription(
        clonedProperties[sourceKey].description,
        [
          `REPAIR_WITNESS_PROTOCOL=${REPAIR_WITNESS_CLOSURE_PROTOCOL}.`,
          representation + ".",
          repairActive
            ? "SIBLING_SOURCES=preserved_byte_identical; do_not_reemit_preserved_sources."
            : null,
          counterexampleText
            ? counterexampleText + "."
            : null,
          dependencyText
            ? dependencyText + "."
            : null,
        ],
      )

    if (counterexample?.unresolved_symbol) {
      unresolvedSymbol = counterexample.unresolved_symbol
    }

    witnesses[sourceKey] = Object.freeze({
      representation,
      counterexample,
      dependency_evidence:
        row?.kind === "python_declaration"
          ? dependencyEvidence?.protocol ?? null
          : null,
    })
  }

  cloned.description = appendDescription(
    cloned.description,
    [
      repairActive
        ? `REPAIR_WITNESS_CLOSURE=${REPAIR_WITNESS_CLOSURE_PROTOCOL}; repair_only_failed_sources=true; preserved_siblings_must_not_be_reemitted=true.`
        : `SOURCE_WITNESS_CLOSURE=${REPAIR_WITNESS_CLOSURE_PROTOCOL}; emit_only_bounded_source_deltas=true.`,
    ],
  )

  return Object.freeze({
    ok: true,
    protocol: REPAIR_WITNESS_CLOSURE_PROTOCOL,
    tool: Object.freeze(cloned),
    source_keys: Object.freeze(sourceKeys),
    repair_active: repairActive,
    unresolved_symbol: unresolvedSymbol,
    dependency_evidence_status:
      dependencyEvidence?.ok === true ? "source_backed" : "unavailable",
    witnesses: Object.freeze(witnesses),
    mutation_authority: false,
    model_authority: false,
    authority_expansion: false,
  })
}
