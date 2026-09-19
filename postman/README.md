# Direct Web Postman

`postman/` содержит текущий production transport между локальным Harness/Luna agent и ChatGPT Web.

## Канонический flow

```text
@Postman <intent>
→ удалить только transport marker
→ новый canonical REQ
→ postman/direct/postman.ps1
→ publish self-contained REQ task
→ двухстрочный browser prompt
→ ChatGPT Web
→ exact correlated assistant turn
→ exact ZIP attachment
→ download + transport validation
→ RESULT_DURABLE
→ optional Result Workspace registration
→ STOP
```

Continuation:

```text
@Postman --chat <old REQ> <new intent>
```

Старый REQ используется только как локальный ключ exact сохранённого ChatGPT conversation.
Continuation всегда создаёт новый REQ, а Ч1 получает только новый intent.

## Production entrypoint

```text
<current workspace>\postman\direct\postman.ps1
```

Hardcoded Windows username не является частью production contract.

## Структура

- `POSTMAN_CURRENT_FLOW.md` — каноническая архитектура и lifecycle.
- `direct/` — production entrypoint, GitHub task publication, durable handoff.
- `web/` — Chrome/CDP, submit, observer, artifact detection, download и validator.
- `task_package.py` — self-contained task manifest и canonical двухстрочный browser prompt.
- `tests/` и `web/tests/` — transport regression tests.

Artifact contract:

```text
docs/web-postman-artifact-contract.md
```

Intent/task contracts:

```text
docs/intent-preservation-rules.md
docs/task-package-protocol.md
```

Последний полный fresh + continuation acceptance:

```text
docs/postman-production-e2e.md
```

## Граница normal flow

Normal `@Postman` заканчивается на `RESULT_DURABLE`. После него разрешена одна попытка
`postman_result_workspace_register(...)`; ошибка регистрации не отменяет transport success.

Normal flow не:

- распаковывает и не интерпретирует ZIP;
- применяет patch/files к repository;
- запускает PREPARE/TEST/PUBLISH;
- создаёт implementation worktree/branch/commit/PR;
- использует `postman_async_send`, `postman_runtime_*` или persistent POSTMAN agent как fallback.

Legacy/manual finalization сохраняется отдельно и запускается только по явному запросу пользователя.
