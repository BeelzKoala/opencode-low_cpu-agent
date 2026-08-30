#!/usr/bin/env node

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  ADDITIVE_HOST_BINDING_PROTOCOL,
  ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
  authorizeAdditiveMutationCapability,
  buildAdditiveMutationHandoff,
  deriveAdditiveMutationCapability,
  materializeAdditiveMutationContext,
  verifyAdditiveMutationAuthority,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"

const root = await mkdtemp(
  path.join(os.tmpdir(), "opencode-e21-coherence-"),
)
await mkdir(path.join(root, "routes"), { recursive: true })
await mkdir(
  path.join(root, "templates", "snippets"),
  { recursive: true },
)
await mkdir(
  path.join(root, ".opencode", "scout-handoffs", "capabilities"),
  { recursive: true },
)

const sources = {
  "routes/page.py":
    '@bp.route("/export")\ndef export():\n    return "old"\n',
  "templates/snippets/menu.html":
    '<a href="/export">Export</a>\n',
  "templates/page.html":
    "<html><body>old</body></html>\n",
  "database.py":
    'class DB:\n    table = "rows"\n',
}

for (const [file, source] of Object.entries(sources)) {
  const absolute = path.join(root, file)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, source)
}

const sha = (file) =>
  createHash("sha256").update(sources[file]).digest("hex")

const row = (file, roles, line = 1, digest = sha(file)) => ({
  file,
  roles,
  witnesses: [{
    line,
    sha256: digest,
    extractor: "e21_fixture",
  }],
})

const closure = {
  status: "covered",
  localization_authority: true,
  truncated: false,
  required_roles: [
    "data_access_capability",
    "navigation_host",
    "ui_host",
  ],
  missing_roles: [],
  ambiguous_roles: [],
  files: [
    // Role propagation is intentionally adversarial here.
    row(
      "routes/page.py",
      ["task_anchor_owner", "navigation_host", "ui_host"],
    ),
    row(
      "templates/snippets/menu.html",
      ["navigation_host", "ui_host"],
    ),
    row("templates/page.html", ["ui_host"]),
    row("database.py", ["data_access_capability"]),
  ],
}

const hosts = {
  protected_surface: {
    owner: "file:routes/page.py",
    owner_file: "routes/page.py",
    structural_ready: true,
  },
  navigation_candidate: {
    resource: "template:snippets/menu.html",
    physical_file: "templates/snippets/menu.html",
    structural_ready: true,
    topology: [{
      resource: "template:snippets/menu.html",
      physical_file: "templates/snippets/menu.html",
      shared_includers: 3,
      internal_route_targets: 4,
      structural_ready: true,
    }],
  },
  ui_candidate: {
    resource: "template:page.html",
    physical_file: "templates/page.html",
    structural_ready: true,
  },
}

const bound = deriveAdditiveMutationCapability({
  taskShape: { status: "compiled", shape: "additive" },
  evidenceClosure: closure,
  hostResourceClosure: hosts,
})

assert.equal(bound.binding_ready, true)
assert.equal(bound.ready, false)
assert.equal(bound.mutation_authority, false)
assert.equal(
  bound.host_binding_protocol,
  ADDITIVE_HOST_BINDING_PROTOCOL,
)
assert.deepEqual(bound.host_bindings, {
  route_owner: "routes/page.py",
  navigation_host: "templates/snippets/menu.html",
  ui_create_source: "templates/page.html",
  ui_resource: "template:page.html",
  navigation_resource: "template:snippets/menu.html",
  navigation_topology: {
    resource: "template:snippets/menu.html",
    physical_file: "templates/snippets/menu.html",
    shared_includers: 3,
    internal_route_targets: 4,
  },
})

// Propagated roles do not create mutation targets.
assert.deepEqual(
  bound.existing_slots.map((slot) => slot.file),
  ["routes/page.py", "templates/snippets/menu.html"],
)
assert.equal(
  bound.create_slots[0].source_file,
  "templates/page.html",
)
assert.ok(
  !bound.existing_slots.some(
    (slot) => slot.file === "database.py",
  ),
)

