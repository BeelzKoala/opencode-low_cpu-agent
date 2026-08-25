#!/usr/bin/env python3
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = (ROOT / "opencode/plugins/cpu-search.ts").read_text(encoding="utf-8")
SPEC = json.loads((ROOT / "contracts/interfaces-v1.json").read_text(encoding="utf-8"))

for key, value in SPEC["protocols"].items():
    assert f'"{value}"' in PLUGIN, (key, value)

for value in (
    "const MAX_MODEL_CALLS_PER_TURN = 4",
    "const MAX_EXECUTED_SEARCHES_PER_TURN = 4",
    "const MAX_PATCH_ATTEMPTS_PER_TURN = 2",
):
    assert value in PLUGIN, value

assert 'name: "execute_patch"' not in PLUGIN

markers = {
    "search": '        name: "search",',
    "execute_replace_node": "        name: EXECUTE_REPLACE_NODE_TOOL,",
    "execute_rename_symbol": "        name: EXECUTE_RENAME_SYMBOL_TOOL,",
}
for tool, contract in SPEC["model_tools"].items():
    i = PLUGIN.index(markers[tool])
    j = PLUGIN.index("\n        options:", i)
    schema = PLUGIN[i:j]
    assert "additionalProperties: false" in schema, tool
    for required in contract["required"]:
        assert required in schema, (tool, required)
    for forbidden in contract.get("forbidden", []):
        assert f"{forbidden}: {{" not in schema, (tool, forbidden)

print("PASS interface-freeze-v1")
