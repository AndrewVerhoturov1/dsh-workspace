---
name: delegate-via-postman
description: >-
  Использовать только когда пользователь явно выбирает Postman для implementation-задачи.
  Выполнить задачу через Direct Web Postman: сохранить пользовательский intent без
  технических дополнений, создать ровно один canonical REQ, один раз вызвать
  C:\Users\andre\.dsh\postman\direct\postman.ps1, дождаться validated RESULT_DURABLE,
  затем безопасно применить implementation ZIP, проверить изменения и оформить их
  по политике репозитория. Не использовать Cordis/postman_async_send, QChat или
  ручную автоматизацию браузера как fallback.
---

# Delegate via Postman — Direct Production

`DIRECT_POSTMAN_SKILL_VERSION: 9`

## 0. Золотой путь

После активации этого skill нормальный production-flow всегда такой:

```text
точный user intent
→ один canonical REQ
→ один foreground-вызов Direct Postman
→ ждать terminal JSON
→ RESULT_DURABLE
→ PREPARE: один вызов prepare_result.ps1
→ READY_FOR_TEST
→ TEST: один вызов test_result.ps1
→ TEST_PASSED
→ PUBLISH: один вызов publish_result.ps1
→ PUBLISHED
→ отчёт пользователю
```

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
ручное открытие ChatGPT
ручное нажатие Send
ручной запуск Chrome
ручное скачивание ZIP из ChatGPT
BrowserSmoke как обычный preflight
```

Не читать `postman/direct/README.md`, исходники bridge или browser-код только для того,
чтобы понять обычный способ запуска. Вся production-команда уже определена этим skill.

## 2. Trigger

### Канонический trigger

Канонический и предпочтительный explicit trigger для Direct Postman:

```text
@Postman <user intent>
```

Примеры:

```text
@Postman сделай простой калькулятор.
@Postman создай страницу проверки.
@Postman измени существующий файл согласно этому запросу.
```

Если исходное пользовательское сообщение начинается с `@Postman`, это однозначный
explicit Postman trigger для implementation-запроса.

### Обязательная загрузка skill до implementation

Первым task-specific действием после такого trigger должен быть вызов:

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

Нельзя начинать самостоятельную реализацию до загрузки `delegate-via-postman`.
Если `delegate-via-postman` отсутствует, не загружается, недействителен или
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

### Legacy-compatible triggers

Для совместимости остаются explicit legacy triggers:

```text
Postman, ...
Через Postman ...
Используй Postman ...
Postman передай это Ч1 и внедри результат.
```

Для новых пользовательских запросов основной синтаксис — `@Postman`.

Само обсуждение Postman transport не является trigger:

```text
Как работает Postman?
Почему Postman использует Chrome?
Надо ли нам менять Postman?
```

Если пользователь не выбрал Postman явно, не активируй его из-за сложности задачи.

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
пользовательский intent сохранять буквально по смыслу.

Для legacy-trigger удаляется только его минимальная управляющая часть:

```text
Postman,
Через Postman
Используй Postman
```

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

Удалить можно только минимальную управляющую часть, выбирающую transport:

```text
Postman,
Через Postman
Используй Postman
```

Все реальные пользовательские ограничения сохранить.

Если пользователь явно ссылается на предыдущий контекст, например:

```text
Postman, сделай это по тем размерам, которые мы уже зафиксировали.
```

разрешено добавить только минимальные факты из предыдущего контекста, без которых
референт (`это`, `те размеры`, `как раньше`) непонятен Ч1.

Это context resolution, а не расширение требований.

Если сомневаешься, лучше передать больше исходного пользовательского текста, чем
придумать новое требование.

## 5. Не выполнять implementation work перед Ч1

После Postman-trigger нельзя сначала:

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

Л1 делает только короткий local handoff gate из предыдущего раздела и переходит к
integration.

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

Новая отправка возможна только после нового явного пользовательского разрешения.

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

## 14. WP-018B deterministic local finalization

После exact `RESULT_DURABLE` normal production path состоит ровно из трёх deterministic boundary-вызовов:

```text
PREPARE
→ TEST
→ PUBLISH
```

Luna не выполняет между ними ручные Git/preflight/publication цепочки.

### PREPARE

Единственный normal entrypoint:

```text
C:\Users\andre\.dsh\postman\direct\prepare_result.ps1
```

```powershell
$prepareText = & 'C:\Users\andre\.dsh\postman\direct\prepare_result.ps1' `
  -ResultJsonText $jsonText `
  -RepoRoot 'C:\Users\andre\.dsh'
