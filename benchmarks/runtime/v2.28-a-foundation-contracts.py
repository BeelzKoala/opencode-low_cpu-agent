#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "opencode/plugins/cpu-search-core"
PLUGIN = ROOT / "opencode/plugins/cpu-search.ts"


def node(source: str) -> dict:
    cp = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert cp.returncode == 0, cp.stderr
    return json.loads(cp.stdout)


req = (CORE / "task-requirements-v1.mjs").resolve().as_uri()
auth = (CORE / "evidence-authority-v1.mjs").resolve().as_uri()
decision = (CORE / "localization-decision-v1.mjs").resolve().as_uri()

data = node(f"""
import {{
  compileTaskRequirements,
}} from {json.dumps(req)};

import {{
  classifyEvidenceAuthority,
}} from {json.dumps(auth)};

import {{
  decideLocalization,
}} from {json.dumps(decision)};

const sha = "a".repeat(64);

const compile = (text) =>
  compileTaskRequirements(text, sha);

const ru = compile(
  "Добавь новую пользовательскую страницу и эндпойнт. " +
  "Добавь её в общее меню. Делай SQL запрос к таблице. " +
  "Результат скачивается как XLSX. Невалидный ввод отклоняй. " +
  "Не ломай существующее поведение."
);

const en = compile(
  "Create a new page and endpoint, expose it through navigation, " +
  "query a database table, download an XLSX artifact, reject invalid " +
  "input and preserve existing route behavior."
);

const rename = compile(
  "Rename alpha to beta in sample.py."
);

const variants = {{
  ruEndpointI: compile("Добавь новый эндпоинт API."),
  ruEndpointY: compile("Добавь новый эндпойнт API."),
  ruApiHandle: compile("Реализуй новую ручку API для получения статуса."),
  enHandler: compile("Implement a new API handler for status."),
  ui: compile("Добавь кнопку и новую форму на странице."),
  nav: compile("Добавь пункт в сайдбар навигации."),
  data: compile("Сделай SQL запрос к таблице в базе данных."),
  schema: compile("Добавь миграцию схемы БД и индекс."),
  output: compile("Экспортируй результат в PDF."),
  validation: compile("Отклоняй недопустимые значения."),
  preserve: compile("Не трогай существующий маршрут."),
  tests: compile("Добавь pytest интеграционный тест."),
  config: compile("Добавь новую переменную окружения в конфигурацию."),
  dependencyChange: compile(
    "Обнови зависимость requests до новой версии."
  ),
  dependencyChangeWithConstraint: compile(
    "Обнови зависимость requests, но не добавляй новые сторонние зависимости."
  ),
}};

const constraints = {{
  deps: compile("Не добавляй новые сторонние зависимости."),
  preserve: compile("Не ломай существующее поведение."),
  parameterized: compile(
    "Передавай значение в SQL параметром, а не строковой подстановкой."
  ),
  closed: compile(
    "Принимай только допустимые варианты и не позволяй произвольное значение."
  ),
  preSideEffect: compile(
    "Невалидный ввод отклоняй до подключения к базе данных."
  ),
}};

const negatives = {{
  displayColumn: compile(
    "Поменяй только отображаемое название столбца на странице."
  ),
  proseModel: compile(
    "Исправь текстовое описание модели в README."
  ),
  noNewDependencies: compile(
    "Не добавляй новые сторонние зависимости."
  ),
  noNewDependenciesEn: compile(
    "Do not add new dependencies."
  ),
}};

const lexical = classifyEvidenceAuthority({{
  origins: ["lexical"],
}});

const impact = classifyEvidenceAuthority({{
  origins: ["impact"],
  mutationCandidateBases: [
    "validated_forward_impact_definition",
  ],
}});

const direct = classifyEvidenceAuthority({{
  origins: ["lexical"],
  mutationCandidateBases: [
    "direct_structural_evidence",
  ],
}});

const exact = classifyEvidenceAuthority({{
  origins: ["lexical"],
  mutationCandidateBases: [
    "direct_structural_evidence",
  ],
  exactTaskActionMatch: true,
}});

const causal = classifyEvidenceAuthority({{
  origins: ["task_causal"],
  taskCausal: true,
}});

const insufficient = decideLocalization({{
  taskRequirements: ru,
  coveredRoles: [],
  mutationSupported: true,
  candidateAuthority: true,
}});

const authorized = decideLocalization({{
  taskRequirements: ru,
  coveredRoles: ru.required_roles,
  mutationSupported: true,
  candidateAuthority: true,
}});

const ambiguous = decideLocalization({{
  taskRequirements: ru,
  coveredRoles: ru.required_roles,
  ambiguousRoles: [ru.required_roles[0]],
  mutationSupported: true,
  candidateAuthority: true,
}});

const noAuthority = decideLocalization({{
  taskRequirements: ru,
  coveredRoles: ru.required_roles,
  mutationSupported: true,
  candidateAuthority: false,
}});

const noAuthorityAndCapability = decideLocalization({{
  taskRequirements: ru,
  coveredRoles: ru.required_roles,
  mutationSupported: false,
  candidateAuthority: false,
}});

const unsupported = decideLocalization({{
  taskRequirements: ru,
  coveredRoles: ru.required_roles,
  mutationSupported: false,
  candidateAuthority: true,
}});

console.log(JSON.stringify({{
  ru,
  en,
  rename,
  variants,
  constraints,
  negatives,
  lexical,
  impact,
  direct,
  exact,
  causal,
  insufficient,
  authorized,
  ambiguous,
  noAuthority,
  noAuthorityAndCapability,
  unsupported,
}}));
""")


