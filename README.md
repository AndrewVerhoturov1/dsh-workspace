# dsh-workspace

Рабочий репозиторий локальной конфигурации и расширений DeepSeek Harness.

## Текущий production Postman

Production Postman — это **Direct Web Postman**. Канонический entrypoint:

```text
postman/direct/postman.ps1
```

Пользовательский trigger:

```text
@Postman <intent>
```

Продолжение exact существующего ChatGPT conversation:

```text
@Postman --chat REQ_... <новый intent>
```

Normal flow:

```text
exact user intent
→ новый canonical REQ
→ Direct Postman
→ self-contained task-файл
→ двухстрочный browser prompt
→ ChatGPT Web
→ correlated ZIP
→ transport validation
→ RESULT_DURABLE
→ optional Result Workspace registration
→ STOP
```

Normal `@Postman` flow не применяет ZIP к repository, не запускает PREPARE/TEST/PUBLISH,
не создаёт implementation branch/commit/PR и не интерпретирует содержимое результата вместо пользователя.

### Source of truth

Документация читается в таком порядке:

1. [`AGENTS.md`](AGENTS.md) — глобальные production invariants и trigger policy.
2. [`.agents/skills/delegate-via-postman/SKILL.md`](.agents/skills/delegate-via-postman/SKILL.md) — точный operational contract Luna.
3. [`postman/POSTMAN_CURRENT_FLOW.md`](postman/POSTMAN_CURRENT_FLOW.md) — каноническая архитектура текущего Direct Postman.
4. [`docs/web-postman-artifact-contract.md`](docs/web-postman-artifact-contract.md) — transport/ZIP contract.
5. [`postman/direct/README.md`](postman/direct/README.md) — direct entrypoint и operator examples.
6. [`postman/web/README.md`](postman/web/README.md) — browser transport modules.
7. [`docs/task-package-protocol.md`](docs/task-package-protocol.md) — self-contained task-файл и двухстрочный browser prompt.
8. [`docs/intent-preservation-rules.md`](docs/intent-preservation-rules.md) — сохранение exact user intent.

Проверенный acceptance сценарий описан в
[`docs/postman-production-e2e.md`](docs/postman-production-e2e.md).

`plugins/dsh-postman-harness` не является production transport для `@Postman`.
Его Result Workspace tools могут использоваться после `RESULT_DURABLE` как presentation convenience.

## Правила репозитория

- [`REPO_POLICY.md`](REPO_POLICY.md) — Git/GitHub policy и границы изменений.
- [`system/implementation-package-workflow.md`](system/implementation-package-workflow.md) — отдельный downstream workflow для явного применения implementation package.

## Codex OAuth

Текущая локальная OAuth-интеграция описана в [`GPT-CODEX-AUTH.md`](GPT-CODEX-AUTH.md).
Production web profile использует пакет `dsh-codex-oauth` и provider route `codex`.
