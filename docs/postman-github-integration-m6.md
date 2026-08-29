# Postman GitHub Integration M6

## Граница M6

M6 подключает уже существующий путь GitHub Issue → Actions → self-hosted runner к Postman Runtime. Обработчик `postman/github-wakeup.ps1` по-прежнему проверяет строгий протокол и атомарно сохраняет `signals/REQ_*.json`; после записи он вызывает `postman/ingest-github-signal.mjs`. Загрузчик использует единственный производственный API `PostmanRuntime.markExternalReady()`.

```text
Web ChatGPT
  → Issue status READY
  → GitHub Actions
  → github-wakeup.ps1
  → durable signal file
  → markExternalReady()
  → postman.db READY
  → watcher будит POSTMAN
  → Agent.followup(origin)
```

GitHub-слой не знает `origin_agent_id` и не вызывает `Agent.followup()`. Владелец берётся только из записи `requests` в базе.

## Отправка

После `postman_async_send` запись сначала получает `REQ_*` и состояние `ACCEPTED`. POSTMAN вызывает `postman_runtime_accept_request`, который создаёт отдельную Issue с заголовком `POSTMAN REQ_<id>` и телом:

```text
request_id: REQ_<id>
status: WAITING
protocol_version: 1
```

Номер Issue и репозиторий сохраняются в `requests`. Затем тот же существующий мост [chatgpt_chat.ps1](C:/Users/andre/.dsh/chatgpt-desktop-uia-bridge/chatgpt_chat.ps1) запускается в режиме `SubmitOnly`. Обычный режим и `SubmitOnly` используют общий `Ensure-FreshOrdinaryChat`: сначала подтверждаются поверхность ChatGPT и действие `Новый чат`, затем состояние проверяется по трём одинаковым семантическим UIA-снимкам. Runtime ID используется только как диагностическое поле. До успешного Fresh-proof нельзя очищать composer, вставлять текст или нажимать Send. После proof проверяются точный ввод, кнопка Send и подтверждение пользовательского сообщения. Результат ChatGPT не читается и не считается ответом; в `SubmitOnly` нет ожидания ответа ассистента и операции Copy. После этого REQ становится `WAITING`, а Postman освобождается.

## Внешний READY

`markExternalReady({ requestId, source, resultText, resultSha256, deliveryKey, externalDeliveryId, metadata })`:

- принимает только `source: github-web-chatgpt`;
- проверяет существующий `requestId` и не создаёт REQ по событию GitHub;
- проверяет SHA-256 полного текста результата;
- сохраняет `issueNumber`, `repository`, `bodySha256`, `externalDeliveryId`, `resultSha256`;
- меняет состояние на `READY` только после фиксации транзакции;
- подавляет повтор по `deliveryKey`/`externalDeliveryId`, а для повторного запуска с новым идентификатором — по неизменным `bodySha256` и `resultSha256`;
- не использует временные метки как идентификатор или полномочие.

Неизвестный REQ даёт `EXTERNAL_READY_UNKNOWN_REQUEST` и записывается в журнал без followup.

## Восстановление

Сигнал остаётся на диске после ingest. При ошибке базы или загрузчика обработчик завершает работу с `GITHUB_SIGNAL_INGEST_FAILED`, не удаляя файл. При старте плагин и затем периодический восстановитель перечитывают все `signals/REQ_*.json`; повторное чтение безопасно и не создаёт вторую доставку. Если READY был записан runner-ом при выключенном Harness, он будет обработан после следующего запуска.

## Состояния ошибок

Используются отдельные состояния `ISSUE_CREATE_FAILED`, `CHAT_SUBMIT_FAILED`, `EXTERNAL_READY_UNKNOWN_REQUEST`, `EXTERNAL_READY_INVALID`, `DELIVERY_RETRY`, `DELIVERY_BLOCKED_ORIGIN_MISSING`. Ошибка отправки оставляет запрос и метаданные Issue для диагностики/повторного действия и не маскируется общим `FAILED`.

## Безопасность

Текст Issue и ответ ChatGPT сохраняются как данные. Ни `github-wakeup.ps1`, ни загрузчик, ни Runtime не исполняют тело Issue, не используют `Invoke-Expression`/`eval` и не выбирают владельца из текста результата. Режим `SubmitOnly` не использует Computer Use; обычный мост сохраняет свои действующие диагностические ограничения.

## Ограничение M6

Состояние `DELIVERING` сохраняется перед `Agent.followup()`. Поскольку `Agent.followup()` возвращает `void`, окно сбоя между постановкой сообщения и фиксацией `DELIVERED` не даёт строгого exactly-once для Harness wakeup; повторная попытка всё равно подавляется состоянием Runtime. Продолжение старых ChatGPT чатов и многопоточный планировщик в M6 не реализуются.
