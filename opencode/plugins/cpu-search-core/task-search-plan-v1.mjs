import {
  TASK_ACTION_PROTOCOL,
  taskActionIdentifier,
} from "./task-action-v1.mjs"

export const TASK_SEARCH_PLAN_PROTOCOL = "task-search-plan-v1"
const EXEC_STATE_LOCATE = "locate"

export function compileTaskSearchPlanForState(
  state,
  requestedQueries,
  requestedPath = ".",
  requestedGlob = undefined,
  globalSourceGlob = null,
) {
  const requested = [
    ...new Set(
      (Array.isArray(requestedQueries) ? requestedQueries : [])
        .filter((query) => typeof query === "string" && query.length > 0),
    ),
  ]
  const fallback = {
    protocol: TASK_SEARCH_PLAN_PROTOCOL,
    applied: false,
    reason: "model_search_plan",
    task_sha256: state?.taskTextSha256 ?? null,
    requested_queries: requested,
    effective_queries: requested,
    requested_path:
      typeof requestedPath === "string" && requestedPath.length > 0
        ? requestedPath
        : ".",
    effective_path:
      typeof requestedPath === "string" && requestedPath.length > 0
        ? requestedPath
        : ".",
    requested_glob:
      typeof requestedGlob === "string" && requestedGlob.length > 0
        ? requestedGlob
        : null,
    effective_glob:
      typeof requestedGlob === "string" && requestedGlob.length > 0
        ? requestedGlob
        : null,
  }

  const action = state?.taskAction ?? null
  const oldName = taskActionIdentifier(action?.old_name)
  const newName = taskActionIdentifier(action?.new_name)
  const exactRename =
    state?.executionState === EXEC_STATE_LOCATE &&
    state?.mutationIntent === "rename_symbol" &&
    action?.protocol === TASK_ACTION_PROTOCOL &&
    action?.status === "exact" &&
    action?.operation === "rename_symbol" &&
    typeof action?.task_sha256 === "string" &&
    action.task_sha256 === state?.taskTextSha256 &&
    oldName !== null &&
    newName !== null &&
    oldName !== newName

  if (!exactRename) return fallback

  if (!globalSourceGlob) {
    return {
      ...fallback,
      reason: "exact_rename_source_glob_unavailable",
    }
  }

  return {
    protocol: TASK_SEARCH_PLAN_PROTOCOL,
    applied: true,
    reason: "exact_global_rename_identifier",
    task_sha256: action.task_sha256,
    requested_queries: requested,
    effective_queries: [oldName],
    requested_path: fallback.requested_path,
    effective_path: ".",
    requested_glob: fallback.requested_glob,
    effective_glob: globalSourceGlob,
  }
}
