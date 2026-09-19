# finalize-task-pr

Исполнитель уже принятого решения о merge обычного task PR **в `preview`**.

Он не является reviewer и намеренно не повторяет проверки, которые модель уже выполнила до команды пользователя «мердж»:

- не запускает тесты;
- не проверяет CI;
- не читает diff PR;
- не пересматривает scope;
- не проверяет старые Postman receipts.

## Обычный вызов

```powershell
& 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' -PrNumber 98
```

Несколько PR последовательно:

```powershell
& 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' -PrNumber 97,98
```

Dry-run только по явному запросу:

```powershell
& 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' -PrNumber 98 -WhatIf
```

## Что делает

1. Читает exact PR через GitHub CLI.
2. Требует `base=preview`.
3. Запрещает использовать `main` или `preview` как временную head branch.
4. Выполняет squash merge через GitHub API.
5. Делает только `git fetch --prune origin` — локальные permanent worktree не checkout/update/reset.
6. Best-effort удаляет clean secondary worktree временной head branch.
7. Удаляет локальную временную head branch, только если она всё ещё указывает на exact PR head SHA и не используется оставшимся worktree.
8. Удаляет remote временную head branch, только если она всё ещё указывает на exact PR head SHA.
9. Возвращает JSON с актуальным `originPreview`.

## Постоянные worktree защищены

Никогда не удалять и не очищать:

```text
C:\Users\andre\.dsh
C:\Users\andre\.dsh-preview
```

Даже если из-за ручной ошибки временная branch окажется checkout в одном из этих путей, executor оставит worktree и branch с warning.

## Cleanup — best effort

Нормальные состояния:

- worktree уже отсутствует;
- local branch уже отсутствует;
- remote branch уже отсутствует;
- PR уже merged.

Dirty secondary worktree оставляется нетронутым с warning.

Branch, которая после review сдвинулась на другой SHA, не удаляется.

Cleanup warning не превращает уже успешный merge в failure.

## Чего executor никогда не делает

- `git reset --hard`;
- `git stash`;
- `git clean`;
- force push;
- checkout/switch `main` или `preview`;
- обновление файлов dirty permanent worktree;
- удаление permanent worktree.

Promotion `preview → main` этим инструментом запрещён. Для release используется `tools/promote-preview-to-main/promote_preview_to_main.ps1`.
