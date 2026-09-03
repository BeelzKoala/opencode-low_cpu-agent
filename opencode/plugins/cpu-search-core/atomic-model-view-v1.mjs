import { spawnSync } from "node:child_process"

import {
  MODEL_VIEW_COMPILER_PROTOCOL,
  validateSourceSlotModelViewPartialRequest,
} from "./model-view-compiler-v1.mjs"

export const ATOMIC_MODEL_VIEW_PROTOCOL =
  "atomic-model-view-v1"

export const RESIDUAL_MODEL_VIEW_PROTOCOL =
  "compiler-owned-residual-model-view-v1"

const ONE_CALL_EXECUTOR_ENV =
  "OPENCODE_CPU_ONE_CALL_EXECUTOR"

function enabledFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  )
}

export function residualModelViewRuntimeEnabled(
  env = process?.env ?? {},
) {
  return enabledFlag(
    env?.[ONE_CALL_EXECUTOR_ENV],
  )
}

const SURFACE_MODE_ENV =
  "OPENCODE_CPU_MODEL_SURFACE_MODE"

const PYTHON_SURFACE_CODEC_ENV =
  "OPENCODE_CPU_PYTHON_SURFACE_CODEC"

export const NATIVE_PYTHON_BODY_SURFACE_PROTOCOL =
  "native-python-declaration-body-v1"

const NATIVE_PYTHON_BODY_CODEC =
  "native_body_v1"

const PYTHON_BODY_CANONICALIZER = String.raw`
import ast
import json
import sys
import textwrap

def trim_blank_edges(text):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)

def leading_spaces(line):
    prefix = line[: len(line) - len(line.lstrip())]
    if "\t" in prefix:
        return None
    if any(ch != " " for ch in prefix):
        return None
    return len(prefix)

def tail_base_dedent(text):
    lines = text.splitlines()
    significant = [i for i, line in enumerate(lines) if line.strip()]
    if len(significant) < 2:
        return None
    first = significant[0]
    first_indent = leading_spaces(lines[first])
    if first_indent is None:
        return None
    tail_indents = []
    for i in significant[1:]:
        indent = leading_spaces(lines[i])
        if indent is None:
            return None
        tail_indents.append(indent)
    if not tail_indents:
        return None
    tail_base = min(tail_indents)
    delta = tail_base - first_indent
    if delta <= 0:
        return None
    normalized = list(lines)
    for i in significant[1:]:
        indent = leading_spaces(normalized[i])
        if indent is None or indent < delta:
            return None
        normalized[i] = normalized[i][delta:]
    candidate = "\n".join(normalized)
    return candidate if candidate != text else None

def candidates(body):
    raw = trim_blank_edges(body)
    out = [("raw", raw)]
    dedented = textwrap.dedent(raw)
    if dedented != raw:
        out.append(("common_dedent", dedented))
    tail = tail_base_dedent(raw)
    if tail is not None and all(candidate != tail for _, candidate in out):
        out.append(("tail_base_dedent", tail))
    return out

def parse_body(body, declaration_kind):
    prefix = "async def generated():\n" if declaration_kind == "async_function" else "def generated():\n"
    try:
        tree = ast.parse(prefix + textwrap.indent(body, "    "))
    except SyntaxError as exc:
        return None, exc
    if not tree.body or not isinstance(tree.body[0], (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None, None
    return tree.body[0], None

def fingerprint(fn):
    module = ast.Module(body=fn.body, type_ignores=[])
    return ast.dump(module, annotate_fields=True, include_attributes=False)

def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        print(json.dumps({"ok": False, "reason": "python_body_codec_input_invalid"}))
        return 0

    body = payload.get("body")
    declaration_kind = payload.get("declaration_kind")
    if not isinstance(body, str) or not body.strip():
        print(json.dumps({"ok": False, "reason": "python_body_empty"}))
        return 0
    if declaration_kind not in ("function", "async_function"):
        print(json.dumps({"ok": False, "reason": "python_body_declaration_kind_invalid"}))
        return 0

    rows = candidates(body)
    valid = []
    raw_error = None
    for kind, candidate in rows:
        fn, error = parse_body(candidate, declaration_kind)
        if kind == "raw":
            raw_error = error
        if error is not None or fn is None:
            continue

        forbidden = None
        for node in ast.walk(fn):
            if node is fn:
                continue
            if isinstance(
                node,
                (
                    ast.Import,
                    ast.ImportFrom,
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                    ast.ClassDef,
                ),
            ):
                forbidden = type(node).__name__
                break

        if forbidden is not None:
            print(json.dumps({
                "ok": False,
                "reason": "python_body_structural_escape",
                "detail": {
                    "forbidden_node": forbidden,
                    "normalization_kind": kind,
                },
            }))
            return 0

        valid.append((kind, candidate, fingerprint(fn), sum(1 for _ in ast.walk(fn))))

    if not valid:
        detail = {
            "normalization_candidate_count": len(rows),
            "parseable_candidate_count": 0,
            "semantic_variant_count": 0,
        }
        if raw_error is not None:
            detail["lineno"] = raw_error.lineno
            detail["offset"] = raw_error.offset
        print(json.dumps({
            "ok": False,
            "reason": "python_body_syntax_invalid",
            "detail": detail,
        }))
        return 0

    variants = {row[2] for row in valid}
    if len(variants) != 1:
        print(json.dumps({
            "ok": False,
            "reason": "python_body_indentation_ambiguous",
            "detail": {
                "normalization_candidate_count": len(rows),
                "parseable_candidate_count": len(valid),
                "semantic_variant_count": len(variants),
                "parseable_normalizations": [row[0] for row in valid],
            },
        }))
        return 0

    preference = {
        "raw": 0,
        "common_dedent": 1,
        "tail_base_dedent": 2,
    }
    selected = min(valid, key=lambda row: preference[row[0]])
    kind, canonical, _, ast_nodes = selected
    print(json.dumps({
        "ok": True,
        "reason": "ok",
        "body": canonical,
        "detail": {
            "normalization_applied": kind != "raw",
            "normalization_kind": kind,
            "normalization_candidate_count": len(rows),
            "parseable_candidate_count": len(valid),
            "semantic_variant_count": 1,
            "ast_nodes": ast_nodes,
        },
    }))
    return 0

raise SystemExit(main())
`

