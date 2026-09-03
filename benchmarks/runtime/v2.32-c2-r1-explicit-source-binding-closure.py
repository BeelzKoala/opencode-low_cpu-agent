#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "opencode/plugins/cpu-search-core/python-semantic-frontend-v1.py"
BRIDGE = ROOT / "rust/evidence-distiller/src/ruff_python_bridge.rs"
frontend = FRONTEND.read_text(encoding="utf-8")
bridge = BRIDGE.read_text(encoding="utf-8")
assert "import ast" not in frontend
assert "ast.parse" not in frontend
assert "import symtable" in frontend
assert "call_bridge" in frontend
assert 'RUFF_BRIDGE_PROTOCOL = "ruff-python-bridge-v1"' in frontend
assert "ruff_python_parser::parse_module" in bridge
assert "ruff_python_ast::visitor" in bridge
print(
    "PASS C2-R1 compatibility: "
    "ruff_source_authority=true "
    "symtable_scope_only=true "
    "cpython_ast_removed=true"
)
