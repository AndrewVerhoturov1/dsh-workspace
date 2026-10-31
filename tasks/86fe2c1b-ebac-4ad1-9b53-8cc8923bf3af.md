POSTMAN_REQUEST_ID: REQ_20261031T001809Z_8463
Режим: WRITE_ISOLATED. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\stage-1-3d-map-standardization-migration
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:86fe2c1b-ebac-4ad1-9b53-8cc8923bf3af'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\stage-1-3d-map-standardization-migration.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 42fffd563c895410edf8de80dbf1efba4a5350361901b6e63e1e5d6b60bed672
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/3d8c27c6dd853242193b375f5628fad95be9e159/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/3d8c27c6dd853242193b375f5628fad95be9e159/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/3d8c27c6dd853242193b375f5628fad95be9e159/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/3d8c27c6dd853242193b375f5628fad95be9e159/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\stage-1-3d-map-standardization-migration\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\86fe2c1b-ebac-4ad1-9b53-8cc8923bf3af\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Следующая ограниченная порция после принятого core-consumers-handoff: (1) согласованные editor-only metadata в MapModel; (2) проверить и при необходимости завершить реальную production movement интеграцию, которую handoff оставил непроверенной. Не повторять завершённую consumer порцию. Leader прочитал handoff, MapObjectGeometry, потребительские tests и focused PASS log.
1. Прочитай artifacts/stage1/editor-format-contract.md. Leader ПРИНЯЛ optional TacticalMapData/TacticalMap.stage1Editor и MapObjectData/MapObject.stage1Source ровно предложенных типов: paint/background recipe/source provenance, никакой второй height/physical collection. Добавь узкий общий файл типов/нормализации (например Stage1EditorMetadata.ts) и MapModel.ts fields/normalization. Не импортируй тяжёлый Stage1EditorMap в MapModel (опасен cycle), используй type-only/чистые type validator зависимости. Строгая проверка input boundary finite/allowlist/bounds1600strokes, copy metadata, никаких physics revisions из paint. Не Stage1EditorMap/catalog/editor/SceneSnapshot: их владельцы отдельно. Сообщи exact new exports через artifacts/stage1/editor-metadata-api.md сразу, затем movement.
2. Реальный SimulationTickLegacy и штатные пользовательские move orders: сейчас MapObjectGeometry exact функции требуют optional map; найди относящиеся production path callsites, которым map ещё не передаётся, collision сегменты и feet/slope checks. Проверь не только A* grid, а фактическое движение отдания команды→simulation ticks по новой карте: обход C02, sphere side, rotatedB03, barrier gaps, движение на hills/ложбине. Минимально подключи оставшиеся места к ТОЙ ЖЕ точной библиотеке, сохраняя budget/pathfinding/AI. Не второй continuous simulation. Поза радиус/высота физически согласованы; без прохождения/телепортаций в тело. Тесты через real state/tick/order APIs, не mock геометрии. Проверь текущую производственную LOS/баллистику в этих real tick сценариях если затрагиваешь. Scope core simulation movement/нужные consumers только, не GameApplication/UI/render/editor/SceneSnapshot/workers/fingerprint.
Метаданные станут нужны main/render и serial; API коротко запиши прежде долгих tests. Targeted tests + typecheck, не повторять все12unchanged smoke. Прежний static-tactical-persistent FAIL отдан владельцу SceneSnapshot для содержательной коррекции test, не переставлять imports ради маркера. Latest user: new visuals own simplified lowpoly/no pack, ±15%visual only, exactphysics. По завершении artifacts/stage1/production-movement-handoff.md и stop без Git/browser/server.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261031T001809Z_8463>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261031T001809Z_8463>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
