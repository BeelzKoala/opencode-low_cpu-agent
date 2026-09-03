import { createHash } from "node:crypto"

import {
  deriveFileFamilyContract,
} from "./file-family-contract-v1.mjs"

export const MODEL_VIEW_COMPILER_PROTOCOL =
  "model-view-compiler-v1"

export const MODEL_VIEW_CODEC_PROTOCOL =
  "model-view-codec-v1"

export const MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL =
  "model-view-semantic-contract-v1"

export const MODEL_VIEW_FAILURE_CLASSIFIER_PROTOCOL =
  "model-view-failure-classifier-v1"

const HOLE_ID_RE = /^h([0-7])$/u
const OPERATION_ID_RE = /^op_([0-7])$/u
const MODEL_RESOURCE_RE =
  /resource:\/\/([A-Za-z][A-Za-z0-9_]{0,63})/gu

const SCHEMA_ANNOTATION_KEYS =
  new Set([
    "description",
    "title",
    "$comment",
    "examples",
  ])

const PYTHON_SCHEMA_FIELD_TO_MODEL =
  Object.freeze({
    kind: "declaration_kind",
    parameters: "signature",
    returns: "return_annotation",
    suite: "python_statements",
  })

const PYTHON_MODEL_FIELD_TO_CANONICAL =
  Object.freeze(
    Object.fromEntries(
      Object.entries(
        PYTHON_SCHEMA_FIELD_TO_MODEL,
      ).map(
        ([canonical, model]) => [
          model,
          canonical,
        ],
      ),
    ),
  )

const STRUCTURAL_TEXT_CODECS =
  new Set([
    "markup_fragment",
    "markup_document",
    "xml_fragment",
    "xml_document",
  ])

const NON_REPAIRABLE_REASONS =
  new Set([
    "model_view_request_invalid",
    "model_view_hole_keys_invalid",
    "model_view_hole_payload_invalid",
    "model_view_codec_shape_invalid",
    "model_view_resource_identity_forbidden",
    "model_view_resource_unknown",
    "model_view_python_prose_payload",
    "model_view_structural_text_missing",
    "model_view_candidate_structural_contract_violation",
    "model_view_partial_hole_cardinality_invalid",
    "model_view_partial_hole_order_invalid",
    "source_slot_compiler_owned_value_echo",
    "source_slot_model_hole_request_invalid",
    "source_slot_model_hole_keys_invalid",
    "source_slot_model_hole_value_invalid",
    "source_slot_model_resource_identity_forbidden",
    "source_slot_model_resource_unknown",
  ])

function classifyFailureReason(reason) {
  const repairEligible =
    !NON_REPAIRABLE_REASONS.has(
      reason,
    )

  let failureClass =
    repairEligible
      ? "candidate_defect_unclassified"
      : "representation_contract_violation"

  if (
    reason ===
      "model_view_candidate_structural_contract_violation"
  ) {
    failureClass =
      "derived_semantic_contract_violation"
  } else if (
    reason ===
      "model_view_python_prose_payload" ||
    reason ===
      "model_view_structural_text_missing"
  ) {
    failureClass =
      "semantic_payload_shape_violation"
  } else if (
    reason ===
      "model_view_resource_identity_forbidden" ||
    reason ===
      "model_view_resource_unknown"
  ) {
    failureClass =
      "model_resource_contract_violation"
  }

  return Object.freeze({
    protocol:
      MODEL_VIEW_FAILURE_CLASSIFIER_PROTOCOL,
    failure_class:
      failureClass,
    repair_eligible:
      repairEligible,
    mutation_authority: false,
  })
}

function fail(reason, extra = {}) {
  const classification =
    classifyFailureReason(reason)

  return Object.freeze({
    ok: false,
    protocol:
      MODEL_VIEW_COMPILER_PROTOCOL,
    reason,
    failure_classifier_protocol:
      classification.protocol,
    failure_class:
      classification.failure_class,
    repair_eligible:
      classification.repair_eligible,
    mutation_authority: false,
    ...extra,
  })
}

