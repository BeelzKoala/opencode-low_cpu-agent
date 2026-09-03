#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


STARTER = '''\
from __future__ import annotations

from datetime import date


def summarize_orders(
    rows: list[dict[str, object]],
    start_date: str,
    end_date: str,
) -> list[dict[str, object]]:
    """
    Summarize non-cancelled orders inside an inclusive date range.

    TODO: implement.
    """
    raise NotImplementedError
'''


TASK = """\
Modify the supplied Python module.

Implement summarize_orders(rows, start_date, end_date).

Requirements:

1. start_date and end_date are ISO calendar dates in YYYY-MM-DD form.
   Parse them with normal Python date semantics.
   Raise ValueError if either date is invalid or start_date > end_date.

2. Every input row has:
   - "date": ISO date string
   - "sku": string
   - "quantity": integer
   - "unit_price": integer
   - "cancelled": boolean

3. Ignore cancelled rows.

4. Ignore rows whose date is outside the inclusive [start_date, end_date] range.

5. Group remaining rows by sku.

6. For each sku calculate:
   - quantity: sum of quantity
   - revenue: sum of quantity * unit_price

7. Return a list of dictionaries with exactly these keys:
   - "sku"
   - "quantity"
   - "revenue"

8. Sort the result by:
   - revenue descending
   - sku ascending when revenue is equal

9. Do not mutate rows or any dictionary contained in rows.

10. Use only the Python standard library.

Return the complete replacement contents of candidate.py.
Do not return an explanation.
"""


HIDDEN_TESTS = r'''\
import copy
import unittest

from candidate import summarize_orders


class SummarizeOrdersTests(unittest.TestCase):
    def test_groups_filters_and_sorts(self):
        rows = [
            {
                "date": "2026-08-01",
                "sku": "B",
                "quantity": 2,
                "unit_price": 10,
                "cancelled": False,
            },
            {
                "date": "2026-08-02",
                "sku": "A",
                "quantity": 1,
                "unit_price": 50,
                "cancelled": False,
            },
            {
                "date": "2026-08-03",
                "sku": "B",
                "quantity": 3,
                "unit_price": 10,
                "cancelled": False,
            },
            {
                "date": "2026-08-03",
                "sku": "C",
                "quantity": 100,
                "unit_price": 100,
                "cancelled": True,
            },
            {
                "date": "2026-07-31",
                "sku": "OUT",
                "quantity": 500,
                "unit_price": 500,
                "cancelled": False,
            },
        ]

        self.assertEqual(
            summarize_orders(rows, "2026-08-01", "2026-08-03"),
            [
                {"sku": "A", "quantity": 1, "revenue": 50},
                {"sku": "B", "quantity": 5, "revenue": 50},
            ],
        )

    def test_range_is_inclusive(self):
        rows = [
            {
                "date": "2026-01-01",
                "sku": "A",
                "quantity": 2,
                "unit_price": 7,
                "cancelled": False,
            },
            {
                "date": "2026-01-31",
                "sku": "A",
                "quantity": 3,
                "unit_price": 7,
                "cancelled": False,
            },
            {
                "date": "2026-02-01",
                "sku": "A",
                "quantity": 100,
                "unit_price": 7,
                "cancelled": False,
            },
        ]

        self.assertEqual(
            summarize_orders(rows, "2026-01-01", "2026-01-31"),
            [{"sku": "A", "quantity": 5, "revenue": 35}],
        )

    def test_empty_result(self):
        rows = [
            {
                "date": "2026-03-10",
                "sku": "A",
                "quantity": 1,
                "unit_price": 9,
                "cancelled": True,
            },
        ]

        self.assertEqual(
            summarize_orders(rows, "2026-03-01", "2026-03-31"),
            [],
        )

    def test_equal_revenue_uses_sku_order(self):
        rows = [
            {
                "date": "2026-05-01",
                "sku": "Z",
                "quantity": 2,
                "unit_price": 5,
                "cancelled": False,
            },
            {
                "date": "2026-05-01",
                "sku": "A",
                "quantity": 1,
                "unit_price": 10,
                "cancelled": False,
            },
        ]

        self.assertEqual(
            summarize_orders(rows, "2026-05-01", "2026-05-01"),
            [
                {"sku": "A", "quantity": 1, "revenue": 10},
                {"sku": "Z", "quantity": 2, "revenue": 10},
            ],
        )

    def test_invalid_start_date(self):
        with self.assertRaises(ValueError):
            summarize_orders([], "2026-02-30", "2026-03-01")

    def test_invalid_end_date(self):
        with self.assertRaises(ValueError):
            summarize_orders([], "2026-03-01", "garbage")

    def test_reversed_range(self):
        with self.assertRaises(ValueError):
            summarize_orders([], "2026-04-02", "2026-04-01")

    def test_input_is_not_mutated(self):
        rows = [
            {
                "date": "2026-06-01",
                "sku": "A",
                "quantity": 4,
                "unit_price": 3,
                "cancelled": False,
            },
        ]

        before = copy.deepcopy(rows)

        summarize_orders(rows, "2026-06-01", "2026-06-30")

        self.assertEqual(rows, before)


if __name__ == "__main__":
    unittest.main()
'''


