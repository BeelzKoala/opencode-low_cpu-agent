import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const fragment06 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/06.part.ts",
    import.meta.url,
  ),
  "utf8",
)

const fragment09 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)

const fragment01 = await readFile(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/01.part.ts",
    import.meta.url,
  ),
  "utf8",
)

assert.equal(
  fragment06.includes("obligationBoundRequest"),
  false,
  "stale obligationBoundRequest consumer must be absent from physical core",
)

const authorizationStart = fragment06.indexOf("const authorization =")
const authorizationEnd = fragment06.indexOf(
  "if (authorization.ok !== true)",
  authorizationStart,
)
assert.ok(authorizationStart >= 0)
assert.ok(authorizationEnd > authorizationStart)

const authorizationSpan = fragment06.slice(
  authorizationStart,
  authorizationEnd,
)
assert.equal(
  authorizationSpan.split("request: rawInput").length - 1,
  2,
  "additive authorization and repair hint must consume physical rawInput",
)
assert.equal(
  authorizationSpan.includes("request: input"),
  false,
  "orchestration-enriched input must not cross additive authorization boundary",
)

const physicalResultPos = fragment09.indexOf("const physicalResult =")
const tryPos = fragment09.lastIndexOf("try {", physicalResultPos)
const physicalCallPos = fragment09.indexOf(
  "executeCapabilityMutationCore(",
  physicalResultPos,
)
const catchPos = fragment09.indexOf("} catch (error) {", physicalCallPos)
const fatalPos = fragment09.indexOf("applyExecutionEvent(", catchPos)
const faultReasonPos = fragment09.indexOf('"tool_runtime_fault"', fatalPos)
const typedStopPos = fragment09.indexOf(
  "PATCH_STOP reason=tool_runtime_fault",
  catchPos,
)
const callbackEndPos = fragment09.indexOf(
  "\n        },\n      })",
  typedStopPos,
)

assert.ok(physicalResultPos >= 0)
assert.ok(tryPos >= 0 && tryPos < physicalResultPos)
assert.ok(physicalCallPos > physicalResultPos)
assert.ok(catchPos > physicalCallPos)
assert.ok(fatalPos > catchPos)
assert.ok(faultReasonPos > fatalPos)
assert.ok(typedStopPos > faultReasonPos)
assert.ok(callbackEndPos > typedStopPos)

const catchSpan = fragment09.slice(catchPos, callbackEndPos)
for (const required of [
  "applyExecutionEvent(",
  '"fatal"',
  '"tool_runtime_fault"',
  "failure_layer:",
  '"runtime_fault"',
  "compiler_run: false",
  "executor_run: false",
  "mutation_authority: false",
]) {
  assert.ok(catchSpan.includes(required), `runtime fault closure missing ${required}`)
}
assert.equal(catchSpan.includes("patch_retry"), false)
assert.equal(catchSpan.includes("source_counterexample"), false)

assert.ok(
  fragment01.includes('if (event === "fatal") return EXEC_STATE_SAFE_FAIL'),
  "fatal event must transition execution FSM to SAFE_FAIL",
)
assert.ok(fragment01.includes("return []"))

const generated = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)
assert.equal(generated.includes("obligationBoundRequest.request"), false)

console.log(
  "PASS R7-R6-C runtime fault closure " +
    "physical_request=rawInput " +
    "stale_obligation_bound_consumer=false " +
    "unexpected_additive_core_throw=typed_stop " +
    "fsm_event=fatal fsm_terminal=SAFE_FAIL " +
    "model_repair=false mutation_authority=false repo_specific=false",
)
