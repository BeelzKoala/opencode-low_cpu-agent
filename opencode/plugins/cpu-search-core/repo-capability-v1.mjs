
export const REPO_CAPABILITY_PROTOCOL =
  "repo-capability-v1"

export const REPO_CAPABILITY_AUTHORITY =
  "routing_observation_only"

export const SOURCE_FAMILY_PLAN_PROTOCOL =
  "source-family-plan-v1"

const EXTENSION_CAPABILITIES = Object.freeze({
  py: Object.freeze({
    language: "python",
    source_families: Object.freeze([
      "server_code",
      "test_code",
    ]),
  }),
  pyi: Object.freeze({
    language: "python",
    source_families: Object.freeze([
      "server_code",
    ]),
  }),

  js: Object.freeze({
    language: "javascript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),
  jsx: Object.freeze({
    language: "javascript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),
  mjs: Object.freeze({
    language: "javascript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),
  cjs: Object.freeze({
    language: "javascript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),

  ts: Object.freeze({
    language: "typescript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),
  tsx: Object.freeze({
    language: "typescript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),
  mts: Object.freeze({
    language: "typescript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),
  cts: Object.freeze({
    language: "typescript",
    source_families: Object.freeze([
      "server_code",
      "client_code",
      "test_code",
    ]),
  }),

  html: Object.freeze({
    language: "html",
    source_families: Object.freeze([
      "ui_resource",
    ]),
  }),
  htm: Object.freeze({
    language: "html",
    source_families: Object.freeze([
      "ui_resource",
    ]),
  }),

  css: Object.freeze({
    language: "css",
    source_families: Object.freeze([
      "style_resource",
    ]),
  }),
  scss: Object.freeze({
    language: "css",
    source_families: Object.freeze([
      "style_resource",
    ]),
  }),
  sass: Object.freeze({
    language: "css",
    source_families: Object.freeze([
      "style_resource",
    ]),
  }),
  less: Object.freeze({
    language: "css",
    source_families: Object.freeze([
      "style_resource",
    ]),
  }),

  xml: Object.freeze({
    language: "xml",
    source_families: Object.freeze([
      "config_resource",
    ]),
  }),

  sql: Object.freeze({
    language: "sql",
    source_families: Object.freeze([
      "data_query",
      "data_schema",
    ]),
  }),
})

function finiteCount(value) {
  return Number.isSafeInteger(value) && value > 0
    ? value
    : 0
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .filter(
          (value) =>
            typeof value === "string" &&
            value.length > 0,
        )
        .map((value) => value.toLowerCase()),
    ),
  ].sort()
}

function familySetForExtensions(profile, extensions) {
  const out = new Set()

  for (const extension of extensions) {
    const record =
      profile?.extension_capabilities?.[extension]

    for (const family of record?.source_families ?? []) {
      out.add(family)
    }
  }

  return out
}

function preferredObservedFamily(obligation, profile) {
  const candidates =
    Array.isArray(obligation?.source_families)
      ? obligation.source_families
      : []

  for (let index = 0; index < candidates.length; index += 1) {
    const family = candidates[index]
    const observed =
      profile?.source_families?.[family]

    if (
      Array.isArray(observed?.extensions) &&
      observed.extensions.length > 0
    ) {
      /*
       * On a partial inventory, observing a lower-priority family does not
       * prove that a preferred family is absent beyond the scan cap.
       */
      if (
        profile?.inventory_complete !== true &&
        index > 0
      ) {
        return null
      }

      return family
    }
  }

  return null
}

function roleCovered(obligation, families, profile) {
  const preferred =
    preferredObservedFamily(obligation, profile)

  return preferred != null && families.has(preferred)
}

function familyPreference(family, obligations) {
  let best = Number.POSITIVE_INFINITY

  for (const obligation of obligations) {
    const families =
      Array.isArray(obligation?.source_families)
        ? obligation.source_families
        : []

    const index = families.indexOf(family)

    if (index >= 0 && index < best) {
      best = index
    }
  }

  return best
}

export function compileRepoCapabilityProfile({
  inventoryProtocol = null,
  complete = false,
  files = 0,
  extensions = {},
} = {}) {
  const normalizedExtensions = {}
  const extensionCapabilities = {}
  const languages = new Map()
  const families = new Map()

  for (
    const [rawExtension, rawCount]
    of Object.entries(
      extensions && typeof extensions === "object"
        ? extensions
        : {},
    ).sort(([a], [b]) => a.localeCompare(b))
  ) {
    const extension = rawExtension.toLowerCase()
    const count = finiteCount(rawCount)
    const capability = EXTENSION_CAPABILITIES[extension]

    if (!capability || count < 1) continue

    normalizedExtensions[extension] = count

    extensionCapabilities[extension] = {
      language: capability.language,
      source_families: [...capability.source_families],
      observed_files: count,
    }

    let language = languages.get(capability.language)

    if (!language) {
      language = {
        extensions: new Set(),
        observed_files: 0,
      }
      languages.set(capability.language, language)
    }

    language.extensions.add(extension)
    language.observed_files += count

    for (const familyName of capability.source_families) {
      let family = families.get(familyName)

      if (!family) {
        family = {
          extensions: new Set(),
          observed_files: 0,
        }
        families.set(familyName, family)
      }

      family.extensions.add(extension)
      family.observed_files += count
    }
  }

  const languageObject = {}
  for (
    const [name, record]
    of [...languages.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ) {
    languageObject[name] = {
      extensions: [...record.extensions].sort(),
      observed_files: record.observed_files,
    }
  }

  const familyObject = {}
  for (
    const [name, record]
    of [...families.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ) {
    familyObject[name] = {
      extensions: [...record.extensions].sort(),
      observed_files: record.observed_files,
    }
  }

  return {
    protocol: REPO_CAPABILITY_PROTOCOL,
    authority: REPO_CAPABILITY_AUTHORITY,
    routing_only: true,

    inventory_protocol:
      typeof inventoryProtocol === "string"
        ? inventoryProtocol
        : null,

    inventory_complete: complete === true,
    inventory_files: finiteCount(files),
    inventory_extensions: normalizedExtensions,

    /*
     * Presence observations remain useful on a partial inventory.
     * Absence is authoritative only after a complete inventory.
     */
    absence_claims_allowed: complete === true,

    extension_capabilities: extensionCapabilities,
    languages: languageObject,
    source_families: familyObject,
  }
}

export function planTaskSourceFamilies({
  taskRequirements = null,
  profile = null,
  requestedExtensions = [],
  maxExtensions = 12,
} = {}) {
  const requested = uniqueStrings(requestedExtensions)
  const limit =
    Number.isSafeInteger(maxExtensions) &&
    maxExtensions > 0
      ? maxExtensions
      : 12

  const obligations =
    taskRequirements?.status === "compiled" &&
    Array.isArray(taskRequirements?.obligations)
      ? taskRequirements.obligations.filter(
          (item) =>
            item?.required === true &&
            typeof item?.role === "string" &&
            Array.isArray(item?.source_families) &&
            item.source_families.length > 0,
        )
      : []

  const base = {
    protocol: SOURCE_FAMILY_PLAN_PROTOCOL,
    authority: REPO_CAPABILITY_AUTHORITY,
    routing_only: true,

    requested_extensions: requested,
    effective_extensions: requested,

    required_roles:
      obligations.map((item) => item.role).sort(),

    initially_covered_roles: [],
    resolved_roles: [],
    unresolved_roles:
      obligations.map((item) => item.role).sort(),

    selected_families: [],
    added_extensions: [],

    applied: false,
    reason: null,
  }

  if (obligations.length < 1) {
    return {
      ...base,
      unresolved_roles: [],
      reason: "no_task_role_obligations",
    }
  }

  if (requested.length < 1) {
    return {
      ...base,
      reason: "source_glob_not_simple_language_glob",
    }
  }

  if (
    profile?.protocol !== REPO_CAPABILITY_PROTOCOL ||
    profile?.routing_only !== true
  ) {
    return {
      ...base,
      reason: "repo_capability_unavailable",
    }
  }

  const initialFamilies =
    familySetForExtensions(profile, requested)

  const initiallyCovered =
    obligations.filter((item) =>
      roleCovered(item, initialFamilies, profile)
    )

  let missing =
    obligations.filter((item) =>
      !roleCovered(item, initialFamilies, profile)
    )

  if (missing.length < 1) {
    const roles =
      initiallyCovered.map((item) => item.role).sort()

    return {
      ...base,
      initially_covered_roles: roles,
      resolved_roles: roles,
      unresolved_roles: [],
      reason: "task_roles_already_covered",
    }
  }

  const effective = new Set(requested)
  const selectedFamilies = []
  let activeFamilies =
    familySetForExtensions(profile, [...effective])

  while (missing.length > 0) {
    const candidates = []

    for (
      const [family, record]
      of Object.entries(profile.source_families ?? {})
    ) {
      if (activeFamilies.has(family)) continue

      const extensions =
        uniqueStrings(record?.extensions)

      if (extensions.length < 1) continue

      const covered =
        missing.filter(
          (item) =>
            preferredObservedFamily(item, profile) === family,
        )

      if (covered.length < 1) continue

      candidates.push({
        family,
        extensions,
        coverage: covered.length,
        preference:
          familyPreference(family, missing),
      })
    }

    candidates.sort(
      (a, b) =>
        b.coverage - a.coverage ||
        a.preference - b.preference ||
        a.family.localeCompare(b.family),
    )

    const winner = candidates[0]
    if (!winner) break

    const projected =
      new Set([
        ...effective,
        ...winner.extensions,
      ])

    /*
     * No partial extension-family truncation. If the complete
     * observed family cannot fit, retain the original search scope.
     */
    if (projected.size > limit) {
      return {
        ...base,
        initially_covered_roles:
          initiallyCovered
            .map((item) => item.role)
            .sort(),
        resolved_roles:
          initiallyCovered
            .map((item) => item.role)
            .sort(),
        unresolved_roles:
          missing.map((item) => item.role).sort(),
        reason: "source_family_extension_budget",
      }
    }

    for (const extension of winner.extensions) {
      effective.add(extension)
    }

    selectedFamilies.push(winner.family)

    activeFamilies =
      familySetForExtensions(profile, [...effective])

    missing =
      obligations.filter((item) =>
        !roleCovered(item, activeFamilies, profile)
      )
  }

  const resolved =
    obligations.filter((item) =>
      roleCovered(item, activeFamilies, profile)
    )

  const effectiveExtensions = [...effective].sort()
  const addedExtensions =
    effectiveExtensions.filter(
      (extension) => !requested.includes(extension),
    )

  if (addedExtensions.length < 1) {
    return {
      ...base,
      initially_covered_roles:
        initiallyCovered.map((item) => item.role).sort(),
      resolved_roles:
        resolved.map((item) => item.role).sort(),
      unresolved_roles:
        missing.map((item) => item.role).sort(),
      reason: "no_observed_family_can_expand_scope",
    }
  }

  return {
    ...base,

    initially_covered_roles:
      initiallyCovered.map((item) => item.role).sort(),

    resolved_roles:
      resolved.map((item) => item.role).sort(),

    unresolved_roles:
      missing.map((item) => item.role).sort(),

    selected_families: [...selectedFamilies],
    added_extensions: addedExtensions,
    effective_extensions: effectiveExtensions,

    applied: true,
    reason:
      missing.length > 0
        ? "task_role_source_family_partially_broadened"
        : "task_role_source_family_broadened",
  }
}