$prepareExit = $LASTEXITCODE
$ready = $prepareText | ConvertFrom-Json
```

Успех: `ok=true`, `code=READY_FOR_TEST`, exact requestId и существующий `readyJson`.

PREPARE детерминированно владеет REPO_POLICY preflight, одним `git fetch origin`,
проверкой local/origin branches, open PR и worktrees, созданием deterministic
`postman/req-*` branch, отдельного clean worktree от `origin/main` и canonical
`integrate_result.py` application.

Основной dirty `C:\Users\andre\.dsh` не очищается. Локальный `main` может отставать
от `origin/main` только как ancestor; task worktree создаётся от актуального `origin/main`.

Существующий canonical applicator остаётся источником истины:
`C:\Users\andre\.dsh\postman\direct\integrate_result.ps1`.
PREPARE использует ту же deterministic `integrate_result.py` логику и сохраняет exact bytes.

Если PREPARE вернул `PREPARE_DIAGNOSTIC_ONLY`, `PREPARE_POLICY_BLOCKED` или любой
другой `ok=false` — STOP. Не создавать branch/worktree вручную.

### TEST

После `READY_FOR_TEST` Luna выбирает ровно одну минимальную task-specific test-команду.
Запуск только через:

```text
C:\Users\andre\.dsh\postman\direct\test_result.ps1
```

```powershell
$testText = & 'C:\Users\andre\.dsh\postman\direct\test_result.ps1' `
  -ReadyJson $ready.readyJson `
  -TestCommand @('python', '-m', 'pytest', 'tests/task_test.py')
$test = $testText | ConvertFrom-Json
```

Test gate проверяет branch/HEAD, authoritative changedFiles, exit code и запрещает
незамеченную мутацию implementation worktree. Успех: `code=TEST_PASSED` и `testJson`.
Если test failure/timeout/mutation — STOP.

### PUBLISH

После `TEST_PASSED` единственный normal publication entrypoint:

```text
C:\Users\andre\.dsh\postman\direct\publish_result.ps1
```

```powershell
$publishText = & 'C:\Users\andre\.dsh\postman\direct\publish_result.ps1' `
  -ReadyJson $ready.readyJson `
  -TestJson $test.testJson
$published = $publishText | ConvertFrom-Json
```

PUBLISH проверяет READY↔TEST binding и fingerprint, выполняет `git diff --check`,
stage только authoritative changedFiles, commit, push без force, remote SHA verification,
создаёт/проверяет один OPEN PR в `main` и удаляет локальный task worktree после PR.
Локальная task branch сохраняется до merge; remote branch нужна открытому PR.

Успех: `ok=true`, `code=PUBLISHED`, `remoteVerified=true`, PR identity exact,
`mergePerformed=false`.

Если PUBLISH вернул failure — STOP. Не выполнять ручную альтернативную публикацию.

## 15. Что Luna больше не делает вручную после RESULT_DURABLE

В normal path не запускать отдельными tool calls:

```text
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

Эти обязанности принадлежат PREPARE/TEST/PUBLISH.

Запрещены по-прежнему `git reset --hard`, `git clean`, automatic stash, force push и
ручная перепись artifact через LLM tools.

## 16. Failure handling local finalization

PREPARE/TEST/PUBLISH являются fail-closed. Не заменять failure собственными shell-командами.
Не создавать второй branch и новый Postman REQ из-за локальной finalization failure.

Если PREPARE после ошибки имеет чистый owned worktree, он может удалить только свой
чистый worktree и пустую локальную branch. Dirty failure worktree сохраняется для диагностики.

TEST receipt связан SHA-256 с exact READY JSON и fingerprint implementation bytes.
PUBLISH не merge-ит PR и не удаляет remote branch.

## 17. Task-specific test selection

Единственное содержательное решение Л1 после READY_FOR_TEST — выбрать одну проверку,
которая лучше всего доказывает пользовательский intent. Приоритет: тесты Ч1,
repository-defined test, существующая project command, одна минимальная semantic assertion.
Для UI допускается один цельный E2E/script. BrowserSmoke не является task test.

## 18. Git publication boundary

