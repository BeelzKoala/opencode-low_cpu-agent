import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  EVIDENCE_INSPECT_AUTHORITY,
  EVIDENCE_INSPECT_PROTOCOL,
  inspectEvidence,
} from "../../opencode/plugins/cpu-search-core/evidence-inspect-v1.mjs"

function digest(source) {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex")
}

const source = [
  "def outer():",
  "    value = 41",
  "    return value + 1",
  "",
].join("\n")

const allowed = [
  {
    file: "src/sample.py",
    sha256: digest(source),
    evidence_lines: [2, 3],
  },
]

const base = inspectEvidence({
  request: { file: "src/sample.py", line: 3, radius: 1 },
  allowed_files: allowed,
  source,
})

assert.equal(base.status, "OK")
assert.equal(base.protocol, EVIDENCE_INSPECT_PROTOCOL)
assert.equal(base.authority, EVIDENCE_INSPECT_AUTHORITY)
assert.equal(base.mutation_authority, false)
assert.deepEqual(base.binding, {
  file: "src/sample.py",
  line: 3,
  sha256: digest(source),
})
assert.deepEqual(
  base.excerpt,
  [
    { line: 2, text: "    value = 41" },
    { line: 3, text: "    return value + 1" },
    { line: 4, text: "" },
  ],
)

assert.deepEqual(
  inspectEvidence({
    request: { file: "src/sample.py", line: 3, radius: 1 },
    allowed_files: allowed,
    source,
  }),
  base,
  "same input must yield byte-for-byte equivalent structured evidence",
)

for (const [name, result, reason] of [
  [
    "unattested file",
    inspectEvidence({
      request: { file: "src/other.py", line: 3, radius: 1 },
      allowed_files: allowed,
      source,
    }),
    "file_not_attested",
  ],
  [
    "unattested line",
    inspectEvidence({
      request: { file: "src/sample.py", line: 1, radius: 1 },
      allowed_files: allowed,
      source,
    }),
    "line_not_attested",
  ],
  [
    "stale source",
    inspectEvidence({
      request: { file: "src/sample.py", line: 3, radius: 1 },
      allowed_files: allowed,
      source: `${source}# changed\n`,
    }),
    "stale_source",
  ],
  [
    "path traversal",
    inspectEvidence({
      request: { file: "../src/sample.py", line: 3, radius: 1 },
      allowed_files: allowed,
      source,
    }),
    "invalid_path",
  ],
  [
    "absolute path",
    inspectEvidence({
      request: { file: "/tmp/sample.py", line: 3, radius: 1 },
      allowed_files: allowed,
      source,
    }),
    "invalid_path",
  ],
  [
    "radius budget",
    inspectEvidence({
      request: { file: "src/sample.py", line: 3, radius: 13 },
      allowed_files: allowed,
      source,
    }),
    "invalid_radius",
  ],
]) {
  assert.equal(result.status, "ABSTAIN", name)
  assert.equal(result.reason, reason, name)
  assert.equal(result.mutation_authority, false, name)
}

const hugeSource = `x = "${"a".repeat(3000)}"\n`
const hugeAllowed = [
  {
    file: "src/huge.py",
    sha256: digest(hugeSource),
    evidence_lines: [1],
  },
]
const huge = inspectEvidence({
  request: { file: "src/huge.py", line: 1, radius: 0 },
  allowed_files: hugeAllowed,
  source: hugeSource,
})
assert.equal(huge.status, "ABSTAIN")
assert.equal(huge.reason, "byte_budget_exceeded")
assert.equal(huge.mutation_authority, false)

console.log("PASS v2.28-A evidence inspect primitive")
