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
