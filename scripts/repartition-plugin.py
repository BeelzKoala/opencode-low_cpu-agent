#!/usr/bin/env python3
from pathlib import Path
import hashlib
import json
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / "opencode/plugins/cpu-search.ts"
PART_DIR = ROOT / "opencode/plugins/cpu-search.fragments"
MANIFEST = ROOT / "opencode/plugins/cpu-search.fragments.json"
TARGET = 64 * 1024

data = ENTRY.read_bytes()
text = data.decode("utf-8")

# Mechanical split only. Boundaries are top-level named functions and export default.
candidates = [0]
for m in re.finditer(
    r"(?m)^(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(",
    text,
):
    candidates.append(len(text[: m.start()].encode("utf-8")))
m = re.search(r"(?m)^export default \{", text)
if m:
    candidates.append(len(text[: m.start()].encode("utf-8")))
candidates = sorted(set(x for x in candidates if 0 <= x < len(data)))

cuts = [0]
cursor = 0
while cursor + TARGET < len(data):
    wanted = cursor + TARGET
    after = [x for x in candidates if x >= wanted and x > cursor]
    before = [x for x in candidates if cursor < x < wanted]
    if after and after[0] - wanted <= TARGET // 2:
        cut = after[0]
    elif before:
        cut = before[-1]
    else:
        cut = wanted
        while cut < len(data) and data[cut : cut + 1] != b"\n":
            cut += 1
        cut = min(len(data), cut + 1)
    if cut <= cursor or cut >= len(data):
        break
    cuts.append(cut)
    cursor = cut
cuts.append(len(data))

# Fragment boundaries are representation-only. Keep exactly one line ending
# on the previous fragment and move additional separator blank lines to the
# next fragment. Concatenation remains byte-identical to the entrypoint while
# every generated shard stays clean under git diff --check.
normalized_cuts = [cuts[0]]
for cut in cuts[1:-1]:
    match = re.search(rb"((?:\r\n|\n){2,})$", data[:cut])
    if match:
        separators = match.group(1)
        first_eol = b"\r\n" if separators.startswith(b"\r\n") else b"\n"
        cut -= len(separators) - len(first_eol)

    if cut <= normalized_cuts[-1] or cut >= len(data):
        raise SystemExit("FAIL normalized fragment boundary invalid")

    normalized_cuts.append(cut)

normalized_cuts.append(cuts[-1])
cuts = normalized_cuts

if PART_DIR.exists():
    shutil.rmtree(PART_DIR)
PART_DIR.mkdir(parents=True)

parts = []
for idx, (a, b) in enumerate(zip(cuts, cuts[1:])):
    body = data[a:b]
    rel = f"opencode/plugins/cpu-search.fragments/{idx:02d}.part.ts"
    path = ROOT / rel
    path.write_bytes(body)
    parts.append(
        {
            "path": rel,
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        }
    )

manifest = {
    "protocol": "cpu-search-fragments-v1",
    "entrypoint": "opencode/plugins/cpu-search.ts",
    "entrypoint_bytes": len(data),
    "entrypoint_sha256": hashlib.sha256(data).hexdigest(),
    "target_fragment_bytes": TARGET,
    "parts": parts,
}
MANIFEST.write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
print(f"PASS repartitioned plugin parts={len(parts)} bytes={len(data)}")
