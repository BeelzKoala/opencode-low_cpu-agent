import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"

export const SEALED_ADDITIVE_SITE_PROTOCOL = "sealed-additive-site-v1"
export const SEALED_EDIT_SITE_PROJECTION_PROTOCOL =
  "sealed-edit-site-projection-v1"
export const SEALED_EDIT_SITE_PROTOCOL = "sealed-edit-site-v1"
export const SEALED_EDIT_SITE_PROVIDER_PROTOCOL =
  "ast-grep-structural-site-v1"
export const SEALED_EDIT_SITE_BACKEND = "ast-grep-0.45.1"
export const SEALED_EDIT_SITE_AUTHORITY = "hypothesis"
export const SEALED_EDIT_SITE_COORDINATES_AUTHORITY =
  "derived_hint_only"

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 512 * 1024
const RESOLVER_TIMEOUT_MS = 2000
const SHA256_RE = /^[0-9a-f]{64}$/u

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function fail(reason, detail = null, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: SEALED_ADDITIVE_SITE_PROTOCOL,
    reason,
    detail,
    mutation_authority: false,
    ...extra,
  })
}

function normalizeRelativeFile(value) {
  if (typeof value !== "string") return null
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "")
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null
  }
  return normalized
}

function isPythonFile(file) {
  return typeof file === "string" && /\.(?:py|pyi)$/u.test(file)
}

function countNonOverlappingOccurrences(haystack, needle) {
  if (!Buffer.isBuffer(haystack) || !Buffer.isBuffer(needle) || needle.length < 1) {
    return 0
  }
  let count = 0
  let offset = 0
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset)
    if (index < 0) break
    count += 1
    if (count > 1) return count
    offset = index + needle.length
  }
  return count
}

function sourceNewline(sourceText) {
  return sourceText.includes("\r\n") ? "\r\n" : "\n"
}

function normalizeInsertedContent(content, newline) {
  if (
    typeof content !== "string" ||
    content.length < 1 ||
    content.includes("\0")
  ) {
    return null
  }
  const normalized = content
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
  const withNewline = normalized.endsWith("\n")
    ? normalized
    : `${normalized}\n`
  return newline === "\n"
    ? withNewline
    : withNewline.replace(/\n/gu, "\r\n")
}

function exactSite(response, target, evidenceLine) {
  if (
    response?.protocol !== SEALED_EDIT_SITE_PROJECTION_PROTOCOL ||
    response?.provider_protocol !== SEALED_EDIT_SITE_PROVIDER_PROTOCOL ||
    response?.backend !== SEALED_EDIT_SITE_BACKEND ||
    response?.authority !== SEALED_EDIT_SITE_AUTHORITY ||
    response?.complete !== true ||
    !Array.isArray(response?.sites) ||
    !Array.isArray(response?.errors) ||
    response.errors.length !== 0
  ) {
    return fail("additive_site_projection_invalid")
  }

  const matches = response.sites.filter((site) =>
    site?.protocol === SEALED_EDIT_SITE_PROTOCOL &&
    site?.authority === SEALED_EDIT_SITE_AUTHORITY &&
    site?.file === target.file &&
    typeof site?.source_sha256 === "string" &&
    site.source_sha256.toLowerCase() === target.sha256.toLowerCase() &&
    site?.evidence_line === evidenceLine,
  )

  if (matches.length < 1) {
    return fail("additive_site_projection_absent")
  }
  if (matches.length > 1) {
    return fail("additive_site_projection_ambiguous")
  }
  return Object.freeze({ ok: true, site: matches[0] })
}

