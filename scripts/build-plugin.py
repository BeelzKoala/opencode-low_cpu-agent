#!/usr/bin/env python3
from pathlib import Path
import argparse
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "opencode/plugins/cpu-search.fragments.json"

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
parser.add_argument("--write", action="store_true")
args = parser.parse_args()

manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
assert manifest["protocol"] == "cpu-search-fragments-v1"

chunks = []
refreshed = []
for record in manifest["parts"]:
    body = (ROOT / record["path"]).read_bytes()
    chunks.append(body)
    refreshed.append(
        {
            **record,
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        }
    )

built = b"".join(chunks)
entry = ROOT / manifest["entrypoint"]

if args.write:
    # Fragments are the editable source-of-truth. Rebuild the runtime
    # entrypoint and refresh only content hashes/sizes.
    entry.write_bytes(built)
    manifest["parts"] = refreshed
    manifest["entrypoint_bytes"] = len(built)
    manifest["entrypoint_sha256"] = hashlib.sha256(built).hexdigest()
    MANIFEST.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"PASS rebuilt cpu-search.ts from fragments "
        f"parts={len(chunks)} bytes={len(built)}"
    )
    raise SystemExit(0)

# Check mode is fail-closed: both fragment hashes and generated entrypoint
# must match the frozen manifest.
for old, current in zip(manifest["parts"], refreshed):
    if old["bytes"] != current["bytes"]:
        raise SystemExit(f"FAIL fragment size drift: {old['path']}")
    if old["sha256"] != current["sha256"]:
        raise SystemExit(f"FAIL fragment hash drift: {old['path']}")

actual = entry.read_bytes()
if actual != built:
    raise SystemExit("FAIL generated cpu-search.ts differs from fragments")
if hashlib.sha256(actual).hexdigest() != manifest["entrypoint_sha256"]:
    raise SystemExit("FAIL entrypoint hash drift")

print(
    f"PASS cpu-search fragments reproduce entrypoint "
    f"parts={len(chunks)} bytes={len(actual)}"
)
