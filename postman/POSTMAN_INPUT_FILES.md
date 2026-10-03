# Postman input files: native-attachment-first

## Normal private flow

Native ChatGPT attachment is the primary input-file transport. Never publish a user/local input to GitHub merely so ChatGPT can read it when native attachment delivery is available. GitHub public staging is fallback-only and requires explicit user approval.

После `postman_task_prepare()` exact production/PTC Leader выбирает inputs через существующий `postman_input_files`:

- `stage(paths:[<explicit absolute regular files>])` — bounded one-time read → private snapshots → native descriptors/grants; **zero GitHub API calls**, без public consent. Source не изменяется; directories, symlinks, sensitive/runtime paths отвергаются.
- `stage_current_attachments(selectionIds?)` — exact latest human user/message этой live top-level Leader session → native `ctx.attachments.readImage` / `ctx.attachments.readFile` (если доступен) → length/SHA proof → temporary private source → private snapshots; **zero GitHub API calls**.
- `describe_existing(repository,commit,path)` — только AndrewVerhoturov1/dsh-workspace, exact immutable commit/path → один GitHub READ → private snapshot. GitHub — source provenance, delivery всё равно native.
- `cleanup(bundleId)` — только own private bundle; grants освобождают snapshots, повтор идемпотентен. Admitted pins удерживают bytes до child disposal. Нет GitHub cleanup writes.

Native descriptor: `{source_kind:"native",name,sha256,byte_length,media_type}`. Никаких repository/commit/path/raw_url, local absolute path, private snapshot path или secret Host handle. Existing-source descriptor: `{source_kind:"github",name,sha256,byte_length,media_type,repository,commit,path,raw_url?}`; legacy GitHub shape без source_kind/media_type продолжает нормализоваться, persisted requests не мигрируются. raw_url — legacy provenance, не инструкция внешнему Web скачивать inputs.

## Authority и current attachment limitations

PostmanInputGrants связывает serialized descriptor с exact private snapshot, exact Agent/session/task context. Bridge admission закрепляет opaque process-local pin и exact child. Fabricated/modified descriptors отвергаются; после restart authority не восстанавливается из model text или registry.

CurrentAttachmentStore хранит только metadata/handles последнего exact `role === "user"`, `source.kind === "user"`, same live top-level Agent `user/message` (Leader или standalone). Все non-text occurrences учитываются; unsupported generic occurrences имеют selectionId и capability status, но не resolver handle. Новый user message заменяет запись даже без вложений; system/subagent/synthetic/foreign session не дают authority. Plugin disposal удаляет store/listener.

Установленный SDK DSH 0.1.1-rc.2 имеет `AttachmentStore.readImage`, но **не generic attachment read API**. Current PNG / JPEG / WebP / GIF доступны; PDF, ZIP, DOCX и другие generic current files → `POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE` с объяснением capability. Host resolver не умеет его читать. Это не означает отсутствие пользовательского файла. Попроси explicit local path для `stage(paths)`; не угадывай local path, можно вызвать bounded `locate(filename)` (только metadata, workspace/Downloads/Desktop/Documents, depth≤3, до 2000 entries). При неоднозначности нужен выбор. Не превращай display name в path. Если Host предоставляет native `readFile`, generic bytes проходят ту же private SHA/length-bound staging цепочку.

Вызов: `postman_input_files({action:"stage_current_attachments",selectionIds:["<exact returned selectionId>"]})`.

Одна supported current image без других occurrences выбирается автоматически. Mixed image+PDF не превращается в одну image: без selectionIds → selection required с обеими occurrences; explicit image selection разрешена, explicit unsupported selection (даже вместе с image) → `POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE` до любых reads/staging. Несколько → `POSTMAN_INPUT_CURRENT_ATTACHMENT_SELECTION_REQUIRED` с compact occurrence metadata (`selectionId`,attachmentId,name?,mediaType,bytes,width,height), без byte reads. Передавай exact unique current selectionIds (1–20); duplicate → ARGUMENTS_INVALID, stale/wrong/foreign → CURRENT_ATTACHMENT_MISMATCH. SelectionId process-local, non-reused; content-addressed attachmentId может совпадать у разных occurrences и не является selector.

Host проверяет exact resolved length и canonical sha256 attachment ID, limits до reads, допустимое display name. Exact bytes — normalized stored Harness image, не model-request variant и не реконструированный original. Temporary source root удаляется после staging; snapshot root остаётся у grants. Private roots process/task/request scoped, bounded abandoned cleanup, 0700/0600 where applicable, paths не возвращаются модели.

## Leader ZIP operations

`postman_input_files({action:"pack",paths,destination})` упаковывает только явно выбранные regular files; `list(source)` и `unpack(source,destination)` используют общий bounded standard ZIP reader. Только absolute selected paths, без secrets/symlinks/junctions, overwrite и GitHub writes. Unpack — новая directory, traversal/ADS/collision/link/oversize/CRC rejection до выдачи результата.

## Request attachments

Standalone `@Postman`, `@PostmanAsk`, `@PostmanImage` с current image используют тот же no-argument `postman_send_current_turn()`: один exact text block сохраняется byte-for-byte рядом с attachment occurrences; exact live session + event seq связывают обе store записи. Host резервирует ход, выполняет существующий private stage/grant/pin и builder, не требуя Leader task context. Plain user text не получает authority через fabricated `--input-files-json`. Mixed/current capability status возвращается до Direct spawn и task publication; никакого GitHub staging, path guessing или generic resolver. Standalone task publication остаётся прежней. Selection snapshot/pin освобождаются после создания независимого request attachment, request root — на terminal.

