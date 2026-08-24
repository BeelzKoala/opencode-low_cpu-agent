# Low-CPU Local Coding Agent

[Русская версия](README.ru.md)

An experimental local background coding worker designed for **small, well-scoped repository tasks under strict CPU and RAM limits**.

The project explores a pipeline in which deterministic tools do as much work as possible and the language model is used only where reasoning or code generation is actually needed.

```text
task
→ localization
→ dependency / impact analysis
→ bounded patch
→ verification
→ at most one repair
→ VERIFIED | SAFE_FAIL
```

> **Status:** active research prototype. The project is not production-ready and deliberately prefers a safe failure over an unsupported `VERIFIED` result.

## Why this project exists

Most coding agents assume that inference, context, memory and parallel workers are comparatively cheap. This project starts from the opposite constraint:

```text
LLM inference is expensive.
Deterministic computation is cheap.
```

The goal is not to build a general autonomous software engineer. The goal is to build a **reliable time-saving worker for small, clear engineering tasks** that can run locally in the background without consuming the whole machine.

Examples of the intended task class:

- small bug fixes;
- validation changes;
- configuration edits;
- focused test additions;
- local call-site changes;
- bounded two- or three-file changes;
- small UI/backend changes when the affected scope can be proven.

Ambiguous, high-risk or insufficiently evidenced tasks should end in `SAFE_FAIL`, not in a confident guess.

## Core design principles

1. **Deterministic tools before model calls.**  
   Search, parsing, graphs, caches, diff analysis, linting and tests should reduce both the number of LLM calls and the amount of model-facing context.

2. **Evidence is not the same as routing.**  
   Heuristics may rank candidates, but they must not be treated as semantic proof.

3. **Safe failure is better than false verification.**  
   A patch is not `VERIFIED` unless the required deterministic gates pass.

4. **Mutation must be bounded.**  
   The executor should not receive unrestricted shell or filesystem access.

5. **Repository changes belong in an isolated worktree.**  
   Apply, verify and rollback should be transactional.

6. **Repair loops are intentionally limited.**  
   One initial patch and at most one bounded repair.

7. **Complexity must justify itself.**  
   Embeddings, vector databases, PageRank, swarms, extra models, large-context strategies and learned routers are rejected until an end-to-end benchmark shows that a simpler deterministic method is insufficient.

## Architecture

The project is converging on five main responsibilities:

### Governor

Controls:

- CPU/RAM and runtime budgets;
- timeouts;
- cache use;
- no-progress detection;
- task and evidence ledgers;
- admission and failure policy.

### Scout

Responsible for deterministic repository understanding:

- lexical search and ranking;
- structural parsing;
- symbol and scope discovery;
- task-local dependency/impact expansion;
- source validation;
- ambiguity detection.

A graph edge is treated as a **hypothesis** until source-level validation supports it.

### Executor

Produces only bounded mutations through structured patches/diffs.

The executor is intentionally denied unrestricted mutation capabilities.

### Verifier

Independently evaluates:

```text
TASK_PASS
SCOPE_PASS
STATIC_PASS
INVARIANT_PASS
IMPACT_PASS
REGRESSION_PASS
```

Only the required gates passing can produce:

```text
VERIFIED
```

### Orchestrator

Runs the deterministic state machine, isolated worktree lifecycle, checkpoints, rollback and the single-repair policy.

A target state machine is:

```text
RECEIVED
→ ELIGIBILITY
→ LOCALIZE
→ IMPACT
→ PREPARE
→ MUTATE
→ VERIFY
→ REPAIR?
→ VERIFY
→ VERIFIED | SAFE_FAIL | ENV_FAIL
```

## Current development focus

The current work is centered on the lower layers required before a trustworthy autonomous loop is possible:

- deterministic repository search;
- task-local impact analysis;
- bounded tool and mutation contracts;
- reproducible runtime/benchmark harnesses;
- local inference integration under CPU/RAM constraints;
- cross-repository validation;
- separating localization hypotheses from evidence.

This README intentionally avoids presenting roadmap items as completed functionality.

## Language priorities

The project is intentionally not equally ambitious for every language.

| Priority | Languages | Target |
|---|---|---|
| 1 | Python | first-class |
| 2 | JavaScript / HTML / CSS | strong practical support |
| 3 | TypeScript | common cases |
| 4 | XML / Docker / SQL | structural support |
| 5 | Other languages | best effort |

## Roadmap

### Product 2.0 — reliable bounded coding worker

Goal:

```text
RETRIEVE
→ RESOLVE
→ CONSTRAIN
→ PATCH
→ PROVE
```

Planned foundations include:

- deterministic finite-state execution;
- isolated worktrees and transactional rollback;
- exact search + BM25F + Reciprocal Rank Fusion;
- Tree-sitter / Python AST / LibCST / ast-grep;
- semantic source validation;
- typed Impact Graph with bounded traversal;
- evidence quorum and abstention;
- invariant extraction and differential static checks;
- regression test selection;
- authoritative differential verification;
- exactly one bounded repair;
- content-addressed caching;
- real end-to-end benchmark corpus.

### Product 3.0 — bounded investigation

Goal:

```text
HYPOTHESIZE
→ MEASURE
→ SLICE
→ ISOLATE
→ PATCH
→ PROVE
```

The worker should become able to investigate locally ambiguous problems through bounded deterministic probes, including:

- budgeted best-first investigation;
- deterministic query expansion;
- coverage-based fault localization;
- test-to-code coverage graphs;
- bounded backward slicing;
- targeted runtime evidence;
- delta debugging;
- `git bisect`;
- dependency-consistent multi-file batches;
- property-based and metamorphic testing where contracts justify them.

### Product 4.0 — autonomous background worker

Goal: safely process a stream of tasks with minimal user involvement while remaining a polite background workload.

Planned mechanisms include:

- empirical task admission / abstention;
- per-instance execution strategy selection;
- optional sequential model cascade;
- persistent SQLite WAL task ledger;
- persistent artifact store;
- Linux PSI-based resource admission;
- cgroups v2;
- token/resource buckets;
- priority FIFO + aging;
- bounded concurrency;
- evidence provenance DAG;
- continuous end-to-end product gates.

## Verification philosophy

The project does not treat an LLM opinion as proof.

The intended verification model is differential:

```text
BEFORE ↔ AFTER
```

Examples:

```text
new_static_errors == 0
public_contract_breaks == 0
scope_violations == 0
```

Focused tests may reduce latency, but a focused test pass alone is not enough to claim `VERIFIED`.

## What this project deliberately does not optimize for

Unless benchmark evidence proves otherwise, this project does not plan to depend on:

- embeddings or a vector database;
- PageRank or graph centrality as repository relevance;
- graph neural networks;
- full CodeQL indexing on the default path;
- MCTS or Tree-of-Thought;
- multi-agent swarms;
- planner LLMs;
- LLM-as-judge verification;
- large candidate sampling;
- unlimited repair loops;
- huge context windows;
- learned routers;
- RL scheduling;
- unrestricted executor shell access.

The acceptance rule for additional complexity is simple:

```text
reproducible end-to-end failure
+
simpler deterministic method is insufficient
+
benchmark evidence for the proposed solution
```

## Benchmarking

Component metrics are useful, but the product is judged end to end.

Important metrics include:

- false `VERIFIED` count;
- `VERIFIED` rate;
- initial-patch pass rate;
- repair rate;
- seconds per `VERIFIED`;
- model calls per `VERIFIED`;
- prompt tokens per `VERIFIED`;
- peak RSS.

A component improvement is not considered a product improvement unless it either improves useful end-to-end throughput/safety or unlocks a meaningful new task class.

## Authorship and use of AI

This project should **not** be represented as code written manually by a human line by line.

A substantial part of the code, tests, scripts, patches and documentation has been generated or rewritten by AI models under human direction.

The human contributor has been responsible for much of the work that determines what the system should actually be:

- researching the problem and existing engineering approaches;
- defining the product constraints and safety model;
- designing significant parts of the architecture;
- selecting, rejecting and sequencing algorithms and tools;
- designing benchmarks and pass criteria;
- running the system on real repositories;
- classifying failures and deciding which changes are justified.

AI systems have been used heavily for:

- implementation;
- refactoring;
- test and benchmark generation;
- scripting;
- documentation;
- architectural critique and alternative designs.

The most accurate description is therefore:

> **A human-directed, AI-implemented engineering research project.**

The project combines established software-engineering and program-analysis techniques into a deliberately constrained local coding-agent pipeline. It does not claim that the underlying algorithms were invented here.

## Project rule

The architectural rule that ties the roadmap together is:

```text
deterministic evidence
        ↓
bounded LLM reasoning
        ↓
bounded mutation
        ↓
deterministic proof
```

Product 2.0 should learn to execute reliably.  
Product 3.0 should learn to investigate reliably.  
Product 4.0 should learn when and how to act autonomously.
