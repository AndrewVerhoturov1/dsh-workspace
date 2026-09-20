The user works on Windows 10 Pro 22H2.
Processor: AMD Ryzen 7 1700 3.00 GHz
RAM: 32.0 GB
Graphics adapter: RTX 3060 (12 GB)
System type: 64-bit operating system

This repository contains Russian text. Always treat text files as UTF-8.

Language. Always respond in Russian unless explicitly asked otherwise. Avoid English loanwords; write as clearly as you would to a high-school student.

Relevance. Take the current date into account.

Links and files
Do not output bare URLs or paths. Web URLs use normal Markdown links. In Harness Web, references to existing local files that should be clickable are formatted as Markdown inline code using the exact file-tool/local path; a basename is allowed only when it is unique among files surfaced/changed in that turn. Do not use `file://` for local-file links. For normal Postman `RESULT_DURABLE`, prefer the exact durable `resultZip`/`resultDirectory` from the authoritative receipt. A retained result-worktree path applies only to explicit manual `PUBLISHED` finalization.

Playwright MCP. Для проверки локальных HTML-файлов не использовать `file://` и порт 3080. Запускать временный HTTP-сервер на свободном порту, например 4173, проверять точный URL и только затем выполнять тесты.

Repository policy. Перед любыми операциями с ветками обязательно прочитать `REPO_POLICY.md` и соблюдать его как обязательную политику репозитория. Постоянные ветки: `main` — стабильная, `preview` — интеграционная. Обычная новая task branch создаётся от exact current `origin/preview`, а обычный task PR target-ит `preview`. `main` меняется только отдельной release-операцией `preview → main` после явной команды пользователя. Перед созданием ветки проверить локальные refs, фактические ветки `origin`, связанные PR и `git worktree`; независимые ресурсы не являются глобальным mutex, но ownership-конфликты текущей задачи должны блокировать небезопасную операцию. Временные ветки нельзя оставлять как бессрочные архивы или резервные копии.

Subprojects. Долгоживущие направления работы находятся в `docs/subprojects/`. Если текущая задача явно относится к существующему подпроекту, после обязательных repository-level правил прочитать его `SUBPROJECT.md`; не читать все подпроекты подряд. `SUBPROJECT.md` сохраняет цель, текущий фокус, следующий шаг, принятые решения и границы между отдельными задачами и чатами, но не переопределяет `AGENTS.md`, `REPO_POLICY.md` или канонический workflow затронутой подсистемы. Подпроект не является branch, PR или REQ: один подпроект может включать много временных task branches, PR и REQ. Создавать подпроект только для многоэтапного или повторяющегося направления, а не для каждой небольшой задачи.

Permanent worktrees. `C:\Users\andre\.dsh` — постоянный main worktree. `C:\Users\andre\.dsh-preview` — постоянный preview worktree. Оба пути нельзя автоматически удалять, очищать, reset/stash-ить или использовать как временный implementation worktree. Обычная implementation выполняется в отдельном worktree.

GitHub synchronization. Локальный агент, который изменил repository, не должен завершать успешную задачу с непубликованными agent-authored изменениями. После проверки task-scoped изменений он обязан выполнить `commit` и `push` текущей task branch, а затем проверить SHA удалённой ветки. Для законченной reviewable обычной работы должен существовать PR в `preview` либо быть обновлён уже существующий PR. Если публикация невозможна, итоговый статус — `BLOCKED_SYNC`, а не `PASS`. Это правило не отменяет явно установленный для внешнего или аналитического агента режим `GitHub READ ONLY`; в таком случае публикацию результата после локального применения выполняет локальный Harness/Luna agent. Подробные правила находятся в `REPO_POLICY.md`.

Postman production invariant.
`POSTMAN_PRODUCTION_ENTRYPOINT: <current workspace>\postman\direct\postman.ps1`
Для любого текущего сообщения с exact `@Postman` trigger это единственный production entrypoint.
`postman_async_send`, `postman_runtime_*`, `dsh-postman-harness`, QChat, Playwright MCP и ручная автоматизация браузера не являются fallback для Postman.
Если загруженный `delegate-via-postman` предлагает `postman_async_send` как normal path или противоречит этому правилу, считать его устаревшим и остановить Postman-операцию до загрузки актуального skill.
После trigger Luna удаляет только transport marker `@Postman` и непосредственно следующий разделяющий whitespace; весь оставшийся текущий user text передаётся Ч1 verbatim. Нельзя добавлять предыдущий контекст, перефразировать или "улучшать" prompt.
До получения `RESULT_DURABLE` не интерпретировать задачу вместо Ч1 и не создавать implementation branch только ради transport.
Luna не выполняет result-root write-probe до bridge; tool-level spawn failure не разрешает recovery через старые request states.

