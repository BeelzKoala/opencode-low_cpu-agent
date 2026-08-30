#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"

js = r'''
import assert from "node:assert/strict";

import {
  inspectResourceAdapterFile,
} from "./opencode/plugins/cpu-search-core/resource-adapter-bridge-v1.mjs";

import {
  EVIDENCE_BASIS,
  EVIDENCE_TIER,
  classifyEvidenceTier,
  makeTieredRoleEvidence,
} from "./opencode/plugins/cpu-search-core/evidence-tier-v1.mjs";

import {
  solveObligationCoverage,
} from "./opencode/plugins/cpu-search-core/obligation-coverage-v1.mjs";

const sha = "a".repeat(64);

function proof(
  file = "routes/report.py",
  line = 10,
) {
  return {
    file,
    sha256: "b".repeat(64),
    line,
    extractor: "fixture",
  };
}

// ------------------------------------------------------------
// D2 bridge
// ------------------------------------------------------------

const html =
  inspectResourceAdapterFile({
    sourcePath:
      "templates/page.html",

    text:
      '<a href="/reports">Reports</a>',
  });

assert.equal(
  html.authority,
  "routing_only",
);

assert.equal(
  html.mutation_authority,
  false,
);

assert(
  html.resource_edges.some(
    (edge) =>
      edge.kind ===
      "targets_route",
  ),
);

const jsFetch =
  inspectResourceAdapterFile({
    sourcePath:
      "src/client.ts",

    text:
      'fetch("/api/reports")',
  });

assert(
  jsFetch.resource_edges.some(
    (edge) =>
      edge.kind ===
      "fetches_route",
  ),
);

const react =
  inspectResourceAdapterFile({
    sourcePath:
      "src/App.tsx",

    text: `
import { Route } from "react-router-dom";
<Route path="/reports" element={<Reports />} />
`,
  });

assert(
  react.resource_edges.some(
    (edge) =>
      edge.kind ===
      "route_to_component",
  ),
);

const sql =
  inspectResourceAdapterFile({
    sourcePath:
      "db/report.sql",

    text:
      "SELECT * FROM reporting.rows;",
  });

assert(
  sql.resource_edges.some(
    (edge) =>
      edge.kind ===
      "reads_data_resource",
  ),
);

for (
  const result of
  [html, jsFetch, react, sql]
) {
  for (
    const edge of
    result.resource_edges
  ) {
    assert.equal(
      edge.validated,
      true,
    );

    assert.equal(
      edge.authority,
      "validated_relation_only",
    );
  }
}

console.log(
  "PASS D1 adapters bridge into typed ResourceGraph without semantic collapse",
);

// ------------------------------------------------------------
// F — tiers
// ------------------------------------------------------------

const direct =
  makeTieredRoleEvidence({
    role:
      "ui_surface",

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .DIRECT_TASK_ANCHOR,

    sourceProof:
      proof(
        "templates/report.html",
        3,
      ),
  });

assert.equal(
  direct.tier,
  EVIDENCE_TIER.A,
);

assert.equal(
  direct.localization_authority,
  true,
);

assert.equal(
  direct.mutation_authority,
  false,
);

const causal =
  makeTieredRoleEvidence({
    role:
      "navigation",

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .TASK_CAUSAL_PATH,

    sourceProof:
      proof(
        "templates/menu.html",
        8,
      ),

    causalPath: [{
      validated: true,
      from:
        "file:routes/report.py",
      to:
        "resource:report.html",
      kind:
        "renders_resource",
      witness:
        proof(
          "routes/report.py",
          12,
        ),
    }],
  });

assert.equal(
  causal.tier,
  EVIDENCE_TIER.B,
);

assert.equal(
  causal.localization_authority,
  true,
);

const lexical =
  makeTieredRoleEvidence({
    role:
      "navigation",
    taskSha256:
      sha,
    basis:
      EVIDENCE_BASIS.LEXICAL,
  });

assert.equal(
  lexical.tier,
  EVIDENCE_TIER.C,
);

assert.equal(
  lexical.localization_authority,
  false,
);

const impact =
  makeTieredRoleEvidence({
    role:
      "data_access",
    taskSha256:
      sha,
    basis:
      EVIDENCE_BASIS.GENERIC_IMPACT,
    sourceProof:
      proof("database.py", 20),
  });

assert.equal(
  impact.tier,
  EVIDENCE_TIER.D,
);

assert.equal(
  impact.localization_authority,
  false,
);

const badCausal =
  classifyEvidenceTier({
    basis:
      EVIDENCE_BASIS
        .TASK_CAUSAL_PATH,

    sourceProof:
      proof(),

    causalPath: [{
      validated: false,
      from: "a",
      to: "b",
      kind: "imports",
      witness: proof(),
    }],
  });

assert.equal(
  badCausal,
  EVIDENCE_TIER.H,
);

console.log(
  "PASS Evidence Tiers enforce A/B localization authority only",
);

// ------------------------------------------------------------
// G — coverage
// ------------------------------------------------------------

const requirements = {
  status: "compiled",
  task_sha256: sha,
  required_roles: [
    "ui_surface",
    "navigation",
    "data_access",
  ],
};

const insufficient =
  solveObligationCoverage({
    taskRequirements:
      requirements,

    evidence: [
      direct,
      lexical,
      impact,
    ],
  });

assert.deepEqual(
  insufficient.covered_roles,
  ["ui_surface"],
);

assert.deepEqual(
  insufficient.missing_roles,
  [
    "data_access",
    "navigation",
  ],
);

assert.equal(
  insufficient.status,
  "insufficient",
);

const dataCausal =
  makeTieredRoleEvidence({
    role:
      "data_access",

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .TASK_CAUSAL_PATH,

    sourceProof:
      proof("report.sql", 5),

    causalPath: [{
      validated: true,
      from:
        "file:report.py",
      to:
        "data_resource:report_rows",
      kind:
        "reads_data_resource",
      witness:
        proof("report.sql", 5),
    }],
  });

const complete =
  solveObligationCoverage({
    taskRequirements:
      requirements,

    evidence: [
      direct,
      causal,
      dataCausal,
    ],
  });

assert.equal(
  complete.status,
  "covered",
);

assert.deepEqual(
  complete.covered_roles,
  [
    "data_access",
    "navigation",
    "ui_surface",
  ],
);

const stale =
  makeTieredRoleEvidence({
    role:
      "ui_surface",

    taskSha256:
      "c".repeat(64),

    basis:
      EVIDENCE_BASIS
        .DIRECT_TASK_ANCHOR,

    sourceProof:
      proof(),
  });

const staleResult =
  solveObligationCoverage({
    taskRequirements:
      requirements,

    evidence:
      [stale],
  });

assert.equal(
  staleResult.covered_roles.length,
  0,
);

assert(
  staleResult.rejected_evidence.some(
    (row) =>
      row.reason ===
      "task_identity_mismatch",
  ),
);

const ambiguousNavigation =
  makeTieredRoleEvidence({
    role:
      "navigation",

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .TASK_CAUSAL_PATH,

    sourceProof:
      proof("menu.html", 8),

    causalPath: [{
      validated: true,
      from:
        "resource:page.html",
      to:
        "route:/reports",
      kind:
        "targets_route",
      witness:
        proof("menu.html", 8),
    }],

    ambiguous: true,
  });

const ambiguity =
  solveObligationCoverage({
    taskRequirements:
      requirements,

    evidence: [
      direct,
      causal,
      dataCausal,
      ambiguousNavigation,
    ],
  });

assert.equal(
  ambiguity.status,
  "ambiguous",
);

assert.deepEqual(
  ambiguity.ambiguous_roles,
  ["navigation"],
);

assert(
  !ambiguity.covered_roles
    .includes("navigation"),
);

console.log(
  "PASS coverage requires task-bound A/B evidence and fails closed on ambiguity",
);

console.log(
  "PASS v2.28-D2/F/G evidence foundation",
);
'''

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

if cp.returncode:
    if cp.stderr:
        print(cp.stderr, end="")
    raise SystemExit(cp.returncode)

for name in (
    "resource-adapter-bridge-v1.mjs",
    "evidence-tier-v1.mjs",
    "obligation-coverage-v1.mjs",
):
    text = (
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
        assert forbidden not in text, (
            name,
            forbidden,
        )

    assert (
        "mutation_authority: true"
        not in text
    )

print(
    "PASS repository-neutral D2/F/G production modules"
)
