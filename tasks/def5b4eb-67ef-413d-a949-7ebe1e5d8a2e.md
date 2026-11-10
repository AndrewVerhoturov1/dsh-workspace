POSTMAN_REQUEST_ID: REQ_20261110T001834Z_5867
Режим: WRITE_APPROVED_TARGET. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\combat-lab-diagnostics-a-20261110
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:def5b4eb-67ef-413d-a949-7ebe1e5d8a2e'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\combat-lab-diagnostics-a-20261110.
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
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\def5b4eb-67ef-413d-a949-7ebe1e5d8a2e\signal.ps1' <done|need-decision|blocked> [-Message 'полный итог и проверки'] [-Report 'report.md']
Bell немедленно завершает получение результата: текст, написанный только после bell, не попадёт Leader.
Если используешь bell, передай содержательный итог и ограничения через -Message (до 16000 символов)
либо существующий -Report; в READ_ONLY новый файл отчёта создавать нельзя. Не отправляй пустой done.
Если поручение Leader явно требует только текст без bell, не вызывай bell: заверши обычным ответом в маркерах ниже.
## Поручение Leader
Завершить обязательную точную проверку достижимых кандидатов срочного укрытия после внедрения предварительных полей. ВA сейчасGitWorker заканчиваетDcherrypick затеминтегрирует awareness80de372e6ffddea3e5d24589e302cc336cd2f572; эти7awarenessowners НЕменять. СуществующийBpolicy src/core/knowledge/SoldierDangerField.ts exact|preliminary и точечный canonical scorer доступны; B private report artifacts/awareness-world-quality-propagation-report.md в соседней рабочейкопии combat-lab-geometry-b-20261110 описываетgap83-87 (можно read-only). Aточки: src/core/tactical/GeneralizedTacticalPositionSearchRuntime.ts99-148 дешёвый ограниченный отбор index/radius+route/danger/protection;179-195 exactevaluation/dedupe/cap;318-375 exactchecks; src/core/ai/tactical/TacticalQuery.ts229-393 filters/scoring. Цель: дешёвое предварительное поле для отбора не должно выдавать неизвестную защиту как измеренную и не должно окончательно отсеивать/ранжировать пригодных срочных кандидатов по консервативной preliminary опасности, когда нужна точная защита. Для реально достижимых относящихся к короткому манёвру кандидатов выполнить необходимую bounded точную point/cover оценку каноническими функциями до окончательного решения; сохранить реальные проверки доступности, все влияющие угрозы, немедленный бой, личную память без скрытыхкоординат. Сначала inspect существующих exactchecks: возможно достаточно минимально скорректировать порядок/quality gate, не дублировать физику. Не fullmap ради point, не arbitrarytopN угроз, не новыйкэш/queue/service. Владеешь только существующим tacticalsearch/AI tacticalquery и относящимися узкимитестами; не navigation/route (activewriter), UI, map/visibility, knowledgefields/runtimeworkers/debug. Еслинуженвнешнийowner опишиgap, не пиши туда. Пропорциональная проверка focused candidate correctness/known-vs-unknown protection/pose/owner isolation, typecheck после отсутствияmarkers; не чинить старые unrelatedharness. NoGit/GPU/N10/N30/N100, сервер5181не трогать, report.mdсохранить. Готовность realexactcandidatepath и tests, отчёт actualwork/counts/limitations, stop.
## Обязательный формат итогового ответа
Итоговый ответ напиши строго между следующими точными маркерами этого задания.
При bell это копия уже переданного через -Message/-Report итога, а не отдельный канал доставки.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261110T001834Z_5867>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261110T001834Z_5867>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
