#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "v2.28-model-viability.py"


def load_module():
    spec = importlib.util.spec_from_file_location(
        "opencode_model_viability",
        TARGET,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load model viability module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    mod = load_module()

    raw_request = {
        "system": ["base-system", "bounded-capsule"],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "perform task"},
                ],
            },
        ],
        "tools": {
            "execute_additive_plan": {
                "description": "bounded additive plan",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "python_declarations": {
                            "type": "array",
                            "items": {"type": "object"},
                        },
                        "replacements": {
                            "type": "array",
                            "items": {"type": "object"},
                        },
                        "creations": {
                            "type": "array",
                            "items": {"type": "object"},
                        },
                    },
                },
            },
        },
    }

    fixture = {
        "protocol": mod.FIXTURE_PROTOCOL,
        "source": {
            "task_text_sha256": "task-sha",
        },
        "request_sha256": mod.sha256_json(raw_request),
        "request": raw_request,
    }

    ablation = {
        "protocol": mod.SPEC_PROTOCOL,
        "task_id": "synthetic",
        "expected_task_text_sha256": "task-sha",
        "current_tool_name": "execute_additive_plan",
        "constrained_tool_name": "submit_required_operation_content",
        "obligations": [
            {
                "id": "server_surface",
                "family": "python_declarations",
                "slot": "existing:0",
                "operation": "python_declaration",
                "constrained_fields": ["content"],
            },
            {
                "id": "navigation_integration",
                "family": "replacements",
                "slot": "existing:1",
                "operation": "replacement",
                "constrained_fields": ["before", "after"],
            },
            {
                "id": "ui_surface",
                "family": "creations",
                "slot": "create:0",
                "operation": "creation",
                "constrained_fields": ["content"],
            },
        ],
    }

    model = {
        "name": "synthetic",
        "model": "synthetic",
        "temperature": 0.0,
        "max_tokens": 128,
    }

    current_body, current_mapping = mod.build_request(
        fixture,
        ablation,
        model,
        "current",
    )
    assert current_mapping == {}
    assert len(current_body["tools"]) == 1
    assert (
        current_body["tools"][0]["function"]["name"]
        == "execute_additive_plan"
    )
    assert current_body["tool_choice"] == "auto"

    constrained_body, mapping = mod.build_request(
        fixture,
        ablation,
        model,
        "constrained",
    )
    assert len(constrained_body["tools"]) == 1
    assert (
        constrained_body["tools"][0]["function"]["name"]
        == "submit_required_operation_content"
    )
    assert set(mapping) == {
        "server_surface",
        "navigation_integration",
        "ui_surface",
    }
    assert constrained_body["tool_choice"]["function"]["name"] == (
        "submit_required_operation_content"
    )

    bad_current = {
        "python_declarations": [
            {"slot": "existing:0", "content": "server"}
        ],
        "replacements": [],
        "creations": [],
    }
    satisfied, missing = mod.current_coverage(
        bad_current,
        ablation,
    )
    assert satisfied == ["server_surface"]
    assert missing == [
        "navigation_integration",
        "ui_surface",
    ]

    empty_content_current = {
        "python_declarations": [
            {"slot": "existing:0", "content": "   "}
        ],
        "replacements": [
            {
                "slot": "existing:1",
                "before": "old",
                "after": "",
            }
        ],
        "creations": [
            {"slot": "create:0", "content": ""}
        ],
    }
    satisfied, missing = mod.current_coverage(
        empty_content_current,
        ablation,
    )
    assert satisfied == []
    assert missing == [
        "server_surface",
        "navigation_integration",
        "ui_surface",
    ]

    good_current = {
        "python_declarations": [
            {"slot": "existing:0", "content": "server"}
        ],
        "replacements": [
            {
                "slot": "existing:1",
                "before": "old",
                "after": "new",
            }
        ],
        "creations": [
            {"slot": "create:0", "content": "ui"}
        ],
    }
    satisfied, missing = mod.current_coverage(
        good_current,
        ablation,
    )
    assert len(satisfied) == 3
    assert missing == []

    constrained_args = {
        mapping["server_surface"]: {
            "content": "server",
        },
        mapping["navigation_integration"]: {
            "before": "old",
            "after": "new",
        },
        mapping["ui_surface"]: {
            "content": "ui",
        },
    }
    satisfied, missing = mod.constrained_coverage(
        constrained_args,
        ablation,
        mapping,
    )
    assert len(satisfied) == 3
    assert missing == []

    response = {
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "name": "execute_additive_plan",
                                "arguments": json.dumps(good_current),
                            },
                        },
                    ],
                },
            },
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
        },
        "timings": {
            "prompt_per_second": 50.0,
            "predicted_per_second": 4.0,
        },
    }

    parsed, meta = mod.parse_tool_call(
        response,
        "execute_additive_plan",
    )
    assert parsed == good_current
    assert meta["tool_call_status"] == "parsed"

    assert mod.normalize_messages(
        raw_request["system"],
        raw_request["messages"],
    ) == [
        {"role": "system", "content": "base-system"},
        {"role": "system", "content": "bounded-capsule"},
        {"role": "user", "content": "perform task"},
    ]

    normalized_tools = mod.normalize_tools(raw_request["tools"])
    assert len(normalized_tools) == 1
    assert normalized_tools[0]["type"] == "function"

    with tempfile.TemporaryDirectory(prefix="model-viability-gate-") as tmp:
        fixture_path = Path(tmp) / "fixture.json"
        spec_path = Path(tmp) / "spec.json"
        mod.write_json(fixture_path, fixture)
        mod.write_json(spec_path, ablation)

        class Args:
            pass

        args = Args()
        args.fixture = str(fixture_path)
        args.spec = str(spec_path)
        rc = mod.inspect_fixture(args)
        assert rc == 0

    assert mod.CAPTURE_CONTROL_PROTOCOL == "model-viability-capture-control-v1"
    assert str(mod.CAPTURE_CONTROL_FILE).endswith("model-viability-capture-control.json")

    print("PASS model viability fixture identity")
    print("PASS current ABI replay normalization")
    print("PASS constrained ABI is benchmark-only topology removal")
    print("PASS current ABI obligation coverage requires topology + nonempty content")
    print("PASS constrained ABI requires every content hole")
    print("PASS tool-call parser")
    print("PASS task-local capture control contract")
    print("PASS network-free CI gate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
