import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  validateAdditiveMutationRequest,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v3.mjs"

const physical = {
  python_imports: [],
  python_declarations: [
    {
      slot: "existing:0",
      content: "def feature():\\n    return 1\\n",
    },
  ],
  replacements: [],
  creations: [],
}

const physicalShape =
  validateAdditiveMutationRequest(physical)

assert.equal(
  physicalShape.ok,
  true,
  JSON.stringify(physicalShape),
)

const polluted = {
  ...physical,
  kind: "additive_surface",
}

const pollutedShape =
  validateAdditiveMutationRequest(polluted)

assert.equal(pollutedShape.ok, false)
assert.equal(
  pollutedShape.reason,
  "additive_request_shape_invalid",
)

const fragment06 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/06.part.ts",
    import.meta.url,
  ),
  "utf8",
)

const additiveBranchPos =
  fragment06.indexOf(
    'forcedKind === "additive_surface"',
  )

const rawValidationPos =
  fragment06.indexOf(
    "validateAdditiveMutationRequest(rawInput)",
    additiveBranchPos,
  )

const genericValidationPos =
  fragment06.indexOf(
    "validateMutationShape(input)",
    additiveBranchPos,
  )

assert.ok(
  additiveBranchPos >= 0,
  "physical additive branch missing",
)

assert.ok(
  rawValidationPos > additiveBranchPos,
  "physical additive validator must consume rawInput after additive branch",
)

assert.ok(
  genericValidationPos > rawValidationPos,
  "generic validator must remain after additive rawInput validator",
)

const countExact = (text, needle) =>
  text.split(needle).length - 1

assert.equal(
  countExact(
    fragment06,
    "validateAdditiveMutationRequest(rawInput)",
  ),
  1,
  "physical additive validator must consume rawInput exactly once",
)

assert.equal(
  countExact(
    fragment06,
    "validateAdditiveMutationRequest(input)",
  ),
  0,
  "orchestration-enriched input must never reach physical additive validator",
)

for (const required of [
  "const contractDetail =",
  "shape?.detail",
  "shape?.reason",
  "const contractSignature =",
  "contract_reason:",
  "contract_detail:",
  "contract_signature:",
]) {
  assert.ok(
    fragment06.includes(required),
    `fragment06 missing truthful contract telemetry ${required}`,
  )
}

const assertFieldValueOrder = (
  block,
  field,
  value,
) => {
  const fieldPos = block.indexOf(field)
  const valuePos = block.indexOf(
    value,
    fieldPos + field.length,
  )

  assert.ok(
    fieldPos >= 0,
    `missing field ${field}`,
  )
  assert.ok(
    valuePos > fieldPos,
    `missing value ${value} after ${field}`,
  )
}

const traceAnchor =
  fragment06.indexOf(
    'reason: "tool_contract_violation"',
  )
const traceBlockStart =
  fragment06.lastIndexOf(
    "await trace({",
    traceAnchor,
  )
const traceBlockEnd =
  fragment06.indexOf(
    "})",
    traceBlockStart,
  )

assert.ok(traceAnchor >= 0)
assert.ok(traceBlockStart >= 0)
assert.ok(traceBlockEnd > traceBlockStart)

const traceBlock =
  fragment06.slice(
    traceBlockStart,
    traceBlockEnd + 2,
  )

assertFieldValueOrder(
  traceBlock,
  "contract_detail:",
  "contractDetail",
)
assertFieldValueOrder(
  traceBlock,
  "contract_signature:",
  "contractSignature",
)

const returnBlockStart =
  fragment06.indexOf(
    "return {",
    traceBlockEnd,
  )
const returnBlockEnd =
  fragment06.indexOf(
    "\n        }\n",
    returnBlockStart,
  )

assert.ok(returnBlockStart > traceBlockEnd)
assert.ok(returnBlockEnd > returnBlockStart)

const returnBlock =
  fragment06.slice(
    returnBlockStart,
    returnBlockEnd,
  )

assertFieldValueOrder(
  returnBlock,
  "detail:",
  "contractDetail",
)
assertFieldValueOrder(
  returnBlock,
  "contract_signature:",
  "contractSignature",
)

const shapePos =
  fragment06.indexOf(
    'const shape = forbiddenRawAuthorityField',
  )
const detailPos =
  fragment06.indexOf(
    "const contractDetail =",
    shapePos,
  )
const failurePos =
  fragment06.indexOf(
    "if (shape.ok !== true)",
    shapePos,
  )

assert.ok(shapePos >= 0)
assert.ok(detailPos > shapePos)
assert.ok(failurePos > detailPos)

const fragment09 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)

const physicalResultAnchor =
  fragment09.indexOf(
    "const physicalResult =",
  )

const physicalCallPos =
  fragment09.indexOf(
    "executeCapabilityMutationCore(",
    physicalResultAnchor,
  )

const materializedRequestPos =
  fragment09.indexOf(
    "materialized.request",
    physicalCallPos,
  )

const toolContextPos =
  fragment09.indexOf(
    "toolContext",
    materializedRequestPos,
  )

const additiveKindPos =
  fragment09.indexOf(
    '"additive_surface"',
    toolContextPos,
  )

const additiveToolPos =
  fragment09.indexOf(
    "EXECUTE_ADDITIVE_PLAN_TOOL",
    additiveKindPos,
  )

const physicalCallClosePos =
  fragment09.indexOf(
    ")",
    additiveToolPos,
  )

assert.ok(
  physicalResultAnchor >= 0,
  "semantic materializer physical result anchor missing",
)

assert.ok(
  physicalCallPos > physicalResultAnchor,
  "semantic materializer common-core call missing",
)

assert.ok(
  materializedRequestPos > physicalCallPos,
  "materialized physical request must be first common-core payload",
)

assert.ok(
  toolContextPos > materializedRequestPos,
  "tool context must follow materialized physical request",
)

assert.ok(
  additiveKindPos > toolContextPos,
  "additive kind must follow tool context",
)

assert.ok(
  additiveToolPos > additiveKindPos,
  "additive tool identity must follow additive kind",
)

assert.ok(
  physicalCallClosePos > additiveToolPos,
  "semantic materializer common-core call must close after tool identity",
)

assert.ok(
  physicalCallClosePos - physicalCallPos < 512,
  "semantic materializer common-core call exceeded bounded structural span",
)

const physicalCallSpan =
  fragment09.slice(
    physicalCallPos,
    physicalCallClosePos + 1,
  )

assert.equal(
  physicalCallSpan.includes("input,"),
  false,
  "semantic materializer must not pass model/frontend input into physical core",
)

assert.equal(
  physicalCallSpan.includes("sources"),
  false,
  "source-slot frontend representation must not cross physical ABI boundary",
)

console.log(
  "PASS R7-R6-B physical additive ABI closure " +
    "model_frontend=source_slot_unchanged " +
    "semantic_materializer=unchanged " +
    "physical_additive_validator=raw_input_exact " +
    "orchestration_kind=not_physical_payload " +
    "gate=bounded_structural_source_invariants " +
    "contract_detail=reason_fallback " +
    "contract_signature=deterministic_fallback " +
    "mutation_authority=false repo_specific=false",
)
