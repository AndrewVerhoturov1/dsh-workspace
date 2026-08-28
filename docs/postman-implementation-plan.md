# Postman: план реализации

## 1. Цель

Postman — отдельная постоянная умная Harness-сессия, которая является единственным владельцем внешнего транспорта ChatGPT и обслуживает несколько рабочих Harness-агентов.

Postman должен:

- принимать запросы от разных Harness-сессий;
- автоматически знать, какая сессия является отправителем;
- создавать и хранить устойчивую связь `REQ -> originSession`;
- управлять очередью внешних запросов;
- отправлять задачи в ChatGPT Desktop/Web;
- не блокировать исходного агента на время длинного ответа;
- получать асинхронный результат через GitHub wakeup;
- автоматически будить свою Harness-сессию после новых входящих событий;
- возвращать результат именно исходной Harness-сессии;
- использовать LLM reasoning для нестандартных состояний;
- использовать Computer Use только как диагностический инструмент, когда детерминированный путь не даёт однозначного состояния.

Postman не должен хранить критическое состояние только в контексте LLM. Истина должна находиться в детерминированном runtime/state layer.

---

## 2. Целевая архитектура

```text
HARNESS
│
├── Agent A
├── Agent B
├── Agent C
│
└── POSTMAN                     постоянная умная Harness-сессия
      │
      ├── Postman Runtime       детерминированная инфраструктура
      │   ├── inbox
      │   ├── SQLite / registry
      │   ├── locks
      │   ├── state machine
      │   ├── journal
      │   └── delivery state
      │
      ├── ChatGPT transport
      │   ├── Desktop/UIA
      │   └── Web ChatGPT
      │
      ├── GitHub wakeup
      │
      └── Computer Use          только диагностика
```

Ключевое разделение:

```text
Postman Agent   = reasoning, решения, диагностика
Postman Runtime = состояние, маршрутизация, идемпотентность, блокировки
```

Обычные Harness-агенты не должны напрямую владеть ChatGPT UI после перехода на полноценный Postman transport.

---

## 3. Уже подтверждённая инфраструктура

К началу реализации Postman уже подтверждён live E2E канал:

```text
обычный Web ChatGPT
→ GitHub Issue
→ GitHub Actions
→ self-hosted Windows runner
→ postman/github-wakeup.ps1
→ %LOCALAPPDATA%\DSH\Postman\signals\REQ_*.json
```

Live probe подтвердил доставку:

```text
requestId = REQ_PROBE_001
status    = READY
response  = POSTMAN_LIVE_WAKEUP_OK
```

Этот GitHub wakeup слой рассматривается как рабочий black box. Его не следует переделывать без отдельной причины.

---

## 4. Основной жизненный цикл запроса

### 4.1 Отправка

```text
Agent A / SESSION_A
↓
postman.send(task)
↓
Harness автоматически сообщает originSession
↓
Postman Runtime создаёт MSG и REQ
↓
СНАЧАЛА durable запись:
REQ_123 → SESSION_A
↓
POSTMAN получает событие NEW_REQUEST
↓
POSTMAN отправляет задачу во внешний ChatGPT
↓
REQ_123 = WAITING
↓
Agent A не блокируется
```

### 4.2 Получение результата

```text
ChatGPT закончил задачу
↓
GitHub Issue:
REQ_123 READY + response
↓
GitHub wakeup
↓
локальный READY signal
↓
Postman Runtime:
REQ_123 WAITING → READY
↓
будится POSTMAN session
↓
lookup:
REQ_123 → SESSION_A
↓
POSTMAN_RESULT → SESSION_A
↓
REQ_123 = DELIVERED
```

---

## 5. Главные инварианты

### 5.1 Адресация

Каждый request обязан иметь устойчивого владельца:

```text
REQ_ID → originSessionId
```

Имя агента, название чата или текст prompt не являются достаточным адресом.

`originSessionId` должен определяться автоматически из Harness runtime при отправке запроса.

### 5.2 Сначала состояние, потом внешнее действие

Перед отправкой во внешний ChatGPT должна существовать durable запись владельца request.

```text
создать REQ
→ записать REQ → session
→ только потом external submit
```

### 5.3 Один внешний транспортный владелец

После включения Postman:

```text
Agent A ─X→ ChatGPT transport
Agent B ─X→ ChatGPT transport
Agent C ─X→ ChatGPT transport

POSTMAN → ChatGPT transport
```

