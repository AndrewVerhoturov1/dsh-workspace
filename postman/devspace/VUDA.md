# VUDA: внешний ChatGPT через туннель, местные агенты напрямую

## Выбор маршрута

| Исполнитель | Рабочий маршрут | Условие |
|---|---|---|
| Внешний ChatGPT, в том числе PostmanDevspace | Плагин `VUDA Local` → OpenAI Secure MCP Tunnel → местный VUDA stdio | Плагин подключён в нужном ChatGPT workspace и его инструменты предъявлены текущему чату |
| Местный агент DSH | Прямой местный VUDA MCP, подключённый к Host | Инструменты доступны конкретной роли; туннель и облачный плагин не нужны |
| Исполнитель с разрешённым shell, без прямых VUDA-инструментов | Установленный MCP SDK → VUDA stdio через `vuda-runtime.mjs` | Исполнение и точечные пути разрешены; для внешнего ChatGPT нужен работоспособный DevSpace Bash |

VUDA работает с местным скрытым Chromium (`VUDA_BROWSER_PROVIDER=local`), а не с
личным Chrome, Windows GUI или встроенным браузером Orca. У местного MCP и туннеля
отдельные серверные сеансы; страницы и входы между ними автоматически не переносятся.
Все чаты одного туннеля, напротив, обращаются к одному серверу и общему VUDA-браузеру:
Leader сериализует связанные действия разных lanes. Scope, writer binding и штатные
Bridge/bell сохраняются; смена инструмента не разрешает обход отказа безопасности/прав.

## Внешний ChatGPT: подключённый VUDA Local

Используй подключённые инструменты по предъявленным схемам и проверяй эффект нужных
действий чтением состояния/снимком. Предварительная проверка серверных provider/dotenv
не нужна: эти параметры задаются при запуске сервера, а не при работе чата через MCP.
Полный каталог собирай, когда задача требует инвентаризации.
При проверке реальных событий читай
`event.isTrusted`, не создавай события программно. Полную приёмку при каждой задаче
повторять не нужно. `screenshot://...` — ресурс сеанса; нужный image-блок сохрани в
разрешённую область, без вывода base64 в чат.

Отсутствие инструментов в чате и недоступность местного сервера — разные факты.
Bash/SDK-вариант ниже применим только при разрешённом и работающем Bash. При недоступном
bell результат доступным текстом остаётся `text_fallback` по действующему контракту.

## Обслуживание установленного туннеля местным агентом

Проверенная Windows-установка: официальный `tunnel-client` v0.0.16, alias `vuda-local`.
Клиент находится в
`%LOCALAPPDATA%/DSH/tools/openai-tunnel-client/v0.0.16/bin/tunnel-client.exe`,
частная конфигурация и запуск VUDA — в `%LOCALAPPDATA%/DSH/integrations/vuda-tunnel/`.
Ключи, частные профили и журналы не копируй в Git или опубликованный REQ.

Для проверки уже работающего клиента вызови `runtimes status vuda-local --json`.
Проверь `process_running`, `healthy`, `ready`; по возвращённому `health_details_url`
проверь успешный polling компонента `control-plane`. Порт бери из ответа клиента.
До первого MCP-вызова `not_observed` допустим; наличие инструмента проверяется в чате.

Постоянный запуск на этом ПК обеспечивает задача Windows `DSH VUDA Local`: при входе
пользователя и каждую минуту, с `IgnoreNew` для уже работающего экземпляра. Если клиент
остановлен и запуск разрешён задачей, используй `Start-ScheduledTask -TaskName 'DSH VUDA Local'`.
`Run-VudaTunnel.ps1` читает сохранённый Windows DPAPI ключ `tunnel-key.dpapi`, запускает
штатный managed runtime и ожидает его завершения. Закрытие окна ввода ключа и перезапуск
Harness не должны останавливать эту отдельную задачу.

Первое сохранение или замену ключа человек выполняет через установленный
`Connect-VudaTunnel.ps1` в видимом PowerShell. Ввод скрыт; ключ сохраняется зашифрованным
для этой учётной записи Windows, с доступом к файлу только у пользователя и SYSTEM.
Агент ключ не извлекает; на странице ключей не запрашивай полное состояние/снимок.
Достаточно прав `Tunnels: Read, Use`, без admin key. При ручном
`runtimes connect` используй существующий `--tunnel-id` и только одну область:
`--workspace-id` **либо** `--organization-id`.

