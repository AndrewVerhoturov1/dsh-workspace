POSTMAN_REQUEST_ID: REQ_20261121T134814Z_4503
Режим: WRITE_TEST. Область для чтения: C:\PROJECTS\Real-tactic-wargame
Перед любыми другими DevSpace-инструментами вызови open_workspace с path="C:\\Users\\Andrew\\AppData\\Local\\DSH\\Postman\\devspace\\ebb03ed3-db9e-49df-8ace-b690d2ff9c34\\workspace" и mode='checkout'. Назначенная область записи: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ebb03ed3-db9e-49df-8ace-b690d2ff9c34\workspace. Исходная область только для чтения.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace.
В этом REQ локальные Git-действия и GitHub push/PR/merge допустимы только при явном поручении, в назначенном репозитории и в пределах назначенной области записи. Если поручение не разрешает конкретное действие или репозиторий не определён, не выполняй его; запроси решение Leader. WRITE_TEST сохраняет исходную область только для чтения. Это уточнение для данного REQ имеет приоритет над общей фразой SKILL о выполнении commit/push/PR/merge отдельным местным маршрутом; условие REPO_POLICY «GitHub READ ONLY» применяется, если такое ограничение назначено этому REQ. Не обходи проектные ограничения, фактические права и защиту веток; разрешение не предоставляет доступа или credentials.
## Инструкции Host
instructions_sha256: 68975b840f17b768404006a369569426821c4a3bf62cb717d3cd08bce33900c5
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ebb03ed3-db9e-49df-8ace-b690d2ff9c34\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Найди и убери источник долгой физической работы поиска маршрута, не меняя доступность/качество пути и первый физический шаг. Подтверждённая горячая точка REL4: PhysicalMovementCollision.ts:292–333 verifiedPhysicalNavigationWaypoints в worker; измеряй число вызовов, реальных проверенных звеньев, долю повторов, время cold/warm. Работай в PhysicalMovementCollision/ядре pathfinding/контролируемом тесте; не меняй NavigationRouteReplanner, worker protocol/client и слой памяти — другая линия. Начни с безопасного bounded переиспользования идентичных направленных звеньев по точным концам, позе и ревизии геометрии, только если подтверждает A/B. Не пропускай авторитетную проверку пути, не ослабляй риск и не превращай pending в safe. Прежнее удаление повторного поиска RouteCostWorker отвергнуто: быстрый worker, но short-кейс не двигался за 120 тиков против первого шага на 37; не повторяй схему. Докажи на нативном Node worker и гибридном replay реальный первый шаг/безопасное продвижение до/после в коротком и двухфланговом Stage1, плюс wide и холодный запуск; чётко назови где лишь изолированный замер. Сравни diagnostic off/on отдельно. Без доказанного выигрыша/паритета изменение отклони, сохрани диагностику и точное объяснение. Основа 77dd10260a2c9f0f6167a22ef626794645c0b420 (проверенный origin/main); пользовательский worktree только на чтение. Изменения только в выданной частной области WRITE_TEST, без Git-записей, без обращений к игре пользователя на 5173 и без публикации. Оставь report.md с точными путями файлов, командами и результатами; выдай проверяемый узкий патч либо перечень исходных файлов с before/after SHA256. Для bell укажи reportRef. Не добавляй локальные ассеты, зависимости или инфраструктуру. 
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261121T134814Z_4503>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261121T134814Z_4503>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
