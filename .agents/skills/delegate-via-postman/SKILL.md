---
name: delegate-via-postman
description: >-
  Использовать только когда ТЕКУЩЕЕ пользовательское сообщение после необязательных
  начальных пробелов начинается с точного литерала @Postman. Выполнить задачу через
  Direct Web Postman: сохранить пользовательский intent без технических дополнений,
  создать ровно один canonical REQ, один раз вызвать
  C:\Users\andre\.dsh\postman\direct\postman.ps1, дождаться validated RESULT_DURABLE,
  сохранить validated RESULT_DURABLE, сообщить exact resultZip и остановиться. Регистрация
  Result Workspace — необязательная presentation convenience, а не integrity gate. Не использовать Cordis/postman_async_send, QChat или
  ручную автоматизацию браузера как fallback.
---

# Delegate via Postman — Direct Production

`DIRECT_POSTMAN_SKILL_VERSION: 13`

Исторический baseline до v12: `DIRECT_POSTMAN_SKILL_VERSION: 11`.

## 0. Золотой путь

После активации этого skill нормальный production-flow всегда такой:

```text
точный user intent
→ удалить только transport prefix @Postman
→ один canonical REQ
→ один foreground-вызов Direct Postman
→ ждать exact terminal JSON
→ RESULT_DURABLE
→ один раз попытаться зарегистрировать exact resultHandoffPath через
  postman_result_workspace_register(result_handoff_json=...)
→ сообщить REQ, resultZip и Workspace (или diagnostic регистрации)
→ STOP
```

После `RESULT_DURABLE` normal flow не вызывает resume/PREPARE/TEST/PUBLISH, не
создаёт implementation worktree/branch/commit/PR и не распаковывает ZIP. Регистрация
Workspace — только удобство показа, а не integrity gate.

Не проектируй другой transport flow.

После загрузки этого skill не вызывай `delegate-via-postman` повторно в этой же операции.

## 1. Жёстко запрещённые обходы

Для обычного Postman request НЕ использовать:

```text
postman_async_send
postman_send
postman_runtime_*
dsh-postman-harness как production transport
persistent POSTMAN agent
QChat
frontend-design до получения результата Ч1
другие implementation/design skills до получения результата Ч1
Playwright MCP
Computer Use
ORCA / навыки ORCA IDE
ручное открытие ChatGPT
ручное нажатие Send
ручной запуск Chrome
ручное скачивание ZIP из ChatGPT
BrowserSmoke как обычный preflight
```

Не читать `postman/direct/README.md`, исходники bridge или browser-код только для того,
чтобы понять обычный способ запуска. Вся production-команда уже определена этим skill.

## 2. Trigger

### Exclusive current-message trigger

Postman по умолчанию OFF. Единственный разрешающий trigger — ТЕКУЩЕЕ
пользовательское сообщение, которое после возможных начальных пробелов начинается с
точного литерала `@Postman`. Формально принимается только начало:

```text
^\s*@Postman(?:\s|$)
```

Это означает:

```text
@Postman <intent>       → trigger
   @Postman <intent>     → trigger
```

Любая другая формулировка — НЕ trigger и не разрешает загрузку skill или запуск
Postman. В частности, НЕ trigger:

```text
Postman сделай X
Postman, сделай X
Через Postman сделай X
Используй Postman
продолжи проект Postman
реализуй WP-020
исправь код Postman
доработай Direct Postman
```

Само обсуждение Postman transport также не является trigger:

```text
Как работает Postman?
Почему Postman использует Chrome?
Надо ли нам менять Postman?
```

### Обязательная загрузка skill до implementation

Только после exact trigger из текущего сообщения первым task-specific действием должен
быть вызов:

```text
skill(delegate-via-postman)
```

До загрузки этого skill Luna не должна выполнять implementation-действия:

```text
glob по task-файлам
read implementation-файлов
edit
write
создание исходников
выбор архитектуры
implementation shell-команды
frontend/design skills
```

Если `@Postman` отсутствует в текущем сообщении, этот skill не должен загружаться по
инициативе Luna только потому, что задача связана с Postman, сложна или касается
разработки самого Postman. В этом случае `delegate-via-postman` не активируется, а
задача выполняется локально Luna.

Разрешение Postman действует только для текущего пользовательского сообщения и не
наследуется из предыдущих сообщений: `Postman permission is current-message-only`.

Нельзя начинать самостоятельную реализацию после exact trigger до загрузки
`delegate-via-postman`. Если skill отсутствует, не загружается, недействителен или
недоступен, действует fail-closed правило: `STOP`.

