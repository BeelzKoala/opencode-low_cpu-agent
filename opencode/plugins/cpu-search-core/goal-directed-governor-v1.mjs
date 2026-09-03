export const GOAL_DIRECTED_GOVERNOR_PROTOCOL =
  "goal-directed-governor-v1"

export const GOAL_DIRECTED_OBJECTIVE =
  "verified_progress"

export const GOAL_DIRECTED_PROBABILITY_AUTHORITY =
  "unavailable_until_calibrated_replay"

export const GOAL_DIRECTED_RUNTIME_COST_AUTHORITY =
  "observation_only"

export const GOAL_DIRECTED_WALL_TIME_AUTHORITY =
  "observation_only"

const EXECUTION_STATES =
  new Set([
    "locate",
    "mutate",
    "repair",
    "done",
    "safe_fail",
  ])

function finiteCount(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0
  )
    ? value
    : null
}

function frozen(value) {
  return Object.freeze(value)
}

function deny(reason, details = {}) {
  return frozen({
    protocol:
      GOAL_DIRECTED_GOVERNOR_PROTOCOL,
    objective:
      GOAL_DIRECTED_OBJECTIVE,
    admitted: false,
    reason,
    proof_obligation:
      details.proof_obligation ?? null,
    selected_tool:
      details.selected_tool ?? null,
    execution_state:
      details.execution_state ?? null,
    decision_basis:
      frozen(
        [...(details.decision_basis ?? [])],
      ),
    success_probability: null,
    probability_authority:
      GOAL_DIRECTED_PROBABILITY_AUTHORITY,
    runtime_cost_authority:
      GOAL_DIRECTED_RUNTIME_COST_AUTHORITY,
    wall_time_authority:
      GOAL_DIRECTED_WALL_TIME_AUTHORITY,
    mutation_authority: false,
  })
}

function allow(reason, details = {}) {
  return frozen({
    protocol:
      GOAL_DIRECTED_GOVERNOR_PROTOCOL,
    objective:
      GOAL_DIRECTED_OBJECTIVE,
    admitted: true,
    reason,
    proof_obligation:
      details.proof_obligation ?? null,
    selected_tool:
      details.selected_tool ?? null,
    execution_state:
      details.execution_state ?? null,
    decision_basis:
      frozen(
        [...(details.decision_basis ?? [])],
      ),
    success_probability: null,
    probability_authority:
      GOAL_DIRECTED_PROBABILITY_AUTHORITY,
    runtime_cost_authority:
      GOAL_DIRECTED_RUNTIME_COST_AUTHORITY,
    wall_time_authority:
      GOAL_DIRECTED_WALL_TIME_AUTHORITY,
    mutation_authority: false,
  })
}

function obligationForState(state) {
  if (state === "locate") {
    return "evidence_closure"
  }

  if (state === "mutate") {
    return "candidate_materialization"
  }

  if (state === "repair") {
    return "failed_proof_reduction"
  }

  return null
}

/*
 * Goal-directed deterministic metareasoning.
 *
 * This is deliberately NOT a probability model. Until replay evidence is
 * sufficient to calibrate P(VERIFIED | state, action), claiming a numeric
 * probability would create false evidence.
 *
 * The decision is therefore a proof-progress feasibility gate:
 *
 *   - deterministic FSM owns the legal frontier;
 *   - terminal states do not compute;
 *   - exhausted bounded attempts do not compute;
 *   - proven deterministic no-progress does not compute;
 *   - otherwise the singleton causal action is allowed.
 *
 * Elapsed wall time and predicted model latency are observations only.
 * They may later become costs in a calibrated value-of-computation policy,
 * but never masquerade as correctness evidence.
 */
