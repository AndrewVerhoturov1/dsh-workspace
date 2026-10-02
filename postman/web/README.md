# `postman/web/` — production browser transport

## Статус

`postman/web/` — действующий browser transport Direct Web Postman.

Старые WP-002…WP-007 milestone-описания являются историей разработки и не задают
текущее production поведение. Текущая схема определяется executable modules,
`postman/POSTMAN_CURRENT_FLOW.md` и `docs/web-postman-artifact-contract.md`. Этот README — карта browser modules; transport lifecycle и пределы automatic continuation определяет Current Flow, не эта карта.

Production pipeline:

```text
dedicated Chrome/CDP
→ owned Page
→ fresh chat OR exact stored conversation
→ exact prompt send proof
→ exact next assistant turn
→ exact artifact envelope/control
→ one browser download
→ transport validator
→ request-scoped durable result
```

## Native input ZIP

Optional verified Host input bundle дополняет, а не заменяет существующую Send state machine. `input_attachment.py` получает только Direct-verified request attachment, читает/сверяет ZIP bytes и загружает ровно один native Playwright FilePayload. No model filesystem paths, generic file lists или directory globs.

После fresh/existing exact chat и empty composer proof: upload → exact filename/count=1 → positive completed file control/no progress/error → prompt fill → re-proof → single Send. После Send нужен ровно один новый user turn с exact full prompt и ZIP resource card в том же exact user-message unit, плюс empty composer/bound URL. DOM filename — membership proof, не remote hash; file ID совпадает, если exposed до и после Send; отсутствие ID само по себе не отменяет card proof. Filename не подставляется в CSS selector.

Pre-Send failures = PROVEN_NOT_SENT. Missing/uncertain sent ZIP = PROMPT_SEND_UNKNOWN, diagnostic POSTMAN_SENT_ATTACHMENT_PROOF_UNKNOWN; не reupload/resend. Serialized system recovery, reminders и deadlines #294 не рефакторятся. Unknown UI markup fail-closed. Без inputs старый flow; reminders/automatic continuations inputs не наследуют. Selector helper и fake-DOM tests изолированы. Один isolated live acceptance прогон production helpers подтвердил PROVEN_SENT для REQ_20261001T223452Z_9498: exact prompt SHA, native ZIP в том же новом user turn, composer empty и bound URL. Runtime Leader→Bridge E2E в установленном Harness не выполнялся; до единственного Send pre-Send попытки оставались PROVEN_NOT_SENT. Details/limits/cleanup: [POSTMAN_INPUT_FILES.md](../POSTMAN_INPUT_FILES.md).

## Модули

```text
postman/web/
├─ browser_bootstrap.py
├─ browser_submit.py
├─ browser_observer.py
├─ browser_recovery.py
├─ request_identity.py
├─ artifact_detector.py
├─ artifact_download.py
├─ artifact-validator.mjs
├─ artifact_validate_cli.mjs
├─ runtime_support.py
├─ web_worker_bridge.py
└─ tests/
```

### `browser_bootstrap.py`

Владеет dedicated Chrome/CDP bootstrap.

Default browser identity:

```text
%LOCALAPPDATA%\DSH\Postman\browser-profile
```

Профиль, а не PID процесса, является устойчивой browser identity. Worker закрывает
только созданную им owned Page, причём до отключения Playwright/CDP. Externally-owned
Chrome/context не закрываются.

### `browser_submit.py`

Fresh-chat path перед Send доказывает:

```text
owned Page
+ root ChatGPT route
+ zero current conversation turns
+ visible empty composer
```

Continuation path открывает exact сохранённый `/c/<conversation-id>` и доказывает
готовность того же conversation к новой отправке.

После начала Send разрешена одна попытка. Success требует exact user-turn proof и bound chat URL.
Текст legacy user turn и modern `data-user-message-bubble="true"` читается из известного вложенного semantic payload; соседние controls свёрнутого сообщения не входят в exact proof. Без такого payload контейнер с `button`/`role="button"`/`data-collapsed` остаётся fail-closed; простой контейнер без controls сохраняет fallback. Вложение проверяется в прежней области всего user turn, не внутри текстового payload.
Неопределённый Send не разрешает blind resend.

### `browser_observer.py`

