# Проверки Postman GitHub Integration M6

## Локальные проверки

- `node --check` для Runtime, плагина, транспорта и загрузчика сигналов — PASS.
- `node --test plugins/dsh-postman-harness/lib/index.test.js plugins/dsh-postman-harness/lib/runtime.test.js plugins/dsh-postman-harness/lib/transport.test.js` — PASS, 42/42.
- `postman/test-github-wakeup.ps1` — PASS, 40/40; строгий старый протокол, отрицательные сценарии и независимость ключа от временной метки сохранены.
- Проверка PowerShell parser для `github-wakeup.ps1`, `test-github-wakeup.ps1` и `chatgpt_chat.ps1` — PASS.
- Проверены миграция схемы M4 → M6, точные SHA-256, unknown REQ, повторный deliveryKey, повторный signal, сохранение issue metadata и spoofing origin.
- `git diff --check` — PASS.
- `dsh --profile web --dump-config` — BLOCKED: установленный `dsh` не находит пакет `@deepseek-ai/dsh-app-boot`.

## Сценарии M6

Заполняются после живого прогона на опубликованной ветке:

| Сценарий | Ожидание | Факт |
|---|---|---|
| Один агент → Issue WAITING → Web ChatGPT SubmitOnly | автоматическая отправка | pending: нет рабочего dsh Harness |
| Issue READY → Actions → Windows signal → Runtime | `READY` | локальный путь PASS; live pending |
| READY → originating Agent | один `POSTMAN_RESULT` | pending: нет live Harness |
| Два агента и две Issue | cross-delivery = 0 | pending: нет live Harness |
| повтор workflow/event | `DUPLICATE_SUPPRESSED` | локальная модель PASS; live pending |
| Harness выключен при READY | signal сохранён и ingest при старте | локальный ingest PASS; live pending |

Live gate заблокирован внешним состоянием среды: процесс runner `dsh-postman-win` обнаружен, но команда `dsh` не стартует из-за отсутствующего `@deepseek-ai/dsh-app-boot`. Без рабочего Harness нельзя безопасно получить реальные имена агентов, REQ, Issues, Actions run/job и наблюдаемые продолжения.

## Итог

`BLOCKED — отсутствует запускаемый dsh Harness (@deepseek-ai/dsh-app-boot); локальная реализация и регрессионные проверки M1–M5/M6 проходят.`

## Обязательные живые доказательства

В отчёте должны быть exact SHA merge commit, имена агентов, `REQ_*`, номера Issue, Actions run/job, факт online runner `dsh-postman-win`, состояния DB и наблюдаемые маркеры продолжения. Содержимое ответа не передаётся через видимый ответ ChatGPT и не копируется пользователем.