При таком отказе запрещены самостоятельная реализация и любой fallback:

```text
postman_async_send
old Harness
QChat
manual browser
Playwright
обычная самостоятельная реализация Luna
```

`QChat` — отдельный transport и не является fallback.

## 3. Разделение ролей

### Ч1 — external implementation author

Ч1 выбирает:

```text
архитектуру
технологии
структуру реализации
код
необходимые тесты
необходимую документацию
```

### Л1 — local implementation agent

Л1 отвечает только за:

```text
точный user intent
REQ
Direct Postman invocation
получение validated artifact
безопасное внедрение результата
локальную проверку
Git/PR
отчёт
```

До получения результата Ч1 Л1 не должна самостоятельно решать, как реализовать
пользовательскую задачу.

## 4. Intent preservation

Главный инвариант:

> Не превращай пользовательский запрос в собственное техническое ТЗ.

Например:

```text
@Postman сделай простой калькулятор в древне-японском стиле.
```

Для вызова `@Postman сделай калькулятор` payload для Ч1 должен быть:

```text
сделай калькулятор
```

Удалить можно только префикс `@Postman` и окружающий его пробел. Остальной
пользовательский intent сохранять буквально по смыслу. Это правило применяется
только к сообщению, прошедшему exclusive current-message trigger.

Не добавлять от себя:

```text
React
Vue
Svelte
адаптивность
accessibility
список кнопок
обработку деления на ноль
цветовую палитру
структуру каталогов
test framework
архитектурный паттерн
язык реализации
```

Все реальные пользовательские ограничения сохранить.

Если текущее сообщение с exact `@Postman` явно ссылается на предыдущий контекст,
разрешено добавить только минимальные факты из предыдущего контекста, без которых
референт (`это`, `те размеры`, `как раньше`) непонятен Ч1. Предыдущее разрешение
само по себе не является trigger для текущего сообщения.

Это context resolution, а не расширение требований.

Если сомневаешься, лучше передать больше исходного пользовательского текста, чем
придумать новое требование.

## 5. Не выполнять implementation work перед Ч1

После exact `@Postman` trigger нельзя сначала:

```text
исследовать framework
выбирать architecture
загружать frontend-design
писать собственный код
создавать структуру проекта
проводить implementation research вместо Ч1
```

Сначала Direct Postman.

Локальное исследование до отправки разрешено только если оно необходимо, чтобы
буквально разрешить неоднозначную пользовательскую ссылку или определить target
repository.

## 6. Canonical production bridge

Единственный production entrypoint:

```text
C:\Users\andre\.dsh\postman\direct\postman.ps1
```

Перед вызовом разрешена только простая проверка существования:

```powershell
$bridge = 'C:\Users\andre\.dsh\postman\direct\postman.ps1'
if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
    throw 'POSTMAN_DIRECT_BRIDGE_MISSING'
}
```

Если bridge отсутствует — STOP.

Production wrapper по умолчанию сохраняет durable artifacts в:

```text
D:\Downloads_dsh_auto
```

`postman.ps1` поддерживает override через `DSH_POSTMAN_RESULT_ROOT` / `-ResultRoot`.
Direct state, worker state и browser profile остаются в `%LOCALAPPDATA%\DSH\Postman`.

До GitHub task publication и до browser Send Direct Postman обязан создать result root
и выполнить write-probe. При невозможности записи: `DIRECT_RESULT_ROOT_UNAVAILABLE`
и `STOP` до отправки prompt.

Если вызывающий shell уже PowerShell, вызывать `postman.ps1` напрямую через `&`.
Дополнительный nested `pwsh.exe` не является normal production path.

Не искать альтернативный transport.
Не переходить на Cordis.
Не переходить на QChat.
Не автоматизировать браузер вручную.

## 7. Создание REQ

Перед bridge invocation создать canonical:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

Использовать реальное текущее UTC-время:

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$suffix = (Get-Random -Minimum 0 -Maximum 10000).ToString("0000")
$requestId = "REQ_${stamp}_${suffix}"
```

До первого запуска bridge можно убедиться, что direct state ещё не существует:

```powershell
$state = Join-Path $env:LOCALAPPDATA "DSH\Postman\direct\requests\$requestId.json"
```

Если случайный REQ уже существует, разрешено сгенерировать другой suffix до
запуска bridge. Максимум три локальные collision-попытки.

После начала bridge invocation REQ immutable.

Новый REQ для этой логической операции автоматически создавать нельзя.

## 8. Единственный production-вызов

Использовать payload из раздела Intent preservation.

```powershell
$bridge = 'C:\Users\andre\.dsh\postman\direct\postman.ps1'

