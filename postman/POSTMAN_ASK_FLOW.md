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
→ assistantText back to local model
```

## Result envelope

```text
<<<POSTMAN_ASK_BEGIN:<REQ>>>
<result text>
<<<POSTMAN_ASK_END:<REQ>>>
```

Принимается ровно одна пара markers с current REQ. Видимый текст вне envelope и пустое тело
запрещены. Обычный завершённый assistant text без markers не является успешным результатом.

## Паузы

Text mode специально не принимает результат мгновенно. Он использует уже существующий Web
Worker contract: завершённый assistant turn без ZIP проходит fresh re-proof через 10 секунд;
если текст/SHA изменился, grace window начинается заново. После этого Direct Ask проверяет
text envelope.

Сохраняются общие reminders 10/20/30 минут, общий deadline 45 минут и same-conversation
recovery Web Worker.

## Trusted current turn

Luna не копирует current user text в tool arguments. Тот же no-argument
`postman_send_current_turn()` внутри trusted Harness различает exact `@Postman` и
`@PostmanAsk`, сохраняет exact payload и выбирает соответствующий wrapper.

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
