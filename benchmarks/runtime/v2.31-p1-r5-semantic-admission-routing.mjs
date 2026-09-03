import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) =>
  readFileSync(path, "utf8")

const imports = read(
  "opencode/plugins/cpu-search.fragments/00.part.ts",
)

const outer = read(
  "opencode/plugins/cpu-search.fragments/06.part.ts",
)

const tool = read(
  "opencode/plugins/cpu-search.fragments/09.part.ts",
)

const entry = read(
  "opencode/plugins/cpu-search.ts",
)

const legacyCore = read(
  "opencode/plugins/cpu-search-core/" +
  "obligation-bound-synthesis-v1.mjs",
)

/*
 * Legacy lowering may remain available as a historical/focused
 * implementation, but it must not participate in production
 * additive execution anymore.
 */
assert.match(
  legacyCore,
  /export function materializeObligationBoundAdditiveRequest/u,
)

assert.doesNotMatch(
  imports,
  /materializeObligationBoundAdditiveRequest/u,
)

assert.doesNotMatch(
  outer,
  /materializeObligationBoundAdditiveRequest/u,
)

assert.doesNotMatch(
  entry,
  /materializeObligationBoundAdditiveRequest/u,
)

/*
 * Outer execution core:
 * rawInput is authority-injection evidence only;
 * input is already physical/materialized.
 */
assert.match(
  outer,
  /forbiddenRawAuthorityField/u,
)

assert.match(
  outer,
  /forcedKind === "additive_surface"[\s\S]*validateAdditiveMutationRequest\(input\)/u,
)

assert.doesNotMatch(
  outer,
  /materializeSemanticAdditiveRequest/u,
)

/*
 * Semantic validation/lowering occurs exactly at the
 * execute_additive_plan model→physical boundary.
 */
assert.match(
  tool,
  /validateSemanticObligationRequest\(\{/u,
)

assert.match(
  tool,
  /await materializeSemanticAdditiveRequest\(\{/u,
)

assert.match(
  tool,
  /executeCapabilityMutationCore\(\s*materialized\.request/u,
)

console.log(
  "PASS P1-R5 semantic admission routing " +
  "semantic_validation=tool_boundary " +
  "semantic_materialization=once " +
  "outer_physical_validation=true " +
  "legacy_runtime_lowering=false",
)