export function validateAndLowerSealedAdditiveSite({
  source,
  target,
  evidenceLine,
  response,
  content,
  maxReplacementBytes,
} = {}) {
  const file = normalizeRelativeFile(target?.file)
  if (
    !file ||
    !isPythonFile(file) ||
    typeof target?.sha256 !== "string" ||
    !SHA256_RE.test(target.sha256) ||
    !Array.isArray(target?.evidence_lines) ||
    !target.evidence_lines.includes(evidenceLine) ||
    !Number.isSafeInteger(evidenceLine) ||
    evidenceLine < 1
  ) {
    return fail("additive_site_target_invalid")
  }

  const sourceBuffer = Buffer.isBuffer(source)
    ? source
    : typeof source === "string"
      ? Buffer.from(source, "utf8")
      : null
  if (!sourceBuffer || sourceBuffer.length > MAX_SOURCE_BYTES) {
    return fail("additive_site_source_invalid")
  }
  if (sha256(sourceBuffer) !== target.sha256.toLowerCase()) {
    return fail("additive_site_source_changed")
  }

  const projected = exactSite(response, { ...target, file }, evidenceLine)
  if (projected.ok !== true) return projected
  const site = projected.site

  if (
    site?.language !== "python" ||
    site?.provider_protocol !== SEALED_EDIT_SITE_PROVIDER_PROTOCOL ||
    site?.backend !== SEALED_EDIT_SITE_BACKEND ||
    site?.coordinates_authority !== SEALED_EDIT_SITE_COORDINATES_AUTHORITY ||
    typeof site?.node_kind !== "string" ||
    site.node_kind.length < 1 ||
    !Array.isArray(site?.structural_path) ||
    site.structural_path.some(
      (index) => !Number.isSafeInteger(index) || index < 0,
    ) ||
    typeof site?.relation !== "string" ||
    site.relation.length < 1 ||
    typeof site?.descriptor_sha256 !== "string" ||
    !SHA256_RE.test(site.descriptor_sha256) ||
    typeof site?.evidence_binding_sha256 !== "string" ||
    !SHA256_RE.test(site.evidence_binding_sha256) ||
    typeof site?.site_sha256 !== "string" ||
    !SHA256_RE.test(site.site_sha256) ||
    !new Set(["insert_before", "insert_after"]).has(site?.operation)
  ) {
    return fail("additive_site_contract_invalid")
  }

  const start = site?.derived_anchor_start_byte
  const end = site?.derived_anchor_end_byte
  const insertByte = site?.derived_insert_byte
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(insertByte) ||
    start < 0 ||
    end <= start ||
    end > sourceBuffer.length ||
    insertByte !== (site.operation === "insert_before" ? start : end)
  ) {
    return fail("additive_site_coordinates_invalid")
  }

  const anchor = sourceBuffer.subarray(start, end)
  if (
    typeof site?.anchor_text_sha256 !== "string" ||
    !SHA256_RE.test(site.anchor_text_sha256) ||
    sha256(anchor) !== site.anchor_text_sha256.toLowerCase()
  ) {
    return fail("additive_site_anchor_digest_mismatch")
  }

  const occurrences = countNonOverlappingOccurrences(sourceBuffer, anchor)
  if (occurrences === 0) {
    return fail("additive_site_anchor_absent")
  }
  if (occurrences > 1) {
    return fail("additive_site_anchor_ambiguous")
  }

  const sourceText = sourceBuffer.toString("utf8")
  if (!Buffer.from(sourceText, "utf8").equals(sourceBuffer)) {
    return fail("additive_site_source_utf8_invalid")
  }
  const newline = sourceNewline(sourceText)
  const inserted = normalizeInsertedContent(content, newline)
  if (!inserted) {
    return fail("additive_site_content_invalid")
  }

  const before = anchor.toString("utf8")
  if (inserted.includes(before)) {
    return fail("additive_site_content_contains_preimage")
  }

  const replacement =
    site.operation === "insert_before"
      ? `${inserted}${before}`
      : `${before}${before.endsWith(newline) ? "" : newline}${inserted}`

  if (
    Number.isSafeInteger(maxReplacementBytes) &&
    maxReplacementBytes > 0 &&
    Buffer.byteLength(replacement, "utf8") > maxReplacementBytes
  ) {
    return fail("additive_site_replacement_too_large")
  }

  return Object.freeze({
    ok: true,
    protocol: SEALED_ADDITIVE_SITE_PROTOCOL,
    reason: "sealed_site_lowered",
    mutation_authority: false,
    file,
    evidence_line: evidenceLine,
    site_id: typeof site.site_id === "string" ? site.site_id : null,
    site_sha256:
      typeof site.site_sha256 === "string" ? site.site_sha256 : null,
    operation: site.operation,
    before,
    replacement,
    anchor_bytes: anchor.length,
    content_bytes: Buffer.byteLength(inserted, "utf8"),
  })
}

