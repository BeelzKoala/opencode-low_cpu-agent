#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]

C7 = (
    ROOT /
    "opencode/plugins/cpu-search-core/"
    "execution-control-kernel-v1.mjs"
)
SYNTH = (
    ROOT /
    "opencode/plugins/cpu-search-core/"
    "deterministic-argument-synthesis-v1.mjs"
)

REQUIRED = re.compile(
    r'toolChoice\s*:\s*\{\s*'
    r'type\s*:\s*["\']required["\']\s*'
    r'\}',
    re.S,
)
NAMED = re.compile(
    r'toolChoice\s*:\s*\{\s*'
    r'type\s*:\s*["\']tool["\']\s*,\s*'
    r'toolName\s*:\s*[^}]+'
    r'\}',
    re.S,
)
SINGLETON = re.compile(
    r'if\s*\(\s*tools\.length\s*!==\s*1\s*\)',
    re.S,
)


def read(path: Path) -> str:
    assert path.is_file(), f"missing source: {path}"
    return path.read_text(encoding="utf-8")


c7 = read(C7)
synth = read(SYNTH)

assert (
    "export function compileProviderDispatchContract" in c7
), "C7 provider dispatch contract missing"

assert SINGLETON.search(c7), (
    "C7 singleton provider frontier gate missing"
)

assert (
    "compileArgumentSynthesisDispatch" in c7
), "C7 does not delegate provider options to deterministic argument synthesis"

assert (
    "model_action_authority: false" in c7
), "C7 model action authority widened"

for reason in (
    "execution_control_missing_required_tool_call",
    "execution_control_multiple_tool_calls",
    "execution_control_wrong_tool_call",
    "execution_control_incomplete_tool_call",
):
    assert reason in c7, (
        f"C7 fail-closed validation missing: {reason}"
    )

assert REQUIRED.search(synth), (
    "deterministic argument synthesis required toolChoice missing"
)

assert not NAMED.search(c7), (
    "provider-specific named toolChoice leaked back into C7"
)
assert not NAMED.search(synth), (
    "provider-specific named toolChoice leaked into argument synthesis"
)

print(
    "PASS C7-R1 provider enforcement "
    "ownership=deterministic_argument_synthesis "
    "deterministic_singleton=required "
    "named_tool_choice_absent=true "
    "fail_closed_return_validation=true "
    "provider_enforcement=grammar_constrained "
    "model_action_authority=false"
)
