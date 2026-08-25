#!/usr/bin/env python3
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_PATH = ROOT / "opencode/plugins/cpu-search.ts"
PLUGIN = PLUGIN_PATH.read_text(encoding="utf-8")


def section(start: str, end: str) -> str:
    i = PLUGIN.index(start)
    j = PLUGIN.index(end, i)
    return PLUGIN[i:j]


for anchor in (
    'const TASK_ACTION_PROTOCOL = "task-action-v1"',
    'const TASK_SEARCH_PLAN_PROTOCOL = "task-search-plan-v1"',
    'function compileTaskAction(value, taskSha256 = null) {',
    'function compileTaskSearchPlanForState(',
    'state.taskAction = taskAction',
    'queries = taskSearchPlan.effective_queries',
    'target = await safeTarget(root, taskSearchPlan.effective_path)',
    'kind: "task_search_plan"',
):
    assert anchor in PLUGIN, anchor

# Existing product budgets and action ABI are untouched.
for anchor in (
    'const MAX_MODEL_CALLS_PER_TURN = 4',
    'const MAX_EXECUTED_SEARCHES_PER_TURN = 4',
    'const MAX_PATCH_ATTEMPTS_PER_TURN = 2',
    'name: EXECUTE_RENAME_SYMBOL_TOOL,',
    'required: ["new_name"]',
):
    assert anchor in PLUGIN, anchor

# No corpus/task-specific business strings in product implementation.
for forbidden in (
    '_path_from_module_v226_probe',
    'getNodeFromPathV226Probe',
):
    assert forbidden not in PLUGIN, forbidden

compiler = section(
    'function taskActionIdentifier(value) {',
    '\nfunction userTurnSnapshotFromContext(event) {',
)
plan = section(
    'function compileTaskSearchPlanForState(',
    '\nfunction allowedToolsForState(state) {',
)

# The fast-path foundation compiles evidence inputs only. It cannot mutate,
# invoke Executor, issue Scout authority, or bypass the existing action plane.
for forbidden in (
    'executeCapabilityMutation(',
    'runPatchCompiler(',
    'runPatchExecutor(',
    'runInvariantVerifier(',
    'writeLocalMutationHandoff(',
    'attestLocalMutationCapability(',
):
    assert forbidden not in compiler, forbidden
    assert forbidden not in plan, forbidden

