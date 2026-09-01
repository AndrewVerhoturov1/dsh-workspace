# dsh-postman-harness

Плагин внутренней почты Harness для этапов M1–M5.

Плагин создаёт отдельного LLM-backed агента POSTMAN с постоянным идентификатором `postman-harness-session`. После внедрения службы `sessionPersistence` он сначала проверяет сохранённую запись через `inspect()`, восстанавливает существующую сессию через `ctx.agents.resume()`, а при точной ошибке «сессия не найдена» создаёт её через `ctx.agents.create()`. Другие ошибки persistence не переводятся в создание пустой сессии. Для сообщений используются только публичные API `ctx.agents.get()` и `Agent.followup()`. Внешние почтовые ящики, SQLite, HTTP, UI Automation и браузерная автоматизация не используются.

Для M1–M3 сохраняется ограниченная таблица `message_id` старого probe-протокола. Для M4–M5 добавлен `PostmanRuntime` на встроенном `node:sqlite`: `%LOCALAPPDATA%\DSH\Postman\postman.db` и `logs\postman.jsonl`. Новый `postman_async_send` атомарно создаёт `MSG_*` и `REQ_*`, получает владельца из `exec.agent.id`, сразу возвращает `POSTMAN_ACCEPTED`, а затем доставляет synthetic READY обратно через `Agent.followup()`.

WP-011 добавляет производственный переход `markReady` и узкий `WebWorkerBridge`. Он принимает только уже зарегистрированный `request_id` и URL задания, возвращает request-scoped `result_path` уже на этапе `ACCEPTED`, а в Runtime переводит запрос в `READY` только после проверенного результата `RESULT_DURABLE`. Браузерные шаги не дублируются: внешний runner должен вызывать существующие WP-003—WP-007 компоненты и передать мосту компактное доказательство результата.

WP-012 передаёт создание и публикацию intent-only task-файла через явно внедрённую capability `taskPublisher`. Она получает точный `user_intent`, публикует файл `{REQ}.md` и возвращает его HTTP(S)-URL. Без publisher запрос остаётся в `ACCEPTED`; ручная передача `task_url` больше не требуется (старый параметр сохранён только для совместимости).

Инструмент `postman_runtime_synthetic_ready` доступен только при `DSH_POSTMAN_ALLOW_SYNTHETIC_READY=1`; в обычном режиме он не регистрируется. Подробная схема и граница гарантии exactly-once описаны в [документации асинхронной маршрутизации](../../docs/postman-async-routing.md).
