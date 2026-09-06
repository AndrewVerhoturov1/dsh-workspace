# finalize-task-pr

Простой исполнитель уже принятого решения о merge.

Он **не является reviewer** и намеренно не повторяет проверки, которые модель уже выполнила до команды пользователя «мердж»:

- не запускает тесты;
- не проверяет CI;
- не читает diff PR;
- не пересматривает scope;
- не проверяет старые Postman receipts;
- не строит отдельный approval workflow.

## Обычный вызов

```powershell
& 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' -PrNumber 98
```

Несколько PR последовательно:

```powershell
& 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' -PrNumber 97,98
```

Каждый следующий PR читается заново уже после merge/fetch предыдущего.

Dry-run:

```powershell
& 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' -PrNumber 98 -WhatIf
```

## Что делает

1. Читает exact PR через GitHub CLI.
2. Проверяет только минимальные аварийные условия: PR относится к `main`, имеет нормальную head-ветку и либо открыт, либо уже merged.
3. Выполняет squash merge через GitHub API.
4. Делает только `git fetch --prune origin` — локальный `main`/working tree не checkout/update/reset.
5. Best-effort удаляет clean worktree этой head-ветки.
6. Удаляет локальную head-ветку, только если она всё ещё указывает на exact PR head SHA и не используется оставшимся worktree.
7. Удаляет remote head-ветку, только если она всё ещё указывает на exact PR head SHA.
8. Возвращает один JSON.

## Философия

После того как модель уже решила, что PR готов к merge, этот скрипт **не должен заново доказывать это решение**.

Cleanup best-effort:

- ветка уже отсутствует → нормально;
- worktree уже отсутствует → нормально;
- remote branch уже удалена → нормально;
- dirty worktree → оставить и вернуть warning;
- ветка после проверки кем-то сдвинута на другой SHA → оставить и вернуть warning.

Merge failure — реальная ошибка и останавливает последовательность.
Cleanup warning после успешного merge не откатывает merge и не мешает перейти к следующему PR.

## Чего скрипт никогда не делает

- `git reset --hard`;
- `git stash`;
- `git clean`;
- force push;
- checkout/switch локального `main`;
- обновление файлов dirty primary worktree;
- удаление dirty worktree;
- удаление `C:\Users\andre\.dsh` как worktree.

Если у результата Postman есть Harness Result Workspace/Session, модель должна закрыть/снять эту UI-регистрацию своим штатным инструментом. Этот скрипт отвечает только за GitHub merge и Git branch/worktree cleanup.
