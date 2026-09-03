import {
  PYTHON_SEMANTIC_PROGRESS_PROTOCOL,
  createPythonClassMemberProgressLedger,
} from "./python-semantic-progress-v1.mjs"

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  PYTHON_UNIT_CONTRACT_PROTOCOL,
  validatePythonUnitsContract,
} from "./python-unit-contract-v1.mjs"

export const PYTHON_NESTED_SEMANTIC_IR_PROTOCOL =
  "python-nested-semantic-ir-v1"

export const PYTHON_NESTED_UNIT_PROTOCOL =
  "python-unit-shell-v2"

export const PYTHON_SUITE_IR_PROTOCOL =
  "python-suite-ir-v2"

const MAX_UNITS = 8
const MAX_SUITE_ITEMS = 64
const MAX_CLASS_MEMBERS = 16
const MAX_BODY_BYTES = 64 * 1024
const MAX_BRIDGE_STDOUT_BYTES =
  4 * 1024 * 1024

const NAME_RE =
  /^[A-Za-z_][A-Za-z0-9_]*$/u

const FUNCTION_FIELDS = new Set([
  "kind",
  "name",
  "parameters",
  "returns",
  "decorators",
  "suite",
])

const CLASS_FIELDS = new Set([
  "kind",
  "name",
  "bases",
  "decorators",
  "members",
])

const ASSIGNMENT_FIELDS = new Set([
  "kind",
  "name",
  "annotation",
  "value",
])

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    protocol:
      PYTHON_NESTED_SEMANTIC_IR_PROTOCOL,
    unit_protocol:
      PYTHON_NESTED_UNIT_PROTOCOL,
    suite_protocol:
      PYTHON_SUITE_IR_PROTOCOL,
    reason,
    mutation_authority: false,
    ...extra,
  })
}

function utf8Bytes(value) {
  return Buffer.byteLength(
    String(value ?? ""),
    "utf8",
  )
}

function exactAllowedFields(
  value,
  allowed,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false
  }

  return Object.keys(value).every(
    (key) => allowed.has(key),
  )
}

function bridgePath() {
  const override =
    process.env
      .OPENCODE_RUFF_PYTHON_BRIDGE

  if (
    typeof override === "string" &&
    override.length > 0
  ) {
    return path.resolve(override)
  }

  const here =
    path.dirname(
      fileURLToPath(import.meta.url),
    )

  return path.resolve(
    here,
    "../.bin/opencode-ruff-python-bridge",
  )
}

function callBridge(payload) {
  const result =
    spawnSync(
      bridgePath(),
      [],
      {
        input: JSON.stringify(payload),
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 8_000,
        maxBuffer:
          MAX_BRIDGE_STDOUT_BYTES,
      },
    )

  if (result.error) {
    return fail(
      result.error.code === "ENOENT"
        ? "ruff_python_bridge_unavailable"
        : "ruff_python_bridge_spawn_failed",
      {
        detail:
          result.error.code ??
          result.error.name ??
          "spawn_error",
      },
    )
  }

  if (result.status !== 0) {
    return fail(
      "ruff_python_bridge_process_failed",
      {
        rc: result.status,
        stderr:
          String(
            result.stderr ?? "",
          ).slice(0, 4096),
      },
    )
  }

  let parsed
  try {
    parsed =
      JSON.parse(
        String(result.stdout ?? ""),
      )
  } catch {
    return fail(
      "ruff_python_bridge_output_invalid",
    )
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.protocol !==
      "ruff-python-bridge-v1"
  ) {
    return fail(
      "ruff_python_bridge_output_invalid",
    )
  }

  return parsed
}

function normalizeStringArray(
  value,
  {
    maxItems,
    maxBytes,
    field,
    allowEmpty = true,
  },
) {
  if (value === undefined) {
    return allowEmpty
      ? Object.freeze({
          ok: true,
          values: Object.freeze([]),
        })
      : fail(
          "python_nested_field_missing",
          { field },
        )
  }

  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    (!allowEmpty && value.length < 1)
  ) {
    return fail(
      "python_nested_array_invalid",
      { field },
    )
  }

  const out = []

  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    const raw = value[index]

    if (
      typeof raw !== "string" ||
      utf8Bytes(raw) > maxBytes
    ) {
      return fail(
        "python_nested_field_invalid",
        {
          field,
          item_index: index,
        },
      )
    }

    out.push(raw)
  }

  return Object.freeze({
    ok: true,
    values: Object.freeze(out),
  })
}

