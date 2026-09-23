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

Implementation package invariant. Перед подготовкой или применением implementation package читать `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`. Обычный package декларативный и не приносит собственный applicator/diagnostics framework. Новый repository-owned файл не должен оставаться ignored: если он попадает под `.gitignore`, package обязан добавить в том же patch минимальное исключение. `git add -f` не использовать как обычный обход; Luna не ремонтирует package после runner FAIL.

Postman production invariant.
`POSTMAN_PRODUCTION_ENTRYPOINT: <current workspace>\postman\direct\postman.ps1`
`POSTMAN_ASK_PRODUCTION_ENTRYPOINT: <current workspace>\postman\direct\postman-ask.ps1`
Exact `@Postman` — artifact/ZIP production trigger. Exact `@PostmanAsk` — text production trigger.
`postman_async_send`, `postman_runtime_*`, QChat, Playwright MCP и ручная автоматизация браузера не являются fallback для Postman.
`dsh-postman-harness` разрешён в normal flow только как trusted orchestration boundary: он сам читает exact current `user/message`, механически различает `@Postman`/`@PostmanAsk`, удаляет только transport syntax и запускает соответствующий Direct wrapper; отдельным transport он не является.
Если загруженный Postman skill предлагает старый async path или противоречит этому правилу, считать его устаревшим и остановить Postman-операцию до загрузки актуального skill.
После exact trigger Luna не перепечатывает текущий user text и не передаёт его как `task`, `payload`, `prompt`, `userIntent` или Base64. Для обоих режимов она вызывает `postman_send_current_turn()` без текстовых аргументов. Trusted runtime удаляет только exact transport marker (и `--chat <REQ>` для continuation) с разрешённым separator, затем сам передаёт exact остаток через UTF-8 Base64 (`-TaskBase64`) в выбранный Direct wrapper. Нельзя добавлять предыдущий контекст, перефразировать или "улучшать" prompt.
До terminal handoff не интерпретировать задачу вместо Ч1 и не создавать implementation branch только ради transport.
Luna не выполняет result-root write-probe до bridge; tool-level spawn failure не разрешает recovery через старые request states.

`@Postman` — канонический artifact/ZIP production trigger.
Если ТЕКУЩЕЕ пользовательское сообщение после необязательных начальных пробелов начинается с exact `@Postman` (`^\s*@Postman(?:\s|$)`), агент ОБЯЗАН сначала загрузить `delegate-via-postman` вызовом `skill(delegate-via-postman)` до любого task-specific действия.

`@PostmanAsk` — отдельный канонический text production trigger.
Если ТЕКУЩЕЕ пользовательское сообщение после необязательных начальных пробелов начинается с exact `@PostmanAsk` (`^\s*@PostmanAsk(?:\s|$)`), агент ОБЯЗАН сначала загрузить `delegate-via-postman-ask` вызовом `skill(delegate-via-postman-ask)` до любого task-specific действия.

Для обоих режимов нельзя обходить skill через glob/read/edit/write/shell, чтобы интерпретировать либо выполнить запрос самостоятельно; до загрузки соответствующего skill запрещены локальное уточнение intent и выбор архитектуры. Если соответствующий skill отсутствует, не загружается или недоступен — fail-closed `STOP`, без другого Postman mode, Harness bypass, QChat, manual browser или самостоятельной реализации.

Direct Postman global invariant: OFF by default.
Обычный direct Postman в текущем Agent разрешён только при одном из exact current-message triggers:
- artifact: `^\s*@Postman(?:\s|$)`;
- text: `^\s*@PostmanAsk(?:\s|$)`.

Это разрешение действует только для текущего сообщения и не наследуется из предыдущих сообщений. `@PostmanAsk` не совпадает с artifact regex. Если ни одного exact trigger нет, обычный Agent не загружает Postman skills, не создаёт REQ, не вызывает Direct wrappers и не обращается к Ч1. Даже задачи по разработке самого Postman без exact trigger выполняются локально.

Postman Bridge supervisor invariant.
`postman_bridge` — отдельная trusted supervisor capability и не ослабляет direct current-message rule. Вызывать её может только top-level Agent, чей current composed preset равен `postman-leader`; для остальных root/subagent Agents tool скрывается runtime restriction, а прямой обход execution boundary завершается fail-closed `POSTMAN_BRIDGE_CALLER_REJECTED`.
Postman Leader может сформировать новое model-authored delegation, exact текст которого начинается с `@Postman` или `@PostmanAsk`. Trusted `spawn` создаёт fresh one-shot Luna child и передаёт exact delegation как собственный current `user/message` child-а; только с этой новой границы действуют обычные trigger skill/no-argument current-turn invariants. Это не наследование разрешения исходного человеческого сообщения, и generic `subagent`, прямой вызов Postman tools или ручная browser automation не могут подменять `postman_bridge`.
Bridge child всегда использует fixed `codex / gpt-6-luna`, `maxDepth = 1` и свой узкий `toolFilter`; он не получает `postman_bridge` или automatic continuation tool. Follow-up, `--chat`, выбор text/artifact mode и остановку решает parent Leader, а authority результата — trusted terminal, прочитанный host-ом из exact child scope, не Luna prose.

