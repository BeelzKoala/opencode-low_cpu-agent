import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  ADDITIVE_MUTATION_ABI_PROTOCOL,
  bindAdditiveToolSchemaToCapability,
  renderAdditiveMutationCapability,
  validateAdditiveMutationRequest,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v2.mjs"
import {
  SEALED_ADDITIVE_SITE_PROTOCOL,
  validateAndLowerSealedAdditiveSite,
} from "../../opencode/plugins/cpu-search-core/sealed-additive-site-v1.mjs"

function sha(value) {
  return createHash("sha256").update(value).digest("hex")
}

const source = [
  "from flask import Blueprint\n",
  "\n",
  '@bp.route("/export", methods=["POST"])\n',
  "def export_excel():\n",
  '    return "old"\n',
].join("")
const anchor = [
  '@bp.route("/export", methods=["POST"])\n',
  "def export_excel():\n",
  '    return "old"',
].join("")
const sourceBuffer = Buffer.from(source, "utf8")
const anchorBuffer = Buffer.from(anchor, "utf8")
const start = sourceBuffer.indexOf(anchorBuffer)
assert.ok(start >= 0)
const end = start + anchorBuffer.length

const target = {
  slot: "existing:0",
  file: "routes/bestsellers_bp.py",
  sha256: sha(sourceBuffer),
  evidence_lines: [1, 3],
}

const response = {
  protocol: "sealed-edit-site-projection-v1",
  provider_protocol: "ast-grep-structural-site-v1",
  backend: "ast-grep-0.45.1",
  authority: "hypothesis",
  complete: true,
  errors: [],
  sites: [{
    protocol: "sealed-edit-site-v1",
    site_id: "insert:0",
    authority: "hypothesis",
    file: target.file,
    source_sha256: target.sha256,
    evidence_line: 3,
    language: "python",
    provider_protocol: "ast-grep-structural-site-v1",
    backend: "ast-grep-0.45.1",
    node_kind: "decorated_definition",
    structural_path: [1],
    relation: "module_child_before",
    operation: "insert_before",
    anchor_text_sha256: sha(anchorBuffer),
    descriptor_sha256: "1".repeat(64),
    evidence_binding_sha256: "2".repeat(64),
    site_sha256: "a".repeat(64),
    derived_anchor_start_byte: start,
    derived_anchor_end_byte: end,
    derived_insert_byte: start,
    coordinates_authority: "derived_hint_only",
  }],
}

const lowered = validateAndLowerSealedAdditiveSite({
  source: sourceBuffer,
  target,
  evidenceLine: 3,
  response,
  content: '@bp.route("/new")\ndef new_page():\n    return "new"\n',
  maxReplacementBytes: 12 * 1024,
})
assert.equal(lowered.ok, true)
assert.equal(lowered.protocol, SEALED_ADDITIVE_SITE_PROTOCOL)
assert.equal(lowered.before, anchor)
assert.match(lowered.replacement, /^@bp\.route\("\/new"\)/u)
assert.ok(lowered.replacement.endsWith(anchor))
assert.equal(lowered.operation, "insert_before")

const preimageSmuggle = validateAndLowerSealedAdditiveSite({
  source: sourceBuffer,
  target,
  evidenceLine: 3,
  response,
  content: anchor,
  maxReplacementBytes: 12 * 1024,
})
assert.equal(preimageSmuggle.ok, false)
assert.equal(
  preimageSmuggle.reason,
  "additive_site_content_contains_preimage",
)

const duplicateSource = Buffer.from(`${source}\n${anchor}\n`, "utf8")
const duplicateTarget = {
  ...target,
  sha256: sha(duplicateSource),
}
const duplicateResponse = {
  ...response,
  sites: [{
    ...response.sites[0],
    source_sha256: duplicateTarget.sha256,
  }],
}
const ambiguous = validateAndLowerSealedAdditiveSite({
  source: duplicateSource,
  target: duplicateTarget,
  evidenceLine: 3,
  response: duplicateResponse,
  content: "x = 1\n",
  maxReplacementBytes: 12 * 1024,
})
assert.equal(ambiguous.ok, false)
assert.equal(ambiguous.reason, "additive_site_anchor_ambiguous")

