#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Iterator


ROOT = Path(__file__).resolve().parents[2]

HELPER = (
    ROOT
    / "opencode/plugins/cpu-search-core/"
      "python-semantic-frontend-v1.py"
)

DEFAULT_BRIDGE = (
    ROOT
    / "rust/evidence-distiller/target/release/"
      "opencode-ruff-python-bridge"
)

HEX64_RE = re.compile(r"^[0-9a-f]{64}$", re.I)

CAPABILITY_TEXT_RE = re.compile(
    r"\bADDITIVE_CAPABILITY\b"
    r"[^\n]*?\bsha256=([0-9a-f]{64})\b",
    re.I,
)

OP_SLOT_PATTERNS = (
    re.compile(
        r"\bREQUIRED_OPERATION\b"
        r"[^\n]*?\bid=(op_[0-9]+)\b"
        r"[^\n]*?\bslot=([^\s]+)",
        re.I,
    ),
    re.compile(
        r"\bid=(op_[0-9]+)\b"
        r"[^\n]*?\bslot=([^\s]+)",
        re.I,
    ),
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def walk(value: Any) -> Iterator[Any]:
    yield value

    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)

    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def strings(value: Any) -> Iterator[str]:
    for node in walk(value):
        if isinstance(node, str):
            yield node


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    for lineno, raw in enumerate(
        path.read_text(
            encoding="utf-8",
            errors="replace",
        ).splitlines(),
        1,
    ):
        if not raw.strip():
            continue

        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            continue

        if isinstance(value, dict):
            rows.append(value)

    return rows


def first_string_key(
    value: Any,
    keys: tuple[str, ...],
) -> str | None:
    for node in walk(value):
        if not isinstance(node, dict):
            continue

        for key in keys:
            candidate = node.get(key)

            if (
                isinstance(candidate, str)
                and candidate.strip()
            ):
                return candidate.strip()

    return None


