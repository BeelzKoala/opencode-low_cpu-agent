export const DATA_OBLIGATION_PROJECTOR_PROTOCOL =
  "data-obligation-projector-v1"

export const DATA_OBLIGATION_PROJECTOR_AUTHORITY =
  "proof_projection_only"

const DATA_ACCESS_CAPABILITY =
  "data_access_capability"

const SHA256_RE =
  /^[0-9a-f]{64}$/iu

const CONSTANT_RE =
  /^[A-Z][A-Z0-9_]{2,79}$/u

function validSha256(value) {
  return (
    typeof value === "string" &&
    SHA256_RE.test(value)
  )
}

function normalizeFile(value) {
  if (typeof value !== "string") return null
  const normalized =
    value
      .replaceAll("\\\\", "/")
      .replace(/^\.\/+/u, "")
      .replace(/^file:/u, "")
  return normalized.length > 0 ? normalized : null
}

function validProof(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    Number.isSafeInteger(value.line) &&
    value.line >= 1 &&
    validSha256(value.sha256) &&
    typeof value.extractor === "string" &&
    value.extractor.length > 0
  )
}

function taskIdentities(taskAnchors, taskSha256) {
  if (
    taskAnchors?.status !== "compiled" ||
    taskAnchors?.truncated === true ||
    taskAnchors?.task_sha256?.toLowerCase?.() !== taskSha256.toLowerCase()
  ) return []

  return [...new Set((taskAnchors?.anchors ?? [])
    .filter((anchor) =>
      anchor?.kind === "constant_identifier" &&
      typeof anchor?.value === "string" &&
      CONSTANT_RE.test(anchor.value),
    )
    .map((anchor) => anchor.value))].sort()
}

function hostBinding(bindingObservation, providerFile, providerSymbol, hostFile) {
  if (
    bindingObservation?.mode !== "symbol_binding_into_file" ||
    bindingObservation?.ready !== true ||
    bindingObservation?.complete !== true ||
    normalizeFile(bindingObservation?.source_file) !== providerFile ||
    bindingObservation?.source_symbol !== providerSymbol ||
    normalizeFile(bindingObservation?.importer_file) !== hostFile
  ) return null

  return (bindingObservation?.bindings ?? [])
    .filter((row) =>
      normalizeFile(row?.importer) === hostFile &&
      row?.confidence === "exact_local" &&
      Number.isSafeInteger(row?.witness_line) &&
      row.witness_line >= 1,
    )
    .sort((a, b) =>
      a.witness_line - b.witness_line ||
      String(a.local_symbol ?? "").localeCompare(String(b.local_symbol ?? "")),
    )[0] ?? null
}

export function projectDataAccessObligation({
  taskSha256,
  taskAnchors,
  coverageRequirements,
  anchorFrontier,
  providerResolution,
  providerProofs = {},
  bindingByProvider = {},
  bindingProofs = {},
} = {}) {
  const base = {
    protocol: DATA_OBLIGATION_PROJECTOR_PROTOCOL,
    authority: DATA_OBLIGATION_PROJECTOR_AUTHORITY,
    status: "abstained",
    reason: "preconditions_unmet",
    proofs: Object.freeze([]),
    localization_authority: false,
    mutation_authority: false,
  }

  const taskSha = typeof taskSha256 === "string" ? taskSha256.toLowerCase() : null
  if (
    !validSha256(taskSha) ||
    coverageRequirements?.status !== "compiled" ||
    coverageRequirements?.task_sha256?.toLowerCase?.() !== taskSha ||
    !(coverageRequirements?.required_roles ?? []).includes(DATA_ACCESS_CAPABILITY)
  ) return Object.freeze(base)

  const hostFile = normalizeFile(anchorFrontier?.owner_file)
  if (
    anchorFrontier?.status !== "bound" ||
    !hostFile ||
    providerResolution?.mode !== "data_provider_identity" ||
    providerResolution?.ready !== true ||
    providerResolution?.complete !== true
  ) {
    return Object.freeze({...base, reason: "provider_resolution_unavailable"})
  }

  const identities = taskIdentities(taskAnchors, taskSha)
  if (identities.length < 1) {
    return Object.freeze({...base, reason: "task_data_identity_absent"})
  }
  const identitySet = new Set(identities)
  const bound = new Map()

  for (const observation of providerResolution?.observations ?? []) {
    if (
      !identitySet.has(observation?.identity) ||
      observation?.search_complete !== true ||
      observation?.truncated === true
    ) continue

    for (const candidate of observation?.candidates ?? []) {
      if (
        candidate?.configuration_identity !== observation.identity ||
        candidate?.constructor_family !== "python-psycopg2"
      ) continue

      const providerFile = normalizeFile(candidate?.file)
      if (!providerFile || typeof candidate?.symbol !== "string") continue
      const key = [observation.identity, providerFile, candidate.symbol].join("\0")
      const providerProof = providerProofs[key]
      const bindingProof = bindingProofs[key]
      if (!validProof(providerProof) || !validProof(bindingProof)) continue
      if (!hostBinding(bindingByProvider[key], providerFile, candidate.symbol, hostFile)) continue

      bound.set(key, {
        identity: observation.identity,
        providerFile,
        candidate,
        providerProof,
        bindingProof,
      })
    }
  }

  const matches = [...bound.values()].sort((a, b) =>
    a.identity.localeCompare(b.identity) ||
    a.providerFile.localeCompare(b.providerFile) ||
    a.candidate.symbol.localeCompare(b.candidate.symbol),
  )
  if (matches.length < 1) {
    return Object.freeze({...base, reason: "task_bound_provider_unavailable"})
  }

  const selected = matches[0]
  const ambiguous = matches.length > 1
  const descriptor = Object.freeze({
    obligation: DATA_ACCESS_CAPABILITY,
    basis: "task_causal_path",
    source_proof: selected.providerProof,
    causal_path: Object.freeze([
      Object.freeze({
        validated: true,
        from: `symbol:${selected.providerFile}#${selected.candidate.symbol}`,
        to: `file:${hostFile}`,
        kind: "provider_binding_into_task_host",
        witness: selected.bindingProof,
      }),
    ]),
    ambiguous,
    detail: Object.freeze({
      producer: DATA_OBLIGATION_PROJECTOR_PROTOCOL,
      task_identity: selected.identity,
      provider_file: selected.providerFile,
      provider_symbol: selected.candidate.symbol,
      constructor_family: selected.candidate.constructor_family,
      constructor: selected.candidate.constructor,
      task_host: hostFile,
      matching_bound_providers: Object.freeze(matches.map((item) => Object.freeze({
        identity: item.identity,
        file: item.providerFile,
        symbol: item.candidate.symbol,
      }))),
    }),
  })

  return Object.freeze({
    ...base,
    status: ambiguous ? "ambiguous" : "proofs_projected",
    reason: ambiguous ? "multiple_task_bound_providers" : "unique_task_bound_provider",
    proofs: Object.freeze([descriptor]),
  })
}
