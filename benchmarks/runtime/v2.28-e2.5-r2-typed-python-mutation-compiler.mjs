import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  CANDIDATE_STATIC_PREFLIGHT_PROTOCOL,
  PYTHON_ADDITIVE_COMPILER_PROTOCOL,
  compilePythonAdditiveEdits,
} from "../../opencode/plugins/cpu-search-core/python-additive-compiler-v1.mjs"

import {
  ADDITIVE_MUTATION_ABI_PROTOCOL,
  bindAdditiveToolSchemaToCapability,
  materializeAdditiveMutationPlan,
  renderAdditiveMutationCapability,
  validateAdditiveMutationRequest,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v3.mjs"

function sha(value) {
  return createHash("sha256").update(value).digest("hex")
}

const root = await mkdtemp(path.join(os.tmpdir(), "e25-r2-"))
try {
  await mkdir(path.join(root, "routes"), { recursive: true })
  const source = [
    "from flask import Blueprint\n",
    "import json\n",
    "\n",
    '@bp.route("/export")\n',
    "def export():\n",
    '    return "x"\n',
  ].join("")
  const file = path.join(root, "routes", "x.py")
  await writeFile(file, source, "utf8")

  const target = {
    slot: "existing:0",
    file: "routes/x.py",
    sha256: sha(Buffer.from(source, "utf8")),
    evidence_lines: [2, 4],
    roles: ["task_anchor_owner"],
  }

  const compiled = await compilePythonAdditiveEdits({
    root,
    target,
    modules: ["io"],
    fromImports: [{ module: "datetime", name: "datetime" }],
    declarations: [
      '        @bp.route("/new")\n' +
      "        def new_page():\n" +
      '            return "new"',
    ],
    maxReplacementBytes: 12 * 1024,
    resolveSite: async ({ evidenceLine, content }) => {
      if (evidenceLine === 2) {
        return {
          ok: true,
          operation: "insert_after",
          before: "import json",
          replacement: `import json\n${content}`,
          site_sha256: "1".repeat(64),
        }
      }
      if (evidenceLine === 4) {
        const before =
          '@bp.route("/export")\n' +
          "def export():\n" +
          '    return "x"'
        return {
          ok: true,
          operation: "insert_before",
          before,
          replacement: `${content}${before}`,
          site_sha256: "2".repeat(64),
        }
      }
      return { ok: false, reason: "projection_absent" }
    },
  })

  assert.equal(compiled.ok, true)
  assert.equal(compiled.protocol, PYTHON_ADDITIVE_COMPILER_PROTOCOL)
  assert.equal(compiled.edits.length, 2)
  assert.equal(
    compiled.candidate_receipt.protocol,
    CANDIDATE_STATIC_PREFLIGHT_PROTOCOL,
  )
  assert.equal(compiled.candidate_receipt.checks.ast_syntax, "passed")
  assert.equal(
    compiled.candidate_receipt.compiler_protocol,
    "typed-python-additive-compiler-v1",
  )
  assert.equal(
    compiled.candidate_receipt.stage,
    "compiler_virtual_candidate",
  )
  assert.match(compiled.compiled_edits_sha256, /^[0-9a-f]{64}$/u)
  assert.equal(
    compiled.candidate_receipt.compiled_edits_sha256,
    compiled.compiled_edits_sha256,
  )
  assert.match(
    compiled.candidate_receipt.receipt_sha256,
    /^[0-9a-f]{64}$/u,
  )
  assert.equal(compiled.candidate_receipt.parent_receipt_sha256, null)
  assert.equal(compiled.candidate_receipt.checks.format, "not_run")
  assert.equal(compiled.candidate_receipt.checks.lint, "not_run")
  assert.equal(compiled.candidate_receipt.checks.type_check, "not_run")
  assert.equal(compiled.candidate_receipt.checks.complexity, "not_run")
  assert.match(compiled.edits[0].replacement, /import io/u)
  assert.match(
    compiled.edits[0].replacement,
    /from datetime import datetime/u,
  )
  assert.match(compiled.edits[1].replacement, /^@bp\.route\("\/new"\)/u)

  const badDeclaration = await compilePythonAdditiveEdits({
    root,
    target,
    declarations: ["import io\n\ndef bad():\n    pass"],
    maxReplacementBytes: 12 * 1024,
    resolveSite: async () => {
      throw new Error("must fail before site resolver")
    },
  })
  assert.equal(badDeclaration.ok, false)
  assert.equal(
    badDeclaration.reason,
    "python_declaration_statement_kind_invalid",
  )

  const ambiguous = await compilePythonAdditiveEdits({
    root,
    target,
    declarations: ["def added():\n    return 1"],
    maxReplacementBytes: 12 * 1024,
    resolveSite: async ({ evidenceLine, content }) => {
      const before =
        evidenceLine === 2
          ? "import json"
          : '@bp.route("/export")'
      return {
        ok: true,
        operation: "insert_before",
        before,
        replacement: `${content}${before}`,
        site_sha256: String(evidenceLine).repeat(64).slice(0, 64),
      }
    },
  })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.reason, "python_declaration_site_ambiguous")
} finally {
  await rm(root, { recursive: true, force: true })
}

