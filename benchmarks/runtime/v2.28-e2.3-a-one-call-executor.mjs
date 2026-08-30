#!/usr/bin/env node

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  DETERMINISTIC_SCOUT_ENTRY_PROTOCOL,
  appendDeterministicScoutContext,
  canAppendDeterministicScoutContext,
  compileDeterministicScoutRequest,
  taskTextFromModelMessages,
} from "../../opencode/plugins/cpu-search-core/deterministic-scout-entry-v1.mjs"

const ozonMessages = [{
  role: "user",
  content:
    "Use only bounded tools.\n\nTASK:\n" +
    "Add an XLSX report page. Keep /export unchanged. " +
    "Read BASDB.rd_bestsellers_data. Parameterize report_date. " +
    "For category require report_category3_filter IS NOT NULL and " +
    "for seller require report_seller_filter IS NOT NULL.",
}]

const plan = compileDeterministicScoutRequest({
  messages: ozonMessages,
  taskShape: { status: "compiled", shape: "additive" },
})

assert.equal(plan.protocol, DETERMINISTIC_SCOUT_ENTRY_PROTOCOL)
assert.equal(plan.applied, true)
assert.equal(plan.routing_authority, false)
assert.equal(plan.mutation_authority, false)
assert.ok(plan.input.queries.length >= 2)
assert.ok(plan.input.queries.length <= 4)
assert.ok(
  plan.input.queries.some((query) =>
    query.includes("rd_bestsellers_data"),
  ),
)
assert.ok(
  plan.input.queries.some((query) =>
    query.includes("report_date") ||
    query.includes("report_category3_filter") ||
    query.includes("report_seller_filter"),
  ),
)

const weak = compileDeterministicScoutRequest({
  messages: [{ role: "user", content: "TASK:\nAdd a button." }],
  taskShape: { status: "compiled", shape: "additive" },
})
assert.equal(weak.applied, false)
assert.equal(weak.reason, "high_signal_query_seed_insufficient")

const nonAdditive = compileDeterministicScoutRequest({
  messages: ozonMessages,
  taskShape: { status: "compiled", shape: "modify" },
})
assert.equal(nonAdditive.applied, false)
assert.equal(nonAdditive.reason, "task_shape_not_additive")

assert.match(taskTextFromModelMessages(ozonMessages), /rd_bestsellers_data/u)
assert.equal(canAppendDeterministicScoutContext("system"), true)
assert.equal(canAppendDeterministicScoutContext([]), true)
assert.equal(canAppendDeterministicScoutContext(null), false)

const event = { system: ["base"] }
assert.equal(
  appendDeterministicScoutContext(
    event,
    "NEXT_ACTION=execute_additive_plan",
  ),
  true,
)
assert.equal(event.system.length, 2)
assert.match(event.system[1], /routing_authority=false/u)
assert.match(event.system[1], /mutation_authority=false/u)

const plugin = await readFile(
  new URL("../../opencode/plugins/cpu-search.ts", import.meta.url),
  "utf8",
)

for (const marker of [
  "DETERMINISTIC_SCOUT_ENTRY_PROTOCOL",
  "compileDeterministicScoutRequest",
  "mergeDeterministicScoutContext",
  "const deterministicSearchExecutor = async (input, toolContext) => {",
  "execute: deterministicSearchExecutor",
  'kind: "deterministic_scout_preflight"',
  "state.modelCalls === 0",
  'state.taskShape?.shape === "additive"',
  'process.env.OPENCODE_CPU_ONE_CALL_EXECUTOR === "1"',
]) {
  assert.match(plugin, new RegExp(
    marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    "u",
  ))
}

const preflight = plugin.indexOf(
  "const deterministicScoutPlan = compileDeterministicScoutRequest(",
)
const frontier = plugin.indexOf(
  "const allowedTools = allowedToolsForState(state)",
)
const accounting = plugin.indexOf("state.modelCalls += 1")
assert.ok(preflight >= 0)
assert.ok(frontier > preflight)
assert.ok(accounting > preflight)

assert.doesNotMatch(
  plugin,
  /deterministic_scout.*mutation_authority=true/iu,
)

console.log("PASS deterministic Scout entry is routing-only")
console.log("PASS additive high-signal tasks may pre-scout without LLM")
console.log("PASS weak/unsupported tasks preserve legacy model-Scout fallback")
console.log("PASS deterministic preflight precedes first model-call accounting")
console.log("PASS v2.28-E2.3-A one-call Executor fastpath")
