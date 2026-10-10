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

## Наблюдение / физическое сохранение / verified result / применение

Artifact UNKNOWN разрешает только ограниченное read-only наблюдение exact принадлежащей Page conversation. Weak count/text/composer/card не повышают UNKNOWN, reminders/recovery/automatic continuation запрещены. Fresh genuinely empty owned chat сохраняет strict verified путь; TEXT/IMAGE не получают unchecked candidate success.

Один native файл конкретного наблюдаемого answer можно сохранить без идеального envelope/REQ/имени. Несколько дают до восьми choices без click; global latest ZIP и arbitrary external URL не выбираются. Descriptor `candidate`: actual path/byteLength/SHA, originalFilename, completeness, reasons/provenance, `verified=false`, `applyEligible=false`. Fixed raw path: `direct/candidates/<REQ>/capture.bin`, original filename не используется как путь.

Wrong native name, доступные partial bytes, validator rejection/exception сохраняются с причиной, без unpack/open/execute. Raw save bounded 50 MiB; если native API не отдаёт partial path, это explicit evidence limit. Cold physical observation читает только owned fixed path (`capture.bin`, либо прежний request-scoped `results/<REQ>/result.zip`) и actual hash отдельно от strict ownership receipt; legacy `completeness=complete` описывает лишь все доступные on-disk bytes, а не полноту native download, и всегда сопровождается `LEGACY_FILE_COMPLETENESS_UNVERIFIED`; branchless/inconsistent receipt не чинится/не повышается. Sync failure не скрывает bytes/path/SHA, retrySync local-only, grant subordinate to verified ownership+sync и hash rechecks. Missing input post-Send proof оставляет `RESULT_MAY_LACK_INPUT_ATTACHMENT` до человеческого выбора.

## 4. Correlated assistant turn

Artifact принимается только из assistant turn, который доказан как ответ на разрешённый
user anchor exact текущего request. Разрешённый anchor — первоначальный Postman prompt
или служебное напоминание Direct Postman с тем же trusted `requestId`.

Для одного REQ допускается до пяти ordinary reminders по абсолютному расписанию
10/20/30/40/50 минут. Natural control message выбирается случайно из 50 русских фраз,
не содержит visible REQ/control metadata и не меняет исходный semantic intent.
Trusted intent до Send сохраняет request/conversation, templateId, exact text/hash и
user-turn relation; после Send exact count/text/prefix/URL закрепляют ordinal/groupKey.
Result correlation натурального anchor требует этого internal proof и original REQ lineage.
Перед каждым reminder transport обязан повторно проверить уже разрешённые assistant turns
этого REQ; найденный exact RESULT отменяет reminder. Завершённый turn без ZIP получает одну
контрольную повторную проверку через 10 секунд. Если exact ZIP всё ещё отсутствует, current
REQ завершается `ASSISTANT_COMPLETED_NO_ARTIFACT` с полным assistant text. Если текст turn
изменился, требуется свежий completion proof и новое 10-секундное окно.

Видимое состояние `Соединение прервано` / `Connection interrupted` не является completion.
В этом состоянии reminders блокируются; transport может reload-ить только ту же exact
conversation Page, после доказанной загрузки выдерживает ещё 10 секунд стабилизации и
заново выполняет correlation/artifact proof. Reload не создаёт новый REQ и не сбрасывает
60-минутный soft deadline. Только уже начатый recovery получает один cycle с hard limit soft+45s.
Additional Processing запускает Stop-if-present→Reload→Same-chat/original-lineage re-proof→
random wait 10–17s→natural Continue с exact Send proof. Одно непрерывное появление banner = один event;
исчезновение rearm-ит detector. Recovery consume-ит наступившие pending slots, очередь не догоняется.
Если ZIP не проходит minimal transport validation, физически сохранённые raw bytes не удаляются: unverified candidate содержит точную причину. `ARTIFACT_REJECTED` — validation fact, не grant/apply authority. Решение о continuation принадлежит локальной LLM; сам REQ не ждёт следующего
reminder после завершённого assistant-turn. Ошибки самого validator infrastructure, записи,
скачивания и другие внутренние ошибки остаются transport failure. Произвольный новый user turn
разрешённым anchor не является.

