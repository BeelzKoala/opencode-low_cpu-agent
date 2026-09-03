import { createHash } from "node:crypto"
import { readFileSync, readlinkSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const STRUCTURED_OUTPUT_RUNTIME_POLICY_PROTOCOL =
  "structured-output-runtime-policy-v2"

export const LLGUIDANCE_RUNTIME_ATTESTATION_PROTOCOL =
  "llguidance-runtime-attestation-v2"

export const LLGUIDANCE_RUNTIME_MODE_ENV =
  "OPENCODE_CPU_LLGUIDANCE_MODE"

export const LLGUIDANCE_ATTESTATION_PATH_ENV =
  "OPENCODE_CPU_LLGUIDANCE_ATTESTATION_PATH"

const SHA256_RE = /^[0-9a-f]{64}$/u
const DECIMAL_RE = /^[0-9]+$/u
const MAX_PROBE_AGE_SECONDS = 6 * 60 * 60
const MAX_ATTESTATION_BYTES = 16 * 1024

function processEnv() {
  if (
    typeof process !== "object" ||
    !process ||
    typeof process.env !== "object" ||
    !process.env
  ) {
    return {}
  }
  return process.env
}

function defaultAttestationPath() {
  return path.join(
    homedir(),
    ".cache",
    "opencode-lowcpu",
    "llguidance-attestation-v2.json",
  )
}

function sha256Text(text) {
  return createHash("sha256")
    .update(text, "utf8")
    .digest("hex")
}

function parseProcStartTicks(statText) {
  if (typeof statText !== "string") return null
  const close = statText.lastIndexOf(")")
  if (close < 0) return null

  // /proc/<pid>/stat fields after comm begin at field 3.
  // Linux field 22 (starttime) is therefore zero-based index 19.
  const fields = statText
    .slice(close + 1)
    .trim()
    .split(/\s+/u)

  const value = fields[19]
  return (
    typeof value === "string" &&
    DECIMAL_RE.test(value)
  )
    ? value
    : null
}

function defaultInspectProcess(pid) {
  const statText = readFileSync(`/proc/${pid}/stat`, "utf8")
  const exePath = readlinkSync(`/proc/${pid}/exe`)
  const exeStat = statSync(`/proc/${pid}/exe`, { bigint: true })
  const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")

  return Object.freeze({
    start_ticks: parseProcStartTicks(statText),
    exe_path: exePath,
    exe_dev: String(exeStat.dev),
    exe_ino: String(exeStat.ino),
    cmdline,
  })
}

function finiteEpoch(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const epoch = Math.floor(number)
  return epoch > 0 ? epoch : null
}

function inactive(reason, extra = {}) {
  return Object.freeze({
    protocol: STRUCTURED_OUTPUT_RUNTIME_POLICY_PROTOCOL,
    active: false,
    backend: null,
    reason,
    proof_sha256: null,
    probe_age_seconds: null,
    attestation_path: null,
    live_process_bound: false,
    mutation_authority: false,
    ...extra,
  })
}

function loadLiveBoundAttestation({
  env,
  nowEpochSeconds,
  inspectProcess,
}) {
  const configured =
    typeof env[LLGUIDANCE_ATTESTATION_PATH_ENV] === "string" &&
    env[LLGUIDANCE_ATTESTATION_PATH_ENV].trim().length > 0
      ? env[LLGUIDANCE_ATTESTATION_PATH_ENV].trim()
      : defaultAttestationPath()

  let raw
  try {
    raw = readFileSync(configured)
  } catch {
    return inactive("llguidance_attestation_unavailable", {
      attestation_path: configured,
    })
  }

  if (raw.length < 2 || raw.length > MAX_ATTESTATION_BYTES) {
    return inactive("llguidance_attestation_size_invalid", {
      attestation_path: configured,
    })
  }

  let envelope
  try {
    envelope = JSON.parse(raw.toString("utf8"))
  } catch {
    return inactive("llguidance_attestation_json_invalid", {
      attestation_path: configured,
    })
  }

  if (
    envelope?.protocol !== LLGUIDANCE_RUNTIME_ATTESTATION_PROTOCOL ||
    typeof envelope.payload_json !== "string" ||
    typeof envelope.proof_sha256 !== "string" ||
    !SHA256_RE.test(envelope.proof_sha256)
  ) {
    return inactive("llguidance_attestation_envelope_invalid", {
      attestation_path: configured,
    })
  }

  const calculatedProof = sha256Text(envelope.payload_json)
  if (calculatedProof !== envelope.proof_sha256) {
    return inactive("llguidance_attestation_hash_mismatch", {
      attestation_path: configured,
    })
  }

  let payload
  try {
    payload = JSON.parse(envelope.payload_json)
  } catch {
    return inactive("llguidance_attestation_payload_invalid", {
      attestation_path: configured,
    })
  }

  if (
    payload?.protocol !== LLGUIDANCE_RUNTIME_ATTESTATION_PROTOCOL ||
    payload?.result !== "constrained_schema_exact" ||
    payload?.mutation_authority !== false
  ) {
    return inactive("llguidance_attestation_contract_invalid", {
      attestation_path: configured,
    })
  }

  const epoch = finiteEpoch(payload.epoch)
  const now = finiteEpoch(nowEpochSeconds)
  if (epoch == null || now == null) {
    return inactive("llguidance_attestation_time_invalid", {
      attestation_path: configured,
      proof_sha256: envelope.proof_sha256,
    })
  }

  const age = now - epoch
  if (age < 0 || age > MAX_PROBE_AGE_SECONDS) {
    return inactive("llguidance_attestation_stale", {
      attestation_path: configured,
      proof_sha256: envelope.proof_sha256,
      probe_age_seconds: age,
    })
  }

  const pid = Number(payload.server_pid)
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    typeof payload.server_start_ticks !== "string" ||
    !DECIMAL_RE.test(payload.server_start_ticks) ||
    typeof payload.server_exe_dev !== "string" ||
    !DECIMAL_RE.test(payload.server_exe_dev) ||
    typeof payload.server_exe_ino !== "string" ||
    !DECIMAL_RE.test(payload.server_exe_ino) ||
    typeof payload.server_exe_sha256 !== "string" ||
    !SHA256_RE.test(payload.server_exe_sha256)
  ) {
    return inactive("llguidance_process_identity_invalid", {
      attestation_path: configured,
      proof_sha256: envelope.proof_sha256,
      probe_age_seconds: age,
    })
  }

  let live
  try {
    live = inspectProcess(pid)
  } catch {
    return inactive("llguidance_attested_process_not_live", {
      attestation_path: configured,
      proof_sha256: envelope.proof_sha256,
      probe_age_seconds: age,
    })
  }

  if (live?.start_ticks !== payload.server_start_ticks) {
    return inactive("llguidance_attested_process_restarted", {
      attestation_path: configured,
      proof_sha256: envelope.proof_sha256,
      probe_age_seconds: age,
    })
  }

  if (
    live?.exe_dev !== payload.server_exe_dev ||
    live?.exe_ino !== payload.server_exe_ino
  ) {
    return inactive("llguidance_attested_executable_changed", {
      attestation_path: configured,
      proof_sha256: envelope.proof_sha256,
      probe_age_seconds: age,
    })
  }

  if (
    typeof live?.exe_path !== "string" ||
    !live.exe_path.includes("llama-server") ||
    typeof live?.cmdline !== "string" ||
    !live.cmdline.includes("llama-server")
  ) {
    return inactive("llguidance_attested_process_not_llama_server", {
      attestation_path: configured,
      proof_sha256: envelope.proof_sha256,
      probe_age_seconds: age,
    })
  }

  return Object.freeze({
    protocol: STRUCTURED_OUTPUT_RUNTIME_POLICY_PROTOCOL,
    active: true,
    backend: "llguidance",
    reason: "llguidance_live_process_attested",
    proof_sha256: envelope.proof_sha256,
    probe_age_seconds: age,
    attestation_path: configured,
    server_pid: pid,
    server_start_ticks: payload.server_start_ticks,
    server_exe_sha256: payload.server_exe_sha256,
    live_process_bound: true,
    mutation_authority: false,
  })
}

export function resolveStructuredOutputRuntimePolicy(
  language,
  {
    nowEpochSeconds = Math.floor(Date.now() / 1000),
    env = processEnv(),
    inspectProcess = defaultInspectProcess,
  } = {},
) {
  if (language?.supportsStructuredOutputs === true) {
    return Object.freeze({
      protocol: STRUCTURED_OUTPUT_RUNTIME_POLICY_PROTOCOL,
      active: true,
      backend: "provider_native",
      reason: "provider_structured_outputs_supported",
      proof_sha256: null,
      probe_age_seconds: null,
      attestation_path: null,
      live_process_bound: false,
      mutation_authority: false,
    })
  }

  const mode =
    typeof env[LLGUIDANCE_RUNTIME_MODE_ENV] === "string"
      ? env[LLGUIDANCE_RUNTIME_MODE_ENV].trim().toLowerCase()
      : "auto"

  if (mode === "off") {
    return inactive("llguidance_runtime_policy_disabled")
  }

  if (mode !== "auto" && mode !== "active") {
    return inactive("llguidance_runtime_policy_invalid")
  }

  return loadLiveBoundAttestation({
    env,
    nowEpochSeconds,
    inspectProcess,
  })
}