js = r"""
const TASK_ACTION_PROTOCOL = "task-action-v1";
const TASK_SEARCH_PLAN_PROTOCOL = "task-search-plan-v1";
const EXEC_STATE_LOCATE = "locate";
const SOURCE_LANGUAGE_EXTENSIONS = Object.freeze([
  "py","pyi","js","jsx","mjs","cjs","ts","tsx","mts","cts",
  "html","htm","css","scss","sass","less","xml","sql",
]);
const SOURCE_LANGUAGE_EXTENSION_SET = new Set(SOURCE_LANGUAGE_EXTENSIONS);
function buildLanguageGlob(prefix, extensions) {
  const unique = [...new Set(extensions ?? [])]
    .filter((ext) => SOURCE_LANGUAGE_EXTENSION_SET.has(ext))
    .sort();
  if (unique.length < 1) return null;
  if (unique.length === 1) return `${prefix}.${unique[0]}`;
  return `${prefix}.{${unique.join(",")}}`;
}
__COMPILER__
__PLAN__
function assert(x, m) { if (!x) throw new Error(m) }

const sha = "a".repeat(64);

const django = compileTaskAction(
  "Rename the private helper `_path_from_module` to `_path_from_module_v226_probe` and update only its proven references. Do not make unrelated changes.",
  sha,
);
assert(django.status === "exact", JSON.stringify(django));
assert(django.operation === "rename_symbol", JSON.stringify(django));
assert(django.old_name === "_path_from_module", JSON.stringify(django));
assert(django.new_name === "_path_from_module_v226_probe", JSON.stringify(django));

const ts = compileTaskAction(
  "Rename the private helper `getNodeFromPath` to `getNodeFromPathV226Probe` and update only its proven references. Do not make unrelated changes.",
  sha,
);
assert(ts.status === "exact", JSON.stringify(ts));
assert(ts.old_name === "getNodeFromPath", JSON.stringify(ts));
assert(ts.new_name === "getNodeFromPathV226Probe", JSON.stringify(ts));

const simple = compileTaskAction("Rename helper foo to bar.", sha);
assert(simple.status === "exact" && simple.old_name === "foo" && simple.new_name === "bar", JSON.stringify(simple));

const changed = compileTaskAction("Change the name of foo to bar.", sha);
assert(changed.status === "exact" && changed.old_name === "foo" && changed.new_name === "bar", JSON.stringify(changed));

const russian = compileTaskAction("Переименуй helper foo в bar.", sha);
assert(russian.status === "exact" && russian.old_name === "foo" && russian.new_name === "bar", JSON.stringify(russian));

const generic = compileTaskAction("Change threshold from 50 to 75.", sha);
assert(generic.status === "unresolved", JSON.stringify(generic));

const incomplete = compileTaskAction("Rename helper foo.", sha);
assert(incomplete.status === "unresolved", JSON.stringify(incomplete));

const negative = compileTaskAction("Change threshold without renaming public APIs.", sha);
assert(negative.status === "unresolved", JSON.stringify(negative));

const ambiguous = compileTaskAction("Rename foo to bar. Rename baz to qux.", sha);
assert(ambiguous.status === "unresolved", JSON.stringify(ambiguous));
assert(ambiguous.reason === "task_action_multiple_rename_pairs", JSON.stringify(ambiguous));

const state = {
  executionState: EXEC_STATE_LOCATE,
  mutationIntent: "rename_symbol",
  taskTextSha256: sha,
  taskAction: ts,
};
const pinned = compileTaskSearchPlanForState(
  state,
  ["api.*node", "fs.ts"],
  "packages/typescript/src/api",
  "**/*.py",
);
assert(pinned.applied === true, JSON.stringify(pinned));
assert(JSON.stringify(pinned.effective_queries) === JSON.stringify(["getNodeFromPath"]), JSON.stringify(pinned));
assert(pinned.effective_path === ".", JSON.stringify(pinned));
assert(typeof pinned.effective_glob === "string", JSON.stringify(pinned));
assert(pinned.effective_glob.startsWith("**/*.{"), JSON.stringify(pinned));
assert(pinned.effective_glob.includes("py"), JSON.stringify(pinned));
assert(pinned.effective_glob.includes("ts"), JSON.stringify(pinned));
assert(JSON.stringify(pinned.requested_queries) === JSON.stringify(["api.*node", "fs.ts"]), JSON.stringify(pinned));

const stale = compileTaskSearchPlanForState(
  {...state, taskTextSha256: "b".repeat(64)},
  ["model-query"],
  "src",
  "**/*.ts",
);
assert(stale.applied === false, JSON.stringify(stale));
assert(JSON.stringify(stale.effective_queries) === JSON.stringify(["model-query"]), JSON.stringify(stale));
assert(stale.effective_path === "src", JSON.stringify(stale));
assert(stale.effective_glob === "**/*.ts", JSON.stringify(stale));

const unresolved = compileTaskSearchPlanForState(
  {...state, mutationIntent: "generic_edit", taskAction: generic},
  ["threshold"],
  "core",
  "**/*.py",
);
assert(unresolved.applied === false, JSON.stringify(unresolved));
assert(JSON.stringify(unresolved.effective_queries) === JSON.stringify(["threshold"]), JSON.stringify(unresolved));

console.log("PASS exact rename task compiles to typed TaskActionIR");
console.log("PASS ambiguity/negative/generic tasks fail closed");
console.log("PASS exact global rename pins deterministic query + root + supported-source scope");
console.log("PASS stale/unresolved tasks preserve model search path");
""".replace("__COMPILER__", compiler).replace("__PLAN__", plan)

with tempfile.TemporaryDirectory(prefix="v227-task-action-") as td:
    path = Path(td) / "gate.mjs"
    path.write_text(js, encoding="utf-8")
    cp = subprocess.run(
        ["node", str(path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert cp.returncode == 0, (cp.stdout, cp.stderr)
    print(cp.stdout.strip())

print("PASS v2.27-A deterministic Task Action IR foundation")
