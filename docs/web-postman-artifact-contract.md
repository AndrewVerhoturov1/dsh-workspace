# Web Postman — контракт результата и artifact transport

## 0. Статус документа

Этот документ является каноническим контрактом результата будущего Web Postman.

WP-001 фиксирует только формат результата, границы доверия, правила корреляции,
валидацию, хранение и ожидаемое поведение будущих модулей. Реализация браузерного
worker, Playwright/CDP, скачивания, SQLite-интеграции и применения изменений в
workspace в этот milestone не входит.

Базовый принцип:

```text
External ChatGPT
= reasoning + proposed result

Web Postman Worker
= browser transport + correlation + download

Postman Runtime
= durable trusted request/result state + routing authority

Harness Agent
= inspect + staging + workspace mutation + tests

GitHub
= READ source
```

Внешний ChatGPT, текст ответа, имя файла и `manifest.json` не являются authority
для маршрутизации результата.

---

## 1. Классы результата

Web Postman должен поддерживать три транспортных класса.

### 1.1. TEXT result

`TEXT` предназначен для анализа, объяснений, research и других результатов,
которые не требуют изменения файлов.

Текст сохраняется как результат конкретного запроса, уже известного Postman
Runtime. Текст не имеет права задавать `origin_agent_id`, destination session
или другую маршрутизацию.

Для TEXT не требуется ZIP manifest.

### 1.2. PATCH result

`PATCH` предназначен для небольших изменений существующих текстовых файлов.

Формат patch:

- unified diff;
- пути только repo-relative;
- без `C:\...`;
- без `/absolute/path`;
- без UNC;
- без выхода через `..`;
- точный `baseCommit` обязателен;
- patch не применяется Web Postman автоматически.

Patch сначала сохраняется как proposed result. Затем Harness Agent проверяет
точную базу, область изменений и корректность patch в staging/check режиме и
только после этого может явно применить его в workspace.

### 1.3. ZIP / HYBRID result

Для coding workloads предпочтительным artifact является ZIP:

```text
POSTMAN_<requestId>_RESULT.zip
├── manifest.json
├── changes.patch          # для patch/hybrid
└── files/
    └── <repo-relative new/full files>
```

Для `requestId = REQ_ABC123` точное ожидаемое имя:

```text
POSTMAN_REQ_ABC123_RESULT.zip
```

То есть имя строит Postman Runtime как:

```text
"POSTMAN_" + requestId + "_RESULT.zip"
```

Runtime заранее знает exact expected filename. Имя, предложенное моделью,
не может переопределить ожидаемое имя.

Логика payload:

- существующие текстовые файлы обычно передаются через `changes.patch`;
- новые файлы обычно передаются целиком под `files/`;
- binary передаётся целиком под `files/`;
- сильно переписанный файл может передаваться целиком, если это разумнее diff;
- ZIP никогда не применяется напрямую поверх repository.

---

## 2. Граница доверия

### 2.1. Trusted request metadata

Authority берётся только из Postman Runtime. До приёма результата Runtime должен
знать минимум:

```text
requestId
repository
baseCommit
expectedArtifactFilename
allowedPaths
forbiddenPaths
origin_agent_id
```

При необходимости Runtime также знает `readRef`/branch, prompt SHA-256 и
идентичность browser job/Page.

### 2.2. Untrusted model metadata

Следующие данные считаются недоверенными, пока не проверены:

- `manifest.json`;
- текст assistant response;
- READY marker;
- имя attachment, показанное страницей;
- `generatedAt`;
- description;
- model-written content inventory;
- branch/readRef, записанные моделью.

`manifest.json` — это данные внешнего LLM, а не команда доверенной системе.

### 2.3. Запрещённая routing authority

Artifact и assistant response не имеют права задавать или менять:

```text
origin_agent_id
destination_agent_id
destination_session
delivery_target
runtime request ownership
```

Если такие поля присутствуют, они не используются для routing. В зависимости
от будущей schema policy неизвестные authority-like поля могут быть отклонены
как invalid manifest.

### 2.4. Временные метки

`generatedAt` допускается только как diagnostic metadata.

Временная метка:

