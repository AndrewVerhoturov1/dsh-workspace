# Политика репозитория

Обязательные правила Git/GitHub для `dsh-workspace`. Пошаговые команды и переход на новый маршрут — в [Branch Workflow](docs/workflow/PREVIEW_BRANCH_WORKFLOW.md). Для Postman и implementation-пакетов см. [Bridge](postman/POSTMAN_BRIDGE_FLOW.md), [workflow](system/implementation-package-workflow.md) и [authoring](system/implementation-package-authoring.md). Приведённые там процедуры не отменяют защиту данных и границы доверия.

## Ветки, рабочие деревья и данные

- **`main` — повседневная интеграционная ветка.** Обычная новая задача начинается только от доказанного exact current `origin/main` SHA: временная task branch и отдельное clean worktree → PR с base=`main` → после отдельного решения пользователя squash merge в `main`. Прямая разработка в постоянных ветках запрещена.
- **`preview` — последняя явно проверенная stable-версия.** Обычные task PR, автоматическая синхронизация после task merge, прямые коммиты и PR с base=`preview` запрещены. Только отдельный human stable GO на **полный проверенный exact `origin/main` SHA A** допускает remote-only non-force fast-forward `preview` к A при доказанной ancestry и свежей проверке exact remote refs перед push. Эта проверка не гарантирует их неизменность до push и не является атомарной CAS. Это не PR, merge, squash, force push или собственный commit в `preview`. Без GO `preview` не меняется.
- `C:\Users\andre\.dsh` (main) и `C:\Users\andre\.dsh-preview` (preview) — постоянные worktree; нельзя удалять, очищать, перепривязывать на task branch или применять к ним implementation ZIP. Отдельно различай изменения в Git source, фактически запущенный DSH Host/навыки и stable GO; одно не доказывает другого.
- `settings.yaml`, `attachments/`, browser state, секреты, credentials, журналы, diagnostics и runtime-файлы — пользовательские данные, не материал для автоматической уборки/commit. Сохраняй несвязанные изменения и первичные untracked данные, включая `plugins/dsh-branchline/`.

Исключение [transport/postman-inputs](postman/POSTMAN_INPUT_FILES.md): Host-managed transport branch только для явно выбранных временных файлов. Это не task branch, не обычный task PR и не merge; очистка — только безопасный non-force commit, без обещания удаления истории.

## Один канонический Git-снимок

