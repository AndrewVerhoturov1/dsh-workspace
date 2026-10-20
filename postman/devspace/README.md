# Host-owned PostmanDevspace

Основной маршрут Leader → persistent Luna → ChatGPT/DevSpace. До трёх текущих исполнений на Leader; сохранённая беседа или старая неопределённая запись слот сама по себе не занимает. Новое поручение с `lane_id` продолжает собственную Luna/ChatGPT-беседу; каждая отправка получает отдельный REQ.

Host сохраняет exact owner/job/child/REQ/lane/conversation, результаты и факты Send/Stop в существующем реестре. Готовый bell или текст доступен Leader независимо от доступности Luna. Status/list только наблюдают, не запускают восстановление или модель. Выгрузка не переигрывает Send. Смысл ошибки, повтор и приёмку решает Leader; Host не строит автоматическую цепочку REQ.

Рабочая папка определяется назначением либо каталогом сессии, без подготовки Git Host. Scope/read-only — инструкции исполнителю; фактические права инструментов, принадлежность и явный отзыв сохраняются. Worker выполняет Git по REPO_POLICY. Writer binding идентифицирует собственный REQ, не является дополнительным запретом на пути или пересечения каталогов.

Действующий таймер 15/30/45 минут сохранён: result-first → один распознанный Stop при необходимости → готовый composer → продолжение. Максимум три подтверждённых напоминания и прежний общий deadline. UI Stop не доказывает завершение Bash.

Bell вызывается из настоящего DevSpace Bash готовой командой `pwsh -NoProfile -NonInteractive -File <native-script-path> done|need-decision|blocked`. Optional `-Message`/`-Report` допускают многострочный текст. В Bash каждый аргумент заключён в single quotes; апостроф экранируется `'"'"'`, а не правилами PowerShell. Отчёт любого формата необязателен; его отсутствие — информация. Без bell передаётся доступный текст без выдуманного DONE/PASS.

Подробный текущий контракт — [POSTMAN_DEVSPACE_FLOW.md](../POSTMAN_DEVSPACE_FLOW.md); инструкции ChatGPT — [SKILL.md](SKILL.md). Местный VUDA и внешний ChatGPT используют разные маршруты по [VUDA.md](VUDA.md). Реальный каталог инструментов проверяется по текущему подключению, а не по догадке.

Целевые проверки: `node --test lib/postman-devspace.test.js` из Harness plugin, `python -m unittest postman.devspace.tests.test_devspace` из репозитория и затронутые Direct/Bridge/observer/Ask/image suites. Source PASS не обновляет активный Host и не означает live GUI PASS. Установка/переключение и stable preview — отдельные согласованные действия.
