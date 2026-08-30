#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"

js = r'''
import assert from "node:assert/strict";

import {
  ADDITIVE_LOCALIZATION_PLAN_PROTOCOL,
  ADDITIVE_LOCALIZATION_PLAN_AUTHORITY,
  ADDITIVE_TASK_KIND,
  LOCALIZATION_OBLIGATION,
  planAdditiveLocalization,
} from "./opencode/plugins/cpu-search-core/additive-localization-plan-v1.mjs";

import {
  EVIDENCE_BASIS,
  makeTieredRoleEvidence,
} from "./opencode/plugins/cpu-search-core/evidence-tier-v1.mjs";

import {
  solveObligationCoverage,
} from "./opencode/plugins/cpu-search-core/obligation-coverage-v1.mjs";

const sha = "a".repeat(64);

function proof(
  file,
  line = 1,
) {
  return {
    file,
    sha256:
      "b".repeat(64),
    line,
    extractor:
      "v2.28-e1-fixture",
  };
}

// ------------------------------------------------------------
// 1. Additive task:
// desired result roles MUST NOT become pre-existing
// localization requirements with identical names.
// ------------------------------------------------------------

const requirements = {
  status:
    "compiled",

  task_sha256:
    sha,

  required_roles: [
    "ui_surface",
    "navigation",
    "data_access",
    "output_artifact",
    "input_validation",
    "preserve_behavior",
  ],
};

const before =
  JSON.stringify(
    requirements,
  );

const plan =
  planAdditiveLocalization({
    taskRequirements:
      requirements,

    taskKind:
      ADDITIVE_TASK_KIND,
  });

assert.equal(
  plan.protocol,
  ADDITIVE_LOCALIZATION_PLAN_PROTOCOL,
);

assert.equal(
  plan.authority,
  ADDITIVE_LOCALIZATION_PLAN_AUTHORITY,
);

assert.equal(
  plan.status,
  "planned",
);

assert.equal(
  plan.localization_authority,
  false,
);

assert.equal(
  plan.mutation_authority,
  false,
);

assert.deepEqual(
  plan.positive_localization_obligations,
  [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
);

assert.deepEqual(
  plan.positive_localization_bindings,
  [
    {
      source_role:
        "data_access",
      obligation:
        "data_access_capability",
    },
    {
      source_role:
        "navigation",
      obligation:
        "navigation_host",
    },
    {
      source_role:
        "ui_surface",
      obligation:
        "ui_host",
    },
  ],
);

assert.deepEqual(
  plan.protected_surface_obligations,
  [
    "protected_surface",
  ],
);

assert.deepEqual(
  plan.protected_surface_bindings,
  [{
    source_role:
      "preserve_behavior",
    obligation:
      "protected_surface",
  }],
);

assert.deepEqual(
  plan.implementation_verification_roles,
  [
    "input_validation",
    "output_artifact",
  ],
);

assert.deepEqual(
  plan.policy_roles,
  [],
);

assert.deepEqual(
  plan.positive_localization_source_families,
  [
    "client_code",
    "data_query",
    "server_code",
    "ui_resource",
  ],
);

assert.deepEqual(
  plan.protected_surface_source_families,
  [
    "client_code",
    "server_code",
    "ui_resource",
  ],
);

assert.equal(
  JSON.stringify(
    requirements,
  ),
  before,
);

console.log(
  "PASS additive result roles project to distinct pre-existing host obligations",
);

// ------------------------------------------------------------
// 2. Existing coverage solver works unchanged with the
// internal host-obligation vocabulary.
// ------------------------------------------------------------

const hostEvidence = [
  makeTieredRoleEvidence({
    role:
      LOCALIZATION_OBLIGATION.UI_HOST,

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .DIRECT_TASK_ANCHOR,

    sourceProof:
      proof(
        "templates/base.html",
        10,
      ),
  }),

  makeTieredRoleEvidence({
    role:
      LOCALIZATION_OBLIGATION.NAVIGATION_HOST,

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .TASK_CAUSAL_PATH,

    sourceProof:
      proof(
        "templates/nav.html",
        20,
      ),

    causalPath: [{
      validated: true,
      from:
        "resource:base.html",
      to:
        "resource:nav.html",
      kind:
        "includes_resource",
      witness:
        proof(
          "templates/base.html",
          11,
        ),
    }],
  }),

  makeTieredRoleEvidence({
    role:
      LOCALIZATION_OBLIGATION
        .DATA_ACCESS_CAPABILITY,

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .DIRECT_TASK_ANCHOR,

    sourceProof:
      proof(
        "db/connection.py",
        30,
      ),
  }),
];

assert(
  hostEvidence.every(
    Boolean,
  ),
);

const hostCoverage =
  solveObligationCoverage({
    taskRequirements:
      plan
        .positive_coverage_requirements,

    evidence:
      hostEvidence,
  });

assert.equal(
  hostCoverage.status,
  "covered",
);

assert.deepEqual(
  hostCoverage.covered_roles,
  [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
);

console.log(
  "PASS existing coverage solver accepts distinct host obligation vocabulary",
);

// ------------------------------------------------------------
// 3. Evidence that the NEW implementation surface already
// exists must NOT accidentally satisfy host localization.
// ------------------------------------------------------------

const implementationNamedEvidence = [
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
        "templates/new-page.html",
        1,
      ),
  }),

  makeTieredRoleEvidence({
    role:
      "data_access",

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .DIRECT_TASK_ANCHOR,

    sourceProof:
      proof(
        "new-query.sql",
        1,
      ),
  }),
];

const wrongVocabularyCoverage =
  solveObligationCoverage({
    taskRequirements:
      plan
        .positive_coverage_requirements,

    evidence:
      implementationNamedEvidence,
  });

assert.equal(
  wrongVocabularyCoverage.status,
  "insufficient",
);

assert.deepEqual(
  wrongVocabularyCoverage.covered_roles,
  [],
);

assert.deepEqual(
  wrongVocabularyCoverage.missing_roles,
  [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
);

console.log(
  "PASS implementation-role evidence cannot masquerade as additive host evidence",
);

// ------------------------------------------------------------
// 4. Raw TaskRequirements coverage is intentionally a
// different question.
// ------------------------------------------------------------

const rawCoverage =
  solveObligationCoverage({
    taskRequirements:
      requirements,

    evidence:
      hostEvidence,
  });

assert.equal(
  rawCoverage.status,
  "insufficient",
);

assert.deepEqual(
  rawCoverage.covered_roles,
  [],
);

assert.deepEqual(
  rawCoverage.missing_roles,
  [
    "data_access",
    "input_validation",
    "navigation",
    "output_artifact",
    "preserve_behavior",
    "ui_surface",
  ],
);

console.log(
  "PASS TaskRequirements result obligations remain separate from host localization",
);

// ------------------------------------------------------------
// 5. Explicit endpoint example.
//
// A task asking to CREATE an endpoint requires an existing
// server host, NOT a pre-existing copy of the requested endpoint.
// ------------------------------------------------------------

const endpointPlan =
  planAdditiveLocalization({
    taskRequirements: {
      status:
        "compiled",

      task_sha256:
        "c".repeat(64),

      required_roles: [
        "server_endpoint",
      ],
    },

    taskKind:
      ADDITIVE_TASK_KIND,
  });

assert.deepEqual(
  endpointPlan
    .positive_localization_obligations,
  [
    "server_host",
  ],
);

assert.deepEqual(
  endpointPlan
    .positive_coverage_requirements
    .required_roles,
  [
    "server_host",
  ],
);

assert(
  !endpointPlan
    .positive_coverage_requirements
    .required_roles
    .includes(
      "server_endpoint",
    ),
);

console.log(
  "PASS new endpoint requires server host rather than pre-existing endpoint",
);

// ------------------------------------------------------------
// 6. Full role vocabulary partition.
// ------------------------------------------------------------

const allRoles = [
  "server_endpoint",
  "ui_surface",
  "navigation",
  "data_access",
  "data_schema",
  "output_artifact",
  "input_validation",
  "preserve_behavior",
  "test_surface",
  "configuration",
  "dependency_policy",
];

const full =
  planAdditiveLocalization({
    taskRequirements: {
      status:
        "compiled",

      task_sha256:
        "d".repeat(64),

      required_roles:
        allRoles,
    },

    taskKind:
      ADDITIVE_TASK_KIND,
  });

assert.deepEqual(
  full.positive_localization_obligations,
  [
    "data_access_capability",
    "navigation_host",
    "server_host",
    "ui_host",
  ],
);

assert.deepEqual(
  full.protected_surface_obligations,
  [
    "protected_surface",
  ],
);

assert.deepEqual(
  full.implementation_verification_roles,
  [
    "configuration",
    "data_schema",
    "input_validation",
    "output_artifact",
    "test_surface",
  ],
);

assert.deepEqual(
  full.policy_roles,
  [
    "dependency_policy",
  ],
);

const accountedSourceRoles =
  new Set([
    ...full
      .positive_localization_bindings
      .map(
        (x) =>
          x.source_role,
      ),

    ...full
      .protected_surface_bindings
      .map(
        (x) =>
          x.source_role,
      ),

    ...full
      .implementation_verification_roles,

    ...full
      .policy_roles,
  ]);

assert.deepEqual(
  [...accountedSourceRoles].sort(),
  [...allRoles].sort(),
);

console.log(
  "PASS additive TaskRequirements vocabulary maps to complete non-overlapping semantics",
);

// ------------------------------------------------------------
// 7. Unknown task shape fails closed.
// ------------------------------------------------------------

const wrongShape =
  planAdditiveLocalization({
    taskRequirements:
      requirements,

    taskKind:
      "modify_existing",
  });

assert.equal(
  wrongShape.status,
  "unresolved",
);

assert.equal(
  wrongShape.reason,
  "task_kind_not_explicit_additive",
);

assert.equal(
  wrongShape
    .positive_coverage_requirements,
  null,
);

console.log(
  "PASS additive localization cannot be inferred from TaskRequirements roles",
);

// ------------------------------------------------------------
// 8. Future unknown roles fail closed.
// ------------------------------------------------------------

const future =
  planAdditiveLocalization({
    taskRequirements: {
      status:
        "compiled",

      task_sha256:
        "e".repeat(64),

      required_roles: [
        "ui_surface",
        "future_unknown_role",
      ],
    },

    taskKind:
      ADDITIVE_TASK_KIND,
  });

assert.equal(
  future.status,
  "unresolved",
);

assert.equal(
  future.reason,
  "unknown_required_role",
);

assert.deepEqual(
  future.unknown_roles,
  [
    "future_unknown_role",
  ],
);

assert.equal(
  future
    .positive_coverage_requirements,
  null,
);

console.log(
  "PASS unknown additive obligation roles fail closed",
);

console.log(
  "PASS v2.28-E1 additive host-localization semantic contract",
);
'''

cp = subprocess.run(
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


module = (
    CORE
    / "additive-localization-plan-v1.mjs"
).read_text(
    encoding="utf-8"
)

lower = module.lower()

for forbidden in (
    "ozon",
    "bestsellers",
    "rd_bestsellers_data",
    "templates/snippets/menu.html",
):
    assert forbidden not in lower, forbidden

for forbidden in (
    "mutation_authority: true",
    "localization_authority: true",
    "taskroleevidence",
    "executepatch",
):
    assert forbidden not in lower, forbidden


# Foundation-only:
# runtime must not consume this before deterministic task-shape proof.
plugin = PLUGIN.read_text(
    encoding="utf-8"
)



print(
  "PASS E1 host-localization model remains repository-neutral and non-authoritative"
)
