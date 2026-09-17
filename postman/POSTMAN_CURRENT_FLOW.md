# Direct Web Postman — актуальный рабочий процесс

> Репозиторий: https://github.com/AndrewVerhoturov1/dsh-workspace  
> Актуальная ветка: `main`  
> Production entrypoint: **Direct Web Postman / WP-014R**

## 1. Назначение

Direct Web Postman — транспортный слой между локальным агентом DSH и ChatGPT Web.

Его задача:

1. принять пользовательскую задачу от локального агента;
2. создать уникальный `REQ`;
3. зафиксировать trusted metadata задачи и `base_commit`;
4. опубликовать task-файл в GitHub;
5. открыть или переиспользовать выделенный Chrome с авторизованным ChatGPT Web;
6. создать новый чат;
7. отправить короткий transport prompt со ссылками на policy и task-файл;
8. дождаться строго коррелированного assistant turn;
9. найти строго коррелированный ZIP attachment;
10. скачать ZIP ровно одним кликом;
11. провалидировать ZIP и `manifest.json`;
12. атомарно сохранить результат как `RESULT_DURABLE`;
13. вернуть локальному агенту JSON с путём к проверенному ZIP.

Postman **не должен автоматически применять ZIP к рабочему репозиторию**.

---

## 2. Текущий production flow

```text
Локальный агент / Luna
        │
        ▼
postman/direct/postman.ps1
        │
        ▼
postman/direct/postman_direct.py
        │
        ├─ validate REQ
        ├─ snapshot origin/main
        ├─ derive base_commit
        ├─ build trusted task manifest
        ├─ publish REQ_<id>.md to GitHub main
        │
        ├─ ensure dedicated Chrome + CDP
        │
        ▼
postman/web/web_worker_bridge.py
        │
        ├─ create owned Page
        ├─ prove fresh ChatGPT chat
        ├─ send transport prompt exactly once
        ├─ bind /c/... chat URL
        ├─ observe exact next assistant turn
        ├─ detect exact ZIP control
        ├─ re-prove artifact identity
        ├─ expect_download + exactly one click
        ├─ stage ZIP
        ├─ validate ZIP + manifest + scope
        ├─ publish request-scoped durable result
        ▼
RESULT_DURABLE
        │
        ▼
JSON result back to local agent
```

Основное описание:

- `postman/direct/README.md`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/README.md

- `postman/direct/postman.ps1`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman.ps1

- `postman/direct/postman_direct.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman_direct.py

---

## 3. Request ID

Новый production request использует immutable cross-system key:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

Пример:

```text
REQ_20260917T134845Z_2554
```

Один logical request имеет один canonical `REQ`.

Автоматический blind resend того же `REQ` запрещён.

Если persisted direct-state для `REQ` уже существует, новый автоматический transport run не должен повторно отправлять prompt.

Связанные файлы:

- `postman/web/request_identity.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/request_identity.py

- `postman/direct/postman_direct.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman_direct.py

---

## 4. Snapshot и `base_commit`

До публикации task-файла Postman должен получить текущий commit целевой ветки.

Для production flow:

```text
repository = AndrewVerhoturov1/dsh-workspace
branch = main
```

Этот commit становится:

```text
base_commit
```

`base_commit` — trusted implementation snapshot, против которого внешний ChatGPT должен готовить результат.

После snapshot Postman публикует:

```text
REQ_<id>.md
```

Публикационный commit обязан иметь snapshot commit непосредственным родителем.

Если branch успела измениться между snapshot и публикацией, Postman должен завершиться fail-closed с publication race, а не молча использовать другую базу.

Реализация:

- `GitHubTaskPublisher.snapshot()`
- `GitHubTaskPublisher.publish_content()`

Файл:

- https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman_direct.py

---

## 5. Task-файл

Task-файл содержит trusted request metadata.

Пример структуры:

```text
# POSTMAN TASK

protocol_version: 1
request_id: REQ_...
repository: AndrewVerhoturov1/dsh-workspace
base_commit: <40-hex-sha>
expected_filename: POSTMAN_REQ_..._RESULT.zip
allowed_paths_json: [...]
forbidden_paths_json: [...]

## User intent

<исходное пользовательское намерение>

## Execution contract

...

## Result contract

...
```

Task-файл формируется здесь:

- `postman/task_package.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/task_package.py

Функция:

```text
render_direct_task_manifest(...)
```

Task-файл является self-contained описанием конкретного запроса.

---

## 6. Transport prompt в ChatGPT Web

В браузер не нужно дублировать полную задачу.

Production transport prompt должен быть коротким и ссылочным:

```text
POSTMAN_REQUEST_ID: REQ_...
policy: https://...
task_file: https://.../REQ_....md
```

То есть:

- первая строка содержит canonical `REQ`;
- `policy:` указывает на protocol/policy;
- `task_file:` указывает на exact published task-файл.

Task text, `base_commit`, allowed paths, forbidden paths и ZIP contract находятся в task-файле.

Реализация:

- `postman/task_package.py`
- `build_external_prompt(...)`

Ссылка:

- https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/task_package.py

---

## 7. Dedicated Chrome

Postman использует отдельный Chrome profile.

Default profile:

```text
%LOCALAPPDATA%\DSH\Postman\browser-profile
```

Browser identity — это именно профиль, а не PID процесса Chrome.

CDP endpoint:

```text
http://127.0.0.1:9222
```

Postman должен:

1. попытаться подключиться к уже работающему dedicated Chrome;
2. если CDP недоступен — найти Chrome;
3. запустить Chrome с Postman profile;
4. дождаться CDP readiness.

Browser является externally owned.

Worker не должен закрывать весь Chrome после запроса.

Связанные файлы:

- `postman/web/browser_bootstrap.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/browser_bootstrap.py

- `postman/direct/postman_direct.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman_direct.py

---

## 8. Новый Page и fresh chat

Для каждого transport request создаётся отдельная owned Page.

`WebWorkerBridge` подключается по CDP и делает новую страницу.

Дальше `browser_submit.py` обязан доказать:

```text
PAGE_OWNED
→ root chatgpt.com route
→ zero current conversation turns
→ visible empty composer
→ FRESH_CHAT_CONFIRMED
→ COMPOSER_EMPTY_CONFIRMED
```

После этого разрешена вставка prompt.

Файл:

- `postman/web/browser_submit.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/browser_submit.py

---

## 9. Отправка prompt

Prompt должен быть вставлен точно.

После вставки проверяются:

- exact prompt text;
- SHA-256 prompt;
- состояние composer.

После начала Send разрешена **ровно одна попытка отправки**.

Успех должен доказать одновременно:

```text
exactly one new user turn
+
exact prompt text
+
empty composer
+
new bound https://chatgpt.com/c/... URL
=
PROMPT_SEND_CONFIRMED
```

После этого send state:

```text
PROVEN_SENT
```

Если после клика Send невозможно доказать, отправился prompt или нет:

```text
PROMPT_SEND_UNKNOWN
```

В этом состоянии автоматический resend запрещён.

Это критический anti-duplication invariant.

---

## 10. Корреляция assistant turn

После `PROMPT_SEND_CONFIRMED` worker передаёт observer:

```text
exact prompt text
+
exact bound /c/... URL
```

Observer ищет:

```text
exact proven user turn
→ immediately next conversation turn
→ role = assistant
```

Нельзя:

- искать ответ по всему `body`;
- брать старый assistant turn;
- брать attachment из другого сообщения;
- использовать другой `/c/...` URL.

Lifecycle:

```text
ASSISTANT_TURN_STARTED
→ ASSISTANT_TURN_STREAMING
→ ASSISTANT_TURN_COMPLETED
```

Файл:

- `postman/web/browser_observer.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/browser_observer.py

Production Direct Postman передаёт observer timeout около 15 минут.

---

## 11. Контракт финального ответа ChatGPT

Для ZIP result финальный assistant turn должен содержать ровно три непустые видимые строки:

```text
<<<POSTMAN_RESULT_BEGIN:<REQ>>>
POSTMAN_<REQ>_RESULT.zip
<<<POSTMAN_RESULT_END:<REQ>>>
```

Критически важно:

средняя строка должна быть **реальным downloadable attachment/control**, а не plain text.

Visible filename должен exact-match:

```text
POSTMAN_<REQ>_RESULT.zip
```

Для конкретного примера:

```text
POSTMAN_REQ_20260917T134845Z_2554_RESULT.zip
```

Контракт:

- один exact BEGIN marker;
- один exact END marker;
- один exact expected ZIP control;
- control физически находится между BEGIN и END;
- control находится внутри того же correlated assistant turn;
- generic `Download ZIP` недостаточен;
- правильное имя файла вне envelope недостаточно;
- stale ZIP недостаточен;
- wrong `REQ` отклоняется.

Реализация:

- `postman/web/artifact_detector.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact_detector.py

---

## 12. Artifact DOM proof

После успешного detect worker получает identity proof, включающий данные вроде:

```text
requestId
expectedFilename
chatUrl
assistantIndex
assistantTextSha256
turnSelector
attachmentPath
```

Перед скачиванием P6 обязан повторно выполнить detector.

Если identity изменилась:

```text
DOWNLOAD_PROOF_CHANGED
```

Никакого клика быть не должно.

Это защищает от DOM race и подмены attachment между detect и download.

---

## 13. Download

ZIP не ищется по файловой системе и не выбирается как «последний `.zip`».

Запрещено:

```text
scan Downloads directory
choose newest ZIP
choose last Download button
search whole page for .zip
```

Правильный flow:

```text
exact correlated attachment
→ page.expect_download(...)
→ exactly one click
→ exact download event
```

После download event проверяется:

```text
download.suggested_filename == expected_filename
```

При mismatch artifact отклоняется.

Повторный click автоматически не выполняется.

Реализация:

- `postman/web/artifact_download.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact_download.py

