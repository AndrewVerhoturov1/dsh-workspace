---
name: delegate-via-postman
description: Делегировать явно запрошенную implementation-задачу во внешний Web ChatGPT через Direct Web Postman. Использовать, когда пользователь явно выбирает Postman как transport. Не активировать Postman автоматически только из-за сложности задачи.
---

# Delegate via Postman — Direct Bridge

## Purpose

Postman использует прямой production bridge по принципу QChat:

```text
User
→ Luna (Л1)
→ postman/direct/postman.ps1
→ postman/direct/postman_direct.py
→ GitHub intent task
→ dedicated Postman Chrome/CDP
→ external Web ChatGPT (Ч1)
→ validated implementation ZIP
→ JSON result to Luna
→ Luna applies/tests/commits/reports
```

`dsh-postman-harness`, persistent POSTMAN agent, `postman_async_send`, Runtime
wakeup/callback и Cordis plugin resolution **не являются production path** этого
skill. Старый код может оставаться в репозитории для истории/совместимости.

## Roles

### Ч1 — external architect / implementation author

Ч1 отвечает за:

- анализ пользовательского намерения;
- выбор архитектуры и технологий;
- код;
- тесты;
- документацию при необходимости;
- создание одного implementation ZIP по Postman artifact policy.

### Л1 — local implementation agent

Л1 отвечает за:

- создание canonical REQ;
- передачу точного пользовательского намерения в Direct Postman;
- получение только подтверждённого validated ZIP;
- проверку совместимости результата с текущим checkout;
- применение ZIP;
- локальные тесты;
- commit/PR;
- итоговый отчёт пользователю.

Л1 не должна до отправки Ч1 самостоятельно выбирать framework, архитектуру,
структуру файлов, дизайн-систему или расширять требования пользователя.

## Trigger

Используй этот skill, когда пользователь явно выбирает Postman как transport,
например:

- `Postman, сделай ...`
- `Через Postman сделай ...`
- `Используй Postman для ...`
- `Отправь через Postman ...`

Если Postman не запрошен явно, не активируй его самостоятельно.

`QChat` — отдельный transport и не является fallback для Postman.

## Canonical request ID

Перед единственным production-вызовом создай:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

На Windows:

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$suffix = (Get-Random -Minimum 0 -Maximum 10000).ToString("0000")
$requestId = "REQ_${stamp}_${suffix}"
```

REQ после начала transport immutable.

Один логический запрос → один REQ.

Нельзя автоматически создавать новый REQ после того, как Direct Postman мог
опубликовать task или отправить prompt.

## Intent preservation

Передай пользовательскую задачу максимально близко к исходному тексту.

Главный инвариант:

> Л1 не превращает короткое намерение пользователя в собственное техническое ТЗ.

Например пользовательское:

```text
Postman, сделай простой калькулятор в древне-японском стиле.
```

не должно превращаться до Ч1 в требования вроде:

- React/Vue/Svelte;
- обязательная адаптивность;
- конкретный набор операций;
- обработка деления на ноль;
- конкретные цвета/шрифты;
- структура директорий;
- test framework;
- архитектура приложения.

Можно удалить только управляющую формулировку выбора transport, если это не
меняет смысл. Допустимо также передать исходный текст целиком; важнее не
добавлять новых требований.

## Production bridge

Canonical bridge:

```text
C:\Users\andre\.dsh\postman\direct\postman.ps1
```

Нормальный вызов:

```powershell
$bridge = 'C:\Users\andre\.dsh\postman\direct\postman.ps1'
$jsonText = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $bridge `
  -RequestId $requestId `
  -Task $payload