export function decideGoalDirectedCompute({
  execution_state,
  selected_tool,
  frontier_size,
  patch_accepted = false,
  model_calls = 0,
  max_model_calls = 0,
  search_attempts = 0,
  max_search_attempts = 0,
  mutation_attempts = 0,
  max_mutation_attempts = 0,
  exact_no_progress = false,
} = {}) {
  if (
    !EXECUTION_STATES.has(
      execution_state,
    )
  ) {
    return deny(
      "goal_state_invalid",
      {
        execution_state,
        selected_tool,
        decision_basis: [
          "execution_state_invalid",
        ],
      },
    )
  }

  if (
    execution_state === "done" ||
    patch_accepted === true
  ) {
    return deny(
      "goal_already_satisfied",
      {
        execution_state,
        selected_tool,
        decision_basis: [
          "terminal_or_patch_ready",
        ],
      },
    )
  }

  if (execution_state === "safe_fail") {
    return deny(
      "goal_terminal_safe_fail",
      {
        execution_state,
        selected_tool,
        decision_basis: [
          "terminal_safe_fail",
        ],
      },
    )
  }

  if (
    finiteCount(frontier_size) !== 1 ||
    typeof selected_tool !== "string" ||
    selected_tool.length < 1
  ) {
    return deny(
      "goal_frontier_not_singleton",
      {
        execution_state,
        selected_tool:
          typeof selected_tool === "string"
            ? selected_tool
            : null,
        proof_obligation:
          obligationForState(
            execution_state,
          ),
        decision_basis: [
          "deterministic_frontier_required",
        ],
      },
    )
  }

  const modelCalls =
    finiteCount(model_calls)
  const maxModelCalls =
    finiteCount(max_model_calls)

  if (
    modelCalls == null ||
    maxModelCalls == null ||
    maxModelCalls < 1
  ) {
    return deny(
      "goal_model_budget_invalid",
      {
        execution_state,
        selected_tool,
        proof_obligation:
          obligationForState(
            execution_state,
          ),
        decision_basis: [
          "bounded_model_budget_required",
        ],
      },
    )
  }

  if (modelCalls >= maxModelCalls) {
    return deny(
      "goal_model_attempts_exhausted",
      {
        execution_state,
        selected_tool,
        proof_obligation:
          obligationForState(
            execution_state,
          ),
        decision_basis: [
          "bounded_model_attempts_exhausted",
        ],
      },
    )
  }

  if (execution_state === "locate") {
    const searchAttempts =
      finiteCount(search_attempts)
    const maxSearchAttempts =
      finiteCount(max_search_attempts)
    if (
      searchAttempts == null ||
      maxSearchAttempts == null ||
      maxSearchAttempts < 1
    ) {
      return deny(
        "goal_search_budget_invalid",
        {
          execution_state,
          selected_tool,
          proof_obligation:
            "evidence_closure",
          decision_basis: [
            "bounded_search_budget_required",
          ],
        },
      )
    }

    if (
      searchAttempts >=
      maxSearchAttempts
    ) {
      return deny(
        "goal_search_attempts_exhausted",
        {
          execution_state,
          selected_tool,
          proof_obligation:
            "evidence_closure",
          decision_basis: [
            "bounded_search_attempts_exhausted",
          ],
        },
      )
    }

    if (exact_no_progress === true) {
      return deny(
        "goal_exact_no_progress",
        {
          execution_state,
          selected_tool,
          proof_obligation:
            "evidence_closure",
          decision_basis: [
            "exact_state_action_repeated",
          ],
        },
      )
    }

    return allow(
      "goal_causal_action_can_advance",
      {
        execution_state,
        selected_tool,
        proof_obligation:
          "evidence_closure",
        decision_basis: [
          "singleton_deterministic_frontier",
          "open_evidence_obligation",
          "bounded_attempts_available",
          "no_exact_no_progress",
        ],
      },
    )
  }

  const mutationAttempts =
    finiteCount(mutation_attempts)
  const maxMutationAttempts =
    finiteCount(max_mutation_attempts)

  if (
    mutationAttempts == null ||
    maxMutationAttempts == null ||
    maxMutationAttempts < 1
  ) {
    return deny(
      "goal_mutation_budget_invalid",
      {
        execution_state,
        selected_tool,
        proof_obligation:
          obligationForState(
            execution_state,
          ),
        decision_basis: [
          "bounded_mutation_budget_required",
        ],
      },
    )
  }

  if (
    mutationAttempts >=
    maxMutationAttempts
  ) {
    return deny(
      "goal_mutation_attempts_exhausted",
      {
        execution_state,
        selected_tool,
        proof_obligation:
          obligationForState(
            execution_state,
          ),
        decision_basis: [
          "bounded_mutation_attempts_exhausted",
        ],
      },
    )
  }

  return allow(
    "goal_causal_action_can_advance",
    {
      execution_state,
      selected_tool,
      proof_obligation:
        obligationForState(
          execution_state,
        ),
      decision_basis: [
        "singleton_deterministic_frontier",
        "open_proof_obligation",
        "bounded_attempts_available",
        "wall_time_not_solver_authority",
      ],
    },
  )
}
