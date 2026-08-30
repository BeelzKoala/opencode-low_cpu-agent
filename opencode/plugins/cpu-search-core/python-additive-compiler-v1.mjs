import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"

import {
  resolveSealedAdditiveInsertion,
} from "./sealed-additive-site-v1.mjs"

export const PYTHON_ADDITIVE_COMPILER_PROTOCOL =
  "typed-python-additive-compiler-v1"
export const CANDIDATE_STATIC_PREFLIGHT_PROTOCOL =
  "candidate-static-preflight-v1"
export const PYTHON_IR_CANONICALIZER_PROTOCOL =
  "python-ir-canonicalizer-v1"

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const PYTHON_HELPER_TIMEOUT_MS = 2000
const PYTHON_HELPER_MAX_OUTPUT_BYTES = 512 * 1024
const SHA256_RE = /^[0-9a-f]{64}$/u

const PYTHON_HELPER = String.raw`
import ast
import json
import re
import sys
import textwrap

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DOTTED = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")


def fail(reason, detail=None):
    print(json.dumps({"ok": False, "reason": reason, "detail": detail}))
    raise SystemExit(0)


def newline_of(source):
    return "\r\n" if "\r\n" in source else "\n"


def source_lines(source):
    return source.splitlines(keepends=True)


def node_text(source, node):
    lines = source_lines(source)
    start = node.lineno - 1
    end = node.end_lineno
    if start < 0 or end <= start or end > len(lines):
        return None
    return "".join(lines[start:end])


def module_docstring_node(tree):
    if not tree.body:
        return None
    node = tree.body[0]
    if (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    ):
        return node
    return None


def import_prefix(tree):
    body = list(tree.body)
    index = 1 if module_docstring_node(tree) is not None else 0
    future = []
    normal = []

    while index < len(body):
        node = body[index]
        if (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and node.module == "__future__"
        ):
            future.append(node)
            index += 1
            continue
        break

    while index < len(body):
        node = body[index]
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom) and node.level != 0:
                break
            normal.append(node)
            index += 1
            continue
        break

    return future, normal


def import_key(kind, module, name, asname, level=0):
    return (kind, module, name, asname or "", int(level))


def existing_import_keys(tree):
    keys = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                keys.add(import_key("import", alias.name, "", alias.asname, 0))
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                if alias.name == "*":
                    continue
                keys.add(
                    import_key(
                        "from",
                        module,
                        alias.name,
                        alias.asname,
                        node.level,
                    )
                )
    return keys


def render_import(spec):
    kind = spec["kind"]
    module = spec["module"]
    name = spec["name"]
    asname = spec["asname"]
    level = spec["level"]

    if kind == "import":
        return f"import {module}" + (f" as {asname}" if asname else "")

    prefix = "." * level
    source = prefix + module
    return (
        f"from {source} import {name}"
        + (f" as {asname}" if asname else "")
    )


def canonicalize_declaration_fragments(raw):
    declarations = []
    extracted_imports = []
    import_count = 0
    declaration_count = 0
    comment_only_fragments = 0

    for index, value in enumerate(raw):
        if not isinstance(value, str) or not value.strip():
            fail("python_declaration_content_invalid", index)

        content = textwrap.dedent(value).strip("\r\n")
        if not content:
            fail("python_declaration_content_invalid", index)

        lowered = content.lower()
        if any(
            marker in lowered
            for marker in (
                "# noqa",
                "# type: ignore",
                "# pyright:",
                "# mypy:",
                "# ruff:",
            )
        ):
            fail("python_fragment_tooling_directive_unsupported", index)

        try:
            tree = ast.parse(content)
        except SyntaxError as exc:
            fail(
                "python_declaration_syntax_invalid",
                {"index": index, "line": exc.lineno, "offset": exc.offset},
            )

        if not tree.body:
            comment_only_fragments += 1
            continue

        fragment_declarations = []
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    extracted_imports.append({
                        "kind": "import",
                        "module": alias.name,
                        "name": "",
                        "asname": alias.asname or "",
                        "level": 0,
                    })
                    import_count += 1
                continue

            if isinstance(node, ast.ImportFrom):
                if node.module == "__future__":
                    fail("python_fragment_future_import_unsupported", index)
                for alias in node.names:
                    if alias.name == "*":
                        fail("python_fragment_star_import_unsupported", index)
                    extracted_imports.append({
                        "kind": "from",
                        "module": node.module or "",
                        "name": alias.name,
                        "asname": alias.asname or "",
                        "level": int(node.level),
                    })
                    import_count += 1
                continue

            if isinstance(
                node,
                (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
            ):
                lines = content.splitlines(keepends=True)
                start_node = (
                    node.decorator_list[0]
                    if node.decorator_list
                    else node
                )
                start = start_node.lineno - 1
                end = node.end_lineno
                if (
                    start < 0
                    or not isinstance(end, int)
                    or end <= start
                    or end > len(lines)
                ):
                    fail(
                        "python_declaration_source_segment_invalid",
                        {"index": index, "kind": type(node).__name__},
                    )
                segment = "".join(lines[start:end])
                if not segment.strip():
                    fail(
                        "python_declaration_source_segment_invalid",
                        {"index": index, "kind": type(node).__name__},
                    )
                fragment_declarations.append(
                    textwrap.dedent(segment).strip("\r\n")
                )
                declaration_count += 1
                continue

            fail(
                "python_declaration_statement_kind_invalid",
                {"index": index, "kind": type(node).__name__},
            )

        if fragment_declarations:
            declarations.append("\n\n".join(fragment_declarations))

    return {
        "declarations": declarations,
        "imports": extracted_imports,
        "normalization": {
            "imports_reclassified": import_count,
            "declarations_retained": declaration_count,
            "comment_only_fragments_dropped": comment_only_fragments,
        },
    }


def plan(payload):
    source = payload.get("source")
    modules = payload.get("modules", [])
    from_imports = payload.get("from_imports", [])
    declarations = payload.get("declarations", [])

    if not isinstance(source, str):
        fail("python_source_invalid")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        fail(
            "python_base_syntax_invalid",
            {"line": exc.lineno, "offset": exc.offset},
        )

    if not isinstance(modules, list) or not isinstance(from_imports, list):
        fail("python_import_request_invalid")
    for value in modules:
        if not isinstance(value, str) or DOTTED.fullmatch(value) is None:
            fail("python_import_module_invalid", value)
    normalized_froms = []
    for row in from_imports:
        if not isinstance(row, dict) or set(row) != {"module", "name"}:
            fail("python_from_import_shape_invalid")
        module = row.get("module")
        name = row.get("name")
        if (
            not isinstance(module, str)
            or DOTTED.fullmatch(module) is None
            or not isinstance(name, str)
            or IDENT.fullmatch(name) is None
        ):
            fail("python_from_import_identifier_invalid", row)
        normalized_froms.append((module, name))

    canonicalized = canonicalize_declaration_fragments(declarations)

    requested_imports = []
    for module in modules:
        requested_imports.append({
            "kind": "import",
            "module": module,
            "name": "",
            "asname": "",
            "level": 0,
        })
    for module, name in normalized_froms:
        requested_imports.append({
            "kind": "from",
            "module": module,
            "name": name,
            "asname": "",
            "level": 0,
        })
    requested_imports.extend(canonicalized["imports"])

    existing_keys = existing_import_keys(tree)
    deduped = {}
    for spec in requested_imports:
        key = import_key(
            spec["kind"],
            spec["module"],
            spec["name"],
            spec["asname"],
            spec["level"],
        )
        deduped[key] = spec

    missing_specs = [
        deduped[key]
        for key in sorted(deduped)
        if key not in existing_keys
    ]

    nl = newline_of(source)
    import_lines = [render_import(spec) for spec in missing_specs]
    import_edit = None

    if import_lines:
        block = nl.join(import_lines) + nl
        future, normal = import_prefix(tree)
        doc = module_docstring_node(tree)

        if normal:
            anchor = node_text(source, normal[-1])
            if not anchor:
                fail("python_import_anchor_invalid")
            replacement = anchor + ("" if anchor.endswith(("\n", "\r")) else nl) + block
        elif future:
            anchor = node_text(source, future[-1])
            if not anchor:
                fail("python_import_anchor_invalid")
            replacement = (
                anchor
                + ("" if anchor.endswith(("\n", "\r")) else nl)
                + nl
                + block
            )
        elif doc is not None:
            anchor = node_text(source, doc)
            if not anchor:
                fail("python_import_anchor_invalid")
            replacement = (
                anchor
                + ("" if anchor.endswith(("\n", "\r")) else nl)
                + nl
                + block
            )
        elif tree.body:
            anchor = node_text(source, tree.body[0])
            if not anchor:
                fail("python_import_anchor_invalid")
            replacement = block + nl + anchor
        else:
            fail("python_import_anchor_unavailable")

        import_edit = {
            "before": anchor,
            "replacement": replacement,
            "missing_imports": missing_specs,
        }

    print(json.dumps({
        "ok": True,
        "source_syntax": "passed",
        "import_edit": import_edit,
        "normalized_declarations": canonicalized["declarations"],
        "ir_normalization": canonicalized["normalization"],
    }))


def syntax(payload):
    source = payload.get("source")
    if not isinstance(source, str):
        fail("python_candidate_invalid")
    try:
        ast.parse(source)
    except SyntaxError as exc:
        fail(
            "python_candidate_syntax_invalid",
            {"line": exc.lineno, "offset": exc.offset, "msg": exc.msg},
        )
    print(json.dumps({"ok": True, "syntax": "passed"}))


payload = json.loads(sys.stdin.read())
mode = payload.get("mode")
if mode == "plan":
    plan(payload)
elif mode == "syntax":
    syntax(payload)
else:
    fail("python_helper_mode_invalid")
`

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function fail(reason, detail = null, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    reason,
    detail,
    repairable: false,
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

function pythonBinary() {
  const override = process.env.OPENCODE_PYTHON_BIN
  return typeof override === "string" && override.length > 0
    ? override
    : "python3"
}

function runPythonHelper(payload, cwd) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    let timedOut = false

    const child = spawn(
      pythonBinary(),
      ["-I", "-c", PYTHON_HELPER],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    )

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, PYTHON_HELPER_TIMEOUT_MS)

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout.on("data", (chunk) => {
      if (stdout.length > PYTHON_HELPER_MAX_OUTPUT_BYTES) return
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > PYTHON_HELPER_MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL")
      }
    })
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= 8192) return
      stderr = Buffer.concat([stderr, chunk]).subarray(0, 8192)
    })
    child.on("error", (error) => {
      finish(fail("python_compiler_spawn_failed", String(error?.message ?? error)))
    })
    child.on("close", (code) => {
      if (settled) return
      if (timedOut) {
        finish(fail("python_compiler_timeout"))
        return
      }
      if (stdout.length > PYTHON_HELPER_MAX_OUTPUT_BYTES) {
        finish(fail("python_compiler_output_too_large"))
        return
      }
      if (code !== 0) {
        finish(fail(
          "python_compiler_failed",
          stderr.toString("utf8").slice(0, 1000),
          { compiler_rc: code },
        ))
        return
      }
      try {
        const parsed = JSON.parse(stdout.toString("utf8"))
        finish(parsed?.ok === true ? parsed : fail(
          parsed?.reason ?? "python_compiler_rejected",
          parsed?.detail ?? null,
        ))
      } catch {
        finish(fail("python_compiler_json_invalid"))
      }
    })

    try {
      child.stdin.end(JSON.stringify(payload))
    } catch (error) {
      child.kill("SIGKILL")
      finish(fail("python_compiler_input_failed", String(error?.message ?? error)))
    }
  })
}

