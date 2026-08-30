#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"

js = r'''
import assert from "node:assert/strict";

import {
  runResourceAdapters,
} from "./opencode/plugins/cpu-search-core/resource-adapter-v1.mjs";

import {
  genericHtmlJsAdapter,
} from "./opencode/plugins/cpu-search-core/generic-html-js-adapter-v1.mjs";

import {
  reactJsxRouterAdapter,
} from "./opencode/plugins/cpu-search-core/react-jsx-router-adapter-v1.mjs";

import {
  vueSfcAdapter,
} from "./opencode/plugins/cpu-search-core/vue-sfc-adapter-v1.mjs";

import {
  sqlResourceAdapter,
} from "./opencode/plugins/cpu-search-core/sql-resource-adapter-v1.mjs";

import {
  resolveObservedResource,
} from "./opencode/plugins/cpu-search-core/observed-resource-resolver-v1.mjs";

import {
  compileTaskRequirements,
} from "./opencode/plugins/cpu-search-core/task-requirements-v1.mjs";

const adapters = [
  genericHtmlJsAdapter,
  reactJsxRouterAdapter,
  vueSfcAdapter,
  sqlResourceAdapter,
];

function run(sourcePath, text, extra = {}) {
  return runResourceAdapters({
    sourcePath,
    text,
    adapters,
    ...extra,
  });
}

function kinds(result) {
  return new Set(
    result.edge_candidates.map(
      (edge) => edge.kind,
    ),
  );
}

function targets(result) {
  return new Set(
    result.edge_candidates.map(
      (edge) => edge.to?.id,
    ),
  );
}

// ------------------------------------------------------------
// TaskIR must not infer implementation detail.
// A page/download requirement is NOT automatically an endpoint.
// ------------------------------------------------------------

const pageDownload =
  compileTaskRequirements(
    "Добавь новую пользовательскую страницу для скачивания XLSX. " +
    "Сохрани существующее поведение.",
    "a".repeat(64),
  );

assert(
  pageDownload.required_roles.includes("ui_surface"),
);

assert(
  pageDownload.required_roles.includes("output_artifact"),
);

assert(
  !pageDownload.required_roles.includes("server_endpoint"),
  "TaskIR inferred hidden transport implementation",
);

const explicitEndpoint =
  compileTaskRequirements(
    "Create a new API endpoint for downloading a report.",
    "b".repeat(64),
  );

assert(
  explicitEndpoint.required_roles.includes("server_endpoint"),
);

console.log(
  "PASS TaskIR does not invent hidden server endpoint obligations",
);

// ------------------------------------------------------------
// Generic HTML
// ------------------------------------------------------------

const html = run(
  "pages/report.html",
  `
<!-- <a href="/fake-comment">fake</a> -->

<a href="/reports">Reports</a>

<form action="/reports/export" method="post">
  <button>Export</button>
</form>

<form action="{{ dynamic_target }}">
</form>
`,
);

assert(kinds(html).has("TARGETS_ROUTE"));
assert(targets(html).has("/reports"));
assert(targets(html).has("/reports/export"));

assert(
  !targets(html).has("/fake-comment"),
);

console.log(
  "PASS generic HTML literal navigation/form relations",
);

// ------------------------------------------------------------
// Generic JS / TS fetch + XHR
// ------------------------------------------------------------

const jsResult = run(
  "client/report.ts",
  `
// fetch("/comment-only")

async function load() {
  return fetch("/api/reports");
}

const xhr = new XMLHttpRequest();
xhr.open("POST", "/api/reports/export");
`,
);

assert(
  kinds(jsResult).has("FETCHES_ROUTE"),
);

assert(
  targets(jsResult).has("/api/reports"),
);

assert(
  targets(jsResult).has("/api/reports/export"),
);

assert(
  !targets(jsResult).has("/comment-only"),
);

console.log(
  "PASS generic JS/TS literal request relations",
);

// ------------------------------------------------------------
// React / JSX Router
// ------------------------------------------------------------

const react = run(
  "src/App.tsx",
  `
import {
  Route,
  Link,
} from "react-router-dom";

<Route
  path="/reports"
  element={<ReportsPage />}
/>

<Link to="/reports">Reports</Link>

<Route
  path={dynamicPath}
  element={<DynamicPage />}
/>
`,
);

assert(
  react.families.includes("react-jsx-router"),
);

assert(
  kinds(react).has("DECLARES_ROUTE"),
);

assert(
  kinds(react).has("ROUTE_TO_COMPONENT"),
);

assert(
  kinds(react).has("TARGETS_ROUTE"),
);

assert(
  targets(react).has("ReportsPage"),
);

console.log(
  "PASS React JSX Router static relations",
);

// ------------------------------------------------------------
// Vue SFC
// ------------------------------------------------------------

const vue = run(
  "src/views/Reports.vue",
  `
<template>
  <!-- <RouterLink to="/comment-only" /> -->

  <RouterLink to="/reports">
    Reports
  </RouterLink>

  <RouterLink :to="dynamicRoute">
    Dynamic
  </RouterLink>
</template>

<script setup>
fetch("/api/reports")
</script>
`,
);

assert(
  vue.families.includes("vue-sfc"),
);

assert(
  kinds(vue).has("TARGETS_ROUTE"),
);

assert(
  kinds(vue).has("FETCHES_ROUTE"),
);

assert(
  targets(vue).has("/reports"),
);

assert(
  targets(vue).has("/api/reports"),
);

assert(
  !targets(vue).has("/comment-only"),
);

console.log(
  "PASS Vue SFC static navigation/request relations",
);

// ------------------------------------------------------------
// SQL files
// ------------------------------------------------------------

const sql = run(
  "db/report.sql",
  `
-- SELECT * FROM fake_comment;

SELECT *
FROM analytics.report_rows r
JOIN public.accounts a
  ON a.id = r.account_id
WHERE r.report_date = $1;

/*
UPDATE ignored_comment SET x = 1;
*/

UPDATE reporting.status
SET processed = true;
`,
);

assert(
  sql.families.includes("sql-resource"),
);

assert(
  kinds(sql).has("READS_DATA_RESOURCE"),
);

assert(
  kinds(sql).has("WRITES_DATA_RESOURCE"),
);

assert(
  targets(sql).has("analytics.report_rows"),
);

assert(
  targets(sql).has("public.accounts"),
);

assert(
  targets(sql).has("reporting.status"),
);

assert(
  !targets(sql).has("fake_comment"),
);

assert(
  !targets(sql).has("ignored_comment"),
);

console.log(
  "PASS SQL file table relations ignore comments",
);

// ------------------------------------------------------------
// Proof / authority contract
// ------------------------------------------------------------

for (const result of [
  html,
  jsResult,
  react,
  vue,
  sql,
]) {
  assert.equal(
    result.authority,
    "routing_only",
  );

  assert.equal(
    result.mutation_authority,
    false,
  );

  for (const edge of result.edge_candidates) {
    assert.equal(
      edge.mutation_authority,
      false,
    );

    assert.match(
      edge.source_sha256,
      /^[0-9a-f]{64}$/,
    );
  }
}

console.log(
  "PASS resource adapters cannot grant mutation authority",
);

// ------------------------------------------------------------
// Bounded deterministic output
// ------------------------------------------------------------

const bounded = run(
  "client/routes.ts",
  `
fetch("/a");
fetch("/b");
fetch("/c");
fetch("/d");
`,
  {
    maxWitnesses: 2,
    maxEdges: 2,
  },
);

assert.equal(
  bounded.witnesses.length,
  2,
);

assert.equal(
  bounded.edge_candidates.length,
  2,
);

assert.equal(
  bounded.truncated,
  true,
);

const boundedAgain = run(
  "client/routes.ts",
  `
fetch("/a");
fetch("/b");
fetch("/c");
fetch("/d");
`,
  {
    maxWitnesses: 2,
    maxEdges: 2,
  },
);

assert.deepEqual(
  bounded,
  boundedAgain,
);

console.log(
  "PASS resource adapter output is bounded and deterministic",
);

// ------------------------------------------------------------
// Observed resource resolver
// ------------------------------------------------------------

const resolved =
  resolveObservedResource({
    target:
      "reports/page.html",

    sourcePath:
      "routes/report.py",

    observedFiles: [
      "routes/report.py",
      "templates/reports/page.html",
      "templates/base.html",
    ],

    resourceRoots: [
      "templates",
    ],

    inventoryComplete:
      true,
  });

assert.equal(
  resolved.status,
  "resolved",
);

assert.equal(
  resolved.resolved_file,
  "templates/reports/page.html",
);

const partialMissing =
  resolveObservedResource({
    target:
      "missing.html",

    observedFiles: [],
    resourceRoots: [
      "templates",
    ],

    inventoryComplete:
      false,
  });

assert.equal(
  partialMissing.status,
  "unresolved",
  "partial inventory inferred absence",
);

const completeMissing =
  resolveObservedResource({
    target:
      "missing.html",

    observedFiles: [
      "templates/base.html",
    ],

    resourceRoots: [
      "templates",
    ],

    inventoryComplete:
      true,
  });

assert.equal(
  completeMissing.status,
  "missing",
);

const ambiguous =
  resolveObservedResource({
    target:
      "page.html",

    sourcePath:
      "views/source.html",

    observedFiles: [
      "views/page.html",
      "templates/page.html",
    ],

    resourceRoots: [
      "templates",
    ],

    inventoryComplete:
      true,
  });

assert.equal(
  ambiguous.status,
  "ambiguous",
);

assert.equal(
  ambiguous.resolved_file,
  null,
);

console.log(
  "PASS observed resolver never guesses missing/ambiguous resources",
);

console.log(
  "PASS v2.28-D1 resource adapter foundation",
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
    "resource-adapter-v1.mjs",
    "generic-html-js-adapter-v1.mjs",
    "react-jsx-router-adapter-v1.mjs",
    "vue-sfc-adapter-v1.mjs",
    "sql-resource-adapter-v1.mjs",
    "observed-resource-resolver-v1.mjs",
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

    assert "taskroleevidence" not in body
    assert "mutation_authority: true" not in body

print(
    "PASS repository-neutral D1 production modules"
)
