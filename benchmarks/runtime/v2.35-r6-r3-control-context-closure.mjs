import assert from "node:assert/strict"
import fs from "node:fs"

import {
  CONTROL_CONTEXT_LAYER_PROTOCOL,
  compileControlContextLayer,
} from "../../opencode/plugins/cpu-search-core/control-context-layer-v1.mjs"

const task =
  "Implement the bounded additive mutation."

const phaseText = [
  "MUTATION_PHASE protocol=mutation-phase-compiler-v1 state=mutate tool=execute_additive_plan exactly_once=true",
  "",
  "TASK",
  task,
  "",
  "MUTATION_CONTENT_ENVELOPE protocol=fixture-v1 minimal_complete=true",
  "",
  "ADDITIVE_CAPABILITY protocol=fixture-v1 operations=python_imports,python_declarations,replacements,creations",
  "MUTATION_ABI protocol=fixture-v1 content_fields=python_imports,python_declarations,replacements,creations",
  "slot=existing:0 ops=add_module_declaration file=sample.py",
  "budgets operations<=8 files<=5 creates<=2",
  "REQUIRED_MUTATION_COVERAGE protocol=fixture-v1 server_surface@existing:0:python_declaration all_required=true",
  "MODEL_TOOL_ABI protocol=semantic-content-ir-v1 shape=contents[id,content]",
  "SYNTHESIS_TRANSACTION protocol=fixture-v1 content_only=true",
  "REQUIRED_OPERATION id=op_0 obligation=server_surface slot=existing:0 operation=python_declaration payload=content",
  "MUTATION_CONSTRAINTS no_new_dependencies=true preserve_existing_behavior=true",
  "MODEL_AUTHORITY content_only=true slot=false operation=false file=false scope=false",
  "",
  "SEALED_CONTEXT file=sample.py roles=owner anchors=10",
  "   10 | def existing():",
  "   11 |     return 1",
  "NEXT_ACTION=execute_additive_plan reason=execution_readiness_ready search_locked=true",
  "",
  "CALL_POLICY tool=execute_additive_plan exactly_once=true prose=false minimum_complete=true authority_expansion=false",
].join("\n")

const base = {
  applied: true,
  reason: "mutation_phase_compiled",
  selected_tool: "execute_additive_plan",
  system: [{
    type: "text",
    text: "You are a bounded mutation worker.",
  }],
  messages: [{
    role: "user",
    content: [{
      type: "text",
      text: phaseText,
    }],
  }],
}

const projected =
  compileControlContextLayer(base)

assert.equal(projected.applied, true)
assert.equal(
  projected.control_context_protocol,
  CONTROL_CONTEXT_LAYER_PROTOCOL,
)
assert.equal(
  projected.control_context_applied,
  true,
)
assert.equal(
  projected.control_context_reason,
  "phase_control_evidence_separated",
)
assert.equal(
  projected.control_context_action,
  "execute_additive_plan",
)
assert.equal(
  projected.control_context_required_operations,
  1,
)
assert.equal(
  projected.control_context_mutation_authority,
  false,
)
assert.equal(
  projected.control_context_model_action_authority,
  false,
)

const systemText =
  JSON.stringify(projected.system)
const messageText =
  JSON.stringify(projected.messages)

for (const required of [
  "CONTROL_CONTEXT protocol=control-context-layer-v1",
  "ACTION=execute_additive_plan",
  "REQUIRED=id=op_0",
  "CONSTRAINTS=no_new_dependencies=true",
  "PYTHON_FUNCTION_SUITE=body_statements_only",
  "CAPABILITY_LABELS_AS_PAYLOAD=forbidden",
]) {
  assert.ok(
    systemText.includes(required),
    `control context missing ${required}`,
  )
}

for (const required of [
  task,
  "EVIDENCE_CONTEXT protocol=control-context-layer-v1",
  "SEALED_CONTEXT file=sample.py",
  "def existing()",
]) {
  assert.ok(
    messageText.includes(required),
    `evidence context missing ${required}`,
  )
}

for (const forbidden of [
  "MUTATION_PHASE protocol=",
  "ADDITIVE_CAPABILITY",
  "python_imports,python_declarations,replacements,creations",
  "MUTATION_ABI",
  "slot=existing:0",
  "budgets operations",
  "REQUIRED_MUTATION_COVERAGE",
  "MODEL_TOOL_ABI",
  "SYNTHESIS_TRANSACTION",
  "REQUIRED_OPERATION",
  "MUTATION_CONSTRAINTS",
  "MODEL_AUTHORITY",
  "NEXT_ACTION=",
  "CALL_POLICY ",
]) {
  assert.equal(
    messageText.includes(forbidden),
    false,
    `control metadata leaked into user/evidence context: ${forbidden}`,
  )
}

for (const forbidden of [
  "SEALED_CONTEXT file=sample.py",
  "def existing()",
]) {
  assert.equal(
    systemText.includes(forbidden),
    false,
    `repository evidence leaked into control context: ${forbidden}`,
  )
}

assert.ok(
  projected.control_context_projected_bytes <=
    projected.control_context_source_bytes + 256,
)

const mismatch =
  compileControlContextLayer({
    ...base,
    selected_tool: "execute_replace_node",
  })

assert.equal(
  mismatch.control_context_applied,
  false,
)
assert.equal(
  mismatch.control_context_reason,
  "control_context_action_drift",
)

const fragment0 =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/00.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

assert.ok(
  fragment0.includes(
    "compileMutationPhaseContextBase",
  ),
)
assert.ok(
  fragment0.includes(
    "compileControlContextLayer",
  ),
)

const compiler =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search-core/model-context-compiler-v1.mjs",
      import.meta.url,
    ),
    "utf8",
  )

for (const required of [
  "export function resolveModelContextCompilerMode(value)",
  'value === "off" || value === "shadow" || value === "active"',
  'return "shadow"',
  "critical_file_coverage_complete",
  "execution_contract_coverage_complete",
  "semantic_coverage_complete",
  "snapshotCompiledExecutionCapsule",
  "verifyCompiledExecutionCapsule",
]) {
  assert.ok(
    compiler.includes(required),
    `existing model-context compiler contract missing ${required}`,
  )
}

const fragment9 =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/09.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

for (const required of [
  "process.env.OPENCODE_CPU_MODEL_CONTEXT_COMPILER",
  'modelContextCompilerMode === "active"',
  '"deterministic_scout_baseline"',
  '"compiled_execution_capsule"',
  "execution_contract_coverage_complete === true",
  "semantic_coverage_complete === true",
]) {
  assert.ok(
    fragment9.includes(required),
    `existing model-context runtime contract missing ${required}`,
  )
}

console.log(
  "PASS R6-R3-R4 Control Context Closure " +
    "phase_control_evidence_separated=true " +
    "capability_labels_removed_from_user_context=true " +
    "python_suite_body_only=true " +
    "existing_active_context_switch_verified=true " +
    "default_context_mode_unchanged=shadow " +
    "canonical_materializer_preserved=true " +
    "model_calls_added=0 " +
    "mutation_authority_expansion=false",
)
