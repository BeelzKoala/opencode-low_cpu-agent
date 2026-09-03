import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  deriveSemanticContentSpec,
  materializeSemanticAdditiveRequest,
  validateSemanticContentRequest,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"

const root = await mkdtemp(path.join(os.tmpdir(), "semantic-content-ir-"))
await mkdir(path.join(root, "routes"), { recursive: true })
await mkdir(path.join(root, "templates/snippets"), { recursive: true })
await mkdir(path.join(root, "templates"), { recursive: true })

const server = "from flask import Blueprint\n\nbp = Blueprint('x', __name__)\n"
const menu = "<ul>\n  <li>\n    <a href=\"/old\">Old</a>\n  </li>\n</ul>\n"
const ui = "<html><body>source</body></html>\n"

await writeFile(path.join(root, "routes/x.py"), server)
await writeFile(path.join(root, "templates/snippets/menu.html"), menu)
await writeFile(path.join(root, "templates/source.html"), ui)

const sha = (value) => createHash("sha256").update(value).digest("hex")

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
      source_file: "templates/source.html",
      source_sha256: sha(ui),
      evidence_lines: [1],
      allowed_extensions: [".html"],
      max_depth: 2,
      allowed_operations: ["create_file"],
    },
  ],
}

const spec = deriveSemanticContentSpec({ capability })
assert.equal(spec.ok, true)
assert.deepEqual(spec.content_ids, ["op_0", "op_1", "op_2"])
assert.equal(spec.model_authority.file, false)
assert.equal(spec.model_authority.source_preimage, false)

const semantic = {
  contents: [
    {
      id: "op_0",
      content: {
        kind: "python_units",
        units: [
          {
            kind: "function",
            name: "new_page",
            parameters: "",
            decorators: ["bp.route('/new')"],
            suite: [
              "import io",
              "return io.StringIO('resource://op_2').getvalue()",
            ],
          },
        ],
      },
    },
    {
      id: "op_1",
      content: {
        kind: "text",
        mode: "after",
        text: '  <li><a href="/new">New</a></li>\n',
      },
    },
    {
      id: "op_2",
      content: {
        kind: "text",
        mode: "create",
        text: "<html><body>new</body></html>\n",
      },
    },
  ],
}

assert.equal(validateSemanticContentRequest({ spec, request: semantic }).ok, true)
const materialized = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: semantic,
})
assert.equal(
  materialized.ok,
  true,
  JSON.stringify(materialized, null, 2),
)
assert.equal(
  materialized.request.python_imports.length,
  0,
)

// C5 scope contract: imports authored inside a semantic Python
// declaration remain in their lexical scope. They are validated
// deterministically but are not hoisted into the physical
// module-level python_imports surface.
assert.equal(materialized.request.python_declarations.length, 1)

const pythonDeclaration =
  materialized.request.python_declarations[0].content

assert.match(
  pythonDeclaration,
  /^    import io$/mu,
)
assert.match(materialized.request.python_declarations[0].content, /source_ui_surface\.html/u)
assert.doesNotMatch(
  materialized.request.python_declarations[0].content,
  /resource:\/\//u,
)
assert.doesNotMatch(
  materialized.request.python_declarations[0].content,
  /@@CREATE_PATH/u,
)
assert.equal(materialized.request.replacements.length, 1)
assert.match(materialized.request.replacements[0].before, /Old/u)
assert.match(materialized.request.replacements[0].replacement, /New/u)
assert.doesNotMatch(
  materialized.request.replacements[0].replacement,
  /@@BEFORE|resource:\/\//u,
)
assert.equal(materialized.request.creations.length, 1)
assert.equal(materialized.request.creations[0].relative_path, "source_ui_surface.html")
assert.equal(materialized.model_authority.file, false)

console.log(
  "PASS P1 semantic content IR + deterministic materializer " +
  "semantic_holes_only=true preimage_deterministic=true " +
  "create_path_deterministic=true additive_v3_lowering=true",
)
