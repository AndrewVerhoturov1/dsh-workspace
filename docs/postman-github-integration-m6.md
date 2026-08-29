# Postman GitHub Integration M6

## Необязательная защита после отправки (30 августа 2026)

После подтверждённой стадии `CHAT_SUBMIT_CONFIRMED` запускается отдельный
ограниченный post-submit guard. Он не входит в Fresh/SubmitOnly и не задерживает
`POSTMAN_ACCEPTED` или завершение хода агента; guard связан с конкретными `requestId`
и Issue и наблюдает только подтверждённое окно ChatGPT.

Поддержанный блокирующий диалог `WORK_MODE_PROMPT` подтверждается одновременным
наличием заголовка `Продолжить в режиме Work?`, кнопки `Продолжить чат здесь` и
кнопки `Продолжить в режиме Work` в одном subtree host. Имена нормализуются только
по пробелам, управляющим и private-use glyph; нечёткое сопоставление запрещено.
Разрешён единственный вызов: `InvokePattern` на `Продолжить чат здесь`. Кнопка Work
никогда не вызывается. После действия требуются два чтения без диалога. Неизвестный
диалог, отсутствие правильной кнопки или более трёх повторов дают fail-closed
`POST_SUBMIT_GUARD_BLOCKED`.

События guard: `POST_SUBMIT_GUARD_STARTED`, `WORK_PROMPT_DETECTED`,
`WORK_PROMPT_CONTINUE_HERE_INVOKED`, `WORK_PROMPT_DISMISS_CONFIRMED`,
`WORK_PROMPT_LOOP`, `UNKNOWN_POST_SUBMIT_MODAL`, `POST_SUBMIT_GUARD_FINISHED`.
В диагностике сохраняются PID/HWND host, foreground PID/HWND, `windowRect`,
`workAreaRect`, имена элементов и доступность `InvokePattern`. Координаты, Enter,
Space и Computer Use в производственном пути не применяются.

## Текущее доказательство и blocker

Контракт guard проверен синтетически: 9/9. На реальном host PID `34728`, HWND
`0x280788` standalone UIA-проба обнаружила заголовок и обе кнопки, вызвала только
`Продолжить чат здесь` через `InvokePattern` и подтвердила исчезновение диалога
двумя чтениями. Это доказательство механизма, но не заменяет полный M6 Case B.

Интегрированная попытка `MSG_M6_001` → `REQ_67A8658CF323453FA91324B5EF1422DF`
→ Issue №44 достигла `POST_SUBMIT_GUARD_STARTED`; Issue остаётся `WAITING`, а
`WORK_PROMPT_DETECTED` и `ISSUE_READY_SEEN` не получены. Поэтому полный single-agent
M6, A+B, duplicate и offline/recovery после этого изменения не засчитаны и PR не
сливается.

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

## Ремонт Desktop bridge

Предыдущая диагностика «ChatGPT Desktop process absent» была неверной. Unified-приложение действительно работало: `ChatGPT (Beta).exe`, PID `34728`, путь `C:\Program Files\WindowsApps\OpenAI.CodexBeta_26.727.4816.0_x64__2p2nqsd0c76g0\app\ChatGPT (Beta).exe`. У него были два верхнеуровневых UIA-элемента: видимая поверхность `Codex` (`Chrome_WidgetWin_1`, HWND `0xA5202E`) и окно-хозяин `ChatGPT (Beta)` (`Chrome_WidgetWin_1`, HWND `0x280788`); заголовок окна процесса в состоянии Codex был `Codex`.

Причина ошибки была в смешении обнаружения host и поверхности: мини-поверхность Codex принималась за единственную точку управления, а клавиатурное действие направлялось не в окно-хозяин. Теперь host определяется отдельно по процессу, исполняемому файлу, PID и верхнеуровневому HWND; поверхность отдельно классифицируется как `CODEX` или `ORDINARY_CHAT`. Переход выполняется через UIA `ExpandCollapsePattern` и точный `MenuItem.InvokePattern`, затем независимо подтверждается обычная ChatGPT-поверхность по переключателю режима, структуре composer, отсутствию активного Codex-корня и глобальному `Новый чат`. При отсутствии proof возвращается `ORDINARY_CHAT_SURFACE_NOT_CONFIRMED`; Fresh и отправка не запускаются.

Обычный путь и `SubmitOnly` используют один `Ensure-FreshOrdinaryChat`. Fresh подтверждается действием `Новый чат` и тремя одинаковыми семантическими UIA-снимками; Runtime ID только диагностический. До этого proof composer не очищается и не изменяется. Производственный путь использует UIA/native API, без Computer Use, координат и скриншотов.

## Фактическая проверка 29 августа 2026 года

Пять обязательных живых проб SubmitOnly завершились успешно: `M6_SUBMITONLY_PROBE_009`–`013`. Отдельная проба `014` завершилась с `FRESH_SURFACE_UNSTABLE` до Send; отправка не выполнялась. После этого исправлено подтверждение глубокого UIA-якоря нового сообщения: опциональный путь использует `.ToArray()`, а обычный предел видимой области для остальных проверок сохранён.

Полный M6 после исправления пока не доказан. Последний настоящий запрос `MSG_M6_SINGLE_R15` создал `REQ_F6687A0BC867459CB9B53D3827DD0874` и Issue №37, но остановился на `CHAT_SUBMIT_STARTED`: unified host был найден, однако Windows не дал активировать окно `0x280788`, потому что передним было окно Unity `Back To The Dawn` (PID `29032`, HWND `0x292330`). `SetForegroundWindow` и `AttachThreadInput` вернули отказ; `sendAttempted=false`. Ожидаемая следующая стадия — `CHAT_SUBMIT_CONFIRMED`. Эмуляция клавиш, координатный ввод и Computer Use не применялись.

Issue №37 и прежние попытки R11–R14 не являются доказательством полного M6; synthetic READY не создавался.

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
