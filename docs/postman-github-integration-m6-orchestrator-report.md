# Отчёт оркестратору: Postman GitHub Integration M6

Дата проверки: 29 августа 2026 года.

## Состояние кода

- База `main`: `56292d4933adc26bc8d9089979d45cd038ac77df`.
- Ветка: `postman/github-integration-m6`.
- Реализация M6 зафиксирована коммитом `a5021b190ee58d1bd701d9857f34809c229ca591`.
- Независимые пользовательские изменения сохранены; `settings.yaml` не включается в коммиты.

## Маршруты A, B, C, W

- A — чтение задания, репозитория, существующего GitHub wakeup и M4–M5 Runtime.
- B — реализация внешнего транспорта Issue → SubmitOnly → durable external READY, миграции схемы и восстановления сигналов.
- C — `node --check`, 41/41 тестов JavaScript, 36/36 тестов PowerShell, проверка схемы и живого Harness.
- W — ветка `postman/github-integration-m6`, без слияния в `main`, поскольку живой контрольный шлюз не прошёл.

## Проверки

| Проверка | Результат |
|---|---|
| GitHub runner `dsh-postman-win` | `status=online`, `busy=false`, метки `self-hosted, Windows, X64, postman` |
| Harness | `http://127.0.0.1:3080/` отвечает; схема базы M6 загружена |
| JS | PASS, 43/43 |
| GitHub wakeup PowerShell | PASS, 40/40 |
| Конфигурация | PASS через `dsh-cli-validation`; Flowglass и Postman присутствуют |
| Issue transport | Issue №19 создана для `REQ_13FFF51BE0E6477C9A4FB26E629FD43D` |
| SubmitOnly | BLOCKED: `CHAT_SUBMIT_FAILED`, `FRESH_CHAT_NOT_CONFIRMED` |

## Живой контур

Для временного агента `postman-m6-live-a-130758` запрос `MSG_M6_A_004` был принят и получил `REQ_13FFF51BE0E6477C9A4FB26E629FD43D`. Runtime создал Issue [№19](https://github.com/AndrewVerhoturov1/dsh-workspace/issues/19) и сохранил её в базе. Затем существующий Desktop UIA-мост отказался отправлять запрос, потому что не подтвердил свежую ChatGPT-поверхность. Issue осталась в состоянии `WAITING`, реального `READY`, сигнала runner-а и продолжения агента нет.

После перезапуска ChatGPT окно стало видимым для UIA, но проверка свежего чата завершилась `FRESH_CHAT_NOT_CONFIRMED: EMPTY_SURFACE_MARKER_NOT_FOUND`. Это внешний блокирующий фактор Desktop ChatGPT; подменять внешний ответ, вручную писать READY-сигнал или засчитывать синтетический результат запрещено.

Поэтому живые сценарии двух агентов, повторного события и READY при выключенном Harness не засчитаны. Не выполнено также слияние в `main`.

## Безопасность

- `origin_agent_id` берётся только из durable Runtime.
- Неизвестный REQ не создаётся и не будит агента.
- Тело Issue и ответ рассматриваются как данные; `eval` и `Invoke-Expression` не используются.
- `settings.yaml`, секреты и диагностические артефакты не включены в рабочую фиксацию.
- Computer Use: `0`.

## Итог

`BLOCKED — Desktop ChatGPT не подтверждает свежую поверхность для SubmitOnly (`FRESH_CHAT_NOT_CONFIRMED`); локальная реализация M6 и регрессии проходят.`

Следующий минимальный этап после устранения внешнего блокера: production-проверка многозапросного транспорта с двумя одновременными агентами; сам многозапросный планировщик в M6 не реализовывался.
