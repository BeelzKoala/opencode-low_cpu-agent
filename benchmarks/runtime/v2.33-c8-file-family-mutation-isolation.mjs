import assert from "node:assert/strict"
import fs from "node:fs"

import {
  FILE_FAMILY_CONTRACT_PROTOCOL,
  buildFileFamilyRepairHint,
  deriveFileFamilyContract,
  fileFamilyRepairAuthorityMatches,
  renderFileFamilyContract,
  resolveFileFamily,
  validateOperationFileFamilyContent,
} from "../../opencode/plugins/cpu-search-core/file-family-contract-v1.mjs"

import {
  bindSemanticContentToolSchemaToCapability,
  deriveSemanticContentSpec,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"

const capability = {
  ready: true,
  mutation_authority: true,
  capability_sha256: "a".repeat(64),
  authority_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "src/server.py",
      allowed_operations: [
        "add_module_declaration",
        "replace_exact",
      ],
      roles: [
        "task_anchor_owner",
      ],
    },
    {
      slot: "existing:1",
      file: "templates/menu.html",
      allowed_operations: [
        "replace_exact",
      ],
      roles: [
        "navigation_host",
      ],
    },
  ],
  create_slots: [
    {
      slot: "create:0",
      root: "templates",
      allowed_extensions: [
        ".html",
      ],
      max_depth: 2,
      allowed_operations: [
        "create_file",
      ],
    },
  ],
}

const spec =
  deriveSemanticContentSpec({
    capability,
  })

assert.equal(
  spec.ok,
  true,
  JSON.stringify(spec),
)

const contract =
  deriveFileFamilyContract({
    operations: spec.operations,
    capability,
  })

assert.equal(
  contract.ok,
  true,
  JSON.stringify(contract),
)

assert.equal(
  contract.protocol,
  FILE_FAMILY_CONTRACT_PROTOCOL,
)

assert.deepEqual(
  contract.operations.map(
    (row) => [
      row.operation_id,
      row.family,
      row.representation,
    ],
  ),
  [
    [
      "op_0",
      "python",
      "python_units",
    ],
    [
      "op_1",
      "markup_template",
      "markup_fragment",
    ],
    [
      "op_2",
      "markup_template",
      "markup_document",
    ],
  ],
)

const html =
  resolveFileFamily({
    file: "page.j2",
    operationKind: "replacement",
  })

assert.equal(html.ok, true)
assert.equal(
  html.family,
  "markup_template",
)
assert.equal(
  html.representation,
  "markup_fragment",
)

const js =
  resolveFileFamily({
    file: "src/client.js",
    operationKind: "replacement",
  })

assert.equal(js.ok, true)

assert.equal(
  validateOperationFileFamilyContent({
    contract: js,
    text: "const answer = 42\n",
  }).ok,
  true,
)

const markupContract =
  contract.operations.find(
    (row) =>
      row.operation_id === "op_1",
  )

assert(markupContract)

for (const text of [
  '<li><a href="{{ value }}">Item</a></li>\n',
  "Reports\n",
]) {
  const valid =
    validateOperationFileFamilyContent({
      contract: markupContract,
      text,
    })

  assert.equal(
    valid.ok,
    true,
    JSON.stringify(valid),
  )
}

for (const text of [
  '@decorator("/example")\ndef handler():\n    return 1\n',
  "def handler():\n    return 1\n",
  'if __name__ == "__main__":\n    main()\n',
]) {
  const rejected =
    validateOperationFileFamilyContent({
      contract: markupContract,
      text,
    })

  assert.equal(rejected.ok, false)
  assert.equal(
    rejected.reason,
    "file_family_foreign_python_source",
  )
  assert.equal(
    rejected.foreign_family,
    "python",
  )
}

const pythonTextReplacement =
  deriveFileFamilyContract({
    operations: [
      {
        id: "op_0",
        kind: "replacement",
        slot: "existing:0",
      },
    ],
    capability,
  })

assert.equal(
  pythonTextReplacement.ok,
  false,
)

