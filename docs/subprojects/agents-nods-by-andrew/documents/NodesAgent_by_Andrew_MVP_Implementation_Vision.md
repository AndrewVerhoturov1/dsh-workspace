# NodesAgent_by_Andrew — видение реализации MVP

status: canonical implementation vision
language: ru
updated: 2026-09-21

## 1. Назначение документа

Этот документ фиксирует техническое видение реализации MVP плагина `NodesAgent_by_Andrew` поверх DeepSeek Harness.

Он дополняет продуктовую Vision и MVP-спецификацию, но не заменяет их. Product semantics остаются в `DSH_Agent_Orchestration_Vision_for_MVP.md` и `DSH_Agent_Orchestration_MVP.md`; этот документ отвечает на вопрос **как именно строить реализацию по этапам**, чтобы первый код не противоречил будущей архитектуре.

Главный практический результат документа — сделать обязательным отдельный первый этап `P0`: standalone HTML-прототип интерфейса до production-интеграции в DSH.

## 2. Каноническое имя

Каноническое имя плагина:

```text
NodesAgent_by_Andrew
```

Для будущего каталога и npm-compatible package используется техническое имя:

```text
plugins/dsh-nodes-agent-by-andrew/
dsh-nodes-agent-by-andrew
```

Текущий исторический путь подпроекта `docs/subprojects/agents-nods-by-andrew/` не переименовывается в рамках этого решения, чтобы не создавать несвязанную миграцию документации.

Случайное прежнее рабочее название больше не используется и не должно переноситься в UI, package names, TypeScript identifiers, storage domains, RPC names, тесты или новую документацию.

## 3. Языковая политика

### 3.1. Программные файлы и identifiers

Все программные артефакты ведутся на английском:

- TypeScript и JavaScript;
- HTML structure и технические атрибуты;
- CSS class names;
- JSON/YAML schemas;
- package names;
- RPC/API names;
- type/interface/class/function/variable identifiers;
- test names;
- comments в коде;
- технические имена storage tables и events.

Пример корректного программного API:

```ts
interface AgentNodeDefinition {
  id: AgentNodeId
  displayName: string
  technicalName: string
}
```

### 3.2. Документация

Документация подпроекта ведётся на русском языке. Английские технические термины и identifiers сохраняются там, где они являются именами сущностей или API.

### 3.3. Пользовательский интерфейс

Русская версия интерфейса готовится сразу, а не отдельным поздним этапом.

Production UI не должен захардкоживать русские строки в компонентах. С первого production UI milestone должны существовать локализуемые строки минимум для:

```text
en-US
ru-RU
```

Для `P0` HTML-прототипа допускается локальный словарь в `app.js`, но прототип должен позволять просмотреть русскую версию интерфейса и не связывать DOM identifiers с конкретным языком.

## 4. Цель MVP

`NodesAgent_by_Andrew` — плагин DeepSeek Harness для визуального создания команды независимых `AgentNode`, настройки их моделей, ролей, capabilities и отношений, сохранения `TeamDefinition` и `TeamLayout`, а затем запуска этой конфигурации как `TeamRun` поверх настоящих DSH Agent/Session.

Ключевая граница:

```text
NodesAgent_by_Andrew organizes agents.
DeepSeek Harness executes agents.
```

Плагин не создаёт собственный LLM runtime, собственный Chat или параллельный Agent engine.

## 5. Архитектурные инварианты

Следующие правила обязательны для всех этапов реализации:

```text
TeamDefinition != TeamLayout != TeamRun
Message != Task != TaskAttempt
Authority != Communication
Saved AgentNode != Runtime Agent
```

Дополнительно:

- DSH владеет реальными Agent и Session.
- Новый `TeamRun` по умолчанию создаёт новые runtime bindings.
- Пользователь всегда может открыть настоящий DSH Chat любого запущенного AgentNode.
- Human access к Chat не блокируется внутренним Communication graph.
- Authority graph не должен использоваться как скрытая замена DSH runtime ownership.
- Runtime permissions должны проверяться кодом, а не только prompt-инструкциями.
- Для capability policy действует правило `deny wins`.
- Программа хранит durable orchestration facts; LLM context не является единственным source of truth.

