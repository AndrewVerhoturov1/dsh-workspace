POSTMAN_REQUEST_ID: REQ_20261103T030753Z_8679
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
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\e05c38ae-f42a-4b05-bd3f-3dff75ee9faf\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Продолжи прежнее исследование регрессии FPS после прерывания Host. Пользователь явно просит продолжить. Сначала просмотри существующую историю этой беседы и фактически выполненные команды/процессы, используй уже собранные результаты; не повторяй исходный анализ или запуски вслепую. Цель прежняя: установить причину среднего FPS ~15 после последнего merge в Real-tactic-wargame, изучив все коммиты последних 7 дней, и подготовить минимальное исправление до >=45. Сейчас нужен конкретный анализ без правок исходников/refs: точные SHA, горячие файлы/символы, причинная связь, существующий сценарий сравнения и доказанные baseline-метрики если уже есть. Каталог C:/PROJECTS/Real-tactic-wargame. Worker отдельно готовит task worktree, Secretary — хронологию; не создавай веток. Прочти проектные README.md, DEVELOPMENT.md и принципы docs/performance/PERFORMANCE_PRINCIPLES.md и docs/product/CORE_GAME_PRINCIPLES.md если еще не читал. Сообщи что уже удалось установить и чего конкретно не хватает для исправления. Если используешь VUDA, после измерений перед анализом/ожиданием вызови доступный vuda_pause, но не во время активного замера. Остановись после отчета; не публикуй/merge.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261103T030753Z_8679>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261103T030753Z_8679>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
