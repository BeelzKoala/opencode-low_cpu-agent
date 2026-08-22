# Low-CPU agent architecture plan

The governing constraint is: local CPU inference is expensive; deterministic search,
indexing and verification are cheap. New runtime layers are accepted only when they
reduce model turns, reduce model-facing context, or improve localization recall without
weakening evidence safety.

## Long-horizon agent pipeline

1. **Scout** — bounded reconnaissance, no editing.
2. **Governor** — per-turn budgets, loop suppression, model-call and wall limits.
3. **Evidence router / reader** — broad lexical intent -> trustworthy source regions in
   the same tool call. This is the current work.
4. **Execution / patch stage** — consume scoped evidence and make the smallest practical
   change.
5. **Review / verification stage** — deterministic checks first, then bounded review of
   the patch and affected behavior.

Scout and Governor are not superseded by the router. The router is the reading layer
between bounded reconnaissance and execution.

## Search/evidence roadmap

### v2.11 — Ranked file routing — DONE

File-level `rg --files-with-matches`, direct lexical candidate retention, query-fair
same-call refinement, separate discovery/line completeness and separate route/evidence
novelty ledgers.

### v2.12-A — Budgeted region router — DONE

- fairness is separate from relevance;
- route scores stay in telemetry, not model-facing text;
- focused context has a bounded cost premium;
- dense evidence auto-routes to sampled AST scopes before INDEX;
- route-only novelty does not bypass evidence no-progress.

### v2.12-B — Probe-more / emit-less — CURRENT

- probe 6–8 lexical files inside the tool;
- emit only the best evidence regions under the evidence budget;
- preserve at least one direct candidate per non-empty query;
- rank regions by query coverage, structural role, task/path anchors and marginal
  evidence-per-byte.

### v2.13 — Incremental RepoIndex — CONDITIONAL

Build only if v2.12 benchmarks show misses where the needed file has no direct lexical
seed: incremental defs/imports/refs, forward + reverse edges, working-set prior and
one-hop graph expansion. PageRank is optional after this. Embeddings and a second
explorer model remain out of scope until benchmarks justify their CPU/RAM cost.

## Permanent invariants

1. Routing may be heuristic; evidence must not overclaim completeness.
2. Direct lexical matches may be reordered, never removed from the candidate universe.
3. Sampled region evidence is explicitly sampled and `complete=false`.
4. Unsupported/broken syntax degrades safely to raw/index.
5. Model-visible route metadata is minimal; score math belongs in trace telemetry.
6. A 20–100 ms tool-side increase is acceptable if it reliably removes a model turn or
   materially reduces model-facing context.

## Benchmark gates

Primary KPI: model calls per task.

Secondary: touched/gold file recall, first useful region rank, useful coverage at fixed
2 KiB/4 KiB budgets, output bytes/search, dense searches resolved without
`refinement_required=true`, no-progress loops, tool wall time, lexical retention and
parse/unsupported fallbacks.
