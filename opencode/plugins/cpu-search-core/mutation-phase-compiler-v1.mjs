import { createHash } from "node:crypto"

export const MUTATION_PHASE_COMPILER_PROTOCOL =
  "mutation-phase-compiler-v1"
export const STRUCTURED_MUTATION_CONTROL_PROTOCOL =
  "structured-mutation-control-v1"

const STRUCTURED_MUTATION_CONTROL_MAX_EXPANSION_BYTES = 2048
const STRUCTURED_MUTATION_CONTROL_SHA256_RE = /^[0-9a-f]{64}$/u
const STRUCTURED_MUTATION_CONTROL_TOKEN_RE = /^[A-Za-z0-9_.:-]+$/u
const MUTATION_PHASE_TASK_MAX_BYTES = 4096
const MUTATION_PHASE_ENVELOPE_MAX_BYTES = 8192

const MUTATION_PHASE_SYSTEM =
  "You are the bounded semantic synthesis stage of a coding transaction. " +
  "Call exactly the single exposed mutation tool. Emit no prose. " +
  "Repository scope, files, slots, operations, and authority are deterministic; " +
  "supply only semantic payload fields required by the schema and mutation envelope. " +
  "Prefer the smallest complete implementation that satisfies every required operation."

function bytes(value) {
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value ?? null),
    "utf8",
  )
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function utf8Prefix(value, maxBytes) {
  const text = typeof value === "string" ? value : ""
  if (bytes(text) <= maxBytes) return text
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
}

function compactTaskText(value) {
  const text = typeof value === "string" ? value : ""
  return utf8Prefix(
    text
      .replace(/\r\n?/gu, "\n")
      .replace(/[ \t]+/gu, " ")
      .replace(/\n[ \t]+/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
    MUTATION_PHASE_TASK_MAX_BYTES,
  )
}

function textCandidates(value, depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return []
  if (typeof value === "string") return [value]
  if (typeof value !== "object") return []
  if (seen.has(value)) return []
  seen.add(value)

  const out = []
  if (Array.isArray(value)) {
    for (const item of value) {
      out.push(...textCandidates(item, depth + 1, seen))
    }
    return out
  }

  const priority = [
    "text",
    "output",
    "content",
    "result",
    "state",
    "message",
  ]
  const used = new Set()

  for (const key of priority) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    used.add(key)
    out.push(...textCandidates(value[key], depth + 1, seen))
  }

  for (const [key, item] of Object.entries(value)) {
    if (used.has(key)) continue
    out.push(...textCandidates(item, depth + 1, seen))
  }

  return out
}

const CANONICAL_MUTATION_ENVELOPE_EXTRACTION_PROTOCOL =
  "canonical-mutation-envelope-extraction-v1"

const CANONICAL_MUTATION_ENVELOPE_START =
  "MUTATION_CONTENT_ENVELOPE protocol="

const CANONICAL_MUTATION_ENVELOPE_END =
  "NEXT_ACTION="

function normalizeEnvelopeCarrierText(value) {
  return typeof value === "string"
    ? value.replace(/\r\n?/gu, "\n")
    : ""
}

/*
 * Canonical envelope extraction is a protocol parser, not a substring trim.
 *
 * Authority boundary:
 *   line beginning with MUTATION_CONTENT_ENVELOPE protocol=
 *       ...
 *   line beginning with NEXT_ACTION=
 *
 * Prefix/suffix text belongs to the runtime carrier, not to the mutation
 * envelope. A marker without a terminator, an oversized envelope, or multiple
 * distinct envelopes fails closed.
 */