Artifact Postman lifecycle invariant.
Один artifact Direct Postman REQ имеет три успешных terminal transport outcomes: `RESULT_DURABLE`, `ASSISTANT_COMPLETED_NO_ARTIFACT`, `ARTIFACT_REJECTED`. После exact `RESULT_DURABLE` normal `@Postman` flow сообщает exact `requestId` и `resultZip`, затем останавливается. Два non-durable outcomes возвращают Л1 exact `assistantText`; `ARTIFACT_REJECTED` также возвращает validation reason. Они не transport failure. Artifact automatic continuation допустима только из предусмотренных non-durable outcomes и только пока текущее сообщение разрешает `@Postman`.

PostmanAsk text lifecycle invariant.
Один `@PostmanAsk` REQ успешно завершается только `TEXT_RESULT_DURABLE`. Ч1 обязан выдать exact REQ-bound envelope `<<<POSTMAN_ASK_BEGIN:<REQ>>> ... <<<POSTMAN_ASK_END:<REQ>>>`. Произвольный завершённый assistant text не является успехом. Общий Web Worker сначала доказывает exact assistant turn, окончание генерации и существующий 10-second fresh re-proof; если assistant text/SHA изменился, grace window начинается заново. Только после этого text Direct layer принимает exact markers и выбирает delivery mode по exact длине результата: `<=4096` символов → `deliveryMode=inline` без Markdown-файла; `>4096` → `deliveryMode=file`, exact UTF-8 `POSTMAN_<REQ>_ANSWER.md` и compact descriptor без `assistantText` в terminal JSON. Harness до file handoff перечитывает Markdown и проверяет exact filename, UTF-8 bytes, byte length и SHA-256. ZIP/result workspace для text mode не требуются. Missing/wrong/ambiguous markers завершаются fail-closed, а не принимаются как ответ.

PostmanAsk exact final-reply invariant.
Для `deliveryMode=inline` Harness сохраняет exact `assistantText` в session-scoped reply slot, привязанный к текущему REQ. Перед final response Luna обязана передать candidate final text в `postman_ask_validate_reply(request_id, text)`. Validator использует прямое строковое равенство без trim/whitespace/Markdown normalization и без отдельного SHA-gate. Только `EXACT_REPLY_MATCH` разрешает final response тем же candidate; mismatch требует повторно взять exact `assistantText`, а unavailable/request mismatch/invalid означают `STOP`. Для `deliveryMode=file` exact-reply validator не вызывается и полного `assistantText` у Luna нет: она не читает `resultFile`, не читает его кусками, не собирает большой текст обратно в model context и не пересказывает его. Final response для file-mode — короткий handoff exact `resultFile` как кликабельного локального файла по правилу Links and files; допустимы только компактные metadata вроде длины и SHA-256.

Postman existing-chat continuation invariant.
Формы `@Postman --chat <canonical old REQ> <intent>` и `@PostmanAsk --chat <canonical old REQ> <intent>` разрешают продолжить exact ChatGPT conversation, URL которого уже доказан и сохранён Postman. Старый REQ — только conversation lookup key; новая отправка всегда получает новый canonical REQ. Trusted runtime передаёт только новый exact intent, без transport marker и старого REQ; Luna этот текст не формирует. `TEXT_RESULT_DURABLE` является допустимым local conversation reference, поэтому один доказанный conversation можно вручную продолжить в любом из двух режимов. UI Search/лупа, угадывание чата и silent fresh fallback запрещены.

`postman_continue_last_request` остаётся deterministic automatic continuation только artifact Postman; PostmanAsk v1 automatic continuation не использует.

`resume_request.ps1`, PREPARE, TEST, PUBLISH и `integrate_result.ps1` сохраняются как legacy/manual explicit finalization для artifact durable result. Они не являются частью normal `@Postman` или `@PostmanAsk` flow. При manual finalization TestScript/TestSpec передаются argv-safe. Normal transport не создаёт implementation worktree, branch, commit или PR. Настоящий transport failure (`ok=false`) остаётся strict fail-closed: STOP без fallback/повторного Send того же REQ.

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
