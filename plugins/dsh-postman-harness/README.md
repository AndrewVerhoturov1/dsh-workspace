# dsh-postman-harness

## Статус

`dsh-postman-harness` не является отдельным browser transport. Production transport остаётся в
`postman/direct/`.

Plugin владеет trusted Harness orchestration boundary:

```text
exact current @Postman / @PostmanAsk
→ no-argument current-turn tools
→ existing Direct Postman wrappers
```

и отдельной supervisor capability:

```text
Postman Leader
→ postman_bridge(message="@Postman..." | "@PostmanAsk...")
→ fresh fixed gpt-5.6-luna child
→ existing trusted current-turn tools
→ existing Direct Postman
→ trusted terminal returned to parent
```

`postman_bridge` не является fallback после Direct failure и не создаёт новый transport.

## Postman Bridge

Bundle подключает subpath entrypoint:

```text
dsh-postman-harness/bridge
```

Он регистрирует tool `postman_bridge` с одним model-facing argument `message`.

Bridge жёстко фиксирует:

- provider `spawn`;
- model route `codex / gpt-5.6-luna`;
- one-shot child;
- `maxDepth = 1`;
- allowlist child tools: `skill`, `postman_send_current_turn`, `postman_current_turn_status`, `postman_ask_validate_reply`.

Model/provider/tool surface child-а нельзя переопределить аргументами `postman_bridge`.

После child settlement parent получает terminal через trusted `postman_current_turn_status` в exact
child scope. Child assistant prose не используется как result authority.

Полный contract: `postman/POSTMAN_BRIDGE_FLOW.md`.

## Postman Leader preset

Web profile добавляет selectable `Postman Leader` (`postman-leader`). Runtime boundary оставляет
его top-level Agent-у только read-only inspection + `postman_bridge`:

```text
read, glob, grep, skill, web_fetch, web_search, postman_bridge
```

Ограничение не применяется к `origin=subagent`; Luna Bridge получает свой отдельный `toolFilter`.
Preset не меняет выбранную пользователем main-model route. Для Leader рекомендуется сильная модель;
Bridge Luna фиксирована кодом.

## Legacy async runtime

В основном entrypoint сохраняются исторические/совместимые компоненты:

- persistent `postman-harness-session`;
- probe protocol;
- SQLite-backed `PostmanRuntime`;
- `postman_async_send`;
- `postman_runtime_*`;
- result workspace/presentation helpers.

Они не являются fallback для normal Direct Postman или Postman Bridge.

## Production source of truth

```text
AGENTS.md
.agents/skills/delegate-via-postman/SKILL.md
.agents/skills/delegate-via-postman-ask/SKILL.md
.agents/skills/postman-leader/SKILL.md
postman/POSTMAN_CURRENT_FLOW.md
postman/POSTMAN_ASK_FLOW.md
postman/POSTMAN_BRIDGE_FLOW.md
postman/direct/README.md
postman/web/README.md
```
