# Проверки Postman GitHub Integration M6

## Локальные проверки

- `node --check` для Runtime, плагина, транспорта и загрузчика сигналов — PASS.
- `node --test plugins/dsh-postman-harness/lib/index.test.js plugins/dsh-postman-harness/lib/runtime.test.js plugins/dsh-postman-harness/lib/transport.test.js` — PASS, 43/43.
- `postman/test-github-wakeup.ps1` — PASS, 40/40; строгий старый протокол, отрицательные сценарии и независимость ключа от временной метки сохранены.
- Проверка PowerShell parser для `github-wakeup.ps1`, `test-github-wakeup.ps1` и `chatgpt_chat.ps1` — PASS.
- Проверены миграция схемы M4 → M6, точные SHA-256, unknown REQ, повторный deliveryKey, повторный signal, сохранение issue metadata и spoofing origin.
- `git diff --check` — PASS.
- `node C:\Users\andre\dsh-cli-validation\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config` — PASS; в конфигурации присутствуют Flowglass и Postman, `agent-loop.agents=[]`.

## Сценарии M6

Заполняются после живого прогона на опубликованной ветке:

| Сценарий | Ожидание | Факт |
|---|---|---|
| Один агент → Issue WAITING → Web ChatGPT SubmitOnly | автоматическая отправка | BLOCKED на SubmitOnly: `FRESH_CHAT_NOT_CONFIRMED` |
| Issue READY → Actions → Windows signal → Runtime | `READY` | live не выполнен: Issue №19 остался WAITING |
| READY → originating Agent | один `POSTMAN_RESULT` | live не выполнен |
| Два агента и две Issue | cross-delivery = 0 | live не выполнен |
| повтор workflow/event | `DUPLICATE_SUPPRESSED` | локальная модель PASS; live не выполнен |
| Harness выключен при READY | signal сохранён и ingest при старте | локальная модель PASS; live не выполнен |

Live gate заблокирован внешним состоянием Desktop ChatGPT: runner `dsh-postman-win` в GitHub имеет `status=online`, `busy=false`, Harness `http://127.0.0.1:3080/` отвечает, Issue №19 создана, но существующий мост `chatgpt_chat.ps1` не подтвердил свежий чат (`FRESH_CHAT_NOT_CONFIRMED: EMPTY_SURFACE_MARKER_NOT_FOUND`). После перезапуска ChatGPT UIA видит поверхность, однако она остаётся текущей Codex-сессией; безопасная отправка через `SubmitOnly` не подтверждена.

## Итог

`BLOCKED — Desktop ChatGPT не подтверждает свежую поверхность для SubmitOnly (`FRESH_CHAT_NOT_CONFIRMED`); локальная реализация и регрессионные проверки M1–M5/M6 проходят.`

## Обязательные живые доказательства

В отчёте должны быть exact SHA merge commit, имена агентов, `REQ_*`, номера Issue, Actions run/job, факт online runner `dsh-postman-win`, состояния DB и наблюдаемые маркеры продолжения. Содержимое ответа не передаётся через видимый ответ ChatGPT и не копируется пользователем.
