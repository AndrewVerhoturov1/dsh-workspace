POSTMAN_REQUEST_ID: REQ_20261104T045830Z_7300
Режим: WRITE_ISOLATED. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\full-cover-system
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:eaaede02-b54e-4c0d-81c4-4f0764d9dabc'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\full-cover-system.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 91f1e53f3462363bd8273209adb59323c833395cc61d81ef7ec84c325fabdd35
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\full-cover-system\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\eaaede02-b54e-4c0d-81c4-4f0764d9dabc\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Performance43987a78 принято Leader; больше измерений не запускать. Только завершение собственных временных DEV-серверов по exact native job ID после проверки текущих записей: candidate :5186 job214a2b02-77a6-4621-8924-0315543fb98e; baseline :5185 jobb4027960-07c6-479c-a82e-da0883729995. Они запускались вашей perf-линией и больше не нужны. Сначала status exact jobs и получить оставшийся вывод, затем штатный native stop только если ещё работают; записать фактическое terminal process состояние. Не process-kill по порту/имени, не чужие браузеры/DSH/Orca. Если отказ ownership — точный refusal, не обходить. Userpreview :5184 НЕ ОСТАНАВЛИВАТЬ. Браузер уже about:blank, заново не открывать. Source/dist/raw/reports/Git не менять: локальный Worker публикует53sourcepaths. Только короткий artifacts/cover-performance-servers-final.md с exact stop/status receipts допустим. Не удалять baselineworktree/junction/node_modules/артефакты. Done две точные записи состояния своих тестовых серверов; остановиться.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261104T045830Z_7300>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261104T045830Z_7300>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
