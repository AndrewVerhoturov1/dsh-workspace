# Web Postman — план внедрения и проверки

## 0. Статус и отправная точка

Этот документ фиксирует новый browser-first путь Postman.

Ветка реализации:

```text
postman/web-postman-v1
```

Она создаётся от `main`, где уже доказан Postman M4–M5: durable runtime, `REQ -> origin_agent_id`, READY recovery, duplicate suppression и возврат результата в исходного Harness Agent.

Существующая ветка `postman/github-integration-m6` не является базой новой реализации. Она остаётся отдельным Desktop/GitHub-write прототипом и источником уже полученных уроков по fail-closed поведению, fresh/send proof, correlation и recovery.

В качестве reference implementation для браузерной части используется публичный проект `AndrewVerhoturov1/codex-token-monitor`, Route W / `zworker-auto`. Из него допускается переиспользовать проверенные идеи и при необходимости небольшие изолированные helper-подходы, но новый Web Postman не должен становиться копией zworker-auto.

Главные полезные наработки Route W:

- headful Google Chrome;
- отдельный авторизованный профиль;
- Playwright + CDP attach-mode;
- dedicated Page, не затрагивающая пользовательские вкладки;
- `page.expect_download()` для штатного browser download lifecycle;
- persistent `run_state.json` / `events.jsonl` / `chat_url`;
- prompt SHA-256;
- resume protection;
- ZIP pre-validation.

---

## 1. Цель

Создать новый Web Postman transport, в котором внешний ChatGPT:

1. получает задачу через ChatGPT Web;
2. использует GitHub только как READ-источник исходников;
3. выполняет reasoning / code generation;
4. возвращает результат обычным assistant response и/или ZIP artifact;
5. не выполняет обязательные внешние write-actions;
6. Web Postman Worker детерминированно обнаруживает результат, скачивает его, валидирует и сохраняет локально;
7. Postman Runtime переводит соответствующий `REQ` в `READY`;
8. результат возвращается строго исходному Harness Agent по trusted mapping из runtime DB.

Целевая цепочка:

```text
Harness Agent
    |
    v
  POSTMAN
    |
    v
Postman Runtime
    |
    v
Web Postman Worker
    |
    +-- Chrome
    +-- CDP
    +-- Playwright
    +-- dedicated Page per active REQ
            |
            v
       ChatGPT Web
            |
            +-- GitHub READ
            |
            v
       TEXT / PATCH / ZIP
            |
            v
      Browser download
            |
            v
      Artifact validator
            |
            v
      Durable result store
            |
            v
      Postman DB READY
            |
            v
 originating Harness Agent
```

---

## 2. Архитектурное разделение

Web Postman состоит минимум из трёх слоёв.

### POSTMAN LLM session

Отвечает за:

- orchestration;
- reasoning по нестандартным состояниям;
- принятие решений по retry/recovery;
- общение с исходным Harness Agent.

Не является durable source of truth.

### Postman Runtime

Отвечает за:

- durable `REQ` registry;
- trusted `REQ -> origin_agent_id`;
- request/result state;
- journal;
- locks;
- duplicate suppression;
- delivery lifecycle;
- paths/hashes/result metadata.

LLM-текст, ZIP manifest и ChatGPT response не имеют права выбирать `origin_agent_id`.

### Web Postman Worker

Детерминированный persistent process, отвечающий за:

- browser ownership;
- CDP connection;
- Page lifecycle;
- fresh chat;
- prompt submit;
- assistant turn observation;
- artifact correlation;
- browser download;
- local validation;
- durable result persistence.

В production Web Worker не должен требовать активного Harness turn в течение всей генерации ChatGPT.

---

## 3. GitHub policy

GitHub в новом production path используется как READ-источник для внешнего ChatGPT.

Разрешённая роль:

```text
ChatGPT Web -> GitHub READ -> source files / docs / branch / commit
```

Не является обязательной частью возврата результата:

```text
NO required update_issue
NO required comment
NO required commit
NO required PR
NO required GitHub READY
NO required Actions wakeup
```

Если позже GitHub wakeup будет нужен как дополнительный audit/out-of-process signal, это должно быть отдельным optional layer, а не обязательной частью result delivery.

---

## 4. Временный ручной цикл разработки