assert.equal(
  pythonTextReplacement.reason,
  "file_family_operation_incompatible",
)

const unknownCapability = {
  ...capability,
  existing_slots: [
    capability.existing_slots[0],
    {
      ...capability.existing_slots[1],
      file: "templates/menu.unknown",
    },
  ],
}

assert.equal(
  deriveFileFamilyContract({
    operations: spec.operations,
    capability: unknownCapability,
  }).ok,
  false,
)

const mixedCreateCapability = {
  ...capability,
  create_slots: [
    {
      ...capability.create_slots[0],
      allowed_extensions: [
        ".html",
        ".js",
      ],
    },
  ],
}

const mixed =
  deriveFileFamilyContract({
    operations: spec.operations,
    capability:
      mixedCreateCapability,
  })

assert.equal(mixed.ok, false)
assert.equal(
  mixed.reason,
  "file_family_extension_set_mixed",
)

const baseTool = {
  name: "execute_additive_plan",
  description:
    "Submit semantic content only.",
  input: {
    type: "object",
    properties: {
      contents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
            },
            content: {
              type: "object",
            },
          },
          required: [
            "id",
            "content",
          ],
        },
      },
    },
    required: ["contents"],
    additionalProperties: false,
  },
}

const malformedToolBinding =
  bindSemanticContentToolSchemaToCapability(
    {
      description:
        "missing semantic input schema",
    },
    capability,
  )

assert.equal(
  malformedToolBinding.ok,
  false,
)

assert.equal(
  malformedToolBinding.reason,
  "semantic_schema_not_applicable",
)

const bound =
  bindSemanticContentToolSchemaToCapability(
    baseTool,
    capability,
  )

assert.equal(
  bound.ok,
  true,
  JSON.stringify(bound),
)

assert.match(
  bound.tool.description,
  /FILE_FAMILY_CONTRACT protocol=file-family-contract-v1/u,
)

assert.match(
  bound.tool.description,
  /id=op_1 family=markup_template representation=markup_fragment/u,
)

const rendered =
  renderFileFamilyContract(contract)

assert.match(
  rendered,
  /authority=compiler_owned model_retarget=false/u,
)

const failure = {
  ok: false,
  reason:
    "semantic_file_family_mismatch",
  id: "op_1",
  operation_index: 1,
  field: "content",
  file_family:
    "markup_template",
  representation:
    "markup_fragment",
  foreign_family: "python",
}

const request = {
  contents: [
    {
      id: "op_1",
      content: {
        kind: "text",
        mode: "after",
        text:
          "def wrong():\n    return 1\n",
      },
    },
  ],
}

const contextSha = "c".repeat(64)

const repair =
  buildFileFamilyRepairHint({
    failure,
    capability,
    request,
    executionContextSha256:
      contextSha,
  })

assert.equal(repair.repairable, true)

assert.equal(
  fileFamilyRepairAuthorityMatches({
    hint: repair,
    capability,
    executionContextSha256:
      contextSha,
  }),
  true,
)

assert.equal(
  fileFamilyRepairAuthorityMatches({
    hint: repair,
    capability,
    executionContextSha256:
      "d".repeat(64),
  }),
  false,
)

const product =
  fs.readFileSync(
    new URL(
      "../../opencode/plugins/cpu-search-core/file-family-contract-v1.mjs",
      import.meta.url,
    ),
    "utf8",
  ).toLowerCase()

for (const forbidden of [
  "ozon",
  "bestsellers",
  "xlsx",
  "flask",
  "navigation_integration",
  "targets_route",
]) {
  assert.equal(
    product.includes(forbidden),
    false,
    forbidden,
  )
}

console.log(
  "PASS C8 file-family mutation isolation " +
    "family=compiler_owned " +
    "model_retarget=false " +
    "python=ruff_authoritative " +
    "non_python=conservative_foreign_source_guard " +
    "repair=bounded_authority_bound " +
    "repo_specific_policy=false",
)
