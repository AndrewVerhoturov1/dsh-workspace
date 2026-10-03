# Журнал подпроекта Postman

## Правила

- Записывать только существенные решения и этапы.
- Не вести журнал каждого commit, теста или микрошагa.
- Каждая запись кратко отвечает: что изменилось, почему, результат.

## Записи

### 2026-10-03 — Уточнение границы presend lock после #328

- **Что изменилось:** общий browser-presend.lock берётся только для fresh `/`; existing/packaging/reminder/system continuation сохраняют прежний ownership/cleanup/one-shot декоратор без глобального ожидания. Admission timeout возвращает terminal PROVEN_NOT_SENT до DOM/upload/fill.
- **Почему:** живой WORKING reminder ждал55,359с и потерял operation_deadline; A–E доказали shared draft у fresh+fresh, но не между независимыми `/c/`.
- **Результат:** исправленный reminder отправлен во время55с Image holder; 4/4 initial Image Send с собственными attachment, waits до160,298с. Полного4/4 durable нет: поздние download/CDP сбои честно отделены. Подробности и ограничения — [отчёт](PRESEND_LOCK_BOUNDARIES_20261003.md).

### 2026-10-03 — Send: shared home draft, безопасная очистка и reminder click

- **Что изменилось:** короткая cross-process блокировка prepare/upload/fill/Send/proof; общий cleanup только exact owned PROVEN_NOT_SENT без попытки Send; reminder click timeout 5 секунд и безопасный тип attachment exception.
- **Почему:** controlled stagger доказал восстановление общего home draft после hydration; конкретный второй reminder падал внутри click с бюджетом 1 секунда, не на guard. Первоначальное attachment-исключение старый snapshot потерял и его причина не выдумана.
- **Результат:** финальный full Image batch 3/3 IMAGE_RESULT_DURABLE одновременно с ordinary/reminder и независимым /c/ чатом; UNKNOWN не очищается и не повторяется. Подробности, тесты и ограничения — [отчёт](SEND_INVESTIGATION_20261003.md).

### 2026-10-01 — Review PR #294: recovery на границах UI и deadline

- **Что изменилось:** weak interruption блокирует recovery READY; exhaustion reload переводит connection flow в пассивное CONNECTION_WAITING без F5/reminders. Grace привязан к confirmation timestamp, terminal journal различает COMPLETED/FAILED/ABORTED.
- **Почему:** прежняя проверка могла принять остающийся weak banner за готовый UI, завершить REQ раньше deadline и потерять pending recovery на границе soft timeout; cleanup ошибочно журналировал success.
- **Результат:** production Chromium regressions покрывают остающийся weak banner, exhaustion/disappearance/timeout/re-arm/result priority, поздний observer return и Send UNKNOWN без duplicate click. Дополнительная правка serial handoff закрывает Additional Processing как ABORTED перед Connection recovery при interruption на границе wait/Send; result-first, fresh lineage/composer proof, weak confirmation и deadline сохранены. Общие safety guards сохранены.

### 2026-10-01 — Reminders и системный Web recovery сериализованы

- **Что изменилось:** 50 natural continuation templates без visible transport headers; exact internal intent/ordinal/prefix/groupKey proof. Slots 10/20/30/40/50, soft 60m, текущий recovery hard grace +45s. Connection headline распознаётся без fixed subtitle и внутри modern turn wrappers. Additional Processing: Stop-if-present→Reload→Lineage re-proof→Uniform wait 10–17s→Exact Continue.
- **Почему:** реальные interruption пропускались, processing лишь ожидался, а reminder metadata попадала в chat. Один непрерывный banner теперь один event; active recovery consume-ит наступившие slots без догоняющей очереди.
- **Результат:** production path и contracts синхронизированы; bounded append-only event journal сохраняет evidence/rejection/counters, фазы, Stop/reload/re-proof/wait/Send и судьбу slots. Реалистичные Chromium DOM/production bridge tests покрывают exact lineage, repeated template, no blind resend и deadline grace.

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

### 2026-09-22 — Bridge restriction следует за сменой preset до первого turn

- **Что изменилось:** Bridge boundary manager хранит один restriction на live Agent и заменяет его на `agent-preset/selected`; старый exact disposer снимается перед продолжением работы.
- **Почему:** Harness разрешает пустой сессии переключиться `standard → postman-leader` после `agent/created`; прежний одноразовый deny оставался активным и из-за пересечения restrictions мог скрывать Bridge у уже выбранного Leader.
- **Результат:** `standard → postman-leader → standard` корректно меняет видимость `postman_bridge`, а execute-level caller guard остаётся независимой fail-closed защитой.

### 2026-09-22 — Большие PostmanAsk results вынесены из Luna context

- **Что изменилось:** ответы до 4096 символов остаются inline без файла; любой более длинный exact PostmanAsk result атомарно сохраняется как UTF-8 Markdown и передаётся Harness/Luna только compact descriptor.
- **Почему:** production session с ответом около 66 тысяч символов показала многократное дублирование одного текста через terminal result, exact-reply validator и chunk reassembly, из-за чего Luna тратила контекст на механическую пересылку.
- **Результат:** большие ответы больше не проходят через model context целиком; Harness проверяет файл byte-for-byte, inline validator сохраняется только для действительно маленьких ответов.

### 2026-09-23 — Postman Leader синхронизирован с file-mode PostmanAsk

- **Что изменилось:** Bridge child теперь ветвится по `deliveryMode`: inline сохраняет exact-validator path, file не вызывает validator и не читает Markdown; parent Leader принимает verified file descriptor и при необходимости читает `resultFile` выборочно собственными read-only tools.
- **Почему:** после внедрения long-result Markdown handoff supervisor persona и Leader docs всё ещё безусловно ожидали `TEXT_RESULT_DURABLE.assistantText`, которого в file-mode намеренно нет.
- **Результат:** direct и supervisor контракты снова согласованы; большой PostmanAsk result не возвращается в Luna context, а сильный Leader может исследовать файл без полной rehydration.

### 2026-09-28 — Direct continuation ограничен, проверка пакета не дублируется

- **Что изменилось:** Direct automatic continuation допускает не более двух новых REQ на root chain; manual `--chat` создаёт отдельную root chain. Central runner PASS с объявленными тестами на target worktree сохраняет authority до изменения релевантных входов.
- **Почему:** исключить неограниченную автоматическую работу и повторное доказательство уже проверенного без изменения условий.
- **Результат:** Worker follow-up и Bridge не ограничены Direct budget; результат runner reuse-ится при отдельном решении о публикации. Запись от 2026-09-21 выше описывает прежнее состояние; текущие контракты — в `postman/POSTMAN_CURRENT_FLOW.md` и `system/implementation-package-workflow.md`.

### 2026-09-29 — Совмещение адресного Worker и защищённого закрытия

- **Что изменилось:** #246 интегрирует `workers[id]` из #242 с точной корреляцией назначений/report, проверкой сохранённой истории после освобождения Agent, подтверждённой отменой uncertain и SHA-привязанной поправкой closing result.
- **Почему:** обычное закрытие должно отличать доказанный результат от отсутствия Agent, а restore не должен превращать pause в отмену.
- **Результат:** native in-process AgentLoop/continuation manager с фиктивным провайдером подтверждает автоматическое пробуждение Leader после report, естественное освобождение Worker и адресный close; JSON/Session reopen сохраняют B/C. Активный Host и установленный пакет не изменены.
