#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

JS = r"""
import assert from "node:assert/strict";

import {
  compileTaskRequirements,
} from "./opencode/plugins/cpu-search-core/task-requirements-v1.mjs";

const SHA = "c".repeat(64);

function compile(text) {
  return compileTaskRequirements(
    text,
    SHA,
  );
}

function has(result, role) {
  return (
    result.required_roles ?? []
  ).includes(role);
}

function noServer(text) {
  const result = compile(text);

  assert.equal(
    has(result, "server_endpoint"),
    false,
    JSON.stringify({
      text,
      result,
    }),
  );

  return result;
}

function server(text) {
  const result = compile(text);

  assert.equal(
    has(result, "server_endpoint"),
    true,
    JSON.stringify({
      text,
      result,
    }),
  );

  return result;
}


// ============================================================
// Preserve-only server references are NOT result roles.
// ============================================================

noServer(
  "Preserve existing route /legacy-export behavior."
);

noServer(
  "Keep the existing endpoint behavior unchanged."
);

noServer(
  "Сохрани существующий маршрут /legacy-export."
);

console.log(
  "PASS preserve-only server references are protected context",
);


// ============================================================
// Additive UI + protected route must not invent endpoint.
// ============================================================

const pageEn = noServer(
  "Create a new report page and preserve the existing route /legacy-export behavior."
);

assert.equal(
  has(pageEn, "ui_surface"),
  true,
);

assert.equal(
  has(pageEn, "preserve_behavior"),
  true,
);


const pageEnReverse = noServer(
  "Preserve the existing route /legacy-export and create a new report page."
);

assert.equal(
  has(pageEnReverse, "ui_surface"),
  true,
);


const pageRu = noServer(
  "Создай новую страницу и сохрани существующий маршрут /legacy-export."
);

assert.equal(
  has(pageRu, "ui_surface"),
  true,
);


noServer(
  "Сохрани существующий маршрут /legacy-export и создай новую страницу."
);


noServer(
  "Create a new page and do not break the existing route /legacy-export."
);


noServer(
  "Создай новую страницу и не ломай существующий маршрут /legacy-export."
);

console.log(
  "PASS protected route clauses cannot leak into positive endpoint role",
);


// ============================================================
// Explicit server mutation remains recognized.
// ============================================================

server(
  "Create a new API endpoint for reports."
);

server(
  "Update the existing route /reports."
);

server(
  "Fix the request handler for report generation."
);

server(
  "Добавь новый эндпоинт API."
);

server(
  "Обнови существующий маршрут /reports."
);

server(
  "Реализуй новую ручку API для отчётов."
);

console.log(
  "PASS explicit positive server mutations remain classified",
);


// ============================================================
// Protected old route + explicit NEW endpoint retains endpoint.
// ============================================================

server(
  "Preserve /legacy-export and create a new endpoint /reports/export."
);

server(
  "Сохрани /legacy-export и создай новый эндпоинт /reports/export."
);

console.log(
  "PASS independent explicit endpoint creation survives protected context",
);


// ============================================================
// Existing important anti-overfit contract.
// ============================================================

const pageDownload =
  noServer(
    "Добавь новую пользовательскую страницу для скачивания XLSX. " +
    "Сохрани существующее поведение."
  );

assert.equal(
  has(pageDownload, "ui_surface"),
  true,
);

assert.equal(
  has(pageDownload, "output_artifact"),
  true,
);

console.log(
  "PASS page/download requirement still does not invent transport",
);


// ============================================================
// Determinism + authority-neutral IR.
// ============================================================

const deterministicText =
  "Create a new page and preserve existing route /old.";

const first =
  JSON.stringify(
    compile(deterministicText),
  );

for (
  let i = 0;
  i < 32;
  i += 1
) {
  assert.equal(
    JSON.stringify(
      compile(
        deterministicText,
      ),
    ),
    first,
  );
}

console.log(
  "PASS TaskRequirements role polarity deterministic",
);

console.log(
  "PASS v2.28-A4 TaskRequirements server-role polarity contract",
);
"""

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


body = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "task-requirements-v1.mjs"
).read_text(
    encoding="utf-8"
).lower()

for forbidden in (
    "ozon",
    "bestsellers",
    "rd_bestsellers_data",
    "templates/snippets/menu.html",
):
    assert forbidden not in body, forbidden

print(
    "PASS repository-neutral TaskRequirements polarity"
)