function countOccurrences(haystack, needle) {
  if (typeof haystack !== "string" || typeof needle !== "string" || !needle) {
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

function applyExactVirtual(candidate, edit) {
  const count = countOccurrences(candidate, edit.before)
  if (count === 0) {
    return fail("python_candidate_preimage_absent")
  }
  if (count > 1) {
    return fail("python_candidate_preimage_ambiguous")
  }
  return Object.freeze({
    ok: true,
    candidate: candidate.replace(edit.before, edit.replacement),
  })
}

async function readAuthorizedPythonSource(root, target) {
  const file = normalizeRelativeFile(target?.file)
  if (
    typeof root !== "string" ||
    root.length < 1 ||
    !file ||
    !/\.(?:py|pyi)$/u.test(file) ||
    typeof target?.sha256 !== "string" ||
    !SHA256_RE.test(target.sha256)
  ) {
    return fail("python_target_invalid")
  }

  try {
    const rootReal = await realpath(root)
    const targetPath = path.join(rootReal, ...file.split("/"))
    const info = await lstat(targetPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      return fail("python_target_not_regular_file")
    }
    if (info.size > MAX_SOURCE_BYTES) {
      return fail("python_source_too_large")
    }
    const targetReal = await realpath(targetPath)
    const prefix = rootReal.endsWith(path.sep)
      ? rootReal
      : `${rootReal}${path.sep}`
    if (!targetReal.startsWith(prefix)) {
      return fail("python_target_escape")
    }
    const source = await readFile(targetReal)
    if (sha256(source) !== target.sha256.toLowerCase()) {
      return fail("python_base_state_changed")
    }
    const sourceText = source.toString("utf8")
    if (!Buffer.from(sourceText, "utf8").equals(source)) {
      return fail("python_source_utf8_invalid")
    }
    return Object.freeze({
      ok: true,
      root_real: rootReal,
      file,
      source: sourceText,
      source_sha256: target.sha256.toLowerCase(),
    })
  } catch (error) {
    return fail("python_source_unavailable", String(error?.message ?? error))
  }
}

async function compileDeclarationEdit({
  root,
  target,
  content,
  maxReplacementBytes,
  resolveSite,
}) {
  const candidates = []
  const lines = [...new Set(
    Array.isArray(target?.evidence_lines)
      ? target.evidence_lines.filter(
          (line) => Number.isSafeInteger(line) && line >= 1,
        )
      : [],
  )].sort((a, b) => a - b)

  for (const evidenceLine of lines) {
    const resolved = await resolveSite({
      root,
      target,
      evidenceLine,
      content,
      maxReplacementBytes,
    })
    if (
      resolved?.ok === true &&
      resolved?.operation === "insert_before"
    ) {
      candidates.push(resolved)
    }
  }

  const unique = new Map(
    candidates.map((row) => [
      `${row.site_sha256 ?? ""}\0${row.before}`,
      row,
    ]),
  )
  const rows = [...unique.values()]
  if (rows.length < 1) {
    return fail("python_declaration_site_absent")
  }
  if (rows.length > 1) {
    return fail("python_declaration_site_ambiguous", null, {
      candidate_count: rows.length,
    })
  }
  return Object.freeze({ ok: true, edit: rows[0] })
}

export async function compilePythonAdditiveEdits({
  root,
  target,
  modules = [],
  fromImports = [],
  declarations = [],
  maxReplacementBytes,
  resolveSite = resolveSealedAdditiveInsertion,
} = {}) {
  const loaded = await readAuthorizedPythonSource(root, target)
  if (loaded.ok !== true) return loaded

  const planned = await runPythonHelper({
    mode: "plan",
    source: loaded.source,
    modules,
    from_imports: fromImports,
    declarations,
  }, loaded.root_real)
  if (planned.ok !== true) return planned

  const edits = []
  if (planned.import_edit) {
    edits.push(Object.freeze({
      kind: "replace_exact",
      file: loaded.file,
      symbol: "<python:add_imports>",
      before: planned.import_edit.before,
      replacement: planned.import_edit.replacement,
      compiler_operation: "add_imports",
    }))
  }

  if (planned.normalized_declarations.length > 0) {
    const declarationContent =
      planned.normalized_declarations.join("\n\n") + "\n"
    const declaration = await compileDeclarationEdit({
      root,
      target,
      content: declarationContent,
      maxReplacementBytes,
      resolveSite,
    })
    if (declaration.ok !== true) return declaration
    edits.push(Object.freeze({
      kind: "replace_exact",
      file: loaded.file,
      symbol: "<python:add_module_declaration>",
      before: declaration.edit.before,
      replacement: declaration.edit.replacement,
      compiler_operation: "add_module_declaration",
      site_sha256: declaration.edit.site_sha256 ?? null,
    }))
  }

  let candidate = loaded.source
  for (const edit of edits) {
    const applied = applyExactVirtual(candidate, edit)
    if (applied.ok !== true) return applied
    candidate = applied.candidate
  }

  const syntax = await runPythonHelper({
    mode: "syntax",
    source: candidate,
  }, loaded.root_real)
  if (syntax.ok !== true) return syntax

  const candidateSha256 = sha256(Buffer.from(candidate, "utf8"))
  const compiledEditsSha256 = sha256(
    Buffer.from(JSON.stringify(edits), "utf8"),
  )
  const checks = Object.freeze({
    ast_syntax: "passed",
    format: "not_run",
    lint: "not_run",
    type_check: "not_run",
    complexity: "not_run",
  })
  const receiptPayload = {
    protocol: CANDIDATE_STATIC_PREFLIGHT_PROTOCOL,
    compiler_protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    ir_canonicalizer_protocol: PYTHON_IR_CANONICALIZER_PROTOCOL,
    stage: "compiler_virtual_candidate",
    file: loaded.file,
    base_sha256: loaded.source_sha256,
    candidate_sha256: candidateSha256,
    compiled_edits_sha256: compiledEditsSha256,
    parent_receipt_sha256: null,
    ir_normalization: Object.freeze({
      ...(planned.ir_normalization ?? {}),
    }),
    checks,
    mutation_authority: false,
  }
  const candidateReceipt = Object.freeze({
    ...receiptPayload,
    receipt_sha256: sha256(
      Buffer.from(JSON.stringify(receiptPayload), "utf8"),
    ),
  })

  return Object.freeze({
    ok: true,
    protocol: PYTHON_ADDITIVE_COMPILER_PROTOCOL,
    reason: "python_typed_ir_lowered",
    mutation_authority: false,
    file: loaded.file,
    base_sha256: loaded.source_sha256,
    candidate_sha256: candidateSha256,
    compiled_edits_sha256: compiledEditsSha256,
    ir_canonicalizer_protocol: PYTHON_IR_CANONICALIZER_PROTOCOL,
    ir_normalization: Object.freeze({
      ...(planned.ir_normalization ?? {}),
    }),
    edits: Object.freeze(edits),
    candidate_receipt: candidateReceipt,
  })
}
