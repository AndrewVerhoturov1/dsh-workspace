# Архитектура агента «Почтальон» для работы с ChatGPT Desktop

## Статус документа

Идея для следующего этапа развития QChat после стабилизации текущего Fresh QChat bridge.

Этот документ описывает целевую архитектуру, в которой обычные рабочие агенты **не управляют ChatGPT Desktop напрямую**. Единственным владельцем интерфейса ChatGPT становится отдельный специализированный агент — условно **Почтальон**.

Главная цель: безопасно обслуживать несколько агентов параллельно, не допуская путаницы между окнами, чатами, запросами и ответами.

---

## 1. Проблема

Текущий QChat bridge позволяет одному агенту:

1. открыть ChatGPT Desktop;
2. создать новый чат;
3. отправить prompt;
4. дождаться ответа;
5. скопировать проверенный ответ через штатную кнопку Copy.

Для одного вызывающего агента это удобно.

Но если несколько агентов одновременно начнут управлять одним и тем же ChatGPT Desktop, появляются гонки:

```text
Agent 1 → New Chat
Agent 2 → New Chat
Agent 3 → открыть старый chat
Agent 1 → Send
Agent 2 → Copy
```

Даже если каждый отдельный bridge хорошо защищён, общая система становится сложной:

- один агент может переключить чат во время работы другого;
- один агент может открыть новую беседу между действиями другого;
- ответы могут относиться не к тому запросу;
- параллельные retry начинают конкурировать;
- Computer Use нескольких агентов может физически мешать друг другу;
- трудно восстановить состояние после падения одного из процессов.

Поэтому ChatGPT Desktop следует рассматривать как **один физический ресурс с одним владельцем**.

---

## 2. Основная идея

Вводится отдельный агент:

```text
Postman / Почтальон
```

Он является единственным агентом, которому разрешено управлять ChatGPT Desktop.

Остальные агенты не открывают ChatGPT, не нажимают New Chat, не используют Copy и не применяют Computer Use к ChatGPT Desktop.

Они только создают заявки Почтальону.

Схема:

```text
Agent 1 ─┐
Agent 2 ─┼──→ Mailbox / Queue ───→ Postman ───→ ChatGPT Desktop
Agent 3 ─┘                              │
                                       ↓
                                Conversation Registry
                                       │
                                       ↓
                                  Result Mailbox
```

Главный инвариант:

> **Only Postman may control ChatGPT Desktop.**

---

## 3. Почему это лучше прямого доступа всех агентов

### 3.1. Один владелец UI

Не требуется решать сложную координацию десятков агентов на уровне UIA.

Почтальон последовательно выполняет физические действия:

```text
open chat
send
switch chat
check
copy
```

### 3.2. Много логических задач одновременно

Хотя UI worker один, ChatGPT может одновременно обрабатывать несколько разных conversation.

Пример:

```text
CHAT_A → generation in progress
CHAT_B → generation in progress
CHAT_C → generation in progress
```

Почтальон не обязан ждать CHAT_A до конца.

Он может:

```text
send A
send B
send C
check A
check B
check C
```

Таким образом система получает:

> **один последовательный UI worker + несколько inflight ChatGPT conversations**.

### 3.3. Централизованное восстановление

Если процесс Почтальона падает, после рестарта он читает таблицу и видит состояние каждой заявки.

Например:

```text
REQ_001 = WAITING_RESPONSE
REQ_002 = QUEUED
REQ_003 = DELIVERED
```

Это позволяет не отправлять уже отправленный prompt повторно.

---

## 4. Две разные сущности: Conversation и Request

Очень важно не смешивать чат и отдельный запрос.

### Conversation

Conversation — постоянная беседа ChatGPT.

Пример внутреннего ключа:

```text
CHAT_914E20
```

В одной conversation может быть много запросов.

### Request

Request — одно конкретное сообщение от агента Почтальону.

Пример:

```text
REQ_82A14F
```

Один chat может содержать:

```text
CHAT_914E20
├─ REQ_001 → первый вопрос
├─ REQ_002 → уточнение
└─ REQ_003 → следующий вопрос
```

Это разделение должно быть базовым для всей системы.

---

## 5. Уникальные идентификаторы

У каждой заявки должен быть собственный уникальный `requestId`.

Например:

```text
REQ_20260827_82A14F
```

