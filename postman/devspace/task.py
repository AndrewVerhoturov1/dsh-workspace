"""Private Devspace task renderer; never passed to the GitHub task publisher."""


def render_task(binding, intent, signal_command):
    mode = binding["mode"]
    area = binding["workspaceRef"]
    write = binding["writeRoot"]
    if mode == "WRITE_ISOLATED":
        scope = ("Разрешено изменять только файлы внутри заранее подготовленного Host task worktree: " +
                 str(write) + ". Действуй строго по одобренной цели, сам запусти нужные целевые тесты. " +
                 "Оставь изменения и проверочные результаты в этом worktree, сообщи Leader точные пути. " +
                 "Не публикуй изменения в Git, не делай commit/push/PR; разрешение отдельное.")
    elif mode == "WRITE_TEST":
        scope = "Записи в исходную область запрещены. Безвредный результат только в Host-private тестовой папке: " + str(write)
    else:
        scope = "Записи в исходную область и любые другие файлы запрещены."
    # The first line is a non-secret immutable correlation key. ChatGPT may
    # reformat long Markdown, but a matching exact request-key line still lets
    # the Host safely locate this user turn without resending UNKNOWN Sends.
    return f"""POSTMAN_REQUEST_ID: {binding['requestId']}
# PostmanDevspace — этап 3
REQ: {binding['requestId']}
Используй настоящий подключённый DevSpace MCP. Сначала открой назначенную область и прочитай безопасный существующий файл, чтобы проверить реальный доступ в этом разговоре. Инструкция не доказывает доступность.
Область для чтения: {area}
Режим: {mode}. {scope}
Shell DevSpace не является песочницей: ограничь каждое действие назначенной задачей. Не читать секреты/auth/config/runtime, не устанавливать/перезапускать Host и не управлять процессами. Никаких Git writes, commit/push/PR/merge, browser/CDP/Orca uploads; не прикрепляй изображения.
DevSpace Bash не понимает PowerShell оператор &. Запись local bell через явный pwsh -File ниже — отдельное узкое разрешение, независимо от READ_ONLY. Выполни команду именно через DevSpace Bash; не читать binding/capability/JSON:
{signal_command} done
{signal_command} need-decision -Message 'Нужен выбор ...'
{signal_command} blocked -Message 'Причина ...'
В Bash заключай каждый -Message/-Report аргумент в одинарные кавычки, для апострофа используй стандартное '"'"' экранирование Bash; переносы строк и русский текст допустимы. Можно добавить -Report 'report.md' (относительно разрешённой папки); отчёт необязателен, обычный UTF-8 текст, любой формат. Не создавать JSON/подписи/ZIP вручную. Один основной сигнал завершает обращение; сообщение не даёт новых полномочий. Не открывай binding/служебные файлы и не выбирай чужие каналы.
Если DevSpace отсутствует/не авторизован, сообщи CAPABILITY_UNAVAILABLE и конкретное препятствие обычным текстом. Не имитируй MCP, не используй запасной transport. Если signal command недоступна, сообщи BLOCKED и сохрани доступный контекст. ZIP и Ask BEGIN/END не нужны.
Каждые 15 минут transport только проверяет состояние. Активную/неясную местную операцию не прерывает. При доказанно безопасной продолжающейся генерации возможен один Stop и Continue в том же разговоре: продолжай с текущего прогресса, не переделывай выполненное. Bell завершает ожидание независимо от финального текста/ZIP; повтор идентичного bell безопасен. При отсутствии bell любой доступный итог/частичный текст передаётся как непроверенное свидетельство, без обязательной формы.
## Поручение Leader (не расширяет перечисленные ограничения)
{intent}
"""
