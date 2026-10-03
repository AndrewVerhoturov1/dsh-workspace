# Расследование и исправление Send Postman — 2026-10-03

## Результат и границы

Доказаны две разные причины: общий сохраняемый черновик нового чата и слишком короткий timeout reminder-click. Исправлены короткая критическая фаза отправки, очистка доказанно собственного неотправленного текста/вложения и reminder timeout. Последний живой запуск трёх Image завершился **3/3 IMAGE_RESULT_DURABLE** одновременно с обычным Postman/reminder и независимым обычным чатом.

Это не утверждение, что исходный attachment-сбой был гонкой: его точное исключение старый код потерял. Исторические неизвестные ниже явно оставлены неизвестными. Код проверялся из отдельного task worktree; действующая установка не заменялась. PR не означает merge или развёртывание.

## Источники и воспроизводимость

- Исходная Leader session: `session-118a825a-84b2-4c25-9bf2-ead09115de99`; три child sessions: `5e78cfce-6d3c-42cc-8815-54616da79cf3`, `f8965317-0216-452c-bd3d-cd3c0970c3be`, `43ff8c4a-e32d-4d2f-840d-c987855710f7`. Новых субагентов не запускали.
- Исторические terminal/state и живые JSONL сохранены локально в `%LOCALAPPDATA%/DSH/Postman/send-investigation-20261003`; в Git не включены browser state, личные файлы, пользовательские тексты или сырые storage dumps.
- Живой Chrome: существующий CDP `http://127.0.0.1:9222`, Chrome `154.0.8037.58`. BrowserContext `FE8E9A7F7EC2194D6B6D40CCBAE89CA5`; каждый REQ создаёт отдельную owned Page в этом общем context.
- Контроли A/B/C использовали настоящие upload/submit/proof helpers и разные синтетические PNG. Финальный контроль — настоящий `DirectPostman.run(image_mode=True)`: generation → packaging Send → download → validation → durable result, не мок и не новый transport. Trusted current-turn Host не вызывался и пользовательский запрос не выдавался за `@PostmanImage`.
- Для синтетических REQ использована отдельная transport-ветка `transport/postman-send-control-20261003`. Она не является repair PR и не должна сливаться в preview; её история сохранена, без слепого удаления.

Все времена далее UTC. Исходная база исследования: `e3b0937f7e2c1f7deef21550eeaa939c73b8f51e`; перед PR task branch fast-forward обновлена до `070bf9dd368f2d9c2efaff5d634eea31c94f32f1` (изменения preview затрагивали только независимый Harness bridge, не Python Send).

## 1. Исходные три Image: что реально известно

| REQ | Старт | Зафиксированный исход | Этап и Send |
|---|---|---|---|
| REQ_20261003T061011Z_6313 | 06:10:11.648 | runtime failure 06:11:50.443, delivery 06:11:50.575 | PAGE_OWNED → FRESH_CHAT_CONFIRMED → COMPOSER_EMPTY_CONFIRMED → ATTACHMENT_UPLOAD_STARTED; POSTMAN_ATTACHMENT_UPLOAD_TIMEOUT / attachment_dom_unreadable. **До fill и Send**. |
| REQ_20261003T061015Z_5227 | 06:10:15.675 | IMAGE_RESULT_DURABLE 06:13:18.839 | Собственное изображение, packaging и ZIP успешно; сохранён bound chat и результат. |
| REQ_20261003T061029Z_3412 | 06:10:29.403 | runtime failure 06:12:04.408, delivery 06:12:04.582 | На / ноль turns, после hydration composer непустой → COMPOSER_NOT_EMPTY. **Нет fill/click**. |

Интервалы выполнения всех трёх пересекались с 06:10:29.403 до 06:11:50.443. Это доказывает перекрытие запросов, **не** точное перекрытие отдельных set_input_files/fill/click. Старые записи не содержали PID, CDP targetId, времени подключения и всех этапов. Код создавал отдельные Page в contexts[0], но индивидуальную историческую идентичность этих Page нельзя восстановить из отсутствующих записей.