Для одного tunnel id запускай один клиент. Повторный `connect` работающего alias не
заменяет ключ; согласованная замена требует штатного stop/connect своего runtime.
Ключами управляет пользователь. Сохраняй изоляцию окружения установленного launcher:
runtime API key не передаётся VUDA. Недостающие пакеты автоматически не загружай.

Повторный ввод при обычном запуске не нужен; новый ключ требуется при истечении срока,
отзыве или утрате сохранённого ключа. После запуска проверь готовность и нужный вызов
из ChatGPT. Заверши собственные тестовые ресурсы; общую задачу и клиент не останавливай
без поручения. Зашифрованный ключ и частные runtime-файлы остаются вне репозитория.

Официальные источники: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels),
[клиент](https://github.com/openai/tunnel-client),
[подключение ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt).
Границы принятого теста — [таблица возможностей](../POSTMAN_DEVSPACE_CAPABILITIES.md#vuda-local-через-secure-mcp-tunnel-20-октября-2026).

## Установленный VUDA через местный SDK или разрешённый DevSpace Bash

Этот вариант использует уже установленный VUDA 1.1.0 и его MCP SDK, не требует
туннеля и не добавляет MCP namespace в каталог агента. Его можно использовать местно
при разрешённом shell и отсутствии ролевого запрета; внешний ChatGPT выполняет эти
команды только через разрешённый настоящий DevSpace Bash целевого Windows-ПК.
Пакеты не устанавливаются, настройки Host не меняются.

Для Postman сначала прочитай закреплённое задание и правила. Leader должен разрешить чтение
локатора, пустого dotenv-файла и исполнение установленного VUDA/SDK из его npm cache.
Файлы отчёта и снимки сохраняй только в назначенный writeRoot. Наличие этого примера
само по себе доступа не выдаёт.

Из корня разрешённой исходной установки:

```sh
node postman/devspace/vuda-runtime.mjs --describe
node postman/devspace/vuda-runtime.mjs --list-tools
```

Первая команда только находит entrypoints. Вторая запускает собственный stdio-сеанс,
читает все страницы `tools/list` и закрывает его. Каталог содержит реальные схемы.
Не ищи сервер только по имени команды: bin-поля пакета — `vuda` и
`visual-ui-debug-agent`, а глобальная установка npm не обязательна.

Связанные действия выполняй внутри одного `withVudaClient`, иначе следующий процесс
не получит состояние предыдущей страницы. Пример для собственной контрольной страницы
с кнопками `#clicker`, `#hoverer`, полем `#entry` и `window.testState` (адрес сервера и
путь к модулю замени на фактически разрешённые):

```sh
node --input-type=module <<'VUDA'
import { pathToFileURL } from 'node:url';
const { withVudaClient } = await import(pathToFileURL(
  'C:/Users/Andrew/.dsh/postman/devspace/vuda-runtime.mjs').href);
await withVudaClient(async client => {
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result;
  }
  await call('playwright_navigate', { url: 'http://127.0.0.1:8765/', waitUntil: 'load' });
  await call('playwright_click', { selector: '#clicker' });
  await call('playwright_hover', { selector: '#hoverer' });
  await call('playwright_fill', { selector: '#entry', value: 'vuda-check' });
  await call('playwright_press_key', { key: 'Enter', selector: '#entry' });
  console.log(JSON.stringify(await call('playwright_evaluate', { script: 'window.testState' })));
  const shot = await call('playwright_screenshot', { name: 'vuda-check', fullPage: false });
  // Сохрани image-блок снимка в выданный writeRoot; не печатай его base64 в чат.
  console.log(JSON.stringify({ screenshotReceived: shot.content.some(c => c.type === 'image') }));
});
VUDA
```

Модуль задаёт `VUDA_BROWSER_PROVIDER=local`, пустой `DOTENV_CONFIG_PATH` и передаёт
серверу только служебное окружение ОС. `withVudaClient` закрывает свой MCP-клиент
и дочерний сервер в `finally`, в том числе при ошибке действий. Свой HTTP-сервер
закрой отдельно штатным native job control.

`VUDA_RUNTIME_UNAVAILABLE` означает, что в проверенных местах не найден полный комплект;
это не доказательство отсутствия VUDA на всём ПК. `VUDA_CONNECT_FAILED` — ошибка запуска
найденного комплекта. В обоих случаях сохрани точную диагностику и не устанавливай
зависимости без решения пользователя. Этот маршрут не добавляет namespace в каталог
ChatGPT и не является доказательством штатной доставки Leader → Bridge → ChatGPT.