// Exact physical host identity must be present in the attested closure.
const missingExactNav = deriveAdditiveMutationCapability({
  taskShape: { status: "compiled", shape: "additive" },
  evidenceClosure: {
    ...closure,
    files: closure.files.filter(
      (entry) =>
        entry.file !== "templates/snippets/menu.html",
    ),
  },
  hostResourceClosure: hosts,
})
assert.equal(missingExactNav.binding_ready, false)
assert.equal(
  missingExactNav.reason,
  "additive_navigation_host_unattested",
)

// A typed navigation host without an exact structural topology witness is not
// mutation authority.
const topologyMismatch = deriveAdditiveMutationCapability({
  taskShape: { status: "compiled", shape: "additive" },
  evidenceClosure: closure,
  hostResourceClosure: {
    ...hosts,
    navigation_candidate: {
      ...hosts.navigation_candidate,
      topology: [{
        resource: "template:other.html",
        physical_file: "templates/snippets/menu.html",
        structural_ready: true,
      }],
    },
  },
})
assert.equal(topologyMismatch.binding_ready, false)
assert.equal(
  topologyMismatch.reason,
  "additive_navigation_topology_unproven",
)

// Duplicate attestations merge only when source identity agrees.
const conflict = deriveAdditiveMutationCapability({
  taskShape: { status: "compiled", shape: "additive" },
  evidenceClosure: {
    ...closure,
    files: [
      ...closure.files,
      row(
        "templates/page.html",
        ["ui_host"],
        1,
        "0".repeat(64),
      ),
    ],
  },
  hostResourceClosure: hosts,
})
assert.equal(conflict.binding_ready, false)
assert.equal(
  conflict.reason,
  "additive_evidence_file_hash_conflict",
)

// Binding alone is never mutation authority.
const context = await materializeAdditiveMutationContext({
  root,
  capability: bound,
})
assert.equal(context.ok, true)

const provisional = buildAdditiveMutationHandoff({
  searchProtocol: "search-test",
  sessionKey: "s",
  turnKey: "t",
  capability: bound,
  context,
})
assert.equal(provisional.ok, true)
assert.equal(provisional.bundle.status, "provisional")

const rel =
  ".opencode/scout-handoffs/capabilities/e21.json"
const abs = path.join(root, rel)
await writeFile(
  abs,
  JSON.stringify(provisional.bundle, null, 2) + "\n",
)

const authorized = await authorizeAdditiveMutationCapability({
  root,
  capability: bound,
  context,
  handoffPath: rel,
})
assert.equal(authorized.ready, true)
assert.equal(authorized.mutation_authority, true)
assert.equal(
  authorized.authority_protocol,
  ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
)

const finalHandoff = buildAdditiveMutationHandoff({
  searchProtocol: "search-test",
  sessionKey: "s",
  turnKey: "t",
  capability: authorized,
  context,
})
await writeFile(
  abs,
  JSON.stringify(finalHandoff.bundle, null, 2) + "\n",
)

const verified = await verifyAdditiveMutationAuthority({
  root,
  capability: authorized,
  context,
  handoffPath: rel,
})
assert.equal(verified.ok, true)

// Tampering after sealing must revoke the receipt.
const tampered = {
  ...finalHandoff.bundle,
  sealed_context_sha256: "0".repeat(64),
}
await writeFile(abs, JSON.stringify(tampered, null, 2) + "\n")
const rejected = await verifyAdditiveMutationAuthority({
  root,
  capability: authorized,
  context,
  handoffPath: rel,
})
assert.equal(rejected.ok, false)
assert.equal(
  rejected.reason,
  "additive_authorized_handoff_mismatch",
)

console.log(
  "PASS v2.28-E2.1 coverage identity authority separation",
)
