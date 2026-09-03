#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import hashlib
import html.parser
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import textwrap
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

PROTOCOL = "edit-surface-qualification-v1.1"
DEFAULT_ATTESTATION = Path.home() / ".cache/opencode-lowcpu/llguidance-attestation-v2.json"


def sha256_json(value: Any) -> str:
    data = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class Surface:
    name: str
    prompt: str
    schema: dict[str, Any]
    validator: Callable[[dict[str, Any]], tuple[bool, str, dict[str, Any]]]
    max_tokens: int


class RssSampler:
    def __init__(self, pid: int | None) -> None:
        self.pid = pid
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.max_rss_kib: int | None = None

    def _read_rss(self) -> int | None:
        if not self.pid:
            return None
        path = Path(f"/proc/{self.pid}/status")
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
        except (OSError, ValueError):
            return None
        return None

    def _loop(self) -> None:
        while not self._stop.is_set():
            rss = self._read_rss()
            if rss is not None:
                if self.max_rss_kib is None or rss > self.max_rss_kib:
                    self.max_rss_kib = rss
            self._stop.wait(0.05)

    def __enter__(self) -> "RssSampler":
        if self.pid:
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=0.5)
        rss = self._read_rss()
        if rss is not None:
            if self.max_rss_kib is None or rss > self.max_rss_kib:
                self.max_rss_kib = rss


