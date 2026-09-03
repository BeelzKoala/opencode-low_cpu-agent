import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  bindSemanticContentToolSchemaToCapability,
  materializeSemanticAdditiveRequest,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"
import {
  bindSemanticObligationContract,
  validateSemanticObligationRequest,
} from "../../opencode/plugins/cpu-search-core/semantic-obligation-bridge-v1.mjs"
import {
  SOURCE_SLOT_COMPILER_PROTOCOL,
  SOURCE_SLOT_REPAIR_PROTOCOL,
  bindSourceSlotToolSchema,
  buildSourceSlotRepairCache,
  rehydrateSourceSlotRequest,
  sourceSlotRepairAuthorityMatches,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

// Source-tree focused gates bind deterministic external tools to artifacts
// built from the same checkout, never to an unrelated installed generation.
if (!process.env.OPENCODE_RUFF_PYTHON_BRIDGE) {
  const benchmarkDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(benchmarkDir, "../..")
  const bridge = path.join(
    repoRoot,
    "rust/evidence-distiller/target/release/opencode-ruff-python-bridge",
  )
  await access(bridge, constants.X_OK)
  process.env.OPENCODE_RUFF_PYTHON_BRIDGE = bridge
}

const sha = (value) => createHash("sha256").update(value).digest("hex")
const root = await mkdtemp(path.join(os.tmpdir(), "r7-r3-source-slot-"))
await mkdir(path.join(root, "routes"), { recursive: true })
await mkdir(path.join(root, "templates/snippets"), { recursive: true })
await mkdir(path.join(root, "templates"), { recursive: true })

const server = [
  "from flask import Blueprint",
  "bp = Blueprint('x', __name__)",
  "",
  "@bp.route('/existing')",
  "def existing():",
  "    return 'ok'",
  "",
].join("\n")
const menu = "<li><a href=\"/existing\">Existing</a></li>\n"
const sourceUi = "<html><body>Existing</body></html>\n"
await writeFile(path.join(root, "routes/server.py"), server)
await writeFile(path.join(root, "templates/snippets/menu.html"), menu)
await writeFile(path.join(root, "templates/source.html"), sourceUi)

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/server.py",
      sha256: sha(server),
      evidence_lines: [4],
      roles: ["task_anchor_owner"],
      allowed_operations: ["replace_exact"],
    },
    {
      slot: "existing:1",
      file: "templates/snippets/menu.html",
      sha256: sha(menu),
      evidence_lines: [1],
      roles: ["navigation_host"],
      allowed_operations: ["replace_exact"],
    },
  ],
  create_slots: [
    {
      slot: "create:0",
      root: "templates",
      source_file: "templates/source.html",
      source_sha256: sha(sourceUi),
      evidence_lines: [1],
      allowed_extensions: [".html"],
      max_depth: 2,
      roles: ["ui_host"],
      allowed_operations: ["create_file"],
    },
  ],
}

const baseTool = {
  name: "execute_additive_plan",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      contents: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^op_[0-9]+$",
            },
            content: {
              type: "object",
            },
          },
          required: ["id", "content"],
        },
      },
    },
    required: ["contents"],
  },
}
const semantic = bindSemanticContentToolSchemaToCapability(baseTool, capability)
assert.equal(semantic.ok, true, JSON.stringify(semantic))
const contract = {
  ok: true,
  contract_sha256: "c".repeat(64),
  operations: [
    { id: "op_0", obligation: "server_surface", kind: "python_declaration" },
    { id: "op_1", obligation: "navigation_integration", kind: "replacement" },
    { id: "op_2", obligation: "ui_surface", kind: "creation" },
  ],
}
const obligation = bindSemanticObligationContract({
  semanticBinding: semantic,
  capability,
  contract,
})
assert.equal(obligation.ok, true, JSON.stringify(obligation))

