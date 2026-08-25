# Low-CPU agent architecture plan

## Current product objective

```text
task
→ bounded deterministic search
→ Query Formulation 2.0 when needed
→ lexical / structural routing
→ Impact hypotheses + source validation
→ semantic shadow validation
→ structural owner recovery
→ bounded preauthorized capabilities
→ deterministic mutation-action routing
→ sealed edit capsule
→ action-specific semantic mutation
→ deterministic late binding + Mutation Confinement 2.0
→ candidate reconstruction + native validity
→ isolated Executor
→ independent Verifier
→ VERIFIED | SAFE_FAIL
```

The governing constraint remains:

```text
LLM inference is expensive.
Deterministic tools are cheap.
```

Routing may be heuristic. Evidence and authority may not be fabricated.
A graph edge is a hypothesis until source validation.
SAFE_FAIL is preferable to unsupported VERIFIED.

## Architecture moratorium — CURRENT

For the next stabilization versions the project deliberately stops adding architectural
layers unless an immutable end-to-end corpus demonstrates a concrete product failure.

The critical review behind this decision is:

> Stop adding architecture for several versions. Fix the Git-hook escape, split the
> 438 KB plugin, freeze interfaces, provide one `./ci` / `make check`, pin the
> environment, and run a large immutable corpus. Only if the pipeline beats simpler
> baselines on false-VERIFIED and solved-tasks-per-CPU is it an empirical result rather
> than only an interesting engineering construction.

This is project policy.

### Moratorium rules

1. No new model, agent, planner, vector DB, embeddings, PageRank, learned routing,
   backend rewrite or semantic authority source without corpus evidence.
2. Scout ranking, Impact and semantic-shadow behavior are frozen except for reproduced
   correctness bugs.
3. Compiler / Executor / Verifier authority contracts are frozen except for reproduced
   correctness bugs.
4. Model-facing interfaces are frozen after the current action-routing correction.
5. No model/search/mutation budget increase without benchmark evidence.
6. Every FAIL is classified first:
   architecture / implementation / benchmark / telemetry / environment.
7. Existing immutable corpus versions are never edited; create a new version.
8. Git hooks are convenience only. `./ci` is the authority.
9. Component improvements are rejected if they do not improve the product.

## Trust boundaries

### Governor
Owns model-call, search, wall-clock, no-progress and mutation-attempt budgets.
Initial patch + at most one semantic repair remains the limit.

### Scout
Read-only. It localizes, ranks, builds Impact hypotheses, validates source evidence and
persists strong fingerprints. It does not mutate.

### Mutation capabilities
Replace and rename are independent authorities.

- bounded replace authority: local preauthorized candidate capability;
- rename authority: `scout-rename-target-v2`, requiring complete exact identifier evidence,
  a unique structural definition and fresh source fingerprint.

File, old symbol, mutation kind and scope remain capability-derived.

### Deterministic mutation-action router

Evidence from the Django and TypeScript real-repository probes showed a correct sealed
rename target while the model was still offered both `execute_replace_node` and
`execute_rename_symbol`. The model then chose replace and safely failed downstream.

This is an Orchestrator bug.

Permanent invariant:

```text
model-visible mutation actions <= 1
```

Task text may select between already-issued capabilities, but it cannot create authority.
`task-context-v1` is the correctness boundary: one synchronous user-turn snapshot provides
turn identity, bounded canonical task text, SHA-256 provenance and tri-state routing intent
(`rename_symbol | generic_edit | unknown`). The snapshot is latched once per turn. Missing
later host context cannot rewrite it; same-turn text-hash drift fails closed.

The host adapter accepts only explicitly tested text shapes and never recursively scrapes
unknown objects. Unsupported shapes, oversized task payloads and incomplete rename commands
become `unknown`, which exposes no mutation tool. Adding a host shape requires a sanitized
fixture and an adapter protocol bump.

`rename_symbol` plus sealed rename authority exposes only `execute_rename_symbol`.
`generic_edit` plus bounded replace authority exposes only `execute_replace_node`.
Repair remains action-sticky. The frontier resolver is pure: it computes intent ∩ capability.

