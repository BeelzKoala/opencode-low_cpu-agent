import {
  makeResourceEdgeCandidate,
  makeResourceWitness,
  resourceRegexMatches,
} from "./resource-adapter-v1.mjs"

export const GENERIC_HTML_JS_ADAPTER_ID =
  "generic-html-js-adapter-v1"

function fileNode(sourcePath) {
  return {
    kind: "FILE",
    id: sourcePath,
  }
}

function routeNode(target) {
  return {
    kind: "ROUTE",
    id: target,
  }
}

function localRoute(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("{{") &&
    !value.includes("{%") &&
    !value.includes("${")
  )
}

function maskRange(text, start, end) {
  return (
    text.slice(0, start) +
    text
      .slice(start, end)
      .replace(/[^\n]/g, " ") +
    text.slice(end)
  )
}

function maskHtmlComments(text) {
  let out = text
  let offset = 0

  while (true) {
    const start =
      out.indexOf("<!--", offset)

    if (start < 0) break

    const close =
      out.indexOf("-->", start + 4)

    const end =
      close < 0
        ? out.length
        : close + 3

    out = maskRange(
      out,
      start,
      end,
    )

    offset = end
  }

  return out
}

function maskJsComments(text) {
  const chars = [...text]

  let state = "code"

  for (let i = 0; i < chars.length; i += 1) {
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

    if (state === "single") {
      if (c === "\\") {
        i += 1
        continue
      }

      if (c === "'") {
        state = "code"
      }

      continue
    }

    if (state === "double") {
      if (c === "\\") {
        i += 1
        continue
      }

      if (c === '"') {
        state = "code"
      }

      continue
    }

    if (state === "template") {
      if (c === "\\") {
        i += 1
        continue
      }

      if (c === "`") {
        state = "code"
      }

      continue
    }

    if (c === "/" && n === "/") {
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
      state = "single"
    } else if (c === '"') {
      state = "double"
    } else if (c === "`") {
      state = "template"
    }
  }

  return chars.join("")
}

function appendRoute({
  witnesses,
  edges,
  sourcePath,
  text,
  index,
  kind,
  edgeKind,
  target,
  detail = null,
}) {
  if (!localRoute(target)) {
    return
  }

  const witness =
    makeResourceWitness({
      adapter:
        GENERIC_HTML_JS_ADAPTER_ID,
      family:
        "generic-html-js",
      kind,
      sourcePath,
      text,
      index,
      target,
      detail,
    })

  witnesses.push(witness)

  edges.push(
    makeResourceEdgeCandidate({
      adapter:
        GENERIC_HTML_JS_ADAPTER_ID,
      family:
        "generic-html-js",
      kind: edgeKind,
      sourcePath,
      witness,
      from:
        fileNode(sourcePath),
      to:
        routeNode(target),
    }),
  )
}

export const genericHtmlJsAdapter =
  Object.freeze({
    id:
      GENERIC_HTML_JS_ADAPTER_ID,

    family:
      "generic-html-js",

    detect({ sourcePath }) {
      return {
        matched:
          /\.(?:html?|[cm]?[jt]s)$/iu
            .test(sourcePath),
      }
    },

    inspect({
      sourcePath,
      text,
    }) {
      const witnesses = []
      const edge_candidates = []

      if (/\.html?$/iu.test(sourcePath)) {
        const clean =
          maskHtmlComments(text)

        const patterns = [
          {
            kind: "html_link",
            edgeKind:
              "TARGETS_ROUTE",
            regex:
              /<a\b[^>]*\bhref\s*=\s*(["'])(\/(?!\/)[^"'<>]*)\1/giu,
            target: 2,
          },
          {
            kind: "html_form",
            edgeKind:
              "TARGETS_ROUTE",
            regex:
              /<form\b[^>]*\baction\s*=\s*(["'])(\/(?!\/)[^"'<>]*)\1/giu,
            target: 2,
          },
        ]

        for (const spec of patterns) {
          for (
            const match of
            resourceRegexMatches(
              spec.regex,
              clean,
            )
          ) {
            appendRoute({
              witnesses,
              edges:
                edge_candidates,
              sourcePath,
              text,
              index:
                match.index,
              kind:
                spec.kind,
              edgeKind:
                spec.edgeKind,
              target:
                match[spec.target],
            })
          }
        }
      }

      if (
        /\.(?:[cm]?[jt]s)$/iu
          .test(sourcePath)
      ) {
        const clean =
          maskJsComments(text)

        for (
          const match of
          resourceRegexMatches(
            /\bfetch\s*\(\s*(["'`])(\/(?!\/)[^"'`\\]*)\1/giu,
            clean,
          )
        ) {
          appendRoute({
            witnesses,
            edges:
              edge_candidates,
            sourcePath,
            text,
            index: match.index,
            kind:
              "fetch_route",
            edgeKind:
              "FETCHES_ROUTE",
            target: match[2],
          })
        }

        for (
          const match of
          resourceRegexMatches(
            /\.open\s*\(\s*(["'`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*(["'`])(\/(?!\/)[^"'`\\]*)\3/giu,
            clean,
          )
        ) {
          appendRoute({
            witnesses,
            edges:
              edge_candidates,
            sourcePath,
            text,
            index: match.index,
            kind:
              "xhr_route",
            edgeKind:
              "FETCHES_ROUTE",
            target: match[4],
            detail: {
              method:
                match[2]
                  .toUpperCase(),
            },
          })
        }
      }

      return {
        witnesses,
        edge_candidates,
      }
    },
  })