function extractCanonicalMutationEnvelopeCandidates(
  value,
  carrier,
) {
  const text = normalizeEnvelopeCarrierText(value)
  if (!text) return []

  const lines = text.split("\n")
  const out = []

  for (let start = 0; start < lines.length; start += 1) {
    if (
      !lines[start].startsWith(
        CANONICAL_MUTATION_ENVELOPE_START,
      )
    ) {
      continue
    }

    let end = -1
    let nestedStart = false

    for (
      let index = start + 1;
      index < lines.length;
      index += 1
    ) {
      if (
        lines[index].startsWith(
          CANONICAL_MUTATION_ENVELOPE_START,
        )
      ) {
        nestedStart = true
        break
      }

      if (
        lines[index].startsWith(
          CANONICAL_MUTATION_ENVELOPE_END,
        )
      ) {
        end = index
        break
      }
    }

    if (nestedStart || end < 0) {
      out.push({
        ok: false,
        reason:
          nestedStart
            ? "canonical_mutation_envelope_nested_start"
            : "canonical_mutation_envelope_unterminated",
        carrier,
        marker_line: start + 1,
        text: "",
        next_action: null,
        envelope_bytes: null,
      })
      continue
    }

    const candidate =
      lines
        .slice(start, end + 1)
        .join("\n")
        .trim()

    const candidateBytes = bytes(candidate)

    if (
      candidateBytes >
      MUTATION_PHASE_ENVELOPE_MAX_BYTES
    ) {
      out.push({
        ok: false,
        reason:
          "canonical_mutation_envelope_byte_budget",
        carrier,
        marker_line: start + 1,
        text: "",
        next_action: null,
        envelope_bytes: candidateBytes,
      })
      start = end
      continue
    }

    const actionMatch =
      /^NEXT_ACTION=([a-zA-Z0-9_.:-]+)(?:\s|$)/u
        .exec(lines[end].trim())

    if (!actionMatch) {
      out.push({
        ok: false,
        reason:
          "canonical_mutation_envelope_next_action_invalid",
        carrier,
        marker_line: start + 1,
        text: candidate,
        next_action: null,
        envelope_bytes: candidateBytes,
      })
      start = end
      continue
    }

    out.push({
      ok: true,
      reason:
        "canonical_mutation_envelope_candidate",
      carrier,
      marker_line: start + 1,
      text: candidate,
      next_action: actionMatch[1],
      envelope_bytes: candidateBytes,
    })

    start = end
  }

  return out
}

function findCanonicalMutationEnvelope({
  messages,
  system,
}) {
  const observed = [
    ...textCandidates(system).flatMap(
      (text) =>
        extractCanonicalMutationEnvelopeCandidates(
          text,
          "system",
        ),
    ),
    ...textCandidates(messages).flatMap(
      (text) =>
        extractCanonicalMutationEnvelopeCandidates(
          text,
          "messages",
        ),
    ),
  ]

  if (observed.length < 1) {
    return {
      ok: false,
      protocol:
        CANONICAL_MUTATION_ENVELOPE_EXTRACTION_PROTOCOL,
      reason:
        "canonical_mutation_envelope_unavailable",
      text: "",
      next_action: null,
      carrier: null,
      envelope_bytes: null,
      observed_candidate_count: 0,
      distinct_candidate_count: 0,
    }
  }

  const malformed =
    observed.filter((row) => row.ok !== true)

  if (malformed.length > 0) {
    return {
      ok: false,
      protocol:
        CANONICAL_MUTATION_ENVELOPE_EXTRACTION_PROTOCOL,
      reason:
        "canonical_mutation_envelope_malformed",
      malformed_reasons:
        [...new Set(
          malformed.map((row) => row.reason),
        )].sort(),
      text: "",
      next_action: null,
      carrier: null,
      envelope_bytes: null,
      observed_candidate_count:
        observed.length,
      distinct_candidate_count: null,
    }
  }

  const unique = new Map()

  for (const row of observed) {
    const identity = sha256(row.text)
    const prior = unique.get(identity)

    if (!prior) {
      unique.set(identity, {
        ...row,
        carriers: new Set([row.carrier]),
      })
      continue
    }

    if (prior.next_action !== row.next_action) {
      return {
        ok: false,
        protocol:
          CANONICAL_MUTATION_ENVELOPE_EXTRACTION_PROTOCOL,
        reason:
          "canonical_mutation_envelope_identity_drift",
        text: "",
        next_action: null,
        carrier: null,
        envelope_bytes: null,
        observed_candidate_count:
          observed.length,
        distinct_candidate_count:
          unique.size,
      }
    }

    prior.carriers.add(row.carrier)
  }

  if (unique.size !== 1) {
    return {
      ok: false,
      protocol:
        CANONICAL_MUTATION_ENVELOPE_EXTRACTION_PROTOCOL,
      reason:
        "canonical_mutation_envelope_ambiguous",
      text: "",
      next_action: null,
      carrier: null,
      envelope_bytes: null,
      observed_candidate_count:
        observed.length,
      distinct_candidate_count:
        unique.size,
    }
  }

  const only =
    [...unique.values()][0]

  return {
    ok: true,
    protocol:
      CANONICAL_MUTATION_ENVELOPE_EXTRACTION_PROTOCOL,
    reason:
      "canonical_mutation_envelope_observed",
    text: only.text,
    next_action: only.next_action,
    carrier:
      [...only.carriers].sort().join("+"),
    envelope_bytes:
      only.envelope_bytes,
    observed_candidate_count:
      observed.length,
    distinct_candidate_count: 1,
  }
}

