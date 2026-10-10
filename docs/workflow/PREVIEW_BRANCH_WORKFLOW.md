# Preview Branch Workflow

`PREVIEW_BRANCH_WORKFLOW_VERSION: 2`

Пошаговые команды новой двухветочной модели `dsh-workspace`. Обязательные правила ownership, preflight, публикации, запретов и отдельных решений см. в [REPO_POLICY.md](../../REPO_POLICY.md). Здесь не заменяются существующие Host grant/runner/ApprovalService или полномочия ролей.

## 1. Постоянные ветки

```text
main    = текущая интеграционная (повседневные task PR и squash merge)
preview = последний отдельно одобренный и проверенный stable SHA
```

Обе ветки постоянные. `main` не тождественна стабильной публикации. Stable обновляется только из точного проверенного `origin/main` commit A по отдельному решению пользователя.

## 2. Постоянные worktree

```text
C:\Users\andre\.dsh         → main
C:\Users\andre\.dsh-preview → preview
```

Это постоянные разные worktree одного Git repository (не временные task environments), а не гарантии того, какой код сейчас загружен в работающий DSH. Не удалять/перепривязывать/сбрасывать, не делать auto stash/clean, не применять сюда implementation ZIP. Новую работу вести в отдельном task worktree. Включая первичные untracked `plugins/dsh-branchline/`, пользовательские файлы не трогать.

## 3. Обычная задача после миграции

Только после доказанного `git fetch --prune origin`, актуального snapshot и ownership по [policy](../../REPO_POLICY.md):

```text
origin/main @ exact BASE_SHA
        │
        └── feature/... | fix/... | exp/... | postman/... (clean temporary worktree)
                       └── PR base=main → отдельное user decision → squash merge в main
```

Host `postman_task_prepare` создаёт/публикует единственную task branch и clean worktree от exact `origin/main`; Bridge помещает REQ commit **в ту же task branch**, а не в `main` и не в `preview`. Standalone Direct-main остаётся без изменений. Если пакет изначально был написан для прежнего pinned snapshot, его base/REQ/`packageBase` нельзя переписывать и нельзя автоматически rebase/retarget task или registry; `git apply --check` — authority совместимости.

Проверить относящиеся тесты и `git diff --check`, явно staged paths, commit/push task branch, exact remote SHA, PR base=`main`. Отдельное user decision запускает `finalize-task-pr` (squash и безопасная уборка временных ресурсов). Обычный task merge **не** запускает синхронизацию `preview`.

## 4. Проверка текущего интеграционного состояния

После task merge интеграционные проверки выполняются против точного `origin/main` SHA и соответствующего активного runtime, если нужен live-test. Исходные файлы, локальное постоянное дерево main и реально загруженные Host/skills — разные состояния. Не менять грязный primary worktree принудительно. Для новой ошибки создаётся обычная `fix/*` branch от нового `origin/main`; если issue найдена до merge task branch, исправление остаётся там же.

Отдельную проверку стабильности планируют на *полном* кандидатном SHA A из `main`, включая нужную Windows/live acceptance, по решению пользователя. Локальное прохождение узких authoring checks не есть stable GO.

## 5. Stable promotion: exact approved main SHA A → preview

Только после отдельного **актуального** явного решения пользователя о проверенной полной версии `origin/main` A. Канонический вызов (G2 release executor):

```powershell
& 'C:\Users\andre\.dsh\tools\promote-main-to-preview\promote_main_to_preview.ps1' -ApprovedMainSha <A> -UserGo
```

Эквивалентные ключи Python исполнителя `tools/promote-main-to-preview/promote_main_to_preview.py`:

```text
--approved-main-sha A --user-go
```

Remote-only promotion выполняется **сериализованно с другими Git writers** и только для проверенного полного approved SHA A с отдельным human GO. Executor проверяет actual remote `main=A`, `preview=P`, соответствие свежим fetched refs и ancestry `P → A` (или подтверждённый no-op при `P=A`). Непосредственно перед push он свежо сверяет **оба** actual remote refs: движение `main` или `preview`, обнаруженное **до** push, — **STOP** без автоматического retry/переподтверждения. Если ancestry/fast-forward не доказаны или push завершился ошибкой — также STOP без обхода.

