# Low-CPU Local Coding Agent

[English version](README.md)

Экспериментальный локальный background coding worker для **небольших, ограниченных задач в репозитории при жёстких лимитах CPU и RAM**.

Проект исследует пайплайн, в котором максимум работы выполняют дешёвые детерминированные инструменты, а языковая модель подключается только там, где действительно требуется рассуждение или генерация кода.

```text
task
→ localization
→ dependency / impact analysis
→ bounded patch
→ verification
→ at most one repair
→ VERIFIED | SAFE_FAIL
```

> **Статус:** активный исследовательский прототип. Проект пока не является production-ready и намеренно предпочитает безопасный отказ неподтверждённому `VERIFIED`.

## Зачем существует этот проект

Большинство coding-agent систем исходят из того, что inference, большой context, память и параллельные workers сравнительно дёшевы. Здесь исходная предпосылка обратная:

```text
LLM inference дорог.
Deterministic computation дёшево.
```

Цель — не создать универсального автономного программиста. Цель — создать **надёжного фонового экономщика времени для небольших и ясных инженерных задач**, способного работать локально и не забирать себе всю машину.

Предполагаемый класс задач:

- небольшие bugfix;
- изменения валидации;
- правки конфигурации;
- добавление локальных тестов;
- изменение конкретного callsite;
- ограниченные изменения в двух-трёх файлах;
- небольшие UI/backend задачи, если область воздействия можно доказуемо ограничить.

Неоднозначные, рискованные или плохо подтверждённые задачи должны завершаться `SAFE_FAIL`, а не уверенным угадыванием.

## Основные принципы

1. **Сначала детерминированные инструменты, потом model calls.**  
   Search, parsing, graph, cache, diff analysis, lint и tests должны уменьшать и число обращений к LLM, и объём model-facing context.

2. **Routing — не evidence.**  
   Heuristics могут ранжировать кандидатов, но не должны становиться семантическим доказательством.

3. **Safe failure лучше false VERIFIED.**  
   Патч не считается `VERIFIED`, пока не пройдены необходимые детерминированные гейты.

4. **Mutation должна быть bounded.**  
   Executor не должен получать unrestricted shell или filesystem.

5. **Изменения выполняются в isolated worktree.**  
   Apply, verify и rollback должны быть транзакционными.

6. **Repair loop намеренно ограничен.**  
   Один initial patch и максимум один bounded repair.

7. **Сложность должна заслужить своё место.**  
   Embeddings, vector DB, PageRank, swarm, extra models, huge context и learned routers не добавляются без end-to-end evidence, что более простой deterministic метод недостаточен.

## Архитектура

Проект развивается вокруг пяти основных ролей.

### Governor

Отвечает за:

- CPU/RAM и runtime budgets;
- timeout;
- cache;
- no-progress detection;
- task/evidence ledgers;
- admission и failure policy.

### Scout

Отвечает за детерминированное понимание репозитория:

- lexical search и ranking;
- structural parsing;
- поиск symbols и scopes;
- task-local dependency/impact expansion;
- source validation;
- обнаружение неоднозначности.

Graph edge считается **гипотезой**, пока source-level validation не превратит его в evidence.

### Executor

Создаёт только bounded mutation через structured patch/diff.

Unrestricted mutation capabilities намеренно не выдаются.

### Verifier

Независимо проверяет:

```text
TASK_PASS
SCOPE_PASS
STATIC_PASS
INVARIANT_PASS
IMPACT_PASS
REGRESSION_PASS
```

Только прохождение необходимых гейтов может дать:

```text
VERIFIED
```

### Orchestrator

Управляет deterministic state machine, жизненным циклом isolated worktree, checkpoint/rollback и правилом одного repair.

Целевая state machine:

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

## Текущий фокус разработки

Сейчас работа сосредоточена на нижних слоях, без которых надёжный автономный loop бессмыслен:

- deterministic repository search;
- task-local impact analysis;
- bounded tool и mutation contracts;
- воспроизводимые runtime/benchmark harnesses;
- local inference под жёсткими CPU/RAM ограничениями;
- cross-repository validation;
- разделение localization hypotheses и evidence.

README намеренно не выдаёт roadmap за уже реализованную функциональность.

## Приоритет языков

Проект не пытается одинаково хорошо поддерживать всё.

| Приоритет | Языки | Цель |
|---|---|---|
| 1 | Python | first-class |
| 2 | JavaScript / HTML / CSS | сильная практическая поддержка |
| 3 | TypeScript | common cases |
| 4 | XML / Docker / SQL | structural support |
| 5 | Остальные | best effort |

## Roadmap

### Product 2.0 — надёжный bounded coding worker

Цель:

```text
RETRIEVE
→ RESOLVE
→ CONSTRAIN
→ PATCH
→ PROVE
```

Запланированный фундамент:

- deterministic finite-state execution;
- isolated worktree и transactional rollback;
- exact search + BM25F + Reciprocal Rank Fusion;
- Tree-sitter / Python AST / LibCST / ast-grep;
- semantic source validation;
- typed Impact Graph с bounded traversal;
- evidence quorum и abstention;
- invariant extraction и differential static checks;
- regression test selection;
- authoritative differential verification;
- ровно один bounded repair;
- content-addressed cache;
- настоящий end-to-end benchmark corpus.

### Product 3.0 — bounded investigation

Цель:

```text
HYPOTHESIZE
→ MEASURE
→ SLICE
→ ISOLATE
→ PATCH
→ PROVE
```

Worker должен научиться расследовать локально неоднозначные проблемы через ограниченные deterministic probes:

- budgeted best-first investigation;
- deterministic query expansion;
- coverage-based fault localization;
- test-to-code coverage graph;
- bounded backward slicing;
- targeted runtime evidence;
- delta debugging;
- `git bisect`;
- dependency-consistent multi-file batches;
- property-based и metamorphic testing там, где это позволяет доказуемый contract.

### Product 4.0 — автономный background worker

Цель — безопасно обрабатывать поток задач почти без участия пользователя и оставаться фоновым workload для основной машины.

Планируемые механизмы:

- empirical task admission / abstention;
- per-instance выбор execution strategy;
- опциональный sequential model cascade;
- persistent SQLite WAL task ledger;
- persistent artifact store;
- Linux PSI-based resource admission;
- cgroups v2;
- token/resource buckets;
- Priority FIFO + Aging;
- bounded concurrency;
- Evidence Provenance DAG;
- постоянный end-to-end product gate.

## Философия проверки

Мнение LLM не считается доказательством.

Целевая модель verification — differential:

```text
BEFORE ↔ AFTER
```

Примеры:

```text
new_static_errors == 0
public_contract_breaks == 0
scope_violations == 0
```

Focused tests могут уменьшить latency, но сами по себе не дают права объявлять задачу `VERIFIED`.

## Что проект намеренно не оптимизирует заранее

Пока benchmark не докажет необходимость, проект не должен зависеть от:

- embeddings и vector DB;
- PageRank или graph centrality как repository relevance;
- Graph Neural Networks;
- полного CodeQL indexing на default path;
- MCTS и Tree-of-Thought;
- multi-agent swarm;
- Planner LLM;
- LLM-as-judge verification;
- large candidate sampling;
- unlimited repair;
- huge context;
- learned router;
- RL scheduling;
- unrestricted Executor shell.

Правило допуска дополнительной сложности:

```text
reproducible end-to-end failure
+
более простой deterministic метод недостаточен
+
benchmark evidence для предлагаемого решения
```

## Benchmarking

Метрики компонентов полезны, но продукт оценивается end-to-end.

Ключевые метрики:

- число false `VERIFIED`;
- `VERIFIED` rate;
- initial-patch PASS;
- repair rate;
- seconds / `VERIFIED`;
- model calls / `VERIFIED`;
- prompt tokens / `VERIFIED`;
- peak RSS.

Улучшение отдельного компонента не считается улучшением продукта, если оно не повышает полезную end-to-end эффективность/безопасность и не открывает значимый новый класс задач.

## Об авторстве и использовании ИИ

Этот проект **нельзя честно описывать как код, вручную написанный человеком строка за строкой**.

Значительная часть кода, тестов, скриптов, патчей и документации была сгенерирована или переработана ИИ-моделями под человеческим управлением.

На стороне человека находилась существенная часть работы, определяющей, каким вообще должен быть продукт:

- исследование проблемы и существующих инженерных подходов;
- формулирование продуктовых ограничений и safety model;
- проектирование значительной части архитектуры;
- выбор, критика, отбраковка и последовательность алгоритмов и инструментов;
- разработка benchmark и PASS-критериев;
- реальные запуски на репозиториях;
- классификация failures и решение, какие изменения действительно оправданы.

ИИ активно использовался для:

- реализации;
- рефакторинга;
- генерации тестов и benchmark;
- написания скриптов;
- документации;
- архитектурной критики и поиска альтернативных решений.

Поэтому наиболее точное описание проекта:

> **Human-directed, AI-implemented engineering research project.**

Проект объединяет известные методы software engineering и program analysis в намеренно ограниченную архитектуру локального coding-agent. Он не заявляет, что используемые алгоритмы были изобретены в рамках этого проекта.

## Главное правило проекта

Архитектурный закон для всей дорожной карты:

```text
deterministic evidence
        ↓
bounded LLM reasoning
        ↓
bounded mutation
        ↓
deterministic proof
```

Product 2.0 должен научиться надёжно выполнять.  
Product 3.0 — надёжно расследовать.  
Product 4.0 — самостоятельно решать, когда и как действовать.