def tool_states(
    rows: list[dict[str, Any]],
    tool_name: str,
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    for row in rows:
        for node in walk(row):
            if not isinstance(node, dict):
                continue

            if node.get("tool") != tool_name:
                continue

            state = node.get("state")

            if isinstance(state, dict):
                found.append(state)

    return found


def extract_python_operation(
    rows: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    candidates: list[
        tuple[str, list[dict[str, Any]]]
    ] = []

    for state in tool_states(
        rows,
        "execute_additive_plan",
    ):
        payload = state.get("input")

        if not isinstance(payload, dict):
            continue

        contents = payload.get("contents")

        if not isinstance(contents, list):
            continue

        for item in contents:
            if not isinstance(item, dict):
                continue

            op_id = item.get("id")
            content = item.get("content")

            if (
                not isinstance(op_id, str)
                or not isinstance(content, dict)
                or content.get("kind") != "python_units"
            ):
                continue

            units = content.get("units")

            if not isinstance(units, list):
                continue

            if not all(
                isinstance(unit, dict)
                for unit in units
            ):
                continue

            candidates.append((op_id, units))

    # Deduplicate repeated telemetry copies of the exact same call.
    unique: dict[
        tuple[str, str],
        tuple[str, list[dict[str, Any]]],
    ] = {}

    for op_id, units in candidates:
        fingerprint = sha256_bytes(
            canonical_json(units)
        )
        unique[(op_id, fingerprint)] = (
            op_id,
            units,
        )

    if len(unique) != 1:
        observed = [
            {
                "op_id": op_id,
                "sha256": fingerprint,
            }
            for op_id, fingerprint in unique
        ]

        raise SystemExit(
            "STOP expected exactly one unique "
            "python_units operation; "
            f"observed={observed}"
        )

    op_id, units = next(iter(unique.values()))

    if not units:
        raise SystemExit(
            "STOP saved python_units operation is empty"
        )

    return op_id, units


def structured_capability_sha(
    values: list[Any],
) -> str | None:
    found: set[str] = set()

    for value in values:
        for node in walk(value):
            if not isinstance(node, dict):
                continue

            candidate = node.get(
                "capability_sha256"
            )

            if (
                isinstance(candidate, str)
                and HEX64_RE.fullmatch(candidate)
            ):
                found.add(candidate.lower())

    if len(found) == 1:
        return next(iter(found))

    return None


def structured_slot_file(
    values: list[Any],
    slot: str,
) -> str | None:
    found: set[str] = set()

    for value in values:
        for node in walk(value):
            if not isinstance(node, dict):
                continue

            if node.get("slot") != slot:
                continue

            candidate = node.get("file")

            if (
                isinstance(candidate, str)
                and candidate.strip()
            ):
                found.add(candidate.strip())

    if len(found) == 1:
        return next(iter(found))

    return None


def recover_from_text(
    values: list[Any],
    op_id: str,
) -> tuple[str | None, str | None]:
    text = "\n".join(
        part
        for value in values
        for part in strings(value)
    )

    capability_matches = {
        match.group(1).lower()
        for match in CAPABILITY_TEXT_RE.finditer(
            text
        )
    }

    capability_sha = (
        next(iter(capability_matches))
        if len(capability_matches) == 1
        else None
    )

    slots: set[str] = set()

    for pattern in OP_SLOT_PATTERNS:
        for match in pattern.finditer(text):
            if match.group(1) == op_id:
                slots.add(match.group(2))

    if len(slots) != 1:
        return capability_sha, None

    slot = next(iter(slots))

    escaped_slot = re.escape(slot)

    slot_file_re = re.compile(
        rf"\bslot={escaped_slot}\b"
        rf"[^\n]*?\bfile=([^\s]+)",
        re.I,
    )

    files = {
        match.group(1)
        for match in slot_file_re.finditer(text)
    }

    target_file = (
        next(iter(files))
        if len(files) == 1
        else None
    )

    return capability_sha, target_file


def resolve_capability_and_target(
    result: Any,
    rows: list[dict[str, Any]],
    op_id: str,
) -> tuple[str, str]:
    values: list[Any] = [result, *rows]

    capability_sha = structured_capability_sha(
        values
    )

    # First recover operation -> slot from textual evidence.
    text = "\n".join(
        part
        for value in values
        for part in strings(value)
    )

    slots: set[str] = set()

    for pattern in OP_SLOT_PATTERNS:
        for match in pattern.finditer(text):
            if match.group(1) == op_id:
                slots.add(match.group(2))

    target_file: str | None = None

    if len(slots) == 1:
        slot = next(iter(slots))
        target_file = structured_slot_file(
            values,
            slot,
        )

    text_capability, text_target = (
        recover_from_text(
            values,
            op_id,
        )
    )

    capability_sha = (
        capability_sha
        or text_capability
    )

    target_file = (
        target_file
        or text_target
    )

    if capability_sha is None:
        raise SystemExit(
            "STOP capability_sha256 not recoverable "
            "from saved artifact"
        )

    if target_file is None:
        raise SystemExit(
            f"STOP target file not recoverable "
            f"for operation={op_id}"
        )

    return capability_sha, target_file


def ensure_relative_repo_path(
    value: str,
) -> Path:
    path = Path(value)

    if path.is_absolute():
        raise SystemExit(
            f"STOP target path is absolute: {value}"
        )

    if ".." in path.parts:
        raise SystemExit(
            f"STOP target path escapes repo: {value}"
        )

    return path


def run_frontend(
    *,
    worktree: Path,
    target_file: Path,
    op_id: str,
    units: list[dict[str, Any]],
    capability_sha256: str,
    bridge: Path,
) -> tuple[dict[str, Any], str]:
    source_path = worktree / target_file

    if not source_path.is_file():
        raise SystemExit(
            "STOP target absent in exact base worktree: "
            f"{target_file}"
        )

    source = source_path.read_text(
        encoding="utf-8",
        errors="strict",
    )

    payload = {
        "root": str(worktree),
        "target_file": target_file.as_posix(),
        "source": source,
        "units": units,
        "operation_id": op_id,
        "capability_sha256": capability_sha256,
    }

    payload_bytes = canonical_json(payload)
    payload_sha = sha256_bytes(payload_bytes)

    env = dict(os.environ)
    env["OPENCODE_RUFF_PYTHON_BRIDGE"] = str(
        bridge
    )

    cp = subprocess.run(
        [
            sys.executable,
            "-S",
            str(HELPER),
        ],
        input=payload_bytes.decode("utf-8"),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )

    if cp.returncode != 0:
        raise SystemExit(
            "STOP frontend subprocess failed "
            f"rc={cp.returncode}\n"
            f"stderr:\n{cp.stderr}"
        )

    if not cp.stdout.strip():
        raise SystemExit(
            "STOP frontend emitted no JSON"
        )

    try:
        frontend = json.loads(cp.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            "STOP frontend emitted invalid JSON:\n"
            f"{cp.stdout}"
        ) from exc

    if not isinstance(frontend, dict):
        raise SystemExit(
            "STOP frontend result is not object"
        )

    return frontend, payload_sha


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Replay saved real E2E Python semantic "
            "operation through the current deterministic "
            "Python frontend without LLM inference."
        )
    )

    parser.add_argument(
        "--artifact",
        type=Path,
        required=True,
        help=(
            "Saved E2E artifact directory containing "
            "result.json and agent.stdout.jsonl"
        ),
    )

    parser.add_argument(
        "--bridge",
        type=Path,
        default=DEFAULT_BRIDGE,
    )

    parser.add_argument(
        "--require-ok",
        action="store_true",
        help=(
            "Fail unless the entire Python frontend "
            "returns ok=true. Without this flag C6 only "
            "requires the historical C4/C5 barriers to "
            "be eliminated."
        ),
    )

    parser.add_argument(
        "--expect-reason",
        default=None,
        help=(
            "Optional expected deterministic SAFE_FAIL "
            "reason for negative regression replay."
        ),
    )

    parser.add_argument(
        "--expect-symbol",
        default=None,
        help=(
            "Optional expected unresolved/diagnostic symbol. "
            "Benchmark evidence only; never affects compiler authority."
        ),
    )

    args = parser.parse_args()

    if args.require_ok and (
        args.expect_reason is not None
        or args.expect_symbol is not None
    ):
        raise SystemExit(
            "STOP --require-ok conflicts with "
            "--expect-reason/--expect-symbol"
        )

    artifact = args.artifact.resolve()
    bridge = args.bridge.resolve()

    result_path = artifact / "result.json"
    trace_path = artifact / "agent.stdout.jsonl"

    for path in (
        result_path,
        trace_path,
        HELPER,
        bridge,
    ):
        if not path.exists():
            raise SystemExit(
                f"STOP required path missing: {path}"
            )

    result = load_json(result_path)
    rows = load_jsonl(trace_path)

    repo_raw = first_string_key(
        result,
        (
            "repo",
            "repo_path",
            "repository",
        ),
    )

    base_head = first_string_key(
        result,
        (
            "base_head",
            "base_commit",
            "head_before",
        ),
    )

    if repo_raw is None:
        raise SystemExit(
            "STOP repo path not recoverable "
            "from result.json"
        )

    if base_head is None:
        raise SystemExit(
            "STOP base head not recoverable "
            "from result.json"
        )

    repo = Path(repo_raw).expanduser().resolve()

    if not (repo / ".git").exists():
        # Worktrees/submodules can have .git as a file,
        # so existence is sufficient; this branch catches
        # ordinary path mistakes.
        cp = subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "rev-parse",
                "--git-dir",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

        if cp.returncode != 0:
            raise SystemExit(
                f"STOP artifact repo is not Git: {repo}"
            )

    op_id, units = extract_python_operation(
        rows
    )

    capability_sha256, target_raw = (
        resolve_capability_and_target(
            result,
            rows,
            op_id,
        )
    )

    target_file = ensure_relative_repo_path(
        target_raw
    )

    unit_sha = sha256_bytes(
        canonical_json(units)
    )

    tmp = Path(
        tempfile.mkdtemp(
            prefix="koalik-c6-"
        )
    )

    worktree = tmp / "repo"
    worktree_added = False

    try:
        cp = subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "worktree",
                "add",
                "--detach",
                str(worktree),
                base_head,
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        if cp.returncode != 0:
            raise SystemExit(
                "STOP detached worktree creation failed\n"
                f"stdout:\n{cp.stdout}\n"
                f"stderr:\n{cp.stderr}"
            )

        worktree_added = True

        resolved_head = subprocess.check_output(
            [
                "git",
                "-C",
                str(worktree),
                "rev-parse",
                "HEAD",
            ],
            text=True,
        ).strip()

        frontend, payload_sha = run_frontend(
            worktree=worktree,
            target_file=target_file,
            op_id=op_id,
            units=units,
            capability_sha256=capability_sha256,
            bridge=bridge,
        )

        ok = frontend.get("ok")
        reason = frontend.get("reason")
        detail = frontend.get("detail")

        print("=== C6 SAVED FRONTEND REPLAY ===")
        print(f"repo={repo}")
        print(f"base_head={resolved_head}")
        print(f"operation={op_id}")
        print(f"target={target_file.as_posix()}")
        print(
            f"capability_sha256="
            f"{capability_sha256}"
        )
        print(f"units_sha256={unit_sha}")
        print(f"payload_sha256={payload_sha}")
        print()

        print("=== FRONTEND RESULT ===")
        print(
            json.dumps(
                frontend,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        print()

        # Historical C4 barrier.
        if reason == "representation_ambiguous":
            raise SystemExit(
                "FAIL C6 C4 regression: "
                "representation_ambiguous"
            )

        # Historical C5 barrier.
        if (
            reason == "semantic_unsupported"
            and detail
            == "dynamic_or_nested_import_semantics"
        ):
            raise SystemExit(
                "FAIL C6 C5 regression: "
                "dynamic_or_nested_import_semantics"
            )

        print(
            "PASS C6 historical barriers eliminated "
            "representation_ambiguous=false "
            "dynamic_or_nested_import_semantics=false"
        )

        expected_negative = (
            args.expect_reason is not None
            or args.expect_symbol is not None
        )

        if expected_negative:
            if ok is True:
                raise SystemExit(
                    "FAIL C6 expected deterministic SAFE_FAIL "
                    "but frontend returned ok=true"
                )

            if (
                args.expect_reason is not None
                and reason != args.expect_reason
            ):
                raise SystemExit(
                    "FAIL C6 reason drift: "
                    f"expected={args.expect_reason!r} "
                    f"observed={reason!r}"
                )

            observed_symbol = frontend.get("symbol")

            if (
                args.expect_symbol is not None
                and observed_symbol != args.expect_symbol
            ):
                raise SystemExit(
                    "FAIL C6 symbol drift: "
                    f"expected={args.expect_symbol!r} "
                    f"observed={observed_symbol!r}"
                )

            print(
                "PASS C6 expected deterministic SAFE_FAIL "
                f"reason={reason!r} "
                f"symbol={observed_symbol!r} "
                "mutation_authority=false"
            )
            return 0

        if ok is True:
            print(
                "PASS C6 full Python frontend "
                "frontend_ok=true"
            )
            return 0

        print(
            "PASS C6 reached next deterministic barrier "
            f"frontend_ok={ok!r} "
            f"reason={reason!r} "
            f"detail={detail!r}"
        )

        if args.require_ok:
            raise SystemExit(
                "FAIL C6 --require-ok: "
                "frontend did not return ok=true"
            )

        return 0

    finally:
        if worktree_added:
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "worktree",
                    "remove",
                    "--force",
                    str(worktree),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )

        shutil.rmtree(
            tmp,
            ignore_errors=True,
        )


if __name__ == "__main__":
    raise SystemExit(main())
