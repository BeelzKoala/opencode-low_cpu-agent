#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "opencode/plugins/cpu-search-core/semantic-preservation-v1.py"

spec = importlib.util.spec_from_file_location(
    "koalik_r29_semantic_preservation",
    MODULE_PATH,
)
assert spec is not None and spec.loader is not None
r29 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r29)


def main() -> int:
    assert not hasattr(r29, "register_detector")
    assert not hasattr(r29, "register_policy")
    assert r29.policy_for("python.module", "future_unknown") is None
    assert r29.detector_for("python", "module") == "python_ast_top_level_v1"

    try:
        r29.POLICY_REGISTRY[("python.module", "future")] = {}
        raise AssertionError("policy registry mutated")
    except TypeError:
        pass

    before = (
        '"""module docs"""\n'
        "import os\n"
        "FLAG = True\n"
        "\n"
        "def keep(value):\n"
        "    return value + 1\n"
        "\n"
        "register()\n"
    )
    additive = (
        before
        + "\n"
        + "def added(value):\n"
        + "    return value * 2\n"
    )

    detected = r29.detect_python_source(
        path="routes/example.py",
        source=before,
    )
    assert detected["ok"] is True, detected
    assert detected["complete"] is True
    assert detected["stable_identity_complete"] is False

    content_only = [
        fact
        for fact in detected["facts"]
        if fact["identity_status"] == "content_only"
    ]
    assert content_only
    assert all(fact["semantic_key"] is None for fact in content_only)
    assert all(fact["identity_reason"] for fact in content_only)

    passed = r29.verify_sources(
        path="routes/example.py",
        before_source=before,
        after_source=additive,
    )
    assert passed["ok"] is True, passed

    modified = before.replace("return value + 1", "return value + 2")
    failed = r29.verify_sources(
        path="routes/example.py",
        before_source=before,
        after_source=modified,
    )
    assert failed["ok"] is False, failed
    assert failed["reason"] == "semantic_preservation_violation"
    assert any(
        item["reason"] == "baseline_semantic_fact_modified"
        for item in failed["violations"]
    )

    keep_fact = next(
        fact
        for fact in detected["facts"]
        if fact["kind"] == "function"
        and fact["semantic_key"].endswith("::function::keep")
    )
    allowed = r29.verify_sources(
        path="routes/example.py",
        before_source=before,
        after_source=modified,
        allowed_delta=[{
            "semantic_key": keep_fact["semantic_key"],
            "change": "modify",
        }],
    )
    assert allowed["ok"] is True, allowed
    assert allowed["allowed_delta_count"] == 1

    unstable_delta = r29.verify_sources(
        path="routes/example.py",
        before_source=before,
        after_source=before,
        allowed_delta=[{
            "semantic_key": "routes/example.py::statement::anonymous",
            "change": "modify",
        }],
    )
    assert unstable_delta["ok"] is False
    assert (
        unstable_delta["reason"]
        == "semantic_allowed_delta_key_not_in_baseline"
    )

    with tempfile.TemporaryDirectory(prefix="koalik-r29-") as tmp:
        base = Path(tmp) / "base"
        candidate = Path(tmp) / "candidate"
        (base / "routes").mkdir(parents=True)
        (candidate / "routes").mkdir(parents=True)

        (base / "routes/example.py").write_text(before, encoding="utf-8")
        (candidate / "routes/example.py").write_text(
            additive,
            encoding="utf-8",
        )

        checked = r29.verify_changed_python_files(
            baseline=base,
            candidate=candidate,
            changed_files=[
                "routes/example.py",
                "templates/menu.html",
            ],
        )
        assert checked["ok"] is True, checked
        assert checked["python_files_checked"] == 1
        assert checked["unsupported_changed_files"] == [
            "templates/menu.html",
        ]

    print(
        "PASS R29 semantic preservation "
        "static_registry=true fail_closed_policy=true "
        "semantic_key_required_for_allowed_delta=true "
        "unstable_identity_explicit=true additive_delta=true "
        "model_calls_added=0 mutation_authority=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
