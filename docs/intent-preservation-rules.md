# Правила сохранения намерения

## Область

Этот документ задаёт intent boundary текущего Direct Web Postman.

Главное правило:

> Локальный transport переносит current user intent; он не становится вторым постановщиком задачи.

## Normal `@Postman`

Trigger:

```text
@Postman <intent>
```

Локальный агент:

1. распознаёт exact current-message trigger;
2. удаляет только transport marker `@Postman` и непосредственно следующий separator;
3. передаёт весь оставшийся current user text как semantic intent;
4. создаёт новый canonical REQ;
5. не добавляет предыдущий chat context, свои предположения или implementation requirements.

Запрещено:

- перефразировать запрос «для удобства»;
- дополнять его предыдущим контекстом Luna;
- придумывать критерии, ограничения или архитектуру;
- превращать обычный research/text/file request в repository implementation request;
- интерпретировать результат Ч1 вместо пользователя как часть transport lifecycle.

## Continuation

Syntax:

```text
@Postman --chat <old REQ> <new intent>
```

Здесь:

- `--chat <old REQ>` — только transport control;
- old REQ используется для local lookup exact сохранённого ChatGPT conversation;
- continuation создаёт **новый** canonical REQ;
- Ч1 получает только `<new intent>`;
- предыдущий conversation context предоставляется самим exact ChatGPT chat, а не копированием текста Luna.

Search UI, угадывание conversation и silent fresh-chat fallback не используются.

## Task-файл

Published task-файл self-contained и содержит:

- trusted request metadata;
- exact `User intent`;
- execution contract;
- result contract.

Metadata (`repository`, `base_commit`, allowed/forbidden paths) не является semantic
доказательством того, что пользователь попросил код или Git-операции.

## Обязанности внешнего агента

Внешний ChatGPT:

- читает exact self-contained task-файл;
- самостоятельно анализирует задачу;
- выбирает содержание ответа;
- возвращает proposed result в ZIP по transport contract.

Локальный transport не должен заранее проектировать это решение.

## После результата

`RESULT_DURABLE` доказывает успешный transport и validation artifact, но не semantic correctness
и не пользовательское принятие результата.

Normal Luna flow сообщает exact REQ/resultZip/Workspace status и останавливается.
Применение implementation package, tests, Git publication и PR — отдельный explicit downstream workflow.