function compileRuntimeSystemCarrier(system) {
  if (typeof system === "string") {
    return {
      ok: true,
      reason: "runtime_system_string_preserved",
      system: MUTATION_PHASE_SYSTEM,
      carrier_index: null,
      carrier_shape_sha256: sha256("string"),
    }
  }

  if (!Array.isArray(system)) {
    return {
      ok: false,
      reason: "runtime_system_carrier_unavailable",
      system,
      carrier_index: null,
      carrier_shape_sha256: null,
    }
  }

  for (let index = 0; index < system.length; index += 1) {
    const part = system[index]

    // Older hook variants may expose string[].
    if (typeof part === "string") {
      return {
        ok: true,
        reason: "runtime_system_string_part_preserved",
        system: [MUTATION_PHASE_SYSTEM],
        carrier_index: index,
        carrier_shape_sha256: sha256("string-part"),
      }
    }

    // Current OpenCode context hooks expose SystemPart objects such as
    // { text: "..." }. Preserve the runtime object's prototype, descriptors,
    // provider metadata and any future compatible fields; replace text only.
    if (
      part &&
      typeof part === "object" &&
      typeof part.text === "string"
    ) {
      const projectedPart = cloneWithDescriptors(
        part,
        { text: MUTATION_PHASE_SYSTEM },
      )
      if (!projectedPart) continue

      const shape = {
        part_keys: Reflect.ownKeys(part)
          .map((key) => String(key))
          .sort(),
        part_prototype:
          Object.getPrototypeOf(part)?.constructor?.name ?? null,
      }

      return {
        ok: true,
        reason: "runtime_system_part_carrier_preserved",
        system: [projectedPart],
        carrier_index: index,
        carrier_shape_sha256: sha256(JSON.stringify(shape)),
      }
    }
  }

  return {
    ok: false,
    reason: "runtime_system_text_carrier_unavailable",
    system,
    carrier_index: null,
    carrier_shape_sha256: null,
  }
}

function cloneWithDescriptors(value, overrides = {}) {
  if (!value || typeof value !== "object") return null

  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, nextValue] of Object.entries(overrides)) {
    const current = descriptors[key]
    descriptors[key] = current
      ? {
          ...current,
          get: undefined,
          set: undefined,
          value: nextValue,
          writable: true,
        }
      : {
          configurable: true,
          enumerable: true,
          writable: true,
          value: nextValue,
        }

    if ("get" in descriptors[key] && descriptors[key].get === undefined) {
      delete descriptors[key].get
    }
    if ("set" in descriptors[key] && descriptors[key].set === undefined) {
      delete descriptors[key].set
    }
  }

  return Object.create(
    Object.getPrototypeOf(value),
    descriptors,
  )
}

