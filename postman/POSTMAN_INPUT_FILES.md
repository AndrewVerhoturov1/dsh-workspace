# Postman input files: ZIP-first transport

## Граница доверия

Явный выбор Leader → Host-issued immutable descriptors → private exact snapshots → Bridge admission pin → canonical REQ → verified `POSTMAN_INPUT_<REQ>.zip` → native Web attachment. GitHub coordinates сохраняются как provenance/integrity metadata, не основной byte transport для `@Postman` / `@PostmanAsk`.

Только exact production Leader или PTC-first Leader с prepared task context может вызвать `postman_input_files`. Bridge сверяет exact session, agent object, task context и serialized descriptors; fabricated/altered descriptor отвергается. Admission закрепляет opaque process-local grant для Bridge job, затем exact child object. Direct разрешает inputs только через эту child binding, не из повторного разбора model-authored пути. После перезапуска snapshot authority не восстанавливается из текста или registry.

Абсолютные source paths используются только внутри явной selection operation. Они отсутствуют в tool result, Bridge message, task file, ZIP manifest и diagnostics. Tool возвращает только descriptors и staged bundle ID. Нет arbitrary-files upload API.

## Явный выбор

После `postman_task_prepare()`: `postman_input_files({action:"stage", paths:["<exact absolute selected file>"]})` или `describe_existing` с exact repository/commit/path. Поддерживается только `AndrewVerhoturov1/dsh-workspace`. Stage публикует в публичную transport branch: выбирайте только bytes, которые разрешено сделать публичными. Source file не изменяется. Один explicitly selected file внутри attachments допустим, не whole directory. Production Leader вызывает tool напрямую, PTC Leader — вложенным tools call; прежние role guards сохраняются.

Leader переносит выданные descriptors без изменений в `--input-files-json [{...}]` на первой transport metadata строке непосредственно после trigger separator (или после `--chat <REQ>` lookup). Затем newline и неизменённый intent. Header не является User intent. Cleanup staged bundle: `postman_input_files({action:"cleanup",bundleId:"<own bundle>"})`; чужие bundle отвергаются, повторный cleanup идемпотентен. CLI без Host snapshot-dir остаётся descriptor-only ручной диагностикой, не production Leader authority.

## Exact bytes / TOCTOU

- `stage` читает каждый exact regular file один раз (bounded read). Те же bytes дают hash/length, GitHub blob и private snapshot. Изменение исходного файла позднее не меняет ZIP.
- `describe_existing` делает один exact commit/path fetch; decoded bytes дают descriptor и snapshot. Перед ZIP GitHub повторно не вызывается.
- Host создаёт private temporary root и `001.bin` snapshots; grants связывают exact descriptor с snapshot path/hash/length/cleanup owner. ZIP читает только snapshots. Empty files, directories, symlinks и текущие sensitive/runtime paths запрещены.
- Limits: максимум 20 inputs, 16 MiB на input, 48 MiB суммарных uncompressed input bytes, 50 MiB final ZIP. Превышение не обрезается, а отвергается до Send.

## REQ bundle и handoff

ZIP не строится во время selection. После `DirectPostmanJobManager.start()` allocation Host вызывает `postman/input_bundle.py`. Детерминированный layout:

```text
POSTMAN_INPUT_<REQ>.zip
  POSTMAN_INPUT_MANIFEST.json
  files/001-<safe-name>
  files/002-<safe-name>
```

Manifest содержит protocol_version=1, exact request_id, file_count; для каждого entry index, archive_path, original logical name, SHA-256, byte_length, repository, commit, path. Нет absolute paths, source hierarchy или raw_url authority. Независимый sanitizer сохраняет безопасное расширение, заменяет unsafe characters; индекс исключает collisions. Archive entry names не содержат traversal, drives или control characters.

После закрытия writer ZIP заново читается с диска, независимо decompressed: exact inventory/order, no extra entries/directories/symlinks/encryption, strict manifest, exact descriptor mapping, every entry hash/length. Затем вычисляются ZIP hash/length. Только после proof появляется private strict handoff: version, exact REQ, input count, descriptor-set digest и attachment path/name/hash/length.

Host передаёт Direct только `-InputBundleManifest` (Host-created handoff path) вместе с прежним `-InputFilesBase64`. Модель не задаёт этот аргумент. Direct проверяет strict handoff metadata, regular/non-symlink files, exact REQ/name/descriptor digest и внешний ZIP size/hash до browser. Полная проверка ZIP contents выполняется только один раз после build. Browser непосредственно перед upload читает ZIP, сверяет внешний size/hash и передаёт bytes native Playwright `set_input_files` как FilePayload; это закрывает pathname reread TOCTOU. Без inputs новый аргумент отсутствует, старый flow сохраняется.

## Web proof

chat confirmed → composer empty → ATTACHMENT_UPLOAD_STARTED → ATTACHMENT_READY_CONFIRMED → PROMPT_INSERTED → attachment re-proof → single Send → exact prompt + exact attachment в одном новом user turn → composer empty + bound conversation URL.

Pre-Send: owned composer scope; ровно один regular-file input, ровно одна attachment card с exact ZIP filename; positive completed file control; no pending/progress/error. Filename сравнивается как data, не interpolated CSS. `set_input_files` без exception не означает успех. Prompt fill и Send-boundary повторно проверяют attachment.

