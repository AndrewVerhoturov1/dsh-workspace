# Web Postman — production artifact contract

## Статус

Этот документ описывает текущий production-контракт результата Direct Web Postman.

Канонический runtime flow находится в:

```text
postman/POSTMAN_CURRENT_FLOW.md
```

Реализация transport и validation находится в:

```text
postman/direct/
postman/web/
```

## 1. Базовый принцип

```text
External ChatGPT
= reasoning + proposed implementation artifact

Direct/Web Postman
= transport + correlation + download + validation + durable handoff

Local Harness agent
= последующая работа с уже проверенным RESULT_DURABLE
```

Внешний ChatGPT не является authority для локальной маршрутизации, путей на диске или выбора request identity.

## 2. Request identity

Каждый production request использует один canonical immutable key:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

Один logical request должен сохранять один и тот же `request_id` во всех слоях transport.

Первая непустая строка отправляемого transport prompt должна содержать exact key:

```text
POSTMAN_REQUEST_ID: <requestId>
```

Название ChatGPT conversation не является идентификатором запроса.

## 3. Production result

Production Direct Postman использует один ZIP и для обычных universal results, и для coding workloads.

Для одного ZIP имя выводится детерминированно:

```text
POSTMAN_<requestId>_RESULT.zip
```

Для заранее ожидаемых нескольких artifacts допускаются ordinals `01..99`:

```text
POSTMAN_<requestId>_RESULT-01.zip
POSTMAN_<requestId>_RESULT-02.zip
```

`-00` не используется.

## 4. Correlated assistant turn

Artifact принимается только из assistant turn, который доказан как ответ на разрешённый
user anchor exact текущего request. Разрешённый anchor — первоначальный Postman prompt
или служебное напоминание Direct Postman с тем же trusted `requestId`.

Для одного REQ допускается до трёх таких служебных напоминаний по фиксированному
расписанию 10/20/30 минут. Они не создают новый request и не меняют semantic intent.
Если скачанный ZIP не проходит проверку содержимого, `ARTIFACT_INVALID` считается
повторяемой ошибкой результата: его staging-каталог удаляется, а следующий срок
напоминания запускает новую попытку. Ошибки валидатора, записи, доверенной аттестации,
скачивания и другие внутренние ошибки немедленно завершают REQ. А произвольный новый user turn
разрешённым anchor не является.

Финальный assistant turn должен содержать envelope:

```text
<<<POSTMAN_RESULT_BEGIN:<requestId>>>
<real downloadable ZIP control with exact expected filename>
<<<POSTMAN_RESULT_END:<requestId>>>
```

Требования:

- BEGIN содержит exact trusted `requestId`;
- END содержит тот же exact `requestId`;
- ожидаемый ZIP control находится между BEGIN и END;
- visible filename совпадает с exact expected filename;
- простой текст с именем файла не заменяет downloadable control;
- ZIP из другого assistant turn не подходит;
- последний ZIP на странице не выбирается по принципу «самый свежий» без correlation proof.

## 5. ZIP structure

Normal Postman не навязывает внутреннюю schema результата. ZIP может содержать любые
нужные deliverables в естественной безопасной структуре, например:

```text
POSTMAN_<requestId>_RESULT.zip
├── result.md
├── notes.txt
└── assets/
    └── image.png
```

`files/`, `changes.patch`, `resultType`, `patch` и `files[]` не обязательны для transport.
`manifest.json` также необязателен. Если он присутствует, unknown/extra fields допустимы,
а `protocolVersion`, `repository`, `baseCommit`, `resultType`, `patch` и `files` являются
информационными для normal transport. Единственный manifest hard reject: присутствующий
строковый `requestId` явно не совпадает с trusted current REQ.

Содержимое ZIP является proposed result; для code-result это proposed implementation.
Сам факт скачивания ZIP не разрешает автоматически изменять рабочий repository.
Repository/application validation выполняется только на отдельной explicit downstream boundary.

## 6. Trust boundaries

Trusted request identity приходит из локального request context и browser correlation proof,
а не из содержимого ZIP.

Normal transport доказывает:

```text
exact current REQ in correlated user/assistant flow
exact expected downloadable filename
one browser download event
actual ZIP SHA-256
safe archive structure and limits
```

`manifest.json` не является authority для repository/application decisions. Malformed,
non-object или отсутствующий manifest не превращает безопасно скачанный ZIP в transport failure.

## 7. Path safety

Каждый archive entry остаётся subject to structural path-safety validation независимо от
содержимого или назначения результата.

Недопустимы:

- absolute paths;
- Windows drive paths;
- UNC paths;
- `..` traversal;
- NTFS alternate data streams;
- symlink/reparse/special entries;
- duplicate paths;
- normalized/case-insensitive collisions;
- Windows reserved path names и другие extraction-unsafe path forms.

Repository `allowedPaths` / `forbiddenPaths` и содержимое unified diff не проверяются на
normal transport boundary, потому что RESULT_DURABLE не применяет ZIP к repository.

## 8. Size and archive safety

Validator должен fail-closed отклонять malformed ZIP и аномальные archives, включая:

- слишком большой compressed artifact;
- слишком большой total uncompressed size;
- чрезмерно большой отдельный entry;
- чрезмерное количество entries;
- pathological compression ratio / ZIP-bomb risk;
- duplicate or colliding normalized paths.

Лимиты принадлежат текущей реализации validator, а не тексту assistant response.

## 9. Download lifecycle

Postman должен:

1. доказать exact request correlation;
2. доказать exact downloadable control;
3. инициировать ожидаемый browser download;
4. сохранить artifact во временную/request-scoped область;
5. выполнить validation;
6. только после успешной validation опубликовать durable result metadata.

Нельзя считать существование attachment в DOM равным успешному durable result.

## 10. RESULT_DURABLE

`RESULT_DURABLE` означает, что Postman получил, сохранил и провалидировал artifact конкретного request.

Он не означает автоматический merge, commit или изменение production workspace.

Для normal flow после `RESULT_DURABLE` дальнейшее применение не выполняется: результат
сообщается пользователю и поток останавливается. Repository-changing result может быть
обработан только отдельной явной manual finalization по текущей repository policy.

## 11. Что transport не делает

Direct/Web Postman transport не должен:

- выбирать требования или архитектуру вместо внешней модели;
- менять пользовательское намерение;
- применять скачанный ZIP напрямую поверх repository без downstream workflow;
- выбирать artifact только по времени появления;
- выполнять содержимое ZIP;
- доверять model-provided routing metadata;
- делать blind resend, когда состояние предыдущего send неопределённо.

Фиксированное служебное напоминание с новым номером `REMINDER 1/3..3/3` не является
blind resend исходной задачи: это заранее определённый transport control того же REQ.
Для результата отправки допускаются только доказанные состояния: `PROVEN_SENT` продолжает
цикл, `PROVEN_NOT_SENT` продолжает его лишь после безопасной очистки поля, а `UNKNOWN`
немедленно завершает REQ без следующего напоминания.

## 12. Production invariants

```text
one logical request
= one immutable request_id
+ zero to three authorized reminder turns

exact request correlation
+ exact assistant turn
+ exact expected downloadable ZIP
= artifact correlation proof

successful download
+ validator PASS
+ durable request-scoped storage
= RESULT_DURABLE

model output = untrusted proposal
local request state = routing authority

Web Postman transport != automatic workspace mutation
```