---

## 14. Staging

Скачанный ZIP сначала сохраняется в request-scoped staging.

Пример концептуально:

```text
<ResultRoot>\
└── .staging\
    └── <REQ>\
        └── POSTMAN_<REQ>_RESULT.zip
```

Staging и final result path должны быть уникальны для request.

Если staging/final path уже существует:

```text
RESULT_STORE_CONFLICT
```

---

## 15. ZIP validation

Скачивание файла ещё не означает успех.

После download Postman вычисляет SHA-256 и запускает artifact validator.

Canonical validator:

- `postman/web/artifact-validator.mjs`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact-validator.mjs

CLI wrapper:

- `postman/web/artifact_validate_cli.mjs`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact_validate_cli.mjs

Validator проверяет среди прочего:

- ZIP structure;
- exact filename;
- `manifest.json` в root;
- `protocolVersion`;
- exact `requestId`;
- exact repository;
- exact `baseCommit`;
- allowed `resultType`;
- allowed / forbidden paths;
- patch structure;
- path traversal;
- absolute paths;
- `..`;
- symlinks;
- junction/reparse/special entries;
- duplicate entries;
- case collisions;
- Unicode-normalization collisions;
- archive limits;
- compressed/uncompressed limits;
- content inventory;
- SHA-256.

ZIP не должен извлекаться непосредственно поверх repository.

---

## 16. Manifest contract

Для ZIP artifact `manifest.json` находится в корне.

Минимальный пример:

```json
{
  "protocolVersion": 1,
  "requestId": "REQ_...",
  "repository": "AndrewVerhoturov1/dsh-workspace",
  "baseCommit": "<40-hex-sha>",
  "resultType": "hybrid_patch",
  "patch": "changes.patch",
  "files": []
}
```

Разрешённые `resultType`:

```text
patch
files
hybrid_patch
```

Trusted runtime metadata имеет приоритет над содержимым ZIP.

Artifact не имеет права определять routing authority:

```text
origin_agent_id
destination_agent_id
destination_session
delivery_target
```

Canonical contract:

- `docs/web-postman-artifact-contract.md`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/docs/web-postman-artifact-contract.md

---

## 17. Post-validation re-check

Даже если Node validator вернул PASS, Python transport повторно проверяет identity:

```text
manifest.requestId == trusted requestId
manifest.repository == trusted repository
manifest.baseCommit == trusted baseCommit
validation.sha256 == actual ZIP SHA-256
```

Это дополнительная fail-closed boundary.

Реализация:

- `postman/web/artifact_download.py`

---

## 18. Durable result store

После полного PASS результат атомарно публикуется в request-scoped directory.

Формат:

```text
<ResultRoot>\<REQ>\
├── result.zip
├── manifest.json
├── validation.json
└── metadata.json
```

Состояние:

```text
RESULT_DURABLE
```

Только `RESULT_DURABLE` означает, что Postman transport успешно завершён.

Default result root задаётся через:

```text
DSH_POSTMAN_RESULT_ROOT
```

или runtime defaults.

В PowerShell entrypoint Direct Postman также используется production default:

```text
D:\Downloads_dsh_auto
```

если другой путь не задан.

Файлы:

- `postman/direct/postman.ps1`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman.ps1

- `postman/web/runtime_support.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/runtime_support.py

- `postman/web/artifact_download.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact_download.py

---

## 19. WebWorkerBridge state machine

Основные состояния transport bridge:

```text
ACCEPTED
→ WEB_STARTING
→ PROMPT_SENT
→ WAITING_ASSISTANT
→ ARTIFACT_FOUND
→ RESULT_DURABLE
```

Bridge хранит persisted state request-а.

Он не должен перемещать state назад.

При restart уже продвинутого request-а нельзя blind resend prompt.

Файл:

- `postman/web/web_worker_bridge.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/web_worker_bridge.py

---

## 20. Direct Postman state machine

Direct layer дополнительно хранит верхнеуровневые состояния:

```text
INIT
→ TASK_PUBLISHED
→ BROWSER_READY
→ WEB_RUNNING
→ RESULT_DURABLE
```

Ошибка:

```text
FAILED
```

После `RESULT_DURABLE` сохраняется durable handoff JSON.

Файлы:

- `postman/direct/postman_direct.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman_direct.py

