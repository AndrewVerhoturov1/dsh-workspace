# Implementation Package Authoring Contract

id: implementation-package-authoring  
status: canonical  
language: ru

## 1. Назначение

Этот документ задаёт канонические правила подготовки implementation package внешней моделью для репозитория `AndrewVerhoturov1/dsh-workspace`.

Он применяется вместе с:

```text
REPO_POLICY.md
system/implementation-package-workflow.md
system/implementation_package_schema.json
system/implementation_package_runner.py
```

При конфликте действуют repository policy и более строгое правило защиты пользовательских данных.

Главный принцип:

> ChatGPT Web владеет содержимым декларативного ZIP. Sol отдельно решает, применять ли его; тот же продолжаемый Worker запускает существующий runner в чистом временном worktree. Runner владеет механической безопасностью и диагностикой. Публикация будущего ZIP — отдельное решение, не следствие PASS.

Внешняя модель не создаёт новый applicator, diagnostics framework или Git workflow для каждого ZIP.

---

## 2. Роли

### 2.1. Внешняя модель

Внешняя модель обязана самостоятельно:

1. изучить актуальное состояние задачи и затрагиваемого кода;
2. спроектировать решение;
3. подготовить все продуктовые изменения;
4. подготовить необходимые targeted/regression tests;
5. сформировать корректный Git patch;
6. сформировать `manifest.json`;
7. подготовить короткие `README.md` и `TEST_PLAN.md`;
8. проверить package настолько полно, насколько позволяет среда;
9. передать готовый ZIP и SHA-256 через обычный Postman transport. Web не обязана публиковать Git-изменения или всегда запускать все тесты; она честно перечисляет фактически выполненные проверки.

Модель не перекладывает на Worker:

- проектирование;
- написание недостающего кода;
- исправление patch;
- выбор архитектуры;
- адаптацию package после FAIL;
- создание дополнительных файлов, которые должны были находиться в package;
- ручное исправление `.gitignore` после применения package.

Если package несовместим или неполон, его пересобирает внешняя модель.

### 2.2. Central implementation package runner

Runner:

- проверяет repository/worktree safety;
- проверяет `git apply --check`;
- защищает локальные данные;
- применяет patch;
- проверяет, что patch не создал Git-ignored файлы, которые потеряются при обычном commit;
- запускает только объявленные targeted tests;
- создаёт diagnostics ZIP при hard FAIL.

Runner не проектирует решение и не вызывает LLM.

### 2.3. Sol и продолжаемый Worker

Sol принимает отдельное решение о применении exact ZIP. При положительном решении тот же продолжаемый Worker создаёт clean temporary worktree и запускает существующий центральный runner; он не ремонтирует package. При PASS Worker возвращает отчёт, при FAIL — точные diagnostics без исправлений. Commit/push/PR будущего ZIP допускаются только после отдельного решения о публикации и по `REPO_POLICY.md`; merge требует отдельного разрешения пользователя.

---

## 3. Канонический формат ZIP

Обычный implementation package:

```text
PACKAGE.zip
├─ manifest.json
├─ changes.patch
├─ README.md
└─ TEST_PLAN.md
```

Все изменения repository находятся в одном `changes.patch`, включая:

- изменение существующих файлов;
- новые файлы;
- удаления;
- новые тесты;
- документацию;
- необходимые изменения `.gitignore`.

Package не содержит собственного механизма применения.

По умолчанию запрещены package-local runner, installer и Git publication, в частности:

```text
apply_package.py
run_package.py
apply.ps1
check.ps1
diagnostics.py
package-local Git workflow
package-local diagnostics framework
package-local compatibility framework
```

Исключение: файл с подобным именем допустим, если он является именно продуктовым файлом задачи и должен остаться в repository после merge.

---

## 4. Golden path подготовки package

Канонический путь:

```text
актуальный origin/preview
↓
disposable authoring worktree/shadow
↓
полная реализация задачи
↓
targeted/regression tests
↓
проверка Git visibility всех новых файлов
↓
при необходимости — узкие .gitignore exceptions внутри того же изменения
↓
git add -A -- <authoring paths>
↓
Git-generated staged diff
↓
changes.patch
↓
проверка patch на втором clean shadow/worktree
↓
manifest.json
↓
README.md + TEST_PLAN.md
↓
ZIP
↓
SHA-256
↓
короткий handoff результата
```

---

## 5. Исходная база

Обычная задача проектируется относительно актуального `origin/preview`.

В manifest:

```json
{
  "baseBranch": "preview",
  "prBase": "preview"
}
```

`packageBase` может содержать observed SHA во время подготовки, но является информационным полем.

Нельзя превращать его в условие:

```text
current preview SHA == packageBase
```

Продвижение `preview` само по себе не делает package несовместимым.

Главный compatibility authority:

```text
git apply --check changes.patch
```

Если Git всё ещё применяет patch, stale `packageBase` не является blocker.

---

## 6. Как должен создаваться changes.patch

### Главное правило

> Unified patch должен генерироваться инструментом diff/Git из реальных конечных файлов, а не собираться LLM вручную строка за строкой.

Запрещено вручную сочинять hunk headers и контекст, если существует возможность получить настоящий Git diff.

Рекомендуемый путь в disposable authoring environment:

```text
git add -A -- <authoring paths>
git diff --cached --binary --no-ext-diff HEAD -- <authoring paths>
```

Полученный вывод становится `changes.patch`.

Использование temporary staging здесь допустимо: это disposable authoring environment, а не пользовательский implementation worktree. `<authoring paths>` — реальные пути изменения в этой disposable среде; это не `affectedPaths` runner-а и не правило publication после PASS.

Нельзя использовать `git add -f` для обхода `.gitignore`.

---

## 7. Обязательное правило для .gitignore

### 7.1. Новый продуктовый файл не может оставаться ignored

Если задача требует добавить продуктовый файл, но текущий `.gitignore` его исключает из Git, внешний автор package обязан **в этом же `changes.patch` добавить узкое исключение** для требуемого пути.

Пример.

Есть глобальное правило:

```gitignore
**/lib/
```

Задача добавляет repository source:

```text
plugins/example/lib/new-file.js
```

Если `plugins/example/lib/` действительно является исходным кодом repository, package обязан добавить исключение, например:

```gitignore
**/lib/
!plugins/example/lib/
!plugins/example/lib/**
```

И само изменение `.gitignore`, и новый файл входят в один `changes.patch`.

### 7.2. Исключение должно быть минимальным

Нельзя ради одного файла глобально отключать полезное ignore-правило.

Неправильно:

```gitignore
# удалить **/lib/ полностью
```

если repository по-прежнему должен игнорировать большинство generated `lib/`.

Правильно:

```gitignore
**/lib/
!plugins/example/lib/
!plugins/example/lib/**
```

Исключение должно охватывать минимально необходимый repository-owned путь.

### 7.3. Force-add запрещён как решение

Нельзя решать проблему так:

```text
git add -f ignored-file
```

Нельзя инструктировать Worker или локального агента использовать `git add -f`.

Причина: force-add скрывает конфликт repository policy с продуктовыми файлами и позволяет случайно протащить generated/runtime/local data.

Правильный подход:

> Если файл должен постоянно жить в repository, `.gitignore` должен явно разрешать этот путь.

### 7.4. Проверка перед упаковкой

После всех изменений внешний автор должен проверить, что новые продуктовые файлы не являются ignored.

Смысл проверки:

```text
полный patch уже применён
↓
новый файл существует
↓
обычный Git видит его
↓
обычный `git add -A -- <нужный путь>` включит его в commit
```

### 7.5. Канонический hard FAIL runner-а

Если после применения полного patch новый затронутый файл остаётся ignored, runner обязан завершиться:

```text
PATCH_CREATES_IGNORED_FILE
```

Это реальный safety/publication failure, а не административная проверка.

Такой FAIL означает:

> Тесты могут видеть файл локально, но обычный Git commit может его потерять.

При этом Worker не чинит `.gitignore` вручную. Package возвращается внешней модели на пересборку.

### 7.6. Что не считается ошибкой

Уже tracked-файл, который исторически совпадает с ignore-pattern, сам по себе не является проблемой.

Проверка направлена именно на **новые patch-created файлы, которые останутся ignored после полного изменения**.

---

## 8. Минимальный manifest

Пример:

```json
{
  "schemaVersion": 1,
  "package": "descriptive-package-name",
  "repository": "AndrewVerhoturov1/dsh-workspace",
  "baseBranch": "preview",
  "prBase": "preview",
  "packageBase": "informational-observed-sha",
  "patch": "changes.patch",
  "tests": [
    {
      "name": "focused regression",
      "command": [
        "python",
        "-m",
        "unittest",
        "-q",
        "path.to.test"
      ],
      "timeoutSeconds": 300
    }
  ]
}
```

`command` всегда задаётся argv-массивом.

Не создавать shell command string только ради quoting.

---

## 9. Выбор тестов

Manifest содержит только проверки, которые действительно помогают доказать изменение.

Хороший набор обычно:

```text
новый regression test
+
syntax/compile check при необходимости
+
один существующий subsystem test, если он относится к изменению
```

Не требуется автоматически запускать полный regression suite всего repository.

Полный suite нужен только когда:

- изменение действительно широкое;
- затронута общая инфраструктура с большим радиусом влияния;
- repository policy явно требует его для этой подсистемы.

Документационный package может иметь:

```json
"tests": []
```

если исполняемая проверка не имеет смысла.

Нельзя добавлять тесты исключительно ради создания формального gate.

---

## 10. Что является hard FAIL

Hard FAIL должен означать реальную проблему применения, безопасности или публикации.

Канонические hard FAIL:

1. wrong repository identity;
2. protected branch/worktree;
3. dirty implementation worktree до применения;
4. повреждённый/небезопасный package;
5. patch затрагивает protected local-data path;
6. `git apply --check` сообщает, что patch не применяется;
7. `git apply` фактически завершился ошибкой;
8. patch создал новый Git-ignored файл, который обычный commit может потерять;
9. targeted test завершился non-zero/timeout;
10. внутренняя ошибка runner-а.

Для ignored-файла канонический код:

```text
PATCH_CREATES_IGNORED_FILE
```

---

## 11. Что НЕ является hard FAIL

Обычный package не должен блокироваться по:

- exact source blob SHA;
- равенству `packageBase` текущему HEAD;
- exact changed-file inventory;
- exact числу файлов;
- expected-new-file count;
- tracked/untracked bookkeeping само по себе;
- продвижению `preview`;
- отсутствию full regression suite;
- whitespace warning от `git diff --check`.

Эти данные могут быть полезны для диагностики, но не должны становиться blocker без конкретного риска.

Главное правило:

> Совместимость определяет Git. Работоспособность определяют targeted tests. Публикуемость новых файлов определяет обычная Git visibility без force-add.

---

## 12. Проверка package до выдачи

Желательный verification path выполняется в отдельном clean shadow/worktree.

Минимум:

```text
git apply --check changes.patch
↓
git apply changes.patch
↓
проверка ignored patch-created files
↓
targeted tests
```

Не утверждать в финальном отчёте, что проверка выполнена, если она фактически не запускалась.

Если среда Web не позволяет выполнить Git verification или все тесты, это нужно честно указать. После отдельного решения Sol тот же продолжаемый Worker выполнит authoritative runner.

Не создавать ради этой проверки новый framework внутри ZIP.

---

## 13. README.md внутри package

README должен быть коротким.

Он содержит:

```text
что меняется
зачем меняется
какая область repository затронута
какие targeted tests объявлены
есть ли важное migration/compatibility замечание
есть ли необходимые .gitignore exceptions
```

README не должен дублировать полный patch или превращаться в ещё одну policy.

---

## 14. TEST_PLAN.md

TEST_PLAN перечисляет те же осмысленные проверки, которые находятся в manifest.

Пример:

```text
1. node --test plugins/example/lib/new-feature.test.js
   Доказывает новое поведение.

2. node --check plugins/example/lib/index.js
   Проверяет синтаксис изменённого entrypoint.
```

Не записывать десятки проверок «на всякий случай».

---

## 15. Diagnostics

Внешняя модель НЕ создаёт diagnostics collector.

Diagnostics являются обязанностью:

```text
system/implementation_package_runner.py
```

При hard FAIL central runner создаёт компактный diagnostics ZIP с:

```text
failure.json
stdout.txt
stderr.txt
git-status.txt
git-diff-stat.txt
git-diff-check.txt
runner-log.txt
```

Package не дублирует эту систему.

Для `PATCH_CREATES_IGNORED_FILE` диагностика должна явно содержать список затронутых ignored paths в `failure.json` или `runner-log.txt`.

---

## 16. Запрещённые package-local операции

Implementation package не должен:

```text
создавать branch
создавать worktree
commit
push
создавать PR
merge
force-push
git reset --hard
git clean
auto-stash
запускать LLM
изменять permanent worktree
```

Эти операции принадлежат другим слоям workflow.

---

## 17. Поведение при FAIL

Если runner возвращает FAIL:

```text
STOP
↓
diagnostics ZIP
↓
никаких ручных исправлений Worker
↓
package возвращается внешней модели
↓
модель исследует точную ошибку
↓
выдаёт новый replacement package
```

Нельзя инструктировать Worker:

```text
поправь этот файл вручную
добавь недостающий import
сделай git add -f
подправь patch
удали failing test
добавь исключение в .gitignore вручную после FAIL
```

Если исправление требуется — оно должно войти в новый package.

---

## 18. Отчёт после PASS и отдельная публикация

После:

```text
IMPLEMENTATION_PACKAGE_APPLIED
```

Worker сначала сообщает Sol PASS и exact runner result. Только если принято отдельное решение публиковать будущий ZIP, локальный агент выполняет обычный Git lifecycle по `REPO_POLICY.md`:

```text
взять affectedPaths из exact runner result
↓
git add -A -- <affectedPaths>
↓
commit
↓
push task branch
↓
verify remote SHA
↓
create/update PR в preview
↓
remote verify changed files
↓
STOP
```

`affectedPaths` возвращается runner-ом как список фактически затронутых patch путей. Это publication/staging boundary, а не compatibility gate, expected/exact inventory validation или проверка числа файлов. При отдельной публикации агент staging-ит только эти пути; посторонние untracked/generated файлы, созданные targeted tests, не входят в commit автоматически. При большом списке путей агент передаёт их Git argv-safe несколькими группами, не собирая shell-строку.

`git add -f` запрещён.

После отдельно разрешённого push агент обязан убедиться, что новые файлы, созданные package, реально присутствуют в remote commit/PR. Это publication sanity check, а не exact-file-inventory gate до применения.

Central runner не делает commit/push/PR сам.

Merge выполняется только после отдельного явного разрешения пользователя.

---

## 19. Выдача результата внешней модели

После подготовки package внешняя модель должна передать результат через обычный универсальный Postman transport (не специальный канал применения):

```text
1. ZIP
2. SHA-256 ZIP
3. короткое описание
4. результат собственной проверки:
   - git apply --check PASS/не запускался
   - ignored-new-file check PASS/не запускался
   - targeted tests PASS/не запускались
5. короткое описание для отдельного решения Sol
```

Не выдавать пользователю внутренние временные authoring worktree.

---