$jsonText = & $bridge `
  -RequestId $requestId `
  -Task $payload

$bridgeExitCode = $LASTEXITCODE
```

Это один logical invocation.

Если shell/tool требует увеличенный timeout, дать этому одному вызову достаточно
времени. Coding/ZIP request может выполняться много минут.

Предпочитать один foreground-вызов с timeout не меньше внутреннего Postman timeout
(15 минут). Не переводить обычный request в background только ради периодического
polling. Background допустим только если конкретный shell-tool технически не может
ждать достаточно долго; тогда ждать завершения именно этого одного process/job.

Не запускать параллельно второй Postman request.
Не создавать второй REQ.

Если из-за ограничения shell-tool процесс пришлось запустить background-способом,
это всё ещё тот же единственный invocation. Ждать завершения именно этого process,
а не запускать новый.


### Внутренний link-only transport contract

Luna передаёт bridge только exact user payload через `-Task`. Сам внешний prompt
формирует Direct Postman; Luna не собирает его вручную.

Канонический prompt Ч1 состоит ровно из трёх строк:

```text
POSTMAN_REQUEST_ID: REQ_xxx
policy: <policy link>
task_file: <SHA-pinned task link>
```

В prompt не должны находиться `repository`, `base_commit`, `expected_filename`,
`allowed_paths_json`, `forbidden_paths_json`, user intent, result markers или
implementation instructions. Всё это Direct Postman помещает в self-contained task-файл.

`baseCommit` implementation artifact относится к snapshot `main` ДО transport-only
публикации `REQ_xxx.md`. SHA публикации task-файла хранится отдельно как
`taskPublicationCommit`. Luna не подменяет один SHA другим и не реконструирует task
manifest вручную.

## 9. Разбор JSON и минимальный transport gate

После завершения Direct Postman распарсить terminal JSON:

```powershell
try {
    $result = $jsonText | ConvertFrom-Json
}
catch {
    throw 'POSTMAN_RESULT_JSON_INVALID'
}
```

До PREPARE Luna проверяет только transport boundary:

```text
$result.ok        == true
$result.code      == RESULT_DURABLE
$result.state     == RESULT_DURABLE
$result.requestId == exact $requestId
```

Не выполнять вручную `Get-FileHash`, повторный manifest/base/staleness/path validation
или отдельный `Test-Path` как normal handoff. Полная проверка ZIP, SHA-256, manifest,
baseCommit и application принадлежит deterministic PREPARE/applicator.

После `RESULT_DURABLE` не открывать ChatGPT для визуального подтверждения.

### Канонический durable handoff, Workspace registration и STOP

После успешного `RESULT_DURABLE` Direct Postman атомарно сохраняет канонический
terminal JSON в deterministic path:

```text
C:\Users\andre\AppData\Local\DSH\Postman\direct\results\<REQ>.json
```

Этот файл — durable источник истины для сообщения пользователю. До этого состояния
сохраняется строгий fail-closed transport gate: `ok=true`, exact `code/state`,
correlation REQ и вся проверка ZIP принадлежат Direct Postman. Не реконструировать
receipt, не распаковывать и не анализировать ZIP повторно.

После exact `RESULT_DURABLE` разрешена одна presentation-попытка:

```text
postman_result_workspace_register(result_handoff_json=<exact resultHandoffPath>)
```

При успехе сообщить `requestId`, exact `resultZip` и `workspaceId`. Если регистрация
не удалась, transport всё равно успешен: сообщить diagnostic, не создавать второй REQ,
не повторять ChatGPT/download и не запускать resume. Затем normal flow останавливается.

`resume_request.ps1`, `integrate_result.ps1` и стадии PREPARE/TEST/PUBLISH не удаляются.
Они описаны ниже только как legacy/manual explicit finalization для уже существующего
durable результата; они не являются частью normal `@Postman` flow.

## 10. Что Direct Postman уже доказал

При `RESULT_DURABLE` не повторять вручную весь browser/artifact validator.

Direct pipeline уже доказал:

```text
корреляцию REQ
assistant turn
exact expected filename
download
manifest
repository
baseCommit
allowed/forbidden paths
artifact integrity
durable storage
```

Л1 делает только короткий local handoff gate из предыдущего раздела, при необходимости
пытается зарегистрировать exact durable result как Workspace и останавливается.

## 11. Failure handling

Если bridge вернул `ok=false`, invalid JSON или завершился с non-zero exit — STOP.

Сохранить исходный exact REQ.

Не создавать автоматически второй REQ.
Не повторять Send.
Не открывать ChatGPT вручную.
Не брать визуально существующий ZIP.
Не использовать старый Harness.
Не использовать QChat.
Не пытаться доделать implementation самому.

Разрешено один раз прочитать exact direct state/worker state этого REQ для
диагностики, если стандартный state path известен.

После этого вернуть пользователю:

```text
requestId
code
state
error/reason
последнюю доказанную transport-фазу
```

Новая отправка возможна только после нового пользовательского сообщения с exact `@Postman` trigger.

## 12. BrowserSmoke

`BrowserSmoke` является диагностической операцией.

Не запускать его перед каждым нормальным Postman request.

Использовать только если пользователь прямо просит smoke/диагностику либо
исследуется неисправность browser bootstrap/CDP до новой разрешённой отправки.

```powershell
& 'C:\Users\andre\.dsh\postman\direct\postman.ps1' `
  -BrowserSmoke
```