До новой ветки выполни `git fetch --prune origin`; один раз собери task snapshot: `git status --short --branch`, текущие branch/HEAD, локальные и remote refs (включая exact `origin/main` и `origin/preview`), `git worktree list --porcelain`, связанные PR с base/head/state и ownership, незавершённые local/remote temporary branches. Адресные команды:

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
git for-each-ref refs/heads refs/remotes/origin --format="%(refname:short)|%(objectname)|%(upstream:short)|%(upstream:track)"
git ls-remote --heads origin
git worktree list --porcelain
```

Переиспользуй снимок, пока входы не изменились. Fetch обновляет remote refs; commit — HEAD/status; push — remote refs/PR; merge/rebase/cherry-pick — HEAD/refs; создание, switch, удаление ветки/worktree — соответствующие refs и worktree; изменение PR и внешнее GitHub-состояние — соответствующие поля. Освежай лишь инвалидированные поля, повторяй полный снимок лишь при неясном охвате. Read-only анализ/TODO/навык снимок не инвалидируют.

Чужой независимый PR/branch/worktree — часть аудита, не глобальная блокировка. Блокируют конфликт ownership/identity/resource конкретной задачи, занятое worktree, неясная перезапись или риск для чужих данных. Обычная ветка допустима лишь от доказанного exact `origin/main` SHA в **новом отдельном** worktree. Исключения базы возможны только по явно оформленной административной migration/bootstrap или отдельной release-операции; старый pinned REQ не является поводом для переназначения базы.

Перед необратимым/разрушительным действием отдельно получи свежие доказательства exact refs, worktree, ownership и данных. Старый snapshot сам по себе не разрешает удаление или rewrite.

## Изоляция, совместимость и срок жизни задачи

Одна логическая задача — одна temporary branch и один отдельный worktree; законченный milestone — один PR в `main`. Не создавай цепочки fix-v2 вокруг незаконченной задачи; новую независимую проблему выдели в следующую задачу. Эксперимент — `exp/*` с последующим решением.

После принятия: `task PR → squash merge в main → проверенная уборка временной ветки`. Ценную отклонённую работу сохраняй annotated `archive/*` tag на exact SHA после проверки local/remote peeled target; закрывай PR без merge и безопасно удаляй temporary branch. Не force-переписывай archive tags; сохранность чужих данных и постоянных refs обязательна.

**Старые pinned задачи не мигрируют автоматически:** существующие task branches, worktrees, опубликованные SHA-pinned REQ и implementation packages сохраняют исходные base/REQ/`packageBase`. Никакого массового retarget/rebase, registry migration или переписывания. Открытые старые PR с base=`preview` после cutoff рассматриваются только по отдельному решению owner; новый CI guard их не разрешает. Compatibility пакета определяет `git apply --check`, а не равенство `packageBase` и HEAD. Standalone Direct-main маршрут остаётся прежним; для Host `postman_task_prepare` task от `origin/main` и transport commit с REQ в **той же** task branch — разные действия.

## Проверка и публикация

Проверки соразмерны изменению; прежний PASS при неизменных релевантных входах не повторяют. Перед принятием task PR в `main` проверь относящиеся тесты, `git diff --check` и отсутствие случайных секретов/пользовательских файлов. Integration `main` должна позволять безопасный старт следующей задачи, но её обновление **не** является проверкой stable.

Локальный агент публикует только намеренные проверенные изменения:

`изменения → targeted checks → явное добавление путей задачи → commit → push task branch → проверка remote SHA → один PR с base=main`.

До успешной синхронизации `local HEAD == origin task branch HEAD` результат не считается опубликованным. Не делать `git add -A` по загрязнённому дереву; чужие изменения не включать. При сбое публикации/сверки отчитайся `BLOCKED_SYNC` с local/remote SHA и причиной, не удаляя сохранённый код. До следующей независимой задачи результат должен быть опубликован или явно отклонён пользователем.

Внешний агент с `GitHub READ ONLY` не делает commit/push/PR/merge, а отдаёт результат штатным transport. После local apply отдельное решение о публикации; решение о merge — ещё одно действие. Runner PASS не даёт прав на GitHub writes.

## Merge, stable GO и административная миграция

Обычный task PR с base=`main` сливается **squash** через `finalize-task-pr` только после отдельного решения пользователя; исполнитель сохраняет постоянные ветки/worktrees, выполняет безопасную уборку временных ресурсов и не подменяет reviewer.

Stable — отдельная **remote-only** команда `promote-main-to-preview` с точным проверенным полным `origin/main` SHA A и явным текущим человеческим GO: PowerShell `-ApprovedMainSha A -UserGo` или Python `--approved-main-sha A --user-go`. Операцию сериализуют с другими Git writers. Executor проверяет actual remote `main=A`, `preview=P`, соответствие свежим fetched refs и ancestry `P → A` (либо подтверждённый no-op `P=A`); непосредственно перед push повторно сверяет оба actual refs. Замеченный сдвиг **до** push, невозможность fast-forward и failed push — STOP без автоматического retry, смены A или обхода. Затем ровно один обычный non-force push **литерала `A:refs/heads/preview`**, без force/lease, и обязательная сверка фактического `preview=A`. Между проверкой и push остаётся окно гонки: обычный Git push отвергает non-fast-forward, но не даёт atomic CAS и не доказывает неизменность обоих refs. Если `main` сдвинулся **после** push, executor сообщает warning и не публикует новый непроверенный HEAD. Никаких PR/body marker, merge commit, squash, auto-sync или новых preview commits.

Remote-only операция **не проверяет чистоту постоянных worktree и не изменяет их**: не выполняет checkout, reset, stash, clean или локальный update. Проверка чистоты/известного состояния и безопасного fast-forward постоянного preview worktree требуется лишь для **отдельно запрошенного опционального** локального `preview-worktree -Action update` после подтверждённого успешного remote promotion; при dirty/unknown состоянии локальный update останавливают без потери пользовательских данных.

Для введения **этого** нового правила допускается ровно **один** явно одобренный административный `task → main` migration PR под документированное исключение старого guard. До merge нужен фактический успешный запуск **изменённого** check на `pull_request` именно для этого PR/точного head SHA; локальный тест или старый зелёный check недостаточны. Если текущий guard не допускает обновлённый PR/check, остановись и согласуй изменённый план; нельзя отключать guard, обходить защиту или включать временный двойной маршрут. Не меняй `preview` до отдельного stable GO. После merge проверить актуальную активную установку GUI `4173`, загруженные Host source/skills, предусмотренную установку/перезапуск и новую Leader-сессию: Git source сам по себе не обновляет текущий процесс. Исторические PR/задачи оставить без массовых изменений.

## Запреты и отчёт по стадиям

Без отдельной авторизации запрещены `git reset --hard`, слепой `git clean`, автоматический stash, force push (включая `--force-with-lease`), обычные `git gc/prune`, force archive retag/deletion, удаление постоянных worktree и чужих данных. Временную ветку удаляй только при доказанном сохранении или интеграции всей нужной уникальной работы.

**Реализация/PR:** repository, task branch, task base SHA от `origin/main` (для старых pinned tasks — их фактическая база), local HEAD, origin task branch HEAD, `Synchronized: YES/NO`, реальные commit/push/PR number/base/state и `GitHub synchronization status: SYNCED | BLOCKED_SYNC`.

**Task merge:** только исполнитель сообщает `Merge performed` и `Final origin/main SHA`.

**Stable GO:** только executor сообщает `Final origin/preview SHA`, exact approved main A, доказательство fast-forward и статус стабильной публикации. Не объявляй стабильность по одному task merge.

Не требуй от исполнителя implementation доказательств будущего merge или stable GO. Закрытие task после отдельного решения включает судьбу временных ресурсов и сохранность постоянных refs/worktree и пользовательских данных.
