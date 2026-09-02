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

`DIRECT_POSTMAN_SKILL_VERSION: 4`

## 0. Золотой путь

После активации этого skill нормальный production-flow всегда такой:

```text
точный user intent
→ один canonical REQ
→ один foreground-вызов Direct Postman
→ ждать terminal JSON
→ RESULT_DURABLE
→ один bundled Git/preflight
→ один deterministic applicator
→ READY_FOR_TEST
→ task-scoped tests
→ commit / push / PR
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

Активируй skill только если пользователь явно выбрал Postman как transport для
implementation-задачи.

Примеры:

```text
Postman, сделай простой калькулятор.
Через Postman сделай страницу...
Используй Postman и реализуй...
Postman передай это Ч1 и внедри результат.
```

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
Postman, сделай простой калькулятор в древне-японском стиле.
```

payload должен оставаться по смыслу:

```text
Сделай простой калькулятор в древне-японском стиле.
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

$jsonText = & pwsh.exe `
  -NoLogo `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File $bridge `
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

## 9. Разбор JSON и success gate

После завершения:

```powershell
try {
    $result = $jsonText | ConvertFrom-Json
}
catch {
    throw 'POSTMAN_RESULT_JSON_INVALID'
}
```

Production success существует только при одновременных условиях:

```text
$result.ok          == true
$result.code        == RESULT_DURABLE
$result.state       == RESULT_DURABLE
$result.requestId   == exact $requestId
$result.resultZip   != empty
$result.sha256      != empty
```

Проверить файл:

```powershell
Test-Path -LiteralPath $result.resultZip -PathType Leaf
```

И SHA:

```powershell
$actualSha = (Get-FileHash -Algorithm SHA256 $result.resultZip).Hash.ToLower()
```

Требовать:

```text
actualSha == result.sha256
```

Также проверить:

```text
expectedFilename содержит exact REQ
taskUrl относится к exact REQ
baseCommit является полным 40-hex SHA
repository соответствует ожидаемому repository
```

После `RESULT_DURABLE` не открывать ChatGPT для визуального подтверждения.
Durable validated artifact является источником истины.

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
& pwsh.exe `
  -NoLogo `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File 'C:\Users\andre\.dsh\postman\direct\postman.ps1' `
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

## 14. Bundled integration preflight после RESULT_DURABLE

После `RESULT_DURABLE` прочитать `REPO_POLICY.md` один раз и выполнить branch/worktree/PR
preflight как один компактный bundled-шаг. Не повторять одинаковые `status`, branch,
remote и worktree проверки, если repository state с предыдущей проверки не менялся.

До application:

1. Проверить policy-required состояние веток/PR/worktrees.
2. Выполнить `git fetch origin`.
3. Создать ровно одну чистую task branch/worktree от текущего `origin/main`.
4. Не применять artifact в основной dirty `C:\Users\andre\.dsh`.

Проверки artifact SHA/manifest/base/staleness и exact application принадлежат
canonical deterministic applicator из раздела 16. Л1 не должна повторять их вручную
до или после applicator.

Если preflight запрещает новую task branch — STOP и вернуть blocker. Не создавать
вторую branch и не обходить `REPO_POLICY.md`.

## 15. Защита пользовательского рабочего дерева

Если основной `C:\Users\andre\.dsh` содержит пользовательские dirty/untracked данные:

```text
не reset
не clean
не stash автоматически
не restore пользовательских файлов
```

Применение implementation package выполнять в отдельном чистом worktree, если это
нужно для сохранности пользовательского дерева.

Никогда не распаковывать implementation ZIP внутрь dirty repository root.
Использовать `%TEMP%`.

## 16. Canonical deterministic applicator

Normal production path после создания чистой task branch/worktree — ровно один
вызов:

```text
C:\Users\andre\.dsh\postman\direct\integrate_result.ps1
```

Сохранить exact terminal JSON Direct Postman во временный UTF-8 JSON-файл и вызвать:

```powershell
& 'C:\Users\andre\.dsh\postman\direct\integrate_result.ps1' `
  -ResultJson $resultJsonPath `
  -RepoRoot $taskWorktree
```

Applicator детерминированно выполняет:

```text
RESULT_DURABLE gate
request/repository/base/filename validation
ZIP SHA256 validation
safe ZIP + manifest validation
diagnostic-only classification
protected/path-traversal checks
git fetch + base ancestry/staleness gate
clean task-worktree + HEAD==origin/main gate
git apply --check для patch
exact-byte copy для manifest files
git diff --check
unexpected-path gate
```

Успех application существует только при JSON:

```text
ok   = true
code = READY_FOR_TEST
requestId = exact исходный REQ
```

После `READY_FOR_TEST` использовать `changedFiles` applicator как authoritative список
внедрённых путей и переходить к task-scoped tests.

В normal path Л1 НЕ должна:

```text
вручную распаковывать ZIP
повторно читать manifest для application
вручную выполнять git apply
автоматически переписывать implementation-файлы через write/edit LLM tool
декодировать и заново кодировать files payload
повторять SHA/base/staleness проверки, уже пройденные applicator
```

Файлы из `files/` должны попадать в repository exact bytes из artifact.

Если applicator вернул `RESULT_DIAGNOSTIC_ONLY`, это transport/artifact success, но
НЕ implementation success. STOP, сохранить тот же REQ, показать diagnostic blocker и
не создавать новый REQ автоматически.

Любой другой `ok=false` от applicator — STOP. Не исправлять artifact вручную и не
заменять решение Ч1 собственным implementation.

## 17. Проверка реализации

Л1 не должна перепроектировать Ч1 после применения.

Проверить:

```text
изменились только ожидаемые task-scoped paths
решение соответствует пользовательскому intent
не затронуты settings.yaml / attachments / runtime state / browser profile
```

Запустить repository-defined tests, относящиеся к изменению.

Для одной простой проверки предпочитать один цельный test invocation вместо цепочки
из множества `open/snapshot/click/snapshot/console` вызовов. Для UI допускается один
небольшой E2E/script, который запускает нужный server/browser, делает assertion и
закрывает ресурсы. Не сокращать сами assertions ради скорости.

Источники test-команд по приоритету:

```text
AGENTS.md / repository instructions
package/project scripts
тесты, включённые Ч1
существующие тестовые команды проекта
```

Не добавлять новый framework только ради проверки.

При failure — STOP. Не чинить архитектуру Ч1 молча. Сообщить точный conflict/test
failure.

## 18. Git publication

После успешного application + tests следовать `REPO_POLICY.md`.

Обычная схема:

```text
одна task branch
→ commit
→ push
→ подтвердить remote SHA
→ один PR в main
```

Если shell позволяет, stage/commit/push/remote-SHA verification выполнить одним
последовательным invocation после успешных tests. Не повторять неизменившийся Git
preflight между этими шагами.

Не merge автоматически, если пользователь отдельно не разрешил merge.

Не создавать вторую branch для той же операции.

Не использовать:

```text
git reset --hard
git clean
git push --force
автоматический stash
```

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
15. Normal application выполняется через `postman/direct/integrate_result.ps1` и требует `READY_FOR_TEST`.
16. `files/` payload копируется exact bytes; L1 не переписывает его через LLM tools.
17. `RESULT_DIAGNOSTIC_ONLY` не является implementation success и не разрешает automatic resend.
18. Нет validated correlated artifact → нет успешного Postman результата.