export function nativePythonBodySurfaceEnabled(
  env = process?.env ?? {},
) {
  const value =
    String(
      env?.[PYTHON_SURFACE_CODEC_ENV] ?? "",
    )
      .trim()
      .toLowerCase()

  return (
    value === NATIVE_PYTHON_BODY_CODEC ||
    value === "native_body"
  )
}

function transformNativePythonDeclarationSchema(
  schema,
  row,
) {
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return {
      schema: cloneJson(schema),
      transformed: 0,
    }
  }

  const out = cloneJson(schema)
  let transformed = 0

  for (const unionKey of ["oneOf", "anyOf"]) {
    if (Array.isArray(out[unionKey])) {
      out[unionKey] =
        out[unionKey].map((branch) => {
          const next =
            transformNativePythonDeclarationSchema(
              branch,
              row,
            )
          transformed +=
            next.transformed
          return next.schema
        })
    }
  }

  if (
    out.properties &&
    typeof out.properties === "object" &&
    !Array.isArray(out.properties) &&
    Object.prototype.hasOwnProperty.call(
      out.properties,
      "python_statements",
    )
  ) {
    const nextProperties = {
      ...out.properties,
    }
    delete nextProperties.python_statements

    nextProperties.body = {
      type: "string",
      minLength: 1,
      maxLength:
        Number.isSafeInteger(row?.max_bytes) &&
        row.max_bytes > 0
          ? Math.min(row.max_bytes, 12288)
          : 6144,
    }

    out.properties =
      nextProperties

    const priorRequired =
      Array.isArray(out.required)
        ? out.required.filter(
            (name) =>
              name !==
              "python_statements",
          )
        : []

    if (!priorRequired.includes("body")) {
      priorRequired.push("body")
    }
    out.required = priorRequired
    transformed += 1
  }

  if (
    out.items &&
    typeof out.items === "object" &&
    !Array.isArray(out.items)
  ) {
    const next =
      transformNativePythonDeclarationSchema(
        out.items,
        row,
      )
    out.items = next.schema
    transformed +=
      next.transformed
  }

  return {
    schema: out,
    transformed,
  }
}

