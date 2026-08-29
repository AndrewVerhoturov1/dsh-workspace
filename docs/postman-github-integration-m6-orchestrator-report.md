# Отчёт оркестратору: Postman GitHub Integration M6

Дата проверки: 29 августа 2026 года.

## Состояние кода

- База `main`: `56292d4933adc26bc8d9089979d45cd038ac77df`.
- Ветка: `postman/github-integration-m6`.
- Реализация M6 зафиксирована коммитом `a5021b190ee58d1bd701d9857f34809c229ca591`.
- Доработка моста зафиксирована в коммите `6084c134345347e9c3e6222c2445c575d4a4b8a0`: строгий Fresh-proof для `SubmitOnly`; перед отправкой требуются действие `Новый чат` и три стабильных семантических UIA-снимка. Runtime ID не является доказательством нового чата.
- Доработка host/surface зафиксирована коммитом `b420722027f4d9a765f39248709fa91b0cd7bd99`: раздельное обнаружение unified host и поверхности Codex/ChatGPT, штатный UIA-переход через `ExpandCollapsePattern` + `MenuItem.InvokePattern`, независимый ordinary-Chat proof и fail-closed ошибки. Ошибка `$matches` в PowerShell исправлена переименованием коллекции меню, чтобы автоматическая переменная `$Matches` не разрушала подсчёт кандидатов.
- В рабочем изменении исправлено подтверждение составного сообщения с глубоким UIA-якорем: опциональный путь использует `.ToArray()` и не меняет обычный предел видимой области.
- Независимые пользовательские изменения сохранены; `settings.yaml` не включается в коммиты.

## Маршруты A, B, C, W

- A — чтение задания, репозитория, существующего GitHub wakeup и M4–M5 Runtime.
- B — диагностика unified host и поверхности Codex, безопасная UIA-навигация в ordinary Chat, общий Fresh-gate и пять живых SubmitOnly-проб.
- C — `node --check`, 43/43 теста JavaScript, 40/40 тестов GitHub wakeup, 15/15 тестов surface-контракта, 13/13 тестов Fresh-контракта; внешний M6 остановлен на точном foreground blocker, без synthetic READY.
- W — ветка `postman/github-integration-m6`, без слияния в `main`, поскольку живой контрольный шлюз не прошёл.

## Проверки

| Проверка | Результат |
|---|---|
| GitHub runner `dsh-postman-win` | `status=online`, `busy=false`, метки `self-hosted, Windows, X64, postman` |
| Harness | `http://127.0.0.1:3080/` отвечает; схема базы M6 загружена |
| JS | PASS, 43/43 |
| GitHub wakeup PowerShell | PASS, 40/40 |
| Fresh-контракт PowerShell | PASS, 13/13 |
| Конфигурация | PASS через `dsh-cli-validation`; Flowglass и Postman присутствуют |
| Issue transport | Issue №19 создана для `REQ_13FFF51BE0E6477C9A4FB26E629FD43D` |
| Unified Desktop host | PASS: `ChatGPT (Beta).exe`, PID `34728`, host HWND `0x280788`, initial surface `CODEX` |
| SubmitOnly | PASS, 5/5: `M6_SUBMITONLY_PROBE_009`…`013`; `014` fail-closed до отправки |
| Последняя single-agent попытка | `MSG_M6_SINGLE_R15` → `REQ_F6687A0BC867459CB9B53D3827DD0874` → Issue #37; `CHAT_SUBMIT_STARTED`, затем `DESKTOP_HOST_FOUND_WRONG_SURFACE`, `sendAttempted=false` |

## Живой контур

Ранее временный агент `postman-m6-live-a-130758` создал `REQ_13FFF51BE0E6477C9A4FB26E629FD43D` и Issue [№19](https://github.com/AndrewVerhoturov1/dsh-workspace/issues/19); это было до ремонта host/surface и осталось WAITING. После ремонта были созданы новые настоящие запросы R11–R15. Ни один не дал полного доказательства до `CHAT_SUBMIT_CONFIRMED`; R15 остановлен на foreground-lock при переднем окне Unity `Back To The Dawn`.

Подменять внешний ответ, вручную писать READY-сигнал или засчитывать синтетический результат запрещено. Внешний transport для M6 разрешён и обязателен, но без подтверждённого SubmitOnly оставшиеся single-agent/A+B/duplicate/offline gates не засчитываются.

Поэтому живые сценарии двух агентов, повторного события и READY при выключенном Harness не засчитаны. Не выполнено также слияние в `main`.

## Безопасность

- `origin_agent_id` берётся только из durable Runtime.
- Неизвестный REQ не создаётся и не будит агента.
- Тело Issue и ответ рассматриваются как данные; `eval` и `Invoke-Expression` не используются.
- `settings.yaml`, секреты и диагностические артефакты не включены в рабочую фиксацию.
- Computer Use: `0`.

## Итог

`BLOCKED — REQ_F6687A0BC867459CB9B53D3827DD0874, Issue #37; последняя подтверждённая стадия CHAT_SUBMIT_STARTED, следующая CHAT_SUBMIT_CONFIRMED. Unified host найден, но Windows foreground-lock отказал в активации HWND 0x280788 из Harness при переднем окне Unity Back To The Dawn (PID 29032); sendAttempted=false. Поэтому single-agent, A+B, duplicate и offline/recovery не доказаны.`

Следующий минимальный этап после устранения внешнего блокера: production-проверка многозапросного транспорта с двумя одновременными агентами; сам многозапросный планировщик в M6 не реализовывался.