function compileRuntimeMessageCarrier(messages, text) {
  if (!Array.isArray(messages)) {
    return {
      ok: false,
      reason: "runtime_message_array_unavailable",
      messages,
      carrier_index: null,
      carrier_role: null,
      carrier_shape_sha256: null,
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      !message ||
      typeof message !== "object" ||
      message.role !== "user" ||
      !Array.isArray(message.content)
    ) {
      continue
    }

    const textIndex = message.content.findIndex(
      (part) =>
        part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    if (textIndex < 0) continue

    const originalPart = message.content[textIndex]
    const projectedPart = cloneWithDescriptors(
      originalPart,
      { text },
    )
    if (!projectedPart) continue

    const projectedContent = [projectedPart]
    const projectedMessage = cloneWithDescriptors(
      message,
      { content: projectedContent },
    )
    if (!projectedMessage) continue

    const shape = {
      message_keys: Reflect.ownKeys(message)
        .map((key) => String(key))
        .sort(),
      part_keys: Reflect.ownKeys(originalPart)
        .map((key) => String(key))
        .sort(),
      message_prototype:
        Object.getPrototypeOf(message)?.constructor?.name ?? null,
      part_prototype:
        Object.getPrototypeOf(originalPart)?.constructor?.name ?? null,
    }

    return {
      ok: true,
      reason: "runtime_user_text_carrier_preserved",
      messages: [projectedMessage],
      carrier_index: index,
      carrier_role: message.role,
      carrier_shape_sha256: sha256(JSON.stringify(shape)),
    }
  }

  return {
    ok: false,
    reason: "runtime_user_text_carrier_unavailable",
    messages,
    carrier_index: null,
    carrier_role: null,
    carrier_shape_sha256: null,
  }
}

function exactObjectKeys(value, required, optional = []) {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false
  }

  const allowed = new Set([
    ...required,
    ...optional,
  ])

  const keys = Object.keys(value)

  if (
    required.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(
          value,
          key,
        ),
    ) ||
    keys.some((key) => !allowed.has(key))
  ) {
    return false
  }

  return true
}

