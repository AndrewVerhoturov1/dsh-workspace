# Agents Nods by Andrew

id: agents-nods-by-andrew
status: active
updated: 2026-09-21

## Goal

Создать плагин `NodesAgent_by_Andrew`: визуальную систему DSH Agent Orchestration, в которой пользователь собирает команду настоящих DSH-агентов на нодовом Canvas, задаёт подчинение и разрешённое общение, запускает команду из обычного DSH Chat и наблюдает за её работой, задачами и runtime-состоянием.

MVP должен быть небольшим вертикальным срезом будущей системы, а не отдельным временным runtime-прототипом с другой семантикой.

## Current focus

Read-only исследование существующих DSH plugin/runtime integration patterns выполнено и зафиксировано в implementation vision.

Текущий implementation focus — обязательный `Phase P0`: standalone HTML UX prototype редактора `NodesAgent_by_Andrew` до production Cordis/DSH integration.

## Next step

Подготовить отдельный implementation package для `Phase P0`, полностью реализующий:

```text
docs/subprojects/agents-nods-by-andrew/prototypes/nodes-agent-mvp/
├─ index.html
├─ styles.css
├─ app.js
└─ README.md
```

Локальный агент должен только механически применить готовый package, запустить prototype через временный HTTP server, выполнить минимальные P0 checks, commit/push и открыть PR в `preview`.

## Boundaries

- Каноническое имя плагина: `NodesAgent_by_Andrew`; случайные рабочие названия не переносятся в API, storage, UI или новые документы.
- Программные файлы, identifiers, API/RPC/storage names, tests и code comments ведутся на английском; документация подпроекта — на русском.
- Русская UI-локализация готовится одновременно с production UI; минимум `en-US` и `ru-RU` не откладываются на отдельный поздний milestone.
- `Phase P0` — standalone UX prototype, а не production runtime и не доказательство DSH API compatibility.
- DSH остаётся владельцем настоящих агентов, DSH Sessions, модельных вызовов и индивидуального agent runtime. Плагин не должен строить параллельный agent engine.
- Каждый запущенный `AgentNode` должен быть связан с реальным DSH Agent / Session в рамках конкретного `TeamRun`.
- Пользователь определяет структуру команды; автономное создание/удаление агентов и изменение графа агентами не входит в MVP.
- Authority, Communication и Task — разные понятия и не должны сливаться в одну универсальную связь.
- У агента максимум один непосредственный manager; циклы authority-графа запрещены.
- Authority graph не используется как скрытая DSH Session parent hierarchy.
- Пользователь может открыть настоящий DSH Chat любого агента независимо от внутренних communication restrictions.
- Не каждое сообщение является Task. Обычные Messages и формальные Tasks существуют отдельно.
- `Task` и `TaskAttempt` должны быть разделены уже в модели MVP, даже если в MVP поддерживается только одна попытка.
- Следующую работу выбирает manager, а не глобальный автоматический scheduler.
- Состояние команды хранит программа, а не только prompts или context Lead.
- `TeamDefinition`, `TeamLayout` и `TeamRun` должны оставаться раздельными понятиями.
- Pause/Resume входит в MVP как простое управление Run; полноценный Pause → Edit → Validate → Resume отложен.
- Полный Artifact Store, Decision/Approval, AwaitSet, task dependency DAG, advanced recovery, analytics, budgets, service nodes и dynamic graph mutation не входят в MVP.
- При конфликте документов semantic invariants Vision имеют приоритет; текущая MVP-спецификация задаёт согласованную границу первого продукта; `NodesAgent_by_Andrew_MVP_Implementation_Vision.md` задаёт канонический implementation approach; Original Concept используется только как каталог идей.
- Этот подпроект не переопределяет `AGENTS.md`, `REPO_POLICY.md` или канонические workflows репозитория.

## Read first

1. `AGENTS.md`
2. `REPO_POLICY.md`
3. `system/implementation-package-workflow.md` — когда работа выполняется через ZIP implementation package.
4. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Vision_for_MVP.md`
5. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_MVP.md`
6. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_MVP_Handoff.md`
7. `docs/subprojects/agents-nods-by-andrew/documents/NodesAgent_by_Andrew_MVP_Implementation_Vision.md`
8. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Architecture_Boundaries.md`
9. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_MVP_Acceptance_Checklist.md`
10. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Implementation_Roadmap.md`
11. `docs/subprojects/agents-nods-by-andrew/documents/DSH_Agent_Orchestration_Concept_Original_Full.md` — только при необходимости углубиться в исходный каталог идей.

## Main paths

- `docs/subprojects/agents-nods-by-andrew/SUBPROJECT.md`
- `docs/subprojects/agents-nods-by-andrew/JOURNAL.md`
- `docs/subprojects/agents-nods-by-andrew/README.md`
- `docs/subprojects/agents-nods-by-andrew/documents/`
- `docs/subprojects/agents-nods-by-andrew/prototypes/nodes-agent-mvp/` — следующий `P0` implementation path.
- `plugins/dsh-nodes-agent-by-andrew/` — planned production plugin path после P0.

## Current decisions

- Название подпроекта: **Agents Nods by Andrew**.
- Technical subproject id: `agents-nods-by-andrew`.
- Каноническое имя плагина: **NodesAgent_by_Andrew**.
- Planned package/directory name: `dsh-nodes-agent-by-andrew` / `plugins/dsh-nodes-agent-by-andrew/`.
- Программирование ведётся на английском; документация подпроекта — на русском; production UI с первого этапа локализации имеет минимум `en-US` и `ru-RU`.
- Перед production plugin обязателен standalone `Phase P0` HTML UX prototype.
- MVP — отдельный большой ComfyUI-подобный Agent Team Editor с AgentNode и правым Inspector.
- AgentNode минимум содержит display name, technical name, role/description, model, reasoning effort, system prompt и расширяемые Capabilities.
- Capabilities шире Tools и в перспективе включают Tools, Skills, MCP, Files, Repositories, Network и другие ресурсы; реальные запреты применяются программно; при конфликте `deny wins`.
- Во время `TeamRun` каждый AgentNode работает через настоящий DSH Agent / Session; сохранённый AgentNode не привязан навсегда к одной Session.
- DSH runtime topology и Authority hierarchy не считаются одной и той же структурой.
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
- Содержимое MVP зафиксировано в `DSH_Agent_Orchestration_MVP.md`; способ реализации — в `NodesAgent_by_Andrew_MVP_Implementation_Vision.md`; расширять MVP без отдельного решения не следует.
