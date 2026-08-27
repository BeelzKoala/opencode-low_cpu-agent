export const TASK_SHAPE_PROTOCOL =
  "task-shape-v1"

export const TASK_SHAPE_AUTHORITY =
  "deterministic_task_text"

export const TASK_SHAPE = Object.freeze({
  ADDITIVE:
    "additive",

  UNRESOLVED:
    "unresolved",
})

const ADD_VERBS = new Set([
  "add",
  "adds",
  "adding",
  "добавить",
  "добавь",
  "добавьте",
  "добавляем",
])

const CREATE_VERBS = new Set([
  "create",
  "creates",
  "creating",
  "introduce",
  "introduces",
  "introducing",
  "создать",
  "создай",
  "создайте",
  "создаем",
  "создаём",
  "ввести",
])

const NOVELTY = new Set([
  "new",
  "новый",
  "новая",
  "новое",
  "новые",
  "новую",
  "нового",
  "новой",
  "новом",
  "новым",
  "новых",
])

/*
 * Implementation surfaces only.
 *
 * Do NOT include "test", "validation", "logging", "field", etc.
 * Those are frequently additive edits to an existing feature rather
 * than evidence that the task itself is an additive feature task.
 */
const SURFACES = new Set([
  "page",
  "screen",
  "view",
  "endpoint",
  "route",
  "handler",
  "button",
  "form",
  "command",
  "component",
  "service",

  "страница",
  "страницу",
  "страницы",
  "странице",
  "экран",
  "эндпоинт",
  "эндпойнт",
  "маршрут",
  "обработчик",
  "кнопка",
  "кнопку",
  "форма",
  "форму",
  "команда",
  "команду",
  "компонент",
  "сервис",
])

const EXISTING = new Set([
  "existing",
  "current",
  "old",
  "существующий",
  "существующую",
  "существующего",
  "существующей",
  "текущий",
  "текущую",
  "старый",
  "старую",
])

/*
 * A second independent bug-fix/destructive objective makes the task
 * shape mixed. Preserve/keep/update are intentionally NOT here:
 * additive features commonly integrate into existing host surfaces.
 */
const CONFLICT_VERBS = new Set([
  "fix",
  "repair",
  "rename",
  "delete",
  "remove",
  "replace",
  "rewrite",

  /*
   * Russian infinitive + common imperative forms.
   *
   * Exact lexical matching is intentional here: the vocabulary is
   * small and deterministic. Do not introduce stemming because it
   * would broaden classification authority without evidence.
   */
  "исправить",
  "исправь",
  "исправьте",

  "починить",
  "почини",
  "почините",

  "переименовать",
  "переименуй",
  "переименуйте",

  "удалить",
  "удали",
  "удалите",

  "заменить",
  "замени",
  "замените",

  "переписать",
  "перепиши",
  "перепишите",
])

const NEGATION = new Set([
  "not",
  "never",
  "dont",
  "don't",
  "do",
  "no",

  "не",
  "нельзя",
])

/*
 * Hard safety bound, not a linguistic window.
 *
 * Classification already operates inside one clause.
 * This cap only prevents pathological clauses from creating
 * unbounded scanning work; it must not encode normal phrase length.
 */
const MAX_SURFACE_DISTANCE_TOKENS = 24