- `postman/direct/durable_handoff.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/durable_handoff.py

---

## 21. Что Postman НЕ делает

Direct Web Postman не должен:

- применять ZIP поверх working tree;
- делать blind patch apply;
- считать assistant text trusted;
- доверять имени файла без validator;
- использовать model-provided routing authority;
- выбирать «последний ZIP»;
- повторно кликать attachment после неопределённого download;
- повторно отправлять prompt после неопределённого Send;
- закрывать externally-owned Chrome;
- использовать старый user browser tab как job identity;
- переключать основной checkout ради transport;
- считать `RESULT_DURABLE` эквивалентом тестирования реализации.

---

## 22. Что происходит после `RESULT_DURABLE`

После successful transport ответственность возвращается локальному originating agent.

Дальнейший flow:

```text
RESULT_DURABLE
→ PREPARE
→ isolated request worktree
→ compatibility checks
→ apply
→ deterministic tests
→ TEST_PASSED
→ publish / presentation
→ cleanup
```

Для resume уже существующего durable result используется отдельный state-machine flow.

Он не должен повторно вызывать Direct Postman или ChatGPT.

Связанные файлы:

- `postman/direct/resume_request.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/resume_request.py

- `postman/direct/prepare_result.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/prepare_result.py

- `postman/direct/test_result.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/test_result.py

- `postman/direct/publish_result.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/publish_result.py

- `postman/direct/integrate_result.py`  
  https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/integrate_result.py

---

## 23. Ключевые safety invariants

### Send

```text
PROVEN_SENT
→ no automatic resend
```

```text
PROMPT_SEND_UNKNOWN
→ no automatic resend
```

### Download

```text
exact correlated attachment
→ exactly one click
```

После начала click:

```text
no blind retry
```

### Request

```text
one logical request
→ one canonical REQ
```

### Browser

```text
one request
→ one owned Page
```

### Artifact

```text
correct filename
≠ sufficient proof
```

Нужно одновременно:

```text
correct REQ
+ correct chat
+ correct assistant turn
+ exact envelope
+ exact downloadable control
+ exact filename
+ exact manifest identity
+ validator PASS
+ durable store
```

---

## 24. Важное замечание по документации

В `postman/web/README.md` и `docs/web-postman-artifact-contract.md` остаются исторические milestone-секции, где написано, что:

```text
WP-007 / P6 — Download + validation
не реализован
```

Это исторический текст.

В текущем production code P6 уже реализован и реально вызывается:

```text
artifact_download.download_validated_artifact(...)
```

из:

```text
WebWorkerBridge.run_request(...)
```

Поэтому для определения текущего поведения source of truth следует считать в первую очередь:

1. `postman/direct/README.md`
2. `postman/direct/postman.ps1`
3. `postman/direct/postman_direct.py`
4. `postman/web/web_worker_bridge.py`
5. `postman/web/browser_submit.py`
6. `postman/web/browser_observer.py`
7. `postman/web/artifact_detector.py`
8. `postman/web/artifact_download.py`
9. `postman/web/artifact-validator.mjs`

Исторические milestone-разделы README полезны как история развития, но не должны переопределять текущий executable flow.

---

## 25. Короткая формулировка

Direct Web Postman должен работать так:

> Локальный агент создаёт уникальный `REQ`, фиксирует GitHub `base_commit`, публикует self-contained task-файл, запускает или переиспользует выделенный Chrome, создаёт новый ChatGPT Web chat, отправляет link-only transport prompt, привязывается к конкретному `/c/...` диалогу, ждёт ровно следующий assistant turn, находит внутри него строго оформленный ZIP attachment для того же `REQ`, ровно один раз скачивает его через browser download event, валидирует ZIP/manifest/SHA/scope, атомарно сохраняет `RESULT_DURABLE` и возвращает локальному агенту путь к проверенному `result.zip`.

---

## 26. Основные ссылки

### Репозиторий

https://github.com/AndrewVerhoturov1/dsh-workspace

### Production Direct Postman

https://github.com/AndrewVerhoturov1/dsh-workspace/tree/main/postman/direct

### Browser transport

https://github.com/AndrewVerhoturov1/dsh-workspace/tree/main/postman/web

### Главный production README

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/README.md

### Direct CLI

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman_direct.py

### PowerShell entrypoint

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/direct/postman.ps1

### Web worker bridge

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/web_worker_bridge.py

### Fresh chat + submit

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/browser_submit.py

### Assistant observer

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/browser_observer.py

### Artifact detector

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact_detector.py

### Download + durable store

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact_download.py

### ZIP validator

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/web/artifact-validator.mjs

### Artifact contract

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/docs/web-postman-artifact-contract.md

### Task package / transport prompt

https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/postman/task_package.py
