#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import queue
import shutil
import statistics
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlparse


PROTOCOL = "semantic-engine-shootout-v1"

TOOLS = (
    Path.home()
    / ".local/share/opencode-semantic-bench"
)

REQUEST_TIMEOUT = 20.0
STARTUP_TIMEOUT = 45.0


def uri(path: Path) -> str:
    return "file://" + quote(str(path.resolve()), safe="/:")


def path_from_uri(value: str) -> Path:
    parsed = urlparse(value)
    return Path(unquote(parsed.path))


def utf16_col(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def find_position(
    path: Path,
    needle: str,
    occurrence: int = 1,
):
    text = path.read_text(encoding="utf-8")
    start = -1

    for _ in range(occurrence):
        start = text.find(needle, start + 1)
        if start < 0:
            raise RuntimeError(
                f"{needle!r} occurrence={occurrence} "
                f"not found in {path}"
            )

    before = text[:start]
    line = before.count("\n")
    line_start = before.rfind("\n") + 1
    col_text = text[line_start:start]

    return {
        "line": line,
        "character": utf16_col(col_text),
    }


def line_of(path: Path, marker: str) -> int:
    text = path.read_text(encoding="utf-8")
    pos = text.find(marker)
    if pos < 0:
        raise RuntimeError(
            f"marker {marker!r} not found in {path}"
        )
    return text[:pos].count("\n")


def normalize_locations(result):
    if result is None:
        return []

    values = result if isinstance(result, list) else [result]
    out = []

    for item in values:
        if not isinstance(item, dict):
            continue

        if "uri" in item:
            item_uri = item.get("uri")
            rng = item.get("range")
        else:
            item_uri = item.get("targetUri")
            rng = (
                item.get("targetSelectionRange")
                or item.get("targetRange")
            )

        if not isinstance(item_uri, str):
            continue
        if not isinstance(rng, dict):
            continue

        start = rng.get("start") or {}

        out.append(
            {
                "path": str(path_from_uri(item_uri)),
                "line": start.get("line"),
                "character": start.get("character"),
            }
        )

    return out


def proc_children(pid: int):
    p = Path(f"/proc/{pid}/task/{pid}/children")

    try:
        raw = p.read_text().strip()
    except OSError:
        return []

    if not raw:
        return []

    return [
        int(value)
        for value in raw.split()
        if value.isdigit()
    ]


def proc_tree(pid: int):
    pending = [pid]
    seen = set()

    while pending:
        current = pending.pop()

        if current in seen:
            continue

        seen.add(current)
        pending.extend(proc_children(current))

    return seen


def proc_rss_kb(pid: int):
    try:
        text = Path(
            f"/proc/{pid}/status"
        ).read_text()
    except OSError:
        return 0

    for line in text.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            return int(parts[1])

    return 0


def tree_rss_kb(pid: int):
    return sum(
        proc_rss_kb(child)
        for child in proc_tree(pid)
    )


class RssSampler:
    def __init__(self, pid: int):
        self.pid = pid
        self.peak_kb = 0
        self.running = True

        self.thread = threading.Thread(
            target=self._run,
            daemon=True,
        )
        self.thread.start()

    def _run(self):
        while self.running:
            self.peak_kb = max(
                self.peak_kb,
                tree_rss_kb(self.pid),
            )
            time.sleep(0.02)

    def stop(self):
        self.running = False
        self.thread.join(timeout=1)
        self.peak_kb = max(
            self.peak_kb,
            tree_rss_kb(self.pid),
        )


class LspClient:
    def __init__(
        self,
        command,
        root: Path,
        init_options=None,
    ):
        self.command = list(command)
        self.root = root.resolve()
        self.root_uri = uri(self.root)
        self.init_options = init_options or {}

        self.process = subprocess.Popen(
            self.command,
            cwd=self.root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )

        self.sampler = RssSampler(self.process.pid)

        self.responses = {}
        self.condition = threading.Condition()
        self.write_lock = threading.Lock()
        self.next_id = 1
        self.stderr = bytearray()

        self.reader = threading.Thread(
            target=self._reader_loop,
            daemon=True,
        )
        self.reader.start()

        self.stderr_reader = threading.Thread(
            target=self._stderr_loop,
            daemon=True,
        )
        self.stderr_reader.start()

        self.capabilities = {}

    def _stderr_loop(self):
        assert self.process.stderr is not None

        while True:
            data = self.process.stderr.read(4096)

            if not data:
                return

            if len(self.stderr) < 32 * 1024:
                remaining = 32 * 1024 - len(self.stderr)
                self.stderr.extend(data[:remaining])

    def _read_message(self):
        assert self.process.stdout is not None

        headers = {}

        while True:
            line = self.process.stdout.readline()

            if not line:
                raise EOFError()

            if line in (b"\r\n", b"\n"):
                break

            text = line.decode(
                "ascii",
                errors="replace",
            ).strip()

            if ":" not in text:
                continue

            key, value = text.split(":", 1)
            headers[key.lower()] = value.strip()

        length = int(headers["content-length"])
        body = self.process.stdout.read(length)

        if len(body) != length:
            raise EOFError()

        return json.loads(body.decode("utf-8"))

    def _send(self, message):
        assert self.process.stdin is not None

        raw = json.dumps(
            message,
            separators=(",", ":"),
        ).encode("utf-8")

        header = (
            f"Content-Length: {len(raw)}\r\n\r\n"
        ).encode("ascii")

        with self.write_lock:
            self.process.stdin.write(header)
            self.process.stdin.write(raw)
            self.process.stdin.flush()

    def _server_request_result(self, message):
        method = message.get("method")
        params = message.get("params") or {}

        if method == "workspace/configuration":
            return [
                {}
                for _ in params.get("items", [])
            ]

        if method == "workspace/workspaceFolders":
            return [
                {
                    "uri": self.root_uri,
                    "name": self.root.name,
                }
            ]

        if method == "workspace/applyEdit":
            return {"applied": False}

        # Registration/progress/refresh requests.
        if method in {
            "client/registerCapability",
            "client/unregisterCapability",
            "window/workDoneProgress/create",
            "workspace/semanticTokens/refresh",
            "workspace/inlayHint/refresh",
            "workspace/codeLens/refresh",
            "workspace/diagnostic/refresh",
        }:
            return None

        # We deliberately do not grant arbitrary server actions.
        return None

    def _reader_loop(self):
        try:
            while True:
                message = self._read_message()

                if (
                    "method" in message
                    and "id" in message
                ):
                    self._send(
                        {
                            "jsonrpc": "2.0",
                            "id": message["id"],
                            "result":
                                self._server_request_result(
                                    message
                                ),
                        }
                    )
                    continue

                if "id" in message:
                    with self.condition:
                        self.responses[
                            message["id"]
                        ] = message
                        self.condition.notify_all()

        except Exception:
            with self.condition:
                self.condition.notify_all()

    def request(
        self,
        method,
        params=None,
        timeout=REQUEST_TIMEOUT,
    ):
        with self.condition:
            request_id = self.next_id
            self.next_id += 1

        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            }
        )

        deadline = time.monotonic() + timeout

        with self.condition:
            while request_id not in self.responses:
                remaining = deadline - time.monotonic()

                if remaining <= 0:
                    raise TimeoutError(
                        f"LSP timeout: {method}"
                    )

                if self.process.poll() is not None:
                    raise RuntimeError(
                        f"LSP exited rc={self.process.returncode} "
                        f"during {method}: "
                        f"{self.stderr.decode(errors='replace')[-2000:]}"
                    )

                self.condition.wait(
                    timeout=min(0.1, remaining)
                )

            response = self.responses.pop(request_id)

        if "error" in response:
            error = response["error"]
            raise RuntimeError(
                f"LSP error {method}: "
                f"{error.get('code')} "
                f"{error.get('message')}"
            )

        return response.get("result")

    def notify(self, method, params=None):
        self._send(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": params or {},
            }
        )

    def initialize(self):
        started = time.perf_counter()

        result = self.request(
            "initialize",
            {
                "processId": os.getpid(),
                "clientInfo": {
                    "name":
                        "opencode-semantic-bench",
                    "version": "1",
                },
                "rootUri": self.root_uri,
                "workspaceFolders": [
                    {
                        "uri": self.root_uri,
                        "name": self.root.name,
                    }
                ],
                "capabilities": {
                    "workspace": {
                        "configuration": True,
                        "workspaceFolders": True,
                    },
                    "textDocument": {
                        "definition": {},
                        "references": {},
                        "implementation": {},
                        "callHierarchy": {},
                    },
                },
                "initializationOptions":
                    self.init_options,
            },
            timeout=STARTUP_TIMEOUT,
        )

        self.notify("initialized", {})

        self.capabilities = (
            (result or {}).get("capabilities")
            or {}
        )

        return (
            time.perf_counter() - started
        ) * 1000

    def open(self, path: Path, language: str):
        text = path.read_text(encoding="utf-8")

        self.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri(path),
                    "languageId": language,
                    "version": 1,
                    "text": text,
                }
            },
        )

    def shutdown(self):
        self.sampler.stop()

        try:
            self.request(
                "shutdown",
                timeout=3,
            )
            self.notify("exit")
            self.process.wait(timeout=3)
        except Exception:
            self.process.kill()
            self.process.wait(timeout=3)


