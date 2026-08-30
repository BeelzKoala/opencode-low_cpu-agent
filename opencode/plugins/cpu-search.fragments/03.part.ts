
async function materializeCapabilityBoundMutation(
  root,
  state,
  input,
) {
  const loaded = await readAuthorizedEditCapsule(root, state)
  if (!loaded.ok) return { ...loaded, rescout: false }

  const authorizedScopes = loaded.capsule.scopes.filter(
    (scope) =>
      scope?.context === "full" &&
      scope?.mutation_authorized === true,
  )
  if (authorizedScopes.length !== 1) {
    return {
      ok: false,
      reason: "mutation_capability_invalid",
      detail: `authorized_scope_count_${authorizedScopes.length}`,
      rescout: false,
    }
  }

  const primaryTarget = authorizedScopes[0]
  const primaryCapability = state?.localMutationCapability ?? null

  let target = null
  let capability = null
  let activeHandoffPath = null

  if (input.kind === "replace_node") {
    if (
      primaryCapability?.protocol !== SCOUT_LOCAL_CAPABILITY_PROTOCOL ||
      primaryCapability?.replaceNodeReady !== true ||
      !sameAuthorizedScopeIdentity(
        primaryTarget,
        {
          file: primaryCapability?.target?.file,
          symbol_name: primaryCapability?.target?.symbol_name,
          symbol_kind: primaryCapability?.target?.symbol_kind,
          start_line: primaryCapability?.target?.start_line,
          end_line: primaryCapability?.target?.end_line,
        },
      )
    ) {
      return {
        ok: false,
        reason: "mutation_capability_unavailable",
        detail: "local_capability_target_mismatch",
        rescout: false,
      }
    }

    const binding =
      await bindReplaceNodeMutationCandidate(
        root,
        state,
        input.before,
      )

    if (!binding.ok) {
      return {
        ok: false,
        reason: binding.reason,
        detail: binding.reason,
        repairable: binding.repairable === true,
        rescout: false,
        candidate_count: binding.candidate_count ?? null,
      }
    }

    target = binding.candidate.target
    capability = binding.candidate.capability

    if (
      !Array.isArray(capability.allowedMutations) ||
      !capability.allowedMutations.includes("replace_node")
    ) {
      return {
        ok: false,
        reason: "mutation_not_authorized_by_handoff",
        detail: "replace_node_not_in_local_capability",
        rescout: false,
      }
    }

    activeHandoffPath = capability.localHandoffPath
    state.boundMutationTarget = mutationCandidateIdentity(target)
  } else if (input.kind === "rename_symbol") {
    const renameCapability = state?.renameMutationCapability ?? null
    target = renameCapability?.target ?? null
    capability = renameCapability

    const identitySha256 = target
      ? createHash("sha256")
          .update(JSON.stringify(target))
          .digest("hex")
      : null

    if (
      renameCapability?.protocol !== SCOUT_RENAME_TARGET_PROTOCOL ||
      renameCapability?.operation !== "rename_symbol" ||
      renameCapability?.ready !== true ||
      renameCapability?.globalReady !== true ||
      renameCapability?.sourceHandoffPath !== state?.scoutHandoffPath ||
      renameCapability?.targetIdentitySha256 !== identitySha256 ||
      typeof state?.scoutHandoffPath !== "string"
    ) {
      return {
        ok: false,
        reason: "rename_target_capability_invalid",
        detail: "rename_target_capability_invalid",
        rescout: true,
      }
    }

    const renameFile = canonicalMutationFile(root, target?.file)
    let currentBody
    try {
      currentBody = await readFile(path.resolve(root, renameFile ?? ""))
    } catch {
      return {
        ok: false,
        reason: "rename_target_file_unavailable",
        detail: "rename_target_file_unavailable",
        rescout: true,
      }
    }

    const currentSha256 = createHash("sha256")
      .update(currentBody)
      .digest("hex")
    if (currentSha256 !== renameCapability.targetSourceSha256) {
      return {
        ok: false,
        reason: "rename_target_stale",
        detail: "rename_target_stale",
        rescout: true,
      }
    }

    activeHandoffPath = state.scoutHandoffPath
    state.boundMutationTarget = mutationCandidateIdentity(target)
  }

  const file = canonicalMutationFile(root, target?.file)
  const symbol =
    typeof target?.symbol_name === "string" ? target.symbol_name : ""

  if (!file || !symbol) {
    return {
      ok: false,
      reason: "mutation_capability_invalid",
      detail: "authorized_target_identity_invalid",
      rescout: false,
    }
  }

  if (
    typeof activeHandoffPath !== "string" ||
    activeHandoffPath.length < 1
  ) {
    return {
      ok: false,
      reason: "mutation_handoff_unavailable",
      detail: "operation_handoff_missing",
      rescout: false,
    }
  }

  const mutation = {
    file,
    kind: input.kind,
    symbol,
    ...(typeof input.before === "string" ? { before: input.before } : {}),
    ...(typeof input.replacement === "string"
      ? { replacement: input.replacement }
      : {}),
    ...(typeof input.new_name === "string" ? { new_name: input.new_name } : {}),
    ...(input.kind === "rename_symbol" ? { scope: "handoff" } : {}),
  }

  return {
    ok: true,
    mutation,
    handoff_path: activeHandoffPath,
    scope_context: target.context,
    target: {
      file,
      symbol,
      symbol_kind: target.symbol_kind ?? null,
      start_line: target.start_line ?? null,
      end_line: target.end_line ?? null,
    },
  }
}
const PATCH_COMPILER_RETRY_REASONS = new Set([
  "mutation_contract_invalid",
  "mutation_kind_invalid",
  "mutation_file_invalid",
  "symbol_not_found",
  "symbol_ambiguous",
  "expression_pattern_invalid",
  "expression_not_found",
  "expression_ambiguous",
  "rename_context_ambiguous",
  "rename_scope_too_large",
  "lowered_edit_budget_exceeded",
  "no_effect_plan",
  "mutation_slice_not_exact",
  "mutation_slice_ambiguous",
  "mutation_slice_not_structural",
  "mutation_slice_too_wide",
  "mutation_fragment_invalid",
  "mutation_replacement_invalid",
  "candidate_language_invalid",
])

const PATCH_COMPILER_RESCOUT_REASONS = new Set([
  "handoff_not_ready",
  "local_capability_invalid",
  "handoff_scope_mode_invalid",
  "mutation_not_authorized_by_handoff",
  "handoff_scope_empty",
  "handoff_file_invalid",
  "handoff_file_unavailable",
  "file_outside_handoff",
  "evidence_anchor_missing",
  "rename_scope_incomplete",
])

const PATCH_RETRY_REASONS = new Set([
  "edit_contract_invalid",
  "check_contract_invalid",
  "precondition_not_unique",
  "ast_pattern_invalid",
  "ast_metavariables_unsupported",
  "ast_precondition_ambiguous",
  "ast_precondition_not_found",
  "no_effect",
  "candidate_syntax_invalid",
  "postcondition_failed",
  "changed_file_budget_exceeded",
  "changed_line_budget_exceeded",
  "patch_budget_exceeded",
])

const PATCH_RESCOUT_REASONS = new Set([
  "handoff_not_ready",
  "handoff_scope_too_large",
  "handoff_scope_empty",
  "handoff_file_invalid",
  "handoff_fingerprint_weak",
  "handoff_fingerprint_missing",
  "handoff_file_unavailable",
  "stale_fingerprint",
  "file_outside_handoff",
  "check_file_outside_handoff",
  "evidence_anchor_missing",
  "edit_outside_evidence_radius",
  "worktree_baseline_missing",
  "worktree_baseline_mismatch",
  "source_changed_during_execution",
])

