---
name: finalize-task-pr
description: >-
  Использовать, когда пользователь уже принял решение смержить один или несколько
  проверенных обычных task pull request в preview и нужно выполнить squash merge
  с best-effort cleanup временных веток/worktree. Это исполнитель готового решения,
  а не повторный reviewer.
---

# Finalize Task PR

`FINALIZE_TASK_PR_SKILL_VERSION: 3`

## Назначение

Этот skill используется **после того, как модель уже проверила обычный task PR и решила, что он готов к merge**, а пользователь дал команду выполнить merge.

Обычный task PR всегда target-ит:

```text
preview
```

Skill не принимает решение о качестве PR. Он только исполняет уже принятое решение через:

```text
C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1
```

Нормальный путь:

```text
PR уже проверен моделью
→ пользователь говорит merge / смержи
→ определить exact PR number(s)
→ один вызов finalize_task_pr.ps1
→ проверить base=preview
→ squash merge в preview
→ best effort cleanup temporary worktree/local branch/remote branch
→ после успешного finalize один раз обновить permanent local preview через preview_worktree.ps1 -Action update
→ проверить результат preview update
→ краткий отчёт
```

## Когда использовать

Использовать, если пользователь хочет выполнить merge уже проверенного обычного task PR в `preview`.

Типичные формулировки:

```text
мердж
смёржи PR #99
мердж #97 и #98
всё готово, сливай в preview
закрой ветку через merge
```

Если PR number не написан в текущем сообщении, но из непосредственно предшествующего контекста однозначно известен один готовый PR, использовать его без лишнего уточнения.

Если невозможно однозначно определить PR — спросить номер PR. Не угадывать.

## Когда НЕ использовать

Не использовать этот skill для:

```text
preview → main
проверь PR
сделай review
готов ли PR к merge?
исправь конфликты
почини тесты
создай PR
архивируй ветку
удали произвольную ветку
```

Для `preview → main` используется `promote-preview-to-main`.

## Главное правило: не проверять повторно

После активации skill **не повторять** то, что модель уже проверила до команды merge:

```text
тесты
CI/checks
diff review
scope review
архитектурный review
повторный просмотр всех изменённых файлов
Postman receipts
```

Не создавать дополнительный approval pipeline.

## Канонический вызов

Один PR:

```powershell
$resultText = & 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' `
  -PrNumber 99
$result = $resultText | ConvertFrom-Json
```

Несколько PR:

```powershell
$resultText = & 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' `
  -PrNumber 97,98
$result = $resultText | ConvertFrom-Json
```

`-WhatIf` использовать только если пользователь явно просит предварительный просмотр действий. Это не обязательный шаг.

## Что делает executor

Для каждого PR последовательно:

```text
прочитать exact PR identity
→ убедиться, что base=preview
→ убедиться, что head не main/preview
→ squash merge
→ git fetch --prune
→ удалить связанный clean temporary secondary worktree, если это безопасно
→ удалить local temporary branch, если она всё ещё указывает на exact PR head
→ удалить remote temporary branch, если она всё ещё указывает на exact PR head
→ перейти к следующему PR
```

Executor **не запускает** тесты/CI/review.

Ответственность разделена:

```text
finalize_task_pr.ps1
= merge + temporary cleanup + refresh remote refs