До автоматизации роль Postman между Web ChatGPT и локальной Luna выполняет пользователь.

```text
Web ChatGPT
   |
   | reads GitHub, creates implementation package
   v
WP-XXX.zip
   |
   v
manual handoff
   |
   v
Local Luna
   |
   +-- validate package
   +-- apply in controlled way
   +-- run tests
   +-- create result report
   |
   v
manual handoff
   |
   v
Web ChatGPT
   |
   +-- PASS
   +-- or next repair ZIP
```

Ручной цикл нужен для того, чтобы сначала доказать contracts и implementation steps без зависимости от ещё не готового Web Postman.

Пакеты нумеруются:

```text
WP-001
WP-002
WP-003
...
```

---

## 5. Implementation ZIP contract

Для разработки нового Web Postman Web ChatGPT возвращает один implementation package:

```text
WP-001.zip
|-- manifest.json
|-- changes.patch
|-- files/
|   `-- <repo-relative new/full files>
|-- instructions.md
`-- expected-tests.md
```

### `changes.patch`

Используется преимущественно для существующих текстовых файлов.

Цели:

- уменьшить объём результата;
- уменьшить количество токенов, нужных Luna для review;
- явно показать изменения;
- дать `git apply --check`/эквивалентный fail-safe.

### `files/`

Используется для:

- новых файлов;
- бинарных файлов;
- файлов, полностью переписанных настолько, что patch не даёт преимущества.

Все пути строго repo-relative.

### `manifest.json`

Минимальный контракт:

```json
{
  "protocolVersion": 1,
  "packageId": "WP-001",
  "repository": "AndrewVerhoturov1/dsh-workspace",
  "branch": "postman/web-postman-v1",
  "baseCommit": "<sha>",
  "resultType": "hybrid_patch",
  "patch": "changes.patch",
  "files": [],
  "allowedPaths": [],
  "expectedTests": []
}
```

Runtime/Luna не должны доверять package metadata без проверки против ожидаемого request context.

---

## 6. Luna package intake contract

Luna не должна распаковывать ZIP непосредственно поверх рабочего repo.

Обязательная последовательность:

```text
ZIP_RECEIVED
  -> ZIP_VALIDATED
  -> BASE_COMMIT_CONFIRMED
  -> PATCH_CHECK
  -> STAGING_APPLY
  -> DIFF_REVIEW
  -> WORKTREE_APPLY
  -> TESTS
  -> REPORT
```

До `ZIP_VALIDATED` изменения workspace запрещены.

Минимальные проверки:

- настоящий ZIP;
- non-empty;
- bounded archive size;
- bounded entry count;
- bounded total uncompressed size;
- bounded compression ratio;
- no `..` traversal;
- no absolute Unix paths;
- no Windows drive paths;
- no UNC paths;
- no NTFS ADS;
- no symlinks/reparse-like unsafe entries;
- no Windows reserved names;
- no case-insensitive path collisions;
- valid UTF-8 `manifest.json`;
- exact package/request id;
- exact repository;
- exact branch;
- exact base commit;
- allowed-path compliance;
- result type from whitelist.

---

## 7. Luna result report

После применения/проверки Luna должна возвращать компактный result package или `report.md`.

Рекомендуемый полный формат:

```text
WP-001-RESULT.zip
|-- result.json
|-- report.md
|-- final.diff
`-- logs/
    |-- tests.txt
    `-- diagnostics.txt
```

Пример `result.json`:

```json
{
  "packageId": "WP-001",
  "status": "PASS",
  "baseCommit": "<sha>",
  "resultCommit": "<sha-or-empty>",
  "testsPassed": 42,
  "testsFailed": 0,
  "warnings": []
}
```

При простой ошибке достаточно текстового `report.md`. При сложной ошибке нужен result ZIP с logs/diagnostics.

---

## 8. Core safety invariants

### No duplicate send on uncertainty

```text
PROVEN_NOT_SENT -> resend may be allowed
PROVEN_SENT     -> never automatically resend
UNKNOWN         -> PROMPT_SEND_UNKNOWN -> inspect/recover, no blind resend
```

Наличие/отсутствие `/c/...` URL само по себе не является правом на повторную отправку.

### No response search before confirmed user message

```text
no confirmed user message
=
no right to correlate/search assistant result
```