У каждой conversation — собственный `conversationKey`:

```text
CHAT_20260827_914E20
```

Эти значения используются во внутреннем реестре.

Дополнительно `conversationKey` желательно писать в сам ChatGPT chat как служебный маркер, например в первом prompt:

```text
[MAILBOX CHAT_20260827_914E20]

<основной prompt>
```

Этот marker нужен как резервный способ идентификации разговора.

Но поиск по текстовому marker не должен быть основным механизмом открытия chat, если уже доступны более надёжные идентификаторы.

---

## 6. Идентификация ChatGPT conversation

Предпочтительный порядок сохранения и повторного открытия существующего chat:

1. `conversationId`, если bridge может его надёжно получить;
2. deeplink;
3. conversation path/session identifier;
4. внутренний сохранённый UI/route identifier;
5. поиск ChatGPT по уникальному `conversationKey` как аварийный fallback.

То есть:

```text
conversationId/deeplink
        ↓
preferred
        ↓
search by CHAT_xxx
        ↓
last resort
```

Причина: встроенный поиск ChatGPT может индексироваться с задержкой и менять поведение.

---

## 7. Минимальный интерфейс для рабочих агентов

На первом этапе другим агентам достаточно четырёх операций.

### Создать новую conversation

```text
submit_new(prompt)
```

Пример логического запроса:

```json
{
  "requestId": "REQ_82A14F",
  "requester": "agent-1",
  "operation": "new",
  "prompt": "Проверь архитектуру и найди слабые места."
}
```

### Продолжить существующую conversation

```text
submit_continue(conversationKey, prompt)
```

Пример:

```json
{
  "requestId": "REQ_B7D310",
  "requester": "agent-1",
  "operation": "continue",
  "conversationKey": "CHAT_914E20",
  "prompt": "Теперь сравни варианты A и B."
}
```

### Проверить статус

```text
status(requestId)
```

### Получить результат

```text
result(requestId)
```

Позже можно добавить:

```text
cancel(requestId)
retry(requestId)
list_conversations(agent)
archive(conversationKey)
```

---

## 8. Реестр и очередь

Логически Почтальон работает по таблице.

Пример:

| Request | Agent | Conversation | Operation | Status |
|---|---|---|---|---|
| `REQ_A1` | Agent1 | `CHAT_X1` | NEW | WAITING_RESPONSE |
| `REQ_A2` | Agent2 | `CHAT_X2` | NEW | QUEUED |
| `REQ_A3` | Agent1 | `CHAT_X1` | CONTINUE | QUEUED |

Для первого PoC допустим JSON/JSONL.

Для постоянной реализации предпочтительнее **SQLite**, потому что она даёт:

- атомарные изменения;
- транзакции;
- простой поиск;
- безопасное восстановление;
- блокировки;
- нормальную работу с несколькими producer-агентами;
- возможность в будущем иметь больше одного процесса чтения статусов.

---

## 9. Предлагаемая модель данных

### Таблица `conversations`

Примерные поля:

```text
conversation_key
chatgpt_conversation_id
chatgpt_deeplink
chatgpt_path
created_at
last_used_at
created_by_agent
status
marker
metadata_json
```

### Таблица `requests`

```text
request_id
requester_agent
conversation_key
operation
prompt_path / prompt_text
status
priority
created_at
queued_at
sent_at
next_check_at
completed_at
attempt_count
error_code
error_message
response_path
response_hash
response_length
metadata_json
```

### Таблица `events` — желательно позже

Для аудита полезно иметь append-only журнал:

```text
event_id
request_id
conversation_key
timestamp
event_type
details_json
```

Примеры событий:

```text
REQUEST_CREATED
CHAT_OPENED
PROMPT_CONFIRMED
PROMPT_SENT
WAIT_STARTED
RESPONSE_READY
COPY_CONFIRMED
RESULT_DELIVERED
RETRY_SCHEDULED
ERROR
```

---

## 10. Машина состояний заявки

Базовая последовательность:

```text
QUEUED
   ↓
OPENING_CHAT
   ↓
SUBMITTING
   ↓
WAITING_RESPONSE
   ↓
RESPONSE_READY
   ↓
DELIVERING
   ↓
DELIVERED
```

Ошибочные состояния:

```text
RETRY_WAIT
NEEDS_DIAGNOSTIC
FAILED
```

Критически важно сохранять состояние **после каждого подтверждённого перехода**.

Например:

```text
PROMPT_SENT
→ записать WAITING_RESPONSE в БД
→ только после этого переключаться на другую задачу
```

Если процесс упадёт, он не должен забыть, что prompt уже отправлен.

---

## 11. Принцип восстановления после падения

После старта Почтальон не начинает работу с чистого листа.

Он читает БД и классифицирует незавершённые запросы.

### `QUEUED`

Prompt ещё не отправлен.

Можно безопасно отправлять.

### `SUBMITTING`

Неизвестное состояние.

Нельзя автоматически отправлять prompt повторно.

Нужна проверка фактической conversation и submit marker.

### `WAITING_RESPONSE`

Prompt уже отправлен.

Нужно только открыть chat и проверить состояние ответа.

### `RESPONSE_READY`

Ответ обнаружен, но ещё не доставлен.

Нужно повторно выполнить проверенный Copy и сохранить результат.

### `DELIVERING`

Нужно проверить, был ли result уже сохранён/отправлен агенту, чтобы не создавать логические дубликаты.

---

## 12. Планировщик Почтальона

Очередь не обязана быть строго FIFO.

Почтальон может самостоятельно выбирать следующее наиболее полезное действие.

Пример порядка приоритетов:

1. забрать уже готовый ответ;
2. отправить новый высокоприоритетный запрос;
3. проверить давно ожидающий ответ;
4. выполнить разрешённый retry;
5. обслужить обычную очередь;
6. выполнить низкоприоритетное обслуживание/архивацию.

Полезные поля:

```text
priority
created_at
next_check_at
attempt_count
```

Пример:

```text
REQ_A → WAITING_RESPONSE → nextCheckAt=20:05:10
REQ_B → QUEUED          → priority=high
REQ_C → WAITING_RESPONSE → nextCheckAt=20:05:30
```

Почтальон сам выбирает следующее действие.

---

## 13. Проверка ожидающих ответов

Не нужно постоянно открывать каждый chat раз в секунду.

Предлагается adaptive polling.

Например:

```text
после отправки:
первый check через 10–15 секунд

если генерация идёт:
следующий check через 10–15 секунд

если ответ длинный:
следующий check через 20–30 секунд
```

Если в будущем удастся надёжно читать системные уведомления ChatGPT, их можно использовать как ускоритель.

Но:

> notification = hint, registry + verified chat inspection = source of truth.

Уведомление не должно само по себе означать, что response готов и относится к нужному request.

---

## 14. Параллельная генерация

Нужно отдельно проверить важное предположение:

> продолжает ли ChatGPT генерировать ответ в conversation A, когда UI переключён на conversation B.

Если да, Почтальон сможет эффективно держать несколько inflight chat:

```text
send A
switch
send B
switch
send C
switch
check A
```

Физически UI действия последовательные, но reasoning ChatGPT работает параллельно на серверной стороне.

Это один из ключевых экспериментов для следующей фазы.

---

## 15. Связь с текущим QChat bridge

Текущий bridge остаётся низкоуровневым transport.

Почтальон не должен заново реализовывать:

- exact composer confirmation;
- submit gate;
- user-message confirmation;
- stale assistant protection;
- assistant→Copy pairing;
- clipboard sentinel;
- Copy extraction.

Почтальон должен использовать готовый bridge для атомарных операций.

Условно в будущем нужны операции уровня:

```text
CreateFreshConversation
OpenConversation
SubmitPrompt
CheckGeneration
CopyLatestVerifiedResponse
GetConversationMetadata
```

Но каждое действие всё равно должно иметь строгие подтверждения.

---

## 16. Fresh и Continue — два разных сценария

### NEW

```text
request.operation = new
↓
создать новый chat
↓
получить conversationKey
↓
сохранить ChatGPT identifiers
↓
отправить prompt
```

### CONTINUE

```text
request.operation = continue
↓
найти conversationKey в registry
↓
открыть сохранённый ChatGPT chat
↓
подтвердить identity
↓
отправить prompt
```

При Continue нельзя просто использовать «текущий открытый chat».

Identity должна быть подтверждена.

---

## 17. Поиск существующего chat

Если direct deeplink/conversation ID работает, использовать его.