def create_python_fixture(root: Path):
    root.mkdir(parents=True)

    (root / "pyproject.toml").write_text(
        """
[project]
name = "semantic-fixture"
version = "0.0.0"
requires-python = ">=3.11"
""".lstrip(),
        encoding="utf-8",
    )

    (root / "lib.py").write_text(
        """
class Base:
    def run(self) -> str:
        return "base"

def target(x: int) -> int:
    return x + 1
""".lstrip(),
        encoding="utf-8",
    )

    (root / "impl.py").write_text(
        """
from lib import Base

class Child(Base):
    def run(self) -> str:
        return "child"
""".lstrip(),
        encoding="utf-8",
    )

    (root / "use.py").write_text(
        """
from lib import Base
from lib import target as aliased

def local_shadow() -> int:
    target = lambda x: x * 2
    return target(3)

def imported_call() -> int:
    return aliased(4)

def dispatch(value: Base) -> str:
    return value.run()
""".lstrip(),
        encoding="utf-8",
    )


def create_ts_fixture(root: Path):
    src = root / "src"
    src.mkdir(parents=True)

    (root / "package.json").write_text(
        json.dumps(
            {
                "name": "semantic-fixture",
                "private": True,
                "type": "module",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    (root / "tsconfig.json").write_text(
        json.dumps(
            {
                "compilerOptions": {
                    "target": "ES2022",
                    "module": "ESNext",
                    "moduleResolution": "bundler",
                    "strict": True,
                    "noEmit": True,
                    "baseUrl": ".",
                    "paths": {
                        "@core/*": ["src/*"]
                    },
                },
                "include": ["src/**/*.ts"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    (src / "core.ts").write_text(
        """
export interface Runner {
  run(): string;
}

export function target(x: number): number {
  return x + 1;
}
""".lstrip(),
        encoding="utf-8",
    )

    (src / "impl.ts").write_text(
        """
import type { Runner } from "./core";

export class Child implements Runner {
  run(): string {
    return "child";
  }
}
""".lstrip(),
        encoding="utf-8",
    )

    (src / "barrel.ts").write_text(
        """
export { target as aliased } from "./core";
""".lstrip(),
        encoding="utf-8",
    )

    (src / "use.ts").write_text(
        """
import { aliased } from "./barrel";
import type { Runner } from "./core";

export function importedCall(): number {
  return aliased(4);
}

export function localShadow(): number {
  const aliased = (x: number) => x * 2;
  return aliased(3);
}

export function dispatch(value: Runner): string {
  return value.run();
}
""".lstrip(),
        encoding="utf-8",
    )

    (src / "pathuse.ts").write_text(
        """
import { target as pathTarget } from "@core/core";

export const pathResult = pathTarget(7);
""".lstrip(),
        encoding="utf-8",
    )


def provider_supported(capabilities, key):
    value = capabilities.get(key)
    return bool(value)


def evaluate_location(
    locations,
    expected_file: Path,
    expected_line: int,
):
    expected = str(expected_file.resolve())

    for loc in locations:
        if (
            loc["path"] == expected
            and loc["line"] == expected_line
        ):
            return True

    return False


def run_definition_case(
    client,
    name,
    query_file,
    needle,
    occurrence,
    expected_file,
    expected_marker,
):
    if not provider_supported(
        client.capabilities,
        "definitionProvider",
    ):
        return {
            "name": name,
            "method": "definition",
            "status": "unsupported",
        }

    position = find_position(
        query_file,
        needle,
        occurrence,
    )

    started = time.perf_counter()

    result = client.request(
        "textDocument/definition",
        {
            "textDocument": {
                "uri": uri(query_file)
            },
            "position": position,
        },
    )

    elapsed = (
        time.perf_counter() - started
    ) * 1000

    locations = normalize_locations(result)
    expected_line = line_of(
        expected_file,
        expected_marker,
    )

    passed = evaluate_location(
        locations,
        expected_file,
        expected_line,
    )

    return {
        "name": name,
        "method": "definition",
        "status": "pass" if passed else "fail",
        "elapsed_ms": round(elapsed, 3),
        "locations": locations,
        "expected": {
            "path": str(expected_file.resolve()),
            "line": expected_line,
        },
    }


def run_references_case(
    client,
    name,
    query_file,
    needle,
    occurrence,
    forbidden_lines,
):
    if not provider_supported(
        client.capabilities,
        "referencesProvider",
    ):
        return {
            "name": name,
            "method": "references",
            "status": "unsupported",
        }

    position = find_position(
        query_file,
        needle,
        occurrence,
    )

    started = time.perf_counter()

    result = client.request(
        "textDocument/references",
        {
            "textDocument": {
                "uri": uri(query_file)
            },
            "position": position,
            "context": {
                "includeDeclaration": True
            },
        },
    )

    elapsed = (
        time.perf_counter() - started
    ) * 1000

    locations = normalize_locations(result)

    forbidden = {
        (str(path.resolve()), line)
        for path, line in forbidden_lines
    }

    bad = [
        loc
        for loc in locations
        if (loc["path"], loc["line"]) in forbidden
    ]

    passed = len(locations) >= 1 and not bad

    return {
        "name": name,
        "method": "references",
        "status": "pass" if passed else "fail",
        "elapsed_ms": round(elapsed, 3),
        "locations": locations,
        "forbidden_hits": bad,
    }


def run_implementation_case(
    client,
    name,
    query_file,
    needle,
    occurrence,
    expected_file,
    expected_marker,
):
    if not provider_supported(
        client.capabilities,
        "implementationProvider",
    ):
        return {
            "name": name,
            "method": "implementation",
            "status": "unsupported",
        }

    position = find_position(
        query_file,
        needle,
        occurrence,
    )

    started = time.perf_counter()

    try:
        result = client.request(
            "textDocument/implementation",
            {
                "textDocument": {
                    "uri": uri(query_file)
                },
                "position": position,
            },
        )
    except RuntimeError as error:
        return {
            "name": name,
            "method": "implementation",
            "status": "error",
            "error": str(error),
        }

    elapsed = (
        time.perf_counter() - started
    ) * 1000

    locations = normalize_locations(result)
    expected_line = line_of(
        expected_file,
        expected_marker,
    )

    passed = evaluate_location(
        locations,
        expected_file,
        expected_line,
    )

    return {
        "name": name,
        "method": "implementation",
        "status": "pass" if passed else "fail",
        "elapsed_ms": round(elapsed, 3),
        "locations": locations,
    }


def run_engine(
    *,
    name,
    language,
    command,
    root,
    init_options,
    cases,
):
    if not command:
        return {
            "engine": name,
            "status": "unavailable",
        }

    executable = command[0]

    if (
        "/" in executable
        and not Path(executable).exists()
    ):
        return {
            "engine": name,
            "status": "unavailable",
            "command": command,
        }

    client = None

    try:
        client = LspClient(
            command,
            root,
            init_options=init_options,
        )

        startup_ms = client.initialize()

        extensions = (
            {".py": "python"}
            if language == "python"
            else {
                ".ts": "typescript",
                ".tsx": "typescriptreact",
                ".js": "javascript",
                ".jsx": "javascriptreact",
            }
        )

        for path in sorted(root.rglob("*")):
            lang = extensions.get(path.suffix)

            if lang:
                client.open(path, lang)

        results = [
            case(client)
            for case in cases
        ]

        peak_kb = client.sampler.peak_kb

        statuses = [
            item["status"]
            for item in results
        ]

        hard_fail = any(
            value in {"fail", "error"}
            for value in statuses
        )

        timings = [
            item["elapsed_ms"]
            for item in results
            if isinstance(
                item.get("elapsed_ms"),
                (int, float),
            )
        ]

        return {
            "engine": name,
            "status":
                "fail" if hard_fail else "pass",
            "command": command,
            "startup_ms": round(startup_ms, 3),
            "peak_rss_mb": round(
                peak_kb / 1024,
                2,
            ),
            "median_query_ms": (
                round(statistics.median(timings), 3)
                if timings
                else None
            ),
            "capabilities": {
                "definition":
                    provider_supported(
                        client.capabilities,
                        "definitionProvider",
                    ),
                "references":
                    provider_supported(
                        client.capabilities,
                        "referencesProvider",
                    ),
                "implementation":
                    provider_supported(
                        client.capabilities,
                        "implementationProvider",
                    ),
                "call_hierarchy":
                    provider_supported(
                        client.capabilities,
                        "callHierarchyProvider",
                    ),
            },
            "cases": results,
        }

    except Exception as error:
        return {
            "engine": name,
            "status": "error",
            "command": command,
            "error": str(error),
            "stderr": (
                client.stderr.decode(
                    errors="replace"
                )[-4000:]
                if client
                else None
            ),
        }

    finally:
        if client:
            client.shutdown()


def python_cases(root: Path):
    lib = root / "lib.py"
    impl = root / "impl.py"
    use = root / "use.py"

    return [
        lambda c: run_definition_case(
            c,
            "alias_import_definition",
            use,
            "aliased(4)",
            1,
            lib,
            "def target(",
        ),
        lambda c: run_definition_case(
            c,
            "local_shadow_definition",
            use,
            "target(3)",
            1,
            use,
            "target = lambda",
        ),
        lambda c: run_references_case(
            c,
            "alias_references_no_shadow_leak",
            use,
            "aliased(4)",
            1,
            [
                (
                    use,
                    line_of(
                        use,
                        "target = lambda",
                    ),
                ),
                (
                    use,
                    line_of(
                        use,
                        "return target(3)",
                    ),
                ),
            ],
        ),
        lambda c: run_implementation_case(
            c,
            "method_implementation",
            lib,
            "run(self)",
            1,
            impl,
            "def run(self)",
        ),
    ]


def ts_cases(root: Path):
    src = root / "src"
    core = src / "core.ts"
    impl = src / "impl.ts"
    use = src / "use.ts"
    pathuse = src / "pathuse.ts"

    return [
        lambda c: run_definition_case(
            c,
            "barrel_reexport_definition",
            use,
            "aliased(4)",
            1,
            core,
            "export function target(",
        ),
        lambda c: run_definition_case(
            c,
            "local_shadow_definition",
            use,
            "aliased(3)",
            1,
            use,
            "const aliased =",
        ),
        lambda c: run_definition_case(
            c,
            "tsconfig_path_alias_definition",
            pathuse,
            "pathTarget(7)",
            1,
            core,
            "export function target(",
        ),
        lambda c: run_references_case(
            c,
            "barrel_alias_references_no_shadow_leak",
            use,
            "aliased(4)",
            1,
            [
                (
                    use,
                    line_of(
                        use,
                        "const aliased =",
                    ),
                ),
                (
                    use,
                    line_of(
                        use,
                        "return aliased(3)",
                    ),
                ),
            ],
        ),
        lambda c: run_implementation_case(
            c,
            "interface_implementation",
            core,
            "run(): string",
            1,
            impl,
            "run(): string",
        ),
    ]


def main():
    temp = Path(
        tempfile.mkdtemp(
            prefix="v224-semantic-"
        )
    )

    try:
        python_root = temp / "python"
        ts_root = temp / "typescript"

        create_python_fixture(python_root)
        create_ts_fixture(ts_root)

        pyrefly = shutil.which("pyrefly")
        ty = shutil.which("ty")

        pyright = (
            TOOLS
            / "pyright/node_modules/.bin/"
            "pyright-langserver"
        )

        ts7 = (
            TOOLS
            / "ts7/node_modules/.bin/tsc"
        )

        ts6_server = (
            TOOLS
            / "ts6/node_modules/.bin/"
            "typescript-language-server"
        )

        ts6_lib = (
            TOOLS
            / "ts6/node_modules/typescript/lib/"
            "tsserver.js"
        )

        engines = [
            {
                "name": "pyrefly",
                "language": "python",
                "command":
                    [pyrefly, "lsp"]
                    if pyrefly
                    else None,
                "root": python_root,
                "init_options": {
                    "pyrefly": {
                        "typeCheckingMode": "basic",
                        "disableTypeErrors": True,
                    }
                },
                "cases": python_cases(
                    python_root
                ),
            },
            {
                "name": "ty",
                "language": "python",
                "command":
                    [ty, "server"]
                    if ty
                    else None,
                "root": python_root,
                "init_options": {},
                "cases": python_cases(
                    python_root
                ),
            },
            {
                "name": "pyright",
                "language": "python",
                "command": [
                    str(pyright),
                    "--stdio",
                ],
                "root": python_root,
                "init_options": {},
                "cases": python_cases(
                    python_root
                ),
            },
            {
                "name": "typescript7-native",
                "language": "typescript",
                "command": [
                    str(ts7),
                    "--lsp",
                    "--stdio",
                ],
                "root": ts_root,
                "init_options": {},
                "cases": ts_cases(ts_root),
            },
            {
                "name": "typescript6-language-server",
                "language": "typescript",
                "command": [
                    str(ts6_server),
                    "--stdio",
                    "--log-level",
                    "1",
                ],
                "root": ts_root,
                "init_options": {
                    "disableAutomaticTypingAcquisition":
                        True,
                    "tsserver": {
                        "path": str(ts6_lib),
                        "useSyntaxServer": "never",
                    },
                },
                "cases": ts_cases(ts_root),
            },
        ]

        results = []

        for spec in engines:
            print(
                f">>> {spec['name']}",
                flush=True,
            )

            result = run_engine(**spec)
            results.append(result)

            print(
                json.dumps(
                    result,
                    indent=2,
                    sort_keys=True,
                ),
                flush=True,
            )

        report = {
            "protocol": PROTOCOL,
            "generated_at_ms":
                int(time.time() * 1000),
            "results": results,
        }

        output = (
            Path.cwd()
            / ".opencode"
            / "semantic-engine-shootout-v1.json"
        )

        output.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        output.write_text(
            json.dumps(
                report,
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        print()
        print("=== SUMMARY ===")

        for result in results:
            print(
                f"{result['engine']:30} "
                f"status={result['status']:11} "
                f"startup_ms="
                f"{result.get('startup_ms')} "
                f"median_query_ms="
                f"{result.get('median_query_ms')} "
                f"peak_rss_mb="
                f"{result.get('peak_rss_mb')}"
            )

            for case in result.get(
                "cases",
                [],
            ):
                print(
                    f"  "
                    f"{case['name']:38} "
                    f"{case['status']}"
                )

        false_results = []

        for result in results:
            for case in result.get(
                "cases",
                [],
            ):
                if case["status"] in {
                    "fail",
                    "error",
                }:
                    false_results.append(
                        (
                            result["engine"],
                            case["name"],
                            case["status"],
                        )
                    )

        print()
        print(
            "false_or_error_results=",
            false_results,
        )
        print(f"report={output}")

        if false_results:
            raise SystemExit(2)

        print()
        print(
            "PASS semantic engine synthetic "
            "correctness gate"
        )

    finally:
        shutil.rmtree(
            temp,
            ignore_errors=True,
        )


if __name__ == "__main__":
    main()
