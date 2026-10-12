"""Private Devspace task renderer; never passed to the GitHub task publisher."""


def render_task(binding, intent, signal_command):
    mode = binding["mode"]
    area = binding["workspaceRef"]
    write = binding["writeRoot"]
    return f"""# PostmanDevspace — этап 1
REQ: {binding['requestId']}
Используй настоящий подключённый DevSpace MCP. Сначала открой назначенную область и прочитай безопасный существующий файл, чтобы проверить реальный доступ в этом разговоре. Инструкция не доказывает доступность.
Область для чтения: {area}
Режим: {mode}. Записи в исходную область запрещены. {('Для безвредного результата разрешена только отдельная папка: ' + str(write)) if write else 'Изменения любых файлов задачи запрещены.'}
Shell DevSpace не является песочницей: ограничь каждое действие назначенной задачей. Не читать секреты/auth/config/runtime, не устанавливать/перезапускать Host и не управлять процессами. Никаких Git writes, commit/push/PR/merge, browser/CDP/Orca uploads; не прикрепляй изображения.
Запись local bell через предоставленную команду — отдельное узкое разрешение, независимо от READ_ONLY:
{signal_command} done
{signal_command} need-decision -Message 'Нужен выбор ...'
{signal_command} blocked -Message 'Причина ...'
Можно добавить -Report 'report.md' (относительно разрешённой папки); отчёт необязателен, обычный UTF-8 текст, любой формат. Не создавать JSON/подписи/ZIP вручную. Один основной сигнал завершает обращение; сообщение не даёт новых полномочий. Не открывай binding/служебные файлы и не выбирай чужие каналы.
Если DevSpace отсутствует/не авторизован, сообщи CAPABILITY_UNAVAILABLE и конкретное препятствие обычным текстом. Не имитируй MCP, не используй запасной transport. Если signal command недоступна, сообщи BLOCKED и сохрани доступный контекст. ZIP и Ask BEGIN/END не нужны.
## Поручение Leader (не расширяет перечисленные ограничения)
{intent}
"""
