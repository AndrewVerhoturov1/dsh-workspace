# Тесты Harness POSTMAN M1–M3

## Область

Тестируется только внутренняя почта между настоящими Harness-агентами. ChatGPT Desktop/Web, QChat, GitHub wakeup, SQLite-очередь, UIA, Computer Use, браузерная автоматизация и продолжение старых чатов не входят в эти проверки.

## Подготовка

1. В `profiles/web/package.json` подключён `dsh-postman-harness` как локальный bundle.
2. Bundle оставляет `agent-loop` без конфигурируемых агентов; плагин сначала проверяет запись через `sessionPersistence.inspect()`, затем запускает POSTMAN через публичные `ctx.agents.resume()`/`ctx.agents.create()`.
3. POSTMAN получает фиксированный `sessionId: postman-harness-session`, а сессии сохраняются штатным `session-persistence-jsonl`.
4. Для реального запуска требуется доступный маршрут `codex` и действующая OAuth-авторизация.

## Детерминированные проверки плагина

Проверяются без сети и внешнего транспорта:

- синтаксис и импорт плагина;
- наличие `postman_send` и scoped `postman_reply`;
- обязательные `message_id`/`payload`, границы размера и формат `MSG_...`;
- запрет self-send и отправки без живого POSTMAN;
- sender берётся из `exec.agent.id`, а не из текста probe;
- duplicate correlation id отклоняется;
- `allow: []` скрывает у POSTMAN унаследованные глобальные инструменты;
- `postman_reply` доступен только агенту с точным POSTMAN ID, принимает только `PONG`;
- reply адресуется по закрытой runtime-таблице;
- FIFO достигается нативным `Agent.followup`;
- TTL/лимит и очистка при `agent/disposed` не оставляют вечную запись.

Текущий набор детерминированных тестов содержит 15 проверок; отдельно проверяются заполненная pending-таблица, scoped `allow: []`, очистка корреляции после уничтожения отправителя и отказ без создания сессии при ошибке persistence.

## M1

Проверить после перезапуска Web:

- `session.list` содержит непустую сессию `postman-harness-session`;
- `session.history` показывает восстановленные LLM-backed POSTMAN events, продолженные после холодного запуска;
- POSTMAN не выбран в UI, но существует в live agent registry;
- после нового процесса тот же `sessionId` восстанавливается штатным persistence.

## M2

Создать отдельный Harness Agent A и через модельный `postman_send` отправить:

```text
message_id: MSG_A_001
payload: ALPHA
```

Ожидается: POSTMAN получает `POSTMAN_PROBE`, вызывает `postman_reply(message_id=MSG_A_001, reply=PONG)`, Agent A получает `POSTMAN_PROBE_RESULT` с `ALPHA`. Второй prompt Agent A должен продолжить после асинхронной доставки.

## M3

Два независимых агента отправляют почти одновременно:

```text
A: MSG_COLD_A_002 / ALPHA
B: MSG_COLD_B_002 / BRAVO
```

Ожидается одна очередь POSTMAN, два разных correlation id, `PONG` и исходный payload возвращаются ровно владельцам. В истории A не должно быть `BRAVO`, в истории B не должно быть `ALPHA`.

## Security / inactive / busy

- В payload добавить `from_session: B` при отправке A — маршрутизация должна остаться у A.
- Послать несколько сообщений при `POSTMAN.status === running` — они должны ждать в FIFO, без второго конкурентного драйвера.
- Вызвать send при отсутствии live POSTMAN — получить явную ошибку, без внешнего обходного пути.
- Уничтожить sender до ответа — ответ отклоняется и correlation удаляется.
- После TTL повторно использовать старый `message_id` — он не должен оставаться заблокированным.

## Критерий PASS

`POSTMAN INTERNAL MAIL M1-M3 READY` разрешён только при наличии журналов реальных LLM Harness-сессий A, B и POSTMAN, повторного cold restart без `id collision` и всех перечисленных проверок. Одного `session.prompt` из Host API или заглушек недостаточно.