### Trusted request correlation

Runtime заранее знает:

- request id;
- expected repository;
- expected branch/base commit;
- expected artifact filename;
- owned Page/job;
- prompt SHA;
- origin agent from DB.

Model text может быть сигналом, но не authority.

### No generic page-wide attachment selection

Запрещён production detector вида:

```text
".zip somewhere in body"
"last Download button on page"
```

Нужна корреляция с конкретным assistant turn.

### Postman never auto-applies repository changes

Web Postman заканчивает транспорт на `RESULT_DURABLE`/`READY`.

Применяет изменения только рабочий Harness Agent после inspect/staging/tests.

---

# 9. План реализации

## P0 — contracts и skeleton

Создать/зафиксировать:

- `docs/web-postman-implementation-plan.md`;
- `docs/web-postman-artifact-contract.md`;
- initial module/test layout;
- error/state vocabulary;
- browser ownership rules;
- recovery invariants.

Код браузера на этом шаге не требуется.

### PASS P0

- contracts однозначны;
- paths/module ownership определены;
- нет зависимости от GitHub write;
- нет зависимости от Desktop UIA.

---

## P1 — artifact validator

Первый production-quality код.

Предполагаемый layout:

```text
postman/web/
|-- artifact-validator.mjs
`-- test-artifact-validator.mjs
```

Или другой layout, если существующая структура проекта требует иного размещения.

API должен быть явным и детерминированным, например:

```text
validateArtifact(zipPath, expectedRequest)
```

Успех:

```text
ARTIFACT_VALID
```

Пример ошибок:

```text
ARTIFACT_BAD_ZIP
ARTIFACT_EMPTY
ARTIFACT_MANIFEST_MISSING
ARTIFACT_MANIFEST_INVALID
ARTIFACT_REQUEST_MISMATCH
ARTIFACT_REPOSITORY_MISMATCH
ARTIFACT_BRANCH_MISMATCH
ARTIFACT_BASE_COMMIT_MISMATCH
ARTIFACT_PATH_TRAVERSAL
ARTIFACT_ABSOLUTE_PATH
ARTIFACT_NTFS_ADS
ARTIFACT_SYMLINK
ARTIFACT_CASE_COLLISION
ARTIFACT_RESERVED_NAME
ARTIFACT_SIZE_LIMIT
ARTIFACT_UNCOMPRESSED_SIZE_LIMIT
ARTIFACT_COMPRESSION_RATIO_LIMIT
ARTIFACT_ENTRY_COUNT_LIMIT
ARTIFACT_SCOPE_VIOLATION
```

### Обязательные негативные tests

- `../evil.txt`;
- `C:/evil.txt`;
- `/evil.txt`;
- UNC path;
- `foo.txt:$DATA`;
- `README.md` + `readme.md`;
- symlink entry;
- Windows reserved names;
- wrong request/package id;
- wrong repository;
- wrong branch;
- wrong base commit;
- missing manifest;
- invalid JSON;
- fake `.zip`;
- empty ZIP;
- archive over size limit;
- too many entries;
- excessive uncompressed size;
- suspicious compression ratio;
- file outside allowed scope.

### PASS P1

Validator полностью проверяется без браузера и fail-closed на неизвестных/опасных состояниях.

---

## P2 — Browser Bootstrap

Пока без отправки prompt.

Цепочка:

```text
Chrome
  -> remote debugging
  -> Playwright connect_over_cdp
  -> dedicated Page
  -> chatgpt.com
  -> session/login check
  -> composer confirmed
