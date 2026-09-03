import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import {
  GOAL_DIRECTED_GOVERNOR_PROTOCOL,
  GOAL_DIRECTED_OBJECTIVE,
  GOAL_DIRECTED_PROBABILITY_AUTHORITY,
  GOAL_DIRECTED_RUNTIME_COST_AUTHORITY,
  GOAL_DIRECTED_WALL_TIME_AUTHORITY,
  decideGoalDirectedCompute,
} from "../../opencode/plugins/cpu-search-core/goal-directed-governor-v1.mjs"

assert.equal(
  GOAL_DIRECTED_GOVERNOR_PROTOCOL,
  "goal-directed-governor-v1",
)
assert.equal(
  GOAL_DIRECTED_OBJECTIVE,
  "verified_progress",
)
assert.equal(
  GOAL_DIRECTED_PROBABILITY_AUTHORITY,
  "unavailable_until_calibrated_replay",
)
assert.equal(
  GOAL_DIRECTED_RUNTIME_COST_AUTHORITY,
  "observation_only",
)
assert.equal(
  GOAL_DIRECTED_WALL_TIME_AUTHORITY,
  "observation_only",
)

const expensiveButCausal =
  decideGoalDirectedCompute({
    execution_state: "mutate",
    selected_tool:
      "execute_additive_plan",
    frontier_size: 1,
    model_calls: 1,
    max_model_calls: 4,
    mutation_attempts: 0,
    max_mutation_attempts: 2,

    // Deliberately irrelevant observations. The API must not use them.
    elapsed_ms: 360_000,
    predicted_inference_ms: 498_763,
    legacy_task_remaining_ms: 299_674,
  })

assert.equal(
  expensiveButCausal.admitted,
  true,
)
assert.equal(
  expensiveButCausal.reason,
  "goal_causal_action_can_advance",
)
assert.equal(
  expensiveButCausal.proof_obligation,
  "candidate_materialization",
)
assert.equal(
  expensiveButCausal.success_probability,
  null,
)
assert.equal(
  expensiveButCausal.wall_time_authority,
  "observation_only",
)
assert.equal(
  expensiveButCausal.runtime_cost_authority,
  "observation_only",
)
assert.equal(
  expensiveButCausal.mutation_authority,
  false,
)

const repair =
  decideGoalDirectedCompute({
    execution_state: "repair",
    selected_tool:
      "execute_additive_plan",
    frontier_size: 1,
    model_calls: 2,
    max_model_calls: 4,
    mutation_attempts: 1,
    max_mutation_attempts: 2,
  })

assert.equal(repair.admitted, true)
assert.equal(
  repair.proof_obligation,
  "failed_proof_reduction",
)

const mutationExhausted =
  decideGoalDirectedCompute({
    execution_state: "repair",
    selected_tool:
      "execute_additive_plan",
    frontier_size: 1,
    model_calls: 2,
    max_model_calls: 4,
    mutation_attempts: 2,
    max_mutation_attempts: 2,
  })

assert.equal(
  mutationExhausted.admitted,
  false,
)
assert.equal(
  mutationExhausted.reason,
  "goal_mutation_attempts_exhausted",
)

const locateNoProgress =
  decideGoalDirectedCompute({
    execution_state: "locate",
    selected_tool: "search",
    frontier_size: 1,
    model_calls: 1,
    max_model_calls: 4,
    search_attempts: 2,
    max_search_attempts: 6,
    exact_no_progress: true,
  })

assert.equal(
  locateNoProgress.admitted,
  false,
)
assert.equal(
  locateNoProgress.reason,
  "goal_exact_no_progress",
)

const nonSingleton =
  decideGoalDirectedCompute({
    execution_state: "mutate",
    selected_tool: null,
    frontier_size: 0,
    model_calls: 1,
    max_model_calls: 4,
    mutation_attempts: 0,
    max_mutation_attempts: 2,
  })

assert.equal(
  nonSingleton.admitted,
  false,
)
assert.equal(
  nonSingleton.reason,
  "goal_frontier_not_singleton",
)

const terminal =
  decideGoalDirectedCompute({
    execution_state: "done",
    selected_tool: null,
    frontier_size: 0,
    patch_accepted: true,
    model_calls: 1,
    max_model_calls: 4,
  })

assert.equal(terminal.admitted, false)
assert.equal(
  terminal.reason,
  "goal_already_satisfied",
)

const fragmentsRoot =
  path.resolve(
    "opencode/plugins/cpu-search.fragments",
  )

const fragments =
  fs.readdirSync(fragmentsRoot)
    .filter((name) =>
      name.endsWith(".part.ts"),
    )
    .map((name) =>
      fs.readFileSync(
        path.join(
          fragmentsRoot,
          name,
        ),
        "utf8",
      ),
    )
    .join("\n")

assert.match(
  fragments,
  /decideGoalDirectedCompute\(\{/u,
)

assert.match(
  fragments,
  /kind:\s*"goal_directed_compute"/u,
)

assert.match(
  fragments,
  /OPENCODE_CPU_ONE_CALL_EXECUTOR\s*!==\s*"0"/u,
)

assert.doesNotMatch(
  fragments,
  /admitInferenceWithinTask/u,
)

assert.doesNotMatch(
  fragments,
  /executionControlLeases\.arm\(/u,
)

assert.doesNotMatch(
  fragments,
  /CPU_GOVERNOR \$\{governorAdmission\.reason\}/u,
)

assert.match(
  fragments,
  /kind:\s*"governor_time_observation"/u,
)

assert.match(
  fragments,
  /governor_lease_authority:\s*"cost_observation_only"/u,
)

assert.match(
  fragments,
  /execution_control_task_window_authority:\s*"observation_only"/u,
)

console.log(
  "PASS C10-R3A goal-directed governor " +
  "objective=verified_progress " +
  "wall_time_solver_authority=false " +
  "runtime_cost_authority=observation_only " +
  "fake_probability=false " +
  "causal_expensive_compute=allowed " +
  "deterministic_scout_default=true " +
  "bounded_attempts=true " +
  "deterministic_no_progress=true " +
  "task_wall_interrupt=false " +
  "mutation_authority_expansion=false",
)