- не является correlation key;
- не определяет «самый новый правильный» artifact;
- не подтверждает принадлежность REQ;
- не заменяет requestId, Page/turn correlation, filename, SHA-256 или durable state.

---

## 3. Manifest contract

### 3.1. Обязательные поля

Для ZIP artifact `manifest.json` находится ровно в корне архива и содержит
минимум:

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

Обязательная семантика:

| Поле | Правило |
|---|---|
| `protocolVersion` | integer; для первой версии строго `1` |
| `requestId` | string; exact match trusted Runtime requestId |
| `repository` | string `owner/repo`; exact match trusted Runtime repository |
| `baseCommit` | полный 40-символьный Git SHA; exact match expected base |
| `resultType` | только значение из whitelist |
| `patch` | `"changes.patch"` для patch/hybrid; `null` для files-only |
| `files` | массив repo-relative target paths; пустой только для pure patch |

`baseCommit` проверяется для всех code artifacts. Для результата, содержащего
patch, mismatch всегда является hard reject и запрещает применение.

### 3.2. `resultType` whitelist

Для ZIP manifest разрешены только:

```text
patch
files
hybrid_patch
```

Контракт:

| `resultType` | `patch` | `files` |
|---|---|---|
| `patch` | `"changes.patch"` | `[]` |
| `files` | `null` | минимум 1 путь |
| `hybrid_patch` | `"changes.patch"` | минимум 1 путь |

TEXT — отдельный транспортный класс и не является ZIP `resultType`.

Неизвестное значение = `ARTIFACT_RESULT_TYPE_INVALID`.

### 3.3. Семантика `files`

Каждый элемент `files[]` — repo-relative target path, например:

```json
{
  "files": [
    "docs/new-document.md",
    "assets/icon.bin"
  ]
}
```

Соответствующие ZIP entries:

```text
files/docs/new-document.md
files/assets/icon.bin
```

Manifest не может расширять trusted `allowedPaths`.

### 3.4. Дополнительные поля

Допускаются, если schema их явно разрешает:

```text
readRef
branch
generatedAt
description
inventory
```

Рекомендуемый optional `inventory` может содержать diagnostic сведения:

```json
{
  "inventory": [
    {
      "path": "docs/new-document.md",
      "kind": "full_file",
      "sha256": "<sha256>",
      "size": 1234
    }
  ]
}
```

Даже при наличии hashes внутри manifest окончательный SHA-256 ZIP и при
необходимости hashes entries вычисляет trusted validator.

---

## 4. ZIP layout contract

Разрешённая логическая структура:

```text
manifest.json
changes.patch
files/**
```

Правила:

1. `manifest.json` — ровно один, в корне.
2. `changes.patch` разрешён только когда он требуется `resultType`.
3. Full/new files находятся только под `files/`.
4. Repo-relative target path вычисляется удалением единственного префикса
   `files/`.
5. Неожиданные payload entries вне этого layout отклоняются.
6. Directory entries разрешимы только как безопасные родители допустимых files.
7. Сам manifest не считается доверенным allowlist.

---

## 5. Fail-closed ZIP validation

Validator работает до extraction и до любых repository writes.

Если состояние нельзя доказать безопасным, результат отклоняется.

### 5.1. Минимальные hard reject conditions

Hard reject обязателен для:

- файл отсутствует или не является настоящим ZIP;
- ZIP пуст;
- отсутствует `manifest.json`;
- manifest невалиден или не соответствует schema;
- абсолютный Unix path;
- Windows drive path;
- UNC path;
- `..` traversal;
- NTFS Alternate Data Stream;
- symlink entry;
- reparse-like unsafe entry, если тип можно обнаружить;
- duplicate normalized path;
- case-insensitive collision;
- Unicode-normalization collision;
- Windows reserved device name;
- path segment с опасным trailing dot/space на Windows;
- path вне trusted allowlist;
- trusted forbidden path;
- wrong `requestId`;
- wrong repository;
- wrong `baseCommit`;
- wrong `protocolVersion`;
- unexpected `resultType`;
- wrong exact artifact filename;
- отсутствующий payload, на который ссылается manifest;
- excessive compressed ZIP size;
- excessive total uncompressed size;
- excessive per-entry uncompressed size;
- excessive entry count;
- suspicious compression ratio / zip-bomb condition;
- malformed patch;
- patch scope violation.