### 5.4 Не доверять памяти LLM

После compaction/restart POSTMAN должен восстановить состояние из runtime/database.

### 5.5 Идемпотентность

Один REQ не должен:

- отправляться дважды без доказанной необходимости;
- доставляться владельцу дважды;
- менять владельца после регистрации;
- теряться при повторном GitHub event/workflow rerun.

### 5.6 Computer Use

Нормальный успешный путь:

```text
Computer Use = 0
```

Computer Use разрешён только при неоднозначном или нестандартном UI-состоянии, которое нельзя безопасно классифицировать детерминированным способом.

---

## 6. Постоянное состояние

Предпочтительное расположение:

```text
%LOCALAPPDATA%\DSH\Postman\
```

Целевая структура:

```text
Postman\
├── postman.db
├── signals\
├── processed\
├── runtime\
└── logs\
    └── postman.jsonl
```

### SQLite

Минимальные сущности:

#### messages

```text
message_id
origin_session_id
created_at
payload
status
```

#### requests

```text
request_id
message_id
origin_session_id
conversation_id
issue_number
status
created_at
submitted_at
completed_at
delivered_at
error
```

#### deliveries

```text
request_id
target_session_id
delivery_key
status
delivered_at
```

#### conversations

Добавляется полноценно на этапе continuation:

```text
conversation_id
native_locator
created_at
last_request_id
```

### Audit log

`postman.jsonl` отвечает на вопрос «что происходило», а SQLite — «каково состояние сейчас».

Типовые события:

```text
MESSAGE_RECEIVED
REQUEST_CREATED
REQUEST_SUBMITTED
WAITING
GITHUB_READY
POSTMAN_WOKEN
DELIVERY_STARTED
DELIVERED
DUPLICATE_SUPPRESSED
DELIVERY_BLOCKED
DIAGNOSTIC_STARTED
```

---

## 7. Этапы реализации

## M1. Создать постоянную Harness-сессию POSTMAN

Цель: доказать, что POSTMAN существует как отдельная неактивная Harness-сессия и может быть программно разбужен.

Нужно исследовать штатные механизмы Harness:

- session identity;
- session event/followup;
- AutoContinueRunner;
- `agent.followup`;
- `resumeNow`;
- очередь сообщений в неактивную сессию.

Критерий:

```text
Harness runtime
→ программное сообщение в POSTMAN
→ POSTMAN session запускает turn
```

Не требуется ChatGPT/GitHub.

---

## M2. Agent A → POSTMAN → Agent A

Цель: первая внутренняя почта Harness.

```text
Agent A
→ PING A
→ POSTMAN
→ PONG A
→ Agent A
```

Требования:

- без ручного переключения чатов;
- без ручного ввода sessionId;
- POSTMAN видит реальный sender session locator;
- ответ возвращается именно отправителю.

Gate:

```text
AGENT A → POSTMAN → AGENT A = PASS
```

---

## M3. Два независимых отправителя

```text
Agent A → PING A
Agent B → PING B
```

Один POSTMAN должен получить оба сообщения и вернуть:

```text
Agent A ← PONG A
Agent B ← PONG B
```

Требования:

- 0 cross-delivery;
- sender identity определяется автоматически;
- POSTMAN может быть неактивным в UI;
- сообщения могут прийти почти одновременно.

Gate:

```text
A+B → один POSTMAN → A+B
0 cross-routing
```

---

## M4. Postman Runtime + durable registry

После доказательства внутренней Harness-почты добавить SQLite/runtime.

Первый обязательный mapping:

```text
REQ_123 → originSessionId
```

Добавить минимальный `postman.send(task)`:

```text
Agent
→ send
→ runtime получает originSession
→ создаёт MSG/REQ
→ durable registry
→ будит POSTMAN
→ сразу возвращает POSTMAN_ACCEPTED
```

Agent не ждёт внешнего ответа.

---

## M5. Synthetic READY → исходная сессия

Без внешнего ChatGPT.

```text
Agent A
→ Postman создаёт REQ_A → SESSION_A
→ synthetic READY REQ_A
→ POSTMAN просыпается
→ lookup owner
→ POSTMAN_RESULT → SESSION_A
```

Gate:

```text
REQ owner registration + asynchronous return = PASS
```

---

## M6. Подключить существующий GitHub wakeup

