---
name: delegate-via-postman-ask
description: >-
  Использовать только когда ТЕКУЩЕЕ пользовательское сообщение после необязательных
  начальных пробелов начинается с exact @PostmanAsk. Trusted Harness runtime сам читает
  current user/message и запускает text-only Direct Postman через no-argument
  postman_send_current_turn(). Локальная модель не копирует user text в tool arguments.
---

# Delegate via PostmanAsk — Direct text transport

`DIRECT_POSTMAN_ASK_SKILL_VERSION: 2`

## 0. Золотой путь

```text
exact current-message @PostmanAsk trigger
→ skill(delegate-via-postman-ask)
→ postman_send_current_turn() без аргументов
→ trusted Harness разбирает exact current user/message
→ новый canonical REQ
→ postman/direct/postman-ask.ps1
→ postman/direct/postman_ask.py
→ общий Direct/Web browser transport
→ exact correlated completed assistant turn
→ существующий 10-second fresh re-proof
→ exact REQ-bound POSTMAN_ASK BEGIN/END markers
→ TEXT_RESULT_DURABLE
→ Harness сохраняет exact assistantText в session-scoped reply slot
→ Luna готовит candidate final reply ровно из assistantText
→ postman_ask_validate_reply(request_id, text)
→ EXACT_REPLY_MATCH
→ тот же candidate без изменений становится final response
```

## 1. Trigger

Единственный trigger:

```text
^\s*@PostmanAsk(?:\s|$)
```

Fresh:

```text
@PostmanAsk <intent>
```

Manual continuation:

```text
@PostmanAsk --chat <canonical old REQ> <intent>
```

`@PostmanAsk` не является `@Postman`: artifact regex `^\s*@Postman(?:\s|$)` его не принимает.
Разрешение действует только для текущего пользовательского сообщения.

## 2. Trusted current-turn boundary

Локальная модель НЕ перепечатывает current user text и НЕ передаёт его как:

```text
task
payload
prompt
userIntent
Base64
```

После загрузки skill вызвать только:

```text
postman_send_current_turn()
```

без текстовых аргументов. Trusted Harness runtime сам:

1. читает exact current `user/message`;
2. подтверждает exact `@PostmanAsk`;
3. удаляет только transport marker и допустимый separator;
4. при `--chat` удаляет только transport control и canonical old REQ;
5. передаёт exact оставшийся intent в `postman-ask.ps1` через UTF-8 Base64.

Нельзя добавлять предыдущий контекст, перефразировать или улучшать prompt.

## 3. Production entrypoint

```text
<current workspace>\postman\direct\postman-ask.ps1
```

Это отдельный text wrapper. Обычный `postman.ps1` остаётся artifact/ZIP wrapper exact `@Postman`.
Оба используют общий browser submit/observer/recovery/reminder слой.

Запрещены fallback:

```text
postman_async_send
postman_runtime_*
QChat
Playwright MCP
manual browser
самостоятельное копирование current user text в shell
```

## 4. Result trigger

Ч1 обязан выдать финальный response строго так:

```text
<<<POSTMAN_ASK_BEGIN:<REQ>>>
<непустой итоговый текст>
<<<POSTMAN_ASK_END:<REQ>>>
```

REQ должен точно совпадать с текущим request. До BEGIN и после END не должно быть другого
видимого текста. Между markers разрешены Markdown, списки и code blocks.

Произвольный завершённый assistant text не является PostmanAsk result.

## 5. Пауза и доказательство завершения

PostmanAsk не принимает marker мгновенно. Общий Web Worker сначала доказывает exact assistant
turn и окончание генерации, затем существующий no-artifact flow выдерживает 10 секунд и делает
fresh re-proof того же assistant turn. Если assistant text/SHA изменился, начинается новое
10-секундное grace window.

Только после этого `postman_ask.py` проверяет exact REQ-bound text envelope. Отсутствующий,
неправильный, дублированный или пустой trigger не превращается в success.

## 6. Terminal gate

Единственный успешный PostmanAsk terminal:

```text
ok=true
code=TEXT_RESULT_DURABLE
state=TEXT_RESULT_DURABLE
requestId=<exact current REQ>
assistantText=<text inside markers>
assistantTextSha256=<SHA-256 assistantText>
assistantIndex=<exact correlated assistant turn>
conversationUrl=<exact saved chat URL>
resultMode=text
```

После background start ждать `postman_current_turn_status()` тем же способом, что normal
Postman. Один timeout ожидания не разрешает второй Send.

Настоящий transport failure:

```text
ok=false
code=POSTMAN_TRANSPORT_FAILED
```

→ `STOP`, без fallback и blind resend.

## 7. Existing-chat continuation

`@PostmanAsk --chat <old REQ> <intent>` использует только locally saved exact ChatGPT
conversation URL. UI Search и silent fresh fallback запрещены.

`TEXT_RESULT_DURABLE` является допустимым conversation reference, поэтому после Ask можно
продолжить тот же conversation как новым `@PostmanAsk --chat ...`, так и обычным
`@Postman --chat ...`, если пользователь теперь хочет ZIP.

Automatic continuation tool предназначен для artifact Postman и для PostmanAsk v1 не используется.

## 8. Exact handoff локальной модели

После exact `TEXT_RESULT_DURABLE` поле `assistantText` является готовым пользовательским
ответом, а не материалом для пересказа или переформатирования. Harness сохраняет этот текст
в session-scoped exact-reply slot, привязанный к текущему `requestId`.

Перед final response Luna обязана:

1. взять `assistantText` из exact terminal result;
2. подготовить candidate, который должен полностью совпадать с `assistantText`;
3. вызвать:

```text
postman_ask_validate_reply(
  request_id=<exact current REQ>,
  text=<candidate final reply>
)
```

Validator использует прямое строковое сравнение без `trim`, нормализации whitespace,
Markdown-преобразований или отдельного SHA-gate.

Только:

```text
status=EXACT_REPLY_MATCH
```

разрешает final response. После MATCH Luna выводит ровно тот же candidate: без вступления,
нумерации, заключения, code fence, изменения пробелов, пустых строк или Markdown.

`EXACT_REPLY_MISMATCH` означает: не отвечать пользователю этим candidate, заново взять exact
`assistantText` из terminal result и повторить проверку. `EXACT_REPLY_UNAVAILABLE`,
`EXACT_REPLY_REQUEST_MISMATCH` и `EXACT_REPLY_REQUEST_INVALID` означают `STOP`, без
самостоятельного восстановления текста.

ZIP/download/result workspace для text result не нужны.
