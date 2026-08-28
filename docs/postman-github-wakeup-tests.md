# Результаты проверок GitHub Wakeup

Этот файл заполняется после synthetic E2E и содержит только безопасные идентификаторы запусков и состояние, без токенов.

## Локальные проверки

- PowerShell parse: ожидается PASS.
- Обработчик и отрицательные сценарии: `postman/test-github-wakeup.ps1`.
- YAML: проверяется синтаксическим анализом до публикации.
- `git diff --check`: проверяется перед коммитом.

## Synthetic E2E

Финальный автоматический прогон выполнен на probe Issue `#6` после объединения workflow в `main`:

- Issue edit: PASS, тело изменено на `READY` через `gh issue edit`.
- workflow run id: `33174118478`.
- job id: `98858218972`.
- runner: `dsh-postman-win`, labels `self-hosted`, `Windows`, `X64`, `postman`.
- run: `success`; job: `success`.
- run created/started: `2026-08-28T13:09:13Z`.
- job started/completed: `2026-08-28T13:09:16Z` — `2026-08-28T13:09:39Z`.
- handler: PASS, журнал содержит `SIGNAL_WRITTEN`.
- durable signal: `%LOCALAPPDATA%\DSH\Postman\signals\REQ_PROBE_001.json`.
- ответ сохранён: `POSTMAN FINAL MERGED PROBE RESPONSE`.

Проверка повторного запуска того же run:

- run attempt: `2`;
- job id: `98858547952`;
- runner: `dsh-postman-win`;
- run/job: `success`;
- журнал содержит `SIGNAL_DUPLICATE`;
- файл сигнала не изменился (`signalUnchanged=true`).

Это доказывает путь Issue → Actions → self-hosted runner → handler → signal и подавление повторной доставки; ручной Web ChatGPT live test этим документом не выполняется.

## Отрицательные E2E-проверки

- `WAITING`: Issue `#6`, run `33174449507`, job `98859328825`; job `success`, в журнале `IGNORED status=WAITING`, сигнал отсутствует.
- unrelated Issue: Issue `#10`, run `33174680174`; workflow `skipped`, сигнал отсутствует.
- invalid `request_id`: Issue `#13`, run `33174888752`, job `98860826659`; ожидаемая ошибка в журнале, job `failure`, сигнал отсутствует.
- malformed body: Issue `#14`, run `33174948435`, job `98861031915`; ожидаемая ошибка в журнале, job `failure`, сигнал отсутствует.
- false READY в ответе: покрыт локальным тестом и WAITING E2E; сигнал отсутствует.

Временные отрицательные Issues `#10`, `#13` и `#14` закрыты с причиной `not planned`; probe `#6` возвращён в чистый WAITING. Ручной Web ChatGPT live test не выполнялся.