function validateName(value, pathValue) {
  if (
    typeof value !== "string" ||
    !NAME_RE.test(value)
  ) {
    return fail(
      "python_nested_name_invalid",
      {
        unit_path: pathValue,
        field: "name",
      },
    )
  }

  return null
}

function normalizeHeader(
  value,
  field,
  pathValue,
) {
  if (value === undefined) {
    return Object.freeze({
      ok: true,
      value: "",
    })
  }

  if (
    typeof value !== "string" ||
    utf8Bytes(value) > 4096
  ) {
    return fail(
      "python_nested_field_invalid",
      {
        unit_path: pathValue,
        field,
      },
    )
  }

  return Object.freeze({
    ok: true,
    value,
  })
}

export function normalizePythonSuiteChunk(value) {
  const lines =
    String(value)
      .replace(/\r\n?/gu, "\n")
      .split("\n")

  while (
    lines.length > 0 &&
    !lines[0].trim()
  ) {
    lines.shift()
  }

  while (
    lines.length > 0 &&
    !lines[lines.length - 1].trim()
  ) {
    lines.pop()
  }

  const nonBlank =
    lines.filter(
      (line) =>
        line.trim().length > 0,
    )

  if (nonBlank.length === 0) {
    return ""
  }

  let common =
    /^[ \t\f]*/u.exec(
      nonBlank[0],
    )?.[0] ?? ""

  for (
    let index = 1;
    index < nonBlank.length &&
      common.length > 0;
    index += 1
  ) {
    const indent =
      /^[ \t\f]*/u.exec(
        nonBlank[index],
      )?.[0] ?? ""

    const limit =
      Math.min(
        common.length,
        indent.length,
      )

    let shared = 0

    while (
      shared < limit &&
      common[shared] ===
        indent[shared]
    ) {
      shared += 1
    }

    common =
      common.slice(
        0,
        shared,
      )
  }

  if (common.length === 0) {
    return lines.join("\n")
  }

  return lines
    .map(
      (line) =>
        line.trim().length > 0
          ? line.slice(
              common.length,
            )
          : "",
    )
    .join("\n")
}

function validateSuite(
  suite,
  pathValue,
) {
  const normalized =
    normalizeStringArray(
      suite,
      {
        maxItems:
          MAX_SUITE_ITEMS,
        maxBytes:
          MAX_BODY_BYTES,
        field: "suite",
        allowEmpty: false,
      },
    )

  if (normalized.ok !== true) {
    return Object.freeze({
      ...normalized,
      unit_path: pathValue,
    })
  }

  let total = 0
  const items = []

  for (
    let index = 0;
    index < normalized.values.length;
    index += 1
  ) {
    const text =
      normalizePythonSuiteChunk(
        normalized.values[index],
      )

    if (!text.trim()) {
      return fail(
        "semantic_suite_item_empty",
        {
          unit_path: pathValue,
          suite_index: index,
          field: "suite",
        },
      )
    }

    total += utf8Bytes(text)

    if (total > MAX_BODY_BYTES) {
      return fail(
        "python_nested_body_budget_exceeded",
        {
          unit_path: pathValue,
          suite_index: index,
          field: "suite",
          max_bytes:
            MAX_BODY_BYTES,
        },
      )
    }

    items.push(text)
  }

  const parsed =
    callBridge({
      command:
        "validate_suite_items",
      sources:
        items.map(
          (source, index) => ({
            file: String(index),
            source,
          }),
        ),
    })

  if (parsed.ok !== true) {
    return fail(
      parsed.reason ??
        "semantic_suite_validation_failed",
      {
        unit_path: pathValue,
        suite_index:
          Number.isSafeInteger(
            parsed.suite_index,
          )
            ? parsed.suite_index
            : null,
        field: "suite",
        parser_detail:
          parsed.detail ?? null,
        parser_result: parsed,
      },
    )
  }

  return Object.freeze({
    ok: true,
    suite_protocol:
      parsed.suite_protocol ??
      "python-suite-ir-v2",
    items: Object.freeze(items),
    statement_counts:
      Object.freeze(
        Array.isArray(
          parsed.statement_counts,
        )
          ? [...parsed.statement_counts]
          : [],
      ),
    body: items.join("\n"),
    parser:
      parsed.parser ??
      "ruff_python_parser",
    common_margin:
      "compiler_owned",
    mutation_authority: false,
  })
}

