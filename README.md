# Low-CPU Local Coding Agent

[Русская версия](README.ru.md)

An experimental project exploring whether a useful local coding agent can be built for small repository tasks under strict CPU, RAM and inference-cost constraints.

The general direction is:

```text
task
→ localization
→ impact analysis
→ bounded patch
→ checks
→ limited repair
→ VERIFIED | SAFE_FAIL
```

At the moment this is a **research prototype**, not a production-ready autonomous programmer.

The project investigates how much work can be moved away from the language model and into cheaper deterministic tools.

## Core hypothesis

```text
LLM inference is expensive.
Search, parsers, graphs, lint and tests are cheaper.
```

Instead of increasing model count, agent count and context size, the project explores:

```text
deterministic narrowing
→ small model-facing context
→ bounded mutation
→ deterministic verification
```

It is not yet known how broad a class of real engineering tasks this approach can solve reliably.

Measuring that is one of the main purposes of the project.

## Intended direction

Eventually, the system should be able to receive a small engineering task such as:

```text
"change validation"
"fix a local bug"
"add a test"
"modify one endpoint"
"update several related call sites"
```

and then:

1. locate the relevant code;
2. determine a bounded impact scope;
3. produce a small patch;
4. verify it;
5. perform at most one repair when given a concrete failure;
6. return either a supported result or a safe failure.

The important word here is **eventually**.

The repository currently contains evolving pieces of this architecture together with experimental infrastructure used to evaluate them.

## Current focus

Current work is mainly around:

* deterministic repository search;
* task-local impact analysis;
* structural parsing;
* tool contracts;
* bounded mutation;
* runtime and benchmark harnesses;
* local inference under resource constraints;
* validation across different repositories;
* separating heuristic hypotheses from stronger evidence.

Not every mechanism listed in the roadmap is implemented.

This README intentionally does not present planned functionality as completed functionality.

## Architectural direction

The project is gradually separating several responsibilities.

### Governor

Budgets, timeout, cache, execution limits and task history.

### Scout

Searches for relevant code, symbols, dependencies and possible impact scope.

Heuristic search results are treated as candidates rather than semantic proof.

### Executor

The target design allows only bounded mutations.

The model is not intended to receive unrestricted shell or filesystem mutation access.

### Verifier

Checks patches using deterministic tooling and project-native tests.

The intended design does not treat an LLM opinion as final proof of correctness.

### Orchestrator

Connects the stages through a bounded state machine and manages worktrees, rollback and repair policy.

These are architectural directions. Individual components are at different levels of maturity.

## Why SAFE_FAIL is acceptable

The project does not attempt to complete every task.

If the system cannot:

* localize the change with enough evidence;
* resolve an ambiguous symbol;
* remain inside its budget;
* establish sufficient verification;
* execute because of the environment;

the preferred result should be refusal rather than an unsupported success.

```text
SAFE_FAIL > unsupported VERIFIED
```

How consistently the implementation achieves this is still being tested.

## Language priorities

Primary target:

```text
Python
```

Then:

```text
JavaScript / HTML / CSS
TypeScript
XML / Docker / SQL
```

Other languages are currently best effort.

## Roadmap

### 2.0 — bounded execution

The first major goal is to test whether this pipeline can become sufficiently reliable:

```text
RETRIEVE
→ RESOLVE
→ CONSTRAIN
→ PATCH
→ PROVE
```

Areas being explored include:

* deterministic state machines;
* isolated worktrees;
* transactional mutation;
* exact/BM25-style retrieval;
* structural parsing;
* semantic source validation;
* bounded impact graphs;
* invariants;
* regression test selection;
* differential verification;
* one-repair policy;
* content-addressed caching;
* end-to-end benchmark corpus.

### 3.0 — bounded investigation

If the 2.0 approach performs well enough, the next question is whether the system can investigate problems that are not fully localized by the user.

Possible tools include:

* iterative search;
* coverage-based fault localization;
* backward slicing;
* targeted runtime probes;
* delta debugging;
* `git bisect`;
* test-to-code coverage graphs.

### 4.0 — background operation

Only after enough empirical evidence exists would the project move toward:

* task admission;
* persistent task ledgers;
* resource-aware scheduling;
* Linux PSI;
* cgroups v2;
* bounded queues;
* automatic abstention;
* a long-running background worker.

The roadmap is a research direction, not a delivery promise.

## Deliberately postponed complexity

Without a reproducible failure and benchmark evidence, the project currently avoids adding:

* embeddings;
* vector databases;
* PageRank;
* multi-agent swarms;
* MCTS;
* Tree-of-Thought;
* dedicated planner LLMs;
* LLM verification as authority;
* unlimited repair loops;
* huge context;
* learned routing;
* RL scheduling.

This does not mean those methods are inherently useless.

The project simply tests simpler approaches first.

## Evaluation

The main question is not:

> how intelligent does the agent look?

but:

> how many real tasks can it complete correctly within the resource budget, and how often does it incorrectly claim success?

Important metrics include:

```text
false VERIFIED
VERIFIED rate
initial patch pass rate
repair rate
runtime
model calls
prompt tokens
peak RSS
```

Ideally, architectural improvements should be visible in end-to-end results.

## Authorship

This project is developed with extensive use of generative AI systems.

A significant portion of:

* implementation;
* tests;
* benchmark scripts;
* documentation;
* refactoring;
* architectural alternatives

has been generated or rewritten by AI models.

The human contributor has been responsible for researching the problem, defining constraints, selecting and criticizing architectural directions, designing parts of the system, running experiments and evaluating results.

A reasonably accurate description is:

> **Human-directed, heavily AI-assisted experimental engineering project.**

The project does not claim to have invented the underlying algorithms. Most techniques come from established software engineering, information retrieval and program analysis work.

The experiment is in how they can be combined into a resource-constrained local coding-agent pipeline.

## Current status

```text
experimental
in active development
not production-ready
API and architecture may change
results are still being validated
```

A negative result would also be useful: it would help identify which constraints make this architecture impractical and where more expensive approaches are actually necessary.
