# promote-preview-to-main

Release executor для единственного обычного маршрута в стабильную ветку:

```text
preview → main
```

Используется только после отдельной явной команды пользователя на перенос конкретного проверенного `preview` в `main`.

## Требования к PR

```text
base = main
head = preview
head repository = AndrewVerhoturov1/dsh-workspace
PR body содержит: MAIN_GO_APPROVED_BY_USER: yes
PR head SHA == current origin/preview
```

## Вызов

```powershell
& 'C:\Users\andre\.dsh\tools\promote-preview-to-main\promote_preview_to_main.ps1' -PrNumber 123
```

Dry-run только по явному запросу:

```powershell
& 'C:\Users\andre\.dsh\tools\promote-preview-to-main\promote_preview_to_main.ps1' -PrNumber 123 -WhatIf
```

## Merge method

Используется GitHub `merge_method=merge`, **не squash**.

Причина: merge commit сохраняет ancestry между `preview` и `main` и позволяет после release безопасно fast-forward `preview` на тот же commit.

## Синхронизация preview после merge

После успешного merge executor:

1. делает `git fetch --prune origin`;
2. проверяет, что `origin/main` равен созданному merge SHA;
3. проверяет, что remote `preview` всё ещё равен exact PR head;
4. выполняет только обычный non-force push merge SHA в `refs/heads/preview`;
5. перепроверяет refs.

Если `main` или `preview` успели сдвинуться, executor **не** делает force/rewrite и возвращает warning.

## Что executor не делает

- не удаляет `preview`;
- не удаляет `C:\Users\andre\.dsh-preview`;
- не checkout/reset-ит постоянные worktree;
- не делает force push;
- не запускает review/test suite повторно;
- не создаёт user approval сам.

Локальную `.dsh-preview` после release обновлять отдельно через `preview_worktree.ps1 -Action update`.
