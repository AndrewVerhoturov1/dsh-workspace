# Postman

id: postman
status: active
updated: 2026-10-02

## Goal

Сохранять Direct Web Postman как единый production transport между локальным Harness/Luna agent и ChatGPT Web, не допуская расхождения runtime, skill и канонических контрактов между отдельными задачами и чатами.

## Current focus

Production transport имеет два explicit user-facing режима поверх общего Direct/Web browser слоя: artifact `@Postman` через `postman/direct/postman.ps1` и text `@PostmanAsk` через `postman/direct/postman-ask.ps1`. Над ними существует supervisor orchestration: top-level `Postman Leader` формирует model-authored `@Postman`/`@PostmanAsk` delegation через Leader-only `postman_bridge`, fresh one-shot Luna выполняет только trusted transport, а parent читает terminal result напрямую из child scope. Trusted current-turn Harness остаётся orchestration boundary и не является отдельным transport.

Host поддерживает явно включаемый `localDevelopment: true`: освобождение простаивающей сессии отдельно от доказательства успеха, адресная отмена без повторного approval и restore с приватной recovery-копией файлов/index. Условие целостности данных не заменено доверием к происхождению грязных байтов; pending terminal синхронизируется отдельно без повторной Web-отправки. Подробности — в Host README.

## Next step

Worker lifecycle сохраняет строгий режим по умолчанию; явно включённый `localDevelopment` отделяет освобождение сессии от доказательства результата. 2026-10-02 действующий Host обновлён адресно с резервной копией, режим включён пользователем в Web profile. Текущий Worker штатно освобождён, грязные файлы/index сохранены вне репозитория, task worktree восстановлен и receipt синхронизирован без Direct Send и нового Worker. Native lifecycle-тесты строгого режима воспроизводимо падают и на исходной установленной композиции: это не объявляется PASS и не исправляется подделкой turn/end.

LIVE E2E остаётся за пользователем: Web implementation ZIP → RESULT_DURABLE → Host grant → Sol authorization → same continuable Worker → Host-prepared clean worktree на опубликованном REQ commit → implementation_artifact_apply → existing runner → Worker report. Локально покрыты отказ runner-а → явный rollback → второй ZIP в той же ветке; живой Web-путь не запускался; текущий Host подтвердил загрузку исправленной политики и успешные штатные restore/retrySync.

## Boundaries

- Этот подпроект не переопределяет `AGENTS.md`, `REPO_POLICY.md`, `.agents/skills/delegate-via-postman/SKILL.md`, `postman/POSTMAN_CURRENT_FLOW.md` или `docs/web-postman-artifact-contract.md`.
- Normal `@Postman` не распаковывает и не применяет результат, не создаёт implementation branch/worktree/commit/PR и не выполняет merge.
- `plugins/dsh-postman-harness/` содержит trusted current-turn boundary, Leader-only `postman_bridge` для Web и независимый Leader-only `postman_worker` для локальной работы; Bridge не является альтернативным transport/fallback и не доступен обычным Agents.
- Канонические Postman документы остаются на своих текущих путях; подпроект хранит только долговременный контекст и решения.

## Read first

1. `AGENTS.md`
2. `REPO_POLICY.md`
3. `.agents/skills/delegate-via-postman/SKILL.md` и `.agents/skills/delegate-via-postman-ask/SKILL.md` — по direct trigger mode.
4. `.agents/skills/postman-leader/SKILL.md` и `postman/POSTMAN_BRIDGE_FLOW.md` — для supervisor mode.
5. `postman/POSTMAN_CURRENT_FLOW.md` для artifact flow или `postman/POSTMAN_ASK_FLOW.md` для text flow.
6. `docs/web-postman-artifact-contract.md` — только для artifact mode.
7. `postman/direct/README.md` или `postman/web/README.md` — по затронутому слою.
8. `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md` — для explicit implementation-package работы.

## Main paths

