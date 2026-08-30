# Postman: artifact result transport через ChatGPT Desktop

## Статус

Это **концепция / design note**, а не реализованный production contract.

Текущий приоритет проекта остаётся за завершением Postman M6. Эта схема фиксируется отдельно, чтобы не потерять направление развития после обнаружения того, что authenticated write из обычного ChatGPT в GitHub может быть разрешён, запрошен через Work или заблокирован платформенным safety layer в зависимости от контекста.

Ключевая идея: **GitHub остаётся источником кода для внешнего ChatGPT, но не обязательным каналом записи результата.** Внешний ChatGPT занимается reasoning и формированием результата, а Postman получает результат из самого ChatGPT Desktop как текст, patch или ZIP-artifact и сохраняет его локально.

---

## 1. Цель

Разделить reasoning и side effects:

```text
GitHub repository
      │
      │ READ
      ▼
ordinary ChatGPT
      │
      │ reasoning / code generation
      ▼
TEXT / PATCH / ZIP
      │
      ▼
POSTMAN
      │
      ├── validates
      ├── stores durable result
      └── delivers to origin Harness Agent
```

Внешний ChatGPT не обязан:

- менять GitHub Issue;
- создавать commit;
- push-ить branch;
- редактировать workspace;
- выполнять другие внешние write actions.

GitHub нужен ему прежде всего как **read source / vision of the repository**.

---

## 2. Почему artifact transport рассматривается отдельно

Текущий M6 исторически использует GitHub Issue как внешний transport/wakeup contract:

```text
ChatGPT
→ update Issue to READY
→ GitHub Actions
→ Windows runner
→ durable signal
→ Postman Runtime
```

Практика показала, что write из ordinary ChatGPT может быть недетерминированным с точки зрения разрешения платформой:

```text
same conceptual write
→ ALLOW
или
→ ask to continue in Work
или
→ BLOCK
```

Для критического transport path это нежелательно.

Artifact transport переносит обязательный результат обратно в детерминированную локальную инфраструктуру Postman:

```text
ChatGPT response/artifact
→ Postman extracts/downloads it
→ local durable result store
→ origin Agent
```

---

## 3. Типы результата

Предлагаемый базовый contract:

```text
RESULT_TEXT
RESULT_PATCH
RESULT_ZIP
```

### 3.1 TEXT

Для анализа, объяснений, research и небольших фрагментов кода.

### 3.2 PATCH

Для компактных изменений существующих текстовых файлов.

Предпочтительный формат — unified diff.

Пример:

```diff
--- a/src/foo.js
+++ b/src/foo.js
@@
-old
+new
```

Patch экономнее полного файла для локального Harness Agent, потому что агенту достаточно читать только изменённые участки и контекст.

### 3.3 ZIP

Для больших кодовых результатов, нескольких файлов, новых файлов, бинарных данных или hybrid result.

ZIP является **контейнером результата**, а не обязательно архивом полных файлов.

---

## 4. Рекомендуемый hybrid ZIP

Основной вариант:

```text
POSTMAN_REQ_<REQ>_RESULT.zip
│
├── manifest.json
├── changes.patch
└── files/
    ├── src/new-file.js
    └── assets/new-binary.dat
```

Принцип:

- существующие текстовые файлы → обычно `changes.patch`;
- новые файлы → полные файлы в `files/`;
- бинарные файлы → полные файлы в `files/`;
- полностью переписанный файл можно передать целиком, если patch почти не даёт экономии.

Это позволяет уменьшить количество текста, которое позже придётся читать локальной модели.

---

## 5. Manifest contract

Пример `manifest.json`:

```json
{
  "protocolVersion": 1,
  "requestId": "REQ_123",
  "repository": "AndrewVerhoturov1/dsh-workspace",
  "baseCommit": "abc123",
  "resultType": "hybrid_patch",
  "patch": "changes.patch",
  "files": [
    "src/new-file.js"
  ],
  "deletedFiles": []
}
```

Минимально обязательные поля:

```text
protocolVersion
requestId
repository
baseCommit
resultType
```

`baseCommit` нужен, чтобы Harness не применил patch к другой версии исходников.

Перед применением:

```text
local HEAD == manifest.baseCommit
```

Если нет:

```text
BASE_COMMIT_MISMATCH
```

и автоматическое применение запрещается.

---

## 6. Artifact naming contract

Ожидаемое имя:

```text
POSTMAN_REQ_<requestId>_RESULT.zip
```

Например:

```text
POSTMAN_REQ_REQ_67A8658C_RESULT.zip
```

