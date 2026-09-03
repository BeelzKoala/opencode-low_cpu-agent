import assert from "node:assert/strict"

import {
  compileMutationPhaseContext,
} from "../../opencode/plugins/cpu-search-core/mutation-phase-compiler-v1.mjs"

const TOOL = "execute_additive_plan"
const TASK =
  "Implement the bounded additive mutation."

const PREFIX =
  "DO_NOT_COPY_PREFIX_7f4c ".repeat(220)
const SUFFIX =
  "DO_NOT_COPY_SUFFIX_91aa ".repeat(220)
const HISTORY =
  "OLD_HISTORY_NOT_MUTATION_AUTHORITY ".repeat(180)

const ENVELOPE = [
  "MUTATION_CONTENT_ENVELOPE protocol=fixture-v1 minimal_complete=true",
  "",
  "ADDITIVE_CAPABILITY protocol=fixture-v1",
  "MUTATION_ABI protocol=fixture-v1 content_fields=contents",
  "REQUIRED_OPERATION id=op_0 operation=semantic_body payload=content",
  "MODEL_AUTHORITY content_only=true slot=false operation=false file=false scope=false",
  "",
  "SEALED_CONTEXT file=sample.py roles=owner anchors=10",
  "   10 | def existing():",
  "   11 |     return 1",
  `NEXT_ACTION=${TOOL} reason=execution_readiness_ready search_locked=true`,
].join("\n")

function userText(text) {
  return [{
    role: "user",
    content: [{
      type: "text",
      text,
    }],
  }]
}

function phaseText(result) {
  return result
    ?.messages?.[0]
    ?.content?.[0]
    ?.text ?? ""
}

function compile(system, messages) {
  return compileMutationPhaseContext({
    executionState: "mutate",
    frontierToolNames: [TOOL],
    taskText: TASK,
    system,
    messages,
  })
}

function assertApplied(name, result) {
  assert.equal(
    result.applied,
    true,
    `${name}: ${result.reason}`,
  )
  assert.equal(
    result.reason,
    "mutation_phase_compiled",
  )
  assert.equal(
    result.selected_tool,
    TOOL,
  )
  assert.ok(
    result.reduction_bytes > 0,
    `${name}: expected positive reduction`,
  )

  const text = phaseText(result)
  assert.ok(text.includes(ENVELOPE))
  assert.ok(text.includes(TASK))
  assert.equal(
    text.includes("DO_NOT_COPY_PREFIX_7f4c"),
    false,
  )
  assert.equal(
    text.includes("DO_NOT_COPY_SUFFIX_91aa"),
    false,
  )
  assert.equal(
    text.includes("OLD_HISTORY_NOT_MUTATION_AUTHORITY"),
    false,
  )
}

// Current runtime carrier: canonical envelope embedded inside SystemPart[].
{
  const result = compile(
    [{
      text:
        PREFIX +
        "\n" +
        ENVELOPE +
        "\n" +
        SUFFIX,
    }],
    userText(
      TASK +
      "\n" +
      HISTORY,
    ),
  )

  assertApplied("system_part_array", result)
}

// String system carrier.
{
  const result = compile(
    PREFIX +
      "\n" +
      ENVELOPE +
      "\n" +
      SUFFIX,
    userText(
      TASK +
      "\n" +
      HISTORY,
    ),
  )

  assertApplied("system_string", result)
}

// Legacy messages carrier.
{
  const result = compile(
    [{
      text: PREFIX,
    }],
    userText(
      HISTORY +
      "\n" +
      ENVELOPE +
      "\n" +
      SUFFIX,
    ),
  )

  assertApplied("legacy_messages", result)
}

// Same canonical envelope in different wrappers is one identity.
{
  const result = compile(
    PREFIX +
      "\n" +
      ENVELOPE +
      "\nSYSTEM_WRAPPER_SUFFIX",
    userText(
      "MESSAGE_WRAPPER_PREFIX\n" +
      ENVELOPE +
      "\n" +
      HISTORY,
    ),
  )

  assertApplied("duplicate_identity", result)
}

// Distinct valid envelopes are ambiguous and fail closed.
{
  const other =
    ENVELOPE.replace(
      `NEXT_ACTION=${TOOL}`,
      "NEXT_ACTION=search",
    )

  const result = compile(
    ENVELOPE,
    userText(other),
  )

  assert.equal(result.applied, false)
  assert.equal(
    result.reason,
    "canonical_mutation_envelope_ambiguous",
  )
}

// Marker without NEXT_ACTION is malformed and must never fall open.
{
  const result = compile(
    "MUTATION_CONTENT_ENVELOPE protocol=broken-v1\n" +
      "MODEL_AUTHORITY content_only=true",
    userText(TASK),
  )

  assert.equal(result.applied, false)
  assert.equal(
    result.reason,
    "canonical_mutation_envelope_malformed",
  )
}

// Oversized canonical envelope must be rejected, never silently truncated.
{
  const oversized = [
    "MUTATION_CONTENT_ENVELOPE protocol=oversized-v1",
    "X".repeat(9000),
    `NEXT_ACTION=${TOOL}`,
  ].join("\n")

  const result = compile(
    oversized,
    userText(TASK),
  )

  assert.equal(result.applied, false)
  assert.equal(
    result.reason,
    "canonical_mutation_envelope_malformed",
  )
}

console.log(
  "PASS R4 canonical mutation envelope extraction " +
  "boundary=line_anchored " +
  "terminator=next_action " +
  "prefix_suffix=excluded " +
  "duplicate_identity=dedup " +
  "ambiguity=fail_closed " +
  "unterminated=fail_closed " +
  "oversize=fail_closed " +
  "model_calls_added=0 " +
  "mutation_authority_expansion=false",
)
