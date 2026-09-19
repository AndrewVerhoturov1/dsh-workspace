# dsh-postman-harness

## Статус

`dsh-postman-harness` сохраняется как auxiliary/legacy Harness plugin.

**Он не является production transport для normal `@Postman`.**

Текущий production transport:

```text
@Postman
→ .agents/skills/delegate-via-postman/SKILL.md
→ postman/direct/postman.ps1
→ Direct Web Postman
```

`postman_async_send`, `postman_runtime_*`, persistent `postman-harness-session` и старый
Cordis async path не являются fallback, если Direct Postman не стартовал или завершился ошибкой.

## Что остаётся полезным в plugin

Plugin содержит отдельные Harness capabilities, в том числе presentation tooling для уже
полученного durable result.

Normal Direct Postman после `RESULT_DURABLE` может один раз вызвать:

```text
postman_result_workspace_register(
  request_id=<exact REQ>,
  result_handoff_json=<exact resultHandoffPath>
)
```

Это регистрирует retained result directory как обычный Harness Workspace без повторного
browser transport, без unpack ZIP и без создания нового REQ.

Соответствующий unregister tool:

```text
postman_result_workspace_unregister(...)
```

Workspace registration — presentation convenience, не transport integrity gate.

Для `RESULT_DURABLE` registration требует exact current request identity,
`result.zip`, `validation.json` и `metadata.json`. `manifest.json` **не обязателен**.

## Legacy async runtime

В plugin остаются исторические/совместимые компоненты:

- persistent `postman-harness-session`;
- probe protocol;
- SQLite-backed `PostmanRuntime`;
- `postman_async_send`;
- `postman_runtime_*`;
- legacy wake/delivery routing.

Они могут оставаться покрыты тестами и использоваться для совместимости/экспериментов,
но не описывают normal production `@Postman` flow.

Нельзя использовать их как recovery path после Direct Postman failure.

## Production source of truth

Для current Postman смотреть:

```text
AGENTS.md
.agents/skills/delegate-via-postman/SKILL.md
postman/POSTMAN_CURRENT_FLOW.md
postman/direct/README.md
postman/web/README.md
docs/web-postman-artifact-contract.md
```

Plugin README описывает только plugin-owned capabilities и legacy boundary.
