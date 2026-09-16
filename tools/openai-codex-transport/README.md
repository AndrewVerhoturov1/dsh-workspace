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

В Windows обнаружен включённый системный прокси `127.0.0.1:10809`; порт занят процессом `xray.exe`. Это внешнее HTTPS-перехватывание или прокси с неподтверждённым корневым сертификатом. Слой намеренно не отключает проверку TLS и не добавляет бесконечные повторы.

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

## Проверка

Изолированная проверка применения и отката:

```powershell
node tools/openai-codex-transport/test-overlay.mjs
```

Настоящее устранение `SELF_SIGNED_CERT_IN_CHAIN` выполняется в настройках прокси/антивируса/корневого сертификата Windows и не является частью этого слоя.