Observer привязывается к доказанному user turn и exact chat URL и принимает только
непосредственно следующий логический ход assistant (либо turn-group того же user anchor). Структурный `inspect_answer_phase()` различает
`WORKING`, `FINAL_ANSWER_STARTED` (защёлка), `FINAL_ANSWER_COMPLETED`, `UNKNOWN`
(fail-closed) и `ADDITIONAL_PROCESSING` (видимый системный баннер вне transcript).
Pause/Stop — диагностика, не доказательство фазы. В доступных завершённых CDP-ходах
подтверждены `data-chatgpt-selection-message-id`, `data-markdown-text-style="assistant-message"`
и кнопки действий («Оценить ответ», «Прочитать вслух»); `data-message-model-slug` отсутствовал.
Один Markdown renderer используется и для commentary: сам по себе он не доказывает финал.
`data-turn-key` привязывает user anchor, activity и отдельный final assistant unit к одному
логическому ходу; смена внутреннего message ID не теряет correlation. Activity/status/reasoning
markdown остаётся WORKING, отдельный `:assistant` unit с ролью assistant и rendered answer
защёлкивает финал. Для completion нужны actions этого хода (прежде всего структурные
copy/turn controls) и inactive generation. Старые renderer paths сохранены с fail-closed
неоднозначной разметкой. Живой thinking/tool поток не наблюдался, новые варианты
без доказанных признаков остаются UNKNOWN.
Системные banners допускаются внутри `data-turn-key`, но literal markdown/user quotes
не служат безусловным сигналом. Connection Interrupted headline не требует subtitle;
alert/status/aria-live/retry усиливают evidence, weak candidate подтверждается через 1–3 секунды.
Additional Processing использует RU/EN варианты текста, а не одну exact строку.

В image mode identity закрепляется за exact conversation + доказанным user anchor +
непосредственно следующим логическим assistant response, а не selector family. Grouped
`data-turn-key` предпочитается уже при assistant/working evidence, до появления картинки;
user-only group сохраняет gallery fallback. Допустима гидрация weak → strong;
`groupKey`, scoped `data-content-search-turn-key` и стабильный direct message ID
хранятся раздельно. Конфликт закреплённого ключа или смена weak ID в той же family —
fail-closed. Внутренние message IDs grouped activity/final units не являются response ID.
При временно недоказанной identity polling продолжается в обычном timeout без completion;
promotion и пробел в доказательстве сбрасывают stability window. Только одно decoded/visible
изображение correlated assistant, inactive generation и непрерывное окно стабильности
дают `IMAGE_TURN_COMPLETED` → один `image_prepare()` → один packaging message в том же chat.
Изображения user bubble и чужих turns не входят в proof; proven первый prompt не пересылается.

Поиск «любого похожего ответа» по всему DOM запрещён.

### `browser_recovery.py`

Connection recovery reload-ит ту же owned Page, доказывает exact URL, original task lineage,
последний разрешённый anchor и empty live composer, затем ждёт 10 секунд стабилизации.
Strong и weak interruption evidence оба блокируют recovery READY до исчезновения banner.
До трёх reload attempts; exhaustion ведёт в CONNECTION_WAITING, не terminal failure:
без новых reload/reminders/resend, с periodic result observation и fresh same-chat re-proof
после исчезновения banner. Пассивное ожидание ограничено исходным request deadline.
`system_recovery.py` обрабатывает Additional Processing: Stop-if-present один раз (ABSENT/UNKNOWN
не требуют повторного click) → один reload → обязательный same-chat/lineage re-proof →
random uniform wait 10–17 секунд → re-proof → natural continuation через safe Send.
Connection interrupted на границе этого flow передаёт управление последовательно:
result-first scan → fresh same-chat/lineage/empty-composer proof → RECOVERY_ABORTED
(reason=serial_handoff) → existing Connection recovery. Pending event сохраняет время
confirmation и previousRecoveryDeadline; deadline следующего cycle ограничен
min(previousRecoveryDeadline, normalNewRecoveryDeadline, softDeadline + 45s), без
новых 180 секунд. При исчерпанном остатке — существующее пассивное CONNECTION_WAITING
без reload; нет параллельного flow или повторного Stop/Send.
`transport_control.py` сериализует фазы и banner episodes: одно непрерывное появление = один event,
исчезновение rearm-ит detector, второе событие не накладывает новый flow поверх active recovery.
Reload/control cycle bounded 180 секундами; soft deadline 60 минут. Confirmation timestamp
до soft deadline разрешает начать pending cycle даже при позднем observer return; grace
не позже soft + 45 секунд. Новое позднее событие не получает recovery. Готовый RESULT
отменяет Send. Журнал различает RECOVERY_COMPLETED, RECOVERY_FAILED (reason/code) и
RECOVERY_ABORTED (result preemption/timeout/cleanup), без ложного success в finally.

### `request_identity.py` и `artifact_detector.py`

Artifact должен быть физически внутри exact correlated assistant turn и внутри envelope:

```text
<<<POSTMAN_RESULT_BEGIN:<REQ>>>
POSTMAN_<REQ>_RESULT.zip
<<<POSTMAN_RESULT_END:<REQ>>>
```

Средняя строка — реальный downloadable ZIP control с exact visible filename.

Generic download control, stale attachment, wrong REQ, filename вне envelope или неоднозначный
control отклоняются.

### `artifact_download.py`

Download lifecycle:

```text
exact correlated control
→ re-prove identity
→ page.expect_download()
→ exactly one click
→ exact browser download event
→ request-scoped staging
→ validator
→ durable store
```

