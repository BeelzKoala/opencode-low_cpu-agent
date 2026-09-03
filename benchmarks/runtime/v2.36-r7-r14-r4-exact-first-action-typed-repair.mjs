import assert from "node:assert/strict"
import fs from "node:fs"

import {
  FIRST_ACTION_COMMIT_PROTOCOL,
  classifyFirstActionPrefix,
  createFirstActionCommitStream,
} from "../../opencode/plugins/cpu-search-core/execution-control-kernel-v1.mjs"

import {
  compileTypedPythonRepairSourceSchema,
  deriveSourceSlotSchemaFrontier,
  validateTypedPythonRepairSource,
} from "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs"

const selectedTool = "execute_additive_plan"
const contract = { active: true, selected_tool: selectedTool }
const dispatch = {
  active: true,
  mode: "required_singleton_tool",
  plan: { active: false },
  transport: {
    backend: "test",
    wire_mode: "required_singleton_tool",
  },
}

const partial = classifyFirstActionPrefix([
  { type: "tool-input-start", id: "call-1", toolName: selectedTool },
  { type: "tool-input-delta", id: "call-1", delta: '{"contents":[]}' },
], contract)
assert.equal(partial.state, "pending")

const complete = classifyFirstActionPrefix([
  { type: "tool-input-start", id: "call-1", toolName: selectedTool },
  { type: "tool-input-delta", id: "call-1", delta: '{"contents":[]}' },
  { type: "tool-input-end", id: "call-1" },
], contract)
assert.equal(complete.state, "complete")

assert.throws(
  () => classifyFirstActionPrefix([
    { type: "tool-input-start", id: "call-1", toolName: "wrong_tool" },
  ], contract),
  /execution_control_wrong_tool_call/,
)

assert.throws(
  () => classifyFirstActionPrefix([
    { type: "tool-input-start", id: "call-1", toolName: selectedTool },
    { type: "tool-input-start", id: "call-2", toolName: selectedTool },
  ], contract),
  /execution_control_multiple_tool_calls/,
)

let cancelled = false
let cancelReason = null
const upstream = new ReadableStream({
  start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] })
    controller.enqueue({
      type: "tool-input-start",
      id: "call-1",
      toolName: selectedTool,
    })
    controller.enqueue({
      type: "tool-input-delta",
      id: "call-1",
      delta: '{"contents":[]}',
    })
    controller.enqueue({ type: "tool-input-end", id: "call-1" })
  },
  cancel(reason) {
    cancelled = true
    cancelReason = reason
  },
})

const committed = createFirstActionCommitStream({
  stream: upstream,
  contract,
  dispatch,
})
const reader = committed.getReader()
const output = []
while (true) {
  const next = await reader.read()
  if (next.done) break
  output.push(next.value)
}

const calls = output.filter((part) => part?.type === "tool-call")
assert.equal(calls.length, 1)
assert.equal(calls[0].toolName, selectedTool)
assert.deepEqual(JSON.parse(calls[0].input), { contents: [] })
assert.equal(cancelled, true)
assert.match(String(cancelReason), new RegExp(FIRST_ACTION_COMMIT_PROTOCOL))

const row = {
  source_key: "server_surface",
  operation_id: "op_0",
  operation_index: 0,
  obligation: "server_surface",
  kind: "python_declaration",
  slot: "existing:0",
  allow_module_imports: true,
  mode: null,
  max_bytes: 6144,
}

const typed = compileTypedPythonRepairSourceSchema({ row })
assert.equal(typed.ok, true, JSON.stringify(typed))
assert.equal(typed.capacity_bytes, 6144)
assert.deepEqual(typed.schema.required, ["units"])

const typedWithPreciseWitness =
  compileTypedPythonRepairSourceSchema({
    row,
    repairCapsule: {
      protocol: "source-slot-repair-capsule-v2",
      failure: "source_fragment_top_level_kind_forbidden",
      source_key: "server_surface",
      node_kind: "Expr",
      statement_index: 0,
      line: 1,
      requirement:
        "module_fragment_static_import_prefix_then_function_declarations_only",
      allowed_node_kinds: ["Import", "ImportFrom", "FunctionDef"],
      offending_source: "print('x')",
      failed_source_excerpt: "print('x')",
    },
  })
assert.equal(
  typedWithPreciseWitness.ok,
  true,
  JSON.stringify(typedWithPreciseWitness),
)
assert.match(
  typedWithPreciseWitness.schema.description,
  /node_kind=Expr/,
)
assert.match(
  typedWithPreciseWitness.schema.description,
  /offending_source=/,
)
assert.match(
  typedWithPreciseWitness.schema.properties.units.description,
  /node_kind=Expr/,
)

const union =
  typed.schema.properties.units.items.oneOf ??
  typed.schema.properties.units.items.anyOf
const kinds = union.map((branch) => {
  const kind = branch?.properties?.kind
  if (typeof kind?.const === "string") return kind.const
  if (Array.isArray(kind?.enum) && kind.enum.length === 1) return kind.enum[0]
  return null
}).filter(Boolean).sort()
assert.deepEqual(kinds, ["async_function", "function"])

assert.equal(
  validateTypedPythonRepairSource("def raw_module():\n    pass\n").ok,
  false,
)
assert.equal(
  validateTypedPythonRepairSource({
    units: [{ kind: "assignment", name: "bp", value: "None" }],
  }).ok,
  false,
)
assert.equal(
  validateTypedPythonRepairSource({
    units: [{
      kind: "function",
      name: "report",
      parameters: "",
      suite: ["return 1"],
    }],
  }).ok,
  true,
)

const frontier = deriveSourceSlotSchemaFrontier({
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      sources: {
        type: "object",
        additionalProperties: false,
        properties: { server_surface: typed.schema },
        required: ["server_surface"],
      },
    },
    required: ["sources"],
  },
})
assert.equal(frontier.ok, true, JSON.stringify(frontier))
assert.equal(frontier.active_source_capacity_bytes, 6144)

const witness = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/repair-witness-closure-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)
assert.match(witness, /SOURCE_REPRESENTATION=typed_python_units/)
assert.match(witness, /structural_authority=json_schema_llguidance/)
assert.match(
  witness,
  /representationWitness\(\s*row,\s*repairActive,\s*clonedProperties\[sourceKey\]/s,
)

const source = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/source-slot-compiler-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)
assert.match(source, /activeCache\?\.repair_capsules \?\? null/)
assert.match(source, /const typedCapacity = typedRepairSchemaCapacity\(row\)/)
assert.match(
  source,
  /binding\.typed_repair_source_keys\.includes\(row\.source_key\)/,
)

const kernelSource = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/execution-control-kernel-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)
assert.match(
  kernelSource,
  /dispatch\.active === true &&\s*dispatch\.mode === "required_singleton_tool"/s,
)
assert.match(
  kernelSource,
  /const buffered = \[\][\s\S]*materializeExecutionControlledStream/,
)

const harness = fs.readFileSync(
  new URL("./v2.17-real-task.py", import.meta.url),
  "utf8",
)
assert.match(harness, /def completed_tool_records\(/)
assert.match(harness, /mutation_tool_proposals/)
assert.match(harness, /execute_additive_plan_proposals/)

console.log(
  "PASS R7-R14-R4-R3 exact closure " +
  "first_complete_action=commit_before_eof " +
  "wrong_or_multiple=fail_closed " +
  "typed_repair=function_async_only " +
  "frontier_capacity=6144 repair_capsules=preserved " +
  "initial_source_text_abi=unchanged",
)
