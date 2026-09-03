import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("../../", import.meta.url).pathname)
process.env.OPENCODE_RUFF_PYTHON_BRIDGE =
  path.join(
    repoRoot,
    "rust/evidence-distiller/target/release/opencode-ruff-python-bridge",
  )

const {
  bindSemanticContentToolSchemaToCapability,
  materializeSemanticAdditiveRequest,
} = await import(
  "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"
)
const {
  bindSemanticObligationContract,
  validateSemanticObligationRequest,
} = await import(
  "../../opencode/plugins/cpu-search-core/semantic-obligation-bridge-v1.mjs"
)

const root = await mkdtemp(path.join(os.tmpdir(), "koalik-c3-"))
await mkdir(path.join(root, "routes"), { recursive: true })
await mkdir(path.join(root, "templates/snippets"), { recursive: true })
await mkdir(path.join(root, "templates"), { recursive: true })

const source = [
  "import json",
  "",
  "bp = object()",
  "",
  '@bp.route("/export", methods=["POST"])',
  "def export_existing():",
  "    return None",
  "",
].join("\n")
const menu = [
  "<ul>",
  "  <li>",
  '    <a href="/old">Old</a>',
  "  </li>",
  "</ul>",
  "",
].join("\n")
const template = "<html><body>source</body></html>\n"

await writeFile(path.join(root, "routes/example.py"), source)
await writeFile(path.join(root, "templates/snippets/menu.html"), menu)
await writeFile(path.join(root, "templates/source.html"), template)

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
      file: "routes/example.py",
      sha256: sha(source),
      evidence_lines: [3, 5],
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
      source_sha256: sha(template),
      evidence_lines: [1],
      allowed_extensions: [".html"],
      allowed_operations: ["create_file"],
    },
  ],
}

const good = {
  contents: [
    {
      id: "op_0",
      content: {
        kind: "python_units",
        units: [
          {
            kind: "function",
            name: "build_report",
            parameters: "rows",
            decorators: ['bp.route("/report", methods=["GET"])'],
            suite: [[
              '@bp.route("/report", methods=["GET"])',
              "def build_report(rows):",
              "    import io as buffer_io",
              "    from datetime import datetime as dt",
              "    buffer = buffer_io.BytesIO()",
              "    stamp = dt.now().isoformat()",
              "    return buffer, json.dumps({'stamp': stamp, 'rows': len(rows)})",
            ].join("\n")],
          },
        ],
      },
    },
    {
      id: "op_1",
      content: {
        kind: "text",
        mode: "after",
        text: '<li><a href="resource://op_2">Report</a></li>\n',
      },
    },
    {
      id: "op_2",
      content: {
        kind: "text",
        mode: "create",
        text: "<html><body>Report</body></html>\n",
      },
    },
  ],
}

const baseTool = {
  name: "execute_additive_plan",
  input: {
    type: "object",
    properties: {
      contents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "object" },
          },
          required: ["id", "content"],
        },
      },
    },
    required: ["contents"],
  },
}

const semanticBinding = bindSemanticContentToolSchemaToCapability(
  baseTool,
  capability,
)
assert.equal(semanticBinding.ok, true, JSON.stringify(semanticBinding))

const contract = {
  ok: true,
  contract_sha256: "c".repeat(64),
  operations: [
    { id: "op_0", kind: "python_declaration" },
    { id: "op_1", kind: "replacement" },
    { id: "op_2", kind: "creation" },
  ],
}

const bridgeBinding = bindSemanticObligationContract({
  semanticBinding,
  capability,
  contract,
})
assert.equal(bridgeBinding.ok, true, JSON.stringify(bridgeBinding))

const bridgeValidation = validateSemanticObligationRequest({
  request: good,
  capability,
  contract,
  attestation: bridgeBinding.attestation,
})
assert.equal(
  bridgeValidation.ok,
  true,
  JSON.stringify(bridgeValidation, null, 2),
)

const result = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: good,
})
assert.equal(result.ok, true, JSON.stringify(result, null, 2))
assert.equal(result.python_frontend_protocol, "python-semantic-frontend-v3")

const frontend = result.python_frontend[0]
assert.equal(frontend.canonicalizer_protocol, "semantic-canonicalizer-v1")
assert.equal(frontend.ruff_bridge_protocol, "ruff-python-bridge-v1")
assert.equal(frontend.authority_expansion, false)
assert(frontend.normalizations.includes("redundant_function_wrapper_removed"))
assert(
  frontend.normalizations.includes(
    "scoped_prefix_import_preserved",
  ),
)

assert(
  !frontend.normalizations.includes(
    "static_import_intent_extracted",
  ),
)

// C5 contract: imports authored inside a semantic function body
// retain lexical scope. They are compiler-authorized in place;
// they are no longer rewritten into module-level import hints.
assert.equal(frontend.authority_expansion, false)

assert(
  !frontend.normalizations.includes(
    "alias_canonicalized",
  ),
)

// C5 scope contract: an explicit alias on an import that remains
// inside a semantic unit is lexical program structure. It must not
// be canonicalized merely to match repository/module conventions.


