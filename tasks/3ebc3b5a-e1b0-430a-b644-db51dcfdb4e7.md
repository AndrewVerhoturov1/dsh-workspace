POSTMAN_REQUEST_ID: REQ_20261121T102825Z_3853
Режим: WRITE_TEST. Область для чтения: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\7cd5b7c7-682a-4936-a4bb-3eda2aef76d6\workspace
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:3ebc3b5a-e1b0-430a-b644-db51dcfdb4e7'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\3ebc3b5a-e1b0-430a-b644-db51dcfdb4e7\workspace. Исходная область только для чтения.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 10d2b65f7ea089d66d879130224a643977c2d7a9b47a28a497aefc233a01ea10
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/docs/workflow/TASK_CONTRACT.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\3ebc3b5a-e1b0-430a-b644-db51dcfdb4e7\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
FPS-A/B: пользователь подтвердил медленный FPS в Combat Lab 3D. На уже работающем 50220 Stage1 3 rifles/MG seed9051, combatLab-BLHGjCgi.js SHA a3337bbafa3d80215fa77670ff3b64669fa8928ed35c43d860f42bfc5f491f58, сделай короткий одинаковый VUDA Local CPU A/B без исходных или build изменений. 1440×773 DPR1, hardware WebGL2, один и тот же снимок камеры (порядка 264 м), модели 5 и декоративные местные объекты как уже проверено. Установи via действительный UI/поддерживаемые диагностические переключатели фиксированные camera/resize/time-scale, небольшие одинаковые окна после прогрева, различи ×1/×10 и паузу, scene-render-cpu, fixed-step, кадры p50/p95, draw calls, активные meshes, shadow casters. Если в продукте есть штатный toggle качества/теней/декораций или иной уже существующий узкий A/B, проверь один такой рычаг отдельно (не меняй проект и не выдумывай доступ); сопоставь Camera LOD/shadow/terrain/material path в CombatLabBabylonScene и принеси одну конкретную точку оптимизации с уровнями доказательства. Не меряй GPU по CPU; тени/видеокарту не объявляй доказанной причиной без сравнительного измерения. Используй проверенный Forced Danger для слоя при A/B, не выдавай текущую ветку 50220 за DC7 (та ещё не собрана). Если vuda renderer metrics capability падает, сохрани partial, не обещай ускорение. Новых серверов, патчей, деплоя/commit/remote writes нет; report/json/кадры в своём writer; один активный VUDA. Пока ты меришь, параллельно чинят отмену игрового приказа; не смешивай FPS со временем расчёта маршрута.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261121T102825Z_3853>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261121T102825Z_3853>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
