POSTMAN_REQUEST_ID: REQ_20261023T153953Z_6025
Режим: WRITE_ISOLATED. Область для чтения: C:\PROJECTS\Real-tactic-wargame-babylon-soldier-sandbox
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:ea723bc3-a136-43dc-ad15-c3d18dfadc8e'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame-babylon-soldier-sandbox.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 5069e94a4a6ebf783c44b5a6f6d9af1cbc2c23ab2871d6f1a768afb973c07801
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame-babylon-soldier-sandbox\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ea723bc3-a136-43dc-ad15-c3d18dfadc8e\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Заверши уже частично сохраненные исправления трех замечаний критика, без переписывания проекта. Workspace C:/PROJECTS/Real-tactic-wargame-babylon-soldier-sandbox, только sandbox/babylon-soldier. Прочти REVIEW-CODE.md и актуальные main.ts/core/simulation.ts/character/CharacterView.ts/tests/core.test.mjs. Раньше repair оборвался без отчета; его полномочия отозваны, внешнюю старую беседу не трогать. Worker обнаружил: simulation.ts shoot уже использует muzzlePoint(from,from.yaw), load больше не отвергает крутой склон под бойцом, setPosture выбирает промежуточный crouch для stand-prone; CharacterView содержит transition phase. Это НЕ доказанный PASS. Новых regression tests нет, REPAIR-REVIEW.md нет. Процессов repair/script/test с путем sandbox Worker не наблюдал; не повторять неизвестные процессы вслепую.
Нужно проверить сохраненные изменения и доделать лишь недостающее: 1) HP/cover должны опираться на актуальное simulation-owned muzzle, не stale renderer; 2) законно отредактированный terrain под бойцом должен сохраняться/загружаться без потери высот и ошибки; 3) stand->crouch->prone и обратно, без движения/стрельбы во время перехода, sim owns timings, pause/reset/death не застревают. Missing реальных клипов остаются PARTIAL, soldier.glb пока нет. Никаких new engines/универсальных FSM/соседних исправлений. Импортер/окружение/weapon уже готовы, не менять их. Сервер5181 работает, не перезапускать и не browser сейчас.
Добавь только три соответствующие focused regression shapes в существующий tests/core.test.mjs; выполни npm test,typecheck,build на конечных входах. Сохрани обязательный REPAIR-REVIEW.md с фактически исправленным/проверенным/оставшимся. Если сохранившаяся правка оказалась уже правильной, не менять ради переписывания. Не cleanup/Git/install/основная игра. По завершении будет отдельная проверка критиком. Стоп после этого ограниченного этапа.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261023T153953Z_6025>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261023T153953Z_6025>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
