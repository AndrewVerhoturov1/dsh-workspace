# Task Package Protocol

## Формат

Один файл задачи:

`REQ_<timestamp>_<digits>.md`

Канонический WP-010 task-файл содержит поля в таком порядке:

- `request_id` — неизменяемый ключ запроса;
- `user_intent` — намерение пользователя без пересказа решения;
- `confirmed_requirements` — только требования, подтверждённые пользователем;
- `clarifications` — заданные вопросы и полученные ответы либо ещё неясные места;
- `constraints` — только явно заданные ограничения;
- `required_documents` — ссылки на обязательные документы;
- `repository` и `base_commit` — контекст исходного кода;
- `expected_output` — ожидаемый от внешнего агента результат;
- `validation` — проверки результата.

Локальный агент может запросить уточнение, но не отвечает на него за
пользователя. При упаковке он не дополняет требования, не выбирает архитектуру
и не меняет смысл запроса. Пустые `clarifications` или `constraints` не
заменяются выдуманными значениями.

Функция `render_intent_task_file` формирует этот формат из явно переданных
значений и не обращается к сети, браузеру или GitHub. Старый
`render_task_file` сохраняется для совместимости с WP-009.

## Ответ внешнему агенту

Внешний Postman prompt содержит только:

1. первую строку `POSTMAN_REQUEST_ID: REQ_xxx`;
2. строку `policy:` со ссылкой на общий Postman artifact policy;
3. ссылку на task-файл.

Пример первой строки:

```text
POSTMAN_REQUEST_ID: REQ_xxx
```

Полное техническое задание, repository/base metadata, path scope и result contract
в prompt не копируются: они находятся только в task-файле.
## Direct Postman: self-contained task manifest

Production Direct Postman использует один канонический формат внешнего prompt:

```text
POSTMAN_REQUEST_ID: REQ_xxx
policy: https://.../postman-webchat-result-artifact.md
task_file: https://.../<publication-sha>/REQ_xxx.md
```

Это ровно три строки. В prompt запрещено дублировать `repository`, `base_commit`,
`expected_filename`, `allowed_paths_json`, `forbidden_paths_json`, user intent,
implementation instructions и result markers.

Все request-specific данные находятся в опубликованном task-файле. Direct task manifest
содержит `protocol_version`, `request_id`, `repository`, `base_commit`,
`expected_filename`, `allowed_paths_json`, `forbidden_paths_json`, точный user intent,
execution contract и result contract.

### Два разных commit SHA

`base_commit` в task-файле — implementation snapshot: SHA `main` непосредственно ДО
публикации `REQ_xxx.md`.

`taskPublicationCommit` — transport-only commit, который добавляет сам task-файл. Он
хранится во внутреннем Direct state/result, но не помещается внутрь task-файла, потому
что SHA коммита нельзя самоссылочно записать в содержимое этого же коммита.

```text
implementationBaseCommit
→ publish REQ_xxx.md
→ taskPublicationCommit
→ link-only prompt
```

Artifact manifest Ч1 использует `implementationBaseCommit` как `baseCommit`. PREPARE
допускает последующее transport-only продвижение `main` через `REQ_*.md`, если
implementation base остаётся предком актуального `origin/main` и на payload-path не
было функционального продвижения.