### 5.2. Нормализация путей

До сравнения область пути должна быть вычислена детерминированно.

Рекомендуемый алгоритм:

1. Работать с raw ZIP member name и не доверять библиотечной extraction.
2. Reject NUL/control characters, которые делают path неоднозначным.
3. Обнаружить raw UNC и Windows drive path до любой нормализации.
4. Канонизировать separator к `/` только для анализа.
5. Reject leading `/`.
6. Reject empty, `.` и `..` path segments.
7. Привести Unicode к NFC для ключа сравнения.
8. Построить exact normalized key.
9. Построить Windows collision key через Unicode NFC + `casefold()`.
10. Reject exact duplicate normalized key.
11. Reject любой collision Windows key между различными entries.
12. Проверить reserved names, trailing dot/space и ADS semantics.
13. Только после этого проверять trusted allowlist/forbiddenPaths.

На Windows:

```text
docs/readme.md
docs/README.md
```

= `ARTIFACT_CASE_COLLISION`, hard reject.

Это намеренное усиление относительно старого Route W: его validator фиксирует
case-insensitive duplicates как warning и может вернуть
`accepted_with_warnings`. Web Postman не наследует это поведение.

### 5.3. Symlink и file type

Validator должен принимать только обычные файлы и безопасные directory entries.

Если ZIP metadata показывает Unix symlink mode, entry отклоняется:

```text
ARTIFACT_SYMLINK
```

Если обнаружимы reparse/device/special-file semantics, они также отклоняются.

Нельзя считать entry безопасным только потому, что его имя выглядит безопасно.

### 5.4. Initial configurable limits

Это начальные operational defaults, а не доказанная security theorem.

Рекомендуемая стартовая конфигурация:

| Ограничение | Initial default |
|---|---:|
| compressed ZIP file size | 50 MiB |
| total uncompressed size | 200 MiB |
| per-entry uncompressed size | 64 MiB |
| total entries, включая directory entries | 2000 |
| per-entry compression ratio | 100:1 |
| aggregate compression ratio | 100:1 |

Причины:

- 50 MiB сохраняет уже использовавшийся в Route W порядок величины для
  compressed archive;
- 200 MiB даёт ограниченный запас для нескольких исходников/binary;
- 64 MiB не позволяет одной entry поглотить весь uncompressed budget;
- 2000 entries достаточно для coding package, но ограничивает metadata bombs;
- ratio 100:1 — консервативный начальный сигнал zip-bomb риска.

Все limits должны быть настраиваемыми и тестируемыми. Увеличение limits не
должно происходить из model manifest.

### 5.5. Проверка размеров и ratio

До extraction validator суммирует central-directory metadata и проверяет:

```text
archive_file_size <= maxCompressedBytes
sum(entry.uncompressed_size) <= maxTotalUncompressedBytes
entry.uncompressed_size <= maxEntryUncompressedBytes
entry_count <= maxEntries
entry_ratio <= maxCompressionRatio
aggregate_ratio <= maxCompressionRatio
```

Нулевой compressed size при ненулевом uncompressed content рассматривается как
подозрительный случай и не должен обходить ratio guard.

Нельзя полагаться только на заявленные размеры после начала extraction:
extraction вообще не должна начинаться до прохождения path/type/size checks.

---

## 6. Trusted scope contract

`allowedPaths` и `forbiddenPaths` приходят из trusted Runtime request context.

Manifest может описать content, но не может расширить scope.

Порядок:

```text
normalized target path
→ forbiddenPaths check
→ allowedPaths check
→ manifest consistency check
```

`forbiddenPaths` имеет приоритет над `allowedPaths`.

Для конкретного request Runtime может запрещать, например:

```text
settings.yaml
attachments/
.ai/
browser profiles
runtime state
local diagnostics
```

Глобальный validator не должен самовольно считать `package.json`,
lockfiles или `.github/` всегда запрещёнными: такие production paths могут быть
легитимны в другой явно разрешённой задаче. Их разрешение определяется trusted
request policy.

