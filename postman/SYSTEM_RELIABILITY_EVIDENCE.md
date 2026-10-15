# System reliability A–D — проверка исходников

Дата: 2026-10-14. Task base/HEAD: `eb5a3f37333c7bf5a5895dff2d25cf7e2f4e58ba`. Работа остаётся в исходном task worktree; commit/push/PR, установка и перезапуск активного Host не выполнялись. Это локальная проверка controlled native SDK/QuickJS, не заявление об обновлении production GUI.

## A — только содержательные пробуждения

- Технический bootstrap — только exact `POSTMAN_LUNA_BOOTSTRAP_ACK`; произвольный текст, ошибка, вопрос и `NEEDS_PARENT_GUIDANCE` не подавляются.
- Native `notifySettlement` вызывается после удаления Agent и Session из live registries. Host запоминает exact зарегистрированный Agent через `agent/created`, затем заново проверяет parent/task/lane/job, единственный bootstrap turn и completed terminal. Копия Agent с тем же ID не подходит.
- `postman-native-bootstrap.test.js`: production predicates, настоящий native disposal, варианты report+settled и text-only settled — 2 PASS; все исходные inbox facts сохранены, READY даёт ровно один request.
- `postman-worker-real-cycle.test.js`: 9 PASS. Single final report: 3 → 2 parent requests; multiworker delayed settlement: 5 → 4; конфликтный output остаётся 5. Оригинальные report/settled сохранены. Waiting-only PTC — 0 в single и text-defer fixture; обычный multiworker synthetic plan намеренно содержит wait (см. точные счётчики ниже), поэтому общий ноль не заявляется.
- До инцидента адресно проверены goal continuation 25 PASS, adapter 38 PASS, Leader loop 14 PASS. Первый combined-run имел early goal-suite request failure; отдельный PASS не считался исправлением. Детерминированный before/after regression и полный финальный прогон описаны ниже. Fresh adapter восстанавливает safe wait по native outer result и только текущему turn; user/error/actionable inbox ломает deferral. Финальный P0 добавляет только fence для exact Host-marked deferred facts при завершении dispatch: они не создают новый semantic review; обычный policy veto и live-producer recheck сохранены.

## B — exact continuation и image evidence

- Lane с прежними REQ без валидного exact conversationRef отклоняется до reservation/Send. Дубли immutable request anchor не выбираются по первому совпадению: требуется единственная либо более сильная bound identity.
- Проверенное image_result/SHA/assistantText сохраняется независимо от позднего bell; bell не заменяет private-channel/hash validation.
- До инцидента: DevSpace/stage4 JS 25 PASS, Direct 31 PASS. Python B после разрешённой реконструкции проверен заново: observer 79 PASS + submit 68 PASS. DOM 30 случаев: 29 PASS сразу, один ранее неоднозначный fixture исправлен на другой исторический REQ; ровно этот случай затем PASS. Итого 177 различных affected Python cases проверены на итоговых релевантных входах. Старая цифра observer 76 не является текущим результатом. Unique immutable key выдерживает Markdown-rendering; original+later REF с одинаковым ключом → None/CHAT_CORRELATION_LOST; ordinal/prefix/prompt SHA/groupKey binding доказывает original. Нормальный exact Send и control continuation сохранены; это controlled synthetic cases, не измеренная live reliability rate.

## C — ресурсный admission

