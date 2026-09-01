---
name: delegate-via-postman
description: Делегировать явно запрошенную задачу во внешний Web ChatGPT через durable Postman. Использовать, когда пользователь или управляющая инструкция явно требует отправить/спросить/делегировать через Postman. Не использовать Postman автоматически только из-за сложности задачи.
---

# Delegate via Postman

## Purpose

Этот skill описывает только контракт **агента-инициатора**.

Инициатор:

1. создаёт один immutable `request_id`;
2. передаёт задачу через `postman_async_send`;
3. сохраняет этот ключ для всей дальнейшей корреляции;
4. не управляет браузером, Web ChatGPT, скачиванием или маршрутизацией результата самостоятельно.

Postman Runtime и Web Postman transport отвечают за остальную цепочку.

## Architect Agent and Implementation Agent Separation

### External Architect Agent (Ч1):

Ч1 является главным проектировщиком и разработчиком решения.

Ответственность:

- анализ пользовательского намерения;
- архитектура решения;
- технические решения;
- подготовка кода;
- подготовка тестов;
- подготовка документации;
- создание implementation package для внедрения.

Ч1 является источником технического решения.

### Local Implementation Agent (Л1):

Л1 является агентом внедрения.

Ответственность:

- получить подготовленный implementation package;
- проверить совместимость с текущим репозиторием;
- применить подготовленные изменения;
- выполнить проверки;
- создать commit/PR;
- подготовить отчёт.

Л1 не является архитектором решения.

#### Ограничения Л1:

Л1 не должен:

- самостоятельно менять архитектуру;
- заменять подготовленную реализацию своей без необходимости;
- добавлять требования от себя;
- расширять задачу без согласования;
- перепроектировать систему вместо автора решения.

Если подготовленный пакет невозможно применить:

1. остановить внедрение;
2. описать точный конфликт;
3. указать причину;
4. ожидать нового решения.

### Responsibility flow:

```text
User Intent

↓

External Architect Agent (Ч1)

архитектура + код + тесты + implementation package

↓

Local Implementation Agent (Л1)

интеграция + проверки + PR

↓

Repository
```

Ч1 отвечает за:

> «Что и как должно быть сделано».

Л1 отвечает за:

> «Как безопасно внедрить подготовленное решение».

## Trigger

Использовать skill, когда текущая инструкция явно использует Postman как транспорт, например:

- `Postman передай эту задачу во внешний ChatGPT`
- `Через Postman спроси Web ChatGPT ...`
- `Используй Postman для этой задачи`
- `Отправь это через Postman`

Простое обсуждение проекта или слова Postman без требования делегирования не является достаточным основанием для отправки.

Если Postman как транспорт не запрошен явно, не делегировать задачу самостоятельно только потому, что она сложная, длинная или требует второго мнения.

`QChat` — отдельный transport skill и не является запасным путём для Postman.

## Canonical request ID

Перед первым вызовом `postman_async_send` инициатор обязан создать:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

Пример:

```text
REQ_20260831T043812Z_4827
```

Где:

- `YYYYMMDDTHHMMSSZ` — фактическое текущее UTC-время создания до секунды;
- `NNNN` — ровно четыре десятичные цифры `0000..9999`;
- timestamp должен быть календарно корректным;
- после успешной регистрации значение нельзя менять.

