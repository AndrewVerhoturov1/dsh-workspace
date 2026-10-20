# VUDA: наблюдение и взаимодействия, не итоговый gate

Для местного агента это прямой VUDA MCP в DSH, без OpenAI Tunnel и без облачного плагина ChatGPT. Отдельный маршрут внешнего ChatGPT — `VUDA Local` через Secure MCP Tunnel; порядок выбора описан в [VUDA.md](../../../../postman/devspace/VUDA.md). Эти подключения не переносят между собой страницы и входы.

VUDA — отдельный MCP browser backend для нахождения компонентов и проверки действий. Для обычных агентов профиль явно задаёт `VUDA_BROWSER_PROVIDER=local`; общий `postman/devspace/start-vuda.mjs` для установленной версии 1.1.0 задаёт `headless: true`, `channel: 'chromium'` и `--enable-gpu`, без видимого окна. Это собственный сеанс VUDA; он не использует личный Chrome, браузер Postman или сеанс Playwright MCP. В исходном `profiles/web/cordis.patch.yml` добавлен `mcp-vuda` версии `1.1.0`, но эта правка **не активирует** Host. Применять инструменты ниже **только если VUDA действительно доступен** и разрешён ролью. У `1.1.0` сообщалось о сбое запуска при импорте `dotenv/config`: `DOTENV_CONFIG_PATH` указывает на существующий намеренно пустой файл `<DSH_HOME>/.agents/skills/pixel-perfect-ui-port/references/vuda-empty.config` в исходной установке, без зависимости от ручной глобальной копии навыка, но не гарантирует наличия пакета `dotenv`; общий launcher удаляет унаследованные credentials. При ошибке запуска, `missing` или `forbidden` останови **именно недоступный вызов**, не имитируй VUDA и не заявляй успешную интеграцию. Уточни, относится ли отказ к конкретной роли/подключению либо к разрешениям всей задачи. Для местного агента допустим только реально разрешённый прямой VUDA MCP; для внешнего ChatGPT — его штатный `VUDA Local` или заранее разрешённый DevSpace Bash → SDK согласно [VUDA.md](../../../../postman/devspace/VUDA.md). Отсутствие инструмента у одной роли не доказывает недоступность другой. Явный запрет пользователя, Host или scope запрещает переназначение с целью обхода. Если нет ни одного разрешённого маршрута, сообщи `CAPABILITY_UNAVAILABLE` и останови этап, требующий VUDA; независимую разрешённую диагностику не блокируй.

## Поиск компонента

Открыть reference и target через `playwright_navigate` (HTTP URL); через `playwright_evaluate` и при необходимости `dom_inspector` найти границы и устойчивые selectors. Предпочтение: `data-testid`/`data-qa`, затем `id`, доступные роли и ARIA, устойчивые классы; positional selector — в последнюю очередь. Составить очередь визуальных компонентов, выбрать первый и сохранить пару selectors в конфигурации verifier.

Для разового наблюдения возможны stateless `dom_inspector`, `screenshot_url`, `enhanced_page_analyzer`, `visual_comparison`. **Нельзя предполагать**, что такие вызовы сохраняют браузерный контекст или открытое состояние компонента между вызовами.

## Состояние браузера и реальные действия

Для последовательного исследования после `playwright_navigate` оставаться на direct-инструментах одного контекста:
`playwright_hover`, `playwright_click`, `playwright_press_key`,
`playwright_evaluate`, `playwright_screenshot`, `playwright_console_logs`.
Проверять реальным click/hover/keyboard, что tooltip, меню и модальные окна открываются и закрываются. Для ограниченно управляемого dev/test состояния допустим `playwright_evaluate`, но он не доказывает функциональный click.

До изменения внешнего вида сохранить исходные ошибки консоли и результат игровых действий. После изменения повторить те же действия, сверить консоль и зафиксировать новые критические ошибки. Критичные состояния `hover`, `disabled`, `selected`, `modal`, `tooltip` проверить отдельно, если они есть; не добавлять автоматическую матрицу состояний.

## Финальная проверка

VUDA `visual_comparison` и VUDA screenshot не дают финальный PASS. Только `node scripts/check.mjs --config ...` создаёт контролируемые `reference.json/.png`, `target.json/.png`, `report.json`, `diff.png` и выдаёт visual PASS/BLOCK. Конкретное UI-состояние, достигнутое через VUDA, не переносится автоматически в отдельный процесс Chromium verifier v1: verifier охватывает default state. Функциональную и state-проверку записывать отдельно от visual gate.
