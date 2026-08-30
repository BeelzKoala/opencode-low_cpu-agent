#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"


def node(source: str) -> dict:
    cp = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert cp.returncode == 0, cp.stderr
    return json.loads(cp.stdout)


req_uri = (CORE / "task-requirements-v1.mjs").resolve().as_uri()
cap_uri = (CORE / "repo-capability-v1.mjs").resolve().as_uri()
graph_uri = (CORE / "resource-graph-v1.mjs").resolve().as_uri()

data = node(f"""
import {{
  compileTaskRequirements,
}} from {json.dumps(req_uri)};

import {{
  compileRepoCapabilityProfile,
  planTaskSourceFamilies,
}} from {json.dumps(cap_uri)};

import {{
  boundedTaskCausalClosure,
  normalizeValidatedResourceEdge,
}} from {json.dumps(graph_uri)};

const sha = "a".repeat(64);

const task = compileTaskRequirements(
  "Create a new page and endpoint and link it from navigation.",
  sha,
);

const profile = compileRepoCapabilityProfile({{
  inventoryProtocol: "source-glob-inventory-v1",
  complete: true,
  files: 20,
  extensions: {{
    py: 12,
    html: 5,
    sql: 3,
  }},
}});

const plan = planTaskSourceFamilies({{
  taskRequirements: task,
  profile,
  requestedExtensions: ["py"],
  maxExtensions: 12,
}});

const partialObserved = compileRepoCapabilityProfile({{
  inventoryProtocol: "source-glob-inventory-v1",
  complete: false,
  files: 10,
  extensions: {{
    py: 7,
    html: 3,
  }},
}});

const partialObservedPlan = planTaskSourceFamilies({{
  taskRequirements: task,
  profile: partialObserved,
  requestedExtensions: ["py"],
  maxExtensions: 12,
}});

const partialMissing = compileRepoCapabilityProfile({{
  inventoryProtocol: "source-glob-inventory-v1",
  complete: false,
  files: 8,
  extensions: {{
    py: 8,
  }},
}});

const partialMissingPlan = planTaskSourceFamilies({{
  taskRequirements: task,
  profile: partialMissing,
  requestedExtensions: ["py"],
  maxExtensions: 12,
}});

const rename = compileTaskRequirements(
  "Rename alpha to beta in sample.py.",
  sha,
);

const renamePlan = planTaskSourceFamilies({{
  taskRequirements: rename,
  profile,
  requestedExtensions: ["py"],
}});

const uiTask = compileTaskRequirements(
  "Create a new page.",
  sha,
);

const clientOnlyProfile = compileRepoCapabilityProfile({{
  inventoryProtocol: "source-glob-inventory-v1",
  complete: true,
  files: 9,
  extensions: {{
    py: 5,
    js: 1,
    jsx: 1,
    mjs: 1,
    cjs: 1,
  }},
}});

const budgetPlan = planTaskSourceFamilies({{
  taskRequirements: uiTask,
  profile: clientOnlyProfile,
  requestedExtensions: ["py"],
  maxExtensions: 2,
}});

const witness = (file, line, extractor) => ({{
  file,
  sha256: "b".repeat(64),
  line,
  extractor,
}});

const edges = [
  {{
    validated: true,
    from: "file:a.py",
    to: "route:a",
    kind: "declares_route",
    confidence: 0.9,
    witness: witness("a.py", 10, "fixture"),
  }},
  {{
    validated: true,
    from: "route:a",
    to: "resource:page.html",
    kind: "renders_resource",
    confidence: 0.8,
    witness: witness("a.py", 11, "fixture"),
  }},
  {{
    validated: true,
    from: "file:a.py",
    to: "resource:page.html",
    kind: "renders_resource",
    confidence: 0.4,
    witness: witness("a.py", 12, "fixture"),
  }},
  {{
    validated: false,
    from: "route:a",
    to: "resource:untrusted.html",
    kind: "renders_resource",
    confidence: 1.0,
    witness: witness("a.py", 13, "fixture"),
  }},
];

const closure = boundedTaskCausalClosure({{
  seeds: [{{
    id: "file:a.py",
    score: 1,
    task_causal: true,
  }}],
  edges,
  maxHops: 3,
  maxNodes: 16,
  maxEdges: 16,
}});

const edgeBudgetClosure = boundedTaskCausalClosure({{
  seeds: [{{
    id: "file:a.py",
    score: 1,
    task_causal: true,
  }}],
  edges,
  maxHops: 3,
  maxNodes: 16,
  maxEdges: 1,
}});

const invalidWitness = normalizeValidatedResourceEdge({{
  validated: true,
  from: "a",
  to: "b",
  kind: "imports",
  confidence: 1,
  witness: {{
    file: "a.py",
    sha256: "not-a-sha",
    line: 1,
    extractor: "fixture",
  }},
}});

console.log(JSON.stringify({{
  task,
  profile,
  plan,
  partialObserved,
  partialObservedPlan,
  partialMissing,
  partialMissingPlan,
  renamePlan,
  budgetPlan,
  closure,
  edgeBudgetClosure,
  invalidWitness,
}}));
""")

