import {
  makeEdgeCandidate,
  makeWitness,
  regexMatches,
} from "./framework-adapter-v1.mjs"

export const DJANGO_ORM_ADAPTER_ID = "django-orm-adapter-v1"

function pythonSource(path) {
  return /\.py$/i.test(path)
}

export const djangoOrmAdapter = Object.freeze({
  id: DJANGO_ORM_ADAPTER_ID,
  framework: "django-orm",

  detect({ sourcePath, text }) {
    if (!pythonSource(sourcePath)) return { matched: false }

    return {
      matched:
        /(?:from\s+django\.|import\s+django|urlpatterns\b|\bmodels\.Model\b|\.objects\.)/m.test(
          text,
        ),
    }
  },

  inspect({ sourcePath, text }) {
    const witnesses = []
    const edge_candidates = []

    const routePattern =
      /\b(path|re_path)\s*\(\s*(?:r)?["']([^"']+)["']\s*,\s*([A-Za-z_][\w.]*)/gu

    for (const match of regexMatches(routePattern, text)) {
      const target = match[2]
      const view = match[3]

      const witness = makeWitness({
        adapter: DJANGO_ORM_ADAPTER_ID,
        framework: "django-orm",
        kind: "route_declaration",
        sourcePath,
        text,
        index: match.index,
        target,
        detail: {
          constructor: match[1],
          view,
        },
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: DJANGO_ORM_ADAPTER_ID,
          framework: "django-orm",
          kind: "DECLARES_ROUTE",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: { kind: "ROUTE", id: target },
        }),
      )
    }

    const renderPattern =
      /\brender\s*\(\s*[^,\n]+,\s*["']([^"']+)["']/gu

    for (const match of regexMatches(renderPattern, text)) {
      const target = match[1]

      const witness = makeWitness({
        adapter: DJANGO_ORM_ADAPTER_ID,
        framework: "django-orm",
        kind: "render_template",
        sourcePath,
        text,
        index: match.index,
        target,
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: DJANGO_ORM_ADAPTER_ID,
          framework: "django-orm",
          kind: "RENDERS_TEMPLATE",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: { kind: "TEMPLATE", id: target },
        }),
      )
    }

    const modelPattern =
      /\bclass\s+([A-Za-z_]\w*)\s*\(\s*(?:[A-Za-z_]\w*\.)?models\.Model\s*\)\s*:/gu

    for (const match of regexMatches(modelPattern, text)) {
      const target = match[1]

      const witness = makeWitness({
        adapter: DJANGO_ORM_ADAPTER_ID,
        framework: "django-orm",
        kind: "django_model",
        sourcePath,
        text,
        index: match.index,
        target,
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: DJANGO_ORM_ADAPTER_ID,
          framework: "django-orm",
          kind: "DEFINES_MODEL",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: { kind: "DATA_MODEL", id: target },
        }),
      )
    }

    const readPattern =
      /\b([A-Za-z_]\w*)\.objects\.(all|filter|get|exclude|values|values_list|first|last|exists|count)\s*\(/gu

    for (const match of regexMatches(readPattern, text)) {
      const target = match[1]

      const witness = makeWitness({
        adapter: DJANGO_ORM_ADAPTER_ID,
        framework: "django-orm",
        kind: "orm_read",
        sourcePath,
        text,
        index: match.index,
        target,
        detail: { operation: match[2] },
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: DJANGO_ORM_ADAPTER_ID,
          framework: "django-orm",
          kind: "READS_MODEL",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: { kind: "DATA_MODEL", id: target },
        }),
      )
    }

    const writePattern =
      /\b([A-Za-z_]\w*)\.objects\.(create|bulk_create|update_or_create|get_or_create)\s*\(/gu

    for (const match of regexMatches(writePattern, text)) {
      const target = match[1]

      const witness = makeWitness({
        adapter: DJANGO_ORM_ADAPTER_ID,
        framework: "django-orm",
        kind: "orm_write",
        sourcePath,
        text,
        index: match.index,
        target,
        detail: { operation: match[2] },
      })

      witnesses.push(witness)

      edge_candidates.push(
        makeEdgeCandidate({
          adapter: DJANGO_ORM_ADAPTER_ID,
          framework: "django-orm",
          kind: "WRITES_MODEL",
          sourcePath,
          witness,
          from: { kind: "FILE", id: sourcePath },
          to: { kind: "DATA_MODEL", id: target },
        }),
      )
    }

    return { witnesses, edge_candidates }
  },
})
