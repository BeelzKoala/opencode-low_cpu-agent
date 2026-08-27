import {
  makeEdgeCandidate,
  makeWitness,
  regexMatches,
} from "./framework-adapter-v1.mjs"

export const FLASK_JINJA_ADAPTER_ID = "flask-jinja-adapter-v1"

function pythonSource(path) {
  return /\.py$/i.test(path)
}

function templateSource(path) {
  return /\.(?:html|jinja|jinja2|j2)$/i.test(path)
}

function fileNode(sourcePath) {
  return {
    kind: "FILE",
    id: sourcePath,
  }
}

export const flaskJinjaAdapter = Object.freeze({
  id: FLASK_JINJA_ADAPTER_ID,
  framework: "flask-jinja",

  detect({ sourcePath, text }) {
    if (pythonSource(sourcePath)) {
      return {
        matched:
          /(?:from\s+flask\s+import|import\s+flask|Blueprint\s*\(|render_template\s*\(|@[A-Za-z_]\w*\.route\s*\()/m.test(
            text,
          ),
      }
    }

    if (templateSource(sourcePath)) {
      return {
        matched:
          /\{%\s*(?:include|extends)\s+["']|\burl_for\s*\(\s*["']/m.test(
            text,
          ),
      }
    }

    return { matched: false }
  },

  inspect({ sourcePath, text }) {
    const witnesses = []
    const edge_candidates = []

    if (pythonSource(sourcePath)) {
      const routePattern =
        /@([A-Za-z_]\w*)\.route\s*\(\s*["']([^"']+)["']/gu

      for (const match of regexMatches(routePattern, text)) {
        const target = match[2]
        const witness = makeWitness({
          adapter: FLASK_JINJA_ADAPTER_ID,
          framework: "flask-jinja",
          kind: "route_declaration",
          sourcePath,
          text,
          index: match.index,
          target,
          detail: { owner: match[1] },
        })

        witnesses.push(witness)
        edge_candidates.push(
          makeEdgeCandidate({
            adapter: FLASK_JINJA_ADAPTER_ID,
            framework: "flask-jinja",
            kind: "DECLARES_ROUTE",
            sourcePath,
            witness,
            from: fileNode(sourcePath),
            to: { kind: "ROUTE", id: target },
          }),
        )
      }

      const renderPattern =
        /\brender_template\s*\(\s*["']([^"']+)["']/gu

      for (const match of regexMatches(renderPattern, text)) {
        const target = match[1]
        const witness = makeWitness({
          adapter: FLASK_JINJA_ADAPTER_ID,
          framework: "flask-jinja",
          kind: "render_template",
          sourcePath,
          text,
          index: match.index,
          target,
        })

        witnesses.push(witness)
        edge_candidates.push(
          makeEdgeCandidate({
            adapter: FLASK_JINJA_ADAPTER_ID,
            framework: "flask-jinja",
            kind: "RENDERS_TEMPLATE",
            sourcePath,
            witness,
            from: fileNode(sourcePath),
            to: { kind: "TEMPLATE", id: target },
          }),
        )
      }
    }

    if (templateSource(sourcePath)) {
      for (const [kind, edgeKind, pattern] of [
        [
          "template_include",
          "INCLUDES_TEMPLATE",
          /\{%\s*include\s+["']([^"']+)["']/gu,
        ],
        [
          "template_extends",
          "EXTENDS_TEMPLATE",
          /\{%\s*extends\s+["']([^"']+)["']/gu,
        ],
        [
          "url_for",
          "URL_FOR_ROUTE",
          /\burl_for\s*\(\s*["']([^"']+)["']/gu,
        ],
      ]) {
        for (const match of regexMatches(pattern, text)) {
          const target = match[1]
          const witness = makeWitness({
            adapter: FLASK_JINJA_ADAPTER_ID,
            framework: "flask-jinja",
            kind,
            sourcePath,
            text,
            index: match.index,
            target,
          })

          witnesses.push(witness)

          edge_candidates.push(
            makeEdgeCandidate({
              adapter: FLASK_JINJA_ADAPTER_ID,
              framework: "flask-jinja",
              kind: edgeKind,
              sourcePath,
              witness,
              from: {
                kind: "TEMPLATE",
                id: sourcePath,
              },
              to:
                edgeKind === "URL_FOR_ROUTE"
                  ? { kind: "ROUTE", id: target }
                  : { kind: "TEMPLATE", id: target },
            }),
          )
        }
      }
    }

    return { witnesses, edge_candidates }
  },
})
