#!/usr/bin/env python3
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")

def section(start: str, end: str) -> str:
    i = PLUGIN.index(start)
    j = PLUGIN.index(end, i)
    return PLUGIN[i:j]

frontier = section("function resolveMutationActionForState(state)", "function allowedToolsForState(state)")
js = f"""
const EXEC_STATE_MUTATE = "mutate";
const EXEC_STATE_REPAIR = "repair";
const EXECUTE_REPLACE_NODE_TOOL = "execute_replace_node";
const EXECUTE_RENAME_SYMBOL_TOOL = "execute_rename_symbol";
const SCOUT_RENAME_TARGET_PROTOCOL = "scout-rename-target-v2";
{frontier}
function assert(x,m) {{ if (!x) throw new Error(m) }}
const base = {{executionState:EXEC_STATE_MUTATE,localMutationCapability:{{replaceNodeReady:true}},localMutationCandidates:[{{target:{{}}}}],renameMutationCapability:{{protocol:SCOUT_RENAME_TARGET_PROTOCOL,ready:true,globalReady:true,operation:"rename_symbol",sourceHandoffPath:"h.json"}},scoutHandoffPath:"h.json",activeMutationTool:null,mutationIntent:"unknown"}};
assert(JSON.stringify(mutationToolsForState(base))===JSON.stringify([]),"unknown fails closed");
const generic={{...base,mutationIntent:"generic_edit"}};
assert(JSON.stringify(mutationToolsForState(generic))===JSON.stringify([EXECUTE_REPLACE_NODE_TOOL]),"generic replace only");
const rename={{...base,mutationIntent:"rename_symbol"}};
assert(JSON.stringify(mutationToolsForState(rename))===JSON.stringify([EXECUTE_RENAME_SYMBOL_TOOL]),"rename only");
const noRename={{...rename,renameMutationCapability:null}};
assert(JSON.stringify(mutationToolsForState(noRename))===JSON.stringify([]),"rename cannot fallback");
const noReplace={{...generic,localMutationCapability:null,localMutationCandidates:[]}};
assert(JSON.stringify(mutationToolsForState(noReplace))===JSON.stringify([]),"generic cannot fallback");
const sticky={{...generic,executionState:EXEC_STATE_REPAIR,activeMutationTool:EXECUTE_RENAME_SYMBOL_TOOL}};
assert(JSON.stringify(mutationToolsForState(sticky))===JSON.stringify([EXECUTE_RENAME_SYMBOL_TOOL]),"repair sticky");
for (const state of [base,generic,rename,noRename,noReplace,sticky]) assert(mutationToolsForState(state).length<=1,"frontier cardinality");
console.log("PASS pure fail-closed deterministic mutation frontier");
"""
with tempfile.TemporaryDirectory(prefix="v225-route-") as td:
    path=Path(td)/"gate.mjs"; path.write_text(js,encoding="utf-8"); subprocess.run(["node",str(path)],check=True)
assert 'const TASK_CONTEXT_PROTOCOL = "task-context-v1"' in PLUGIN
assert 'mutation_action_reason:' in PLUGIN
print("PASS v2.25 deterministic action routing")
