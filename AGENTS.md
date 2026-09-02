The user works on Windows 10 Pro 22H2.
Processor: AMD Ryzen 7 1700 3.00 GHz
RAM: 32.0 GB
Graphics adapter: RTX 3060 (12 GB)
System type: 64-bit operating system

This repository contains Russian text. Always treat text files as UTF-8.

Language. Always respond in Russian unless explicitly asked otherwise. Avoid English loanwords; write as clearly as you would to a high-school student.

Relevance. Take the current date into account.

Links and files
Do not output bare URLs or paths. Format all links to web pages and local files as Markdown links. When linking to files, use an absolute path in the format supported by the current Codex environment.

Playwright MCP. Для проверки локальных HTML-файлов не использовать `file://` и порт 3080. Запускать временный HTTP-сервер на свободном порту, например 4173, проверять точный URL и только затем выполнять тесты.

Repository policy. Перед любыми операциями с ветками обязательно прочитать `REPO_POLICY.md` и соблюдать его как обязательную политику репозитория. Перед созданием любой новой ветки необходимо проверить локальные ветки, фактические ветки `origin`, связанные открытые PR и `git worktree`. Если существует временная ветка предыдущей или параллельной задачи, новую ветку создавать нельзя: сначала нужно сообщить пользователю о найденной ветке и предложить корректно завершить её через merge, archive tag + удаление, доказанное удаление или продолжение текущей ветки. Ветки нельзя оставлять как бессрочные архивы или резервные копии.

GitHub synchronization. Локальный агент, который изменил repository, не должен завершать успешную задачу с непубликованными agent-authored изменениями. После проверки task-scoped изменений он обязан выполнить `commit` и `push` текущей task branch, а затем проверить SHA удалённой ветки. Для законченной reviewable работы должен существовать PR либо быть обновлён уже существующий PR. Если публикация невозможна, итоговый статус — `BLOCKED_SYNC`, а не `PASS`. Это правило не отменяет явно установленный для внешнего или аналитического агента режим `GitHub READ ONLY`; в таком случае публикацию результата после локального применения выполняет локальный Harness/Luna agent. Подробные правила находятся в `REPO_POLICY.md`.

Postman production invariant.
`POSTMAN_PRODUCTION_ENTRYPOINT: C:\Users\andre\.dsh\postman\direct\postman.ps1`
Для явно запрошенной Postman implementation-задачи это единственный production entrypoint.
`postman_async_send`, `postman_runtime_*`, `dsh-postman-harness`, QChat, Playwright MCP и ручная автоматизация браузера не являются fallback для Postman.
Если загруженный `delegate-via-postman` предлагает `postman_async_send` как normal path или противоречит этому правилу, считать его устаревшим и остановить Postman-операцию до загрузки актуального skill.
До получения `RESULT_DURABLE` не выбирать архитектуру/технологии вместо Ч1 и не создавать implementation branch только ради transport.

`@Postman` — канонический явный production trigger.
Если пользовательский implementation-запрос начинается с `@Postman`, агент ОБЯЗАН
сначала загрузить `delegate-via-postman` вызовом `skill(delegate-via-postman)` до
любого task-specific implementation-действия. Нельзя обходить skill через glob,
read, edit, write или shell, чтобы реализовать запрос самостоятельно; до загрузки
skill запрещены также выбор архитектуры и frontend/design skills.

Если `delegate-via-postman` отсутствует, не загружается, недействителен или
недоступен, действовать fail-closed: `STOP`. Нельзя реализовывать запрос самому или
использовать fallback `postman_async_send`, старый Harness, QChat, manual browser,
Playwright либо другой transport. Если skill не загружается, не использовать
другой skill или transport fallback.