- Используется прежний launch FIFO/max 3 и readiness predicate, не второй scheduler. Overlapping writers ждут в FIFO; disjoint roots продолжаются. Pending/UNKNOWN durable reservation удерживает root; cancel очереди не отправляет REQ.
- Actual Worker shell/write capability конфликтует независимо от текста READ_ONLY. Проверка учитывает durable task rows, не только live jobs текущего Leader.
- Controlled C counts (assertions, затем actual combined PASS пяти admission случаев): overlap launches 1 → 2 ровно один раз, повторные refresh остаются 2; disjoint 2; queued cancel добавляет 0 launch; UNKNOWN удерживает свой root, disjoint launch 1; shell/write Worker busy 0 → idle 1. Прежний coordinator cap=3 подтверждён прежней проверкой; assertions `maximum three active lifecycles; fourth waits until one settles` не менялись.
- Последний доинцидентный адресный набор: `postman-worker.test.js`, `postman-bridge-core.test.js`, `postman-resource-admission.test.js`, `postman-devspace-bootstrap.test.js`, `postman-task-context.test.js`, `postman-bridge-launch-coordinator.test.js` — 90 PASS, 0 skipped.

## D — настоящее приложение, Host lifetime, browser и stop

- `postman_app` запускает исходный native `pwsh` через ToolRuntime с exact Worker, фиксированным task worktree и прежними guards/sandbox. Узкая native overlay выбирает initial job owner = exact Leader; transfer/restart/process-manager не добавлены.
- `postman-app.test.js`: настоящий Worker запускает tiny HTTP app и делает HTTP check; штатный close удаляет Worker mapping; тот же URL остаётся HTTP 200, native job принадлежит Leader. Проверены forged caller denial, missing job = OUTCOME_UNKNOWN/no restart, exact owned stop и native Leader owner cleanup.
- Финальный native command: `node --test plugins/dsh-postman-harness/lib/postman-native-bootstrap.test.js plugins/dsh-postman-harness/lib/postman-app.test.js` в изолированной pinned SDK fixture — 3 PASS.
- Отдельный actual browser run после Worker close: canonical Harness Playwright, страница `Owned runtime test`, кнопка `Check rendering`, output 0 → 1. Screenshot сохранён вне Git в штатной `.playwright-mcp/postman-app-after-worker-close.png`. После демонстрации exact app явно остановлено; URL более не обслуживается.
- Console gap закрыт без повторного запуска приложения: canonical browser tab всё ещё exact URL прежней демонстрации, title Owned runtime test, snapshot output=1; `browser_console_messages(level:error,all:true)` вернул 0 сообщений/ошибок/предупреждений. Это свидетельство сохранённой browser session, не новое HTTP proof после stop.
- Receipt/URL, HTTP proof и browser render — разные факты; cold saved jobId не доказывает процесс и не разрешает auto-restart.

## Известные ограничения проверки