Если нет — Почтальон может применять поиск ChatGPT.

Fallback flow:

```text
conversationKey = CHAT_914E20
↓
ChatGPT Search
↓
найти unique marker
↓
открыть результат
↓
подтвердить наличие marker CHAT_914E20
↓
только затем отправлять новый prompt
```

Если найдено несколько кандидатов:

```text
CONVERSATION_AMBIGUOUS
```

Нельзя выбирать случайный результат.

---

## 18. Доставка результата вызывающему агенту

Большой ответ лучше не передавать только через transient message bus.

Почтальон может сохранять результат на диск:

```text
mailbox/responses/REQ_82A14F.md
```

В БД:

```text
response_path
response_hash
response_length
completed_at
```

Вызывающему агенту возвращается компактный объект:

```json
{
  "requestId": "REQ_82A14F",
  "status": "DELIVERED",
  "conversationKey": "CHAT_914E20",
  "responsePath": "...",
  "responseHash": "..."
}
```

Для коротких результатов можно также передавать `response` inline.

---

## 19. Идемпотентность

Каждый `requestId` должен быть уникальным и идемпотентным.

Если Agent1 случайно дважды отправил один и тот же `requestId`, Почтальон не создаёт второй ChatGPT prompt.

Он возвращает уже существующую запись.

То есть:

```text
same requestId
→ same logical request
```

Это критично при сетевых timeout и повторных вызовах агентов.

---

## 20. Блокировка conversation

Одна conversation не должна одновременно получать два новых user prompt.

Например:

```text
REQ_A → CHAT_1 → WAITING_RESPONSE
REQ_B → CHAT_1 → QUEUED
```

Пока ответ на `REQ_A` не завершён, `REQ_B` для того же `CHAT_1` остаётся в очереди.

Но запрос к другому chat может быть отправлен:

```text
REQ_C → CHAT_2 → можно выполнять
```

Таким образом блокировка нужна **на уровне conversation**, а не глобально на всю систему.

---

## 21. Computer Use

В этой архитектуре Computer Use становится ещё более строго ограниченным.

### Рабочие агенты

```text
Agent1 / Agent2 / Agent3
→ НЕ используют Computer Use для ChatGPT Desktop.
```

### Почтальон

```text
bridge/UIA first
↓
strict failure
↓
Computer Use diagnostic only
```

Computer Use не используется для:

- обычной отправки prompt;
- обычного открытия chat;
- копирования response;
- обхода submit gate;
- ручного чтения ответа вместо verified Copy.

Если bridge failed, визуально увиденный текст не превращает request в `DELIVERED`.

---

## 22. Граница ответственности

### Рабочий агент отвечает за

- сформировать хороший prompt;
- выбрать `new` или `continue`;
- указать `conversationKey` для continue;
- задать priority при необходимости;
- обработать полученный reasoning result.

### Почтальон отвечает за

- очередь;
- ChatGPT Desktop;
- conversation registry;
- отправку;
- ожидание;
- проверку ответа;
- Copy;
- retry policy;
- диагностику;
- сохранение результата;
- доставку результата.

### QChat bridge отвечает за

- конкретные UIA invariants;
- exact input;
- exact submit confirmation;
- pairing;
- verified Copy transaction.

---

## 23. Что не должен делать Почтальон

Почтальон не должен быть универсальным reasoning-agent.

Он не решает задачу пользователя сам.

Он не переписывает prompt по собственному усмотрению, кроме заранее разрешённого служебного envelope.

Он не интерпретирует ChatGPT response как истину.

Он выполняет функцию:

> маршрутизация + диспетчеризация + доставка.

Именно поэтому роль похожа на почтовое отделение/завхоза.

---

## 24. Возможный служебный envelope prompt

Для нового chat можно использовать минимальную маркировку:

```text
[DSH POSTMAN]
Conversation: CHAT_914E20
Request: REQ_82A14F

<реальный prompt агента>
```

Плюсы:

- можно визуально проверить принадлежность;
- можно найти conversation по marker;
- проще диагностировать ошибку.

Минусы:

- служебный текст становится частью контекста ChatGPT;
- он немного расходует токены.

Поэтому envelope должен быть коротким.

Для continue-запросов достаточно нового `Request:` marker, если это не мешает reasoning.

---

## 25. Приоритеты

