#!/usr/bin/env python3
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")
FIXTURES = json.loads(
    (ROOT / "benchmarks/fixtures/task-context-v1.json").read_text(encoding="utf-8")
)
CONTRACT = json.loads(
    (ROOT / "contracts/task-context-v1.json").read_text(encoding="utf-8")
)

def section(start, end):
    i = PLUGIN.index(start)
    j = PLUGIN.index(end, i)
    return PLUGIN[i:j]

helpers = section(
    "function taskContextValueKind(value)",
    "function usageFromTokens(tokens)",
)

task_action_module = (
    ROOT / "opencode/plugins/cpu-search-core/task-action-v1.mjs"
).resolve().as_uri()

task_requirements_module = (
    ROOT / "opencode/plugins/cpu-search-core/task-requirements-v1.mjs"
).resolve().as_uri()

task_anchor_module = (
    ROOT / "opencode/plugins/cpu-search-core/task-anchor-v1.mjs"
).resolve().as_uri()

task_shape_module = (
    ROOT / "opencode/plugins/cpu-search-core/task-shape-v1.mjs"
).resolve().as_uri()

additive_localization_plan_module = (
    ROOT
    / "opencode/plugins/cpu-search-core/additive-localization-plan-v1.mjs"
).resolve().as_uri()

js = f"""
import {{ createHash }} from "node:crypto";
import {{ compileTaskAction, unresolvedTaskAction }} from {json.dumps(task_action_module)};
import {{
  compileTaskRequirements,
  unresolvedTaskRequirements,
}} from {json.dumps(task_requirements_module)};

import {{
  compileTaskAnchors,
}} from {json.dumps(task_anchor_module)};

import {{
  compileTaskShape,
}} from {json.dumps(task_shape_module)};

import {{
  planAdditiveLocalization,
}} from {json.dumps(additive_localization_plan_module)};

const TASK_CONTEXT_PROTOCOL = "task-context-v1";
const TASK_CONTEXT_ADAPTER_PROTOCOL = "task-context-adapter-v1.2-json-string-controls";
const MUTATION_INTENT_PROTOCOL = "mutation-intent-grammar-v1";
const TASK_ACTION_PROTOCOL = "task-action-v1";
const TASK_CONTEXT_MAX_TEXT_BYTES = 16 * 1024;
const TASK_CONTEXT_MAX_PARTS = 64;
const TASK_CONTEXT_MAX_REPORTED_PART_TYPES = 16;
const TASK_CONTEXT_MAX_REPORTED_SOURCES = 8;

{helpers}

function assert(x, m) {{
  if (!x) throw new Error(m)
}}

const fixtures = {json.dumps(FIXTURES["cases"], ensure_ascii=False)};

for (const f of fixtures) {{
  const snapshot = userTurnSnapshotFromContext(f.event);
  const state = {{
    turnID: snapshot.turnID,
    taskContextLatched: false,
    taskTurnID: null,
    taskTextSha256: null,
    taskTextBytes: 0,
    taskTextSources: [],
    taskContextShape: null,
    taskContextReason: "unresolved",
    taskContextDrift: false,
    taskAction: null,
    taskRequirements: null,
    taskRoleEvidence: [],
    mutationIntent: "unknown",
    mutationIntentReason: "unresolved",
  }};

  latchTaskContextForTurn(state, snapshot);

  assert(
    state.mutationIntent === f.intent,
    f.id + ": intent=" + state.mutationIntent,
  );

  if (f.source) {{
    assert(
      state.taskTextSources.includes(f.source),
      f.id + ": source=" + JSON.stringify(state.taskTextSources),
    );
  }}

  if (snapshot.ok) {{
    assert(/^[0-9a-f]{{64}}$/.test(state.taskTextSha256), f.id + ": hash");
    assert(
      state.taskRequirements?.protocol === "task-requirements-v1",
      f.id + ": requirements protocol",
    );
    assert(
      state.taskRequirements?.task_sha256 === state.taskTextSha256,
      f.id + ": requirements task hash",
    );
  }}
}}

// Exact sanitized representation observed in real OpenCode E2E:
// text part contains JSON.stringify(user task), not bare semantic text.
const semanticRename = "Rename helper foo to bar.";
const observedRename = JSON.stringify(semanticRename);
const observed = userTurnSnapshotFromContext({{
  messages: [{{
    role: "user",
    id: "observed-json-string",
    content: [{{
      type: "text",
      text: observedRename,
    }}],
  }}],
}});

assert(observed.ok === true, "observed JSON-string task rejected");
assert(observed.text === semanticRename, "one representation layer not removed");
assert(
  observed.textSha256 ===
    createHash("sha256").update(semanticRename).digest("hex"),
  "task hash must cover canonical semantic text",
);
assert(
  observed.sources.includes("content_text_part_text_json_string"),
  "JSON-string representation provenance missing",
);

// Candidate representation seen with multiline real-task prompts:
// outer JSON quotes + materialized literal control characters.
const semanticMultiline = [
  "Use only search and execute_patch.",
  "",
  "TASK:",
  "Create a new page and endpoint.",
].join(String.fromCharCode(10));

const observedMultilineRaw =
  String.fromCharCode(34) +
  semanticMultiline +
  String.fromCharCode(34);

const observedMultiline = userTurnSnapshotFromContext({{
  messages: [{{
    role: "user",
    id: "observed-multiline-controls",
    content: [{{
      type: "text",
      text: observedMultilineRaw,
    }}],
  }}],
}});

assert(
  observedMultiline.ok === true,
  "multiline quote-wrapped task rejected",
);

assert(
  observedMultiline.text === semanticMultiline,
  "multiline task semantics changed",
);

assert(
  observedMultiline.sources.includes(
    "content_text_part_text_json_string_controls_repaired"
  ),
  "control-repair provenance missing",
);

// Same framing without the closing JSON quote remains invalid.
// Do not recover through quote stripping.
const malformedControlWrapped =
  userTurnSnapshotFromContext({{
    messages: [{{
      role: "user",
      id: "malformed-control-wrapper",
      content: [{{
        type: "text",
        text:
          String.fromCharCode(34) +
          "TASK:" +
          String.fromCharCode(10) +
          "Create endpoint.",
      }}],
    }}],
  }});

assert(
  malformedControlWrapped.ok === false,
  "unterminated JSON wrapper accepted",
);

assert(
  malformedControlWrapped.reason ===
    "task_text_representation_invalid",
  "unterminated wrapper wrong failure reason",
);

const observedState = {{
  turnID: observed.turnID,
  taskContextLatched: false,
  taskTurnID: null,
  taskTextSha256: null,
  taskTextBytes: 0,
  taskTextSources: [],
  taskContextShape: null,
  taskContextReason: "unresolved",
  taskContextDrift: false,
  taskAction: null,
  taskRequirements: null,
  taskRoleEvidence: [],
  mutationIntent: "unknown",
  mutationIntentReason: "unresolved",
}};
latchTaskContextForTurn(observedState, observed);
assert(
  observedState.mutationIntent === "rename_symbol",
  "real OpenCode JSON-string rename must classify rename",
);
assert(
  observedState.taskRequirements?.protocol === "task-requirements-v1",
  "real OpenCode JSON-string task must compile requirements",
);
assert(
  observedState.taskRequirements?.task_sha256 === observed.textSha256,
  "requirements must bind canonical semantic task hash",
);

// Current OpenCode V2 Session.Message.User representation:
// type=user, text=<task>, id, metadata, time.
const v2User = userTurnSnapshotFromContext({{
  messages: [{{
    type: "user",
    id: "msg_v2_user_shape",
    text: "Create a new page and endpoint.",
    metadata: {{}},
    time: {{ created: 1 }},
  }}],
}});

assert(v2User.ok === true, "OpenCode V2 user message rejected");
assert(
  v2User.turnID === "user:msg_v2_user_shape",
  "OpenCode V2 user message identity",
);
assert(
  v2User.sources.includes("message_text"),
  "OpenCode V2 message_text provenance missing",
);

const v2State = {{
  turnID: v2User.turnID,
  taskContextLatched: false,
  taskTurnID: null,
  taskTextSha256: null,
  taskTextBytes: 0,
  taskTextSources: [],
  taskContextShape: null,
  taskContextReason: "unresolved",
  taskContextDrift: false,
  taskAction: null,
  taskRequirements: null,
  taskRoleEvidence: [],
  mutationIntent: "unknown",
  mutationIntentReason: "unresolved",
}};

latchTaskContextForTurn(v2State, v2User);

assert(
  v2State.taskRequirements?.status === "compiled",
  "OpenCode V2 TaskRequirementsIR not compiled",
);
assert(
  v2State.taskRequirements?.required_roles?.includes("server_endpoint"),
  "OpenCode V2 endpoint obligation missing",
);
assert(
  v2State.taskRequirements?.required_roles?.includes("ui_surface"),
  "OpenCode V2 UI obligation missing",
);
assert(
  v2State.taskRequirements?.task_sha256 === v2User.textSha256,
  "OpenCode V2 requirements/task identity mismatch",
);

assert(
  v2State.taskShape?.status === "compiled",
  "OpenCode V2 TaskShapeIR not compiled",
);

assert(
  v2State.taskShape?.shape === "additive",
  "OpenCode V2 TaskShapeIR not additive",
);

assert(
  v2State.taskShape?.task_sha256 === v2User.textSha256,
  "OpenCode V2 TaskShapeIR/task identity mismatch",
);

assert(
  v2State.additiveLocalizationPlan?.status === "planned",
  "OpenCode V2 additive localization plan missing",
);

assert(
  v2State.additiveLocalizationPlan
    ?.positive_localization_obligations
    ?.includes("server_host"),
  "OpenCode V2 server_host obligation missing",
);

assert(
  v2State.additiveLocalizationPlan
    ?.positive_localization_obligations
    ?.includes("ui_host"),
  "OpenCode V2 ui_host obligation missing",
);

assert(
  v2State.additiveLocalizationPlan
    ?.localization_authority === false,
  "OpenCode V2 additive plan gained localization authority",
);

assert(
  v2State.additiveLocalizationPlan
    ?.mutation_authority === false,
  "OpenCode V2 additive plan gained mutation authority",
);

// Malformed representation fails closed; it must never fall through to
// generic_edit and acquire replace authority.
const malformed = userTurnSnapshotFromContext({{
  messages: [{{
    role: "user",
    id: "malformed-json-string",
    content: [{{
      type: "text",
      text: "\\"Rename helper foo to bar.",
    }}],
  }}],
}});
assert(malformed.ok === false, "malformed JSON-string task accepted");
assert(
  malformed.reason === "task_text_representation_invalid",
  "malformed representation reason",
);

// Existing latch/drift behavior is retained.
const first = userTurnSnapshotFromContext({{
  messages: [{{
    role: "user",
    id: "sticky",
    content: [{{
      type: "text",
      text: JSON.stringify("Rename foo to bar."),
    }}],
  }}],
}});
const sticky = {{
  turnID: first.turnID,
  taskContextLatched: false,
  taskTurnID: null,
  taskTextSha256: null,
  taskTextBytes: 0,
  taskTextSources: [],
  taskContextShape: null,
  taskContextReason: "unresolved",
  taskContextDrift: false,
  taskAction: null,
  taskRequirements: null,
  taskRoleEvidence: [],
  mutationIntent: "unknown",
  mutationIntentReason: "unresolved",
}};
latchTaskContextForTurn(sticky, first);
assert(sticky.mutationIntent === "rename_symbol", "initial latch");
assert(
  sticky.taskRequirements?.task_sha256 === first.textSha256,
  "initial requirements hash",
);
const stickyRequirementsHash =
  sticky.taskRequirements.task_sha256;

latchTaskContextForTurn(
  sticky,
  userTurnSnapshotFromContext({{messages: []}}),
);

assert(
  sticky.mutationIntent === "rename_symbol",
  "missing context changed latch",
);
assert(
  sticky.taskRequirements?.task_sha256 === stickyRequirementsHash,
  "missing context changed requirements latch",
);

const changed = userTurnSnapshotFromContext({{
  messages: [{{
    role: "user",
    id: "sticky",
    content: "Change threshold from 50 to 75.",
  }}],
}});
latchTaskContextForTurn(sticky, changed);
assert(sticky.taskContextDrift === true, "drift not detected");
assert(sticky.mutationIntent === "unknown", "drift did not fail closed");
assert(
  sticky.taskAction?.status === "unresolved",
  "drift TaskActionIR did not fail closed",
);
assert(
  sticky.taskRequirements?.status === "unresolved",
  "drift TaskRequirementsIR did not fail closed",
);
assert(
  sticky.taskRequirements?.reason === "task_text_drift_same_turn",
  "drift requirements reason",
);
assert(
  sticky.taskRoleEvidence?.length === 0,
  "drift retained stale role evidence",
);

const mismatchState = {{
  turnID: "expected-turn",
  taskContextLatched: false,
  taskTurnID: null,
  taskTextSha256: null,
  taskTextBytes: 0,
  taskTextSources: [],
  taskContextShape: null,
  taskContextReason: "unresolved",
  taskContextDrift: false,
  taskAction: null,
  taskRequirements: null,
  taskRoleEvidence: [{{ role: "stale", validated: true }}],
  mutationIntent: "unknown",
  mutationIntentReason: "unresolved",
}};

const mismatchSnapshot = {{
  ok: true,
  reason: "ok",
  turnID: "other-turn",
  text: "Create a new page.",
  textSha256: createHash("sha256")
    .update("Create a new page.")
    .digest("hex"),
  textBytes: 18,
  sources: ["content_string"],
  shape: "messages",
}};

const mismatchResult =
  latchTaskContextForTurn(mismatchState, mismatchSnapshot);

assert(mismatchResult.ok === false, "turn mismatch accepted");
assert(
  mismatchResult.reason === "task_turn_mismatch",
  "turn mismatch reason",
);
assert(
  mismatchState.taskRequirements?.status === "unresolved",
  "turn mismatch retained requirements",
);
assert(
  mismatchState.taskRoleEvidence?.length === 0,
  "turn mismatch retained role evidence",
);

console.log("PASS task-context adapter JSON-string canonicalization");
console.log("PASS canonical task hash covers semantic text");
console.log("PASS TaskActionIR + TaskRequirementsIR lifecycle coherence");
console.log("PASS task-context fixtures + latch + drift");
"""