Успех:

```text
ok = true
code = BROWSER_SMOKE_READY
promptSent = false
```

Smoke не является частью обычного golden path.

## 13. Не создавать Git branch до RESULT_DURABLE только ради transport

Direct Postman сам публикует intent task в `main`.

Л1 не должна до получения Ч1 создавать implementation branch/worktree,
модифицировать repository или писать implementation только ради отправки.

Git integration начинается после validated `RESULT_DURABLE`.

Исключение: отдельная задача разработки/ремонта самого Postman transport.

## 14. Legacy/manual explicit finalization

Этот раздел не выполняется в normal `@Postman` flow. Для уже существующего durable
результата и отдельного явного запроса пользователя допускается только один entrypoint:

```text
C:\Users\andre\.dsh\postman\direct\resume_request.ps1
```

State machine:

```text
RESULT_DURABLE
→ READY_FOR_TEST
→ TEST_PASSED
→ PUBLISHED
```

`resume_request.py` программно передаёт exact `readyJson → testJson → publishedJson`,
проверяет request/repository/branch/worktree identity и не пересчитывает пути по
догадке. Existing valid receipts делают resume идемпотентным.

### Task test input

При explicit manual finalization test input — argv-safe файл вне implementation worktree:

```text
%LOCALAPPDATA%\DSH\Postman\handoff\<REQ>\task_test.py
```

или `test-spec.json` в том же handoff-каталоге.

Для одной semantic assertion создать UTF-8 `task_test.py` штатным Harness file
write/edit tool. Не строить содержимое теста как shell-строку. Затем:

```powershell
$resumeText = & 'C:\Users\andre\.dsh\postman\direct\resume_request.ps1' `
  -RequestId $requestId `
  -RepoRoot 'C:\Users\andre\.dsh' `
  -TestScript $testScript