preview_worktree.ps1 -Action update
= safe synchronization permanent local preview
```

Сам finalize executor не обновляет `C:\Users\andre\.dsh-preview`.

## Cleanup — best effort

Нормальные неошибочные состояния:

```text
worktree уже отсутствует
local branch уже отсутствует
remote branch уже отсутствует
PR уже merged
```

Dirty secondary worktree — не удалять, вернуть warning и сохранить успешный merge.

Если branch после review сдвинулась на другой SHA — не удалять её, вернуть warning.

Cleanup warning не превращает уже успешный merge в failure.

## Permanent worktrees защищены

Никогда не удалять/очищать:

```text
C:\Users\andre\.dsh
C:\Users\andre\.dsh-preview
```

Даже если временная branch по ошибке checkout в одном из этих путей, executor должен оставить его нетронутым и вернуть warning.

Запрещены:

```text
git reset --hard
git clean
automatic stash
force push
удаление permanent worktree
```

## Обработка результата

Успешные terminal codes:

```text
TASK_PRS_FINALIZED
TASK_PRS_FINALIZED_WITH_WARNINGS
```

`TASK_PRS_FINALIZED_WITH_WARNINGS` означает: merge выполнен, но часть best-effort cleanup оставлена нетронутой.

Если `ok=false`, сообщить exact `code` и blocker. Не имитировать executor вручную без отдельной причины.

## Синхронизация permanent preview после merge

После выполнения всего вызова `finalize_task_pr.ps1` обновлять permanent local preview **один раз на всю пачку PR**, а не после каждого PR. Канонический вызов:

```powershell
$previewText = & 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' `
  -Action update
$previewResult = $previewText | ConvertFrom-Json
```

Запускать его только после:

```powershell
$resultText = & 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' ...
$result = $resultText | ConvertFrom-Json

if ($result.ok -eq $true -and -not $WhatIf) {
    # Для TASK_PRS_FINALIZED и TASK_PRS_FINALIZED_WITH_WARNINGS
    # один вызов update после завершения всей batch-операции.
}
```

Условия обязательны:

- при `TASK_PRS_FINALIZED` запускать update;
- при `TASK_PRS_FINALIZED_WITH_WARNINGS` также запускать update: warning cleanup временной task branch не мешает синхронизации permanent preview;
- при `TASK_PRS_DRY_RUN` (`-WhatIf`) permanent preview не изменять;
- при `ok=false` автоматически update не запускать и не угадывать состояние частично завершённой batch-операции.

`preview_worktree.ps1 -Action update` сам проверяет зарегистрированный worktree branch `preview`, clean state, делает `git fetch --prune origin`, затем только `merge --ff-only origin/preview` и проверяет равенство local preview HEAD и `origin/preview`. Он не использует reset, stash, clean, checkout/switch или force push.

Если task merge уже успешен, но preview update завершился ошибкой, merge не отменять и не объявлять неуспешным. Сообщить отдельно:

```text
remote task merge succeeded
local preview synchronization failed
exact PREVIEW_* code / blocker
```

Автоматически не исправлять dirty `.dsh-preview`, неправильный branch/worktree, divergence или ff-only failure.

## Финальный отчёт

Сообщить кратко и разделить результат executor и полный результат skill:

```text
какие PR merged
originPreview из результата finalize
local preview synchronization result
local preview HEAD после update, если доступен
preview update code
какие temporary worktree/branches удалены
cleanup warnings
preview sync warning/blocker, если есть
mainWorkingTreeTouched=false
```

Поле `previewWorkingTreeTouched=false` можно сохранять только как поле результата самого `finalize_task_pr.py`: после отдельного вызова `preview_worktree.ps1` оно не описывает полный end-to-end результат skill.

## Критические инварианты

1. Skill — исполнитель уже принятого решения, не reviewer.
2. Base обычного task PR — только `preview`.
3. Merge method — squash.
4. `main` и `preview` не являются временными head branches.
5. Не повторять тесты/CI/diff/scope review.
6. Не делать обязательный `-WhatIf`.
7. Dirty secondary worktree не удалять.
8. Permanent `.dsh` и `.dsh-preview` не удалять и не очищать.
9. Не использовать reset/stash/clean/force push.
10. Promotion в `main` выполняется только отдельным skill `promote-preview-to-main`.
11. После успешного обычного task merge permanent local preview приводится к current `origin/preview` только через `preview-worktree -Action update`.
12. Обычный task finalize никогда не обновляет local `main` и не изменяет `C:\Users\andre\.dsh`.