def load_server_pid(explicit: int | None, attestation: Path) -> int | None:
    if explicit:
        return explicit
    try:
        data = json.loads(attestation.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    value = data.get("server_pid")
    return value if isinstance(value, int) and value > 0 else None


def post_json(url: str, payload: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail[:2000]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"provider connection failed: {exc}") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"provider returned non-JSON: {body[:2000]}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("provider response is not an object")
    return parsed


def extract_tool_args(response: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    try:
        message = response["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None, "missing_choices_message"

    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or len(tool_calls) != 1:
        return None, "expected_exactly_one_tool_call"

    call = tool_calls[0]
    try:
        fn = call["function"]
        if fn.get("name") != "submit_edit":
            return None, "wrong_tool_name"
        arguments = fn["arguments"]
    except (KeyError, TypeError):
        return None, "malformed_tool_call"

    if isinstance(arguments, dict):
        return arguments, "ok"
    if not isinstance(arguments, str):
        return None, "tool_arguments_not_string_or_object"

    try:
        decoded = json.loads(arguments)
    except json.JSONDecodeError:
        return None, "tool_arguments_invalid_json"
    if not isinstance(decoded, dict):
        return None, "tool_arguments_not_object"
    return decoded, "ok"


def _trim_blank_edges(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def _leading_spaces(line: str) -> int | None:
    prefix = line[: len(line) - len(line.lstrip())]
    if "\t" in prefix:
        return None
    if any(ch != " " for ch in prefix):
        return None
    return len(prefix)


def _tail_base_dedent(text: str) -> str | None:
    lines = text.splitlines()
    significant = [index for index, line in enumerate(lines) if line.strip()]
    if len(significant) < 2:
        return None

    first = significant[0]
    first_indent = _leading_spaces(lines[first])
    if first_indent is None:
        return None

    tail_indents: list[int] = []
    for index in significant[1:]:
        indent = _leading_spaces(lines[index])
        if indent is None:
            return None
        tail_indents.append(indent)

    if not tail_indents:
        return None

    tail_base = min(tail_indents)
    delta = tail_base - first_indent
    if delta <= 0:
        return None

    normalized = list(lines)
    for index in significant[1:]:
        line = normalized[index]
        indent = _leading_spaces(line)
        assert indent is not None
        if indent < delta:
            return None
        normalized[index] = line[delta:]

    candidate = "\n".join(normalized)
    return candidate if candidate != text else None


def _python_body_candidates(body: str) -> list[tuple[str, str]]:
    raw = _trim_blank_edges(body)
    candidates: list[tuple[str, str]] = [("raw", raw)]

    dedented = textwrap.dedent(raw)
    if dedented != raw:
        candidates.append(("common_dedent", dedented))

    tail = _tail_base_dedent(raw)
    if tail is not None and all(candidate != tail for _, candidate in candidates):
        candidates.append(("tail_base_dedent", tail))

    return candidates


def _parse_python_body_candidate(
    body: str,
) -> tuple[ast.Module | None, ast.FunctionDef | None, SyntaxError | None]:
    try:
        tree = ast.parse(
            "def generated(rows):\n" + textwrap_indent(body, "    ")
        )
    except SyntaxError as exc:
        return None, None, exc

    if not tree.body or not isinstance(tree.body[0], ast.FunctionDef):
        return tree, None, None
    return tree, tree.body[0], None


def _python_body_semantic_fingerprint(fn: ast.FunctionDef) -> str:
    module = ast.Module(body=fn.body, type_ignores=[])
    return ast.dump(module, annotate_fields=True, include_attributes=False)


def canonicalize_python_body(
    body: str,
) -> tuple[bool, str | None, str, dict[str, Any]]:
    if not isinstance(body, str) or not body.strip():
        return False, None, "python_body_empty", {}

    candidates = _python_body_candidates(body)
    valid: list[tuple[str, str, ast.FunctionDef, str]] = []
    raw_syntax_error: SyntaxError | None = None

    for kind, candidate in candidates:
        _, fn, syntax_error = _parse_python_body_candidate(candidate)
        if kind == "raw":
            raw_syntax_error = syntax_error
        if syntax_error is not None or fn is None:
            continue

        valid.append(
            (
                kind,
                candidate,
                fn,
                _python_body_semantic_fingerprint(fn),
            )
        )

    if not valid:
        detail: dict[str, Any] = {
            "normalization_candidate_count": len(candidates),
            "parseable_candidate_count": 0,
            "semantic_variant_count": 0,
        }
        if raw_syntax_error is not None:
            detail["lineno"] = raw_syntax_error.lineno
            detail["offset"] = raw_syntax_error.offset
        return False, None, "python_body_syntax_invalid", detail

    semantic_variants = {fingerprint for _, _, _, fingerprint in valid}
    if len(semantic_variants) != 1:
        return False, None, "python_body_indentation_ambiguous", {
            "normalization_candidate_count": len(candidates),
            "parseable_candidate_count": len(valid),
            "semantic_variant_count": len(semantic_variants),
            "parseable_normalizations": [kind for kind, _, _, _ in valid],
        }

    preference = {
        "raw": 0,
        "common_dedent": 1,
        "tail_base_dedent": 2,
    }
    selected = min(valid, key=lambda row: preference[row[0]])
    kind, canonical, fn, _ = selected

    return True, canonical, "ok", {
        "normalization_applied": kind != "raw",
        "normalization_kind": kind,
        "normalization_candidate_count": len(candidates),
        "parseable_candidate_count": len(valid),
        "semantic_variant_count": 1,
        "ast_nodes": sum(1 for _ in ast.walk(fn)),
    }


def validate_python_body_text(body: str) -> tuple[bool, str, dict[str, Any]]:
    ok, canonical_body, reason, canonical_detail = canonicalize_python_body(body)
    if not ok or canonical_body is None:
        return False, reason, canonical_detail

    _, fn, syntax_error = _parse_python_body_candidate(canonical_body)
    if syntax_error is not None or fn is None:
        return False, "python_wrapper_internal_error", canonical_detail

    banned_nodes = (
        ast.Import,
        ast.ImportFrom,
        ast.Global,
        ast.Nonlocal,
        ast.FunctionDef,
        ast.AsyncFunctionDef,
        ast.ClassDef,
    )
    for node in fn.body:
        if isinstance(node, banned_nodes):
            return False, "python_body_contains_owned_or_module_structure", {
                **canonical_detail,
                "node": type(node).__name__,
            }

    banned_calls = {"eval", "exec", "compile", "open", "__import__", "input"}
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in banned_calls:
                return False, "python_body_unsafe_builtin", {
                    **canonical_detail,
                    "name": node.func.id,
                }
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return False, "python_body_dunder_access", {
                **canonical_detail,
                "attr": node.attr,
            }

    script = f"""
import json

def generated(rows):
{textwrap_indent(canonical_body, "    ")}

cases = [
    (
        [
            {{"seller": "a", "amount": 10, "status": "paid"}},
            {{"seller": "a", "amount": 4, "status": "cancelled"}},
            {{"seller": "b", "amount": 7, "status": "paid"}},
            {{"seller": "a", "amount": 2, "status": "paid"}},
        ],
        {{"a": 12, "b": 7}},
    ),
    (
        [
            {{"seller": "x", "amount": 3, "status": "paid"}},
            {{"seller": "x", "status": "paid"}},
            {{"seller": "y", "amount": 9, "status": "pending"}},
        ],
        {{"x": 3}},
    ),
    ([], {{}}),
]

for rows, expected in cases:
    before = json.dumps(rows, sort_keys=True)
    actual = generated(rows)
    after = json.dumps(rows, sort_keys=True)
    if actual != expected:
        raise SystemExit("wrong_result:" + repr(actual) + " expected=" + repr(expected))
    if before != after:
        raise SystemExit("input_mutated")

print("PASS")
"""
    with tempfile.TemporaryDirectory(prefix="koalik-edit-surface-python-") as tmp:
        path = Path(tmp) / "candidate.py"
        path.write_text(script, encoding="utf-8")
        try:
            proc = subprocess.run(
                [os.environ.get("PYTHON", sys.executable), "-S", str(path)],
                cwd=tmp,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=2.0,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return False, "python_body_runtime_timeout", canonical_detail
    if proc.returncode != 0:
        return False, "python_body_semantics_failed", {
            **canonical_detail,
            "stderr": proc.stderr[-800:],
            "stdout": proc.stdout[-800:],
        }

    return True, "ok", canonical_detail


def textwrap_indent(text: str, prefix: str) -> str:
    lines = text.splitlines()
    if not lines:
        return prefix + "pass"
    return "\n".join(prefix + line for line in lines)


class MarkupProbe(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.starttags: list[tuple[str, dict[str, str | None]]] = []
        self.endtags: list[str] = []
        self.data_parts: list[str] = []
        self.doctypes = 0

    def handle_decl(self, decl: str) -> None:
        if decl.lower().startswith("doctype"):
            self.doctypes += 1

    def handle_starttag(self, tag: str, attrs) -> None:
        self.starttags.append((tag.lower(), {k.lower(): v for k, v in attrs}))

    def handle_endtag(self, tag: str) -> None:
        self.endtags.append(tag.lower())

    def handle_data(self, data: str) -> None:
        self.data_parts.append(data)


def parse_markup(text: str) -> MarkupProbe:
    parser = MarkupProbe()
    parser.feed(text)
    parser.close()
    return parser


def validate_fragment_text(fragment: str) -> tuple[bool, str, dict[str, Any]]:
    if not isinstance(fragment, str) or not fragment.strip():
        return False, "markup_fragment_empty", {}

    lower = fragment.lower()
    forbidden = ["<!doctype", "<html", "<head", "<body", "{% extends"]
    hit = next((token for token in forbidden if token in lower), None)
    if hit:
        return False, "markup_fragment_document_wrapper", {"token": hit}

    try:
        parsed = parse_markup(fragment)
    except Exception as exc:
        return False, "markup_fragment_parse_failed", {"error": str(exc)}

    li_count = sum(1 for tag, _ in parsed.starttags if tag == "li")
    anchors = [attrs for tag, attrs in parsed.starttags if tag == "a"]
    text = " ".join(" ".join(parsed.data_parts).split())

    if li_count != 1:
        return False, "markup_fragment_li_cardinality", {"li_count": li_count}
    if len(anchors) != 1:
        return False, "markup_fragment_anchor_cardinality", {"anchor_count": len(anchors)}
    if anchors[0].get("href") != "/reports":
        return False, "markup_fragment_wrong_href", {"href": anchors[0].get("href")}
    if "Reports" not in text:
        return False, "markup_fragment_missing_label", {"text": text[:200]}

    return True, "ok", {"li_count": li_count, "anchor_count": len(anchors)}


def validate_document_text(document: str) -> tuple[bool, str, dict[str, Any]]:
    if not isinstance(document, str) or not document.strip():
        return False, "markup_document_empty", {}

    try:
        parsed = parse_markup(document)
    except Exception as exc:
        return False, "markup_document_parse_failed", {"error": str(exc)}

    tags = [tag for tag, _ in parsed.starttags]
    attrs_by_tag: dict[str, list[dict[str, str | None]]] = {}
    for tag, attrs in parsed.starttags:
        attrs_by_tag.setdefault(tag, []).append(attrs)

    for required in ["html", "head", "title", "body", "form", "input", "select", "button"]:
        if required not in tags:
            return False, "markup_document_missing_required_tag", {"tag": required}

    forms = attrs_by_tag.get("form", [])
    if not any((attrs.get("method") or "").lower() == "post" for attrs in forms):
        return False, "markup_document_form_method", {}

    inputs = attrs_by_tag.get("input", [])
    if not any(
        attrs.get("name") == "report_date" and (attrs.get("type") or "").lower() == "date"
        for attrs in inputs
    ):
        return False, "markup_document_missing_report_date", {}

    selects = attrs_by_tag.get("select", [])
    if not any(attrs.get("name") == "report_type" for attrs in selects):
        return False, "markup_document_missing_report_type", {}

    options = attrs_by_tag.get("option", [])
    values = {attrs.get("value") for attrs in options}
    if not {"category", "seller"}.issubset(values):
        return False, "markup_document_missing_report_type_values", {
            "values": sorted(v for v in values if isinstance(v, str)),
        }

    lower = document.lower()
    if '""" +' in document or ".njoin(" in document or "f\"" in document:
        return False, "markup_document_python_string_building", {}

    return True, "ok", {
        "tag_count": len(tags),
        "doctype_count": parsed.doctypes,
    }


def validate_python_native(args: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    if set(args) != {"body"}:
        return False, "python_native_argument_shape", {"keys": sorted(args)}
    return validate_python_body_text(args["body"])


def validate_fragment_native(args: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    if set(args) != {"fragment"}:
        return False, "fragment_native_argument_shape", {"keys": sorted(args)}
    return validate_fragment_text(args["fragment"])


def validate_document_native(args: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    if set(args) != {"document"}:
        return False, "document_native_argument_shape", {"keys": sorted(args)}
    return validate_document_text(args["document"])


def validate_r26_batch(args: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    holes = args.get("holes")
    if not isinstance(holes, dict) or set(holes) != {"h0", "h1", "h2"}:
        return False, "r26_holes_shape", {
            "keys": sorted(holes) if isinstance(holes, dict) else None,
        }

    failures: list[dict[str, Any]] = []

    h0 = holes.get("h0")
    if not isinstance(h0, dict):
        failures.append({"hole": "h0", "reason": "python_hole_not_object"})
    else:
        declarations = h0.get("python_declarations")
        if not isinstance(declarations, list) or len(declarations) != 1:
            failures.append({
                "hole": "h0",
                "reason": "python_declaration_cardinality",
                "count": len(declarations) if isinstance(declarations, list) else None,
            })
        else:
            decl = declarations[0]
            if not isinstance(decl, dict):
                failures.append({"hole": "h0", "reason": "python_declaration_not_object"})
            else:
                if decl.get("declaration_kind") != "function":
                    failures.append({"hole": "h0", "reason": "wrong_declaration_kind"})
                if decl.get("name") != "summarize_paid":
                    failures.append({"hole": "h0", "reason": "wrong_declaration_name"})
                if decl.get("signature") != "(rows)":
                    failures.append({
                        "hole": "h0",
                        "reason": "signature_not_signature_only",
                        "signature": decl.get("signature"),
                    })
                statements = decl.get("python_statements")
                if not isinstance(statements, list) or not statements or not all(
                    isinstance(item, str) and item.strip() for item in statements
                ):
                    failures.append({"hole": "h0", "reason": "python_statements_shape"})
                else:
                    ok, reason, detail = validate_python_body_text("\n".join(statements))
                    if not ok:
                        failures.append({
                            "hole": "h0",
                            "reason": reason,
                            "detail": detail,
                        })

    h1 = holes.get("h1")
    fragment = h1.get("markup_fragment") if isinstance(h1, dict) else None
    ok, reason, detail = validate_fragment_text(fragment)
    if not ok:
        failures.append({"hole": "h1", "reason": reason, "detail": detail})

    h2 = holes.get("h2")
    document = h2.get("markup_document") if isinstance(h2, dict) else None
    ok, reason, detail = validate_document_text(document)
    if not ok:
        failures.append({"hole": "h2", "reason": reason, "detail": detail})

    if failures:
        return False, "r26_structured_batch_failed", {
            "failure_count": len(failures),
            "failures": failures,
        }

    return True, "ok", {"hole_count": 3}


def surfaces() -> dict[str, Surface]:
    python_schema = {
        "type": "object",
        "properties": {
            "body": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1800,
            },
        },
        "required": ["body"],
        "additionalProperties": False,
    }

    fragment_schema = {
        "type": "object",
        "properties": {
            "fragment": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1000,
            },
        },
        "required": ["fragment"],
        "additionalProperties": False,
    }

    document_schema = {
        "type": "object",
        "properties": {
            "document": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2500,
            },
        },
        "required": ["document"],
        "additionalProperties": False,
    }

    r26_schema = {
        "type": "object",
        "properties": {
            "holes": {
                "type": "object",
                "properties": {
                    "h0": {
                        "type": "object",
                        "properties": {
                            "python_declarations": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 1,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "declaration_kind": {
                                            "type": "string",
                                            "enum": ["function"],
                                        },
                                        "name": {
                                            "type": "string",
                                            "enum": ["summarize_paid"],
                                        },
                                        "signature": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 40,
                                        },
                                        "python_statements": {
                                            "type": "array",
                                            "minItems": 1,
                                            "maxItems": 20,
                                            "items": {
                                                "type": "string",
                                                "minLength": 1,
                                                "maxLength": 500,
                                            },
                                        },
                                    },
                                    "required": [
                                        "declaration_kind",
                                        "name",
                                        "signature",
                                        "python_statements",
                                    ],
                                    "additionalProperties": False,
                                },
                            },
                        },
                        "required": ["python_declarations"],
                        "additionalProperties": False,
                    },
                    "h1": {
                        "type": "object",
                        "properties": {
                            "markup_fragment": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000,
                            },
                        },
                        "required": ["markup_fragment"],
                        "additionalProperties": False,
                    },
                    "h2": {
                        "type": "object",
                        "properties": {
                            "markup_document": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2500,
                            },
                        },
                        "required": ["markup_document"],
                        "additionalProperties": False,
                    },
                },
                "required": ["h0", "h1", "h2"],
                "additionalProperties": False,
            },
        },
        "required": ["holes"],
        "additionalProperties": False,
    }

    common = (
        "Return exactly one submit_edit tool call and no prose. "
        "Do not repeat compiler-owned wrappers when asked for a body or fragment. "
    )

    return {
        "python_body_native": Surface(
            name="python_body_native",
            prompt=common + """
Fill only the body of this existing Python function:

def summarize_paid(rows):
    <FILL_BODY>

Required behavior:
- rows is a list of dictionaries.
- Include only rows whose status is exactly "paid".
- Return a dict mapping seller to the integer sum of amount.
- A paid row with a missing amount contributes 0.
- Do not mutate rows.
- Do not emit def/class/import/from/decorator lines.
- The body must be directly insertable under the existing def.
""".strip(),
            schema=python_schema,
            validator=validate_python_native,
            max_tokens=700,
        ),
        "markup_fragment_native": Surface(
            name="markup_fragment_native",
            prompt=common + """
Fill only the marked navigation fragment:

<nav>
  <ul id="main-nav">
    <li><a href="/">Home</a></li>
    <!-- MODEL_FRAGMENT -->
  </ul>
</nav>

Required result:
- exactly one li containing exactly one anchor;
- href must be /reports;
- visible anchor text must be Reports;
- return only the fragment replacing MODEL_FRAGMENT;
- no doctype, html, head, body, template inheritance, or full document.
""".strip(),
            schema=fragment_schema,
            validator=validate_fragment_native,
            max_tokens=350,
        ),
        "markup_document_native": Surface(
            name="markup_document_native",
            prompt=common + """
Create a complete standalone HTML report-request page.

Requirements:
- html, head, title and body;
- a POST form;
- input type=date name=report_date;
- select name=report_type;
- options value=category and value=seller;
- submit button;
- plain HTML only: no Python source, string concatenation, f-strings, or pseudo-code.
""".strip(),
            schema=document_schema,
            validator=validate_document_native,
            max_tokens=900,
        ),
        "r26_structured_batch": Surface(
            name="r26_structured_batch",
            prompt=common + """
Complete three compiler-owned holes in one call.

h0 is an existing Python function declaration:
- declaration_kind MUST be function.
- name MUST be summarize_paid.
- signature MUST be exactly (rows), not a full def.
- python_statements are ONLY the function body statements.
- behavior: include rows with status == "paid"; return seller -> integer sum(amount);
  missing paid amount contributes 0; do not mutate rows.
- do not put imports, decorators, def/class wrappers in python_statements.

h1 is ONLY a navigation fragment for this host:
<nav><ul><li><a href="/">Home</a></li><!-- h1 --></ul></nav>
It must be exactly one li with one anchor href=/reports and text Reports.
No full document wrapper.

h2 is a complete standalone HTML page with:
- html/head/title/body;
- POST form;
- date input name=report_date;
- select name=report_type with category and seller options;
- submit button;
- no Python source or pseudo-code.
""".strip(),
            schema=r26_schema,
            validator=validate_r26_batch,
            max_tokens=1800,
        ),
    }


def run_surface(
    *,
    base_url: str,
    model: str,
    surface: Surface,
    timeout_s: float,
    server_pid: int | None,
    save_raw_dir: Path | None,
) -> dict[str, Any]:
    tool = {
        "type": "function",
        "function": {
            "name": "submit_edit",
            "description": "Submit the bounded edit payload.",
            "parameters": surface.schema,
        },
    }

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a bounded code editor. "
                    "Follow the requested edit surface exactly."
                ),
            },
            {"role": "user", "content": surface.prompt},
        ],
        "tools": [tool],
        "tool_choice": {
            "type": "function",
            "function": {"name": "submit_edit"},
        },
        "temperature": 0,
        "top_p": 1,
        "seed": 1,
        "max_tokens": surface.max_tokens,
    }

    started = time.monotonic()
    with RssSampler(server_pid) as rss:
        try:
            response = post_json(
                base_url.rstrip("/") + "/v1/chat/completions",
                payload,
                timeout_s,
            )
            transport_ok = True
            transport_error = None
        except Exception as exc:
            response = {}
            transport_ok = False
            transport_error = str(exc)
    elapsed_ms = round((time.monotonic() - started) * 1000, 2)

    if save_raw_dir is not None:
        save_raw_dir.mkdir(parents=True, exist_ok=True)
        (save_raw_dir / f"{model}__{surface.name}.response.json").write_text(
            json.dumps(response, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (save_raw_dir / f"{model}__{surface.name}.request.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    result: dict[str, Any] = {
        "surface": surface.name,
        "transport_ok": transport_ok,
        "transport_error": transport_error,
        "elapsed_ms": elapsed_ms,
        "max_rss_kib": rss.max_rss_kib,
        "prompt_sha256": hashlib.sha256(surface.prompt.encode("utf-8")).hexdigest(),
        "schema_sha256": sha256_json(surface.schema),
        "qualified": False,
        "reason": None,
        "validator_detail": {},
        "prompt_tokens": None,
        "completion_tokens": None,
        "total_tokens": None,
    }

    if not transport_ok:
        result["reason"] = "transport_failed"
        return result

    usage = response.get("usage")
    if isinstance(usage, dict):
        result["prompt_tokens"] = usage.get("prompt_tokens")
        result["completion_tokens"] = usage.get("completion_tokens")
        result["total_tokens"] = usage.get("total_tokens")

    args, extraction_reason = extract_tool_args(response)
    if args is None:
        result["reason"] = extraction_reason
        return result

    ok, reason, detail = surface.validator(args)
    result["qualified"] = ok
    result["reason"] = reason
    result["validator_detail"] = detail
    result["argument_sha256"] = sha256_json(args)
    return result


def classify_model(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_name = {row["surface"]: row for row in rows}
    atomic_names = [
        "python_body_native",
        "markup_fragment_native",
        "markup_document_native",
    ]
    atomic_failures = [
        name for name in atomic_names
        if name in by_name and not by_name[name]["qualified"]
    ]

    if atomic_failures:
        return {
            "decision": "model_capability_insufficient_atomic",
            "failed_surfaces": atomic_failures,
            "recommended_action": "route_or_replace_model_before_product_changes",
            "batching_qualified": False,
        }

    batch = by_name.get("r26_structured_batch")
    if batch is None:
        return {
            "decision": "atomic_surfaces_qualified_batch_unmeasured",
            "failed_surfaces": [],
            "recommended_action": "run_r26_structured_batch",
            "batching_qualified": None,
        }

    if not batch["qualified"]:
        return {
            "decision": "adaptive_partitioning_candidate",
            "failed_surfaces": ["r26_structured_batch"],
            "recommended_action": (
                "keep_canonical_plan_but_partition_model_calls_by_surface"
            ),
            "batching_qualified": False,
        }

    return {
        "decision": "batched_structured_surface_qualified",
        "failed_surfaces": [],
        "recommended_action": "retain_single_call_batch_for_this_model_profile",
        "batching_qualified": True,
    }


def self_test() -> None:
    ok, reason, _ = validate_python_body_text(
        """
totals = {}
for row in rows:
    if row.get("status") != "paid":
        continue
    seller = row["seller"]
    totals[seller] = totals.get(seller, 0) + int(row.get("amount", 0))
return totals
""".strip()
    )
    assert ok, reason

    north_mini_body = """
result = {}
    for row in rows:
        if row.get("status") == "paid":
            seller = row.get("seller")
            amount = row.get("amount")
            if amount is None:
                amount = 0
            result[seller] = result.get(seller, 0) + amount
    return result
""".strip()
    ok, reason, detail = validate_python_body_text(north_mini_body)
    assert ok, reason
    assert detail["normalization_applied"] is True
    assert detail["normalization_kind"] == "tail_base_dedent"
    assert detail["semantic_variant_count"] == 1

    ok, canonical, reason, detail = canonicalize_python_body(
        "if True:\n    return {}\nreturn {}"
    )
    assert ok, reason
    assert canonical is not None
    assert detail["semantic_variant_count"] == 1

    ok, reason, _ = validate_python_body_text(
        "def inner():\n    return 1\nreturn {}"
    )
    assert not ok and reason == "python_body_contains_owned_or_module_structure"

    ok, reason, _ = validate_fragment_text(
        '<li><a href="/reports">Reports</a></li>'
    )
    assert ok, reason

    ok, reason, _ = validate_fragment_text(
        '<!DOCTYPE html><html><body><li><a href="/reports">Reports</a></li></body></html>'
    )
    assert not ok and reason == "markup_fragment_document_wrapper"

    good_doc = """
<!DOCTYPE html>
<html>
<head><title>Report</title></head>
<body>
<form method="post">
<input type="date" name="report_date">
<select name="report_type">
<option value="category">Category</option>
<option value="seller">Seller</option>
</select>
<button type="submit">Run</button>
</form>
</body>
</html>
""".strip()
    ok, reason, _ = validate_document_text(good_doc)
    assert ok, reason

    bad_doc = good_doc.replace(
        "<title>Report</title>",
        '""" + str(value) + """<title>Report</title>',
    )
    ok, reason, _ = validate_document_text(bad_doc)
    assert not ok and reason == "markup_document_python_string_building"

    batch_args = {
        "holes": {
            "h0": {
                "python_declarations": [{
                    "declaration_kind": "function",
                    "name": "summarize_paid",
                    "signature": "(rows)",
                    "python_statements": [
                        "totals = {}",
                        "for row in rows:",
                        "    if row.get('status') != 'paid':",
                        "        continue",
                        "    seller = row['seller']",
                        "    totals[seller] = totals.get(seller, 0) + int(row.get('amount', 0))",
                        "return totals",
                    ],
                }],
            },
            "h1": {
                "markup_fragment": '<li><a href="/reports">Reports</a></li>',
            },
            "h2": {
                "markup_document": good_doc,
            },
        },
    }
    ok, reason, _ = validate_r26_batch(batch_args)
    assert ok, reason

    broken = json.loads(json.dumps(batch_args))
    broken["holes"]["h0"]["python_declarations"][0]["signature"] = (
        "def summarize_paid(rows):"
    )
    broken["holes"]["h1"]["markup_fragment"] = (
        '<!DOCTYPE html><html><body>bad</body></html>'
    )
    ok, reason, detail = validate_r26_batch(broken)
    assert not ok and reason == "r26_structured_batch_failed"
    assert detail["failure_count"] >= 2

    print(
        "PASS edit-surface-qualification self-test "
        "repo_mutation=false model_calls=0"
    )


def parse_models(value: str) -> list[str]:
    models = [item.strip() for item in value.split(",") if item.strip()]
    if not models:
        raise argparse.ArgumentTypeError("at least one model is required")
    return models


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Qualify model edit surfaces without mutating the product repository."
        )
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument(
        "--models",
        type=parse_models,
        default=["north-mini-code-local"],
        help="comma-separated model aliases",
    )
    parser.add_argument("--timeout-s", type=float, default=300.0)
    parser.add_argument("--server-pid", type=int)
    parser.add_argument(
        "--attestation",
        type=Path,
        default=DEFAULT_ATTESTATION,
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("benchmarks/results/edit-surface-qualification-v1"),
    )
    parser.add_argument(
        "--batch-policy",
        choices=["if-atomics-pass", "always", "never"],
        default="if-atomics-pass",
    )
    parser.add_argument(
        "--save-raw",
        action="store_true",
        help="save request/response JSON under OUT/raw",
    )
    parser.add_argument(
        "--require-qualified",
        action="store_true",
        help="return non-zero unless every requested model qualifies for batch mode",
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    server_pid = load_server_pid(args.server_pid, args.attestation)
    catalog = surfaces()
    args.out.mkdir(parents=True, exist_ok=True)

    profile: dict[str, Any] = {
        "protocol": PROTOCOL,
        "base_url": args.base_url,
        "server_pid": server_pid,
        "batch_policy": args.batch_policy,
        "models": [],
    }

    all_batch_qualified = True

    for model in args.models:
        print(f"=== MODEL {model} ===", flush=True)
        rows: list[dict[str, Any]] = []
        atomic_names = [
            "python_body_native",
            "markup_fragment_native",
            "markup_document_native",
        ]

        for name in atomic_names:
            print(f"+ surface={name}", flush=True)
            row = run_surface(
                base_url=args.base_url,
                model=model,
                surface=catalog[name],
                timeout_s=args.timeout_s,
                server_pid=server_pid,
                save_raw_dir=(args.out / "raw") if args.save_raw else None,
            )
            rows.append(row)
            print(
                f"{'PASS' if row['qualified'] else 'FAIL'} "
                f"surface={name} reason={row['reason']} "
                f"elapsed_ms={row['elapsed_ms']} "
                f"completion_tokens={row['completion_tokens']} "
                f"max_rss_kib={row['max_rss_kib']}",
                flush=True,
            )

        atomics_pass = all(row["qualified"] for row in rows)
        run_batch = (
            args.batch_policy == "always"
            or (
                args.batch_policy == "if-atomics-pass"
                and atomics_pass
            )
        )

        if run_batch:
            name = "r26_structured_batch"
            print(f"+ surface={name}", flush=True)
            row = run_surface(
                base_url=args.base_url,
                model=model,
                surface=catalog[name],
                timeout_s=args.timeout_s,
                server_pid=server_pid,
                save_raw_dir=(args.out / "raw") if args.save_raw else None,
            )
            rows.append(row)
            print(
                f"{'PASS' if row['qualified'] else 'FAIL'} "
                f"surface={name} reason={row['reason']} "
                f"elapsed_ms={row['elapsed_ms']} "
                f"completion_tokens={row['completion_tokens']} "
                f"max_rss_kib={row['max_rss_kib']}",
                flush=True,
            )
        else:
            print(
                "SKIP surface=r26_structured_batch "
                f"policy={args.batch_policy} atomics_pass={atomics_pass}",
                flush=True,
            )

        decision = classify_model(rows)
        all_batch_qualified = all_batch_qualified and (
            decision["decision"] == "batched_structured_surface_qualified"
        )

        model_profile = {
            "model": model,
            "surfaces": rows,
            "decision": decision,
            "model_calls": len(rows),
            "total_elapsed_ms": round(
                sum(float(row["elapsed_ms"]) for row in rows),
                2,
            ),
            "total_completion_tokens": sum(
                int(row["completion_tokens"] or 0) for row in rows
            ),
        }
        profile["models"].append(model_profile)

        print(
            "DECISION "
            f"model={model} "
            f"decision={decision['decision']} "
            f"recommended_action={decision['recommended_action']}",
            flush=True,
        )

    profile["profile_sha256"] = sha256_json(profile)
    output_file = args.out / "capability-profile.json"
    output_file.write_text(
        json.dumps(profile, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"PROFILE {output_file}", flush=True)
    print(
        "PASS qualification_completed "
        f"models={len(profile['models'])} "
        "repo_mutation=false "
        "product_authority=false",
        flush=True,
    )

    if args.require_qualified and not all_batch_qualified:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