## 6. Что уже подтверждено по DSH

При подготовке этого implementation vision были изучены существующие workspace plugins и актуальная upstream-реализация DeepSeek Harness.

Полезные локальные reference implementations:

```text
plugins/dsh-agent-team-by-andrew/
plugins/dsh-better-sidebar-andrew/
plugins/dsh-flowglass-by-andrew/
plugins/dsh-restart-web/
```

Из них подтверждены применимые patterns:

- Cordis Host/Client plugin composition;
- service injection;
- storage domains;
- client slots;
- connection RPC в текущем workspace baseline;
- model/tool catalog access;
- subagent execution patterns;
- system prompt sections и agent lifecycle hooks.

Текущий workspace baseline в `profiles/web` в основном находится около DSH `0.1.1-rc.2`. Текущий upstream DeepSeek Harness уже новее и содержит дополнительные APIs, поэтому upstream используется как архитектурный reference, но не как доказательство ABI текущего `preview`.

Перед runtime milestone должны отдельно подтверждаться на фактическом installed ABI:

- continuable child-agent API;
- `uiWorkspace` или эквивалент для открытия существующей Session;
- `agents.create`/resume semantics;
- model capability metadata для `reasoningEffort`;
- scoped capability enforcement.

Эти пункты являются compatibility gates, а не поводом менять базовую модель продукта.

## 7. Phase P0 — standalone HTML UX Prototype

### 7.1. Почему P0 обязателен

Первым implementation milestone является не Cordis plugin и не runtime, а standalone HTML-прототип редактора.

Цель P0 — проверить:

- информационную архитектуру;
- размеры и расположение областей UI;
- UX создания и выбора AgentNode;
- Inspector;
- UX Authority и Communication edges;
- выбор Entry Agent;
- validation presentation;
- runtime-state presentation;
- русскую и английскую локализацию основных экранов.

P0 не доказывает работу DSH APIs и не является production архитектурой.

### 7.2. Планируемая структура P0

```text
docs/subprojects/agents-nods-by-andrew/prototypes/nodes-agent-mvp/
├─ index.html
├─ styles.css
├─ app.js
└─ README.md
```

Программные файлы и identifiers внутри прототипа — на английском. `README.md` — на русском.

### 7.3. Ограничения прототипа

Прототип может:

```text
use mock data
use in-memory state
use browser localStorage
simulate runtime states
use a simplified graph renderer
```

Прототип не должен:

- обращаться к реальному DSH backend;
- создавать настоящие DSH Sessions;
- притворяться доказательством compatibility;
- задавать production storage/API architecture через случайную структуру frontend state.

Production implementation переиспользует из P0 UX, terminology, layout и flows, но не обязана переиспользовать JS architecture прототипа.

### 7.4. Основной layout

```text
┌────────────────────────────────────────────────────────────┐
│ NodesAgent_by_Andrew       Team ▼       Save   Start       │
├─────────────────────────────────────────┬──────────────────┤
│                                         │                  │
│                                         │ Agent Inspector  │
│                                         │                  │
│                Canvas                   │ Name             │
│                                         │ Role             │
│      ┌────────────┐                     │ Model            │
│      │ Coordinator│                     │ Reasoning        │
│      └────────────┘                     │ System Prompt    │
│            │                            │ Capabilities     │
│            ▼                            │                  │
│      ┌────────────┐                     │                  │
│      │ Developer  │                     │                  │
│      └────────────┘                     │                  │
│                                         │                  │
├─────────────────────────────────────────┴──────────────────┤
│ Validation / runtime status                                │
└────────────────────────────────────────────────────────────┘
```

### 7.5. Canvas behaviour

P0 должен позволять:

- создать AgentNode;
- выбрать AgentNode;
- переместить AgentNode;
- удалить AgentNode;
- pan;
- zoom;
- fit view;
- переключить режим создания `Authority`/`Communication` edge;
- создать и удалить edge;
- визуально отличать разные типы edges.

Конкретные production colors и design tokens в архитектурном документе не фиксируются.

### 7.6. AgentNode card