profile = data["profile"]
plan = data["plan"]

assert profile["protocol"] == "repo-capability-v1"
assert profile["routing_only"] is True
assert profile["inventory_complete"] is True
assert profile["absence_claims_allowed"] is True

assert profile["languages"]["python"]["observed_files"] == 12
assert profile["source_families"]["ui_resource"]["extensions"] == ["html"]

# Python already covers endpoint/server work. UI is observed in the repo and
# is the preferred family for page/navigation work, so it must be added.
assert plan["applied"] is True, plan
assert plan["added_extensions"] == ["html"], plan
assert plan["selected_families"] == ["ui_resource"], plan
assert plan["unresolved_roles"] == [], plan
assert set(plan["effective_extensions"]) == {"py", "html"}

# Presence is still useful on incomplete inventories.
assert data["partialObserved"]["absence_claims_allowed"] is False
assert data["partialObservedPlan"]["applied"] is True
assert data["partialObservedPlan"]["added_extensions"] == ["html"]

# But absence on an incomplete inventory is not evidence: Python must not be
# accepted as proof that the preferred UI family does not exist.
assert data["partialMissing"]["absence_claims_allowed"] is False
assert data["partialMissingPlan"]["applied"] is False
assert "ui_surface" in data["partialMissingPlan"]["unresolved_roles"]

# Exact rename remains unaffected.
assert data["renamePlan"]["applied"] is False
assert data["renamePlan"]["reason"] == "no_task_role_obligations"

# Never partially truncate a whole observed family just to satisfy a budget.
assert data["budgetPlan"]["applied"] is False
assert data["budgetPlan"]["reason"] == "source_family_extension_budget"

closure = data["closure"]

assert closure["protocol"] == "resource-graph-v1"
assert closure["routing_only"] is True
assert closure["authority"] == "routing_task_causal_only"
assert closure["invalid_edges_ignored"] == 1

by_id = {row["id"]: row for row in closure["nodes"]}

assert "resource:untrusted.html" not in by_id
assert abs(by_id["resource:page.html"]["score"] - 0.72) < 1e-9
assert by_id["resource:page.html"]["hops"] == 2

# Best-path score wins. Parallel paths are not summed (hub amplification).
assert by_id["resource:page.html"]["score"] < 1

assert data["edgeBudgetClosure"]["truncated"] is True
assert data["edgeBudgetClosure"]["edges_considered"] == 1

assert data["invalidWitness"] is None

for name in (
    "repo-capability-v1.mjs",
    "resource-graph-v1.mjs",
):
    body = (CORE / name).read_text(encoding="utf-8").lower()

    for forbidden in (
        "ozon",
        "bestsellers",
        "rd_bestsellers_data",
        "templates/snippets/menu.html",
    ):
        assert forbidden not in body, (name, forbidden)

plugin = PLUGIN.read_text(encoding="utf-8")

for marker in (
    'from "./cpu-search-core/repo-capability-v1.mjs"',
    "async function resolveTaskSourceFamilyGlob(",
    "compileRepoCapabilityProfile({",
    "planTaskSourceFamilies({",
    'kind: "source_family_plan"',
    "glob_role_broadened:",
):
    assert marker in plugin, marker

print("PASS RepoCapabilityProfile reuses bounded source inventory")
print("PASS complete inventory selects preferred observed source family")
print("PASS partial inventory uses presence but never infers absence")
print("PASS role-aware Python -> HTML expansion is repository-neutral")
print("PASS whole-family extension budget fails closed")
print("PASS exact rename search scope remains unaffected")
print("PASS ResourceEdge requires proof-carrying validated witness")
print("PASS task-causal closure uses bounded best-path propagation")
print("PASS parallel paths are not summed / no hub amplification")
print("PASS ResourceGraph remains routing-only")
print("PASS v2.28-B1 repo capability + resource graph foundation")