function proofObligationsForMutations(mutations) {
  const obligations = [
    { id: "changed_file_set", check_kind: "changed_file_set", disposition: "fatal" },
    { id: "replay_exact", check_kind: "replay_exact", disposition: "fatal" },
    { id: "ast_parse", check_kind: "ast_parse", disposition: "fatal" },
    { id: "candidate_validity_barrier", check_kind: "candidate_validity_barrier", disposition: "fatal" },
    { id: "top_level_conservation", check_kind: "top_level_conservation", disposition: "repair" },
    { id: "target_cardinality", check_kind: "target_cardinality", disposition: "repair" },
  ]
  if ((mutations ?? []).some((mutation) => mutation?.kind === "replace_node")) {
    obligations.push(
      { id: "replace_node_confinement", check_kind: "replace_node_confinement", disposition: "repair" },
    )
  }
  if ((mutations ?? []).some((mutation) => mutation?.kind === "rename_symbol")) {
    obligations.push(
      { id: "rename_identifier_delta", check_kind: "rename_identifier_delta", disposition: "repair" },
      { id: "rename_syntactic_closure", check_kind: "rename_global_closure", disposition: "rescout" },
    )
  }
  return obligations.map((obligation) => ({ protocol: PROOF_OBLIGATION_PROTOCOL, ...obligation }))
}

function assessProofObligations(verificationResponse, obligations) {
  const checks = Array.isArray(verificationResponse?.checks) ? verificationResponse.checks : []
  const byKind = new Map()
  for (const check of checks) {
    if (!check || typeof check.kind !== "string") continue
    if (!byKind.has(check.kind)) byKind.set(check.kind, [])
    byKind.get(check.kind).push(check)
  }

  const failed = []
  for (const obligation of obligations ?? []) {
    const rows = byKind.get(obligation.check_kind) ?? []
    const pass = rows.length > 0 && rows.every((row) => row?.pass === true)
    if (!pass) failed.push({
      id: obligation.id,
      check_kind: obligation.check_kind,
      disposition: obligation.disposition,
      details: rows.filter((row) => row?.pass !== true).map((row) => ({ file: row?.file ?? null, detail: row?.detail ?? null })),
    })
  }
  if (verificationResponse?.worktree_cleaned !== true) {
    failed.push({ id: "worktree_cleanup", check_kind: "worktree_cleaned", disposition: "fatal", details: [] })
  }

  let disposition = "pass"
  if (failed.some((item) => item.disposition === "fatal")) disposition = "fatal"
  else if (failed.some((item) => item.disposition === "rescout")) disposition = "rescout"
  else if (failed.length > 0) disposition = "repair"

  return {
    protocol: PROOF_OBLIGATION_PROTOCOL,
    ok: failed.length === 0,
    disposition,
    obligations: obligations ?? [],
    failed,
  }
}

function compactProofFailure(assessment) {
  return (assessment?.failed ?? []).map((item) => item.id).join(",") || "unknown"
}

function runJsonBinary(binary, root, request, protocol, timeoutMs, stdoutLimit) {
  return new Promise((resolve) => {
    if (!binary) {
      resolve({ ok: false, reason: "binary_path_unavailable", elapsedMs: 0 })
      return
    }
    const started = performance.now()
    const child = spawn(binary, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let outputLimited = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > stdoutLimit) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 4096) return
      const remaining = 4096 - stderrBytes
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
      stderr.push(Buffer.from(kept))
      stderrBytes += kept.length
    })
    child.stdin.on("error", () => {})
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", error: String(error?.message ?? error) }))
    child.on("close", (code, signal) => {
      if (settled) return
      const stderrText = Buffer.concat(stderr).toString("utf8").trim()
      if (timedOut) return finish({ ok: false, reason: "timeout", error: stderrText || null })
      if (outputLimited) return finish({ ok: false, reason: "stdout_limit", error: stderrText || null })
      if (code !== 0) return finish({ ok: false, reason: "exit_error", exitCode: code, signal: signal ?? null, error: stderrText || null })
      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (error) {
        return finish({ ok: false, reason: "invalid_json", error: String(error?.message ?? error) })
      }
      if (response?.protocol !== protocol) {
        return finish({ ok: false, reason: "protocol_mismatch", response })
      }
      finish({
        ok: true,
        reason: "ok",
        response,
        diagnostic: stderrText || null,
      })
    })
    try {
      child.stdin.end(JSON.stringify(request))
    } catch (error) {
      child.kill("SIGKILL")
      finish({ ok: false, reason: "stdin_error", error: String(error?.message ?? error) })
    }
  })
}

function runPatchCompiler(root, request) {
  return runJsonBinary(
    patchCompilerBinary(),
    root,
    request,
    PATCH_COMPILER_PROTOCOL,
    PATCH_COMPILER_TIMEOUT_MS,
    PATCH_COMPILER_MAX_STDOUT_BYTES,
  )
}

function runPatchExecutor(root, request) {
  return runJsonBinary(
    patchExecutorBinary(),
    root,
    request,
    PATCH_EXECUTOR_PROTOCOL,
    PATCH_EXECUTOR_TIMEOUT_MS,
    PATCH_EXECUTOR_MAX_STDOUT_BYTES,
  )
}

function runInvariantVerifier(root, request) {
  return runJsonBinary(
    invariantVerifierBinary(),
    root,
    request,
    INVARIANT_VERIFIER_PROTOCOL,
    INVARIANT_VERIFIER_TIMEOUT_MS,
    INVARIANT_VERIFIER_MAX_STDOUT_BYTES,
  )
}

function runCompletionAuthorizer(root, request) {
  return runJsonBinary(
    completionAuthorizerBinary(),
    root,
    request,
    COMPLETION_AUTHORIZER_PROTOCOL,
    COMPLETION_AUTHORIZER_TIMEOUT_MS,
    COMPLETION_AUTHORIZER_MAX_STDOUT_BYTES,
  )
}

function completionAuthorizationPermitsTerminal(observation) {
  return (
    observation?.applicable === true &&
    observation?.transport_ok === true &&
    observation?.decision === "CERTIFY" &&
    typeof observation?.certificate_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(observation.certificate_sha256)
  )
}

async function observeCompletionAuthorization(
  root,
  sessionID,
  state,
  persisted,
  proofAssessment,
  dispatchOrigin,
  actionCommit,
) {
  const applicable =
    dispatchOrigin === ACTION_COMMIT_DISPATCH_ORIGIN &&
    actionCommit?.protocol === ACTION_COMMIT_PROTOCOL &&
    state?.taskAction?.protocol === TASK_ACTION_PROTOCOL &&
    state.taskAction.status === "exact" &&
    state.taskAction.operation === "rename_symbol"

  if (!applicable) {
    return {
      applicable: false,
      transport_ok: false,
      decision: null,
      reason: "completion_authorizer_not_applicable",
      certificate_sha256: null,
      elapsed_ms: 0,
    }
  }

  const request = {
    protocol: COMPLETION_AUTHORIZER_REQUEST_PROTOCOL,
    policy: COMPLETION_AUTHORIZER_POLICY,
    user_turn_id: state.taskTurnID,
    task_action: state.taskAction,
    action_commit: actionCommit,
    patch_receipt_path: persisted.path,
    patch_receipt_body: JSON.stringify(persisted.receipt, null, 2) + "\n",
    verification_receipt_path: persisted.verificationPath,
    verification_receipt_body:
      JSON.stringify(persisted.verificationReceipt, null, 2) + "\n",
    proof_assessment: proofAssessment,
  }

  const result = await runCompletionAuthorizer(root, request)
  const response = result?.ok === true ? result.response : null
  const certificateSha256 =
    response?.decision === "CERTIFY" &&
    typeof response?.certificate?.certificate_sha256 === "string"
      ? response.certificate.certificate_sha256
      : null

  const observation = {
    applicable: true,
    transport_ok: result?.ok === true,
    decision: response?.decision ?? null,
    reason:
      response?.reason ??
      result?.reason ??
      "completion_authorizer_unknown",
    certificate_sha256: certificateSha256,
    elapsed_ms: result?.elapsedMs ?? null,
  }

  await writeProjectTrace(root, "cpu-agent-trace.jsonl", {
    ts: nowMs(),
    protocol: AGENT_PROTOCOL,
    kind: "completion_authorizer",
    completion_authorizer_protocol: COMPLETION_AUTHORIZER_PROTOCOL,
    completion_authorizer_policy: COMPLETION_AUTHORIZER_POLICY,
    completion_authorizer_authority: "terminal_permission",
    completion_authorizer_applicable: observation.applicable,
    completion_authorizer_transport_ok: observation.transport_ok,
    completion_authorizer_decision: observation.decision,
    completion_authorizer_reason: observation.reason,
    completion_certificate_sha256: observation.certificate_sha256,
    completion_authorizer_elapsed_ms: observation.elapsed_ms,
    sessionID,
    turnID: state.turnID,
    task_turn_id: state.taskTurnID,
    task_sha256: state.taskTextSha256,
    action_commit_sha256: actionCommit?.commit_sha256 ?? null,
    patch_receipt: persisted.path,
    verification_receipt: persisted.verificationPath,
    patch_sha256: persisted.receipt?.patch_sha256 ?? null,
    project_root: root,
  })

  return observation
}

