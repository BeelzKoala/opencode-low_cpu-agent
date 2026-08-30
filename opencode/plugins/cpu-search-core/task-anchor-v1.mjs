export const TASK_ANCHOR_PROTOCOL =
  "task-anchor-v1"

export const TASK_ANCHOR_AUTHORITY =
  "deterministic_task_text"

export const TASK_ANCHOR_MAX =
  32

function validTaskSha256(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/iu.test(value)
  )
}

function pushAnchor(
  out,
  seen,
  {
    kind,
    value,
    index,
    derivedFrom = null,
  },
) {
  if (
    typeof kind !== "string" ||
    typeof value !== "string" ||
    value.length < 1 ||
    !Number.isSafeInteger(index) ||
    index < 0
  ) {
    return
  }

  const key =
    `${kind}\0${value}`

  if (seen.has(key)) {
    return
  }

  seen.add(key)

  out.push({
    protocol:
      TASK_ANCHOR_PROTOCOL,

    authority:
      TASK_ANCHOR_AUTHORITY,

    kind,
    value,
    index,

    derived_from:
      derivedFrom,
  })
}

const ROUTE_EXACT_QUOTES =
  new Set([
    '"',
    "'",
    "`",
  ])

function normalizeRouteLiteralMatch(
  taskText,
  match,
) {
  const raw =
    match?.[1]

  if (
    typeof taskText !== "string" ||
    typeof raw !== "string" ||
    raw.length < 2 ||
    !Number.isSafeInteger(match?.index)
  ) {
    return null
  }

  const offset =
    match[0].lastIndexOf(raw)

  if (offset < 0) {
    return null
  }

  const index =
    match.index + offset

  const end =
    index + raw.length

  const before =
    index > 0
      ? taskText[index - 1]
      : ""

  const after =
    end < taskText.length
      ? taskText[end]
      : ""

  /*
   * Quoted literals are explicit and therefore preserved exactly.
   *
   * Example:
   *   "/literal:"
   *
   * Unquoted routes are prose tokens. Strip punctuation that can
   * legally occur in a URI path but is overwhelmingly likely to
   * be sentence/container punctuation at the token boundary.
   *
   * Internal punctuation remains untouched:
   *   /users/:id
   *   /v1.0/report
   *   /a,b/report
   */
  const exactQuoted =
    ROUTE_EXACT_QUOTES.has(before) &&
    after === before

  const value =
    exactQuoted
      ? raw
      : raw.replace(
          /[.,;:!?)]+$/u,
          "",
        )

  if (value.length < 2) {
    return null
  }

  return {
    value,
    index,
  }
}

export function compileTaskAnchors(
  taskText,
  taskSha256,
) {
  if (
    typeof taskText !== "string" ||
    taskText.length < 1 ||
    !validTaskSha256(taskSha256)
  ) {
    return Object.freeze({
      protocol:
        TASK_ANCHOR_PROTOCOL,

      status:
        "unresolved",

      authority:
        TASK_ANCHOR_AUTHORITY,

      task_sha256:
        validTaskSha256(taskSha256)
          ? taskSha256.toLowerCase()
          : null,

      anchors: [],

      truncated: false,

      reason:
        "task_text_unavailable",
    })
  }

  const anchors = []
  const seen = new Set()

  /*
   * Literal application routes.
   *
   * Deliberately excludes:
   *   //host
   *   arbitrary prose slash fragments
   *   query strings / expressions
   *
   * Examples:
   *   /export
   *   /api/reports
   *   /users/:id
   */
  const routePattern =
    /(?:^|[\s"'`()\[\]{},;:=])((?:\/(?!\/)[A-Za-z0-9._~!$&()*+,;=:@%+-]+)+)/gu

  for (
    const match of
    taskText.matchAll(routePattern)
  ) {
    const normalized =
      normalizeRouteLiteralMatch(
        taskText,
        match,
      )

    if (!normalized) {
      continue
    }

    pushAnchor(
      anchors,
      seen,
      {
        kind:
          "route_literal",

        value:
          normalized.value,

        index:
          normalized.index,
      },
    )
  }

  /*
   * Qualified code identifiers.
   *
   * Example:
   *   analytics.report_rows
   *   package.module.symbol
   */
  const qualifiedPattern =
    /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/gu

  for (
    const match of
    taskText.matchAll(
      qualifiedPattern,
    )
  ) {
    const value =
      match[0]

    pushAnchor(
      anchors,
      seen,
      {
        kind:
          "qualified_identifier",

        value,

        index:
          match.index,
      },
    )

    const parts =
      value.split(".")

    const tail =
      parts.at(-1)

    /*
     * Tail is source-backed by the explicit qualified identifier,
     * not inferred from model output.
     */
    if (
      typeof tail === "string" &&
      tail.includes("_")
    ) {
      pushAnchor(
        anchors,
        seen,
        {
          kind:
            "identifier",

          value:
            tail,

          index:
            match.index +
            value.lastIndexOf(tail),

          derivedFrom:
            value,
        },
      )
    }
  }

  /*
   * Code-like identifiers only.
   *
   * Requiring "_" prevents ordinary prose words from becoming
   * authoritative graph seeds.
   *
   * Examples:
   *   report_date
   *   rd_report_rows
   *   user_id
   */
  const identifierPattern =
    /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/gu

  for (
    const match of
    taskText.matchAll(
      identifierPattern,
    )
  ) {
    const value =
      match[0]

    if (!value.includes("_")) {
      continue
    }

    pushAnchor(
      anchors,
      seen,
      {
        kind:
          "identifier",

        value,

        index:
          match.index,
      },
    )
  }

  /*
   * Explicit constant-like identifiers.
   * Observation only: no graph/localization/mutation authority by itself.
   */
  const constantIdentifierPattern =
    /\b[A-Z][A-Z0-9_]{2,79}\b/gu

  for (
    const match of
    taskText.matchAll(
      constantIdentifierPattern,
    )
  ) {
    pushAnchor(
      anchors,
      seen,
      {
        kind:
          "constant_identifier",

        value:
          match[0],

        index:
          match.index,
      },
    )
  }

  /*
   * Artifact extension is useful task telemetry,
   * but deliberately has no graph seed authority.
   */
  const extensionPattern =
    /\.[A-Za-z0-9]{2,8}\b/gu

  for (
    const match of
    taskText.matchAll(
      extensionPattern,
    )
  ) {
    pushAnchor(
      anchors,
      seen,
      {
        kind:
          "artifact_extension",

        value:
          match[0].toLowerCase(),

        index:
          match.index,
      },
    )
  }

  anchors.sort(
    (a, b) =>
      a.index - b.index ||
      a.kind.localeCompare(b.kind) ||
      a.value.localeCompare(b.value),
  )

  const selected =
    anchors.slice(
      0,
      TASK_ANCHOR_MAX,
    )

  return Object.freeze({
    protocol:
      TASK_ANCHOR_PROTOCOL,

    status:
      "compiled",

    authority:
      TASK_ANCHOR_AUTHORITY,

    task_sha256:
      taskSha256.toLowerCase(),

    anchors:
      selected.map(
        (item) =>
          Object.freeze(item),
      ),

    truncated:
      anchors.length >
      TASK_ANCHOR_MAX,

    reason:
      "deterministic_task_anchors",
  })
}
