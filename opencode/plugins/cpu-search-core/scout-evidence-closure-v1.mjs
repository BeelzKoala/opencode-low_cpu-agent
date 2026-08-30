import {
  solveObligationCoverage,
} from "./obligation-coverage-v1.mjs"

import {
  RESOURCE_EDGE_KIND,
} from "./resource-graph-v1.mjs"


export const SCOUT_EVIDENCE_CLOSURE_PROTOCOL =
  "scout-evidence-closure-v1"

export const SCOUT_EVIDENCE_CLOSURE_AUTHORITY =
  "localization_evidence_only"

export const SCOUT_EVIDENCE_CLOSURE_MAX_FILES = 8
export const SCOUT_EVIDENCE_CLOSURE_MAX_WITNESSES_PER_FILE = 8
export const SCOUT_EVIDENCE_CLOSURE_MAX_HOST_REFINEMENT_FILES = 1

const SHA256_RE = /^[0-9a-f]{64}$/iu


function normalizeFile(value) {
  if (typeof value !== "string") return null

  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^file:/u, "")

  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "..")
  ) {
    return null
  }

  return normalized
}


function validWitness(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    normalizeFile(value.file) &&
    Number.isSafeInteger(value.line) &&
    value.line >= 1 &&
    typeof value.sha256 === "string" &&
    SHA256_RE.test(value.sha256) &&
    typeof value.extractor === "string" &&
    value.extractor.length > 0,
  )
}


function routePath(node) {
  if (typeof node !== "string" || !node.startsWith("route:")) return null

  const value = node.slice("route:".length)
  if (value.startsWith("/")) return value

  const firstSpace = value.indexOf(" ")
  return firstSpace > 0 && value.slice(firstSpace + 1).startsWith("/")
    ? value.slice(firstSpace + 1)
    : null
}


function edgeKey(edge) {
  return [
    edge?.kind ?? "",
    edge?.from ?? "",
    edge?.to ?? "",
    normalizeFile(edge?.witness?.file) ?? "",
    String(edge?.witness?.line ?? 0).padStart(12, "0"),
  ].join("\0")
}


function validatedEdges(frameworkEdges) {
  return (Array.isArray(frameworkEdges) ? frameworkEdges : [])
    .filter((edge) => edge?.validated === true && validWitness(edge?.witness))
    .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))
}


function positiveCoverageRequirements(taskRequirements, additiveLocalizationPlan) {
  const taskSha = typeof taskRequirements?.task_sha256 === "string"
    ? taskRequirements.task_sha256.toLowerCase()
    : null

  const planSha = typeof additiveLocalizationPlan?.task_sha256 === "string"
    ? additiveLocalizationPlan.task_sha256.toLowerCase()
    : null

  const requirements = additiveLocalizationPlan?.positive_coverage_requirements

  if (
    taskRequirements?.status !== "compiled" ||
    additiveLocalizationPlan?.status !== "planned" ||
    !taskSha ||
    planSha !== taskSha ||
    requirements?.status !== "compiled" ||
    requirements?.task_sha256?.toLowerCase?.() !== taskSha
  ) {
    return null
  }

  return requirements
}


function exactAnchorEdge(anchorFrontier, frameworkEdges) {
  const owner = anchorFrontier?.owner
  const ownerFile = normalizeFile(anchorFrontier?.owner_file)
  const routeAnchor = anchorFrontier?.route_anchor

  if (
    anchorFrontier?.status !== "bound" ||
    typeof owner !== "string" ||
    !owner.startsWith("file:") ||
    !ownerFile ||
    typeof routeAnchor !== "string" ||
    !routeAnchor.startsWith("/")
  ) {
    return null
  }

  return validatedEdges(frameworkEdges).find((edge) =>
    edge.kind === RESOURCE_EDGE_KIND.DECLARES_ROUTE &&
    edge.from === owner &&
    routePath(edge.to) === routeAnchor &&
    normalizeFile(edge.witness.file) === ownerFile
  ) ?? null
}