async function writePatchReceipt(root, sessionID, state, executorResponse, compilerResponse, verificationResponse, proofAssessment, dispatch = null) {
  const patch = typeof executorResponse?.patch === "string" ? executorResponse.patch : null
  if (!patch || !sessionID || !state?.turnID) return null

  const dir = path.join(root, ".opencode", "patches")
  const key = scoutOpaqueKey(`${sessionID}:${state.turnID}`)
  const patchPath = path.join(dir, `${key}.diff`)
  const receiptPath = path.join(dir, `${key}.json`)
  const verificationPath = path.join(dir, `${key}.verify.json`)
  const nonce = `${process.pid}.${nowMs()}`
  const patchTemp = `${patchPath}.${nonce}.tmp`
  const receiptTemp = `${receiptPath}.${nonce}.tmp`
  const verificationTemp = `${verificationPath}.${nonce}.tmp`
  const receipt = {
    protocol: PATCH_RECEIPT_PROTOCOL,
    verification_protocol: VERIFICATION_RECEIPT_PROTOCOL,
    verification_receipt: path.relative(root, verificationPath),
    execution_protocol: EXECUTION_LOOP_PROTOCOL,
    mutation_tool_abi_protocol: MUTATION_TOOL_ABI_PROTOCOL,
    mutation_dispatch_origin: dispatch?.origin ?? "model_tool",
    action_commit_protocol: dispatch?.actionCommit?.protocol ?? null,
    action_commit_sha256: dispatch?.actionCommit?.commit_sha256 ?? null,
    mutation_tool: state.activeMutationTool,
    visible_tool_schema_sha256: state.visibleToolSchemaSha256,
    tool_contract_failures: state.contractFailures,
    compiler_protocol: PATCH_COMPILER_PROTOCOL,
    mutation_protocol: PATCH_MUTATION_PROTOCOL,
    executor_protocol: PATCH_EXECUTOR_PROTOCOL,
    edit_protocol: PATCH_EDIT_PROTOCOL,
    search_protocol: SEARCH_PROTOCOL,
    turn_key: scoutOpaqueKey(state.turnID),
    generated_at_ms: nowMs(),
    scout_handoff:
      state.activeMutationHandoffPath ?? state.scoutHandoffPath,
    discovery_handoff: state.scoutHandoffPath,
    mutation_capability_protocol:
      state.activeMutationTool === EXECUTE_RENAME_SYMBOL_TOOL
        ? state.renameMutationCapability?.protocol ?? null
        : state.localMutationCapability?.protocol ?? null,
    mutation_capability_target:
      state.activeMutationTool === EXECUTE_RENAME_SYMBOL_TOOL
        ? state.renameMutationCapability?.target ?? null
        : state.localMutationCapability?.target ?? null,
    rename_target_capability_protocol:
      state.renameMutationCapability?.protocol ?? null,
    rename_target_capability_target:
      state.renameMutationCapability?.target ?? null,
    mutation_confinement_protocol:
      (compilerResponse?.edits ?? []).some((edit) => edit?.kind === "replace_slice")
        ? MUTATION_CONFINEMENT_PROTOCOL
        : null,
    mutation_confinements:
      (compilerResponse?.edits ?? [])
        .filter((edit) => edit?.kind === "replace_slice" && edit?.confinement)
        .map((edit) => edit.confinement),
    edit_capsule_protocol: EDIT_CAPSULE_PROTOCOL,
    edit_capsule: state.editCapsulePath,
    edit_capsule_sha256: state.editCapsuleHash,
    execution_fsm_protocol: EXECUTION_FSM_PROTOCOL,
    proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL,
    proof_obligations: proofAssessment?.obligations ?? [],
    proof_disposition: proofAssessment?.disposition ?? null,
    patch_path: path.relative(root, patchPath),
    patch_sha256: createHash("sha256").update(patch).digest("hex"),
    attempts_used: state.mutationAttempts,
    mutation_attempts_used: state.mutationAttempts,
    repair_attempts_used: state.repairAttempts,
    compiler_runs: state.compilerRuns,
    patch_attempts_used: state.patchAttempts,
    executor_runs: state.executorRuns,
    mutations_requested: compilerResponse?.mutations_requested ?? null,
    mutations_effective: compilerResponse?.mutations_effective ?? null,
    compiler_dropped_noops: compilerResponse?.dropped_noops ?? null,
    compiler_dropped_duplicates: compilerResponse?.dropped_duplicates ?? null,
    compiler_lowered_edits: compilerResponse?.lowered_edits ?? null,
    compiler_checks_generated: compilerResponse?.checks_generated ?? null,
    changed_files: executorResponse.changed_files ?? [],
    changed_lines: executorResponse.changed_lines ?? 0,
    patch_bytes: executorResponse.patch_bytes ?? bytes(patch),
    changes: executorResponse.changes ?? [],
    syntax_checked_files: executorResponse.syntax_checked_files ?? [],
    postconditions_checked: executorResponse.postconditions_checked ?? 0,
    structural_edits: executorResponse.structural_edits ?? 0,
    git_diff_check: executorResponse.git_diff_check === true,
    git_apply_check: executorResponse.git_apply_check === true,
    repo_mutated: executorResponse.repo_mutated === true,
    invariant_verifier_protocol: verificationResponse?.protocol ?? null,
    invariants_total: verificationResponse?.invariants_total ?? null,
    invariants_passed: verificationResponse?.invariants_passed ?? null,
    invariants_failed: verificationResponse?.invariants_failed ?? null,
  }

  try {
    await mkdir(dir, { recursive: true })
    const verificationReceipt = {
      protocol: VERIFICATION_RECEIPT_PROTOCOL,
      generated_at_ms: nowMs(),
      patch_receipt: path.relative(root, receiptPath),
      patch_sha256: receipt.patch_sha256,
      edit_capsule: state.editCapsulePath,
      edit_capsule_sha256: state.editCapsuleHash,
      proof_obligation_protocol: PROOF_OBLIGATION_PROTOCOL,
      proof_assessment: proofAssessment,
      verifier: verificationResponse,
    }
    const receiptBody = JSON.stringify(receipt, null, 2) + "\n"
    const verificationBody = JSON.stringify(verificationReceipt, null, 2) + "\n"
    const receiptSha256 =
      createHash("sha256").update(receiptBody).digest("hex")
    const verificationSha256 =
      createHash("sha256").update(verificationBody).digest("hex")
    await writeFile(patchTemp, patch, "utf8")
    await writeFile(receiptTemp, receiptBody, "utf8")
    await writeFile(verificationTemp, verificationBody, "utf8")
    await rename(patchTemp, patchPath)
    await rename(receiptTemp, receiptPath)
    await rename(verificationTemp, verificationPath)
    return {
      path: path.relative(root, receiptPath),
      verificationPath: path.relative(root, verificationPath),
      receipt,
      verificationReceipt,
      receiptSha256,
      verificationSha256,
    }
  } catch {
    await rm(patchTemp, { force: true }).catch(() => {})
    await rm(receiptTemp, { force: true }).catch(() => {})
    await rm(verificationTemp, { force: true }).catch(() => {})
    await rm(patchPath, { force: true }).catch(() => {})
    await rm(receiptPath, { force: true }).catch(() => {})
    await rm(verificationPath, { force: true }).catch(() => {})
    return null
  }
}


