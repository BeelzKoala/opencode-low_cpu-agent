#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


PROTOCOL = "model-viability-benchmark-v1"
CAPTURE_PROTOCOL = "model-viability-request-capture-v1"
FIXTURE_PROTOCOL = "model-viability-fixture-v1"
SPEC_PROTOCOL = "model-viability-ablation-spec-v1"
MODEL_MATRIX_PROTOCOL = "model-viability-model-matrix-v1"
CAPTURE_FILE = Path(".opencode/model-viability-request.jsonl")
CAPTURE_CONTROL_FILE = Path(".opencode/model-viability-capture-control.json")
CAPTURE_CONTROL_PROTOCOL = "model-viability-capture-control-v1"
DEFAULT_OPENCODE = Path(os.path.expanduser("~/.opencode/bin/opencode2"))
DEFAULT_ABIS = ("current", "constrained")


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(raw)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def select_task(doc: Any, task_id: str | None) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(doc, dict):
        raise RuntimeError("task document must be a JSON object")
    defaults = doc.get("defaults")
    if not isinstance(defaults, dict):
        defaults = {}

    tasks = doc.get("tasks")
    if isinstance(tasks, list):
        candidates = [row for row in tasks if isinstance(row, dict)]
    elif isinstance(doc.get("id"), str):
        candidates = [doc]
    else:
        raise RuntimeError("task document has no tasks")

    if task_id is None:
        if len(candidates) != 1:
            raise RuntimeError(
                f"task document has {len(candidates)} tasks; pass --task-id"
            )
        return candidates[0], defaults

    matches = [row for row in candidates if row.get("id") == task_id]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one task id={task_id!r}, found {len(matches)}"
        )
    return matches[0], defaults


def run_checked(
    argv: list[str],
    *,
    cwd: Path,
    timeout_s: int = 60,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    cp = subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        timeout=timeout_s,
        check=False,
    )
    if cp.returncode != 0:
        raise RuntimeError(
            f"command failed rc={cp.returncode}: {' '.join(argv)}\n"
            f"stdout:\n{cp.stdout[-4000:]}\n"
            f"stderr:\n{cp.stderr[-4000:]}"
        )
    return cp


def git(repo: Path, *args: str, timeout_s: int = 60) -> subprocess.CompletedProcess[str]:
    return run_checked(["git", *args], cwd=repo, timeout_s=timeout_s)


