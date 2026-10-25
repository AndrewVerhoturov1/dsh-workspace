POSTMAN_REQUEST_ID: REQ_20261025T105231Z_7202
Режим: WRITE_ISOLATED. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\babylon-sandbox-in-lab
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:1ce4f574-ccf5-4a22-9fc1-feebc88ae2e1'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\babylon-sandbox-in-lab.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 88a8dbd030810229d1e29fc7f56566ff22e4c7591747387293bdcaf6f174de0a
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\babylon-sandbox-in-lab\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\1ce4f574-ccf5-4a22-9fc1-feebc88ae2e1\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Продолжи текущую работу в том же worktree без повторения выполненной terrain/grid реализации. Уже установлено: REQ предыдущей части завершился bell DONE; прочитан artifacts/babylon-terrain-grid-result.md, Leader просмотрел babylon-terrain-grid-on-relief.png; изменены CombatLabBabylonGround.ts и CombatLabBabylonScene.ts. Surface/grid ещё не опубликованы. Успешные неизменённые smoke terrain/revision/materials не повторять. Действующий URL http://127.0.0.1:5192/combat-lab.html и сервер сохранить.

НОВОЕ прямое дополнение пользователя было поставлено в steer и осталось QUEUED, поэтому в отчёте его нет: «Еще размер солдат нужно соотнести с игрой, сейчас он как будто гигантский и поэтому перемещается лунной походкойс буксуя на месте так как в игре вроде скорость правильно расчитана. И высота юнита важна для попадий и промахов». Выполни эту недостающую часть сейчас.

Цель: единый реальный физический масштаб поверхности, soldier GLB/weapon и расчётного тела; согласовать изображение с существующей игровой геометрией для попаданий, не изменяя игровую скорость, баллистику или hit shape definitions ради картинки. Найди и измерь текущий путь GLB units/transform/root scale → Babylon metres; положение unit.position в клетках переводится через metersPerCell, а cellSize — только 2D world units, не дополнительный физический коэффициент. Точные источники: src/core/combat/UnitHitShapes.ts :23-31,48-103, используемые баллистикой per-part vertical cylinders в метрах: standing head top 1.78m, crouched 1.22m, prone .42m; standing torso radius .28m, crouched .27m, prone chest .27m, это не единая ширина целого тела. BallisticTrace использует intersectRayWithUnitHitShapes и m/m/s; UnitModel position grid, speedCellsPerSecond. Подтверди эти данные в назначенной копии. Визуальное тело должно разумно соответствовать этим габаритам/позам; из-за грубых цилиндров не требуем идентичность каждого пальца. Не деформируй конечности/не делай IK, runtime limb corrections запрещены; принятый дефект crawl не исправлять. Не добавляй dependencies или вторую симуляцию.

Проверь причину лунной походки: после верного масштаба фактическое расстояние за simulation time vs игра, и native locomotion cycle tempo/stride. Если нужно, минимально согласуй tempo существующего locomotion clip с текущей игровой скоростью/родным stride, НЕ меняя игровые скорости и НЕ меняя pose/hit/fire/reload clips. Не угадывай коэффициент на глаз и не заявляй отсутствие скольжения только по координатному тесту. Сохрани работу pause/step/скорость симуляции — анимация по simulation delta без wall-clock.

Done when: (1) измерены и согласованы модель стоя и расчётная standing height, проверены crouch/prone как минимум по размерам/grounding; размеры карты/клетки и игровой hit envelope указаны; (2) реальный приказ движения с наблюдением анимации и измерением game time/метров; честная оценка оставшегося визуального скольжения; (3) surface/grid не регрессировали. Сейчас terrain QA использовал injected PointerEvent и MapPaint function: для окончательной UI-приёмки сделай настоящие браузерные клики RMB на рельефе и существующим 2D редактором измени высоту/материал, вернись в 3D, screenshot с включённой/выключенной сеткой. Если реальная UI возможность недоступна, сообщи конкретно, не называй injection настоящим кликом. Заодно адресно выясни источник замеченных ERR_CONNECTION_REFUSED (чтобы отделить ошибки приложения от tooling; не чинить соседние инфраструктурные ошибки).

Внеси только минимальные необходимые renderer/character изменения. Уже сделанная terrain работа сохраняется. После последней кодовой правки typecheck/build один раз и относящиеся адресные проверки масштаба/паузы/движения; не запускать весь общий animation QA. Отчёт обнови в artifacts/babylon-terrain-grid-result.md добавленным разделом масштаб/проверки со свежими screenshot paths, changed files и точными измерениями; можно отдельные JSON. Нужен screenshot где сетка и нормальный масштаб солдата видны одновременно. Не публикуй Git/ассеты/артефакты, не делай merge, не останавливай действующий сервер, не трогай основной Pixi или sandbox reference. После критериев остановись. Если текущий масштаб уже правильный — докажи числами и исправляй только установленную причину, не уменьшай солдата произвольно.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261025T105231Z_7202>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261025T105231Z_7202>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