function nativePythonHoleSchema(
  property,
  row,
) {
  if (
    !property ||
    typeof property !== "object" ||
    Array.isArray(property) ||
    property.type !== "object" ||
    !property.properties ||
    typeof property.properties !==
      "object" ||
    Array.isArray(property.properties)
  ) {
    return null
  }

  const declarations =
    property.properties
      .python_declarations

  if (
    !declarations ||
    declarations.type !== "array" ||
    !declarations.items
  ) {
    return null
  }

  const transformed =
    transformNativePythonDeclarationSchema(
      declarations.items,
      row,
    )

  if (transformed.transformed < 1) {
    return null
  }

  return Object.freeze({
    ...cloneJson(property),
    properties:
      Object.freeze({
        ...cloneJson(
          property.properties,
        ),
        python_declarations:
          Object.freeze({
            ...cloneJson(declarations),
            items:
              Object.freeze(
                transformed.schema,
              ),
          }),
      }),
  })
}

function canonicalizeNativePythonBody(
  body,
  declarationKind,
) {
  if (
    typeof body !== "string" ||
    body.length < 1
  ) {
    return fail(
      "atomic_python_body_empty",
    )
  }

  const pythonBin =
    String(
      process?.env
        ?.OPENCODE_CPU_PYTHON_BIN ??
      "python3",
    ).trim() || "python3"

  const result =
    spawnSync(
      pythonBin,
      [
        "-S",
        "-c",
        PYTHON_BODY_CANONICALIZER,
      ],
      {
        input:
          JSON.stringify({
            body,
            declaration_kind:
              declarationKind,
          }),
        encoding: "utf8",
        timeout: 1500,
        maxBuffer: 65536,
        windowsHide: true,
      },
    )

  if (result.error) {
    return fail(
      "atomic_python_body_canonicalizer_unavailable",
      {
        detail:
          String(
            result.error?.message ??
            result.error,
          ).slice(0, 200),
      },
    )
  }

  if (result.status !== 0) {
    return fail(
      "atomic_python_body_canonicalizer_failed",
      {
        status:
          result.status,
        stderr:
          String(
            result.stderr ?? "",
          ).slice(0, 200),
      },
    )
  }

  let decoded
  try {
    decoded =
      JSON.parse(
        String(result.stdout ?? ""),
      )
  } catch {
    return fail(
      "atomic_python_body_canonicalizer_invalid_output",
    )
  }

  if (decoded?.ok !== true) {
    return fail(
      `atomic_${decoded?.reason ?? "python_body_invalid"}`,
      {
        canonicalizer_detail:
          decoded?.detail ?? null,
      },
    )
  }

  if (
    typeof decoded.body !== "string" ||
    decoded.body.length < 1
  ) {
    return fail(
      "atomic_python_body_canonicalizer_missing_body",
    )
  }

  return Object.freeze({
    ok: true,
    protocol:
      NATIVE_PYTHON_BODY_SURFACE_PROTOCOL,
    reason:
      "native_python_body_canonicalized",
    body:
      decoded.body,
    canonicalizer_detail:
      decoded.detail ?? null,
    mutation_authority: false,
  })
}