Карточка минимум показывает:

```text
Display name
Role
Model
Runtime status
```

Для Entry Agent отображается отдельный badge.

### 7.7. Inspector

Inspector редактирует минимум:

```text
Technical name
Display name
Role
System prompt
Provider
Model
Reasoning effort
Capabilities
```

Поля `Provider`, `Model`, `Reasoning effort` и `Capabilities` в P0 работают на mock catalog.

### 7.8. Validation presentation

P0 должен визуально демонстрировать blocking validation errors минимум для случаев:

```text
Missing Entry Agent
Duplicate technical name
Authority cycle
Unknown model
Invalid capability
Dangling edge endpoint
```

Ошибки должны быть видимы в общей validation area и, где возможно, связаны с конкретной node/edge.

### 7.9. Mock runtime

Кнопка `Start` в P0 не запускает DSH. Она переводит mock state через понятные состояния, чтобы проверить UX.

Минимальные TeamRun states:

```text
STOPPED
STARTING
RUNNING
PAUSED
FAILED
```

Минимальные AgentNode runtime states:

```text
NOT_STARTED
IDLE
RUNNING
PAUSED
ERROR
STOPPED
```

`Open Chat` в P0 является видимой disabled/mock action с пояснением, что реальная навигация появится только в runtime milestone.

### 7.10. P0 acceptance criteria

P0 считается готовым, если без backend можно последовательно:

1. открыть прототип через локальный HTTP server;
2. переключить интерфейс минимум между `ru-RU` и `en-US`;
3. создать минимум четыре AgentNode;
4. настроить каждый node через Inspector;
5. назначить ровно один Entry Agent;
6. создать Authority edges;
7. создать Communication edges;
8. перемещать nodes и использовать pan/zoom/fit view;
9. сохранить mock definition/layout в browser state;
10. получить несколько validation errors;
11. исправить validation errors;
12. нажать `Start` и увидеть mock runtime states;
13. выбрать running AgentNode и увидеть `Open Chat` action;
14. выполнить mock Pause/Resume/Stop;
15. после Stop снова редактировать команду.

Проверка локального HTML выполняется через временный HTTP server, не через `file://`.

## 8. Production plugin architecture

После принятого P0 production plugin строится слоями:

```text
NodesAgent_by_Andrew
│
├── Design Model
│   ├── TeamDefinition
│   └── TeamLayout
│
├── Editor
│
├── Runtime
│   └── TeamRun
│
└── DeepSeek Harness Integration
    ├── Agent
    ├── Session
    ├── LLM
    ├── Tools / Capabilities
    └── Web Client
```

Планируемая структура production plugin:

```text
plugins/dsh-nodes-agent-by-andrew/
├─ package.json
├─ cordis.patch.yml
├─ tsconfig.json
├─ tsdown.config.ts
├─ src/
│  ├─ index.ts
│  ├─ model/
│  │  ├─ ids.ts
│  │  ├─ team-definition.ts
│  │  ├─ team-layout.ts
│  │  ├─ capability.ts
│  │  └─ validation.ts
│  ├─ storage/
│  │  ├─ design-domain.ts
│  │  └─ repository.ts
│  ├─ host/
│  │  ├─ service.ts
│  │  ├─ catalog.ts
│  │  └─ rpc.ts
│  ├─ runtime/
│  │  ├─ team-run.ts
│  │  ├─ runtime-manager.ts
│  │  ├─ message-bus.ts
│  │  └─ task-board.ts
│  └─ client/
│     ├─ index.tsx
│     ├─ controller.ts
│     ├─ locales.ts
│     └─ editor/
│        ├─ TeamEditor.tsx
│        ├─ Canvas.tsx
│        ├─ AgentNode.tsx
│        ├─ Edge.tsx
│        ├─ Inspector.tsx
│        ├─ Toolbar.tsx
│        └─ ValidationPanel.tsx
└─ tests/
   ├─ schema.spec.ts
   ├─ validation.spec.ts
   ├─ storage.spec.ts
   └─ rpc.spec.ts
```

Runtime files добавляются только в соответствующем runtime milestone; M1 не должен создавать fake runtime ради заполнения структуры.