Минимальная шкала:

```text
urgent
high
normal
low
```

Но scheduler не обязан буквально сортировать только по priority.

Например готовый ответ разумно забрать раньше, чем создавать новый low-priority chat.

Можно использовать score:

```text
score = priority + age + ready_bonus + retry_penalty
```

Точную формулу определять после измерений.

---

## 26. Retry policy

Retry нужно разделить по этапам.

### До Send

Если prompt точно не отправлен:

```text
safe retry allowed
```

Например transient composer failure.

### После Send

Если неизвестно, был ли prompt отправлен:

```text
NO blind retry
```

Сначала открыть conversation и доказать фактическое состояние.

### WAITING_RESPONSE

Timeout проверки ответа не означает, что prompt надо отправлять снова.

Нужно просто перенести `next_check_at`.

---

## 27. Ошибки

Предлагаемые высокоуровневые коды:

```text
CHAT_OPEN_FAILED
CONVERSATION_NOT_FOUND
CONVERSATION_AMBIGUOUS
CONVERSATION_IDENTITY_NOT_CONFIRMED
SUBMIT_NOT_CONFIRMED
RESPONSE_NOT_READY
RESPONSE_COPY_FAILED
DELIVERY_FAILED
DESKTOP_UNAVAILABLE
NEEDS_DIAGNOSTIC
```

Низкоуровневый код bridge должен сохраняться отдельно:

```text
bridge_error_code
```

---

## 28. Наблюдаемость

Почтальон должен иметь простой status dashboard или CLI.

Например:

```text
Postman
-----------------------------------------------
QUEUED            3
WAITING_RESPONSE  5
RESPONSE_READY    1
RETRY_WAIT        1
FAILED            0
-----------------------------------------------
```

И таблицу:

```text
REQ        AGENT   CHAT       STATUS             AGE
REQ_A01    A1      CHAT_11    WAITING_RESPONSE   24s
REQ_A02    A2      CHAT_12    QUEUED             8s
REQ_A03    A1      CHAT_11    QUEUED             3s
```

Это пригодится и человеку, и диагностическому агенту.

---

## 29. Один процесс или отдельный агент Codex

Первая реализация может быть отдельным долговременным агентом/процессом внутри DSH, который:

1. читает очередь;
2. выбирает следующую операцию;
3. вызывает bridge;
4. обновляет registry;
5. ждёт/планирует следующие проверки.

Важно не название процесса, а invariant единственного владельца ChatGPT Desktop.

Даже если в будущем Почтальон будет реализован как Codex/Luna agent, физический UI lease должен принадлежать только ему.

---

## 30. UI lease

Дополнительно к логической роли полезно иметь системную блокировку:

```text
Global\DSH_ChatGPT_Postman_UI
```

Только Почтальон держит этот lease во время управления Desktop.

Если другой инструмент случайно пытается запустить bridge напрямую, bridge может отказать:

```text
POSTMAN_OWNS_DESKTOP
```

В первой версии это необязательно, но в целевой архитектуре полезно.

---

## 31. Жизненный цикл нового запроса

Пример полного NEW flow:

```text
Agent1
  ↓
create REQ_82A14F
  ↓
Mailbox
  ↓
Postman inserts QUEUED
  ↓
Scheduler selects request
  ↓
Create Fresh Chat
  ↓
assign CHAT_914E20
  ↓
save conversation metadata
  ↓
submit prompt
  ↓
verified submit
  ↓
status = WAITING_RESPONSE
  ↓
next_check_at = +15s
  ↓
Postman handles another request
  ↓
check CHAT_914E20
  ↓
response complete
  ↓
verified Copy
  ↓
save REQ_82A14F.md
  ↓
status = DELIVERED
  ↓
Agent1 receives result
```

---

## 32. Жизненный цикл CONTINUE

```text
Agent1
  ↓
REQ_B7D310
operation=continue
conversation=CHAT_914E20
  ↓
Postman registry lookup
  ↓
conversation currently free?
  ├─ no → stay QUEUED
  └─ yes
       ↓
open via deeplink/id/search
       ↓
confirm CHAT_914E20 identity
       ↓
submit prompt
       ↓
WAITING_RESPONSE
       ↓
check later
       ↓
verified Copy
       ↓
DELIVERED
```

---

## 33. Важный эксперимент: несколько inflight chats