with tempfile.TemporaryDirectory(prefix="task-context-v11-") as td:
    path = Path(td) / "gate.mjs"
    path.write_text(js, encoding="utf-8")
    subprocess.run(["node", str(path)], check=True)

assert CONTRACT["protocol"] == "task-context-v1"
assert CONTRACT["adapter_protocol"] == "task-context-adapter-v1.2-json-string-controls"
assert CONTRACT["intent_protocol"] == "mutation-intent-grammar-v1"
assert "content_text_part_text_json_string" in CONTRACT["recognized_text_sources"]
assert (
    "content_text_part_text_json_string_controls_repaired"
    in CONTRACT["recognized_text_sources"]
)
assert CONTRACT["rules"]["unknown_is_fail_closed"] is True
assert CONTRACT["rules"]["unsupported_shapes_recursively_scraped"] is False

for needle in (
    'const TASK_CONTEXT_ADAPTER_PROTOCOL = "task-context-adapter-v1.2-json-string-controls"',
    "function normalizeTaskTextChunk(value, source)",
    '"task_text_representation_invalid"',
    '"content_text_part_text_json_string"',
    "task_text_sha256:",
):
    assert needle in PLUGIN, needle

reset_start = PLUGIN.index("function resetTurnState(")
reset_end = PLUGIN.index(
    "\nfunction transitionExecutionState",
    reset_start,
)
reset_block = PLUGIN[reset_start:reset_end]

for needle in (
    "state.taskAction = null",
    "state.taskRequirements = null",
    "state.taskRoleEvidence = []",
):
    assert needle in reset_block, needle

print("PASS turn reset clears task-derived IR")
print("PASS task-context-v1.2 adapter boundary")