function impactIndexBinary() {
  const override = process.env.OPENCODE_IMPACT_INDEX
  if (typeof override === "string" && override.length > 0) return override
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) return null
  return path.join(home, ".local", "libexec", "opencode-cpu-agent", "opencode-impact-index")
}

function runImpactIndexRequest(root, request, timeoutMs) {
  return new Promise((resolve) => {
    const binary = impactIndexBinary()
    if (!binary) {
      resolve({ ok: false, reason: "binary_path_unavailable", elapsedMs: 0 })
      return
    }
    const started = performance.now()
    const child = spawn(binary, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let outputLimited = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > IMPACT_INDEX_MAX_STDOUT_BYTES) {
        outputLimited = true
        child.kill("SIGKILL")
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 4096) return
      const remaining = 4096 - stderrBytes
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
      stderr.push(Buffer.from(kept))
      stderrBytes += kept.length
    })
    child.stdin.on("error", () => {})
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", error: String(error?.message ?? error) }))
    child.on("close", (code, signal) => {
      if (settled) return
      const stderrText = Buffer.concat(stderr).toString("utf8").trim()
      if (timedOut) return finish({ ok: false, reason: "timeout", error: stderrText || null })
      if (outputLimited) return finish({ ok: false, reason: "stdout_limit", error: stderrText || null })
      if (code !== 0) return finish({ ok: false, reason: "exit_error", exitCode: code, signal: signal ?? null, error: stderrText || null })
      let response
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"))
      } catch (error) {
        return finish({ ok: false, reason: "invalid_json", error: String(error?.message ?? error) })
      }
      if (response?.protocol !== "impact-index-v1") return finish({ ok: false, reason: "protocol_mismatch", response })
      finish({ ok: true, reason: "ok", response })
    })
    try {
      child.stdin.end(JSON.stringify({ root, ...request }))
    } catch (error) {
      child.kill("SIGKILL")
      finish({ ok: false, reason: "stdin_error", error: String(error?.message ?? error) })
    }
  })
}


function taskConstantIdentifiers(taskAnchors) {
  if (taskAnchors?.status !== "compiled" || taskAnchors?.truncated === true) return []
  return [...new Set((taskAnchors?.anchors ?? [])
    .filter((anchor) =>
      anchor?.kind === "constant_identifier" &&
      typeof anchor?.value === "string" &&
      /^[A-Z][A-Z0-9_]{2,79}$/u.test(anchor.value),
    )
    .map((anchor) => anchor.value))].sort()
}

function additiveNeedsDataAccess(requirements) {
  return requirements?.status === "compiled" &&
    (requirements?.required_roles ?? []).includes("data_access_capability")
}

async function dataCapabilitySourceProof(root, file, line, extractor) {
  if (typeof file !== "string" || !Number.isSafeInteger(line) || line < 1) return null
  const rel = evidenceFileKey(file)
  const rootPath = path.resolve(root)
  const candidate = path.resolve(rootPath, rel)
  if (candidate !== rootPath && !candidate.startsWith(rootPath + path.sep)) return null
  try {
    const body = await readFile(candidate)
    return Object.freeze({
      file: rel,
      line,
      sha256: createHash("sha256").update(body).digest("hex"),
      extractor,
    })
  } catch {
    return null
  }
}

async function resolveTaskBoundDataCapability({root, state, anchorFrontier, coverageRequirements}) {
  const empty = {
    providerResolution: null,
    projection: Object.freeze({
      protocol: DATA_OBLIGATION_PROJECTOR_PROTOCOL,
      authority: "proof_projection_only",
      status: "abstained",
      reason: "not_required",
      proofs: Object.freeze([]),
      localization_authority: false,
      mutation_authority: false,
    }),
  }
  if (
    !state ||
    !additiveNeedsDataAccess(coverageRequirements) ||
    anchorFrontier?.status !== "bound" ||
    typeof anchorFrontier?.owner_file !== "string"
  ) return empty

  const identities = taskConstantIdentifiers(state?.taskAnchors)
  if (identities.length > DATA_PROVIDER_IDENTITY_MAX_TASK_IDENTITIES) {
    const providerResolution = {
      protocol: "impact-index-v1",
      mode: "data_provider_identity",
      ready: false,
      complete: false,
      reason: "task_constant_identity_budget_exceeded",
      observations: [],
    }
    return {
      ...empty,
      providerResolution,
      projection: projectDataAccessObligation({
        taskSha256: state?.taskRequirements?.task_sha256,
        taskAnchors: state?.taskAnchors,
        coverageRequirements,
        anchorFrontier,
        providerResolution,
      }),
    }
  }

  const cacheKey = JSON.stringify([
    state?.taskRequirements?.task_sha256 ?? null,
    anchorFrontier.owner_file,
    identities,
  ])
  if (state?.dataCapabilityObservation?.cacheKey === cacheKey) {
    return state.dataCapabilityObservation.value
  }

  const request = await runImpactIndexRequest(
    root,
    {
      mode: "data_provider_identity",
      identities,
      max_files_per_identity: DATA_PROVIDER_IDENTITY_MAX_FILES_PER_IDENTITY,
    },
    DATA_PROVIDER_IDENTITY_REQUEST_TIMEOUT_MS,
  )
  const providerResolution = request?.ok === true
    ? request.response
    : {
        protocol: "impact-index-v1",
        mode: "data_provider_identity",
        ready: false,
        complete: false,
        reason: request?.reason ?? "provider_request_failed",
        observations: [],
      }

  const providerProofs = {}
  const bindingByProvider = {}
  const bindingProofs = {}

  if (providerResolution?.ready === true && providerResolution?.complete === true) {
    for (const observation of providerResolution?.observations ?? []) {
      if (
        observation?.search_complete !== true ||
        observation?.truncated === true ||
        !identities.includes(observation?.identity)
      ) continue

      for (const candidate of observation?.candidates ?? []) {
        if (
          candidate?.configuration_identity !== observation.identity ||
          candidate?.constructor_family !== "python-psycopg2" ||
          typeof candidate?.file !== "string" ||
          typeof candidate?.symbol !== "string"
        ) continue

        const providerFile = evidenceFileKey(candidate.file)
        const key = [observation.identity, providerFile, candidate.symbol].join("\0")
        const providerProof = await dataCapabilitySourceProof(
          root,
          providerFile,
          candidate.witness_line,
          "impact-index-data-provider-identity-v1",
        )
        if (!providerProof) continue
        providerProofs[key] = providerProof

        const bindingResult = await runImpactIndexRequest(
          root,
          {
            mode: "symbol_binding_into_file",
            source_file: providerFile,
            source_symbol: candidate.symbol,
            importer_file: evidenceFileKey(anchorFrontier.owner_file),
          },
          DATA_PROVIDER_SYMBOL_BINDING_TIMEOUT_MS,
        )
        if (bindingResult?.ok !== true) {
          bindingByProvider[key] = {
            protocol: "impact-index-v1",
            mode: "symbol_binding_into_file",
            ready: false,
            complete: false,
            reason: bindingResult?.reason ?? "binding_request_failed",
            source_file: providerFile,
            source_symbol: candidate.symbol,
            importer_file: evidenceFileKey(anchorFrontier.owner_file),
            bindings: [],
          }
          continue
        }
        bindingByProvider[key] = bindingResult.response

        const binding = (bindingResult.response?.bindings ?? [])
          .filter((row) =>
            evidenceFileKey(row?.importer) === evidenceFileKey(anchorFrontier.owner_file) &&
            evidenceFileKey(row?.target) === providerFile &&
            row?.source_symbol === candidate.symbol &&
            row?.confidence === "exact_local" &&
            Number.isSafeInteger(row?.witness_line),
          )
          .sort((a, b) => a.witness_line - b.witness_line)[0]
        if (!binding) continue

        const bindingProof = await dataCapabilitySourceProof(
          root,
          binding.importer,
          binding.witness_line,
          "impact-index-symbol-binding-into-file-v1",
        )
        if (bindingProof) bindingProofs[key] = bindingProof
      }
    }
  }

  const projection = projectDataAccessObligation({
    taskSha256: state?.taskRequirements?.task_sha256,
    taskAnchors: state?.taskAnchors,
    coverageRequirements,
    anchorFrontier,
    providerResolution,
    providerProofs,
    bindingByProvider,
    bindingProofs,
  })
  const value = {providerResolution, bindingByProvider, projection}
  state.dataCapabilityObservation = {cacheKey, value}
  return value
}

