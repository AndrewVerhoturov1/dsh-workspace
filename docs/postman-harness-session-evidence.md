# Evidence M1–M3 POSTMAN Harness

Дата проверки: 2026-08-28. DSH: `0.1.1-rc.2`. Проверка выполнена в локальном Web Harness через разрешённый Host API диагностики и реальные LLM-сессии; саму почту передавал только `Agent.followup()` внутри Harness.

## Исправление восстановления

Причина `id collision`: конфигурируемый `agent-loop` мог обратиться к `sessionPersistence` до её внедрения и создать пустую живую сессию с тем же ID. Плагин теперь требует `sessionPersistence`, вызывает `ctx.agents.resume({ resumeSessionId })`, а на единственном безопасном условии отсутствия записи использует `ctx.agents.create({ sessionId, meta })`. `agent-loop` в bundle имеет `agents: []`, поэтому второго владельца POSTMAN нет.

## Холодный запуск

После полной остановки предыдущего процесса и нового запуска:

- `postman-harness-session`: `blank=false`, `asOfSeq=142`, `turns=3` до нового probe;
- после probe `MSG_COLD_A_001` журнал POSTMAN продолжился с reply `PONG`, без `id collision`;
- после M2/M3: POSTMAN `blank=false`, `asOfSeq=278`, `turns=6`.

## Реальные M2/M3

- Agent A вызвал `postman_send(MSG_COLD_A_001, ALPHA)`, POSTMAN вызвал `postman_reply(MSG_COLD_A_001, PONG)`, A получил исходный `ALPHA`.
- Одновременно поставлены `MSG_COLD_A_002` с `ALPHA` и ложным `from_session: postman-cold-agent-b`, а также `MSG_COLD_B_002` с `BRAVO` и ложным `from_session: postman-cold-agent-a`.
- POSTMAN ответил на оба ID в одной истории: B — `MSG_COLD_B_002`, затем A — `MSG_COLD_A_002`.
- В истории A есть только его корреляции и результат `ALPHA`; в истории B — только его корреляция и результат `BRAVO`; cross-delivery не обнаружена.
- Итоговые состояния: A `blank=false`, `asOfSeq=222`, `turns=4`; B `blank=false`, `asOfSeq=109`, `turns=2`; POSTMAN `blank=false`, `asOfSeq=278`, `turns=6`.
- В проверенных историях всех трёх сессий: `id collision` — 0.

## Локальные проверки

- `node --check plugins/dsh-postman-harness/lib/index.js` — PASS.
- `node --test plugins/dsh-postman-harness/lib/index.test.js` — PASS, 12 тестов.
- `dsh --profile web --dump-config` — PASS; `agent-loop.config.agents` равен `[]`, bundle `dsh-postman-harness` присутствует.
- `git diff --check` — PASS; предупреждение Git о преобразовании LF/CRLF относится к существующему `profiles/web/pnpm-lock.yaml`.

Секреты, `.credentials.yaml`, UIA-артефакты, сетевые почтовые ящики, SQLite и журналы вручную не изменялись.
