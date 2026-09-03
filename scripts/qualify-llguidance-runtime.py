#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROTOCOL = "llguidance-runtime-attestation-v2"


def compact_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(value) -> str:
    return sha256_bytes(compact_json(value).encode("utf-8"))


def request_json(url: str, *, method: str = "GET", body=None, timeout: int = 120):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = compact_json(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        raise SystemExit(
            f"STOP HTTP {exc.code} {url}: "
            + raw[:1200].decode("utf-8", "replace")
        ) from exc
    except OSError as exc:
        raise SystemExit(f"STOP request failed {url}: {exc}") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"STOP invalid JSON from {url}: {raw[:1200]!r}") from exc


def parse_proc_start_ticks(pid: int) -> str:
    text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="strict")
    close = text.rfind(")")
    if close < 0:
        raise SystemExit("STOP malformed /proc stat")
    fields = text[close + 1 :].strip().split()
    if len(fields) <= 19 or not fields[19].isdecimal():
        raise SystemExit("STOP invalid /proc process starttime")
    return fields[19]


def listener_socket_inodes(port: int) -> set[str]:
    wanted = f"{port:04X}"
    result: set[str] = set()
    for filename in ("/proc/net/tcp", "/proc/net/tcp6"):
        path = Path(filename)
        if not path.is_file():
            continue
        for line in path.read_text(encoding="ascii", errors="replace").splitlines()[1:]:
            parts = line.split()
            if len(parts) < 10 or parts[3] != "0A":
                continue
            try:
                _addr, local_port = parts[1].rsplit(":", 1)
            except ValueError:
                continue
            if local_port.upper() == wanted:
                result.add(parts[9])
    return result


def find_listener_pid(port: int) -> int:
    inodes = listener_socket_inodes(port)
    if not inodes:
        raise SystemExit(f"STOP no LISTEN socket for port={port}")

    owners: set[int] = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            fds = list((proc / "fd").iterdir())
        except (PermissionError, FileNotFoundError):
            continue
        for fd in fds:
            try:
                target = os.readlink(fd)
            except (FileNotFoundError, PermissionError, OSError):
                continue
            if not target.startswith("socket:["):
                continue
            inode = target[len("socket:[") : -1]
            if inode in inodes:
                owners.add(int(proc.name))
                break

    if len(owners) != 1:
        raise SystemExit(
            f"STOP listener pid ambiguous port={port} owners={sorted(owners)}"
        )
    return next(iter(owners))


def process_identity(pid: int) -> dict:
    proc = Path(f"/proc/{pid}")
    exe_link = proc / "exe"
    try:
        exe = exe_link.resolve(strict=True)
        exe_stat = exe_link.stat()
        cmdline = (proc / "cmdline").read_bytes()
    except (FileNotFoundError, PermissionError, OSError) as exc:
        raise SystemExit(f"STOP cannot inspect llama-server pid={pid}: {exc}") from exc

    if b"llama-server" not in cmdline:
        raise SystemExit(f"STOP listener pid={pid} is not llama-server")

    return {
        "server_pid": pid,
        "server_start_ticks": parse_proc_start_ticks(pid),
        "server_exe": str(exe),
        "server_exe_dev": str(exe_stat.st_dev),
        "server_exe_ino": str(exe_stat.st_ino),
        "server_exe_sha256": sha256_bytes(exe.read_bytes()),
    }