function impactIndexShadowStats(result, lexicalFiles) {
  const lexical = new Set((lexicalFiles ?? []).map((entry) =>
    evidenceFileKey(typeof entry === "string" ? entry : entry?.file),
  ))
  const neighbors = result?.ok && Array.isArray(result?.query?.response?.neighbors)
    ? result.query.response.neighbors
    : []
  const lexicalMisses = neighbors.filter((neighbor) =>
    typeof neighbor?.file === "string" && !lexical.has(evidenceFileKey(neighbor.file)),
  )
  const refresh = result?.refresh?.response ?? null
  const query = result?.query?.response ?? null

  return {
    attempted: result?.attempted === true,
    ok: result?.ok === true,
    reason: result?.reason ?? "unknown",
    elapsedMs: result?.elapsedMs ?? 0,
    refreshDue: result?.refreshDue === true,
    refreshDeferred: result?.refreshDeferred === true,
    refreshOk:
      result?.refresh?.ok === true &&
      refresh?.mode === "refresh" &&
      refresh?.ready === true,
    refreshComplete: query?.coverage_complete ?? refresh?.coverage_complete ?? refresh?.refresh_complete ?? null,
    partialReason: query?.partial_reason ?? refresh?.partial_reason ?? null,
    inventoryKind: query?.inventory_kind ?? refresh?.inventory_kind ?? null,
    refreshReason: result?.refresh?.reason ?? null,
    refreshElapsedMs: result?.refresh?.elapsedMs ?? null,
    queryElapsedMs: result?.query?.elapsedMs ?? null,
    cacheAgeMs: query?.cache_age_ms ?? null,
    staleSeedFiles: query?.stale_seed_files ?? 0,
    staleWitnessEdges: query?.stale_witness_edges ?? 0,
    taskFiltersApplied: query?.task_filters_applied === true,
    bootstrapCacheHit: false,
    filesTotal: query?.files_total ?? refresh?.files_total ?? null,
    filesReused: refresh?.files_reused ?? null,
    filesReindexed: refresh?.files_reindexed ?? null,
    filesRemoved: refresh?.files_removed ?? null,
    importsTotal: query?.imports_total ?? refresh?.imports_total ?? null,
    edgesTotal: query?.edges_total ?? refresh?.edges_total ?? null,
    resolvedImports: query?.local_resolved ?? refresh?.local_resolved ?? refresh?.resolved_imports ?? null,
    unresolvedImports: query?.local_unresolved ?? refresh?.local_unresolved ?? null,
    ambiguousImports: query?.local_ambiguous ?? refresh?.local_ambiguous ?? null,
    externalPackages: query?.external_package ?? refresh?.external_package ?? null,
    unsupportedAliases: query?.unsupported_alias ?? refresh?.unsupported_alias ?? null,
    unsupportedDynamic: query?.unsupported_dynamic ?? refresh?.unsupported_dynamic ?? null,
    neighborsTotal: query?.neighbors_total ?? null,
    neighborsShown: neighbors.length,
    lexicalMisses: lexicalMisses.length,
    forwardNeighbors: neighbors.filter((neighbor) => neighbor?.direction === "forward").length,
    reverseNeighbors: neighbors.filter((neighbor) => neighbor?.direction === "reverse").length,
    candidates: lexicalMisses.slice(0, IMPACT_INDEX_MAX_NEIGHBORS).map((neighbor) => ({
      file: neighbor.file,
      seed: neighbor.seed,
      direction: neighbor.direction,
      kind: neighbor.kind,
      confidence: neighbor.confidence,
      witness_file: neighbor.witness_file,
      witness_line: neighbor.witness_line,
      spec: neighbor.spec,
      bindings: Array.isArray(neighbor.bindings) ? neighbor.bindings : [],
      source_symbols: Array.isArray(neighbor.source_symbols) ? neighbor.source_symbols : [],
      binding_pairs: Array.isArray(neighbor.binding_pairs) ? neighbor.binding_pairs : [],
      witness: neighbor.witness ?? null,
    })),
  }
}

function impactStatsForTaskQuery(queryResult, lexicalFiles, reason = "impact_task_filtered", refresh = null) {
  const response = queryResult?.response ?? null
  const age = Number(response?.cache_age_ms)
  const ready =
    queryResult?.ok === true &&
    response?.mode === "neighbors" &&
    response?.ready === true &&
    Array.isArray(response?.neighbors)
  const staleSeedFiles = Number(response?.stale_seed_files ?? 0)
  const staleWitnessEdges = Number(response?.stale_witness_edges ?? 0)
  const refreshDue =
    queryResult?.ok === true && (
      !ready ||
      !Number.isFinite(age) ||
      age >= IMPACT_INDEX_REFRESH_TTL_MS ||
      staleSeedFiles > 0 ||
      staleWitnessEdges > 0
    )
  return impactIndexShadowStats({
    attempted: true,
    ok: ready,
    reason: ready ? reason : queryResult?.reason ?? "query_unavailable",
    elapsedMs: queryResult?.elapsedMs ?? 0,
    refreshDue,
    refreshDeferred: ready && refreshDue,
    refresh,
    query: queryResult,
  }, lexicalFiles)
}

function regexEscape(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function impactSymbolArray(values, cap = IMPACT_EDGE_SYMBOL_CAP) {
  const out = []
  for (const value of values ?? []) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ||
      value.length > 80
    ) continue
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

function impactBindingList(values) {
  return [...new Set(impactSymbolArray(values, IMPACT_BINDINGS_PER_CANDIDATE))]
}

function impactRelationPairs(candidate) {
  const local = impactSymbolArray(candidate?.bindings)
  const source = impactSymbolArray(candidate?.source_symbols)
  const explicit = []
  for (const pair of candidate?.binding_pairs ?? []) {
    const localName = typeof pair?.local === "string" ? pair.local : null
    const sourceName = typeof pair?.source === "string" ? pair.source : null
    if (!localName || !sourceName) continue
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(localName) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sourceName)) continue
    explicit.push({ local: localName, source: sourceName })
    if (explicit.length >= IMPACT_EDGE_SYMBOL_CAP) break
  }
  if (explicit.length > 0) return { local, source, pairs: explicit }

  // Fail-open only for identity mappings. Old caches are rejected by cache
  // version, but this keeps helper skew conservative instead of guessing alias
  // alignment from two independently ordered arrays.
  const pairs = []
  if (local.length === source.length && local.every((value, index) => value === source[index])) {
    for (let i = 0; i < local.length; i += 1) pairs.push({ local: local[i], source: source[i] })
  }
  return { local, source, pairs }
}