Подключить уже доказанный канал:

```text
GitHub READY
→ signals\REQ_xxx.json
→ runtime READY
→ wake POSTMAN
→ delivery originSession
```

На этом этапе не менять GitHub transport без необходимости.

---

## M7. Первый полный live цикл

```text
Harness Agent
→ POSTMAN
→ Web ChatGPT
→ GitHub
→ Windows
→ POSTMAN
→ тот же Harness Agent
```

Целевой gate:

```text
5/5 live requests
0 manual intervention
0 wrong-session deliveries
0 duplicate deliveries
```

---

## M8. Многозадачность

Проверить несколько рабочих Harness-сессий и несколько одновременно ожидающих ChatGPT requests.

```text
REQ_A → SESSION_A
REQ_B → SESSION_B
REQ_C → SESSION_C
```

Внешние UI-submit операции сериализуются одним POSTMAN, но ChatGPT-задачи могут выполняться параллельно в разных разговорах.

Ответы могут приходить в любом порядке.

---

## M9. Умная диагностика + Computer Use

Нормальный маршрут остаётся детерминированным.

LLM POSTMAN используется для обработки исключений:

- response overdue;
- GitHub write не произошёл;
- UIA contradictory state;
- неожиданное окно;
- authentication prompt;
- chat locator ambiguity;
- неизвестная ошибка транспорта.

Computer Use используется только после детерминированной диагностики, когда состояние нельзя безопасно определить иначе.

---

## M10. Continuation существующего ChatGPT-чата

Добавить:

```text
postman.continue(chatId, task)
```

Для этого отдельно исследовать persistent locator обычного ChatGPT conversation:

- deeplink;
- conversation/session ID;
- conversation path;
- sidebar/search fallback.

Это не блокирует Postman v1 для новых независимых запросов.

---

## M11. Crash recovery и production hardening

После перезапуска Postman восстанавливает состояние из SQLite.

Правила:

```text
QUEUED      → можно обработать
WAITING     → НЕ resend автоматически
READY       → можно доставить
DELIVERING  → специальный recovery protocol
DELIVERED   → никогда не доставлять повторно
```

Нужны устойчивые locks, delivery IDs и подтверждение enqueue/followup от Harness runtime.

---

## 8. Postman session как интерфейс

На первом этапе POSTMAN — обычная отдельная Harness-сессия/чат:

```text
Harness
├── рабочий чат A
├── рабочий чат B
└── POSTMAN
```

Пользователь может открыть её для диагностики, но нормальная связь происходит программно.

POSTMAN должен работать и когда его чат не выбран в интерфейсе.

Пример диагностического timeline внутри POSTMAN:

```text
POSTMAN_INBOX MSG_117 from SESSION_A
Создан REQ_331
REQ_331 SUBMITTED
REQ_331 WAITING
REQ_331 READY
REQ_331 DELIVERED → SESSION_A
```

После стабилизации можно рассмотреть скрытый/background service-agent UI, не меняя архитектуру.

---

## 9. API для обычных Harness-агентов

MVP:

```text
postman.send(task)
```

Позже:

```text
postman.continue(chatId, task)
postman.status(requestId)
postman.cancel(requestId)
```

Обычный агент не должен знать:

- номер GitHub Issue;
- детали UIA;
- GitHub wakeup protocol;
- SQLite schema;
- конкретный ChatGPT locator.

Этим владеет POSTMAN.

---

## 10. Что делать следующим

Следующий этап реализации — только M1–M3.

Нужно доказать внутренний транспорт Harness:

```text
1. создать/найти постоянную служебную session POSTMAN;
2. программно разбудить её из другой session;
3. передать реальный senderSessionId автоматически;
4. вернуть PONG исходной session;
5. повторить с двумя независимыми отправителями;
6. доказать отсутствие cross-delivery.
```

На этом этапе НЕ подключать:

- Web ChatGPT;
- GitHub Issues/wakeup;
- SQLite full queue;
- UIA;
- Computer Use;
- continuation;
- browser automation.

Ключевой gate следующего этапа:

```text
Agent A ─┐
         ├→ один POSTMAN → правильный sender
Agent B ─┘

POSTMAN → PONG A → Agent A
POSTMAN → PONG B → Agent B

0 manual session IDs
0 cross-delivery
```

После этого можно переходить к M4: durable `REQ → originSession` registry.