Точный naming contract ещё нужно нормализовать, чтобы не дублировать `REQ_`; это design note, а не финальный wire format.

Важнее сам принцип: filename должен однозначно коррелировать с `requestId`.

---

## 7. Text envelope рядом с artifact

Внешнему ChatGPT предлагается возвращать короткий machine-readable envelope рядом с attachment:

```text
POSTMAN_ARTIFACT_V1
request_id: REQ_123
artifact_type: zip
filename: POSTMAN_REQ_123_RESULT.zip
```

Postman не должен считать любой ZIP в ChatGPT правильным результатом.

Для `ARTIFACT_CONFIRMED` нужны одновременно:

```text
correct ChatGPT conversation
+
correct assistant turn
+
exact request_id
+
POSTMAN_ARTIFACT_V1
+
expected filename
+
attachment control in the same assistant message container
```

---

## 8. Как Postman должен находить artifact

Не использовать координаты.

Сначала нужно провести реальный UIA probe и определить фактическую структуру attachment в ChatGPT Desktop Beta.

Возможные control types нельзя предполагать заранее. Нужно выяснить:

- `ControlType`;
- accessible name;
- AutomationId;
- `InvokePattern`;
- `ValuePattern`;
- отдельная ли есть кнопка Download;
- появляется ли Windows Save As;
- принадлежит ли artifact тому же assistant message container.

После этого пишется deterministic detector.

---

## 9. Download flow

### Вариант A — direct Invoke/download

```text
ARTIFACT_CONFIRMED
→ InvokePattern
→ download
→ stable file observed
```

До Invoke Postman делает snapshot staging/download directory.

После Invoke ожидается **точный expected filename**, а не любой новый файл.

Завершение download подтверждается, например, двумя последовательными чтениями с одинаковым размером файла.

### Вариант B — Save As

Если появляется системный Save As:

```text
attachment Invoke
→ exact Save As dialog confirmed
→ set controlled staging path through semantic UIA
→ semantic Save
```

Запрещены координатные клики.

Предлагаемый staging root:

```text
%LOCALAPPDATA%\DSH\Postman\incoming\
```

---

## 10. Durable local result store

После download результат переносится в отдельное durable storage:

```text
%LOCALAPPDATA%\DSH\Postman\results\
└── REQ_123\
    ├── result.zip
    └── metadata.json
```

Пример metadata:

```json
{
  "requestId": "REQ_123",
  "resultType": "zip",
  "sha256": "...",
  "status": "READY"
}
```

Большой patch или ZIP не обязан попадать в GitHub Issue.

---

## 11. Validation после download

После появления ZIP на диске UIA больше не участвует.

Postman Runtime должен детерминированно проверить:

1. файл существует;
2. размер > 0;
3. download завершён;
4. SHA-256 рассчитан;
5. ZIP корректно открывается;
6. `manifest.json` существует;
7. `manifest.requestId == expected requestId`;
8. repository совпадает;
9. baseCommit соответствует ожидаемой базе;
10. resultType разрешён;
11. archive paths безопасны.

После успешной проверки:

```text
ARTIFACT_VALIDATED
```

---

## 12. Archive security

ZIP никогда не распаковывается прямо поверх рабочего repository.

Запрещённые пути:

```text
..\..
C:\...
/Windows/...
absolute paths
UNC paths
path traversal
```

Порядок применения:

```text
ZIP
→ isolated staging directory
→ validate paths / manifest / hashes
→ inspect diff
→ Harness Agent review
→ apply/copy into workspace
→ tests
```

Внешний ChatGPT не получает прямого права изменять рабочий repository.

---

## 13. Correlation

Нужна многоуровневая проверка:

```text
Postman REQ
   ==
text envelope requestId
   ==
filename requestId
   ==
manifest requestId
```

После download добавляется:

```text
resultSha256
```

SHA идентифицирует конкретный полученный artifact.

---

## 14. Экономия контекста локальной модели

Цель hybrid artifact — не заставлять локального агента перечитывать полные файлы без необходимости.

Пример:

```text
исходные файлы:       10 000 строк
реальное изменение:       80 строк
```

Полные файлы могут потребовать тысячи токенов.

`changes.patch` содержит только изменённые участки и ограниченный контекст, поэтому для локальной модели обычно дешевле.

При этом новые файлы разумно передавать целиком.

Итоговый принцип:

```text
small textual change → PATCH
many/new/binary files → ZIP
ZIP internally → PATCH + only necessary full files
```

---

## 15. Proposed result lifecycle