def infer_build_dir(exe: Path) -> Path:
    if exe.name != "llama-server":
        raise SystemExit(f"STOP unexpected server executable: {exe}")
    build = exe.parent.parent
    cache = build / "CMakeCache.txt"
    if not cache.is_file():
        raise SystemExit(f"STOP running server is not bound to CMakeCache: {cache}")
    return build


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--model", default="north-mini-code-local")
    parser.add_argument(
        "--attestation-out",
        default=str(
            Path.home()
            / ".cache/opencode-lowcpu/llguidance-attestation-v2.json"
        ),
    )
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--server-pid", type=int, default=None)
    args = parser.parse_args()

    if args.trials < 2 or args.trials > 8:
        raise SystemExit("STOP --trials must be 2..8")

    parsed = urllib.parse.urlparse(args.base_url)
    if parsed.scheme not in ("http", "https"):
        raise SystemExit("STOP unsupported base-url scheme")
    if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("STOP R7 local attestation requires loopback base-url")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    pid = args.server_pid if args.server_pid is not None else find_listener_pid(port)
    before = process_identity(pid)
    exe = Path(before["server_exe"])
    build_dir = infer_build_dir(exe)
    cache = build_dir / "CMakeCache.txt"
    cache_text = cache.read_text(encoding="utf-8", errors="replace")
    if "LLAMA_LLGUIDANCE:BOOL=ON" not in cache_text:
        raise SystemExit("STOP running llama-server build is not LLAMA_LLGUIDANCE=ON")

    base = args.base_url.rstrip("/")
    props = request_json(base + "/props", timeout=args.timeout)

    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["protocol", "ok", "value"],
        "properties": {
            "protocol": {"type": "string", "const": PROTOCOL},
            "ok": {"type": "boolean", "const": True},
            "value": {"type": "integer", "const": 7},
        },
    }

    request_payload = {
        "model": args.model,
        "messages": [
            {
                "role": "user",
                "content": (
                    "Return exactly the plain text token BROKEN. "
                    "Do not return JSON."
                ),
            }
        ],
        "temperature": 0,
        "max_tokens": 384,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "llguidance_runtime_probe",
                "strict": True,
                "schema": schema,
            },
        },
    }

    expected = {"protocol": PROTOCOL, "ok": True, "value": 7}
    response_hashes: list[str] = []
    for trial in range(args.trials):
        result = request_json(
            base + "/v1/chat/completions",
            method="POST",
            body=request_payload,
            timeout=args.timeout,
        )
        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise SystemExit(
                "STOP chat completion shape invalid trial="
                f"{trial}: "
                + json.dumps(result, ensure_ascii=False)[:2000]
            ) from exc
        if not isinstance(content, str):
            raise SystemExit(f"STOP constrained content not string trial={trial}")
        try:
            decoded = json.loads(content)
        except json.JSONDecodeError as exc:
            raise SystemExit(
                f"STOP constrained output is not JSON trial={trial}: {content[:1200]!r}"
            ) from exc
        if decoded != expected:
            raise SystemExit(
                f"STOP constrained output mismatch trial={trial}: "
                + json.dumps(decoded, ensure_ascii=False)
            )
        response_hashes.append(sha256_json(decoded))

    after = process_identity(pid)
    for key in (
        "server_pid",
        "server_start_ticks",
        "server_exe",
        "server_exe_dev",
        "server_exe_ino",
        "server_exe_sha256",
    ):
        if before[key] != after[key]:
            raise SystemExit(f"STOP llama-server changed during probe field={key}")

    epoch = int(time.time())
    attestation_payload = {
        "protocol": PROTOCOL,
        "epoch": epoch,
        "base_url": base,
        "model": args.model,
        **after,
        "server_build_info": props.get("build_info"),
        "server_model_alias": props.get("model_alias"),
        "cmake_cache_sha256": sha256_bytes(cache.read_bytes()),
        "schema_sha256": sha256_json(schema),
        "response_sha256": sha256_json(expected),
        "trials": args.trials,
        "trial_response_sha256": response_hashes,
        "result": "constrained_schema_exact",
        "mutation_authority": False,
    }

    payload_json = compact_json(attestation_payload)
    proof = sha256_bytes(payload_json.encode("utf-8"))
    envelope = {
        "protocol": PROTOCOL,
        "payload_json": payload_json,
        "proof_sha256": proof,
    }

    out = Path(args.attestation_out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(compact_json(envelope) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, out)

    print("PASS LLGuidance live-process runtime probe")
    print(f"proof_sha256={proof}")
    print(f"server_pid={pid}")
    print(f"server_start_ticks={after['server_start_ticks']}")
    print(f"server_exe_sha256={after['server_exe_sha256']}")
    print(f"trials={args.trials}")
    print(f"attestation_file={out}")
    print("restart_invalidates_attestation=true")


if __name__ == "__main__":
    main()