```

Профиль Postman должен быть отдельным от пользовательского браузера, например:

```text
%LOCALAPPDATA%\DSH\Postman\browser-profile
```

Каталог этого выделенного профиля является durable browser identity для Web
Postman. Он переживает Chrome restart и несёт локальное session/browser state.

Не являются durable identity:

- PID процесса Chrome;
- текущий CDP WebSocket URL;
- Page id/handle;
- номер конкретного запуска worker.

Профиль является чувствительным локальным состоянием: его нельзя помещать в
repository, artifact ZIP или diagnostics dump целиком.

Первичная авторизация выполняется пользователем вручную.

Запрещена автоматизация:

- password;
- 2FA;
- CAPTCHA.

### Browser ownership

Attach-mode worker:

- создаёт dedicated Page;
- не использует пользовательскую existing Page;
- закрывает только принадлежащую ему Page;
- не закрывает внешний browser/context.

### Проверки P2

- foreground browser;
- background browser;
- minimized browser;
- другая вкладка foreground;
- повторный attach;
- worker restart;
- Chrome restart + reattach.

### PASS P2

Минимум 10/10 успешных browser/session/composer probes без отправки сообщений.

---

## P3 — Fresh Chat + Submit

Цепочка proof:

```text
PAGE_OWNED
  -> FRESH_CHAT_CONFIRMED
  -> COMPOSER_EMPTY_CONFIRMED
  -> PROMPT_INSERTED
  -> PROMPT_SEND_STARTED
  -> PROMPT_SEND_CONFIRMED
  -> CHAT_URL_BOUND
```

Fresh chat не должен считаться подтверждённым только потому, что homepage composer виден.

Нужно отличать:

- composer ready;
- fresh conversation proof;
- prompt delivery proof;
- chat URL correlation.

### PASS P3

- 10 последовательных fresh submits;
- 0 duplicate sends;
- 0 stale conversation sends;
- explicit `PROMPT_SEND_UNKNOWN` при неопределённости.

---

## P4 — Assistant Turn Observer

Пока без скачивания ZIP.

Состояния:

```text
ASSISTANT_TURN_STARTED
ASSISTANT_TURN_STREAMING
ASSISTANT_TURN_COMPLETED
```

Observer должен связывать:

```text
our confirmed user turn
-> next assistant turn
```

Не использовать body-wide text как главный источник корреляции.

### Test cases

- короткий текст;
- длинный текст;
- code block;
- несколько code blocks;
- Unicode/Cyrillic;
- долгий reasoning delay;
- background tab;
- minimized browser;
- previous assistant attachments already present.

### PASS P4

10/10 корректного определения именно нового assistant turn и его завершения.

---

## P5 — Artifact DOM detection

Worker заранее знает expected artifact filename, например:

```text
POSTMAN_REQ_<REQ>_RESULT.zip
```

Допустимый detection proof:

```text
owned Page
+
confirmed request/user turn
+
next completed assistant turn
+
exact result envelope/request id
+
exact expected filename
+
attachment/download control inside same assistant turn
```

Текстовый READY marker — полезный сигнал, но не заменяет attachment proof.

### PASS P5

- 10/10 correct artifact detection;
- stale ZIP from previous turn не принимается;
- wrong filename rejected;
- same filename outside correlated assistant turn rejected;
- unrelated Download buttons ignored.

---

## P6 — Download + validation

После `ARTIFACT_DOM_CONFIRMED`:

```text
page.expect_download()
  -> semantic click on exact correlated attachment
  -> browser download event
  -> save_as(controlled staging path)
  -> DOWNLOAD_COMPLETED
  -> validator
  -> SHA-256
  -> atomic move to durable store
```

Result store:

```text
%LOCALAPPDATA%\DSH\Postman\results\<REQ>\
|-- result.zip
|-- manifest.json
|-- validation.json
`-- metadata.json
```

### PASS P6

Контролируемый artifact probe проходит end-to-end минимум 10/10.

---

## P7 — Single-request Web Worker E2E

Полная state machine одного запроса:

```text
REQUEST_ACCEPTED

BROWSER_JOB_CREATED
TAB_CREATED
FRESH_CHAT_CONFIRMED

PROMPT_PREPARED
PROMPT_INSERTED
PROMPT_SEND_STARTED
PROMPT_SEND_CONFIRMED
CHAT_URL_BOUND

ASSISTANT_TURN_STARTED
ASSISTANT_TURN_STREAMING
ASSISTANT_TURN_COMPLETED

RESULT_DECLARED
ARTIFACT_DOM_CONFIRMED
DOWNLOAD_STARTING
DOWNLOAD_STARTED
DOWNLOAD_COMPLETED

ARTIFACT_VALIDATING
ARTIFACT_VALID

RESULT_DURABLE
READY
```

Отдельные unknown/failure states:

```text
PROMPT_SEND_UNKNOWN
CHAT_CORRELATION_LOST
ASSISTANT_STATE_UNKNOWN
ARTIFACT_MISMATCH
DOWNLOAD_INTERRUPTED
DOWNLOAD_NOT_FOUND
ARTIFACT_INVALID
```

### PASS P7

Один реальный запрос end-to-end минимум 10/10.

---

## P8 — Crash/restart recovery

Worker намеренно завершается после разных стадий:

- `TAB_CREATED`;
- `PROMPT_INSERTED`;
- `PROMPT_SEND_CONFIRMED`;
- `ASSISTANT_TURN_STREAMING`;
- `ASSISTANT_TURN_COMPLETED`;
- `DOWNLOAD_STARTED`;
- `DOWNLOAD_COMPLETED`;
- `ARTIFACT_VALID`.

После restart:

```text
load durable state
-> inspect browser/chat/result
-> resume from proven state
```

### Critical acceptance

После подтверждённого Send prompt не отправляется повторно.

### PASS P8

- 0 duplicate prompts;
- completed result не теряется;
- interrupted download либо безопасно resume/restart download, либо получает точное failure state;
- corrupted partial file не принимается.

---

## P9 — Persistent Web Worker

После single-process E2E runner превращается в постоянный service/worker:

```text
Web Postman Worker
|-- job queue
|-- Chrome/CDP connection
|-- Page registry
|-- durable worker journal
`-- recovery loop
```

Harness/POSTMAN session может завершить текущий turn, пока ChatGPT продолжает работу.

### PASS P9

- request продолжает обрабатываться без активного Harness turn;
- результат durable после завершения;
- worker restart восстанавливает pending jobs.

---

## P10 — интеграция с существующим M4–M5 Postman Runtime

Только после самостоятельного Web Worker E2E.

Цепочка:

```text
Agent A
-> POSTMAN
-> Runtime REQ registration
-> Web Worker job
-> ChatGPT Web
-> result ZIP
-> RESULT_DURABLE
-> DB READY
-> POSTMAN wake/resume
-> Agent A
```

Trusted routing:

```text
REQ -> origin_agent_id
```

берётся только из Runtime DB.

### PASS P10

Single-agent live E2E через настоящий Harness.

---

## P11 — concurrency = 2

Mapping:

```text
REQ_A -> Page A
REQ_B -> Page B
```

Test cases:

- A start -> B start -> A complete -> B complete;
- A start -> B start -> B complete -> A complete;
- A slow, B fast;
- A invalid ZIP, B valid ZIP;
- worker restart while both active;
- duplicate-ready/result processing attempts.

### PASS P11

0 cross-delivery и 0 cross-download/correlation.

---

## P12 — concurrency >= 3

Постепенно:

```text
3 -> 4 -> 5
```

Не предполагать заранее, что 10 background tabs будут работать стабильно.

Конфиг:

```text
maxConcurrentWebRequests
```

должен быть ограниченным и настраиваемым.

Измерять:

- answer latency;
- background throttling;
- download reliability;
- memory;
- browser stability;
- ChatGPT rate/usage effects.

---

## P13 — реальные coding workloads

После transport hardening протестировать три класса задач.

### Small patch

- 1 existing file;
- 10–30 changed lines.

### Hybrid

- несколько existing files через patch;
- 1+ new files целиком.

### Larger change

- несколько files;
- tests;
- docs.

Измерять:

- ZIP size;
- patch bytes;
- full-file bytes;
- Luna context/token use;
- apply/test time;
- revision count;
- quality.

На основе измерений определить правила `patch vs full file`, а не задавать их только теоретически.

---

## P14 — security/hardening

Перед production cutover:

- no private ChatGPT API;
- no password/2FA/CAPTCHA automation;
- no token scraping;
- no arbitrary artifact execution;
- staging-only ZIP extraction;
- symlink/path/ADS/collision protection;
- zip bomb bounds;
- exact REQ correlation;
- prompt SHA;
- artifact SHA;
- bounded timeouts;
- browser/Page ownership;
- fail-closed unknown states;
- lifecycle tests;
- secret scan;
- deterministic logs/journal.

---

## P15 — production cutover

Web Postman становится production transport только после доказательства:

```text
single-agent PASS
A+B PASS
reverse completion PASS
duplicate suppression PASS
worker restart PASS
Chrome restart PASS
Harness offline/restart PASS
bad ZIP reject PASS
wrong artifact reject PASS
0 cross-delivery
```

После cutover:

```text
Web Postman = primary transport
Desktop transport = fallback / diagnostics
GitHub-write M6 = historical/reference prototype
```

Старые пути сразу не удалять.

---

# 10. Durable request/browser correlation

Для каждого REQ runtime/worker должен хранить минимум:

```text
request_id
worker_job_id
browser profile/context identity
owned page identity (ephemeral)
chat_url (durable when available)
prompt_sha256
expected_artifact_filename
expected repository
expected branch
expected base commit
result_path
result_sha256
state
```

Ephemeral Page/tab id не является durable authority после browser restart.

Recovery опирается на комбинацию:

```text
REQ
+ prompt SHA
+ known chat URL
+ expected artifact filename
+ artifact manifest
+ local result SHA
```

---

# 11. Result artifact contract для production Web Postman

Предпочтительный coding result:

```text
POSTMAN_REQ_<REQ>_RESULT.zip
|-- manifest.json
|-- changes.patch
`-- files/
    `-- <repo-relative new/full files>