При `P != A` выполняется **один** обычный non-force push литерала `A:refs/heads/preview`, без force/lease, и обязательная последующая проверка **фактического** `preview=A`. Между pre-push сверкой и push остаётся окно гонки: серверный Git запрещает non-fast-forward, но обычный push **не является атомарной CAS** и не доказывает неизменность обоих refs. Если `main` успеет сдвинуться **после** push, результат содержит warning; `preview` остаётся на **проверенном A**, новый HEAD автоматически не продвигается. Не запускать retry/fallback и не подбирать новый SHA без отдельного GO.

Исполнитель не проверяет и не изменяет постоянные worktree `main`/`preview`: нет checkout/reset/stash/clean, локальной синхронизации или удаления. **Только после подтверждённого remote stable успеха** можно **отдельно** запросить существующий локальный ff-only update `tools/preview-worktree/preview_worktree.ps1 -Action update`. Именно для этой опциональной локальной операции обязательны известное **чистое** состояние preview worktree и допустимый safe fast-forward; при dirty/unknown/diverged дереве локальный update останавливают и сохраняют пользовательские данные. Эти условия не блокируют remote-only promotion, который деревья не затрагивает.

```text
main:     ... ── A  (проверенный целиком, approved)
preview:  ... ─────┘  (A является потомком preview)
             non-force fast-forward only, preview HEAD = A
```

Никакого stable PR, PR-body marker, merge commit, собственных preview commits, автоматической синхронизации после task PR. `main` остаётся интеграционной и получает обычные новые задачи; `preview` остаётся на последнем явно утверждённом SHA до следующего отдельного GO.

## 6. GitHub CI guard

`.github/workflows/preview-policy.yml`: тот же `pull_request` trigger, job ID `preview-branch-policy`, check name `Preview Branch Policy / preview-branch-policy`, права `contents: read`. Final branch-route contract:

- PR `temporary task head → main` разрешён (но merge только по отдельному решению пользователя);
- PR с head `main` или `preview` — не обычная task branch, в `main` запрещён;
- **любой** PR с base=`preview` запрещён, даже если head временная ветка или `main`;
- любые другие base branches запрещены.

CI guard не заменяет решение пользователя и не выполняет stable update. Нельзя выключать guard или создавать временный двойной маршрут по умолчанию.

## 7. Однократная административная миграция

Это исключительный переход от *старых* правил, по которым обычные PR шли в `preview`, а `preview → main` требовал отдельный PR. Эти старые маршруты более не являются действующими правилами, после принятия нового policy.

1. В отдельной временной **административной** ветке подготовить согласованные G1/G2/G3 изменения и единый `task → main` migration PR. Зафиксировать отдельное explicit owner-approved исключение старого guard **только** для этого PR; не переключать ordinary task на два маршрута.
2. Проверить фактическую GitHub конфигурацию на момент действия (main default, protections/rulesets/required checks). Первоначально наблюдались: default=`main`, для main и preview protection endpoint 404 `Branch not protected`, rulesets=`[]`; это лишь historical snapshot, **не** постоянная гарантия защиты или её отсутствия.
3. До merge предъявить реальное подтверждение, что **изменённый** `.github/workflows/preview-policy.yml` был запущен по `pull_request` для *этого* migration PR и его exact head SHA с успешным ожидаемым check. Локальный unittest или зелёный run старого guard — не доказательство. Если старое правило не даёт реально запустить/принять новое: STOP, новый согласованный план; не отключать guard, не force, не автоматический fallback или обход.
4. По отдельному решению owner выполнить task squash merge **в `main`**, убедиться в exact remote SHA. `preview` не трогать. Старые open preview PR не retarget/rebase автоматически: после cutoff их судьба — отдельное решение owner.
5. После merge проверить **активный** DSH GUI `4173`: source/установку/нужный штатный restart, загруженные Host и навыки и новую Leader session. Проверить фактический task prepare от `origin/main`; одно изменение Git source не обновляет текущий процесс. Миграционный PR не является user stable GO.
6. Отдельно проверить весь кандидатный `origin/main` SHA A и запросить явный stable GO; только тогда процедура раздела 5 может продвинуть `preview` к A безопасным fast-forward. Пока этого нет, старый stable `preview` сохраняется.

