import {
  makeResourceEdgeCandidate,
  makeResourceWitness,
  resourceRegexMatches,
} from "./resource-adapter-v1.mjs"

export const REACT_JSX_ROUTER_ADAPTER_ID =
  "react-jsx-router-adapter-v1"

function localRoute(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
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

function commentMasked(text) {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
    (match) =>
      match.replace(/[^\n]/g, " "),
  )
}

export const reactJsxRouterAdapter =
  Object.freeze({
    id:
      REACT_JSX_ROUTER_ADAPTER_ID,

    family:
      "react-jsx-router",

    detect({ sourcePath, text }) {
      if (!/\.[jt]sx$/iu.test(sourcePath)) {
        return { matched: false }
      }

      return {
        matched:
          /(?:react-router|<Route\b|<Link\b|<NavLink\b|\bfetch\s*\()/u
            .test(text),
      }
    },

    inspect({
      sourcePath,
      text,
    }) {
      const witnesses = []
      const edge_candidates = []

      const clean =
        commentMasked(text)

      for (
        const match of
        resourceRegexMatches(
          /<Route\b[^>]*>/giu,
          clean,
        )
      ) {
        const tag = match[0]

        const pathMatch =
          tag.match(
            /\bpath\s*=\s*(["'])(\/(?!\/)[^"']*)\1/iu,
          )

        if (
          !pathMatch ||
          !localRoute(pathMatch[2])
        ) {
          continue
        }

        const route =
          pathMatch[2]

        const witness =
          makeResourceWitness({
            adapter:
              REACT_JSX_ROUTER_ADAPTER_ID,
            family:
              "react-jsx-router",
            kind:
              "react_route",
            sourcePath,
            text,
            index:
              match.index,
            target:
              route,
          })

        witnesses.push(witness)

        edge_candidates.push(
          makeResourceEdgeCandidate({
            adapter:
              REACT_JSX_ROUTER_ADAPTER_ID,
            family:
              "react-jsx-router",
            kind:
              "DECLARES_ROUTE",
            sourcePath,
            witness,
            from:
              fileNode(sourcePath),
            to:
              routeNode(route),
          }),
        )

        const component =
          tag.match(
            /\belement\s*=\s*\{\s*<([A-Z][A-Za-z0-9_.]*)\b/u,
          )

        if (component) {
          const componentWitness =
            makeResourceWitness({
              adapter:
                REACT_JSX_ROUTER_ADAPTER_ID,
              family:
                "react-jsx-router",
              kind:
                "route_component",
              sourcePath,
              text,
              index:
                match.index,
              target:
                component[1],
              detail: {
                route,
              },
            })

          witnesses.push(
            componentWitness,
          )

          edge_candidates.push(
            makeResourceEdgeCandidate({
              adapter:
                REACT_JSX_ROUTER_ADAPTER_ID,
              family:
                "react-jsx-router",
              kind:
                "ROUTE_TO_COMPONENT",
              sourcePath,
              witness:
                componentWitness,
              from:
                routeNode(route),
              to: {
                kind:
                  "COMPONENT",
                id:
                  component[1],
              },
            }),
          )
        }
      }

      for (
        const match of
        resourceRegexMatches(
          /<(?:Link|NavLink)\b[^>]*\bto\s*=\s*(["'])(\/(?!\/)[^"']*)\1/giu,
          clean,
        )
      ) {
        if (!localRoute(match[2])) {
          continue
        }

        const witness =
          makeResourceWitness({
            adapter:
              REACT_JSX_ROUTER_ADAPTER_ID,
            family:
              "react-jsx-router",
            kind:
              "react_link",
            sourcePath,
            text,
            index:
              match.index,
            target:
              match[2],
          })

        witnesses.push(witness)

        edge_candidates.push(
          makeResourceEdgeCandidate({
            adapter:
              REACT_JSX_ROUTER_ADAPTER_ID,
            family:
              "react-jsx-router",
            kind:
              "TARGETS_ROUTE",
            sourcePath,
            witness,
            from:
              fileNode(sourcePath),
            to:
              routeNode(match[2]),
          }),
        )
      }

      for (
        const match of
        resourceRegexMatches(
          /\bfetch\s*\(\s*(["'`])(\/(?!\/)[^"'`\\]*)\1/giu,
          clean,
        )
      ) {
        if (!localRoute(match[2])) {
          continue
        }

        const witness =
          makeResourceWitness({
            adapter:
              REACT_JSX_ROUTER_ADAPTER_ID,
            family:
              "react-jsx-router",
            kind:
              "react_fetch",
            sourcePath,
            text,
            index:
              match.index,
            target:
              match[2],
          })

        witnesses.push(witness)

        edge_candidates.push(
          makeResourceEdgeCandidate({
            adapter:
              REACT_JSX_ROUTER_ADAPTER_ID,
            family:
              "react-jsx-router",
            kind:
              "FETCHES_ROUTE",
            sourcePath,
            witness,
            from:
              fileNode(sourcePath),
            to:
              routeNode(match[2]),
          }),
        )
      }

      return {
        witnesses,
        edge_candidates,
      }
    },
  })
