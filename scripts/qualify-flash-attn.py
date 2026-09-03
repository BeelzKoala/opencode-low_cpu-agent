#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
from pathlib import Path


def run_mode(args, mode: str):
    bench = Path(args.llama_bench).expanduser().resolve()
    model = Path(args.model).expanduser().resolve()
    if not bench.is_file():
        raise SystemExit(f"STOP llama-bench missing: {bench}")
    if not model.is_file():
        raise SystemExit(f"STOP local GGUF missing: {model}")

    cmd = [
        str(bench),
        "-m", str(model),
        "-p", str(args.prompt_tokens),
        "-n", str(args.gen_tokens),
        "-pg", f"{args.prompt_tokens},{args.gen_tokens}",
        "-r", str(args.repetitions),
        "-t", str(args.threads),
        "-ctk", args.cache_type_k,
        "-ctv", args.cache_type_v,
        "-fa", mode,
        "-o", "json",
    ]
    if args.extra_args:
        cmd.extend(shlex.split(args.extra_args))

    proc = subprocess.run(
        cmd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        return {
            "mode": mode,
            "ok": False,
            "error": proc.stderr[-5000:],
        }

    try:
        rows = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {
            "mode": mode,
            "ok": False,
            "error": "invalid llama-bench JSON: " + proc.stdout[-3000:],
        }

    pp = tg = pg = None
    for row in rows if isinstance(rows, list) else []:
        n_prompt = int(row.get("n_prompt") or 0)
        n_gen = int(row.get("n_gen") or 0)
        avg_ns = float(row.get("avg_ns") or 0)
        avg_ts = float(row.get("avg_ts") or 0)
        if avg_ns <= 0 or avg_ts <= 0:
            continue
        metric = {"avg_ns": avg_ns, "avg_ts": avg_ts}
        if n_prompt == args.prompt_tokens and n_gen == 0:
            pp = metric
        elif n_prompt == 0 and n_gen == args.gen_tokens:
            tg = metric
        elif n_prompt == args.prompt_tokens and n_gen == args.gen_tokens:
            pg = metric

    if pp is None or tg is None or pg is None:
        return {
            "mode": mode,
            "ok": False,
            "error": "expected pp/tg/pg rows absent",
        }

    return {"mode": mode, "ok": True, "pp": pp, "tg": tg, "pg": pg}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--llama-bench",
        default=str(Path.home() / "llama.cpp/build/bin/llama-bench"),
    )
    parser.add_argument(
        "--model",
        required=True,
        help="exact local production GGUF; network/HF fallback is forbidden",
    )
    parser.add_argument("--baseline", choices=("off", "auto", "on"), required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--prompt-tokens", type=int, default=4096)
    parser.add_argument("--gen-tokens", type=int, default=768)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--cache-type-k", required=True)
    parser.add_argument("--cache-type-v", required=True)
    parser.add_argument(
        "--extra-args",
        default="",
        help="exact extra llama-bench runtime flags, e.g. '-ngl 0 -b 512 -ub 512'",
    )
    parser.add_argument("--min-speedup", type=float, default=0.05)
    args = parser.parse_args()

    if args.prompt_tokens < 1 or args.gen_tokens < 1 or args.repetitions < 2 or args.threads < 1:
        raise SystemExit("STOP invalid benchmark dimensions")

    results = [run_mode(args, mode) for mode in ("off", "auto", "on")]

    print("=== FLASH ATTENTION QUALIFICATION ===")
    for row in results:
        if not row["ok"]:
            print(f"{row['mode']:>4} UNAVAILABLE {row['error'].splitlines()[-1][:300]}")
            continue
        print(
            f"{row['mode']:>4} "
            f"pp={row['pp']['avg_ts']:.3f} tok/s "
            f"tg={row['tg']['avg_ts']:.3f} tok/s "
            f"pg={row['pg']['avg_ns'] / 1e9:.3f}s"
        )

    by_mode = {row["mode"]: row for row in results}
    baseline = by_mode[args.baseline]
    if not baseline["ok"]:
        raise SystemExit(
            f"STOP declared baseline mode={args.baseline} is unavailable; "
            "benchmark must match real runtime configuration"
        )

    viable = [row for row in results if row["ok"]]
    winner = min(viable, key=lambda row: row["pg"]["avg_ns"])
    speedup = baseline["pg"]["avg_ns"] / winner["pg"]["avg_ns"] - 1.0

    print()
    print(
        f"baseline={args.baseline} winner={winner['mode']} "
        f"pg_speedup_vs_baseline={speedup * 100:.2f}%"
    )

    if winner["mode"] != args.baseline and speedup >= args.min_speedup:
        print(
            f"CANDIDATE flash_attn={winner['mode']} promotion=false "
            "reason=requires_real_e2e_correctness_parity"
        )
        print(f"NEXT after parity: export LLAMA_ARG_FLASH_ATTN={winner['mode']}")
    else:
        print(
            f"PASS flash_attn_not_promoted keep={args.baseline} "
            "reason=no_material_pg_speedup"
        )


if __name__ == "__main__":
    main()
