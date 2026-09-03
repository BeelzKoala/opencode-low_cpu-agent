import { createHash } from "node:crypto"

export const CONTROL_CONTEXT_LAYER_PROTOCOL =
  "control-context-layer-v1"

const PHASE_PREFIX =
  "MUTATION_PHASE protocol="
const ENVELOPE_PREFIX =
  "MUTATION_CONTENT_ENVELOPE protocol="
const NEXT_ACTION_PREFIX =
  "NEXT_ACTION="
const CALL_POLICY_PREFIX =
  "CALL_POLICY "

const CONTROL_PREFIXES = Object.freeze([
  "ADDITIVE_CAPABILITY ",
  "MUTATION_ABI ",
  "REQUIRED_MUTATION_COVERAGE ",
  "MODEL_TOOL_ABI ",
  "SYNTHESIS_TRANSACTION ",
  "REQUIRED_OPERATION ",
  "SUPPORT_IMPORTS ",
  "MUTATION_CONSTRAINTS ",
  "MODEL_AUTHORITY ",
  "NEXT_ACTION=",
  "slot=",
  "budgets ",
])

function bytes(value) {
  return Buffer.byteLength(
    typeof value === "string"
      ? value
      : JSON.stringify(value),
    "utf8",
  )
}

function sha256(value) {
  return createHash("sha256")
    .update(
      typeof value === "string"
        ? value
        : JSON.stringify(value),
    )
    .digest("hex")
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function fail(base, reason, extra = {}) {
  return Object.freeze({
    ...base,
    ...extra,
    control_context_protocol:
      CONTROL_CONTEXT_LAYER_PROTOCOL,
    control_context_applied: false,
    control_context_reason: reason,
    control_context_mutation_authority: false,
    control_context_model_action_authority: false,
  })
}

function isCapabilityControlLine(line) {
  return /^[A-Z0-9_]+_CAPABILITY(?:\s|$)/u
    .test(line)
}

function isControlLine(line) {
  return (
    CONTROL_PREFIXES.some(
      (prefix) => line.startsWith(prefix),
    ) ||
    isCapabilityControlLine(line)
  )
}

function compactRequired(line) {
  return line.replace(
    /^REQUIRED_OPERATION\s+/u,
    "REQUIRED=",
  )
}

function parsePhaseText(text) {
  if (typeof text !== "string" || !text) {
    return null
  }

  const lines =
    text.replace(/\r\n?/gu, "\n").split("\n")

  const phaseIndex =
    lines.findIndex(
      (line) =>
        line.startsWith(PHASE_PREFIX),
    )

  if (phaseIndex < 0) {
    return null
  }

  const taskMarker =
    lines.findIndex(
      (line, index) =>
        index > phaseIndex &&
        line === "TASK",
    )

  const envelopeStart =
    lines.findIndex(
      (line, index) =>
        index > phaseIndex &&
        line.startsWith(
          ENVELOPE_PREFIX,
        ),
    )

  if (
    taskMarker < 0 ||
    envelopeStart < 0 ||
    envelopeStart <= taskMarker
  ) {
    return {
      ok: false,
      reason:
        "control_context_phase_shape_invalid",
    }
  }

  const envelopeEnd =
    lines.findIndex(
      (line, index) =>
        index >= envelopeStart &&
        line.startsWith(
          NEXT_ACTION_PREFIX,
        ),
    )

  if (envelopeEnd < 0) {
    return {
      ok: false,
      reason:
        "control_context_envelope_unterminated",
    }
  }

  const callPolicyIndex =
    lines.findIndex(
      (line, index) =>
        index > envelopeEnd &&
        line.startsWith(
          CALL_POLICY_PREFIX,
        ),
    )

  if (callPolicyIndex < 0) {
    return {
      ok: false,
      reason:
        "control_context_call_policy_missing",
    }
  }

  const taskLines =
    lines
      .slice(
        taskMarker + 1,
        envelopeStart,
      )
      .filter(
        (line) => line.trim() !== "",
      )

  if (taskLines.length < 1) {
    return {
      ok: false,
      reason:
        "control_context_task_missing",
    }
  }

  const envelopeLines =
    lines.slice(
      envelopeStart,
      envelopeEnd + 1,
    )

  const nextActionLine =
    envelopeLines.at(-1)

  const actionMatch =
    /^NEXT_ACTION=([A-Za-z0-9_.:-]+)(?:\s|$)/u
      .exec(nextActionLine)

  if (!actionMatch) {
    return {
      ok: false,
      reason:
        "control_context_next_action_invalid",
    }
  }

  const requiredOperations =
    envelopeLines.filter(
      (line) =>
        line.startsWith(
          "REQUIRED_OPERATION ",
        ),
    )

  const modelAuthority =
    envelopeLines.find(
      (line) =>
        line.startsWith(
          "MODEL_AUTHORITY ",
        ),
    ) ?? null

  const constraints =
    envelopeLines.filter(
      (line) =>
        line.startsWith(
          "MUTATION_CONSTRAINTS ",
        ),
    )

  const evidenceLines =
    envelopeLines.filter(
      (line, index) => {
        if (
          index === 0 ||
          line.trim() === "" ||
          isControlLine(line)
        ) {
          return false
        }

        return true
      },
    )

  const evidenceBlock = [
    "EVIDENCE_CONTEXT protocol=control-context-layer-v1 trust=untrusted_repository_data authority=false",
    ...evidenceLines,
  ].join("\n")

  const controlLines = [
    "CONTROL_CONTEXT protocol=control-context-layer-v1 authority=deterministic",
    `ACTION=${actionMatch[1]}`,
    ...requiredOperations.map(
      compactRequired,
    ),
    ...constraints.map(
      (line) =>
        line.replace(
          /^MUTATION_CONSTRAINTS\s+/u,
          "CONSTRAINTS=",
        ),
    ),
    (
      modelAuthority
        ? modelAuthority.replace(
            /^MODEL_AUTHORITY\s+/u,
            "MODEL_OWNS=",
          )
        : "MODEL_OWNS=content_only=true"
    ),
    "CONTROL_METADATA_IS_NOT_PAYLOAD=true",
  ]

  if (
    actionMatch[1] ===
    "execute_additive_plan"
  ) {
    controlLines.push(
      "PYTHON_FUNCTION_SUITE=body_statements_only",
      "PYTHON_FUNCTION_PARAMETERS=python_signature_source_only",
      "PYTHON_FUNCTION_RETURNS=python_annotation_source_only",
      "PYTHON_DECLARATION_WRAPPER_IN_SUITE=forbidden",
      "CAPABILITY_LABELS_AS_PAYLOAD=forbidden",
    )
  }

  const taskBlock = [
    "TASK",
    ...taskLines,
  ].join("\n")

  const userText = [
    taskBlock,
    evidenceBlock,
  ].join("\n\n")

  const controlBlock =
    controlLines.join("\n")

  const sourceControlBytes =
    bytes(
      [
        lines[phaseIndex],
        ...envelopeLines.filter(
          (line) =>
            isControlLine(line) ||
            line.startsWith(
              ENVELOPE_PREFIX,
            ),
        ),
        lines[callPolicyIndex],
      ].join("\n"),
    )

  return {
    ok: true,
    action: actionMatch[1],
    controlBlock,
    evidenceBlock,
    userText,
    requiredOperationCount:
      requiredOperations.length,
    sourceControlBytes,
  }
}

function transformCarrier(value) {
  if (typeof value === "string") {
    const parsed = parsePhaseText(value)

    if (parsed == null) {
      return {
        ok: true,
        changed: false,
        value,
        parsed: null,
      }
    }

    if (parsed.ok !== true) {
      return parsed
    }

    return {
      ok: true,
      changed: true,
      value: parsed.userText,
      parsed,
    }
  }

  if (Array.isArray(value)) {
    let parsed = null
    let changed = false
    const out = []

    for (const item of value) {
      const row =
        transformCarrier(item)

      if (row.ok !== true) {
        return row
      }

      if (row.parsed && parsed) {
        return {
          ok: false,
          reason:
            "control_context_multiple_phase_carriers",
        }
      }

      parsed = parsed ?? row.parsed
      changed =
        changed || row.changed
      out.push(row.value)
    }

    return {
      ok: true,
      changed,
      value: out,
      parsed,
    }
  }

  if (
    value &&
    typeof value === "object"
  ) {
    let parsed = null
    let changed = false
    const out = {}

    for (
      const [key, item]
      of Object.entries(value)
    ) {
      if (
        key !== "text" &&
        key !== "content" &&
        key !== "parts"
      ) {
        out[key] = item
        continue
      }

      const row =
        transformCarrier(item)

      if (row.ok !== true) {
        return row
      }

      if (row.parsed && parsed) {
        return {
          ok: false,
          reason:
            "control_context_multiple_phase_carriers",
        }
      }

      parsed = parsed ?? row.parsed
      changed =
        changed || row.changed
      out[key] = row.value
    }

    return {
      ok: true,
      changed,
      value: out,
      parsed,
    }
  }

  return {
    ok: true,
    changed: false,
    value,
    parsed: null,
  }
}

function appendControlToSystem(
  system,
  controlBlock,
) {
  if (
    typeof controlBlock !== "string" ||
    !controlBlock
  ) {
    return null
  }

  if (typeof system === "string") {
    return (
      system.trimEnd()
      + "\n\n"
      + controlBlock
    )
  }

  if (Array.isArray(system)) {
    const out = clone(system)

    for (
      let i = 0;
      i < out.length;
      i += 1
    ) {
      if (
        typeof out[i] === "string"
      ) {
        out[i] =
          out[i].trimEnd()
          + "\n\n"
          + controlBlock
        return out
      }

      if (
        out[i] &&
        typeof out[i] === "object" &&
        typeof out[i].text === "string"
      ) {
        out[i].text =
          out[i].text.trimEnd()
          + "\n\n"
          + controlBlock
        return out
      }
    }

    return null
  }

  if (
    system &&
    typeof system === "object"
  ) {
    const out = clone(system)

    if (typeof out.text === "string") {
      out.text =
        out.text.trimEnd()
        + "\n\n"
        + controlBlock
      return out
    }

    if (Array.isArray(out.content)) {
      for (
        let i = 0;
        i < out.content.length;
        i += 1
      ) {
        const part = out.content[i]
        if (
          part &&
          typeof part === "object" &&
          typeof part.text === "string"
        ) {
          part.text =
            part.text.trimEnd()
            + "\n\n"
            + controlBlock
          return out
        }
      }
    }
  }

  return null
}

export function compileControlContextLayer(
  base,
) {
  if (
    !base ||
    typeof base !== "object" ||
    base.applied !== true
  ) {
    return fail(
      base ?? {},
      "control_context_phase_inactive",
    )
  }

  const messageProjection =
    transformCarrier(base.messages)

  if (messageProjection.ok !== true) {
    return fail(
      base,
      messageProjection.reason,
    )
  }

  if (!messageProjection.parsed) {
    return fail(
      base,
      "control_context_phase_carrier_unavailable",
    )
  }

  const parsed =
    messageProjection.parsed

  if (
    typeof base.selected_tool === "string" &&
    base.selected_tool &&
    parsed.action !== base.selected_tool
  ) {
    return fail(
      base,
      "control_context_action_drift",
      {
        control_context_action:
          parsed.action,
      },
    )
  }

  const projectedSystem =
    appendControlToSystem(
      base.system,
      parsed.controlBlock,
    )

  if (projectedSystem == null) {
    return fail(
      base,
      "control_context_system_carrier_unsupported",
    )
  }

  const beforeBytes =
    bytes(base.system) +
    bytes(base.messages)

  const afterBytes =
    bytes(projectedSystem) +
    bytes(messageProjection.value)

  if (
    afterBytes >
    beforeBytes + 256
  ) {
    return fail(
      base,
      "control_context_not_profitable",
      {
        control_context_source_bytes:
          beforeBytes,
        control_context_projected_bytes:
          afterBytes,
      },
    )
  }

  return Object.freeze({
    ...base,
    system: projectedSystem,
    messages: messageProjection.value,
    control_context_protocol:
      CONTROL_CONTEXT_LAYER_PROTOCOL,
    control_context_applied: true,
    control_context_reason:
      "phase_control_evidence_separated",
    control_context_action:
      parsed.action,
    control_context_required_operations:
      parsed.requiredOperationCount,
    control_context_source_bytes:
      beforeBytes,
    control_context_projected_bytes:
      afterBytes,
    control_context_saved_bytes:
      Math.max(
        0,
        beforeBytes - afterBytes,
      ),
    control_context_source_control_bytes:
      parsed.sourceControlBytes,
    control_context_sha256:
      sha256(parsed.controlBlock),
    evidence_context_sha256:
      sha256(parsed.evidenceBlock),
    control_context_mutation_authority:
      false,
    control_context_model_action_authority:
      false,
  })
}
