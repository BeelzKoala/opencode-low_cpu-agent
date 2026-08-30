#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"
PLUGIN_PATH = ROOT / "opencode/plugins/cpu-search.ts"
INSTALL_PATH = ROOT / "scripts/install-plugin-stack.sh"

PLUGIN = PLUGIN_PATH.read_text(encoding="utf-8")
INSTALL = INSTALL_PATH.read_text(encoding="utf-8")

js = r'''
import assert from "node:assert/strict";

import {
  compileTaskAnchors,
} from "./opencode/plugins/cpu-search-core/task-anchor-v1.mjs";

import {
  runTaskCausalShadow,
} from "./opencode/plugins/cpu-search-core/task-causal-shadow-v1.mjs";

import {
  normalizeValidatedResourceEdge,
} from "./opencode/plugins/cpu-search-core/resource-graph-v1.mjs";

const SHA = "a".repeat(64);

function routes(text) {
  return compileTaskAnchors(
    text,
    SHA,
  ).anchors
    .filter(
      (x) => x.kind === "route_literal",
    )
    .map(
      (x) => x.value,
    );
}

// ------------------------------------------------------------
// Route token boundary normalization.
// ------------------------------------------------------------

const routeFixtures = [
  [
    "Preserve /export: existing behavior.",
    ["/export"],
  ],
  [
    "Preserve /export.",
    ["/export"],
  ],
  [
    "Keep /api/report, but add another page.",
    ["/api/report"],
  ],
  [
    "Keep /api/report; add another page.",
    ["/api/report"],
  ],
  [
    "Preserve /export!",
    ["/export"],
  ],
  [
    "Use (/export) for compatibility.",
    ["/export"],
  ],
  [
    "Use /users/:id for the handler.",
    ["/users/:id"],
  ],
  [
    "Use /v1.0/report for compatibility.",
    ["/v1.0/report"],
  ],
  [
    "Use /a,b/report for compatibility.",
    ["/a,b/report"],
  ],
  [
    'Preserve "/literal:" exactly.',
    ["/literal:"],
  ],
];

for (const [text, expected] of routeFixtures) {
  assert.deepEqual(
    routes(text),
    expected,
    text,
  );
}

console.log(
  "PASS TaskAnchor route boundaries distinguish prose punctuation from route syntax",
);

// ------------------------------------------------------------
// Generic deterministic task anchors.
// ------------------------------------------------------------

const anchors =
  compileTaskAnchors(
    `
Create a report page.
Preserve /export.
Read report_rows using report_date.
Return a valid .xlsx.
`,
    SHA,
  );

assert.equal(
  anchors.status,
  "compiled",
);

assert(
  anchors.anchors.some(
    (x) =>
      x.kind === "route_literal" &&
      x.value === "/export",
  ),
);

assert(
  anchors.anchors.some(
    (x) =>
      x.kind === "identifier" &&
      x.value === "report_rows",
  ),
);

assert(
  anchors.anchors.some(
    (x) =>
      x.kind === "identifier" &&
      x.value === "report_date",
  ),
);

assert(
  anchors.anchors.some(
    (x) =>
      x.kind === "artifact_extension" &&
      x.value === ".xlsx",
  ),
);

console.log(
  "PASS TaskAnchorIR extracts explicit deterministic code-like anchors",
);

// ------------------------------------------------------------
// ResourceEdge fixture helper.
// ------------------------------------------------------------

function edge(
  from,
  to,
  kind,
  file,
  line,
) {
  const result =
    normalizeValidatedResourceEdge({
      validated: true,
      from,
      to,
      kind,
      confidence: 1,
      witness: {
        file,
        sha256:
          "b".repeat(64),
        line,
        extractor:
          "v2.28-e0-fixture",
      },
    });

  assert(
    result,
    `${kind}:${from}->${to}`,
  );

  return result;
}

// ------------------------------------------------------------
// Critical negative topology:
// route anchor must not reverse-walk into the owning FILE.
// ------------------------------------------------------------

const fileLevelEdges = [
  edge(
    "file:routes/report.py",
    "route:/export",
    "declares_route",
    "routes/report.py",
    10,
  ),

  edge(
    "file:routes/report.py",
    "resource:unrelated.html",
    "renders_resource",
    "routes/report.py",
    20,
  ),
];

const shadow =
  runTaskCausalShadow({
    taskAnchors:
      anchors,

    edges:
      fileLevelEdges,

    maxHops: 3,
    maxNodes: 16,
    maxEdges: 16,
  });

assert.equal(
  shadow.protocol,
  "task-causal-shadow-v1",
);

assert.equal(
  shadow.status,
  "observed",
);

assert.equal(
  shadow.authority,
  "shadow_observation",
);

assert.equal(
  shadow.localization_authority,
  false,
);

assert.equal(
  shadow.mutation_authority,
  false,
);

assert.deepEqual(
  shadow.bound_anchors.map(
    (x) => x.node,
  ),
  ["route:/export"],
);

const reached =
  new Set(
    shadow.closure.nodes.map(
      (x) => x.id,
    ),
  );

assert(
  reached.has(
    "route:/export",
  ),
);

assert(
  !reached.has(
    "file:routes/report.py",
  ),
  "task route reverse-walked into file ownership",
);

assert(
  !reached.has(
    "resource:unrelated.html",
  ),
  "file co-location leaked into task causality",
);

console.log(
  "PASS task route cannot reverse-walk through file-level co-location",
);

// ------------------------------------------------------------
// Ambiguous literal route binding must abstain.
// ------------------------------------------------------------

const ambiguousAnchors =
  compileTaskAnchors(
    "Use /api/report.",
    "c".repeat(64),
  );

const ambiguous =
  runTaskCausalShadow({
    taskAnchors:
      ambiguousAnchors,

    edges: [
      edge(
        "file:get.ts",
        "route:GET /api/report",
        "declares_route",
        "get.ts",
        1,
      ),

      edge(
        "file:post.ts",
        "route:POST /api/report",
        "declares_route",
        "post.ts",
        1,
      ),
    ],
  });

assert.equal(
  ambiguous.seed_count,
  0,
);

assert.equal(
  ambiguous.ambiguous_anchors.length,
  1,
);

assert.deepEqual(
  ambiguous.ambiguous_anchors[0].candidates,
  [
    "route:GET /api/report",
    "route:POST /api/report",
  ],
);

console.log(
  "PASS ambiguous graph-node binding abstains",
);

// ------------------------------------------------------------
// Valid forward topology is observable.
// ------------------------------------------------------------

const forwardAnchors =
  compileTaskAnchors(
    "Open /reports.",
    "d".repeat(64),
  );

const forward =
  runTaskCausalShadow({
    taskAnchors:
      forwardAnchors,

    edges: [
      edge(
        "route:/reports",
        "component:ReportsPage",
        "route_to_component",
        "src/App.tsx",
        4,
      ),
    ],
  });

assert.equal(
  forward.seed_count,
  1,
);

assert(
  forward.closure.nodes.some(
    (x) =>
      x.id ===
      "component:ReportsPage",
  ),
);

assert.equal(
  forward.localization_authority,
  false,
);

assert.equal(
  forward.mutation_authority,
  false,
);

console.log(
  "PASS validated forward task-causal topology is observable but non-authoritative",
);

// ------------------------------------------------------------
// Artifact extension never becomes graph seed.
// ------------------------------------------------------------

const artifactOnly =
  compileTaskAnchors(
    "Return a valid .xlsx.",
    "e".repeat(64),
  );

const artifactShadow =
  runTaskCausalShadow({
    taskAnchors:
      artifactOnly,

    edges: [
      edge(
        "file:a.js",
        "route:/xlsx",
        "declares_route",
        "a.js",
        1,
      ),
    ],
  });

assert.equal(
  artifactShadow.seed_count,
  0,
);

assert(
  artifactShadow.unbound_anchors.some(
    (x) =>
      x.kind ===
        "artifact_extension" &&
      x.reason ===
        "non_graph_anchor",
  ),
);

console.log(
  "PASS observational artifact anchors cannot seed ResourceGraph",
);

console.log(
  "PASS v2.28-E0 task-causal shadow contract",
);
'''

