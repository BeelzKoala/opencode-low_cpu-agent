#!/usr/bin/env python3

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

js = r'''
import assert from "node:assert/strict";

import {
  compileTaskShape,
} from "./opencode/plugins/cpu-search-core/task-shape-v1.mjs";

const SHA = "f".repeat(64);

function classify(text) {
  return compileTaskShape(
    text,
    SHA,
  );
}


// ============================================================
// Known additive feature tasks.
// ============================================================

const positive = [
  "Add a new page.",
  "Add a new endpoint.",
  "Add a new button.",
  "Add a new form.",
  "Create a page.",
  "Create a new endpoint.",
  "Create a new handler.",
  "Create a service for report generation.",
  "Add button for opening the report page.",

  "Add to the existing product a new user-facing page.",
  "Create in the existing application a new endpoint.",

  (
    "Add to the existing product for the current reporting "
    + "workflow a new user-facing page."
  ),

  "Добавь новую страницу.",
  "Добавь новый эндпоинт.",
  "Добавь новую кнопку.",
  "Добавь новую форму.",
  "Создай страницу.",
  "Создай новый обработчик.",
  "Создай новый сервис.",
  "Добавь кнопку для открытия страницы.",

  "Добавь в существующий продукт новую пользовательскую страницу.",
  "Создай в существующем приложении новый эндпоинт.",

  (
    "Добавь в существующий продукт для текущего сценария "
    + "отчетности новую отдельную пользовательскую страницу."
  ),
];

for (const text of positive) {
  const result =
    classify(text);

  assert.equal(
    result.status,
    "compiled",
    JSON.stringify({
      text,
      result,
    }),
  );

  assert.equal(
    result.shape,
    "additive",
    JSON.stringify({
      text,
      result,
    }),
  );
}

console.log(
  `PASS additive corpus recall=${positive.length}/${positive.length}`,
);


// ============================================================
// Non-additive / additive edits to existing behavior.
//
// ZERO false positives allowed.
// ============================================================

const negative = [
  "Add validation to the existing endpoint.",
  "Add logging to endpoint /reports.",
  "Add tests for the endpoint.",
  "Add metrics to the service.",
  "Add a field to the form.",
  "Add validation to the current handler.",

  "Add an existing page.",
  "Add a new existing page.",

  "Fix the existing reports page.",
  "Update the existing endpoint response.",
  "Rename helper old_name to new_name.",
  "Remove the old route.",
  "Replace the existing handler.",
  "Rewrite the old parser.",

  "Preserve the existing /export behavior.",
  "Use the existing reports page.",

  "Добавь валидацию в существующий обработчик.",
  "Добавь логирование в обработчик.",
  "Добавь тесты для эндпоинта.",
  "Добавь метрики в сервис.",
  "Добавь поле в форму.",

  "Добавь существующую страницу.",
  "Добавь новую существующую страницу.",

  "Исправь существующую страницу.",
  "Обнови существующий обработчик.",
  "Переименуй старый helper.",
  "Удали старый маршрут.",
  "Замени старый обработчик.",
  "Перепиши старый parser.",

  "Сохрани текущее поведение страницы.",
];

let falsePositive = 0;

for (const text of negative) {
  const result =
    classify(text);

  if (
    result.status === "compiled" &&
    result.shape === "additive"
  ) {
    falsePositive += 1;

    console.error(
      "FALSE_POSITIVE",
      JSON.stringify({
        text,
        result,
      }),
    );
  }

  assert.equal(
    result.status,
    "unresolved",
    JSON.stringify({
      text,
      result,
    }),
  );
}

assert.equal(
  falsePositive,
  0,
);

console.log(
  `PASS non-additive corpus false_positive=${falsePositive}/${negative.length}`,
);


// ============================================================
// Mixed objectives.
//
// Explicit new feature + independent destructive/repair work
// must fail closed.
// ============================================================

const mixed = [
  "Create a new report page and fix the old parser.",
  "Add a new endpoint and remove the old route.",
  "Create a new service and rewrite the old parser.",
  "Add a new button and replace the existing handler.",

  "Добавь новую страницу и почини старый парсер.",
  "Добавь новый эндпоинт и удали старый маршрут.",
  "Создай новый сервис и перепиши старый parser.",
  "Добавь новую кнопку и замени старый обработчик.",
];

for (const text of mixed) {
  const result =
    classify(text);

  assert.equal(
    result.status,
    "unresolved",
    JSON.stringify({
      text,
      result,
    }),
  );

  assert.equal(
    result.reason,
    "mixed_task_shape",
    JSON.stringify({
      text,
      result,
    }),
  );

  assert(
    result.additive_evidence.length > 0,
    JSON.stringify({
      text,
      result,
    }),
  );

  assert(
    result.conflict_evidence.length > 0,
    JSON.stringify({
      text,
      result,
    }),
  );
}

console.log(
  `PASS mixed-objective corpus abstain=${mixed.length}/${mixed.length}`,
);


// ============================================================
// Negated creation.
// ============================================================

const negated = [
  "Do not create a new page.",
  "Do not add a new endpoint.",
  "Never create a new route.",

  "Не добавь новую страницу.",
  "Не создавай новую страницу.",
  "Не нужно создавать новую страницу.",
];

for (const text of negated) {
  const result =
    classify(text);

  assert.equal(
    result.status,
    "unresolved",
    JSON.stringify({
      text,
      result,
    }),
  );
}

console.log(
  `PASS negated-creation corpus abstain=${negated.length}/${negated.length}`,
);


// ============================================================
// Determinism.
// ============================================================

const determinismText =
  "Add to the existing product a new user-facing page.";

const first =
  JSON.stringify(
    classify(
      determinismText,
    ),
  );

for (
  let index = 0;
  index < 32;
  index += 1
) {
  assert.equal(
    JSON.stringify(
      classify(
        determinismText,
      ),
    ),
    first,
  );
}

console.log(
  "PASS TaskShape classification deterministic across repeated runs",
);


// ============================================================
// Authority boundary.
// ============================================================

for (const text of [
  ...positive,
  ...negative,
  ...mixed,
  ...negated,
]) {
  const result =
    classify(text);

  assert.equal(
    result.localization_authority,
    false,
  );

  assert.equal(
    result.mutation_authority,
    false,
  );
}

console.log(
  "PASS TaskShape corpus cannot grant localization or mutation authority",
);

console.log(
  "PASS v2.28-E1.1 TaskShape adversarial corpus"
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
    ROOT
    / "opencode/plugins/cpu-search-core/task-shape-v1.mjs"
).read_text(
    encoding="utf-8"
).lower()

for forbidden in (
    "ozon",
    "bestsellers",
    "rd_bestsellers_data",
    "templates/snippets/menu.html",
):
    assert forbidden not in module, forbidden

print(
    "PASS repository-neutral TaskShape production"
)
