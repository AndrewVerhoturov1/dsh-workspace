# Implementation Package Workflow

id: implementation-package-workflow
status: canonical
language: ru

## 1. Назначение

Этот документ задаёт канонический процесс подготовки и внедрения implementation-пакетов для `AndrewVerhoturov1/dsh-workspace`.

Главный принцип:

> Модель готовит содержимое изменения. Репозиторий владеет применением, минимальной механической проверкой и диагностикой.

После установки центрального runner-а внешняя модель **не должна писать новый applicator для каждого ZIP**. Обычный implementation package — декларативный: manifest + unified patch + список только нужных целевых тестов.

[Implementation Package Authoring Contract](implementation-package-authoring.md) — канонический contract именно для автора package; этот workflow описывает полный lifecycle его применения.

Роли:

- **ChatGPT / другая внешняя модель** — проектирует решение, готовит `changes.patch`, manifest и при необходимости новые regression tests внутри patch.
- **Central implementation package runner** — одинаково для всех пакетов проверяет реальную применимость patch, защищает постоянные worktree/локальные данные, применяет patch, запускает только объявленные targeted tests и создаёт компактную диагностику при FAIL.
- **Luna / локальный агент** — создаёт отдельный clean implementation worktree, запускает центральный runner, а после PASS делает commit/push/PR. Она не чинит package вручную.
- **Пользователь** — принимает решение о merge; promotion `preview → main` остаётся отдельным explicit действием.

## 2. Канонический runner

Единственный обычный applicator implementation-пакетов:

```text
system/implementation_package_runner.py
```

Обычный запуск внутри отдельного temporary implementation worktree:

```text
python system/implementation_package_runner.py apply <PACKAGE.zip>
```

Опциональный dry-run без записи:

```text
python system/implementation_package_runner.py check <PACKAGE.zip>
```

`apply` уже выполняет те же лёгкие проверки перед записью, поэтому `check` не является обязательной бюрократической стадией. Локальный агент может запускать сразу `apply`, если пользователь не попросил отдельный dry-run.

## 3. Формат будущего package

Нормальный ZIP:

```text
PACKAGE.zip
├─ manifest.json
├─ changes.patch
├─ README.md       # optional, для человека
└─ TEST_PLAN.md    # optional, для человека
```

Никакого package-local `apply_package.py`, `run_package.py`, собственного Git workflow или собственного diagnostics framework по умолчанию нет.

Все repository changes, включая новые файлы и новые тесты, входят в `changes.patch`.

### manifest.json

Минимальный пример:

```json
{
  "schemaVersion": 1,
  "package": "postman-example-fix",
  "repository": "AndrewVerhoturov1/dsh-workspace",
  "baseBranch": "preview",
  "prBase": "preview",
  "packageBase": "optional-informational-sha",
  "patch": "changes.patch",
  "tests": [
    {
      "name": "targeted postman tests",
      "command": ["python", "-m", "unittest", "-q", "postman.direct.tests.test_example"],
      "timeoutSeconds": 300
    }
  ]
}
```

JSON Schema находится в:

```text
system/implementation_package_schema.json
```

`command` — argv-массив. Runner запускает его напрямую с `shell=False`; shell-quoting от LLM не нужен.

## 4. Что является hard FAIL

Runner намеренно имеет маленький набор блокирующих проверок.

Он останавливается только при реальной проблеме:

1. это не Git repository или не тот `owner/repository`;
2. запуск идёт прямо на защищённой ветке `main`/`preview` или в постоянном worktree;
3. temporary implementation worktree уже dirty до применения;
4. ZIP/manifest повреждён либо пытается использовать небезопасный путь;
5. patch затрагивает явно локальные защищённые данные (`.git`, root `settings.yaml`, root `.env`, root `attachments/`);
6. `git apply --check` говорит, что patch действительно не применяется;
7. сам `git apply` завершился ошибкой;
8. `PATCH_CREATES_IGNORED_FILE`: после применения полного patch новый затронутый файл остаётся ignored обычным Git и потому может пройти локальные tests, но потеряться при обычном commit;
9. один из **объявленных targeted tests** завершился non-zero/timeout.

Это и есть обычные hard gates.

## 5. Что НЕ является hard FAIL

Runner не должен останавливать нормальное внедрение из-за административных расхождений.

Не являются обязательным blocker:

