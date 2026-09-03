#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]

HELPER = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "python-semantic-frontend-v1.py"
)

BRIDGE = (
    ROOT
    / "rust/evidence-distiller/target/release/"
      "opencode-ruff-python-bridge"
)


def compile_payload(payload: dict) -> dict:
    env = dict(os.environ)
    env["OPENCODE_RUFF_PYTHON_BRIDGE"] = str(BRIDGE)

    cp = subprocess.run(
        ["python3", "-S", str(HELPER)],
        input=json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )

    assert cp.returncode == 0, cp.stderr
    assert cp.stdout.strip(), cp.stderr

    return json.loads(cp.stdout)


with tempfile.TemporaryDirectory(
    prefix="koalik-scoped-alias-"
) as raw:
    root = Path(raw)

    target = root / "sample.py"
    target.write_text(
        "EXISTING = 1\n",
        encoding="utf-8",
    )

    result = compile_payload(
        {
            "root": str(root),
            "target_file": "sample.py",
            "source": target.read_text(encoding="utf-8"),
            "units": [
                {
                    "kind": "function",
                    "name": "probe",
                    "parameters": "value",
                    "returns": None,
                    "decorators": [],
                    "body": (
                        "import json as js\n"
                        "if value:\n"
                        "    import pathlib as p\n"
                        "    return p.Path('.')\n"
                        "return js.dumps(value)\n"
                    ),
                }
            ],
            "operation_id": "op_0",
            "capability_sha256": "0" * 64,
        }
    )

    assert result["ok"] is True, result
    assert result["authority_expansion"] is False

    declaration = result["declaration"]

    # Exact explicit aliases stay in the generated declaration.
    assert "import json as js" in declaration, declaration
    assert "import pathlib as p" in declaration, declaration

    # Usages must remain consistent with those exact bindings.
    assert "js.dumps(value)" in declaration, declaration
    assert "p.Path('.')" in declaration, declaration

    # No module-level materialization from function-local imports.
    assert result["modules"] == [], result["modules"]
    assert result["from_imports"] == [], result["from_imports"]

    rows = result["scoped_imports"]

    json_row = next(
        row
        for row in rows
        if row["resolved_module"] == "json"
    )

    pathlib_row = next(
        row
        for row in rows
        if row["resolved_module"] == "pathlib"
    )

    assert json_row["alias"] == "js"
    assert json_row["local"] == "js"
    assert json_row["scope_preserved"] is True
    assert json_row["model_authority"] is False

    assert pathlib_row["alias"] == "p"
    assert pathlib_row["local"] == "p"
    assert "if.body" in pathlib_row["execution_path"]
    assert pathlib_row["scope_preserved"] is True
    assert pathlib_row["model_authority"] is False

    # Scoped aliases are lexical authority, not normalization targets.
    assert (
        "alias_canonicalized"
        not in result["normalizations"]
    ), result["normalizations"]


print(
    "PASS C5-R1 scoped alias preservation "
    "explicit_alias=stable "
    "usage_binding=stable "
    "scope_preserved=true "
    "module_hoist=false "
    "authority_expansion=false "
    "model_context_overhead_bytes=0"
)