function lowerNativePythonHoleRequest({
  plan,
  request,
  expectedHole,
} = {}) {
  if (
    !exactKeys(request, ["holes"]) ||
    !request.holes ||
    typeof request.holes !== "object" ||
    Array.isArray(request.holes) ||
    !exactKeys(
      request.holes,
      [expectedHole],
    )
  ) {
    return fail(
      "atomic_native_python_request_invalid",
      {
        expected_hole:
          expectedHole,
      },
    )
  }

  const row =
    plan.rows.find(
      (candidate) =>
        candidate?.hole ===
        expectedHole,
    ) ?? null

  const payload =
    request.holes[
      expectedHole
    ]

  if (
    row?.representation !==
      "python_units" ||
    row?.codec_field !==
      "python_declarations" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !exactKeys(
      payload,
      ["python_declarations"],
    ) ||
    !Array.isArray(
      payload.python_declarations,
    ) ||
    payload.python_declarations.length < 1
  ) {
    return fail(
      "atomic_native_python_payload_invalid",
      {
        expected_hole:
          expectedHole,
      },
    )
  }

  const declarations = []
  const normalization = []

  for (
    let index = 0;
    index <
      payload.python_declarations.length;
    index += 1
  ) {
    const declaration =
      payload.python_declarations[index]

    if (
      !declaration ||
      typeof declaration !==
        "object" ||
      Array.isArray(declaration) ||
      typeof declaration.body !==
        "string" ||
      Object.prototype.hasOwnProperty.call(
        declaration,
        "python_statements",
      )
    ) {
      return fail(
        "atomic_native_python_declaration_invalid",
        {
          declaration_index:
            index,
        },
      )
    }

    const declarationKind =
      declaration
        .declaration_kind

    if (
      declarationKind !==
        "function" &&
      declarationKind !==
        "async_function"
    ) {
      return fail(
        "atomic_native_python_declaration_kind_invalid",
        {
          declaration_index:
            index,
        },
      )
    }

    const canonical =
      canonicalizeNativePythonBody(
        declaration.body,
        declarationKind,
      )

    if (canonical.ok !== true) {
      return Object.freeze({
        ...canonical,
        declaration_index:
          index,
        expected_hole:
          expectedHole,
        mutation_authority: false,
      })
    }

    const lowered = {}
    for (
      const [key, value]
      of Object.entries(
        declaration,
      )
    ) {
      if (key === "body") continue
      lowered[key] =
        cloneJson(value)
    }

    lowered.python_statements = [
      canonical.body,
    ]

    declarations.push(lowered)
    normalization.push(
      Object.freeze({
        declaration_index:
          index,
        ...(canonical
          .canonicalizer_detail ??
          {}),
      }),
    )
  }

  return Object.freeze({
    ok: true,
    protocol:
      NATIVE_PYTHON_BODY_SURFACE_PROTOCOL,
    reason:
      "native_python_body_lowered",
    request:
      Object.freeze({
        holes:
          Object.freeze({
            [expectedHole]:
              Object.freeze({
                python_declarations:
                  Object.freeze(
                    declarations,
                  ),
              }),
          }),
      }),
    normalization:
      Object.freeze(
        normalization,
      ),
    mutation_authority: false,
  })
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol:
      ATOMIC_MODEL_VIEW_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function cloneJson(value) {
  return JSON.parse(
    JSON.stringify(value),
  )
}

function exactKeys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false
  }

  const actual =
    Object.keys(value).sort()
  const wanted =
    [...expected].sort()

  return (
    actual.length === wanted.length &&
    actual.every(
      (key, index) =>
        key === wanted[index],
    )
  )
}

function toolSchemaSlot(tool) {
  if (
    !tool ||
    typeof tool !== "object"
  ) {
    return null
  }

  for (
    const key of [
      "input",
      "inputSchema",
      "parameters",
      "schema",
    ]
  ) {
    const schema = tool[key]
    if (
      schema &&
      typeof schema === "object" &&
      !Array.isArray(schema)
    ) {
      return { key, schema }
    }
  }

  return null
}

function validPlanSurface(plan) {
  return (
    plan?.protocol ===
      MODEL_VIEW_COMPILER_PROTOCOL &&
    typeof plan?.plan_sha256 ===
      "string" &&
    Array.isArray(plan?.rows) &&
    Array.isArray(
      plan?.required_holes,
    ) &&
    plan.required_holes.length > 1 &&
    plan.required_holes.length ===
      plan.rows.length
  )
}

function freshAssembly(plan, turnID) {
  return {
    protocol:
      ATOMIC_MODEL_VIEW_PROTOCOL,
    plan_sha256:
      plan.plan_sha256,
    turn_id:
      typeof turnID === "string"
        ? turnID
        : null,
    cursor: 0,
    accepted_holes: [],
    holes: {},
    mutation_authority: false,
  }
}

function normalizeAssembly({
  plan,
  assembly,
  turnID,
} = {}) {
  const normalizedTurn =
    typeof turnID === "string"
      ? turnID
      : null

  if (
    assembly?.protocol !==
      ATOMIC_MODEL_VIEW_PROTOCOL ||
    assembly.plan_sha256 !==
      plan.plan_sha256 ||
    assembly.turn_id !==
      normalizedTurn ||
    !Number.isSafeInteger(
      assembly.cursor,
    ) ||
    assembly.cursor < 0 ||
    assembly.cursor >=
      plan.required_holes.length ||
    !Array.isArray(
      assembly.accepted_holes,
    ) ||
    !assembly.holes ||
    typeof assembly.holes !==
      "object" ||
    Array.isArray(assembly.holes)
  ) {
    return freshAssembly(
      plan,
      normalizedTurn,
    )
  }

  const expectedAccepted =
    plan.required_holes.slice(
      0,
      assembly.cursor,
    )

  if (
    expectedAccepted.length !==
      assembly.accepted_holes.length ||
    expectedAccepted.some(
      (hole, index) =>
        hole !==
          assembly.accepted_holes[index],
    ) ||
    !exactKeys(
      assembly.holes,
      expectedAccepted,
    )
  ) {
    return freshAssembly(
      plan,
      normalizedTurn,
    )
  }

  return cloneJson(assembly)
}

