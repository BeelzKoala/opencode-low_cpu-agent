#!/usr/bin/env python3
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
TASK = (ROOT / "opencode/plugins/cpu-search-core/task-anchor-v1.mjs").resolve()
PROJECTOR = (ROOT / "opencode/plugins/cpu-search-core/data-obligation-projector-v1.mjs").resolve()
TASK_BOUND = (ROOT / "opencode/plugins/cpu-search-core/task-bound-obligation-evidence-v1.mjs").resolve()
COVERAGE = (ROOT / "opencode/plugins/cpu-search-core/obligation-coverage-v1.mjs").resolve()
BIN = ROOT / "rust/evidence-distiller/target/debug/opencode-impact-index"


def run(argv, cwd=ROOT, input_text=None):
    cp = subprocess.run(
        argv,
        cwd=cwd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if cp.returncode:
        print(cp.stdout, end="")
        print(cp.stderr, end="")
        raise SystemExit(cp.returncode)
    return cp


run([
    "cargo",
    "test",
    "--manifest-path",
    str(ROOT / "rust/evidence-distiller/Cargo.toml"),
    "data_provider_identity_",
])
run([
    "cargo",
    "test",
    "--manifest-path",
    str(ROOT / "rust/evidence-distiller/Cargo.toml"),
    "symbol_binding_into_file_",
])
run([
    "cargo",
    "build",
    "--manifest-path",
    str(ROOT / "rust/evidence-distiller/Cargo.toml"),
    "--bin",
    "opencode-impact-index",
])

with tempfile.TemporaryDirectory(prefix="e16-r3-provider-") as td:
    repo = Path(td)
    (repo / "routes").mkdir()

    (repo / "database.py").write_text(
        """import psycopg2
DB = {}
REPORTING_DB = {}

def primary_conn():
    return psycopg2.connect(**DB)

def reporting_conn():
    return psycopg2.connect(**REPORTING_DB)
""",
        encoding="utf-8",
    )

    (repo / "routes/report.py").write_text(
        """from database import reporting_conn

def report():
    return reporting_conn()
""",
        encoding="utf-8",
    )

    (repo / "routes/other.py").write_text(
        """from database import primary_conn

def other():
    return primary_conn()
""",
        encoding="utf-8",
    )

    # Adversarial unrelated namespace/member dependency. Global rename-grade
    # closure must remain fail-closed because BindingPair cannot prove it.
    (repo / "unrelated.py").write_text(
        """import database

def unrelated():
    return database.reporting_conn()
""",
        encoding="utf-8",
    )

    for i in range(5):
        (repo / f"noise_{i}.py").write_text("NOISE = True\n", encoding="utf-8")

    request = {
        "root": str(repo),
        "mode": "data_provider_identity",
        "identities": ["NOISE", "REPORTING_DB"],
        "max_files_per_identity": 2,
    }
    provider = json.loads(
        run(
            [str(BIN)],
            cwd=repo,
            input_text=json.dumps(request),
        ).stdout
    )

    obs = {row["identity"]: row for row in provider["observations"]}
    assert provider["ready"] is True and provider["complete"] is True
    assert obs["NOISE"]["truncated"] is True
    assert obs["REPORTING_DB"]["search_complete"] is True
    assert obs["REPORTING_DB"]["truncated"] is False
    assert len(obs["REPORTING_DB"]["candidates"]) == 1
    candidate = obs["REPORTING_DB"]["candidates"][0]
    assert candidate["file"] == "database.py"
    assert candidate["symbol"] == "reporting_conn"
    assert candidate["configuration_identity"] == "REPORTING_DB"
    assert candidate["constructor_family"] == "python-psycopg2"

    global_closure = json.loads(
        run(
            [str(BIN)],
            cwd=repo,
            input_text=json.dumps({
                "root": str(repo),
                "mode": "symbol_closure",
                "source_file": "database.py",
                "source_symbol": "reporting_conn",
                "max_bindings": 32,
            }),
        ).stdout
    )
    assert global_closure["ready"] is False
    assert global_closure["complete"] is False
    assert global_closure["reason"] == "closure_member_binding_unsupported"

    binding = json.loads(
        run(
            [str(BIN)],
            cwd=repo,
            input_text=json.dumps({
                "root": str(repo),
                "mode": "symbol_binding_into_file",
                "source_file": "database.py",
                "source_symbol": "reporting_conn",
                "importer_file": "routes/report.py",
            }),
        ).stdout
    )
    assert binding["ready"] is True and binding["complete"] is True
    assert binding["reason"] is None
    assert binding["source_file"] == "database.py"
    assert binding["source_symbol"] == "reporting_conn"
    assert binding["importer_file"] == "routes/report.py"
    assert len(binding["bindings"]) == 1

    host_binding = binding["bindings"][0]
    assert host_binding["importer"] == "routes/report.py"
    assert host_binding["target"] == "database.py"
    assert host_binding["source_symbol"] == "reporting_conn"
    assert host_binding["local_symbol"] == "reporting_conn"
    assert host_binding["confidence"] == "exact_local"

    negative = json.loads(
        run(
            [str(BIN)],
            cwd=repo,
            input_text=json.dumps({
                "root": str(repo),
                "mode": "symbol_binding_into_file",
                "source_file": "database.py",
                "source_symbol": "reporting_conn",
                "importer_file": "routes/other.py",
            }),
        ).stdout
    )
    assert negative["ready"] is True
    assert negative["complete"] is True
    assert negative["reason"] == "exact_binding_absent"
    assert negative["bindings"] == []

    namespace = json.loads(
        run(
            [str(BIN)],
            cwd=repo,
            input_text=json.dumps({
                "root": str(repo),
                "mode": "symbol_binding_into_file",
                "source_file": "database.py",
                "source_symbol": "reporting_conn",
                "importer_file": "unrelated.py",
            }),
        ).stdout
    )
    assert namespace["ready"] is False
    assert namespace["complete"] is False
    assert namespace["reason"] == "binding_member_binding_unsupported"

    sha = "a" * 64
    js = f"""
import assert from "node:assert/strict";
import {{compileTaskAnchors}} from {json.dumps(TASK.as_uri())};
import {{projectDataAccessObligation}} from {json.dumps(PROJECTOR.as_uri())};
import {{projectTaskBoundObligationProofs, mergeTaskRoleEvidence}} from {json.dumps(TASK_BOUND.as_uri())};
import {{solveObligationCoverage}} from {json.dumps(COVERAGE.as_uri())};

const sha = "{sha}";
const anchors = compileTaskAnchors("Use REPORTING_DB for the report", sha);
assert(anchors.anchors.some((x) => x.kind === "constant_identifier" && x.value === "REPORTING_DB"));

const req = {{
  status: "compiled",
  task_sha256: sha,
  required_roles: ["data_access_capability"],
}};

const proof = (file, line, extractor) => ({{
  file,
  line,
  sha256: "b".repeat(64),
  extractor,
}});

const provider = {json.dumps(provider)};
const binding = {json.dumps(binding)};
const key = ["REPORTING_DB", "database.py", "reporting_conn"].join("\\0");

const projection = projectDataAccessObligation({{
  taskSha256: sha,
  taskAnchors: anchors,
  coverageRequirements: req,
  anchorFrontier: {{status: "bound", owner_file: "routes/report.py"}},
  providerResolution: provider,
  providerProofs: {{
    [key]: proof(
      "database.py",
      {candidate["witness_line"]},
      "impact-index-data-provider-identity-v1",
    ),
  }},
  bindingByProvider: {{
    [key]: binding,
  }},
  bindingProofs: {{
    [key]: proof(
      "routes/report.py",
      {host_binding["witness_line"]},
      "impact-index-symbol-binding-into-file-v1",
    ),
  }},
}});

assert.equal(projection.status, "proofs_projected");
assert.equal(projection.proofs.length, 1);
assert.equal(projection.proofs[0].obligation, "data_access_capability");
assert.equal(projection.proofs[0].causal_path.length, 1);
assert.equal(
  projection.proofs[0].causal_path[0].kind,
  "provider_binding_into_task_host",
);
assert.equal(
  projection.proofs[0].causal_path[0].from,
  "symbol:database.py#reporting_conn",
);
assert.equal(
  projection.proofs[0].causal_path[0].to,
  "file:routes/report.py",
);
assert.equal(
  projection.proofs[0].causal_path.some((edge) =>
    String(edge.from ?? "").startsWith("task_constant:")
  ),
  false,
);

const data = projectTaskBoundObligationProofs({{
  coverageRequirements: req,
  taskSha256: sha,
  proofs: projection.proofs,
}});
assert.equal(data.evidence.length, 1);
assert.equal(data.evidence[0].tier, "B");
assert.equal(data.evidence[0].localization_authority, true);
assert.equal(data.evidence[0].mutation_authority, false);

const merged = mergeTaskRoleEvidence({{
  existing: [],
  incoming: data.evidence,
  taskSha256: sha,
}});
const covered = solveObligationCoverage({{
  taskRequirements: req,
  evidence: merged.evidence,
}});
assert.equal(covered.status, "covered");
assert.deepEqual(covered.covered_roles, ["data_access_capability"]);

// Wrong config identity cannot cover.
const wrong = structuredClone(provider);
wrong.observations.find((x) =>
  x.identity === "REPORTING_DB"
).candidates[0].configuration_identity = "PRIMARY_DB";
assert.equal(
  projectDataAccessObligation({{
    taskSha256: sha,
    taskAnchors: anchors,
    coverageRequirements: req,
    anchorFrontier: {{status: "bound", owner_file: "routes/report.py"}},
    providerResolution: wrong,
  }}).proofs.length,
  0,
);

console.log("PASS constant identifier observation");
console.log("PASS identity-local truncation isolation");
console.log("PASS AST provider identity");
console.log("PASS global symbol_closure remains rename-grade fail-closed");
console.log("PASS target-conditioned exact symbol binding");
console.log("PASS exact importer namespace/member use remains fail-closed");
console.log("PASS negative target relation is a complete negative");
console.log("PASS Tier B path contains only real provider->host relation");
console.log("PASS existing E1.5 Tier B projection");
console.log("PASS mutation authority remains false");
"""
    out = run(["node", "--input-type=module"], input_text=js)
    print(out.stdout, end="")

for p in (
    TASK,
    PROJECTOR,
    ROOT / "rust/evidence-distiller/src/impact_index_core.rs",
):
    text = p.read_text(encoding="utf-8").lower()
    for forbidden in (
        "ozon",
        "bestsellers",
        "rd_bestsellers_data",
        "get_basdb_conn",
    ):
        assert forbidden not in text, (p, forbidden)

impact_text = (
    ROOT / "rust/evidence-distiller/src/impact_index_core.rs"
).read_text(encoding="utf-8")
assert "closure_member_binding_unsupported" in impact_text
assert 'mode: "symbol_binding_into_file"' in impact_text

print("PASS E1.6-R3 production remains repository-neutral")
print("PASS v2.28-E1.6-R3 target-conditioned data capability localization")