function impactLanguage(file) {
  const base = path.basename(String(file ?? "")).toLowerCase()
  if (base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "docker"
  const ext = path.extname(base).slice(1)
  if (ext === "py") return "python"
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript"
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript"
  if (["html", "htm"].includes(ext)) return "html"
  if (ext === "css") return "css"
  if (["xml", "xsd", "xsl", "xslt"].includes(ext)) return "xml"
  if (ext === "sql") return "sql"
  return "other"
}

function impactIdentifiers(text) {
  const out = new Set()
  const stop = new Set([
    "and", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "def", "default", "do", "else", "except", "export", "extends", "false", "finally", "for",
    "from", "function", "if", "import", "in", "interface", "let", "new", "none", "null", "of",
    "pass", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "var",
    "while", "with", "yield",
  ])
  const pattern = /[A-Za-z_$][A-Za-z0-9_$]*/g
  for (const match of String(text ?? "").matchAll(pattern)) {
    const value = match[0]
    // One-character local aliases are common in Python/JS/TS (for example
    // `import { handle as h } ...`). Candidate matching remains exact and is
    // followed by source validation, so retaining them is safer than silently
    // losing a real dependency edge.
    if (value.length < 1 || stop.has(value.toLowerCase())) continue
    out.add(value)
    if (out.size >= IMPACT_SCOPE_IDENTIFIER_CAP) break
  }
  return out
}

function impactDeclaredSymbols(line, language) {
  const text = String(line ?? "").trim()
  const out = new Set()
  const patterns = language === "python"
    ? [
        /^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/,
      ]
    : [
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:export\s+)?(?:default\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
        /^(?:(?:public|private|protected|static|readonly|async|abstract|override|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\)\s*(?::[^={]+)?\s*\{?/,
      ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match?.[1]) continue
    const value = match[1]
    if (!["if", "for", "while", "switch", "catch", "function", "constructor"].includes(value)) out.add(value)
  }
  return out
}

function impactPythonOwnerSymbols(lines, ranges, hitLines) {
  const owners = new Set()
  for (const range of ranges ?? []) {
    const start = Math.max(0, range.start ?? 0)
    for (const value of impactDeclaredSymbols(lines[start] ?? "", "python")) owners.add(value)
    const baseIndent = impactIndent(lines[start] ?? "")
    let ceilingIndent = baseIndent
    for (let i = start - 1; i >= Math.max(0, start - IMPACT_SCOPE_MAX_LINES); i -= 1) {
      const line = lines[i] ?? ""
      const match = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
      if (!match) continue
      const indent = impactIndent(line)
      if (indent < ceilingIndent) {
        owners.add(match[1]); ceilingIndent = indent
        if (indent === 0) break
      }
    }
  }
  for (const lineNo of hitLines ?? []) {
    for (const value of impactDeclaredSymbols(lines[Math.max(0, lineNo - 1)] ?? "", "python")) owners.add(value)
  }
  return owners
}

function impactBraceEnclosingOwner(lines, start) {
  let depth = 0
  for (let i = start - 1; i >= Math.max(0, start - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i] ?? ""
    for (let j = line.length - 1; j >= 0; j -= 1) {
      const ch = line[j]
      if (ch === "}") depth += 1
      else if (ch === "{") {
        if (depth > 0) depth -= 1
        else {
          for (const value of impactDeclaredSymbols(line, "typescript")) return value
        }
      }
    }
  }
  return null
}

function impactBraceOwnerSymbols(lines, ranges, hitLines, language) {
  const owners = new Set()
  for (const range of ranges ?? []) {
    const start = Math.max(0, range.start ?? 0)
    const end = Math.min(lines.length - 1, start + 5)
    for (let i = Math.max(0, start - 2); i <= end; i += 1) {
      for (const value of impactDeclaredSymbols(lines[i] ?? "", language)) owners.add(value)
    }
    const enclosing = impactBraceEnclosingOwner(lines, start)
    if (enclosing) owners.add(enclosing)
  }
  for (const lineNo of hitLines ?? []) {
    for (const value of impactDeclaredSymbols(lines[Math.max(0, lineNo - 1)] ?? "", language)) owners.add(value)
  }
  return owners
}

function impactOwnerSymbols(lines, ranges, hitLines, language) {
  if (!Array.isArray(lines)) return new Set()
  if (language === "python") return impactPythonOwnerSymbols(lines, ranges, hitLines)
  if (["javascript", "typescript"].includes(language)) return impactBraceOwnerSymbols(lines, ranges, hitLines, language)
  return new Set()
}

function impactIndent(line) {
  const match = String(line ?? "").match(/^[ \t]*/)
  return match ? match[0].replace(/\t/g, "    ").length : 0
}

function impactWindowRange(lines, lineNo, radius = IMPACT_SCOPE_WINDOW_RADIUS) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  return {
    start: Math.max(0, center - radius),
    end: Math.min(lines.length - 1, center + radius),
  }
}

function impactPythonRange(lines, lineNo) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  const hitIndent = impactIndent(lines[center])
  const defPattern = /^\s*(?:async\s+def|def|class)\s+[A-Za-z_][A-Za-z0-9_]*\b/
  let start = -1
  let baseIndent = -1

  for (let i = center; i >= Math.max(0, center - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i]
    if (!defPattern.test(line)) continue
    const indent = impactIndent(line)
    if (indent <= hitIndent) {
      start = i
      baseIndent = indent
      break
    }
  }

  if (start < 0) return impactWindowRange(lines, lineNo)
  let end = Math.min(lines.length - 1, start + IMPACT_SCOPE_MAX_LINES - 1)
  for (let i = start + 1; i < lines.length && i <= end; i += 1) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (impactIndent(lines[i]) <= baseIndent && !/^\s*@/.test(lines[i])) {
      end = i - 1
      break
    }
  }
  return { start, end }
}

function impactBraceRange(lines, lineNo) {
  const center = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  let balance = 0
  let start = -1
  for (let i = center; i >= Math.max(0, center - IMPACT_SCOPE_MAX_LINES); i -= 1) {
    const line = lines[i]
    for (let j = line.length - 1; j >= 0; j -= 1) {
      if (line[j] === "}") balance += 1
      else if (line[j] === "{") {
        if (balance === 0) {
          start = i
          break
        }
        balance -= 1
      }
    }
    if (start >= 0) break
  }
  if (start < 0) return impactWindowRange(lines, lineNo)

  balance = 0
  let end = Math.min(lines.length - 1, start + IMPACT_SCOPE_MAX_LINES - 1)
  outer: for (let i = start; i < lines.length && i <= end; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") balance += 1
      else if (ch === "}") {
        balance -= 1
        if (balance <= 0) {
          end = i
          break outer
        }
      }
    }
  }
  return { start, end }
}

function impactRangeForLanguage(lines, lineNo, language) {
  if (language === "python") return impactPythonRange(lines, lineNo)
  if (["javascript", "typescript", "css"].includes(language)) return impactBraceRange(lines, lineNo)
  return impactWindowRange(lines, lineNo)
}

function impactMergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

async function buildImpactSeedContexts(root, probeResults) {
  const byFile = new Map()
  for (const hit of mergeHits(probeResults).values()) {
    const file = evidenceFileKey(hit.file)
    let entry = byFile.get(file)
    if (!entry) {
      entry = { file, hitLines: new Set(), fallbackText: [] }
      byFile.set(file, entry)
    }
    entry.hitLines.add(hit.line)
    entry.fallbackText.push(hit.text ?? "")
  }

  const contexts = new Map()
  await Promise.all([...byFile.values()].map(async (entry) => {
    const language = impactLanguage(entry.file)
    const resolved = path.resolve(root, entry.file)
    let lines = null
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      try {
        const source = await readFile(resolved, "utf8")
        if (bytes(source) <= MAX_CONTEXT_FILE_BYTES) lines = source.split(/\r?\n/)
      } catch {}
    }

    const ranges = []
    const chunks = []
    if (lines) {
      for (const lineNo of [...entry.hitLines].slice(0, 12)) {
        ranges.push(impactRangeForLanguage(lines, lineNo, language))
      }
      for (const range of impactMergeRanges(ranges)) {
        chunks.push(lines.slice(range.start, range.end + 1).join("\n"))
      }
    } else {
      chunks.push(...entry.fallbackText)
    }

    const mergedRanges = impactMergeRanges(ranges)
    const text = chunks.join("\n")
    contexts.set(entry.file, {
      file: entry.file,
      language,
      identifiers: impactIdentifiers(text),
      ownerSymbols: impactOwnerSymbols(lines, mergedRanges, entry.hitLines, language),
      ranges: mergedRanges,
      text,
      hitLines: entry.hitLines,
    })
  }))
  return contexts
}

