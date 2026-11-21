POSTMAN_REQUEST_ID: REQ_20261121T131405Z_3216
Режим: READ_ONLY. Область для чтения: C:\PROJECTS\Real-tactic-wargame
Сначала открой назначенную область обычным open_workspace с path="C:\\PROJECTS\\Real-tactic-wargame". В READ_ONLY не используй postman-writer. Записи в любые файлы запрещены, кроме bell ниже.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace.
READ_ONLY запрещает локальные Git-операции с записью и любые удалённые изменения, включая commit, push, PR и merge, даже если поручение их просит. Исключение для записи — только выданная команда bell.
## Инструкции Host
instructions_sha256: 68975b840f17b768404006a369569426821c4a3bf62cb717d3cd08bce33900c5
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\b3f1adf2-ebe6-4c5e-b9f6-91dc6a4b535c\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Разбери в Combat Lab связь NavigationRouteReplanner, RouteCostWorker и текущего поля угроз. Сценарий игрового NPC: цель за холмом, один контакт справа и три слева; при смене видимости маршрут раскачивается, иногда долго стоит. Найди места для стабилизации выбора маршрута и точки измерения причин простоя отдельно от знания NPC. Укажи пути:строки, инварианты безопасности движения и минимальные тесты. Не объявляй причину подтверждённой без воспроизведения; без правок и запуска игры.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261121T131405Z_3216>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261121T131405Z_3216>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