assert.equal(
  ADDITIVE_MUTATION_ABI_PROTOCOL,
  "closed-additive-mutation-abi-v3",
)

const request = {
  python_imports: [{
    slot: "existing:0",
    modules: ["io"],
    from_imports: [{ module: "datetime", name: "datetime" }],
  }],
  python_declarations: [{
    slot: "existing:0",
    content: "def added():\n    return 1",
  }],
  replacements: [],
  creations: [],
}
assert.equal(validateAdditiveMutationRequest(request).ok, true)

const leakedSelector = {
  python_imports: [{
    slot: "existing:0",
    modules: [],
    from_imports: [],
    evidence_line: 1,
  }],
  python_declarations: [],
  replacements: [],
  creations: [],
}
assert.equal(validateAdditiveMutationRequest(leakedSelector).ok, false)

const capability = {
  protocol: "scout-additive-capability-v1",
  ready: true,
  mutation_authority: true,
  operation: "additive_surface",
  capability_sha256: "a".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/x.py",
      sha256: "b".repeat(64),
      evidence_lines: [2, 4],
      roles: ["task_anchor_owner"],
    },
    {
      slot: "existing:1",
      file: "templates/menu.html",
      sha256: "c".repeat(64),
      evidence_lines: [1],
      roles: ["navigation_host"],
    },
  ],
  create_slots: [],
}

const materialized = await materializeAdditiveMutationPlan({
  root: "/unused",
  capability,
  request,
  compilePython: async () => ({
    ok: true,
    edits: [{
      before: "old",
      replacement: "new",
    }],
    candidate_receipt: {
      protocol: CANDIDATE_STATIC_PREFLIGHT_PROTOCOL,
      file: "routes/x.py",
      base_sha256: "b".repeat(64),
      candidate_sha256: "d".repeat(64),
      checks: {
        ast_syntax: "passed",
        format: "not_run",
        lint: "not_run",
        type_check: "not_run",
        complexity: "not_run",
      },
      mutation_authority: false,
    },
  }),
})
assert.equal(materialized.ok, true)
assert.equal(materialized.abi_protocol, "closed-additive-mutation-abi-v3")
assert.equal(
  materialized.compiler_protocol,
  "typed-python-additive-compiler-v1",
)
assert.equal(materialized.python_compiled_files, 1)
assert.equal(materialized.mutations.length, 1)
assert.equal(materialized.mutations[0].kind, "replace_exact")

const tool = {
  description: "typed",
  input: {
    type: "object",
    properties: {
      python_imports: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            modules: { type: "array" },
            from_imports: { type: "array" },
          },
        },
      },
      python_declarations: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            content: { type: "string" },
          },
        },
      },
      replacements: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
          },
        },
      },
      creations: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
          },
        },
      },
    },
  },
}
const bound = bindAdditiveToolSchemaToCapability(tool, capability)
assert.equal(bound.ok, true)
assert.deepEqual(
  bound.tool.input.properties.python_imports.items.properties.slot.enum,
  ["existing:0"],
)
assert.deepEqual(
  bound.tool.input.properties.python_declarations.items.properties.slot.enum,
  ["existing:0"],
)
assert.deepEqual(
  bound.tool.input.properties.replacements.items.properties.slot.enum,
  ["existing:1"],
)

const rendered = renderAdditiveMutationCapability(capability)
assert.match(rendered, /closed-additive-mutation-abi-v3/u)
assert.match(rendered, /ops=add_imports,add_module_declaration/u)
assert.match(rendered, /physical_selector=model_forbidden/u)
assert.match(rendered, /preimage=model_forbidden/u)
assert.doesNotMatch(rendered, /evidence_line_required=true/u)

console.log(
  "PASS E2.5/R2 typed Python IR lowers through AST re-derivation and virtual syntax preflight",
)
