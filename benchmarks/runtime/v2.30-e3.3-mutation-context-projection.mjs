#!/usr/bin/env node
import assert from "node:assert/strict"
import {
  MUTATION_CONTEXT_PROJECTION_PROTOCOL,
  projectObligationBoundMutationContext,
} from "../../opencode/plugins/cpu-search-core/obligation-bound-synthesis-v1.mjs"

const capabilityText = [
  "ADDITIVE_CAPABILITY protocol=scout-additive-capability-v1 sha256=" + "a".repeat(64),
  "MUTATION_ABI protocol=closed-additive-mutation-abi-v3 python_imports=[] python_declarations=[] replacements=[] creations=[]",
  "Use execute_additive_plan only. For Python existing slots, describe WHAT only: python_imports and python_declarations. Never submit Python before/preimage, line numbers, offsets, site ids, or repository paths. Non-Python existing slots keep exact replacements.",
  "slot=existing:0 ops=add_imports,add_module_declaration reuse=allowed_distinct_preimages file=server/feature.py roles=data_access_capability,task_anchor_owner physical_selector=model_forbidden preimage=model_forbidden evidence_lines_internal=3,40",
  "slot=existing:1 op=replace_exact reuse=allowed_distinct_preimages file=templates/menu.html roles=navigation_host evidence_lines=20",
  "slot=create:0 op=create_file relative_path_only=true sealed_root_prefix=canonicalized extensions=.html max_depth=2",
  "budgets operations<=8 files<=5 creates<=2",
  "REQUIRED_MUTATION_COVERAGE protocol=mutation-obligation-v1 server_surface@existing:0:python_declaration navigation_integration@existing:1:replacement ui_surface@create:0:creation python_imports=support_only all_required=true",
].join("\n")

const synthesisText = [
  "SYNTHESIS_TRANSACTION protocol=obligation-bound-synthesis-v1 sha256=" + "b".repeat(64) + " content_only=true all_required=true",
  "REQUIRED_OPERATION id=op_0 obligation=server_surface slot=existing:0 operation=python_declaration payload=content",
  "REQUIRED_OPERATION id=op_1 obligation=navigation_integration slot=existing:1 operation=replacement payload=before,replacement",
  "REQUIRED_OPERATION id=op_2 obligation=ui_surface slot=create:0 operation=creation payload=relative_path,content",
  "SUPPORT_IMPORTS slot=existing:0 optional=true support_only=true target=model_forbidden",
  "MUTATION_CONSTRAINTS no_new_dependencies=true parameterized_data_query=true preserve_existing_behavior=true",
  "MODEL_AUTHORITY content_only=true slot=false operation=false file=false scope=false",
].join("\n")

const contextText = [
  "SEALED_CONTEXT file=server/feature.py roles=data_access_capability,task_anchor_owner anchors=3,40 anchor_radius=8 sha256=" + "c".repeat(64) + " mutation_authority=false",
  "    1 | import os",
  "    2 | from database import connect",
  "    3 | bp = Blueprint('feature', __name__)",
  "    4 |",
  "    5 | VALUE = 1",
  "   20 | def unrelated():",
  "   21 |     return 1",
  "   38 |",
  "   39 | @bp.route('/existing')",
  "   40 | def existing():",
  "   41 |     return render_template('existing.html')",
  "   42 |",
  "",
  "SEALED_CONTEXT file=templates/menu.html roles=navigation_host anchors=20 anchor_radius=8 sha256=" + "d".repeat(64) + " mutation_authority=false",
  "   10 | <nav>",
  "   18 |   <ul>",
  "   19 |     <li>",
  "   20 |       <a href=\"{{ url_for('feature.existing') }}\">Existing</a>",
  "   21 |     </li>",
  "   22 |   </ul>",
  "   30 | </nav>",
].join("\n")

const projected = projectObligationBoundMutationContext({
  capabilityText,
  synthesisText,
  contextText,
})

assert.equal(projected.ok, true)
assert.equal(projected.protocol, MUTATION_CONTEXT_PROJECTION_PROTOCOL)
assert.equal(projected.reason, "projection_applied")
assert.equal(projected.mutation_authority, false)
assert.ok(projected.projected_bytes < projected.source_bytes)
assert.ok(projected.reduction_bytes > 0)
assert.equal(projected.anchor_radius, 2)

for (const required of [
  "REQUIRED_MUTATION_COVERAGE",
  "REQUIRED_OPERATION id=op_0",
  "REQUIRED_OPERATION id=op_1",
  "REQUIRED_OPERATION id=op_2",
  "MUTATION_CONSTRAINTS",
  "MODEL_AUTHORITY content_only=true",
  "slot=existing:0",
  "slot=existing:1",
  "slot=create:0",
  "SEALED_CONTEXT file=server/feature.py",
  "SEALED_CONTEXT file=templates/menu.html",
  "   40 | def existing():",
  "   20 |       <a href=",
]) {
  assert.ok(projected.content.includes(required), `missing ${required}`)
}

assert.ok(!projected.content.includes("Never submit Python before/preimage"))
assert.ok(!projected.content.includes("   20 | def unrelated():"))
assert.ok(!projected.content.includes("   10 | <nav>"))

const repeated = projectObligationBoundMutationContext({
  capabilityText,
  synthesisText,
  contextText,
})
assert.equal(repeated.projection_sha256, projected.projection_sha256)
assert.equal(repeated.content, projected.content)

const incomplete = projectObligationBoundMutationContext({
  capabilityText: "ADDITIVE_CAPABILITY protocol=x",
  synthesisText,
  contextText,
})
assert.equal(incomplete.ok, false)
assert.equal(incomplete.reason, "projection_contract_incomplete")

console.log(
  "PASS E3.3 mutation context projection: authority preserved, anchor-local " +
  `projection ${projected.source_bytes}->${projected.projected_bytes} bytes`,
)