### Compiler
Deterministically lowers semantic mutation intent into bounded physical edits.

### Executor
Mutates only an isolated worktree. Main checkout must remain unchanged.

### Verifier
Independently replays and re-derives proof obligations. Compiler authority is not verifier
authority.

### Terminal outcome adapter

Host process exit status is transport telemetry, not semantic proof.

Canonical states:

```text
VERIFIED
SAFE_FAIL
ENV_FAIL
TRANSPORT_FAIL
```

`VERIFIED` requires a valid patch receipt and passing verification receipt.

## Stabilization packages

### S1 — deterministic mutation routing
PASS:
- both capabilities + explicit rename → rename only;
- ordinary bounded edit → replace only;
- repair cannot switch action;
- frontier cardinality never exceeds one.

### S2 — split the 438 KB plugin without behavior rewrite
`cpu-search.ts` remains the runtime entrypoint. Its source is partitioned mechanically at
top-level function boundaries into content-addressed fragments. `build-plugin.py --check`
must prove byte-for-byte reconstruction.

The split is not permission for semantic refactoring.

### S3 — freeze interfaces
`contracts/interfaces-v1.json` freezes model-facing tool names, required fields, protocol
names and budgets. CI fails on silent ABI drift.

### S4 — one check entrypoint

```text
./ci quick
./ci full
./ci env
./ci corpus
make check
```

Tracked Git hooks call `./ci quick`; hosted CI calls the same entrypoint. `--no-verify`
can bypass a hook, therefore hooks are never treated as the release authority.

### S5 — pin benchmark environment
The benchmark lock records the exact Python, Node, Git, ripgrep, Rust/Cargo and OpenCode
versions used for corpus results. Environment mismatch is `ENV_FAIL`, not product FAIL.

### S6 — immutable corpus and baseline scoring
Corpus versions are content-addressed. Primary metrics:

```text
false_verified
verified_tasks
cpu_seconds
solved_tasks_per_cpu
model_calls
wall_seconds
```

The architecture exits the moratorium only if it beats simpler baselines on the fixed
corpus without increasing false VERIFIED.

## Evidence-backed gaps

1. Action selection was still delegated to the model when both mutation capabilities existed.
2. CLI exit status and proof receipts can disagree.
3. `cpu-search.ts` reached about 438 KB.
4. Historical benchmarks encode stale interface assumptions.
5. Local hook checks are bypassable.
6. Corpus and benchmark environment were not one immutable identity.
7. End-to-end latency is dominated by model/host time, not deterministic search.

## Frozen / postponed

Until corpus evidence says otherwise:

- no new Scout ranking method;
- no semantic resolver promotion from shadow authority;
- no Compiler / Executor / Verifier rewrite;
- no extra models or agents;
- no embeddings/vector DB/PageRank;
- no unlimited repair;
- no budget increases.

## Benchmark policy

Synthetic gates prove invariants.
Real-repository gates prove usefulness.
Adversarial gates prove safe failure.

Required stabilization matrix:

| Gate | PASS |
| --- | --- |
| action frontier | <= 1 mutation tool |
| explicit rename | rename only |
| normal bounded edit | replace only |
| repair stickiness | action unchanged |
| ambiguous rename | SAFE_FAIL |
| stale capability | SAFE_FAIL |
| invalid candidate | SAFE_FAIL |
| bounded replace corpus | VERIFIED where supported |
| Django rename | VERIFIED |
| TypeScript rename | VERIFIED |
| terminal outcome | receipt authority separated from CLI transport |
| interface freeze | no silent ABI drift |
| plugin reconstruction | byte-identical |
| corpus lock | exact content hashes |

## Promotion criterion

```text
low false-VERIFIED
+
higher solved-tasks-per-CPU than simpler baselines
+
bounded model calls/context
+
safe failure under ambiguity
```

If the system does not satisfy this, simplify it. Do not add another layer.