Git publication успешна только при exact `PUBLISHED`, который доказывает commit,
remote exact SHA, один OPEN PR `base=main` с exact head branch/SHA, удалённый task worktree
и отсутствие автоматического merge.

## 19. Финальный отчёт

При успехе сообщить как минимум:

```text
Postman requestId
RESULT_DURABLE
artifact SHA256
что было внедрено
результаты тестов
commit SHA
remote synchronization
PR/link
merge status
```

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

1. Postman используется только по явному запросу.
2. До Ч1 не загружать implementation/design skills и не проектировать решение.
3. User intent не расширяется собственными требованиями Л1.
4. Один logical request → один REQ.
5. После начала Direct Postman invocation REQ immutable.
6. Production transport — только `C:\Users\andre\.dsh\postman\direct\postman.ps1`.
7. `postman_async_send` и Cordis path не являются production transport.
8. BrowserSmoke не является normal preflight.
9. Chrome/ChatGPT/Send/download принадлежат Direct Postman, а не Л1.
10. После возможной отправки automatic resend запрещён.
11. Только exact `RESULT_DURABLE` является implementation result.
12. Не создавать implementation branch только ради transport до результата.
13. Пользовательский dirty worktree не очищать и не переписывать.
14. Л1 внедряет результат Ч1, а не заменяет его собственным решением.
15. После RESULT_DURABLE normal local path — только PREPARE → TEST → PUBLISH.
16. PREPARE является единственным владельцем branch/worktree/preflight и canonical applicator.
17. TEST требует exact `TEST_PASSED` receipt и запрещает незамеченную мутацию implementation.
18. PUBLISH является единственным владельцем stage/commit/push/remote-SHA/PR в normal path.
19. `files/` payload копируется exact bytes; Л1 не переписывает его через LLM tools.
20. `RESULT_DIAGNOSTIC_ONLY` не является implementation success и не разрешает automatic resend.
21. Ни PREPARE, ни TEST, ни PUBLISH не создают новый Postman REQ.
22. PUBLISH никогда не merge-ит PR автоматически.
23. Нет validated correlated artifact → нет успешного Postman результата.


## Result Workspace после PUBLISHED

После успешного `PUBLISHED` task worktree НЕ удаляется. `published.json` содержит
`worktree`, `worktreeRetained: true` и `resultWorkspaceRegistrationRequired: true`.
Это exact tested PR HEAD и единственный локальный источник результата до merge;
отдельную Preview-копию не создавать.

Сразу после `PUBLISHED` вызвать ровно один раз:

```text
postman_result_workspace_register(published_json=<exact publishedJson>)
```

Это НЕ transport и НЕ повторная отправка Ч1. Инструмент использует host
`ctx.workspaceRegistry.create(worktree, title)`, записывает sibling
`result-workspace.json` и возвращает `RESULT_WORKSPACE_REGISTERED` с `workspaceId`
и title. Штатный Workspace feed Harness сам покажет новый Workspace без reload.

Не использовать для Result Workspace:

```text
ctx.workspaces.create
ctx.sessions.create
ctx.sessions.open
custom remote event
dsh-api-remotes patch
lib/client.js
Postman Chrome/CDP
локальный preview HTTP server
```

Обычный клик по строке Workspace только раскрывает группу. Для работы с результатом
пользователь выбирает Workspace в штатном picker или нажимает `+ New Session` у него;
штатный Harness выполняет `workspaces.startSession → connectWorkspace →
sessions.create({workspaceId}) → sessions.open`, поэтому cwd новой Session равен exact
retained worktree. Файловые/shell/launcher операции этой Session выполняются оттуда.

Если регистрация Workspace после уже успешного `PUBLISHED` не удалась, не создавать
новый REQ, не повторять PUBLISH и не удалять PR. Сообщить post-publication UX failure
и остановиться с сохранённым worktree.

После merge сначала закрыть/архивировать Result Session, затем вызвать
`postman_result_workspace_unregister` для exact `publishedJson`. Инструмент удаляет
только Workspace registration и помечает `result-workspace.json` как
`RESULT_WORKSPACE_UNREGISTERED`; worktree и Session logs он не удаляет. После этого
`cleanup_published.ps1` может удалить только clean exact worktree, только у merged PR.
Dirty worktree, незамерженный PR или всё ещё зарегистрированный Workspace — fail-closed.

Пользователь не должен вводить git/SHA/worktree-команды или команды терминала вручную.
