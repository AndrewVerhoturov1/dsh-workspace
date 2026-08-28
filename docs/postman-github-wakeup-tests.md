# Результаты проверок GitHub Wakeup

Этот файл заполняется после synthetic E2E и содержит только безопасные идентификаторы запусков и состояние, без токенов.

## Локальные проверки

- PowerShell parse: ожидается PASS.
- Обработчик и отрицательные сценарии: `postman/test-github-wakeup.ps1`.
- YAML: проверяется синтаксическим анализом до публикации.
- `git diff --check`: проверяется перед коммитом.

## Synthetic E2E

Первый автоматический прогон выполнен на probe Issue `#6` после публикации workflow:

- Issue edit: PASS, тело изменено на `READY` через `gh issue edit`.
- workflow run id: `33172140309`.
- job id: `98851625844`.
- runner: `dsh-postman-win`, labels `self-hosted`, `Windows`, `X64`, `postman`.
- run: `success`; job: `success`.
- run created/started: `2026-08-28T12:41:45Z`.
- job started/completed: `2026-08-28T12:41:49Z` — `2026-08-28T12:42:14Z`.
- handler: PASS, журнал содержит `SIGNAL_WRITTEN`.
- durable signal: `%LOCALAPPDATA%\DSH\Postman\signals\REQ_PROBE_001.json`.
- ответ сохранён: `POSTMAN PROBE RESPONSE`.

Этот run является доказательством пути Issue → Actions → self-hosted runner → handler → signal; ручной Web ChatGPT live test этим документом не выполняется.
