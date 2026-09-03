import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  bindSemanticContentToolSchemaToCapability,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"
import {
  bindSemanticObligationContract,
} from "../../opencode/plugins/cpu-search-core/semantic-obligation-bridge-v1.mjs"
import {
  bindSourceSlotToolSchema,
  buildSourceSlotRepairCache,
  sourceSlotRepairAuthorityMatches,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "../..")
const bridge =
  process.env.OPENCODE_RUFF_PYTHON_BRIDGE ||
  path.join(
    repo,
    "rust/evidence-distiller/target/release/opencode-ruff-python-bridge",
  )

assert.equal(fs.existsSync(bridge), true, `Ruff bridge missing: ${bridge}`)

function shaText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function lower(source) {
  const cp = spawnSync(bridge, [], {
    input: JSON.stringify({ command: "lower_source_fragment", source }),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(cp.error, undefined)
  assert.equal(cp.status, 0, cp.stderr)
  return JSON.parse(cp.stdout)
}

function failureFor(frontend) {
  return {
    ok: false,
    protocol: "source-slot-compiler-v1",
    reason: frontend.reason,
    source_key: "server_surface",
    operation_id: "op_0",
    operation_index: 0,
    frontend,
    mutation_authority: false,
  }
}

const server = "def existing():\n    return 'ok'\n"
const menu = '<li><a href="/existing">Existing</a></li>\n'
const ui = "<html><body>Existing</body></html>\n"
const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/server.py",
      sha256: shaText(server),
      evidence_lines: [1],
      roles: ["task_anchor_owner"],
      allowed_operations: ["add_imports", "add_module_declaration", "replace_exact"],
    },
    {
      slot: "existing:1",
      file: "templates/snippets/menu.html",
      sha256: shaText(menu),
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
      source_sha256: shaText(ui),
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
            id: { type: "string", pattern: "^op_[0-9]+$" },
            content: { type: "object" },
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
const initialBinding = bindSourceSlotToolSchema({
  tool: obligation.tool,
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  executionContextSha256,
})
assert.equal(initialBinding.ok, true, JSON.stringify(initialBinding))
assert.equal(initialBinding.repair_active, false)

const exprSource = 'from os import path\n\nbp.route("/x")\ndef foo():\n    pass\n'
const expr = lower(exprSource)
assert.equal(expr.ok, false)
assert.equal(expr.reason, "source_fragment_top_level_kind_forbidden")
assert.equal(expr.structural_witness.protocol, "ruff-python-structural-witness-v1")
assert.equal(expr.structural_witness.node_kind, "Expr")
assert.equal(expr.structural_witness.statement_index, 1)
assert.equal(
  Buffer.from(exprSource, "utf8")
    .subarray(expr.structural_witness.start_byte, expr.structural_witness.end_byte)
    .toString("utf8"),
  'bp.route("/x")',
)

const assignSource = "from os import path\n\nbp = object()\ndef foo():\n    pass\n"
const assign = lower(assignSource)
assert.equal(assign.ok, false)
assert.equal(assign.structural_witness.node_kind, "Assign")
assert.equal(
  Buffer.from(assignSource, "utf8")
    .subarray(assign.structural_witness.start_byte, assign.structural_witness.end_byte)
    .toString("utf8"),
  "bp = object()",
)

const crlfSource = 'from os import path\r\n\r\nbp.route("/x")\r\ndef foo():\r\n    pass\r\n'
const crlf = lower(crlfSource)
assert.equal(crlf.ok, false)
assert.equal(crlf.structural_witness.parser_input_normalization, "universal_newline_to_lf")
const normalized = crlfSource.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n")
assert.equal(
  Buffer.from(normalized, "utf8")
    .subarray(crlf.structural_witness.start_byte, crlf.structural_witness.end_byte)
    .toString("utf8"),
  'bp.route("/x")',
)

const request = {
  sources: {
    server_surface: exprSource,
    navigation_integration: '<li><a href="resource://ui_surface">Report</a></li>\n',
    ui_surface: "<html><body>Report</body></html>\n",
  },
}
const cache = buildSourceSlotRepairCache({
  binding: initialBinding.binding,
  request,
  failure: failureFor(expr),
  capability,
  executionContextSha256,
})
assert.equal(cache.repairable, true, JSON.stringify(cache))
assert.deepEqual(cache.failed_source_keys, ["server_surface"])
assert.deepEqual(cache.structural_witness_required_keys, ["server_surface"])
assert.equal(cache.accepted_sources.navigation_integration, request.sources.navigation_integration)
assert.equal(cache.accepted_sources.ui_surface, request.sources.ui_surface)
const witness = cache.structural_witnesses.server_surface
assert.equal(witness.protocol, "source-slot-structural-counterexample-v1")
assert.equal(witness.node_kind, "Expr")
assert.equal(witness.line, 3)
assert.equal(witness.failed_source_sha256, shaText(exprSource))
assert.equal(witness.parser_input_sha256, shaText(exprSource))
assert.equal(witness.source_span_sha256, shaText('bp.route("/x")'))
assert.equal(
  witness.requirement,
  "module_fragment_static_import_prefix_then_function_declarations_only",
)
assert.deepEqual(witness.allowed_node_kinds, [
  "Import",
  "ImportFrom",
  "FunctionDef",
])
assert.equal(witness.mutation_authority, false)
const repairCapsule = cache.repair_capsules.server_surface
assert.equal(repairCapsule.protocol, "source-slot-repair-capsule-v2")
assert.equal(repairCapsule.offending_source, 'bp.route("/x")')
assert.match(repairCapsule.failed_source_excerpt, /bp\.route/u)
assert.equal(repairCapsule.semantic_fix_provided, false)
assert.equal(
  sourceSlotRepairAuthorityMatches({
    hint: cache,
    capability,
    executionContextSha256,
    binding: initialBinding.binding,
  }),
  true,
)

const repairBinding = bindSourceSlotToolSchema({
  tool: obligation.tool,
  capability,
  contract,
  semanticAttestation: obligation.attestation,
  repairCache: cache,
  executionContextSha256,
})
assert.equal(repairBinding.ok, true, JSON.stringify(repairBinding))
assert.equal(repairBinding.repair_active, true)
assert.deepEqual(
  repairBinding.tool.input.properties.sources.required,
  ["server_surface"],
)
const description =
  repairBinding.tool.input.properties.sources.properties.server_surface.description
assert.match(description, /node_kind=Expr/u)
assert.match(description, /line=3/u)
assert.doesNotMatch(description, /source_span_sha256=/u)
assert.match(description, /offending_source=/u)
assert.match(description, /bp\.route/u)
assert.match(description, /module_fragment_static_import_prefix_then_function_declarations_only/u)
assert.match(description, /allowed_node_kinds=Import,ImportFrom,FunctionDef/u)
assert.doesNotMatch(description, /suggested_fix/u)
assert.doesNotMatch(description, /@bp\.route/u)
assert.equal(request.sources.server_surface, exprSource)

// Structural failure without parser-owned evidence must not earn another LLM
// call. It is a compiler/telemetry integrity failure, not a semantic repair CE.
const missingWitnessCache = buildSourceSlotRepairCache({
  binding: initialBinding.binding,
  request,
  failure: {
    ...failureFor(expr),
    frontend: {
      ...expr,
      structural_witness: undefined,
    },
  },
  capability,
  executionContextSha256,
})
assert.equal(missingWitnessCache.repairable, false)

console.log(
  "PASS R7-R7 precise Ruff structural counterexample " +
  "parser_fact=ruff_owned source_binding=content_addressed " +
  "contract=capability_derived model_fix_hint=absent " +
  "accepted_siblings=byte_preserved failed_generation_replay=false " +
  "mutation_authority=false",
)
