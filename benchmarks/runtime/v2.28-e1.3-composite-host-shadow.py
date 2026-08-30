#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

JS = r'''
import assert from "node:assert/strict"

import {
  compileTaskRequirements,
} from "./opencode/plugins/cpu-search-core/task-requirements-v1.mjs"

import {
  compileTaskAnchors,
} from "./opencode/plugins/cpu-search-core/task-anchor-v1.mjs"

import {
  compileTaskShape,
} from "./opencode/plugins/cpu-search-core/task-shape-v1.mjs"

import {
  planAdditiveLocalization,
} from "./opencode/plugins/cpu-search-core/additive-localization-plan-v1.mjs"

import {
  runHostIntegrationShadow,
  buildResourceGraphViews,
} from "./opencode/plugins/cpu-search-core/host-integration-shadow-v1.mjs"


const SHA =
  "a".repeat(64)

const task =
  (
    "Create in the existing product a new report page, " +
    "expose it through navigation, query the database, " +
    "and preserve existing route /legacy-export behavior."
  )

const requirements =
  compileTaskRequirements(
    task,
    SHA,
  )

const anchors =
  compileTaskAnchors(
    task,
    SHA,
  )

const shape =
  compileTaskShape(
    task,
    SHA,
  )

assert.equal(
  shape.shape,
  "additive",
  JSON.stringify(shape),
)

const plan =
  planAdditiveLocalization({
    taskRequirements:
      requirements,

    taskKind:
      shape.shape,
  })


const witness =
  (
    file,
    line,
    extractor = "fixture",
  ) => ({
    file,
    sha256:
      "b".repeat(64),
    line,
    extractor,
  })


const edge =
  (
    from,
    to,
    kind,
    file,
    line,
  ) => ({
    validated:
      true,

    from,
    to,
    kind,

    confidence:
      1,

    witness:
      witness(
        file,
        line,
      ),
  })


const frameworkEdges = [
  /*
   * ProtectionView:
   * exact route owner.
   */
  edge(
    "file:routes/reports.py",
    "route:/legacy-export",
    "declares_route",
    "routes/reports.py",
    10,
  ),

  /*
   * HostView:
   * owner -> UI resource.
   */
  edge(
    "file:routes/reports.py",
    "template:reports/page.html",
    "renders_resource",
    "routes/reports.py",
    20,
  ),

  /*
   * UI -> shared included resource.
   */
  edge(
    "template:reports/page.html",
    "template:shared/navigation.html",
    "includes_resource",
    "templates/reports/page.html",
    5,
  ),

  /*
   * Second includer proves shared topology.
   */
  edge(
    "template:home.html",
    "template:shared/navigation.html",
    "includes_resource",
    "templates/home.html",
    5,
  ),

  /*
   * Multiple internal targets prove navigation topology
   * without depending on filename.
   */
  edge(
    "template:shared/navigation.html",
    "route:home.index",
    "targets_route",
    "templates/shared/navigation.html",
    10,
  ),

  edge(
    "template:shared/navigation.html",
    "route:reports.index",
    "targets_route",
    "templates/shared/navigation.html",
    11,
  ),

  /*
   * Unrelated render must never become reports UI host.
   */
  edge(
    "file:routes/admin.py",
    "template:admin/page.html",
    "renders_resource",
    "routes/admin.py",
    8,
  ),
]


const impactValidated = [
  {
    validated:
      true,

    validationKind:
      "forward_scope_definition",

    file:
      "data/report_store.py",

    displayBindings: [
      "open_report_store",
    ],

    forwardSymbols: [
      "open_report_store",
    ],

    relations: [
      {
        seed:
          "routes/reports.py",

        direction:
          "forward",

        kind:
          "python_from",

        spec:
          "data.report_store",

        bindings: [
          "open_report_store",
        ],

        witness_file:
          "routes/reports.py",

        witness_line:
          3,
      },
    ],
  },

  /*
   * Valid dependency from another owner must be ignored.
   */
  {
    validated:
      true,

    validationKind:
      "forward_scope_definition",

    file:
      "data/admin_store.py",

    forwardSymbols: [
      "open_admin_store",
    ],

    relations: [
      {
        seed:
          "routes/admin.py",

        direction:
          "forward",

        kind:
          "python_from",

        spec:
          "data.admin_store",

        bindings: [
          "open_admin_store",
        ],

        witness_file:
          "routes/admin.py",

        witness_line:
          3,
      },
    ],
  },
]


const observed =
  runHostIntegrationShadow({
    taskRequirements:
      requirements,

    taskAnchors:
      anchors,

    additiveLocalizationPlan:
      plan,

    frameworkEdges,

    impactValidated,

    frameworkTruncated:
      false,

    resourceTruncated:
      false,
  })


assert.equal(
  observed.localization_authority,
  false,
)

assert.equal(
  observed.mutation_authority,
  false,
)

assert.equal(
  observed.obligation_spec.status,
  "compiled",
)

assert.deepEqual(
  observed.obligation_spec
    .positive_specs
    .map(
      (item) =>
        item.obligation,
    )
    .sort(),
  [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
)

console.log(
  "PASS E1.3a typed additive host obligations",
)


const protectedSurface =
  observed.bindings
    .protected_surface

assert.equal(
  protectedSurface.status,
  "context_bound_candidate",
)

assert.equal(
  protectedSurface.route_anchor,
  "/legacy-export",
)

assert.equal(
  protectedSurface.owner,
  "file:routes/reports.py",
)

assert.equal(
  protectedSurface.structural_ready,
  true,
)

assert.equal(
  protectedSurface.semantic_ready,
  false,
)

console.log(
  "PASS E1.3b ProtectionView resolves exact route ownership without generic reverse traversal",
)


const ui =
  observed.bindings.ui_host

assert.equal(
  ui.status,
  "context_bound_candidate",
)

assert.equal(
  ui.resource,
  "template:reports/page.html",
)

assert(
  !ui.candidates.includes(
    "template:admin/page.html",
  ),
)

assert.equal(
  ui.structural_ready,
  true,
)

assert.equal(
  ui.semantic_ready,
  false,
)

console.log(
  "PASS E1.3c HostView keeps unrelated rendered resources out",
)


const nav =
  observed.bindings
    .navigation_host

assert.equal(
  nav.resource,
  "template:shared/navigation.html",
)

assert.equal(
  nav.structural_ready,
  true,
)

assert.equal(
  nav.candidates[0]
    .includer_count,
  2,
)

assert.equal(
  nav.candidates[0]
    .route_target_count,
  2,
)

assert.equal(
  nav.candidates[0]
    .shared_navigation_topology,
  true,
)

console.log(
  "PASS E1.3c navigation host uses structural topology rather than filename heuristics",
)


const data =
  observed.bindings
    .data_access_capability

assert.equal(
  data.status,
  "structural_candidate",
)

assert.equal(
  data.candidate.target_file,
  "data/report_store.py",
)

assert.equal(
  data.candidates.length,
  1,
)

assert.equal(
  data.source_identity_status,
  "unresolved",
)

assert.equal(
  data.semantic_ready,
  false,
)

console.log(
  "PASS E1.3c validated Impact is a provider candidate, never direct task authority",
)


assert.equal(
  observed.coverage.status,
  "structural_complete_semantic_blocked",
)

assert.deepEqual(
  observed.coverage
    .structurally_missing,
  [],
)

assert.equal(
  observed.coverage
    .semantically_ready
    .length,
  0,
)

assert.equal(
  observed.coverage
    .positive_complete,
  false,
)

console.log(
  "PASS E1.3d structural completeness remains distinct from semantic authority",
)


/*
 * ============================================================
 * Adversarial: competing exact route owners.
 * ============================================================
 */

const ambiguous =
  runHostIntegrationShadow({
    taskRequirements:
      requirements,

    taskAnchors:
      anchors,

    additiveLocalizationPlan:
      plan,

    frameworkEdges: [
      ...frameworkEdges,

      edge(
        "file:legacy/other.py",
        "route:/legacy-export",
        "declares_route",
        "legacy/other.py",
        7,
      ),
    ],

    impactValidated,
  })

assert.equal(
  ambiguous.bindings
    .protected_surface
    .status,
  "ambiguous",
)

assert.equal(
  ambiguous.bindings
    .ui_host
    .structural_ready,
  false,
)

assert.equal(
  ambiguous.bindings
    .data_access_capability
    .structural_ready,
  false,
)

console.log(
  "PASS competing protected owners fail closed before host projection",
)


/*
 * ============================================================
 * Adversarial: truncated graph cannot establish uniqueness.
 * ============================================================
 */

const truncated =
  runHostIntegrationShadow({
    taskRequirements:
      requirements,

    taskAnchors:
      anchors,

    additiveLocalizationPlan:
      plan,

    frameworkEdges,

    impactValidated,

    frameworkTruncated:
      true,
  })

assert.equal(
  truncated.graph_views
    .truncated,
  true,
)

assert.equal(
  truncated.bindings
    .protected_surface
    .structural_ready,
  false,
)

assert.equal(
  truncated.bindings
    .ui_host
    .structural_ready,
  false,
)

assert.equal(
  truncated.bindings
    .navigation_host
    .structural_ready,
  false,
)

console.log(
  "PASS truncated graph cannot claim complete host structure",
)


/*
 * ============================================================
 * Adversarial: multiple task route anchors.
 *
 * TaskAnchor lacks role/polarity binding, so do not guess.
 * ============================================================
 */

const multiTask =
  (
    "Create a new page for /reports and preserve " +
    "the existing /legacy-export behavior."
  )

const multiRequirements =
  compileTaskRequirements(
    multiTask,
    SHA,
  )

const multiAnchors =
  compileTaskAnchors(
    multiTask,
    SHA,
  )

const multiShape =
  compileTaskShape(
    multiTask,
    SHA,
  )

const multiPlan =
  planAdditiveLocalization({
    taskRequirements:
      multiRequirements,

    taskKind:
      multiShape.shape,
  })

const multi =
  runHostIntegrationShadow({
    taskRequirements:
      multiRequirements,

    taskAnchors:
      multiAnchors,

    additiveLocalizationPlan:
      multiPlan,

    frameworkEdges,
  })

assert.equal(
  multi.obligation_spec
    .protected_anchor_status,
  "ambiguous_route_anchor_set",
)

assert.equal(
  multi.bindings
    .protected_surface
    .status,
  "ambiguous",
)

console.log(
  "PASS TaskAnchor route polarity is not hallucinated from multiple literals",
)


/*
 * ============================================================
 * API surface safety.
 * No generic both-direction graph primitive.
 * ============================================================
 */

const views =
  buildResourceGraphViews({
    frameworkEdges,
  })

assert.equal(
  typeof views.protection,
  "object",
)

assert.equal(
  typeof views.host,
  "object",
)

assert.equal(
  Object.hasOwn(
    views,
    "neighbors",
  ),
  false,
)

assert.equal(
  Object.hasOwn(
    views,
    "reverse",
  ),
  false,
)

assert.equal(
  Object.hasOwn(
    views,
    "walk",
  ),
  false,
)

console.log(
  "PASS ResourceGraph purpose views expose no generic reverse walker",
)

console.log(
  "PASS v2.28-E1.3 composite host-integration shadow contract",
)
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


production = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "host-integration-shadow-v1.mjs"
).read_text(
    encoding="utf-8",
).lower()

for forbidden in (
    "ozon",
    "bestsellers",
    "rd_bestsellers_data",
    "templates/snippets/menu.html",
):
    assert forbidden not in production, forbidden

for forbidden in (
    "makeTieredRoleEvidence",
    "solveObligationCoverage",
    "decideLocalization",
    "taskRoleEvidence",
):
    assert forbidden.lower() not in production.lower(), forbidden

print(
    "PASS E1.3 production remains repository-neutral and authority-free"
)
