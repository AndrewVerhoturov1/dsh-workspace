# Исправление связи `openai-codex`

Этот слой предназначен только для установленной связки:

- `@deepseek-ai/dsh@0.1.1-rc.2`;
- `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`;
- `@earendil-works/pi-ai@0.82.1`.

Он не обновляет пакеты, не меняет PTC, модель, каталог моделей или учётные данные.

## Что подтверждено

У свежего сбоя `transport:auto` зафиксирована цепочка:

```text
WebSocket error
→ переход на SSE
→ TypeError: fetch failed
→ cause.code: SELF_SIGNED_CERT_IN_CHAIN
```

Причина `SELF_SIGNED_CERT_IN_CHAIN` подтверждена на Windows 10. При прямом TLS-соединении к `chatgpt.com` Node получает сертификат, выпущенный `AO Kaspersky Lab / Kaspersky Anti-Virus Personal Root Certificate`. Этот корень присутствует в `CurrentUser\Root` и `LocalMachine\Root`, но обычный набор CA Node его не использует. В результате контрольный тест дал `13 PASS / 7 SELF_SIGNED_CERT_IN_CHAIN`, а с `NODE_USE_SYSTEM_CA=1` — `20 PASS / 20`.

`127.0.0.1:10809` принадлежит Happ/Xray и отвечает на HTTP CONNECT. DSH не получает этот адрес из `HTTP_PROXY`/`HTTPS_PROXY` и не меняет настройки VPN. Через явный CONNECT приходит обычная цепочка Google Trust Services. Исправление ниже действует только на окружение запускаемого DSH-процесса.

Слой намеренно не отключает проверку TLS и не добавляет бесконечные повторы.

Отдельно подтверждён дефект жизненного цикла: после ошибки WebSocket сессия навсегда закреплялась на SSE до завершения процесса. Теперь SSE используется только для текущего запроса, а следующий запрос снова проверяет WebSocket.

## Применение

Сначала проверить установленную связку:

```powershell
node tools/openai-codex-transport/apply-overlay.mjs --verify --root "$env:APPDATA/npm/node_modules/@deepseek-ai/dsh"
```

Применить с резервной копией:

```powershell
node tools/openai-codex-transport/apply-overlay.mjs --apply `
  --root "$env:APPDATA/npm/node_modules/@deepseek-ai/dsh" `
  --backup-dir "$env:USERPROFILE/.dsh/_codex-backups/openai-codex-transport-overlay"
```

После применения перезапустить DSH штатным контроллером. Скрипт останавливается при несовпадении версий или структуры файлов.

## Откат

Откат возможен только если установленные файлы не менялись после применения:

```powershell
node tools/openai-codex-transport/apply-overlay.mjs --rollback `
  --manifest "$env:USERPROFILE/.dsh/_codex-backups/openai-codex-transport-overlay/manifest.json"
```

После переустановки DSH слой нужно применить заново. Резервная копия содержит только три изменённых файла, без ключей и содержимого `.credentials.yaml`.

## Доверие к Windows CA только для DSH

Репозиторный контроллер запускает дочерний DSH с `NODE_USE_SYSTEM_CA=1`. Глобальное окружение Windows, VPN, Happ/Xray, хранилища сертификатов и Kaspersky не изменяются.

Проверка контроллера:

```powershell
node --test tools/deepseek-harness-launcher/dsh-process-controller.test.js
```

Откат этого изменения — обычный откат локального коммита. При штатном запуске контроллера переменная снова добавляется только в окружение DSH, а не в открытый терминал или системные настройки.

## Проверка

Изолированная проверка применения и отката:

```powershell
node tools/openai-codex-transport/test-overlay.mjs
```

Проверка TLS остаётся включённой: используются стандартные CA Windows через штатную возможность Node, без `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized=false` и без изменения VPN или системного trust store.
