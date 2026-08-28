# Отчёт оркестратору: Postman Async Routing M4–M5

Дата: 2026-08-29  
Ветка: `postman/async-routing-m4-m5`  
Базовый проверенный M1–M3 коммит: `6cefa2790b6a34c2016377db8ff8a74bc7f7cd8a`  
Коммит реализации M4–M5: будет указан после фиксации изменений.

## Итог

`POSTMAN ASYNC ROUTING M4-M5 READY`

## M4

- Durable runtime на встроенном `node:sqlite` реализован.
- База: `%LOCALAPPDATA%\DSH\Postman\postman.db`.
- Журнал: `%LOCALAPPDATA%\DSH\Postman\logs\postman.jsonl`.
- Схема версии 1: `metadata`, `messages`, `requests`, `deliveries`.
- `REQ_*` генерируется runtime из UUID; `REQ → origin_agent_id` сохраняется транзакционно.
- `POSTMAN_ACCEPTED` выдаётся только после успешной записи `MSG_*` + `REQ_*`.
- Sender берётся из `exec.agent.id`; ложный `from_session` не участвует в маршрутизации.

## M5

- `postman_runtime_synthetic_ready` доступен только при `DSH_POSTMAN_ALLOW_SYNTHETIC_READY=1`.
- `READY` вычисляет SHA-256, фиксирует стабильный `delivery_key`, будит ту же POSTMAN-сессию.
- POSTMAN читает результат и владельца из runtime, затем доставляет `POSTMAN_RESULT` исходному агенту через `Agent.followup()`.
- Статусы: `ACCEPTED → WAITING → READY → DELIVERING → DELIVERED`; ошибки сохраняют результат как retryable или blocked.

## Живая проверка

- A→POSTMAN→READY→A: `REQ_1C66FF1B05DC455F8AE744DEEF7445A6`, маркер `ASYNC_ALPHA_A2_RECEIVED`.
- Перезапуск между ACCEPTED и READY: `REQ_7B2CE25C962B418BB8FBA00228DC05ED`, маркер `ASYNC_RESTART2_RECEIVED`; исходный агент восстановлен через `ctx.agents.resume()`.
- READY recovery после перезапуска: `REQ_3D0586D412784AAAB79048D399D8B931` оставлен READY без wakeup, затем автоматически доставлен; маркер `READY_RECOVERY_RECEIVED`.
- A+B reverse-ready: A=`REQ_5C77086F215D4C9A829B11BB681AFE6B`, B=`REQ_BCF0F4CAC509434A974C2647351AE091`, порядок B→A, cross-delivery=0.
- Один агент, три запроса: A1=`REQ_164CB1A411FF4BE481254736618B8F12`, A2=`REQ_5DB6CB7AB0D848A99BAADA64CCBF36C7`, A3=`REQ_A85AF29090404034B4541E9D12D09DFD`; READY A2→A1→A3, все три доставлены правильно.
- Повтор READY для `REQ_1C66FF1B05DC455F8AE744DEEF7445A6`: `DUPLICATE_SUPPRESSED`, в базе одна доставка.
- Отдельный отрицательный прогон сохранил `DELIVERY_BLOCKED_ORIGIN_MISSING`, не потеряв результат.

## Проверки

- `node --check` для `runtime.js` и `index.js` — PASS.
- M1–M3 и M4–M5 unit/integration: 28/28 — PASS.
- `dsh --profile web --dump-config` эквивалентно выполнен через рабочую локальную установку DSH: Flowglass и `dsh-postman-harness` присутствуют, `agent-loop.config.agents=[]`.
- Несколько холодных запусков выполнены в обычном режиме с включённым Flowglass; исходники Flowglass не менялись.
- Настоящий Web ChatGPT и новый GitHub live flow не подключались.
- `settings.yaml`, секреты и посторонние UIA-артефакты в коммит не включены.

## Ограничение exactly-once

В Harness `Agent.followup()` имеет тип `void`, без идентификатора события и подтверждения enqueue. Поэтому повторный READY подавляется и в нормальном пути вторая доставка не создаётся; строгий exactly-once в окне между enqueue и фиксацией `DELIVERED` не обещается. Состояние `DELIVERING` после такого сбоя не повторяется вслепую.

## Маршруты

- A — код, SQLite, журнал и локальные тесты.
- B — внутренняя доставка через `Agent.followup()`.
- C — разрешённый Host API для создания тестовых Harness-агентов и проверки историй.
- W — рабочая ветка `postman/async-routing-m4-m5`; `main` не изменён и не сливался.

Минимальный следующий integration seam: преобразовать существующий сигнал GitHub `REQ_*.json` в вызов `markSyntheticReady` внутри runtime, не меняя GitHub transport на этом этапе.

