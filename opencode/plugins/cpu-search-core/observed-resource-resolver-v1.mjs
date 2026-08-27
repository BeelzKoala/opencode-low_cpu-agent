import path from "node:path"

export const OBSERVED_RESOURCE_RESOLVER_PROTOCOL =
  "observed-resource-resolver-v1"

function normalizePath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1
  ) {
    return null
  }

  const normalized =
    value
      .replaceAll("\\", "/")
      .replace(/^\.\/+/u, "")

  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    return null
  }

  const parts =
    normalized.split("/")

  if (
    parts.some(
      (part) =>
        part === ".." ||
        part.length < 1,
    )
  ) {
    return null
  }

  return parts.join("/")
}

export function resolveObservedResource({
  target,
  sourcePath = null,
  observedFiles = [],
  resourceRoots = [],
  inventoryComplete = false,
} = {}) {
  const normalizedTarget =
    normalizePath(target)

  if (
    !normalizedTarget ||
    target.includes("{{") ||
    target.includes("{%") ||
    target.includes("${")
  ) {
    return Object.freeze({
      protocol:
        OBSERVED_RESOURCE_RESOLVER_PROTOCOL,

      authority:
        "routing_resolution_only",

      mutation_authority:
        false,

      status:
        "invalid",

      target:
        target ?? null,

      resolved_file:
        null,

      candidates: [],
    })
  }

  const observed =
    new Set(
      observedFiles
        .map(normalizePath)
        .filter(Boolean),
    )

  const candidates =
    new Set([
      normalizedTarget,
    ])

  const normalizedSource =
    normalizePath(sourcePath)

  if (normalizedSource) {
    const parent =
      path.posix.dirname(
        normalizedSource,
      )

    if (
      parent &&
      parent !== "."
    ) {
      candidates.add(
        path.posix.normalize(
          `${parent}/${normalizedTarget}`,
        ),
      )
    }
  }

  for (const root of resourceRoots) {
    const normalizedRoot =
      normalizePath(root)

    if (!normalizedRoot) {
      continue
    }

    candidates.add(
      path.posix.normalize(
        `${normalizedRoot}/${normalizedTarget}`,
      ),
    )
  }

  const matches =
    [...candidates]
      .filter((candidate) =>
        observed.has(candidate),
      )
      .sort()

  let status

  if (matches.length === 1) {
    status = "resolved"
  } else if (matches.length > 1) {
    status = "ambiguous"
  } else {
    status =
      inventoryComplete
        ? "missing"
        : "unresolved"
  }

  return Object.freeze({
    protocol:
      OBSERVED_RESOURCE_RESOLVER_PROTOCOL,

    authority:
      "routing_resolution_only",

    mutation_authority:
      false,

    status,

    target:
      normalizedTarget,

    resolved_file:
      status === "resolved"
        ? matches[0]
        : null,

    candidates:
      matches,

    inventory_complete:
      inventoryComplete === true,
  })
}
