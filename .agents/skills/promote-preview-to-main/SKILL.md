---
name: promote-preview-to-main
description: >-
  Использовать только после явной команды пользователя перенести текущий проверенный
  preview в main. Skill создаёт/проверяет promotion PR preview -> main с user-GO marker
  и выполняет канонический merge executor без squash и без удаления preview.
---

# Promote Preview To Main

`PROMOTE_PREVIEW_TO_MAIN_SKILL_VERSION: 1`

## Назначение

Этот skill относится только к release promotion:

```text
preview → main
```

Обычные task PR в `preview` этим skill не обрабатываются.

## Разрешение

Promotion разрешён только когда **текущее пользовательское сообщение** явно командует перенести/слить проверенный `preview` в `main`.

Разрешение не наследуется из старых сообщений и не выводится из того, что task PR уже были приняты в `preview`.

## Promotion PR

Нужен PR:

```text
base = main
head = preview
```

Body обязан содержать точную строку:

```text
MAIN_GO_APPROVED_BY_USER: yes
```

Если такого PR нет, после explicit user GO разрешено создать один через GitHub CLI с `base=main`, `head=preview` и этим marker. Не создавать PR заранее «на будущее».

Если PR существует без marker, добавлять marker разрешено только в рамках текущего explicit user GO.

## Канонический executor

После того как exact PR number известен:

```powershell
$resultText = & 'C:\Users\andre\.dsh\tools\promote-preview-to-main\promote_preview_to_main.ps1' `
  -PrNumber 123
$result = $resultText | ConvertFrom-Json
```

`-WhatIf` не является обязательным; использовать только по явному запросу.

## Executor guards

Executor требует:

```text
base=main
head=preview
same repository
MAIN_GO_APPROVED_BY_USER: yes
exact PR head == current origin/preview до первого merge
```

Merge method:

```text
merge commit
```

Squash для `preview → main` запрещён.

## После merge

Executor может non-force fast-forward remote `preview` на созданный main merge commit, но только если:

```text
origin/main == merge SHA
origin/preview всё ещё == exact tested PR head
```

Если refs сдвинулись, не force-push и не переписывать историю. Сообщить warning/blocker.

После успешного remote sync обновить локальную preview-папку отдельным каноническим инструментом:

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action update
```

## Не повторять review

Если модель уже проверила exact promotion intent и пользователь дал GO, executor не должен превращаться в повторный review pipeline.

Не запускать без конкретной причины:

```text
повторные task tests
повторный diff review всех feature PR
исторический branch audit
Postman transport
```

Аварийные ref/identity guards executor выполняет сам.

## Запрещено

```text
squash preview → main
force push main/preview
удаление preview
удаление C:\Users\andre\.dsh-preview
reset/stash/clean постоянных worktree
promotion без current-message user GO
```

## Финальный отчёт

Сообщить:

```text
PR
previewHeadSha
mergeSha
originMain
originPreview
previewSync
local preview HEAD после update, если доступен
preview update code
warnings
preview sync warning/blocker, если есть
mainWorkingTreeTouched=false
previewBranchDeleted=false
```

`previewWorkingTreeTouched=false` — это только поле результата promotion executor, а не утверждение о полном skill после отдельного вызова preview-worktree.
