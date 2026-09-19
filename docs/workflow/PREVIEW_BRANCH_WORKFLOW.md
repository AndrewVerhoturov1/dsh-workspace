# Preview Branch Workflow

`PREVIEW_BRANCH_WORKFLOW_VERSION: 1`

Этот документ описывает каноническую двухветочную модель `dsh-workspace`.

## 1. Постоянные ветки

```text
main    = стабильное, окончательно принятое состояние
preview = интеграционное состояние для текущей работы и локального тестирования
```

Обе ветки долгоживущие. Любые другие ветки временные.

## 2. Постоянные локальные папки

```text
C:\Users\andre\.dsh          → main
C:\Users\andre\.dsh-preview → preview
```

`.dsh-preview` создаётся как `git worktree`, а не как независимый clone.

Причины:

- обе папки существуют одновременно;
- не нужно постоянно `git switch` в одном рабочем каталоге;
- Git знает, какая branch занята каким worktree;
- task-worktree можно создавать и удалять независимо;
- одна object database и один `origin` уменьшают риск расхождения двух clone.

## 3. Обычная новая задача

Начальная точка — exact current `origin/preview`.

```text
origin/preview @ BASE_SHA
        │
        └── feature/... | fix/... | exp/... | postman/...
```

Обязательный порядок:

1. `git fetch --prune origin`;
2. прочитать exact `origin/preview` SHA;
3. создать одну временную branch от этого SHA;
4. создать отдельный clean worktree;
5. выполнить работу и проверки;
6. commit + push;
7. открыть PR **в `preview`**;
8. после отдельного user merge command — squash merge;
9. безопасно удалить временную branch/worktree.

Нельзя начинать обычную task от `main`.

## 4. Локальное тестирование `preview`

После task merge локальная preview-папка обновляется только безопасным fast-forward:

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action update
```

Скрипт обязан остановиться, если `.dsh-preview` dirty или больше не является worktree branch `preview`.

Никаких auto-stash/reset/clean.

## 5. Если после локального теста нужен fix

Fix начинается от уже обновлённого `origin/preview`, а не от старой feature branch:

```text
preview
  └── fix/YYYYMMDD-short-slug
        └── PR → preview
```

Исключение: если defect найден до merge исходной feature branch в preview, исправление остаётся в той же task branch.

## 6. Promotion в `main`

`main` меняется только после отдельной команды пользователя на перенос проверенного состояния.

Единственный обычный release route:

```text
preview → main
```

Перед promotion:

1. получить exact `origin/preview`;
2. убедиться, что это именно проверенное пользователем состояние;
3. создать/использовать PR с `base=main`, `head=preview`;
4. записать в PR body:

```text
MAIN_GO_APPROVED_BY_USER: yes
```

5. выполнить promotion executor.

Канонический executor:

```powershell
& 'C:\Users\andre\.dsh\tools\promote-preview-to-main\promote_preview_to_main.ps1' -PrNumber <N>
```

Promotion использует GitHub merge method `merge`, а не `squash`.

Это сохраняет ancestry:

```text
main-old ───────────────┐
                        ├─ main-new (merge commit)
preview-tested ─────────┘
```

После merge executor пытается non-force fast-forward remote `preview` на этот же merge commit. Он делает это только если может доказать, что `preview` не сдвинулся после проверки.

Если `preview` изменился или `main` получил другой commit, автоматический sync запрещён; executor возвращает warning и не делает force push.

## 7. После promotion

Обновить локальный preview worktree:

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action update
```

Основной `C:\Users\andre\.dsh` не reset-ится и не обновляется насильно. Его синхронизация выполняется отдельно безопасным способом с учётом возможных локальных пользовательских изменений.

## 8. Bootstrap `preview`

Bootstrap выполняется **один раз после merge migration PR**, который вводит эту политику.

Команда:

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action bootstrap
```

Bootstrap:

1. проверяет primary repository;
2. делает `git fetch --prune origin`;
3. убеждается, что migration policy уже находится в `origin/main`;
4. если remote `preview` отсутствует — создаёт его ровно на current `origin/main` без force;
5. создаёт локальную branch `preview` с tracking `origin/preview`, если это безопасно;
6. создаёт `C:\Users\andre\.dsh-preview` как worktree;
7. проверяет exact SHA/branch/clean state.

Если remote `preview` уже существует на другом SHA, bootstrap не переписывает его.

Если `.dsh-preview` уже существует, но не является ожидаемым worktree, bootstrap ничего не удаляет и останавливается.

## 9. GitHub PR policy

Workflow `.github/workflows/preview-policy.yml` проверяет структуру PR:

- `temporary branch → preview` — допустимый task route;
- `preview → main` — допустимый release route только с `MAIN_GO_APPROVED_BY_USER: yes`;
- `temporary branch → main` — ошибка;
- `main → preview` — ошибка обычного workflow;
- PR в другую base branch — ошибка.

Этот workflow является repository guard, но не заменяет explicit user approval.

## 10. Merge executors

### Task PR

```text
base = preview
head = temporary branch
merge method = squash
cleanup temporary worktree/local branch/remote branch = best effort
main worktree = protected
preview worktree = protected
```

Executor:

```text
tools/finalize-task-pr/finalize_task_pr.ps1
```

### Release promotion

```text
base = main
head = preview
marker = MAIN_GO_APPROVED_BY_USER: yes
merge method = merge
preview branch/worktree = never deleted
safe non-force preview fast-forward after merge
```

Executor:

```text
tools/promote-preview-to-main/promote_preview_to_main.ps1
```

## 11. Запрещённые shortcuts

Без отдельного явного административного решения запрещены:

```text
temporary branch → main
прямая обычная разработка в main
прямая обычная разработка в preview
squash preview → main
delete preview
force push main/preview
auto-stash/reset/clean постоянных worktree
удаление C:\Users\andre\.dsh
удаление C:\Users\andre\.dsh-preview
```

## 12. Короткая схема

```text
                   explicit user GO
                         │
                         ▼
feature/fix ──PR──▶ preview ──PR/merge commit──▶ main
                   │
                   └── C:\Users\andre\.dsh-preview

main ───────────────────▶ C:\Users\andre\.dsh
```
