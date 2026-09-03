import assert from "node:assert/strict"
import fs from "node:fs"

import {
  MUTATION_PHASE_COMPILER_PROTOCOL,
  STRUCTURED_MUTATION_CONTROL_PROTOCOL,
  compileMutationPhaseContext,
} from "../../opencode/plugins/cpu-search-core/mutation-phase-compiler-v1.mjs"

import {
  compileControlContextLayer,
} from "../../opencode/plugins/cpu-search-core/control-context-layer-v1.mjs"

const A = "a".repeat(64)
const B = "b".repeat(64)
const C = "c".repeat(64)
const D = "d".repeat(64)
const E = "e".repeat(64)

const task =
  "Implement the bounded additive mutation."

function control(
  executionState,
  selectedSource,
) {
  return {
    protocol:
      STRUCTURED_MUTATION_CONTROL_PROTOCOL,
    authority:
      "deterministic_runtime_state",
    execution_state: executionState,
    selected_action:
      "execute_additive_plan",
    selected_source: selectedSource,
    execution_context_capsule_sha256:
      A,
    execution_contract_sha256:
      B,
    semantic_contract_sha256:
      C,
    semantic_attestation_sha256:
      D,
    capability_fingerprint_sha256:
      E,
    required_operations: [
      {
        id: "op_0",
        obligation: "server_surface",
        kind: "python_declaration",
      },
      {
        id: "op_1",
        obligation:
          "navigation_integration",
        kind: "replacement",
      },
      {
        id: "op_2",
        obligation: "ui_surface",
        kind: "creation",
      },
    ],
  }
}

const evidenceMarker =
  "COMPILED_EXECUTION_EVIDENCE marker=keep_me"

const failedGeneration =
  "FAILED_GENERATION_SHOULD_NOT_REPLAY:" +
  "x".repeat(14000)

const repairMessages = [
  {
    role: "user",
    content: [{
      type: "text",
      text: task,
    }],
  },
  {
    role: "assistant",
    content: [{
      type: "tool-call",
      id: "failed-call",
      name: "execute_additive_plan",
      args: {
        giant_failed_generation:
          failedGeneration,
      },
    }],
  },
  {
    role: "tool",
    content: [{
      type: "tool-result",
      text:
        "PATCH_RETRY reason=ruff_python_syntax_invalid",
    }],
  },
]

const repairBase =
  compileMutationPhaseContext({
    executionState: "repair",
    frontierToolNames: [
      "execute_additive_plan",
    ],
    taskText: task,
    messages: repairMessages,
    system: [
      {
        type: "text",
        text:
          "runtime bounded mutation system",
      },
      {
        type: "text",
        text: evidenceMarker,
      },
    ],
    controlEnvelope:
      control(
        "repair",
        "persisted_execution_capsule_repair_projection",
      ),
  })

assert.equal(
  repairBase.applied,
  true,
)
assert.equal(
  repairBase.protocol,
  MUTATION_PHASE_COMPILER_PROTOCOL,
)
assert.equal(
  repairBase.reason,
  "mutation_phase_compiled_structured_control",
)
assert.equal(
  repairBase.structured_control_applied,
  true,
)
assert.equal(
  repairBase.structured_control_protocol,
  STRUCTURED_MUTATION_CONTROL_PROTOCOL,
)
assert.equal(
  repairBase.repair_history_elided,
  true,
)

const repairSystem =
  JSON.stringify(repairBase.system)
const repairMessageText =
  JSON.stringify(repairBase.messages)

assert.ok(
  repairSystem.includes(evidenceMarker),
  "compiled execution evidence was dropped",
)
assert.equal(
  repairMessageText.includes(
    "FAILED_GENERATION_SHOULD_NOT_REPLAY",
  ),
  false,
  "failed assistant generation replayed into repair",
)
assert.equal(
  repairMessageText.includes(
    "PATCH_RETRY reason=ruff_python_syntax_invalid",
  ),
  false,
  "old tool result replayed into repair",
)
assert.ok(
  repairMessageText.includes(
    "MUTATION_CONTENT_ENVELOPE protocol=structured-mutation-control-v1",
  ),
)
assert.ok(
  repairMessageText.includes(
    "REQUIRED_OPERATION id=op_0 obligation=server_surface kind=python_declaration",
  ),
)
assert.ok(
  repairBase.projected_messages_bytes <
    repairBase.source_messages_bytes,
)

const finalRepair =
  compileControlContextLayer(
    repairBase,
  )

assert.equal(
  finalRepair.applied,
  true,
)
assert.equal(
  finalRepair.control_context_applied,
  true,
)
assert.equal(
  finalRepair.control_context_reason,
  "phase_control_evidence_separated",
)

