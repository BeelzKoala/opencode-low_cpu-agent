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

js = f"""
import {{ createHash }} from "node:crypto";

const TASK_CONTEXT_PROTOCOL = "task-context-v1";
const TASK_CONTEXT_ADAPTER_PROTOCOL = "task-context-adapter-v1.1-json-string";
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
  mutationIntent: "unknown",
  mutationIntentReason: "unresolved",
}};
latchTaskContextForTurn(observedState, observed);
assert(
  observedState.mutationIntent === "rename_symbol",
  "real OpenCode JSON-string rename must classify rename",
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
  mutationIntent: "unknown",
  mutationIntentReason: "unresolved",
}};
latchTaskContextForTurn(sticky, first);
assert(sticky.mutationIntent === "rename_symbol", "initial latch");
latchTaskContextForTurn(
  sticky,
  userTurnSnapshotFromContext({{messages: []}}),
);
assert(sticky.mutationIntent === "rename_symbol", "missing context changed latch");

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

console.log("PASS task-context adapter JSON-string canonicalization");
console.log("PASS canonical task hash covers semantic text");
console.log("PASS task-context fixtures + latch + drift");
"""

with tempfile.TemporaryDirectory(prefix="task-context-v11-") as td:
    path = Path(td) / "gate.mjs"
    path.write_text(js, encoding="utf-8")
    subprocess.run(["node", str(path)], check=True)

assert CONTRACT["protocol"] == "task-context-v1"
assert CONTRACT["adapter_protocol"] == "task-context-adapter-v1.1-json-string"
assert CONTRACT["intent_protocol"] == "mutation-intent-grammar-v1"
assert "content_text_part_text_json_string" in CONTRACT["recognized_text_sources"]
assert CONTRACT["rules"]["unknown_is_fail_closed"] is True
assert CONTRACT["rules"]["unsupported_shapes_recursively_scraped"] is False

for needle in (
    'const TASK_CONTEXT_ADAPTER_PROTOCOL = "task-context-adapter-v1.1-json-string"',
    "function normalizeTaskTextChunk(value, source)",
    '"task_text_representation_invalid"',
    '"content_text_part_text_json_string"',
    "task_text_sha256:",
):
    assert needle in PLUGIN, needle

print("PASS task-context-v1.1 adapter boundary")
