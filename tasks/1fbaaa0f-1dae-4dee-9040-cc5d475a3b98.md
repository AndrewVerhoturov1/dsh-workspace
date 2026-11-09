POSTMAN_REQUEST_ID: REQ_20261109T225509Z_1831
Режим: READ_ONLY. Область для чтения: C:\PROJECTS\Real-tactic-wargame
Сначала открой назначенную область обычным open_workspace с path="C:\\PROJECTS\\Real-tactic-wargame". В READ_ONLY не используй postman-writer. Записи в любые файлы запрещены, кроме bell ниже.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 768065a9f45863a319e049b97c0833c598489d11c5f9b3345037f6b3d492bc9d
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\1fbaaa0f-1dae-4dee-9040-cc5d475a3b98\signal.ps1' <done|need-decision|blocked> [-Message 'полный итог и проверки'] [-Report 'report.md']
Bell немедленно завершает получение результата: текст, написанный только после bell, не попадёт Leader.
Если используешь bell, передай содержательный итог и ограничения через -Message (до 16000 символов)
либо существующий -Report; в READ_ONLY новый файл отчёта создавать нельзя. Не отправляй пустой done.
Если поручение Leader явно требует только текст без bell, не вызывай bell: заверши обычным ответом в маркерах ниже.
## Поручение Leader
Адресно найди минимальный необходимый diff для обязательного локального обновления подготовленной карты, не общий аудит и не реализация сейчас. Обязательный документ C:/Users/Andrew/Downloads/wargame_task_mandatory.md read-only п1,5,10; project README/AGENTS/DEVELOPMENT/performance. Base main2705b1c0f36c2d36b3a56b147fbc1a49a8041a71; source root толькоread. MapRuntimeState уже хранит dirtybounds, preparedstatic/VisibilityRayKernel/RouteCostWorkerClient глобальныеrevision могут очищать всё. Из прошлых данных конкретный candidate: RouteCostWorkerClient map snapshot serializes wholemap chunk2048 after any maprevision and clearsready, хотя объектодин изменён. Но та же карта в displayworker и fieldcache может уже иметь локальноеinvalidating; найди actual dependency прежде чем предлагать delta. Нужно: newphysicalquery uses sharedpreparedstatic, identicalphysicalinputs reuse; одинobject/mapcell edit меняет только нужную подготовку/зависимыеответы, действительноglobal меняетвсё. Сохранять дальний blocker вдольray, не arbitrarylocalcircle. Установи exact existing hooks MapRuntimeState.ts/PointVisibility.ts/VisibilityRayKernel.ts/RouteCostWorkerClient и worker mapprotocol, smallest firstconcretechange с показателем affectedcells/no fullstaticrebuild и stale safety. Никакой второйmap/cache/service/universalqueue, не новое infrastructure. B сейчас меняет ThreatEvaluation/SoldierDangerField, C displayworker, A diagnostics/navigation; нужные ownershipcrossings перечисли, не editfiles. Прежние source findings использовать, не повторять N10audit. Done concretepatchplan поexistingmechanisms, exact files/invalidation/tests, ограничения singlemapglobal vs genuinelylocal. NoGitcommands/fetch/refs/sourcewrites/tests/browser/GPU/servers/30/100. ASCIIEnglishreport, никакойFPSclaim.
## Обязательный формат итогового ответа
Итоговый ответ напиши строго между следующими точными маркерами этого задания.
При bell это копия уже переданного через -Message/-Report итога, а не отдельный канал доставки.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261109T225509Z_1831>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261109T225509Z_1831>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
