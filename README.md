# opencode-low_cpu-agent

Experimental low-CPU local coding-agent runtime for OpenCode.

## Current architecture

- OpenCode V2 global plugin
- one model-facing `search` tool
- turn-scoped search/model governor
- dynamic per-session project root
- ripgrep first-stage discovery
- Rust structural evidence distiller
- ast-grep/tree-sitter structural backend
- llama.cpp local inference

## Current status

Proven:

- global OpenCode plugin
- dynamic project-root resolution
- multi-repository isolation
- per-user-turn governor reset
- model-call accounting
- bounded search evidence
- Rust evidence-distiller standalone smoke test

In progress:

- pressure-based integration of structural evidence distillation into `search`

## Layout

```text
opencode/
  plugins/
    cpu-search.ts

rust/
  evidence-distiller/
    Cargo.toml
    Cargo.lock
    rust-toolchain.toml
    src/main.rs

llama/
  run-north.example.sh
```

The repository is intended to become the source of truth.
Installed runtime files are generated/copied from this repository.
