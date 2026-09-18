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

Текущий coding-result transport ожидает ZIP artifact.

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

Artifact принимается только из assistant turn, который доказан как ответ на exact текущий request.

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

Implementation ZIP использует manifest и payload, достаточный для детерминированной проверки результата.

Типовая структура:

```text
POSTMAN_<requestId>_RESULT.zip
├── manifest.json
├── changes.patch          # если результат использует patch
└── files/
    └── <repo-relative files>
```

Содержимое ZIP является proposed implementation. Сам факт скачивания ZIP не разрешает автоматически изменять рабочий repository.

## 6. Trust boundaries

Trusted значения приходят из локального request context и Direct Postman state.

Не считать authority значения, полученные только из:

- assistant text;
- имени attachment без correlation proof;
- `manifest.json` без сравнения с trusted request context;
- заголовка ChatGPT conversation;
- произвольного текста внутри ZIP.

Как минимум должны коррелировать:

```text
requestId
repository
baseCommit
expected artifact filename
assistant turn
manifest identity
```

## 7. Path safety

ZIP и patch не должны писать за пределы разрешённого repository scope.

Недопустимы:

- absolute paths;
- Windows drive paths;
- UNC paths;
- `..` traversal;
- NTFS alternate data streams;
- symlink/reparse/special entries, если validator не разрешает их явно;
- normalized/case-insensitive collisions;
- Windows reserved path names;
- forbidden runtime/user paths.

К runtime/user paths относятся, в частности:

```text
.git/
.credentials.yaml
codex-oauth.json
settings.yaml
attachments/
sessions/
storages/
backup/
profiles/web/node_modules/
```

Точный список validator rules определяется текущим кодом `postman/web/` и `postman/direct/`.

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

Дальнейший lifecycle выполняется отдельно локальным агентом согласно текущему Direct Postman workflow и repository policy.

## 11. Что transport не делает

Direct/Web Postman transport не должен:

- выбирать требования или архитектуру вместо внешней модели;
- менять пользовательское намерение;
- применять скачанный ZIP напрямую поверх repository без downstream workflow;
- выбирать artifact только по времени появления;
- выполнять содержимое ZIP;
- доверять model-provided routing metadata;
- делать blind resend, когда состояние предыдущего send неопределённо.

## 12. Production invariants

```text
one logical request
= one immutable request_id

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