В 06:11:06.604 пользователь сообщил о вмешательстве в первый Postman (inbox 06:11:05.652). Это существенный факт внутри интервала ошибки, но не доказательство конкретной navigation/detach/evaluate причины. Первый REQ не вставлял prompt, поэтому **не мог оставить свой prompt как источник третьего**. Чей именно исторический draft увидел третий, не установлено.

## 2. Доказанная каскадная причина: новый чат не изолирует draft

Контроль с уникальным неотправленным маркером дал exact DOM readback одинаковых length/SHA в A и новом B. B сначала показал пустой `textarea#pending-home-input`, затем hydrated `[contenteditable="true"][role="textbox"]` восстановил маркер. Закрытие исходной A не удалило сохраняемый draft; следующая новая / вкладка снова его восстановила.

Маркер найден в IndexedDB `codex-browser-host` → `records`, в draft-записях `composer-prompt-drafts-v2` / `chatgpt-conversation-prompt-drafts-v2`. Уже hydrated другая / Page не меняла свой DOM в течение наблюдаемых ~4 секунд, но reload/new home восстанавливал сохранённый маркер. Поэтому это доказанный **shared persistent bootstrap draft**, а не доказанная мгновенная DOM-синхронизация всех вкладок.

Controlled stagger (создание i×7 секунд, удержание после fill 18 секунд) без критической блокировки: REQ_20261003T082029Z_9100 отправился один раз, 9101/9102 получили COMPOSER_NOT_EMPTY и ноль clicks. Те же условия с serial pre-send: REQ_20261003T082146Z_9100/9101/9102 — 3/3 PROVEN_SENT. После исправления REQ_20261003T083347Z_9100/9101/9102 — 3/3, свои attachment, exact prompt, один initial click.

Это прямое экспериментальное основание короткой cross-process блокировки. Оно не превращает первоначальный attachment exception в доказанную shared-state race.

### Общий context: что разделено, что нет

Cookies и origin persistent storage общие; sessionStorage и live React/DOM/file input принадлежат Page. В контролях upload в A не прикреплял файл в B: attachment state и native input не мигрировали вместе с текстом. Navigation/URL привязаны к target; ни один helper не выбирает чужую Page по последней вкладке. Existing /c/ не наследовал home draft. Service-worker controller ChatGPT в исследованном состоянии был null. Состояние расширений и вся внутренняя React/session реализация не объявляются доказанными причинами.

## 3. Почему конкретный второй reminder не отправился

REQ_20261003T062032Z_2364: initial и slot 1 PROVEN_SENT. Во втором slot exact 79-символьный reminder уже был вставлен (SHA-256 `4f229032cbd47c217ec658d1394501a66475e9100621a0449e145be60bc27d7b`). Финальные guards пропустили его к `button.click(timeout=1000)`. Playwright выдал TimeoutError при ожидании `visible, enabled and stable`. Это **не rejection guard**, а click outcome uncertain → UNKNOWN → остановка.

_suppression_after_insert не вызывалась: выполнение попало в exception после попытки click. Не очищать UNKNOWN и не повторять Send — правильное safety-поведение; ошибка была в чрезмерно коротком бюджете click, не в отсутствии опасной очистки.

На собственной тестовой Page actionability-only trial (без отправки): background 1000 ms дважды TimeoutError; тот же control с 5000 ms готов за 1936 ms; foreground 1000 ms готов за 39 ms. Измеренные rAF в background шли примерно раз в секунду даже при reported visibility=visible; обычному Playwright нужны кадры стабильности. Timeout повышен до 5000 ms, force click не введён, UNKNOWN семантика сохранена.

