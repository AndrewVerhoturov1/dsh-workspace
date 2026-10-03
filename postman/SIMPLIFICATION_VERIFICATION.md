# Проверки упрощения Postman

## Изменения

- Recovery: доказанный failed REQ, exact same-chat lookup, одна durable попытка до публикации/Send. Ask сохраняет text envelope; Image поддерживает existing chat и generation/packaging-only recovery с read-only proof исходного image assistant.
- Reminders: абсолютные 10/20/30/40/50 минут, без WORKING-only/streaming-text gates; exact user/composer ownership и UNKNOWN STOP сохранены. Connection: один best-effort reload на непрерывный banner.
- Downloads: transfer вне global lock, короткие CDP mutation locks, browser-wide GUID directory, exact page/request/event proof и один click. ZIP: стандартный bounded Python zipfile, общий reader для validation/image extraction/Leader unpack.
- Inputs: 48 MiB/file, 144 MiB aggregate, 150 MiB input ZIP, bounded metadata locate, selected pack/list/unpack в существующем Leader tool, 1–7 native image refs. Generic current files проходят private staging только при наличии настоящего Host readFile.
- Leader: read_image по усмотрению, existing/new Worker choice; exact addressed Worker stop без approval/reason, без rollback/Git cleanup и влияния на peers.
- External author: 7 коротких разделов вместо 423 строк.

## Удалено

- system_recovery.py и активная Additional Processing цепочка Stop/reload/wait/continue.
- CONNECTION_WAITING и consume-reminder recovery paths, прежний terminal whitelist и budget двух automatic continuations.
- Запрет Image --chat, ограничение одним reference, full-transfer download lock, bespoke JS ZIP parser и ratio hard gate.

## Выполненные проверки

- Web Python: полный прогон 431 tests, OK, 1 skipped (opt-in live CDP). После последних изменений: observer 75/75, bridge 17/17, reminders 21/21 PASS. Это отдельные прогоны, не суммируются.
- Direct Python: полный прогон 114 tests, OK, 1 skipped. После последних изменений Direct 29/29, Ask 9/9, archive 3/3 PASS.
- Web Node: 20/20 PASS.
- Host Node: полный прогон 433 tests, 426 PASS / 7 FAIL. Устаревший documentation assertion исправлен и его suite 12/12 PASS. Оставшиеся 6 failures в postman-worker-n2.test.js и postman-worker-real-cycle.test.js воспроизведены на неизменной базе 9cf51799a312da337c557494703e2c8791a46b44: установленный SDK отвергает context-global tools.restrict(). Не заявляется общий Host PASS.
- Host targeted: 100/100 PASS; после финального multi-image handoff исправления native-current/input suites 31/31 PASS, включая реальный private builder с 2 и 7 refs и available generic readFile adapter.
- git diff --check PASS.

## Реальный браузер / ограничения

- Opt-in CDP test: PASS на изолированном headless Chrome и local HTTP, без ChatGPT и рабочего browser profile. 5 attach/detach download cycles, затем 4 overlapping transfers; one click each, 61558 bytes each, SHA-256 21013655f6e464e8fcf3b7dae8d7a2c859fac4f2c4ae2bc3a8757a29933242a6; overlap 0.5405272000352852 s.
- Failed sent recovery, one-shot budget, Ask, Image generation/packaging-only, reminders, 7 image refs: covered by deterministic unit/integration test; live trigger unavailable. Не заявляется live ChatGPT E2E.
- Установленный SDK предоставляет image-only readImage, не generic readFile. Generic current files в этой установке остаются capability-unavailable; private adapter проверен с доступным native readFile. Это внешнее ограничение, а не доказанная работа generic attachments в установленном runtime.
- Shared GUID download directory сохраняется; автоматическая уборка abandoned GUID files не добавлялась.
- Изменения только в task worktree. Merge, deploy, production Postman trigger и permanent runtime edits не выполнялись.