const executionContextSha256 = "d".repeat(64)
const bound = bindSourceSlotToolSchema({
  tool: obligation.tool,
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(bound.ok, true, JSON.stringify(bound))
assert.equal(bound.protocol, SOURCE_SLOT_COMPILER_PROTOCOL)
const modelSchema = bound.tool.input
assert.deepEqual(Object.keys(modelSchema.properties), ["sources"])
const schemaText = JSON.stringify(modelSchema)
for (const forbidden of [
  "python_units", "suite", "contents", "operation_id", "relative_path",
  "before", "mode", "target_file", "file_family",
]) {
  assert.equal(schemaText.includes(forbidden), false, forbidden)
}
assert(bound.model_schema_bytes < 2500, bound.model_schema_bytes)

const initial = {
  sources: {
    server_surface: [
      "@bp.route('/report')",
      "def report():",
      "    import io",
      "    return 'resource://ui_surface'",
    ].join("\n"),
    navigation_integration:
      '<li><a href="resource://ui_surface">Report</a></li>\n',
    ui_surface: "<html><body>Report</body></html>\n",
  },
}
const hydrated = await rehydrateSourceSlotRequest({
  binding: bound.binding,
  request: initial,
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(hydrated.ok, true, JSON.stringify(hydrated, null, 2))
assert.equal(hydrated.request.contents[0].content.kind, "python_units")
assert.equal(hydrated.request.contents[0].content.units[0].kind, "function")
assert.equal(hydrated.request.contents[0].content.units[0].name, "report")
assert.deepEqual(hydrated.request.contents[0].content.units[0].suite, [
  "import io",
  "return 'resource://op_2'",
])
assert.equal(
  hydrated.request.contents[1].content.text.includes("resource://op_2"),
  true,
)

const admitted = validateSemanticObligationRequest({
  request: hydrated.request,
  capability,
  contract,
  attestation: obligation.attestation,
})
assert.equal(admitted.ok, true, JSON.stringify(admitted))
const materialized = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: hydrated.request,
})
assert.equal(materialized.ok, true, JSON.stringify(materialized, null, 2))

const missing = await rehydrateSourceSlotRequest({
  binding: bound.binding,
  request: { sources: { server_surface: initial.sources.server_surface } },
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(missing.ok, false)
assert.equal(missing.reason, "source_slot_request_key_set_invalid")

const topImport = await rehydrateSourceSlotRequest({
  binding: bound.binding,
  request: {
    sources: {
      ...initial.sources,
      server_surface: [
        "import os",
        "",
        "@bp.route('/report2')",
        "def report2():",
        "    return os.getcwd()",
        "",
      ].join("\n"),
    },
  },
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(topImport.ok, true, JSON.stringify(topImport, null, 2))
assert.equal(topImport.python_import_hints.length, 1)
assert.equal(topImport.python_import_hints[0].operation_id, "op_0")
assert.equal(topImport.python_import_hints[0].slot, "existing:0")
assert.deepEqual(topImport.python_import_hints[0].hints, [{
  kind: "module",
  module: "os",
  name: null,
  local: "os",
  canonical: "os",
  alias: null,
  source: "model_static_import_hint",
}])
const topImportMaterialized = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: topImport.request,
  pythonImportHints: topImport.python_import_hints,
})
assert.equal(topImportMaterialized.ok, true, JSON.stringify(topImportMaterialized, null, 2))
assert.deepEqual(topImportMaterialized.request.python_imports, [{
  slot: "existing:0",
  modules: ["os"],
  from_imports: [],
}])
assert.match(topImportMaterialized.request.python_declarations[0].content, /def report2\(\):/u)
assert.doesNotMatch(topImportMaterialized.request.python_declarations[0].content, /^import os$/mu)

const lateImport = await rehydrateSourceSlotRequest({
  binding: bound.binding,
  request: {
    sources: {
      ...initial.sources,
      server_surface: [
        "def report_late():",
        "    return 'x'",
        "import os",
        "",
      ].join("\n"),
    },
  },
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(lateImport.ok, true, JSON.stringify(lateImport, null, 2))
assert.equal(lateImport.python_import_hints.length, 1)
assert.deepEqual(lateImport.python_import_hints[0].hints, [{
  kind: "module",
  module: "os",
  name: null,
  local: "os",
  canonical: "os",
  alias: null,
  source: "model_static_import_hint",
}])
assert.equal(
  lateImport.request.contents[0].content.kind,
  "python_units",
)
assert.equal(
  lateImport.request.contents[0].content.units[0].name,
  "report_late",
)
assert.deepEqual(
  lateImport.request.contents[0].content.units[0].suite,
  ["return 'x'"],
)

const executableTopLevel = await rehydrateSourceSlotRequest({
  binding: bound.binding,
  request: {
    sources: {
      ...initial.sources,
      server_surface: [
        "x = 1",
        "def report_bad():",
        "    return x",
        "",
      ].join("\n"),
    },
  },
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(executableTopLevel.ok, false)
assert.equal(executableTopLevel.reason, "source_fragment_top_level_kind_forbidden")
assert.deepEqual(executableTopLevel.source_keys, ["server_surface"])

const wrongNavigation = {
  sources: {
    ...initial.sources,
    navigation_integration: "def wrong():\n    return 1\n",
  },
}
const wrongHydrated = await rehydrateSourceSlotRequest({
  binding: bound.binding,
  request: wrongNavigation,
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(wrongHydrated.ok, true)
const wrongMaterialized = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: wrongHydrated.request,
})
assert.equal(wrongMaterialized.ok, false)
assert.equal(wrongMaterialized.reason, "semantic_file_family_mismatch")
assert.equal(wrongMaterialized.operation_id ?? wrongMaterialized.id, "op_1")

const cache = buildSourceSlotRepairCache({
  binding: bound.binding,
  request: wrongNavigation,
  failure: wrongMaterialized,
  capability,
  executionContextSha256,
})
assert.equal(cache.protocol, SOURCE_SLOT_REPAIR_PROTOCOL)
assert.equal(cache.repairable, true, JSON.stringify(cache))
assert.deepEqual(cache.failed_source_keys, ["navigation_integration"])
assert.deepEqual(cache.failed_slots, ["existing:1"])
assert.equal(cache.accepted_sources.server_surface, initial.sources.server_surface)
assert.equal(cache.accepted_sources.ui_surface, initial.sources.ui_surface)
assert.equal(cache.accepted_source_hashes.server_surface, sha(initial.sources.server_surface))
assert.equal(cache.accepted_source_hashes.ui_surface, sha(initial.sources.ui_surface))

const multiCache = buildSourceSlotRepairCache({
  binding: bound.binding,
  request: initial,
  failure: {
    reason: "source_slot_composite_invalid",
    source_keys: ["navigation_integration", "ui_surface"],
  },
  capability,
  executionContextSha256,
})
assert.equal(multiCache.repairable, true, JSON.stringify(multiCache))
assert.deepEqual(
  multiCache.failed_source_keys,
  ["navigation_integration", "ui_surface"],
)
assert.deepEqual(multiCache.failed_slots, ["create:0", "existing:1"])
assert.deepEqual(Object.keys(multiCache.accepted_sources), ["server_surface"])
assert.equal(
  multiCache.accepted_source_hashes.server_surface,
  sha(initial.sources.server_surface),
)
const multiRepairBound = bindSourceSlotToolSchema({
  tool: obligation.tool,
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  repairCache: multiCache,
  executionContextSha256,
})
assert.equal(multiRepairBound.ok, true, JSON.stringify(multiRepairBound))
assert.deepEqual(
  multiRepairBound.tool.input.properties.sources.required,
  ["navigation_integration", "ui_surface"],
)
assert.deepEqual(
  Object.keys(multiRepairBound.tool.input.properties.sources.properties),
  ["navigation_integration", "ui_surface"],
)

const repairBound = bindSourceSlotToolSchema({
  tool: obligation.tool,
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  repairCache: cache,
  executionContextSha256,
})
assert.equal(repairBound.ok, true, JSON.stringify(repairBound))
assert.deepEqual(
  repairBound.tool.input.properties.sources.required,
  ["navigation_integration"],
)
assert.deepEqual(
  Object.keys(repairBound.tool.input.properties.sources.properties),
  ["navigation_integration"],
)
assert.equal(
  sourceSlotRepairAuthorityMatches({
    hint: cache,
    capability,
    executionContextSha256,
    binding: repairBound.binding,
  }),
  true,
)

const repaired = await rehydrateSourceSlotRequest({
  binding: repairBound.binding,
  request: {
    sources: {
      navigation_integration:
        '<li><a href="resource://ui_surface">Report</a></li>\n',
    },
  },
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  repairCache: cache,
  executionContextSha256,
})
assert.equal(repaired.ok, true, JSON.stringify(repaired, null, 2))
assert.deepEqual(repaired.preserved_source_keys, ["server_surface", "ui_surface"])
assert.equal(repaired.raw_sources.server_surface, initial.sources.server_surface)
assert.equal(repaired.raw_sources.ui_surface, initial.sources.ui_surface)
const repairedMaterialized = await materializeSemanticAdditiveRequest({
  root,
  capability,
  request: repaired.request,
})
assert.equal(repairedMaterialized.ok, true, JSON.stringify(repairedMaterialized, null, 2))

assert.equal(
  sourceSlotRepairAuthorityMatches({
    hint: cache,
    capability: { ...capability, capability_sha256: "e".repeat(64) },
    executionContextSha256,
    binding: repairBound.binding,
  }),
  false,
)

console.log(
  "PASS R7-R4-A typed source fragment frontend " +
  "model_surface=source_text_only " +
  "python_module_fragment=ruff_owned " +
  "module_imports=existing_frontend_authorized " +
  "activation=capability_derived " +
  "partial_repair=causal_n_slot " +
  "accepted_sources=byte_preserved_hashed " +
  "mutation_authority=false",
)