Живой ordinary контроль PID 19016: initial 08:41:26.203, reminder 1 08:41:29.138, reminder 2 08:41:43.447 — все PROVEN_SENT, всего 3 clicks; второй с другой foreground Page. Третий был корректно не eligible после изменения фазы. В финальном смешанном прогоне PID 19264: initial 09:22:07.599 + reminder 1 09:23:48.954 PROVEN_SENT; slots 2/3 не отправлялись при UNKNOWN/ASSISTANT_NOT_STARTED + generationActive. Это не замена production расписания 10/20/30/40/50: контроль вызывал production safe-send helper в настоящей eligible фазе, без подделки guards.

## 4. Attachment: первичный отказ и новое доказательство

В первом историческом REQ выбор native input был допустим (три input, один eligible), но старый snapshot глотал исключение. ATTACHMENT_UPLOAD_STARTED не является доказательством completed set_input_files. Нельзя точно заявить, были ли bytes прочитаны, UI заменён, locator detached либо Page navigated/closed.

Безопасный live контроль на своей Page: set_input_files завершился, React обнулил native files (files.length=0), но UI содержал один pending attachment. После намеренной navigation своей Page old form Locator.evaluate получил реальный TimeoutError 1200 ms → locator_timeout. Это доказывает конкретный класс ошибки и объясняет, почему native files=0 не равно неуспешной загрузке; **не доказывает тот же исходный exception**.

Теперь snapshot сохраняет только exceptionType и безопасную exceptionCategory; пути, содержимое файлов и полный exception message не записывает. Upload отдельно отмечает setInputFilesCompleted. Attachment proof по-прежнему требует единственное своё имя, готовый UI и связь с exact user turn.

В полном Image контроле дополнительно обнаружен local-chatgpt attachment conversation ID после уже состоявшегося Send. Раньше существующий read-only reload/rebind начинался только после полного 90s timeout, что истощало очередь pre-send lock. Теперь он начинается сразу при **том же строгом наборе доказательств**: exact sent user turn, пустой composer, собственный bound /c/ URL, nonduplicate uploaded source с local-chatgpt ID. После reload всё равно требуется полное attachment proof. Ни повторного upload/fill/Send, ни ослабления окончательного успеха нет.

## 5. Все выходы между fill и PROVEN_SENT

| Ветка | Состояние | Очистка после исправления |
|---|---|---|
| До fill: foreign/home draft, неверный URL, upload proof failure | PROVEN_NOT_SENT | Чужой текст не трогать; своё готовое attachment удалять только при доказанной принадлежности и пустом composer. |
| fill exception / exact readback mismatch | PROVEN_NOT_SENT | Очистить только exact полный собственный prompt. Частичный/изменённый/неоднозначный текст не трогать. |
| Send отсутствует; attachment lost; изменился pre-click prompt | PROVEN_NOT_SENT | Общий finally проверяет ownership, отсутствие попытки Send и exact текст; при успехе очищает и доказывает пустоту. |
| Reminder insert failure, window expiry, suppression после insert | PROVEN_NOT_SENT | Тот же finally + строгая _clear_unsent_prompt; неотправленный exact owned reminder очищается. |
| URL/turn count изменились после fill | PROVEN_NOT_SENT | Ownership не доказан → ничего не удалять. |
| button.click exception; post-click proof timeout/exception | UNKNOWN | **Нет очистки, повторного click, refill или resend**. |
| Полное send proof | PROVEN_SENT | Lock освобождается; observer/generation/packaging wait остаются независимыми. |

До ремонта generic fresh/existing errors после fill не имели общего cleanup; reminder cleanup был только в suppression, а некоторые guard/insert ветки возвращались без него. Закрытие Page само по себе не удаляет persistent home draft. Транзакция охватывает fresh/existing/reminder; image packaging и recovery Continue используют эти же helpers. Recovery reload не превращён в новый Send.

Attachment Remove допускается только для единственного exact имени на initially-empty owned surface и без любой Send-попытки, при unchanged URL/turn count и пустом composer. Учитывается live UI: hover своей thumbnail, обычный (не force) exact Remove click, затем zero-attachment proof. При pending/error/unknown/foreign UI никакой слепой Remove.