function tokenize(text) {
  const result = []

  for (
    const match of
    text.matchAll(
      /[\p{L}\p{N}_'-]+/gu,
    )
  ) {
    result.push({
      value:
        match[0].toLocaleLowerCase(),

      index:
        match.index,
    })
  }

  return result
}

function isNegated(
  tokens,
  index,
) {
  for (
    let i =
      Math.max(
        0,
        index - 3,
      );
    i < index;
    i += 1
  ) {
    if (
      NEGATION.has(
        tokens[i].value,
      )
    ) {
      return true
    }
  }

  return false
}

function clauseRanges(text) {
  const ranges = []

  let start = 0

  for (
    let i = 0;
    i < text.length;
    i += 1
  ) {
    if (
      text[i] !== "." &&
      text[i] !== "!" &&
      text[i] !== "?" &&
      text[i] !== "\n" &&
      text[i] !== ";"
    ) {
      continue
    }

    if (i > start) {
      ranges.push([
        start,
        i,
      ])
    }

    start = i + 1
  }

  if (
    start < text.length
  ) {
    ranges.push([
      start,
      text.length,
    ])
  }

  return ranges
}

function additiveEvidenceForClause(
  text,
  start,
  end,
) {
  const clause =
    text.slice(
      start,
      end,
    )

  const tokens =
    tokenize(clause)

  for (
    let verbIndex = 0;
    verbIndex < tokens.length;
    verbIndex += 1
  ) {
    const verb =
      tokens[verbIndex].value

    const isAdd =
      ADD_VERBS.has(verb)

    const isCreate =
      CREATE_VERBS.has(verb)

    if (
      (!isAdd && !isCreate) ||
      isNegated(
        tokens,
        verbIndex,
      )
    ) {
      continue
    }

    /*
     * Search only a bounded local phrase after the verb.
     */
    const limit =
      Math.min(
        tokens.length,
        verbIndex +
          1 +
          MAX_SURFACE_DISTANCE_TOKENS,
      )

    for (
      let surfaceIndex =
        verbIndex + 1;
      surfaceIndex < limit;
      surfaceIndex += 1
    ) {
      const surface =
        tokens[
          surfaceIndex
        ].value

      if (
        !SURFACES.has(
          surface,
        )
      ) {
        continue
      }

      const between =
        tokens.slice(
          verbIndex + 1,
          surfaceIndex,
        )

      /*
       * Existing host != existing target surface.
       *
       * Examples:
       *
       *   add an existing page
       *     -> existing is the nearest semantic qualifier
       *     -> not additive
       *
       *   add to the existing product a new page
       *     -> new occurs after existing and closer to page
       *     -> additive
       *
       *   добавить в существующий продукт новую страницу
       *     -> same host/surface distinction
       *
       *   add a new existing page
       *     -> existing is closer to page
       *     -> fail closed
       *
       * This remains a bounded deterministic heuristic.
       * It does not attempt general syntactic/NLP resolution.
       */
      let lastExistingIndex = -1
      let lastNoveltyIndex = -1

      for (
        let index = 0;
        index < between.length;
        index += 1
      ) {
        const value =
          between[index].value

        if (
          EXISTING.has(
            value,
          )
        ) {
          lastExistingIndex =
            index
        }

        if (
          NOVELTY.has(
            value,
          )
        ) {
          lastNoveltyIndex =
            index
        }
      }

      const hasNovelty =
        lastNoveltyIndex >= 0

      const existingQualifiesSurface =
        lastExistingIndex >= 0 &&
        (
          lastNoveltyIndex < 0 ||
          lastExistingIndex >
            lastNoveltyIndex
        )

      if (
        existingQualifiesSurface
      ) {
        continue
      }

      /*
       * "create endpoint" is inherently additive.
       *
       * "add endpoint/button" is accepted only when the surface
       * immediately follows the verb, or when explicit "new" appears.
       *
       * Therefore:
       *   add validation to existing endpoint -> unresolved
       *   add logging to endpoint             -> unresolved
       *   add a new endpoint                  -> additive
       *   add button                          -> additive
       */
      if (
        isAdd &&
        !hasNovelty &&
        surfaceIndex !==
          verbIndex + 1
      ) {
        continue
      }

      return {
        rule:
          isCreate
            ? "create_surface"
            : hasNovelty
              ? "add_new_surface"
              : "add_direct_surface",

        verb,
        surface,

        index:
          start +
          tokens[
            verbIndex
          ].index,
      }
    }
  }

  return null
}

function positiveConflictEvidence(
  text,
) {
  const tokens =
    tokenize(text)

  const found = []

  for (
    let i = 0;
    i < tokens.length;
    i += 1
  ) {
    if (
      !CONFLICT_VERBS.has(
        tokens[i].value,
      ) ||
      isNegated(
        tokens,
        i,
      )
    ) {
      continue
    }

    found.push({
      verb:
        tokens[i].value,

      index:
        tokens[i].index,
    })
  }

  return found
}

export function unresolvedTaskShape(
  reason,
  taskSha256 = null,
) {
  return Object.freeze({
    protocol:
      TASK_SHAPE_PROTOCOL,

    authority:
      TASK_SHAPE_AUTHORITY,

    status:
      "unresolved",

    shape:
      TASK_SHAPE.UNRESOLVED,

    reason,

    task_sha256:
      taskSha256,

    additive_evidence:
      Object.freeze([]),

    conflict_evidence:
      Object.freeze([]),

    localization_authority:
      false,

    mutation_authority:
      false,
  })
}

export function compileTaskShape(
  taskText,
  taskSha256,
) {
  if (
    typeof taskText !==
      "string" ||
    taskText.trim().length ===
      0
  ) {
    return unresolvedTaskShape(
      "task_text_unavailable",
      taskSha256 ?? null,
    )
  }

  const sha =
    typeof taskSha256 ===
      "string"
      ? taskSha256.toLowerCase()
      : null

  if (
    !/^[0-9a-f]{64}$/.test(
      sha ?? "",
    )
  ) {
    return unresolvedTaskShape(
      "task_hash_invalid",
      sha,
    )
  }

  const additiveEvidence = []

  for (
    const [start, end] of
    clauseRanges(taskText)
  ) {
    const evidence =
      additiveEvidenceForClause(
        taskText,
        start,
        end,
      )

    if (evidence) {
      additiveEvidence.push(
        evidence,
      )
    }
  }

  if (
    additiveEvidence.length ===
      0
  ) {
    return unresolvedTaskShape(
      "explicit_additive_surface_not_proven",
      sha,
    )
  }

  const conflictEvidence =
    positiveConflictEvidence(
      taskText,
    )

  if (
    conflictEvidence.length >
      0
  ) {
    return Object.freeze({
      protocol:
        TASK_SHAPE_PROTOCOL,

      authority:
        TASK_SHAPE_AUTHORITY,

      status:
        "unresolved",

      shape:
        TASK_SHAPE.UNRESOLVED,

      reason:
        "mixed_task_shape",

      task_sha256:
        sha,

      additive_evidence:
        Object.freeze(
          additiveEvidence.map(
            (item) =>
              Object.freeze({
                ...item,
              }),
          ),
        ),

      conflict_evidence:
        Object.freeze(
          conflictEvidence.map(
            (item) =>
              Object.freeze({
                ...item,
              }),
          ),
        ),

      localization_authority:
        false,

      mutation_authority:
        false,
    })
  }

  return Object.freeze({
    protocol:
      TASK_SHAPE_PROTOCOL,

    authority:
      TASK_SHAPE_AUTHORITY,

    status:
      "compiled",

    shape:
      TASK_SHAPE.ADDITIVE,

    reason:
      "explicit_additive_surface",

    task_sha256:
      sha,

    additive_evidence:
      Object.freeze(
        additiveEvidence.map(
          (item) =>
            Object.freeze({
              ...item,
            }),
        ),
      ),

    conflict_evidence:
      Object.freeze([]),

    /*
     * Shape classification is semantic planning input only.
     * It cannot authorize localization or mutation.
     */
    localization_authority:
      false,

    mutation_authority:
      false,
  })
}
