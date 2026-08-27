import {
  makeEdgeCandidate,
  makeWitness,
  regexMatches,
} from "./framework-adapter-v1.mjs"

export const TYPESCRIPT_WEB_ADAPTER_ID =
  "typescript-web-adapter-v1"

function jsTsSource(path) {
  return /\.(?:[cm]?[jt]sx?)$/i.test(path)
}

function nextRouteFromPath(sourcePath) {
  const normalized = sourcePath.replaceAll("\\", "/")

  const match = normalized.match(
    /(?:^|\/)app\/api\/(.+)\/route\.(?:[cm]?[jt]sx?)$/i,
  )

  if (!match) return null

  return `/api/${match[1]}`
}

export const typescriptWebAdapter = Object.freeze({
  id: TYPESCRIPT_WEB_ADAPTER_ID,
  framework: "typescript-web",

  detect({ sourcePath, text }) {
    if (!jsTsSource(sourcePath)) return { matched: false }

    return {
      matched:
        /(?:\bexpress\b|\bRouter\s*\(|\bNestFactory\b|@Controller\s*\(|@(Get|Post|Put|Patch|Delete)\s*\(|(?:^|\/)app\/api\/.+\/route\.)/m.test(
          `${sourcePath}\n${text}`,
        ),
    }
  },

  inspect({ sourcePath, text }) {
    const witnesses = []
    const edge_candidates = []

    const expressPattern =
      /\b(app|router)\.(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/giu

    for (const match of regexMatches(expressPattern, text)) {
      const method = match[2].toUpperCase()
      const target = match[3]

      const witness = makeWitness({
        adapter: TYPESCRIPT_WEB_ADAPTER_ID,
        framework: "typescript-web",
        kind: "express_route",
        sourcePath,
        text,
        index: match.index,
        target,
        detail: {
          owner: match[1],
          method,
        },
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: TYPESCRIPT_WEB_ADAPTER_ID,
          framework: "typescript-web",
          kind: "DECLARES_ROUTE",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: {
            kind: "ROUTE",
            id: `${method} ${target}`,
          },
        }),
      )
    }

    const controllerPattern =
      /@Controller\s*\(\s*["'`]([^"'`]*)["'`]\s*\)/gu

    for (const match of regexMatches(controllerPattern, text)) {
      const target = match[1]

      const witness = makeWitness({
        adapter: TYPESCRIPT_WEB_ADAPTER_ID,
        framework: "typescript-web",
        kind: "nest_controller",
        sourcePath,
        text,
        index: match.index,
        target,
      })

      witnesses.push(witness)
    }

    const nestRoutePattern =
      /@(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`]*)["'`]\s*\)/gu

    for (const match of regexMatches(nestRoutePattern, text)) {
      const method = match[1].toUpperCase()
      const target = match[2]

      const witness = makeWitness({
        adapter: TYPESCRIPT_WEB_ADAPTER_ID,
        framework: "typescript-web",
        kind: "nest_route",
        sourcePath,
        text,
        index: match.index,
        target,
        detail: { method },
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: TYPESCRIPT_WEB_ADAPTER_ID,
          framework: "typescript-web",
          kind: "DECLARES_ROUTE",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: {
            kind: "ROUTE",
            id: `${method} ${target}`,
          },
        }),
      )
    }

    const nextRoute = nextRouteFromPath(sourcePath)

    if (nextRoute) {
      const nextHandlerPattern =
        /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/gu

      for (const match of regexMatches(nextHandlerPattern, text)) {
        const method = match[1].toUpperCase()

        const witness = makeWitness({
          adapter: TYPESCRIPT_WEB_ADAPTER_ID,
          framework: "typescript-web",
          kind: "next_route_handler",
          sourcePath,
          text,
          index: match.index,
          target: nextRoute,
          detail: { method },
        })

        witnesses.push(witness)

        edge_candidates.push(
          makeEdgeCandidate({
            adapter: TYPESCRIPT_WEB_ADAPTER_ID,
            framework: "typescript-web",
            kind: "DECLARES_ROUTE",
            sourcePath,
            witness,
            from: { kind: "FILE", id: sourcePath },
            to: {
              kind: "ROUTE",
              id: `${method} ${nextRoute}`,
            },
          }),
        )
      }
    }

    return { witnesses, edge_candidates }
  },
})