export function atomicModelViewRuntimeEnabled(
  env = process?.env ?? {},
) {
  // Logical hole atomicity is retained by Model View + Source Slot validation,
  // but OPENCODE_CPU_ONE_CALL_EXECUTOR forbids converting logical holes into
  // N physical inferences. The canonical full-hole tool becomes one bounded
  // transport call; failed-source repair remains a separate max-one retry.
  if (residualModelViewRuntimeEnabled(env)) {
    return false
  }

  return (
    String(
      env?.[SURFACE_MODE_ENV] ?? "",
    ).trim().toLowerCase() ===
      "atomic"
  )
}

export function compileAtomicModelViewProjection({
  tool,
  plan,
  assembly = null,
  turnID = null,
} = {}) {
  if (!validPlanSurface(plan)) {
    return fail(
      "atomic_model_view_plan_invalid",
    )
  }

  const slot = toolSchemaSlot(tool)
  const holesSchema =
    slot?.schema?.properties?.holes

  if (
    !slot ||
    slot.schema?.type !== "object" ||
    !holesSchema ||
    holesSchema.type !== "object" ||
    !holesSchema.properties ||
    typeof holesSchema.properties !==
      "object" ||
    Array.isArray(
      holesSchema.properties,
    )
  ) {
    return fail(
      "atomic_model_view_schema_unavailable",
    )
  }

  const nextAssembly =
    normalizeAssembly({
      plan,
      assembly,
      turnID,
    })

  const hole =
    plan.required_holes[
      nextAssembly.cursor
    ]
  const canonicalProperty =
    holesSchema.properties[hole]

  if (
    !canonicalProperty ||
    typeof canonicalProperty !== "object" ||
    Array.isArray(canonicalProperty)
  ) {
    return fail(
      "atomic_model_view_hole_schema_unavailable",
      { hole },
    )
  }

  const row =
    plan.rows.find(
      (candidate) =>
        candidate?.hole === hole,
    ) ?? null

  const nativePythonSurface =
    row?.representation ===
      "python_units" &&
    nativePythonBodySurfaceEnabled()

  const property =
    nativePythonSurface
      ? nativePythonHoleSchema(
          canonicalProperty,
          row,
        )
      : canonicalProperty

  if (!property) {
    return fail(
      "atomic_native_python_schema_unavailable",
      {
        hole,
        canonical_representation:
          row?.representation ?? null,
      },
    )
  }

  const modelSchema = {
    type: "object",
    properties: {
      holes: {
        type: "object",
        properties: {
          [hole]: cloneJson(property),
        },
        required: [hole],
        additionalProperties: false,
      },
    },
    required: ["holes"],
    additionalProperties: false,
  }

  return Object.freeze({
    ok: true,
    protocol:
      ATOMIC_MODEL_VIEW_PROTOCOL,
    reason:
      "atomic_model_view_projected",
    tool:
      Object.freeze({
        ...tool,
        description:
          nativePythonSurface
            ? (
                `Fill only semantic hole ${hole}. ` +
                "For every Python declaration, emit declaration metadata plus body only. " +
                "The body must be directly insertable under that declaration wrapper; " +
                "do not repeat def/async def/class/decorator wrapper lines inside body. " +
                "Compiler retains file, slot, operation, placement and transaction authority."
              )
            : (
                `Fill only semantic hole ${hole}. ` +
                "Do not emit any other hole. " +
                "Compiler retains file, slot, operation, placement and transaction authority."
              ),
        [slot.key]:
          Object.freeze(modelSchema),
      }),
    assembly:
      Object.freeze(nextAssembly),
    current_hole: hole,
    current_representation:
      nativePythonSurface
        ? "python_declaration_body_native"
        : row?.representation ?? null,
    current_canonical_representation:
      row?.representation ?? null,
    current_surface_codec:
      nativePythonSurface
        ? NATIVE_PYTHON_BODY_SURFACE_PROTOCOL
        : "canonical_model_view",
    current_codec_field:
      row?.codec_field ?? null,
    unit_index:
      nextAssembly.cursor,
    unit_count:
      plan.required_holes.length,
    accepted_count:
      nextAssembly.accepted_holes.length,
    remaining_count:
      plan.required_holes.length -
      nextAssembly.cursor,
    model_calls_required:
      plan.required_holes.length,
    model_calls_added:
      plan.required_holes.length - 1,
    partial_materialization: false,
    mutation_authority: false,
  })
}

