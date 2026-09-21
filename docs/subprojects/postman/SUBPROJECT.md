# Postman

id: postman
status: active
updated: 2026-09-21

## Goal

Сохранять Direct Web Postman как единый production transport между локальным Harness/Luna agent и ChatGPT Web, не допуская расхождения runtime, skill и канонических контрактов между отдельными задачами и чатами.

## Current focus

Текущий production path — Direct Web Postman через `postman/direct/postman.ps1`. Normal `@Postman` ограничен transport lifecycle и terminal handoff; legacy/manual finalization и `dsh-postman-harness` остаются отдельными вспомогательными слоями.

## Next step

Для каждой следующей Postman-задачи сначала сверять изменение с текущими production invariants и менять только действительно затронутые runtime/docs/tests.

## Boundaries

- Этот подпроект не переопределяет `AGENTS.md`, `REPO_POLICY.md`, `.agents/skills/delegate-via-postman/SKILL.md`, `postman/POSTMAN_CURRENT_FLOW.md` или `docs/web-postman-artifact-contract.md`.
- Normal `@Postman` не распаковывает и не применяет результат, не запускает PREPARE/TEST/PUBLISH, не создаёт implementation branch/worktree/commit/PR и не выполняет merge.
- `plugins/dsh-postman-harness/` — auxiliary/legacy слой, а не production fallback.
- Канонические Postman документы остаются на своих текущих путях; подпроект хранит только долговременный контекст и решения.

## Read first

1. `AGENTS.md`
2. `REPO_POLICY.md`
3. `.agents/skills/delegate-via-postman/SKILL.md`
4. `postman/POSTMAN_CURRENT_FLOW.md`
5. `docs/web-postman-artifact-contract.md`
6. `postman/direct/README.md` или `postman/web/README.md` — по затронутому слою.
7. `system/implementation-package-workflow.md` — только для explicit implementation-package/manual-finalization работы.

## Main paths

- `postman/`
- `postman/direct/`
- `postman/web/`
- `.agents/skills/delegate-via-postman/SKILL.md`
- `docs/web-postman-artifact-contract.md`
- `plugins/dsh-postman-harness/`

## Current decisions

- `@Postman` — единственный explicit production trigger; production entrypoint — `postman/direct/postman.ps1`.
- Terminal surface: `RESULT_DURABLE`, `ASSISTANT_COMPLETED_NO_ARTIFACT`, `ARTIFACT_REJECTED`, `POSTMAN_TRANSPORT_FAILED`; первые три являются terminal handoff, transport failure остаётся отдельным fail-closed исходом.
- `ASSISTANT_COMPLETED_NO_ARTIFACT` требует fresh reproof через 10 секунд; изменение assistant text/SHA запускает новое 10-секундное grace window.
- ZIP, отклонённый minimal transport validator, немедленно завершает REQ как `ARTIFACT_REJECTED`.
- Service reminders отправляются на 10-й, 20-й и 30-й минуте; общий deadline одного REQ — 45 минут.
- Recovery выполняется в том же exact ChatGPT conversation; reload не создаёт новый REQ и не повторяет исходный prompt.
- Manual `@Postman --chat <old REQ> <intent>` и automatic continuation — разные режимы.
- Automatic continuation использует explicit `-AutomaticContinuation`, не имеет hard cap и монотонно увеличивает `continuationIndex`.
- `POSTMAN_TRANSPORT_FAILED` автоматически не продолжается.
- Normal Postman не выполняет automatic Result Workspace registration и сам не переходит к Git integration или merge.
