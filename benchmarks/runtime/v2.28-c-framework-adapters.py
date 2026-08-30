#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"

script = r'''
import assert from "node:assert/strict";

import {
  runFrameworkAdapters,
} from "./opencode/plugins/cpu-search-core/framework-adapter-v1.mjs";

import {
  flaskJinjaAdapter,
} from "./opencode/plugins/cpu-search-core/flask-jinja-adapter-v1.mjs";

import {
  fastapiPydanticAdapter,
} from "./opencode/plugins/cpu-search-core/fastapi-pydantic-adapter-v1.mjs";

import {
  djangoOrmAdapter,
} from "./opencode/plugins/cpu-search-core/django-orm-adapter-v1.mjs";

import {
  typescriptWebAdapter,
} from "./opencode/plugins/cpu-search-core/typescript-web-adapter-v1.mjs";

const adapters = [
  flaskJinjaAdapter,
  fastapiPydanticAdapter,
  djangoOrmAdapter,
  typescriptWebAdapter,
];

function run(sourcePath, text, extra = {}) {
  return runFrameworkAdapters({
    sourcePath,
    text,
    adapters,
    ...extra,
  });
}

function kinds(result) {
  return new Set(result.edge_candidates.map((x) => x.kind));
}

function witnessKinds(result) {
  return new Set(result.witnesses.map((x) => x.kind));
}

// ------------------------------------------------------------
// Flask / Jinja
// ------------------------------------------------------------

const flask = run(
  "routes/report.py",
  `
from flask import Blueprint, render_template

bp = Blueprint("report", __name__)

@bp.route("/report")
def report():
    return render_template("report.html")
`,
);

assert(flask.frameworks.includes("flask-jinja"));
assert(kinds(flask).has("DECLARES_ROUTE"));
assert(kinds(flask).has("RENDERS_TEMPLATE"));

const jinja = run(
  "templates/menu.html",
  `
{% extends "base.html" %}
{% include "snippets/nav.html" %}
<a href="{{ url_for("report.report") }}">Report</a>
`,
);

assert(kinds(jinja).has("EXTENDS_TEMPLATE"));
assert(kinds(jinja).has("INCLUDES_TEMPLATE"));
assert(kinds(jinja).has("URL_FOR_ROUTE"));

const flaskDynamic = run(
  "routes/dynamic.py",
  `
from flask import render_template

template_name = choose_template()
route_name = choose_route()

def x():
    return render_template(template_name)
`,
);

assert(
  !witnessKinds(flaskDynamic).has("render_template"),
  "dynamic Flask template must abstain",
);

console.log("PASS Flask/Jinja literal structural witnesses");

// ------------------------------------------------------------
// FastAPI / Pydantic
// ------------------------------------------------------------

const fastapi = run(
  "api/report.py",
  `
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

class ReportRequest(BaseModel):
    report_date: str

@router.post("/report", response_model=ReportRequest)
async def report(body: ReportRequest):
    return body
`,
);

assert(fastapi.frameworks.includes("fastapi-pydantic"));
assert(kinds(fastapi).has("DECLARES_ROUTE"));
assert(kinds(fastapi).has("DEFINES_SCHEMA"));
assert(kinds(fastapi).has("USES_SCHEMA"));

const fastapiDynamic = run(
  "api/dynamic.py",
  `
from fastapi import APIRouter
router = APIRouter()
PATH = make_path()

@router.get(PATH)
def handler():
    pass
`,
);

assert(
  !kinds(fastapiDynamic).has("DECLARES_ROUTE"),
  "dynamic FastAPI route must abstain",
);

console.log("PASS FastAPI/Pydantic literal structural witnesses");

// ------------------------------------------------------------
// Django / ORM
// ------------------------------------------------------------

const django = run(
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
assert(kinds(django).has("DEFINES_MODEL"));
assert(kinds(django).has("READS_MODEL"));
assert(kinds(django).has("RENDERS_TEMPLATE"));

const djangoUrls = run(
  "reports/urls.py",
  `
from django.urls import path
from . import views

urlpatterns = [
    path("reports/", views.page),
]
`,
);

assert(kinds(djangoUrls).has("DECLARES_ROUTE"));

const djangoDynamic = run(
  "reports/dynamic_urls.py",
  `
from django.urls import path

route = get_route()

urlpatterns = [
    path(route, handler),
]
`,
);

assert(
  !kinds(djangoDynamic).has("DECLARES_ROUTE"),
  "dynamic Django route must abstain",
);

console.log("PASS Django/ORM literal structural witnesses");

// ------------------------------------------------------------
// TypeScript: Express
// ------------------------------------------------------------

const express = run(
  "src/report-router.ts",
  `
import express from "express"

const router = express.Router()

router.get("/reports", getReports)
router.post("/reports/export", exportReports)
`,
);

assert(express.frameworks.includes("typescript-web"));
assert(kinds(express).has("DECLARES_ROUTE"));
assert.equal(
  express.edge_candidates.filter((x) => x.kind === "DECLARES_ROUTE").length,
  2,
);

const expressDynamic = run(
  "src/dynamic-router.ts",
  `
import express from "express"

const router = express.Router()
const path = getPath()

router.get(path, handler)
`,
);

assert(
  !kinds(expressDynamic).has("DECLARES_ROUTE"),
  "dynamic Express route must abstain",
);

console.log("PASS TypeScript Express literal route witnesses");

// ------------------------------------------------------------
// TypeScript: NestJS
// ------------------------------------------------------------

const nest = run(
  "src/reports.controller.ts",
  `
import { Controller, Get, Post } from "@nestjs/common"

@Controller("/reports")
export class ReportsController {
  @Get("/daily")
  daily() {}

  @Post("/export")
  export() {}
}
`,
);

assert(nest.frameworks.includes("typescript-web"));
assert(witnessKinds(nest).has("nest_controller"));
assert(witnessKinds(nest).has("nest_route"));
assert(kinds(nest).has("DECLARES_ROUTE"));

console.log("PASS TypeScript NestJS decorator witnesses");

// ------------------------------------------------------------
// TypeScript: Next route handlers
// ------------------------------------------------------------

const next = run(
  "src/app/api/reports/export/route.ts",
  `
export async function GET(request: Request) {
  return new Response("ok")
}

export async function POST(request: Request) {
  return new Response("ok")
}
`,
);

assert(next.frameworks.includes("typescript-web"));
assert(witnessKinds(next).has("next_route_handler"));

const nextRoutes = next.edge_candidates
  .filter((x) => x.kind === "DECLARES_ROUTE")
  .map((x) => x.to.id)
  .sort();

assert.deepEqual(
  nextRoutes,
  [
    "GET /api/reports/export",
    "POST /api/reports/export",
  ],
);

console.log("PASS TypeScript Next route-handler witnesses");

// ------------------------------------------------------------
// Proof carrying + no mutation authority
// ------------------------------------------------------------

for (const result of [flask, jinja, fastapi, django, express, nest, next]) {
  for (const witness of result.witnesses) {
    assert.match(witness.source_sha256, /^[0-9a-f]{64}$/);
    assert(Number.isInteger(witness.line) && witness.line >= 1);
  }

  for (const edge of result.edge_candidates) {
    assert.equal(edge.mutation_authority, false);
    assert.match(edge.source_sha256, /^[0-9a-f]{64}$/);
  }
}

console.log("PASS all framework edges remain routing-only");

// ------------------------------------------------------------
// Bounds + determinism
// ------------------------------------------------------------

const noisy = run(
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

assert.equal(noisy.witnesses.length, 2);
assert.equal(noisy.edge_candidates.length, 2);
assert.equal(noisy.truncated, true);

const noisyAgain = run(
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

assert.deepEqual(noisy, noisyAgain);

console.log("PASS bounded deterministic adapter output");
'''

proc = subprocess.run(
    ["node", "--input-type=module"],
    cwd=ROOT,
    input=script,
    text=True,
    capture_output=True,
)

if proc.stdout:
    print(proc.stdout, end="")

if proc.returncode != 0:
    if proc.stderr:
        print(proc.stderr, end="")
    raise SystemExit(proc.returncode)

for name in (
    "framework-adapter-v1.mjs",
    "flask-jinja-adapter-v1.mjs",
    "fastapi-pydantic-adapter-v1.mjs",
    "django-orm-adapter-v1.mjs",
    "typescript-web-adapter-v1.mjs",
):
    body = (CORE / name).read_text(encoding="utf-8").lower()

    for forbidden in (
        "ozon",
        "bestsellers",
        "rd_bestsellers_data",
        "templates/snippets/menu.html",
    ):
        assert forbidden not in body, (name, forbidden)

print("PASS repository-neutral framework adapter family")
print("PASS v2.28-C framework adapters foundation")
