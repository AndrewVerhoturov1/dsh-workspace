POSTMAN_REQUEST_ID: REQ_20261025T011700Z_3394
Режим: WRITE_ISOLATED. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\babylon-mvp-combat-lab
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:1fe3b12c-bc0e-48ea-b50e-c0cd1dc131dd'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\babylon-mvp-combat-lab.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 1d01fca3b22dd4d257291a22d2dcd71aa1556e2e36c58d549dc01fbd62348c3e
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/9d8a7adfd87f1ebd5dc6c75d2745059065ae33b2/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\babylon-mvp-combat-lab\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\1fe3b12c-bc0e-48ea-b50e-c0cd1dc131dd\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Заверши уже реализуемый Babylon-MVP Combat Lab. Пользователь требует Postman, разрешил автономную ночную работу/тесты/коммиты. Другая беседа c907a28b потеряла соединение, все её назначения отозваны и линия закрыта; Sol отменён по выбору пользователя. Ты единственный назначенный writer. Не начинай перенос заново: сначала checkpoint, diff, тестовые отчёты и состояние процессов.
Task C:/PROJECTS/Real-tactic-wargame/.worktrees/babylon-mvp-combat-lab, codex/babylon-mvp-combat-lab, base 6cc59599ed678e4dcc9737e63fa850e6f74e15dc. Есть 31 tracked изменённый файл и 5 новых src/combat-lab/babylon/*: CombatLabBabylonBoard/Map/Units/Overlays/PointerCoordinates. GameApplication выбирает Babylon только для лаборатории, main остаётся Pixi, подключены CharacterView из sandbox и Babylon 8.0.0. В artifacts/babylon-mvp-progress.md старый snapshot typecheck/build:app PASS, но позже изменялись 16 smoke scripts, main/Extension/WorkspaceTabs/vite.config, найден combat-lab-runner-smoke-failure.txt. Найди/прочитай текущие артефакты и diff, установи результаты и ошибки, не повторять слепо npm/tests/сервер. Не откатывай поздние изменения.
Цель: полностью Babylon-сцена лаборатории на нынешней лабораторной карте; плоский рельеф допустим. Прежние панели/редакторы/управление/диагностика должны работать. Игровая симуляция единственная: CombatLabVisualSession, не SandboxSimulation; графика не определяет попадания/LOS/урон. Main игра остаётся Pixi, 5181 не менять. Запрещены IK/runtime-коррекции конечностей и публикация приватных моделей. Используй готовую реализацию, исправляй минимально, без нового render framework.
Необходимая приёмка: выделение/приказы/камера/радиальное меню, редакторы участников/программы/карты/маркеров, 11 diagnostic+существующие тактические слои, реальные состояния/анимации солдат, пауза/шаг/скорость/сброс/контрольная точка. События не дублировать, анимации синхронизировать с игровым временем. Видимые кнопки не оставлять фиктивными. Изменённые smoke должны сохранять семантику, только напрямую отменённые Pixi contracts заменить Babylon. Основную игру не ломать.
Private GLB task/public/assets/local/soldier-grip-approved.glb и m1-garand.glb уже скопированы и исключены Git. Локальные public/dist допустимы, публичная публикация запрещена. Источники в соседних копиях не трогать. Не показывать M1 под видом другого оружия; недостающий тип — честный технический вид.
Доведи до работающего браузерного результата. Сначала установи текущие процессы, затем отдельный Vite strictPort из task cwd на свободном порту; не трогать чужие 5181/8787/8799/5176/5185/5186, общий launcher запрещён. Сохрани background job_id. Проверь точный /combat-lab.html браузером и main Pixi страницу на том же сервере, screenshot и отчёт в task/artifacts. Если browser tool отсутствует — сообщи точно и продолжай доступные проверки. Сервер готового результата оставить работающим.
Проверки: актуальные typecheck/build:app; combat-lab:smoke, combat-lab-experiment:smoke, combat-lab-scenario-editor:smoke; относящиеся runner/scenario, существующий failure исследовать. Детерминированный сценарий/seed/команды должен сохранять digest независимо от рендера; соразмерные lifecycle/performance. Не повторять PASS без новых входов, не чинить соседние старые failures. Сборка не заменяет UI.
По этапам обновляй artifacts/babylon-mvp-progress.md, команды/результаты/jobs/следующий шаг. Git commit/push сделает отдельный локальный Worker после приёмки; сам не публикуй. Финальный результат полным обычным текстом без bell: что сделано, проверки, URL, скриншоты, job IDs, ограничения. Продолжай реализацию до готового MVP, не только анализ/план.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261025T011700Z_3394>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261025T011700Z_3394>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
