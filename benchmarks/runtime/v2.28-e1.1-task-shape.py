#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"
INSTALL = ROOT / "scripts/install-plugin-stack.sh"

js = r'''
import assert from "node:assert/strict";

import {
  TASK_SHAPE,
  compileTaskShape,
} from "./opencode/plugins/cpu-search-core/task-shape-v1.mjs";

import {
  planAdditiveLocalization,
} from "./opencode/plugins/cpu-search-core/additive-localization-plan-v1.mjs";

const sha = "a".repeat(64);

function shape(text) {
  return compileTaskShape(
    text,
    sha,
  );
}

function additive(text) {
  const result =
    shape(text);

  assert.equal(
    result.status,
    "compiled",
    JSON.stringify(result),
  );

  assert.equal(
    result.shape,
    TASK_SHAPE.ADDITIVE,
    JSON.stringify(result),
  );

  assert.equal(
    result.localization_authority,
    false,
  );

  assert.equal(
    result.mutation_authority,
    false,
  );

  return result;
}

function unresolved(
  text,
  reason = null,
) {
  const result =
    shape(text);

  assert.equal(
    result.status,
    "unresolved",
    JSON.stringify(result),
  );

  assert.equal(
    result.shape,
    TASK_SHAPE.UNRESOLVED,
  );

  if (reason) {
    assert.equal(
      result.reason,
      reason,
      JSON.stringify(result),
    );
  }

  return result;
}


// ------------------------------------------------------------
// Positive additive surfaces.
// ------------------------------------------------------------

additive(
  "Add a new user-facing page for report downloads."
);

additive(
  "Create a new endpoint for report downloads."
);

additive(
  "Create endpoint /reports for generated files."
);

additive(
  "Add button for opening the report page."
);

additive(
  "Добавь новую пользовательскую страницу для скачивания отчёта."
);

additive(
  "Создай новый эндпоинт для формирования отчёта."
);

additive(
  "Добавь кнопку для открытия новой страницы."
);

console.log(
  "PASS explicit EN/RU creation of implementation surfaces compiles additive shape",
);


// ------------------------------------------------------------
// Existing HOST context must not be confused with an existing
// target implementation surface.
// ------------------------------------------------------------

additive(
  "Добавь в существующий продукт новую пользовательскую страницу."
);

additive(
  "Создай в существующем приложении новый эндпоинт."
);

additive(
  "Add to the existing product a new user-facing page."
);

additive(
  "Create in the existing application a new endpoint."
);

unresolved(
  "Добавь существующую пользовательскую страницу.",
  "explicit_additive_surface_not_proven",
);

unresolved(
  "Добавь новую существующую страницу.",
  "explicit_additive_surface_not_proven",
);

unresolved(
  "Add an existing page.",
  "explicit_additive_surface_not_proven",
);

unresolved(
  "Add a new existing page.",
  "explicit_additive_surface_not_proven",
);

console.log(
  "PASS existing host context is distinct from existing target surface",
);


// ------------------------------------------------------------
// Preserve/update integration clauses do not invalidate an
// otherwise explicit additive feature.
// ------------------------------------------------------------

const preserved =
  additive(
    "Add a new report page. Preserve the existing /export behavior."
  );

assert.equal(
  preserved
    .additive_evidence
    .length,
  1,
);

additive(
  "Create a new page and update the existing menu to link to it."
);

additive(
  "Добавь новую страницу. Не ломай существующий /export."
);

console.log(
  "PASS additive feature remains additive with host integration/preserve clauses",
);


// ------------------------------------------------------------
// Additive edit != additive feature.
// ------------------------------------------------------------

unresolved(
  "Add validation to the existing endpoint.",
  "explicit_additive_surface_not_proven",
);

unresolved(
  "Add logging to endpoint /reports.",
  "explicit_additive_surface_not_proven",
);

unresolved(
  "Add tests for the endpoint.",
  "explicit_additive_surface_not_proven",
);

unresolved(
  "Добавь валидацию в существующий обработчик.",
  "explicit_additive_surface_not_proven",
);

console.log(
  "PASS additive edits to existing behavior do not masquerade as additive feature shape",
);


// ------------------------------------------------------------
// Modify/fix/rename-only tasks remain unresolved.
// ------------------------------------------------------------

for (const text of [
  "Fix the existing reports page.",
  "Update the existing endpoint response.",
  "Rename helper old_name to new_name.",
  "Исправь существующую страницу.",
  "Обнови существующий обработчик.",
]) {
  unresolved(
    text,
    "explicit_additive_surface_not_proven",
  );
}

console.log(
  "PASS modify-only tasks remain unresolved",
);


// ------------------------------------------------------------
// Mixed independent objectives fail closed.
// ------------------------------------------------------------

unresolved(
  "Create a new report page and fix the old parser.",
  "mixed_task_shape",
);

unresolved(
  "Добавь новую страницу и почини старый парсер.",
  "mixed_task_shape",
);

console.log(
  "PASS mixed additive-plus-repair task shape fails closed",
);


// ------------------------------------------------------------
// Negated creation must never classify as additive.
// ------------------------------------------------------------

unresolved(
  "Do not create a new page. Fix the existing page.",
);

unresolved(
  "Не создавай новую страницу. Используй существующую.",
);

console.log(
  "PASS negated creation cannot prove additive shape",
);


// ------------------------------------------------------------
// Shape proof can feed E1 planner, but neither grants authority.
// ------------------------------------------------------------

const taskShape =
  additive(
    "Add a new page for downloading reports."
  );

const plan =
  planAdditiveLocalization({
    taskRequirements: {
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
    },

    taskKind:
      taskShape.shape,
  });

assert.equal(
  plan.status,
  "planned",
);

assert.deepEqual(
  plan.positive_localization_obligations,
  [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
);

assert.equal(
  plan.localization_authority,
  false,
);

assert.equal(
  plan.mutation_authority,
  false,
);

console.log(
  "PASS TaskShapeIR composes with additive host-localization planning without authority",
);

console.log(
  "PASS v2.28-E1.1 deterministic TaskShapeIR contract",
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
    print(cp.stdout, end="")

if cp.returncode:
    if cp.stderr:
        print(cp.stderr, end="")
    raise SystemExit(cp.returncode)


module = (
    CORE / "task-shape-v1.mjs"
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
    "localization_authority: true",
    "mutation_authority: true",
    "executepatch",
    "taskroleevidence",
):
    assert forbidden not in lower, forbidden


# Still foundation-only.
plugin = PLUGIN.read_text(
    encoding="utf-8"
)

installer = INSTALL.read_text(
    encoding="utf-8"
)





print(
  "PASS TaskShapeIR remains repository-neutral and non-authoritative"
)