function indent(text) {
  return String(text)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

export function inspectPythonSuiteItems(suite) {
  if (!Array.isArray(suite) || suite.length < 1) {
    return fail("semantic_suite_item_count_invalid", { field: "suite" })
  }

  const items = []
  for (let index = 0; index < suite.length; index += 1) {
    const value = suite[index]
    if (typeof value !== "string" || value.trim().length < 1) {
      return fail("semantic_suite_item_empty", {
        suite_index: index,
        field: "suite",
      })
    }
    items.push(value)
  }

  const parsed = callBridge({
    command: "validate_suite_items",
    sources: items.map((source, index) => ({
      file: String(index),
      source,
    })),
  })

  if (parsed.ok !== true) {
    return fail(parsed.reason ?? "semantic_suite_validation_failed", {
      suite_index: Number.isSafeInteger(parsed.suite_index)
        ? parsed.suite_index
        : null,
      field: "suite",
      parser_detail: parsed.detail ?? null,
      parser_result: parsed,
    })
  }

  const shapes = Array.isArray(parsed.statement_shapes)
    ? parsed.statement_shapes
    : null

  if (
    !shapes ||
    shapes.length !== items.length ||
    shapes.some((chunk) =>
      !Array.isArray(chunk) ||
      chunk.length < 1 ||
      chunk.some((shape) =>
        typeof shape !== "string" ||
        ![
          "bare_name_expr",
          "string_literal_expr",
          "expression",
          "statement",
        ].includes(shape),
      ),
    )
  ) {
    return fail("semantic_suite_statement_shapes_invalid", {
      field: "suite",
    })
  }

  return Object.freeze({
    ok: true,
    suite_protocol: parsed.suite_protocol ?? "python-suite-ir-v2",
    statement_counts: Object.freeze(
      Array.isArray(parsed.statement_counts)
        ? [...parsed.statement_counts]
        : [],
    ),
    statement_shapes: Object.freeze(
      shapes.map((chunk) => Object.freeze([...chunk])),
    ),
    parser: parsed.parser ?? "ruff_python_parser",
    mutation_authority: false,
  })
}

function decoratorLines(values) {
  return values.map(
    (value) =>
      `@${value.replace(/^@/u, "")}`,
  )
}

function renderInternalUnit(unit) {
  const decorators =
    decoratorLines(
      unit.decorators ?? [],
    )

  if (
    unit.kind === "function" ||
    unit.kind === "async_function"
  ) {
    const prefix =
      unit.kind ===
      "async_function"
        ? "async "
        : ""

    let header =
      `${prefix}def ${unit.name}` +
      `(${unit.parameters ?? ""})`

    if (unit.returns) {
      header +=
        ` -> ${unit.returns}`
    }

    header += ":"

    return [
      ...decorators,
      header,
      indent(unit.body),
    ].join("\n")
  }

  if (unit.kind === "assignment") {
    if (
      Array.isArray(unit.decorators) &&
      unit.decorators.length > 0
    ) {
      throw new Error(
        "assignment_decorator_forbidden",
      )
    }

    return unit.annotation
      ? `${unit.name}: ${unit.annotation} = ${unit.value}`
      : `${unit.name} = ${unit.value}`
  }

  throw new Error(
    "internal_member_kind_unsupported",
  )
}

function lowerUnit(
  unit,
  {
    unitIndex,
    unitPath,
    classMember = false,
  },
) {
  if (
    !unit ||
    typeof unit !== "object" ||
    Array.isArray(unit)
  ) {
    return fail(
      "python_nested_unit_shape_invalid",
      {
        unit_index: unitIndex,
        unit_path: unitPath,
      },
    )
  }

  const kind = unit.kind

  const badName =
    validateName(
      unit.name,
      unitPath,
    )

  if (badName) {
    return Object.freeze({
      ...badName,
      unit_index: unitIndex,
    })
  }

  if (
    kind === "function" ||
    kind === "async_function"
  ) {
    if (
      !exactAllowedFields(
        unit,
        FUNCTION_FIELDS,
      )
    ) {
      return fail(
        "python_nested_unit_fields_invalid",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          kind,
          unexpected_fields:
            Object.keys(unit)
              .filter(
                (key) =>
                  !FUNCTION_FIELDS.has(key),
              )
              .sort(),
        },
      )
    }

    if (
      !Object.hasOwn(
        unit,
        "suite",
      )
    ) {
      return fail(
        "python_nested_suite_missing",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          field: "suite",
        },
      )
    }

    const parameters =
      normalizeHeader(
        unit.parameters,
        "parameters",
        unitPath,
      )

    if (parameters.ok !== true) {
      return parameters
    }

    const returns =
      normalizeHeader(
        unit.returns,
        "returns",
        unitPath,
      )

    if (returns.ok !== true) {
      return returns
    }

    const decorators =
      normalizeStringArray(
        unit.decorators,
        {
          maxItems: 16,
          maxBytes: 4096,
          field: "decorators",
          allowEmpty: true,
        },
      )

    if (decorators.ok !== true) {
      return decorators
    }

    const suite =
      validateSuite(
        unit.suite,
        unitPath,
      )

    if (suite.ok !== true) {
      return Object.freeze({
        ...suite,
        unit_index: unitIndex,
      })
    }

    return Object.freeze({
      ok: true,
      unit: Object.freeze({
        kind,
        name: unit.name,
        parameters:
          parameters.value,
        ...(returns.value
          ? {
              returns:
                returns.value,
            }
          : {}),
        ...(decorators.values.length
          ? {
              decorators:
                [...decorators.values],
            }
          : {}),
        body: suite.body,
      }),
      unit_index: unitIndex,
      unit_path: unitPath,
    })
  }

  if (kind === "assignment") {
    if (
      !exactAllowedFields(
        unit,
        ASSIGNMENT_FIELDS,
      )
    ) {
      return fail(
        "python_nested_unit_fields_invalid",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          kind,
          unexpected_fields:
            Object.keys(unit)
              .filter(
                (key) =>
                  !ASSIGNMENT_FIELDS.has(key),
              )
              .sort(),
        },
      )
    }

    if (
      typeof unit.value !== "string" ||
      !unit.value.trim() ||
      utf8Bytes(unit.value) >
        MAX_BODY_BYTES
    ) {
      return fail(
        "python_nested_value_invalid",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          field: "value",
        },
      )
    }

    const annotation =
      normalizeHeader(
        unit.annotation,
        "annotation",
        unitPath,
      )

    if (annotation.ok !== true) {
      return annotation
    }

    return Object.freeze({
      ok: true,
      unit: Object.freeze({
        kind,
        name: unit.name,
        ...(annotation.value
          ? {
              annotation:
                annotation.value,
            }
          : {}),
        value: unit.value,
      }),
      unit_index: unitIndex,
      unit_path: unitPath,
    })
  }

  if (kind === "class") {
    if (classMember) {
      return fail(
        "python_nested_class_unsupported",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          mutation_authority: false,
        },
      )
    }

    if (
      !exactAllowedFields(
        unit,
        CLASS_FIELDS,
      )
    ) {
      return fail(
        "python_nested_unit_fields_invalid",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          kind,
          unexpected_fields:
            Object.keys(unit)
              .filter(
                (key) =>
                  !CLASS_FIELDS.has(key),
              )
              .sort(),
        },
      )
    }

    if (
      !Array.isArray(unit.members) ||
      unit.members.length < 1 ||
      unit.members.length >
        MAX_CLASS_MEMBERS
    ) {
      return fail(
        "python_nested_class_members_invalid",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          field: "members",
          max_members:
            MAX_CLASS_MEMBERS,
        },
      )
    }

    const bases =
      normalizeStringArray(
        unit.bases,
        {
          maxItems: 16,
          maxBytes: 4096,
          field: "bases",
          allowEmpty: true,
        },
      )

    if (bases.ok !== true) {
      return bases
    }

    const decorators =
      normalizeStringArray(
        unit.decorators,
        {
          maxItems: 16,
          maxBytes: 4096,
          field: "decorators",
          allowEmpty: true,
        },
      )

    if (decorators.ok !== true) {
      return decorators
    }

    const rendered = []
    const classProgress =
      createPythonClassMemberProgressLedger()

    for (
      let memberIndex = 0;
      memberIndex <
        unit.members.length;
      memberIndex += 1
    ) {
      const child =
        lowerUnit(
          unit.members[
            memberIndex
          ],
          {
            unitIndex,
            unitPath: [
              ...unitPath,
              memberIndex,
            ],
            classMember: true,
          },
        )

      if (child.ok !== true) {
        return child
      }

      const memberProgress =
        classProgress.observe(
          child.unit,
        )

      if (
        memberProgress.ok !== true
      ) {
        return fail(
          memberProgress.reason,
          {
            unit_index: unitIndex,
            unit_path: [
              ...unitPath,
              memberIndex,
            ],
            field: "members",
            semantic_progress_protocol:
              PYTHON_SEMANTIC_PROGRESS_PROTOCOL,
            member_identity:
              memberProgress.identity ??
              null,
            member_fingerprint_sha256:
              memberProgress.fingerprint_sha256 ??
              null,
            previous_fingerprint_sha256:
              memberProgress.previous_fingerprint_sha256 ??
              null,
            exact_repeat:
              memberProgress.exact_repeat === true,
            identity_conflict:
              memberProgress.identity_conflict === true,
            mutation_authority: false,
          },
        )
      }

      try {
        rendered.push(
          renderInternalUnit(
            child.unit,
          ),
        )
      } catch (error) {
        return fail(
          "python_nested_internal_render_failed",
          {
            unit_index: unitIndex,
            unit_path: [
              ...unitPath,
              memberIndex,
            ],
            detail:
              error?.message ??
              "render_failed",
          },
        )
      }
    }

    const body =
      rendered.join("\n\n")

    if (
      !body.trim() ||
      utf8Bytes(body) >
        MAX_BODY_BYTES
    ) {
      return fail(
        "python_nested_body_budget_exceeded",
        {
          unit_index: unitIndex,
          unit_path: unitPath,
          max_bytes:
            MAX_BODY_BYTES,
        },
      )
    }

    return Object.freeze({
      ok: true,
      unit: Object.freeze({
        kind,
        name: unit.name,
        ...(bases.values.length
          ? {
              bases:
                [...bases.values],
            }
          : {}),
        ...(decorators.values.length
          ? {
              decorators:
                [...decorators.values],
            }
          : {}),
        body,
      }),
      unit_index: unitIndex,
      unit_path: unitPath,
    })
  }

  return fail(
    "python_nested_kind_unsupported",
    {
      unit_index: unitIndex,
      unit_path: unitPath,
      kind: kind ?? null,
    },
  )
}