```

`manifest.json` должен включать trusted-comparable fields:

```json
{
  "protocolVersion": 1,
  "requestId": "REQ_...",
  "repository": "owner/repo",
  "branch": "branch-name",
  "baseCommit": "sha",
  "resultType": "hybrid_patch",
  "patch": "changes.patch",
  "files": []
}
```

Runtime генерирует expected values сам и сравнивает их с artifact. Model-provided значения не могут заменить runtime context.

---

# 12. Наблюдаемость и диагностика

Каждый этап должен давать machine-readable event.

Минимальные категории:

```text
browser lifecycle
page ownership
fresh proof
composer state
prompt insertion
send proof
chat URL binding
assistant turn lifecycle
artifact detection
browser download lifecycle
artifact validation
result persistence
recovery decision
runtime READY/delivery
```

Полезные diagnostics для browser failures:

- DOM snapshot;
- bounded screenshot только как diagnostic artifact;
- current URL;
- owned Page metadata;
- relevant locator counts/names;
- download metadata;
- state/event journal.

Diagnostics не должны ослаблять production correlation rules.

---

# 13. Первый практический набор итераций

Первоначальный цикл implementation packages:

```text
WP-001
-> contracts + skeleton directories/modules/tests

WP-002
-> artifact validator + comprehensive unit tests

WP-003
-> Chrome/CDP login/session/composer bootstrap probe

WP-004
-> real ChatGPT artifact detection + browser download probe
```

Только после PASS этих итераций строится полный single-request worker.

---

# 14. Порядок принятия изменений

Для каждого `WP-XXX`:

1. Web ChatGPT читает GitHub branch + exact base commit.
2. Возвращает один implementation ZIP, без GitHub writes.
3. Luna валидирует package.
4. Luna проверяет base commit и local changes; пользовательские unrelated changes не трогаются.
5. Patch/new files применяются через staging/controlled apply.
6. Запускаются expected tests + project gates.
7. Luna формирует report/result package.
8. Web ChatGPT анализирует report.
9. Только после PASS фиксируется commit и начинается следующий `WP-XXX`.

Нельзя:

- `git reset --hard`;
- `git clean`;
- broad destructive stash;
- перезаписывать unrelated local changes;
- включать secrets;
- автоматически менять пользовательский `settings.yaml`.

---

# 15. Первый шаг после этого документа

Первым рабочим этапом является **WP-001**, но он должен быть маленьким.

WP-001 должен:

1. проверить actual layout ветки `postman/web-postman-v1`;
2. создать `docs/web-postman-artifact-contract.md`;
3. создать минимальный `postman/web/` module/test skeleton;
4. зафиксировать state/error constants/contracts, необходимые P1;
5. не реализовывать Playwright/browser automation;
6. не менять M4–M5 runtime без необходимости;
7. не переносить zworker-auto целиком;
8. подготовить точный acceptance checklist для WP-002 validator.

Причина: сначала стабилизируется формат результата и границы модулей. Browser automation начинается только после того, как artifact intake fail-closed и хорошо тестируется.

После PASS WP-001 следующий пакет — WP-002 с полноценным artifact validator.