export function accumulateAtomicModelViewRequest({
  plan,
  assembly,
  request,
  turnID = null,
} = {}) {
  if (!validPlanSurface(plan)) {
    return fail(
      "atomic_model_view_plan_invalid",
    )
  }

  const current =
    normalizeAssembly({
      plan,
      assembly,
      turnID,
    })
  const hole =
    plan.required_holes[current.cursor]

  const row =
    plan.rows.find(
      (candidate) =>
        candidate?.hole === hole,
    ) ?? null
  const nativePythonSurface =
    row?.representation ===
      "python_units" &&
    nativePythonBodySurfaceEnabled()

  const nativeLowering =
    nativePythonSurface
      ? lowerNativePythonHoleRequest({
          plan,
          request,
          expectedHole: hole,
        })
      : Object.freeze({
          ok: true,
          request,
          normalization: null,
          mutation_authority: false,
        })

  if (nativeLowering.ok !== true) {
    return Object.freeze({
      ...nativeLowering,
      atomic_model_view_protocol:
        ATOMIC_MODEL_VIEW_PROTOCOL,
      atomic_unit_index:
        current.cursor,
      atomic_unit_count:
        plan.required_holes.length,
      surface_codec:
        NATIVE_PYTHON_BODY_SURFACE_PROTOCOL,
      mutation_authority: false,
    })
  }

  const validation =
    validateSourceSlotModelViewPartialRequest({
      plan,
      request:
        nativeLowering.request,
      expectedHole: hole,
    })

  if (validation?.ok !== true) {
    return Object.freeze({
      ...validation,
      atomic_model_view_protocol:
        ATOMIC_MODEL_VIEW_PROTOCOL,
      atomic_unit_index:
        current.cursor,
      atomic_unit_count:
        plan.required_holes.length,
      mutation_authority: false,
    })
  }

  const holes = {
    ...current.holes,
    [hole]:
      cloneJson(
        validation.payload,
      ),
  }
  const accepted = [
    ...current.accepted_holes,
    hole,
  ]
  const nextCursor =
    current.cursor + 1
  const complete =
    nextCursor ===
      plan.required_holes.length

  if (complete) {
    const joined = {}
    for (
      const requiredHole
      of plan.required_holes
    ) {
      joined[requiredHole] =
        cloneJson(holes[requiredHole])
    }

    return Object.freeze({
      ok: true,
      protocol:
        ATOMIC_MODEL_VIEW_PROTOCOL,
      reason:
        "atomic_model_view_join_complete",
      complete: true,
      accepted_hole: hole,
      surface_codec:
        nativePythonSurface
          ? NATIVE_PYTHON_BODY_SURFACE_PROTOCOL
          : "canonical_model_view",
      surface_normalization:
        nativeLowering.normalization ?? null,
      accepted_count:
        accepted.length,
      unit_count:
        plan.required_holes.length,
      request:
        Object.freeze({
          holes:
            Object.freeze(joined),
        }),
      partial_materialization: false,
      compiler_join_required: true,
      mutation_authority: false,
    })
  }

  const nextAssembly =
    Object.freeze({
      protocol:
        ATOMIC_MODEL_VIEW_PROTOCOL,
      plan_sha256:
        plan.plan_sha256,
      turn_id:
        typeof turnID === "string"
          ? turnID
          : null,
      cursor: nextCursor,
      accepted_holes:
        Object.freeze(accepted),
      holes:
        Object.freeze(holes),
      mutation_authority: false,
    })

  return Object.freeze({
    ok: true,
    protocol:
      ATOMIC_MODEL_VIEW_PROTOCOL,
    reason:
      "atomic_model_view_unit_accepted",
    complete: false,
    accepted_hole: hole,
    surface_codec:
      nativePythonSurface
        ? NATIVE_PYTHON_BODY_SURFACE_PROTOCOL
        : "canonical_model_view",
    surface_normalization:
      nativeLowering.normalization ?? null,
    next_hole:
      plan.required_holes[nextCursor],
    accepted_count:
      accepted.length,
    unit_count:
      plan.required_holes.length,
    assembly:
      nextAssembly,
    partial_materialization: false,
    compiler_join_required: true,
    mutation_authority: false,
  })
}
