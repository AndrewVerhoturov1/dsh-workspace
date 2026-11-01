POSTMAN_REQUEST_ID: REQ_20261101T012056Z_8927
Режим: WRITE_APPROVED_TARGET. Область для чтения: C:\PROJECTS\Real-tactic-wargame\.worktrees\perception-attention-subjective-memory-v2-implementation
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:bb33d638-9dea-4d4b-a0fc-e72beda251e6'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame\.worktrees\perception-attention-subjective-memory-v2-implementation.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: ec938ce03904eadd3214ef3129f9e261f6d668cd25a726636f68c6420409b907
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/7cbfca08b33f9cdbe8abe1fe513fa5291ea6b6ae/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/7cbfca08b33f9cdbe8abe1fe513fa5291ea6b6ae/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/7cbfca08b33f9cdbe8abe1fe513fa5291ea6b6ae/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/7cbfca08b33f9cdbe8abe1fe513fa5291ea6b6ae/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\.worktrees\perception-attention-subjective-memory-v2-implementation\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\bb33d638-9dea-4d4b-a0fc-e72beda251e6\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Предыдущее продолжение REQ_20261101T011709Z_8149 не доставлено: Host exact SUBMIT_NAVIGATION_FAILED / PROVEN_NOT_SENT. Эта новая явная попытка завершает только недостающую приёмку FPSfix. Код уже исправлен,новыеproductизменения не нужны.
Leaderпрочитал report.md108стр. Ускорение41→57FPSполезно,ноbefore~27s/after45.6sсимуляции неmatched. Нужна ОДНА пара по docs/performance/PERFORMANCE_PRINCIPLES.md§21:stage1-300,5units416objects,seed9041,observerrifle-distance-shooter,камера11,1280×800DPR1,attentionon,×1running,одинаковыйстарт/прогрев/сценарийи≥90секretained. Метрикиnativeexportframetimep50/p95/p99/max и доли>16.7/20/33,фазы/LongTasks/childList. Укажиactualmovers/contactstates и невыдавайseedсценызаполнуюseededдетерминированность.
User53491и5173живы:неоткатыватьliveworktreeрадиbefore. Разрешена частнаяisolatedA/Bкопия нужныхsource/buildв artifacts/lab-attention-fps безGitworktree/install/newdeps. ДоFPSPolygonRightPanelLiveView.ts blobSHA a81bcef6b61403295d8a9f93eddb3b54049bd04a,после42e6dbabb25fabc93a9dc81ae88a126467147579. Восстановиbeforeизсохранённогофайла/точнойистории;либоисключивтолькоизвестныйFPSdiffвisolatedcopyсобязательнымсовпадениемисходногоSHA. Еслиточныйbeforeнедоступен—конкретныйблокер,невыдумыватьэталон. Остальные25релевантныхsourceSHA/dirtyStage4одинаковы;фиксироватьпередобоимипрогонами. Liveисходникине менять. Сохранитьполныеrawnativeexportsнеоднутранскрипциюсводок.
Сначалаnativejobsstatusсуществующихсвоихзапусков—последний53493reportstopped8ebbe015-e9c7-4a70-8131-f4f7cfd9e979;неповторятьнеизвестныйjob. Тестовыйпортсвободный,толькосвойсерверостановитьпослезамеров. Typecheck/build/smokeтекущегоfixужепрошли,неповторятьбезизменённыхinputs;сборкаisolatedbaselineдляA/Bдопустима. НикакихсоседнихSVGоптимизаций/LOScadence/scenechanges. Websearchнеповторять,URLесть;реальныйbrowserbuildномеротделиотspoofUAChrome91Mac/WindowsGPU. User10–15FPSнеполностьювоспроизведён—оставитьчестно. Рано дополни artifacts/lab-attention-fps/report.md точнойграницей,после—matchedresults/nativejobsettlement. Стопиbell.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261101T012056Z_8927>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261101T012056Z_8927>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