Финальный assistant turn должен содержать единственный envelope из трёх последовательных
непустых строк; обычный текст или отдельная SHA-256 строка вне него допускаются:

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
- последний ZIP на странице не выбирается по принципу «самый свежий» без correlation proof;
- повторные полные markers, competing markers другого REQ и повторное exact имя файла
  не допускаются; неполный prefix вне корректного envelope не заменяет полный marker.

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
`manifest.json` также необязателен и полностью informational для normal transport.
Ни `requestId`, ни `protocolVersion`, ни `repository`, `baseCommit`, `resultType`, `patch` или
`files` внутри manifest не являются transport hard gates. Trusted REQ identity доказывается
browser correlation и exact expected filename до скачивания.

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

Browser `suggestedFilename` должен совпадать с canonical expected filename либо содержать
только наблюдавшееся безопасное украшение `<expected> _SHA256_ <64 hex>_`
(пробелы/табуляции допустимы только между именем, `_SHA256_` и digest).
Visible control label и request-scoped staging filename остаются exact. Реальная suggestion
сохраняется в metadata; digest в её суффиксе не является authority или доказательством bytes.
SHA-256 вычисляется по физическому source и staging, затем проверяется ZIP validator.
Не следует добавлять SHA к имени ZIP или заголовку ссылки.

`manifest.json` не является authority для repository/application decisions. Malformed,
non-object или отсутствующий manifest не превращает безопасно скачанный ZIP в transport failure.

## 7. Path safety

Каждый archive entry остаётся subject to structural path-safety validation независимо от
содержимого или назначения результата.

Minimal validator отклоняет только очевидно опасные structural paths:

- absolute paths;
- Windows drive paths;
- UNC paths;
- `..` traversal;
- symlink entries.

Более строгая platform-specific policy (ADS/reserved names/case/Unicode collisions и т. п.)
не является normal Postman transport gate и при необходимости выполняется downstream.

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
сообщается пользователю и поток останавливается. Repository-changing result может быть обработан только после отдельного решения локального агента по текущей repository policy.

Для implementation package ChatGPT Web готовит декларативный ZIP по `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`: `manifest.json`, Git-generated `changes.patch`, `README.md`, `TEST_PLAN.md`, необходимые targeted tests и, если новые repository-owned файлы иначе игнорируются Git, узкое исключение `.gitignore` в том же patch. Transport не проверяет эти package-specific требования: trusted `RESULT_DURABLE` доказывает происхождение и целостность ZIP, но не пригодность его к применению.

На downstream boundary trusted `RESULT_DURABLE` доказывает происхождение и целостность exact ZIP. После этого Host может сохранить его вместе с SHA-256 как process-local trusted artifact для точной сессии Leader и REQ. Sol отдельно решает использовать этот REQ через `postman_worker({task, artifactRequestId})`; Worker не получает model-authored filesystem path. При вызове `implementation_artifact_apply({requestId, worktree})` Host разрешает REQ в сохранённый ZIP, повторно проверяет SHA-256 и передаёт его существующему repository runner. Это не требование к universal ZIP иметь manifest или implementation schema, не автоматическое применение и не merge.

## 11. Что transport не делает

Direct/Web Postman transport не должен:

- выбирать требования или архитектуру вместо Sol и внешней модели в пределах их ответственности;
- менять пользовательское намерение;
- применять скачанный ZIP напрямую поверх repository без downstream workflow;
- выбирать artifact только по времени появления;
- выполнять содержимое ZIP;
- доверять model-provided routing metadata;
- делать blind resend, когда состояние предыдущего send неопределённо.

Natural reminder или special recovery continuation не является blind resend исходной задачи:
это internally correlated transport control того же REQ без технических заголовков в чате.
Для результата отправки допускаются только доказанные состояния: `PROVEN_SENT` продолжает
цикл, `PROVEN_NOT_SENT` продолжает его лишь после безопасной очистки поля, а `UNKNOWN`
немедленно завершает REQ без следующего напоминания.

## 12. Production invariants

```text
one logical request
= one immutable request_id
+ zero to five authorized ordinary reminder turns
+ internally correlated system recovery continuation turns

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
