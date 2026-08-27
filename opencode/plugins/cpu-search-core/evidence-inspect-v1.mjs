import { createHash } from "node:crypto"

export const EVIDENCE_INSPECT_PROTOCOL = "evidence-inspect-v1"
export const EVIDENCE_INSPECT_AUTHORITY = "read_only_evidence"
export const EVIDENCE_INSPECT_MAX_RADIUS = 12
export const EVIDENCE_INSPECT_MAX_LINES = 32
export const EVIDENCE_INSPECT_MAX_BYTES = 2400

const SHA256_RE = /^[0-9a-f]{64}$/
const DRIVE_PREFIX_RE = /^[a-zA-Z]:\//

function abstain(reason, detail = null) {
  return {
    protocol: EVIDENCE_INSPECT_PROTOCOL,
    authority: EVIDENCE_INSPECT_AUTHORITY,
    mutation_authority: false,
    status: "ABSTAIN",
    reason,
    ...(detail === null ? {} : { detail }),
  }
}

function normalizeRepoPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) {
    return null
  }

  const slash = value.replaceAll("\\", "/")
  if (slash.startsWith("/") || DRIVE_PREFIX_RE.test(slash)) return null

  const parts = []
  for (const part of slash.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") return null
    parts.push(part)
  }

  return parts.length > 0 ? parts.join("/") : null
}

function normalizeEvidenceLines(value) {
  if (!Array.isArray(value) || value.length < 1) return null

  const lines = []
  for (const raw of value) {
    if (!Number.isSafeInteger(raw) || raw < 1) return null
    lines.push(raw)
  }

  return [...new Set(lines)].sort((a, b) => a - b)
}

function sourceBytes(source) {
  if (typeof source === "string") return Buffer.from(source, "utf8")
  if (Buffer.isBuffer(source)) return source
  if (source instanceof Uint8Array) return Buffer.from(source)
  return null
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function normalizeAllowedFiles(allowedFiles) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length < 1) return null

  const byFile = new Map()
  for (const row of allowedFiles) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null

    const file = normalizeRepoPath(row.file)
    const digest = typeof row.sha256 === "string" ? row.sha256.toLowerCase() : ""
    const evidenceLines = normalizeEvidenceLines(row.evidence_lines)

    if (!file || !SHA256_RE.test(digest) || !evidenceLines) return null
    if (byFile.has(file)) return null

    byFile.set(file, {
      file,
      sha256: digest,
      evidence_lines: evidenceLines,
    })
  }

  return byFile
}

export function inspectEvidence({ request, allowed_files, source } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return abstain("invalid_request")
  }

  const file = normalizeRepoPath(request.file)
  const line = request.line
  const radius = request.radius ?? 2

  if (!file) return abstain("invalid_path")
  if (!Number.isSafeInteger(line) || line < 1) return abstain("invalid_line")
  if (
    !Number.isSafeInteger(radius) ||
    radius < 0 ||
    radius > EVIDENCE_INSPECT_MAX_RADIUS
  ) {
    return abstain("invalid_radius")
  }

  const allowed = normalizeAllowedFiles(allowed_files)
  if (!allowed) return abstain("invalid_allowlist")

  const attestation = allowed.get(file)
  if (!attestation) return abstain("file_not_attested")
  if (!attestation.evidence_lines.includes(line)) {
    return abstain("line_not_attested")
  }

  const bytes = sourceBytes(source)
  if (!bytes) return abstain("invalid_source")

  const actualSha256 = sha256(bytes)
  if (actualSha256 !== attestation.sha256) {
    return abstain("stale_source", {
      expected_sha256: attestation.sha256,
      actual_sha256: actualSha256,
    })
  }

  const text = decodeUtf8(bytes)
  if (text === null) return abstain("non_utf8_source")

  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  if (line > lines.length) return abstain("line_out_of_range")

  const start = Math.max(1, line - radius)
  const end = Math.min(lines.length, line + radius)
  if (end - start + 1 > EVIDENCE_INSPECT_MAX_LINES) {
    return abstain("line_budget_exceeded")
  }

  const excerpt = []
  for (let current = start; current <= end; current += 1) {
    excerpt.push({ line: current, text: lines[current - 1] })
  }

  const excerptBytes = Buffer.byteLength(
    excerpt.map((row) => `${row.line}:${row.text}`).join("\n"),
    "utf8",
  )
  if (excerptBytes > EVIDENCE_INSPECT_MAX_BYTES) {
    return abstain("byte_budget_exceeded", {
      bytes: excerptBytes,
      max_bytes: EVIDENCE_INSPECT_MAX_BYTES,
    })
  }

  return {
    protocol: EVIDENCE_INSPECT_PROTOCOL,
    authority: EVIDENCE_INSPECT_AUTHORITY,
    mutation_authority: false,
    status: "OK",
    binding: {
      file,
      line,
      sha256: actualSha256,
    },
    window: {
      start,
      end,
      radius,
    },
    excerpt,
    budgets: {
      max_radius: EVIDENCE_INSPECT_MAX_RADIUS,
      max_lines: EVIDENCE_INSPECT_MAX_LINES,
      max_bytes: EVIDENCE_INSPECT_MAX_BYTES,
      used_lines: excerpt.length,
      used_bytes: excerptBytes,
    },
  }
}
