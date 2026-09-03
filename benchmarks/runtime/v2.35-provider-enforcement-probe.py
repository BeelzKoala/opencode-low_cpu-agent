#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
from urllib.request import Request, urlopen


def post(url: str, body: dict, timeout: int) -> dict:
    request = Request(
        url,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(body).encode("utf-8"),
    )
    started = time.monotonic()
    with urlopen(request, timeout=timeout) as response:
        value = json.loads(response.read().decode("utf-8", errors="replace"))
    value["_elapsed_s"] = round(time.monotonic() - started, 3)
    return value


def required_probe(base: str, model: str, timeout: int) -> dict:
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": "Fill the already-selected action arguments. Do not explain.",
            }
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "selected_action",
                    "description": "Already selected deterministic action.",
                    "parameters": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "value": {"type": "string", "enum": ["ok"]}
                        },
                        "required": ["value"],
                    },
                },
            }
        ],
        "tool_choice": "required",
        "temperature": 0,
        "max_tokens": 64,
    }
    value = post(base.rstrip("/") + "/v1/chat/completions", body, timeout)
    choice = (value.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    calls = message.get("tool_calls") or []
    ok = (
        len(calls) == 1
        and calls[0].get("function", {}).get("name") == "selected_action"
    )
    return {
        "mode": "required_singleton_tool",
        "ok": ok,
        "elapsed_s": value.get("_elapsed_s"),
        "finish_reason": choice.get("finish_reason"),
        "tool_calls": calls,
        "content": message.get("content"),
    }


def json_probe(base: str, model: str, timeout: int) -> dict:
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"value": {"type": "string", "enum": ["ok"]}},
        "required": ["value"],
    }
    body = {
        "model": model,
        "messages": [
            {"role": "user", "content": "Return the object required by the schema."}
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "selected_action_arguments",
                "strict": True,
                "schema": schema,
            },
        },
        "temperature": 0,
        "max_tokens": 64,
    }
    value = post(base.rstrip("/") + "/v1/chat/completions", body, timeout)
    choice = (value.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content")
    parsed = None
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except Exception:
            pass
    return {
        "mode": "json_schema",
        "ok": parsed == {"value": "ok"},
        "elapsed_s": value.get("_elapsed_s"),
        "finish_reason": choice.get("finish_reason"),
        "content": content,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--model", default="north-mini-code-local")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--mode", choices=["required", "json", "both"], default="required")
    args = parser.parse_args()

    rows = []
    if args.mode in {"required", "both"}:
        rows.append(required_probe(args.base, args.model, args.timeout))
    if args.mode in {"json", "both"}:
        rows.append(json_probe(args.base, args.model, args.timeout))

    print(json.dumps({"protocol": "provider-enforcement-probe-v1", "results": rows}, indent=2, ensure_ascii=False))
    if not all(row["ok"] for row in rows):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