До реализации полноценного scheduler нужно провести отдельный тест.

### Сценарий

1. создать Chat A и отправить длинный prompt;
2. не ждать окончания;
3. создать Chat B и отправить длинный prompt;
4. создать Chat C;
5. через некоторое время открыть A;
6. проверить, продолжалась ли генерация в фоне;
7. аналогично B и C.

### Если PASS

Можно строить настоящий concurrent mailbox.

### Если FAIL

Почтальон всё равно полезен, но scheduler будет более последовательным.

---

## 34. Первый этап реализации

Не нужно сразу строить всю систему.

### Phase 1 — Registry PoC

- один Postman process;
- SQLite;
- `submit_new`;
- `status`;
- `result`;
- только Fresh conversations;
- не более нескольких inflight chat;
- текущий QChat bridge.

### Phase 2 — Continue

- conversation registry;
- deeplink/conversationId;
- `submit_continue`;
- per-conversation locking;
- search fallback.

### Phase 3 — Scheduler

- priorities;
- adaptive polling;
- retry schedule;
- recovery after restart.

### Phase 4 — Production hardening

- UI lease;
- dashboard;
- event journal;
- cleanup/archive;
- metrics;
- notification hints.

---

## 35. Метрики

Полезно собирать:

```text
requests_total
requests_success
requests_failed
queue_wait_ms
submit_duration_ms
response_wait_ms
copy_duration_ms
conversation_open_ms
computer_use_diagnostics
retries
inflight_conversations
```

Ключевая метрика:

```text
Computer Use on successful normal requests = 0
```

---

## 36. Безопасность и строгие инварианты

1. Только Почтальон управляет ChatGPT Desktop.
2. Один `requestId` не может быть отправлен дважды.
3. Одна conversation получает только один активный prompt одновременно.
4. После неизвестного Send нельзя делать blind retry.
5. Visual response не является verified response.
6. Response принимается только через проверенный Copy path.
7. Continue выполняется только после подтверждения identity chat.
8. Ambiguity всегда ведёт к ошибке, а не к угадыванию.
9. Computer Use — диагностика, не transport.
10. После падения состояние восстанавливается из registry, а не из предположений агента.

---

## 37. Что даёт эта архитектура в итоге

ChatGPT Desktop перестаёт быть GUI, которым напрямую управляют разные агенты.

Для остальной системы он начинает выглядеть как асинхронный reasoning backend:

```text
submit request
→ get requestId
→ work continues
→ poll/wait
→ receive verified result
```

При этом настоящий transport по-прежнему остаётся обычным ChatGPT Desktop и UI Automation.

Архитектура скрывает эту физическую сложность за одним специализированным диспетчером.

---

## 38. Целевая схема

```text
                 ┌──────── Agent 1
                 │
                 ├──────── Agent 2
                 │
                 ├──────── Agent 3
                 │
                 ▼
          ┌───────────────┐
          │ Mailbox / API │
          └───────┬───────┘
                  │
                  ▼
          ┌───────────────┐
          │    SQLite     │
          │ Queue/Registry│
          └───────┬───────┘
                  │
                  ▼
          ┌───────────────┐
          │    Postman    │
          │---------------│
          │ Scheduler     │
          │ Recovery      │
          │ Conversation  │
          │ Registry      │
          │ Delivery      │
          └───────┬───────┘
                  │
                  ▼
            QChat/UIA bridge
                  │
                  ▼
          ChatGPT Desktop Beta
             │       │       │
             ▼       ▼       ▼
          CHAT_A   CHAT_B   CHAT_C
```

---

## 39. Итоговая формулировка идеи

Почтальон — это **единственный диспетчер ChatGPT Desktop**, который принимает задания от других агентов, ведёт реестр conversations и requests, последовательно управляет физическим UI, допускает несколько логически параллельных ChatGPT conversations, отслеживает состояние каждого запроса и доставляет проверенные ответы обратно инициатору.

Основной смысл архитектуры:

> **не синхронизировать десятки агентов вокруг одного GUI, а дать GUI одного владельца и превратить его в асинхронную общую службу.**

Текущий Fresh QChat bridge является базовым transport-слоем для будущего Почтальона, но сам Почтальон должен быть отдельным уровнем оркестрации, очереди, состояния и маршрутизации.
