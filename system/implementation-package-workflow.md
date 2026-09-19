# Implementation Package Workflow

id: implementation-package-workflow
status: canonical
language: ru

## 1. Назначение

Этот документ задаёт канонический процесс подготовки и внедрения implementation-пакетов для репозитория `AndrewVerhoturov1/dsh-workspace`.

Главный принцип:

> ChatGPT готовит всю реализацию, все необходимые файлы, патчи, applicator-скрипты и тесты. Luna не проектирует решение и не исправляет код самостоятельно. Luna только проверяет совместимость пакета, механически внедряет его, запускает тесты, публикует implementation branch/PR и сообщает результат.

Цель процесса — разделить ответственность:

- **ChatGPT** отвечает за архитектуру и содержимое implementation package.
- **Luna** отвечает за безопасное механическое внедрение и проверку.
- **Пользователь** принимает решение о merge и отдельно разрешает promotion `preview → main`.

## 2. Область применения

Этот workflow используется, когда ChatGPT готовит ZIP или другой implementation package, предназначенный для внедрения локальным агентом Luna.

Он не заменяет:
- `REPO_POLICY.md`;
- Postman transport/artifact policy;
- правила merge/cleanup;
- правила Direct Postman RESULT_DURABLE lifecycle.

При конфликте с более строгим правилом безопасности репозитория применяется более строгая защита пользовательских данных.

## 3. Роли

### 3.1. ChatGPT

ChatGPT обязан:

1. Изучить актуальную реализацию и определить точную область изменения.
2. Подготовить все изменения самостоятельно.
3. Подготовить необходимые regression tests.
4. Подготовить механический способ внедрения:
   - готовый patch, если он надёжно применим;
   - либо deterministic applicator, если patch хрупок или изменение сложное.
5. Зафиксировать compatibility guards.
6. Зафиксировать exact `baseBranch` и `packageBase`.
7. Подготовить test plan.
8. Подготовить инструкцию Luna.
9. Упаковать всё в единый ZIP.
10. Не перекладывать проектирование, исправление или адаптацию реализации на Luna.

Если implementation package несовместим с текущим repository state, пакет возвращается ChatGPT на пересборку.

### 3.2. Luna

Luna обязана:

1. Не проектировать альтернативное решение.
2. Не переписывать подготовленный код.
3. Не исправлять package самостоятельно.
4. Проверить repository state.
5. Использовать отдельный clean implementation branch/worktree.
6. Создать обычную implementation branch от exact `origin/preview`, если manifest не объявляет узкое migration/bootstrap исключение с другой базой.
7. Выполнить package `check`/dry-run до записи.
8. Применить package только после успешной проверки.
9. Запустить указанные targeted и full regression tests.
10. Выполнить `git diff --check`.
11. При PASS:
    - commit;
    - push;
    - открыть PR в `preview` для обычной implementation task;
    - открыть PR в явно объявленную manifest базу только для migration/bootstrap пакета, подготовленного именно для такой операции.
12. Не выполнять merge без отдельного явного разрешения пользователя.
13. При реальной несовместимости или regression — STOP и точный отчёт.

### 3.3. Пользователь

Пользователь:

- принимает или отклоняет результат;
- отдельно разрешает merge task PR в `preview`;
- отдельно разрешает promotion `preview → main`;
- при необходимости разрешает исключение из workflow.

## 4. Структура implementation package

Рекомендуемый формат:

```text
PACKAGE.zip
├─ README.md
├─ START_PROMPT.txt
├─ LUNA_IMPLEMENTATION_PROMPT.md
├─ manifest.json
├─ TEST_PLAN.md
├─ apply_package.py
├─ files/
├─ patches/
└─ tests/
```

Допускается упрощённая структура для малых задач, но роли и проверки из этого документа сохраняются.

## 5. Manifest

`manifest.json` должен по возможности содержать:

```json
{
  "package": "PACKAGE_NAME",
  "repository": "AndrewVerhoturov1/dsh-workspace",
  "baseBranch": "preview",
  "packageBase": "<full SHA>",
  "prBase": "preview",
  "delivery": "patch|hash-guarded-applicator|exact-files",
  "targetFiles": [],
  "expectedTargetBlobSha1": {},
  "packageFiles": []
}
```

Для сложных изменений рекомендуется фиксировать exact Git blob SHA каждого исходного target-файла.

Обычная package base — `preview`. `main` допустим как `baseBranch` только для явно описанного migration/bootstrap, который нельзя безопасно начать от ещё не существующего `preview`, либо для отдельной административной операции с явным user approval.

## 6. Совместимость с продвинувшейся базовой веткой

Нельзя требовать `origin/<baseBranch> == packageBase` без необходимости.

Допустимо продолжить, если одновременно:

1. `packageBase` является предком текущего `origin/<baseBranch>`;
2. целевые source-файлы, на которые рассчитан package, не изменились;
3. compatibility guards подтверждают это;
4. package check проходит.

Transport-only advancement, например добавление `REQ_*.md`, само по себе не является причиной для STOP.

Если целевой source-файл изменился — package не адаптируется Luna. Нужна пересборка ChatGPT.

## 7. Предпочтительный applicator

Для сложных изменений предпочтителен deterministic hash-guarded applicator.

Он должен поддерживать минимум:

```text
--check
--apply
```

### `--check`

Не изменяет repository.

Должен проверить:

- repository root;
- implementation branch/worktree не является постоянным `main` или `preview`;
- clean implementation worktree;
- manifest `baseBranch` и package base ancestry;
- exact target blob SHA или другой надёжный compatibility guard;
- наличие всех source anchors;
- возможность построить новые файлы;
- syntax/compile для генерируемого кода.

### `--apply`

Повторяет guards и затем:

1. строит все новые версии файлов до записи;
2. записывает только заранее объявленные target-файлы;
3. создаёт только заранее объявленные новые файлы;
4. проверяет exact changed-path inventory;
5. выполняет `git diff --check`;
6. при собственной ошибке записи/валидации откатывает только изменения, внесённые самим applicator.

Applicator не имеет права:
- выполнять `reset --hard`;
- выполнять `git clean`;
- делать auto-stash;
- менять dirty постоянный worktree `C:\Users\andre\.dsh`;
- менять dirty постоянный worktree `C:\Users\andre\.dsh-preview`;
- force-push;
- удалять неизвестные пользовательские данные.

## 8. Patch packages

Unified patch допустим, если ChatGPT реально проверил его применение к нужной базе.

Минимальная проверка перед выдачей:

```text
git apply --check
```

Если package зависит от hunk offsets и изменения крупные, предпочтительнее applicator с source guards.

Luna не должна вручную чинить reject/conflict patch.

## 9. Тесты

Implementation package должен содержать `TEST_PLAN.md` или эквивалентную инструкцию.

Минимально:

1. syntax/compile изменённых source-файлов;
2. targeted tests новой функциональности;
3. regression tests затронутого subsystem;
4. полный canonical regression suite, если он существует;
5. `git diff --check`.

Если проект содержит Node/JS validator/runtime tests, связанные с изменением, они также запускаются.

Новый regression test должен проверять не только успешный happy path, но и основные safety boundaries.

## 10. PREPARE-specific принцип

Для Direct Postman PREPARE действует принцип:

> proceed unless there is a concrete safety, ownership or application conflict.

Unrelated branch, worktree, PR или исторический receipt сами по себе не должны становиться глобальным mutex.

Hard STOP должен сохраняться для конкретных рисков, например:

- repository/request identity mismatch;
- artifact SHA mismatch;
- unsafe/protected path;
- current-REQ worktree/branch ownership collision;
- dirty или неизвестный current-REQ worktree;
- real patch conflict;
- whole-file stale overwrite;
- попытка затронуть пользовательские данные;
- невозможность доказать совместимость package.

## 11. RESULT_DURABLE

Если Postman уже получил валидированный `RESULT_DURABLE`, implementation/finalization package не должен без причины запускать новый Postman transport или повторно обращаться к Ch1.

Resume должен использовать существующий durable result, если его identity и SHA подтверждены.

## 12. Работа с постоянными worktree

Постоянные worktree:

```text
C:\Users\andre\.dsh          → main
C:\Users\andre\.dsh-preview → preview
```

Если любой из них dirty:

- не очищать;
- не stash-ить автоматически;
- не reset-ить;
- не использовать как место application;
- не удалять.

Обычная implementation выполняется в отдельном clean worktree от проверенного `origin/preview`.

Migration package может использовать отдельный clean worktree от объявленного `origin/main`, только если manifest явно фиксирует это как migration/bootstrap exception.

## 13. Publication lifecycle

После успешного внедрения обычной task:

```text
CHECK
→ APPLY
→ TARGETED TESTS
→ FULL REGRESSION
→ git diff --check
→ COMMIT
→ PUSH
→ PR в preview
```

На этом Luna останавливается.

Migration/bootstrap package следует exact `prBase`, указанному в manifest. Такой пакет не превращает `main` обратно в обычную task base.

Task merge:

```text
только после отдельного явного разрешения пользователя
→ squash merge в preview
```

Release promotion:

```text
отдельный explicit user GO
→ preview → main
→ merge commit, не squash
```

После task merge выполняется безопасный cleanup только доказанно принадлежащих этой работе временных branch/worktree/resources. Постоянные `main`/`preview` и их два канонических worktree cleanup не затрагивает.

## 14. Failure contract

При несовместимости package Luna не ремонтирует его.

Она должна сообщить:

- manifest `baseBranch`;
- current `origin/<baseBranch>`;
- implementation branch/worktree;
- failing guard;
- failing source file/hash/anchor;
- failing test;
- какие файлы были изменены до failure;
- был ли выполнен rollback;
- были ли commit/push/PR.

После этого ChatGPT пересобирает implementation package.

## 15. Обязательные status flags

В финальном отчёте Luna для подобных задач желательно указывать:

```text
Postman invoked=
new REQ created=
Ch1 contacted=
ORCA invoked=
mergePerformed=
dirty main worktree touched=
dirty preview worktree touched=
```

## 16. Канонический принцип

> Все implementation decisions и готовые изменения находятся в package. Luna — исполнитель и тестировщик, а не второй разработчик.

> Если package не подходит к текущему коду, исправляется package, а не процесс внедрения вручную.

> Обычная разработка живёт в цикле `preview → temporary task branch → preview`; `main` обновляется только отдельным promotion после explicit user GO.
