import assert from "node:assert/strict"
import fs from "node:fs"

import {
  projectPythonFrontendDiagnostic,
} from "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs"

const projected = projectPythonFrontendDiagnostic({
  ok: false,
  reason: "semantic_python_binding_unresolved",
  symbol: "Response",
  free_names: [
    "bestsellers_xlsx_export_route",
    "Response",
    "Response",
  ],
  repo_python_files_scanned: 27,
  repo_python_bytes_scanned: 8192,
})

assert.deepEqual(projected, {
  symbol: "Response",
  free_names: [
    "Response",
    "bestsellers_xlsx_export_route",
  ],
  free_names_total: 2,
  free_names_truncated: false,
  repo_python_files_scanned: 27,
  repo_python_bytes_scanned: 8192,
  diagnostic_authority: "python_semantic_frontend",
  mutation_authority: false,
})

const names = Array.from(
  { length: 40 },
  (_, index) => `name_${String(index).padStart(2, "0")}`,
)

const bounded = projectPythonFrontendDiagnostic({
  symbol: "missing_name",
  free_names: names,
})

assert.equal(bounded.symbol, "missing_name")
assert.equal(bounded.free_names.length, 32)
assert.equal(bounded.free_names_total, 40)
assert.equal(bounded.free_names_truncated, true)
assert.equal(bounded.mutation_authority, false)

const invalid = projectPythonFrontendDiagnostic({
  symbol: "",
  free_names: [null, 3, ""],
  repo_python_files_scanned: -1,
  repo_python_bytes_scanned: 1.5,
})

assert.equal(invalid.symbol, null)
assert.equal(invalid.free_names, null)
assert.equal(invalid.repo_python_files_scanned, null)
assert.equal(invalid.repo_python_bytes_scanned, null)

const semantic = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search-core/semantic-content-ir-v1.mjs",
    import.meta.url,
  ),
  "utf8",
)

assert.match(
  semantic,
  /\.\.\.projectPythonFrontendDiagnostic\(\s*compiled,\s*\)/s,
)
assert.match(
  semantic,
  /frontend_reason:\s*compiled\.reason \?\? null/s,
)

const fragment = fs.readFileSync(
  new URL(
    "../../opencode/plugins/cpu-search.fragments/09.part.ts",
    import.meta.url,
  ),
  "utf8",
)

assert.equal(
  (
    fragment.match(
      /`symbol=\$\{materialized\.symbol \?\? "unknown"\} `/g,
    ) ?? []
  ).length,
  2,
)

assert.equal(
  (
    fragment.match(
      /diagnostic_authority:\s*materialized\.diagnostic_authority \?\?\s*null,/gs,
    ) ?? []
  ).length,
  2,
)

assert.equal(
  (
    fragment.match(
      /free_names_truncated:\s*materialized\.free_names_truncated === true,/gs,
    ) ?? []
  ).length,
  2,
)

console.log(
  "PASS R7-R15-R1 semantic diagnostic closure " +
  "frontend_symbol=projected free_names=bounded " +
  "repo_scan=projected retry_stop=visible " +
  "model_calls_added=0 mutation_authority=false",
)