- `origin/preview` продвинулся после создания package, если `git apply --check` всё ещё проходит;
- `packageBase` не равен текущему HEAD;
- исходный blob SHA изменился, если Git всё ещё может корректно применить patch;
- exact changed-file inventory отличается от заранее записанного списка;
- tracked/untracked представление нового файла отличается;
- количество изменённых файлов не совпало с отдельным счётчиком;
- отсутствует полный regression suite;
- `git diff --check` выдал whitespace warning.

`git diff --check` выполняется для видимости, но является **warning**, а не blocker. Whitespace не должен превращать рабочее изменение в ложный FAIL.

Главный compatibility authority:

```text
git apply --check changes.patch
```

Если Git может применить patch и targeted tests проходят, обычный runner не придумывает дополнительные причины остановиться.

## 6. Почему не нужен постоянный Sol-validator

LLM-review может быть полезен для архитектуры, но не является каноническим механическим gate.

Обычный порядок:

```text
модель создаёт patch
→ deterministic local runner
→ git apply --check
→ git apply
→ targeted tests
→ PASS
```

Sol/другая сильная модель нужна только когда есть реальный смысловой blocker или непонятный FAIL. Не нужно тратить сильную модель на постоянное повторение работы Git и тестов.

## 7. Diagnostics при FAIL

При любом hard FAIL runner автоматически создаёт компактный ZIP во временном каталоге ОС:

```text
failure.json
git-status.txt
git-diff-stat.txt
git-diff-check.txt
stdout.txt
stderr.txt
runner-log.txt
```

Он не добавляет environment dump, системный инвентарь, содержимое repository или сам patch.
Из stdout/stderr маскируются распространённые токены и значения sensitive environment variables.

FAIL означает:

```text
STOP
→ diagnostics ZIP
→ package возвращается модели на исправление
```

Локальный агент не перепроектирует и не дописывает package вручную.

## 8. Работа с worktree

Постоянные worktree:

```text
C:\Users\andre\.dsh
C:\Users\andre\.dsh-preview
```

Implementation package туда не применяется.

Обычная схема:

```text
origin/preview
→ отдельная temporary task branch
→ отдельный clean worktree
→ central runner apply
```

Runner не выполняет `git reset --hard`, `git clean`, auto-stash, force push и не удаляет пользовательские данные.

На FAIL dirty temporary worktree можно оставить для диагностики. Постоянные worktree не затрагиваются.

## 9. Тесты

В manifest указываются только **относящиеся к изменению** команды.

Не требуется автоматически запускать весь repository regression suite для каждой маленькой задачи.

Хороший набор:

```text
syntax/compile, если нужен конкретному изменению
+
новый regression test
+
1 затронутый subsystem test, если он реально полезен
```

Документационный package может иметь `tests: []`, если для него нет осмысленного исполняемого теста.

Runner не выбирает тесты сам и не вызывает LLM.

## 10. Publication после PASS

Central runner **не делает GitHub writes**.

После `IMPLEMENTATION_PACKAGE_APPLIED` локальный агент выполняет обычный repository lifecycle:

```text
review git status/diff на уровне задачи
→ git add -A
→ commit
→ push temporary task branch
→ verify remote SHA
→ create/update PR в preview
→ verify package-created new files exist in remote commit/PR
→ STOP без merge
```

`git add -f` запрещён. Эта проверка после публикации не является exact-file-inventory gate до применения package.

Merge — только после отдельного решения пользователя.

Runner не выполняет commit/push/PR, чтобы application и публикация оставались разными границами ответственности.

## 11. Что модель должна выдавать после внедрения этой системы

Будущему ChatGPT достаточно подготовить:

```text
manifest.json
changes.patch
README.md / TEST_PLAN.md при необходимости
```

Перед выдачей желательно локально/в sandbox проверить, что patch синтаксически валиден. Но package не должен содержать очередной новый framework проверки.

Если package несовместим с текущим preview:

```text
git apply --check → FAIL
```

это нормальный честный сигнал на пересборку patch.

## 12. Канонический принцип

> Строгость нужна там, где можно потерять данные или применить изменение не туда.

> Совместимость проверяет Git. Работоспособность проверяют целевые тесты. Остальное не должно становиться бюрократическим blocker без конкретной причины.

> Один центральный runner лучше, чем новый LLM-generated applicator в каждом ZIP.
