POSTMAN_REQUEST_ID: REQ_20261103T033126Z_6286
Режим: WRITE_TEST. Область для чтения: C:\PROJECTS\Real-tactic-wargame
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:a65d727d-f0fd-4fca-bed5-f05fa0e2e268'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\a65d727d-f0fd-4fca-bed5-f05fa0e2e268\workspace. Исходная область только для чтения.
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
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\a65d727d-f0fd-4fca-bed5-f05fa0e2e268\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Параллельное узкое расследование CPU-регрессии стандартного Combat Lab (его 3D и 2D карта): пользователь сообщает средний FPS ~15 после merge, цель >=45. Твоя область — ТОЛЬКО simulation/perception/visibility/navigation/route-field и их вызовы из Combat Lab, без Babylon renderer анализа. Repo C:/PROJECTS/Real-tactic-wargame, exact base/main 3d9236709df952df03829acf8212324418785f0e (#40), first parent d64512c6ea0647a6a604b9f9af7ae117a0b95232. Последний merge 108 файлов +13511/-736, perception v4/общая очередь маршрутов/cover continuous navigation. За неделю значимы 98c1f6a (visibility profile key reuse), c8176c8 (nearby pressure sources/LOS scheduling), 96e7cea (async exact visibility/route fields), 6fbcdd9 (#36 perception v2), 90f9b4a (#38 near-side vision). Изучи соответствующие diff за 2026-10-27—2026-11-03: могла ли интеграция отменить FPS fix, вернуть units×cells/frame, cache churn, синхронные route/LOS builds, частые ненужные invalidation или очередь. Нужны конкретная причинная цепочка SHA/файл/символ/строки, минимальная правка и узкая regression-проверка сохранности восприятия/движения. Существующие scripts/perception_performance_smoke.mjs и danger_layer_movement_performance_smoke.ts могут подсказать workload, но НЕ запускай тяжёлые тесты/браузер/игру сейчас: основная линия выполняет FPS измерение, ты работаешь статическим анализом. Исторические FPS не baseline, не заявляй достижение >=45. Другой Postman один пишет в .worktrees/fps-regression-45; НЕ меняй исходники, refs, GitHub. Прочти README.md, DEVELOPMENT.md и docs/performance/PERFORMANCE_PRINCIPLES.md, docs/product/CORE_GAME_PRINCIPLES.md. Отчет сохрани в выданной частной папке результата, НЕ в исходном проекте, передай абсолютный путь в bell. Не повторяй общий рендеринг-аудит. Готово: конкретная регрессия/обоснованные кандидаты или исключение, предлагаемое минимальное изменение с сохранением gameplay semantics. После отчета остановись.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261103T033126Z_6286>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261103T033126Z_6286>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
