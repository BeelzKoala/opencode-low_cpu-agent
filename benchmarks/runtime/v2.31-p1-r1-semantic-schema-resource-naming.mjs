import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  bindSemanticContentToolSchemaToCapability,
  deriveSemanticContentSpec,
  materializeSemanticAdditiveRequest,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"

const root = await mkdtemp(path.join(os.tmpdir(), "semantic-r1-"))
await mkdir(path.join(root, "routes"), { recursive: true })
await mkdir(path.join(root, "templates/snippets"), { recursive: true })
await mkdir(path.join(root, "templates"), { recursive: true })

const server = "from flask import Blueprint\n\nbp = Blueprint('x', __name__)\n"
const menu = "<ul>\n  <li>\n    <a href=\"/old\">Old</a>\n  </li>\n</ul>\n"
const ui = "<html><body>source</body></html>\n"
await writeFile(path.join(root, "routes/inventory.py"), server)
await writeFile(path.join(root, "templates/snippets/menu.html"), menu)
await writeFile(path.join(root, "templates/inventory_task.html"), ui)

const sha = (value) => createHash("sha256").update(value).digest("hex")

const capability = {
  protocol: "scout-additive-capability-v1",
  operation: "additive_surface",
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/inventory.py",
      sha256: sha(server),
      evidence_lines: [3],
      roles: ["task_anchor_owner"],
      allowed_operations: ["add_module_declaration"],
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
      source_file: "templates/inventory_task.html",
      source_sha256: sha(ui),
      evidence_lines: [1],
      allowed_extensions: [".html"],
      max_depth: 2,
      allowed_operations: ["create_file"],
    },
  ],
}

const schema = {
  type: "object",
  properties: {
    contents: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^op_[0-9]+$" },
          content: { type: "string", minLength: 1 },
        },
        required: ["id", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["contents"],
  additionalProperties: false,
}

const bound = bindSemanticContentToolSchemaToCapability({ input: schema }, capability)
assert.equal(bound.ok, true)
assert.equal(bound.reason, "semantic_schema_bound")
assert.deepEqual(
  bound.tool.input.properties.contents.items.properties.id.enum,
  ["op_0", "op_1", "op_2"],
)
assert.equal(bound.tool.input.properties.contents.minItems, 3)
assert.equal(bound.tool.input.properties.contents.maxItems, 3)

const spec = deriveSemanticContentSpec({ capability })
assert.equal(spec.ok, true)

const semantic = {
  contents: [
    {
      id: "op_0",
      content: [
        "@bp.route('/inventory/report')",
        "def inventory_report_page():",
        "    return render_template('@@CREATE_PATH:op_2@@')",
      ].join("\n"),
    },
    {
      id: "op_1",
      content: "@@BEFORE:op_1@@  <li><a href=\"/inventory/report\">Report</a></li>\n",
    },
    {
      id: "op_2",
      content: "<html><body>report</body></html>\n",
    },
  ],
}

const materialized = await materializeSemanticAdditiveRequest({ root, capability, request: semantic })
assert.equal(materialized.ok, true)
assert.equal(materialized.request.creations.length, 1)
assert.equal(materialized.request.creations[0].relative_path, "inventory_report.html")
assert.match(materialized.request.python_declarations[0].content, /inventory_report\.html/u)
assert.equal(materialized.model_authority.file, false)

console.log(
  "PASS P1-R1 semantic schema + resource naming " +
  "schema_bound=true operation_ids_closed=true " +
  "semantic_reference_naming=true physical_path_model_authority=false",
)
