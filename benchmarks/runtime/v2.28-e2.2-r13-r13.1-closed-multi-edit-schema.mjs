import assert from "node:assert/strict"

import {
  ADDITIVE_MUTATION_ABI_PROTOCOL,
  ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
  bindAdditiveToolSchemaToCapability,
  materializeAdditiveMutationPlan,
  renderAdditiveMutationCapability,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"

function capability({
  existing = [
    {
      slot: "existing:0",
      file: "routes/example.py",
      sha256: "a".repeat(64),
      evidence_lines: [3, 80],
      roles: ["task_anchor_owner", "ui_host"],
      allowed_operations: ["replace_exact"],
    },
    {
      slot: "existing:1",
      file: "templates/snippets/menu.html",
      sha256: "b".repeat(64),
      evidence_lines: [20],
      roles: ["navigation_host"],
      allowed_operations: ["replace_exact"],
    },
  ],
  creates = [
    {
      slot: "create:0",
      root: "templates",
      source_file: "templates/example.html",
      source_sha256: "c".repeat(64),
      evidence_lines: [1],
      allowed_extensions: [".html"],
      max_depth: 2,
      allowed_operations: ["create_file"],
    },
  ],
} = {}) {
  return {
    protocol: ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
    ready: true,
    mutation_authority: true,
    operation: "additive_surface",
    capability_sha256: "d".repeat(64),
    authority_sha256: "e".repeat(64),
    existing_slots: existing,
    create_slots: creates,
  }
}

function staticToolSchema() {
  return {
    name: "execute_additive_plan",
    description: "closed additive tool",
    input: {
      type: "object",
      properties: {
        replacements: {
          type: "array",
          minItems: 0,
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              slot: { type: "string", minLength: 1, maxLength: 64 },
              before: { type: "string" },
              replacement: { type: "string" },
            },
            required: ["slot", "before", "replacement"],
            additionalProperties: false,
          },
        },
        creations: {
          type: "array",
          minItems: 0,
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              slot: { type: "string", minLength: 1, maxLength: 64 },
              relative_path: { type: "string" },
              content: { type: "string" },
            },
            required: ["slot", "relative_path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["replacements", "creations"],
      additionalProperties: false,
    },
  }
}

const cap = capability()

const plan = materializeAdditiveMutationPlan({
  capability: cap,
  request: {
    replacements: [
      {
        slot: "existing:0",
        before: "import os",
        replacement: "import os\nimport io",
      },
      {
        slot: "existing:0",
        before: "@bp.route('/old')",
        replacement: "@bp.route('/new')",
      },
      {
        slot: "existing:1",
        before: "<li>old</li>",
        replacement: "<li>old</li>\n<li>new</li>",
      },
    ],
    creations: [
      {
        slot: "create:0",
        relative_path: "templates/report.html",
        content: "<h1>report</h1>",
      },
    ],
  },
})
assert.equal(plan.ok, true)
assert.equal(plan.abi_protocol, ADDITIVE_MUTATION_ABI_PROTOCOL)
assert.equal(plan.operation_count, 4)
assert.equal(plan.replacement_count, 3)
assert.equal(plan.creation_count, 1)
assert.deepEqual(plan.changed_files, [
  "routes/example.py",
  "templates/report.html",
  "templates/snippets/menu.html",
])
assert.deepEqual(
  plan.mutations
    .filter((row) => row.kind === "replace_exact")
    .map((row) => row.file),
  [
    "routes/example.py",
    "routes/example.py",
    "templates/snippets/menu.html",
  ],
)
assert.equal(
  plan.mutations.find((row) => row.kind === "create_file")?.file,
  "templates/report.html",
)

const duplicatePreimage = materializeAdditiveMutationPlan({
  capability: cap,
  request: {
    replacements: [
      { slot: "existing:0", before: "same", replacement: "first" },
      { slot: "existing:0", before: "same", replacement: "second" },
    ],
    creations: [],
  },
})
assert.equal(duplicatePreimage.ok, false)
assert.equal(duplicatePreimage.reason, "additive_replace_preimage_reused")
assert.equal(duplicatePreimage.operation_index, 1)
assert.equal(duplicatePreimage.field, "before")
assert.equal(duplicatePreimage.repairable, true)

const inventedSlot = materializeAdditiveMutationPlan({
  capability: cap,
  request: {
    replacements: [
      { slot: "existing:2", before: "x", replacement: "y" },
    ],
    creations: [],
  },
})
assert.equal(inventedSlot.ok, false)
assert.equal(inventedSlot.reason, "additive_replace_slot_invalid")

for (const relativePath of [
  "/tmp/report.html",
  "../report.html",
  "nested\\report.html",
]) {
  const rejected = materializeAdditiveMutationPlan({
    capability: cap,
    request: {
      replacements: [],
      creations: [{ slot: "create:0", relative_path: relativePath, content: "x" }],
    },
  })
  assert.equal(rejected.ok, false, relativePath)
}

const exactRootOnly = materializeAdditiveMutationPlan({
  capability: cap,
  request: {
    replacements: [],
    creations: [{ slot: "create:0", relative_path: "templates", content: "x" }],
  },
})
assert.equal(exactRootOnly.ok, false)
assert.equal(exactRootOnly.reason, "additive_create_relative_path_restates_root")

const multiRootCap = capability({
  creates: [{
    slot: "create:0",
    root: "web/templates",
    source_file: "web/templates/example.html",
    source_sha256: "f".repeat(64),
    evidence_lines: [1],
    allowed_extensions: [".html"],
    max_depth: 2,
    allowed_operations: ["create_file"],
  }],
})

const exactFullRootPrefix = materializeAdditiveMutationPlan({
  capability: multiRootCap,
  request: {
    replacements: [],
    creations: [{
      slot: "create:0",
      relative_path: "web/templates/report.html",
      content: "x",
    }],
  },
})
assert.equal(exactFullRootPrefix.ok, true)
assert.equal(exactFullRootPrefix.mutations[0].file, "web/templates/report.html")

const basenameOnlyIsNotStripped = materializeAdditiveMutationPlan({
  capability: multiRootCap,
  request: {
    replacements: [],
    creations: [{
      slot: "create:0",
      relative_path: "templates/report.html",
      content: "x",
    }],
  },
})
assert.equal(basenameOnlyIsNotStripped.ok, true)
assert.equal(
  basenameOnlyIsNotStripped.mutations[0].file,
  "web/templates/templates/report.html",
)

const baseTool = staticToolSchema()
const binding = bindAdditiveToolSchemaToCapability(baseTool, cap)
assert.equal(binding.ok, true)
assert.deepEqual(binding.existing_slots, ["existing:0", "existing:1"])
assert.deepEqual(binding.create_slots, ["create:0"])
assert.deepEqual(
  binding.tool.input.properties.replacements.items.properties.slot.enum,
  ["existing:0", "existing:1"],
)
assert.deepEqual(
  binding.tool.input.properties.creations.items.properties.slot.enum,
  ["create:0"],
)
assert.equal(binding.tool.input.properties.replacements.maxItems, 5)
assert.equal(binding.tool.input.properties.creations.maxItems, 2)
assert.equal(
  baseTool.input.properties.replacements.items.properties.slot.enum,
  undefined,
)
assert.equal(
  baseTool.input.properties.creations.items.properties.slot.enum,
  undefined,
)
const schemaJson = JSON.stringify(binding.tool)
assert.equal(schemaJson.includes("routes/example.py"), false)
assert.equal(schemaJson.includes("templates/example.html"), false)
assert.equal(schemaJson.includes('"existing:2"'), false)

const creationOnly = capability({ existing: [] })
const creationOnlyBinding = bindAdditiveToolSchemaToCapability(
  staticToolSchema(),
  creationOnly,
)
assert.equal(creationOnlyBinding.ok, true)
assert.equal(
  creationOnlyBinding.tool.input.properties.replacements.maxItems,
  0,
)
assert.equal(
  creationOnlyBinding.tool.input.properties.replacements.items.properties.slot.enum,
  undefined,
)
assert.deepEqual(
  creationOnlyBinding.tool.input.properties.creations.items.properties.slot.enum,
  ["create:0"],
)

const rendered = renderAdditiveMutationCapability(cap)
assert.match(rendered, /reuse=allowed_distinct_preimages/u)
assert.match(rendered, /roles=task_anchor_owner,ui_host/u)
assert.match(rendered, /sealed_root_prefix=canonicalized/u)

console.log(
  "PASS E2.2-R13/R13.1 closed multi-edit slots + capability-bound schema + safe create-root canonicalization",
)
