# Проверки упрощения Postman

## Изменения

- Recovery: доказанный failed REQ, exact same-chat lookup, одна durable попытка до публикации/Send. Ask сохраняет text envelope; Image поддерживает existing chat и generation/packaging-only recovery с read-only proof исходного image assistant.
- Reminders: абсолютные 10/20/30/40/50 минут, без WORKING-only/streaming-text gates; exact user/composer ownership и UNKNOWN STOP сохранены. Connection: один best-effort reload на непрерывный banner.
- Downloads: transfer вне global lock, короткие CDP mutation locks, browser-wide GUID directory, exact page/request/event proof и один click. ZIP: стандартный bounded Python zipfile, общий reader для validation/image extraction/Leader unpack.
- Inputs: 48 MiB/file, 144 MiB aggregate, 150 MiB input ZIP, bounded metadata locate, selected pack/list/unpack в существующем Leader tool, 1–7 native image refs. Generic current files проходят private staging только при наличии настоящего Host readFile.
- Leader: read_image по усмотрению, existing/new Worker choice; exact addressed Worker stop без approval/reason, без rollback/Git cleanup и влияния на peers.
- External author: 7 коротких разделов вместо 423 строк.

## Удалено

- system_recovery.py и активная Additional Processing цепочка Stop/reload/wait/continue.
- CONNECTION_WAITING и consume-reminder recovery paths, прежний terminal whitelist и budget двух automatic continuations.
- Запрет Image --chat, ограничение одним reference, full-transfer download lock, bespoke JS ZIP parser и ratio hard gate.

## Первоначальные проверки (до доводки #334)

- Web Python: полный прогон 431 tests, OK, 1 skipped (opt-in live CDP). После последних изменений: observer 75/75, bridge 17/17, reminders 21/21 PASS. Это отдельные прогоны, не суммируются.
- Direct Python: полный прогон 114 tests, OK, 1 skipped. После последних изменений Direct 29/29, Ask 9/9, archive 3/3 PASS.
- Web Node: 20/20 PASS.
- Host Node: полный прогон 433 tests, 426 PASS / 7 FAIL. Устаревший documentation assertion исправлен и его suite 12/12 PASS. Оставшиеся 6 failures в postman-worker-n2.test.js и postman-worker-real-cycle.test.js воспроизведены на неизменной базе 9cf51799a312da337c557494703e2c8791a46b44: установленный SDK отвергает context-global tools.restrict(). Не заявляется общий Host PASS.
- Host targeted: 100/100 PASS; после финального multi-image handoff исправления native-current/input suites 31/31 PASS, включая реальный private builder с 2 и 7 refs и available generic readFile adapter.
- git diff --check PASS.

## Первоначальный браузерный тест / ограничения до доводки

- Opt-in CDP test: PASS на изолированном headless Chrome и local HTTP, без ChatGPT и рабочего browser profile. 5 attach/detach download cycles, затем 4 overlapping transfers; one click each, 61558 bytes each, SHA-256 21013655f6e464e8fcf3b7dae8d7a2c859fac4f2c4ae2bc3a8757a29933242a6; overlap 0.5405272000352852 s.
- Failed sent recovery, one-shot budget, Ask, Image generation/packaging-only, reminders, 7 image refs: covered by deterministic unit/integration test; live trigger unavailable. Не заявляется live ChatGPT E2E.
- Установленный SDK предоставляет image-only readImage, не generic readFile. Generic current files в этой установке остаются capability-unavailable; private adapter проверен с доступным native readFile. Это внешнее ограничение, а не доказанная работа generic attachments в установленном runtime.
- Shared GUID download directory сохраняется; автоматическая уборка abandoned GUID files не добавлялась.
- Первоначальная реализация: только task worktree, без merge/deploy/permanent runtime edits.

## Доводка существующего PR #334 — 2026-10-03

### Подключение recovery и policy

- Exact API: `postman_bridge_status({bridge_job_id})` возвращает `recoveryEligible`; Leader выбирает `postman_bridge_status({bridge_job_id, recover:true})`. Host читает существующий Python `resolve_chat_reference / can_continue_request` из trusted Direct/worker files и запускает прежний `DirectPostmanJobManager.continueLast` на owned terminal. Ни prompt, ни trusted state Leader не передаёт; recovery child не принимает retry-решение и новый Bridge child не создаётся. Новый Bridge job сохраняет mode/branch и обычные READY/status/sync/grant paths.
- Direct повторно проверяет exact conversation, PROVEN_SENT или допустимый exact read-only UNKNOWN reproof, no unresolved UNKNOWN/no Web or durable result. Существующий `claim_recovery` эксклюзивно создаёт/fsync-ит `recovery-<rootREQ>.claim` до publication/Send; вторая automatic попытка запрещена, включая restart. PROVEN_NOT_SENT и local/download failure после Web result не дают continuation. Никаких новых framework/state machine/locks.
- Удалены Leader hard violations повторного Worker при mapping, stop до report/без специальных причин, смены стратегии и создания нового Worker вместо continuation. `createNew:true` допускается при existing mapping/idle/report и свободном слоте; max 3/shared-worktree restrictions сохранены. Exact addressed stop — без rollback/Git cleanup/peer stop.
- Artifact skill: удалено «не повод продолжать автоматически»; Ask: безусловный transport-failure STOP заменён capability-правилом. Image skill прочитан, противоположного правила не найдено — не переписан.
- Live Image открыл конкретные regressions: list reference name в Path, blank preview ID list вместо unavailable IDs, multi-image cleanup expecting single path, CLI import общего ZIP reader. Исправлены только эти строки + regression tests. safe_zip/reminders/download architecture не менялась. Reminder docs assertion исправлен на существующее «50 уникальных русских стартовых фраз».

