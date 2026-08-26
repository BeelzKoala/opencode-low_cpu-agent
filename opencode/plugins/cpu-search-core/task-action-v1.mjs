export const TASK_ACTION_PROTOCOL = "task-action-v1"

export function taskActionIdentifier(value) {
  const text = String(value ?? "").trim()
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)
    ? text
    : null
}

export function unresolvedTaskAction(reason, taskSha256 = null) {
  return {
    protocol: TASK_ACTION_PROTOCOL,
    status: "unresolved",
    operation: null,
    old_name: null,
    new_name: null,
    task_sha256:
      typeof taskSha256 === "string" && /^[0-9a-f]{64}$/.test(taskSha256)
        ? taskSha256
        : null,
    reason,
  }
}

function exactRenameTaskAction(oldName, newName, taskSha256, reason) {
  const oldIdentifier = taskActionIdentifier(oldName)
  const newIdentifier = taskActionIdentifier(newName)

  if (!oldIdentifier || !newIdentifier || oldIdentifier === newIdentifier) {
    return unresolvedTaskAction("task_action_identifier_invalid", taskSha256)
  }

  return {
    protocol: TASK_ACTION_PROTOCOL,
    status: "exact",
    operation: "rename_symbol",
    old_name: oldIdentifier,
    new_name: newIdentifier,
    task_sha256:
      typeof taskSha256 === "string" && /^[0-9a-f]{64}$/.test(taskSha256)
        ? taskSha256
        : null,
    reason,
  }
}

export function compileTaskAction(value, taskSha256 = null) {
  const text = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim()
  if (!text) return unresolvedTaskAction("task_action_text_empty", taskSha256)

  const negativeRename =
    /\b(?:do\s+not|don't|never|avoid)\b.{0,80}\brenam(?:e|ing)\b/iu.test(text) ||
    /\bwithout\b.{0,80}\brenam(?:e|ing)\b/iu.test(text) ||
    /(?:^|\s)(?:не|без)\s+переимен/iu.test(text)

  if (negativeRename) {
    return unresolvedTaskAction("task_action_negative_rename", taskSha256)
  }

  const ident = "[`'\"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'\"]?"
  const patterns = [
    new RegExp(
      "(?:^|[.!?]\\s*)(?:please\\s+)?rename\\b.{0,140}?" +
      ident +
      "\\s+(?:to|as|->|→)\\s*" +
      ident,
      "giu",
    ),
    new RegExp(
      "(?:^|[.!?]\\s*)change\\s+(?:the\\s+)?(?:name|identifier)\\s+of\\s+" +
      ident +
      ".{0,40}?\\b(?:to|as)\\b\\s*" +
      ident,
      "giu",
    ),
    new RegExp(
      "(?:^|[.!?]\\s*)(?:пожалуйста[,\\s]+)?переимен(?:уй|уйте)" +
      "(?=\\s|$|[,:;.!?]).{0,140}?" +
      ident +
      "(?:\\s*[:,]?\\s*)(?:в|на|->|→)\\s*" +
      ident,
      "giu",
    ),
  ]

  const pairs = new Map()

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const oldName = taskActionIdentifier(match[1])
      const newName = taskActionIdentifier(match[2])
      if (!oldName || !newName || oldName === newName) continue
      pairs.set(`${oldName}\u0000${newName}`, { oldName, newName })
    }
  }

  if (pairs.size < 1) {
    return unresolvedTaskAction("task_action_not_exact", taskSha256)
  }

  if (pairs.size > 1) {
    return unresolvedTaskAction("task_action_multiple_rename_pairs", taskSha256)
  }

  const pair = [...pairs.values()][0]
  return exactRenameTaskAction(
    pair.oldName,
    pair.newName,
    taskSha256,
    "exact_rename_pair",
  )
}
