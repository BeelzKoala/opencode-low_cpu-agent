#!/usr/bin/env python3
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")
TASK = (ROOT / "opencode/plugins/cpu-search-core/task-action-v1.mjs").resolve()
PLAN = (ROOT / "opencode/plugins/cpu-search-core/task-search-plan-v1.mjs").resolve()

for anchor in (
    'from "./cpu-search-core/task-action-v1.mjs"',
    'from "./cpu-search-core/task-search-plan-v1.mjs"',
    'state.taskAction = taskAction',
    'queries = taskSearchPlan.effective_queries',
    'target = await safeTarget(root, taskSearchPlan.effective_path)',
    'kind: "task_search_plan"',
):
    assert anchor in PLUGIN, anchor

assert 'function compileTaskAction(' not in PLUGIN
assert 'function compileTaskSearchPlanForState(' not in PLUGIN

for anchor in (
    'const MAX_MODEL_CALLS_PER_TURN = 4',
    'const MAX_EXECUTED_SEARCHES_PER_TURN = 4',
    'const MAX_PATCH_ATTEMPTS_PER_TURN = 2',
    'name: EXECUTE_RENAME_SYMBOL_TOOL,',
    'required: ["new_name"]',
):
    assert anchor in PLUGIN, anchor

for forbidden in ('_path_from_module_v226_probe', 'getNodeFromPathV226Probe'):
    assert forbidden not in PLUGIN, forbidden

for core in (TASK.read_text(encoding="utf-8"), PLAN.read_text(encoding="utf-8")):
    for forbidden in (
        'executeCapabilityMutationCore(', 'runPatchCompiler(',
        'runPatchExecutor(', 'runInvariantVerifier(',
        'writeLocalMutationHandoff(', 'attestLocalMutationCapability(',
    ):
        assert forbidden not in core, forbidden

js = f'''
import {{ compileTaskAction }} from {json.dumps(TASK.as_uri())};
import {{ compileTaskSearchPlanForState }} from {json.dumps(PLAN.as_uri())};
function assert(x, m) {{ if (!x) throw new Error(m) }}
const sha = "a".repeat(64);
const globalSourceGlob = "**/*.{{css,cts,htm,html,js,jsx,less,mjs,mts,py,pyi,sass,scss,sql,ts,tsx,xml}}";

const django = compileTaskAction(
  "Rename the private helper `_path_from_module` to `_path_from_module_v226_probe` and update only its proven references. Do not make unrelated changes.", sha);
assert(django.status === "exact", JSON.stringify(django));
assert(django.old_name === "_path_from_module", JSON.stringify(django));
assert(django.new_name === "_path_from_module_v226_probe", JSON.stringify(django));

const ts = compileTaskAction(
  "Rename the private helper `getNodeFromPath` to `getNodeFromPathV226Probe` and update only its proven references. Do not make unrelated changes.", sha);
assert(ts.status === "exact", JSON.stringify(ts));

const generic = compileTaskAction("Change threshold from 50 to 75.", sha);
assert(generic.status === "unresolved", JSON.stringify(generic));
const negative = compileTaskAction("Change threshold without renaming public APIs.", sha);
assert(negative.status === "unresolved", JSON.stringify(negative));
const ambiguous = compileTaskAction("Rename foo to bar. Rename baz to qux.", sha);
assert(ambiguous.reason === "task_action_multiple_rename_pairs", JSON.stringify(ambiguous));

const state = {{
  executionState: "locate", mutationIntent: "rename_symbol",
  taskTextSha256: sha, taskAction: ts,
}};
const pinned = compileTaskSearchPlanForState(
  state, ["api.*node", "fs.ts"], "packages/typescript/src/api",
  "**/*.py", globalSourceGlob);
assert(pinned.applied === true, JSON.stringify(pinned));
assert(JSON.stringify(pinned.effective_queries) === JSON.stringify(["getNodeFromPath"]), JSON.stringify(pinned));
assert(pinned.effective_path === ".", JSON.stringify(pinned));
assert(pinned.effective_glob === globalSourceGlob, JSON.stringify(pinned));

const stale = compileTaskSearchPlanForState(
  {{...state, taskTextSha256: "b".repeat(64)}}, ["model-query"],
  "src", "**/*.ts", globalSourceGlob);
assert(stale.applied === false, JSON.stringify(stale));
assert(stale.effective_queries[0] === "model-query", JSON.stringify(stale));

console.log("PASS exact rename task compiles to typed TaskActionIR");
console.log("PASS ambiguity/negative/generic tasks fail closed");
console.log("PASS exact global rename pins deterministic query + root + supported-source scope");
console.log("PASS stale/unresolved tasks preserve model search path");
'''

with tempfile.TemporaryDirectory(prefix="v227-task-action-") as td:
    path = Path(td) / "gate.mjs"
    path.write_text(js, encoding="utf-8")
    cp = subprocess.run(["node", str(path)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert cp.returncode == 0, (cp.stdout, cp.stderr)
    print(cp.stdout.strip())

print("PASS v2.27-A deterministic Task Action IR foundation")