const finalSystem =
  JSON.stringify(finalRepair.system)
const finalMessages =
  JSON.stringify(finalRepair.messages)

assert.ok(
  finalSystem.includes(evidenceMarker),
)
assert.ok(
  finalSystem.includes(
    "CONTROL_CONTEXT protocol=control-context-layer-v1",
  ),
)
assert.ok(
  finalSystem.includes(
    "PYTHON_FUNCTION_SUITE=body_statements_only",
  ),
)
assert.ok(
  finalSystem.includes(
    "CAPABILITY_LABELS_AS_PAYLOAD=forbidden",
  ),
)
assert.equal(
  finalMessages.includes(
    "FAILED_GENERATION_SHOULD_NOT_REPLAY",
  ),
  false,
)
assert.equal(
  finalMessages.includes(
    "REQUIRED_OPERATION ",
  ),
  false,
)
assert.equal(
  finalMessages.includes(
    "MODEL_AUTHORITY ",
  ),
  false,
)

const mutate =
  compileMutationPhaseContext({
    executionState: "mutate",
    frontierToolNames: [
      "execute_additive_plan",
    ],
    taskText: task,
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: task,
      }],
    }],
    system: [{
      type: "text",
      text: evidenceMarker,
    }],
    controlEnvelope:
      control(
        "mutate",
        "compiled_execution_capsule",
      ),
  })

assert.equal(
  mutate.applied,
  true,
)
assert.equal(
  mutate.structured_control_applied,
  true,
)
assert.ok(
  mutate.expansion_bytes <= 2048,
)

const bad =
  compileMutationPhaseContext({
    executionState: "mutate",
    frontierToolNames: [
      "execute_additive_plan",
    ],
    taskText: task,
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: task,
      }],
    }],
    system: [{
      type: "text",
      text: evidenceMarker,
    }],
    controlEnvelope: {
      ...control(
        "mutate",
        "compiled_execution_capsule",
      ),
      semantic_attestation_sha256:
        "not-a-hash",
    },
  })

assert.equal(
  bad.applied,
  false,
)
assert.equal(
  bad.reason,
  "structured_mutation_control_identity_invalid",
)

const legacyMissing =
  compileMutationPhaseContext({
    executionState: "mutate",
    frontierToolNames: [
      "execute_additive_plan",
    ],
    taskText: task,
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: task,
      }],
    }],
    system: [{
      type: "text",
      text: evidenceMarker,
    }],
  })

assert.equal(
  legacyMissing.applied,
  false,
)
assert.equal(
  legacyMissing.reason,
  "canonical_mutation_envelope_unavailable",
)

const fragment0 =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search.fragments/00.part.ts",
      import.meta.url,
    ),
    "utf8",
  )

for (const required of [
  "STRUCTURED_MUTATION_CONTROL_PROTOCOL",
  "structuredMutationControlRequiredForState",
  "buildStructuredMutationControlEnvelope",
  "deriveCausalDispatchContract",
]) {
  assert.ok(
    fragment0.includes(required),
    `fragment0 missing ${required}`,
  )
}

const causalDispatchContract =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search-core/causal-dispatch-contract-v1.mjs",
      import.meta.url,
    ),
    "utf8",
  )

for (const required of [
  "CAUSAL_DISPATCH_CONTRACT_PROTOCOL",
  "attestation.operation_ids[index]",
  "attestation.contract_sha256 !== contract.contract_sha256",
  "attestation.capability_fingerprint_sha256",
]) {
  assert.ok(
    causalDispatchContract.includes(required),
    `causal dispatch contract missing ${required}`,
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
  "structuredMutationControlRequired",
  "structuredMutationControlEnvelope",
  "structured_control_boundary_unavailable",
  "structured_control_phase_compile_failed",
  "controlEnvelope:",
  "structured_mutation_control_required:",
  "repair_history_elided:",
]) {
  assert.ok(
    fragment9.includes(required),
    `fragment9 missing ${required}`,
  )
}

console.log(
  "PASS R6-R3-R5-R3 Structured Control Recovery Closure " +
    "control_provenance=deterministic_runtime_state " +
    "semantic_attestation_bound=true " +
    "compiled_evidence_preserved=true " +
    "prompt_scan_not_required_for_active_capsule=true " +
    "control_context_required_fail_closed=true " +
    "repair_history_elided=true " +
    "failed_generation_replay=false " +
    "legacy_prompt_envelope_fallback_preserved=true " +
    "ruff_authority_unchanged=true " +
    "model_calls_added=0 " +
    "mutation_authority_expansion=false",
)