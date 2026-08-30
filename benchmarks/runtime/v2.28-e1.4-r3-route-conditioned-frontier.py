#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"

js = r"""
import assert from "node:assert/strict";

import {
  inspectFrameworkResourceFile,
} from "./opencode/plugins/cpu-search-core/framework-resource-bridge-v1.mjs";

import {
  RESOURCE_EDGE_KIND,
} from "./opencode/plugins/cpu-search-core/resource-graph-v1.mjs";


const noise = Array.from(
  { length: 40 },
  (_, i) => `
@bp.route("/noise-${i}")
def noise_${i}():
    return "${i}"
`,
).join("\\n");

const source = `
from flask import Blueprint
bp = Blueprint("x", __name__)

${noise}

@bp.route("/protected")
def protected():
    return "ok"
`;


/*
 * Baseline whole-file routing is still bounded and therefore
 * correctly reports truncation.
 */
const generic =
  inspectFrameworkResourceFile({
    sourcePath: "routes/noisy.py",
    text: source,
    maxWitnesses: 8,
    maxEdges: 4,
  });

assert.equal(
  generic.truncated,
  true,
);


/*
 * Exact-route proof is relation-conditioned before bounding.
 * Unrelated routes cannot poison completeness.
 */
const targeted =
  inspectFrameworkResourceFile({
    sourcePath: "routes/noisy.py",
    text: source,
    maxWitnesses: 8,
    maxEdges: 4,
    routeTargets: ["/protected"],
  });

assert.equal(
  targeted.truncated,
  false,
);

assert.equal(
  targeted.resource_edges.length,
  1,
);

assert.equal(
  targeted.resource_edges[0].kind,
  RESOURCE_EDGE_KIND.DECLARES_ROUTE,
);

assert.equal(
  targeted.resource_edges[0].to,
  "route:/protected",
);

console.log(
  "PASS exact route proof ignores unrelated whole-file edge pressure",
);


/*
 * Absence is also relation-conditioned:
 * a noisy file with no matching declaration can be completely
 * inspected for this specific route relation.
 */
const absent =
  inspectFrameworkResourceFile({
    sourcePath: "routes/noisy.py",
    text: `
from flask import Blueprint
bp = Blueprint("x", __name__)
${noise}
`,
    maxWitnesses: 1,
    maxEdges: 1,
    routeTargets: ["/protected"],
  });

assert.equal(
  absent.truncated,
  false,
);

assert.equal(
  absent.resource_edges.length,
  0,
);

console.log(
  "PASS exact route absence is not poisoned by unrelated routes",
);


/*
 * Relevant ambiguity still fails bounded completeness.
 */
const competing = `
from flask import Blueprint
bp = Blueprint("x", __name__)

@bp.route("/protected")
def one():
    return "1"

@bp.route("/protected")
def two():
    return "2"
`;

const competingResult =
  inspectFrameworkResourceFile({
    sourcePath: "routes/competing.py",
    text: competing,
    maxEdges: 1,
    routeTargets: ["/protected"],
  });

assert.equal(
  competingResult.truncated,
  true,
);

console.log(
  "PASS relevant route-edge cap still fails closed",
);
"""

cp = subprocess.run(
    ["node", "--input-type=module"],
    cwd=ROOT,
    input=js,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)

if cp.stdout:
    print(cp.stdout, end="")

if cp.returncode != 0:
    if cp.stderr:
        print(cp.stderr, end="")
    raise SystemExit(cp.returncode)


adapter = (
    CORE / "framework-adapter-v1.mjs"
).read_text(encoding="utf-8")

bridge = (
    CORE / "framework-resource-bridge-v1.mjs"
).read_text(encoding="utf-8")

plugin = PLUGIN.read_text(encoding="utf-8")

for marker in (
    "edgeCandidateFilter = null",
    "relevantEdgeCandidates",
    "truncateOnWitnesses = true",
):
    assert marker in adapter, marker

for marker in (
    "routeTargets = null",
    "routeTargetSet",
    "edgeCandidateFilter",
    "relationScoped",
):
    assert marker in bridge, marker

for marker in (
    "routeTargets:",
    "anchorFrontierDiscovery",
    "skippedFiles",
    "filesScanned",
):
    assert marker in plugin, marker


# Production stays repository-neutral.
for path in (
    CORE / "framework-adapter-v1.mjs",
    CORE / "framework-resource-bridge-v1.mjs",
):
    body = path.read_text(
        encoding="utf-8"
    ).lower()

    for forbidden in (
        "ozon",
        "bestsellers",
        "rd_bestsellers_data",
        "templates/snippets/menu.html",
    ):
        assert forbidden not in body, (
            path.name,
            forbidden,
        )


print(
    "PASS route-conditioned completeness remains repository-neutral",
)
print(
    "PASS v2.28-E1.4-R3 exact-route proof completeness",
)
