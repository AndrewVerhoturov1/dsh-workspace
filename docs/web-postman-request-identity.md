# Web Postman — сквозная идентичность запроса

## 1. Главный ключ

Каждый browser-first Postman request имеет один неизменяемый `request_id`:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

Пример:

```text
REQ_20260831T043812Z_4827
```

Где:

- `YYYYMMDDTHHMMSSZ` — фактическое UTC-время создания запроса до секунды;
- `NNNN` — ровно четыре случайные десятичные цифры `0000..9999`;
- `Z` обязателен: локальные timezone/offset в ключ не попадают.

Формат проверяется не только regex: timestamp должен быть реальной календарной UTC-датой.

## 2. Кто создаёт request_id

Новый production request ID создаёт **модель-инициатор Harness до вызова Postman**.

Postman Runtime не переименовывает и не заменяет этот ключ. Runtime является
регистратором и арбитром уникальности:

```text
initiating Harness model
→ creates request_id
→ postman_async_send(request_id, task)
→ Runtime validates format
→ Runtime checks durable registry
→ collision => reject before Web send
→ unique => register exact request_id
```

Если произошёл collision, никакой Web ChatGPT prompt ещё не отправлен. Инициатор
может создать новый четырёхзначный suffix и повторить регистрацию.

Существующие historical/legacy REQ в durable DB могут оставаться читаемыми для
recovery. Но новые browser-first requests должны использовать только новый
canonical format.

## 3. Ключ неизменяем

После успешной регистрации request ID копируется **byte-for-byte**. Нельзя:

- менять timestamp;
- менять четыре цифры;
- сокращать `REQ_`;
- переводить регистр;
- добавлять новый correlation ID вместо него;
- позволять Web ChatGPT, manifest или filename переопределить его.

Trusted mapping `REQ → origin_agent_id` по-прежнему принадлежит Runtime.

## 4. Производные имена

Внутренний `message_id` для нового async request детерминированно выводится из
того же ключа:

```text
REQ_20260831T043812Z_4827
→ MSG_20260831T043812Z_4827
```

Для одного ZIP результата:

```text
POSTMAN_REQ_20260831T043812Z_4827_RESULT.zip
```

Если один request явно ожидает несколько ZIP, request ID остаётся тем же, а
artifact получает двухзначный ordinal:

```text
POSTMAN_REQ_20260831T043812Z_4827_RESULT-01.zip
POSTMAN_REQ_20260831T043812Z_4827_RESULT-02.zip
...
POSTMAN_REQ_20260831T043812Z_4827_RESULT-99.zip
```

`-00` запрещён. Номер artifact не является частью request ID.

Runtime/request context заранее задаёт exact ожидаемое имя каждого artifact;
модель не выбирает ordinal самостоятельно.

## 5. Ключ в Web ChatGPT prompt

Первая непустая строка каждого production Web ChatGPT prompt:

```text
POSTMAN_REQUEST_ID: REQ_20260831T043812Z_4827
```

Дальше может идти trusted request bootstrap и TASK.

Это даёт устойчивый recovery/search anchor. Название ChatGPT conversation не
является authority: оно создаётся интерфейсом автоматически и может измениться.

При recovery worker ищет exact request ID в user turn и затем заново доказывает
корреляцию:

```text
exact request key in user turn
→ exact user turn
→ immediately following assistant turn
→ result envelope/artifact
```

Нельзя выбирать conversation только потому, что его title похож на request ID.

## 6. Ключ в ZIP response

Для ZIP финальный correlated assistant turn использует тот же exact REQ:

```text
<<<POSTMAN_RESULT_BEGIN:REQ_20260831T043812Z_4827>>>
POSTMAN_REQ_20260831T043812Z_4827_RESULT.zip   ← реальный download control
<<<POSTMAN_RESULT_END:REQ_20260831T043812Z_4827>>>
```

Реальный ZIP control должен физически находиться между BEGIN и END и иметь
видимую подпись, равную exact expected filename.

## 7. Ключ в состоянии и хранении

Тот же request ID используется как основной correlation key в:

```text
Runtime requests table
trusted REQ → origin_agent_id mapping
browser job metadata
prompt SHA metadata
ChatGPT user-turn search/recovery
assistant result envelope
manifest.json requestId
artifact filename
journal/events
result metadata
result directory
```

Будущий durable result path:

```text
%LOCALAPPDATA%\DSH\Postman\results\REQ_20260831T043812Z_4827\
```

## 8. Инвариант

```text
one logical request
=
one immutable request_id
=
one cross-system correlation key
```

Timestamp делает ключ удобным для человека и сортировки, четыре цифры защищают
от обычной same-second concurrency, а durable collision check Runtime даёт
окончательную гарантию, что зарегистрированный REQ не повторяется.
