# Low-CPU agent architecture plan

The governing constraint is: local CPU inference is expensive; deterministic search,
indexing and verification are cheap. New runtime layers are accepted only when they
reduce model turns, reduce model-facing context, or improve localization recall without
weakening evidence safety.

## Long-horizon agent pipeline

1. **Scout** — bounded reconnaissance, no editing.
2. **Governor** — per-turn budgets, loop suppression, model-call and wall limits.
3. **Evidence router / reader** — broad lexical intent -> trustworthy source regions in
   the same tool call. Discovery is frozen after v2.13-C3.
4. **Execution / patch stage** — consume the Scout handoff, revalidate file fingerprints,
   and make the smallest practical change. This is the next work.
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

### v2.12-B — Probe-more / emit-less — DONE

- probe 6–8 lexical files inside the tool;
- emit only the best evidence regions under the evidence budget;
- preserve at least one direct candidate per non-empty query;
- rank regions by query coverage, structural role, task/path anchors and marginal
  evidence-per-byte.

### v2.13 — Incremental RepoIndex / Impact Index — DONE AND FROZEN

v2.13-A shadowed exact local edges. v2.13-B activated at most two graph probes and one
graph emit behind source validation. v2.13-C conditioned graph expansion on lexical
scope evidence; C2.2 added task-local pre-cap filtering, alias pairs, multiline imports,
fingerprint freshness and one refresh-on-miss retry.

#### v2.13-C3 — Scout handoff/freeze — DONE

- do not widen discovery or add new graph algorithms;
- persist an atomic `scout-handoff-v1` snapshot under `.opencode/scout-handoffs/`;
- record relative localized files, evidence line hints and validated Impact provenance;
- fingerprint ordinary selected source files with SHA-256 and recheck emitted witness lines against the hashed bytes;
- classify the handoff as `ready`, `partial` or `blocked` without hiding incompleteness;
- expose the handoff path in search metadata/trace;
- after these gates pass, discovery changes require a reproduced benchmark miss.

PageRank, embeddings, full-repository semantic maps and a second explorer model remain
out of scope until a post-freeze benchmark proves they are needed.

### v2.14 — Patch Executor — CURRENT

The executor is a separate action plane, not an extension of `search`.

#### v2.14-A — shadow executor core — DONE

The first executor stage deliberately does not write the repository. It consumes
`scout-handoff-v1` and a bounded `EditScript` request, then constructs the candidate
source and unified patch in memory/temporary storage only. Admission requires:

1. handoff protocol `scout-handoff-v1` with status `ready`;
2. a fresh strong SHA-256 fingerprint for every file carried by the handoff;
3. every edited file to be inside the handoff file allowlist;
4. an exact precondition matching once and within 96 lines of carried evidence;
5. candidate syntax to parse without ERROR/missing nodes through the existing
   ast-grep/tree-sitter backend;
6. `git apply --check --whitespace=error-all` to accept the generated patch;
7. byte identity of the source repository before/after shadow execution.

The initial `EditScript` intentionally exposes only `replace_exact`. This is a safety
baseline, not the final mutation language. Structural rewrites should reuse the existing
ast-grep stack before adding another parser/codemod runtime. GritQL remains a benchmark
candidate for migrations, not a dependency. Difftastic belongs primarily to the later
review plane.

#### v2.14-B — guarded transactional mutation — CURRENT

The guarded executor performs real writes only inside a disposable detached Git worktree.
The Scout fingerprint is revalidated in the main tree and again against the detached HEAD
baseline before any candidate bytes are written. The first mutation language is deliberately
small:

- `replace_exact` retains the v2.14-A unique textual precondition;
- `replace_ast` uses the existing pinned ast-grep/tree-sitter stack to match one structural
  node within the 96-line Scout evidence radius, then replaces that exact node range;
- ast-grep metavariables remain disabled until a later benchmark proves template expansion
  can be constrained safely.

Mutation budgets start at two changed files and 120 changed lines. Candidate files must
parse after the worktree write, deterministic `contains_exact` / `not_contains_exact`
postconditions may be required, `git diff --check` must pass, and the exported patch must
still pass `git apply --check` against the main tree. Any failure removes the disposable
worktree and exports no patch.

This first guarded version requires touched files to exist at the detached `HEAD` baseline.
A locally modified tracked file may be read by Scout, but B refuses to replay it into the
detached worktree when its HEAD bytes differ from the Scout fingerprint. Supporting dirty
baselines is deferred until a benchmark demonstrates that the extra merge/snapshot logic is
worth the safety surface.

The executor may reread localized files, but it may not silently restart repository-wide
discovery. If localization is insufficient it returns control to Scout with a concrete
benchmarkable miss reason.

## Scout -> Executor handoff contract

`scout-handoff-v1` is the trust boundary between read-only reconnaissance and writes.
The handoff is advisory about task relevance but authoritative about provenance: every
localized file has its origin (`lexical`/`impact`), query membership, bounded evidence
line hints and a freshness fingerprint. Validated graph relations retain seed, direction,
bindings and validation kind.

`ready` means the latest Scout result has localized at least one strongly fingerprinted
file, its carried witnesses still match the hashed bytes, and the result does not require refinement. `partial` keeps usable localization but explicitly
records incomplete discovery/evidence. `blocked` means the executor must not write (for
example stale/changed files, weak fingerprint, no localized file, or required refinement).

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

### v2.13 — Impact Index

#### v2.13-A — shadow gate
- precision-first local dependency edges only; no PageRank/embeddings/full repo map;
- persistent cache: `refresh` walks/stats the repo, `neighbors` reads adjacency only;
- forward + reverse edges carry import binding, witness line and confidence;
- graph candidates are telemetry-only and cannot change v2.12 probe/emit routing;
- helper is fail-open; stale/missing/timed-out index cannot break lexical search.

#### v2.13-B — guarded activation (after A passes)
- preserve all 8 lexical probe slots;
- add at most 2 graph hypotheses outside those slots;
- graph edge is never evidence: bindings must be validated in source before ranking/emission;
- emit budget remains <= 4 files/regions.

#### v2.13-C — real-task freeze
- accept only if non-lexical recovery improves without material model-context/model-call regression;
- after freeze, discovery plane stops growing and work moves to v2.14 Patch Executor.

### v2.14-A — Shadow Executor gates

- ready handoff -> candidate patch without source mutation;
- partial/blocked handoff -> no patch authority;
- stale fingerprint -> reject;
- out-of-scope file -> reject;
- ambiguous exact precondition -> reject;
- syntax-breaking candidate -> reject;
- edit outside the bounded evidence radius -> reject;
- applicable patch -> `git apply --check` must pass.

### v2.14-B — Guarded Executor gates

- real mutation occurs only inside a detached disposable Git worktree;
- main source bytes remain unchanged on success and failure;
- detached HEAD bytes for every touched/check file must equal the Scout SHA-256;
- `replace_ast` must prove a unique evidence-local structural match;
- syntax failure after mutation -> no patch + worktree cleanup;
- deterministic postcondition failure -> no patch + worktree cleanup;
- more than two changed files or 120 changed lines -> reject;
- `git diff --check` and main-tree `git apply --check` are mandatory before patch export.