Нет registry migration, массовой перенастройки закреплённых REQ/packages/tasks, удаления постоянных worktree или изменения существующих trust/grant/runner authority. Если требуется починка запуска preview Harness, это отдельная задача.

## 8. Task merge и границы очистки

```text
base = main
head = temporary task branch
merge method = squash
cleanup temporary resources = best effort after proving no unique data loss
main/preview permanent branches and worktrees = protected
```

Executor:

```text
tools/finalize-task-pr/finalize_task_pr.ps1
```

Запрещены по умолчанию force push, `git reset --hard`, blind clean/stash, удаление постоянных worktree, чужих данных/первичных untracked. Упомянутое здесь не разрешает merge в обход approved workflow.

## 9. Короткая схема

```text
new task @ origin/main ── temporary branch ──PR/squash──▶ main
                                                          │
                                        full SHA A tested + explicit human stable GO
                                                          │
                                                          ▼
                                                        preview
                                                  (non-force FF to A)
```

## 10. Сохранение прежних REQ/веток

Ранее опубликованные SHA-pinned REQ, их worktree, metadata и packageBase остаются как есть. К совместимости нового patch применяется `git apply --check`; Host не переписывает bindings/registry при миграции. PR старого маршрута base=`preview` запрещаются новым guard и рассматриваются owner-ом отдельно, без массового retarget. Текущий Direct main маршрут не менять.

## 11. Локальный запуск Harness из `preview`

`PREVIEW_HARNESS_LAUNCHER_VERSION: 1`

Main и preview запускаются как два независимых локальных экземпляра:

```text
main    C:\Users\andre\.dsh          http://127.0.0.1:4173/
preview C:\Users\andre\.dsh-preview  http://127.0.0.1:4174/
```

После первого merge launcher-патча в `preview` и обновления постоянного preview worktree один раз подготовить зависимости:

```powershell
& 'C:\Users\andre\.dsh-preview\tools\deepseek-harness-launcher\Prepare-DSH-Preview.ps1'
```

Опционально, только по явному решению пользователя, можно сделать одноразовую локальную копию `settings.yaml`, `.credentials.yaml` и `codex-oauth.json` из main без перезаписи уже существующих preview-файлов:

```powershell
& 'C:\Users\andre\.dsh-preview\tools\deepseek-harness-launcher\Prepare-DSH-Preview.ps1' -SeedLocalConfig
```

`SeedLocalConfig` не копирует `sessions/`, `storages/`, `attachments/`, журналы и другие runtime/user-data.

Запуск, остановка и перезапуск preview:

```text
tools\deepseek-harness-launcher\start-dsh-preview.bat
tools\deepseek-harness-launcher\stop-dsh-preview.bat
tools\deepseek-harness-launcher\restart-dsh-preview.bat
```

Preview launcher использует отдельные `cwd`, port `4174`, mutex и launcher state в `%LOCALAPPDATA%\DeepSeekHarnessLauncher-Preview`. Main launcher сохраняет defaults `C:\Users\andre\.dsh` + `4173`.

Контроллер передаёт точную runtime identity (`cwd/profile/port/launcher-root/controller/restart-helper`) в дочерний DSH process. Поэтому встроенный `dsh-restart-web` наследует identity текущего экземпляра: Restart из preview остаётся в preview и не должен перезапускать main.

Подробности: [`tools/deepseek-harness-launcher/PREVIEW-LAUNCHER.md`](../../tools/deepseek-harness-launcher/PREVIEW-LAUNCHER.md).