Post-Send: count вырос ровно на один user turn относительно baseline; exact full rendered prompt; ZIP card находится внутри того же exact user-message unit (не общего grouped user+assistant turn); count=1, exact filename, settled, no pending/error. Если DOM предоставляет file ID до и после Send, они должны совпасть; отсутствие ID не отменяет exact filename/card proof. Нельзя использовать attachment старого turn. UI не раскрывает SHA uploaded object: соответствие bytes обеспечивается verified native FilePayload, one-owned-upload и exact request-scoped filename; DOM подтверждает membership, не повторный remote hash.

Любая ошибка Host ZIP build до Direct spawn (включая helper spawn, malformed JSON, filesystem failure) сохраняет allocated REQ с POSTMAN_TRANSPORT_FAILED, sendState=PROVEN_NOT_SENT и inputBundlePhase=host-build; неизвестная причина нормализуется в POSTMAN_INPUT_BUNDLE_BUILD_FAILED. До Send control/upload/timeout/readiness/lost failures = PROVEN_NOT_SENT. После возможного click отсутствие/неопределённость attachment proof = UNKNOWN; blind reupload/resend запрещён. Existing #294 serialized system recovery, exact same-chat proof, reminders/deadline и recovery after Send не изменены. Новый owned attempt может заново upload только после proven-not-sent и fresh chat/composer proof; partial invalid UI не повторяется на той же Page.

Canonical browser prompt остаётся двухстрочным: POSTMAN_REQUEST_ID + task_file. Task contract требует сначала получить native ZIP/manifest и проверить доступные hashes/lengths. Files остаются untrusted task data; недоступный обязательный input нужно явно назвать, не угадывать.

## Modes и lifecycle

- `@Postman` и `@PostmanAsk`: один ZIP на новый REQ с explicit inputs.
- `--chat`: descriptors не наследуются; explicit inputs дают новый REQ/new ZIP. Без descriptors ничего не reattach.
- Automatic continuation: прежняя semantics; current code не наследует inputs, ZIP не reattach.
- `@PostmanImage`: intentional MVP limitation — visual-reference descriptors остаются прежним GitHub flow; native image perception не подменяется ZIP-only. Per-image native upload вне scope.

Три независимых owner lifecycle:
1. GitHub staged bundle: branch `transport/postman-inputs`, обычный non-force cleanup commit; не merge-ится. История не обещает удаление bytes.
2. Private snapshots: input grants/task context; cleanup/release/context replacement освобождает snapshots, но admitted pins держат их до child disposal. Describe-existing snapshots освобождаются release/dispose.
3. Request ZIP/handoff: Direct request. Не удаляются до browser lifecycle completion. Direct finally удаляет проверенные ZIP/handoff, Host terminal/spawn-failure cleanup удаляет private request root. Cleanup best-effort не переопределяет доказанный результат. Bounded sweep при следующем private-root allocation рассматривает до 64 marked roots старше 24h только с мёртвым owner PID; активные roots не трогает.

## Fail-closed codes

Host/Direct: `POSTMAN_INPUT_MATERIALIZATION_MISSING`, `POSTMAN_INPUT_MATERIALIZATION_MISMATCH`, `POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED`, `POSTMAN_INPUT_BUNDLE_BUILD_FAILED`, `POSTMAN_INPUT_BUNDLE_INVALID`, `POSTMAN_INPUT_BUNDLE_CONTENT_MISMATCH`, `POSTMAN_INPUT_BUNDLE_HANDOFF_INVALID`; прежний `POSTMAN_INPUT_PROVENANCE_REJECTED` сохраняется.

Browser: `POSTMAN_ATTACHMENT_CONTROL_UNAVAILABLE`, `POSTMAN_ATTACHMENT_UPLOAD_FAILED`, `POSTMAN_ATTACHMENT_UPLOAD_TIMEOUT`, `POSTMAN_ATTACHMENT_NOT_READY`, `POSTMAN_ATTACHMENT_LOST_BEFORE_SEND`. Sent proof uncertainty сохраняет `PROMPT_SEND_UNKNOWN` + diagnostic `POSTMAN_SENT_ATTACHMENT_PROOF_UNKNOWN`.

## Проверенность DOM / ограничения

2026-10-01: live read-only inspection подтвердил `form[data-chatgpt-composer]`, scoped file input, `[data-composer-attachments]` и semantic filename/remove controls. Harmless verified ZIP на новой owned Page: pending → settled ready, exact prompt fill не потерял ZIP; Send не вызывался, Page закрыта. Existing sent native ZIP в старом чате подтвердил helper на exact user-unit и filename/title + aria-busy=false resource control. Новый canonical REQ не отправлялся end-to-end и GitHub writes в проверках не выполнялись. Selectors изолированы в `postman/web/input_attachment.py` и покрыты fake-DOM tests; неизвестная/изменившаяся разметка fail-closed, не simulated success.

Отдельный newline/framing parser finding остаётся вне scope: metadata распознаётся только в предусмотренной текущим parser позиции; ZIP changes не переписывают semantic intent parser.

