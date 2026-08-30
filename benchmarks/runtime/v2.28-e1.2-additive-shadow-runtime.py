#!/usr/bin/env python3

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

PLUGIN = (
    ROOT / "opencode/plugins/cpu-search.ts"
).read_text(
    encoding="utf-8"
)

INSTALL = (
    ROOT / "scripts/install-plugin-stack.sh"
).read_text(
    encoding="utf-8"
)


# ------------------------------------------------------------
# Runtime imports + lifecycle.
# ------------------------------------------------------------

for marker in (
    'from "./cpu-search-core/task-shape-v1.mjs"',
    (
        'from "./cpu-search-core/'
        'additive-localization-plan-v1.mjs"'
    ),
    "compileTaskShape(",
    "planAdditiveLocalization({",
    "taskShape: null,",
    "additiveLocalizationPlan: null,",
    "state.taskShape = taskShape",
    (
        "state.additiveLocalizationPlan = "
        "additiveLocalizationPlan"
    ),
    "state.taskShape = null",
    "state.additiveLocalizationPlan = null",
):
    assert marker in PLUGIN, marker

print(
    "PASS E1.2 TaskShape/AdditivePlan lifecycle present"
)


# ------------------------------------------------------------
# Telemetry.
# ------------------------------------------------------------

for marker in (
    "task_shape_protocol:",
    "task_shape_status:",
    "task_shape_shape:",
    "task_shape_reason:",
    "task_shape_additive_evidence:",
    "task_shape_conflict_evidence:",
    "task_shape_localization_authority:",
    "task_shape_mutation_authority:",
    "additive_localization_plan_protocol:",
    "additive_localization_plan_status:",
    "additive_localization_positive_obligations:",
    "additive_localization_positive_bindings:",
    "additive_localization_positive_source_families:",
    "additive_localization_protected_obligations:",
    "additive_localization_implementation_roles:",
    "additive_localization_policy_roles:",
    (
        "additive_localization_plan_"
        "localization_authority:"
    ),
    (
        "additive_localization_plan_"
        "mutation_authority:"
    ),
):
    assert marker in PLUGIN, marker

print(
    "PASS E1.2 task-shape/additive planning telemetry present"
)


# ------------------------------------------------------------
# No Scout routing/control-flow impact.
# ------------------------------------------------------------

progress_start = PLUGIN.index(
    "const meaningfulRouteProgress ="
)

progress_end = PLUGIN.index(
    "const novelFactStats =",
    progress_start,
)

progress = PLUGIN[
    progress_start:
    progress_end
]

for forbidden in (
    "taskShape",
    "additiveLocalizationPlan",
    "task_shape",
    "additive_localization",
):
    assert forbidden not in progress, forbidden


route_start = PLUGIN.index(
    "const routeFacts = routeFactsForRanking("
)

ledger_start = PLUGIN.index(
    (
        "const ledgerFactsBefore = "
        "state?.evidenceLedger?.size ?? 0"
    ),
    route_start,
)

route_control = PLUGIN[
    route_start:
    ledger_start
]

for forbidden in (
    "taskShape",
    "additiveLocalizationPlan",
):
    assert forbidden not in route_control, forbidden

print(
    "PASS E1.2 cannot alter route ledger or meaningful progress"
)


# ------------------------------------------------------------
# Existing causal shadow remains independent.
# ------------------------------------------------------------

shadow_start = PLUGIN.index(
    "function taskCausalShadowForState("
)

shadow_end = PLUGIN.index(
    "function scoutEvidenceWitnesses(",
    shadow_start,
)

shadow = PLUGIN[
    shadow_start:
    shadow_end
]

for forbidden in (
    "taskShape",
    "additiveLocalizationPlan",
):
    assert forbidden not in shadow, forbidden

print(
    "PASS E1.2 does not redefine task-causal graph semantics"
)


# ------------------------------------------------------------
# No evidence/readiness authority promotion.
# ------------------------------------------------------------

for forbidden in (
    (
        "state.taskRoleEvidence = "
        "state.additiveLocalizationPlan"
    ),
    (
        "state.taskRoleEvidence = "
        "additiveLocalizationPlan"
    ),
    (
        "state.taskRoleEvidence.push("
        "state.additiveLocalizationPlan"
    ),
    (
        "state.taskRoleEvidence.push("
        "additiveLocalizationPlan"
    ),
):
    assert forbidden not in PLUGIN, forbidden

print(
    "PASS E1.2 remains telemetry-only planning state"
)


# ------------------------------------------------------------
# Installer closure.
# ------------------------------------------------------------

for rel in (
    "cpu-search-core/task-shape-v1.mjs",
    (
        "cpu-search-core/"
        "additive-localization-plan-v1.mjs"
    ),
):
    assert f'"{rel}"' in INSTALL, rel

print(
    "PASS E1.2 installer contains runtime dependencies"
)


# ------------------------------------------------------------
# Repository-neutral production.
# ------------------------------------------------------------

for rel in (
    "task-shape-v1.mjs",
    "additive-localization-plan-v1.mjs",
):
    body = (
        ROOT
        / "opencode/plugins/cpu-search-core"
        / rel
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
            rel,
            forbidden,
        )

print(
    "PASS repository-neutral E1.2 production modules"
)

print(
    "PASS v2.28-E1.2 additive planning runtime shadow contract"
)