$resume = $resumeText | ConvertFrom-Json
```

Для существующей repository/project test-команды разрешён argv-only `TestSpec`,
например:

```json
{
  "command": ["python", "-m", "pytest", "-q", "tests/task_test.py"]
}
```

или spec со script:

```json
{
  "script": "task_test.py",
  "args": []
}
```

После этого использовать `-TestSpec <exact path>`.

`-TestCommand` остаётся legacy compatibility mode runtime, но НЕ является normal
production path Luna. В normal flow запрещены `python -c`, PowerShell command-string
reconstruction и многострочные shell-quoting трюки.

Если при explicit manual finalization тест нельзя выбрать до PREPARE, сначала вызвать
`resume_request.ps1` без test input. Exact `READY_FOR_TEST` receipt даст authoritative `worktree` и `changedFiles`.
Разрешено минимально изучить эти файлы для выбора semantic test, создать TestScript/
TestSpec вне worktree и повторно вызвать `resume_request.ps1` для того же REQ.

Внутри resume PREPARE по-прежнему владеет policy/Git/worktree и canonical applicator,
TEST — semantic receipt/fingerprint, PUBLISH — stage/commit/push/remote-SHA/PR.
`C:\Users\andre\.dsh\postman\direct\integrate_result.ps1` остаётся canonical
applicator maintenance entrypoint, но Luna не вызывает его напрямую в normal flow.

Прямые `prepare_result.ps1`, `test_result.ps1`, `publish_result.ps1` остаются
низкоуровневыми implementation/diagnostic boundary и targeted-test surface. В обычной
пользовательской `@Postman` операции Luna их отдельно НЕ вызывает.

Успех manual finalization: exact `PUBLISHED`, `semanticTest=TEST_PASSED`, один OPEN PR
в `main`, `mergePerformed=false`. Любой `ok=false`/invalid receipt — STOP без ручного
fallback, нового REQ или повторного transport.

## 15. Что normal `@Postman` НЕ делает после RESULT_DURABLE

Normal flow не запускает следующие действия ни отдельными tool calls, ни через resume:

```text
prepare_result.ps1
test_result.ps1
publish_result.ps1
git status / branch / ls-remote / worktree preflight
gh pr list
git fetch
git worktree add
integrate_result.ps1 напрямую
Get-FileHash результата
повторный manifest/base/staleness check
git add
git commit
git push
remote SHA verification
gh pr create
повторное чтение только что созданного PR
```

Эти действия остаются доступными только как explicit manual finalization для уже
существующего durable результата; они не принадлежат normal `@Postman` flow.

Запрещены по-прежнему `git reset --hard`, `git clean`, automatic stash, force push и
ручная перепись artifact через LLM tools.

## 16. Legacy/manual finalization failure handling

В explicit manual finalization `resume_request.ps1` и его внутренние PREPARE/TEST/PUBLISH стадии являются
fail-closed. Не заменять failure собственными shell-командами и не обходить resume
низкоуровневыми boundary wrappers.

Не создавать второй branch и новый Postman REQ из-за local-finalization failure.
Existing RESULT_DURABLE и valid receipts сохраняются; последующий retry должен быть
тем же `resume_request.ps1 -RequestId <exact REQ>`.

Dirty failure worktree сохраняется для диагностики. TEST receipt связан SHA-256 с
exact READY JSON, TestScript SHA-256 и fingerprint implementation bytes. PUBLISH не
merge-ит PR и не удаляет remote branch.

## 17. Legacy/manual task-specific test selection

Только при explicit manual finalization после RESULT_DURABLE/READY_FOR_TEST можно выбрать
одну проверку, которая лучше всего доказывает пользовательский intent. Приоритет:
тесты Ч1, repository-defined test, существующая project command, одна минимальная
semantic assertion.

TestScript/TestSpec должен проверять именно объективные требования пользователя, не
их ослабленную замену. Если пользователь потребовал «чёрную кнопку», недостаточно
проверить лишь наличие `background`; semantic test должен доказать чёрный цвет. Если
есть требования к количеству элементов, тексту, конкретному файлу, hover/active,
сохранности остального и т.п., проверять соответствующие объективные свойства.

Для субъективных UI-требований (`стильно`, `красиво`, `современно`) semantic test
проверяет только объективно формализуемую часть. Визуальная presentation и user
acceptance остаются отдельными состояниями и не подменяются `TEST_PASSED`.

Для UI допускается один цельный UTF-8 E2E/script вне implementation worktree.
BrowserSmoke не является task test. Normal test path не использует `python -c` или
`-TestCommand`; использовать `-TestScript`/`-TestSpec` через resume.

## 18. Git publication boundary for manual finalization

При explicit manual finalization Git publication успешна только при exact `PUBLISHED`, который доказывает commit,
remote exact SHA, один OPEN PR `base=main` с exact head branch/SHA, удалённый task worktree
и отсутствие автоматического merge.

## 19. Финальный отчёт

При normal transport сообщить как минимум:

```text
Postman requestId
RESULT_DURABLE
exact resultZip
resultHandoffPath
Workspace registration status и workspaceId, если регистрация успешна
диагностику регистрации, если она не удалась
```

Поля semantic test, commit, remote synchronization, PR и merge относятся только к
explicit manual finalization и не должны выдаваться как результат normal flow.

### Кликабельные изменённые файлы в Harness Web

Authoritative список брать только из exact `PUBLISHED` receipt `changedFiles`.
Для каждого файла построить exact существующий локальный путь от retained
`published.worktree` + relative `changedFiles`.

В финальном ответе каждый изменённый локальный файл упомянуть как Markdown inline code
— отдельным элементом, например:

`C:\Users\andre\AppData\Local\DSH\Postman\worktrees\REQ_xxx\docs\example.html`

Harness Web делает такие существующие file-path references кликабельными. Использовать
exact path из receipt, а не придумывать `C:\Users\andre\.dsh\postman\worktrees`.
Если штатный file tool уже surfaced файл и basename уникален среди изменённых файлов
этого turn, допустим inline-code basename; иначе использовать абсолютный exact path.

Для локальных файлов не использовать bare path, `file://` и не придумывать Markdown
URL. Web/PR URL оформлять обычной Markdown-ссылкой.