function structuredMutationControlFailure(
  reason,
  extra = {},
) {
  return Object.freeze({
    ok: false,
    absent: false,
    protocol:
      STRUCTURED_MUTATION_CONTROL_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function normalizeStructuredMutationControl({
  controlEnvelope,
  executionState,
  selectedAction,
} = {}) {
  if (controlEnvelope == null) {
    return Object.freeze({
      ok: false,
      absent: true,
      protocol:
        STRUCTURED_MUTATION_CONTROL_PROTOCOL,
      reason:
        "structured_mutation_control_absent",
      mutation_authority: false,
    })
  }

  const requiredKeys = [
    "protocol",
    "authority",
    "execution_state",
    "selected_action",
    "selected_source",
    "execution_context_capsule_sha256",
    "execution_contract_sha256",
    "semantic_contract_sha256",
    "semantic_attestation_sha256",
    "capability_fingerprint_sha256",
    "required_operations",
  ]

  if (
    !exactObjectKeys(
      controlEnvelope,
      requiredKeys,
    )
  ) {
    return structuredMutationControlFailure(
      "structured_mutation_control_shape_invalid",
    )
  }

  if (
    controlEnvelope.protocol !==
      STRUCTURED_MUTATION_CONTROL_PROTOCOL ||
    controlEnvelope.authority !==
      "deterministic_runtime_state"
  ) {
    return structuredMutationControlFailure(
      "structured_mutation_control_authority_invalid",
    )
  }

  if (
    controlEnvelope.execution_state !==
      executionState ||
    controlEnvelope.selected_action !==
      selectedAction
  ) {
    return structuredMutationControlFailure(
      "structured_mutation_control_state_drift",
    )
  }

  if (
    controlEnvelope.selected_source !==
      "compiled_execution_capsule" &&
    controlEnvelope.selected_source !==
      "persisted_execution_capsule_repair_projection"
  ) {
    return structuredMutationControlFailure(
      "structured_mutation_control_source_invalid",
    )
  }

  for (const value of [
    controlEnvelope
      .execution_context_capsule_sha256,
    controlEnvelope
      .execution_contract_sha256,
    controlEnvelope
      .semantic_contract_sha256,
    controlEnvelope
      .semantic_attestation_sha256,
    controlEnvelope
      .capability_fingerprint_sha256,
  ]) {
    if (
      typeof value !== "string" ||
      !STRUCTURED_MUTATION_CONTROL_SHA256_RE
        .test(value)
    ) {
      return structuredMutationControlFailure(
        "structured_mutation_control_identity_invalid",
      )
    }
  }

  const operations =
    Array.isArray(
      controlEnvelope.required_operations,
    )
      ? controlEnvelope.required_operations
      : []

  if (
    operations.length < 1 ||
    operations.length > 8
  ) {
    return structuredMutationControlFailure(
      "structured_mutation_control_operations_invalid",
    )
  }

  const seen = new Set()

  for (const row of operations) {
    if (
      !exactObjectKeys(
        row,
        ["id", "obligation"],
        ["kind"],
      ) ||
      typeof row.id !== "string" ||
      !/^op_[0-9]+$/u.test(row.id) ||
      typeof row.obligation !== "string" ||
      row.obligation.length < 1 ||
      row.obligation.length > 128 ||
      !STRUCTURED_MUTATION_CONTROL_TOKEN_RE
        .test(row.obligation) ||
      (
        row.kind != null &&
        (
          typeof row.kind !== "string" ||
          row.kind.length < 1 ||
          row.kind.length > 64 ||
          !STRUCTURED_MUTATION_CONTROL_TOKEN_RE
            .test(row.kind)
        )
      ) ||
      seen.has(row.id)
    ) {
      return structuredMutationControlFailure(
        "structured_mutation_control_operation_invalid",
      )
    }

    seen.add(row.id)
  }

  const lines = [
    `MUTATION_CONTENT_ENVELOPE protocol=${STRUCTURED_MUTATION_CONTROL_PROTOCOL} ` +
      "minimal_complete=true authority=deterministic_runtime_state",
    `SYNTHESIS_TRANSACTION protocol=semantic-obligation-bridge-v1 ` +
      `sha256=${controlEnvelope.semantic_contract_sha256} ` +
      "content_only=true all_required=true",
  ]

  for (const row of operations) {
    const kind =
      typeof row.kind === "string"
        ? ` kind=${row.kind}`
        : ""

    lines.push(
      `REQUIRED_OPERATION id=${row.id} ` +
        `obligation=${row.obligation}${kind} ` +
        "payload=content",
    )
  }

  lines.push(
    "MUTATION_CONSTRAINTS " +
      "control_source=deterministic_runtime_state " +
      `execution_state=${executionState} ` +
      `execution_context_source=${controlEnvelope.selected_source} ` +
      `execution_context_capsule_sha256=${controlEnvelope.execution_context_capsule_sha256} ` +
      `execution_contract_sha256=${controlEnvelope.execution_contract_sha256} ` +
      `semantic_attestation_sha256=${controlEnvelope.semantic_attestation_sha256} ` +
      `capability_fingerprint_sha256=${controlEnvelope.capability_fingerprint_sha256}`,
  )

  lines.push(
    "MODEL_AUTHORITY content_only=true slot=false operation=false " +
      "file=false scope=false preimage=false create_path=false " +
      "imports=false dependencies=false",
  )

  lines.push(
    `NEXT_ACTION=${selectedAction} ` +
      "reason=structured_runtime_control search_locked=true",
  )

  const text = lines.join("\n")

  if (
    bytes(text) >
    MUTATION_PHASE_ENVELOPE_MAX_BYTES
  ) {
    return structuredMutationControlFailure(
      "structured_mutation_control_render_over_budget",
    )
  }

  return Object.freeze({
    ok: true,
    absent: false,
    protocol:
      STRUCTURED_MUTATION_CONTROL_PROTOCOL,
    reason:
      "structured_mutation_control_valid",
    source:
      "deterministic_runtime_state",
    text,
    next_action: selectedAction,
    required_operation_count:
      operations.length,
    control_sha256: sha256(text),
    mutation_authority: false,
  })
}

export function compileMutationPhaseContext({
  executionState,
  frontierToolNames,
  taskText,
  messages,
  system,
  controlEnvelope,
}) {
  const sourceSystemBytes = bytes(system)
  const sourceMessagesBytes = bytes(messages)

  if (executionState !== "mutate" && executionState !== "repair") {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: "not_mutation_phase",
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: null,
      selected_tool: null,
      mutation_authority: false,
    }
  }

  const frontier = Array.isArray(frontierToolNames)
    ? frontierToolNames.filter(
        (name) => typeof name === "string" && name.length > 0,
      )
    : []

  if (frontier.length !== 1) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: "mutation_frontier_not_singleton",
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: null,
      selected_tool: null,
      mutation_authority: false,
    }
  }

  const structuredControl =
    normalizeStructuredMutationControl({
      controlEnvelope,
      executionState,
      selectedAction: frontier[0],
    })
  const envelope =
    structuredControl.ok === true
      ? structuredControl
      : structuredControl.absent === true
        ? findCanonicalMutationEnvelope({
            messages,
            system,
          })
        : structuredControl
  if (envelope.ok !== true) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: envelope.reason,
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: null,
      selected_tool: frontier[0],
      mutation_authority: false,
    }
  }

  if (envelope.next_action !== frontier[0]) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: "mutation_envelope_frontier_mismatch",
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: sha256(envelope.text),
      selected_tool: frontier[0],
      mutation_authority: false,
    }
  }

  const task = compactTaskText(taskText)
  if (!task) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: "mutation_task_text_unavailable",
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: sha256(envelope.text),
      selected_tool: frontier[0],
      mutation_authority: false,
    }
  }

  const phaseText = [
    `MUTATION_PHASE protocol=${MUTATION_PHASE_COMPILER_PROTOCOL} ` +
      `state=${executionState} tool=${frontier[0]} exactly_once=true`,
    "TASK",
    task,
    envelope.text,
    `CALL_POLICY tool=${frontier[0]} exactly_once=true prose=false ` +
      "minimum_complete=true authority_expansion=false",
  ].join("\n\n")

  const systemCarrier =
    structuredControl.ok === true
      ? {
          ok: true,
          reason:
            "structured_control_system_preserved",
          system,
          carrier_index: null,
          carrier_shape_sha256:
            sha256(
              JSON.stringify({
                kind:
                  Array.isArray(system)
                    ? "array"
                    : typeof system,
                bytes: sourceSystemBytes,
              }),
            ),
        }
      : compileRuntimeSystemCarrier(system)

  if (systemCarrier.ok !== true) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: systemCarrier.reason,
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: sha256(envelope.text),
      selected_tool: frontier[0],
      system_projection_mode: "fail_open",
      system_carrier_index: null,
      system_carrier_shape_sha256: null,
      message_projection_mode: "not_attempted",
      message_carrier_index: null,
      message_carrier_role: null,
      message_carrier_shape_sha256: null,
      mutation_authority: false,
    }
  }

  const projectedSystem = systemCarrier.system
  const messageCarrier =
    compileRuntimeMessageCarrier(messages, phaseText)

  if (messageCarrier.ok !== true) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: messageCarrier.reason,
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: sha256(envelope.text),
      selected_tool: frontier[0],
      system_projection_mode: "runtime_carrier",
      system_projection_reason: systemCarrier.reason,
      system_carrier_index: systemCarrier.carrier_index,
      system_carrier_shape_sha256:
        systemCarrier.carrier_shape_sha256,
      message_projection_mode: "fail_open",
      message_carrier_index: null,
      message_carrier_role: null,
      message_carrier_shape_sha256: null,
      mutation_authority: false,
    }
  }

  const projectedMessages = messageCarrier.messages
  const projectedSystemBytes = bytes(projectedSystem)
  const projectedMessagesBytes = bytes(projectedMessages)
  const sourceTotal = sourceSystemBytes + sourceMessagesBytes
  const projectedTotal = projectedSystemBytes + projectedMessagesBytes

  if (
    structuredControl.ok !== true &&
    projectedTotal >= sourceTotal
  ) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason: "mutation_phase_projection_no_size_gain",
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      envelope_sha256: sha256(envelope.text),
      selected_tool: frontier[0],
      mutation_authority: false,
    }
  }

  if (
    structuredControl.ok === true &&
    projectedTotal >
      sourceTotal +
        STRUCTURED_MUTATION_CONTROL_MAX_EXPANSION_BYTES
  ) {
    return {
      applied: false,
      protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
      reason:
        "structured_control_projection_expansion_exceeded",
      system,
      messages,
      source_system_bytes: sourceSystemBytes,
      source_messages_bytes: sourceMessagesBytes,
      projected_system_bytes: sourceSystemBytes,
      projected_messages_bytes: sourceMessagesBytes,
      reduction_bytes: 0,
      expansion_bytes: 0,
      envelope_sha256: sha256(envelope.text),
      selected_tool: frontier[0],
      structured_control_applied: false,
      structured_control_protocol:
        STRUCTURED_MUTATION_CONTROL_PROTOCOL,
      structured_control_reason:
        "structured_control_projection_expansion_exceeded",
      structured_control_source:
        structuredControl.source ?? null,
      structured_control_required_operations:
        structuredControl.required_operation_count ?? null,
      repair_history_elided: false,
      mutation_authority: false,
    }
  }

  return {
    applied: true,
    protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
    reason:
      structuredControl.ok === true
        ? "mutation_phase_compiled_structured_control"
        : "mutation_phase_compiled",
    structured_control_applied:
      structuredControl.ok === true,
    structured_control_protocol:
      structuredControl.ok === true
        ? STRUCTURED_MUTATION_CONTROL_PROTOCOL
        : null,
    structured_control_reason:
      structuredControl.reason ?? null,
    structured_control_source:
      structuredControl.ok === true
        ? structuredControl.source
        : null,
    structured_control_required_operations:
      structuredControl.ok === true
        ? structuredControl.required_operation_count
        : null,
    repair_history_elided:
      structuredControl.ok === true &&
      executionState === "repair" &&
      Array.isArray(messages) &&
      messages.some(
        (row) =>
          row?.role === "assistant" ||
          row?.role === "tool",
      ) &&
      !projectedMessages.some(
        (row) =>
          row?.role === "assistant" ||
          row?.role === "tool",
      ),
    system: projectedSystem,
    messages: projectedMessages,
    source_system_bytes: sourceSystemBytes,
    source_messages_bytes: sourceMessagesBytes,
    projected_system_bytes: projectedSystemBytes,
    projected_messages_bytes: projectedMessagesBytes,
    reduction_bytes:
      Math.max(0, sourceTotal - projectedTotal),
    expansion_bytes:
      Math.max(0, projectedTotal - sourceTotal),
    envelope_sha256: sha256(envelope.text),
    phase_sha256: sha256(phaseText),
    selected_tool: frontier[0],
    system_projection_mode: "runtime_carrier",
    system_projection_reason: systemCarrier.reason,
    system_carrier_index: systemCarrier.carrier_index,
    system_carrier_shape_sha256:
      systemCarrier.carrier_shape_sha256,
    message_projection_mode: "runtime_carrier",
    message_projection_reason: messageCarrier.reason,
    message_carrier_index: messageCarrier.carrier_index,
    message_carrier_role: messageCarrier.carrier_role,
    message_carrier_shape_sha256:
      messageCarrier.carrier_shape_sha256,
    mutation_authority: false,
  }
}

export function projectMutationToolSchemas({
  tools,
  frontierToolNames,
  active,
}) {
  const sourceBytes = bytes(tools)

  // Runtime tool definitions are executable provider/framework objects.
  // Their identity and validation semantics are not model-facing payload and
  // must not be reconstructed at this boundary.
  //
  // Schema compaction is therefore observation-only here. A future Wire
  // Adapter may compact only the concrete serialized provider representation.
  return {
    applied: false,
    protocol: MUTATION_PHASE_COMPILER_PROTOCOL,
    reason:
      active === true
        ? "tool_schema_runtime_mutation_disabled"
        : "tool_schema_projection_inactive",
    source_bytes: sourceBytes,
    projected_bytes: sourceBytes,
    reduction_bytes: 0,
    projected_tools: 0,
    frontier_tools:
      Array.isArray(frontierToolNames)
        ? frontierToolNames.filter((name) => typeof name === "string")
        : [],
    runtime_schema_immutable: true,
    mutation_authority: false,
  }
}
