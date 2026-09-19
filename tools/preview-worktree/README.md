# preview-worktree

Канонический локальный инструмент постоянной preview-папки.

```text
C:\Users\andre\.dsh          → main
C:\Users\andre\.dsh-preview → preview
```

`.dsh-preview` создаётся как `git worktree` того же repository, а не отдельный clone.

## Первый bootstrap

Запускать только **после merge migration PR**, который добавляет `PREVIEW_BRANCH_WORKFLOW_VERSION: 1` в `origin/main`:

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action bootstrap
```

Bootstrap:

- fetch-ит refs;
- проверяет exact repository и migration marker в `origin/main`;
- если `origin/preview` отсутствует — создаёт его ровно на current `origin/main` обычным non-force push;
- если `origin/preview` уже существует на другом SHA — STOP, не переписывает;
- если `.dsh-preview` уже существует, но не является ожидаемым worktree — STOP, ничего не удаляет;
- создаёт local tracking branch `preview` и permanent worktree;
- проверяет SHA и clean state.

## Setup для уже существующего remote preview

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action setup
```

## Обновление после task merge / release

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action update
```

Update разрешён только если `.dsh-preview`:

- зарегистрирован как worktree;
- находится на branch `preview`;
- clean.

Обновление выполняется:

```text
git fetch --prune origin
git merge --ff-only origin/preview
```

Никаких stash/reset/clean.

## Read-only status

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action status
```

## Safety invariants

Инструмент никогда не делает:

```text
git reset --hard
git clean
git stash
force push
удаление C:\Users\andre\.dsh-preview
перезапись существующего remote preview на другой SHA
```