- Полный production-install fixture остановлен на существующем Web frozen-lockfile mismatch (`dsh-cost-panel` link); lockfile не изменялся ради зелёной проверки. Адресная private overlay application прошла. Новый обязательный `system/patches/postman-native-upgrade.test.mjs`: 7 PASS (current idempotence, historical cold+close → все 4 current targets → idempotence, по одному unknown refusal на каждый из 4 targets до любой замены); отдельный отсутствующий optional pwsh case — 1 PASS. Root cause старого replay: пропущен reverse settlement (это было и в pinned installer), дополнительно новые deferred/report overlays снимаются раньше; Windows LF/CRLF учитывается. Исторические Git blob SHA1 сохранены без изменения: cold 753ba9babe4aa1e548cf7b1dd6eee2ccdc666f40; close d7bcddd29f0952e2e8e4d0308b6f6f4cf921f0e6. Helper проверяет exact canonical pinned subagent/session/pwsh postimage и прежний goal SHA до первого rename; unknown late target не меняет ни один из четырёх SDK файлов. Installer копирует три новые overlay, new tests и проверяет report-defer/deferred markers. `npm pack --dry-run --json` включает lib/postman-app.js; архив не создавался.
- Capability lifecycle suite нельзя объявлять полностью PASS: isolated Leader/Secretary requests не содержат ожидаемые canonical policy markers. По одному точно такому Leader/Secretary assertion воспроизведено на извлечённом pinned HEAD с той же private SDK; это baseline composition failure, не устранённый этой задачей. Real-cycle 9 PASS и app 1 PASS не зависят от подмены этих assertions.
- Cached `origin/main` = `a4b35334ff3198ef6d51f8a5466db67d3f068a28` (#445) отличается от pinned base только `plugins/dsh-ptc/src/executor.mjs` и `plugins/dsh-ptc/test/runtime.test.js`. Fresh remote exact SHA совпал. В отдельной НЕ-Git private directory exact main archive + intentional task diff прошёл git apply --check и actual apply. dsh-ptc привязан к combined main source, native SDK — к прежнему private fixture. Первый combined critical run: 78 cases, 77 PASS / 1 FAIL (initial parent requests 2 вместо 1). Он не принят по одному успешному повтору. В P0 добавлены две нормативные same-plan multiworker ветви и две quiet-order ветви реального two-Worker goal fixture. Новый deterministic before/after раскрывает такую же форму startup failure на прежнем adapter: quiet native fact попадает в дополнительный turn и создаёт model request до A report. Исправление и полный финальный прогон ниже. QuickJS 19 включает настоящий #445 zero-argument -> {} / explicit undefined rejection. Pinned branch не rebase-илась; refs/HEAD не изменены.
- Приватные журналы, исходные пользовательские данные, transport artifacts, runtime IDs, SDK fixtures и `.npm-cache` не предназначены для публикации. Public result содержит только синтетические/агрегированные сведения.
## Агрегаты и контролируемые счётчики

Историческая выборка (данные исходного задания/аудита Leader, НЕ новый прогон): 154 unique PTC, 156 результатов, 2 duplicate; 57 successful empty external_event, 0 empty semantic_decision, 3 syntax failures до действий. 14 REQ: 5 DONE / 5 BLOCKED / 4 UNKNOWN. 113 parent turns, 164 attempts. Tokens: input 965078 / output 80751 / reasoning 17039; денежная стоимость недоступна, доллары не оцениваются. Raw IDs/журналы не публикуются.

Controlled native fixture (реальные tool results, parent requests, report/settled facts; не live reliability rate):

| Случай | Parent requests | PTC total | Empty waits | external / semantic / complete | unique report / settled |
|---|---:|---:|---:|---|---|
| single baseline | 3 | 1 | 0 | 1 / 0 / 0 | 1 / 1 |
| single defer | 2 | 1 | 0 | 1 / 0 / 0 | 1 / 1 |
| multi baseline | 5 | 4 | 2 | 3 / 0 / 1 | 2 / 2 |
| multi defer | 4 | 3 | 1 | 2 / 0 / 1 | 2 / 2 |
| multi conflict | 5 | 4 | 2 | 3 / 0 / 1 | 2 / 2 |
| Sol defer | 4 | 3 | 1 | 2 / 0 / 1 | 2 / 2 |
| text-only review defer | 4 | 2 | 0 | 1 / 0 / 1 | 2 / 2 |
| normative same-plan before | 5 | 3 | 1 | 2 / 0 / 1 | 2 / 2 |
| normative same-plan after | 4 | 2 | 0 | 1 / 0 / 1 | 2 / 2 |

7 instrumented cases PASS в combined main+task source; только single counter затем уточнён, чтобы учитывать deferred native inbox наряду с session events: эти 2 cases PASS заново. Тексты report и settled не уничтожаются. Native fixture tokens/cost не измеряет. Task-tree запуск с отдельной локальной pnpm копией SDK зависал; его не выдаём за PASS: actual task imports native types от task node_modules, fixture SDK — от отдельного private root. Combined source использует один согласованный private dependency graph и настоящий main PTC.

## Восстановление исходников и границы

До восстановления сохранены 946 файлов, index/HEAD, raw incident archives/patch и SHA manifest вне Git. 19 tracked lib/helper postimages восстановлены из доказанного последнего private fixture; 2 случайных main-only PTC файла возвращены к pinned base (main fix остаётся только в combined fixture). Python B, installer, role docs и package files entry — разрешённая минимальная реконструкция/воспроизведение по требованиям, НЕ утверждение exact prior-byte recovery. Один DOM fixture получил другой исторический REQ, потому что прежний одинаковый immutable ключ теперь правомерно неоднозначен; новый duplicate-key regression явно проверяет отказ. Полная per-file provenance сохранена в private recovery manifest; incident artifacts/cache/index не удалялись.

Native upgrade test/helper postimage refusal — дополнительная проверка требуемой trust boundary, а не изменение ожидаемых historical hashes. Активные permanent worktree/SDK/Host не менялись. Полный install остаётся blocked baseline Web lockfile; final acceptance принадлежит Leader. Итог P0 ниже не подменяет baseline install/role composition ограничения.
## P0 — zero waiting и deterministic startup ordering

Нормативная пара normative-baseline / normative-defer использует идентичные native producers A/B, gates, модельный policy и meaningful reviews. A получает один final text judgement; B продолжает реальную работу. Только старый лишний technical-settled wake достигает legacy empty-wait ветви той же модели. Before: 5 parent requests, 3 PTC, 1 empty wait. After: 4 requests, 2 PTC (dispatch + cleanup), 0 empty waits, 0 empty semantic calls, 2 report + 2 settlement unique facts сохранены. Legacy synthetic baseline/defer, где сама модель намеренно просит empty wait после meaningful report, НЕ нормативная приёмка. Нет fake read/no-op tool ради счётчика.

Детерминированная причина раннего технического wake: native inject не вызывает wake только при idle. Host-marked postman-deferred fact, пришедший после authoritative outer result либо при agent/turn-stopping, остаётся pending; AgentLoop открывает следующий turn, а старый adapter ограничивал fence прежним turn. На preserved pre-repair adapter с реальными двумя Worker quiet=none PASS, quiet=dispatch и quiet=turn-stopping FAIL 2 != 1. Failure packet: successful concluded dispatch, 2 accepted child effects, active=true, goal roundsStarted=0; второй user/message — только deferred settlement. Это лишний model request, не goal continuation. First historical incident без raw trace не объявляется идентичным по происхождению.

Fix использует существующий pre-step fence: после ordinary policy разрешения, только если ВСЕ messages exact native deferred report/settled и подтверждён safe wait+живой producer, exact messages возвращаются в тот же durable inbox и proposal отклоняется без модели. Exact suspended-turn marker сохраняет только proven completed wait; каждый admission заново проверяет authority/live producer/actionable input. Quiet facts вместе с A meaningful review не становятся отдельным semantic input. User/guidance/error/policy additions не подавляются. Pending stop/compact/fresh/task-close settlement остаётся wake-relevant даже после turn/end.

Реальный two-Worker regression none/dispatch/turn-stopping: до release A initial request=1, goal rounds=0, PTC authoritative ok; после A один text review, B active, wait=true, goal rounds=0, empty PTC=0; technical fact delivered exactly once. No timer/retry/repeat loop, fake call или новый scheduler.
Финальный полный combined command (pwsh-18): 132/132 PASS, 0 failed/cancelled/skipped, exit0. Состав: main QuickJS runtime + native A/D + real-cycle + goal + resource + DevSpace + affected adapter + Leader-loop. Исходные 78 обязательных cases плюс 2 нормативных и 2 quiet-order = 82 critical PASS; дополнительно 50 adapter/Leader-loop PASS. Все три startup ordering и ordinary policy/user/queued notice/stop/lifecycle/unsafe/admission cases пройдены в одном полном прогоне. Предыдущий расширенный run 131/132 выявил regression pending lifecycle after turn/end; она исправлена возвратом проверки lifecycle к полному tail событий, не ослаблением assertions. Полный следующий run 132/132 — текущая достаточная проверка. Private log: final-p0-combined.log в recovery root.