Live injected PROVEN_NOT_SENT: exact 47-символьный owned prompt + свой PNG → SEND_CONTROL_NOT_FOUND, ноль Send, unsentPromptCleared=true, unsentAttachmentCleanup.cleared=true; новая / Page FRESH_CHAT_CONFIRMED и пустая. Suppression после insert также оставила пустой composer. Injected UNKNOWN сохранил exact текст и не кликнул. Этот искусственный UNKNOWN был очищен **только тестовой fixture**, где независимо известно, что click вообще не выполнялся; production UNKNOWN и настоящие неизвестные отправки не очищались.

## 6. Блокировки и минимальность ремонта

`lock_cdp_download` защищает attach/detach, Browser.setDownloadBehavior и download capture, не обычные DOM операции всего REQ. Его границы не расширены. Несколько connect_over_cdp + отдельные new_page могут работать одновременно; общий draft требует отдельной защиты bootstrap/fill, а не общей сериализации приложения.

Новый `lock_browser_presend` переиспользует существующий one-byte exclusive_lock: prepare → upload → exact fill/readback → один click → полное send proof / безопасный NOT_SENT cleanup. После выхода блокировка освобождается. Page diagnostics безопасно включают REQ, PID, local ordinal, CDP target/context, context page count и creation/close timestamp. Нет новой очереди, нового browser, agent orchestration либо нового transport.

Ограничения сохранены явно:

- Пользовательский новый / draft не подчиняется Postman lock. Если пользователь оставит там текст, Postman откажет с COMPOSER_NOT_EMPTY и не удалит его. Произвольное одновременное редактирование одного профиля не объявляется безопасным при любых interleavings.
- Закрытая/изменённая Page или частично вставленный текст могут исключить доказательство cleanup. Fail-closed сохраняет это в результате вместо обещания «всегда очистить».
- Timeout ожидания lock завершает запрос до изменения composer; он не разрешает retry/resend. 180s — конечное ожидание, не бесконечная гарантия очереди.
- Предыдущий полный batch 08:51:27 имел 3/3 initial Send, но DOWNLOAD_BEHAVIOR_FAILED из-за cdp-download lock и две Page, переставшие отвечать CDP. Эти результаты не объявлены PASS; auto-attach pause/Send race не доказаны, отдельного браузерного ремонта не добавлено. Финальный batch ниже прошёл без этого сбоя.

## 7. Контроли A/B/C/D и конечный полный запуск

| Контроль | REQ batch | Результат |
|---|---|---|
| A, один upload+Send | 08:10:43 / 9100 | 1 PROVEN_SENT, 1 click |
| B, три одновременно без serialization | 08:11:52 / 9100–9102 | 3/3 PROVEN_SENT; само по себе не исключает stagger race |
| B, controlled stagger | 08:20:29 / 9100–9102 | 1 sent, 2 COMPOSER_NOT_EMPTY; failed REQ 0 clicks |
| C, только serial pre-send при том же stagger | 08:21:46 / 9100–9102 | 3/3 PROVEN_SENT |
| Исправленный stagger | 08:33:47 / 9100–9102 | 3/3 PROVEN_SENT, свои attachments, 1 click каждый |
| D + полный Image | **09:21:54 / 9300–9302** | **3/3 IMAGE_RESULT_DURABLE**, normal/reminder + user-style existing chat одновременно |

### Конечная таблица принадлежности и жизненного цикла

REQ общий prefix `REQ_20261003T092154Z_`; context одинаковый, targetId разные.

| suffix / цвет | PID / targetId | Page created | initial click → PROVEN_SENT | durable / Page closed |
|---|---|---|---|---|
| 9300 red | 44564 / FB1DC6613DA7EE56D0A4DF942A546989 | 09:21:57.944 | 09:23:59.591 → 09:24:09.367 | 09:25:46.237 / 09:25:46.140 |
| 9301 green | 36932 / 1B5D9068EFAFAA50BECC99A75F382503 | 09:21:58.629 | 09:22:15.811 → 09:23:27.072 | 09:24:41.000 / 09:24:40.882 |
| 9302 blue | 33552 / 46BE1AB631535AE9B214B8626B4BF718 | 09:21:59.658 | 09:23:35.591 → 09:23:45.734 | 09:25:16.023 / 09:25:15.915 |

