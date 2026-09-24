# Postman Bridge — supervisor/worker flow

> Model-facing capability: `postman_bridge(message=...)`
> Bridge child: fresh one-shot `spawn`, fixed `codex / gpt-6-luna`
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
← POSTMAN_BRIDGE_ACCEPTED + bridgeJobId (Leader сразу свободен)
→ Host job manager / existing Launch Coordinator
→ fresh spawn child
→ fixed gpt-6-luna
→ exact child user/message
→ child loads canonical Postman skill
→ postman_send_current_turn() with no text args
→ existing Direct Postman
→ ChatGPT Web
→ terminal result
→ postman_current_turn_status()
→ bridge host reads the same trusted terminal directly
→ await run.dispose(); release active slot
→ Host followup POSTMAN_BRIDGE_READY (только событие)
→ parent Leader calls postman_bridge_status({bridge_job_id})
← trusted terminal result
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
- route `codex / gpt-6-luna`;
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
session, ждёт полного `run.dispose()` и сохраняет trusted terminal в process-local job registry.
`postman_bridge` возвращает только admission, не completion: Leader сразу может читать, анализировать
и вызывать Worker. После Host `leader.followup(POSTMAN_BRIDGE_READY)` Leader вызывает
`postman_bridge_status({bridge_job_id})`. READY не содержит assistantText/ZIP и не является authority.
Status доступен только точной исходной top-level Leader session; другой Leader/Bridge/Worker
не может прочитать job. При недоставленном READY terminal остаётся доступным по сохранённому ID.
Registry и wakeup state живут лишь в памяти plugin: перезапуск Host во время Bridge может потерять
отображение job; durable Direct Postman result хранится отдельно. Сигнал job — собственный
AbortController, а не exec.signal завершившегося вызова. Остановка plugin отменяет очередь,
посылает abort работающим jobs и ждёт очистки; terminal хранится до dispose plugin.

Это специально не зависит от того, как Luna сформулировала final assistant message.

Для text mode authority — весь trusted `TEXT_RESULT_DURABLE` terminal, а способ потребления
зависит от `deliveryMode`:

```text
deliveryMode=inline
→ terminal содержит assistantText
→ child вызывает postman_ask_validate_reply
→ EXACT_REPLY_MATCH разрешает exact child final reply
→ parent Leader получает тот же trusted terminal через postman_bridge_status

deliveryMode=file
→ terminal не содержит assistantText
→ terminal содержит проверенный resultFile descriptor
→ child НЕ вызывает `postman_ask_validate_reply`
→ child НЕ читает/не реконструирует resultFile
→ bridge host сохраняет descriptor для parent Leader; status tool возвращает его напрямую
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

`postman_bridge` помечен штатным `isConcurrencySafe` Harness 0.1.1-rc.2: Leader
может в одном ходе принять несколько независимых заданий и продолжить работу без ожидания Web. Один Host-side
координатор на жизненный цикл plugin допускает максимум три active Bridge: место
занято от фактического запуска child до terminal и завершения cleanup. Первый
запуск после полного простоя немедленный, следующие идут FIFO с независимой
случайной задержкой 5–15 секунд от предыдущего фактического запуска. Leader не
делает sleep и не разносит вызовы сам; уже запущенные Bridge продолжают работу
параллельно. У каждого вызова свои childSessionId, новый REQ, terminal и
освобождение child. Worker не меняется.
Одинаковый `--chat` (в том числе разные старые REQ одного conversation URL)
отклоняется межпроцессной блокировкой до публикации и отправки; разные разговоры
не блокируют друг друга. Только короткий участок GitHub-публикации задач и первый
запуск общего Chrome/CDP последовательны; Web-наблюдение разных чатов параллельно.
При занятом разговоре нет автоматического повтора отправки.

## 8. Postman Leader preset

Preset `postman-leader` / `Postman Leader` хранится в репозитории как файловая композиция
`.agent-presets/postman-leader/agent.cordis.yml` с описанием в `preset.yml`. Встроенный
`dsh-agent-presets` обнаруживает такие каталоги под `$DSH_HOME/.agent-presets`; поэтому при
проверке отдельного рабочего дерева `DSH_HOME` должен указывать на его корень. Web profile
не загружает отдельный preset-плагин: существующий `postman-bridge` подключается на уровне
host-композиции в bundle `dsh-postman-harness`.

Top-level Agent этого preset получает runtime allowlist для read-only inspection, Bridge и Worker:

```text
read
glob
grep
skill
web_fetch
web_search
postman_bridge
postman_bridge_status
postman_worker
postman_worker_stop
```

`write`, `edit`, shell, generic `subagent`, workflow и direct Postman tools скрыты runtime-ом у Leader. Зарегистрированный `implementation_artifact_apply` не входит в Leader allowlist: его execute path допускает только точного активного Worker после отдельной авторизации REQ.
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
`GPT-6 Sol`. Luna Bridge фиксирована кодом независимо от модели parent.

## 9. Передача implementation package локальному Worker

`RESULT_DURABLE` из exact child scope подтверждает происхождение и целостность ZIP, а не корректность implementation patch. Normal transport универсален и не требует `manifest.json`; Bridge child не применяет пакет. После correlated terminal Host регистрирует process-local grant по точной сессии Leader и REQ с exact trusted ZIP и SHA-256. Grant — внутреннее доверенное соответствие, не model-provided token и не автоматическое разрешение на применение.

Для implementation package ChatGPT Web следует `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`: декларативный ZIP содержит `manifest.json`, Git-generated `changes.patch`, `README.md`, `TEST_PLAN.md`; targeted tests, новые файлы и необходимые узкие исключения `.gitignore` входят в patch. Собственного applicator и диагностики в ZIP нет.

```text
Bridge terminal RESULT_DURABLE
→ Host регистрирует grant для exact Leader session + REQ (trusted ZIP + SHA-256)
→ Sol отдельно авторизует REQ: postman_worker({task, artifactRequestId: "REQ_..."})
→ тот же continuable Worker получает trusted REQ, не model-authored ZIP path
→ Worker создаёт clean task branch/worktree от текущего origin/preview
→ Worker вызывает implementation_artifact_apply({requestId: "REQ_...", worktree: "<clean worktree>"})
→ Host проверяет точного Worker, разрешает REQ в trusted ZIP и повторно сверяет SHA-256
→ Host запускает существующий system/implementation_package_runner.py
→ Worker проверяет фактический результат и отправляет report → Sol
```

`POSTMAN_WORKER_TASK_ACCEPTED` означает только приём задания, не итог: Sol дожидается `report`. На PASS Worker сообщает результат runner и затронутые пути без автоматического commit/push/PR; на FAIL — diagnostics ZIP и STOP без локального ремонта patch. После FAIL Sol решает, исследовать ли проблему, запросить новый ZIP или остановиться. Публикация после PASS поручается отдельно по repository policy; merge требует отдельной явной команды пользователя.

Worker — обычный coding-agent с shell и теоретически может сам запускать локальные программы. Гарантия этой границы уже: только отдельно авторизованный Worker может использовать trusted Host grant и `implementation_artifact_apply` для exact Postman artifact; запрета на все самостоятельные локальные запуски здесь нет.

## 10. Failure boundary

Bridge никогда не делает blind resend.

- caller не top-level `postman-leader` → `POSTMAN_BRIDGE_CALLER_REJECTED` до parsing/spawn;
- malformed message → `POSTMAN_BRIDGE_MESSAGE_REJECTED` до spawn;
- spawn/capability failure → `POSTMAN_BRIDGE_START_FAILED`;
- child не стартовал Direct → `POSTMAN_BRIDGE_NO_TRANSPORT`;
- Direct terminal failure возвращается parent-у как trusted `result`;
- cancellation после начала не разрешает автоматический второй Send.

## 11. Ordinary subagents

Обычные `subagent`/`subagent_fork` capabilities Harness не изменяются. Для не-Leader Agents
добавляется только точечный deny имени `postman_bridge`; остальные global tools этим deny не
затрагиваются. `postman_bridge` остаётся отдельным специализированным tool с фиксированной Luna.
