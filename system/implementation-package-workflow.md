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

- **Sol** — задаёт intent, существенные архитектурные решения и ограничения, а после результата отдельно решает, использовать ли REQ.
- **ChatGPT Web / другая внешняя модель** — исследует код, реализует замысел Sol и принимает необходимые implementation-level решения в заданных границах; готовит декларативный ZIP: `manifest.json`, созданный Git `changes.patch`, `README.md`, `TEST_PLAN.md` и необходимые целевые тесты внутри patch. Web не обязана публиковать изменения в Git или всегда запускать все тесты; фактические проверки указываются честно.
- **Central implementation package runner** — одинаково для всех пакетов проверяет реальную применимость patch, защищает постоянные worktree/локальные данные, применяет patch, запускает только объявленные targeted tests и создаёт компактную диагностику при FAIL.
- **Host / Worker** — после trusted `RESULT_DURABLE` Host сохраняет process-local grant по `(Leader session, REQ)` для exact ZIP/SHA. После отдельного решения Sol допускает REQ через `postman_worker({task, artifactRequestId})`. Тот же продолжаемый Worker создаёт чистое временное worktree и вызывает `implementation_artifact_apply({requestId, worktree})`; Host повторно проверяет SHA и запускает существующий runner. PASS означает `report`, FAIL — diagnostics без ручного ремонта. Публикация применённых изменений требует отдельного решения Sol.
- **Пользователь** — принимает решение о merge; promotion `preview → main` остаётся отдельным explicit действием.

## 2. Канонический runner

Единственный обычный applicator implementation-пакетов:

```text
system/implementation_package_runner.py
```

В доверенном Postman flow Worker в отдельном temporary implementation worktree вызывает:

```text
implementation_artifact_apply({requestId: "REQ_...", worktree: "<clean worktree>"})
```

Host подставляет сохранённый trusted ZIP из grant и запускает runner с `python -X utf8 system/implementation_package_runner.py apply <trusted ZIP> --repo <clean worktree>`. Указанный путь — внутренний аргумент Host, не выбираемый Worker из задания. Для иных явно разрешённых локальных пакетов прямой запуск runner остаётся возможным.

Опциональный dry-run без записи:

```text
python system/implementation_package_runner.py check <PACKAGE.zip>
```

`apply` уже выполняет те же лёгкие проверки перед записью, поэтому `check` не является обязательной бюрократической стадией. Локальный агент может запускать сразу `apply`, если пользователь не попросил отдельный dry-run. После `validate_patch` оба результата могут содержать `affectedPaths`: это authoritative пути фактически затрагиваемого patch, а не compatibility gate, expected inventory или проверка числа файлов. `check` остаётся dry compatibility check и не запускает post-apply проверку ignored-файлов или tests.

## 3. Формат будущего package

Нормальный ZIP:

```text
PACKAGE.zip
├─ manifest.json
├─ changes.patch
├─ README.md
└─ TEST_PLAN.md
```

Никакого package-local runner, installer, `apply_package.py`, `run_package.py`, собственного Git workflow, diagnostics framework или Git publication нет.

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

## 6. Отдельное решение Sol и механическая проверка

Sol принимает отдельное смысловое решение о применении trusted REQ для полученного ZIP; это не автоматический этап транспорта и не замена механической проверке Git и тестами.

Обычный порядок:

```text
модель создаёт patch
→ deterministic local runner
→ git apply --check
→ git apply
→ targeted tests
→ PASS
```

Sol не повторяет работу Git и тестов как дополнительный механический gate. После положительного решения тот же продолжаемый Worker вызывает доверенный Host tool с REQ и worktree, а Host запускает существующий runner; нового runner нет.

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
→ Sol решает: исследовать дальше, запросить новый ZIP у модели или остановиться
```

Worker не перепроектирует и не дописывает package вручную; FAIL передаётся как точные diagnostics, без ремонта.

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
→ trusted RESULT_DURABLE и process-local Host grant для exact Leader session + REQ
→ отдельное решение Sol: postman_worker({task, artifactRequestId})
→ тот же продолжаемый Worker
→ отдельная временная task branch и чистое временное worktree
→ implementation_artifact_apply({requestId, worktree})
→ Host подставляет trusted ZIP, повторно проверяет SHA и запускает central runner apply
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

## 10. Отчёт после PASS и отдельная публикация

Central runner **не делает GitHub writes**.

После `IMPLEMENTATION_PACKAGE_APPLIED` Worker проверяет фактический результат и сообщает Sol PASS и точный результат runner-а через `report`. Это не разрешение автоматически публиковать применённые изменения. Если Sol отдельно решит их публиковать, локальный Worker выполняет обычный repository lifecycle согласно `REPO_POLICY.md`:

```text
review git status/diff на уровне задачи
→ взять affectedPaths из exact runner result
→ git add -A -- <affectedPaths>
→ commit
→ push temporary task branch
→ verify remote SHA
→ create/update PR в preview
→ verify package-created new files exist in remote commit/PR
→ STOP без merge
```

`affectedPaths` — staging boundary, а не compatibility gate, expected/exact inventory validation или проверка числа файлов. Локальный агент staging-ит только эти пути: посторонние untracked/generated файлы, появившиеся во время targeted tests, не входят в commit автоматически. При большом списке путей их передают Git argv-safe несколькими группами, не собирая shell-строку. `git add -f` запрещён.

Merge — только после отдельного решения пользователя.

Runner не выполняет commit/push/PR, чтобы application и публикация оставались разными границами ответственности. Normal Postman transport универсален и лишь доставляет результат; он не создаёт worktree/ветку и не запускает runner или публикацию. Trusted `RESULT_DURABLE` с exact ZIP/SHA подтверждает только происхождение и целостность полученного файла, но не его применимость, качество, разрешение на применение или публикацию.

## 11. Что модель должна выдавать после внедрения этой системы

Будущему ChatGPT достаточно подготовить:

```text
manifest.json
Git-generated changes.patch
README.md
TEST_PLAN.md
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
