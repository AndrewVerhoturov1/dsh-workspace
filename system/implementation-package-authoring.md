# Implementation Package Authoring Contract

id: implementation-package-authoring  
status: canonical  
language: ru

## 1. Назначение

Этот документ прежде всего обращён к ChatGPT Web, который готовит implementation ZIP для репозитория `AndrewVerhoturov1/dsh-workspace`.

Он применяется вместе с:

```text
REPO_POLICY.md
system/implementation-package-workflow.md
system/implementation_package_schema.json
system/implementation_package_runner.py
```

При конфликте действуют repository policy и более строгое правило защиты пользовательских данных. Полный lifecycle применения, central runner, Leader/Worker, diagnostics и отдельной публикации — в [Implementation Package Workflow](implementation-package-workflow.md). Минимальный scope и разделение authoring/local verification подробно описаны в [External Implementation Author](postman-external-implementation-author.md). Здесь определён contract автора ZIP: Web реализует замысел Sol в заданных архитектурных границах, готовит patch/тесты/manifest и честно сообщает собственные проверки. Web не выбирает локальный trusted ZIP path, не применяет package и не создаёт для него новый applicator, diagnostics framework или Git workflow. Применение и публикация требуют отдельных решений; PASS runner-а не означает разрешения на публикацию.

## 2. Ответственность автора

Автор исследует актуальный код, принимает implementation-level решения в границах Sol, включает все продуктовые изменения и необходимые targeted/regression tests в patch, формирует `manifest.json`, короткие `README.md` и `TEST_PLAN.md`, выполняет разумные доступные authoring sanity checks и выдаёт ZIP с SHA-256 через обычный Postman transport. Web не перекладывает на Worker недостающий продуктовый код или архитектуру, известную логическую ошибку, написание необходимого regression test, необходимое `.gitignore` exception либо исправление заведомо неправильного patch: при FAIL package автор готовит replacement package. Это ответственность за **содержание** тестов, а не за их окончательный запуск на реальном target worktree: authoritative исполнение объявленных targeted tests принадлежит central runner / Local Worker workflow. Web не обязан воспроизводить локальную Windows/DSH-приёмку; фактически не выполненные проверки обозначает честно.

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

Практический путь (без обязательного второго локального runner):

```text
актуальный origin/preview и disposable authoring environment
→ полная реализация с необходимыми tests и узкими .gitignore exceptions
→ git add -A -- <authoring paths>
→ Git-generated staged diff → changes.patch
→ manifest.json + короткие README.md и TEST_PLAN.md
→ разумные доступные authoring sanity checks
→ ZIP + SHA-256 → короткий handoff
```

Если дешёвый clean-shadow `git apply --check` естественно доступен, он полезен. Второй shadow/worktree, применение patch и полный повтор targeted tests в нём не являются обязательной стадией Web: не строй инфраструктуру ради имитации local runner. Git-generated patch и полнота package обязательны; окончательную механическую проверку выполняет central runner на target worktree.

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

В Leader flow Host `postman_task_prepare` сначала создаёт и публикует одну task branch с clean worktree от exact `origin/preview`; Bridge публикует REQ commit в эту ветку через Host, а не в `main`. Web использует опубликованный REQ snapshot. Автор package не выбирает standalone transport branch и не меняет эту границу.

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

## 10. Проверки central runner

Runner и его hard FAIL/non-blocking diagnostics определены в [workflow](implementation-package-workflow.md). Для автора существенны: Git применимость patch, безопасность путей, обычная видимость новых файлов (включая `PATCH_CREATES_IGNORED_FILE`) и успех объявленных targeted tests. `packageBase` информационен; exact inventory, число файлов, продвижение `preview` и whitespace warning сами по себе не вводят новых gates.

---

## 11. Проверка package до выдачи

Выполняй дешёвые полезные authoring checks, если они естественно доступны: например, syntax check, относящийся regression test или clean-shadow `git apply --check changes.patch`. Второй shadow/worktree с применением patch, проверкой ignored-файлов и полным повтором targeted tests не обязателен для Web. Их authoritative выполнение на target worktree — ответственность central runner.

Не утверждать в финальном отчёте, что проверка выполнена, если она фактически не запускалась.

Если среда Web не позволяет выполнить Git verification или все тесты, это нужно честно указать. Shadow tests — ранняя authoring-проверка, а не итоговый PASS на реальном target worktree. После отдельного решения Sol тот же продолжаемый Worker вызовет authoritative central runner с `manifest.tests` на target worktree; его PASS при неизменных входах не требует ручного повторного запуска Worker/Sol или rerun при отдельной публикации. Полный lifecycle — в [workflow](implementation-package-workflow.md).

Не создавать ради этой проверки новый framework внутри ZIP.

---

## 12. README.md внутри package

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

## 13. TEST_PLAN.md

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

## 14. Граница применения

ZIP не содержит своего applicator, diagnostics collector или Git publication. Runner diagnostics, поведение Worker на FAIL/PASS, trusted REQ grant и отдельная публикация описаны в [workflow](implementation-package-workflow.md). Автор не инструктирует Worker вручную чинить patch, код, тест или `.gitignore` после FAIL: необходимое исправление входит в replacement package. Web не выбирает trusted локальный путь ZIP и не разрешает применение или merge.

---

## 15. Выдача результата внешней модели

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

Не выдавать пользователю внутренние временные authoring worktree и не добавлять в handoff инструкции Leader/Worker по применению и Git-публикации: они определены в [workflow](implementation-package-workflow.md).

---

## 16. Короткий принцип

Один декларативный package содержит реализацию, Git-generated patch и нужные тесты — не инфраструктуру внедрения. Новый repository-owned файл должен быть видим обычному Git без `git add -f`; для ignored путей добавить узкое исключение в том же patch. Ранние authoring shadow tests не заменяют authoritative runner PASS на реальном target worktree. Применение и отдельная публикация описаны в [workflow](implementation-package-workflow.md).
