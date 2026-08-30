#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CARGO = ROOT / "rust/evidence-distiller/Cargo.toml"
BIN = ROOT / "rust/evidence-distiller/target/debug/opencode-sealed-slice-store"


def run(argv, *, cwd=ROOT, input_text=None, env=None):
    cp = subprocess.run(
        argv,
        cwd=cwd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    if cp.returncode:
        print(cp.stdout, end="")
        print(cp.stderr, end="")
        raise SystemExit(cp.returncode)
    return cp


run([
    "cargo",
    "build",
    "--quiet",
    "--manifest-path",
    str(CARGO),
    "--bin",
    "opencode-sealed-slice-store",
])

with tempfile.TemporaryDirectory(prefix="r14b-sealed-slice-") as td:
    root = Path(td)
    repo = root / "repo"
    cache = root / "cache"
    repo.mkdir()

    source = "def render():\n    return 'ok'\n"
    path = repo / "view.py"
    path.write_text(source, encoding="utf-8")
    source_bytes = source.encode()
    source_sha = hashlib.sha256(source_bytes).hexdigest()
    site_sha = "a" * 64

    start = source_bytes.index(b"return")
    end = start + len(b"return 'ok'")

    env = os.environ.copy()
    env["OPENCODE_SEALED_SLICE_CACHE"] = str(cache.resolve())

    def request(payload):
        cp = run(
            [str(BIN)],
            cwd=repo,
            input_text=json.dumps({"root": str(repo), **payload}),
            env=env,
        )
        return json.loads(cp.stdout)

    payload = {
        "mode": "put_slice",
        "file": "view.py",
        "source_sha256": source_sha,
        "site_sha256": site_sha,
        "start_byte": start,
        "end_byte": end,
    }

    first = request(payload)
    assert first["ok"] is True, first
    assert first["protocol"] == "sealed-slice-store-v1", first
    assert first["authority"] == "cache_only", first
    assert first["binding_protocol"] == "sealed-slice-binding-v1", first
    assert first["execution_offsets_authoritative"] is False, first
    assert first["cache_hit"] is False, first

    blob = first["blob_sha256"]
    expected = hashlib.sha256(source_bytes[start:end]).hexdigest()
    assert blob == expected, (blob, expected)

    object_path = cache / "objects" / "sha256" / blob[:2] / blob
    assert object_path.read_bytes() == source_bytes[start:end]
    assert not (repo / ".opencode").exists()

    second = request(payload)
    assert second["ok"] is True and second["cache_hit"] is True, second
    assert second["blob_sha256"] == first["blob_sha256"], second
    assert second["binding_sha256"] == first["binding_sha256"], second

    path.write_text(source + "# drift\n", encoding="utf-8")
    stale = request(payload)
    assert stale["ok"] is False, stale
    assert stale["reason"] == "source_hash_mismatch", stale

    path.write_text(source, encoding="utf-8")
    object_path.write_bytes(b"corrupt")
    corrupt = request({
        "mode": "verify_blob",
        "blob_sha256": blob,
    })
    assert corrupt["ok"] is False, corrupt
    assert corrupt["reason"] == "cas_blob_corrupt", corrupt

print("PASS R14-B content-addressable sealed slice CAS / stale-source / corruption / no-repo-write")
