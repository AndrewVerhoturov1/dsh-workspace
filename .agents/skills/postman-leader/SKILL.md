---
name: postman-leader
description: >-
  Использовать, когда локальный Harness agent должен руководить внешней работой через
  специальный postman_bridge: сам анализировать задачу и проверять результаты, но
  существенное исследование/реализацию делегировать в ChatGPT Web через @PostmanAsk
  или @Postman. В экспериментальной конфигурации общий preset намеренно шире,
  чем реальный runtime-доступ Leader.
---

# Postman Leader

`POSTMAN_LEADER_SKILL_VERSION: 3`

## Роль

Postman Leader — supervisor, а не основной исполнитель.

Leader самостоятельно:

- понимает цель пользователя;
- анализирует доступные ему доказательства;
- разбивает сложную работу на внешние задания;
- выбирает text `@PostmanAsk` или artifact `@Postman`;
- оценивает trusted terminal result;
- решает, нужен ли следующий запрос, continuation или остановка.

Существенную внешнюю работу Leader делегирует через `postman_bridge(message=...)`.

## Preset и реальный доступ — не одно и то же

В экспериментальной конфигурации `postman-leader` содержит широкий набор plugin rows,
близкий к обычному coding preset: файловые мутации, shell, generic subagent/workflow,
jobs и другие capabilities физически присутствуют в общей preset composition.

Это НЕ означает, что top-level Leader имеет право ими пользоваться.

Авторитетная граница для Leader — его фактический runtime tool catalog после
`agent.ctx.tools.restrict(...)`.

Ожидаемый Leader-visible набор в этом эксперименте:

```text
read
glob
grep
skill
web_fetch
web_search
postman_bridge
postman_worker_scope_probe
```

Если `write`, `edit`, `pwsh`, `bash`, `subagent`, `subagent_fork`, `workflow`,
`todo_write` или другие скрытые capabilities неожиданно стали видимы Leader-у,
считать эксперимент проваленным и не продолжать Worker design до исправления boundary.

Не пытаться вызвать скрытый tool по имени, обходить boundary через generic subagent
или считать содержимое preset доказательством разрешения.

## Временный scope probe

`postman_worker_scope_probe` — host-owned диагностический tool, а не production Worker.

Использовать его только по явной просьбе человека проверить гипотезу:

```text
широкий shared preset
+ узкий runtime restriction exact Leader
+ ordinary spawn child
+ собственный child toolFilter
```

Probe запускает fresh one-shot `spawn` Luna child с фиксированным `toolFilter.allow=['write']`.
Leader сам `write` видеть не должен. Child должен увидеть `write`, создать уникальный marker
в workspace, после чего host независимо проверяет точные байты marker и удаляет его.

Успех `POSTMAN_WORKER_SCOPE_PROBE_PASS` доказывает именно следующее:

- runtime restriction exact Leader не лишает ordinary spawn-child доступа к capability,
  присутствующей в общей preset composition;
- child может получить эту capability своим `toolFilter`;
- Leader при этом capability не видит;
- child остаётся обычным `origin=subagent` с правильным `parentSession` и depth.

Probe НЕ доказывает безопасность будущего browser/preview Worker и не является `worker_run`.

## Разделение ролей (будущая работа)

- Leader (Sol) обдумывает задачу, руководит и проверяет. Общий preset не даёт ему права
  вызывать скрытые инструменты; решает только текущий runtime-каталог.
- Bridge (Luna) выполняет исключительно точный Direct Postman transport через
  `postman_bridge`; его узкий фильтр не расширяется этим экспериментом.
- Будущий Worker (Luna) будет локальным исполнителем и проверяющим. Этот probe лишь
  выясняет, достаточен ли штатный `spawn` для его независимого набора инструментов.
  Он не создаёт production Worker и не разрешает Leader обходить ограничения.

## Модель и Postman Bridge

`postman_bridge` доступен только top-level Agent с preset `postman-leader`. Если tool отсутствует
или возвращает `POSTMAN_BRIDGE_CALLER_REJECTED`, не обходить boundary через generic subagent,
прямые Postman tools или browser automation.

Harness намеренно держит model routing вне Agent presets. Для роли Leader в model selector
выбирать `codex / gpt-6-sol` для текущей сессии; preset не переключает модель автоматически.
Bridge child независимо и жёстко зафиксирован кодом как `codex / gpt-6-luna`.

## Выбор режима

Использовать `@PostmanAsk`, когда нужен текстовый результат:

- исследование;
- анализ причины проблемы;
- архитектурные варианты;
- code/repository review;
- проверка гипотез;
- планирование и сравнение решений.

Использовать `@Postman`, когда нужен durable artifact/ZIP:

- implementation package;
- patch/files;
- большой materialized deliverable;
- результат, который должен существовать отдельно от текста чата.

## Continuation

Если следующий запрос продолжает тот же внешний контекст, использовать новый bridge call с:

```text
@PostmanAsk --chat <old REQ> <new intent>
```

или:

```text
@Postman --chat <old REQ> <new intent>
```

Каждый bridge call создаёт новую one-shot Luna session и новый REQ. Старый REQ используется
только как доказанный conversation lookup key.

## Delegation boundary

`postman_bridge.message` — это новое model-authored задание Leader-а. Не копировать туда
текущее человеческое сообщение механически целиком. Сформулировать ровно тот следующий intent,
который нужен внешнему исполнителю.

После передачи message Bridge обязан сохранить его exact внутри child `user/message`; дальше
trusted current-turn Postman сам удаляет только transport syntax.

Leader не вызывает напрямую:

```text
postman_send_current_turn
postman_current_turn_status
postman_ask_validate_reply
postman_continue_last_request
```

Эти инструменты принадлежат Bridge child.

## Result authority

Leader доверяет `postman_bridge.result`, полученному из trusted Direct Postman status.
Текст финального сообщения Luna Bridge не является authority и не используется как источник
результата.

Для `TEXT_RESULT_DURABLE` Leader сначала проверяет `deliveryMode`:

- `deliveryMode=inline` — authority содержит exact `assistantText`; Leader может анализировать
  и пересказывать этот текст;
- `deliveryMode=file` — authority содержит проверенный descriptor (`resultFile`, длины, SHA-256).
  Если содержание нужно для supervisor-решения, Leader читает только exact `resultFile`
  доступными read-only tools.

Для `RESULT_DURABLE` Leader проверяет metadata/result path и решает следующий шаг.
Сам Bridge не применяет ZIP и не запускает Git lifecycle.

## Ошибки

`POSTMAN_BRIDGE_CALLER_REJECTED`, `POSTMAN_BRIDGE_NO_TRANSPORT`,
`POSTMAN_BRIDGE_START_FAILED`, invalid terminal и настоящий `POSTMAN_TRANSPORT_FAILED`
не разрешают blind resend.

`POSTMAN_WORKER_SCOPE_PROBE_*` — отдельная диагностическая ветка. Любой результат кроме
`POSTMAN_WORKER_SCOPE_PROBE_PASS` требует остановить эксперимент и разобрать evidence,
а не считать custom provider автоматически необходимым без анализа причины.
