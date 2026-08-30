#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"

js = r'''
import assert from "node:assert/strict";

import {
  inspectFrameworkResourceFile,
} from "./opencode/plugins/cpu-search-core/framework-resource-bridge-v1.mjs";

function inspect(sourcePath, text, extra = {}) {
  return inspectFrameworkResourceFile({
    sourcePath,
    text,
    ...extra,
  });
}

function edgeKinds(result) {
  return new Set(result.resource_edges.map((x) => x.kind));
}

// ------------------------------------------------------------
// Flask + Jinja
// ------------------------------------------------------------

const flask = inspect(
  "routes/report.py",
  `
from flask import Blueprint, render_template

bp = Blueprint("report", __name__)

@bp.route("/reports")
def reports():
    return render_template("reports/page.html")
`,
);

assert(flask.frameworks.includes("flask-jinja"));
assert(edgeKinds(flask).has("declares_route"));
assert(edgeKinds(flask).has("renders_resource"));

const jinja = inspect(
  "templates/reports/page.html",
  `
{% extends "base.html" %}
{% include "snippets/menu.html" %}
<a href="{{ url_for("report.reports") }}">Reports</a>
`,
);

assert(edgeKinds(jinja).has("extends_resource"));
assert(edgeKinds(jinja).has("includes_resource"));
assert(edgeKinds(jinja).has("targets_route"));

// ------------------------------------------------------------
// FastAPI + Pydantic
// ------------------------------------------------------------

const fastapi = inspect(
  "api/report.py",
  `
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

class ReportRequest(BaseModel):
    report_date: str

@router.post("/reports", response_model=ReportRequest)
async def report(body: ReportRequest):
    return body
`,
);

assert(fastapi.frameworks.includes("fastapi-pydantic"));
assert(edgeKinds(fastapi).has("declares_route"));
assert(edgeKinds(fastapi).has("defines"));
assert(edgeKinds(fastapi).has("uses_schema"));

// ------------------------------------------------------------
// Django + ORM
// ------------------------------------------------------------

const django = inspect(
  "reports/views.py",
  `
from django.shortcuts import render
from django.db import models

class Report(models.Model):
    name = models.CharField(max_length=10)

def page(request):
    rows = Report.objects.filter(name="x")
    return render(request, "reports/page.html")
`,
);

assert(django.frameworks.includes("django-orm"));
assert(edgeKinds(django).has("defines"));
assert(edgeKinds(django).has("reads_data_resource"));
assert(edgeKinds(django).has("renders_resource"));

// ------------------------------------------------------------
// TypeScript common server frameworks
// ------------------------------------------------------------

const express = inspect(
  "src/report-router.ts",
  `
import express from "express"
const router = express.Router()

router.get("/reports", listReports)
router.post("/reports/export", exportReports)
`,
);

assert(express.frameworks.includes("typescript-web"));
assert(edgeKinds(express).has("declares_route"));

const next = inspect(
  "src/app/api/reports/route.ts",
  `
export async function GET(request: Request) {
  return new Response("ok")
}
`,
);

assert(next.frameworks.includes("typescript-web"));
assert(edgeKinds(next).has("declares_route"));

// ------------------------------------------------------------
// Proof carrying + authority boundary
// ------------------------------------------------------------

for (const result of [
  flask,
  jinja,
  fastapi,
  django,
  express,
  next,
]) {
  assert.equal(result.authority, "routing_only");
  assert.equal(result.mutation_authority, false);

  for (const edge of result.resource_edges) {
    assert.equal(edge.validated, true);
    assert.equal(
      edge.authority,
      "validated_relation_only",
    );

    assert.match(
      edge.witness.sha256,
      /^[0-9a-f]{64}$/,
    );

    assert(
      Number.isInteger(edge.witness.line) &&
      edge.witness.line >= 1,
    );

    assert.equal(
      typeof edge.witness.extractor,
      "string",
    );
  }
}

console.log(
  "PASS framework relations become proof-carrying ResourceEdges",
);
console.log(
  "PASS framework ResourceEdges remain routing-only",
);

// ------------------------------------------------------------
// Dynamic forms must abstain
// ------------------------------------------------------------

const dynamicFlask = inspect(
  "routes/dynamic.py",
  `
from flask import render_template

template_name = choose_template()

def page():
    return render_template(template_name)
`,
);

assert.equal(
  dynamicFlask.resource_edges.length,
  0,
  "dynamic Flask template must not produce validated edge",
);

const dynamicExpress = inspect(
  "src/dynamic.ts",
  `
import express from "express"
const router = express.Router()

const route = chooseRoute()
router.get(route, handler)
`,
);

assert.equal(
  dynamicExpress.resource_edges.length,
  0,
  "dynamic Express route must not produce validated edge",
);

console.log(
  "PASS unresolved dynamic framework relations abstain",
);

// ------------------------------------------------------------
// Per-file bounds
// ------------------------------------------------------------

const bounded = inspect(
  "src/routes.ts",
  `
import express from "express"
const router = express.Router()

router.get("/a", a)
router.get("/b", b)
router.get("/c", c)
router.get("/d", d)
`,
  {
    maxWitnesses: 2,
    maxEdges: 2,
  },
);

assert.equal(bounded.resource_edges.length, 2);
assert.equal(bounded.truncated, true);

console.log(
  "PASS framework resource bridge remains bounded",
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

if cp.returncode != 0:
    if cp.stderr:
        print(cp.stderr, end="")
    raise SystemExit(cp.returncode)

plugin = PLUGIN.read_text(encoding="utf-8")

for marker in (
    'from "./cpu-search-core/framework-resource-bridge-v1.mjs"',
    "function inspectFrameworkRoutingForSelected(",
    "FRAMEWORK_ROUTING_MAX_FILES = 8",
    "FRAMEWORK_ROUTING_MAX_FILE_BYTES = 512 * 1024",
    "FRAMEWORK_ROUTING_MAX_EDGES_PER_FILE = 32",
    "FRAMEWORK_ROUTING_MAX_EDGES_PER_TURN = 96",
    "frameworkResourceEdges: new Map()",
    "frameworkRouting.routeFacts",
    "framework_resource_bridge_protocol:",
    "framework_resource_edges_validated:",
):
    assert marker in plugin, marker

# Framework integration itself must not silently become authority.
#
# Later runtime helpers may be inserted between the framework helper and
# scoutEvidenceWitnesses. Bound this assertion to the framework helper only
# instead of accidentally validating unrelated integrations.
start = plugin.index(
    "function inspectFrameworkRoutingForSelected("
)

candidate_ends = []

for marker in (
    "function resourceAdapterEdgeKey(",
    "function inspectResourceRoutingForSelected(",
    "function scoutEvidenceWitnesses(",
):
    pos = plugin.find(marker, start + 1)

    if pos >= 0:
        candidate_ends.append(pos)

assert candidate_ends, (
    "framework integration end marker missing"
)

end = min(candidate_ends)

integration = plugin[start:end]

for forbidden in (
    "taskRoleEvidence",
    "classifyEvidenceAuthority",
    "mutationReady",
    "mutation_ready",
):
    assert forbidden not in integration, forbidden

# Turn-local routing state cannot leak.
start = plugin.index("function resetTurnState(")
end = plugin.index(
    "\nfunction transitionExecutionState",
    start,
)
reset = plugin[start:end]

for marker in (
    "state.taskRequirements = null",
    "state.taskRoleEvidence = []",
    "state.frameworkResourceEdges = new Map()",
):
    assert marker in reset, marker

# Production adapters remain repository-neutral.
for name in (
    "framework-adapter-v1.mjs",
    "flask-jinja-adapter-v1.mjs",
    "fastapi-pydantic-adapter-v1.mjs",
    "django-orm-adapter-v1.mjs",
    "typescript-web-adapter-v1.mjs",
    "framework-resource-bridge-v1.mjs",
):
    body = (CORE / name).read_text(
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

print("PASS bounded selected-file production integration")
print("PASS task/mutation authority boundary retained")
print("PASS turn-local framework graph lifecycle")
print("PASS repository-neutral C2 integration")
print("PASS v2.28-C2 framework resource routing")
