# Postman Bridge — supervisor/worker flow

> Model-facing capability: `postman_bridge(message=...)`
> Bridge child: fresh one-shot `spawn`, fixed `codex / gpt-5.6-luna`
> Existing transports: `@Postman` artifact and `@PostmanAsk` text

## 1. Назначение

Postman Bridge позволяет умной основной модели работать как supervisor: она думает,
проверяет и решает, что спросить дальше, а transport operation выполняет отдельная минимальная
Luna child session.

Bridge не создаёт третий transport. После child current-turn boundary используются существующие
`postman/direct/postman.ps1` и `postman/direct/postman-ask.ps1` без изменений.

## 2. Поток

```text
Postman Leader
→ postman_bridge(message="@PostmanAsk ..." | "@Postman ...")
→ fresh spawn child
→ fixed gpt-5.6-luna
→ exact child user/message
→ child loads canonical Postman skill
→ postman_send_current_turn() with no text args
→ existing Direct Postman
→ ChatGPT Web
→ terminal result
→ postman_current_turn_status()
→ bridge host reads the same trusted terminal directly
→ parent Leader
```

Child assistant prose не является authority результата.

## 3. Exact-message boundary

`postman_bridge.message` является новым model-authored delegation от Leader-а, а не transport
копией текущего human user message. Он обязан начинаться с exact `@Postman` или `@PostmanAsk` и
проходит существующий `parsePostmanUserTurn` до spawn.

После spawn Harness создаёт child `user/message` с exact `message`. С этого момента действует
обычный trusted current-turn invariant: Luna не перепечатывает intent в tool arguments, а вызывает
`postman_send_current_turn()` без аргументов.

## 4. Bridge child contract

Bridge child всегда:

- provider `spawn`;
- route `codex / gpt-5.6-luna`;
- `maxDepth = 1`;
- one-shot;
- без inherited conversation history;
- с allowlist tools:
  - `skill`;
  - `postman_send_current_turn`;
  - `postman_current_turn_status`;
  - `postman_ask_validate_reply`.

`postman_continue_last_request`, generic subagents, shell, filesystem mutation, GitHub, web и
browser tools child-у не выдаются.

Reasoning effort отдельно не хардкодится: route использует поддерживаемый default Luna. Главная
экономия достигается фиксированной Luna, узкой persona и минимальным tool surface.

## 5. Skill selection

Child сначала загружает канонический skill по exact trigger:

```text
@Postman    → delegate-via-postman
@PostmanAsk → delegate-via-postman-ask
```

Bridge не дублирует transport lifecycle из этих skills.

## 6. Trusted result handoff

После settlement child run Bridge host читает `postman_current_turn_status` в scope exact child
session и возвращает parent-у trusted terminal object.

Это специально не зависит от того, как Luna сформулировала final assistant message.

Для text mode authority — весь trusted `TEXT_RESULT_DURABLE` terminal, а способ потребления
зависит от `deliveryMode`:

```text
deliveryMode=inline
→ terminal содержит assistantText
→ child вызывает postman_ask_validate_reply
→ EXACT_REPLY_MATCH разрешает exact child final reply
→ parent Leader получает тот же trusted terminal напрямую

deliveryMode=file
→ terminal не содержит assistantText
→ terminal содержит проверенный resultFile descriptor
→ child НЕ вызывает `postman_ask_validate_reply`
→ child НЕ читает/не реконструирует resultFile
→ bridge host возвращает descriptor parent Leader напрямую
```

Parent Leader для `inline` может анализировать/суммировать `assistantText`. Для `file` он
использует `resultFile` как authority и, только если содержание действительно нужно для
supervisor-решения, читает exact файл собственными `read`/`grep` выборочно. Не требуется и не
желательно целиком rehydrate-ить большой Markdown в один model turn.

Direct user-facing exact-reply/file-handoff contract относится к direct Luna response; supervisor
Leader получает trusted terminal data и сам решает, какую часть результата нужно анализировать.

## 7. Continuation

Bridge child не живёт между запросами. Continuity принадлежит доказанному ChatGPT conversation:

```text
call 1 → @PostmanAsk ...             → REQ_A
call 2 → @PostmanAsk --chat REQ_A... → REQ_B, same conversation
call 3 → @Postman --chat REQ_B ...   → REQ_C, same conversation, artifact mode
```

Каждый вызов создаёт новую Luna child session. Automatic artifact continuation tool child-у не
выдаётся: решение о следующем шаге принадлежит Leader.

## 8. Postman Leader preset

Web profile добавляет selectable preset `postman-leader` / `Postman Leader`.

Top-level Agent этого preset получает runtime allowlist только для read-only inspection и Bridge:

```text
read
glob
grep
skill
web_fetch
web_search
postman_bridge
```

`write`, `edit`, shell, generic `subagent`, workflow и direct Postman tools скрыты runtime-ом.
Сам `postman_bridge` тоже является Leader-only capability: top-level `postman-leader` получает его
в allowlist, а любой другой root/subagent Agent получает точечный `deny: [postman_bridge]`.
Tool body повторно проверяет caller и при обходе visibility boundary возвращает
`POSTMAN_BRIDGE_CALLER_REJECTED` до parsing/spawn.

Один live Agent всегда имеет ровно один Bridge restriction. Поскольку Harness разрешает сменить
preset у пустой сессии до первого turn, plugin слушает `agent-preset/selected`, заново определяет
live composition через `ctx.agents.get(sessionId)` и заменяет предыдущий restriction, снимая его
exact disposer. Это важно: restrictions пересекаются, поэтому простой второй allow поверх старого
deny не сделал бы Bridge видимым после `standard → postman-leader`.

Spawn child имеет `origin=subagent`, получает этот non-Leader deny и дополнительно собственный
Bridge `toolFilter`, поэтому не может рекурсивно вызвать `postman_bridge`.

Harness model routing намеренно находится вне Agent presets. Поэтому `postman-leader` задаёт роль
и tool boundary, но не переключает модель автоматически: для Leader в model selector выбирается
`GPT-5.6 Sol`. Luna Bridge фиксирована кодом независимо от модели parent.

## 9. Failure boundary

Bridge никогда не делает blind resend.

- caller не top-level `postman-leader` → `POSTMAN_BRIDGE_CALLER_REJECTED` до parsing/spawn;
- malformed message → `POSTMAN_BRIDGE_MESSAGE_REJECTED` до spawn;
- spawn/capability failure → `POSTMAN_BRIDGE_START_FAILED`;
- child не стартовал Direct → `POSTMAN_BRIDGE_NO_TRANSPORT`;
- Direct terminal failure возвращается parent-у как trusted `result`;
- cancellation после начала не разрешает автоматический второй Send.

## 10. Ordinary subagents

Обычные `subagent`/`subagent_fork` capabilities Harness не изменяются. Для не-Leader Agents
добавляется только точечный deny имени `postman_bridge`; остальные global tools этим deny не
затрагиваются. `postman_bridge` остаётся отдельным специализированным tool с фиксированной Luna.
