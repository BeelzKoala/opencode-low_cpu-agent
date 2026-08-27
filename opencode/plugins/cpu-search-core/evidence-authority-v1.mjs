export const EVIDENCE_AUTHORITY_PROTOCOL =
  "evidence-authority-v1"

export const EVIDENCE_CLASS = Object.freeze({
  EXACT_TASK_ACTION: "A_exact_task_action",
  TASK_CAUSAL: "B_task_causal",
  SCOPED_DIRECT: "C_scoped_direct",
  SPARSE_RELEVANCE: "D_sparse_relevance",
  GENERIC_IMPACT: "E_generic_impact",
  HYPOTHESIS: "H_hypothesis",
})

function stringSet(values) {
  return new Set(
    Array.isArray(values)
      ? values.filter(
          (value) => typeof value === "string" && value.length > 0,
        )
      : [],
  )
}

export function classifyEvidenceAuthority({
  origins = [],
  mutationCandidateBases = [],
  exactTaskActionMatch = false,
  taskCausal = false,
} = {}) {
  const originSet = stringSet(origins)
  const basisSet = stringSet(mutationCandidateBases)

  const directStructural =
    basisSet.has("direct_structural_evidence")

  const genericImpact =
    basisSet.has("validated_forward_impact_definition") ||
    originSet.has("impact")

  if (exactTaskActionMatch && directStructural) {
    return {
      protocol: EVIDENCE_AUTHORITY_PROTOCOL,
      evidence_class: EVIDENCE_CLASS.EXACT_TASK_ACTION,
      relation_validated: true,
      task_relevance_proven: true,
      mutation_authority: true,
      reason: "exact_task_action_structural_match",
    }
  }

  if (taskCausal) {
    return {
      protocol: EVIDENCE_AUTHORITY_PROTOCOL,
      evidence_class: EVIDENCE_CLASS.TASK_CAUSAL,
      relation_validated: true,
      task_relevance_proven: true,
      mutation_authority: true,
      reason: "validated_task_causal_path",
    }
  }

  /*
   * Legacy direct structural capability remains authorizing only because
   * buildEditCapsule reaches this point after the existing bounded owner /
   * scope / competitor checks. Lexical origin by itself is NEVER authority.
   */
  if (directStructural) {
    return {
      protocol: EVIDENCE_AUTHORITY_PROTOCOL,
      evidence_class: EVIDENCE_CLASS.SCOPED_DIRECT,
      relation_validated: true,
      task_relevance_proven: true,
      mutation_authority: true,
      reason: "bounded_direct_structural_scope",
    }
  }

  /*
   * A validated dependency edge proves that the relationship exists.
   * It does not prove that the related node belongs to the user's task.
   */
  if (genericImpact) {
    return {
      protocol: EVIDENCE_AUTHORITY_PROTOCOL,
      evidence_class: EVIDENCE_CLASS.GENERIC_IMPACT,
      relation_validated: true,
      task_relevance_proven: false,
      mutation_authority: false,
      reason: "generic_impact_is_routing_only",
    }
  }

  if (originSet.has("lexical")) {
    return {
      protocol: EVIDENCE_AUTHORITY_PROTOCOL,
      evidence_class: EVIDENCE_CLASS.SPARSE_RELEVANCE,
      relation_validated: false,
      task_relevance_proven: false,
      mutation_authority: false,
      reason: "sparse_relevance_is_routing_only",
    }
  }

  return {
    protocol: EVIDENCE_AUTHORITY_PROTOCOL,
    evidence_class: EVIDENCE_CLASS.HYPOTHESIS,
    relation_validated: false,
    task_relevance_proven: false,
    mutation_authority: false,
    reason: "unproven_evidence",
  }
}