Filesystem scan по «последнему ZIP» не используется. Общий cross-process lock из
`postman/direct/process_lock.py` защищает только CDP attach/disconnect и capture:
повторная установка `allowAndName` в каталог текущего подключения → один click →
`download.failure()` → физический `download.path()` → size/SHA source → `save_as()` →
сравнение staging size/SHA. Ожидание ответа, validator и durable publish идут вне lock.
Отсутствующий source — `DOWNLOAD_SOURCE_MISSING`; несовпадение копии —
`DOWNLOAD_STAGING_MISMATCH`, оба transport failure без повторного click. Только
действительно пустой source проходит к существующему `ARTIFACT_EMPTY` validator.

Локальная проверка без ChatGPT и production профиля:

```powershell
$env:DSH_POSTMAN_CDP_REPRO="1"
python -m unittest discover -s postman/web/tests -p test_cdp_download_repro.py
```

Тест выполняет пять циклов независимого B connect/disconnect после A connect,
затем production capture A; проверяет exact bytes/SHA и отсутствие native download.


### `artifact-validator.mjs`

Normal hard gates:

- exact expected filename;
- readable non-empty ZIP;
- central/local header consistency и CRC;
- path traversal / absolute / drive / UNC / ADS rejection;
- path traversal / absolute / Windows drive / UNC rejection;
- symlink rejection;
- простые entry/count/compressed/uncompressed/ratio limits;
- CRC/local-header integrity и SHA-256.

`manifest.json` полностью informational для transport validator и не является hard gate.

Не являются normal transport gates:

```text
protocolVersion
repository
baseCommit
resultType
patch/files schema
allowedPaths/forbiddenPaths
unified diff semantics
```

`manifest.json` может отсутствовать, быть malformed/non-object или содержать unknown fields.
Это само по себе не делает безопасный ZIP invalid.

### `web_worker_bridge.py`

Координирует browser pipeline для одного trusted REQ и сохраняет monotonic request state.

Основные состояния включают три terminal outcomes:

```text
RESULT_DURABLE
ASSISTANT_COMPLETED_NO_ARTIFACT
ARTIFACT_REJECTED
```

Bridge не является repository applicator и не принимает model-provided routing authority.
Завершённый assistant-turn без ZIP перепроверяется через 10 секунд; если ZIP всё ещё отсутствует,
bridge немедленно возвращает `ASSISTANT_COMPLETED_NO_ARTIFACT` вместе с assistant text. ZIP,
который не прошёл minimal transport validation, немедленно возвращает `ARTIFACT_REJECTED` с
точной причиной. Reminders 10/20/30/40/50 допустимы при доказанном WORKING, запрещены после
final latch. UNKNOWN ждёт безопасного proof, recovery consume-ит все наступившие pending slots;
очереди после восстановления нет. `continuation_prompts.py` содержит 50 случайно выбираемых
русских фраз без visible REQ/control identifiers. До Send durable intent сохраняет exact text,
hash, templateId, request/conversation, slot/eventId и user-turn relation; после Send проверяются
exact payload/count/prefix/URL и закрепляется ordinal/groupKey, даже при повторе шаблона.
Две инъецируемые паузы 1–5 секунд разделяют решение, insert и final proof. SendGuard одноразовый,
UNKNOWN post-click не повторяется. Durable/failure state сохраняет bounded 256-event журнал
переходов, detector candidates/evidence/reject reason/counters, slots, Stop, reload, re-proof,
wait и exact Send outcomes. Полная семантика: [current flow](../POSTMAN_CURRENT_FLOW.md#111-transport-control-recovery-и-естественные-продолжения).

## Fresh и continuation

Fresh request создаёт новую owned Page и новый ChatGPT conversation.

Continuation получает от Direct layer exact сохранённый conversation URL старого REQ,
открывает именно его и отправляет **новый** canonical REQ. Старый REQ используется только
для lookup и correlation; semantic prompt содержит только новый request.

Нет Search UI fallback и нет silent fresh-chat fallback.

## Durable result boundary

`postman/web/` заканчивает работу на validated request-scoped artifact:

```text
RESULT_DURABLE
```

Он не:

- применяет ZIP к working tree;
- запускает Git/PR lifecycle;
- интерпретирует semantic correctness результата;
- выбирает downstream action по содержимому ZIP.

Normal post-processing заканчивается на RESULT_DURABLE и описан в
`postman/POSTMAN_CURRENT_FLOW.md`; автоматическая Result Workspace registration не выполняется.

## Tests

Регрессии находятся в:

```text
postman/web/tests/
```

Особенно важны группы:

```text
browser bootstrap
submit/send proof
assistant observer
artifact detector
artifact download
artifact validator
runtime support
web worker bridge
continuation/correlation
```

Исторические milestone counts и «next milestone» не являются частью этого README:
актуальный статус определяется текущим `main` и тестами.
