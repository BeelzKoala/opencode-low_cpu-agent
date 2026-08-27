import {
  makeEdgeCandidate,
  makeWitness,
  regexMatches,
} from "./framework-adapter-v1.mjs"

export const FASTAPI_PYDANTIC_ADAPTER_ID =
  "fastapi-pydantic-adapter-v1"

function pythonSource(path) {
  return /\.py$/i.test(path)
}

export const fastapiPydanticAdapter = Object.freeze({
  id: FASTAPI_PYDANTIC_ADAPTER_ID,
  framework: "fastapi-pydantic",

  detect({ sourcePath, text }) {
    if (!pythonSource(sourcePath)) return { matched: false }

    return {
      matched:
        /(?:from\s+fastapi\s+import|import\s+fastapi|APIRouter\s*\(|FastAPI\s*\(|from\s+pydantic\s+import|BaseModel\b)/m.test(
          text,
        ),
    }
  },

  inspect({ sourcePath, text }) {
    const witnesses = []
    const edge_candidates = []

    const routePattern =
      /@([A-Za-z_]\w*)\.(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/giu

    for (const match of regexMatches(routePattern, text)) {
      const method = match[2].toUpperCase()
      const target = match[3]
      const witness = makeWitness({
        adapter: FASTAPI_PYDANTIC_ADAPTER_ID,
        framework: "fastapi-pydantic",
        kind: "route_declaration",
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
          adapter: FASTAPI_PYDANTIC_ADAPTER_ID,
          framework: "fastapi-pydantic",
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

    const schemaPattern =
      /\bclass\s+([A-Za-z_]\w*)\s*\(\s*(?:[A-Za-z_]\w*\.)?BaseModel\s*\)\s*:/gu

    for (const match of regexMatches(schemaPattern, text)) {
      const target = match[1]
      const witness = makeWitness({
        adapter: FASTAPI_PYDANTIC_ADAPTER_ID,
        framework: "fastapi-pydantic",
        kind: "pydantic_schema",
        sourcePath,
        text,
        index: match.index,
        target,
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: FASTAPI_PYDANTIC_ADAPTER_ID,
          framework: "fastapi-pydantic",
          kind: "DEFINES_SCHEMA",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: { kind: "SCHEMA", id: target },
        }),
      )
    }

    const responsePattern =
      /\bresponse_model\s*=\s*([A-Za-z_]\w*)/gu

    for (const match of regexMatches(responsePattern, text)) {
      const target = match[1]
      const witness = makeWitness({
        adapter: FASTAPI_PYDANTIC_ADAPTER_ID,
        framework: "fastapi-pydantic",
        kind: "response_schema",
        sourcePath,
        text,
        index: match.index,
        target,
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: FASTAPI_PYDANTIC_ADAPTER_ID,
          framework: "fastapi-pydantic",
          kind: "USES_SCHEMA",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: { kind: "SCHEMA", id: target },
        }),
      )
    }

    return { witnesses, edge_candidates }
  },
})