---

## 7. PATCH contract

### 7.1. Формат

Patch должен быть unified diff.

Все file paths:

- repo-relative;
- без drive letters;
- без absolute roots;
- без UNC;
- без traversal;
- после нормализации должны попадать в trusted `allowedPaths`;
- не должны попадать в trusted `forbiddenPaths`.

Patch headers и rename/copy metadata должны проверяться по обеим сторонам
изменения.

### 7.2. Base commit

Для patch:

```text
artifact.baseCommit == Runtime.expectedBaseCommit
```

Иначе:

```text
ARTIFACT_BASE_COMMIT_MISMATCH
```

и fail closed.

### 7.3. Применение

Web Postman не редактирует workspace.

Правильная последовательность:

```text
PATCH_RECEIVED
→ structural validation
→ RESULT_DURABLE
→ Harness Agent receives handle/path
→ repository preflight
→ exact base confirmation
→ staging / git apply --check equivalent
→ diff review
→ explicit Harness apply
→ tests
```

`git apply` или аналог не запускается browser worker.

Malformed patch:

```text
ARTIFACT_PATCH_INVALID
```

Patch, который выходит за trusted scope:

```text
ARTIFACT_SCOPE_VIOLATION
```

---

## 8. Browser correlation contract

Artifact нельзя искать по правилам вида:

```text
".zip где-то на странице"
"последняя кнопка Download"
"любой Download после появления READY"
```

До разрешения download должны одновременно существовать proofs:

```text
known REQ
+
owned browser Page
+
known submitted user turn
+
following assistant turn
+
assistant turn completion
+
exact expected filename
+
attachment/download control inside that same assistant turn
```

Дополнительно могут использоваться:

```text
prompt SHA-256
persisted chat URL
request markers inside the correlated assistant turn
```

Но они не заменяют ownership/turn proof.

### 8.1. READY marker

Текстовый READY marker — дополнительный diagnostic/correlation signal.

Он не является proof результата.

### 8.2. Download proof

Настоящий transport proof:

```text
download event completed
+
bytes saved to request-scoped path
+
artifact validator PASS
+
SHA-256 calculated
+
validation metadata persisted
+
durable result metadata persisted
```

Только после этого возможен `RESULT_DURABLE`.

### 8.3. Browser ownership

Будущий attach-mode worker должен:

- использовать headful Chrome;
- подключаться через CDP;
- создавать dedicated Page для принадлежащего ему job/REQ;
- не использовать пользовательскую existing Page как owned Page;
- закрывать только созданную им Page;
- не закрывать externally-owned browser/context.

Route W уже доказал практичность `connect_over_cdp`, dedicated `context.new_page()`
и `page.expect_download()`. Web Postman сохраняет эти идеи, но вводит более
строгую turn-level artifact correlation.

---

## 9. SEND / recovery contract

Критический инвариант:

```text
SEND_UNKNOWN != RESEND
```

Решение о повторной отправке строится на доказательствах.

### 9.1. Proof send did not happen

Если есть доказательство, что send не произошёл:

```text
PROVEN_NOT_SENT
→ retry may be allowed
```

Примеры будущих доказательств должны быть формализованы worker tests; простого
«нет `/c/...` URL» недостаточно.

### 9.2. Proof send happened

Если send подтверждён любым durable evidence:

```text
PROVEN_SENT
→ automatic resend forbidden
```

Подтверждение может включать persisted `PROMPT_SENT`, `prompt_sent_at`,
наблюдённый user turn, bound chat URL или более позднее состояние.

### 9.3. State uncertain

Если нельзя доказать ни sent, ни not-sent:

```text
PROMPT_SEND_UNKNOWN
→ recovery / inspection
→ NO BLIND RESEND
```

Отсутствие valid `/c/...` URL не является разрешением на resend.

Это намеренно сильнее старого Route W. В его state helper блокировка resend
зависит от `has_prompt_been_sent()` вместе с наличием valid `chat_url` в
`require_prompt_send_allowed()`. Поэтому следы send при потерянном/невалидном
chat URL недостаточны для безусловной блокировки. Web Postman обязан fail-close
в такой неопределённости.

