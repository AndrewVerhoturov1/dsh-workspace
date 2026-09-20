# DSH Agent Orchestration — Implementation Roadmap

## Назначение

Рабочая последовательность implementation milestones после регистрации подпроекта. Это не расширяет scope MVP и не разрешает локальному агенту самостоятельно менять продуктовые решения.

Конкретные файлы и DSH APIs для каждого milestone должны сначала подтверждаться по актуальному коду репозитория.

# Milestone 0 — Repository integration audit

Цель: точно определить существующие точки интеграции DSH, ничего не перепроектируя.

Нужно найти текущие реализации:

- Agent creation/configuration;
- Session creation/resume;
- native Chat opening/routing;
- model/reasoning configuration;
- capabilities/tools/skills/MCP access controls;
- cancellation/pause primitives;
- runtime status/events;
- persistence conventions;
- extension/plugin UI entry points.

Результат: короткий implementation handoff для Milestone 1 с exact paths/APIs.

# Milestone 1 — Team Editor shell

Вертикальный результат:

- отдельный большой Canvas;
- AgentNode create/delete/move/select;
- Inspector;
- TeamDefinition;
- TeamLayout;
- Save/Load;
- базовый Validate;
- Entry Agent field.

Пока команда может не исполняться.

# Milestone 2 — TeamRun and real DSH sessions

Вертикальный результат:

- Start создаёт TeamRun;
- AgentRuntime для каждой ноды;
- real DSH Agent / Session binding;
- Open Chat;
- Stop;
- базовый live runtime status.

После этого граф уже представляет настоящую команду DSH, даже до сложной кооперации.

# Milestone 3 — Authority, Communication and Message Bus

Вертикальный результат:

- parent/child authority;
- max-one-parent + no-cycle validation;
- отдельная communication policy;
- обычный Message;
- проверка права отправки;
- доставка в DSH Session;
- минимальный Messages activity view.

# Milestone 4 — Minimal Tasks

Вертикальный результат:

- manager создаёт Task;
- система создаёт TaskAttempt #1;
- assignee получает формальную работу;
- working/completed/failed/cancelled state;
- `complete_task(result)` или эквивалент;
- completion связывается с правильным attempt;
- result возвращается manager-у;
- никакого global auto-scheduler.

# Milestone 5 — DSH Chat entry flow

Вертикальный результат:

- `Use Agent Team` в обычном новом DSH Chat;
- выбор сохранённой TeamDefinition;
- запуск TeamRun;
- выбранный Chat становится основным каналом Entry Agent;
- остальные AgentRuntime доступны через Open Chat.

После этого должен проходить полный основной demo-сценарий.

# Milestone 6 — Pause / Resume and MVP hardening

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
