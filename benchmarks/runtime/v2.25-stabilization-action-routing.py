#!/usr/bin/env python3
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")
ADDITIVE_MODULE = (
    ROOT / "opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"
).resolve()

assert ADDITIVE_MODULE.is_file(), ADDITIVE_MODULE


def section(start: str, end: str) -> str:
    i = PLUGIN.index(start)
    j = PLUGIN.index(end, i)
    return PLUGIN[i:j]


frontier = section(
    "function resolveMutationActionForState(state)",
    "function allowedToolsForState(state)",
)

js = f"""
import {{
  ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
  EXECUTE_ADDITIVE_PLAN_TOOL,
}} from {json.dumps(ADDITIVE_MODULE.as_uri())};

const EXEC_STATE_MUTATE = "mutate";
const EXEC_STATE_REPAIR = "repair";
const EXECUTE_REPLACE_NODE_TOOL = "execute_replace_node";
const EXECUTE_RENAME_SYMBOL_TOOL = "execute_rename_symbol";
const SCOUT_RENAME_TARGET_PROTOCOL = "scout-rename-target-v2";

{frontier}

function assert(x,m) {{ if (!x) throw new Error(m) }}

const base = {{
  executionState: EXEC_STATE_MUTATE,
  localMutationCapability: {{replaceNodeReady:true}},
  localMutationCandidates: [{{target:{{}}}}],
  renameMutationCapability: {{
    protocol: SCOUT_RENAME_TARGET_PROTOCOL,
    ready: true,
    globalReady: true,
    operation: "rename_symbol",
    sourceHandoffPath: "h.json",
  }},
  additiveMutationCapability: {{
    protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
    ready: true,
    mutation_authority: true,
    operation: "additive_surface",
  }},
  additiveMutationHandoffPath: "additive.json",
  scoutHandoffPath: "h.json",
  activeMutationTool: null,
  mutationIntent: "unknown",
  executionReadiness: {{selected_mutation_operation:null}},
}};

const withOperation = (operation) => ({{
  ...base,
  executionReadiness: {{selected_mutation_operation:operation}},
}});

assert(
  JSON.stringify(mutationToolsForState(base)) === JSON.stringify([]),
  "unresolved readiness fails closed",
);

const replace = withOperation("replace_node");
assert(
  JSON.stringify(mutationToolsForState(replace)) ===
    JSON.stringify([EXECUTE_REPLACE_NODE_TOOL]),
  "canonical readiness selects replace only",
);

const rename = withOperation("rename_symbol");
assert(
  JSON.stringify(mutationToolsForState(rename)) ===
    JSON.stringify([EXECUTE_RENAME_SYMBOL_TOOL]),
  "canonical readiness selects rename only",
);

const additive = withOperation("additive_surface");
assert(
  JSON.stringify(mutationToolsForState(additive)) ===
    JSON.stringify([EXECUTE_ADDITIVE_PLAN_TOOL]),
  "canonical readiness selects additive only",
);

const noRename = {{...rename, renameMutationCapability:null}};
assert(
  JSON.stringify(mutationToolsForState(noRename)) === JSON.stringify([]),
  "rename cannot fallback",
);

const noReplace = {{
  ...replace,
  localMutationCapability:null,
  localMutationCandidates:[],
}};
assert(
  JSON.stringify(mutationToolsForState(noReplace)) === JSON.stringify([]),
  "replace cannot fallback",
);

const noAdditive = {{
  ...additive,
  additiveMutationCapability:null,
  additiveMutationHandoffPath:null,
}};
assert(
  JSON.stringify(mutationToolsForState(noAdditive)) === JSON.stringify([]),
  "additive cannot fallback",
);

const untrustedAdditive = {{
  ...additive,
  additiveMutationCapability: {{
    ...additive.additiveMutationCapability,
    mutation_authority:false,
  }},
}};
assert(
  JSON.stringify(mutationToolsForState(untrustedAdditive)) === JSON.stringify([]),
  "additive requires explicit mutation authority",
);

const intentDrift = {{...replace, mutationIntent:"rename_symbol"}};
assert(
  JSON.stringify(mutationToolsForState(intentDrift)) ===
    JSON.stringify([EXECUTE_REPLACE_NODE_TOOL]),
  "mutation intent cannot override canonical readiness",
);

const stickyRename = {{
  ...replace,
  executionState:EXEC_STATE_REPAIR,
  activeMutationTool:EXECUTE_RENAME_SYMBOL_TOOL,
}};
assert(
  JSON.stringify(mutationToolsForState(stickyRename)) ===
    JSON.stringify([EXECUTE_RENAME_SYMBOL_TOOL]),
  "repair remains sticky to proven rename capability",
);

const stickyAdditive = {{
  ...replace,
  executionState:EXEC_STATE_REPAIR,
  activeMutationTool:EXECUTE_ADDITIVE_PLAN_TOOL,
}};
assert(
  JSON.stringify(mutationToolsForState(stickyAdditive)) ===
    JSON.stringify([EXECUTE_ADDITIVE_PLAN_TOOL]),
  "repair remains sticky to proven additive capability",
);

const unknownOperation = withOperation("unsupported");
assert(
  JSON.stringify(mutationToolsForState(unknownOperation)) === JSON.stringify([]),
  "unknown readiness operation fails closed",
);

for (const state of [
  base,
  replace,
  rename,
  additive,
  noRename,
  noReplace,
  noAdditive,
  untrustedAdditive,
  intentDrift,
  stickyRename,
  stickyAdditive,
  unknownOperation,
]) {{
  assert(mutationToolsForState(state).length <= 1, "frontier cardinality");
}}

console.log(
  "PASS pure fail-closed deterministic mutation frontier canonical-readiness-v1",
);
"""

with tempfile.TemporaryDirectory(prefix="v225-route-") as td:
    path = Path(td) / "gate.mjs"
    path.write_text(js, encoding="utf-8")
    subprocess.run(["node", str(path)], check=True)

assert 'const TASK_CONTEXT_PROTOCOL = "task-context-v1"' in PLUGIN
assert "mutation_action_reason:" in PLUGIN
assert "selected_mutation_operation" in frontier
assert "ADDITIVE_MUTATION_CAPABILITY_PROTOCOL" in frontier
print("PASS v2.25 deterministic action routing")