Не перегружать пользователя browser/CDP внутренностями без диагностической
необходимости.

При failure сообщить:

```text
exact REQ
terminal code
terminal state
точный blocker
что не было выполнено после blocker
```

## 20. Критические инварианты

1. Postman OFF по умолчанию; разрешён только при exact `@Postman` в начале текущего пользовательского сообщения после необязательных начальных пробелов.
2. Разрешение действует только для текущего сообщения и не наследуется из предыдущих сообщений.
3. Без exact trigger не загружать `delegate-via-postman`, не создавать REQ, не вызывать Direct Postman, не использовать другие Postman transport и не обращаться к Ч1.
4. До Ч1 не загружать implementation/design skills и не проектировать решение.
5. User intent не расширяется собственными требованиями Л1.
6. Один logical request → один REQ.
7. После начала Direct Postman invocation REQ immutable.
8. Production transport — только `C:\Users\andre\.dsh\postman\direct\postman.ps1`.
9. `postman_async_send` и Cordis path не являются production transport.
10. BrowserSmoke не является normal preflight.
11. Chrome/ChatGPT/Send/download принадлежат Direct Postman, а не Л1.
12. После возможной отправки automatic resend запрещён.
13. Только exact `RESULT_DURABLE` является implementation result.
14. Не создавать implementation branch только ради transport до результата.
15. Пользовательский dirty worktree не очищать и не переписывать.
16. Л1 внедряет результат Ч1, а не заменяет его собственным решением.
17. После RESULT_DURABLE normal flow останавливается после optional Workspace registration.
18. `resume_request.ps1`, PREPARE/TEST/PUBLISH и `integrate_result.ps1` — только legacy/manual explicit finalization.
19. Normal flow не создаёт implementation worktree/branch/commit/PR и не распаковывает ZIP.
20. Workspace registration — presentation convenience, а не integrity gate.
21. Ошибка Workspace registration не отменяет успешный RESULT_DURABLE и не вызывает retry.
22. Direct Postman сам владеет strict transport validation до RESULT_DURABLE.
23. `files/` payload копируется exact bytes; Л1 не переписывает его через LLM tools.
24. `RESULT_DIAGNOSTIC_ONLY` не является implementation success и не разрешает automatic resend.
25. Resume/PREPARE/TEST/PUBLISH не создают новый Postman REQ и не обращаются повторно к Ч1.
26. Финальный отчёт перечисляет authoritative changedFiles кликабельными inline-code local paths из exact retained worktree.
27. Нет validated correlated artifact → нет успешного Postman результата.


## Result Workspace после RESULT_DURABLE

После exact successful `RESULT_DURABLE` normal flow может один раз попытаться
зарегистрировать durable result как обычный Harness Workspace:

```text
postman_result_workspace_register(result_handoff_json=<exact resultHandoffPath>)
```

Инструмент проверяет только receipt/layout gate, не распаковывает ZIP и не повторяет
artifact validation. Он вызывает `ctx.workspaceRegistry.create(resultDirectory, title)`
с рекомендуемым title `Postman <REQ> — result` и пишет
`<resultDirectory>\\result-workspace.json` внутри exact result directory.

Результат регистрации содержит `source: RESULT_DURABLE`, exact `requestId`,
`resultDirectory`, `resultZip`, `resultHandoffJson` и `workspaceId`. Это presentation
convenience, а не integrity gate. Ошибка регистрации не отменяет transport success:
не создавать второй REQ, не повторять ChatGPT/download, не запускать resume и сообщить
пользователю exact RESULT_DURABLE, resultZip и diagnostic.

После регистрации пользователь может открыть Workspace штатными средствами Harness;
никаких новых Chrome/CDP, Session или preview-сервисов для регистрации не создавать.

Старый `published_json` режим остаётся совместимым: он регистрирует retained PUBLISHED
worktree, пишет sibling `result-workspace.json` рядом с published receipt и сохраняет
старый `clearResultPresentation` только для legacy unregister. Durable unregister не
вызывает published-result presentation cleanup: он удаляет только Workspace registration,
помечает свой sidecar как `RESULT_WORKSPACE_UNREGISTERED` и не удаляет result directory,
`result.zip` или другие durable receipts.

Пользователь не должен вводить git/SHA/worktree-команды или команды терминала вручную.
