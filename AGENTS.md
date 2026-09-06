The user works on Windows 10 Pro 22H2.
Processor: AMD Ryzen 7 1700 3.00 GHz
RAM: 32.0 GB
Graphics adapter: RTX 3060 (12 GB)
System type: 64-bit operating system

This repository contains Russian text. Always treat text files as UTF-8.

Language. Always respond in Russian unless explicitly asked otherwise. Avoid English loanwords; write as clearly as you would to a high-school student.

Relevance. Take the current date into account.

Links and files
Do not output bare URLs or paths. Web URLs use normal Markdown links. In Harness Web, references to existing local files that should be clickable are formatted as Markdown inline code using the exact file-tool/local path; a basename is allowed only when it is unique among files surfaced/changed in that turn. Do not use `file://` for local-file links. For Postman result files, prefer the exact retained result-worktree path from the authoritative receipt.

Playwright MCP. Для проверки локальных HTML-файлов не использовать `file://` и порт 3080. Запускать временный HTTP-сервер на свободном порту, например 4173, проверять точный URL и только затем выполнять тесты.

Repository policy. Перед любыми операциями с ветками обязательно прочитать `REPO_POLICY.md` и соблюдать его как обязательную политику репозитория. Перед созданием любой новой ветки необходимо проверить локальные ветки, фактические ветки `origin`, связанные открытые PR и `git worktree`. Если существует временная ветка предыдущей или параллельной задачи, новую ветку создавать нельзя: сначала нужно сообщить пользователю о найденной ветке и предложить корректно завершить её через merge, archive tag + удаление, доказанное удаление или продолжение текущей ветки. Ветки нельзя оставлять как бессрочные архивы или резервные копии.

GitHub synchronization. Локальный агент, который изменил repository, не должен завершать успешную задачу с непубликованными agent-authored изменениями. После проверки task-scoped изменений он обязан выполнить `commit` и `push` текущей task branch, а затем проверить SHA удалённой ветки. Для законченной reviewable работы должен существовать PR либо быть обновлён уже существующий PR. Если публикация невозможна, итоговый статус — `BLOCKED_SYNC`, а не `PASS`. Это правило не отменяет явно установленный для внешнего или аналитического агента режим `GitHub READ ONLY`; в таком случае публикацию результата после локального применения выполняет локальный Harness/Luna agent. Подробные правила находятся в `REPO_POLICY.md`.

Postman production invariant.
`POSTMAN_PRODUCTION_ENTRYPOINT: C:\Users\andre\.dsh\postman\direct\postman.ps1`
Для явно запрошенной Postman implementation-задачи это единственный production entrypoint.
`postman_async_send`, `postman_runtime_*`, `dsh-postman-harness`, QChat, Playwright MCP и ручная автоматизация браузера не являются fallback для Postman.
Если загруженный `delegate-via-postman` предлагает `postman_async_send` как normal path или противоречит этому правилу, считать его устаревшим и остановить Postman-операцию до загрузки актуального skill.
До получения `RESULT_DURABLE` не выбирать архитектуру/технологии вместо Ч1 и не создавать implementation branch только ради transport.

`@Postman` — единственный канонический явный production trigger.
Если ТЕКУЩЕЕ пользовательское сообщение после необязательных начальных пробелов
начинается с точного литерала `@Postman`, агент ОБЯЗАН сначала загрузить `delegate-via-postman`
вызовом `skill(delegate-via-postman)` до любого task-specific implementation-действия. Нельзя обходить skill через glob,
read, edit, write или shell, чтобы реализовать запрос самостоятельно; до загрузки
skill запрещены также выбор архитектуры и frontend/design skills.

Если `delegate-via-postman` отсутствует, не загружается, недействителен или
недоступен, действовать fail-closed: `STOP`. Нельзя реализовывать запрос самому или
использовать fallback `postman_async_send`, старый Harness, QChat, manual browser,
Playwright либо другой transport. Если skill не загружается, не использовать
другой skill или transport fallback.

Postman global invariant: OFF by default.
Разрешающий trigger существует только тогда, когда ТЕКУЩЕЕ пользовательское сообщение
после необязательных начальных пробелов начинается с точного литерала `@Postman`
(то есть `^\s*@Postman(?:\s|$)`). Разрешение действует только для этого сообщения
и не наследуется из предыдущих сообщений.

Если `@Postman` отсутствует в текущем пользовательском сообщении, Luna обязана:
- не загружать `delegate-via-postman`;
- не создавать `REQ`;
- не вызывать `postman.ps1`;
- не запускать Direct Postman;
- не использовать `postman_async_send`;
- не использовать `postman_runtime_*`;
- не обращаться к Ч1;
- не считать упоминание Postman, задачу о Postman или любую иную формулировку разрешением.

Даже задачи по разработке самого Postman без `@Postman` выполняются локально Luna
самостоятельно. Без `@Postman` Luna больше не имеет права запускать Postman.

Postman local finalization invariant.
После exact `RESULT_DURABLE` единственный normal production local-finalization entrypoint —
`C:\Users\andre\.dsh\postman\direct\resume_request.ps1`. PREPARE, TEST и PUBLISH
остаются внутренними deterministic стадиями resume и владеют соответственно
Git/policy/worktree+applicator, одним task-specific test receipt и
stage/commit/push/remote-SHA/PR. Luna не вызывает `prepare_result.ps1`,
`test_result.ps1` или `publish_result.ps1` отдельно в normal `@Postman` flow и не
разлагает resume обратно на ручные Git/gh/shell вызовы. Normal task test передаётся
argv-safe через `TestScript`/`TestSpec`; `python -c` и `TestCommand` не являются normal
path. Если test нельзя выбрать до PREPARE, первый resume без test input может вернуть
`READY_FOR_TEST`, после чего тот же REQ продолжается вторым resume с TestScript/TestSpec.
Любой `ok=false` — fail-closed `STOP`; ручной fallback, новый REQ и повторный Ch1
запрещены. PUBLISH внутри resume не выполняет merge.

Terminal visibility invariant.
В обычной производственной работе Harness пользователь не должен видеть всплывающие окна PowerShell, cmd, Python, Node, Git, gh или других процессов командной строки. Любой дочерний процесс командной строки запускается без создания видимого окна консоли.

На Windows обязательно:
- для `subprocess` использовать `CREATE_NO_WINDOW`;
- не запускать вложенный `powershell`/`pwsh`, если команду можно выполнить напрямую;
- если отдельный процесс PowerShell действительно необходим, запускать его скрытым;
- не использовать `cmd.exe` или `start` способом, который создаёт видимое окно.

Исключение допускается только для явно запрошенной пользователем диагностики, когда видимый интерактивный терминал действительно является целью операции. Любое всплывающее окно терминала в обычном потоке Postman/Harness считать дефектом реализации, а не нормальным поведением.

Postman UTF-8 CLI boundary invariant.
Все канонические PowerShell-wrapper'ы Direct Postman, integrator, PREPARE, TEST и
PUBLISH обязаны запускать Python в UTF-8 mode через `-X utf8`. Диагностический JSON
с Unicode не должен зависеть от Windows ANSI/OEM code page и не должен теряться
из-за `UnicodeEncodeError`. Это относится и к failure-path, не только к PASS.
