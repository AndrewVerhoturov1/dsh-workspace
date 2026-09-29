# Task Package Protocol

## Статус

Этот документ описывает текущий Direct Web Postman task package и browser prompt.

Source implementation:

```text
postman/task_package.py
```

## Canonical request file

Один production request публикует один self-contained файл:

```text
REQ_<timestamp>_<digits>.md
```

Текущий Direct manifest содержит:

```text
# POSTMAN TASK

protocol_version: 1
request_id: REQ_...
repository: owner/repo
base_commit: <40-hex SHA>
expected_filename: POSTMAN_REQ_..._RESULT.zip
allowed_paths_json: [...]
forbidden_paths_json: [...]

## User intent

<exact current user intent>

## Execution contract

...

## Implementation author discipline

... (conditional only for intent changing the repository named in this task; standalone code artifacts excluded)

## Result contract

...
```

`repository`, `base_commit`, `allowed_paths_json` и `forbidden_paths_json` — trusted
transport/downstream metadata. Их присутствие не означает, что пользователь попросил
изменить repository.

`allowed_paths_json` / `forbidden_paths_json` могут использоваться downstream/manual
application workflow, но **не являются normal ZIP transport gates**.

Task-файл self-contained: execution/result contract и компактная fixed implementation-author discipline находятся в нём же. Последняя не меняет `User intent` и задаёт implementation-package requirements только для intent, требующего изменить repository, указанный в task; автономный кодовый artifact без таких изменений сохраняет естественный формат результата. Универсальный normal transport не становится implementation validator. Подробный канонический contract автора — [External Implementation Author](../system/postman-external-implementation-author.md). Для repository implementation Web пишет полное изменение и необходимые tests; authoritative local apply/targeted tests остаются downstream у Worker/central runner, а не являются authoring-приёмкой Web.

## Canonical browser prompt

Production browser prompt состоит **ровно из двух строк**:

```text
POSTMAN_REQUEST_ID: REQ_xxx
task_file: https://.../<publication-sha>/REQ_xxx.md
```

В browser prompt больше нет отдельной строки `policy:`.

Не дублировать туда:

- user intent;
- `repository`;
- `base_commit`;
- `expected_filename`;
- allowed/forbidden paths;
- implementation instructions;
- result envelope instructions.

Все request-specific инструкции находятся в exact SHA-pinned task-файле.

`build_external_prompt(...)` сохраняет compatibility argument старого policy/skill URL,
но production text от него не зависит.

## Intent preservation

`User intent` содержит current user request без semantic augmentation локальным агентом.

Normal syntax:

```text
@Postman <intent>
```

После transport marker в task передаётся exact intent.

Continuation:

```text
@Postman --chat <old REQ> <new intent>
```

`<old REQ>` — transport lookup metadata. Он не становится частью нового `User intent`,
не добавляется в browser prompt и не заменяет новый canonical REQ.

## Snapshot и publication commit

Есть два разных SHA:

```text
implementationBaseCommit
→ publish REQ_xxx.md
→ taskPublicationCommit
```

`base_commit` внутри task-файла — snapshot выбранной trusted Host ветки непосредственно **до** публикации
transport-only REQ-файла (standalone transport — `main`, Leader flow — подготовленная task branch).

`taskPublicationCommit` — commit, добавивший task-файл. Он хранится в trusted local state,
но не может быть самоссылочно записан внутрь этого же task-файла.

Для ordinary universal result `base_commit` является identity metadata. Для явно
repository-changing результата он может быть использован downstream как implementation base,
но normal transport не проверяет patch semantics или repository scope.

## Result contract

Task-файл требует один реальный downloadable ZIP с exact filename:

```text
POSTMAN_<REQ>_RESULT.zip
```

Внутренняя структура ZIP может быть естественной для задачи. `files/` не обязателен.

`manifest.json` необязателен. Если он присутствует и содержит строковый `requestId`,
он должен совпадать с current REQ. Остальные manifest fields не являются обязательными
normal transport gates.

Финальный assistant turn содержит ровно три непустые видимые строки:

```text
<<<POSTMAN_RESULT_BEGIN:<REQ>>>
POSTMAN_<REQ>_RESULT.zip
<<<POSTMAN_RESULT_END:<REQ>>>
```

Средняя строка должна быть реальным downloadable attachment/control, а не plain text.