function impactFilterSymbols(values, cap = IMPACT_FILTER_SYMBOL_CAP) {
  const out = []
  const seen = new Set()
  for (const value of values ?? []) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ||
      value.length > 80 ||
      seen.has(value)
    ) continue
    seen.add(value)
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

function impactSeedFilters(seedContexts) {
  return [...seedContexts.entries()].map(([seed, context]) => ({
    seed,
    forward_bindings: impactFilterSymbols(context?.identifiers),
    reverse_source_symbols: impactFilterSymbols(context?.ownerSymbols),
  }))
}

async function runTaskFilteredImpactQuery(root, seedContexts) {
  const seedFilters = impactSeedFilters(seedContexts)
  const seeds = seedFilters.map((entry) => entry.seed)
  if (seeds.length < 1) return null
  return await runImpactIndexRequest(
    root,
    {
      mode: "neighbors",
      seed_files: seeds,
      seed_filters: seedFilters,
      max_neighbors: IMPACT_INDEX_MAX_NEIGHBORS,
      check_freshness: true,
    },
    IMPACT_INDEX_QUERY_TIMEOUT_MS,
  )
}

function impactMatchedForwardSymbols(candidate, context) {
  const { local, source, pairs } = impactRelationPairs(candidate)
  const matched = []
  if (pairs.length > 0) {
    for (const pair of pairs) {
      if (context?.identifiers?.has(pair.local)) matched.push(pair.source)
    }
    return [...new Set(matched)].slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
  }
  const matchedLocals = local.filter((value) => context?.identifiers?.has(value))
  if (matchedLocals.length < 1 || source.length > 0) return []
  return impactMemberSymbols(context, matchedLocals).slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
}

function impactMatchedReverseBindings(candidate, context) {
  const { pairs } = impactRelationPairs(candidate)
  const matched = []
  for (const pair of pairs) {
    if (context?.ownerSymbols?.has(pair.source)) matched.push(pair.local)
  }
  return [...new Set(matched)].slice(0, IMPACT_VALIDATION_SYMBOL_CAP)
}

function impactMemberSymbols(context, bindings) {
  const out = new Set()
  for (const binding of [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))]) {
    const pattern = new RegExp(`\\b${regexEscape(binding)}\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, "g")
    for (const match of context?.text?.matchAll(pattern) ?? []) {
      out.add(match[1])
      if (out.size >= IMPACT_VALIDATION_SYMBOL_CAP) return [...out]
    }
  }
  return [...out]
}

async function impactExpansionScope(root, target) {
  if (target === "." || target === "./" || target === "") return { kind: "root", root }
  const candidate = path.resolve(root, target)
  let resolved
  let info
  try {
    resolved = await realpath(candidate)
    info = await stat(resolved)
  } catch {
    return { kind: "blocked", reason: "target_unavailable" }
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return { kind: "blocked", reason: "target_outside_root" }
  if (info.isFile()) return { kind: "blocked", reason: "explicit_file_scope" }
  if (!info.isDirectory()) return { kind: "blocked", reason: "target_not_directory" }
  return { kind: "directory", root: resolved }
}

function impactFileAllowedByScope(root, file, scope) {
  if (!scope || scope.kind === "blocked") return false
  const resolved = path.resolve(root, evidenceFileKey(file))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false
  if (scope.kind === "root") return true
  return resolved === scope.root || resolved.startsWith(scope.root + path.sep)
}

function buildImpactHypotheses(impactStats, probeFiles, seedContexts, root, scope) {
  if (!impactStats?.ok || !Array.isArray(impactStats?.candidates)) return { hypotheses: [], rejectedByScope: 0 }

  const lexical = new Set((probeFiles ?? []).map((entry) => evidenceFileKey(entry.file)))
  const seedQueries = new Map((probeFiles ?? []).map((entry) => [evidenceFileKey(entry.file), new Set(entry.queries ?? [])]))
  const grouped = new Map()
  let rejectedByScope = 0

  for (const candidate of impactStats.candidates) {
    const file = evidenceFileKey(candidate?.file)
    const seed = evidenceFileKey(candidate?.seed)
    if (!file || !seed || lexical.has(file)) continue
    if (candidate?.confidence !== "exact_local") continue
    if (!impactFileAllowedByScope(root, file, scope)) continue

    const context = seedContexts.get(seed)
    if (!context) {
      rejectedByScope += 1
      continue
    }

    let forwardSymbols = []
    let reverseBindings = []
    if (candidate.direction === "forward") {
      forwardSymbols = impactMatchedForwardSymbols(candidate, context)
    } else if (candidate.direction === "reverse") {
      reverseBindings = impactMatchedReverseBindings(candidate, context)
    }

    if (forwardSymbols.length < 1 && reverseBindings.length < 1) {
      rejectedByScope += 1
      continue
    }

    const rawLocal = impactSymbolArray(candidate?.bindings)
    const rawSource = impactSymbolArray(candidate?.source_symbols)
    let entry = grouped.get(file)
    if (!entry) {
      entry = {
        file,
        queries: new Set(),
        relations: [],
        forwardSymbols: new Set(),
        reverseBindings: new Set(),
        displayBindings: new Set(),
        hasForward: false,
        hasReverse: false,
      }
      grouped.set(file, entry)
    }

    for (const queryIndex of seedQueries.get(seed) ?? []) entry.queries.add(queryIndex)
    for (const symbol of forwardSymbols) entry.forwardSymbols.add(symbol)
    for (const binding of reverseBindings) entry.reverseBindings.add(binding)
    for (const value of [...rawLocal, ...rawSource]) entry.displayBindings.add(value)
    entry.hasForward ||= candidate.direction === "forward"
    entry.hasReverse ||= candidate.direction === "reverse"
    entry.relations.push({ ...candidate, file, seed, bindings: rawLocal, source_symbols: rawSource })
  }

  const hypotheses = [...grouped.values()]
    .map((entry) => ({
      ...entry,
      forwardSymbols: [...entry.forwardSymbols].slice(0, IMPACT_VALIDATION_SYMBOL_CAP),
      reverseBindings: [...entry.reverseBindings].slice(0, IMPACT_VALIDATION_SYMBOL_CAP),
      displayBindings: [...entry.displayBindings].slice(0, IMPACT_BINDINGS_PER_CANDIDATE),
    }))
    .filter((entry) => entry.forwardSymbols.length > 0 || entry.reverseBindings.length > 0)
    .sort(
      (a, b) =>
        Number(b.hasForward) - Number(a.hasForward) ||
        b.queries.size - a.queries.size ||
        (b.forwardSymbols.length + b.reverseBindings.length) - (a.forwardSymbols.length + a.reverseBindings.length) ||
        a.file.localeCompare(b.file),
    )
    // This is the actual graph-file probe budget. We deliberately do not hide
    // extra deterministic file reads behind a larger "validation pool".
    .slice(0, IMPACT_GRAPH_PROBE_MAX_FILES)

  return { hypotheses, rejectedByScope }
}

function runImpactValidationQuery(root, file, bindings, glob) {
  return new Promise((resolve) => {
    const escaped = [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))].map(regexEscape)
    if (escaped.length < 1) {
      resolve({ ok: false, reason: "no_bindings", matches: [], scanComplete: true, elapsedMs: 0 })
      return
    }
    const pattern = escaped.length === 1 ? escaped[0] : `(?:${escaped.join("|")})`
    const args = ["--json", "--color", "never", "--max-columns", "500", "--max-columns-preview"]
    appendSearchGlobs(args, glob)
    args.push("--", pattern, file)

    const started = performance.now()
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    const matches = []
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let capped = false
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, pattern, matches, elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, IMPACT_VALIDATION_TIMEOUT_MS)

    function consume(line) {
      if (!line.trim() || capped) return
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event?.type !== "match") return
      const matchFile = event.data?.path?.text
      const lineNo = event.data?.line_number
      if (typeof matchFile !== "string" || !Number.isInteger(lineNo)) return
      if (isReservedAgentEvidencePath(matchFile)) return
      if (matches.length >= IMPACT_VALIDATION_HIT_CAP) { capped = true; child.kill("SIGTERM"); return }
      matches.push({ file: matchFile, line: lineNo, text: event.data?.lines?.text ?? "", exactMatches: Array.isArray(event.data?.submatches) ? event.data.submatches.length : 0 })
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
      while (true) {
        const pos = stdout.indexOf("\n")
        if (pos < 0) break
        consume(stdout.slice(0, pos))
        stdout = stdout.slice(pos + 1)
      }
    })
    child.stderr.on("data", (chunk) => { if (stderr.length < 2000) stderr += chunk.toString("utf8") })
    child.on("error", (error) => finish({ ok: false, reason: "spawn_error", scanComplete: false, error: String(error?.message ?? error) }))
    child.on("close", (code) => {
      if (!capped && stdout.trim()) consume(stdout)
      if (timedOut) return finish({ ok: false, reason: "timeout", scanComplete: false, error: stderr.trim() || null })
      if (capped) return finish({ ok: true, reason: "hit_cap", scanComplete: false, error: null })
      if (code !== 0 && code !== 1) return finish({ ok: false, reason: "exit_error", scanComplete: false, error: stderr.trim() || `rg exited with status ${code}` })
      finish({ ok: true, reason: "complete", scanComplete: true, error: null })
    })
  })
}

function impactDefinitionMatch(text, bindings) {
  const line = String(text ?? "").trim()
  if (!line) return false
  for (const binding of bindings ?? []) {
    const name = regexEscape(binding)
    const patterns = [
      new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:def|class|function|interface|type|enum)\\s+${name}\\b`),
      new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`),
      new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|type|const|static)\\s+${name}\\b`),
    ]
    if (patterns.some((pattern) => pattern.test(line))) return true
  }
  return false
}

