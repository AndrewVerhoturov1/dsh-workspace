# DSH Agent Orchestration — Implementation Roadmap

## Назначение

Рабочая последовательность implementation milestones для плагина `NodesAgent_by_Andrew`. Это не расширяет scope MVP и не разрешает локальному агенту самостоятельно менять продуктовые или архитектурные решения.

Канонический implementation approach находится в `NodesAgent_by_Andrew_MVP_Implementation_Vision.md`.

Каждый milestone выполняется отдельной task branch и отдельным PR в `preview`.

# Phase P0 — Standalone HTML UX Prototype

Цель: до production DSH integration проверить UX и visual hierarchy редактора на полностью готовом standalone prototype.

Путь:

```text
docs/subprojects/agents-nods-by-andrew/prototypes/nodes-agent-mvp/
├─ index.html
├─ styles.css
├─ app.js
└─ README.md
```

Вертикальный результат:

- Canvas;
- AgentNode create/delete/move/select;
- Inspector;
- Entry Agent;
- Authority edges;
- Communication edges;
- validation presentation;
- mock Save/Load в browser state;
- mock Start/Pause/Resume/Stop;
- mock runtime statuses;
- видимая будущая команда Open Chat;
- минимум `ru-RU` и `en-US` presentation.

Ограничения:

- нет реального DSH backend;
- нет настоящих Agent/Session;
- нет production storage/RPC;
- prototype JS architecture не считается production architecture.

P0 должен пройти отдельные P0 acceptance criteria из implementation vision до начала production Editor.

# Milestone 1 — Plugin foundation

Вертикальный результат:

- `plugins/dsh-nodes-agent-by-andrew/`;
- Cordis Host/Client integration;
- `TeamDefinition`;
- `TeamLayout`;
- design storage;
- model/tool catalog;
- CRUD API;
- validator;
- localization foundation минимум `en-US`/`ru-RU`.

Пока команда не исполняется. Fake TeamRun не создаётся.

# Milestone 2 — Production Team Editor

Вертикальный результат:

- UX принятого P0 перенесён в настоящий DSH UI;
- отдельный большой Canvas;
- AgentNode create/delete/move/select;
- Inspector;
- Save/Load;
- catalog-backed provider/model selection;
- capabilities configuration;
- Validate;
- Entry Agent;
- русская и английская локализация UI.

# Milestone 3 — TeamRun and real DSH Sessions

Перед реализацией подтвердить на installed workspace baseline:

- continuable agent/session seam;
- Session navigation/Open Chat seam;
- Agent create/resume semantics;
- required model capability metadata.

Вертикальный результат:

- Start создаёт TeamRun;
- AgentRuntime для каждой ноды;
- real DSH Agent / Session binding;
- новый Run по умолчанию получает новые Sessions;
- Open Chat;
- Stop;
- базовый live runtime status.

Authority hierarchy не должна автоматически становиться DSH parent-child runtime hierarchy.

# Milestone 4 — Authority, Communication and Message Bus

Вертикальный результат:

- parent/child authority;
- max-one-parent + no-cycle validation;
- отдельная communication policy;
- обычный durable Message;
- runtime permission check;
- доставка в DSH Session;
- минимальный Messages activity view.

# Milestone 5 — Minimal Tasks

Вертикальный результат:

- manager создаёт Task;
- система создаёт TaskAttempt #1;
- assignee получает формальную работу;
- working/completed/failed/cancelled state;
- `complete_task(result)` или эквивалент;
- completion связывается с правильным attempt;
- result возвращается manager-у;
- никакого global auto-scheduler.

# Milestone 6 — DSH Chat entry flow

Вертикальный результат:

- `Use Agent Team` в обычном новом DSH Chat;
- выбор сохранённой TeamDefinition;
- запуск TeamRun;
- выбранный Chat становится основным каналом Entry Agent;
- остальные AgentRuntime доступны через Open Chat.

После этого должен проходить полный основной demo-сценарий.

# Milestone 7 — Pause / Resume and MVP hardening

Вертикальный результат:

- soft Pause;
- Resume того же Run;
- понятные node statuses;
- обработка базовых runtime errors;
- сохранение необходимого orchestration state;
- доведение end-to-end Acceptance Checklist до PASS.

Полный live schema editing на Pause не входит в этот milestone.

# После MVP

Отдельными решениями могут идти:

- multiple TaskAttempts / retry / reassign;
- responsibility transfer;
- Task dependency graph;
- Decision / Approval;
- AwaitSet and event wakeup;
- Artifacts;
- richer shared project knowledge;
- dynamic topology;
- Pause → Edit → Validate → Resume;
- advanced recovery;
- service nodes;
- budgets and analytics.

Ни один из этих пунктов не должен тихо втягиваться в MVP milestone «заодно».