def terminate_process_group(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    proc.wait(timeout=3)


def capture_request(args: argparse.Namespace) -> int:
    task_path = Path(args.task).resolve()
    task_doc = read_json(task_path)
    task, defaults = select_task(task_doc, args.task_id)

    task_id = task.get("id")
    repo_value = task.get("repo")
    prompt = task.get("prompt")
    if not isinstance(task_id, str) or not task_id:
        raise RuntimeError("task id missing")
    if not isinstance(repo_value, str) or not repo_value:
        raise RuntimeError("task repo missing")
    if not isinstance(prompt, str) or not prompt:
        raise RuntimeError("task prompt missing")

    repo = Path(os.path.expanduser(repo_value)).resolve()
    if not repo.exists():
        raise RuntimeError(f"task repo missing: {repo}")

    opencode = Path(os.path.expanduser(str(args.opencode))).resolve()
    if not opencode.is_file():
        raise RuntimeError(f"opencode binary missing: {opencode}")

    base_ref = task.get("base_ref", "HEAD")
    if not isinstance(base_ref, str) or not base_ref:
        base_ref = "HEAD"

    fixture_out = Path(args.fixture).resolve()
    capture_timeout_s = float(args.capture_timeout_s)
    if capture_timeout_s <= 0:
        raise RuntimeError("capture timeout must be > 0")

    base_head = git(repo, "rev-parse", str(base_ref)).stdout.strip()

    temp_parent = Path(
        tempfile.mkdtemp(prefix=f"opencode-model-viability-{task_id}-")
    )
    temp_parent.rmdir()
    worktree = temp_parent

    proc: subprocess.Popen[str] | None = None
    try:
        git(
            repo,
            "worktree",
            "add",
            "--detach",
            str(worktree),
            str(base_ref),
            timeout_s=60,
        )

        for index, setup in enumerate(task.get("setup", []), 1):
            if not isinstance(setup, dict):
                raise RuntimeError(f"invalid setup #{index}")
            argv = setup.get("argv")
            if (
                not isinstance(argv, list)
                or not argv
                or not all(isinstance(x, str) and x for x in argv)
            ):
                raise RuntimeError(f"invalid setup argv #{index}")
            setup_timeout = setup.get(
                "timeout_s",
                defaults.get("setup_timeout_s", 120),
            )
            if not isinstance(setup_timeout, int):
                setup_timeout = 120
            run_checked(
                argv,
                cwd=worktree,
                timeout_s=setup_timeout,
            )

        capture_path = worktree / CAPTURE_FILE
        capture_path.parent.mkdir(parents=True, exist_ok=True)
        if capture_path.exists():
            capture_path.unlink()

        full_prompt = prompt
        capture_nonce = hashlib.sha256(os.urandom(32)).hexdigest()
        expected_task_text_sha256 = hashlib.sha256(
            full_prompt.encode("utf-8")
        ).hexdigest()
        capture_control_path = worktree / CAPTURE_CONTROL_FILE
        write_json(
            capture_control_path,
            {
                "protocol": CAPTURE_CONTROL_PROTOCOL,
                "enabled": True,
                "nonce": capture_nonce,
                "task_id": task_id,
                "expected_task_text_sha256": expected_task_text_sha256,
                "capture_mode": "shadow_only",
            },
        )

        child_env = os.environ.copy()
        child_env["PWD"] = str(worktree.resolve())

        stdout_path = fixture_out.with_suffix(".capture.stdout.jsonl")
        stderr_path = fixture_out.with_suffix(".capture.stderr")
        stdout_path.parent.mkdir(parents=True, exist_ok=True)

        stdout = stdout_path.open("w", encoding="utf-8")
        stderr = stderr_path.open("w", encoding="utf-8")
        try:
            proc = subprocess.Popen(
                [
                    str(opencode),
                    "run",
                    "--format",
                    "json",
                    full_prompt,
                ],
                cwd=worktree,
                env=child_env,
                stdout=stdout,
                stderr=stderr,
                text=True,
                start_new_session=True,
            )

            deadline = time.monotonic() + capture_timeout_s
            captured: dict[str, Any] | None = None

            while time.monotonic() < deadline:
                rows = load_json_lines(capture_path)
                matches = [
                    row
                    for row in rows
                    if row.get("protocol") == CAPTURE_PROTOCOL
                    and row.get("kind") == "model_viability_request_capture"
                    and row.get("model_call") == 1
                    and row.get("capture_control_protocol")
                    == CAPTURE_CONTROL_PROTOCOL
                    and row.get("capture_control_nonce") == capture_nonce
                    and row.get("task_text_sha256")
                    == expected_task_text_sha256
                ]
                if matches:
                    captured = matches[-1]
                    break
                if proc.poll() is not None:
                    break
                time.sleep(0.05)

            if captured is None:
                raise RuntimeError(
                    "model-facing request was not captured before deadline; "
                    "verify plugin stack is installed and task-local "
                    "capture control is supported by the loaded runtime"
                )

            raw_request = {
                "system": captured.get("system"),
                "messages": captured.get("messages"),
                "tools": captured.get("tools"),
            }
            computed_sha = sha256_json(raw_request)
            recorded_raw_sha = captured.get("raw_request_sha256")

            fixture = {
                "protocol": FIXTURE_PROTOCOL,
                "source": {
                    "task_file": str(task_path),
                    "task_id": task_id,
                    "repo": str(repo),
                    "base_ref": base_ref,
                    "base_head": base_head,
                    "captured_provider_id": captured.get("providerID"),
                    "captured_model_id": captured.get("modelID"),
                    "task_text_sha256": captured.get("task_text_sha256"),
                },
                "request_sha256": computed_sha,
                "request": raw_request,
                "capture": {
                    "sessionID": captured.get("sessionID"),
                    "turnID": captured.get("turnID"),
                    "model_call": captured.get("model_call"),
                    "tool_names": captured.get("tool_names"),
                    "capture_mode": captured.get("capture_mode"),
                    "capture_control_protocol": captured.get(
                        "capture_control_protocol"
                    ),
                    "capture_control_nonce": captured.get(
                        "capture_control_nonce"
                    ),
                    "expected_task_text_sha256": expected_task_text_sha256,
                    "raw_request_sha256": recorded_raw_sha,
                    "canonical_request_sha256": computed_sha,
                },
            }
            write_json(fixture_out, fixture)
            print(
                "CAPTURED "
                f"fixture={fixture_out} "
                f"request_sha256={computed_sha} "
                f"tools={captured.get('tool_names')}"
            )
        finally:
            terminate_process_group(proc) if proc is not None else None
            stdout.close()
            stderr.close()

    finally:
        if proc is not None:
            terminate_process_group(proc)
        try:
            git(
                repo,
                "worktree",
                "remove",
                "--force",
                str(worktree),
                timeout_s=60,
            )
        except Exception:
            pass
        if worktree.exists():
            shutil.rmtree(worktree, ignore_errors=True)

    return 0


def flatten_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for part in value:
            if isinstance(part, str):
                parts.append(part)
                continue
            if isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    parts.append(part["text"])
                    continue
                if isinstance(part.get("content"), str):
                    parts.append(part["content"])
                    continue
            parts.append(canonical_json(part))
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"]
        if isinstance(value.get("content"), str):
            return value["content"]
    return canonical_json(value)


def normalize_messages(raw_system: Any, raw_messages: Any) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []

    if isinstance(raw_system, list):
        systems = raw_system
    elif raw_system is None:
        systems = []
    else:
        systems = [raw_system]

    for entry in systems:
        content = flatten_content(entry)
        if content:
            messages.append({"role": "system", "content": content})

    if not isinstance(raw_messages, list):
        raise RuntimeError("captured request messages must be a list")

    for index, message in enumerate(raw_messages):
        if not isinstance(message, dict):
            raise RuntimeError(f"captured message #{index} is not an object")
        role = message.get("role")
        if role not in {"system", "user", "assistant", "tool"}:
            raise RuntimeError(f"captured message #{index} has invalid role={role!r}")
        row: dict[str, Any] = {
            "role": role,
            "content": flatten_content(message.get("content")),
        }
        if role == "tool":
            if isinstance(message.get("tool_call_id"), str):
                row["tool_call_id"] = message["tool_call_id"]
            if isinstance(message.get("name"), str):
                row["name"] = message["name"]
        if role == "assistant" and isinstance(message.get("tool_calls"), list):
            row["tool_calls"] = message["tool_calls"]
        messages.append(row)

    return messages


def schema_candidate(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    if (
        value.get("type") == "object"
        or isinstance(value.get("properties"), dict)
        or isinstance(value.get("required"), list)
    ):
        return value

    for key in (
        "parameters",
        "inputSchema",
        "input_schema",
        "schema",
        "jsonSchema",
        "json_schema",
        "args",
        "input",
    ):
        candidate = value.get(key)
        if isinstance(candidate, dict):
            nested = schema_candidate(candidate)
            if nested is not None:
                return nested
    return None


def normalize_tools(raw_tools: Any) -> list[dict[str, Any]]:
    if isinstance(raw_tools, list):
        out: list[dict[str, Any]] = []
        for index, tool in enumerate(raw_tools):
            if not isinstance(tool, dict):
                raise RuntimeError(f"captured tool #{index} is not an object")
            if (
                tool.get("type") == "function"
                and isinstance(tool.get("function"), dict)
            ):
                out.append(tool)
                continue
            name = tool.get("name")
            if not isinstance(name, str) or not name:
                raise RuntimeError(f"captured tool #{index} has no name")
            schema = schema_candidate(tool)
            if schema is None:
                raise RuntimeError(
                    f"captured tool {name!r} has no serializable JSON schema"
                )
            out.append({
                "type": "function",
                "function": {
                    "name": name,
                    "description": str(tool.get("description") or ""),
                    "parameters": schema,
                },
            })
        return out

    if not isinstance(raw_tools, dict):
        raise RuntimeError("captured request tools must be an object or list")

    out = []
    for name, value in raw_tools.items():
        if not isinstance(name, str) or not name:
            raise RuntimeError("captured tool map contains invalid name")
        if not isinstance(value, dict):
            raise RuntimeError(f"captured tool {name!r} is not an object")

        if (
            value.get("type") == "function"
            and isinstance(value.get("function"), dict)
        ):
            function = dict(value["function"])
            function.setdefault("name", name)
            out.append({"type": "function", "function": function})
            continue

        schema = schema_candidate(value)
        if schema is None:
            raise RuntimeError(
                f"captured tool {name!r} has no serializable JSON schema; "
                f"keys={sorted(value.keys())}"
            )
        out.append({
            "type": "function",
            "function": {
                "name": name,
                "description": str(value.get("description") or ""),
                "parameters": schema,
            },
        })

    return out


def safe_property_name(value: str) -> str:
    out = []
    for char in value:
        if char.isalnum() or char == "_":
            out.append(char)
        else:
            out.append("_")
    name = "".join(out).strip("_")
    if not name:
        raise RuntimeError(f"cannot derive constrained property from {value!r}")
    if name[0].isdigit():
        name = "o_" + name
    return name


def constrained_tool(spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    obligations = spec.get("obligations")
    if not isinstance(obligations, list) or not obligations:
        raise RuntimeError("ablation spec obligations missing")

    properties: dict[str, Any] = {}
    required: list[str] = []
    mapping: dict[str, str] = {}

    for obligation in obligations:
        if not isinstance(obligation, dict):
            raise RuntimeError("ablation obligation must be object")
        obligation_id = obligation.get("id")
        if not isinstance(obligation_id, str) or not obligation_id:
            raise RuntimeError("ablation obligation id missing")
        prop = safe_property_name(obligation_id)
        if prop in properties:
            raise RuntimeError(f"duplicate constrained property {prop}")
        mapping[obligation_id] = prop

        fields = obligation.get("constrained_fields")
        if not isinstance(fields, list) or not fields:
            fields = ["content"]
        if not all(isinstance(field, str) and field for field in fields):
            raise RuntimeError(
                f"invalid constrained_fields for {obligation_id}"
            )

        field_properties = {
            field: {
                "type": "string",
                "minLength": 1,
                "description": (
                    f"Synthesized {field} for obligation {obligation_id}; "
                    f"slot={obligation.get('slot')} "
                    f"operation={obligation.get('operation')}"
                ),
            }
            for field in fields
        }

        properties[prop] = {
            "type": "object",
            "additionalProperties": False,
            "properties": field_properties,
            "required": fields,
        }
        required.append(prop)

    tool_name = spec.get(
        "constrained_tool_name",
        "submit_required_operation_content",
    )
    if not isinstance(tool_name, str) or not tool_name:
        raise RuntimeError("invalid constrained_tool_name")

    tool = {
        "type": "function",
        "function": {
            "name": tool_name,
            "description": (
                "Benchmark ablation only. The deterministic planner already "
                "fixed operation topology. Supply only the required mutation "
                "content for every obligation; do not add or remove operations."
            ),
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": properties,
                "required": required,
            },
        },
    }
    return tool, mapping


def constrained_instruction(
    spec: dict[str, Any],
    mapping: dict[str, str],
) -> str:
    lines = [
        "MODEL_VIABILITY_ABLATION_ONLY.",
        "The deterministic planner has already fixed the mutation topology.",
        "Do not choose files, slots, operation kinds, or whether an operation exists.",
        "Return exactly one tool call containing content for every required obligation.",
        "Required obligations:",
    ]
    for obligation in spec["obligations"]:
        oid = obligation["id"]
        lines.append(
            "- "
            f"{mapping[oid]}: obligation={oid} "
            f"slot={obligation.get('slot')} "
            f"operation={obligation.get('operation')}"
        )
    return "\n".join(lines)


def build_request(
    fixture: dict[str, Any],
    spec: dict[str, Any],
    model: dict[str, Any],
    abi: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    if fixture.get("protocol") != FIXTURE_PROTOCOL:
        raise RuntimeError("fixture protocol mismatch")
    if spec.get("protocol") != SPEC_PROTOCOL:
        raise RuntimeError("ablation spec protocol mismatch")

    request = fixture.get("request")
    if not isinstance(request, dict):
        raise RuntimeError("fixture request missing")

    messages = normalize_messages(
        request.get("system"),
        request.get("messages"),
    )
    current_tools = normalize_tools(request.get("tools"))

    expected_task_sha = spec.get("expected_task_text_sha256")
    observed_task_sha = (
        fixture.get("source", {}).get("task_text_sha256")
        if isinstance(fixture.get("source"), dict)
        else None
    )
    if (
        isinstance(expected_task_sha, str)
        and expected_task_sha
        and expected_task_sha != observed_task_sha
    ):
        raise RuntimeError(
            "fixture task identity mismatch: "
            f"expected={expected_task_sha} observed={observed_task_sha}"
        )

    constrained_mapping: dict[str, str] = {}

    if abi == "current":
        tools = current_tools
        tool_choice: Any = "auto"
        expected_current_tool = spec.get("current_tool_name")
        if isinstance(expected_current_tool, str) and expected_current_tool:
            names = [
                row.get("function", {}).get("name")
                for row in tools
                if isinstance(row, dict)
            ]
            if expected_current_tool not in names:
                raise RuntimeError(
                    "captured current tool missing: "
                    f"expected={expected_current_tool} names={names}"
                )
    elif abi == "constrained":
        tool, constrained_mapping = constrained_tool(spec)
        tools = [tool]
        messages = [
            *messages,
            {
                "role": "system",
                "content": constrained_instruction(
                    spec,
                    constrained_mapping,
                ),
            },
        ]
        tool_choice = {
            "type": "function",
            "function": {"name": tool["function"]["name"]},
        }
    else:
        raise RuntimeError(f"unsupported ABI {abi!r}")

    body: dict[str, Any] = {
        "messages": messages,
        "tools": tools,
        "tool_choice": tool_choice,
        "stream": False,
        "temperature": model.get("temperature", 0.0),
        "max_tokens": model.get("max_tokens", 1024),
    }
    model_id = model.get("model")
    if isinstance(model_id, str) and model_id:
        body["model"] = model_id

    return body, constrained_mapping


class RssSampler:
    def __init__(self, pid: int | None) -> None:
        self.pid = pid if isinstance(pid, int) and pid > 0 else None
        self.peak_kb: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _sample_once(self) -> None:
        if self.pid is None:
            return
        path = Path(f"/proc/{self.pid}/status")
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return
        for line in text.splitlines():
            if line.startswith("VmRSS:"):
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        value = int(parts[1])
                    except ValueError:
                        return
                    if self.peak_kb is None or value > self.peak_kb:
                        self.peak_kb = value
                return

    def _run(self) -> None:
        while not self._stop.wait(0.05):
            self._sample_once()
        self._sample_once()

    def __enter__(self) -> "RssSampler":
        if self.pid is not None:
            self._sample_once()
            self._thread = threading.Thread(
                target=self._run,
                daemon=True,
            )
            self._thread.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)


def post_json(
    url: str,
    body: dict[str, Any],
    *,
    timeout_s: float,
    api_key: str | None,
    pid: int | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    request = urllib_request.Request(
        url,
        data=data,
        headers=headers,
        method="POST",
    )
    started = time.monotonic()
    response_body = b""
    http_status: int | None = None
    error_text: str | None = None
    timed_out = False

    with RssSampler(pid) as rss:
        try:
            with urllib_request.urlopen(
                request,
                timeout=timeout_s,
            ) as response:
                http_status = response.status
                response_body = response.read()
        except (TimeoutError, socket.timeout):
            timed_out = True
            error_text = "timeout"
        except urllib_error.HTTPError as exc:
            http_status = exc.code
            try:
                response_body = exc.read()
            except Exception:
                response_body = b""
            error_text = f"http_error:{exc.code}"
        except urllib_error.URLError as exc:
            if isinstance(exc.reason, socket.timeout):
                timed_out = True
                error_text = "timeout"
            else:
                error_text = f"url_error:{exc.reason}"
        except Exception as exc:
            error_text = f"request_error:{type(exc).__name__}:{exc}"

    wall_s = round(time.monotonic() - started, 3)

    parsed: dict[str, Any] | None = None
    if response_body:
        try:
            value = json.loads(response_body.decode("utf-8", errors="replace"))
            if isinstance(value, dict):
                parsed = value
            else:
                error_text = error_text or "response_not_object"
        except Exception as exc:
            error_text = error_text or f"response_json_error:{exc}"

    meta = {
        "wall_s": wall_s,
        "http_status": http_status,
        "timed_out": timed_out,
        "error": error_text,
        "response_bytes": len(response_body),
        "peak_rss_kb": rss.peak_kb,
    }
    return parsed, meta


def parse_tool_call(
    response: dict[str, Any] | None,
    expected_name: str,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    if not isinstance(response, dict):
        return None, {
            "tool_call_status": "response_unavailable",
            "tool_call_count": 0,
        }

    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return None, {
            "tool_call_status": "choices_missing",
            "tool_call_count": 0,
        }
    choice = choices[0]
    if not isinstance(choice, dict):
        return None, {
            "tool_call_status": "choice_invalid",
            "tool_call_count": 0,
        }
    message = choice.get("message")
    if not isinstance(message, dict):
        return None, {
            "tool_call_status": "message_missing",
            "tool_call_count": 0,
        }

    raw_calls = message.get("tool_calls")
    calls: list[dict[str, Any]] = []
    if isinstance(raw_calls, list):
        calls.extend(row for row in raw_calls if isinstance(row, dict))

    function_call = message.get("function_call")
    if isinstance(function_call, dict):
        calls.append({
            "type": "function",
            "function": function_call,
        })

    matching: list[dict[str, Any]] = []
    for call in calls:
        function = call.get("function")
        if not isinstance(function, dict):
            continue
        if function.get("name") == expected_name:
            matching.append(call)

    meta = {
        "tool_call_count": len(calls),
        "matching_tool_call_count": len(matching),
        "finish_reason": choice.get("finish_reason"),
    }

    if len(matching) != 1:
        meta["tool_call_status"] = (
            "expected_tool_missing"
            if not matching
            else "expected_tool_duplicated"
        )
        return None, meta

    function = matching[0]["function"]
    arguments = function.get("arguments")
    if isinstance(arguments, dict):
        parsed = arguments
    elif isinstance(arguments, str):
        try:
            value = json.loads(arguments)
        except Exception as exc:
            meta["tool_call_status"] = f"arguments_json_invalid:{exc}"
            return None, meta
        if not isinstance(value, dict):
            meta["tool_call_status"] = "arguments_not_object"
            return None, meta
        parsed = value
    else:
        meta["tool_call_status"] = "arguments_missing"
        return None, meta

    meta["tool_call_status"] = "parsed"
    return parsed, meta


def current_coverage(
    args: dict[str, Any],
    spec: dict[str, Any],
) -> tuple[list[str], list[str]]:
    satisfied: list[str] = []
    missing: list[str] = []

    for obligation in spec["obligations"]:
        oid = obligation["id"]
        family = obligation.get("family")
        slot = obligation.get("slot")
        rows = args.get(family) if isinstance(family, str) else None
        found = False
        fields = obligation.get("constrained_fields")
        if not isinstance(fields, list) or not fields:
            fields = ["content"]
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                if slot is not None and row.get("slot") != slot:
                    continue
                fields_ok = True
                for field in fields:
                    value = row.get(field)
                    if not isinstance(value, str) or not value.strip():
                        fields_ok = False
                        break
                if fields_ok:
                    found = True
                    break
        if found:
            satisfied.append(oid)
        else:
            missing.append(oid)

    return satisfied, missing


def constrained_coverage(
    args: dict[str, Any],
    spec: dict[str, Any],
    mapping: dict[str, str],
) -> tuple[list[str], list[str]]:
    satisfied: list[str] = []
    missing: list[str] = []

    for obligation in spec["obligations"]:
        oid = obligation["id"]
        prop = mapping[oid]
        value = args.get(prop)
        fields = obligation.get("constrained_fields")
        if not isinstance(fields, list) or not fields:
            fields = ["content"]

        ok = isinstance(value, dict)
        if ok:
            for field in fields:
                current = value.get(field)
                if not isinstance(current, str) or not current.strip():
                    ok = False
                    break
        if ok:
            satisfied.append(oid)
        else:
            missing.append(oid)

    return satisfied, missing


def timing_fields(response: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(response, dict):
        return {
            "prompt_tokens": None,
            "completion_tokens": None,
            "total_tokens": None,
            "prompt_tokens_per_s": None,
            "generation_tokens_per_s": None,
        }

    usage = response.get("usage")
    if not isinstance(usage, dict):
        usage = {}
    timings = response.get("timings")
    if not isinstance(timings, dict):
        timings = {}

    return {
        "prompt_tokens": usage.get(
            "prompt_tokens",
            timings.get("prompt_n"),
        ),
        "completion_tokens": usage.get(
            "completion_tokens",
            timings.get("predicted_n"),
        ),
        "total_tokens": usage.get("total_tokens"),
        "prompt_tokens_per_s": timings.get(
            "prompt_per_second",
            timings.get("prompt_tokens_per_second"),
        ),
        "generation_tokens_per_s": timings.get(
            "predicted_per_second",
            timings.get("tokens_per_second"),
        ),
        "prompt_ms": timings.get("prompt_ms"),
        "generation_ms": timings.get("predicted_ms"),
    }


def run_one(
    *,
    fixture: dict[str, Any],
    spec: dict[str, Any],
    model: dict[str, Any],
    abi: str,
    repeat_index: int,
) -> dict[str, Any]:
    body, mapping = build_request(
        fixture,
        spec,
        model,
        abi,
    )
    request_sha = sha256_json({
        "abi": abi,
        "body": body,
    })

    url = model.get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError(f"model {model.get('name')} url missing")
    timeout_s = model.get("timeout_s", 90)
    if not isinstance(timeout_s, (int, float)) or timeout_s <= 0:
        raise RuntimeError(f"model {model.get('name')} timeout invalid")
    pid = model.get("pid")
    if not isinstance(pid, int):
        pid = None

    api_key = None
    api_key_env = model.get("api_key_env")
    if isinstance(api_key_env, str) and api_key_env:
        api_key = os.environ.get(api_key_env)

    response, transport = post_json(
        url,
        body,
        timeout_s=float(timeout_s),
        api_key=api_key,
        pid=pid,
    )

    expected_name = (
        spec.get("current_tool_name")
        if abi == "current"
        else spec.get(
            "constrained_tool_name",
            "submit_required_operation_content",
        )
    )
    if not isinstance(expected_name, str) or not expected_name:
        raise RuntimeError("expected tool name missing")

    parsed_args, call_meta = parse_tool_call(
        response,
        expected_name,
    )

    if parsed_args is None:
        satisfied: list[str] = []
        missing = [row["id"] for row in spec["obligations"]]
    elif abi == "current":
        satisfied, missing = current_coverage(
            parsed_args,
            spec,
        )
    else:
        satisfied, missing = constrained_coverage(
            parsed_args,
            spec,
            mapping,
        )

    coverage_complete = len(missing) == 0
    valid_candidate = (
        transport["timed_out"] is False
        and transport["error"] is None
        and call_meta.get("tool_call_status") == "parsed"
        and coverage_complete
    )
    valid_within_budget = (
        valid_candidate
        and transport["wall_s"] <= float(timeout_s)
    )

    if transport["timed_out"]:
        status = "timeout"
    elif transport["error"] is not None:
        status = "transport_error"
    elif call_meta.get("tool_call_status") != "parsed":
        status = "invalid_tool_call"
    elif not coverage_complete:
        status = "coverage_incomplete"
    else:
        status = "valid_candidate"

    return {
        "protocol": PROTOCOL,
        "model_name": model.get("name"),
        "model_id": model.get("model"),
        "abi": abi,
        "repeat_index": repeat_index,
        "request_sha256": request_sha,
        "fixture_request_sha256": fixture.get("request_sha256"),
        "status": status,
        "valid_candidate": valid_candidate,
        "valid_candidate_within_budget": valid_within_budget,
        "coverage_complete": coverage_complete,
        "satisfied_obligations": satisfied,
        "missing_obligations": missing,
        "coverage_ratio": (
            len(satisfied) / len(spec["obligations"])
            if spec["obligations"]
            else 0.0
        ),
        **transport,
        **call_meta,
        **timing_fields(response),
    }


def run_matrix(args: argparse.Namespace) -> int:
    fixture = read_json(Path(args.fixture).resolve())
    spec = read_json(Path(args.spec).resolve())
    matrix = read_json(Path(args.models).resolve())

    if matrix.get("protocol") != MODEL_MATRIX_PROTOCOL:
        raise RuntimeError("model matrix protocol mismatch")
    models = matrix.get("models")
    if not isinstance(models, list) or not models:
        raise RuntimeError("model matrix has no models")
    if not all(isinstance(model, dict) for model in models):
        raise RuntimeError("model matrix entries must be objects")

    defaults = matrix.get("defaults")
    if not isinstance(defaults, dict):
        defaults = {}

    resolved_models: list[dict[str, Any]] = []
    for model in models:
        merged = dict(defaults)
        merged.update(model)
        if not isinstance(merged.get("name"), str) or not merged["name"]:
            raise RuntimeError("every model requires a name")
        resolved_models.append(merged)

    abis = [
        value.strip()
        for value in args.abis.split(",")
        if value.strip()
    ]
    if not abis:
        raise RuntimeError("no ABI selected")
    unsupported = [value for value in abis if value not in DEFAULT_ABIS]
    if unsupported:
        raise RuntimeError(f"unsupported ABIs: {unsupported}")

    repeat = int(args.repeat)
    if repeat < 1:
        raise RuntimeError("--repeat must be >=1")

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    runs_path = out / "runs.jsonl"
    if runs_path.exists():
        runs_path.unlink()

    results: list[dict[str, Any]] = []

    for model in resolved_models:
        for abi in abis:
            for repeat_index in range(1, repeat + 1):
                print(
                    "RUN "
                    f"model={model['name']} "
                    f"abi={abi} "
                    f"repeat={repeat_index}/{repeat}",
                    flush=True,
                )
                row = run_one(
                    fixture=fixture,
                    spec=spec,
                    model=model,
                    abi=abi,
                    repeat_index=repeat_index,
                )
                results.append(row)
                with runs_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(
                    "RESULT "
                    f"status={row['status']} "
                    f"wall_s={row['wall_s']} "
                    f"coverage={len(row['satisfied_obligations'])}/"
                    f"{len(spec['obligations'])} "
                    f"valid_within_budget={row['valid_candidate_within_budget']}",
                    flush=True,
                )

    groups: list[dict[str, Any]] = []
    for model in resolved_models:
        for abi in abis:
            selected = [
                row
                for row in results
                if row["model_name"] == model["name"]
                and row["abi"] == abi
            ]
            completed = [
                row for row in selected if row["status"] != "timeout"
            ]
            valid = [
                row
                for row in selected
                if row["valid_candidate_within_budget"] is True
            ]
            groups.append({
                "model_name": model["name"],
                "abi": abi,
                "runs": len(selected),
                "completed_runs": len(completed),
                "valid_candidate_within_budget_runs": len(valid),
                "completion_rate": (
                    len(completed) / len(selected) if selected else 0.0
                ),
                "valid_candidate_within_budget_rate": (
                    len(valid) / len(selected) if selected else 0.0
                ),
                "best_wall_s": min(
                    (row["wall_s"] for row in selected),
                    default=None,
                ),
                "best_coverage_ratio": max(
                    (row["coverage_ratio"] for row in selected),
                    default=0.0,
                ),
            })

    current_group = next(
        (
            row
            for row in groups
            if row["model_name"] == resolved_models[0]["name"]
            and row["abi"] == "current"
        ),
        None,
    )
    constrained_group = next(
        (
            row
            for row in groups
            if row["model_name"] == resolved_models[0]["name"]
            and row["abi"] == "constrained"
        ),
        None,
    )

    abi_supported = (
        current_group is not None
        and constrained_group is not None
        and constrained_group["valid_candidate_within_budget_rate"]
        > current_group["valid_candidate_within_budget_rate"]
    )

    baseline_name = resolved_models[0]["name"]
    alternate_current_groups = [
        row
        for row in groups
        if row["abi"] == "current"
        and row["model_name"] != baseline_name
    ]
    best_alternate_current = max(
        alternate_current_groups,
        key=lambda row: (
            row["valid_candidate_within_budget_rate"],
            row["completion_rate"],
            row["best_coverage_ratio"],
        ),
        default=None,
    )
    model_swap_supported = (
        current_group is not None
        and best_alternate_current is not None
        and (
            best_alternate_current["valid_candidate_within_budget_rate"]
            > current_group["valid_candidate_within_budget_rate"]
            or (
                current_group["completion_rate"] == 0
                and best_alternate_current["completion_rate"] > 0
            )
        )
    )

    if abi_supported and model_swap_supported:
        ablation_signal = "BOTH_ABI_AND_MODEL_SUPPORTED"
    elif abi_supported:
        ablation_signal = "ABI_PLANNING_ENTROPY_SUPPORTED"
    elif model_swap_supported:
        ablation_signal = "MODEL_BACKEND_ALTERNATIVE_SUPPORTED"
    elif (
        current_group is not None
        and constrained_group is not None
        and current_group["completion_rate"] == 0
        and constrained_group["completion_rate"] == 0
    ):
        ablation_signal = "BASELINE_MODEL_BACKEND_LATENCY_DOMINANT"
    elif (
        current_group is not None
        and constrained_group is not None
        and current_group["valid_candidate_within_budget_rate"]
        >= constrained_group["valid_candidate_within_budget_rate"]
    ):
        ablation_signal = "ABI_ABLATION_NO_BENEFIT"
    else:
        ablation_signal = "INCONCLUSIVE"

    summary = {
        "protocol": PROTOCOL,
        "fixture_request_sha256": fixture.get("request_sha256"),
        "task_id": spec.get("task_id"),
        "groups": groups,
        "baseline_model": baseline_name,
        "best_alternate_current": best_alternate_current,
        "ablation_signal": ablation_signal,
        "pass_metric": "VALID_CANDIDATE_WITHIN_BUDGET",
    }
    write_json(out / "summary.json", summary)

    print("\n=== MODEL VIABILITY SUMMARY ===")
    for row in groups:
        print(
            f"{row['model_name']:20} "
            f"{row['abi']:12} "
            f"complete={row['completed_runs']}/{row['runs']} "
            f"valid={row['valid_candidate_within_budget_runs']}/{row['runs']} "
            f"best_wall_s={row['best_wall_s']} "
            f"best_coverage={row['best_coverage_ratio']:.3f}"
        )
    print(f"ABLATION_SIGNAL {ablation_signal}")
    print(f"SUMMARY {out / 'summary.json'}")

    return 0


def inspect_fixture(args: argparse.Namespace) -> int:
    fixture = read_json(Path(args.fixture).resolve())
    spec = read_json(Path(args.spec).resolve())

    if fixture.get("protocol") != FIXTURE_PROTOCOL:
        raise RuntimeError("fixture protocol mismatch")
    request = fixture.get("request")
    if not isinstance(request, dict):
        raise RuntimeError("fixture request missing")

    raw_sha = sha256_json(request)
    if raw_sha != fixture.get("request_sha256"):
        raise RuntimeError(
            "fixture SHA mismatch: "
            f"recorded={fixture.get('request_sha256')} computed={raw_sha}"
        )

    tools = normalize_tools(request.get("tools"))
    messages = normalize_messages(
        request.get("system"),
        request.get("messages"),
    )
    tool_names = [
        row.get("function", {}).get("name")
        for row in tools
    ]

    expected_tool = spec.get("current_tool_name")
    if isinstance(expected_tool, str) and expected_tool not in tool_names:
        raise RuntimeError(
            f"expected current tool {expected_tool!r} missing from {tool_names}"
        )

    expected_task_sha = spec.get("expected_task_text_sha256")
    source = fixture.get("source")
    observed_task_sha = (
        source.get("task_text_sha256")
        if isinstance(source, dict)
        else None
    )
    if (
        isinstance(expected_task_sha, str)
        and expected_task_sha
        and expected_task_sha != observed_task_sha
    ):
        raise RuntimeError(
            "task SHA mismatch: "
            f"expected={expected_task_sha} observed={observed_task_sha}"
        )

    print(f"PASS fixture request_sha256={raw_sha}")
    print(f"PASS messages={len(messages)} tools={tool_names}")
    print(f"PASS obligations={len(spec.get('obligations', []))}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Capture and replay one stable model-facing request without "
            "Scout/worktree execution in the timed benchmark loop."
        )
    )
    sub = parser.add_subparsers(dest="command", required=True)

    capture = sub.add_parser("capture")
    capture.add_argument("--task", required=True)
    capture.add_argument("--task-id")
    capture.add_argument("--fixture", required=True)
    capture.add_argument("--opencode", default=str(DEFAULT_OPENCODE))
    capture.add_argument("--capture-timeout-s", type=float, default=20.0)
    capture.set_defaults(func=capture_request)

    inspect = sub.add_parser("inspect")
    inspect.add_argument("--fixture", required=True)
    inspect.add_argument("--spec", required=True)
    inspect.set_defaults(func=inspect_fixture)

    run = sub.add_parser("run")
    run.add_argument("--fixture", required=True)
    run.add_argument("--spec", required=True)
    run.add_argument("--models", required=True)
    run.add_argument("--abis", default="current,constrained")
    run.add_argument("--repeat", type=int, default=1)
    run.add_argument(
        "--out",
        default="benchmarks/results/v2.28-model-viability",
    )
    run.set_defaults(func=run_matrix)

    args = parser.parse_args()
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"FAIL {type(exc).__name__}: {exc}", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
