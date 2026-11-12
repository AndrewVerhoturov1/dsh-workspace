POSTMAN_REQUEST_ID: REQ_20261112T040949Z_3978
Режим: WRITE_APPROVED_TARGET. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\cellular-tactical-map-1x1-stages-1-2
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:7e15389c-0de8-4f1a-bffc-c84c25bab0cc'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\cellular-tactical-map-1x1-stages-1-2.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 97a9b6623720c0d5b34d64bb63d304efaa6aae0ed90235e0da68b0576c6cf874
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\cellular-tactical-map-1x1-stages-1-2\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\7e15389c-0de8-4f1a-bffc-c84c25bab0cc\signal.ps1' <done|need-decision|blocked> [-Message 'полный итог и проверки'] [-Report 'report.md']
Bell немедленно завершает получение результата: текст, написанный только после bell, не попадёт Leader.
Если используешь bell, передай содержательный итог и ограничения через -Message (до 16000 символов)
либо существующий -Report; в READ_ONLY новый файл отчёта создавать нельзя. Не отправляй пустой done.
Если поручение Leader явно требует только текст без bell, не вызывай bell: заверши обычным ответом в маркерах ниже.
## Поручение Leader
Git-подготовка трёх веток для параллельной работы. Исходники игры не менять.

Репозиторий: C:/PROJECTS/Real-tactic-wargame. Рабочая копия: C:/PROJECTS/Real-tactic-wargame/.worktrees/cellular-tactical-map-1x1-stages-1-2, ветка codex/cellular-tactical-map-1x1-stages-1-2, HEAD 6ef9a56080cb2a5d608a3e92e6bdeebd6d7ede09. В рабочей копии 35 изменённых и 41 новый незакоммиченный файл принятой работы по V2 — их нужно закоммитить.

Проверено: предыдущие попытки не изменили диск, файла docs/v2/koncept-v2-1x1.md нет, рабочих копий .worktrees/v2-geography-document, .worktrees/v2-route-pool, .worktrees/v2-scene-metric-roundtrip нет. Начинай с нуля и после каждого шага показывай фактический вывод команды.

1) cd в рабочую копию; git rev-parse --abbrev-ref HEAD; git rev-parse HEAD.
2) Скопировать C:/Users/Andrew/Downloads/koncept_v2_1x1.md в docs/v2/koncept-v2-1x1.md (каталог создать). Побайтово, UTF-8. Показать Get-FileHash -Algorithm SHA256 источника и копии.
3) git status --porcelain; подтвердить, что нет путей node_modules/, dist/, artifacts/, .env.
4) git add -A; коммит с сообщением: feat(v2): принятая работа по оконной карте + согласованная концепция V2 1x1. Push не делать. Показать SHA и git show --stat --oneline.
5) От этого SHA: git worktree add -b <ветка> <путь> <sha> для трёх пар: codex/v2-geography-document → C:/PROJECTS/Real-tactic-wargame/.worktrees/v2-geography-document; codex/v2-route-pool → .worktrees/v2-route-pool; codex/v2-scene-metric-roundtrip → .worktrees/v2-scene-metric-roundtrip.
6) В каждой новой копии: junction node_modules на уже установленный, чтобы не ставить зависимости заново — New-Item -ItemType Junction -Path <новый>/node_modules -Target <источник>. Источник: C:/PROJECTS/Real-tactic-wargame/.worktrees/cellular-tactical-map-1x1-stages-1-2/node_modules, если существует, иначе C:/PROJECTS/Real-tactic-wargame/node_modules. Указать фактический источник; затем в каждой копии показать git status --porcelain (ожидается пусто).

Ограничения: не править исходники игры; никаких push, merge, reset, clean, stash, force; ничего не удалять; не запускать и не останавливать dev-серверы на 5198 и 5199; не делать npm install.

Готово когда: базовый коммит создан, три рабочие копии стоят на нём, в каждой есть docs/v2/koncept-v2-1x1.md и работающий node_modules. Если Bash, запись на диск или доступ к папке недоступны — сразу напиши это обычным текстом с точной ошибкой, не выдавай задачу за выполненную.
## Обязательный формат итогового ответа
Итоговый ответ напиши строго между следующими точными маркерами этого задания.
При bell это копия уже переданного через -Message/-Report итога, а не отдельный канал доставки.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261112T040949Z_3978>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261112T040949Z_3978>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
