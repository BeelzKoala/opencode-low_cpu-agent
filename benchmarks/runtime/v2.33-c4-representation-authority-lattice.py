#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]

BRIDGE = Path(
    os.environ.get(
        "OPENCODE_RUFF_PYTHON_BRIDGE",
        str(
            ROOT
            / "rust/evidence-distiller/target/release/"
              "opencode-ruff-python-bridge"
        ),
    )
).resolve()


def canonicalize(unit: dict) -> dict:
    cp = subprocess.run(
        [str(BRIDGE)],
        input=json.dumps(
            {
                "command": "canonicalize_unit",
                "unit": unit,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert cp.returncode == 0, cp.stderr

    result = json.loads(cp.stdout)

    assert result["protocol"] == "ruff-python-bridge-v1"

    return result


def base_unit(
    *,
    returns,
    body: str,
    decorators=None,
    parameters: str = "value: int",
    name: str = "answer",
    kind: str = "function",
) -> dict:
    return {
        "kind": kind,
        "name": name,
        "parameters": parameters,
        "returns": returns,
        "decorators": decorators or [],
        "body": body,
    }


# These are probes, NOT a whitelist.
# The product must remain annotation-expression agnostic.
ANNOTATION_PROBES = (
    "None",
    "bool",
    "int",
    "float",
    "complex",
    "str",
    "bytes",
    "list[str]",
    "dict[str, int]",
    "set[str]",
    "frozenset[str]",
    "tuple[str, ...]",
    "str | None",
    "typing.Optional[str]",
    "typing.Union[str, int]",
    'typing.Literal["x"]',
    'typing.Annotated[int, "unit"]',
    "collections.abc.Callable[[str], int]",
    "Response",
    "T",
)


# ------------------------------------------------------------
# 1. Shell annotation + wrapper omission = monotonic reduction.
# ------------------------------------------------------------

for annotation in ANNOTATION_PROBES:
    result = canonicalize(
        base_unit(
            returns=annotation,
            body=(
                "def answer(value: int):\n"
                "    return value\n"
            ),
        )
    )

    assert result["ok"] is True, (
        annotation,
        result,
    )

    assert result["authority_expansion"] is False

    assert (
        "redundant_wrapper_return_omission"
        in result["normalizations"]
    ), result


# ------------------------------------------------------------
# 2. Exact duplication remains accepted.
# ------------------------------------------------------------

exact = canonicalize(
    base_unit(
        returns="int",
        body=(
            "def answer(value: int) -> int:\n"
            "    return value\n"
        ),
    )
)

assert exact["ok"] is True, exact
assert exact["authority_expansion"] is False


# ------------------------------------------------------------
# 3. Explicit contradiction stays fail-closed.
# ------------------------------------------------------------

conflict = canonicalize(
    base_unit(
        returns="int",
        body=(
            "def answer(value: int) -> str:\n"
            "    return str(value)\n"
        ),
    )
)

assert conflict["ok"] is False, conflict
assert conflict["reason"] == "representation_ambiguous"
assert conflict["detail"] == "redundant_wrapper_conflict"
assert conflict["conflict"] == "return_annotation"


# ------------------------------------------------------------
# 4. Wrapper may not expand absent shell authority.
# ------------------------------------------------------------

expansion = canonicalize(
    base_unit(
        returns=None,
        body=(
            "def answer(value: int) -> int:\n"
            "    return value\n"
        ),
    )
)

assert expansion["ok"] is False, expansion
assert expansion["reason"] == "representation_ambiguous"
assert expansion["conflict"] == "return_annotation"


# ------------------------------------------------------------
# 5. Parameters are semantic, never omission-tolerant.
# ------------------------------------------------------------

parameter_conflict = canonicalize(
    base_unit(
        returns="int",
        body=(
            "def answer(other: int) -> int:\n"
            "    return other\n"
        ),
    )
)

assert parameter_conflict["ok"] is False, parameter_conflict
assert parameter_conflict["reason"] == "representation_ambiguous"
assert parameter_conflict["conflict"] == "parameters"


# ------------------------------------------------------------
# 6. Decorator omission is monotonic.
# ------------------------------------------------------------

decorator_omission = canonicalize(
    base_unit(
        returns="int",
        decorators=["staticmethod"],
        body=(
            "def answer(value: int) -> int:\n"
            "    return value\n"
        ),
    )
)

assert decorator_omission["ok"] is True, decorator_omission
assert decorator_omission["authority_expansion"] is False
assert (
    "redundant_wrapper_decorator_omission"
    in decorator_omission["normalizations"]
)


# ------------------------------------------------------------
# 7. Wrapper-only decorator is authority expansion.
# ------------------------------------------------------------

decorator_expansion = canonicalize(
    base_unit(
        returns="int",
        body=(
            "@staticmethod\n"
            "def answer(value: int) -> int:\n"
            "    return value\n"
        ),
    )
)

assert decorator_expansion["ok"] is False, decorator_expansion
assert decorator_expansion["reason"] == "representation_ambiguous"
assert decorator_expansion["conflict"] == "decorators"


# ------------------------------------------------------------
# 8. Different decorators conflict.
# ------------------------------------------------------------

decorator_conflict = canonicalize(
    base_unit(
        returns="int",
        decorators=["classmethod"],
        body=(
            "@staticmethod\n"
            "def answer(value: int) -> int:\n"
            "    return value\n"
        ),
    )
)

assert decorator_conflict["ok"] is False, decorator_conflict
assert decorator_conflict["reason"] == "representation_ambiguous"
assert decorator_conflict["conflict"] == "decorators"


# ------------------------------------------------------------
# 9. Identity remains exact.
# ------------------------------------------------------------

identity_conflict = canonicalize(
    base_unit(
        returns="int",
        body=(
            "def different(value: int) -> int:\n"
            "    return value\n"
        ),
    )
)

assert identity_conflict["ok"] is False, identity_conflict
assert identity_conflict["reason"] == "representation_ambiguous"
assert identity_conflict["conflict"] == "identity"


# ------------------------------------------------------------
# 10. Sync/async identity remains exact.
# ------------------------------------------------------------

async_conflict = canonicalize(
    base_unit(
        returns="int",
        body=(
            "async def answer(value: int) -> int:\n"
            "    return value\n"
        ),
    )
)

assert async_conflict["ok"] is False, async_conflict
assert async_conflict["reason"] == "representation_ambiguous"
assert async_conflict["conflict"] == "identity"


# ------------------------------------------------------------
# 11. Exact E2E #3 representation-class probe.
#
# We intentionally preserve a nested import. This test asserts
# ONLY that missing wrapper return annotation is no longer the
# failure. A later deterministic semantic barrier is legitimate.
# ------------------------------------------------------------

probe = canonicalize(
    {
        "kind": "function",
        "name": "add_bestsellers_download_page",
        "parameters": "self, request",
        "returns": "Response",
        "decorators": [],
        "body": (
            "def add_bestsellers_download_page(self, request):\n"
            "    def download_xlsx():\n"
            "        import io\n"
            "        return io.BytesIO()\n"
            "    return download_xlsx()\n"
        ),
    }
)

assert probe.get("reason") != "representation_ambiguous", probe


print(
    "PASS C4 representation authority lattice "
    "annotation_space=open "
    "wrapper_omission=monotonic "
    "explicit_conflict=fail_closed "
    "authority_expansion=false"
)

if probe.get("ok") is not True:
    print(
        "NEXT deterministic barrier:",
        probe.get("reason"),
        probe.get("detail"),
    )
