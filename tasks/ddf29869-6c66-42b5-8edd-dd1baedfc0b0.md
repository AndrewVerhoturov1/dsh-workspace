POSTMAN_REQUEST_ID: REQ_20261110T060047Z_3470
Режим: WRITE_APPROVED_TARGET. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\combat-lab-diagnostics-a-20261110
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:ddf29869-6c66-42b5-8edd-dd1baedfc0b0'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\combat-lab-diagnostics-a-20261110.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: fcc9c087b341a69aa473eb7ddc47c106e62a201fee10331456bebf6ae131facc
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ba417a39240a0aa1c1ced8af4f2e72cace9bee8a/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\combat-lab-diagnostics-a-20261110\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ddf29869-6c66-42b5-8edd-dd1baedfc0b0\signal.ps1' <done|need-decision|blocked> [-Message 'полный итог и проверки'] [-Report 'report.md']
Bell немедленно завершает получение результата: текст, написанный только после bell, не попадёт Leader.
Если используешь bell, передай содержательный итог и ограничения через -Message (до 16000 символов)
либо существующий -Report; в READ_ONLY новый файл отчёта создавать нельзя. Не отправляй пустой done.
Если поручение Leader явно требует только текст без bell, не вызывай bell: заверши обычным ответом в маркерах ниже.
## Поручение Leader
Заверши два конкретных оставшихся дефекта команд движения в существующей реализации. Рабочая папка C:/PROJECTS/Real-tactic-wargame/.worktrees/combat-lab-diagnostics-a-20261110. Уже существуют и прошли адресные тесты A→B без паузы, late A, pause/cancel, остановка A при устаревших личных данных. Читай artifacts/command-liveness-report.md и точные исходники. Сейчас CombatLabVisualSession.ts:626–641 после MAX_INTERACTIVE_MOVE_RETRIES=2 вызывает failPendingMove, удаляет принятое намерение B и требует повторного клика. Это НЕ принято: меняющаяся информация об угрозе не должна уничтожать достижимый приказ. Убери произвольный cap/терминальный отказ из-за одной лишь устарелости данных. Сохраняй тот же id/цель B и безопасное удержание ног; используй существующий общий Worker/его очередь и её справедливость, без отдельного таймера/очереди/пула, без синхронного A*, без stale игрового результата. После стабилизации данных B должен автоматически начать движение без повторной команды. Настоящий актуальный отрицательный план/смерть/отмена/ошибка потока остаются отличимыми конечными исходами. Сам выбери минимальный способ в существующей машине; не превращай изменение цены угроз в бесконечное голодание. Второе: beginAsyncCombatLabMoveOrder в RoutedMoveOrders.ts сейчас не устанавливает command.pendingRoute, но CombatLabBabylonScene.ts:1719 проверяет его. Обеспечь единое честное pending-представление B и в 3D (старый A отдельно), с корректным завершением/restore/cancel. Разрешены записи только src/combat-lab/runtime/CombatLabVisualSession.ts, src/core/orders/RoutedMoveOrders.ts, при реальной необходимости src/combat-lab/rendering/CombatLabBabylonScene.ts и существующие command_move_liveness_smoke.ts/.mjs, отчёт artifacts/command-liveness-final-report.md. Параллельно другие исполнители меняют расчёты awareness/tactical/navigation; их файлы не трогай. Дополни текущий адресный тест: более двух последовательных changed replies → B всё ещё принят/с тем же id; другой боец обслуживается; стабилизация → актуальный B автоматически идёт; late/cancel/pause сохранены; pending3D основан на том же контракте. Запусти только релевантный тест после изменений и scoped diff-check, не повторяй старые проверки без новых входов. Полный typecheck/build будут позже один раз после всех писателей. Без браузера/GPU/N30/N100/Git/новых зависимостей. Пользователь сам проводит живые тесты. Дай точные изменения/вывод/собственные native job IDs и settlement; остановись после этих двух дефектов.
## Обязательный формат итогового ответа
Итоговый ответ напиши строго между следующими точными маркерами этого задания.
При bell это копия уже переданного через -Message/-Report итога, а не отдельный канал доставки.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261110T060047Z_3470>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261110T060047Z_3470>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
