import assert from "node:assert/strict"
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
  REPAIR_WITNESS_CLOSURE_PROTOCOL,
  compileRepairWitnessClosure,
  inspectPythonDependencyEvidence,
} from "../../opencode/plugins/cpu-search-core/repair-witness-closure-v1.mjs"

const tool = {
  description: "Submit bounded source values.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      sources: {
        type: "object",
        additionalProperties: false,
        properties: {
          server_surface: {
            type: "string",
            minLength: 1,
            maxLength: 6144,
            description: "Normal Python module fragment.",
          },
        },
        required: ["server_surface"],
      },
    },
    required: ["sources"],
  },
}

const binding = {
  all_source_rows: [
    {
      source_key: "server_surface",
      kind: "python_declaration",
      slot: "existing:0",
      max_bytes: 6144,
      allow_module_imports: true,
    },
  ],
}

const repairCache = {
  failed_source_keys: ["server_surface"],
  failed_slots: ["existing:0"],
  accepted_sources: {
    navigation_integration: "<a>preserved</a>",
    ui_surface: "<div>preserved</div>",
  },
}

const repairLock = {
  ...repairCache,
  failure_reason: "semantic_python_binding_unresolved",
  typed_counterexample: {
    protocol: "typed-counterexample-v1",
    reason: "semantic_python_binding_unresolved",
    layer: "binding",
    source_key: "server_surface",
    unresolved_symbol: "xlsxwriter",
    diagnostic: {},
    mutation_authority: false,
  },
}

const dependencyEvidence = {
  ok: true,
  protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
  declared_distributions: ["openpyxl", "pandas"],
  declared_modules: ["openpyxl", "pandas"],
  manifest_files: ["requirements.txt"],
  absence_authority: false,
  mutation_authority: false,
  model_import_authority: false,
}

const originalTool = JSON.stringify(tool)

const repair = compileRepairWitnessClosure({
  tool,
  binding,
  repairCache,
  repairLock,
  dependencyEvidence,
})

assert.equal(repair.ok, true)
assert.equal(repair.protocol, REPAIR_WITNESS_CLOSURE_PROTOCOL)
assert.equal(repair.repair_active, true)
assert.equal(repair.unresolved_symbol, "xlsxwriter")
assert.equal(repair.authority_expansion, false)
assert.equal(JSON.stringify(tool), originalTool)

const description =
  repair.tool.input.properties.sources.properties.server_surface.description

assert.match(description, /SOURCE_REPRESENTATION=python_module_delta/)
assert.match(
  description,
  /allowed_top_level=Import\|ImportFrom\|FunctionDef\|AsyncFunctionDef/,
)
assert.match(description, /module_imports=prefix_only/)
assert.match(description, /executable_top_level=forbidden/)
assert.match(description, /existing_module_replay=forbidden/)
assert.match(description, /output=new_declarations_only/)
assert.match(description, /repair_mode=replace_failed_delta_only/)
assert.match(description, /SIBLING_SOURCES=preserved_byte_identical/)
assert.match(description, /reason=semantic_python_binding_unresolved/)
assert.match(description, /layer=binding/)
assert.match(description, /unresolved_symbol=xlsxwriter/)
assert.match(
  description,
  /reuse_unresolved_symbol=forbidden_without_new_source_evidence/,
)
assert.match(description, /declared_distributions=openpyxl,pandas/)
assert.match(description, /declared_python_modules=openpyxl,pandas/)
assert.match(description, /absence_claims=forbidden/)
assert.doesNotMatch(description, /xlsxwriter.*absent/i)

const initial = compileRepairWitnessClosure({
  tool,
  binding,
  dependencyEvidence,
})
assert.equal(initial.ok, true)
assert.equal(initial.repair_active, false)
assert.match(
  initial.tool.input.properties.sources.properties.server_surface.description,
  /repair_mode=initial_delta/,
)

