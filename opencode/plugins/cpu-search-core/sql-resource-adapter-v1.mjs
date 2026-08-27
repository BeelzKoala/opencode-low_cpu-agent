import {
  makeResourceEdgeCandidate,
  makeResourceWitness,
  resourceRegexMatches,
} from "./resource-adapter-v1.mjs"

export const SQL_RESOURCE_ADAPTER_ID =
  "sql-resource-adapter-v1"

function maskSqlNonCode(text) {
  const chars = [...text]
  let state = "code"

  for (
    let i = 0;
    i < chars.length;
    i += 1
  ) {
    const c = chars[i]
    const n = chars[i + 1]

    if (state === "line_comment") {
      if (c === "\n") {
        state = "code"
      } else {
        chars[i] = " "
      }
      continue
    }

    if (state === "block_comment") {
      if (c === "*" && n === "/") {
        chars[i] = " "
        chars[i + 1] = " "
        i += 1
        state = "code"
      } else if (c !== "\n") {
        chars[i] = " "
      }
      continue
    }

    if (state === "single_string") {
      if (
        c === "'" &&
        n === "'"
      ) {
        chars[i] = " "
        chars[i + 1] = " "
        i += 1
        continue
      }

      if (c === "'") {
        chars[i] = " "
        state = "code"
      } else if (c !== "\n") {
        chars[i] = " "
      }

      continue
    }

    if (c === "-" && n === "-") {
      chars[i] = " "
      chars[i + 1] = " "
      i += 1
      state = "line_comment"
      continue
    }

    if (c === "/" && n === "*") {
      chars[i] = " "
      chars[i + 1] = " "
      i += 1
      state = "block_comment"
      continue
    }

    if (c === "'") {
      chars[i] = " "
      state = "single_string"
    }
  }

  return chars.join("")
}

function normalizeIdentifier(raw) {
  return raw
    .replace(/\s+/gu, "")
    .split(".")
    .map((part) =>
      part.startsWith('"') &&
      part.endsWith('"')
        ? part.slice(1, -1)
        : part,
    )
    .join(".")
}

const IDENT =
  '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\\s*\\.\\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)){0,2}'

const SPECS = Object.freeze([
  Object.freeze({
    kind:
      "READS_DATA_RESOURCE",
    operation:
      "from",
    regex:
      new RegExp(
        `\\bFROM\\s+(${IDENT})`,
        "giu",
      ),
  }),

  Object.freeze({
    kind:
      "READS_DATA_RESOURCE",
    operation:
      "join",
    regex:
      new RegExp(
        `\\bJOIN\\s+(${IDENT})`,
        "giu",
      ),
  }),

  Object.freeze({
    kind:
      "WRITES_DATA_RESOURCE",
    operation:
      "insert",
    regex:
      new RegExp(
        `\\bINSERT\\s+INTO\\s+(${IDENT})`,
        "giu",
      ),
  }),

  Object.freeze({
    kind:
      "WRITES_DATA_RESOURCE",
    operation:
      "update",
    regex:
      new RegExp(
        `\\bUPDATE\\s+(${IDENT})`,
        "giu",
      ),
  }),

  Object.freeze({
    kind:
      "WRITES_DATA_RESOURCE",
    operation:
      "delete",
    regex:
      new RegExp(
        `\\bDELETE\\s+FROM\\s+(${IDENT})`,
        "giu",
      ),
  }),
])

export const sqlResourceAdapter =
  Object.freeze({
    id:
      SQL_RESOURCE_ADAPTER_ID,

    family:
      "sql-resource",

    detect({ sourcePath }) {
      return {
        matched:
          /\.(?:sql|ddl)$/iu
            .test(sourcePath),
      }
    },

    inspect({
      sourcePath,
      text,
    }) {
      const witnesses = []
      const edge_candidates = []

      const clean =
        maskSqlNonCode(text)

      for (const spec of SPECS) {
        for (
          const match of
          resourceRegexMatches(
            spec.regex,
            clean,
          )
        ) {
          const target =
            normalizeIdentifier(
              match[1],
            )

          const witness =
            makeResourceWitness({
              adapter:
                SQL_RESOURCE_ADAPTER_ID,
              family:
                "sql-resource",
              kind:
                "sql_table_reference",
              sourcePath,
              text,
              index:
                match.index,
              target,
              detail: {
                operation:
                  spec.operation,
              },

              // A real .sql/.ddl statement after
              // comment/string masking.
              validated: true,
              validation:
                "sql_file_token",
            })

          witnesses.push(witness)

          edge_candidates.push(
            makeResourceEdgeCandidate({
              adapter:
                SQL_RESOURCE_ADAPTER_ID,
              family:
                "sql-resource",
              kind:
                spec.kind,
              sourcePath,
              witness,
              from: {
                kind:
                  "FILE",
                id:
                  sourcePath,
              },
              to: {
                kind:
                  "DATA_RESOURCE",
                id:
                  target,
              },
            }),
          )
        }
      }

      return {
        witnesses,
        edge_candidates,
      }
    },
  })
