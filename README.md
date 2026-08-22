# opencode-low_cpu-agent

Experimental low-CPU local coding-agent runtime for OpenCode.

## Current architecture

- OpenCode V2 global plugin
- one model-facing `search` tool
- turn-scoped search/model governor
- dynamic per-session project root
- ripgrep file-level lexical discovery (`--files-with-matches`)
- deterministic candidate relevance ranking by multi-query coverage + path affinity
- query rarity used for fairness reservation/telemetry, not semantic relevance
- internal probe pool of up to eight lexical files, with at most four evidence files emitted
- post-probe relevance refinement using bounded line/definition evidence
- budgeted region routing for dense evidence before model-facing INDEX fallback
- focused-context cost guard and compact model-visible route metadata
- separate routing and evidence novelty ledgers
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
- file-level discovery that cannot be starved by one file with many line hits
- query-fair auto-refinement for compound searches
- explicit `lexical_discovery_complete` vs global `scan_complete`
- `ranked_raw`, `ranked_focused`, and `ranked_hybrid` broad-search representations
- retained-unread lexical candidates are never treated as absent
- focused structural reading can run after ranking even when the repository-wide
  line search would be too broad
- Rust evidence-distiller standalone smoke test
- pressure-based structural evidence distillation inside `search`

Roadmap:

- v2.12-A budgeted region router — DONE
- v2.12-B probe-more / emit-less — CURRENT
- v2.13 incremental symbol/file graph only if benchmark misses justify it

See `docs/ARCHITECTURE_PLAN.md`, `benchmarks/v2.12-a-gates.json`, and `benchmarks/v2.12-b-gates.json`.

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
