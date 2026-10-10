---
name: finalize-task-pr
description: >-
  Использовать, когда пользователь уже принял решение смержить один или несколько
  проверенных обычных task pull request в main и нужно выполнить squash merge
  с best-effort cleanup временных веток/worktree. Это исполнитель готового решения,
  а не повторный reviewer.
---

# Finalize Task PR

`FINALIZE_TASK_PR_SKILL_VERSION: 3`

## Назначение

Этот skill используется **после того, как модель уже проверила обычный task PR и решила, что он готов к merge**, а пользователь дал команду выполнить merge.

Обычный task PR всегда target-ит:

```text
main
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
→ проверить base=main
→ squash merge в main
→ best effort cleanup temporary worktree/local branch/remote branch
→ краткий отчёт без обновления permanent worktrees
```

## Когда использовать

Использовать, если пользователь хочет выполнить merge уже проверенного обычного task PR в `main`.

Типичные формулировки:

```text
мердж
смёржи PR #99
мердж #97 и #98
всё готово, сливай в main
закрой ветку через merge
```

Если PR number не написан в текущем сообщении, но из непосредственно предшествующего контекста однозначно известен один готовый PR, использовать его без лишнего уточнения.

Если невозможно однозначно определить PR — спросить номер PR. Не угадывать.

## Когда НЕ использовать

Не использовать этот skill для:

```text
main → preview
проверь PR
сделай review
готов ли PR к merge?
исправь конфликты
почини тесты
создай PR
архивируй ветку
удали произвольную ветку
```

Для `main → preview` используется отдельно `tools/promote-main-to-preview/promote_main_to_preview.ps1` (release-инструмент группы G2).

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
→ убедиться, что base=main
→ убедиться, что head не main/preview
→ squash merge
→ git fetch --prune
→ удалить связанный clean temporary secondary worktree, если это безопасно
→ удалить local temporary branch, если она всё ещё указывает на exact PR head
→ удалить remote temporary branch, если она всё ещё указывает на exact PR head
→ перейти к следующему PR
```

Executor **не запускает** тесты/CI/review.

`finalize_task_pr.ps1` выполняет только merge, уборку временных ресурсов и refresh remote refs.
Он не синхронизирует локальные permanent `main` и `preview` worktrees.

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

## После обычного merge

Успешный squash merge обычной задачи меняет remote `main`, а не stable `preview`.
Skill не запускает автоматическую синхронизацию permanent `preview` и
не вводит автоматический updater локального `main`.
Оба постоянных worktree остаются нетронутыми.

Stable `preview` продвигается только отдельной release-операцией от exact одобренного
SHA `main` после явного решения пользователя через
`tools/promote-main-to-preview/promote_main_to_preview.ps1` (группа G2).
Обычный task finalize не вызывает release-инструмент.

## Финальный отчёт

Сообщить кратко результат executor:

```text
какие PR merged в main
originMain из результата finalize
какие temporary worktree/branches удалены
cleanup warnings, если есть
mainWorkingTreeTouched=false
previewWorkingTreeTouched=false
```

Обычный finalize не обновляет permanent worktrees и не выполняет release в `preview`.

## Критические инварианты

1. Skill — исполнитель уже принятого решения, не reviewer.
2. Base обычного task PR — только `main`.
3. Merge method — squash.
4. `main` и `preview` не являются временными head branches.
5. Не повторять тесты/CI/diff/scope review.
6. Не делать обязательный `-WhatIf`.
7. Dirty secondary worktree не удалять.
8. Permanent `.dsh` и `.dsh-preview` не удалять и не очищать.
9. Не использовать reset/stash/clean/force push.
10. Promotion `main → preview` выполняется только отдельным release-инструментом `promote-main-to-preview`.
11. После обычного task merge нет автоматического обновления permanent `preview` или `main`.
12. Обычный task finalize не меняет ни `C:\Users\andre\.dsh`, ни `C:\Users\andre\.dsh-preview`.
