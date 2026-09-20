# DSH Agent Orchestration — Architecture Boundaries

## Назначение

Короткая техническая памятка по границам, которые нельзя случайно сломать при реализации MVP.

Этот документ не заменяет Vision или MVP specification.

# 1. Runtime boundary

```text
AgentNode
  ↓
AgentRuntime
  ↕
DSH Agent / DSH Session
```

- `AgentNode` — сохранённая часть определения команды.
- `AgentRuntime` — состояние AgentNode внутри конкретного `TeamRun`.
- DSH Session принадлежит runtime конкретного запуска, а не навсегда сохранённой ноде.
- Плагин не реализует собственный модельный executor.

# 2. Team boundary

```text
TeamDefinition ≠ TeamLayout ≠ TeamRun
```

- `TeamDefinition` — смысл команды.
- `TeamLayout` — координаты и визуальное состояние Canvas.
- `TeamRun` — конкретный запуск frozen/identified definition revision с runtime bindings.

Перемещение карточки не меняет семантику команды. Новый запуск не должен случайно продолжать Sessions предыдущего запуска.

# 3. Three relation concepts

```text
Authority
Communication
Task / Task ownership-execution
```

Это три разные вещи.

- Authority: кто кому manager.
- Communication: кто кому может писать.
- Task: формально порученная работа.

В MVP authority-граф: максимум один parent, циклы запрещены.

# 4. Message is not Task

Manager может отправить обычный Message или создать формальную Task. Нельзя превращать весь межагентный трафик в Tasks.

# 5. Task is not TaskAttempt

```text
Task
  └─ TaskAttempt #1
```

В MVP допустима одна попытка, но сущности раздельны. Это сохраняет путь к retry, reassign, cancel, recovery и защите от stale completion.

# 6. No global automatic scheduler

Оркестратор может знать, что агент idle или Task готова, но следующую работу выбирает manager. MVP не должен автоматически раздавать ready Tasks свободным агентам.

# 7. Durable team state

Критические факты не должны существовать только в LLM context:

- кто parent;
- кому разрешено писать;
- какой TeamRun активен;
- AgentNode → Session binding;
- Messages;
- Task / TaskAttempt status;
- accepted task result.

Полное crash recovery можно отложить, но модель не должна быть in-memory-only по замыслу.

# 8. User control boundary

Пользователь всегда может открыть настоящий DSH Chat любого агента. Внутренние communication restrictions относятся к agent-to-agent обмену и не блокируют оператора.

# 9. Capabilities boundary

Не моделировать доступы как вечный `tools[]`.

Конфигурация должна допускать Tools, Skills, MCP, Files, Repositories, Network и другие ресурсы. Реальные deny/allow ограничения применяются программно там, где DSH это поддерживает.

# 10. Run lifecycle boundary

MVP:

```text
DRAFT/READY
→ RUNNING
→ PAUSING
→ PAUSED
→ RUNNING
→ STOPPED
```

Полный Pause → Edit → Validate → Resume отложен, но архитектура не должна делать такой сценарий невозможным.

# 11. Entry Agent boundary

У TeamDefinition один Entry Agent. Обычный DSH Chat с `Use Agent Team` направляет пользовательские сообщения этому агенту, но пользователь может отдельно открыть любой другой AgentRuntime.

# 12. Explicitly deferred

Не втягивать в MVP без отдельного решения:

- Task dependency DAG;
- multiple-attempt behavior / retry UI / reassign;
- responsibility-transfer workflow;
- Decision / Approval;
- AwaitSet;
- Artifact Store / semantic project memory;
- Router / Queue / Condition nodes;
- Tool / Skill / MCP nodes;
- dynamic agent creation;
- agent-driven graph mutation;
- full live graph editing;
- advanced crash recovery;
- budgets / cost analytics / deep timeline.