### 9.4. Recovery after confirmed send

После подтверждённого send conversation восстанавливается по persisted state:

```text
REQ
+ prompt SHA-256
+ owned job identity
+ known/persisted chat URL when available
+ observed user turn identity when available
+ expected artifact filename
```

Recovery не выполняется повторной отправкой исходного prompt.

Fresh homepage composer не является доказательством нового conversation.

---

## 10. Durable result store

Предлагаемый root:

```text
%LOCALAPPDATA%\DSH\Postman\results\<REQ>\
├── result.zip
├── validation.json
├── metadata.json
└── staging\
```

`staging/` существует только как request-scoped временная/проверяемая область и
не является workspace.

### 10.1. Lifecycle

```text
DOWNLOAD_COMPLETED
→ ARTIFACT_VALIDATING
→ ARTIFACT_VALID
→ RESULT_DURABLE
```

Рекомендуемая последовательность:

1. Browser download сохраняет raw bytes в deterministic request-scoped staging.
2. Никакой extraction в repository не выполняется.
3. Validator проверяет ZIP, manifest, paths, scope, limits и patch structure.
4. Вычисляется SHA-256 raw ZIP.
5. После PASS raw ZIP атомарно фиксируется как `result.zip`.
6. `validation.json` и `metadata.json` записываются атомарно.
7. Только когда durable metadata подтверждает полный набор файлов, state
   становится `RESULT_DURABLE`.
8. Originating Harness Agent получает только handle/path на durable result.

### 10.2. `validation.json`

Минимально содержит trusted validator output:

```json
{
  "status": "ARTIFACT_VALID",
  "requestId": "REQ_...",
  "sha256": "<sha256>",
  "validatedProtocolVersion": 1,
  "errors": [],
  "warnings": [],
  "inventory": []
}
```

### 10.3. `metadata.json`

Минимально содержит runtime-derived identity:

```json
{
  "requestId": "REQ_...",
  "repository": "owner/repo",
  "baseCommit": "<sha>",
  "expectedFilename": "POSTMAN_REQ_..._RESULT.zip",
  "resultSha256": "<sha256>",
  "state": "RESULT_DURABLE"
}
```

`origin_agent_id` при необходимости хранится только как Runtime-owned поле и
никогда не импортируется из model artifact.

---

## 11. Error taxonomy

Коды ошибок — стабильные machine-readable identifiers. Человеческое сообщение
может меняться, код — нет без versioned contract change.

### 11.1. Artifact / validator errors

```text
ARTIFACT_BAD_ZIP
ARTIFACT_EMPTY
ARTIFACT_FILENAME_MISMATCH

ARTIFACT_MANIFEST_MISSING
ARTIFACT_MANIFEST_INVALID
ARTIFACT_PROTOCOL_VERSION_MISMATCH
ARTIFACT_REQUEST_MISMATCH
ARTIFACT_REPOSITORY_MISMATCH
ARTIFACT_BASE_COMMIT_MISMATCH
ARTIFACT_RESULT_TYPE_INVALID
ARTIFACT_PAYLOAD_MISSING

ARTIFACT_PATH_TRAVERSAL
ARTIFACT_ABSOLUTE_PATH
ARTIFACT_WINDOWS_DRIVE_PATH
ARTIFACT_UNC_PATH
ARTIFACT_NTFS_ADS
ARTIFACT_SYMLINK
ARTIFACT_REPARSE_ENTRY
ARTIFACT_DUPLICATE_PATH
ARTIFACT_CASE_COLLISION
ARTIFACT_WINDOWS_RESERVED_NAME
ARTIFACT_PATH_INVALID
ARTIFACT_SCOPE_VIOLATION
ARTIFACT_FORBIDDEN_PATH

ARTIFACT_COMPRESSED_SIZE_LIMIT
ARTIFACT_UNCOMPRESSED_SIZE_LIMIT
ARTIFACT_ENTRY_SIZE_LIMIT
ARTIFACT_ENTRY_LIMIT
ARTIFACT_ZIP_BOMB_RISK

ARTIFACT_PATCH_INVALID
```