$result = $jsonText | ConvertFrom-Json
```

Не вызывать для production path:

```text
postman_async_send
postman_send
postman_runtime_*
Playwright MCP
Computer Use
ручной запуск Chrome
ручную навигацию ChatGPT
```

Direct bridge сам:

1. валидирует REQ;
2. публикует intent-only `<REQ>.md` в GitHub `main`;
3. фиксирует publication SHA как trusted `baseCommit`;
4. формирует transport prompt с exact REQ/repository/baseCommit/filename/scope;
5. запускает или переиспользует dedicated Postman Chrome;
6. выполняет существующий browser-first pipeline;
7. скачивает и валидирует ZIP;
8. сохраняет durable result;
9. возвращает один JSON object.

## Dedicated Chrome

Direct Postman использует только специальный Chrome transport:

```text
CDP: http://127.0.0.1:9222
profile: %LOCALAPPDATA%\DSH\Postman\browser-profile
```

Если CDP уже доступен — Chrome переиспользуется.
Если нет — bridge сам находит установленный Google Chrome и запускает его с
выделенным profile directory.

Не устанавливать и не использовать Playwright MCP Chromium как замену.

## Browser smoke

Для диагностики transport без публикации task и без prompt:

```powershell
& pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `
  C:\Users\andre\.dsh\postman\direct\postman.ps1 `
  -BrowserSmoke
```

Успех:

```text
ok = true
code = BROWSER_SMOKE_READY
promptSent = false
```

## Result success

Production success существует только если JSON одновременно подтверждает:

```text
ok = true
code = RESULT_DURABLE
requestId = exact REQ
resultZip = non-empty path
```

Дополнительно сверить:

- `expectedFilename` содержит exact REQ;
- `taskUrl` принадлежит exact REQ;
- `baseCommit` — полный 40-hex SHA;
- файл `resultZip` физически существует;
- manifest/validation уже опубликованы durable Web Postman pipeline.

Не принимать обычный текст внешнего ChatGPT вместо ZIP для implementation-задачи.

## Apply result

Direct Postman **не применяет ZIP автоматически**.

После `RESULT_DURABLE` Л1:

1. читает manifest результата;
2. сверяет exact REQ/repository/baseCommit;
3. убеждается, что текущий checkout совместим с baseCommit;
4. применяет `changes.patch`/`files/` штатным способом;
5. запускает проектные тесты;
6. делает commit/PR;
7. докладывает пользователю.

Не переписывать решение Ч1 самостоятельно, чтобы скрыть несовместимость ZIP.
Если пакет нельзя безопасно применить — остановиться и доложить точный blocker.

## Failure handling

Если bridge вернул `ok=false`:

- сохранить exact REQ;
- не создавать второй REQ автоматически;
- не открывать ChatGPT вручную;
- не брать визуально найденный ответ;
- сообщить пользователю code/error/details.

Если state-файл exact REQ уже существует, Direct Postman блокирует автоматический
resend (`DIRECT_REQUEST_EXISTS`). Это fail-closed защита от двойной отправки.

## Artifact contract

Canonical public policy:

```text
https://raw.githubusercontent.com/AndrewVerhoturov1/agents-andrew-instructions/main/policies/postman-webchat-result-artifact.md
```

Для одного ZIP exact filename:

```text
POSTMAN_<REQ>_RESULT.zip
```

Direct Postman сам передаёт Ч1 trusted:

```text
requestId
repository
baseCommit
expectedFilename
allowedPaths
forbiddenPaths
```

и existing validator проверяет их после скачивания.

## Safety invariants

1. Postman только по явному запросу.
2. Один logical request → один immutable REQ.
3. Л1 не расширяет пользовательское ТЗ до Ч1.
4. Production path идёт напрямую через `postman/direct/postman.ps1`.
5. Cordis `dsh-postman-harness` не является production dependency этого path.
6. Dedicated Chrome запускает Direct Postman, не Л1.
7. Prompt отправляет browser-first pipeline, не Л1.
8. После неоднозначной/возможной отправки автоматический resend запрещён.
9. Только validated `RESULT_DURABLE` считается implementation result.
10. Direct Postman не применяет ZIP; application/tests остаются ответственностью Л1.
11. Conversation title не является correlation key.
12. Нет exact correlated validated artifact → нет подтверждённого результата.
