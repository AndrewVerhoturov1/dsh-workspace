POSTMAN_REQUEST_ID: REQ_20261106T013718Z_4965
Режим: WRITE_ISOLATED. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\ai-cover-memory-cycle
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:a7cff4dd-f8cd-4383-900c-bc8f2af3ac52'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\ai-cover-memory-cycle.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 16ac58a3e8647ecacfa673b6e5d7bbffbd4460eb4ded6c02660fe99eb807292b
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\ai-cover-memory-cycle\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\a7cff4dd-f8cd-4383-900c-bc8f2af3ac52\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Изменения validation получены. Отказ прежнего status сейчас снят штатно: исходный исполнитель смог получить TREE_SETTLED результата; другой subgraph+typecheck job ещё проверяется им. Не запускай дубликат, если увидишь активный subgraph. Для текущих изменённых входов разрешён один обычный npm run subgraph:smoke, без обхода любых новых отказов. Запиши результат artifacts/ai-cover-validation-report.md, исходники в этом этапе не менять. Дополнительно нужен короткий READ_ONLY вывод по ранее найденному terrain/no-profile риску: действительно ли готовый cover_observation_cycle принимает тактический terrain слот без profileId, который затем неизбежно отклоняется pose_observe? Основной инженер назвал аналогичный тест неправильным fixture, но это не опровергает реальный formTerrainCoverSlots. Назови точную цепочку и минимальный необходимый вариант решения в рамках существующей физики (не искусственный профиль/поза). Проверь по коду, не запускать второй cover тест: основной инженер b82c4c87 сейчас меняет CoverPhysicalCycle/GraphCoverAction и гоняет graph-cover-terrain. Не писать его файлы и не повторять весь аудит. Конечный результат — smoke актуальной validation + конкретный вывод о terrain для решения Leader, затем обычный текст БЕЗ bell.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261106T013718Z_4965>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261106T013718Z_4965>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