proc = subprocess.run(
    [
        "node",
        "--input-type=module",
    ],
    cwd=ROOT,
    input=js,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)

if proc.stdout:
    print(
        proc.stdout,
        end="",
    )

if proc.returncode != 0:
    if proc.stderr:
        print(
            proc.stderr,
            end="",
        )

    raise SystemExit(
        proc.returncode
    )


# ------------------------------------------------------------
# Production integration contract.
# ------------------------------------------------------------

required = (
    'from "./cpu-search-core/resource-adapter-bridge-v1.mjs"',
    'from "./cpu-search-core/task-anchor-v1.mjs"',
    'from "./cpu-search-core/task-causal-shadow-v1.mjs"',
    "state.taskAnchors = taskAnchors",
    "state.resourceAdapterEdges = new Map()",
    "const resourceRouting =",
    "const taskCausalShadow =",
    "resource_adapter_bridge_protocol:",
    "task_causal_shadow_protocol:",
)

for marker in required:
    assert marker in PLUGIN, marker


# ------------------------------------------------------------
# Shadow must not feed route ledger or progress.
# ------------------------------------------------------------

for forbidden in (
    "for (const fact of resourceRouting.routeFacts)",
    "resourceRouting.validatedEdges > 0",
):
    assert forbidden not in PLUGIN, forbidden


