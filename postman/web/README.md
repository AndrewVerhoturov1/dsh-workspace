# `postman/web/` — границы будущего Web Postman

## Статус

WP-001 зафиксировал contracts и module boundaries. WP-002 добавляет первый
production-quality модуль: детерминированный fail-closed artifact validator и
его unit tests.

В WP-002 по-прежнему нет browser implementation, Playwright dependencies,
production state machine, ZIP extraction/application code или интеграции с
существующим Postman Runtime.

Канонический контракт artifact/result transport находится в
`docs/web-postman-artifact-contract.md`.

## Целевая роль

Будущий поток:

```text
Postman Runtime
→ browser-worker
→ browser-state
→ ChatGPT Web on owned Page
→ artifact-download
→ artifact-validator
→ result-store
→ Postman Runtime READY
```

Ни один модуль под `postman/web/` не является routing authority.

Trusted mapping:

```text
REQ → origin_agent_id
```

остаётся ответственностью Postman Runtime.

---

## Предполагаемая структура

```text
postman/web/
├── artifact-validator.mjs
├── browser-worker.*
├── browser-state.*
├── artifact-download.*
├── result-store.*
└── tests/
    └── artifact-validator.test.mjs
```

В WP-002 реализованы только `artifact-validator.mjs` и его unit tests.
Остальные implementation modules остаются будущими.

---

## `artifact-validator`

Ответственность:

- максимально pure/deterministic validation;
- проверка ZIP container до extraction;
- exact expected filename;
- manifest schema/version;
- trusted `requestId` / repository / baseCommit comparison;
- resultType whitelist;
- normalized path safety;
- symlink/reparse/special entry rejection;
- duplicate/case/Unicode collision rejection;
- trusted allowed/forbidden scope;
- compressed/uncompressed/entry/ratio limits;
- patch structure/scope validation;
- SHA-256 и безопасный content inventory.

Предполагаемый вход:

```text
validateArtifact(zipPath, expectedRequest)
```

Где `expectedRequest` формируется trusted Runtime и содержит ожидаемые identity,
scope и limits.

Предполагаемый выход:

```text
ValidationResult
├── ok
├── code
├── sha256
├── inventory
├── warnings
└── details
```

Ограничения:

- без browser;
- без network;
- без routing;
- без workspace writes;
- без extraction поверх repo;
- один input должен давать детерминированный decision.

WP-002 реализует модуль без сторонних зависимостей. Он использует только
стандартные модули Node.js и не требует `package.json` в `postman/web/`.

Unit tests запускаются напрямую:

```powershell
node --test postman/web/tests/artifact-validator.test.mjs
```

Validator читает ZIP как недоверенные bytes, проверяет central/local headers,
CRC, SHA-256, типы entries, path aliases/collisions, limits, manifest, trusted
scope и unified diff до любого применения результата в workspace.

ZIP не извлекается поверх repository.

---

## `browser-worker`

Ответственность только за browser orchestration:

- connect/reattach к headful Chrome через CDP;
- создание owned dedicated Page;
- login/session readiness;
- fresh-chat proof;
- composer readiness;
- prompt insertion/send proof;
- assistant turn lifecycle;
- вызов artifact-download после строгой correlation;
- recovery orchestration по persisted browser-state.

Не отвечает за:

- origin routing;
- application patch/files;
- GitHub writes;
- validation policy internals;
- durable result storage internals.

Worker не должен использовать existing user Page как owned job Page и не должен
закрывать externally-owned browser/context.

---

## `browser-state`

Ответственность за persisted browser/request state.

Минимальные будущие данные:

```text
requestId
workerJobId
state
promptSha256
expectedArtifactFilename
chatUrl
owned-page correlation metadata
send evidence
assistant-turn correlation metadata
download evidence
lastError
```

Важные инварианты:

```text
PROMPT_SEND_UNKNOWN -> no blind resend
PROVEN_SENT -> no automatic resend
```

State должен переживать worker restart. Ephemeral Page handle сам по себе не
является durable identity.

`browser-state` не хранит model-provided routing authority.

---

## `artifact-download`

Ответственность:

```text
exact correlated assistant attachment
→ Playwright expect_download lifecycle
→ controlled request-scoped staging path
→ DOWNLOAD_COMPLETED
```

Этот модуль получает уже доказанный assistant-turn/attachment handle от
browser-worker.

Запрещено:

- искать любой `.zip` по всему body;
- выбирать последнюю Download button;
- считать READY marker proof;
- принимать файл с неправильным exact filename;
- применять или распаковывать ZIP в repository.

После download модуль передаёт raw path validator/result-store flow.

---

## `result-store`

Ответственность за durable local persistence:

```text
%LOCALAPPDATA%\DSH\Postman\results\<REQ>\
├── result.zip
├── validation.json
├── metadata.json
└── staging\
```

Обязан:

- сохранять raw result детерминированно;
- обеспечивать request-scoped paths;
- использовать атомарную фиксацию metadata;
- хранить calculated SHA-256;
- различать downloaded, validated и durable states;
- выдавать handle только после `RESULT_DURABLE`.

Не отвечает за routing decision и не применяет result к workspace.

---

## `tests/`

Будущие тесты делятся минимум на:

```text
artifact validator unit tests
browser-state unit tests
browser correlation tests
download lifecycle tests
recovery tests
single-request E2E
concurrency/cross-correlation tests
```

WP-002 содержит artifact validator unit tests и не требует browser/network.
Acceptance matrix включает exact machine-readable error codes для invalid
fixtures. Case-insensitive и Unicode-NFC collisions являются hard reject, а не
warning.

---

## Межмодульные границы

### Browser transport не валидирует policy «по памяти»

`browser-worker` и `artifact-download` не должны дублировать ZIP security rules.
Они передают raw artifact в `artifact-validator`.

### Validator не знает browser

`artifact-validator` не знает DOM, Page, ChatGPT, CDP или send state.

### Result store не выбирает получателя

`result-store` хранит результат конкретного REQ, но не решает, какому Harness
Agent его доставить.

### Runtime остаётся authority

Только Postman Runtime владеет trusted request metadata и
`REQ → origin_agent_id`.

### Harness единственный применяет изменения

Web Postman заканчивает работу на validated/durable result. Inspect, staging,
apply и tests выполняет originating Harness Agent.

---

## WP-002 границы

В этом milestone не добавляются:

- Playwright runner;
- Chrome automation;
- CDP connection code;
- browser worker implementation;
- artifact download implementation;
- SQLite integration;
- Harness integration;
- production state machine implementation;
- ZIP extraction/application code;
- browser profiles;
- runtime state;
- diagnostics dumps;
- новые runtime dependencies.

Следующий milestone после PASS WP-002: WP-003 — Chrome/CDP
login/session/composer bootstrap probe без отправки production prompt.

---

## WP-003 — Browser Bootstrap

WP-003 добавляет `browser_bootstrap.py` и unit tests для P2 browser bootstrap.

Граница этого milestone:

```text
Chrome/CDP
→ Playwright connect_over_cdp
→ dedicated owned Page
→ chatgpt.com
→ manual session/login check
→ visible composer
```

WP-003 не отправляет prompt, не ищет assistant turn и не скачивает artifacts.
В attach-mode модуль не переиспользует существующую Page и не закрывает
externally-owned browser/context. Профиль по умолчанию находится вне repository:
`%LOCALAPPDATA%\\DSH\\Postman\\browser-profile`.

### Постоянная идентичность браузера

Для Web Postman постоянной идентичностью browser session является **каталог
выделенного Chrome-профиля**, а не PID конкретного процесса Chrome:

```text
%LOCALAPPDATA%\\DSH\\Postman\\browser-profile
```

Профиль переживает закрытие и новый запуск Chrome и сохраняет локальное browser
state, необходимое для повторного использования уже авторизованной сессии.
PID процесса, CDP WebSocket URL и идентификаторы Page являются временными
атрибутами конкретного запуска и не должны использоваться как durable identity.

Обычный повторный запуск:

```powershell
python postman/web/browser_bootstrap.py --launch-chrome --timeout-ms 30000
```

Код Web Postman не вводит и не обрабатывает пароль, 2FA или CAPTCHA. При этом
сам Chrome-профиль содержит cookies/session tokens и другое чувствительное
локальное browser state. Поэтому профиль должен оставаться вне repository,
не должен коммититься, прикладываться к artifact ZIP или целиком попадать в
диагностические отчёты.

---

## WP-004 — Fresh Chat + Submit

WP-004 добавляет `browser_submit.py` и unit tests для P3 transport boundary.

Перед отправкой worker обязан доказать одновременно:

```text
PAGE_OWNED
→ root chatgpt.com route
→ zero current conversation turns
→ visible empty composer
→ FRESH_CHAT_CONFIRMED
→ COMPOSER_EMPTY_CONFIRMED
```

Один только видимый homepage composer не считается достаточным доказательством
fresh chat.

После вставки prompt проверяется его точный текст и SHA-256. Затем разрешена
ровно одна попытка Send. После начала click запрещены Enter-fallback и
автоматический повтор.

Успешная отправка требует одновременного доказательства:

```text
exactly one new user turn with exact prompt text
+ empty composer
+ new bound /c/... URL
= PROMPT_SEND_CONFIRMED
```

Если после начала Send хотя бы одно из этих доказательств отсутствует или
результат click неопределён, состояние — `PROMPT_SEND_UNKNOWN`. Такой prompt
автоматически повторно не отправляется.

WP-004 ещё не наблюдает assistant turn, не ищет attachments и не скачивает ZIP.
Persistent restart recovery для Send state остаётся отдельным последующим