### 11.2. Future browser errors

```text
BROWSER_NOT_AVAILABLE
BROWSER_LOGIN_REQUIRED
BROWSER_PAGE_NOT_OWNED
BROWSER_FRESH_CHAT_NOT_CONFIRMED
BROWSER_COMPOSER_NOT_READY
BROWSER_PROMPT_INSERT_NOT_CONFIRMED
BROWSER_PROMPT_SEND_NOT_CONFIRMED
BROWSER_PROMPT_SEND_UNKNOWN
BROWSER_CHAT_URL_NOT_BOUND
BROWSER_ASSISTANT_TURN_NOT_FOUND
BROWSER_ASSISTANT_TURN_TIMEOUT
BROWSER_ARTIFACT_DOM_NOT_CONFIRMED
BROWSER_DOWNLOAD_NOT_STARTED
BROWSER_DOWNLOAD_INTERRUPTED
BROWSER_DOWNLOAD_TIMEOUT
```

Browser errors не разрешают routing и не должны автоматически превращаться в
resend.

---

## 12. WP-002 validator acceptance matrix

Следующий milestone должен реализовать validator без повторного архитектурного
проектирования. Для каждого invalid case unit test обязан проверять exact error
code.

### 12.1. Valid cases

| Test | Ожидаемый результат |
|---|---|
| valid manifest + patch | `ARTIFACT_VALID` |
| valid manifest + one new file | `ARTIFACT_VALID` |
| valid hybrid patch + files | `ARTIFACT_VALID` |
| безопасное Cyrillic/Unicode имя | `ARTIFACT_VALID` |
| nested repo-relative paths | `ARTIFACT_VALID` |
| безопасные explicit directory entries | `ARTIFACT_VALID` |

Пример безопасного Unicode target:

```text
docs/тест/данные.md
```

### 12.2. Invalid cases and exact codes

| Test fixture | Expected code |
|---|---|
| fake `.zip` bytes | `ARTIFACT_BAD_ZIP` |
| zero-byte file | `ARTIFACT_EMPTY` |
| valid empty ZIP | `ARTIFACT_EMPTY` |
| missing root `manifest.json` | `ARTIFACT_MANIFEST_MISSING` |
| malformed manifest JSON | `ARTIFACT_MANIFEST_INVALID` |
| manifest wrong field type/schema | `ARTIFACT_MANIFEST_INVALID` |
| wrong `protocolVersion` | `ARTIFACT_PROTOCOL_VERSION_MISMATCH` |
| wrong `requestId` | `ARTIFACT_REQUEST_MISMATCH` |
| wrong `repository` | `ARTIFACT_REPOSITORY_MISMATCH` |
| wrong `baseCommit` | `ARTIFACT_BASE_COMMIT_MISMATCH` |
| unknown `resultType` | `ARTIFACT_RESULT_TYPE_INVALID` |
| manifest references missing `changes.patch` | `ARTIFACT_PAYLOAD_MISSING` |
| manifest references missing `files[]` entry | `ARTIFACT_PAYLOAD_MISSING` |
| wrong archive filename | `ARTIFACT_FILENAME_MISMATCH` |
| `../evil` | `ARTIFACT_PATH_TRAVERSAL` |
| `files/a/../../evil` | `ARTIFACT_PATH_TRAVERSAL` |
| `/absolute` | `ARTIFACT_ABSOLUTE_PATH` |
| `C:/absolute` | `ARTIFACT_WINDOWS_DRIVE_PATH` |
| `C:\absolute` | `ARTIFACT_WINDOWS_DRIVE_PATH` |
| `\\server\share\evil` | `ARTIFACT_UNC_PATH` |
| `//server/share/evil` | `ARTIFACT_UNC_PATH` |
| `files/foo.txt:$DATA` | `ARTIFACT_NTFS_ADS` |
| symlink ZIP entry | `ARTIFACT_SYMLINK` |
| detectable reparse/special entry | `ARTIFACT_REPARSE_ENTRY` |
| exact duplicate normalized path | `ARTIFACT_DUPLICATE_PATH` |
| `files/docs/readme.md` + `files/docs/README.md` | `ARTIFACT_CASE_COLLISION` |
| NFC-equivalent Unicode path collision | `ARTIFACT_CASE_COLLISION` |
| Windows reserved target such as `files/CON` | `ARTIFACT_WINDOWS_RESERVED_NAME` |
| trailing dot/space aliasing path | `ARTIFACT_PATH_INVALID` |
| NUL/control path ambiguity | `ARTIFACT_PATH_INVALID` |
| path outside trusted allowlist | `ARTIFACT_SCOPE_VIOLATION` |
| path under trusted forbidden path | `ARTIFACT_FORBIDDEN_PATH` |
| actual ZIP file size exceeds configured limit | `ARTIFACT_COMPRESSED_SIZE_LIMIT` |
| total uncompressed bytes exceed limit | `ARTIFACT_UNCOMPRESSED_SIZE_LIMIT` |
| one entry exceeds per-entry limit | `ARTIFACT_ENTRY_SIZE_LIMIT` |
| too many entries | `ARTIFACT_ENTRY_LIMIT` |
| pathological per-entry ratio | `ARTIFACT_ZIP_BOMB_RISK` |
| pathological aggregate ratio | `ARTIFACT_ZIP_BOMB_RISK` |
| malformed unified diff | `ARTIFACT_PATCH_INVALID` |
| patch has absolute/drive/traversal path | соответствующий path error |
| patch touches outside allowlist | `ARTIFACT_SCOPE_VIOLATION` |
| patch touches forbidden path | `ARTIFACT_FORBIDDEN_PATH` |

