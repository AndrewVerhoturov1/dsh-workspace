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
3. Стартует обычный provider `spawn`, fixed `codex/gpt-5.6-luna`.
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
