import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PYTHON_SEMANTIC_FRONTEND_PROTOCOL =
  "python-semantic-frontend-v3"
export const PYTHON_UNIT_SHELL_PROTOCOL =
  "python-unit-shell-v1"
export const SEMANTIC_CANONICALIZER_PROTOCOL =
  "semantic-canonicalizer-v1"
export const RUFF_PYTHON_BRIDGE_PROTOCOL =
  "ruff-python-bridge-v1"
export const PYTHON_BINDING_CAPABILITY_PROTOCOL =
  "python-binding-capability-v1"
export const KOALIK_PROVENANCE_PROTOCOL =
  "koalik-provenance-v1"
export const PYTHON_SCOPE_LATTICE_PROTOCOL =
  "python-scope-lattice-v1"

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 256 * 1024

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: PYTHON_SEMANTIC_FRONTEND_PROTOCOL,
    unit_protocol: PYTHON_UNIT_SHELL_PROTOCOL,
    canonicalizer_protocol: SEMANTIC_CANONICALIZER_PROTOCOL,
    ruff_bridge_protocol: RUFF_PYTHON_BRIDGE_PROTOCOL,
    binding_protocol: PYTHON_BINDING_CAPABILITY_PROTOCOL,
    provenance_protocol: KOALIK_PROVENANCE_PROTOCOL,
    reason,
    mutation_authority: false,
    model_import_authority: false,
    ...extra,
  })
}

function validStringArray(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string")
}

function validateFrontendOutput(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return fail("python_unit_output_invalid")
  }

  const protocols = [
    ["protocol", PYTHON_SEMANTIC_FRONTEND_PROTOCOL],
    ["unit_protocol", PYTHON_UNIT_SHELL_PROTOCOL],
    ["canonicalizer_protocol", SEMANTIC_CANONICALIZER_PROTOCOL],
    ["ruff_bridge_protocol", RUFF_PYTHON_BRIDGE_PROTOCOL],
    ["binding_protocol", PYTHON_BINDING_CAPABILITY_PROTOCOL],
    ["provenance_protocol", KOALIK_PROVENANCE_PROTOCOL],
  ]

  for (const [field, expected] of protocols) {
    if (value[field] !== expected) {
      return fail("python_unit_protocol_mismatch", {
        field,
        expected,
        observed: value[field] ?? null,
      })
    }
  }

  if (
    "mutation_authority" in value &&
    value.mutation_authority !== false
  ) {
    return fail("python_unit_mutation_authority_invalid", {
      observed: value.mutation_authority,
    })
  }

  if (value.model_import_authority !== false) {
    return fail("python_unit_model_import_authority_invalid", {
      observed: value.model_import_authority ?? null,
    })
  }

  if (value.ok === false) {
    if (
      typeof value.reason !== "string" ||
      value.reason.length < 1
    ) {
      return fail("python_unit_failure_shape_invalid")
    }

    return Object.freeze(value)
  }

  if (value.ok !== true) {
    return fail("python_unit_output_invalid")
  }

  if (value.authority_expansion !== false) {
    return fail("python_unit_authority_expansion", {
      observed: value.authority_expansion ?? null,
    })
  }

  if (
    typeof value.declaration !== "string" ||
    value.declaration.trim().length < 1
  ) {
    return fail("python_unit_declaration_invalid")
  }

  if (!validStringArray(value.modules)) {
    return fail("python_unit_modules_invalid")
  }

  if (
    !Array.isArray(value.from_imports) ||
    !value.from_imports.every(
      (row) =>
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        typeof row.module === "string" &&
        row.module.length > 0 &&
        typeof row.name === "string" &&
        row.name.length > 0,
    )
  ) {
    return fail("python_unit_from_imports_invalid")
  }

  if (!Array.isArray(value.bindings)) {
    return fail("python_unit_bindings_invalid")
  }

  if (
    !value.alias_rewrites ||
    typeof value.alias_rewrites !== "object" ||
    Array.isArray(value.alias_rewrites)
  ) {
    return fail("python_unit_alias_rewrites_invalid")
  }

  if (!validStringArray(value.normalizations)) {
    return fail("python_unit_normalizations_invalid")
  }

  if (!Array.isArray(value.model_import_hints)) {
    return fail("python_unit_model_import_hints_invalid")
  }

  if (
    value.scope_protocol !== PYTHON_SCOPE_LATTICE_PROTOCOL
  ) {
    return fail("python_unit_scope_protocol_invalid", {
      observed: value.scope_protocol ?? null,
    })
  }

  if (
    typeof value.scope_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.scope_sha256)
  ) {
    return fail("python_unit_scope_sha256_invalid")
  }

  if (
    !Array.isArray(value.scoped_imports) ||
    value.scoped_imports.some((row) =>
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      row.scope_preserved !== true ||
      row.model_authority !== false ||
      !Array.isArray(row.lexical_path) ||
      !Array.isArray(row.execution_path)
    )
  ) {
    return fail("python_unit_scoped_imports_invalid")
  }

  if (
    !value.scope_summary ||
    typeof value.scope_summary !== "object" ||
    Array.isArray(value.scope_summary)
  ) {
    return fail("python_unit_scope_summary_invalid")
  }

  if (
    !value.provenance ||
    typeof value.provenance !== "object" ||
    Array.isArray(value.provenance) ||
    value.provenance.protocol !== KOALIK_PROVENANCE_PROTOCOL
  ) {
    return fail("python_unit_provenance_invalid")
  }

  return Object.freeze(value)
}

function helperPath() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, "python-semantic-frontend-v1.py")
}

export async function compilePythonSemanticUnits(
  payload,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    python = process.env.OPENCODE_PYTHON ?? "python3",
  } = {},
) {
  if (!payload || typeof payload !== "object") {
    return fail("python_unit_payload_invalid")
  }

  return await new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false

    const child = spawn(
      python,
      ["-S", helperPath()],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: process.env,
      },
    )

    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(fail("python_unit_timeout", { timeout_ms: timeoutMs }))
    }, timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL")
        finish(fail("python_unit_stdout_budget_exceeded"))
      }
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
        child.kill("SIGKILL")
        finish(fail("python_unit_stderr_budget_exceeded"))
      }
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      finish(
        fail("python_unit_spawn_failed", {
          detail: error?.code ?? error?.name ?? "spawn_error",
        }),
      )
    })

    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      if (code !== 0) {
        finish(
          fail("python_unit_process_failed", {
            rc: code,
            signal: signal ?? null,
            stderr: stderr.slice(0, 4096),
          }),
        )
        return
      }

      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        finish(
          fail("python_unit_output_invalid", {
            stdout: stdout.slice(0, 4096),
            stderr: stderr.slice(0, 4096),
          }),
        )
        return
      }

      finish(validateFrontendOutput(parsed))
    })

    try {
      child.stdin.end(JSON.stringify(payload))
    } catch {
      clearTimeout(timer)
      child.kill("SIGKILL")
      finish(fail("python_unit_stdin_failed"))
    }
  })
}
