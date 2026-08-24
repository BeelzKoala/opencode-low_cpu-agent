# Low-CPU Local Coding Agent

[English version](README.md)

Экспериментальный проект по исследованию локального coding-agent для небольших задач в репозитории при жёстких ограничениях CPU, RAM и стоимости inference.

Основная идея проекта:

```text
task
→ localization
→ impact analysis
→ bounded patch
→ checks
→ limited repair
→ VERIFIED | SAFE_FAIL
```

На текущем этапе это **исследовательский прототип**, а не готовый автономный программист.

Проект проверяет, насколько далеко можно зайти, если использовать LLM только там, где действительно требуется генерация или рассуждение, а остальную работу отдавать более дешёвым детерминированным инструментам.

## Основная гипотеза

```text
LLM inference дорог.
Search, parsers, graphs, lint и tests дешевле.
```

Поэтому вместо увеличения числа моделей, агентов и размера context проект исследует противоположный подход:

```text
deterministic narrowing
→ small model-facing context
→ bounded mutation
→ deterministic verification
```

Пока неизвестно, насколько широкий класс реальных задач удастся таким образом закрыть.

Именно это проект и пытается измерить.

## Что мы хотим получить

В перспективе система должна уметь принимать небольшую инженерную задачу:

```text
"измени валидацию"
"исправь локальный bug"
"добавь тест"
"измени один endpoint"
"обнови несколько связанных callsites"
```

затем самостоятельно:

1. найти релевантный код;
2. определить ограниченную область воздействия;
3. подготовить небольшой patch;
4. проверить его;
5. при конкретной ошибке выполнить максимум один repair;
6. либо выдать подтверждённый результат, либо отказаться.

Ключевое слово здесь — **в перспективе**.

Текущий репозиторий содержит постепенно развиваемые части этой архитектуры и экспериментальную инфраструктуру для их проверки.

## Текущий фокус

Сейчас основная работа идёт вокруг:

* deterministic repository search;
* task-local impact analysis;
* structural parsing;
* tool contracts;
* bounded mutation;
* runtime и benchmark harnesses;
* локального inference под ограниченными ресурсами;
* проверки поведения на разных репозиториях;
* различения heuristic hypotheses и подтверждённого evidence.

Не все перечисленные в roadmap механизмы уже реализованы.

README намеренно не пытается создавать такое впечатление.

## Архитектурное направление

Проект постепенно разделяется на несколько ролей.

### Governor

Отвечает за budgets, timeout, cache, ограничения выполнения и историю задачи.

### Scout

Ищет релевантный код, symbols, dependencies и потенциальную область воздействия.

Результаты эвристического поиска считаются кандидатами, а не доказательством.

### Executor

Должен иметь возможность делать только ограниченные изменения.

Целевая архитектура не предполагает unrestricted shell/filesystem access для модели.

### Verifier

Проверяет patch через deterministic tooling и project-native tests.

Идея состоит в том, чтобы не использовать мнение LLM как окончательное доказательство корректности.

### Orchestrator

Связывает этапы в ограниченный state machine и управляет worktree, rollback и repair policy.

Это архитектурное направление. Отдельные части находятся на разных стадиях готовности.

## Почему SAFE_FAIL считается нормальным результатом

Проект не ставит целью обязательно выполнить каждую задачу.

Если система:

* не смогла уверенно локализовать изменение;
* столкнулась с неоднозначным symbol resolution;
* вышла за budget;
* не смогла доказать достаточность проверки;
* получила environment failure;

предпочтительным результатом должен быть отказ.

```text
SAFE_FAIL > unsupported VERIFIED
```

Насколько хорошо это правило соблюдается на реальных задачах — предмет текущего тестирования.

## Приоритет языков

Основной приоритет:

```text
Python
```

Далее:

```text
JavaScript / HTML / CSS
TypeScript
XML / Docker / SQL
```

Остальные языки пока рассматриваются как best effort.

## Roadmap

### 2.0 — bounded execution

Цель — проверить, можно ли достаточно надёжно построить:

```text
RETRIEVE
→ RESOLVE
→ CONSTRAIN
→ PATCH
→ PROVE
```

Исследуемые направления:

* deterministic state machine;
* isolated worktree;
* transactional mutation;
* exact/BM25-style retrieval;
* structural parsing;
* semantic source validation;
* bounded Impact Graph;
* invariants;
* regression test selection;
* differential verification;
* one-repair policy;
* content-addressed cache;
* end-to-end benchmark corpus.

### 3.0 — bounded investigation

Если 2.0 покажет приемлемые результаты, следующий вопрос:

> может ли система самостоятельно локализовать не полностью определённую проблему?

Возможные инструменты:

* iterative search;
* coverage-based fault localization;
* backward slicing;
* runtime probes;
* delta debugging;
* `git bisect`;
* test-to-code coverage graph.

### 4.0 — background operation

Только после появления достаточной статистики можно будет исследовать:

* task admission;
* persistent task ledger;
* resource-aware scheduling;
* Linux PSI;
* cgroups v2;
* bounded queue;
* automatic abstention;
* долгоживущий background worker.

Roadmap является направлением исследования, а не обещанием реализации.

## Что пока намеренно не добавляется

Без воспроизводимой проблемы и benchmark evidence проект старается не усложнять архитектуру через:

* embeddings;
* vector databases;
* PageRank;
* multi-agent swarm;
* MCTS;
* Tree-of-Thought;
* отдельный Planner LLM;
* LLM verifier как authority;
* unlimited repair loops;
* huge context;
* learned routing;
* RL scheduling.

Это не утверждение, что такие методы бесполезны.

Просто при текущих ограничениях сначала проверяются более простые решения.

## Как оценивается прогресс

Главный вопрос проекта не:

> насколько умным выглядит агент?

а:

> сколько реальных задач он способен корректно завершить при заданных ресурсах и насколько часто ошибочно объявляет результат проверенным?

Поэтому важны:

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

В идеале любое архитектурное улучшение должно быть видно на end-to-end задачах.

## Об авторстве

Проект активно разрабатывается с использованием генеративных ИИ-моделей.

Значительная часть:

* кода;
* тестов;
* benchmark scripts;
* документации;
* refactoring;
* отдельных архитектурных вариантов

была создана или переработана ИИ.

Человек при этом занимается исследованием задачи, постановкой ограничений, выбором архитектурных направлений, критикой решений, проектированием части системы, проведением экспериментов и оценкой результатов.

Поэтому наиболее точное описание:

> **Human-directed, heavily AI-assisted experimental engineering project.**

Этот репозиторий не претендует на изобретение используемых алгоритмов. Большая часть методов основана на известных подходах из software engineering, information retrieval и program analysis.

Интерес проекта — в проверке того, насколько полезно их сочетание в локальном coding-agent под жёсткими ресурсными ограничениями.

## Текущий статус

```text
experimental
in active development
not production-ready
API and architecture may change
results are still being validated
```

Если эксперимент окажется неудачным, это тоже будет полезным результатом: станет понятнее, какие ограничения не позволяют подобной архитектуре работать и где именно требуется более дорогой подход.