`@Postman` — единственный канонический явный production trigger.
Если ТЕКУЩЕЕ пользовательское сообщение после необязательных начальных пробелов
начинается с точного литерала `@Postman`, агент ОБЯЗАН сначала загрузить `delegate-via-postman`
вызовом `skill(delegate-via-postman)` до любого task-specific действия. Нельзя обходить skill через glob,
read, edit, write или shell, чтобы интерпретировать либо выполнить запрос самостоятельно; до загрузки
skill запрещены также локальное уточнение intent, выбор архитектуры и frontend/design skills.

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

Postman normal lifecycle invariant.
После exact `RESULT_DURABLE` normal `@Postman` flow может один раз попытаться
зарегистрировать exact durable result через
`postman_result_workspace_register(request_id=<exact REQ>, result_handoff_json=<exact resultHandoffPath>)`
и затем обязан остановиться. Workspace registration — presentation convenience, а не integrity gate.

Postman existing-chat continuation invariant.
Форма `@Postman --chat <canonical old REQ> <intent>` разрешает продолжить exact ChatGPT
conversation, URL которого уже доказан и сохранён Postman. Старый REQ используется только
как conversation lookup key; новая отправка всегда получает новый canonical REQ. В `-Task`
передаётся только новый intent без `--chat` и старого REQ. Если URL не найден, normal path
останавливается с `DIRECT_CHAT_REFERENCE_UNAVAILABLE`; UI Search/лупа и угадывание чата в
этом milestone запрещены как fallback.

Если регистрация не удалась, transport остаётся успешным: сообщить exact resultZip и
diagnostic, не создавать второй REQ, не повторять ChatGPT/download и не запускать resume.

`resume_request.ps1`, PREPARE, TEST, PUBLISH и `integrate_result.ps1` сохраняются как
legacy/manual explicit finalization для уже существующего durable результата. Они не являются
частью normal `@Postman` flow. Normal flow не создаёт implementation worktree, branch,
commit или PR и не распаковывает/анализирует ZIP. Luna не интерпретирует содержимое
результата и не выбирает действия на основе его содержимого. До `RESULT_DURABLE` действует strict
fail-closed поведение; любой `ok=false` останавливает операцию без fallback, нового REQ
или повторного Ch1. При manual finalization TestScript/TestSpec передаются argv-safe.

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

Task PR merge executor.
Когда модель уже вручную проверила обычный task PR и приняла решение, что он готов к merge, а пользователь дал команду merge, не повторять внутри merge-исполнителя тесты, CI, diff-review и прочую проверочную бюрократию. Для обычного `squash merge → preview → cleanup` использовать `tools/finalize-task-pr/finalize_task_pr.ps1`. Скрипт является исполнителем уже принятого решения, а не reviewer. Он может обработать несколько PR последовательно и перед каждым следующим заново читает его состояние после предыдущего merge.

Исполнитель сохраняет только аварийные предохранители: base должен быть `preview`; head не может быть `main` или `preview`; постоянные worktree `C:\Users\andre\.dsh` и `C:\Users\andre\.dsh-preview` не удаляются и не очищаются; dirty secondary worktree оставляется с warning; local/remote temporary head branch удаляется только если всё ещё указывает на exact PR head SHA. Отсутствующие временные worktree/ветки считаются нормальным уже очищенным состоянием. Cleanup выполняется best-effort и его warning не отменяет уже успешный merge. Запрещены `reset --hard`, `stash`, `git clean` и force push.

Task PR finalize skill.
Когда пользователь дал команду выполнить merge уже проверенного обычного task PR (или нескольких PR), normal path — загрузить `skill(finalize-task-pr)` и выполнить merge через `tools/finalize-task-pr/finalize_task_pr.ps1`. Этот skill является исполнителем уже принятого решения и не должен запускать повторный test/CI/diff/scope review. Если exact PR number однозначно известен из текущего или непосредственно предшествующего контекста, не спрашивать его повторно. Если PR не определяется однозначно — уточнить номер. `-WhatIf` не является обязательным preflight и используется только по явному запросу пользователя.

Preview promotion executor.
`main` обновляется только отдельной promotion-операцией. Когда пользователь явно разрешил перенос текущего проверенного `preview` в `main`, использовать `tools/promote-preview-to-main/promote_preview_to_main.ps1` через skill `promote-preview-to-main`. Promotion PR обязан иметь `base=main`, `head=preview` и marker `MAIN_GO_APPROVED_BY_USER: yes`. Merge method — обычный merge commit, не squash. Executor никогда не удаляет branch `preview` или `C:\Users\andre\.dsh-preview`; после merge он может только non-force fast-forward remote `preview` на созданный merge commit, если exact refs доказывают безопасность. Если refs сдвинулись, force/rewrite запрещены и возвращается warning/blocker.