export function lowerPythonNestedSemanticUnits(
  units,
) {
  // R6: model-facing Python shape is admitted by one canonical contract
  // before any nested lowering or Ruff syntax work. Semantic parsing remains
  // downstream authority; this layer only closes representational drift.
  const contractAdmission =
    validatePythonUnitsContract(units)

  if (contractAdmission.ok !== true) {
    return Object.freeze({
      ...contractAdmission,
      nested_protocol:
        PYTHON_UNIT_CONTRACT_PROTOCOL,
      mutation_authority: false,
    })
  }


  if (
    !Array.isArray(units) ||
    units.length < 1 ||
    units.length > MAX_UNITS
  ) {
    return fail(
      "python_nested_unit_count_invalid",
      {
        units:
          Array.isArray(units)
            ? units.length
            : null,
        max_units: MAX_UNITS,
      },
    )
  }

  const lowered = []

  for (
    let unitIndex = 0;
    unitIndex < units.length;
    unitIndex += 1
  ) {
    const row =
      lowerUnit(
        units[unitIndex],
        {
          unitIndex,
          unitPath: [unitIndex],
        },
      )

    if (row.ok !== true) {
      return row
    }

    lowered.push(row.unit)
  }

  return Object.freeze({
    ok: true,
    protocol:
      PYTHON_NESTED_SEMANTIC_IR_PROTOCOL,
    unit_protocol:
      PYTHON_NESTED_UNIT_PROTOCOL,
    suite_protocol:
      PYTHON_SUITE_IR_PROTOCOL,
    internal_unit_protocol:
      "python-unit-shell-v1",
    units: Object.freeze(lowered),
    outer_indent_authority:
      "compiler",
    model_raw_body_authority:
      false,
    mutation_authority: false,
  })
}