function cloneJson(value) {
  return JSON.parse(
    JSON.stringify(value),
  )
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value
      .map(stableJson)
      .join(",")}]`
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(value[key])}`,
      )
      .join(",")}}`
  }

  return JSON.stringify(value)
}

function sha(value) {
  return createHash("sha256")
    .update(
      stableJson(value),
      "utf8",
    )
    .digest("hex")
}

function jsonBytes(value) {
  return Buffer.byteLength(
    JSON.stringify(value),
    "utf8",
  )
}

function exactKeys(
  value,
  expected,
) {
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
    actual.length ===
      wanted.length &&
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
      return {
        key,
        schema,
      }
    }
  }

  return null
}

function stripSchemaAnnotations(
  value,
) {
  if (Array.isArray(value)) {
    return value.map(
      stripSchemaAnnotations,
    )
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return value
  }

  const out = {}

  for (
    const [key, child]
    of Object.entries(value)
  ) {
    if (
      SCHEMA_ANNOTATION_KEYS.has(key)
    ) {
      continue
    }

    out[key] =
      stripSchemaAnnotations(
        child,
      )
  }

  return out
}

function renamePythonSchemaFields(
  value,
) {
  if (Array.isArray(value)) {
    return value.map(
      renamePythonSchemaFields,
    )
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return value
  }

  const out = {}

  for (
    const [key, child]
    of Object.entries(value)
  ) {
    if (
      key === "properties" &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      const properties = {}

      for (
        const [propertyName, propertySchema]
        of Object.entries(child)
      ) {
        const modelName =
          PYTHON_SCHEMA_FIELD_TO_MODEL[
            propertyName
          ] ??
          propertyName

        properties[modelName] =
          renamePythonSchemaFields(
            propertySchema,
          )
      }

      out[key] = properties
      continue
    }

    if (
      key === "required" &&
      Array.isArray(child)
    ) {
      out[key] =
        child.map(
          (propertyName) =>
            PYTHON_SCHEMA_FIELD_TO_MODEL[
              propertyName
            ] ??
            propertyName,
        )
      continue
    }

    out[key] =
      renamePythonSchemaFields(
        child,
      )
  }

  return out
}

function decodePythonModelFields(
  value,
) {
  if (Array.isArray(value)) {
    return value.map(
      decodePythonModelFields,
    )
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return value
  }

  const out = {}

  for (
    const [key, child]
    of Object.entries(value)
  ) {
    const canonical =
      PYTHON_MODEL_FIELD_TO_CANONICAL[
        key
      ] ??
      key

    out[canonical] =
      decodePythonModelFields(
        child,
      )
  }

  return out
}

function bindingRows(binding) {
  const rows =
    Array.isArray(
      binding?.all_source_rows,
    )
      ? binding.all_source_rows
      : []

  const normalized = []

  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.source_key !==
        "string" ||
      row.source_key.length < 1 ||
      typeof row.operation_id !==
        "string" ||
      !OPERATION_ID_RE.test(
        row.operation_id,
      ) ||
      !Number.isSafeInteger(
        row.operation_index,
      ) ||
      row.operation_index < 0 ||
      row.operation_index > 7 ||
      row.operation_id !==
        `op_${row.operation_index}` ||
      typeof row.kind !== "string" ||
      row.kind.length < 1 ||
      typeof row.slot !== "string" ||
      row.slot.length < 1
    ) {
      return null
    }

    normalized.push(
      Object.freeze({
        source_key:
          row.source_key,
        operation_id:
          row.operation_id,
        operation_index:
          row.operation_index,
        obligation:
          typeof row.obligation ===
            "string"
            ? row.obligation
            : row.source_key,
        kind:
          row.kind,
        slot:
          row.slot,
        max_bytes:
          Number.isSafeInteger(
            row.max_bytes,
          )
            ? row.max_bytes
            : null,
        allow_module_imports:
          row.allow_module_imports ===
            true,
      }),
    )
  }

  normalized.sort(
    (a, b) =>
      a.operation_index -
        b.operation_index ||
      a.source_key.localeCompare(
        b.source_key,
      ),
  )

  return normalized
}

function activeRowsForSchema({
  binding,
  sourceSchema,
} = {}) {
  if (
    !sourceSchema ||
    typeof sourceSchema !==
      "object" ||
    Array.isArray(sourceSchema) ||
    sourceSchema.type !==
      "object" ||
    sourceSchema
      .additionalProperties !==
      false ||
    !sourceSchema.properties ||
    typeof sourceSchema
      .properties !== "object" ||
    Array.isArray(
      sourceSchema.properties,
    ) ||
    !Array.isArray(
      sourceSchema.required,
    )
  ) {
    return fail(
      "model_view_source_schema_invalid",
    )
  }

  const required =
    [...sourceSchema.required]

  if (
    required.length < 1 ||
    required.length > 8 ||
    new Set(required).size !==
      required.length
  ) {
    return fail(
      "model_view_source_required_invalid",
    )
  }

  const rows =
    bindingRows(binding)

  if (!rows) {
    return fail(
      "model_view_binding_invalid",
    )
  }

  const byKey =
    new Map(
      rows.map(
        (row) => [
          row.source_key,
          row,
        ],
      ),
    )

  const active = []

  for (const sourceKey of required) {
    const row =
      byKey.get(sourceKey)

    if (
      !row ||
      !Object.prototype
        .hasOwnProperty.call(
          sourceSchema.properties,
          sourceKey,
        )
    ) {
      return fail(
        "model_view_binding_schema_drift",
        {
          source_key:
            sourceKey,
        },
      )
    }

    active.push(
      Object.freeze({
        ...row,
        source_schema:
          sourceSchema.properties[
            sourceKey
          ],
      }),
    )
  }

  active.sort(
    (a, b) =>
      a.operation_index -
        b.operation_index,
  )

  return Object.freeze({
    ok: true,
    rows:
      Object.freeze(active),
    all_rows:
      Object.freeze(rows),
    mutation_authority: false,
  })
}

function fileFamilyContractForRows({
  rows,
  capability,
} = {}) {
  const operations =
    rows.map(
      (row) => ({
        id:
          row.operation_id,
        obligation:
          row.obligation,
        kind:
          row.kind,
        slot:
          row.slot,
      }),
    )

  const contract =
    deriveFileFamilyContract({
      operations,
      capability,
    })

  if (contract?.ok !== true) {
    return fail(
      "model_view_file_family_unavailable",
      {
        family_reason:
          contract?.reason ?? null,
      },
    )
  }

  return contract
}

function preservationContractForRow(
  row,
) {
  const existingSlot =
    typeof row?.slot === "string" &&
    row.slot.startsWith("existing:")

  return Object.freeze({
    preservation_mode:
      existingSlot
        ? "preserve_unmentioned_semantics"
        : "not_applicable",
    preservation_scope:
      "bounded_slot",
    allowed_delta_authority:
      "deterministic_verifier_only",
  })
}

function deriveSemanticContract({
  row,
  family,
} = {}) {
  if (
    row?.kind ===
      "python_declaration" &&
    family?.representation ===
      "python_units"
  ) {
    return Object.freeze({
      protocol:
        MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
      kind:
        "python_declaration_body_v1",
      duplicate_owned_wrapper_forbidden:
        true,
      module_imports_possible:
        row.allow_module_imports ===
          true,
      ...preservationContractForRow(row),
      authority:
        "derived_from_canonical_operation_and_file_family",
      mutation_authority: false,
    })
  }

  if (
    row?.kind === "replacement" &&
    family?.representation ===
      "markup_fragment"
  ) {
    return Object.freeze({
      protocol:
        MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
      kind:
        "markup_fragment_replacement_v1",
      template_extends_forbidden:
        true,
      document_root_forbidden:
        true,
      ...preservationContractForRow(row),
      authority:
        "derived_from_canonical_operation_and_file_family",
      mutation_authority: false,
    })
  }

  if (
    row?.kind === "creation" &&
    family?.representation ===
      "markup_document"
  ) {
    return Object.freeze({
      protocol:
        MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
      kind:
        "markup_document_creation_v1",
      template_document_allowed:
        true,
      ...preservationContractForRow(row),
      authority:
        "derived_from_canonical_operation_and_file_family",
      mutation_authority: false,
    })
  }

  return Object.freeze({
    protocol:
      MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
    kind:
      "codec_shape_only_v1",
    ...preservationContractForRow(row),
    authority:
      "derived_from_canonical_operation_and_file_family",
    mutation_authority: false,
  })
}

function semanticContractControlTokens(
  contract,
) {
  if (
    !contract ||
    typeof contract !== "object"
  ) {
    return "contract=codec_shape_only_v1"
  }

  const tokens = [
    `contract=${contract.kind}`,
  ]

  for (
    const key of [
      "duplicate_owned_wrapper_forbidden",
      "module_imports_possible",
      "template_extends_forbidden",
      "document_root_forbidden",
      "template_document_allowed",
    ]
  ) {
    if (
      typeof contract[key] ===
        "boolean"
    ) {
      tokens.push(
        `${key}=${contract[key]}`,
      )
    }
  }

  return tokens.join(" ")
}

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  )
}

function pythonOwnedWrapperDuplicate(
  declarations,
) {
  if (!Array.isArray(declarations)) {
    return null
  }

  for (
    let unitIndex = 0;
    unitIndex < declarations.length;
    unitIndex += 1
  ) {
    const unit = declarations[unitIndex]
    const name =
      typeof unit?.name === "string"
        ? unit.name.trim()
        : ""
    const kind =
      unit?.declaration_kind

    if (
      !name ||
      ![
        "function",
        "async_function",
      ].includes(kind) ||
      !Array.isArray(
        unit?.python_statements,
      )
    ) {
      continue
    }

    const escapedName =
      escapeRegExp(name)
    const wrapper =
      new RegExp(
        "^\\s*(?:@[^\\n]+\\n\\s*)*" +
          "(?:async\\s+def|def)\\s+" +
          escapedName +
          "\\s*\\(",
        "u",
      )

    for (
      let statementIndex = 0;
      statementIndex <
        unit.python_statements.length;
      statementIndex += 1
    ) {
      const statement =
        unit.python_statements[
          statementIndex
        ]

      if (
        typeof statement === "string" &&
        wrapper.test(statement)
      ) {
        return Object.freeze({
          kind:
            "python_owned_wrapper_duplicate",
          unit_index: unitIndex,
          statement_index:
            statementIndex,
        })
      }
    }
  }

  return null
}

function markupFragmentDocumentViolation(
  text,
  contract,
) {
  if (
    typeof text !== "string" ||
    !contract ||
    typeof contract !== "object"
  ) {
    return null
  }

  if (
    contract
      .template_extends_forbidden ===
      true &&
    /\{%\s*extends\b[^%]*%\}/iu.test(
      text,
    )
  ) {
    return Object.freeze({
      kind:
        "markup_fragment_template_extends",
    })
  }

  if (
    contract
      .document_root_forbidden ===
      true &&
    /(?:<!doctype\s+html\b|<html\b)/iu.test(
      text,
    )
  ) {
    return Object.freeze({
      kind:
        "markup_fragment_document_root",
    })
  }

  return null
}

function inspectDerivedSemanticContracts({
  plan,
  request,
} = {}) {
  const byHole =
    new Map(
      plan.rows.map(
        (row) => [
          row.hole,
          row,
        ],
      ),
    )

  const violations = []

  for (
    const hole
    of plan.required_holes
  ) {
    const row = byHole.get(hole)
    const payload =
      request?.holes?.[hole]

    if (
      !row ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      continue
    }

    if (
      row.semantic_contract
        ?.duplicate_owned_wrapper_forbidden ===
        true &&
      Array.isArray(
        payload.python_declarations,
      )
    ) {
      const duplicate =
        pythonOwnedWrapperDuplicate(
          payload
            .python_declarations,
        )

      if (duplicate) {
        violations.push(
          Object.freeze({
            hole,
            contract:
              row.semantic_contract.kind,
            ...duplicate,
          }),
        )
      }
    }

    if (
      row.representation ===
        "markup_fragment" &&
      typeof payload[
        row.codec_field
      ] === "string"
    ) {
      const documentViolation =
        markupFragmentDocumentViolation(
          payload[
            row.codec_field
          ],
          row.semantic_contract,
        )

      if (documentViolation) {
        violations.push(
          Object.freeze({
            hole,
            contract:
              row.semantic_contract.kind,
            ...documentViolation,
          }),
        )
      }
    }
  }

  return Object.freeze(
    violations,
  )
}

function pythonCodecSchema(
  sourceSchema,
) {
  const clean =
    stripSchemaAnnotations(
      cloneJson(sourceSchema),
    )

  const units =
    clean?.properties?.units

  if (
    clean?.type !== "object" ||
    clean
      .additionalProperties !==
      false ||
    !Array.isArray(
      clean.required,
    ) ||
    clean.required.length !== 1 ||
    clean.required[0] !==
      "units" ||
    !units ||
    units.type !== "array"
  ) {
    return null
  }

  return Object.freeze({
    type: "object",
    properties:
      Object.freeze({
        python_declarations:
          renamePythonSchemaFields(
            units,
          ),
      }),
    required:
      Object.freeze([
        "python_declarations",
      ]),
    additionalProperties: false,
  })
}

function textCodecSchema({
  sourceSchema,
  representation,
} = {}) {
  const clean =
    stripSchemaAnnotations(
      cloneJson(sourceSchema),
    )

  if (
    clean?.type !== "string" ||
    typeof representation !==
      "string" ||
    representation.length < 1
  ) {
    return null
  }

  return Object.freeze({
    type: "object",
    properties:
      Object.freeze({
        [representation]:
          clean,
      }),
    required:
      Object.freeze([
        representation,
      ]),
    additionalProperties: false,
  })
}

function planCore(plan) {
  if (
    !plan ||
    typeof plan !== "object" ||
    !Array.isArray(plan.rows) ||
    !Array.isArray(
      plan.required_holes,
    )
  ) {
    return null
  }

  return {
    protocol:
      plan.protocol,
    codec_protocol:
      plan.codec_protocol,
    binding_sha256:
      plan.binding_sha256 ?? null,
    source_spec_sha256:
      plan.source_spec_sha256 ??
      null,
    file_family_contract_sha256:
      plan
        .file_family_contract_sha256 ??
      null,
    required_holes:
      [...plan.required_holes],
    rows:
      plan.rows.map(
        (row) => ({ ...row }),
      ),
    compiler_identity_fields_exposed:
      plan
        .compiler_identity_fields_exposed,
    annotation_independent_semantics:
      plan
        .annotation_independent_semantics,
    final_model_abi_owner:
      plan.final_model_abi_owner,
    generic_model_abi_projection_allowed:
      plan
        .generic_model_abi_projection_allowed,
    model_file_authority:
      plan.model_file_authority,
    model_slot_authority:
      plan.model_slot_authority,
    model_operation_authority:
      plan
        .model_operation_authority,
    mutation_authority:
      plan.mutation_authority,
  }
}

function validPlan(plan) {
  const core =
    planCore(plan)

  if (
    !core ||
    plan.protocol !==
      MODEL_VIEW_COMPILER_PROTOCOL ||
    plan.codec_protocol !==
      MODEL_VIEW_CODEC_PROTOCOL ||
    typeof plan.plan_sha256 !==
      "string" ||
    sha(core) !==
      plan.plan_sha256 ||
    plan
      .compiler_identity_fields_exposed !==
      0 ||
    plan
      .annotation_independent_semantics !==
      true ||
    plan.final_model_abi_owner !==
      MODEL_VIEW_COMPILER_PROTOCOL ||
    plan
      .generic_model_abi_projection_allowed !==
      false ||
    plan.model_file_authority !==
      false ||
    plan.model_slot_authority !==
      false ||
    plan
      .model_operation_authority !==
      false ||
    plan.mutation_authority !==
      false
  ) {
    return false
  }

  const holes =
    plan.rows.map(
      (row) => row?.hole,
    )

  return (
    plan.rows.length >= 1 &&
    plan.rows.length <= 8 &&
    new Set(holes).size ===
      plan.rows.length &&
    holes.every(
      (hole) =>
        typeof hole === "string" &&
        HOLE_ID_RE.test(hole),
    ) &&
    plan.required_holes.length ===
      plan.rows.length &&
    plan.required_holes.every(
      (hole, index) =>
        hole === holes[index],
    )
  )
}

export function compileSourceSlotModelView({
  tool,
  binding,
  capability,
} = {}) {
  const slot =
    toolSchemaSlot(tool)

  if (!slot) {
    return fail(
      "model_view_tool_schema_unavailable",
    )
  }

  const canonicalSchema =
    slot.schema

  const sources =
    canonicalSchema
      ?.properties?.sources

  if (
    canonicalSchema?.type !==
      "object" ||
    canonicalSchema
      .additionalProperties !==
      false ||
    !canonicalSchema.properties ||
    typeof canonicalSchema
      .properties !== "object" ||
    Array.isArray(
      canonicalSchema.properties,
    ) ||
    Object.keys(
      canonicalSchema.properties,
    ).length !== 1 ||
    !sources ||
    typeof sources !== "object" ||
    Array.isArray(sources) ||
    !Array.isArray(
      canonicalSchema.required,
    ) ||
    canonicalSchema.required.length !==
      1 ||
    canonicalSchema.required[0] !==
      "sources"
  ) {
    return fail(
      "model_view_canonical_schema_invalid",
    )
  }

  const active =
    activeRowsForSchema({
      binding,
      sourceSchema: sources,
    })

  if (active.ok !== true) {
    return active
  }

  const familyContract =
    fileFamilyContractForRows({
      rows:
        active.all_rows,
      capability,
    })

  if (
    familyContract?.ok !== true
  ) {
    return familyContract
  }

  const familyByOperation =
    new Map(
      familyContract.operations.map(
        (row) => [
          row.operation_id,
          row,
        ],
      ),
    )

  const holeProperties = {}
  const planRows = []

  for (const row of active.rows) {
    const hole =
      `h${row.operation_index}`

    if (!HOLE_ID_RE.test(hole)) {
      return fail(
        "model_view_hole_identity_invalid",
      )
    }

    const family =
      familyByOperation.get(
        row.operation_id,
      )

    if (!family) {
      return fail(
        "model_view_file_family_drift",
        {
          operation_id:
            row.operation_id,
        },
      )
    }

    let codecField = null
    let codecSchema = null

    if (
      row.kind ===
        "python_declaration"
    ) {
      if (
        family.representation !==
          "python_units"
      ) {
        return fail(
          "model_view_python_family_drift",
          {
            operation_id:
              row.operation_id,
            representation:
              family.representation ??
              null,
          },
        )
      }

      codecField =
        "python_declarations"
      codecSchema =
        pythonCodecSchema(
          row.source_schema,
        )
    } else {
      codecField =
        family.representation

      codecSchema =
        textCodecSchema({
          sourceSchema:
            row.source_schema,
          representation:
            codecField,
        })
    }

    if (
      typeof codecField !==
        "string" ||
      !codecSchema
    ) {
      return fail(
        "model_view_codec_unavailable",
        {
          operation_id:
            row.operation_id,
          representation:
            family.representation ??
            null,
        },
      )
    }

    holeProperties[hole] =
      codecSchema

    planRows.push(
      Object.freeze({
        hole,
        source_key:
          row.source_key,
        operation_id:
          row.operation_id,
        operation_index:
          row.operation_index,
        kind:
          row.kind,
        slot:
          row.slot,
        family:
          family.family,
        representation:
          family.representation,
        codec_field:
          codecField,
        semantic_contract:
          deriveSemanticContract({
            row,
            family,
          }),
        max_bytes:
          row.max_bytes,
      }),
    )
  }

  const requiredHoles =
    planRows.map(
      (row) => row.hole,
    )

  const modelSchema =
    Object.freeze({
      type: "object",
      properties:
        Object.freeze({
          holes:
            Object.freeze({
              type: "object",
              properties:
                Object.freeze(
                  holeProperties,
                ),
              required:
                Object.freeze(
                  [...requiredHoles],
                ),
              additionalProperties:
                false,
            }),
        }),
      required:
        Object.freeze(["holes"]),
      additionalProperties: false,
    })

  const planPayload = {
    protocol:
      MODEL_VIEW_COMPILER_PROTOCOL,
    codec_protocol:
      MODEL_VIEW_CODEC_PROTOCOL,
    binding_sha256:
      typeof binding
        ?.binding_sha256 ===
        "string"
        ? binding.binding_sha256
        : null,
    source_spec_sha256:
      typeof binding
        ?.source_spec_sha256 ===
        "string"
        ? binding
            .source_spec_sha256
        : null,
    file_family_contract_sha256:
      familyContract
        .contract_sha256 ??
      null,
    required_holes:
      [...requiredHoles],
    rows:
      planRows.map(
        (row) => ({ ...row }),
      ),
    compiler_identity_fields_exposed:
      0,
    annotation_independent_semantics:
      true,
    final_model_abi_owner:
      MODEL_VIEW_COMPILER_PROTOCOL,
    generic_model_abi_projection_allowed:
      false,
    model_file_authority: false,
    model_slot_authority: false,
    model_operation_authority: false,
    mutation_authority: false,
  }

  const plan =
    Object.freeze({
      ...planPayload,
      plan_sha256:
        sha(planPayload),
    })

  const projectedTool =
    Object.freeze({
      ...tool,
      description:
        "Fill every opaque semantic hole exactly once. " +
        "The JSON property name inside each hole is the payload codec. " +
        "Compiler owns target files, slots, operation identity, preimages, " +
        "placement and create paths. Cross-hole references use resource://hN.",
      [slot.key]:
        modelSchema,
    })

  return Object.freeze({
    ok: true,
    protocol:
      MODEL_VIEW_COMPILER_PROTOCOL,
    reason:
      "model_view_compiled",
    tool:
      projectedTool,
    plan,
    model_schema_sha256:
      sha(modelSchema),
    model_schema_bytes:
      jsonBytes(modelSchema),
    canonical_schema_sha256:
      sha(canonicalSchema),
    compiler_identity_fields_exposed:
      0,
    annotation_independent_semantics:
      true,
    final_model_abi_owner:
      MODEL_VIEW_COMPILER_PROTOCOL,
    generic_model_abi_projection_allowed:
      false,
    frontier_codec_count:
      new Set(
        planRows.map(
          (row) =>
            row.representation,
        ),
      ).size,
    frontier_family_count:
      new Set(
        planRows.map(
          (row) =>
            row.family,
        ),
      ).size,
    derived_semantic_contract_count:
      planRows.length,
    semantic_contract_protocol:
      MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
    model_calls_added: 0,
    mutation_authority: false,
  })
}

function modelIdentitySet(plan) {
  const out = new Set()

  for (const row of plan.rows) {
    for (
      const value of [
        row.source_key,
        row.operation_id,
        row.slot,
      ]
    ) {
      if (
        typeof value === "string" &&
        value.length > 0
      ) {
        out.add(value)
      }
    }
  }

  return out
}

function rewriteModelResources({
  value,
  byHole,
  compilerIdentities,
} = {}) {
  if (typeof value === "string") {
    let failure = null

    const rewritten =
      value.replace(
        MODEL_RESOURCE_RE,
        (whole, token) => {
          const row =
            byHole.get(token)

          if (row) {
            return (
              "resource://" +
              row.source_key
            )
          }

          if (
            compilerIdentities
              .has(token) ||
            OPERATION_ID_RE
              .test(token)
          ) {
            failure =
              fail(
                "model_view_resource_identity_forbidden",
                {
                  resource:
                    token,
                },
              )
            return whole
          }

          failure =
            fail(
              "model_view_resource_unknown",
              {
                resource:
                  token,
              },
            )
          return whole
        },
      )

    return (
      failure ??
      Object.freeze({
        ok: true,
        value: rewritten,
        mutation_authority: false,
      })
    )
  }

  if (Array.isArray(value)) {
    const out = []

    for (const child of value) {
      const rewritten =
        rewriteModelResources({
          value: child,
          byHole,
          compilerIdentities,
        })

      if (
        rewritten.ok !== true
      ) {
        return rewritten
      }

      out.push(
        rewritten.value,
      )
    }

    return Object.freeze({
      ok: true,
      value: out,
      mutation_authority: false,
    })
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const out = {}

    for (
      const [key, child]
      of Object.entries(value)
    ) {
      const rewritten =
        rewriteModelResources({
          value: child,
          byHole,
          compilerIdentities,
        })

      if (
        rewritten.ok !== true
      ) {
        return rewritten
      }

      out[key] =
        rewritten.value
    }

    return Object.freeze({
      ok: true,
      value: out,
      mutation_authority: false,
    })
  }

  return Object.freeze({
    ok: true,
    value,
    mutation_authority: false,
  })
}

function pythonStatementHasCodeSignal(
  source,
) {
  const text =
    String(source ?? "").trim()

  if (!text) return false

  return (
    /^(?:return|raise|yield|await|assert|pass|break|continue|del|global|nonlocal)\b/u
      .test(text) ||
    /^(?:if|elif|else|for|while|with|try|except|finally|match|case)\b/u
      .test(text) ||
    /^(?:from|import)\s+/u
      .test(text) ||
    /^[A-Za-z_][A-Za-z0-9_.]*\s*(?:=|:=|\+=|-=|\*=|\/=|%=)/u
      .test(text) ||
    /^[A-Za-z_][A-Za-z0-9_.]*\s*\(/u
      .test(text) ||
    /^\s*@?[A-Za-z_][A-Za-z0-9_.]*\s*\(/u
      .test(text)
  )
}

function pythonModelPayloadLooksLikeProse(
  declarations,
) {
  if (
    !Array.isArray(declarations) ||
    declarations.length < 1
  ) {
    return false
  }

  let statementCount = 0
  let codeSignals = 0

  for (const unit of declarations) {
    const statements =
      Array.isArray(
        unit?.python_statements,
      )
        ? unit.python_statements
        : []

    for (const statement of statements) {
      if (
        typeof statement !==
          "string"
      ) {
        continue
      }

      statementCount += 1

      if (
        pythonStatementHasCodeSignal(
          statement,
        )
      ) {
        codeSignals += 1
      }
    }
  }

  return (
    statementCount > 0 &&
    codeSignals === 0
  )
}

function structuralTextPresent(
  representation,
  text,
) {
  if (
    !STRUCTURAL_TEXT_CODECS.has(
      representation,
    )
  ) {
    return true
  }

  const source =
    String(text ?? "")

  if (
    representation.startsWith(
      "markup_",
    )
  ) {
    return (
      /<\/?[A-Za-z][^>]*>/u
        .test(source) ||
      /\{\{[\s\S]*?\}\}/u
        .test(source) ||
      /\{%[\s\S]*?%\}/u
        .test(source)
    )
  }

  if (
    representation.startsWith(
      "xml_",
    )
  ) {
    return (
      /<\?xml\b/u.test(source) ||
      /<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\s[^>]*)?>/u
        .test(source)
    )
  }

  return true
}

export function validateSourceSlotModelViewPartialRequest({
  plan,
  request,
  expectedHole = null,
} = {}) {
  if (!validPlan(plan)) {
    return fail(
      "model_view_plan_invalid",
    )
  }

  if (
    !exactKeys(
      request,
      ["holes"],
    ) ||
    !request.holes ||
    typeof request.holes !==
      "object" ||
    Array.isArray(
      request.holes,
    )
  ) {
    return fail(
      "model_view_request_invalid",
    )
  }

  const holes =
    Object.keys(request.holes)

  if (holes.length !== 1) {
    return fail(
      "model_view_partial_hole_cardinality_invalid",
      {
        actual_holes:
          Object.freeze(
            [...holes].sort(),
          ),
      },
    )
  }

  const hole = holes[0]

  if (
    expectedHole != null &&
    hole !== expectedHole
  ) {
    return fail(
      "model_view_partial_hole_order_invalid",
      {
        expected_hole:
          expectedHole,
        actual_hole:
          hole,
      },
    )
  }

  const row =
    plan.rows.find(
      (candidate) =>
        candidate?.hole === hole,
    ) ?? null

  const payload =
    request.holes[hole]

  if (
    !row ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !exactKeys(
      payload,
      [row.codec_field],
    )
  ) {
    return fail(
      "model_view_codec_shape_invalid",
      {
        hole,
        codec_field:
          row?.codec_field ?? null,
      },
    )
  }

  const semanticViolations =
    inspectDerivedSemanticContracts({
      plan: {
        rows: [row],
        required_holes: [hole],
      },
      request,
    })

  if (
    semanticViolations.length > 0
  ) {
    return fail(
      "model_view_candidate_structural_contract_violation",
      {
        semantic_contract_protocol:
          MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
        structural_violation_count:
          semanticViolations.length,
        structural_violation_kinds:
          Object.freeze(
            semanticViolations.map(
              (candidate) =>
                candidate.kind,
            ),
          ),
        structural_violation_holes:
          Object.freeze([hole]),
        structural_violations:
          semanticViolations,
      },
    )
  }

  let canonicalValue = null

  if (
    row.representation ===
      "python_units"
  ) {
    const declarations =
      payload.python_declarations

    if (
      !Array.isArray(declarations) ||
      declarations.length < 1
    ) {
      return fail(
        "model_view_hole_payload_invalid",
        {
          hole,
          representation:
            row.representation,
        },
      )
    }

    if (
      pythonModelPayloadLooksLikeProse(
        declarations,
      )
    ) {
      return fail(
        "model_view_python_prose_payload",
        {
          hole,
          representation:
            row.representation,
        },
      )
    }

    canonicalValue = {
      units:
        decodePythonModelFields(
          declarations,
        ),
    }
  } else {
    const text =
      payload[row.codec_field]

    if (
      typeof text !== "string" ||
      text.length < 1
    ) {
      return fail(
        "model_view_hole_payload_invalid",
        {
          hole,
          representation:
            row.representation,
        },
      )
    }

    if (
      !structuralTextPresent(
        row.representation,
        text,
      )
    ) {
      return fail(
        "model_view_structural_text_missing",
        {
          hole,
          representation:
            row.representation,
        },
      )
    }

    canonicalValue = text
  }

  const rewritten =
    rewriteModelResources({
      value:
        canonicalValue,
      byHole:
        new Map(
          plan.rows.map(
            (candidate) => [
              candidate.hole,
              candidate,
            ],
          ),
        ),
      compilerIdentities:
        modelIdentitySet(plan),
    })

  if (rewritten.ok !== true) {
    return rewritten
  }

  return Object.freeze({
    ok: true,
    protocol:
      MODEL_VIEW_COMPILER_PROTOCOL,
    reason:
      "model_view_partial_hole_validated",
    hole,
    payload:
      cloneJson(payload),
    representation:
      row.representation,
    codec_field:
      row.codec_field,
    semantic_contract_protocol:
      MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
    mutation_authority: false,
  })
}

export function normalizeSourceSlotModelViewRequest({
  plan,
  request,
} = {}) {
  if (!validPlan(plan)) {
    return fail(
      "model_view_plan_invalid",
    )
  }

  if (
    !exactKeys(
      request,
      ["holes"],
    ) ||
    !request.holes ||
    typeof request.holes !==
      "object" ||
    Array.isArray(
      request.holes,
    )
  ) {
    return fail(
      "model_view_request_invalid",
    )
  }

  const expected =
    [...plan.required_holes]
      .sort()

  const actual =
    Object.keys(
      request.holes,
    ).sort()

  if (
    expected.length !==
      actual.length ||
    expected.some(
      (hole, index) =>
        hole !== actual[index],
    )
  ) {
    return fail(
      "model_view_hole_keys_invalid",
      {
        expected_holes:
          Object.freeze(
            expected,
          ),
        actual_holes:
          Object.freeze(
            actual,
          ),
      },
    )
  }

  const byHole =
    new Map(
      plan.rows.map(
        (row) => [
          row.hole,
          row,
        ],
      ),
    )

  const compilerIdentities =
    modelIdentitySet(plan)

  const semanticViolations =
    inspectDerivedSemanticContracts({
      plan,
      request,
    })

  if (
    semanticViolations.length > 0
  ) {
    return fail(
      "model_view_candidate_structural_contract_violation",
      {
        semantic_contract_protocol:
          MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
        structural_violation_count:
          semanticViolations.length,
        structural_violation_kinds:
          Object.freeze(
            semanticViolations.map(
              (row) => row.kind,
            ),
          ),
        structural_violation_holes:
          Object.freeze(
            semanticViolations.map(
              (row) => row.hole,
            ),
          ),
        structural_violations:
          semanticViolations,
      },
    )
  }

  const sources = {}

  for (
    const hole
    of plan.required_holes
  ) {
    const row =
      byHole.get(hole)
    const payload =
      request.holes[hole]

    if (
      !row ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !exactKeys(
        payload,
        [row.codec_field],
      )
    ) {
      return fail(
        "model_view_codec_shape_invalid",
        {
          hole,
          codec_field:
            row?.codec_field ??
            null,
        },
      )
    }

    let canonicalValue = null

    if (
      row.representation ===
        "python_units"
    ) {
      const declarations =
        payload
          .python_declarations

      if (
        !Array.isArray(
          declarations,
        ) ||
        declarations.length < 1
      ) {
        return fail(
          "model_view_hole_payload_invalid",
          {
            hole,
            representation:
              row.representation,
          },
        )
      }

      if (
        pythonModelPayloadLooksLikeProse(
          declarations,
        )
      ) {
        return fail(
          "model_view_python_prose_payload",
          {
            hole,
            representation:
              row.representation,
          },
        )
      }

      canonicalValue = {
        units:
          decodePythonModelFields(
            declarations,
          ),
      }
    } else {
      const text =
        payload[
          row.codec_field
        ]

      if (
        typeof text !== "string" ||
        text.length < 1
      ) {
        return fail(
          "model_view_hole_payload_invalid",
          {
            hole,
            representation:
              row.representation,
          },
        )
      }

      if (
        !structuralTextPresent(
          row.representation,
          text,
        )
      ) {
        return fail(
          "model_view_structural_text_missing",
          {
            hole,
            representation:
              row.representation,
          },
        )
      }

      canonicalValue = text
    }

    const rewritten =
      rewriteModelResources({
        value:
          canonicalValue,
        byHole,
        compilerIdentities,
      })

    if (
      rewritten.ok !== true
    ) {
      return rewritten
    }

    sources[
      row.source_key
    ] =
      cloneJson(
        rewritten.value,
      )
  }

  return Object.freeze({
    ok: true,
    protocol:
      MODEL_VIEW_COMPILER_PROTOCOL,
    reason:
      "model_view_lowered_to_canonical_source_slots",
    request:
      Object.freeze({
        sources:
          Object.freeze(
            sources,
          ),
      }),
    model_view_holes:
      plan.required_holes.length,
    compiler_joined: true,
    codec_validated: true,
    model_file_authority: false,
    model_slot_authority: false,
    model_operation_authority: false,
    mutation_authority: false,
  })
}

function projectControlString({
  text,
  plan,
} = {}) {
  const byOperation =
    new Map(
      plan.rows.map(
        (row) => [
          row.operation_id,
          row,
        ],
      ),
    )

  const seen =
    new Map(
      plan.rows.map(
        (row) => [
          row.operation_id,
          0,
        ],
      ),
    )

  let output =
    String(text ?? "")

  output =
    output.replace(
      /^REQUIRED=id=(op_[0-7])\s+obligation=[^\s]+\s+kind=[^\s]+\s+payload=content\s*$/gmu,
      (whole, operationId) => {
        const row =
          byOperation.get(
            operationId,
          )

        if (!row) {
          return whole
        }

        seen.set(
          operationId,
          (seen.get(operationId) ?? 0) +
            1,
        )

        return (
          `HOLE=${row.hole} ` +
          `codec=${row.representation} ` +
          `field=${row.codec_field} ` +
          "required=true " +
          semanticContractControlTokens(
            row.semantic_contract,
          )
        )
      },
    )

  output =
    output.replace(
      /^PYTHON_FUNCTION_SUITE=body_statements_only\s*$/gmu,
      "PYTHON_MODEL_BODY_FIELD=python_statements",
    )
  output =
    output.replace(
      /^PYTHON_FUNCTION_PARAMETERS=python_signature_source_only\s*$/gmu,
      "PYTHON_MODEL_SIGNATURE_FIELD=signature",
    )
  output =
    output.replace(
      /^PYTHON_FUNCTION_RETURNS=python_annotation_source_only\s*$/gmu,
      "PYTHON_MODEL_RETURN_FIELD=return_annotation",
    )
  output =
    output.replace(
      /^PYTHON_DECLARATION_WRAPPER_IN_SUITE=forbidden\s*$/gmu,
      "PYTHON_DECLARATION_WRAPPER_IN_PYTHON_STATEMENTS=forbidden",
    )

  if (
    output.includes(
      "ACTION=execute_additive_plan",
    ) &&
    !output.includes(
      `MODEL_VIEW protocol=${MODEL_VIEW_COMPILER_PROTOCOL}`,
    )
  ) {
    output =
      output.replace(
        "ACTION=execute_additive_plan",
        "ACTION=execute_additive_plan\n" +
          `MODEL_VIEW protocol=${MODEL_VIEW_COMPILER_PROTOCOL} ` +
          "namespace=holes annotation_independent=true " +
          "compiler_identity_fields_exposed=0",
      )
  }

  return Object.freeze({
    text: output,
    seen,
  })
}

function mapStrings(
  value,
  projector,
) {
  if (typeof value === "string") {
    return projector(value)
  }

  if (Array.isArray(value)) {
    return value.map(
      (child) =>
        mapStrings(
          child,
          projector,
        ),
    )
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const out = {}

    for (
      const [key, child]
      of Object.entries(value)
    ) {
      out[key] =
        mapStrings(
          child,
          projector,
        )
    }

    return out
  }

  return value
}

export function projectModelViewControlContext(
  compilation,
  plan,
) {
  if (
    !compilation ||
    typeof compilation !==
      "object"
  ) {
    return fail(
      "model_view_control_compilation_invalid",
    )
  }

  if (!validPlan(plan)) {
    return Object.freeze({
      ...compilation,
      model_view_protocol:
        MODEL_VIEW_COMPILER_PROTOCOL,
      model_view_applied: false,
      model_view_reason:
        "model_view_plan_not_active",
      model_view_control_namespace:
        null,
    })
  }

  const aggregate =
    new Map(
      plan.rows.map(
        (row) => [
          row.operation_id,
          0,
        ],
      ),
    )

  const projectedSystem =
    mapStrings(
      compilation.system,
      (text) => {
        const projected =
          projectControlString({
            text,
            plan,
          })

        for (
          const [operationId, count]
          of projected.seen.entries()
        ) {
          aggregate.set(
            operationId,
            (aggregate.get(
              operationId,
            ) ?? 0) + count,
          )
        }

        return projected.text
      },
    )

  const counts =
    [...aggregate.values()]

  if (
    counts.some(
      (count) => count !== 1,
    )
  ) {
    return Object.freeze({
      ...compilation,
      applied: false,
      control_context_applied:
        false,
      reason:
        "model_view_control_projection_failed",
      control_context_reason:
        "model_view_control_projection_failed",
      model_view_protocol:
        MODEL_VIEW_COMPILER_PROTOCOL,
      model_view_applied: false,
      model_view_reason:
        "model_view_required_operation_cardinality_invalid",
      model_view_control_namespace:
        "hole_only",
      mutation_authority: false,
    })
  }

  return Object.freeze({
    ...compilation,
    system:
      projectedSystem,
    model_view_protocol:
      MODEL_VIEW_COMPILER_PROTOCOL,
    model_view_applied: true,
    model_view_reason:
      "model_view_control_projected",
    model_view_control_namespace:
      "hole_only",
    model_view_hole_count:
      plan.rows.length,
    model_view_required_holes:
      Object.freeze([
        ...plan.required_holes,
      ]),
    model_view_annotation_independent:
      true,
    model_view_semantic_contract_protocol:
      MODEL_VIEW_SEMANTIC_CONTRACT_PROTOCOL,
    model_view_derived_semantic_contracts:
      plan.rows.length,
    model_view_compiler_identity_fields_exposed:
      0,
    mutation_authority: false,
  })
}

export function modelViewOwnsFinalModelAbi(
  plan,
) {
  return (
    validPlan(plan) &&
    plan.final_model_abi_owner ===
      MODEL_VIEW_COMPILER_PROTOCOL &&
    plan
      .generic_model_abi_projection_allowed ===
      false
  )
}

export function classifyModelViewFailure(
  reason,
) {
  return classifyFailureReason(reason)
}

export function modelViewFailureIsNonRepairable(
  reason,
) {
  return (
    classifyFailureReason(reason)
      .repair_eligible === false
  )
}