- `postman/`
- `postman/direct/`
- `postman/web/`
- `.agents/skills/delegate-via-postman/SKILL.md`
- `.agents/skills/delegate-via-postman-ask/SKILL.md`
- `.agents/skills/postman-leader/SKILL.md`
- `postman/POSTMAN_ASK_FLOW.md`
- `postman/POSTMAN_BRIDGE_FLOW.md`
- `docs/web-postman-artifact-contract.md`
- `plugins/dsh-postman-harness/`

## Current decisions

- `@Postman` — explicit artifact/ZIP production trigger; entrypoint — `postman/direct/postman.ps1`.
- `@PostmanAsk` — отдельный explicit text production trigger; entrypoint — `postman/direct/postman-ask.ps1`.
- `postman_bridge` — отдельная supervisor capability только для top-level `postman-leader`; обычные root/subagent Agents получают runtime deny, execute path повторно проверяет caller fail-closed, а blank-session `agent-preset/selected` заменяет старый restriction на restriction текущей live composition.
- Bridge delegation создаёт fresh one-shot `codex / gpt-6-luna` child с `maxDepth = 1` и узким transport-only toolFilter; follow-up, mode и continuation Web-запроса выбирает parent Leader.
- Локальный Worker — обычный continuable `spawn` child `codex / gpt-6-luna`, с отдельной константой модели и без собственного allowlist. Один активный childId на точную Leader session связан с durable task registry; resident activation и последующие follow-up сохраняют ту же Worker session. Повторный task идёт через `followup`; stop освобождает resident Activation, но не удаляет durable Session. Отчёт Worker приходит через штатный child-scoped `report`; admission не означает выполнения.
- Authority supervisor result — trusted Direct terminal из exact child scope, а не Luna prose. Для text terminal parent Leader ветвится по `deliveryMode`: `inline` анализирует `assistantText`, `file` использует verified `resultFile` descriptor и при необходимости читает exact Markdown выборочно через свои `read`/`grep`; Bridge child файл не rehydrate-ит.
- Agent presets не владеют model routing; для роли Leader `GPT-6 Sol` выбирается отдельно в model selector, Bridge Luna остаётся hard-fixed.
- Оба режима используют один trusted `postman_send_current_turn()` без text arguments; Harness сам различает exact current-message trigger и сохраняет exact payload.
- PostmanAsk success — только `TEXT_RESULT_DURABLE` после exact REQ-bound BEGIN/END envelope; обычный assistant text не является result.
- После `TEXT_RESULT_DURABLE` Direct PostmanAsk использует size-based handoff: `<=4096` символов остаются `deliveryMode=inline` и проходят strict `postman_ask_validate_reply`; более длинный exact result атомарно сохраняется как UTF-8 `POSTMAN_<REQ>_ANSWER.md`, terminal возвращает только проверенный file descriptor без `assistantText`, а Luna не rehydrate-ит файл обратно в context.
- PostmanAsk использует существующий Web Worker 10-second no-artifact fresh re-proof перед text-envelope validation; отдельный browser transport не создаётся.
- Artifact terminal surface: `RESULT_DURABLE`, `ASSISTANT_COMPLETED_NO_ARTIFACT`, `ARTIFACT_REJECTED`, `POSTMAN_TRANSPORT_FAILED`; первые три являются artifact handoff, transport failure остаётся отдельным fail-closed исходом. Text success surface — `TEXT_RESULT_DURABLE`; text trigger validation failure остаётся transport failure.
- `ASSISTANT_COMPLETED_NO_ARTIFACT` требует fresh reproof через 10 секунд; изменение assistant text/SHA запускает новое 10-секундное grace window.
- ZIP, отклонённый minimal transport validator, немедленно завершает REQ как `ARTIFACT_REJECTED`.
- Reminders 10/20/30/40/50 — absolute slots; soft deadline 60 минут, текущий recovery начатый до него может закончиться только до soft+45s. Recovery consume-ит все наступившие pending slots без очереди догоняющих сообщений. 50 natural Russian continuation templates не показывают REQ/control identifiers; trusted state сохраняет exact text/hash/templateId, slot/eventId и доказанную user-turn relation (ordinal/prefix/groupKey). Reminder безопасен только при WORKING без final latch; 5-second Send window/poll 1s/one-shot click сохраняются.
- Connection headline не требует subtitle; modern turn wrapper не исключает system UI. Additional Processing выполняет Stop-if-present (ABSENT/UNKNOWN без повторного click)→Reload exact chat→original task lineage/composer re-proof→uniform wait 10–17s→natural Continue. Один banner episode = один bounded cycle; disappearance re-arms, второй flow не накладывается. Durable/failure state содержит bounded 256-event журнал и detector evidence/reasons/counters.
- Recovery выполняется в том же exact ChatGPT conversation; reload не создаёт новый REQ и не повторяет исходный prompt.
- Manual `@Postman --chat <old REQ> <intent>` / `@PostmanAsk --chat <old REQ> <intent>` используют exact сохранённый conversation; automatic continuation остаётся artifact-only.
- Automatic continuation использует explicit `-AutomaticContinuation` только после non-durable artifact terminal: максимум два новых REQ на root chain (`continuationIndex` 1 и 2); после исчерпания требуется отдельное решение. Ручной `--chat` начинает новую root chain с индексом 0. Worker follow-up не относится к этому пределу.
- `POSTMAN_TRANSPORT_FAILED` автоматически не продолжается.
- Normal Postman transport универсален: безопасный ZIP и trusted `RESULT_DURABLE` подтверждают происхождение, целостность и сохранность, но не пригодность patch и не разрешение на применение. На downstream boundary Host создаёт process-local grant по exact Leader session + REQ для trusted ZIP/SHA; Sol отдельно авторизует REQ через `postman_worker({task, artifactRequestId})`.
- Для implementation ZIP ChatGPT Web следует `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`: `manifest.json`, Git-generated `changes.patch`, `README.md`, `TEST_PLAN.md`, только относящиеся к изменению тесты и узкое исключение `.gitignore` в том же patch для иначе игнорируемых новых файлов. Пакет не приносит собственного runner или grant-механизма: process-local Host grant принадлежит downstream orchestration.
- Тот же continuable Worker получает trusted REQ, не model-authored ZIP path, использует единственную Host-prepared task branch и тот же clean worktree на опубликованном REQ commit, не создавая вторую ветку и вызывает `implementation_artifact_apply({requestId, worktree})`. Host проверяет caller и SHA-256, подставляет сохранённый exact ZIP и запускает существующий `system/implementation_package_runner.py`. Runner PASS с `manifest.tests` на реальном target worktree authoritative при неизменных релевантных inputs: Worker inspect-ит exact result/status/diff, но не повторяет те же tests вручную. Worker сообщает через `report` (приём задания — не завершение). На PASS сообщает результат и затронутые пути, но не публикует автоматически; на FAIL передаёт диагностику без ручного ремонта. Sol выбирает дальнейший шаг. Worker остаётся обычным coding-agent с shell: граница запрещает не все самостоятельные локальные запуски, а доступ неавторизованного Worker к trusted grant/tool. Публикация — отдельное действие согласно `REPO_POLICY.md`; merge требует отдельной команды.
- Host `postman_task_prepare` создаёт и публикует единственную task branch/worktree Leader от exact `origin/preview`; Bridge через Host публикует REQ туда, а не в `main`. При необходимости Leader-only `postman_task_restore` сбрасывает только эту существующую process-local привязку к проверенному remote SHA после блокировки новых задач и завершения активных операций; постоянные worktree не изменяются. Registry сохраняет task/Worker binding по действующему контракту; неизвестного child нельзя угадывать. Перед отдельным commit/push/PR реализации удаляются REQ transport-файлы; SHA-pinned URL старых REQ и `--chat` сохраняются. Runner допускает `packageBase != HEAD`.
- Normal Postman не выполняет automatic Result Workspace registration и сам не переходит к Git integration или merge.

PR #242 уже входит в `preview`. Разработка #246 совмещает `workers[id]` и отдельные lifecycle-свидетельства каждого Worker, не переносит устаревший drain из старого prepareRestore. Постоянные worktree и активная установка не меняются; накладка `dsh-subagent` остаётся SHA-привязанной offline-поправкой для отдельного будущего развёртывания. Историческое отсутствие `turn/end` не имеет установленной причины.