## 9. TeamDefinition

Семантика сохранённой команды хранится отдельно от Canvas layout.

```ts
interface TeamDefinition {
  schemaVersion: 1
  id: TeamId
  revision: number
  name: string
  description?: string
  entryAgentId: AgentNodeId
  agents: AgentNodeDefinition[]
  authorityEdges: AuthorityEdge[]
  communicationEdges: CommunicationEdge[]
}
```

`revision` используется для optimistic concurrency и для привязки будущего `TeamRun` к конкретной сохранённой версии.

## 10. AgentNode

Минимальная форма:

```ts
interface AgentNodeDefinition {
  id: AgentNodeId
  technicalName: string
  displayName: string
  role: string
  systemPrompt: string
  model: {
    provider: string
    model: string
    reasoningEffort?: string
  }
  capabilities: CapabilityPolicy
}
```

Правила:

- `id` стабилен и не редактируется как display field;
- `technicalName` редактируем, но уникален внутри TeamDefinition;
- `displayName` предназначен для UI;
- `reasoningEffort` хранится как provider/model-owned opaque value, а не как hardcoded DeepSeek enum.

## 11. Capability model

MVP UI может начать с реальных DSH Tools, но data model не должна быть навсегда ограничена `tools[]`.

```ts
interface CapabilityPolicy {
  grants: CapabilityGrant[]
}

interface CapabilityGrant {
  kind: string
  id: string
  mode: 'allow' | 'deny'
  config?: JsonValue
}
```

Потенциальные будущие `kind`:

```text
tool
skill
mcp
filesystem
repository
network
computer-use
```

Основное правило разрешения конфликтов:

```text
deny wins
```

## 12. TeamLayout

Visual state хранится отдельно:

```ts
interface TeamLayout {
  schemaVersion: 1
  teamId: TeamId
  viewport: {
    x: number
    y: number
    zoom: number
  }
  nodes: Record<AgentNodeId, {
    x: number
    y: number
  }>
}
```

Перемещение карточки на Canvas не должно создавать semantic revision TeamDefinition, если семантические поля не менялись.

## 13. Authority graph

Authority отвечает на вопрос: кто является прямым manager для AgentNode.

MVP constraints:

```text
exactly one Entry Agent
max one direct manager per AgentNode
no self edge
no cycles
all endpoints must exist
```

Authority graph не равен DSH Session parent hierarchy.

## 14. Communication graph

Communication отвечает на вопрос: какой AgentNode может отправить agent-to-agent Message какому AgentNode.

Он хранится отдельно от Authority и не выводится автоматически из него.

Допустимо, например, чтобы `A` управлял `B`, но направления `A -> B` и `B -> A` задавались отдельной communication policy.

## 15. Validation

Production validator является отдельным pure/domain layer, а не набором UI conditions.

Минимальные blocking checks:

### AgentNode

- immutable ID shape;
- unique `technicalName`;
- non-empty `displayName`;
- provider/model exists in actual catalog;
- `reasoningEffort` допустим для выбранной model, если Harness предоставляет capability metadata;
- capability references существуют и не конфликтуют с policy rules.

### Team

- `entryAgentId` задан;
- `entryAgentId` ссылается на существующий node.

### Authority

- endpoints существуют;
- нет self-edge;
- максимум один direct manager;
- нет cycle.

### Communication

- endpoints существуют;
- policy direction валиден;
- communication graph не меняет результат authority validation.

## 16. Persistence

Design и runtime persistence разделяются концептуально и, при возможности, storage domains.

План:

```text
nodes_agent_design
  team_definitions
  team_layouts

nodes_agent_runtime
  team_runs
  messages
  tasks
  task_attempts
```

M1 использует только design storage. Runtime storage появляется вместе с реальным TeamRun.

## 17. Host/Client API boundary

UI не должен напрямую зависеть от конкретного transport API.

На стороне client вводится нейтральный слой вида:

```ts
interface NodesAgentApi {
  getCatalog(): Promise<NodesAgentCatalog>
  listTeams(): Promise<TeamSummary[]>
  getTeam(id: TeamId): Promise<TeamDefinition>
  createTeam(input: CreateTeamInput): Promise<TeamDefinition>
  saveTeam(input: SaveTeamInput): Promise<TeamDefinition>
  deleteTeam(id: TeamId): Promise<void>
  getLayout(teamId: TeamId): Promise<TeamLayout>
  saveLayout(layout: TeamLayout): Promise<void>
  validateTeam(team: TeamDefinition): Promise<ValidationResult>
}
```

Для текущего workspace baseline допустимо реализовать этот API через уже доказанный Connection RPC pattern. Если при implementation milestone актуальный Harness baseline предоставляет стабильный generated Remote API, transport можно заменить без изменения Editor/domain layer.

Save должен использовать `revision`/`expectedRevision`, чтобы две вкладки не перезаписывали изменения молча.

## 18. Production Editor

Production Editor переносит утверждённый UX из P0 в DSH client plugin.

Предпочтительный full-area seam — `conversation.view` или актуальный эквивалент, подтверждённый на installed baseline.

Основные области:

```text
Toolbar
Canvas
Inspector
Validation Panel
Runtime Status Area
```

Для graph renderer допускается специализированная библиотека вроде `@xyflow/react`, если она совместима с workspace build. Business/domain types не должны импортировать типы graph library; нужен adapter projection между `TeamDefinition`/`TeamLayout` и renderer nodes/edges.

## 19. TeamRun

Сохранённый AgentNode не является runtime agent.

```ts
interface TeamRun {
  id: TeamRunId
  teamDefinitionId: TeamId
  teamDefinitionRevision: number
  status: TeamRunStatus
  entryNodeId: AgentNodeId
  rootSessionId: SessionId
  bindings: Record<AgentNodeId, {
    sessionId: SessionId
    status: AgentRuntimeStatus
  }>
}
```

Основная связь:

```text
AgentNode
  -> TeamRun binding
  -> DSH Session
  -> DSH Agent
```

Новый `Start` создаёт новый TeamRun и новые bindings, если пользователь явно не выполняет Resume существующего Run.

## 20. Runtime topology

Смешивание business hierarchy с DSH lifecycle ownership запрещено; runtime topology и Authority semantics разделяются.

Пример Authority:

```text
Coordinator
└─ Architect
   ├─ Developer
   └─ Reviewer
```

Допустимая DSH runtime topology:

```text
Entry Session
├─ Architect Session
├─ Developer Session
└─ Reviewer Session
```

Authority остаётся отдельными domain edges и проверяется plugin layer.

## 21. Реальные DSH Agent/Session

Для runtime implementation предпочтителен continuable child-agent/session seam, потому что AgentNode должен:

- сохранять Session на протяжении TeamRun;
- получать последующие Messages;
- быть доступен через настоящий Chat;
- поддерживать pause/resume lifecycle настолько, насколько это позволяет DSH.

Если установленный workspace baseline не содержит пригодного continuable API, runtime milestone останавливается на compatibility gate и требует отдельного upgrade/adapter package. Нельзя подменять required semantics one-shot subagent execution и объявлять runtime завершённым.

## 22. Open Chat

`NodesAgent_by_Andrew` не реализует собственный Chat.

`Open Chat` должен открыть существующую DSH Session выбранного AgentRuntime стандартным DSH navigation API, подтверждённым на текущем baseline.

Communication restrictions относятся только к agent-to-agent обмену. Операторский доступ пользователя к Chat остаётся доступен.

## 23. Message Bus

Минимальная runtime entity:

```ts
interface TeamMessage {
  id: TeamMessageId
  runId: TeamRunId
  from: AgentNodeId
  to: AgentNodeId
  kind: 'message' | 'task-assignment' | 'task-result' | 'system'
  text: string
  state: 'queued' | 'delivered' | 'failed'
  createdAt: number
}
```

Минимальный pipeline:

```text
authorize
-> persist
-> deliver to target DSH Agent/Session
-> record outcome
```

Communication permission проверяется до доставки.

## 24. Tasks и TaskAttempts

Формальная работа моделируется отдельно от обычных Messages.

```text
Message != Task != TaskAttempt
```

