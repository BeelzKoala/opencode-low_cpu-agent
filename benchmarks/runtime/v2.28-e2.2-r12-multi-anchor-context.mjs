import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  materializeAdditiveMutationContext,
} from "../../opencode/plugins/cpu-search-core/additive-mutation-v1.mjs"

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function sourceWithAnchors() {
  const lines = Array.from(
    { length: 100 },
    (_, index) => `LINE_${String(index + 1).padStart(3, "0")}`,
  )
  lines[2] = "ANCHOR_THREE"
  lines[19] = "OVERLAP_TWENTY"
  lines[20] = "OVERLAP_TWENTY_ONE"
  lines[21] = "OVERLAP_TWENTY_TWO"
  lines[39] = "ANCHOR_FORTY"
  lines[79] = "ANCHOR_EIGHTY"
  return `${lines.join("\n")}\n`
}

function capabilityFor({
  file,
  digest,
  evidenceLines,
  roles,
  mutable = true,
  createSource = null,
}) {
  return {
    binding_ready: true,
    capability_sha256: "c".repeat(64),
    existing_slots: mutable
      ? [{
          slot: "existing:0",
          file,
          sha256: digest,
          evidence_lines: evidenceLines,
          roles,
          allowed_operations: ["replace_exact"],
        }]
      : [],
    create_slots: createSource
      ? [{
          slot: "create:0",
          source_file: createSource,
        }]
      : [],
    context_files: [{
      file,
      sha256: digest,
      evidence_lines: evidenceLines,
      roles,
    }],
  }
}

function renderedLineCount(content, line) {
  const needle = `${String(line).padStart(5)} | `
  return content
    .split("\n")
    .filter((row) => row.startsWith(needle))
    .length
}

const root = await mkdtemp(
  path.join(os.tmpdir(), "cpu-agent-r12-context-"),
)

try {
  const routeFile = "routes/example.py"
  const routePath = path.join(root, routeFile)
  await mkdir(path.dirname(routePath), { recursive: true })
  const routeSource = sourceWithAnchors()
  const routeDigest = sha256(routeSource)

  await writeFile(routePath, routeSource, "utf8")

  // Regression: three distant mutation anchors must all reach model context.
  // ui_host normally gets radius=12 => 25 theoretical lines.
  // R12 redistributes that same line envelope across 3 anchors:
  // floor((25 - 3) / (2 * 3)) = 3.
  const multiCapability = capabilityFor({
    file: routeFile,
    digest: routeDigest,
    evidenceLines: [3, 40, 80],
    roles: ["task_anchor_owner", "ui_host"],
  })

  const multi = await materializeAdditiveMutationContext({
    root,
    capability: multiCapability,
    maxBytes: 4_800,
  })
  assert.equal(multi.ok, true)
  assert.equal(multi.mutation_authority, false)
  assert.match(
    multi.content,
    /anchors=3,40,80 anchor_radius=3/u,
  )
  assert.match(multi.content, /ANCHOR_THREE/u)
  assert.match(multi.content, /ANCHOR_FORTY/u)
  assert.match(multi.content, /ANCHOR_EIGHTY/u)
  assert.doesNotMatch(multi.content, /LINE_020/u)

  const multiAgain = await materializeAdditiveMutationContext({
    root,
    capability: multiCapability,
    maxBytes: 4_800,
  })
  assert.equal(multiAgain.ok, true)
  assert.equal(multiAgain.content, multi.content)
  assert.equal(multiAgain.context_sha256, multi.context_sha256)

  // Overlapping windows must merge by physical line, never amplify context.
  // Default role radius=4 => 9 theoretical lines.
  // Two anchors receive radius=1; line 21 belongs to both windows.
  const overlapCapability = capabilityFor({
    file: routeFile,
    digest: routeDigest,
    evidenceLines: [20, 22],
    roles: ["data_access_capability"],
  })
  const overlap = await materializeAdditiveMutationContext({
    root,
    capability: overlapCapability,
    maxBytes: 4_800,
  })
  assert.equal(overlap.ok, true)
  assert.match(overlap.content, /anchors=20,22 anchor_radius=1/u)
  assert.equal(renderedLineCount(overlap.content, 21), 1)
  assert.match(overlap.content, /OVERLAP_TWENTY/u)
  assert.match(overlap.content, /OVERLAP_TWENTY_TWO/u)

  // Single-anchor behavior preserves the old role radius exactly.
  const singleCapability = capabilityFor({
    file: routeFile,
    digest: routeDigest,
    evidenceLines: [40],
    roles: ["navigation_host"],
  })
  const single = await materializeAdditiveMutationContext({
    root,
    capability: singleCapability,
    maxBytes: 4_800,
  })
  assert.equal(single.ok, true)
  assert.match(single.content, /anchors=40 anchor_radius=8/u)
  assert.equal(renderedLineCount(single.content, 32), 1)
  assert.equal(renderedLineCount(single.content, 48), 1)

  // Never silently drop attested anchors from a mutable file.
  // Default radius envelope is 9 lines, so 10 distinct anchors cannot be
  // represented even at radius=0 without widening the previous line budget.
  const overflowCapability = capabilityFor({
    file: routeFile,
    digest: routeDigest,
    evidenceLines: Array.from({ length: 10 }, (_, index) => index + 1),
    roles: ["data_access_capability"],
  })
  const overflow = await materializeAdditiveMutationContext({
    root,
    capability: overflowCapability,
    maxBytes: 4_800,
  })
  assert.equal(overflow.ok, false)
  assert.equal(
    overflow.reason,
    "additive_context_critical_anchor_budget",
  )

  // Existing critical byte-budget behavior remains fail-closed.
  const byteBudget = await materializeAdditiveMutationContext({
    root,
    capability: singleCapability,
    maxBytes: 256,
  })
  assert.equal(byteBudget.ok, false)
  assert.equal(byteBudget.reason, "additive_context_critical_budget")

  console.log(
    "PASS E2.2-R12 additive context covers every attested mutation anchor within the existing per-file line envelope",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
