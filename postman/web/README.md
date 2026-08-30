# `postman/web/` — границы будущего Web Postman

## Статус

WP-001 создаёт только skeleton/module-boundary document.

В этом каталоге пока не должно быть browser implementation, Playwright
dependencies, production state machine, ZIP extraction/application code или
интеграции с существующим Postman Runtime.

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
├── artifact-validator.*
├── browser-worker.*
├── browser-state.*
├── artifact-download.*
├── result-store.*
└── tests/
```

Эти implementation files в WP-001 **не создаются**.

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

WP-002 реализует этот модуль и unit tests по acceptance matrix из artifact
contract.

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

WP-002 начинает только с artifact validator unit tests и не требует browser.

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

## WP-001 запреты

В этом milestone не добавлять:

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
- dependencies.

Следующий milestone: WP-002 — deterministic fail-closed artifact validator.
