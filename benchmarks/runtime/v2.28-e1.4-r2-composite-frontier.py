#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

JS = r'''
import assert from "node:assert/strict";

import {
  resolveAnchorFrontier,
} from "./opencode/plugins/cpu-search-core/anchor-resolution-frontier-v1.mjs";

import {
  mergeHostAliases,
  resolveHostAliasesForNodes,
  resolveHostClosureContext,
} from "./opencode/plugins/cpu-search-core/host-resource-closure-v2.mjs";


function witness(
  file,
  line,
) {
  return {
    file,
    sha256:
      "a".repeat(64),

    line,
    extractor:
      "e1.4-r2-fixture",
  };
}


function edge(
  from,
  to,
  kind,
  file,
  line,
) {
  return {
    validated: true,

    from,
    to,
    kind,

    confidence: 1,

    witness:
      witness(
        file,
        line,
      ),
  };
}


const taskAnchors = {
  protocol:
    "task-anchor-v1",

  anchors: [
    {
      kind:
        "route_literal",

      value:
        "/legacy-export",
    },
  ],
};


/*
 * Model-selected files intentionally MISS the real owner.
 *
 * Anchor frontier must not depend on this set.
 */
const selectedFiles = [
  "routes/unrelated.py",
  "templates/unrelated.html",
];

assert(
  !selectedFiles.includes(
    "routes/report.py",
  ),
);


const rawEdges = [
  edge(
    "file:routes/report.py",
    "route:/legacy-export",
    "declares_route",
    "routes/report.py",
    10,
  ),

  edge(
    "file:routes/report.py",
    "template:report.html",
    "renders_resource",
    "routes/report.py",
    20,
  ),

  /*
   * Physical template source differs from logical render target.
   */
  edge(
    "template:templates/report.html",
    "template:shared/nav.html",
    "includes_resource",
    "templates/report.html",
    5,
  ),

  /*
   * Second includer proves shared navigation topology.
   */
  edge(
    "template:templates/home.html",
    "template:shared/nav.html",
    "includes_resource",
    "templates/home.html",
    5,
  ),

  edge(
    "template:templates/shared/nav.html",
    "route:home.index",
    "targets_route",
    "templates/shared/nav.html",
    10,
  ),

  edge(
    "template:templates/shared/nav.html",
    "route:report.index",
    "targets_route",
    "templates/shared/nav.html",
    11,
  ),
];


const immutableBefore =
  JSON.stringify(
    rawEdges,
  );


const frontier =
  resolveAnchorFrontier({
    taskAnchors,

    candidateFiles: [
      "routes/report.py",
    ],

    searchComplete:
      true,

    searchTruncated:
      false,

    inspectionTruncated:
      false,

    frameworkEdges:
      rawEdges,
  });


assert.equal(
  frontier.status,
  "bound",
);

assert.equal(
  frontier.owner,
  "file:routes/report.py",
);

assert.equal(
  frontier.owner_file,
  "routes/report.py",
);

console.log(
  "PASS exact anchor frontier resolves owner independent of selected_files",
);


const observedFiles = [
  "routes/report.py",
  "routes/unrelated.py",
  "templates/report.html",
  "templates/home.html",
  "templates/shared/nav.html",
  "templates/unrelated.html",
];


const noAliasContext =
  resolveHostClosureContext({
    anchorFrontier:
      frontier,

    frameworkEdges:
      rawEdges,

    aliases: [],
  });


assert.equal(
  noAliasContext
    .protected_surface
    .structural_ready,
  true,
);

assert.equal(
  noAliasContext
    .ui_candidate
    .resource,
  "template:report.html",
);

assert.equal(
  noAliasContext
    .ui_candidate
    .structural_ready,
  false,
);

console.log(
  "PASS logical UI host observed before physical alias resolution",
);


const uiResolution =
  resolveHostAliasesForNodes({
    nodes: [
      noAliasContext
        .ui_candidate
        .resource,
    ],

    observedFiles,

    inventoryComplete:
      true,
  });


assert.equal(
  uiResolution.status,
  "resolved",
);

assert.equal(
  uiResolution.aliases.length,
  1,
);

assert.equal(
  uiResolution.aliases[0]
    .logical_node,
  "template:report.html",
);

assert.equal(
  uiResolution.aliases[0]
    .physical_node,
  "template:templates/report.html",
);

assert.equal(
  uiResolution.aliases[0]
    .physical_file,
  "templates/report.html",
);

console.log(
  "PASS inventory-backed resolver creates immutable UI AliasView",
);


const midContext =
  resolveHostClosureContext({
    anchorFrontier:
      frontier,

    frameworkEdges:
      rawEdges,

    aliases:
      uiResolution.aliases,
  });


assert.equal(
  midContext
    .ui_candidate
    .structural_ready,
  true,
);

assert.deepEqual(
  midContext
    .navigation_include_candidates,
  [
    "template:shared/nav.html",
  ],
);

console.log(
  "PASS alias-aware HostView exposes included resource without rewriting edge",
);


const navResolution =
  resolveHostAliasesForNodes({
    nodes:
      midContext
        .navigation_include_candidates,

    sourcePath:
      "templates/report.html",

    observedFiles,

    inventoryComplete:
      true,
  });


assert.equal(
  navResolution.status,
  "resolved",
);

assert.equal(
  navResolution.aliases[0]
    .physical_file,
  "templates/shared/nav.html",
);


const aliases =
  mergeHostAliases(
    uiResolution.aliases,
    navResolution.aliases,
  );


const finalContext =
  resolveHostClosureContext({
    anchorFrontier:
      frontier,

    frameworkEdges:
      rawEdges,

    aliases,
  });


assert.equal(
  finalContext
    .navigation_candidate
    .resource,
  "template:shared/nav.html",
);

assert.equal(
  finalContext
    .navigation_candidate
    .structural_ready,
  true,
);

assert.equal(
  finalContext
    .navigation_candidate
    .semantic_ready,
  false,
);

console.log(
  "PASS bounded resource closure reconstructs shared navigation topology",
);


/*
 * Critical proof immutability invariant.
 *
 * Alias-aware lookup projected meaning but never changed the
 * original validated observation.
 */
const immutableAfter =
  JSON.stringify(
    rawEdges,
  );

assert.equal(
  immutableAfter,
  immutableBefore,
);

console.log(
  "PASS validated ResourceEdges remain byte-for-byte logically immutable",
);


/*
 * Competing exact route owners must fail closed.
 */
const ambiguous =
  resolveAnchorFrontier({
    taskAnchors,

    candidateFiles: [
      "routes/report.py",
      "routes/legacy.py",
    ],

    searchComplete:
      true,

    searchTruncated:
      false,

    inspectionTruncated:
      false,

    frameworkEdges: [
      ...rawEdges,

      edge(
        "file:routes/legacy.py",
        "route:/legacy-export",
        "declares_route",
        "routes/legacy.py",
        3,
      ),
    ],
  });


assert.equal(
  ambiguous.status,
  "ambiguous",
);

assert.equal(
  ambiguous.owner,
  null,
);

console.log(
  "PASS competing exact route owners fail closed",
);


/*
 * A truncated exact search cannot claim uniqueness even when the
 * currently observed edge set happens to contain one owner.
 */
const truncated =
  resolveAnchorFrontier({
    taskAnchors,

    candidateFiles: [
      "routes/report.py",
    ],

    searchComplete:
      false,

    searchTruncated:
      true,

    inspectionTruncated:
      false,

    frameworkEdges:
      rawEdges,
  });


assert.equal(
  truncated.status,
  "incomplete",
);

assert.equal(
  truncated.owner,
  null,
);

console.log(
  "PASS truncated anchor frontier cannot claim unique owner",
);


/*
 * Resource ambiguity must also fail closed.
 */
const ambiguousResource =
  resolveHostAliasesForNodes({
    nodes: [
      "template:report.html",
    ],

    observedFiles: [
      "templates/report.html",
      "views/report.html",
    ],

    inventoryComplete:
      true,
  });


assert.equal(
  ambiguousResource.status,
  "ambiguous",
);

assert.equal(
  ambiguousResource.aliases.length,
  0,
);

console.log(
  "PASS ambiguous logical resource identity fails closed",
);


for (
  const observation of [
    frontier,
    uiResolution,
    navResolution,
    finalContext,
  ]
) {
  assert.equal(
    observation
      .localization_authority,
    false,
  );

  assert.equal(
    observation
      .mutation_authority,
    false,
  );
}

console.log(
  "PASS E1.4-R2 composite remains shadow-only",
);

console.log(
  "PASS v2.28-E1.4-R2 deterministic anchor + immutable alias + bounded closure",
);
'''

cp = subprocess.run(
    [
        "node",
        "--input-type=module",
    ],
    cwd=ROOT,
    input=JS,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)

if cp.stdout:
    print(
        cp.stdout,
        end="",
    )

if cp.returncode:
    if cp.stderr:
        print(
            cp.stderr,
            end="",
        )

    raise SystemExit(
        cp.returncode
    )


for name in (
    "anchor-resolution-frontier-v1.mjs",
    "host-resource-closure-v2.mjs",
):
    body = (
        ROOT
        / "opencode/plugins/cpu-search-core"
        / name
    ).read_text(
        encoding="utf-8",
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

    for forbidden in (
        "taskroleevidence",
        "solveobligationcoverage",
        "decidelocalization",
        "mutation_authority: true",
        "localization_authority: true",
    ):
        assert forbidden not in body, (
            name,
            forbidden,
        )

print(
    "PASS repository-neutral and authority-free E1.4-R2 production"
)
