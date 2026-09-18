# dsh-workspace

Рабочий репозиторий локальной конфигурации и расширений DeepSeek Harness.

## Текущий production Postman

Каноническое описание текущего процесса:

- [`postman/POSTMAN_CURRENT_FLOW.md`](postman/POSTMAN_CURRENT_FLOW.md) — полный production flow Direct Web Postman;
- [`postman/direct/README.md`](postman/direct/README.md) — прямой локальный entrypoint и lifecycle запроса;
- [`postman/web/README.md`](postman/web/README.md) — browser transport;
- [`docs/web-postman-artifact-contract.md`](docs/web-postman-artifact-contract.md) — текущий контракт ZIP-результата.

Production entrypoint:

```text
postman/direct/postman.ps1
```

## Правила репозитория

- [`REPO_POLICY.md`](REPO_POLICY.md) — Git/GitHub policy и границы изменений.
- [`system/implementation-package-workflow.md`](system/implementation-package-workflow.md) — правила подготовки и применения implementation packages.

## Сохранение пользовательского намерения

- [`docs/intent-preservation-rules.md`](docs/intent-preservation-rules.md)
- [`docs/task-package-protocol.md`](docs/task-package-protocol.md)

Локальный transport не должен самостоятельно дополнять пользовательские требования или проектировать решение вместо внешней модели.

## Codex OAuth

Текущая локальная OAuth-интеграция описана в [`GPT-CODEX-AUTH.md`](GPT-CODEX-AUTH.md).
Production web profile использует пакет `dsh-codex-oauth` и provider route `codex`.