const declaration = result.request.python_declarations[0].content
assert.match(declaration, /^# koalik:begin op_0:[0-9a-f]{8}$/mu)
assert.match(declaration, /def build_report\(rows\):/u)

// C5/C5-R1 scope contract:
// model-authored imports inside a semantic declaration remain in
// their exact lexical scope. Explicit aliases are lexical bindings
// and are validated, not canonicalized or hoisted.
assert.match(
  declaration,
  /^    import io as buffer_io$/mu,
)
assert.match(
  declaration,
  /^    from datetime import datetime as dt$/mu,
)
assert.match(
  declaration,
  /buffer_io\.BytesIO\(\)/u,
)
assert.match(
  declaration,
  /dt\.now\(\)/u,
)

assert.equal(frontend.scope_protocol, "python-scope-lattice-v1")
assert.equal(frontend.authority_expansion, false)

assert(Array.isArray(frontend.scoped_imports))
assert.equal(frontend.scoped_imports.length, 2)

const scopedIo = frontend.scoped_imports.find(
  (row) => row.resolved_module === "io",
)
assert(scopedIo)
assert.equal(scopedIo.alias, "buffer_io")
assert.equal(scopedIo.local, "buffer_io")
assert.equal(scopedIo.scope_preserved, true)
assert.equal(scopedIo.model_authority, false)

const scopedDatetime = frontend.scoped_imports.find(
  (row) => row.resolved_module === "datetime",
)
assert(scopedDatetime)
assert.equal(scopedDatetime.alias, "dt")
assert.equal(scopedDatetime.local, "dt")
assert.equal(scopedDatetime.scope_preserved, true)
assert.equal(scopedDatetime.model_authority, false)

// Function-local imports must not escape into the physical
// module-level import surface.
assert.deepEqual(result.request.python_imports, [])

assert.match(declaration, /# koalik:end op_0$/mu)

const replacement = result.request.replacements[0]
assert.equal(replacement.before, menu.split("\n").slice(1, 4).join("\n") + "\n")
assert.match(replacement.replacement, /source_ui_surface\.html/u)
assert(replacement.replacement.startsWith(replacement.before))
assert.doesNotMatch(replacement.replacement, /@@BEFORE/u)
assert.doesNotMatch(replacement.replacement, /resource:\/\//u)

const creation = result.request.creations[0]
assert.equal(creation.relative_path, "source_ui_surface.html")
assert.equal(creation.content, "<html><body>Report</body></html>\n")

const nestedImport = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: {
    ...good,
    contents: good.contents.map((row) =>
      row.id === "op_0"
        ? {
            id: "op_0",
            content: {
              kind: "python_units",
              units: [{
                kind: "function",
                name: "nested_import_case",
                parameters: "flag",
                suite: [
                  [
                    "if flag:",
                    "    import io",
                  ].join("\n"),
                  "return None",
                ],
              }],
            },
          }
        : row,
    ),
  },
})
assert.equal(
  nestedImport.ok,
  true,
  JSON.stringify(nestedImport, null, 2),
)

const nestedFrontend = nestedImport.python_frontend[0]

assert.equal(
  nestedFrontend.scope_protocol,
  "python-scope-lattice-v1",
)
assert.equal(
  nestedFrontend.authority_expansion,
  false,
)
assert(
  nestedFrontend.normalizations.includes(
    "scoped_nested_import_preserved",
  ),
)

const nestedScopedIo = nestedFrontend.scoped_imports.find(
  (row) => row.resolved_module === "io",
)

assert(nestedScopedIo)
assert.equal(nestedScopedIo.scope_preserved, true)
assert.equal(nestedScopedIo.model_authority, false)
assert(
  nestedScopedIo.execution_path.includes("if.body"),
)

const nestedDeclaration =
  nestedImport.request.python_declarations[0].content

assert.match(
  nestedDeclaration,
  /^        import io$/mu,
)

// Again: no lexical-scope-changing module import materialization.
assert.deepEqual(
  nestedImport.request.python_imports,
  [],
)

const wrapperConflict = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: {
    ...good,
    contents: good.contents.map((row) =>
      row.id === "op_0"
        ? {
            id: "op_0",
            content: {
              kind: "python_units",
              units: [{
                kind: "function",
                name: "conflict",
                parameters: "x",
                suite: [[
                  "def conflict(x, y):",
                  "    return x + y",
                ].join("\n")],
              }],
            },
          }
        : row,
    ),
  },
})
assert.equal(wrapperConflict.ok, false)
assert.equal(wrapperConflict.reason, "representation_ambiguous")

const oldPlaceholder = validateSemanticObligationRequest({
  request: {
    ...good,
    contents: good.contents.map((row) =>
      row.id === "op_1"
        ? {
            id: "op_1",
            content: {
              kind: "text",
              text: "@@BEFORE:op_1@@x",
            },
          }
        : row,
    ),
  },
  capability,
  contract,
  attestation: bridgeBinding.attestation,
})
assert.equal(oldPlaceholder.ok, false)
assert.equal(oldPlaceholder.reason, "semantic_obligation_text_content_invalid")

console.log(
  "PASS C3 Ruff semantic canonicalizer " +
  "ruff_parser=true " +
  "wrapper_unwrap=true " +
  "static_import_hints=true " +
  "alias_canonicalization=true " +
  "dynamic_import_fail_closed=true " +
  "text_modes=true " +
  "resource_refs=true " +
  "placeholders_model_forbidden=true " +
  "authority_monotonic=true",
)
