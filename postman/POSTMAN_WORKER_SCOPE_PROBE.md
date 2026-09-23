# Postman Worker Scope Probe

## Статус

Это временный архитектурный эксперимент. Это **не** production `worker_run` и не готовый Worker.

Цель — проверить одну конкретную гипотезу установленного Harness `0.1.1-rc.2`:

```text
широкий shared preset
        |
        +--> exact Leader runtime restriction -> Leader не видит write
        |
        +--> ordinary spawn child + toolFilter allow ['write']
                                      -> child видит и реально вызывает write
```

Если это работает, будущий Worker можно строить поверх штатного `spawn`, не создавая отдельный
`postman-worker SubagentProvider` только ради независимого tool surface.

## Что меняется

`postman-leader` становится широким preset composition: в нём присутствуют стандартные coding
capabilities, включая `write/edit`, shell и generic delegation.

Это **не расширяет фактический каталог top-level Leader**. Plugin `dsh-postman-harness/bridge`
оставляет Leader runtime allowlist узким:

```text
read
glob
grep
skill
web_fetch
web_search
postman_bridge
postman_worker_scope_probe
```

Все остальные capabilities существуют как общий источник composition для children, но exact
Leader их не видит.

## Что делает probe

`postman_worker_scope_probe()`:

1. Проверяет, что exact Leader не видит `write`.
2. Создаёт уникальное имя marker-файла внутри Leader `cwd`.
3. Стартует обычный provider `spawn`, fixed `codex/gpt-6-luna`.
4. Child получает `toolFilter.allow=['write']`.
5. Host сразу измеряет настоящий child tool catalog.
6. Luna получает фиксированную задачу вызвать `write` ровно один раз.
7. Host независимо перечитывает marker и сравнивает точные байты.
8. Host проверяет:
   - `parentSession`;
   - `origin=subagent`;
   - `delegationDepth=1`;
   - `write` виден child;
   - `postman_bridge` и сам probe child не видит.
9. Child dispose.
10. Marker удаляется host-ом.

Успешный terminal:

```text
POSTMAN_WORKER_SCOPE_PROBE_PASS
verdict=SPAWN_SUFFICIENT_FOR_SCOPE_HYPOTHESIS
```

## Что PASS доказывает

PASS доказывает только tool-scope архитектуру:

- runtime restriction exact Leader остаётся локальным для Leader;
- ordinary spawn child может заново присоединиться к общей preset composition;
- собственный child `toolFilter` может оставить capability, скрытую у Leader;
- отдельный custom SubagentProvider не нужен **только ради этой особенности**.

PASS не доказывает:

- безопасную распаковку Postman artifacts;
- preview/browser sandbox;
- SSRF-safe fetch;
- host-side QA assertions;
- concurrency/resource isolation будущего Worker.

## Что считать провалом

- Leader видит `write`.
- Spawn не стартует из-за неизвестного `write`.
- Child не видит `write`.
- Child видит `postman_bridge` или `postman_worker_scope_probe`.
- Marker не создан или его содержимое отличается.
- Lineage не `Leader -> origin=subagent, depth=1`.

В этих случаях не делать автоматический вывод `CUSTOM_PROVIDER_REQUIRED`. Сначала разобрать
конкретную причину: preset composition, boundary layering, child toolFilter, sandbox или model/tool
execution.

## Состояние проверки

Тесты `postman-bridge-core.test.js` и `postman-worker-scope-probe.test.js`
проверяют логику границ, байтовую сверку marker и cleanup на подставном `subagents.start`.
Они **не доказывают** наследование инструментов в настоящем Harness.
Архитектурный PASS допустим только после одного вызова probe из новой top-level
сессии Postman Leader в Web, загруженном с этим плагином и preset, и проверки
фактического JSON, каталогов инструментов и отсутствия marker.
До такого вызова статус гипотезы — `UNVERIFIED`, а не `SPAWN_SUFFICIENT`.

## Второй режим: продолжение одной сессии

Исходный вызов `postman_worker_scope_probe()` (или `mode="scope"`) сохраняет старую
одноразовую проверку без изменения её вывода. Новый вызов из **новой** top-level сессии
Postman Leader после перезапуска Web:

`postman_worker_scope_probe({"mode":"continuation"})`

Это отдельный эксперимент с `codex / gpt-5.6-luna`, не production Worker. Host вызывает
штатные методы установленного Harness 0.1.1-rc.2:

- `ctx.subagents.startContinuable({ provider: 'spawn', childId, request, signal, label })`:
  единственный child с `toolFilter.allow=['write']`; возвращённые `childId/messageId`
  означают принятие первого сообщения, **не** окончание хода.
- Подписка на `session/event` фиксирует `turn/end` первого хода. Тогда Host посылает
  `ctx.subagents.followup(parent, childId, content, { source, signal })` в ту же сессию.
  Доставка начинается до автоматического освобождения неактивной активации; повторное
  сообщение никогда не содержит секрет. Если реальный runtime успел освободить child
  до этого перехода, результат — FAIL, а не скрытая подмена другим child.
- Запись `turn/end` второго хода позволяет прочитать события `tool/call` и `tool/result`.
  Затем Host сравнивает **байты** marker с собственной строкой, вычисленной из секрета
  первого сообщения. Слова Luna не используются как доказательство.
- В конце `drainContinuableChildren(parent, [childId])` освобождает выбранного
  резидентного child; Host удаляет marker и проверяет отсутствие файла/агента.
  Ошибка cleanup всегда исключает PASS. Таймаут 120 секунд служит только предохранителем
  на случай отсутствия штатного события, а не задержкой между ходами.

Секрет `CONTINUATION_SECRET:<uuid>` есть только в первом пользовательском сообщении child:
не в persona, не в системном тексте, не в имени файла и не во втором сообщении.
Ответ второго хода должен записать `CONTINUATION_OK:` и этот секрет. Проверяются
одинаковый session id, завершение обоих ходов, сохранение child между ходами,
каталог ровно `["write"]`, отсутствие Bridge/probe в child, lineage, реальный
успешный вызов `write`, точные байты и полный cleanup.

Только живой результат `POSTMAN_WORKER_CONTINUATION_PROBE_PASS` с
`verdict=CONTINUABLE_SPAWN_SUFFICIENT` доказывает эту гипотезу. Подставные тесты
проверяют алгоритм, но **не** являются архитектурным доказательством. Не запускать
Direct Postman и не объединять ветку автоматически.

## После эксперимента

Probe должен быть удалён из production patch. Если PASS подтверждён, следующий production design:

```text
Postman Leader
  -> worker_run (host-owned)
  -> ordinary spawn
  -> fixed Luna
  -> fixed Worker persona
  -> fixed Worker toolFilter
```

При этом `worker_run` уже отдельно получает artifact grant, isolated workspace, preview/browser
facade, evidence contract и cleanup semantics.