## 20. Стандартный handoff для Sol и Worker

Обычный текст должен быть коротким:

```text
Получен exact implementation ZIP с SHA-256. Trusted RESULT_DURABLE доказывает только provenance/integrity, не качество или разрешение на применение. Sol отдельно решает, применять ли ZIP. При положительном решении тот же продолжаемый Worker создаёт clean temporary worktree от актуального origin/preview и выполняет:

python -X utf8 system/implementation_package_runner.py apply <TRUSTED_PACKAGE.zip> --repo <CLEAN_WORKTREE>

Путь trusted ZIP подставляет Host, а не Web или Worker. Ничего в package вручную не исправляй и не добавляй дополнительные compatibility gates.

При FAIL остановись и верни exact stage/error и diagnostics ZIP, ничего не ремонтируя.

При PASS верни отчёт и exact runner result; не публикуй автоматически. Только после отдельного решения о публикации возьми `affectedPaths` из exact runner result, выполни `git add -A -- <affectedPaths>`, затем commit, push, verify remote SHA и создай/обнови PR в preview. После push проверь наличие новых package-created файлов в remote commit/PR.

Не используй git add -f.

Merge не выполняй.
```

Task-specific детали добавляются только если они действительно нужны.

---

## 21. Антипаттерны

### Неправильно

```text
ZIP
├─ apply_package.py
├─ check_package.py
├─ diagnostics.py
├─ compatibility.json
├─ hashes.json
├─ expected-files.json
├─ files/
└─ patches/
```

если всё это существует только для одноразового применения package.

### Правильно

```text
ZIP
├─ manifest.json
├─ changes.patch
├─ README.md
└─ TEST_PLAN.md
```

---

## 22. Golden path целиком

```text
CHATGPT WEB / ВНЕШНЯЯ МОДЕЛЬ

актуальный preview
→ понять задачу
→ реализовать полное решение в disposable environment
→ добавить нужные tests
→ проверить каждый новый продуктовый файл
→ если файл ignored, добавить узкое .gitignore exception в это же изменение
→ убедиться, что обычный Git видит новые файлы
→ git add -A -- <authoring paths>
→ Git-generated changes.patch
→ проверить patch на clean base
→ проверить ignored new files после полного patch
→ targeted tests
→ manifest + README + TEST_PLAN
→ ZIP + SHA-256


SOL И ТОТ ЖЕ ПРОДОЛЖАЕМЫЙ WORKER

trusted RESULT_DURABLE + exact ZIP/SHA: только provenance/integrity
→ отдельное решение Sol о применении
→ Worker: fetch current preview
→ clean temporary worktree
→ central runner apply
    → repository safety
    → git apply --check
    → protected paths
    → git apply
    → reject ignored patch-created files
    → targeted tests
→ FAIL: diagnostics + STOP, без ремонта
→ PASS: отчёт Sol, без автоматической публикации
→ только при отдельном решении о публикации будущего ZIP
→ взять affectedPaths из runner result
→ git add -A -- <affectedPaths>
→ commit
→ push
→ remote SHA verify
→ PR в preview
→ verify package-created files present remotely
→ STOP


ПОЛЬЗОВАТЕЛЬ

review
→ отдельное разрешение merge
```

---

## 23. Канонические принципы

> Один package содержит решение, а не собственную инфраструктуру внедрения.

> Patch генерирует Git, а не LLM вручную.

> Если продуктовый файл попадает под `.gitignore`, package обязан добавить минимальное явное исключение для repository-owned пути в том же patch.

> Новый repository-owned файл обязан быть видим обычному Git без `git add -f`.

> Совместимость определяет `git apply --check`.

> Поведение определяют targeted tests.

> Diagnostics принадлежат центральному runner-у.

> Sol отдельно решает о применении; тот же продолжаемый Worker механически применяет package и не ремонтирует его.

> Строгий к опасным операциям, мягкий к совместимости.