Leader переносит descriptors без модификации в `--input-files-json <JSON>` сразу после trigger separator (или после `--chat <REQ>`), затем newline + exact intent. Ни Leader, ни Bridge child не строят attachments, не читают bytes моделью, не кодируют Base64 и не выполняют manual upload.

### @Postman / @PostmanAsk

После canonical REQ allocation Host строит один deterministic `POSTMAN_INPUT_<REQ>.zip`:

```text
POSTMAN_INPUT_MANIFEST.json
files/001-<safe-name>
files/002-<safe-name>
```

Manifest: protocol_version=1, request_id, file_count; per-entry index,archive_path,name,sha256,byte_length; source_kind/media_type если есть; repository/commit/path только для настоящего GitHub source. Нет raw_url или private paths. Exact inventory/order, no traversal/directories/symlinks/encryption, every hash/length, strict manifest, outer ZIP SHA; request ZIP строится из snapshot, исходный pathname не перечитывается.

Host-created `-InputBundleManifest` handoff связывает exact REQ, descriptor-set digest, count и attachment path/name/SHA/length. Direct проверяет regular/non-symlink files, metadata и outer hash до browser. Browser повторно проверяет bytes непосредственно перед `set_input_files(FilePayload)`, не передаёт pathname. Task contract требует attached ZIP/manifest как source of truth, не скачивание inputs с GitHub. Artifact result и TEXT_RESULT_DURABLE contracts неизменны.

### @PostmanImage

Visual references are native image attachments whenever Host can resolve their bytes. 1–7 PNG/JPEG/WebP/GIF references → тот же grant/pin → `POSTMAN_REFERENCE_<REQ>.<ext>` и private handoff, без input ZIP. Host проверяет exact snapshot SHA/length, magic/media type и decoder; bytes не перекодируются. Image prompt короткий: приложенное изображение как visual reference + exact user intent + ровно одно изображение; без raw_url, GitHub coordinates или внутренних hashes/IDs.

Восемь references → `POSTMAN_INPUT_IMAGE_REFERENCE_COUNT_UNSUPPORTED`; ordinary non-image input → `POSTMAN_INPUT_IMAGE_REFERENCE_TYPE_UNSUPPORTED`. Multi-upload одним FilePayload list требует точных ready cards и полного exact sent set; не публикуй fallback. Generation → IMAGE_TURN_COMPLETED → прежний отдельный packaging Send в том же чате → verified result ZIP → IMAGE_RESULT_DURABLE; упаковка и result ZIP contract не меняются.

## Exact Send proof

Empty owned composer, один eligible file input, ready exact request filename/card, no pending/error → native FilePayload → exact prompt fill → fresh attachment re-proof → one Send. Затем exact full prompt + exact attachment membership в одном новом user turn + empty composer + bound chat URL + 0→1 count = PROVEN_SENT.

Image selectors ограничены composer attachments / exact sent user-message unit; никакого body-wide image search, OCR, fuzzy filename или DOM pixel hash. ZIP proof остаётся прежним. Если DOM даёт file ID до/после, он должен совпасть; remote byte hash DOM не раскрывает — identity обеспечивается проверенным FilePayload, one-owned-upload и request-scoped exact name. Filename только data, не interpolated CSS. Unknown markup fail-closed.

Host build/handoff/upload/pre-Send failures → PROVEN_NOT_SENT. После possible click uncertain card/prompt → UNKNOWN, **no blind resend/reupload**. Reminders/recovery/deadlines, #305 generated-image identity и #308 collapsed prompt proof не меняются. Без inputs flow прежний. --chat inputs explicit, без inheritance; image manual --chat поддержан.

Limits: 20 logical inputs, 48 MiB/file, 144 MiB aggregate, 150 MiB ZIP. Ничего не обрезается.

## Legacy public fallback

Normal tool не содержит public-stage action и никогда не вызывает publisher. Старый safe publisher сохранён лишь как отдельная manual fallback CLI: `--stage-public-fallback <paths> --public-fallback-confirmed`; без explicit confirmation `POSTMAN_INPUT_PUBLIC_APPROVAL_REQUIRED` до любых GitHub calls. Это отдельное явное user approval public publication при технически недоступной native delivery, не автоматический retry. Legacy cleanup — `--cleanup-public-fallback <bundle>`; non-force commit удаляет current entries, **не стирает Git history**. Transport branch не merge-ится. Task.md publication через SHA-pinned URL не относится к input bytes и остаётся прежней.

## Cleanup и проверки

Private selection snapshots освобождаются cleanup/release/context replacement/dispose; pins удерживают их до disposal. Direct удаляет request attachment/handoff best-effort после browser lifecycle, Host убирает request root на terminal/spawn failure. Cleanup не меняет доказанный Send outcome.

Controlled tests покрывают private local/current stages без GitHub writes, existing immutable source, ZIP/native Send в Postman/Ask, image generation + real submit/observer helpers + one packaging Send + IMAGE_RESULT_DURABLE, exact card/prompt negatives и UNKNOWN/no-resend. Живой ChatGPT Web для этой реализации не запускался; acceptance отдельно по разрешению пользователя.