### Generic current attachments: BLOCKED / НЕ ВЫПОЛНЕНО в установленном runtime

- Exact installed evidence root: `C:/Users/Andrew/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`. `dsh-attachment/package.json:4`: **0.1.1-rc.2**. `dsh-attachment/lib/types/index.d.ts:49–65`: saveImage/readImage/readImageRequest, generic API отсутствует. `dsh-attachment-local/lib/index.js:868–871` реализует readImage/readImageRequest. `dsh-llm/lib/types/types.d.ts:79–85` ContentBlockMap = text/reasoning/image/tool-call/tool-result, без file. Другого штатного generic API/file handle/current-message bytes в этой версии не найдено.
- npm registry проверен: next **0.2.0-rc.2**, alpha **0.2.1-alpha.1**. Оба tarball только распакованы в TEMP. Их `lib/types/index.d.ts:97–121`: saveFile/saveFileStream/**readFileStream**, fileHostPath — НЕ readFile. Exact API `readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array>`; ref = attachmentId/name/bytes, без mediaType.
- Подключение одного адаптера не создаст отсутствующие generic ingress/storage/current-message authority в старом SDK. Для фактической работы необходим связанный Host/SDK update, запрещённый этой задачей; permanent runtime не обновлён. Второй framework, filename/path guessing и GitHub byte publication не добавлены. Прежний available-readFile adapter test НЕ доказывает PDF/ZIP/DOCX/TXT в installed runtime и не считается runtime PASS.

### Проверки доводки (локальные, не CI)

- Public Leader/Bridge API + real Python resolver/claim: **56/56 PASS** (combined Bridge/Direct), включая artifact/Ask/Image, new REQ/mode/no original prompt, negative Send/result cases, exact UNKNOWN reproof, second attempt/restart durable claim. Policy/composition **12/12 PASS**.
- Финальный Direct Python **116 tests, OK, 1 skipped** (115 passed); Web Python **435 tests, OK, 1 skipped** (434 passed); Web Node **20/20 PASS**. Targeted после live fixes: Direct **30/30**, extraction **8/8**, input **17/17**. Пересекающиеся прогоны не суммируются.
- Финальный relevant Host/Bridge/Harness/input/Worker **151/151 PASS**: `node --test lib/postman-bridge*.test.js lib/direct-current-turn.test.js lib/postman-input*.test.js lib/web-worker-bridge*.test.js lib/postman-worker-core.test.js lib/postman-worker-n1.test.js lib/postman-worker-fix-s1.test.js`.
- Широкий Host **444 tests, 437 PASS / 7 FAIL**, НЕ общий PASS. Шесть SDK failures снова воспроизведены на unchanged base **9cf51799a312da337c557494703e2c8791a46b44** (6/6 FAIL; context-global tools.restrict требует agent.ctx). Седьмой concurrent failure — journal timing; отдельно **9/9 PASS**, final relevant PASS. В sequential broad run седьмой — Windows **ENOTEMPTY** при test TEMP cleanup в unchanged postman-task-registry.test.js; отдельно **5/6**, на base **6/6**. Это не объявляется baseline failure и не скрывается; unrelated cleanup не менялся. CI successful не заявляется.
- `git diff --check` PASS. Временные live task files убраны из итогового tree обычным commit; SHA-pinned historical links сохраняются.

### Dedicated Chrome / живой ChatGPT

Существующий dedicated Chrome `http://127.0.0.1:9222`, profile `C:/Users/Andrew/AppData/Local/DSH/Postman/browser-profile`; без изменения runtime/настроек/плагинов. Temporary runners/Direct roots/results вне Git, собственные Pages, synthetic benign intents. Task publication только в этой #334 branch; reference bytes private, не GitHub.

| Сценарий | Реальный исход |
|---|---|
| Normal Postman `REQ_20261003T191200Z_3345` | RESULT_DURABLE, ZIP SHA `cbefdb2b0038fe6b5ac00a6db61d9896b9e73d61c69cff4551bda80be495a9a0` |
| Normal Ask `REQ_20261003T191000Z_3343` | TEXT_RESULT_DURABLE, exact POSTMAN_ASK_334_OK, 18 bytes, SHA `c804769f2c404754e544fdb02a345ad918b717cdd1270a557f170a7b58e1a97f` |
| Image + 2 private refs `REQ_20261003T191500Z_3348` | IMAGE_RESULT_DURABLE, PNG 1254×1254, 637080 bytes, SHA `2a1217c12c164eac10ededf269d02ce84862084623b29de4c2a015f2c5d22345` |
| Manual Image --chat `REQ_20261003T191300Z_3346` | Exact Ask `/c/6ac16d97-5370-83ed-9bc5-f08d9ef6a0a0`: generation/packaging/validated Web ZIP success. Initial CLI extraction failed; после import fix **только local finish, NO new Send/download** → IMAGE_RESULT_DURABLE, SHA `460fa2ab4fe44d677e8edfdc9e7cd1aca36eb04b7fb8e1660d9d7093a991f9c8`. Не clean first-run CLI PASS. |

Controlled recovery: temporary one-shot fault на existing WebWorkerBridge._write_state(PROMPT_SENT), после сохранения actual Send proof, до detection/download/durable result.
- Initial **REQ_20261003T190100Z_3342** → PROVEN_SENT → POSTMAN_TRANSPORT_FAILED / BRIDGE_PIPELINE_FAILED / CONTROLLED_POST_PROVEN_SENT_FAILURE.
- Isolated real Host public API получил recorded actual terminal и actual Direct files → recoveryEligible:true → recover:true → **один** Direct child/recovery Send → **REQ_20261003T210144Z_9702** → RESULT_DURABLE.
- Same exact `https://chatgpt.com/c/6ac16cc8-36a0-83ed-a3fa-2730f48627d1`. Read-only live DOM: **ровно 2 user bubbles**, initial pinned URL и recovery pinned URL. Recovery User intent: «Продолжи исходную незавершённую задачу с текущего места и доведи её до готового результата.» Original task/prompt/URL не повторены. Actual claim связывает root 3342 с new 9702. Second API → **POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED**, child counter остался 1. Production artifact grant отдельно принят на том же ZIP без Send.
- Recovery ZIP SHA `348cc887df31cc0b5ccd79ac7aee6d64fe59e5be02fdd2b4317d5339dabcd5c3`. Detailed states/claim/results/leader-live.json в `C:/Users/Andrew/AppData/Local/Temp/postman-334-live/`; новых reports в repo нет.
- Отсутствие Web artifact именно в момент более позднего recovery Send отдельно live не перепроверялось; controlled fault доказывает failure до result detection/durability. Запрет recovery по уже известному Web/durable result проверен targeted negative cases, не отдельным live сценарием.
- Live ограничение: Direct/Web/browser/claim реальные, но Leader/initial Bridge terminal delivery — isolated Host fixture, не permanent GUI Leader. Spawn adapter связал temporary roots и существующую #334 branch; fault hook только temporary. Fixture без grants дал separate grant diagnostic; настоящий grant принят отдельным read-only local test.
- Неуспешные попытки не PASS: первый temporary fault hook повторно сработал при error persistence; исправлен только fixture и использован новый independent REQ. Первый two-ref REQ был PROVEN_NOT_SENT. `REQ_20261003T191400Z_3347` дал UNKNOWN из-за blank preview IDs — **не resubmit/recovery**, composer после possible Send не очищался. После tiny fix отдельный новый user intent/new REQ 3348 прошёл.

### Не проверено / не выполнено

- Generic PDF/ZIP/DOCX/TXT current runtime — BLOCKED, не PASS. Live failed Ask recovery, Image automatic generation/packaging-only recovery, 7 refs, reminder/reload episodes и restart permanent Leader — deterministic tests only. Full Host/remote CI green не достигнут; ENOTEMPTY указан выше. Merge/deploy/permanent runtime updates не выполнялись.

### Changed files / Git

Доводка относительно `c276f02bcdb3a7a3cded0db3583698913a32c1e3`: три skills (Image прочитан, не изменён); direct-current-turn.js, postman-bridge.js/postman-bridge-jobs.js, два Bridge теста; POSTMAN_BRIDGE_FLOW.md и этот отчёт; chat_reference.py/postman_direct.py/image_result.py/Direct regression test; input_attachment.py/input regression test/reminder docs assertion. Новых tracked файлов/framework/locks нет.
Repository `AndrewVerhoturov1/dsh-workspace`; existing [PR #334](https://github.com/AndrewVerhoturov1/dsh-workspace/pull/334), branch `task/postman-simplification-recovery-inputs-20261003`, base `preview`; exact task/base SHA `9cf51799a312da337c557494703e2c8791a46b44`. Final local/remote HEAD и PR state проверяются после push и сообщаются в итоговом ответе.

