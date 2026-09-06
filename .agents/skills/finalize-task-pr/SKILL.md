---
name: finalize-task-pr
description: >-
  Использовать, когда пользователь уже принял решение смержить один или несколько
  проверенных pull request в main и нужно выполнить squash merge с обычным cleanup
  временных веток/worktree. Это исполнитель готового решения, а не повторный reviewer:
  не запускать заново тесты, CI, diff/scope review и исторические проверки.
---

# Finalize Task PR

`FINALIZE_TASK_PR_SKILL_VERSION: 1`

## Назначение

Этот skill используется **после того, как модель уже проверила PR и решила, что он готов к merge**, а пользователь дал команду выполнить merge.

Skill не принимает решение о качестве PR. Он только исполняет уже принятое решение через готовый локальный инструмент:

```text
C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1
```

Нормальный путь:

```text
PR уже проверен моделью
→ пользователь говорит merge / смержи
→ определить exact PR number(s)
→ один вызов finalize_task_pr.ps1
→ squash merge
→ best-effort cleanup worktree/local branch/remote branch
→ краткий отчёт
```

## Когда использовать

Использовать, если из текущего сообщения и ближайшего контекста однозначно следует, что пользователь хочет **выполнить merge уже проверенного PR**.

Типичные формулировки:

```text
мердж
смёржи PR #99
мердж #97 и #98
объедини эти два PR в main
всё готово, сливай
закрой ветку через merge
```

Если PR number не написан в текущем сообщении, но из непосредственно предшествующего контекста однозначно известен один готовый PR, использовать его без лишнего уточнения.

Если невозможно однозначно определить PR — спросить номер PR. Не угадывать.

## Когда НЕ использовать

Не использовать этот skill для:

```text
проверь PR
сделай review
готов ли PR к merge?
исправь конфликты
почини тесты
посмотри diff
создай PR
закрой PR без merge
архивируй ветку
удали произвольную ветку
```

Если решение о готовности PR ещё не принято, сначала выполнить обычную ручную проверку по текущему контексту/правилам репозитория. Только после решения о merge использовать этот skill.

## Главное правило: не проверять повторно

После активации skill **не повторять** то, что модель уже проверила до команды merge:

```text
тесты
CI/checks
diff review
scope review
архитектурный review
повторный просмотр всех изменённых файлов
Postman receipts
исторические ветки/PR/worktree как глобальный preflight
```

Не создавать перед merge дополнительный «approval pipeline».

Готовый executor сам содержит только лёгкие аварийные предохранители, необходимые чтобы не удалить явно не тот ресурс.

## Канонический вызов

Один PR:

```powershell
$resultText = & 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' `
  -PrNumber 99
$result = $resultText | ConvertFrom-Json
```

Несколько PR в заданном порядке:

```powershell
$resultText = & 'C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1' `
  -PrNumber 97,98
$result = $resultText | ConvertFrom-Json
```

Не раскладывать нормальный путь обратно на ручные команды `gh pr merge`, `git worktree remove`, `git branch -D`, `git push --delete` и т. п.

`-WhatIf` использовать только если пользователь явно просит предварительный просмотр действий. Это не обязательный шаг перед обычным merge.

## Что делает executor

Для каждого указанного PR последовательно:

```text
прочитать exact PR identity
→ убедиться, что base=main и PR не находится в явно несовместимом состоянии
→ squash merge (или принять уже merged как идемпотентное состояние)
→ git fetch --prune
→ удалить связанный clean secondary worktree, если он существует
→ удалить local branch, если она всё ещё указывает на exact PR head
→ удалить remote branch, если она всё ещё указывает на exact PR head
→ перейти к следующему PR
```

При нескольких PR следующий PR читается заново после предыдущего merge.

Executor **не запускает** тесты/CI/review.

## Cleanup — best effort

Нормальные неошибочные состояния:

```text
worktree уже отсутствует
local branch уже отсутствует
remote branch уже отсутствует
PR уже merged
```

Если связанный secondary worktree dirty — **не удалять его**, вернуть warning и сохранить успешный merge.

Если branch после проверки модели успела переместиться на другой SHA — не удалять её, вернуть warning.

Cleanup warning не превращает уже успешный merge в failure.

## Primary main защищён

Основной worktree:

```text
C:\Users\andre\.dsh
```

не очищать и не перестраивать ради merge.

Запрещены:

```text
git reset --hard
git clean
automatic stash
force push
удаление primary worktree
```

Локальный dirty `main` может остаться dirty; merge выполняется через GitHub и не требует checkout/reset primary worktree.

## Обработка результата

Успешные terminal codes:

```text
TASK_PRS_FINALIZED
TASK_PRS_FINALIZED_WITH_WARNINGS
```

`TASK_PRS_FINALIZED_WITH_WARNINGS` означает: merge выполнен, но часть best-effort cleanup оставлена нетронутой. Не пытаться автоматически «дочистить» warning опасными командами.

Если `ok=false`, сообщить точный `code` и blocker. Не имитировать executor вручную без отдельной причины.

## Финальный отчёт

Отчёт короткий. Сообщить:

```text
какие PR merged
актуальный origin/main SHA из результата
какие worktree/branches удалены
какие cleanup warnings остались
mainWorkingTreeTouched=false
```

Не повторять пользователю уже выполненный review и не перечислять старые проверки, если это не нужно для диагностики.

## Критические инварианты

1. Skill — исполнитель уже принятого решения, не reviewer.
2. Нормальный merge method — squash.
3. Один вызов может обработать несколько PR последовательно.
4. Не повторять тесты/CI/diff/scope review.
5. Не делать обязательный `-WhatIf` перед merge.
6. Отсутствующие временные ресурсы — нормальное состояние.
7. Dirty secondary worktree не удалять; warning достаточно.
8. Primary `C:\Users\andre\.dsh` не очищать и не удалять.
9. Не использовать reset/stash/clean/force push.
10. Не разлагать normal path на ручную цепочку Git/gh команд.