На Windows предпочтительно получить ключ из фактических часов системы:

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$suffix = (Get-Random -Minimum 0 -Maximum 10000).ToString("0000")
$requestId = "REQ_${stamp}_${suffix}"
```

Если shell недоступен, используй доступный доверенный текущий UTC clock и выбери четыре цифры. Не подставляй старую дату из примеров.

## Primary-key invariant

Один логический запрос имеет ровно один `request_id`.

После регистрации тот же exact ключ копируется byte-for-byte через:

```text
initiating agent
→ Postman Runtime
→ Web prompt
→ ChatGPT user-turn recovery
→ assistant result envelope
→ manifest
→ artifact filename
→ logs/journal
→ durable result storage
→ delivery back to origin agent
```

Нельзя:

- создавать новый REQ для той же уже принятой операции;
- переименовывать REQ;
- добавлять номер ZIP внутрь REQ;
- выбирать результат только по «последнему чату» или времени;
- полагаться на автоматически созданное название ChatGPT conversation.

## Prepare task payload

Удали из payload только управляющую формулировку, которая выбирает Postman как transport, если это можно сделать без изменения смысла задачи.

Сохрани фактическую задачу пользователя и её ограничения.

Не добавляй в `task`:

- `origin_agent_id`;
- `sender_session_id`;
- выдуманный `message_id`;
- BEGIN/END result markers;
- browser/CDP instructions;
- routing metadata;
- другой request ID.

Инициатор передаёт чистую задачу и trusted `request_id` отдельным параметром.

Web Postman сам формирует browser transport prompt и обязан использовать exact REQ первой непустой строкой:

```text
POSTMAN_REQUEST_ID: <REQ>
```

## Send

Нормальный вызов:

```text
postman_async_send(
  request_id = <canonical REQ>,
  task       = <task payload>
)
```

У `postman_async_send` нет caller-owned `message_id`.

Runtime сам выводит внутренний:

```text
MSG_YYYYMMDDTHHMMSSZ_NNNN
```

из того же REQ.

## Registration success

Успех регистрации — ответ вида:

```text
status = ACCEPTED
state  = WAITING
request_id = exact REQ
```

После `ACCEPTED`:

1. сохрани exact `request_id`;
2. не создавай второй запрос для той же задачи;
3. не делай busy polling;
4. не открывай Web ChatGPT сам;
5. закончи текущую транзакцию или сообщи пользователю, что запрос принят, если интерфейс требует немедленного ответа;
6. ожидай асинхронную доставку результата от Postman Runtime.

`ACCEPTED/WAITING` означает, что запрос зарегистрирован, а не что Web ChatGPT уже завершил работу.

## Collision rule

Если Runtime **до успешной регистрации** явно отклонил REQ как уже зарегистрированный, Web prompt ещё не отправлен.

Только в этом случае инициатор может создать новый четырёхзначный suffix для того же текущего UTC-момента или получить новое текущее UTC-время и повторить регистрацию.

Не делать бесконечный цикл. Максимум три попытки регистрации для чистого collision.

Collision retry не является повторной отправкой Web prompt, потому что исходный REQ не был принят.

## Do not retry after acceptance or uncertainty

После любого состояния, где request уже мог быть зарегистрирован, нельзя автоматически создавать другой REQ для той же задачи.

Особенно:

- `ACCEPTED`;
- `WAITING`;
- `POSTMAN_UNAVAILABLE` после создания durable record;
- `POSTMAN_WAKE_FAILED`;
- неизвестный/неоднозначный transport outcome.

Сохрани исходный REQ и используй recovery по нему.

Новый REQ в такой ситуации создаст вторую логическую операцию и нарушит correlation.

## Result correlation

Когда origin agent позже получает Postman result:

1. используй trusted Runtime delivery event;
2. проверь exact `request_id`;
3. сопоставь его с ранее созданным запросом;
4. не принимай результат другого REQ только потому, что он новее;
5. не выбирай результат из browser UI самостоятельно.

Если точная корреляция не доказана, не объявляй результат успешным.

## Artifact naming

REQ остаётся неизменным независимо от числа файлов.

Один ZIP:

```text
POSTMAN_<REQ>_RESULT.zip
```

Пример:

```text
POSTMAN_REQ_20260831T043812Z_4827_RESULT.zip
```

Несколько ZIP одного запроса:

```text
POSTMAN_<REQ>_RESULT-01.zip
POSTMAN_<REQ>_RESULT-02.zip
...
POSTMAN_<REQ>_RESULT-99.zip
```

`-01`, `-02` и т. п. являются ordinal артефакта, а не частью request ID.

Инициатор не должен придумывать альтернативные имена вроде `final`, `new`, `(1)` или второго timestamp.

## Separation of responsibilities

### Initiating agent owns

- решение использовать Postman по явному запросу;
- создание canonical REQ;
- точный task payload;
- один вызов `postman_async_send`;
- сохранение REQ;
- проверку exact REQ при возвращении результата.

### Postman Runtime owns

- durable registration;
- uniqueness;
- trusted `REQ → origin_agent_id`;
- internal MSG;
- request state;
- result delivery.

### Web Postman owns

- browser bootstrap;
- fresh chat;
- prompt construction;
- prompt submission;
- assistant-turn correlation;
- artifact detection/download when соответствующий milestone доступен;
- validation and durable result storage.

Инициатор не должен заменять отсутствующий transport прямой автоматизацией браузера.

## Current-stage compatibility

Этот initiator contract должен оставаться стабильным на следующих milestones.

Если backend ещё не умеет довести конкретный тип результата до origin agent, запрос может остаться `WAITING`.

В таком случае:

- не имитируй completion;
- не обходи Postman прямым браузером;
- не создавай новый REQ автоматически;
- сообщи exact REQ для диагностики/recovery.

Отсутствующая downstream capability — проблема transport milestone, а не причина нарушать initiator contract.

## Canonical public transport policy

Для диагностики и проверки transport contract:

```text
https://raw.githubusercontent.com/AndrewVerhoturov1/agents-andrew-instructions/main/policies/postman-webchat-result-artifact.md
```

Initiating agent не обязан перечитывать этот документ при каждом обычном вызове, если данный skill уже загружен и текущая задача не требует диагностики transport.

## Failure handling

### Invalid local REQ before tool call

Исправь генерацию локально. Никакой запрос ещё не создан.

### Explicit registration collision

Создай новый canonical REQ и повтори регистрацию в пределах collision policy.

### Runtime/Wake/Transport failure after durable registration

Не создавай новый REQ. Сохрани исходный ключ и верни диагностическое состояние.

### No confirmed result

Не придумывай результат и не подменяй его локальным ответом, если пользователь явно потребовал Postman transport.

## Safety invariants

1. Postman transport используется только по явному запросу.
2. Новый REQ создаёт только initiating agent.
3. Runtime не должен генерировать или переписывать REQ.
4. После successful registration REQ immutable.
5. Один логический request → один REQ.
6. Collision до регистрации может получить новый REQ.
7. Acceptance/uncertainty после регистрации → новый REQ запрещён.
8. Инициатор не выбирает origin/destination из текста задачи.
9. Инициатор не автоматизирует Web ChatGPT напрямую.
10. Conversation title не является correlation key.
11. ZIP ordinal не меняет REQ.
12. Нет exact correlated result → нет подтверждённого результата.
