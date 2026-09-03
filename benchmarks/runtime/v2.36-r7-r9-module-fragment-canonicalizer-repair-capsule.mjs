import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  canonicalizePythonModuleSourceFragment,
  lowerPythonSourceFragment,
} from "../../opencode/plugins/cpu-search-core/python-nested-semantic-ir-v1.mjs"
import {
  buildSourceSlotRepairCapsuleV2,
  renderSourceSlotRepairCapsuleV2,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

function shaText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex")
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

const trailingImports = [
  "from database import get_basdb_conn",
  "",
  '@bp.route("/x")',
  "def export_report():",
  "    return get_basdb_conn()",
  "",
  "import io",
  "from datetime import datetime",
  "",
].join("\n")

const before = await lowerPythonSourceFragment(trailingImports)
assert.equal(before.ok, false)
assert.equal(before.reason, "source_fragment_import_after_declaration")

const canonical = await canonicalizePythonModuleSourceFragment(trailingImports)
assert.equal(canonical.ok, true, JSON.stringify(canonical))
assert.equal(canonical.reason, "module_fragment_import_prefix_canonicalized")
assert.equal(canonical.authority, "representation_only")
assert.equal(canonical.semantic_repair_required, false)
assert.equal(canonical.mutation_authority, false)
assert.ok(canonical.source.indexOf("import io") < canonical.source.indexOf("@bp.route"))
assert.ok(
  canonical.source.indexOf("from datetime import datetime") <
    canonical.source.indexOf("@bp.route"),
)
const after = await lowerPythonSourceFragment(canonical.source)
assert.equal(after.ok, true, JSON.stringify(after))

const semanticNode = [
  "from database import get_basdb_conn",
  "",
  "bp = None",
  "",
  '@bp.route("/x")',
  "def export_report():",
  "    return get_basdb_conn()",
  "",
].join("\n")
const semanticCanonical =
  await canonicalizePythonModuleSourceFragment(semanticNode)
assert.equal(semanticCanonical.ok, false)
assert.equal(
  semanticCanonical.reason,
  "module_fragment_canonicalization_forbidden_node",
)
assert.equal(semanticCanonical.node_kind, "Assign")
assert.equal(semanticCanonical.semantic_repair_required, true)

const ambiguousTrivia = [
  "def export_report():",
  "    return 1",
  "",
  "# comment ownership is ambiguous across a reorder",
  "import io",
  "",
].join("\n")
const trivia = await canonicalizePythonModuleSourceFragment(ambiguousTrivia)
assert.equal(trivia.ok, false)
assert.equal(trivia.reason, "module_fragment_canonicalization_trivia_ambiguous")

const offending = "bp = None"
const start = Buffer.from(semanticNode, "utf8").indexOf(Buffer.from(offending))
const end = start + Buffer.byteLength(offending, "utf8")
const witnessPayload = {
  protocol: "source-slot-structural-counterexample-v1",
  failure: "source_fragment_top_level_kind_forbidden",
  source_key: "server_surface",
  slot: "existing:0",
  operation_id: "op_0",
  operation_index: 0,
  frontend_protocol: "ruff-python-structural-witness-v1",
  parser: "ruff_python_parser",
  parser_input_normalization: "universal_newline_to_lf",
  node_kind: "Assign",
  statement_index: 1,
  start_byte: start,
  end_byte: end,
  line: 3,
  failed_source_sha256: shaText(semanticNode),
  parser_input_sha256: shaText(semanticNode),
  source_span_sha256: shaText(offending),
  requirement: "module_fragment_static_import_prefix_then_function_declarations_only",
  allowed_node_kinds: ["Import", "ImportFrom", "FunctionDef"],
  mutation_authority: false,
}
const witness = {
  ...witnessPayload,
  witness_sha256: createHash("sha256")
    .update(
      `{${Object.keys(witnessPayload).sort().map((key) => `${JSON.stringify(key)}:${stableJson(witnessPayload[key])}`).join(",")}}`,
      "utf8",
    )
    .digest("hex"),
}

const capsule = buildSourceSlotRepairCapsuleV2({
  source: semanticNode,
  witness,
})
assert.ok(capsule)
assert.equal(capsule.offending_source, "bp = None")
assert.match(capsule.failed_source_excerpt, /bp = None/u)
assert.equal(capsule.semantic_fix_provided, false)
assert.equal(capsule.authority, "failed_source_slot_only")
const rendered = renderSourceSlotRepairCapsuleV2(capsule)
assert.match(rendered, /node_kind=Assign/u)
assert.match(rendered, /offending_source="bp = None"/u)
assert.match(rendered, /failed_source_excerpt:/u)
assert.doesNotMatch(rendered, /sha256/u)
assert.doesNotMatch(rendered, /suggested_fix/u)

console.log(
  "PASS R7-R9 module-fragment canonicalizer + repair capsule v2 " +
  "import_order=deterministic_no_llm forbidden_node=semantic_repair_only " +
  "trivia=fail_closed repair_capsule=actionable_bounded_hash_bound " +
  "accepted_siblings=frozen mutation_authority=false",
)
