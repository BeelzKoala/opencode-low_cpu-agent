import {
  makeResourceEdgeCandidate,
  makeResourceWitness,
  resourceRegexMatches,
} from "./resource-adapter-v1.mjs"

export const VUE_SFC_ADAPTER_ID =
  "vue-sfc-adapter-v1"

function localRoute(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("{{") &&
    !value.includes("${")
  )
}

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

function maskComments(text) {
  return text
    .replace(
      /<!--[\s\S]*?-->/gu,
      (match) =>
        match.replace(/[^\n]/g, " "),
    )
    .replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
      (match) =>
        match.replace(/[^\n]/g, " "),
    )
}

function append({
  witnesses,
  edgeCandidates,
  sourcePath,
  text,
  index,
  kind,
  edgeKind,
  target,
}) {
  if (!localRoute(target)) {
    return
  }

  const witness =
    makeResourceWitness({
      adapter:
        VUE_SFC_ADAPTER_ID,
      family:
        "vue-sfc",
      kind,
      sourcePath,
      text,
      index,
      target,
    })

  witnesses.push(witness)

  edgeCandidates.push(
    makeResourceEdgeCandidate({
      adapter:
        VUE_SFC_ADAPTER_ID,
      family:
        "vue-sfc",
      kind:
        edgeKind,
      sourcePath,
      witness,
      from:
        fileNode(sourcePath),
      to:
        routeNode(target),
    }),
  )
}

export const vueSfcAdapter =
  Object.freeze({
    id:
      VUE_SFC_ADAPTER_ID,

    family:
      "vue-sfc",

    detect({ sourcePath }) {
      return {
        matched:
          /\.vue$/iu.test(sourcePath),
      }
    },

    inspect({
      sourcePath,
      text,
    }) {
      const witnesses = []
      const edge_candidates = []

      const clean =
        maskComments(text)

      const patterns = [
        {
          regex:
            /<(?:router-link|RouterLink)\b[^>]*\bto\s*=\s*(["'])(\/(?!\/)[^"']*)\1/giu,
          kind:
            "vue_router_link",
          edgeKind:
            "TARGETS_ROUTE",
          target: 2,
        },
        {
          regex:
            /<a\b[^>]*\bhref\s*=\s*(["'])(\/(?!\/)[^"']*)\1/giu,
          kind:
            "vue_link",
          edgeKind:
            "TARGETS_ROUTE",
          target: 2,
        },
        {
          regex:
            /<form\b[^>]*\baction\s*=\s*(["'])(\/(?!\/)[^"']*)\1/giu,
          kind:
            "vue_form",
          edgeKind:
            "TARGETS_ROUTE",
          target: 2,
        },
        {
          regex:
            /\bfetch\s*\(\s*(["'`])(\/(?!\/)[^"'`\\]*)\1/giu,
          kind:
            "vue_fetch",
          edgeKind:
            "FETCHES_ROUTE",
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
          append({
            witnesses,
            edgeCandidates:
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

      return {
        witnesses,
        edge_candidates,
      }
    },
  })
