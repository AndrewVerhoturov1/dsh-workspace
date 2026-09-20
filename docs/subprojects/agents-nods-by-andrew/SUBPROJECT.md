# Agents Nods by Andrew

id: agents-nods-by-andrew
status: active
updated: 2026-09-20

## Goal

Создать плагин DSH Agent Orchestration: визуальную систему, в которой пользователь собирает команду настоящих DSH-агентов на нодовом Canvas, задаёт подчинение и разрешённое общение, запускает команду из обычного DSH Chat и наблюдает за её работой, задачами и runtime-состоянием.

MVP должен быть небольшим вертикальным срезом будущей системы, а не отдельным временным прототипом с другой семантикой.

## Current focus

Зафиксирована согласованная граница MVP и подготовлен полный документационный контекст подпроекта.

Текущий фокус после регистрации этого подпроекта — начать реализацию MVP по небольшим изолированным milestones, сначала подтвердив конкретные точки интеграции с существующими DSH Agent / Session / Chat / capability APIs.

## Next step

После внедрения этого документационного пакета выполнить отдельную read-only/analysis задачу по текущей реализации DSH и зафиксировать конкретные integration points для первого implementation milestone: Team Editor shell + `TeamDefinition` / `TeamLayout` + AgentNode inspector + Save/Load/Validate.

## Boundaries

- DSH остаётся владельцем настоящих агентов, DSH Sessions, модельных вызовов и индивидуального agent runtime. Плагин не должен строить параллельный agent engine.
- Каждый запущенный `AgentNode` должен быть связан с реальным DSH Agent / Session в рамках конкретного `TeamRun`.
- Пользователь определяет структуру команды; автономное создание/удаление агентов и изменение графа агентами не входит в MVP.
- Authority, Communication и Task — разные понятия и не должны сливаться в одну универсальную связь.
- У агента максимум один непосредственный manager; циклы authority-графа запрещены.
- Пользователь может открыть настоящий DSH Chat любого агента независимо от внутренних communication restrictions.
- Не каждое сообщение является Task. Обычные Messages и формальные Tasks существуют отдельно.
- `Task` и `TaskAttempt` должны быть разделены уже в модели MVP, даже если в MVP поддерживается только одна попытка.
- Следующую работу выбирает manager, а не глобальный автоматический scheduler.
- Состояние команды хранит программа, а не только prompts или context Lead.
- `TeamDefinition`, `TeamLayout` и `TeamRun` должны оставаться раздельными понятиями.
- Pause/Resume входит в MVP как простое управление Run; полноценный Pause → Edit → Validate → Resume отложен.
- Полный Artifact Store, Decision/Approval, AwaitSet, task dependency DAG, advanced recovery, analytics, budgets, service nodes и dynamic graph mutation не входят в MVP.
- При конфликте документов semantic invariants Vision имеют приоритет; текущая MVP-спецификация задаёт согласованную границу первого продукта; Original Concept используется только как каталог идей.
- Этот подпроект не переопределяет `AGENTS.md`, `REPO_POLICY.md` или канонические workflows репозитория.

## Read first

1. `AGENTS.md`
2. `REPO_POLICY.md`
3. `system/implementation-package-workflow.md` — когда работа выполняется через ZIP implementation package.
4. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Vision_for_MVP.md`
5. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_MVP.md`
6. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_MVP_Handoff.md`
7. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Architecture_Boundaries.md`
8. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_MVP_Acceptance_Checklist.md`
9. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Implementation_Roadmap.md`
10. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Concept_Original_Full.md` — только при необходимости углубиться в исходный каталог идей.

## Main paths

- `docs/subprojects/agents-nods-by-andrew/SUBPROJECT.md`
- `docs/subprojects/agents-nods-by-andrew/JOURNAL.md`
- `docs/subprojects/agents-nods-by-andrew/README.md`
- `docs/subprojects/agents-nods-by-andrew/documents/`
- будущие plugin/runtime/UI paths уточняются только после отдельного исследования актуального DSH кода и фиксируются здесь после первого implementation milestone.

## Current decisions

- Название подпроекта: **Agents Nods by Andrew**.
- Technical subproject id: `agents-nods-by-andrew`.
- MVP — отдельный большой ComfyUI-подобный Agent Team Editor с AgentNode и правым Inspector.
- AgentNode минимум содержит display name, technical name, role/description, model, reasoning effort, system prompt и расширяемые Capabilities.
- Capabilities шире Tools и в перспективе включают Tools, Skills, MCP, Files, Repositories, Network и другие ресурсы; реальные запреты применяются программно.
- Во время `TeamRun` каждый AgentNode работает через настоящий DSH Agent / Session; сохранённый AgentNode не привязан навсегда к одной Session.
- На AgentNode обязательна команда **Open Chat**, открывающая настоящий DSH Chat соответствующего runtime.
- Authority и Communication настраиваются отдельно.
- MVP содержит минимальный Message Bus и отдельные обычные Messages.
- MVP содержит минимальные Tasks и внутренний `TaskAttempt`.
- В схеме существует один Entry Agent, обычно Lead.
- В обычном новом DSH Chat появляется **Use Agent Team** с выбором сохранённой схемы; этот чат становится основным пользовательским каналом TeamRun через Entry Agent.
- Перед Start схема проходит Validate.
- MVP содержит Start / Pause / Resume / Stop и live status AgentNode.
- Схемы можно Save / Load; semantic state и visual layout хранятся раздельно.
- `TeamRun` обязателен как отдельная сущность конкретного запуска и владеет runtime bindings, Messages, Tasks и TaskAttempts.
- Содержимое MVP зафиксировано в `DSH_Agent_Orchestration_MVP.md`; расширять его без отдельного решения не следует.
