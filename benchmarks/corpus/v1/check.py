#!/usr/bin/env python3
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / "corpus.json").read_text(encoding="utf-8"))
assert manifest["protocol"] == "immutable-corpus-v1"
ids = [task["id"] for task in manifest["tasks"]]
assert len(ids) == len(set(ids))
assert len(ids) >= 10
for task in manifest["tasks"]:
    assert task["expected"] in {"VERIFIED", "SAFE_FAIL", "PASS"}
print(f"PASS immutable corpus tasks={len(ids)}")
