# Журнал подпроекта Postman

## Правила

- Записывать только существенные решения и этапы.
- Не вести журнал каждого commit, теста или микрошагa.
- Каждая запись кратко отвечает: что изменилось, почему, результат.

## Записи

### 2026-09-19 — Direct Web Postman закреплён как production path

- **Что изменилось:** production transport сведён к Direct Web Postman, а artifact validation — к transport-safety boundary.
- **Почему:** требовался единый fail-closed production path без старого async transport в критическом пути.
- **Результат:** закреплены current production contracts и пройден fresh + continuation E2E.

### 2026-09-20 — Зафиксированы long-running orchestration и reminders

- **Что изменилось:** один REQ выполняется как один background job; reminders назначены на 10/20/30 минут при общем deadline 45 минут.
- **Почему:** законный Postman request может выполняться дольше одного orchestration tool-call.
- **Результат:** timeout ожидания не разрешает второй Send или новый REQ.

### 2026-09-21 — Зафиксирован terminal/continuation/recovery contract

- **Что изменилось:** добавлены terminal no-artifact/rejected handoff, fresh 10-second reproof, новое grace window при изменении assistant text, same-conversation recovery и разделение manual/automatic continuation без hard cap.
- **Почему:** завершённый ответ модели нужно отличать от transport failure и безопасно продолжать только доказанный conversation.
- **Результат:** сформирован текущий production lifecycle; `POSTMAN_TRANSPORT_FAILED` остаётся fail-closed и не продолжается автоматически.

### 2026-09-21 — Postman оформлен как подпроект

- **Что изменилось:** существующее направление зарегистрировано в `docs/subprojects/postman/`.
- **Почему:** Postman развивается через множество отдельных runtime/docs/tests задач и требует долговременного контекста между ними.
- **Результат:** `SUBPROJECT.md` хранит актуальный контекст и решения, а канонические Postman contracts остаются на существующих путях.

### 2026-09-22 — Добавлен отдельный text transport `@PostmanAsk`

- **Что изменилось:** рядом с artifact `@Postman` спроектирован text-only `@PostmanAsk` с отдельным Direct wrapper, exact REQ-bound BEGIN/END trigger и `TEXT_RESULT_DURABLE`. Trusted current-turn Harness сам выбирает wrapper без передачи user text моделью в tool arguments.
- **Почему:** для анализа и консультаций ZIP избыточен, но обычный завершённый текст нельзя принимать без доказанного transport trigger и паузы стабильности.
- **Результат:** text mode переиспользует общий browser/correlation/recovery слой и существующий 10-second fresh re-proof; artifact mode и его ZIP-контракт остаются отдельными и неизменёнными.

### 2026-09-22 — Добавлена проверка точного final handoff PostmanAsk

- **Что изменилось:** Harness сохраняет `TEXT_RESULT_DURABLE.assistantText` в session-scoped reply slot и проверяет candidate Luna через `postman_ask_validate_reply` прямым строковым равенством.
- **Почему:** smoke-тест показал, что Luna может сохранить смысл, но добавить нумерацию или иначе переформатировать готовый text result.
- **Результат:** только `EXACT_REPLY_MATCH` разрешает final response тем же candidate; mismatch не принимается, при этом browser/Direct transport PostmanAsk не меняется.

### 2026-09-22 — Reminders перестали вмешиваться в active generation

- **Что изменилось:** 10/20/30 минут закреплены как absolute reminder checkpoints; active generation подавляет соответствующий reminder до изменения composer, а race после вставки требует доказанной очистки exact unsent текста.
- **Почему:** long-running PostmanAsk stress-test показал, что reminder мог заполнить composer во время streaming, не найти обычный Send control и завершить REQ transport failure.
- **Результат:** работающий assistant больше не прерывается служебным сообщением, suppressed checkpoints не накапливаются, а uncertain/неочищенное состояние остаётся fail-closed.


### 2026-09-22 — Reminder safe-send закрывает late-send race

- **Что изменилось:** reminder больше не использует generic 30-second wait для Send; введено отдельное 5-second safe-send окно с polling раз в секунду, latest same-REQ turn fingerprint и финальной pre-click reproof.
- **Почему:** после первого streaming fix оставалась гонка: Send мог появиться только после завершения длинной generation, и просроченный reminder всё ещё мог отправиться задним числом.
- **Результат:** generation/assistant activity в любой момент pre-click окна подавляет checkpoint, отсутствие Send за 5 секунд приводит к cleanup+skip, а UNKNOWN click или недоказанная cleanup остаются fail-closed.

### 2026-09-22 — Postman Leader/Bridge выделен в отдельную supervisor boundary

- **Что изменилось:** поверх Direct `@Postman`/`@PostmanAsk` добавлен `Postman Leader`, который создаёт model-authored delegation через `postman_bridge`; follow-up hardening делает Bridge видимым только top-level `postman-leader` и повторно проверяет caller в execute path.
- **Почему:** сильная модель должна выбирать задачу, mode и continuation, а минимальная Luna — только безопасно запускать trusted current-turn transport; глобально видимый Bridge и неявное исключение из direct-trigger policy размывали эту границу.
- **Результат:** fresh child всегда fixed `codex / gpt-5.6-luna`, trusted terminal читается host-ом напрямую, ordinary Agents не получают Bridge, а model routing Leader-а остаётся штатным Harness model selector (`GPT-5.6 Sol` выбирается отдельно, preset его не подменяет).
