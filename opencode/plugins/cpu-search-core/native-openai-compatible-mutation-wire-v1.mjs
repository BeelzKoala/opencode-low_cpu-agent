import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"

import {
  compileProviderSafeModelSchema,
} from "./deterministic-argument-synthesis-v1.mjs"

export const NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL =
  "native-openai-compatible-mutation-wire-v1"

const DIAGNOSTIC_ENV =
  "OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC"
const DIAGNOSTIC_PATH_ENV =
  "OPENCODE_CPU_PROVIDER_SCHEMA_DIAGNOSTIC_PATH"

function fail(reason, details = {}) {
  const error = new Error(
    `CPU_NATIVE_MUTATION_WIRE ${reason}`,
  )
  error.name = "NativeMutationWireError"
  error.code = reason
  Object.assign(error, details)
  return error
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
}

function jsonBytes(value) {
  return Buffer.byteLength(
    JSON.stringify(value),
    "utf8",
  )
}

function mutationToolName(tool, allowed) {
  if (
    tool?.type !== "function" ||
    typeof tool?.function?.name !== "string"
  ) {
    return null
  }

  const name = tool.function.name
  return allowed.has(name) ? name : null
}

function emitDiagnostic(record) {
  if (
    process?.env?.[DIAGNOSTIC_ENV] !== "1"
  ) {
    return
  }

  const path =
    process?.env?.[
      DIAGNOSTIC_PATH_ENV
    ]?.trim?.() ?? ""

  if (path.length > 0) {
    appendFileSync(
      path,
      JSON.stringify(record) + "\n",
      {
        encoding: "utf8",
        flag: "a",
      },
    )
    return
  }

  console.error(
    "KOALIK_NATIVE_MUTATION_WIRE_V1 " +
    JSON.stringify(record),
  )
}

function requestPathname(request) {
  try {
    return new URL(request.url).pathname
  } catch {
    return null
  }
}

export async function rewriteNativeOpenAICompatibleMutationRequest(
  event,
  {
    mutationToolNames = [],
  } = {},
) {
  const request = event?.request

  if (
    !request ||
    typeof request !== "object" ||
    typeof request.clone !== "function"
  ) {
    return Object.freeze({
      protocol:
        NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
      applied: false,
      reason: "request_unavailable",
      mutation_authority: false,
    })
  }

  if (
    String(request.method ?? "").toUpperCase() !==
    "POST"
  ) {
    return Object.freeze({
      protocol:
        NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
      applied: false,
      reason: "non_post_request",
      mutation_authority: false,
    })
  }

  const pathname = requestPathname(request)
  if (
    typeof pathname !== "string" ||
    !pathname.endsWith("/chat/completions")
  ) {
    return Object.freeze({
      protocol:
        NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
      applied: false,
      reason: "non_openai_chat_request",
      mutation_authority: false,
    })
  }

  let body
  try {
    body = await request.clone().json()
  } catch {
    return Object.freeze({
      protocol:
        NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
      applied: false,
      reason: "non_json_request_body",
      mutation_authority: false,
    })
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray(body.tools)
  ) {
    return Object.freeze({
      protocol:
        NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
      applied: false,
      reason: "tool_array_absent",
      mutation_authority: false,
    })
  }

  const allowed =
    new Set(
      Array.from(mutationToolNames).filter(
        (name) =>
          typeof name === "string" &&
          name.length > 0,
      ),
    )

  const mutationIndexes = []

  for (
    let index = 0;
    index < body.tools.length;
    index += 1
  ) {
    const name =
      mutationToolName(
        body.tools[index],
        allowed,
      )
    if (name != null) {
      mutationIndexes.push({
        index,
        name,
      })
    }
  }

  if (mutationIndexes.length === 0) {
    return Object.freeze({
      protocol:
        NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
      applied: false,
      reason: "no_mutation_tool",
      mutation_authority: false,
    })
  }

  if (
    mutationIndexes.length !== 1 ||
    body.tools.length !== 1
  ) {
    throw fail(
      "mutation_frontier_not_singleton",
      {
        mutation_tool_count:
          mutationIndexes.length,
        wire_tool_count:
          body.tools.length,
      },
    )
  }

  const selected = mutationIndexes[0]
  const sourceTool = body.tools[selected.index]
  const sourceSchema =
    sourceTool?.function?.parameters

  if (
    !sourceSchema ||
    typeof sourceSchema !== "object" ||
    Array.isArray(sourceSchema)
  ) {
    throw fail(
      "mutation_tool_schema_invalid",
      {
        selected_tool: selected.name,
      },
    )
  }

  const projection =
    compileProviderSafeModelSchema(
      sourceSchema,
    )

  if (projection?.ok !== true) {
    throw fail(
      "provider_schema_projection_failed",
      {
        selected_tool: selected.name,
        projection_reason:
          projection?.reason ?? null,
        projection_path:
          projection?.path ?? null,
      },
    )
  }

  const projectedSchema =
    projection.schema

  const projectedTool = {
    ...sourceTool,
    function: {
      ...sourceTool.function,
      parameters: projectedSchema,
    },
  }

  const nextBody = {
    ...body,
    tools: [projectedTool],

    // The causal frontier already selected the action. Native
    // transport must not downgrade it back to model-owned "auto".
    tool_choice: {
      type: "function",
      function: {
        name: selected.name,
      },
    },
  }

  const headers =
    new Headers(request.headers)

  headers.delete("content-length")

  event.request =
    new Request(
      request,
      {
        headers,
        body:
          JSON.stringify(nextBody),
      },
    )

  const record = Object.freeze({
    protocol:
      NATIVE_OPENAI_COMPATIBLE_MUTATION_WIRE_PROTOCOL,
    authority:
      "deterministic_wire_projection",
    selected_tool:
      selected.name,
    endpoint:
      pathname,
    tool_count_before:
      body.tools.length,
    tool_count_after: 1,
    tool_choice_before:
      body.tool_choice ?? null,
    tool_choice_after:
      nextBody.tool_choice,
    source_schema_sha256:
      sha256(sourceSchema),
    projected_schema_sha256:
      sha256(projectedSchema),
    source_schema_bytes:
      jsonBytes(sourceSchema),
    projected_schema_bytes:
      jsonBytes(projectedSchema),
    provider_projection_protocol:
      projection.protocol ?? null,
    flattened_unions:
      projection.flattened_unions ?? 0,
    dropped_patterns:
      projection.dropped_patterns ?? 0,
    dropped_annotations:
      projection.dropped_annotations ?? 0,
    dropped_oversized_repetition_bounds:
      projection
        .dropped_oversized_repetition_bounds ??
      0,
    generation_constraints_relaxed:
      projection
        .generation_constraints_relaxed ===
      true,
    canonical_validation_required:
      projection
        .canonical_validation_required ===
      true,
    semantic_authority: false,
    mutation_authority: false,
  })

  emitDiagnostic(record)

  return Object.freeze({
    ...record,
    applied: true,
    reason:
      "native_mutation_wire_projected",
  })
}
