# Evidence M1–M3 POSTMAN Harness

Дата проверки: 2026-08-29. DSH: `0.1.1-rc.2`. Проверка выполнена в локальном Web Harness через разрешённый Host API диагностики и реальные LLM-сессии; саму почту передавал только `Agent.followup()` внутри Harness.

## Исправление восстановления

Причина `id collision`: конфигурируемый `agent-loop` мог обратиться к `sessionPersistence` до её внедрения и создать пустую живую сессию с тем же ID. Плагин теперь требует `sessionPersistence`, сначала выполняет `inspect()`, затем вызывает `ctx.agents.resume({ resumeSessionId })` для существующей записи, а `ctx.agents.create({ sessionId, meta })` разрешает только при точной ошибке «сессия не найдена». Ошибки persistence приводят к отказу запуска без создания пустого владельца. `agent-loop` в bundle имеет `agents: []`, поэтому второго владельца POSTMAN нет.

## Холодный запуск

После полной остановки предыдущего процесса и двух самостоятельных запусков:

- первый новый процесс поднялся на `127.0.0.1:3080` с новым PID; после восстановления `postman-harness-session` сохранила `blank=false` и прежний журнал до `seq=279`;
- затем был выполнен реальный M2/M3-прогон; журнал POSTMAN продолжился до `seq=416`, без `id collision`;
- второй запуск выполнен уже в обычном режиме, без временного overlay; новый процесс снова поднял порт, а `postman-harness-session` сохранила `blank=false` и тот же хвост `seq=416`.

## Реальные M2/M3

- Agent A вызвал `postman_send(MSG_RESTART_A_001, ALPHA_RESTART)`, POSTMAN вызвал `postman_reply(MSG_RESTART_A_001, PONG)`, A получил `POSTMAN_PROBE_RESULT` с исходным payload.
- Почти одновременно поставлены `MSG_RESTART_A_002` с `ALPHA_M3_RESTART` и ложным `from_session: postman-verify-b`, а также `MSG_RESTART_B_002` с `BRAVO_M3_RESTART` и ложным `from_session: postman-verify-a`.
- POSTMAN ответил на оба ID; A получил только `MSG_RESTART_A_002`, B — только `MSG_RESTART_B_002`.
- В истории A нет `BRAVO_M3_RESTART`, в истории B нет `ALPHA_M3_RESTART`; cross-delivery не обнаружена.
- Итоговые состояния прогона: A `blank=false`, `asOfSeq=203`, `events=204`; B `blank=false`, `asOfSeq=132`, `events=133`; POSTMAN `blank=false`, `asOfSeq=416`, `events=417`.
- В проверенных историях всех трёх сессий: `id collision` — 0.

## Локальные проверки

- `node --check plugins/dsh-postman-harness/lib/index.js` — PASS.
- `node --test plugins/dsh-postman-harness/lib/index.test.js` — PASS, 15 тестов; добавлены проверки лимита pending-таблицы, scoped `allow: []`, очистки при уничтожении отправителя и отказа при ошибке persistence.
- `dsh --profile web --dump-config` — PASS; `agent-loop.config.agents` равен `[]`, bundle `dsh-postman-harness` присутствует.
- `git diff --check` — PASS; предупреждение Git о преобразовании LF/CRLF относится к существующему `profiles/web/pnpm-lock.yaml`.

Секреты, `.credentials.yaml`, UIA-артефакты, сетевые почтовые ящики, SQLite и журналы вручную не изменялись.

## Исторический сбой и итог

Ранее при запуске действительно наблюдался `id collision`: старый путь мог перейти к `create()` после временно пустого ответа persistence. После замены на строгую последовательность `inspect()` → `resume()` и повторной проверки с двумя холодными запусками этот сбой не воспроизвёлся.

Первый старт после остановки временно обходил сломанный локальный путь зависимости Flowglass; пакет был найден в локальном хранилище DSH, ссылка восстановлена, а финальный запуск выполнен штатно с включённым Flowglass. Журнал сессии и его файлы не изменялись вручную.

Итог: `POSTMAN INTERNAL MAIL M1-M3 READY`.
