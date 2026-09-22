# Direct Web PostmanAsk — text production flow

> Trigger: exact current-message `@PostmanAsk`
> Trusted orchestration tool: `postman_send_current_turn()` without text arguments
> Production wrapper: `postman/direct/postman-ask.ps1`

## Назначение

PostmanAsk использует тот же Direct/Web browser transport, что artifact Postman, но возвращает
текст, когда ZIP избыточен.

```text
@PostmanAsk <intent>
→ trusted current-turn capture
→ canonical REQ
→ self-contained text task
→ exact correlated assistant turn
→ existing 10-second stable no-artifact re-proof
→ exact REQ-bound text envelope validation
→ TEXT_RESULT_DURABLE
→ Direct выбирает deliveryMode по exact длине результата
   ├─ inline: <= 4096 символов → exact assistantText → exact reply validator
   └─ file:   > 4096 символов → exact UTF-8 Markdown → compact file descriptor
```

## Result envelope

```text
<<<POSTMAN_ASK_BEGIN:<REQ>>>
<result text>
<<<POSTMAN_ASK_END:<REQ>>>
```

Принимается ровно одна пара markers с current REQ. Видимый текст вне envelope и пустое тело
запрещены. Обычный завершённый assistant text без markers не является успешным результатом.


## Delivery mode

После exact envelope Direct layer считает длину текста внутри markers.

```text
<= 4096 символов → deliveryMode=inline
>  4096 символов → deliveryMode=file
```

`inline` предназначен только для очень маленьких ответов. Markdown-файл не создаётся,
terminal содержит exact `assistantText`, и дальше действует существующий exact-reply validator.

`file` предназначен для всех остальных ответов. Direct атомарно записывает exact UTF-8 bytes
без BOM и без дополнительной обёртки в:

```text
<direct_root>/text-results/<REQ>/POSTMAN_<REQ>_ANSWER.md
```

File-mode terminal не содержит `assistantText`. Он содержит только compact descriptor:
`resultFile`, exact filename, MIME `text/markdown`, encoding `utf-8`, character/byte lengths и
SHA-256. Harness перечитывает файл до handoff и fail-closed проверяет absolute path/filename,
UTF-8 bytes, byte length и SHA-256. Descriptor с одновременно присутствующим `assistantText`
отклоняется, чтобы большой result не попадал в Luna context.

## Паузы

Text mode специально не принимает результат мгновенно. Он использует уже существующий Web
Worker contract: завершённый assistant turn без ZIP проходит fresh re-proof через 10 секунд;
если текст/SHA изменился, grace window начинается заново. После этого Direct Ask проверяет
text envelope.

Сохраняются общие reminder checkpoints на 10/20/30 минутах, общий deadline 45 минут и
same-conversation recovery Web Worker. Если ChatGPT в checkpoint всё ещё активно генерирует
ответ, reminder подавляется без изменения composer и не отправляется позднее задним числом.
Reminder pre-click path не использует общий 30-секундный Send wait: composer проверяется
однократно, затем действует максимум 5-секундное safe-send окно с polling раз в секунду.
Generation, появление/изменение assistant turn или отсутствие безопасного Send к концу окна
подавляют checkpoint; после вставки exact unsent reminder обязан быть доказанно очищен.
Непосредственно перед единственным click volatile proofs проверяются ещё раз; UNKNOWN и
неподтверждённая cleanup остаются fail-closed.

## Trusted current turn

Luna не копирует current user text в tool arguments. Тот же no-argument
`postman_send_current_turn()` внутри trusted Harness различает exact `@Postman` и
`@PostmanAsk`, сохраняет exact payload и выбирает соответствующий wrapper.


## Final handoff

После `TEXT_RESULT_DURABLE` Luna сначала проверяет `deliveryMode`.

### Inline

Для `deliveryMode=inline` Harness хранит exact `assistantText` в session-scoped reply slot.
Перед ответом Luna передаёт candidate в `postman_ask_validate_reply(request_id, text)`.
Проверка остаётся прямым строковым равенством без `trim`, whitespace/Markdown normalization
или дополнительного SHA-gate. Только `EXACT_REPLY_MATCH` разрешает вывести тот же candidate.
Mismatch требует повторно взять exact `assistantText`; unavailable/request mismatch/invalid —
`STOP`.

### File

Для `deliveryMode=file` полного `assistantText` в terminal result и reply slot нет.
`postman_ask_validate_reply` не вызывается. Luna не должна открывать файл, читать его кусками,
собирать текст обратно в model context или пересказывать содержимое только ради handoff.
Финальный ответ — короткая ссылка на exact локальный `resultFile` по общему правилу `AGENTS.md`
(путь в Markdown inline code); можно добавить только компактные metadata вроде длины и SHA-256.

Новый request в той же Luna session очищает предыдущий inline exact-reply slot, поэтому stale
Ask result не может подтвердить ответ для следующего REQ.

## Continuation

```text
@PostmanAsk --chat <old REQ> <new intent>
```

Old REQ — только lookup key сохранённого conversation URL. Новый запрос получает новый
canonical REQ. `TEXT_RESULT_DURABLE` добавлен к допустимым local conversation references.

## Граница text mode

PostmanAsk не создаёт durable ZIP handoff и не выполняет Git/PR integration. Если внешний
ChatGPT неожиданно выдаёт artifact terminal вместо text envelope, Ask flow завершается
fail-closed, а не принимает ZIP как текстовый результат.
