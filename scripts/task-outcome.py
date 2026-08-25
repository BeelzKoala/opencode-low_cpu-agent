#!/usr/bin/env python3
from pathlib import Path
import argparse
import json
import re

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--jsonl", required=True)
parser.add_argument("--cli-rc", type=int, required=True)
args = parser.parse_args()

repo = Path(args.repo).resolve()
terminal = None

for line in Path(args.jsonl).read_text(
    encoding="utf-8", errors="replace"
).splitlines():
    try:
        row = json.loads(line)
    except Exception:
        continue
    if row.get("type") != "tool_use":
        continue
    part = row.get("part") or {}
    state = part.get("state") or {}
    output = str(state.get("output") or row.get("output") or "")
    metadata = state.get("metadata") or row.get("metadata") or {}

    if "PATCH_READY" in output:
        terminal = ("VERIFIED", output, metadata)
    elif "PATCH_STOP" in output:
        terminal = ("SAFE_FAIL", output, metadata)

if terminal is None:
    record = {
        "protocol": "task-outcome-v1",
        "state": "TRANSPORT_FAIL",
        "authority": "no_terminal_event",
        "upstream_cli_rc": args.cli_rc,
        "transport_mismatch": False,
    }
else:
    semantic_state, output, metadata = terminal
    authority = "tool_terminal_event"
    receipt = None

    if semantic_state == "VERIFIED":
        rel = metadata.get("receipt_path")
        match = re.search(r"\breceipt=([^\s]+)", output)
        rel = rel or (match.group(1) if match else None)

        try:
            receipt = json.loads((repo / rel).read_text(encoding="utf-8")) if rel else None
        except Exception:
            receipt = None

        if not isinstance(receipt, dict) or receipt.get("protocol") != "patch-receipt-v1":
            semantic_state = "TRANSPORT_FAIL"
            authority = "invalid_patch_receipt"
        else:
            verification_rel = receipt.get("verification_receipt")
            try:
                wrapper = (
                    json.loads((repo / verification_rel).read_text(encoding="utf-8"))
                    if isinstance(verification_rel, str)
                    else None
                )
            except Exception:
                wrapper = None
            verifier = wrapper.get("verifier") if isinstance(wrapper, dict) else None
            if not isinstance(verifier, dict) or verifier.get("ok") is not True:
                semantic_state = "TRANSPORT_FAIL"
                authority = "verification_receipt_invalid"
            else:
                authority = "patch_receipt_plus_verification_receipt"

    record = {
        "protocol": "task-outcome-v1",
        "state": semantic_state,
        "authority": authority,
        "upstream_cli_rc": args.cli_rc,
        "transport_mismatch": semantic_state == "VERIFIED" and args.cli_rc != 0,
        "patch_receipt": receipt,
    }

print(json.dumps(record, indent=2, ensure_ascii=False))