const unavailableDependency = compileRepairWitnessClosure({
  tool,
  binding,
  repairCache,
  repairLock,
  dependencyEvidence: {
    ok: false,
    protocol: PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
    absence_authority: false,
    mutation_authority: false,
    model_import_authority: false,
  },
})
assert.equal(unavailableDependency.ok, true)
assert.match(
  unavailableDependency.tool.input.properties.sources.properties.server_surface.description,
  /DEPENDENCY_EVIDENCE=unavailable/,
)
assert.match(
  unavailableDependency.tool.input.properties.sources.properties.server_surface.description,
  /invent_external_dependency=forbidden/,
)

const widenedTool = structuredClone(tool)
widenedTool.input.properties.sources.properties.ui_surface = {
  type: "string",
  description: "unexpected sibling",
}
widenedTool.input.properties.sources.required = [
  "server_surface",
  "ui_surface",
]
const widenedBinding = {
  all_source_rows: [
    ...binding.all_source_rows,
    {
      source_key: "ui_surface",
      kind: "creation",
      slot: "create:0",
      max_bytes: 8192,
    },
  ],
}
const widened = compileRepairWitnessClosure({
  tool: widenedTool,
  binding: widenedBinding,
  repairCache,
  repairLock,
  dependencyEvidence,
})
assert.equal(widened.ok, false)
assert.equal(widened.reason, "repair_witness_frontier_widened")

const replacementTool = {
  description: "replacement",
  input: {
    type: "object",
    properties: {
      sources: {
        type: "object",
        properties: {
          navigation_integration: {
            type: "string",
            description: "replacement",
          },
        },
        required: ["navigation_integration"],
      },
    },
  },
}
const replacement = compileRepairWitnessClosure({
  tool: replacementTool,
  binding: {
    all_source_rows: [
      {
        source_key: "navigation_integration",
        kind: "replacement",
        slot: "existing:1",
      },
    ],
  },
})
assert.equal(replacement.ok, true)
assert.match(
  replacement.tool.input.properties.sources.properties.navigation_integration.description,
  /SOURCE_REPRESENTATION=exact_replacement_delta/,
)
assert.match(
  replacement.tool.input.properties.sources.properties.navigation_integration.description,
  /file_wrapper=forbidden/,
)

const root = await mkdtemp(path.join(os.tmpdir(), "koalik-r7-r14-"))
try {
  await writeFile(
    path.join(root, "requirements.txt"),
    [
      "alpha-package==1.0.0",
      "openpyxl==3.1.2",
      "",
    ].join("\n"),
  )
  await writeFile(
    path.join(root, "pyproject.toml"),
    [
      "[project]",
      'dependencies = ["beta-package>=2", "pandas==2.2.2"]',
      "",
    ].join("\n"),
  )

  const evidence = await inspectPythonDependencyEvidence(root)
  assert.equal(evidence.ok, true, JSON.stringify(evidence))
  assert.equal(
    evidence.protocol,
    PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
  )
  assert.equal(evidence.absence_authority, false)
  assert.equal(evidence.mutation_authority, false)
  assert.equal(evidence.model_import_authority, false)
  assert.ok(evidence.declared_distributions.includes("alpha-package"))
  assert.ok(evidence.declared_distributions.includes("beta-package"))
  assert.ok(evidence.declared_distributions.includes("openpyxl"))
  assert.ok(evidence.declared_distributions.includes("pandas"))
} finally {
  await rm(root, { recursive: true, force: true })
}

const part09 = await readFile(
  new URL("../../opencode/plugins/cpu-search.fragments/09.part.ts", import.meta.url),
  "utf8",
)
assert.match(part09, /compileRepairWitnessClosure\(\{/)
assert.match(part09, /inspectPythonDependencyEvidence\(root\)/)
assert.match(
  part09,
  /\?\s*repairWitnessBinding\.tool\s*:\s*semanticObligationBinding\.tool/,
)
assert.match(part09, /kind:\s*"repair_witness_closure"/)

console.log(
  "PASS R7-R14 repair witness closure " +
  "representation=derived dependency_evidence=source_backed " +
  "counterexample=projected sibling_widening=blocked model_calls_unchanged",
)