`Task` хранит смысл и ownership работы. `TaskAttempt` хранит конкретную попытку конкретного AgentRuntime выполнить Task.

В MVP допускается одна попытка, но сущности всё равно разделены, чтобы не закрывать путь к retry/reassign/recovery.

Manager/model выбирает, какую работу поручить. Plugin layer проверяет authority, ownership, attempt identity и transitions. Глобальный auto-scheduler не распределяет ready Tasks сам.

## 25. Milestones

### Phase P0 — HTML UX Prototype

Результат:

- standalone HTML/CSS/JS prototype;
- Canvas;
- AgentNode cards;
- Inspector;
- Authority/Communication edges;
- Entry Agent;
- validation UI;
- mock runtime;
- `ru-RU` и `en-US` presentation;
- P0 acceptance criteria PASS.

Никакой DSH runtime integration.

### Milestone 1 — Plugin foundation

Результат:

- `plugins/dsh-nodes-agent-by-andrew/`;
- Cordis Host/Client integration;
- `TeamDefinition`;
- `TeamLayout`;
- design storage;
- model/tool catalog;
- CRUD API;
- validator;
- localization foundation.

Никакого fake TeamRun.

### Milestone 2 — Production Team Editor

Результат:

- UX P0 перенесён в настоящий DSH UI;
- Canvas;
- Inspector;
- Save/Load;
- catalog-backed model selection;
- capability configuration;
- validation presentation.

### Milestone 3 — TeamRun and real DSH Sessions

Результат:

- real DSH Agent/Session bindings;
- Start;
- Stop;
- live runtime status;
- Open Chat;
- новая Session на новый Run по умолчанию.

### Milestone 4 — Authority, Communication and Message Bus

Результат:

- runtime authority enforcement;
- runtime communication enforcement;
- durable TeamMessage;
- delivery в реальные Sessions;
- минимальная activity view.

### Milestone 5 — Minimal Tasks

Результат:

- Task;
- TaskAttempt;
- assignment;
- execution status;
- completion result;
- возврат result manager-у;
- без global auto-scheduler.

### Milestone 6 — DSH Chat entry flow

Результат:

- `Use Agent Team` в обычном DSH Chat;
- выбор сохранённой TeamDefinition;
- создание TeamRun;
- Entry Agent как основной user channel;
- остальные agents доступны через Open Chat.

### Milestone 7 — Pause/Resume and MVP hardening

Результат:

- soft Pause;
- Resume того же TeamRun;
- basic recovery/error presentation;
- durable orchestration state;
- end-to-end MVP Acceptance Checklist PASS.

## 26. Definition of Done для implementation milestones

Каждый milestone оформляется отдельной task branch и отдельным PR в `preview`.

Milestone считается завершённым только если:

- реализован заявленный vertical result;
- не добавлены скрытые функции следующего milestone;
- targeted tests соответствуют затронутому layer;
- `git diff --check` проходит;
- нет случайных local/runtime artifacts;
- документация подпроекта обновлена, если изменилось подтверждённое архитектурное решение;
- русская локализация не откладывается на неопределённое будущее для уже появившегося production UI.

## 27. Explicit non-goals MVP

Не входят в MVP без отдельного решения:

- Task dependency DAG;
- multiple-attempt UX и автоматический retry;
- responsibility transfer workflow;
- Decision / Approval subsystem;
- AwaitSet/event wakeup subsystem;
- Artifact Store/semantic project memory;
- dynamic agent creation;
- agent-driven graph mutation;
- Router/Queue/Condition nodes;
- live schema editing during Pause;
- advanced crash recovery;
- budgets/cost analytics;
- deep execution timeline.

## 28. Следующий конкретный шаг

После принятия этого документа следующий отдельный implementation package должен реализовать **только Phase P0**:

```text
docs/subprojects/agents-nods-by-andrew/prototypes/nodes-agent-mvp/
```

Он должен содержать полностью готовый standalone HTML prototype и минимальную инструкцию запуска/проверки через временный local HTTP server. Локальный агент не проектирует UX и не дописывает prototype; он только применяет подготовленный package и выполняет P0 checks.
