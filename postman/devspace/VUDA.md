# Установленный VUDA через DevSpace Bash

Этот маршрут нужен ChatGPT, у которого нет прямых VUDA-инструментов. Он использует
уже установленный VUDA 1.1.0 и его MCP SDK. Пакеты не устанавливаются, настройки Host
не меняются. Команды выполняются на целевом Windows-ПК через настоящий DevSpace Bash.

Сначала прочитай закреплённое задание и правила. Leader должен разрешить чтение
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
