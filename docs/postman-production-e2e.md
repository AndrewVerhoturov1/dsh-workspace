# Direct Postman — production E2E acceptance

status: PASS  
verified: 2026-09-19

## Цель

Этот документ фиксирует последний полный production acceptance сценарий после исправлений
workspace-relative bridge invocation, shell spawn fail-closed behavior и pwsh orchestration contract.

Это **acceptance evidence**, а не замена канонических contracts.

Нормативные документы:

```text
AGENTS.md
.agents/skills/delegate-via-postman/SKILL.md
postman/POSTMAN_CURRENT_FLOW.md
docs/web-postman-artifact-contract.md
```

## Сценарий 1 — fresh request

Проверено:

```text
exact @Postman trigger
→ new canonical REQ
→ Direct Postman invoked
→ ChatGPT Web fresh conversation
→ correlated assistant result
→ artifact download
→ ARTIFACT_VALID
→ RESULT_DURABLE
→ Result Workspace registered
```

Semantic test payload содержал кодовое слово и число, которые должны были сохраниться
в conversation для следующего запроса.

## Сценарий 2 — continuation

Continuation был отправлен через:

```text
@Postman --chat <REQ_1> <new intent>
```

Проверено:

```text
REQ_2 != REQ_1
continuedFromRequestId = REQ_1
conversation identity REQ_2 = conversation identity REQ_1
conversation URL REQ_2 = conversation URL REQ_1
RESULT_DURABLE
ARTIFACT_VALID
Result Workspace registered
```

Ответ external ChatGPT корректно использовал context предыдущего сообщения и выполнил
новое вычисление. Это подтвердило semantic continuity exact существующего ChatGPT conversation.

## Artifact acceptance

Для continuation artifact:

```text
manifestPresent = false
ARTIFACT_VALID = true
warnings = []
```

Это подтверждает production contract: `manifest.json` необязателен.

Workspace registration для manifestless durable result также прошла.

## Итог

```text
fresh transport = PASS
continuation transport = PASS
same-conversation proof = PASS
artifact validation = PASS
manifestless result = PASS
RESULT_DURABLE = PASS
Result Workspace registration = PASS
FULL E2E = PASS
```

Следующий regression run должен оцениваться по тем же transport invariants, а не по историческим
WP milestone descriptions.
