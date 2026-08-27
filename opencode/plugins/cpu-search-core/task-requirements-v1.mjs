export const TASK_REQUIREMENTS_PROTOCOL =
  "task-requirements-v1"

export const TASK_REQUIREMENTS_AUTHORITY =
  "deterministic_task_text"

export const TASK_ROLE = Object.freeze({
  SERVER_ENDPOINT: "server_endpoint",
  UI_SURFACE: "ui_surface",
  NAVIGATION: "navigation",
  DATA_ACCESS: "data_access",
  DATA_SCHEMA: "data_schema",
  OUTPUT_ARTIFACT: "output_artifact",
  INPUT_VALIDATION: "input_validation",
  PRESERVE_BEHAVIOR: "preserve_behavior",
  TEST_SURFACE: "test_surface",
  CONFIGURATION: "configuration",
  DEPENDENCY_POLICY: "dependency_policy",
})

export const TASK_CONSTRAINT = Object.freeze({
  NO_NEW_DEPENDENCIES: "no_new_dependencies",
  PRESERVE_EXISTING_BEHAVIOR: "preserve_existing_behavior",
  PARAMETERIZED_DATA_QUERY: "parameterized_data_query",
  CLOSED_CHOICE_INPUT: "closed_choice_input",
  VALIDATE_BEFORE_SIDE_EFFECT: "validate_before_side_effect",
})

const ROLE_SOURCE_FAMILIES = Object.freeze({
  [TASK_ROLE.SERVER_ENDPOINT]: Object.freeze([
    "server_code",
  ]),
  [TASK_ROLE.UI_SURFACE]: Object.freeze([
    "ui_resource",
    "client_code",
  ]),
  [TASK_ROLE.NAVIGATION]: Object.freeze([
    "ui_resource",
    "client_code",
    "server_code",
  ]),
  [TASK_ROLE.DATA_ACCESS]: Object.freeze([
    "server_code",
    "data_query",
  ]),
  [TASK_ROLE.DATA_SCHEMA]: Object.freeze([
    "data_schema",
    "server_code",
  ]),
  [TASK_ROLE.OUTPUT_ARTIFACT]: Object.freeze([
    "server_code",
    "client_code",
  ]),
  [TASK_ROLE.INPUT_VALIDATION]: Object.freeze([
    "server_code",
    "client_code",
  ]),
  [TASK_ROLE.PRESERVE_BEHAVIOR]: Object.freeze([
    "server_code",
    "ui_resource",
    "client_code",
  ]),
  [TASK_ROLE.TEST_SURFACE]: Object.freeze([
    "test_code",
  ]),
  [TASK_ROLE.CONFIGURATION]: Object.freeze([
    "config_resource",
    "server_code",
    "client_code",
  ]),
  [TASK_ROLE.DEPENDENCY_POLICY]: Object.freeze([
    "dependency_manifest",
  ]),
})

