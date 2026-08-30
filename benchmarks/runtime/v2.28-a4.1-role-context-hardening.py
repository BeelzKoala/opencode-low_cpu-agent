#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

JS = r"""
import assert from "node:assert/strict";

import {
  compileTaskRequirements,
} from "./opencode/plugins/cpu-search-core/task-requirements-v1.mjs";

const SHA =
  "e".repeat(64);

function compile(text) {
  return compileTaskRequirements(
    text,
    SHA,
  );
}

function has(result, role) {
  return (
    result.required_roles ??
    []
  ).includes(role);
}


// ============================================================
// 1. Negated server clauses cannot create server_endpoint.
// ============================================================

const negatedServer = [
  "Create a new page and do not update the existing route.",
  "Create a new page and don't modify the existing endpoint.",
  "Create a new page and must not change the existing route.",

  "Создай новую страницу и не изменяй существующий маршрут.",
  "Создай новую страницу и не обновляй существующий роут.",
  "Создай новую страницу, но не исправляй существующий эндпоинт.",
  "Создай новую страницу и не надо изменять существующий маршрут.",
  "Создай новую страницу и не нужно обновлять существующий маршрут.",
];

for (const text of negatedServer) {
  const result =
    compile(text);

  assert.equal(
    has(
      result,
      "server_endpoint",
    ),
    false,
    JSON.stringify({
      text,
      result,
    }),
  );

  assert.equal(
    has(
      result,
      "ui_surface",
    ),
    true,
    JSON.stringify({
      text,
      result,
    }),
  );
}

console.log(
  "PASS negated server clauses cannot create positive endpoint obligations",
);


// ============================================================
// 2. Independent positive endpoint remains visible.
// ============================================================

const positiveServer = [
  "Do not change /old, but create a new endpoint /new.",
  "Preserve the existing route and update the reports endpoint.",

  // Negative server clause + independent positive server clause.
  "Do not update the existing route, but create a new endpoint.",
  "Do not update the existing route but create a new endpoint.",
  "Do not modify the old endpoint; create a new endpoint.",

  "Не ломай /old, а создай новый маршрут /new.",
  "Сохрани старый маршрут и добавь новый эндпоинт.",

  // Same polarity composition in Russian.
  "Не изменяй существующий маршрут, а создай новый маршрут.",
  "Не изменяй существующий маршрут а создай новый маршрут.",
  "Не обновляй старый эндпоинт; создай новый эндпоинт.",
];

for (const text of positiveServer) {
  const result =
    compile(text);

  assert.equal(
    has(
      result,
      "server_endpoint",
    ),
    true,
    JSON.stringify({
      text,
      result,
    }),
  );
}

console.log(
  "PASS independent positive endpoint remains classified",
);


// ============================================================
// 3. Slash route identifiers are not artifact language.
// ============================================================

const routeOnly = [
  "Preserve route /legacy-export behavior.",
  "Keep endpoint /download-report unchanged.",
  "Do not break /archive-export.",

  "Сохрани маршрут /экспорт.",
  "Не ломай роут /выгрузка.",
];

for (const text of routeOnly) {
  const result =
    compile(text);

  assert.equal(
    has(
      result,
      "output_artifact",
    ),
    false,
    JSON.stringify({
      text,
      result,
    }),
  );
}

console.log(
  "PASS route literals cannot leak into output_artifact",
);


// ============================================================
// 4. Real artifact requirements survive masking.
// ============================================================

const artifacts = [
  "Generate an XLSX file.",
  "Download the report file.",
  "Export report data.",
  "Create a CSV report.",

  "Скачай XLSX.",
  "Добавь выгрузку отчета.",
  "Сформируй PDF.",
];

for (const text of artifacts) {
  const result =
    compile(text);

  assert.equal(
    has(
      result,
      "output_artifact",
    ),
    true,
    JSON.stringify({
      text,
      result,
    }),
  );
}

console.log(
  "PASS explicit artifact requirements remain classified",
);


// ============================================================
// 5. Combined additive + protected context.
// ============================================================

const protectedPage =
  compile(
    "Создай новую страницу и не изменяй существующий маршрут /legacy-export."
  );

assert.equal(
  has(
    protectedPage,
    "ui_surface",
  ),
  true,
);

assert.equal(
  has(
    protectedPage,
    "server_endpoint",
  ),
  false,
);

assert.equal(
  has(
    protectedPage,
    "output_artifact",
  ),
  false,
);

console.log(
  "PASS protected route context cannot create unrelated positive roles",
);


// ============================================================
// 6. Additive download task + protected old route.
// ============================================================

const downloadPage =
  compile(
    "Create a new page to download an XLSX report. " +
    "Preserve existing route /legacy-export behavior."
  );

assert.equal(
  has(
    downloadPage,
    "ui_surface",
  ),
  true,
);

assert.equal(
  has(
    downloadPage,
    "output_artifact",
  ),
  true,
);

assert.equal(
  has(
    downloadPage,
    "server_endpoint",
  ),
  false,
);

assert.equal(
  has(
    downloadPage,
    "preserve_behavior",
  ),
  true,
);

console.log(
  "PASS artifact intent and protected route polarity coexist",
);


// ============================================================
// 7. Determinism.
// ============================================================

const deterministicText =
  (
    "Create a page to download XLSX; " +
    "do not update /legacy-export."
  );

const first =
  JSON.stringify(
    compile(
      deterministicText,
    ),
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
  "PASS A4.1 role-specific context masking deterministic",
);

console.log(
  "PASS v2.28-A4.1 TaskRequirements role-context hardening",
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
    encoding="utf-8",
).lower()

for forbidden in (
    "ozon",
    "bestsellers",
    "rd_bestsellers_data",
    "templates/snippets/menu.html",
):
    assert forbidden not in body, forbidden

print(
    "PASS repository-neutral A4.1 role-context production"
)