def request_candidate(
    *,
    base_url: str,
    model: str,
    timeout: float,
) -> tuple[str, dict[str, object], float]:
    schema = {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
            },
        },
        "required": ["code"],
        "additionalProperties": False,
    }

    prompt = (
        TASK
        + "\n\n"
        + "Current candidate.py:\n\n"
        + STARTER
    )

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are editing one Python source file. "
                    "Solve the requested coding task directly. "
                    "Return only the requested structured result."
                ),
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        "temperature": 0.0,
        "max_tokens": 2048,
        "stream": False,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "coding_candidate",
                "strict": True,
                "schema": schema,
            },
        },
    }

    req = urllib.request.Request(
        base_url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    started = time.monotonic()

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"HTTP {exc.code}: {body}"
        ) from exc

    wall = time.monotonic() - started

    response_obj = json.loads(raw)

    choices = response_obj.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("response contains no choices")

    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise RuntimeError("response contains no message")

    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        reasoning = message.get("reasoning_content")
        raise RuntimeError(
            "final content is empty; "
            f"reasoning_present={bool(reasoning)}"
        )

    decoded = json.loads(content)

    code = decoded.get("code")
    if not isinstance(code, str) or not code.strip():
        raise RuntimeError("structured result contains no code")

    return code, response_obj, wall


def run_gate(code: str) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory(
        prefix="koalik-model-coding-sanity-"
    ) as tmp:
        root = Path(tmp)

        candidate = root / "candidate.py"
        tests = root / "test_candidate.py"

        candidate.write_text(code, encoding="utf-8")
        tests.write_text(HIDDEN_TESTS, encoding="utf-8")

        compile_result = subprocess.run(
            [
                sys.executable,
                "-m",
                "py_compile",
                str(candidate),
            ],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=10,
        )

        if compile_result.returncode != 0:
            return (
                False,
                "COMPILE_FAIL\n" + compile_result.stdout,
            )

        test_result = subprocess.run(
            [
                sys.executable,
                "-m",
                "unittest",
                "-v",
                "test_candidate.py",
            ],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=20,
        )

        if test_result.returncode != 0:
            return (
                False,
                "TEST_FAIL\n" + test_result.stdout,
            )

        return (
            True,
            "PASS\n" + test_result.stdout,
        )


def main() -> int:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8080",
    )
    parser.add_argument(
        "--model",
        required=True,
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=180.0,
    )
    parser.add_argument(
        "--save-candidate",
        type=Path,
    )

    args = parser.parse_args()

    print("=== MODEL CODING SANITY v1 ===")
    print(f"model={args.model}")
    print("abstractions=none")
    print("model_calls=1")
    print()

    try:
        code, response, wall = request_candidate(
            base_url=args.base_url,
            model=args.model,
            timeout=args.timeout,
        )
    except Exception as exc:
        print(
            f"FAIL inference error={type(exc).__name__}: {exc}"
        )
        return 1

    choice = response["choices"][0]
    message = choice.get("message") or {}
    usage = response.get("usage") or {}

    print(f"inference_wall_s={wall:.3f}")
    print(
        "finish_reason="
        + repr(choice.get("finish_reason"))
    )
    print(
        "reasoning_present="
        + str(bool(message.get("reasoning_content")))
    )
    print(
        "prompt_tokens="
        + str(usage.get("prompt_tokens"))
    )
    print(
        "completion_tokens="
        + str(usage.get("completion_tokens"))
    )

    if args.save_candidate is not None:
        args.save_candidate.write_text(
            code,
            encoding="utf-8",
        )
        print(
            "candidate="
            + str(args.save_candidate)
        )

    print()
    print("=== CANDIDATE ===")
    print(code)
    print("=== END CANDIDATE ===")
    print()

    passed, detail = run_gate(code)

    print("=== DETERMINISTIC GATE ===")
    print(detail)

    if not passed:
        print()
        print("VERDICT=MODEL_CODING_FAIL")
        return 1

    print()
    print("VERDICT=MODEL_CODING_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