```text
Harness Agent
→ POSTMAN
→ ordinary ChatGPT
→ GitHub READ for source context
→ reasoning
→ assistant turn completed
→ TEXT / PATCH / ZIP artifact
→ Postman detects result
→ download/extract
→ validate
→ durable result store
→ POSTMAN_RESULT
→ exact origin Harness Agent
→ staging/apply/tests
```

Routing authority остаётся Postman DB:

```text
REQ → originAgentId
```

Ни текст ChatGPT, ни filename, ни manifest не имеют права сами выбирать origin agent.

---

## 16. Relation to GitHub

В этой концепции GitHub сохраняет две полезные роли.

### Read source

Внешний ChatGPT читает repository, исходники, документацию и историю, если это доступно через подключённый GitHub.

### Optional infrastructure signal

Если позже нужен GitHub wakeup, его можно генерировать детерминированным локальным Postman Runtime после успешной локальной валидации результата.

Но обязательный production result transport не должен зависеть от того, разрешит ли ordinary ChatGPT внешний `update_issue`.

---

## 17. Post-submit observer

Artifact transport требует доказать состояния:

```text
CHAT_SUBMIT_CONFIRMED
ASSISTANT_TURN_STARTED
ASSISTANT_TURN_COMPLETED
RESULT_DETECTED
ARTIFACT_CONFIRMED        # для ZIP
ARTIFACT_DOWNLOADED
ARTIFACT_VALIDATED
RESULT_DURABLE
RESULT_DELIVERED
```

Optional modal handlers, например Work prompt, остаются отдельными deterministic handlers внутри post-submit observer.

---

## 18. Fail-closed states

Примеры:

```text
ASSISTANT_TURN_NOT_STARTED
ASSISTANT_TURN_STALLED
ASSISTANT_TURN_ERROR
UNKNOWN_POST_SUBMIT_BLOCKER
ARTIFACT_NOT_FOUND
ARTIFACT_FILENAME_MISMATCH
ARTIFACT_REQUEST_ID_MISMATCH
ARTIFACT_DOWNLOAD_FAILED
ARTIFACT_INVALID_ZIP
ARTIFACT_PATH_TRAVERSAL
BASE_COMMIT_MISMATCH
RESULT_HASH_MISMATCH
```

При любом таком состоянии не применять результат в workspace автоматически.

---

## 19. Минимальный эксперимент до архитектурного перехода

Не переписывать весь M6 под ZIP заранее.

Сначала выполнить отдельный controlled probe.

Внешнему ChatGPT дать простую задачу:

```text
Создай ZIP с:

src/a.txt = AAA
tests/b.txt = BBB

Добавь manifest.json.
Верни artifact с заранее заданным requestId и filename.
```

Доказать:

```text
assistant artifact appears
→ UIA detects exact attachment
→ download is invoked semantically
→ file appears locally
→ download completion confirmed
→ ZIP opens
→ manifest matches REQ
→ expected files match
→ SHA-256 stable
```

Повторить 5–10 раз.

До этого `RESULT_ZIP` считать experimental.

---

## 20. Acceptance criteria для artifact transport

Минимум:

- exact assistant turn correlation;
- no coordinate clicks;
- exact filename correlation;
- exact manifest correlation;
- deterministic download completion proof;
- SHA-256 result identity;
- safe archive path validation;
- no direct extraction into repository;
- base commit guard для patches;
- durable local storage;
- delivery only through DB `REQ → originAgentId`;
- Computer Use не нужен в production success path.

---

## 21. Не решено пока

Нужно экспериментально определить:

1. Может ли ordinary ChatGPT Desktop стабильно создавать downloadable ZIP artifact в нужном режиме.
2. Как attachment представлен в реальном UIA tree текущей ChatGPT Desktop Beta.
3. Какой download flow используется: direct download, Save As или иной.
4. Можно ли гарантированно сопоставить attachment с конкретным assistant message container.
5. Максимальный практический размер artifact.
6. Нужно ли поддерживать multipart artifacts.
7. Как лучше кодировать результат для не-code задач.
8. Нужен ли GitHub wakeup после перехода на локальный durable result или можно будить Postman напрямую локальным runtime event.

---

## 22. Архитектурный принцип

Главная граница ответственности:

```text
External ChatGPT
= reasoning + proposed result

POSTMAN
= transport + correlation + persistence + validation

Harness Agent
= workspace mutation + verification + tests
```

Это снижает зависимость production transport от внешних write permissions и оставляет реальные side effects под контролем локальной детерминированной инфраструктуры.
