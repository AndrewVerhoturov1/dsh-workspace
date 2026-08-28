# Исследование внутренней почты Harness для POSTMAN

## Статус

Исследование выполнено на установленном DSH `0.1.1-rc.2` и его публичных собранных пакетах. Цель — найти штатный способ для настоящего LLM-агента обращаться к другой постоянной Harness-сессии без внешнего транспорта.

## Идентичность сессии

Каноническая сущность — event-sourced `Session`. Стабильный идентификатор находится в `session.header.id` и доступен как `session.id`. Живой `Agent.id` обязан совпадать с `Agent.session.id`. `runId` относится только к одной активации подагента и не является адресом сессии. `threadId` и `conversationId` в маршрутизации DSH не обнаружены.

Постоянство после перезапуска обеспечивается `sessionPersistence` (в профиле используется JSONL/Zstandard backend). Без него сессия живёт только в памяти процесса. UI-чаты являются представлением сессии, а не её идентификатором.

Доказательства:

- `@deepseek-ai/dsh-session/lib/types/index.js`: `Session.id`, `Session.header`, append-only events.
- `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`: `Agent.id` — общая с `Agent.session` identity.
- `@deepseek-ai/dsh-agent-loop/lib/index.js`: `resume()` вызывает `sessionPersistence.prepare()`.

## Найденные штатные механизмы

### `Agent.followup(message)`

`agent.followup()` помещает пользовательское сообщение в FIFO `next-turn` inbox и будит живой Agent. Если Agent idle — начинается новый turn. Если Agent уже выполняет turn, сообщение ждёт в его inbox и не запускает конкурентный execution. Метод принимает полноценный `UserMessage`, включая `source`; это позволяет прикрепить runtime-метаданные отправителя.

Доказательство: `@deepseek-ai/dsh-agent-loop/lib/index.js:390-404,436-489`; `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:99-132`.

Ограничение: этот вызов требует уже полученный объект живого Agent. Сам по себе `followup()` не ищет холодную сессию по ID и не является произвольным публичным маршрутизатором.

### `ctx.subagents.followup(parent, childId, content, options)`

Это единственный штатный механизм продолжения постоянной неактивной сессии, найденный в DSH. Он поддерживает resident inbox, ожидание текущего хода и cold resume из persistence. Однако `childId` должен быть продолжимым дочерним агентом, а `parent` — точным живым прямым родителем. Проверяется durable lineage; чужой или не continuable ID отвергается.

Доказательства: `@deepseek-ai/dsh-subagent/lib/types/index.js:98-114`; `@deepseek-ai/dsh-subagent/lib/types/continuation.js:220-261,613-663,843-879`.

Модельный инструмент `send_message` является только адаптером этого вызова. Он принимает `subagent_id`, требует `exec.agent` и возвращает лишь `messageId`, а не ответ подагента. Он не адресует произвольную существующую сессию.

Доказательство: `@deepseek-ai/dsh-tool-subagent-control/lib/index.js:17-65`.

### `session.prompt`

Host API-прокси имеет `session.prompt` с произвольным `sessionId`. Он разрешает живой Agent, вызывает `agent.followup()`/`steer`, а для холодной обычной сессии использует host resolver и persistence. Это реальный программный Host API, но он не является автоматически доступным модельным инструментом текущего LLM-агента. Sender identity в нём задаётся внешним RPC-запросом, а не автоматически связывается с инициирующим агентом.

Доказательства: `@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.js:2077-2136`; `:2733-2782`; `@deepseek-ai/dsh-api-remotes/lib/types/agent-lookup.js:69-165`.

## Ответы на вопросы плана

1. **Стабильная identity:** `Session.header.id` / `Agent.id`.
2. **Сообщение другой существующей session:** напрямую из LLM-агента штатного общего метода нет. Для дочернего continuable — `ctx.subagents.followup`.
3. **Автоматический sender:** у `send_message` runtime передаёт `source.senderSessionId = parent.id`; для произвольной сессии такого общего механизма нет.
4. **Reply:** `followup` на известный разрешённый дочерний Agent возвращает только inbox `messageId`; универсального reply-to-caller API нет.
5. **Wake inactive:** continuable child можно cold-resume через `ctx.subagents.followup`; произвольную обычную сессию — только Host API resolver.
6. **BUSY:** принятие идёт через одну inbox; последующее сообщение ожидает/стоит в FIFO и не создаёт две ветви одной сессии. При уничтожении/закрытии admission отвергается.
7. **Очередь:** штатная очередь есть внутри `Agent.inbox` и continuation manager; отдельной общей очереди внутренних сообщений нет.
8. **Адрес по ID:** `sessionId` стабилен, но модельный `send_message` принимает только разрешённый `subagent_id`.
9. **Служебная POSTMAN-сессия:** declarative `agent-loop` может создать именованный Agent с явным `sessionId` и persistence. Отдельного встроенного продукта POSTMAN или сервиса общего доступа нет.

## Выбранный безопасный путь

Для M1–M3 добавляется малый пользовательский Cordis-плагин `dsh-postman-harness`, использующий только публичные Host/Agent API:

- после внедрения `sessionPersistence` сначала вызывает `ctx.agents.resume()` по стабильному `postman-harness-session`, а `ctx.agents.create()` использует только если persistence сообщает отсутствие записи;
- не использует гонкоопасный ранний `ctx.get('sessionPersistence')` из конфигурируемого `agent-loop`;
- регистрирует модельный `postman_send`, где `exec.agent.id` — доверенный sender;
- вызывает `postman.followup()` через обычный Agent inbox;
- хранит только ограниченную in-flight таблицу `message_id -> senderSessionId/payload` в памяти процесса, не будущую SQLite очередь;
- добавляет scoped `postman_reply`, доступный только POSTMAN;
- отправляет ответ через `sender.followup()` на адрес, выбранный runtime-таблицей, а не из текста probe;
- ограничивает инструменты POSTMAN, исключая внешние транспортные действия.

Это не shell IPC, не HTTP, не UI automation и не ручной поиск UI-чата. Смена выбранного UI-чата не должна влиять на живой Agent registry.

## Граница доказательства

До запуска реального DSH Web-процесса и повторного холодного запуска нельзя честно объявлять M1–M3 PASS. Требуются реальные LLM-сессии Agent A, Agent B и POSTMAN, восстановленный event prefix без `id collision`, проверка inactive POSTMAN, correlation и отсутствие cross-delivery. Если профиль не поддержит пользовательское расширение `agent-loop` или текущая версия не даёт безопасного runtime-доступа, итог должен быть `BLOCKED — NO SAFE HARNESS SESSION MESSAGING API`, а не синтетический PASS.

## Что отклонено

- ручной поиск чата по названию — имя UI не является identity;
- ручная передача `sessionId` — нарушает требование автоматического sender;
- `spawn`/`fork` — создают новые сессии, а fork лишь копирует снимок префикса;
- shell/HTTP/Named Pipe/файловый mailbox — внешний transport, не Harness internal mail;
- прямое редактирование `.jsonl.zstd` или Harness DB — unsupported и небезопасно;
- GitHub, Desktop, Web ChatGPT, QChat, UIA, Computer Use, continuation старых чатов — вне M1–M3.