У каждого transitions содержат ATTACHMENT_READY_CONFIRMED, PROMPT_INSERTED и PROVEN_SENT; exactUserTurn, composerEmpty, sentAttachmentConfirmed=true. Имя `POSTMAN_REFERENCE_<exact REQ>.png` подтверждено на exact новом user turn. File IDs: 9300 `file_000000003250821083ce4f35ca6c8031`; 9301 `file_00000000a0348210bb23ef8e5c2071a5`; 9302 `file_00000000d22c8210992300d5ecd0db8c`. Chats: 9300 `6ac0c9ad-3558-83eb-a191-aa75df1a748c`, 9301 `6ac0c945-8724-83eb-88bb-79298c974038`, 9302 `6ac0c994-cba8-83ed-b9e4-f8b83c6085b5`.

**Ровно один initial Send у каждого**, плюс ровно один отдельный штатный packaging Send после generation (два Send всего — не resend исходного prompt). Все packaging Sends PROVEN_SENT. Results — три различные PNG 1254×1254, визуально соответствуют red/green/blue референсам; ZIP скачаны и validated. Image SHA-256:

- 9300: `a95f7309039d070ed94530da99ce72373c883a6f6b1a1727c98b7c939a73c6fa`
- 9301: `b7f6ee7e501f219a283eab67b025b5cccf27d819adb6606fd47c61126e0a6cde`
- 9302: `5af95c7bfe45aeda44a71d6c7c92db6a7a7b6742cad1572521632879ac034d91`

Overlap после PROVEN_SENT виден непосредственно: packaging 9301 начался 09:23:49.779, когда 9300 ещё ожидал initial критическую фазу; последующие generation/download независимы. Все owned Page закрыты один раз, внешний browser/context не закрывались.

Независимый user-style /c/ chat отправил сообщение без Postman lock (PROVEN_SENT), затем имел exact неотправленный тестовый draft; после полного batch exact hash сохранился, user count 2→2, дети exit codes [0,0]. Draft не отправлялся и не удалялся Postman; собственная fixture очистила его перед закрытием своей Page. Проверялся свой безопасный чат, не личные пользовательские вкладки.

## 8. Проверки кода и публикация

- Web suite: **454 tests, OK (skipped=1)**, с явным исключением заранее воспроизведённого неизменённого baseline failure `test_web_worker_result_recovery.WebWorkerResultRecoveryTests.test_additional_processing_enters_active_system_flow` (FakePage без locator). Не заявляется безусловный PASS всего исходного suite. Unit harness отключал только реальные browser locks для fake Page, не подменял live checks.
- Direct suite: **108 tests, OK (skipped=1)**. Эти результаты не повторялись при неизменных релевантных входах.
- Дополненные targeted transaction/attachment tests: **13/13 PASS** (4 новых ownership cleanup cases поверх проверенных 9); UNKNOWN/foreign/changed URL запреты, exact Remove/zero proof и privacy exception diagnostic.
- Финальная правка только diagnostics сохраняет URL до закрытия Page (вместо исходного about:blank); targeted bridge regression **15/15 PASS**. Send-код после живого контроля не менялся.
- `git diff --check` PASS; финальный живой mixed control exit 0, full Image children [0,0,0].

Изменены только `postman/direct/process_lock.py`, `postman/web/browser_submit.py`, `input_attachment.py`, `reminder_policy.py`, `web_worker_bridge.py`, относящиеся тесты и этот отчёт/краткий журнал. Никаких личных attachment/browser/storage данных в PR. Merge в preview и deployment требуют отдельного решения.