function resolverBinary() {
  const override = process.env.OPENCODE_SEALED_EDIT_SITE
  if (typeof override === "string" && override.length > 0) return override
  const runtimeDir =
    process.env.OPENCODE_RUNTIME_DIR ??
    path.join(os.homedir(), ".local", "libexec", "opencode-cpu-agent")
  return path.join(runtimeDir, "opencode-sealed-edit-site")
}

function runProjection(binary, request, cwd) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    let timedOut = false

    const child = spawn(binary, [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, RESOLVER_TIMEOUT_MS)

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout.on("data", (chunk) => {
      if (stdout.length > MAX_RESPONSE_BYTES) return
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > MAX_RESPONSE_BYTES) child.kill("SIGKILL")
    })
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= 8192) return
      stderr = Buffer.concat([stderr, chunk]).subarray(0, 8192)
    })
    child.on("error", (error) => {
      finish(fail("additive_site_resolver_spawn_failed", String(error?.message ?? error)))
    })
    child.on("close", (code) => {
      if (settled) return
      if (timedOut) {
        finish(fail("additive_site_resolver_timeout"))
        return
      }
      if (stdout.length > MAX_RESPONSE_BYTES) {
        finish(fail("additive_site_resolver_output_too_large"))
        return
      }
      if (code !== 0) {
        finish(fail(
          "additive_site_resolver_failed",
          stderr.toString("utf8").slice(0, 1000),
          { resolver_rc: code },
        ))
        return
      }
      try {
        finish(Object.freeze({
          ok: true,
          response: JSON.parse(stdout.toString("utf8")),
        }))
      } catch {
        finish(fail("additive_site_resolver_json_invalid"))
      }
    })

    try {
      child.stdin.end(JSON.stringify(request))
    } catch (error) {
      child.kill("SIGKILL")
      finish(fail("additive_site_resolver_input_failed", String(error?.message ?? error)))
    }
  })
}

export async function resolveSealedAdditiveInsertion({
  root,
  target,
  evidenceLine,
  content,
  maxReplacementBytes,
} = {}) {
  const file = normalizeRelativeFile(target?.file)
  if (
    typeof root !== "string" ||
    root.length < 1 ||
    !file ||
    !isPythonFile(file)
  ) {
    return fail("additive_site_target_invalid")
  }

  let rootReal
  let targetReal
  let targetStat
  let source
  try {
    rootReal = await realpath(root)
    const targetPath = path.join(rootReal, ...file.split("/"))
    targetStat = await lstat(targetPath)
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      return fail("additive_site_target_not_regular_file")
    }
    targetReal = await realpath(targetPath)
    const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`
    if (!targetReal.startsWith(prefix)) {
      return fail("additive_site_target_escape")
    }
    if (targetStat.size > MAX_SOURCE_BYTES) {
      return fail("additive_site_source_too_large")
    }
    source = await readFile(targetReal)
  } catch (error) {
    return fail("additive_site_source_unavailable", String(error?.message ?? error))
  }

  if (
    typeof target?.sha256 !== "string" ||
    !SHA256_RE.test(target.sha256) ||
    sha256(source) !== target.sha256.toLowerCase()
  ) {
    return fail("additive_site_source_changed")
  }
  if (
    !Number.isSafeInteger(evidenceLine) ||
    evidenceLine < 1 ||
    !Array.isArray(target?.evidence_lines) ||
    !target.evidence_lines.includes(evidenceLine)
  ) {
    return fail("additive_site_evidence_line_unattested")
  }

  const projected = await runProjection(
    resolverBinary(),
    {
      root: rootReal,
      files: [{
        file,
        source_sha256: target.sha256.toLowerCase(),
        evidence_lines: [evidenceLine],
      }],
    },
    rootReal,
  )
  if (projected.ok !== true) return projected

  return validateAndLowerSealedAdditiveSite({
    source,
    target: { ...target, file },
    evidenceLine,
    response: projected.response,
    content,
    maxReplacementBytes,
  })
}
