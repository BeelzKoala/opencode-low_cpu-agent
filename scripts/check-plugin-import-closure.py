#!/usr/bin/env python3

from __future__ import annotations

from argparse import ArgumentParser
from pathlib import Path
import re
import sys


IMPORT_RE = re.compile(
    r"""
    (?:
        from\s+
        |
        import\s*
        (?:
            \(\s*
        )?
    )
    ["']
    (?P<spec>\.[^"']+)
    ["']
    """,
    re.VERBOSE,
)


def normalize_relative(
    root: Path,
    path: Path,
) -> str:
    return (
        path.resolve()
        .relative_to(
            root.resolve()
        )
        .as_posix()
    )


def relative_imports(
    path: Path,
) -> list[str]:
    text = path.read_text(
        encoding="utf-8",
    )

    return sorted(
        {
            match.group("spec")
            for match in IMPORT_RE.finditer(
                text
            )
        }
    )


def resolve_dependency(
    root: Path,
    importer: Path,
    spec: str,
) -> Path:
    clean = (
        spec
        .split("?", 1)[0]
        .split("#", 1)[0]
    )

    candidate = (
        importer.parent
        / clean
    ).resolve()

    try:
        candidate.relative_to(
            root.resolve()
        )
    except ValueError as exc:
        raise RuntimeError(
            "relative import escaped plugin root: "
            f"{importer}: {spec}"
        ) from exc

    return candidate


def walk_closure(
    root: Path,
    entry: Path,
) -> tuple[
    set[str],
    list[tuple[str, str, str]],
]:
    pending = [
        entry.resolve()
    ]

    visited: set[Path] = set()
    required: set[str] = set()
    missing = []

    while pending:
        current = pending.pop()

        if current in visited:
            continue

        visited.add(current)

        if not current.is_file():
            missing.append(
                (
                    "<entry>",
                    normalize_relative(
                        root,
                        current,
                    ),
                    "missing",
                )
            )
            continue

        current_rel = normalize_relative(
            root,
            current,
        )

        required.add(
            current_rel
        )

        for spec in relative_imports(
            current
        ):
            dependency = resolve_dependency(
                root,
                current,
                spec,
            )

            try:
                dependency_rel = (
                    normalize_relative(
                        root,
                        dependency,
                    )
                )
            except ValueError:
                missing.append(
                    (
                        current_rel,
                        spec,
                        "escaped_root",
                    )
                )
                continue

            if not dependency.is_file():
                missing.append(
                    (
                        current_rel,
                        dependency_rel,
                        "missing_source",
                    )
                )
                continue

            required.add(
                dependency_rel
            )

            if dependency not in visited:
                pending.append(
                    dependency
                )

    return (
        required,
        missing,
    )


def manifest_paths(
    manifest: Path,
) -> set[str]:
    text = manifest.read_text(
        encoding="utf-8",
    )

    paths = set()

    for match in re.finditer(
        r'''["']([^"']+\.(?:mjs|js|ts))["']''',
        text,
    ):
        value = (
            match.group(1)
            .replace("\\", "/")
            .removeprefix("./")
        )

        paths.add(value)

    return paths


def main() -> int:
    parser = ArgumentParser()

    parser.add_argument(
        "--plugin-root",
        required=True,
    )

    parser.add_argument(
        "--entry",
        default="cpu-search.ts",
    )

    parser.add_argument(
        "--manifest",
    )

    args = parser.parse_args()

    root = Path(
        args.plugin_root
    ).resolve()

    entry = (
        root
        / args.entry
    ).resolve()

    if not root.is_dir():
        print(
            "FAIL plugin root missing:",
            root,
            file=sys.stderr,
        )
        return 1

    required, missing = (
        walk_closure(
            root,
            entry,
        )
    )

    if missing:
        print(
            "FAIL plugin import closure",
            file=sys.stderr,
        )

        for importer, dependency, reason in missing:
            print(
                f"  {reason}: "
                f"{importer} -> {dependency}",
                file=sys.stderr,
            )

        return 1

    print(
        "PASS source transitive import closure "
        f"files={len(required)}"
    )

    if args.manifest:
        manifest = Path(
            args.manifest
        )

        declared = manifest_paths(
            manifest
        )

        undeclared = sorted(
            required - declared
        )

        if undeclared:
            print(
                "FAIL installer omits transitive dependencies:",
                file=sys.stderr,
            )

            for path in undeclared:
                print(
                    f"  {path}",
                    file=sys.stderr,
                )

            return 1

        print(
            "PASS installer contains full transitive "
            f"import closure files={len(required)}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(
        main()
    )
