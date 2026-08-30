#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

js = r"""
import assert from "node:assert/strict";

import {
  hostResourceClosureSummary,
} from "./opencode/plugins/cpu-search-core/host-resource-closure-v2.mjs";

import {
  projectAnchoredHostObligationProofs,
} from "./opencode/plugins/cpu-search-core/host-obligation-projector-v1.mjs";

import {
  mergeTaskRoleEvidence,
  projectTaskBoundObligationProofs,
} from "./opencode/plugins/cpu-search-core/task-bound-obligation-evidence-v1.mjs";

import {
  EVIDENCE_BASIS,
  makeTieredRoleEvidence,
} from "./opencode/plugins/cpu-search-core/evidence-tier-v1.mjs";

import {
  solveObligationCoverage,
} from "./opencode/plugins/cpu-search-core/obligation-coverage-v1.mjs";


const sha =
  "a".repeat(64);

function witness(
  file,
  line,
) {
  return {
    file,
    sha256:
      "b".repeat(64),
    line,
    extractor:
      "fixture",
  };
}


/*
 * ===========================================================
 * E1.5a
 * Correct positive obligation wiring must produce the
 * structural role set from existing closure signals.
 * ===========================================================
 */

const closureSummary =
  hostResourceClosureSummary({
    context: {
      protected_surface: {
        structural_ready:
          true,
      },

      ui_candidate: {
        structural_ready:
          true,
      },

      navigation_candidate: {
        structural_ready:
          true,
      },
    },

    baselineHostIntegrationShadow: {
      bindings: {
        data_access_capability: {
          structural_ready:
            true,
        },
      },
    },

    positiveObligations: [
      "data_access_capability",
      "navigation_host",
      "ui_host",
    ],
  });

assert.deepEqual(
  closureSummary
    .structurally_ready,
  [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
);

assert.deepEqual(
  closureSummary
    .structurally_missing,
  [],
);

console.log(
  "PASS E1.5a positive obligation wiring reaches HostResourceClosure summary",
);


/*
 * ===========================================================
 * E1.5b
 * First relation-driven host producer.
 * ===========================================================
 */

const taskRequirements = {
  status:
    "compiled",

  task_sha256:
    sha,

  required_roles: [
    "ui_surface",
    "navigation",
    "data_access",
    "input_validation",
    "output_artifact",
  ],
};

const plan = {
  status:
    "planned",

  task_sha256:
    sha,

  positive_localization_obligations: [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],

  positive_coverage_requirements: {
    status:
      "compiled",

    task_sha256:
      sha,

    required_roles: [
      "data_access_capability",
      "navigation_host",
      "ui_host",
    ],
  },
};

const anchorFrontier = {
  status:
    "bound",

  route_anchor:
    "/legacy-export",

  owner:
    "file:routes/report.py",
};

const hostClosure = {
  protected_surface: {
    structural_ready:
      true,

    route_anchor:
      "/legacy-export",

    owner:
      "file:routes/report.py",
  },

  ui_candidate: {
    structural_ready:
      true,

    owner:
      "file:routes/report.py",

    resource:
      "template:report.html",
  },

  navigation_candidate: {
    structural_ready:
      true,

    resource:
      "template:shared/nav.html",
  },
};

const frameworkEdges = [
  {
    validated:
      true,

    from:
      "file:routes/report.py",

    to:
      "route:/legacy-export",

    kind:
      "declares_route",

    witness:
      witness(
        "routes/report.py",
        10,
      ),
  },

  {
    validated:
      true,

    from:
      "file:routes/report.py",

    to:
      "template:report.html",

    kind:
      "renders_resource",

    witness:
      witness(
        "routes/report.py",
        20,
      ),
  },

  {
    validated:
      true,

    from:
      "template:templates/report.html",

    to:
      "template:shared/nav.html",

    kind:
      "includes_resource",

    witness:
      witness(
        "templates/report.html",
        7,
      ),
  },
];

const aliases = [
  {
    logical_node:
      "template:report.html",

    physical_node:
      "template:templates/report.html",
  },
];

const hostProjection =
  projectAnchoredHostObligationProofs({
    taskRequirements,
    additiveLocalizationPlan:
      plan,
    anchorFrontier,
    hostResourceClosure:
      hostClosure,
    frameworkEdges,
    aliases,
  });

assert.deepEqual(
  hostProjection
    .proofs
    .map(
      (item) =>
        item.obligation,
    )
    .sort(),
  [
    "navigation_host",
    "ui_host",
  ],
);

assert.equal(
  hostProjection
    .localization_authority,
  false,
);

assert.equal(
  hostProjection
    .mutation_authority,
  false,
);

console.log(
  "PASS first host producer emits proof descriptors without authority",
);


/*
 * Generic authority conversion.
 */

const projected =
  projectTaskBoundObligationProofs({
    coverageRequirements:
      plan
        .positive_coverage_requirements,

    taskSha256:
      sha,

    proofs:
      hostProjection.proofs,
  });

assert.deepEqual(
  projected
    .evidence
    .map(
      (item) =>
        item.role,
    ),
  [
    "navigation_host",
    "ui_host",
  ],
);

assert(
  projected.evidence.every(
    (item) =>
      item.tier === "B" &&
      item.validated === true &&
      item.localization_authority ===
        true &&
      item.mutation_authority ===
        false,
  ),
);

console.log(
  "PASS producer-certified task paths become Tier B localization evidence only",
);


/*
 * Generic Impact remains Tier D and must not enter
 * the authoritative task-role channel.
 */

const impactProjection =
  projectTaskBoundObligationProofs({
    coverageRequirements:
      plan
        .positive_coverage_requirements,

    taskSha256:
      sha,

    proofs: [{
      obligation:
        "data_access_capability",

      basis:
        EVIDENCE_BASIS
          .GENERIC_IMPACT,

      source_proof:
        witness(
          "routes/report.py",
          30,
        ),

      causal_path:
        [],
    }],
  });

assert.equal(
  impactProjection
    .evidence
    .length,
  0,
);

assert(
  impactProjection
    .rejected
    .some(
      (item) =>
        item.reason ===
        "tier_has_no_coverage_authority",
    ),
);

console.log(
  "PASS generic Impact cannot acquire localization coverage authority",
);


/*
 * Unsupported/wrong host path abstains.
 */

const wrongOwner =
  projectAnchoredHostObligationProofs({
    taskRequirements,
    additiveLocalizationPlan:
      plan,

    anchorFrontier: {
      ...anchorFrontier,
      owner:
        "file:routes/other.py",
    },

    hostResourceClosure:
      hostClosure,

    frameworkEdges,
    aliases,
  });

assert.equal(
  wrongOwner
    .proofs
    .length,
  0,
);

console.log(
  "PASS host projector fails closed when exact task owner does not match",
);


/*
 * ===========================================================
 * E1.5c
 * Merge is additive, deterministic and ambiguity-safe.
 * ===========================================================
 */

const extraProducerEvidence =
  makeTieredRoleEvidence({
    role:
      "data_access_capability",

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .DIRECT_TASK_ANCHOR,

    sourceProof:
      witness(
        "provider.py",
        3,
      ),
  });

const merged =
  mergeTaskRoleEvidence({
    existing: [
      extraProducerEvidence,
    ],

    incoming: [
      ...projected.evidence,
      ...projected.evidence,
    ],

    taskSha256:
      sha,
  });

assert.equal(
  merged.truncated,
  false,
);

assert.deepEqual(
  merged.evidence
    .map(
      (item) =>
        item.role,
    )
    .sort(),
  [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
);

console.log(
  "PASS role evidence merges producers and deduplicates exact proof identity",
);


/*
 * Ambiguous A/B evidence must survive merge so the coverage
 * solver can make ambiguity dominate a positive proof.
 */

const ambiguousNavigation =
  makeTieredRoleEvidence({
    role:
      "navigation_host",

    taskSha256:
      sha,

    basis:
      EVIDENCE_BASIS
        .TASK_CAUSAL_PATH,

    sourceProof:
      witness(
        "routes/report.py",
        10,
      ),

    causalPath: [{
      validated:
        true,

      from:
        "file:routes/report.py",

      to:
        "template:other.html",

      kind:
        "renders_resource",

      witness:
        witness(
          "routes/report.py",
          40,
        ),
    }],

    ambiguous:
      true,
  });

const ambiguousMerged =
  mergeTaskRoleEvidence({
    existing:
      merged.evidence,

    incoming: [
      ambiguousNavigation,
    ],

    taskSha256:
      sha,
  });

const ambiguityCoverage =
  solveObligationCoverage({
    taskRequirements:
      plan
        .positive_coverage_requirements,

    evidence:
      ambiguousMerged
        .evidence,
  });

assert.equal(
  ambiguityCoverage.status,
  "ambiguous",
);

assert(
  ambiguityCoverage
    .ambiguous_roles
    .includes(
      "navigation_host",
    ),
);

assert(
  !ambiguityCoverage
    .covered_roles
    .includes(
      "navigation_host",
    ),
);

console.log(
  "PASS ambiguity survives merge and dominates positive localization evidence",
);


/*
 * Budget overflow must fail closed, not silently drop a
 * possibly ambiguous proof.
 */

const budgeted =
  mergeTaskRoleEvidence({
    existing:
      merged.evidence,

    incoming:
      [],

    taskSha256:
      sha,

    maxItems:
      2,
  });

assert.equal(
  budgeted.truncated,
  true,
);

assert.equal(
  budgeted
    .evidence
    .length,
  0,
);

console.log(
  "PASS task-role evidence budget overflow invalidates coverage fail-closed",
);


/*
 * Correct additive vocabulary:
 * verifier-only result roles cannot block host localization.
 */

const hostOnlyCoverage =
  solveObligationCoverage({
    taskRequirements:
      plan
        .positive_coverage_requirements,

    evidence:
      projected.evidence,
  });

assert.deepEqual(
  hostOnlyCoverage
    .covered_roles,
  [
    "navigation_host",
    "ui_host",
  ],
);

assert.deepEqual(
  hostOnlyCoverage
    .missing_roles,
  [
    "data_access_capability",
  ],
);

assert(
  !hostOnlyCoverage
    .missing_roles
    .includes(
      "input_validation",
    ),
);

assert(
  !hostOnlyCoverage
    .missing_roles
    .includes(
      "output_artifact",
    ),
);

console.log(
  "PASS implementation/verifier roles do not leak into additive host localization",
);


/*
 * Task identity drift fails closed.
 */

const stale =
  projectTaskBoundObligationProofs({
    coverageRequirements:
      plan
        .positive_coverage_requirements,

    taskSha256:
      "c".repeat(64),

    proofs:
      hostProjection.proofs,
  });

assert.equal(
  stale.evidence.length,
  0,
);

console.log(
  "PASS stale task identity cannot promote role evidence",
);

console.log(
  "PASS v2.28-E1.5 task-bound localization layer",
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


cpu = (
    ROOT
    / "opencode/plugins/cpu-search.ts"
).read_text(
    encoding="utf-8"
)

generic = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "task-bound-obligation-evidence-v1.mjs"
).read_text(
    encoding="utf-8"
)

host = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "host-obligation-projector-v1.mjs"
).read_text(
    encoding="utf-8"
)


# Confirm the actual R5a wiring fix.
assert (
    "positive_localization_obligations"
    in cpu
)

assert (
    "?.positive_obligations ??"
    not in cpu
)


# Existing solver remains in the runtime decision path.
for marker in (
    "solveObligationCoverage({",
    "positive_coverage_requirements",
    "mergeTaskRoleEvidence({",
    "projectTaskBoundObligationProofs({",
    "projectAnchoredHostObligationProofs({",
    "localizationCoverage",
):
    assert marker in cpu, marker

import re

assert re.search(
    r"localizationCoverage\s*\.\s*covered_roles",
    cpu,
), "localizationCoverage.covered_roles"

assert re.search(
    r"localizationCoverage\s*\.\s*ambiguous_roles",
    cpu,
), "localizationCoverage.ambiguous_roles"


# No direct overwrite from one producer.
assert (
    "state.taskRoleEvidence =\n"
    "              taskBoundHostEvidence"
    not in cpu
)


# No repository/task fixture specialization in production.
for text, name in (
    (generic, "generic"),
    (host, "host"),
):
    lower = text.lower()

    for forbidden in (
        "ozon",
        "bestsellers",
        "rd_bestsellers_data",
        "snippets/menu.html",
    ):
        assert forbidden not in lower, (
            name,
            forbidden,
        )


# Generic authority ABI must not grant mutation.
assert (
    "mutation_authority:\n      true"
    not in generic
)

assert (
    "mutation_authority:\n      true"
    not in host
)

print(
    "PASS E1.5 production remains repository-neutral"
)

print(
    "PASS LocalizationDecision remains sole localization-authority solver"
)

print(
    "PASS no new mutation authority introduced"
)