function impactLineContainsBinding(text, bindings) {
  const line = String(text ?? "")
  return [...new Set(impactSymbolArray(bindings, IMPACT_VALIDATION_SYMBOL_CAP))]
    .some((binding) => new RegExp(`\\b${regexEscape(binding)}\\b`).test(line))
}

async function validateImpactHypotheses(root, target, glob, probeFiles, probeResults) {
  const scope = await impactExpansionScope(root, target)
  const emptyStats = impactIndexShadowStats({
    attempted: false, ok: false, reason: scope.kind === "blocked" ? scope.reason : "not_queried",
    elapsedMs: 0, refreshDue: false, refreshDeferred: false, refresh: null, query: null,
  }, probeFiles)
  if (scope.kind === "blocked") {
    return {
      attempted: false, reason: scope.reason, hypotheses: [], validated: [], rejected: [], elapsedMs: 0,
      queryCount: 0, scopeRejected: 0, seedContexts: 0, ownerSymbols: 0,
      filterQueryUsed: false, filterQueryElapsedMs: null, refreshFallbackAttempted: false,
      refreshFallbackElapsedMs: null, pairwiseConditioned: true, indexStats: emptyStats,
    }
  }

  const seedContexts = await buildImpactSeedContexts(root, probeResults)
  const ownerSymbols = [...seedContexts.values()].reduce((sum, context) => sum + (context.ownerSymbols?.size ?? 0), 0)
  let filterQueryUsed = false
  let filterQueryElapsedMs = null
  let refreshFallbackAttempted = false
  let refreshFallbackElapsedMs = null
  let refresh = null

  async function queryTaskGraph(reason) {
    const query = await runTaskFilteredImpactQuery(root, seedContexts)
    filterQueryUsed = query != null
    if (query) filterQueryElapsedMs = (filterQueryElapsedMs ?? 0) + (query.elapsedMs ?? 0)
    return query ? impactStatsForTaskQuery(query, probeFiles, reason, refresh) : emptyStats
  }

  async function validateStats(stats) {
    const built = buildImpactHypotheses(stats, probeFiles, seedContexts, root, scope)
    const hypotheses = built.hypotheses
    if (hypotheses.length < 1) {
      return {
        attempted: false,
        reason: stats?.ok ? "no_scope_relevant_hypotheses" : "impact_index_unavailable",
        hypotheses: [], validated: [], rejected: [], elapsedMs: 0, queryCount: 0,
        scopeRejected: built.rejectedByScope,
      }
    }

    const started = performance.now()
    const checks = await Promise.all(hypotheses.map(async (hypothesis) => {
      const validationTerms = [...new Set([...hypothesis.forwardSymbols, ...hypothesis.reverseBindings])]
      const validation = await runImpactValidationQuery(root, hypothesis.file, validationTerms, glob)
      const matches = validation.matches ?? []
      const declarationMatches = matches.filter((match) => impactDefinitionMatch(match.text, hypothesis.forwardSymbols))
      const reverseWitnessLines = new Set(
        hypothesis.relations
          .filter((relation) => relation.direction === "reverse" && evidenceFileKey(relation.witness_file) === evidenceFileKey(hypothesis.file) && Number.isInteger(relation.witness_line))
          .map((relation) => relation.witness_line),
      )
      const reverseUsageMatches = matches.filter(
        (match) => !reverseWitnessLines.has(match.line) && impactLineContainsBinding(match.text, hypothesis.reverseBindings),
      )
      const forwardValidated = hypothesis.forwardSymbols.length > 0 && declarationMatches.length > 0
      const reverseValidated = hypothesis.reverseBindings.length > 0 && reverseUsageMatches.length > 0
      const validated = validation.ok && (forwardValidated || reverseValidated)

      return {
        ...hypothesis,
        validation,
        validated,
        validationKind: forwardValidated ? "forward_scope_definition" : reverseValidated ? "reverse_scope_usage" : null,
        declarationMatches,
        reverseUsageMatches,
      }
    }))

    const validated = checks.filter((entry) => entry.validated).sort(
      (a, b) =>
        Number(b.validationKind === "forward_scope_definition") - Number(a.validationKind === "forward_scope_definition") ||
        b.queries.size - a.queries.size || a.file.localeCompare(b.file),
    )
    return {
      attempted: true,
      reason: validated.length > 0 ? "validated_scope_conditioned" : "all_rejected",
      hypotheses,
      validated,
      rejected: checks.filter((entry) => !entry.validated),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      queryCount: checks.length,
      scopeRejected: built.rejectedByScope,
    }
  }

  let indexStats = await queryTaskGraph("impact_task_filtered")
  const initialIndexStats = {
    refreshDue: indexStats?.refreshDue === true,
    staleSeedFiles: Number(indexStats?.staleSeedFiles ?? 0),
    staleWitnessEdges: Number(indexStats?.staleWitnessEdges ?? 0),
    reason: indexStats?.reason ?? null,
    cacheAgeMs: indexStats?.cacheAgeMs ?? null,
  }
  let result = await validateStats(indexStats)

  // A stale graph is only a hypothesis. We can reuse a source-validated edge
  // when its import witness file is unchanged. If task-local routing misses and
  // the helper reports age/fingerprint staleness (or no readable cache), do one
  // synchronous refresh and one filtered retry.
  if (result.validated.length < 1 && indexStats.refreshDue === true) {
    refreshFallbackAttempted = true
    refresh = await runImpactIndexRequest(root, { mode: "refresh" }, IMPACT_INDEX_REFRESH_TIMEOUT_MS)
    refreshFallbackElapsedMs = refresh?.elapsedMs ?? null
    if (refresh?.ok === true && refresh.response?.ready === true) {
      indexStats = await queryTaskGraph("impact_refreshed_task_filtered")
      indexStats.refresh = refresh
      indexStats.refreshOk = true
      indexStats.refreshElapsedMs = refresh.elapsedMs ?? null
      result = await validateStats(indexStats)
    }
  }

  return {
    ...result,
    seedContexts: seedContexts.size,
    ownerSymbols,
    filterQueryUsed,
    filterQueryElapsedMs,
    refreshFallbackAttempted,
    refreshFallbackElapsedMs,
    initialIndexStats,
    pairwiseConditioned: true,
    indexStats,
  }
}
