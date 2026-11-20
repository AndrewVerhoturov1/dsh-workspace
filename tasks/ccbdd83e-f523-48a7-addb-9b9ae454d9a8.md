POSTMAN_REQUEST_ID: REQ_20261120T222521Z_2916
Режим: WRITE_TEST. Область для чтения: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\db1552b7-0523-435d-93f1-d7b78e0603aa\workspace
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:ccbdd83e-f523-48a7-addb-9b9ae454d9a8'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ccbdd83e-f523-48a7-addb-9b9ae454d9a8\workspace. Исходная область только для чтения.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 10d2b65f7ea089d66d879130224a643977c2d7a9b47a28a497aefc233a01ea10
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/docs/workflow/TASK_CONTRACT.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ccbdd83e-f523-48a7-addb-9b9ae454d9a8\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Проверь перенос приватного пакета :50206 на чистую версионированную базу, до решения о PR. В одном назначенном read-only корне два входа: `main-baseline-a07ec5a.zip` (git archive exact a07ec5a66d768d4aa23766ce09699bd4baf93f1d, SHA256 7d61c266ab7148d75534fa56c9f7a4d4fe9d220cd936acc8ccb962563bb30a23; архив 224 МБ, читать/распаковать **только** в свой новый writer, проверить безопасные относительные пути) и `inputs-verified-release-b867384d/` (source patch b0b1a7aab70abc5f1ec19392b7a376d428ad368277323fe95b0e939b17a72dae, assets ZIP a708ab7c718b8b247ddaa5e41dd71b8dbb9e54769cfbd88de0209915deaf08bb, old→new manifest cdfb452a64a5017ce3929d6fe3af29c8e13ffa03c467c9490d63f10ca63ddd11). Сначала dry-run и точные SHA меняемых baseline, затем применить только в копии без .git; после — сверить 122 текстовых + 2 v2geo, без удалений чужих файлов или лишних изменений. Использовать доступные зависимости только в writer (штатно npm ci --offline если возможно; не устанавливать глобально, не трогать host/исходники). Зафиксировать Git LFS pointers и чего они не позволяют проверить. На полученной сборке штатный typecheck/build и только относящиеся memory R200, route scheduler, checkpoint, danger slope, worker revision и geography smoke, если доступны; не подменять верификацию исходником seed и не ослаблять проверки. Основная-map 300×300 была байтово уже той же; фон внимания и новые правки опасности НЕ включать. Если какой-то этап недоступен, report с точным blocker и NOT_RUN. Итог report.md, фактические проверки и путь к проверенной сборке; не запускать сервер, не делать Git writes/commit/worktree/push/PR/merge и не менять main, stable или существующие превью. После отчёта стоп.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261120T222521Z_2916>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261120T222521Z_2916>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
