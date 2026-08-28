# Postman: асинхронная маршрутизация M4–M5

Дата: 2026-08-29

## Область

Этот этап доказывает локальный синтетический путь:

```text
Harness Agent → POSTMAN → durable MSG/REQ → synthetic READY
→ пробуждение той же POSTMAN-сессии → lookup владельца
→ Agent.followup() → POSTMAN_RESULT
```

Web ChatGPT, GitHub wakeup, QChat, UI Automation и Computer Use в M4–M5 не подключаются.

## Durable runtime

По умолчанию база находится в `%LOCALAPPDATA%\DSH\Postman\postman.db`, а журнал — в `%LOCALAPPDATA%\DSH\Postman\logs\postman.jsonl`. Runtime использует встроенный `node:sqlite`; запись сообщения и запроса выполняется одной транзакцией `BEGIN IMMEDIATE` / `COMMIT`.

Схема версии 1:

- `metadata(key, value)` — версия схемы;
- `messages(message_id, origin_agent_id, created_at, payload, status)` — входное сообщение;
- `requests(request_id, message_id, origin_agent_id, status, created_at, ready_at, delivered_at, result_text, result_sha256, delivery_key, error)` — асинхронная работа;
- `deliveries(delivery_key, request_id, target_agent_id, status, created_at, completed_at, harness_event_id, error)` — идемпотентная доставка.

`MSG_*` — корреляция входного сообщения. `REQ_*` генерируется самим runtime из UUID и не принимается от агента как готовый идентификатор.

## Контракт отправителя

Обычный агент вызывает scoped-глобальный инструмент `postman_async_send(message_id, task)`. Runtime получает `origin_agent_id` только из `exec.agent.id`, создаёт `MSG_*` и `REQ_*`, а затем ставит служебное сообщение POSTMAN через `Agent.followup()`. До успешного коммита ответ `POSTMAN_ACCEPTED` невозможен. Исходный агент не ждёт внешний результат в этом же turn.

POSTMAN после получения `POSTMAN_ASYNC_REQUEST` читает запись через `postman_runtime_get_request` и переводит её в `WAITING` через `postman_runtime_accept_request`.

## READY и доставка

Тестовый инструмент `postman_runtime_synthetic_ready` регистрируется только при переменной среды `DSH_POSTMAN_ALLOW_SYNTHETIC_READY=1`. Он принимает существующий `request_id` и результат, считает SHA-256, создаёт стабильный `delivery_key = request_id:result_sha256`, затем атомарно переводит запрос в `READY` и вызывает пробуждение POSTMAN.

Служебное событие содержит только `request_id` и `delivery_key`. POSTMAN обязан сначала запросить trusted-запись из runtime, затем вызвать `postman_runtime_deliver_ready`. Runtime выполняет:

1. `READY → DELIVERING` до внешнего `followup`;
2. проверку владельца из `requests.origin_agent_id`;
3. `Agent.followup()` только найденному исходному агенту;
4. `DELIVERING → DELIVERED` после того, как `followup()` не выбросил ошибку.

При отсутствии владельца результат не теряется: запрос получает `DELIVERY_BLOCKED_ORIGIN_MISSING`. При ошибке `followup()` запрос получает `DELIVERY_RETRY`. При неизвестном `REQ_*` возвращается `UNKNOWN_REQUEST`; агент и доставка не создаются.

## Идемпотентность и граница гарантии

Повтор того же `READY` с тем же результатом возвращает `DUPLICATE_SUPPRESSED`, не будит POSTMAN второй раз и не создаёт вторую строку доставки. Повторная обработка уже доставленного ключа также подавляется.

В установленной версии Harness `Agent.followup()` имеет тип `void`: он ставит сообщение в FIFO inbox и не возвращает идентификатор события или подтверждение, которое можно записать в базу. Поэтому гарантируется at-most-once при повторном `READY` и подавление дублей до нового `followup`, но не строгий exactly-once в crash window между успешной постановкой сообщения и записью `DELIVERED`. Runtime оставляет такое состояние `DELIVERING` и не делает небезопасный слепой повтор после перезапуска.

## Восстановление

При старте POSTMAN восстанавливается прежним fail-closed путём: `sessionPersistence.inspect()` → `ctx.agents.resume()`. Runtime перечисляет `READY` и `DELIVERY_RETRY` и снова ставит служебные `POSTMAN_READY` в ту же постоянную сессию. `WAITING` не отправляется повторно. `DELIVERING` сохраняется для диагностики границы crash window.

Фактические живые проверки подтвердили два варианта восстановления: `REQ_7B2CE25C962B418BB8FBA00228DC05ED` пережил перезапуск до `READY`, а `REQ_3D0586D412784AAAB79048D399D8B931` был оставлен в `READY` без wakeup и доставлен автоматически первым запуском после перезапуска. Если исходный агент не опубликован в live registry, runtime пытается штатно восстановить именно его по сохранённому идентификатору; при отсутствии persistence оставляет `DELIVERY_BLOCKED_ORIGIN_MISSING` и сохраняет результат.

## Журнал

`postman.jsonl` содержит время, тип события, идентификаторы, состояние, длины и SHA-256. Полный результат и задание в журнал не записываются, поэтому секреты не дублируются в диагностическом файле. Основные события: `MESSAGE_RECEIVED`, `REQUEST_CREATED`, `REQUEST_ACCEPTED`, `REQUEST_READY`, `POSTMAN_WAKE_REQUESTED`, `POSTMAN_WAKE_SUCCEEDED`, `DELIVERY_STARTED`, `FOLLOWUP_ENQUEUED`, `DELIVERED`, `DUPLICATE_SUPPRESSED`, `ORIGIN_MISSING`, `DELIVERY_FAILED`.

## Итоговый gate

Внутренний синтетический контур M4–M5 подтверждён на живых Harness-агентах A и B, включая обратный порядок READY, несколько запросов одного владельца, дублирование READY, перезапуск до READY и восстановление READY после перезапуска. Следующий минимальный стык — существующий GitHub wakeup: после записи входного `REQ_*.json` вызвать `markSyntheticReady` с доверенными `requestId` и результатом; сам GitHub-путь на этом этапе не изменён.
