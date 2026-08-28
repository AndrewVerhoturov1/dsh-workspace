# Проверки Postman M4–M5

Дата: 2026-08-29

## Детерминированные проверки

Команды:

```text
node --check plugins/dsh-postman-harness/lib/runtime.js
node --check plugins/dsh-postman-harness/lib/index.js
node --test plugins/dsh-postman-harness/lib/index.test.js plugins/dsh-postman-harness/lib/runtime.test.js
```

Текущий набор: 27/27 PASS.

Покрыты:

- атомарное создание `MSG_*` + `REQ_*`;
- уникальная генерация `REQ_*` самим runtime;
- durable `REQ → origin_agent_id`;
- отсутствие `ACCEPTED` при ошибке коммита;
- немедленный асинхронный ответ отправителю без ожидания результата;
- synthetic `READY` и пробуждение POSTMAN;
- стабильный `delivery_key` и повторное `READY` без второй доставки;
- неизвестный `REQ_DOES_NOT_EXIST`;
- игнорирование ложного `from_session` в задании;
- `READY → DELIVERING → DELIVERED`;
- ошибка доставки не становится `DELIVERED`;
- отсутствующий исходный агент и сохранение результата;
- несколько запросов одного агента с выдачей в обратном порядке;
- сохранение `READY` и владельца после повторного открытия SQLite;
- scoped API POSTMAN и `allow: []`;
- отказ старого M1–M3 пути при неверной авторизации.

## Настоящий Harness E2E

Проверено в живом Web Harness с переменной среды `DSH_POSTMAN_ALLOW_SYNTHETIC_READY=1`:

1. Agent A создал `REQ_E927BA083ABE4D479DBBF35AB9685801`, получил `POSTMAN_ACCEPTED`, а после READY получил результат без ручной передачи и продолжил работу.
2. Повторный чистый прогон Agent A создал `REQ_1C66FF1B05DC455F8AE744DEEF7445A6`; маркер `ASYNC_ALPHA_A2_RECEIVED` записан самим агентом после `POSTMAN_RESULT`.
3. После перезапуска между `ACCEPTED` и `READY` `REQ_7B2CE25C962B418BB8FBA00228DC05ED` был восстановлен и доставлен исходному Agent A; маркер `ASYNC_RESTART2_RECEIVED` подтверждён.
4. Для READY recovery без немедленного пробуждения `REQ_3D0586D412784AAAB79048D399D8B931` оставлен в `READY`, затем после холодного запуска автоматически доставлен; маркер `READY_RECOVERY_RECEIVED` подтверждён.
5. Два агента создали `REQ_5C77086F215D4C9A829B11BB681AFE6B` (A) и `REQ_BCF0F4CAC509434A974C2647351AE091` (B). READY подан в порядке B → A; A получил только `ASYNC_RESULT_ALPHA_REVERSE`, B — только `ASYNC_RESULT_BRAVO_REVERSE`, маркеры `A_REVERSE_RECEIVED` и `B_REVERSE_RECEIVED` подтверждены.
6. Один агент создал три запроса: `REQ_164CB1A411FF4BE481254736618B8F12` (A1), `REQ_5DB6CB7AB0D848A99BAADA64CCBF36C7` (A2), `REQ_A85AF29090404034B4541E9D12D09DFD` (A3). READY подан A2 → A1 → A3; все три маркера получены, одна строка доставки на каждый REQ.
7. Повторный READY для уже доставленного `REQ_1C66FF1B05DC455F8AE744DEEF7445A6` дал `DUPLICATE_SUPPRESSED`; второй `followup` не создавался.

Проверено несколько холодных запусков с включённым Flowglass; последний процесс поднят в обычном режиме, без overlay. Финальный статус синтетического контура: `POSTMAN ASYNC ROUTING M4-M5 READY`.