const ROLE_RULES = Object.freeze([
  Object.freeze({
    role: TASK_ROLE.SERVER_ENDPOINT,
    patterns: Object.freeze([
      /*
       * Explicit positive mutation of a server surface.
       *
       * Protected clauses between the mutation verb and the
       * server noun terminate the relation. This prevents:
       *
       *   create a page and preserve the existing route
       *
       * from becoming a server_endpoint requirement.
       */
      /\b(?:add|create|implement|change|update|modify|fix|remove|delete|rename|expose)\b(?:(?!\b(?:preserve|keep|retain|leave)\b|\b(?:do\s+not|don't|must\s+not)\b)[\s\S]){0,100}\b(?:endpoint|route|api\s+(?:handler|method)|request\s+handler|controller\s+action)\b/iu,

      /*
       * Russian equivalent.
       *
       * "не" and preserve verbs terminate the positive
       * verb->surface relation.
       */
      /(?:добав|созда|реализ|измен|обнов|исправ|удал|переимен)[а-яё]*(?:(?!(?:сохран|остав)[а-яё]*|(?<![\p{L}\p{N}_])не(?![\p{L}\p{N}_]))[\s\S]){0,100}(?:эндпо(?:и|й)нт|маршрут|роут|api[-\s]*(?:метод|обработчик)|ручк[а-яё]*\s+api|api\s+ручк[а-яё]*)/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.UI_SURFACE,
    patterns: Object.freeze([
      /\b(?:add|create|introduce|change|update|modify|fix|remove|new)\b.{0,100}\b(?:page|screen|view|form|template|component|button|control)\b/iu,
      /\b(?:page|screen|view|form|template|component|button|control)\b.{0,100}\b(?:add|create|introduce|change|update|modify|fix|remove)\b/iu,
      /(?:добав|созда|измен|обнов|исправ|удал|нов)[а-яё]*.{0,100}(?:страниц|экран|форм|шаблон|компонент|кнопк|элемент\s+интерфейс)[а-яё]*/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.NAVIGATION,
    patterns: Object.freeze([
      /\b(?:menu|navigation|navbar|sidebar|breadcrumb)\b/iu,
      /меню|навигац|сайдбар|боков[а-яё]*\s+панел|хлебн[а-яё]*\s+крошк/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.DATA_ACCESS,
    patterns: Object.freeze([
      /\b(?:sql|database|db|dao|data\s+repository)\b/iu,
      /\b(?:select|insert|update|delete|query)\b.{0,80}\b(?:table|database|db)\b/iu,
      /\b(?:table|database|db)\b.{0,80}\b(?:select|insert|update|delete|query)\b/iu,
      /sql|баз[а-яё]*\s+данн|(?:^|\s)бд(?:\s|$)|(?:запрос|select|insert|update|delete).{0,80}таблиц/iu,
      /таблиц[а-яё]*.{0,80}(?:sql|бд|баз[а-яё]*\s+данн|запрос|select|insert|update|delete)/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.DATA_SCHEMA,
    patterns: Object.freeze([
      /\b(?:database|db)\s+(?:migration|schema)\b/iu,
      /\b(?:migration|schema\s+change|alter\s+table|create\s+table|drop\s+table)\b/iu,
      /миграц|схем[а-яё]*\s+(?:бд|баз[а-яё]*\s+данн)|alter\s+table|create\s+table|drop\s+table/iu,
      /(?:добав|удал|измен)[а-яё]*.{0,60}(?:столб|колонк|индекс)[а-яё]*.{0,60}(?:таблиц|бд|баз[а-яё]*\s+данн)/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.OUTPUT_ARTIFACT,
    patterns: Object.freeze([
      /\b(?:xlsx|excel|csv|pdf|zip|archive)\b/iu,
      /\b(?:download|export)\b.{0,80}\b(?:file|report|data|artifact)\b/iu,
      /скач|выгруз|экспорт|(?:xlsx|excel|csv|pdf|zip)/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.INPUT_VALIDATION,
    patterns: Object.freeze([
      /\b(?:invalid|validate|validation|reject|bad\s+request|allowed\s+values?|enum)\b/iu,
      /невалид|валидир|валидац|отклон|недопустим|допустим[а-яё]*\s+значен/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.PRESERVE_BEHAVIOR,
    patterns: Object.freeze([
      /\b(?:preserve|keep)\b.{0,120}\b(?:existing|current|behavior|behaviour|route|endpoint|contract)\b/iu,
      /\b(?:do\s+not|don't|must\s+not)\b.{0,120}\b(?:break|change|reuse|replace|regress)\b/iu,
      /\bbackward(?:s)?\s+compatib/iu,
      /не\s+(?:лом|меня|переиспольз|трог)[а-яё]*/iu,
      /сохран[а-яё]*.{0,80}(?:поведен|маршрут|эндпо(?:и|й)нт|роут|контракт)/iu,
      /обратн[а-яё]*\s+совместим/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.TEST_SURFACE,
    patterns: Object.freeze([
      /\b(?:add|create|update|fix|write)\b.{0,80}\b(?:test|tests|unit\s+test|integration\s+test|e2e|regression\s+test)\b/iu,
      /\b(?:pytest|unittest|jest|vitest|playwright|cypress)\b/iu,
      /(?:добав|созда|обнов|исправ|напиш)[а-яё]*.{0,80}тест[а-яё]*/iu,
      /pytest|юнит[-\s]*тест|интеграц[а-яё]*\s+тест|e2e/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.CONFIGURATION,
    patterns: Object.freeze([
      /\b(?:config|configuration|settings|environment\s+variable|env\s+var|feature\s+flag)\b/iu,
      /конфиг|конфигурац|настройк|переменн[а-яё]*\s+окружен|фича[-\s]*флаг/iu,
    ]),
  }),

  Object.freeze({
    role: TASK_ROLE.DEPENDENCY_POLICY,
    patterns: Object.freeze([
      /\b(?:add|install|upgrade|update|remove|replace|pin|bump)\b.{0,100}\b(?:dependency|dependencies|package|packages|library|libraries)\b/iu,
      /\b(?:dependency|dependencies|package|packages|library|libraries)\b.{0,100}\b(?:add|install|upgrade|update|remove|replace|pin|bump)\b/iu,
      /(?:добав|установ|обнов|подним|удал|замен|закреп)[а-яё]*.{0,100}(?:зависимост|пакет|библиотек)[а-яё]*/iu,
      /(?:requirements\.txt|pyproject\.toml|package\.json).{0,100}(?:обнов|измен|добав|удал)[а-яё]*/iu,
    ]),
  }),
])

const CONSTRAINT_RULES = Object.freeze([
  Object.freeze({
    kind: TASK_CONSTRAINT.NO_NEW_DEPENDENCIES,
    suppresses_roles: Object.freeze([
      TASK_ROLE.DEPENDENCY_POLICY,
    ]),
    patterns: Object.freeze([
      /\b(?:do\s+not|don't|must\s+not|without)\b.{0,100}\b(?:add|introduce|install)\b.{0,80}\b(?:new\s+)?(?:dependencies|packages|libraries)\b/iu,
      /\bno\s+new\s+(?:third[-\s]?party\s+)?(?:dependencies|packages|libraries)\b/iu,
      /не\s+добавл[а-яё]*.{0,100}(?:нов[а-яё]*\s+)?(?:сторонн[а-яё]*\s+)?(?:зависимост|пакет|библиотек)/iu,
      /без\s+(?:нов[а-яё]*\s+)?(?:сторонн[а-яё]*\s+)?(?:зависимост|пакет|библиотек)/iu,
    ]),
  }),

  Object.freeze({
    kind: TASK_CONSTRAINT.PRESERVE_EXISTING_BEHAVIOR,
    patterns: Object.freeze([
      /\b(?:preserve|keep)\b.{0,120}\b(?:existing|current|behavior|behaviour|route|endpoint|contract)\b/iu,
      /\b(?:do\s+not|don't|must\s+not)\b.{0,120}\b(?:break|change|reuse|replace|regress)\b/iu,
      /не\s+(?:лом|меня|переиспольз|трог)[а-яё]*/iu,
      /сохран[а-яё]*.{0,80}(?:поведен|маршрут|эндпо(?:и|й)нт|роут|контракт)/iu,
    ]),
  }),

  Object.freeze({
    kind: TASK_CONSTRAINT.PARAMETERIZED_DATA_QUERY,
    patterns: Object.freeze([
      /\bparameteri[sz]ed\s+(?:sql\s+)?query\b/iu,
      /\b(?:sql|query)\b.{0,100}\bparameter\b/iu,
      /\bparameter\b.{0,100}\b(?:sql|query)\b/iu,
      /параметриз[а-яё]*.{0,80}(?:sql|запрос)/iu,
      /(?:sql|запрос).{0,80}параметр[а-яё]*/iu,
      /переда[а-яё]*.{0,80}(?:в|как)\s+(?:sql[-\s]*)?параметр/iu,
    ]),
  }),

  Object.freeze({
    kind: TASK_CONSTRAINT.CLOSED_CHOICE_INPUT,
    patterns: Object.freeze([
      /\b(?:only|exactly)\b.{0,100}\b(?:allowed\s+)?(?:values?|choices?|options?)\b/iu,
      /\b(?:enum|closed\s+set|allowlist)\b/iu,
      /\bmust\s+not\b.{0,100}\barbitrary\b/iu,
      /только.{0,100}(?:значени|вариант|тип)[а-яё]*/iu,
      /фиксированн[а-яё]*\s+набор/iu,
      /не\s+долж[а-яё]*.{0,100}произвольн/iu,
    ]),
  }),

  Object.freeze({
    kind: TASK_CONSTRAINT.VALIDATE_BEFORE_SIDE_EFFECT,
    patterns: Object.freeze([
      /\b(?:reject|validate)\b.{0,120}\bbefore\b.{0,120}\b(?:database|db|network|write|connect|request)\b/iu,
      /\bbefore\b.{0,120}\b(?:database|db|network|write|connect|request)\b.{0,120}\b(?:reject|validate)\b/iu,
      /(?:отклон|валидир)[а-яё]*.{0,120}до.{0,120}(?:бд|баз[а-яё]*\s+данн|подключ|запис|сет)/iu,
    ]),
  }),
])

function normalizeTaskText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
}

function validSha256(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{64}$/iu.test(value)
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function matchingRuleIndexes(patterns, text) {
  const matches = []

  for (let index = 0; index < patterns.length; index += 1) {
    if (patterns[index].test(text)) {
      matches.push(index)
    }
  }

  return matches
}

const NEGATED_SERVER_SURFACE_PATTERNS =
  Object.freeze([
    /*
     * English negative mutation clause.
     *
     * Blank BOTH mutation verb and server surface so an earlier
     * unrelated positive verb cannot jump across the clause.
     */
    /\b(?:do\s+not|don't|must\s+not|never)\s+(?:add|create|implement|change|update|modify|fix|remove|delete|rename|expose)\b(?:(?!\s(?:but|however|instead)\s)[^,.;!?]){0,100}\b(?:endpoint|route|api\s+(?:handler|method)|request\s+handler|controller\s+action)\b/giu,

    /*
     * Russian equivalent.
     *
     * No \b around Cyrillic tokens: JS word-boundary semantics
     * are ASCII-centric and already caused a real regression.
     */
    /(?:не|не\s+надо|не\s+нужно|не\s+следует)\s+(?:добав|созда|реализ|измен|обнов|исправ|удал|переимен)[а-яё]*(?:(?!\s(?:но|а|зато)\s)[^,.;!?]){0,100}(?:эндпо(?:и|й)нт|маршрут|роут|api[-\s]*(?:метод|обработчик)|ручк[а-яё]*\s+api|api\s+ручк[а-яё]*)/giu,
  ])


const ROUTE_LITERAL_CONTEXT_PATTERN =
  /(^|[\s"'`(])\/[\p{L}\p{N}._~!$&()*+,;=:@%+\/-]+/gu


function blankPatternMatches(
  text,
  patterns,
) {
  let candidate = text

  for (const pattern of patterns) {
    candidate =
      candidate.replace(
        pattern,
        (match) =>
          " ".repeat(
            match.length,
          ),
      )
  }

  return candidate
}


function maskNegatedServerSurfaceContext(
  text,
) {
  return blankPatternMatches(
    text,
    NEGATED_SERVER_SURFACE_PATTERNS,
  )
}


function maskRouteLiteralContext(
  text,
) {
  return text.replace(
    ROUTE_LITERAL_CONTEXT_PATTERN,

    (
      match,
      prefix,
    ) => {
      /*
       * Preserve the delimiter itself; blank only the slash
       * literal. Example:
       *
       *   " /legacy-export"
       *   "               "
       *
       * except the leading space remains intact.
       */
      const keptPrefix =
        typeof prefix === "string"
          ? prefix
          : ""

      const maskedLength =
        Math.max(
          0,
          match.length -
            keptPrefix.length,
        )

      return (
        keptPrefix +
        " ".repeat(
          maskedLength,
        )
      )
    },
  )
}


function textForRole(text, role) {
  let candidate = text

  if (
    role ===
    TASK_ROLE.SERVER_ENDPOINT
  ) {
    candidate =
      maskNegatedServerSurfaceContext(
        candidate,
      )
  }

  if (
    role ===
    TASK_ROLE.OUTPUT_ARTIFACT
  ) {
    candidate =
      maskRouteLiteralContext(
        candidate,
      )
  }

  for (const spec of CONSTRAINT_RULES) {
    if (!(spec.suppresses_roles ?? []).includes(role)) {
      continue
    }

    for (const pattern of spec.patterns) {
      const flags =
        pattern.flags.includes("g")
          ? pattern.flags
          : `${pattern.flags}g`

      candidate = candidate.replace(
        new RegExp(pattern.source, flags),
        (match) => " ".repeat(match.length),
      )
    }
  }

  return candidate
}

export function unresolvedTaskRequirements(
  reason,
  taskSha256 = null,
) {
  return {
    protocol: TASK_REQUIREMENTS_PROTOCOL,
    authority: TASK_REQUIREMENTS_AUTHORITY,
    status: "unresolved",
    task_sha256:
      validSha256(taskSha256)
        ? taskSha256.toLowerCase()
        : null,
    required_roles: [],
    required_source_families: [],
    obligations: [],
    constraints: [],
    reason,
  }
}

export function compileTaskRequirements(
  value,
  taskSha256 = null,
) {
  const text = normalizeTaskText(value)

  if (!text) {
    return unresolvedTaskRequirements(
      "task_requirements_text_empty",
      taskSha256,
    )
  }

  const obligations = []

  for (const spec of ROLE_RULES) {
    const roleText = textForRole(text, spec.role)

    const matchedRules =
      matchingRuleIndexes(spec.patterns, roleText)

    if (matchedRules.length < 1) continue

    obligations.push({
      id: `role:${spec.role}`,
      role: spec.role,
      required: true,
      authority: TASK_REQUIREMENTS_AUTHORITY,
      source_families: [
        ...(ROLE_SOURCE_FAMILIES[spec.role] ?? []),
      ],
      deterministic_rule_matches: matchedRules,
    })
  }

  const constraints = []

  for (const spec of CONSTRAINT_RULES) {
    const matchedRules =
      matchingRuleIndexes(spec.patterns, text)

    if (matchedRules.length < 1) continue

    constraints.push({
      id: `constraint:${spec.kind}`,
      kind: spec.kind,
      required: true,
      authority: TASK_REQUIREMENTS_AUTHORITY,
      deterministic_rule_matches: matchedRules,
    })
  }

  const requiredRoles =
    obligations.map((item) => item.role)

  const requiredFamilies = uniqueSorted(
    obligations.flatMap(
      (item) => item.source_families,
    ),
  )

  return {
    protocol: TASK_REQUIREMENTS_PROTOCOL,
    authority: TASK_REQUIREMENTS_AUTHORITY,
    status:
      obligations.length > 0 || constraints.length > 0
        ? "compiled"
        : "none",
    task_sha256:
      validSha256(taskSha256)
        ? taskSha256.toLowerCase()
        : null,
    required_roles: requiredRoles,
    required_source_families: requiredFamilies,
    obligations,
    constraints,
    reason:
      obligations.length > 0 || constraints.length > 0
        ? "deterministic_task_requirements"
        : "no_structural_task_requirement",
  }
}
