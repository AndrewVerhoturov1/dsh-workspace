POSTMAN_REQUEST_ID: REQ_20261120T234221Z_1420
Режим: WRITE_TEST. Область для чтения: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ba5dda38-efc9-4b45-a5b4-286b394c9503\workspace
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:9ce44ab0-c462-471c-aa00-fcac7e9be1ba'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\9ce44ab0-c462-471c-aa00-fcac7e9be1ba\workspace. Исходная область только для чтения.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 10d2b65f7ea089d66d879130224a643977c2d7a9b47a28a497aefc233a01ea10
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/docs/workflow/TASK_CONTRACT.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\9ce44ab0-c462-471c-aa00-fcac7e9be1ba\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Линия B6: интегрируй исправление двух tile defects B5 на ПОЛНУЮ совместимую базу C3, сохрани exact commits. Dedicated read-only seed; в inputs/verified-danger-c3-b5/ используй danger-A-C-A2.bundle (HEAD 04ae0f63e45d35a269e1ed30a53a84ba3972f51c, ветка codex/danger-review, SHA256 80acb906db46013381706dd0a8070a9015655327f638a885af60b4c30aabdf19) и b5-delivery.patch SHA256 f51de1f202203e0cd7e8982e112de88fed7785e3011fcca33c5b6b00e27a196e; никакие иные inputs не читать. В своём writer используй git bundle verify и clone/reset-free checkout точной ветки, удалить только своё локальное bundle-origin если создано. Недостающие untracked sandbox и node_modules взять из разрешённого seed; проверить, что реальные public/*.v2geo, штатные scripts/HTML и sandbox доступны и правильные. Если bundle не включает требуемые игровые ассеты, воссоздай их только из разрешённых seed release patches или явно запроси другие scoped inputs, не подменяй данными. Сохрани exact A,C,A2 parent. Применить B5 ровно двумя файлами, не менять производственный смысл; A2 queue hunks сохранить. Проверь кандидат на полный официальные typecheck/build, real demand-tile acceptance, B5 parity/repro, display consistency, native scheduler, source/probe. Если обнаружится именно B5 регрессия/конфликт — минимальная поправка в двух затронутых файлах и объяснить. Важно: не выдавать новый tile sampling за full-map, измерить retained/rebuild counters и статусы. Отдельный локальный commit поверх 04ae0f6, product bundle + format patch + manifest, no remote/main/stable. Не VUDA, не сервер; C проводит baseline. Сохранить полноценный рабочий writer для следующего браузерного этапа. Отчёт с exact paths и стихийные фазы отдельно. Стоп.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261120T234221Z_1420>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261120T234221Z_1420>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
