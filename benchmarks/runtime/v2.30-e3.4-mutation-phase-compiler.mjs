#!/usr/bin/env node
import assert from "node:assert/strict"
import {
  MUTATION_PHASE_COMPILER_PROTOCOL,
  compileMutationPhaseContext,
  projectMutationToolSchemas,
} from "../../opencode/plugins/cpu-search-core/mutation-phase-compiler-v1.mjs"

const MUTATION_PHASE_SYSTEM_FOR_TEST =
  "You are the bounded semantic synthesis stage of a coding transaction. " +
  "Call exactly the single exposed mutation tool. Emit no prose. " +
  "Repository scope, files, slots, operations, and authority are deterministic; " +
  "supply only semantic payload fields required by the schema and mutation envelope. " +
  "Prefer the smallest complete implementation that satisfies every required operation."

const task = `
Add a bounded export surface.
The endpoint must validate an ISO date and a closed-choice report type before data access.
Use the existing database connector and parameterized query semantics.
Return an xlsx artifact, add one navigation entry, create one minimal page,
preserve the existing export endpoint, and add no dependency.
`.repeat(5)

const envelope = [
  "MUTATION_CONTENT_ENVELOPE protocol=mutation-context-projection-v1 minimal_complete=true",
  "ADDITIVE_CAPABILITY protocol=scout-additive-capability-v1",
  "slot=existing:0 ops=add_imports,add_module_declaration file=routes/example.py roles=data_access_capability,task_anchor_owner",
  "slot=existing:1 op=replace_exact file=templates/snippets/menu.html roles=navigation_host",
  "slot=create:0 op=create_file relative_path_only=true extensions=.html max_depth=2",
  "REQUIRED_MUTATION_COVERAGE protocol=mutation-obligation-v1 server_surface@existing:0:python_declaration navigation_integration@existing:1:replacement ui_surface@create:0:creation all_required=true",
  "SYNTHESIS_TRANSACTION protocol=obligation-bound-synthesis-v1 content_only=true all_required=true",
  "REQUIRED_OPERATION id=op_0 obligation=server_surface slot=existing:0 operation=python_declaration payload=content",
  "REQUIRED_OPERATION id=op_1 obligation=navigation_integration slot=existing:1 operation=replacement payload=before,replacement",
  "REQUIRED_OPERATION id=op_2 obligation=ui_surface slot=create:0 operation=creation payload=relative_path,content",
  "MUTATION_CONSTRAINTS closed_choice_input=true no_new_dependencies=true parameterized_data_query=true preserve_existing_behavior=true",
  "MODEL_AUTHORITY content_only=true slot=false operation=false file=false scope=false",
  "SEALED_CONTEXT file=routes/example.py roles=data_access_capability anchors=3,80",
  "    1 | from flask import Blueprint, render_template",
  "    2 | from database import get_conn",
  "    3 | bp = Blueprint('example', __name__)",
  "   78 | @bp.route('/existing')",
  "   79 | def existing():",
  "   80 |     return render_template('existing.html')",
  "NEXT_ACTION=execute_additive_plan reason=execution_readiness_ready search_locked=true",
].join("\n")

const system = [
  {
    text: "General coding agent system instructions. ".repeat(20),
    providerOptions: { local: { system_preserved: true } },
  },
  {
    text: "Repository exploration instructions. ".repeat(10),
  },
]

const messages = [
  {
    id: "runtime-message-carrier",
    sessionID: "runtime-session",
    role: "user",
    providerOptions: { local: { preserved: true } },
    content: [
      {
        type: "text",
        text: task,
        providerOptions: { local: { part_preserved: true } },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        tool: "search",
        input: { queries: ["export", "database"] },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        output: envelope,
        metadata: {
          verbose_scout_telemetry: "x".repeat(2500),
        },
      },
    ],
  },
]