const stale = validateAndLowerSealedAdditiveSite({
  source: `${source}# drift\n`,
  target,
  evidenceLine: 3,
  response,
  content: "x = 1\n",
  maxReplacementBytes: 12 * 1024,
})
assert.equal(stale.ok, false)
assert.equal(stale.reason, "additive_site_source_changed")

const absent = validateAndLowerSealedAdditiveSite({
  source: sourceBuffer,
  target,
  evidenceLine: 1,
  response,
  content: "x = 1\n",
  maxReplacementBytes: 12 * 1024,
})
assert.equal(absent.ok, false)
assert.equal(absent.reason, "additive_site_projection_absent")

assert.equal(ADDITIVE_MUTATION_ABI_PROTOCOL, "closed-additive-mutation-abi-v2")

const valid = validateAdditiveMutationRequest({
  insertions: [{
    slot: "existing:0",
    evidence_line: 3,
    content: "def added():\n    return 1\n",
  }],
  replacements: [],
  creations: [],
})
assert.equal(valid.ok, true)
assert.equal(valid.abi_protocol, "closed-additive-mutation-abi-v2")

const legacyShape = validateAdditiveMutationRequest({
  replacements: [],
  creations: [],
})
assert.equal(legacyShape.ok, false)
assert.equal(legacyShape.reason, "additive_request_shape_invalid")

const tool = {
  description: "test",
  input: {
    type: "object",
    properties: {
      insertions: {
        type: "array",
        minItems: 0,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
            evidence_line: { type: "integer", minimum: 1 },
            content: { type: "string" },
          },
          required: ["slot", "evidence_line", "content"],
          additionalProperties: false,
        },
      },
      replacements: {
        type: "array",
        minItems: 0,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            slot: { type: "string" },
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
            slot: { type: "string" },
            relative_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["slot", "relative_path", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["insertions", "replacements", "creations"],
    additionalProperties: false,
  },
}

const capability = {
  protocol: "scout-additive-capability-v1",
  ready: true,
  mutation_authority: true,
  operation: "additive_surface",
  capability_sha256: "b".repeat(64),
  existing_slots: [
    {
      slot: "existing:0",
      file: "routes/bestsellers_bp.py",
      sha256: "c".repeat(64),
      evidence_lines: [3, 112],
      roles: ["task_anchor_owner"],
    },
    {
      slot: "existing:1",
      file: "templates/snippets/menu.html",
      sha256: "d".repeat(64),
      evidence_lines: [59],
      roles: ["navigation_host"],
    },
  ],
  create_slots: [{
    slot: "create:0",
    root: "templates",
    source_file: "templates/bestsellers_task.html",
    source_sha256: "e".repeat(64),
    evidence_lines: [196],
    allowed_extensions: [".html"],
    max_depth: 2,
  }],
}

const bound = bindAdditiveToolSchemaToCapability(tool, capability)
assert.equal(bound.ok, true)
assert.deepEqual(
  bound.tool.input.properties.insertions.items.properties.slot.enum,
  ["existing:0"],
)
assert.deepEqual(
  bound.tool.input.properties.replacements.items.properties.slot.enum,
  ["existing:1"],
)
assert.deepEqual(
  bound.tool.input.properties.creations.items.properties.slot.enum,
  ["create:0"],
)

const rendered = renderAdditiveMutationCapability(capability)
assert.match(rendered, /closed-additive-mutation-abi-v2/u)
assert.match(rendered, /slot=existing:0 op=insert_at_sealed_site/u)
assert.match(rendered, /preimage=model_forbidden/u)
assert.match(rendered, /evidence_line_required=true/u)
assert.match(rendered, /evidence_lines=3,112/u)
assert.match(rendered, /slot=existing:1 op=replace_exact/u)

console.log(
  "PASS E2.5 sealed additive Python sites remove model-authored preimages",
)