function selectedFileSet(selectedFiles) {
  return new Set(
    (Array.isArray(selectedFiles) ? selectedFiles : [])
      .map((entry) => normalizeFile(typeof entry === "string" ? entry : entry?.file))
      .filter(Boolean),
  )
}


export function planTaskBoundHostRefinement({
  taskRequirements = null,
  additiveLocalizationPlan = null,
  anchorFrontier = null,
  hostResourceClosure = null,
  frameworkEdges = [],
  selectedFiles = [],
} = {}) {
  const requirements = positiveCoverageRequirements(
    taskRequirements,
    additiveLocalizationPlan,
  )

  const base = {
    protocol: SCOUT_EVIDENCE_CLOSURE_PROTOCOL,
    authority: SCOUT_EVIDENCE_CLOSURE_AUTHORITY,
    status: "not_applicable",
    reason: "positive_coverage_requirements_unavailable",
    candidate_files: Object.freeze([]),
    source_proofs: Object.freeze([]),
    mutation_authority: false,
  }

  if (!requirements) return Object.freeze(base)

  const required = new Set(requirements.required_roles ?? [])
  if (!required.has("ui_host") && !required.has("navigation_host")) {
    return Object.freeze({
      ...base,
      status: "not_needed",
      reason: "host_resource_obligation_not_required",
    })
  }

  const anchorEdge = exactAnchorEdge(anchorFrontier, frameworkEdges)
  const ownerFile = normalizeFile(anchorFrontier?.owner_file)

  if (!anchorEdge || !ownerFile) {
    return Object.freeze({
      ...base,
      status: "abstained",
      reason: "exact_anchor_source_proof_unavailable",
    })
  }

  const selected = selectedFileSet(selectedFiles)
  if (selected.has(ownerFile)) {
    return Object.freeze({
      ...base,
      status: "not_needed",
      reason: "task_anchor_owner_already_unscoped_selected",
    })
  }

  const ownerNode = `file:${ownerFile}`
  const ownerAlreadyExpanded = validatedEdges(frameworkEdges).some((edge) =>
    edge.kind === RESOURCE_EDGE_KIND.RENDERS_RESOURCE &&
    edge.from === ownerNode,
  )

  if (ownerAlreadyExpanded) {
    return Object.freeze({
      ...base,
      status: "not_needed",
      reason: "task_anchor_owner_relations_already_observed",
    })
  }

  return Object.freeze({
    ...base,
    status: "planned",
    reason: "task_bound_host_obligation_needs_owner_relations",
    candidate_files: Object.freeze([ownerFile]),
    source_proofs: Object.freeze([anchorEdge.witness]),
  })
}


function witnessKey(witness) {
  return [
    normalizeFile(witness?.file) ?? "",
    witness?.sha256 ?? "",
    String(witness?.line ?? 0).padStart(12, "0"),
    witness?.extractor ?? "",
  ].join("\0")
}


function addWitness(files, role, witness) {
  if (!validWitness(witness)) return

  const file = normalizeFile(witness.file)
  if (!file) return

  let row = files.get(file)
  if (!row) {
    row = {
      file,
      roles: new Set(),
      witnesses: new Map(),
    }
    files.set(file, row)
  }

  if (typeof role === "string" && role.length > 0) row.roles.add(role)
  row.witnesses.set(witnessKey(witness), Object.freeze({
    file,
    line: witness.line,
    sha256: witness.sha256.toLowerCase(),
    extractor: witness.extractor,
  }))
}


function addEvidenceWitnesses(files, evidence) {
  for (const item of evidence ?? []) {
    const role = item?.role
    addWitness(files, role, item?.source_proof)

    for (const edge of item?.causal_path ?? []) {
      if (edge?.validated === true) addWitness(files, role, edge?.witness)
    }
  }
}



function addResolvedHostContext(
  files,
  hostResourceClosure,
  frameworkEdges,
  coveredRoles,
) {
  const edges = validatedEdges(frameworkEdges)

  for (const [role, candidate] of [
    ["ui_host", hostResourceClosure?.ui_candidate],
    ["navigation_host", hostResourceClosure?.navigation_candidate],
  ]) {
    if (!coveredRoles.has(role) || candidate?.structural_ready !== true) continue

    const file = normalizeFile(candidate?.physical_file)
    if (!file) continue

    /*
     * Coverage authority comes from accepted task-bound evidence above.
     * This witness only attests the already-bound physical source file so it
     * can enter the context projection; it cannot cover a missing role.
     */
    const witnessEdge = edges.find((edge) =>
      normalizeFile(edge?.witness?.file) === file,
    )

    if (witnessEdge) addWitness(files, role, witnessEdge.witness)
  }
}