framework_pos = PLUGIN.index(
    "for (const fact of frameworkRouting.routeFacts)"
)

ledger_pos = PLUGIN.index(
    "const ledgerFactsBefore = state?.evidenceLedger?.size ?? 0",
    framework_pos,
)

novelty_pos = PLUGIN.index(
    "const novelty = novelEvidenceFacts(state, finalFacts)",
    ledger_pos,
)

assert (
    framework_pos
    < ledger_pos
    < novelty_pos
)

assert (
    "resourceRouting"
    not in
    PLUGIN[
        framework_pos:
        ledger_pos
    ]
)


progress_start = PLUGIN.index(
    "const meaningfulRouteProgress =",
    novelty_pos,
)

progress_end = PLUGIN.index(
    "const novelFactStats =",
    progress_start,
)

progress = PLUGIN[
    progress_start:
    progress_end
]

assert (
    "frameworkRouting.validatedEdges > 0"
    in progress
)

assert (
    "resourceRouting.validatedEdges"
    not in progress
)

print(
    "PASS E0 runtime shadow cannot alter Scout route ledger or progress"
)


# ------------------------------------------------------------
# Shadow helper cannot grant authority.
# ------------------------------------------------------------

shadow_start = PLUGIN.index(
    "function taskCausalShadowForState("
)

shadow_end = PLUGIN.index(
    "function scoutEvidenceWitnesses(",
    shadow_start,
)

shadow_block = PLUGIN[
    shadow_start:
    shadow_end
]

for forbidden in (
    "taskRoleEvidence",
    "decideLocalization",
    "classifyEvidenceAuthority",
    "makeTieredRoleEvidence",
    "solveObligationCoverage",
    "mutationReady",
    "mutation_ready",
):
    assert forbidden not in shadow_block, forbidden

print(
    "PASS E0 runtime remains observation-only"
)


# ------------------------------------------------------------
# Installer runtime dependency closure.
# ------------------------------------------------------------

for rel in (
    "resource-adapter-v1.mjs",
    "generic-html-js-adapter-v1.mjs",
    "react-jsx-router-adapter-v1.mjs",
    "vue-sfc-adapter-v1.mjs",
    "sql-resource-adapter-v1.mjs",
    "resource-adapter-bridge-v1.mjs",
    "task-anchor-v1.mjs",
    "task-causal-shadow-v1.mjs",
):
    assert (
        f'"cpu-search-core/{rel}"'
        in INSTALL
    ), rel

print(
    "PASS E0 installer contains runtime dependency closure"
)


# ------------------------------------------------------------
# Genericity.
# ------------------------------------------------------------

for name in (
    "task-anchor-v1.mjs",
    "task-causal-shadow-v1.mjs",
):
    body = (
        CORE / name
    ).read_text(
        encoding="utf-8"
    ).lower()

    for forbidden in (
        "ozon",
        "bestsellers",
        "rd_bestsellers_data",
        "templates/snippets/menu.html",
    ):
        assert forbidden not in body, (
            name,
            forbidden,
        )

print(
    "PASS repository-neutral E0 production modules"
)
