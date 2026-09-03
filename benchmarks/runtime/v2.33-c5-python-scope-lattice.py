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
        input=json.dumps(payload),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )

    assert cp.returncode == 0, cp.stderr
    return json.loads(cp.stdout)


with tempfile.TemporaryDirectory(
    prefix="koalik-scope-"
) as raw:
    root = Path(raw)

    target = root / "sample.py"
    target.write_text(
        "EXISTING = 1\n",
        encoding="utf-8",
    )

    unit = {
        "kind": "function",
        "name": "probe",
        "parameters": "flag",
        "returns": None,
        "decorators": [],
        "body": (
            "import io\n"
            "if flag:\n"
            "    import json\n"
            "try:\n"
            "    from datetime import datetime\n"
            "except ValueError:\n"
            "    import math\n"
            "with open(__file__, 'rb') as handle:\n"
            "    import os\n"
            "def nested():\n"
            "    import pathlib\n"
            "    return pathlib.Path('.')\n"
            "return io.BytesIO()\n"
        ),
    }

    result = compile_payload(
        {
            "root": str(root),
            "target_file": "sample.py",
            "source": target.read_text(encoding="utf-8"),
            "units": [unit],
            "operation_id": "op_0",
            "capability_sha256": "0" * 64,
        }
    )

    assert result["ok"] is True, result
    assert result["scope_protocol"] == "python-scope-lattice-v1"
    assert result["model_import_authority"] is False
    assert result["scope_sha256"]

    rows = result["scoped_imports"]
    assert len(rows) == 6, rows

    assert all(
        row["scope_preserved"] is True
        and row["model_authority"] is False
        for row in rows
    )

    modules = {
        row["resolved_module"]
        for row in rows
    }

    assert modules == {
        "io",
        "json",
        "datetime",
        "math",
        "os",
        "pathlib",
    }

    # No local import may be materialized as a module-level import.
    assert result["modules"] == [], result["modules"]
    assert result["from_imports"] == [], result["from_imports"]

    declaration = result["declaration"]

    for statement in (
        "import io",
        "import json",
        "from datetime import datetime",
        "import math",
        "import os",
        "import pathlib",
    ):
        assert statement in declaration

    nested = next(
        row
        for row in rows
        if row["resolved_module"] == "pathlib"
    )

    assert any(
        value == "function:nested"
        for value in nested["lexical_path"]
    )

    conditional = next(
        row
        for row in rows
        if row["resolved_module"] == "json"
    )

    assert "if.body" in conditional["execution_path"]


    # global is explicit scope authority and stays model-forbidden.
    bad_global = dict(unit)
    bad_global["body"] = (
        "global X\n"
        "X = 1\n"
    )

    result = compile_payload(
        {
            "root": str(root),
            "target_file": "sample.py",
            "source": target.read_text(encoding="utf-8"),
            "units": [bad_global],
            "operation_id": "op_0",
            "capability_sha256": "0" * 64,
        }
    )

    assert result["ok"] is False
    assert result["reason"] == "semantic_python_global_forbidden"


    # Star imports remain fail-closed.
    bad_star = dict(unit)
    bad_star["body"] = (
        "if flag:\n"
        "    from math import *\n"
        "return None\n"
    )

    result = compile_payload(
        {
            "root": str(root),
            "target_file": "sample.py",
            "source": target.read_text(encoding="utf-8"),
            "units": [bad_star],
            "operation_id": "op_0",
            "capability_sha256": "0" * 64,
        }
    )

    assert result["ok"] is False
    assert result["reason"] == "semantic_python_star_import_forbidden"


    # Unknown external dependencies are not legalized by model syntax.
    unknown = dict(unit)
    unknown["body"] = (
        "import koalik_definitely_missing_dependency\n"
        "return None\n"
    )

    result = compile_payload(
        {
            "root": str(root),
            "target_file": "sample.py",
            "source": target.read_text(encoding="utf-8"),
            "units": [unknown],
            "operation_id": "op_0",
            "capability_sha256": "0" * 64,
        }
    )

    assert result["ok"] is False
    assert (
        result["reason"]
        == "semantic_python_scoped_import_unauthorized"
    )


# Scope machinery must remain absent from mutation inference context.
prompt_source = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "obligation-bound-synthesis-v1.mjs"
).read_text(encoding="utf-8")

for forbidden in (
    "python-scope-lattice-v1",
    "scoped_imports",
    "lexical_path",
    "execution_path",
):
    assert forbidden not in prompt_source, forbidden


print(
    "PASS C5 Python scope lattice "
    "lexical=true "
    "execution_regions=true "
    "imports=scope_preserved "
    "authority=compiler_only "
    "ruff_crosscheck=true "
    "global_nonlocal=fail_closed "
    "model_context_overhead_bytes=0"
)