### 12.3. Determinism requirements for WP-002

Каждый test должен доказывать:

- один и тот же input + trusted expected request даёт один и тот же decision;
- validator не требует browser;
- validator не требует network;
- validator не меняет workspace;
- validator не извлекает archive поверх repo;
- первый hard-reject code выбирается по документированному deterministic order;
- warnings не могут превратить hard reject в accepted result;
- case-insensitive collision никогда не является warning-only.

Рекомендуемый порядок категорий, чтобы tests не зависели от случайной
очерёдности:

```text
file existence/basic ZIP
→ exact filename
→ central directory / entry type / path safety / limits
→ manifest presence + schema
→ trusted identity comparisons
→ payload consistency
→ trusted scope
→ patch validation
→ success
```

---

## 13. Что Web Postman не делает

Web Postman transport не должен:

- выбирать origin agent;
- применять patch в repository;
- копировать `files/` в workspace;
- автоматически merge/commit/push;
- создавать GitHub write side effects;
- исполнять содержимое artifact;
- считать assistant READY proof достаточным;
- выбирать «последний ZIP на странице»;
- извлекать ZIP до fail-closed validation;
- выполнять blind resend при неопределённом send state.

---

## 14. Связь с Route W reference

В WP-001 используются только проверенные идеи reference implementation:

- headful Google Chrome;
- отдельный authenticated profile;
- Playwright CDP attach-mode;
- dedicated Page в attached context;
- `page.expect_download()` для browser download event;
- persisted `run_state.json`, `events.jsonl`, `chat_url`;
- prompt SHA-256;
- resume state;
- ZIP pre-validation.

При этом Web Postman намеренно не копирует слабые места reference:

- generic body-wide ZIP detection не считается достаточной correlation;
- «последний Download» не считается допустимым production selection;
- case-insensitive path collision — hard reject;
- потеря valid chat URL после следов send не разрешает blind resend;
- Runtime metadata, а не model output, является authority.

---

## 15. Инварианты P0

До перехода к WP-002 считаются зафиксированными следующие инварианты:

```text
GitHub = READ source

Runtime metadata = trusted
model metadata = untrusted until validated

exact REQ
+ exact repository
+ exact baseCommit
+ exact filename
+ owned Page
+ correlated assistant turn
= correlation prerequisites

download complete
+ validator PASS
+ SHA-256
+ durable metadata
= result proof

SEND_UNKNOWN != RESEND

Web Postman != workspace mutation

case-insensitive collision = hard reject
```

Любое изменение этих правил требует явного versioned contract update.
