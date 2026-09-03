import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  materializeSemanticAdditiveRequest,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"

const root = await mkdtemp(
  path.join(os.tmpdir(), "semantic-import-shape-"),
)
await mkdir(path.join(root, "routes"), { recursive: true })
await mkdir(path.join(root, "templates/snippets"), { recursive: true })
await mkdir(path.join(root, "templates"), { recursive: true })

const server =
  "from flask import Blueprint\n\n" +
  "bp = Blueprint('x', __name__)\n"
const menu =
  "<ul>\n" +
  "  <li>\n" +
  '    <a href="/old">Old</a>\n' +
  "  </li>\n" +
  "</ul>\n"
const ui = "<html><body>source</body></html>\n"

await writeFile(path.join(root, "routes/x.py"), server)
await writeFile(
  path.join(root, "templates/snippets/menu.html"),
  menu,
)
await writeFile(
  path.join(root, "templates/source.html"),
  ui,
)

const sha = (value) =>
  createHash("sha256").update(value).digest("hex")

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/x.py",
      sha256: sha(server),
      evidence_lines: [3],
      roles: ["task_anchor_owner"],
      allowed_operations: [
        "add_imports",
        "add_module_declaration",
      ],
    },
    {
      slot: "existing:1",
      file: "templates/snippets/menu.html",
      sha256: sha(menu),
      evidence_lines: [3],
      roles: ["navigation_host"],
      allowed_operations: ["replace_exact"],
    },
  ],
  create_slots: [
    {
      slot: "create:0",
      root: "templates",
      source_file: "templates/source.html",
      source_sha256: sha(ui),
      evidence_lines: [1],
      allowed_extensions: [".html"],
      allowed_operations: ["create_file"],
    },
  ],
}

const request = {
  contents: [
    {
      id: "op_0",
      content: [
        "import io, json",
        "from flask import (",
        "  request,",
        "  send_file,",
        ")",
        "from openpyxl.styles import Font, PatternFill",
        "",
        "@bp.route('/download')",
        "def download():",
        "    return send_file(io.BytesIO())",
      ].join("\n"),
    },
    {
      id: "op_1",
      content:
        "@@BEFORE:op_1@@\n" +
        '<li><a href="/download">Download</a></li>\n',
    },
    {
      id: "op_2",
      content:
        '<a href="@@CREATE_PATH:op_2@@">Download</a>\n',
    },
  ],
}

const result = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request,
})

assert.equal(
  result.ok,
  true,
  `${result.reason ?? "unknown"} ${result.detail ?? ""}`,
)

assert.equal(result.request.python_imports.length, 1)
assert.deepEqual(
  result.request.python_imports[0].modules,
  ["io", "json"],
)
assert.deepEqual(
  result.request.python_imports[0].from_imports,
  [
    { module: "flask", name: "request" },
    { module: "flask", name: "send_file" },
    { module: "openpyxl.styles", name: "Font" },
    { module: "openpyxl.styles", name: "PatternFill" },
  ],
)

assert.equal(
  result.request.python_declarations[0].content,
  [
    "@bp.route('/download')",
    "def download():",
    "    return send_file(io.BytesIO())",
  ].join("\n"),
)

const aliasResult = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: {
    ...request,
    contents: request.contents.map((row) =>
      row.id === "op_0"
        ? {
            ...row,
            content:
              "import pandas as pd\n\n" +
              "def download():\n" +
              "    return None\n",
          }
        : row
    ),
  },
})

assert.equal(aliasResult.ok, false)
assert.equal(
  aliasResult.reason,
  "semantic_python_import_alias_unsupported",
)

console.log(
  "PASS M1 Python import materializer " +
  "multi_module_import=true " +
  "multi_name_from_import=true " +
  "parenthesized_from_import=true " +
  "alias_fail_closed=true",
)
