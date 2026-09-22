# Direct Web Postman

`postman/` содержит production transport между локальным Harness agent и ChatGPT Web.

## Два transport mode

Artifact mode:

```text
@Postman <intent>
→ trusted current-turn capture
→ postman/direct/postman.ps1
→ ChatGPT Web
→ correlated ZIP
→ RESULT_DURABLE | ASSISTANT_COMPLETED_NO_ARTIFACT | ARTIFACT_REJECTED
```

Text mode:

```text
@PostmanAsk <intent>
→ trusted current-turn capture
→ postman/direct/postman-ask.ps1
→ ChatGPT Web
→ exact REQ-bound text envelope
→ TEXT_RESULT_DURABLE
```

Оба режима поддерживают manual continuation:

```text
@Postman --chat <old REQ> <new intent>
@PostmanAsk --chat <old REQ> <new intent>
```

Old REQ используется только как локальный ключ доказанного ChatGPT conversation; новая отправка
всегда получает новый REQ.

## Supervisor mode: Postman Bridge

Для обычного пользовательского запроса умная локальная модель может работать как supervisor через:

```text
postman_bridge({ message: "@PostmanAsk ..." })
postman_bridge({ message: "@Postman ..." })
```

Bridge создаёт fresh one-shot Luna, передаёт ей exact model-authored delegation как child
`user/message`, после чего используются те же current-turn tools и Direct wrappers. Parent получает
trusted terminal result напрямую; Luna prose не является authority.

Canonical Bridge contract:

```text
postman/POSTMAN_BRIDGE_FLOW.md
```

Strategy skill:

```text
.agents/skills/postman-leader/SKILL.md
```

## Production entrypoints

```text
<current workspace>\postman\direct\postman.ps1
<current workspace>\postman\direct\postman-ask.ps1
```

Hardcoded Windows username не является частью production contract.

## Структура

- `POSTMAN_CURRENT_FLOW.md` — artifact transport lifecycle.
- `POSTMAN_ASK_FLOW.md` — text transport lifecycle.
- `POSTMAN_BRIDGE_FLOW.md` — supervisor → Luna Bridge → Direct Postman lifecycle.
- `direct/` — production wrappers, task publication и durable handoff.
- `web/` — Chrome/CDP, submit, observer, recovery, artifact/text correlation.
- `tests/`, `direct/tests/`, `web/tests/` — regression tests.

Artifact contract:

```text
docs/web-postman-artifact-contract.md
```

## Граница normal transport

Normal Postman не:

- применяет ZIP к repository;
- запускает PREPARE/TEST/PUBLISH автоматически;
- создаёт implementation branch/commit/PR;
- использует `postman_async_send`/`postman_runtime_*` как fallback;
- делает blind resend после неопределённого transport outcome.

`postman_bridge` также не применяет artifact: следующий шаг выбирает parent Leader.