def roles(record: dict) -> set[str]:
    return set(record["required_roles"])


def constraints(record: dict) -> set[str]:
    return {
        item["kind"]
        for item in record["constraints"]
    }


base_expected = {
    "server_endpoint",
    "ui_surface",
    "navigation",
    "data_access",
    "output_artifact",
    "input_validation",
    "preserve_behavior",
}

assert roles(data["ru"]) == base_expected, (
    "ru",
    sorted(roles(data["ru"])),
)
assert roles(data["en"]) == base_expected, (
    "en",
    sorted(roles(data["en"])),
)

assert data["rename"]["status"] == "none"
assert data["rename"]["required_roles"] == []

variant_roles = {
    "ruEndpointI": "server_endpoint",
    "ruEndpointY": "server_endpoint",
    "ruApiHandle": "server_endpoint",
    "enHandler": "server_endpoint",
    "ui": "ui_surface",
    "nav": "navigation",
    "data": "data_access",
    "schema": "data_schema",
    "output": "output_artifact",
    "validation": "input_validation",
    "preserve": "preserve_behavior",
    "tests": "test_surface",
    "config": "configuration",
    "dependencyChange": "dependency_policy",
    "dependencyChangeWithConstraint": "dependency_policy",
}

for fixture, role in variant_roles.items():
    assert role in roles(data["variants"][fixture]), (
        fixture,
        role,
        sorted(roles(data["variants"][fixture])),
    )

expected_constraints = {
    "deps": "no_new_dependencies",
    "preserve": "preserve_existing_behavior",
    "parameterized": "parameterized_data_query",
    "closed": "closed_choice_input",
    "preSideEffect": "validate_before_side_effect",
}

for fixture, kind in expected_constraints.items():
    assert kind in constraints(data["constraints"][fixture]), (
        fixture,
        kind,
        sorted(constraints(data["constraints"][fixture])),
    )

# A positive dependency mutation remains a localization obligation even
# when the same task also forbids introducing additional dependencies.
assert "dependency_policy" in roles(
    data["variants"]["dependencyChangeWithConstraint"]
)
assert "no_new_dependencies" in constraints(
    data["variants"]["dependencyChangeWithConstraint"]
)

# "Displayed column" is not a DB schema migration.
assert "data_schema" not in roles(
    data["negatives"]["displayColumn"]
)

# Generic prose use of "model" does not mean DB/data access.
assert "data_access" not in roles(
    data["negatives"]["proseModel"]
)

# A negative dependency invariant is a verifier constraint, not a
# localization obligation to mutate/read manifests.
assert "dependency_policy" not in roles(
    data["negatives"]["noNewDependencies"]
)

# The same invariant must hold independently of task language.
assert "dependency_policy" not in roles(
    data["negatives"]["noNewDependenciesEn"]
)
assert "no_new_dependencies" in constraints(
    data["negatives"]["noNewDependenciesEn"]
)

assert data["lexical"]["mutation_authority"] is False
assert data["impact"]["mutation_authority"] is False
assert data["direct"]["mutation_authority"] is True
assert data["exact"]["mutation_authority"] is True
assert data["causal"]["mutation_authority"] is True

assert data["insufficient"]["status"] == "INSUFFICIENT"
assert data["authorized"]["status"] == "AUTHORIZED"
assert data["ambiguous"]["status"] == "AMBIGUOUS"

assert data["noAuthority"]["status"] == "INSUFFICIENT"
assert (
    data["noAuthority"]["reason"]
    == "mutation_authority_not_proven"
)

# Authority failure dominates capability classification.
assert data["noAuthorityAndCapability"]["status"] == "INSUFFICIENT"
assert (
    data["noAuthorityAndCapability"]["reason"]
    == "mutation_authority_not_proven"
)

# READY_UNSUPPORTED is reserved for a proven localization whose
# mutation shape is outside Executor capability.
assert data["unsupported"]["status"] == "READY_UNSUPPORTED"
assert (
    data["unsupported"]["reason"]
    == "mutation_capability_unavailable"
)

for path in (
    CORE / "task-requirements-v1.mjs",
    CORE / "evidence-authority-v1.mjs",
    CORE / "localization-decision-v1.mjs",
):
    text = path.read_text(encoding="utf-8").lower()

    for forbidden in (
        "ozon",
        "bestsellers",
        "rd_bestsellers_data",
        "templates/snippets/menu.html",
    ):
        assert forbidden not in text, (path.name, forbidden)

plugin = PLUGIN.read_text(encoding="utf-8")

for marker in (
    "compileTaskRequirements(snapshot.text, snapshot.textSha256)",
    "classifyEvidenceAuthority({",
    "decideLocalization({",
    "localization_decision:",
    "task_required_roles:",
    "task_constraints:",
):
    assert marker in plugin, marker

print("PASS TaskRequirementsIR extended generic role vocabulary")
print("PASS endpoint/эндпоинт/эндпойнт/API-handler variants")
print("PASS future roles: schema/tests/config/dependency policy")
print("PASS deterministic constraint vocabulary")
print("PASS adversarial negative role classification")
print("PASS lexical relevance alone cannot authorize mutation")
print("PASS generic validated Impact cannot authorize mutation")
print("PASS one LocalizationDecision owns readiness semantics")
print("PASS negative dependency policy remains verifier-only constraint")
print("PASS v2.28-A3 future-facing TaskRequirementsIR")
