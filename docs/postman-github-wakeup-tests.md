# Результаты проверок GitHub Wakeup

Этот файл заполняется после synthetic E2E и содержит только безопасные идентификаторы запусков и состояние, без токенов.

## Локальные проверки

- PowerShell parse: ожидается PASS.
- Обработчик и отрицательные сценарии: `postman/test-github-wakeup.ps1`.
- YAML: проверяется синтаксическим анализом до публикации.
- `git diff --check`: проверяется перед коммитом.

## Synthetic E2E

- probe Issue: заполняется после создания.
- Issue edit: заполняется после изменения тела через GitHub API.
- workflow run id: заполняется после автоматического запуска.
- job id: заполняется после завершения job.
- runner name/labels: заполняется по данным GitHub Actions.
- результат и времена: заполняются по run/job.
- durable signal: `%LOCALAPPDATA%\DSH\Postman\signals\REQ_PROBE_001.json`.

Ручной Web ChatGPT live test этим документом не выполняется.