export function lowerPythonSourceFragment(source) {
  if (
    typeof source !== "string" ||
    source.length < 1 ||
    utf8Bytes(source) > MAX_BODY_BYTES
  ) {
    return fail(
      "python_source_fragment_invalid",
      { field: "source" },
    )
  }

  const parsed = callBridge({
    command: "lower_source_fragment",
    source,
  })
  if (
    parsed?.ok !== true ||
    !Array.isArray(parsed.units) ||
    parsed.units.length < 1 ||
    !Array.isArray(parsed.module_imports)
  ) {
    return fail(
      parsed?.reason ??
        "python_source_fragment_lowering_failed",
      {
        field: "source",
        bridge: parsed ?? null,
      },
    )
  }

  const moduleImports = []
  for (const intent of parsed.module_imports) {
    if (
      !intent ||
      typeof intent !== "object" ||
      typeof intent.kind !== "string" ||
      !["module", "from"].includes(intent.kind) ||
      typeof intent.module !== "string" ||
      intent.module.length < 1 ||
      typeof intent.local !== "string" ||
      intent.local.length < 1 ||
      typeof intent.canonical !== "string" ||
      intent.canonical.length < 1 ||
      intent.source !== "model_static_import_hint" ||
      (intent.name != null && typeof intent.name !== "string") ||
      (intent.alias != null && typeof intent.alias !== "string")
    ) {
      return fail(
        "python_source_fragment_import_intent_invalid",
        { field: "source" },
      )
    }
    moduleImports.push(Object.freeze({
      kind: intent.kind,
      module: intent.module,
      name: intent.name ?? null,
      local: intent.local,
      canonical: intent.canonical,
      alias: intent.alias ?? null,
      source: intent.source,
    }))
  }

  return Object.freeze({
    ok: true,
    protocol: PYTHON_NESTED_SEMANTIC_IR_PROTOCOL,
    source_fragment_protocol:
      parsed.source_fragment_protocol ??
      "source-slot-python-fragment-v2",
    units: Object.freeze(
      parsed.units.map((unit) => Object.freeze({ ...unit })),
    ),
    module_imports: Object.freeze(moduleImports),
    module_import_count: moduleImports.length,
    parser: parsed.parser ?? "ruff_python_parser",
    execution_model:
      parsed.execution_model ??
      "typed_source_fragment_frontend",
    authority_expansion: false,
    mutation_authority: false,
  })
}

export function canonicalizePythonModuleSourceFragment(source) {
  if (
    typeof source !== "string" ||
    source.length < 1 ||
    utf8Bytes(source) > MAX_BODY_BYTES
  ) {
    return fail(
      "python_source_fragment_invalid",
      { field: "source" },
    )
  }

  const canonicalized = callBridge({
    command: "canonicalize_source_fragment",
    source,
  })

  if (
    !canonicalized ||
    typeof canonicalized !== "object" ||
    Array.isArray(canonicalized)
  ) {
    return fail(
      "python_source_fragment_canonicalization_failed",
      {
        field: "source",
        bridge: canonicalized ?? null,
      },
    )
  }

  return Object.freeze({
    ...canonicalized,
    mutation_authority: false,
  })
}
