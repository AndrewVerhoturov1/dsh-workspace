# Postman

id: postman
status: active
updated: 2026-09-22

## Goal

Сохранять Direct Web Postman как единый production transport между локальным Harness/Luna agent и ChatGPT Web, не допуская расхождения runtime, skill и канонических контрактов между отдельными задачами и чатами.

## Current focus

Production transport имеет два explicit user-facing режима поверх общего Direct/Web browser слоя: artifact `@Postman` через `postman/direct/postman.ps1` и text `@PostmanAsk` через `postman/direct/postman-ask.ps1`. Над ними существует supervisor orchestration: top-level `Postman Leader` формирует model-authored `@Postman`/`@PostmanAsk` delegation через Leader-only `postman_bridge`, fresh one-shot Luna выполняет только trusted transport, а parent читает terminal result напрямую из child scope. Trusted current-turn Harness остаётся orchestration boundary и не является отдельным transport. Legacy/manual finalization относится только к artifact durable result.

## Next step

Для каждой следующей Postman-задачи сначала сверять изменение с текущими production invariants и менять только действительно затронутые runtime/docs/tests.

## Boundaries

- Этот подпроект не переопределяет `AGENTS.md`, `REPO_POLICY.md`, `.agents/skills/delegate-via-postman/SKILL.md`, `postman/POSTMAN_CURRENT_FLOW.md` или `docs/web-postman-artifact-contract.md`.
- Normal `@Postman` не распаковывает и не применяет результат, не запускает PREPARE/TEST/PUBLISH, не создаёт implementation branch/worktree/commit/PR и не выполняет merge.
- `plugins/dsh-postman-harness/` содержит trusted current-turn boundary и Leader-only `postman_bridge`; Bridge не является альтернативным transport/fallback и не доступен обычным Agents.
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
- Supervisor delegation создаёт fresh one-shot `codex / gpt-5.6-luna` child с `maxDepth = 1` и узким transport-only toolFilter; follow-up, mode и continuation выбирает parent Leader.
- Authority supervisor result — trusted Direct terminal из exact child scope, а не Luna prose. Для text terminal parent Leader ветвится по `deliveryMode`: `inline` анализирует `assistantText`, `file` использует verified `resultFile` descriptor и при необходимости читает exact Markdown выборочно через свои `read`/`grep`; Bridge child файл не rehydrate-ит.
- Agent presets не владеют model routing; для роли Leader `GPT-5.6 Sol` выбирается отдельно в model selector, Bridge Luna остаётся hard-fixed.
- Оба режима используют один trusted `postman_send_current_turn()` без text arguments; Harness сам различает exact current-message trigger и сохраняет exact payload.
- PostmanAsk success — только `TEXT_RESULT_DURABLE` после exact REQ-bound BEGIN/END envelope; обычный assistant text не является result.
- После `TEXT_RESULT_DURABLE` Direct PostmanAsk использует size-based handoff: `<=4096` символов остаются `deliveryMode=inline` и проходят strict `postman_ask_validate_reply`; более длинный exact result атомарно сохраняется как UTF-8 `POSTMAN_<REQ>_ANSWER.md`, terminal возвращает только проверенный file descriptor без `assistantText`, а Luna не rehydrate-ит файл обратно в context.
- PostmanAsk использует существующий Web Worker 10-second no-artifact fresh re-proof перед text-envelope validation; отдельный browser transport не создаётся.
- Artifact terminal surface: `RESULT_DURABLE`, `ASSISTANT_COMPLETED_NO_ARTIFACT`, `ARTIFACT_REJECTED`, `POSTMAN_TRANSPORT_FAILED`; первые три являются artifact handoff, transport failure остаётся отдельным fail-closed исходом. Text success surface — `TEXT_RESULT_DURABLE`; text trigger validation failure остаётся transport failure.
- `ASSISTANT_COMPLETED_NO_ARTIFACT` требует fresh reproof через 10 секунд; изменение assistant text/SHA запускает новое 10-секундное grace window.
- ZIP, отклонённый minimal transport validator, немедленно завершает REQ как `ARTIFACT_REJECTED`.
- 10/20/30 минут — absolute reminder checkpoints при общем deadline 45 минут; если assistant всё ещё активно генерирует, соответствующий checkpoint подавляется без изменения composer и не догоняется позже. Reminder pre-click использует отдельное 5-секундное safe-send окно с polling 1 секунда вместо generic 30-секундного Send wait; generation/assistant activity во время окна подавляет checkpoint, а click разрешён только после финальной reproof.
- Recovery выполняется в том же exact ChatGPT conversation; reload не создаёт новый REQ и не повторяет исходный prompt.
- Manual `@Postman --chat <old REQ> <intent>` / `@PostmanAsk --chat <old REQ> <intent>` используют exact сохранённый conversation; automatic continuation остаётся artifact-only.
- Automatic continuation использует explicit `-AutomaticContinuation`, не имеет hard cap и монотонно увеличивает `continuationIndex`.
- `POSTMAN_TRANSPORT_FAILED` автоматически не продолжается.
- Normal Postman не выполняет automatic Result Workspace registration и сам не переходит к Git integration или merge.
