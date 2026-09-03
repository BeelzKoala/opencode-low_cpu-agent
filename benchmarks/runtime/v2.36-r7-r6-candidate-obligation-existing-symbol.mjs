import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  CANDIDATE_OBLIGATION_LEDGER_PROTOCOL,
  deriveCandidateObligationLedger,
} from "../../opencode/plugins/cpu-search-core/candidate-obligation-ledger-v1.mjs"
import {
  deriveExistingSymbolSourceCounterexample,
  renderTypedCounterexampleForModel,
} from "../../opencode/plugins/cpu-search-core/typed-counterexample-v1.mjs"

const sha = (value) => createHash("sha256").update(String(value), "utf8").digest("hex")
const binding = { all_source_rows: [
  { operation_id:"op_0", operation_index:0, source_key:"server_surface", obligation:"server_surface", kind:"python_declaration", slot:"existing:0" },
  { operation_id:"op_1", operation_index:1, source_key:"navigation_integration", obligation:"navigation_integration", kind:"replacement", slot:"existing:1" },
  { operation_id:"op_2", operation_index:2, source_key:"ui_surface", obligation:"ui_surface", kind:"creation", slot:"create:0" },
] }

const currentLike = { contents: [
  { id:"op_0", content:{ kind:"python_units", units:[{ kind:"function", name:"bestsellers_task_page" }] } },
  { id:"op_1", content:{ kind:"text", text:"{{ url_for('bestsellers.bestsellers_report_export') }}" } },
  { id:"op_2", content:{ kind:"text", text:'{{ url_for("bestsellers.bestsellers_report_export") }}' } },
] }
const ledger = deriveCandidateObligationLedger({ request: currentLike, binding })
assert.equal(ledger.ok, true, JSON.stringify(ledger,null,2))
assert.equal(ledger.protocol, CANDIDATE_OBLIGATION_LEDGER_PROTOCOL)
assert.equal(ledger.authority, "observation_only")
assert.equal(ledger.mutation_authority, false)
assert.deepEqual(ledger.declared_symbols.map((r)=>r.symbol), ["bestsellers_task_page"])
assert.equal(ledger.consensus_references.length, 1)
assert.equal(ledger.consensus_references[0].reference_name, "bestsellers.bestsellers_report_export")
assert.equal(ledger.consensus_references[0].tail_symbol, "bestsellers_report_export")
assert.equal(ledger.consensus_references[0].candidate_bound, false)
assert.equal(ledger.candidate_unbound_consensus_count, 1)

const bound = structuredClone(currentLike)
bound.contents[0].content.units[0].name = "bestsellers_report_export"
const boundLedger = deriveCandidateObligationLedger({request:bound,binding})
assert.equal(boundLedger.consensus_references[0].candidate_bound,true)

const single = structuredClone(currentLike)
single.contents[2].content.text = "static"
assert.equal(deriveCandidateObligationLedger({request:single,binding}).consensus_references.length,0)

const dynamic = structuredClone(currentLike)
dynamic.contents[1].content.text = "{{ url_for(endpoint) }}"
dynamic.contents[2].content.text = "{{ url_for(other) }}"
assert.equal(deriveCandidateObligationLedger({request:dynamic,binding}).references.length,0)

const raw = {sources:{server_surface:"def bestsellers_task_page():\n    return 1\n"}}
const cache = {
  repairable:true,
  mutation_authority:false,
  cache_sha256:"a".repeat(64),
  failure_reason:"semantic_python_existing_symbol_forbidden",
  failed_source_keys:["server_surface"],
  failed_slots:["existing:0"],
}
const failure = {
  reason:"semantic_python_existing_symbol_forbidden",
  id:"op_0", operation_id:"op_0", operation_index:0,
  frontend_reason:"semantic_python_existing_symbol_forbidden",
  frontend:{reason:"semantic_python_existing_symbol_forbidden",symbols:["bestsellers_task_page"]},
}
const ce = deriveExistingSymbolSourceCounterexample({failure,request:raw,binding,repairCache:cache,candidateLedger:ledger})
assert.equal(ce.ok,true,JSON.stringify(ce,null,2))
assert.equal(ce.layer,"sym_collision")
assert.equal(ce.requirement,"fresh_symbol")
assert.equal(ce.diagnostic.collision_symbol,"bestsellers_task_page")
assert.equal(ce.diagnostic.consensus_symbol,"bestsellers_report_export")
assert.equal(ce.diagnostic.candidate_guidance_authority,"observation_only")
assert.equal(ce.candidate_source_sha256,sha(raw.sources.server_surface))
assert.equal(ce.mutation_authority,false)
const rendered = renderTypedCounterexampleForModel(ce)
assert.ok(Buffer.byteLength(rendered,"utf8")<=144,rendered)
assert.match(rendered,/exists=bestsellers_task_page/u)
assert.match(rendered,/auto_fix=false/u)

const multi = deriveExistingSymbolSourceCounterexample({
  failure:{...failure,frontend:{...failure.frontend,symbols:["a","b"]}},
  request:raw,binding,repairCache:cache,candidateLedger:ledger,
})
assert.equal(multi.ok,false)
assert.equal(multi.reason,"typed_counterexample_symbol_collision_witness_invalid")

const fragment09 = await readFile(new URL("../../opencode/plugins/cpu-search.fragments/09.part.ts",import.meta.url),"utf8")
const ledgerPos = fragment09.indexOf("const candidateObligationLedger =")
const materialPos = fragment09.indexOf("const materialized =",ledgerPos)
const symbolPos = fragment09.indexOf("// R7-R6: existing-symbol collision")
const routePos = fragment09.indexOf("// R7-R4-H: an exact existing-route collision")
assert.ok(ledgerPos>=0 && materialPos>ledgerPos && symbolPos>materialPos && routePos>symbolPos)
const span = fragment09.slice(symbolPos,routePos)
for (const token of ["deriveExistingSymbolSourceCounterexample","sourceSlotRepairAuthorityMatches","decideSourceCounterexampleRepairAdmission","prepareCounterexampleToolResult","candidateObligationLedger","candidate_guidance_authority","Transaction commit point"]) {
  assert.ok(span.includes(token),token)
}
assert.equal(span.includes("state.mutationAttempts +="),false)
const authStart=span.indexOf("const symbolCollisionRepairAuthorityOk")
const ceStart=span.indexOf("const symbolCollisionCounterexample")
assert.ok(authStart>=0 && ceStart>authStart)
assert.equal(span.slice(authStart,ceStart).includes("candidateObligationLedger"),false)

console.log("PASS R7-R6 candidate obligation witness + existing-symbol closure candidate_ledger=observation_only existing_symbol=hard_frontend_witness single_collision=repairable multi_collision=terminal transactional_result=true auto_fix=false mutation_authority=false")