const tools = {
  execute_additive_plan: {
    description:
      "Submit a large additive plan. ".repeat(30),
    input: {
      type: "object",
      description: "root",
      properties: {
        python_declarations: {
          type: "array",
          description: "Python declarations to add. ".repeat(20),
          items: {
            type: "object",
            description: "declaration",
            properties: {
              content: {
                type: "string",
                description: "Complete declaration content. ".repeat(20),
              },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
        replacements: {
          type: "array",
          description: "Exact replacement payloads. ".repeat(20),
          items: {
            type: "object",
            properties: {
              before: {
                type: "string",
                description: "Exact source witness. ".repeat(20),
              },
              replacement: {
                type: "string",
                description: "Replacement content. ".repeat(20),
              },
            },
            required: ["before", "replacement"],
            additionalProperties: false,
          },
        },
      },
      required: ["python_declarations", "replacements"],
      additionalProperties: false,
    },
    options: { codemode: false, permission: "execute_patch" },
  },
}

const sourceTotal = Buffer.byteLength(
  JSON.stringify({ system, messages, tools }),
)

const compiled = compileMutationPhaseContext({
  executionState: "mutate",
  frontierToolNames: ["execute_additive_plan"],
  taskText: task,
  messages,
  system,
})

assert.equal(compiled.applied, true)
assert.equal(compiled.protocol, MUTATION_PHASE_COMPILER_PROTOCOL)
assert.equal(compiled.reason, "mutation_phase_compiled")
assert.equal(compiled.mutation_authority, false)
assert.equal(compiled.selected_tool, "execute_additive_plan")
assert.equal(compiled.messages.length, 1)
assert.equal(compiled.system.length, 1)
assert.equal(compiled.system_projection_mode, "runtime_carrier")
assert.equal(
  compiled.system_projection_reason,
  "runtime_system_part_carrier_preserved",
)
assert.equal(compiled.system_carrier_index, 0)
assert.deepEqual(
  compiled.system[0].providerOptions,
  { local: { system_preserved: true } },
)
assert.equal(compiled.system[0].text, MUTATION_PHASE_SYSTEM_FOR_TEST)
assert.equal(compiled.message_projection_mode, "runtime_carrier")
assert.equal(
  compiled.message_projection_reason,
  "runtime_user_text_carrier_preserved",
)
assert.equal(compiled.message_carrier_role, "user")
assert.equal(compiled.messages[0].id, "runtime-message-carrier")
assert.equal(compiled.messages[0].sessionID, "runtime-session")
assert.deepEqual(
  compiled.messages[0].providerOptions,
  { local: { preserved: true } },
)
assert.deepEqual(
  compiled.messages[0].content[0].providerOptions,
  { local: { part_preserved: true } },
)

const projectedTools = structuredClone(tools)
const schemaProjection = projectMutationToolSchemas({
  tools: projectedTools,
  frontierToolNames: ["execute_additive_plan"],
  active: compiled.applied,
})

assert.equal(schemaProjection.applied, false)
assert.equal(
  schemaProjection.reason,
  "tool_schema_runtime_mutation_disabled",
)
assert.equal(schemaProjection.runtime_schema_immutable, true)
assert.equal(
  schemaProjection.projected_bytes,
  schemaProjection.source_bytes,
)
assert.equal(schemaProjection.reduction_bytes, 0)
assert.equal(
  projectedTools.execute_additive_plan.input.type,
  "object",
)
assert.deepEqual(
  projectedTools.execute_additive_plan.input.required,
  ["python_declarations", "replacements"],
)
assert.equal(
  projectedTools.execute_additive_plan.input.additionalProperties,
  false,
)
assert.ok(
  projectedTools.execute_additive_plan.input.properties.python_declarations
    .description,
)

const phaseText = compiled.messages[0].content[0].text
for (const required of [
  "MUTATION_PHASE protocol=mutation-phase-compiler-v1",
  "TASK",
  "closed-choice report type",
  "MUTATION_CONTENT_ENVELOPE",
  "REQUIRED_OPERATION id=op_0",
  "REQUIRED_OPERATION id=op_1",
  "REQUIRED_OPERATION id=op_2",
  "NEXT_ACTION=execute_additive_plan",
  "CALL_POLICY tool=execute_additive_plan",
]) {
  assert.ok(phaseText.includes(required), `missing ${required}`)
}

assert.ok(!JSON.stringify(compiled.messages).includes("verbose_scout_telemetry"))

const projectedTotal = Buffer.byteLength(
  JSON.stringify({
    system: compiled.system,
    messages: compiled.messages,
    tools: projectedTools,
  }),
)

assert.ok(projectedTotal < sourceTotal)
assert.ok(
  projectedTotal < sourceTotal,
  `expected phase-local model-facing reduction, got ${projectedTotal}/${sourceTotal}`,
)

const locate = compileMutationPhaseContext({
  executionState: "locate",
  frontierToolNames: ["search"],
  taskText: task,
  messages,
  system,
})
assert.equal(locate.applied, false)
assert.equal(locate.reason, "not_mutation_phase")

const missingEnvelope = compileMutationPhaseContext({
  executionState: "mutate",
  frontierToolNames: ["execute_additive_plan"],
  taskText: task,
  messages: [{ role: "user", content: [{ type: "text", text: task }] }],
  system,
})
assert.equal(missingEnvelope.applied, false)
assert.equal(
  missingEnvelope.reason,
  "canonical_mutation_envelope_unavailable",
)

const mismatch = compileMutationPhaseContext({
  executionState: "mutate",
  frontierToolNames: ["execute_replace_node"],
  taskText: task,
  messages,
  system,
})
assert.equal(mismatch.applied, false)
assert.equal(mismatch.reason, "mutation_envelope_frontier_mismatch")

console.log(
  "PASS E3.4 mutation phase compiler " +
    `model-facing-bytes=${sourceTotal}->${projectedTotal} ` +
    `reduction=${sourceTotal - projectedTotal}`,
)
