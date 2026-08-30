#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

js = r"""
import assert from "node:assert/strict";

import {
  inspectFrameworkResourceFile,
} from "./opencode/plugins/cpu-search-core/framework-resource-bridge-v1.mjs";


const noise = Array.from(
  { length: 40 },
  (_, i) => `
{% include "fragments/noise-${i}.html" %}
`,
).join("\\n");

const source = `
${noise}
{% include "fragments/shared-nav.html" %}
`;


/*
 * Generic whole-file inspection remains bounded.
 */
const generic =
  inspectFrameworkResourceFile({
    sourcePath: "templates/page.html",
    text: source,
    maxWitnesses: 8,
    maxEdges: 4,
  });

assert.equal(
  generic.truncated,
  true,
);


/*
 * Target-conditioned include proof filters before cap.
 */
const targeted =
  inspectFrameworkResourceFile({
    sourcePath: "templates/page.html",
    text: source,
    maxWitnesses: 8,
    maxEdges: 4,
    includeTargets: [
      "fragments/shared-nav.html",
    ],
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
  "includes_resource",
);

assert.equal(
  targeted.resource_edges[0].to,
  "template:fragments/shared-nav.html",
);

console.log(
  "PASS target-conditioned include proof ignores unrelated include pressure",
);


/*
 * No matching relation is a complete result for the inspected
 * file even when unrelated includes are noisy.
 */
const absent =
  inspectFrameworkResourceFile({
    sourcePath: "templates/page.html",
    text: noise,
    maxWitnesses: 1,
    maxEdges: 1,
    includeTargets: [
      "fragments/shared-nav.html",
    ],
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
  "PASS target-conditioned include absence ignores unrelated relations",
);


/*
 * Multiple relevant matching relations remain bounded/fail-closed.
 */
const competing = `
{% include "fragments/shared-nav.html" %}
{% include "fragments/shared-nav.html" %}
`;

const competingResult =
  inspectFrameworkResourceFile({
    sourcePath: "templates/page.html",
    text: competing,
    maxEdges: 1,
    includeTargets: [
      "fragments/shared-nav.html",
    ],
  });

assert.equal(
  competingResult.truncated,
  true,
);

console.log(
  "PASS relevant include-edge pressure still respects cap",
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

    raise SystemExit(
        cp.returncode
    )


bridge = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "framework-resource-bridge-v1.mjs"
).read_text(
    encoding="utf-8"
)

plugin = (
    ROOT
    / "opencode/plugins/cpu-search.ts"
).read_text(
    encoding="utf-8"
)

for marker in (
    "includeTargets = null",
    '"INCLUDES_TEMPLATE"',
    "includeTargetSet",
    "relationScoped",
):
    assert marker in bridge, marker

for marker in (
    "NAVIGATION_REVERSE_MAX_CANDIDATE_FILES",
    "discoverNavigationReverseIncluderFiles",
    "navigation-reverse-frontier-v1",
    "navigationReverseDiscovery",
    "navigationReverseFramework",
    "includeTargets:",
):
    assert marker in plugin, marker


# Production must remain repository-neutral.

for forbidden in (
    "ozon",
    "bestsellers",
    "rd_bestsellers_data",
    "snippets/menu.html",
):
    assert forbidden not in bridge.lower(), forbidden


# The runtime helper itself must not contain repository-specific
# identifiers either.
for forbidden in (
    "ozon",
    "bestsellers",
    "rd_bestsellers_data",
):
    assert forbidden not in plugin.lower(), forbidden


print(
    "PASS reverse include witness acquisition remains repository-neutral"
)

print(
    "PASS reverse search stays hypothesis-only; parser relation remains evidence"
)

print(
    "PASS v2.28-E1.4-R4 target-conditioned reverse include witnesses"
)