export function solveScoutEvidenceClosure({
  taskRequirements = null,
  additiveLocalizationPlan = null,
  taskRoleEvidence = [],
  anchorFrontier = null,
  hostResourceClosure = null,
  frameworkEdges = [],
  maxFiles = SCOUT_EVIDENCE_CLOSURE_MAX_FILES,
} = {}) {
  const requirements = positiveCoverageRequirements(
    taskRequirements,
    additiveLocalizationPlan,
  )

  if (!requirements) {
    return Object.freeze({
      protocol: SCOUT_EVIDENCE_CLOSURE_PROTOCOL,
      authority: SCOUT_EVIDENCE_CLOSURE_AUTHORITY,
      status: "not_applicable",
      reason: "positive_coverage_requirements_unavailable",
      coverage_status: "not_applicable",
      required_roles: Object.freeze([]),
      covered_roles: Object.freeze([]),
      missing_roles: Object.freeze([]),
      ambiguous_roles: Object.freeze([]),
      files: Object.freeze([]),
      truncated: false,
      localization_authority: false,
      mutation_authority: false,
    })
  }

  const coverage = solveObligationCoverage({
    taskRequirements: requirements,
    evidence: taskRoleEvidence,
  })

  const files = new Map()

  const anchorEdge = exactAnchorEdge(anchorFrontier, frameworkEdges)
  if (anchorEdge) addWitness(files, "task_anchor_owner", anchorEdge.witness)

  addEvidenceWitnesses(files, coverage.accepted_evidence)
  addResolvedHostContext(
    files,
    hostResourceClosure,
    frameworkEdges,
    new Set(coverage.covered_roles ?? []),
  )

  const ordered = [...files.values()]
    .sort((a, b) => a.file.localeCompare(b.file))

  const limit = Number.isSafeInteger(maxFiles) && maxFiles > 0
    ? maxFiles
    : SCOUT_EVIDENCE_CLOSURE_MAX_FILES

  const filesTruncated = ordered.length > limit
  const witnessesTruncated = ordered
    .slice(0, limit)
    .some((row) => row.witnesses.size > SCOUT_EVIDENCE_CLOSURE_MAX_WITNESSES_PER_FILE)
  const truncated = filesTruncated || witnessesTruncated
  const bounded = ordered.slice(0, limit).map((row) => Object.freeze({
    file: row.file,
    roles: Object.freeze([...row.roles].sort()),
    witnesses: Object.freeze(
      [...row.witnesses.values()]
        .sort((a, b) => witnessKey(a).localeCompare(witnessKey(b)))
        .slice(0, SCOUT_EVIDENCE_CLOSURE_MAX_WITNESSES_PER_FILE),
    ),
  }))

  let status = coverage.status
  let reason = coverage.reason

  if (truncated) {
    status = "truncated"
    reason = filesTruncated
      ? "evidence_closure_file_budget"
      : "evidence_closure_witness_budget"
  }

  return Object.freeze({
    protocol: SCOUT_EVIDENCE_CLOSURE_PROTOCOL,
    authority: SCOUT_EVIDENCE_CLOSURE_AUTHORITY,
    status,
    reason,
    coverage_status: coverage.status,
    required_roles: Object.freeze([...(coverage.required_roles ?? [])]),
    covered_roles: Object.freeze([...(coverage.covered_roles ?? [])]),
    missing_roles: Object.freeze([...(coverage.missing_roles ?? [])]),
    ambiguous_roles: Object.freeze([...(coverage.ambiguous_roles ?? [])]),
    files: Object.freeze(bounded),
    truncated,
    localization_authority: coverage.status === "covered" && !truncated,
    mutation_authority: false,
  })
}
