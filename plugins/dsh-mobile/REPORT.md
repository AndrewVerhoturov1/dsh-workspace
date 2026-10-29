# Отчёт реализации dsh-mobile v6

Исходный запрос: REQ_20261029T013008Z_8003. Адресная проверка: REQ_20261029T015805Z_6300.
**Статус: принятая реализация с явным исключением управления child controls.** Пользователь выбрал завершение без этих действий у дочерних агентов; Host API не расширялся. Исходные результаты и исторические NEED_DECISION/NOT_RUN ниже сохранены как снимки прежних этапов, не как текущий статус. Финальная геометрия 320/412 подтверждена; live Host/Android не проверялись. Действующая DSH не изменялась.

## Рабочее дерево

- Корень: `C:\Users\Andrew\AppData\Local\DSH\worktrees\android-mobile-web-client-v6`
- Репозиторий: `AndrewVerhoturov1/dsh-workspace`
- Ветка: `task/android-mobile-web-client-v6`
- HEAD и task base: `21a3c0da3452bd65b18633ff355ff8deb646bfa2`
- `origin/main` локально на один коммит впереди task branch; база намеренно не менялась.
- Локального `origin/task/android-mobile-web-client-v6` ref нет.
- Commit, push, PR, merge: NOT_RUN, выполнит Worker.

## Изменения (только каталог плагина)

- `plugins/dsh-mobile/package.json`: пакет Web rc.2 и скрипты.
- `plugins/dsh-mobile/cordis.patch.yml`: opt-in Loader entry.
- `plugins/dsh-mobile/scripts/build.mjs`: сборка без новых зависимостей.
- `plugins/dsh-mobile/src/index.js`: GET /mobile, ограниченный просмотр проектов, точечный durable unarchive через установленный WorkspaceRegistry.
- `plugins/dsh-mobile/src/client.js`: мобильные экраны и реальные runtime/API rc.2.
- `plugins/dsh-mobile/src/mobile.css`: стили принятого компактного messenger v6, только внутри mobile-области.
- `plugins/dsh-mobile/lib/index.js` и `lib/client.js`: собранные Host/Client артефакты.
- `plugins/dsh-mobile/.gitignore`: исключения из корневого игнорирования lib — собрать и включить именно эти два JS при публикации.
- `plugins/dsh-mobile/tests/host.test.mjs`: пути/права/архи́в/HTTP/HTML CSP.
- `plugins/dsh-mobile/tests/client.test.mjs`: десктоп без mobile, выбор чатов (включая обычный fork), Task, вопросы, Markdown, проекции.
- `plugins/dsh-mobile/tests/rc2.test.mjs`: исходники установленного rc.2 WebServer и настоящий ClientModuleSystem в изолированном VM.
- `plugins/dsh-mobile/README.md`: порядок подключения без активации.

## Выполненные проверки

- `node plugins/dsh-mobile/scripts/build.mjs`: PASS, созданы оба lib-файла.
- `node --check plugins/dsh-mobile/lib/client.js`: PASS.
- `node --test plugins/dsh-mobile/tests/host.test.mjs`: 6/6 PASS (синтетические файлы и состояние; после проверки исходники Host не менялись).
- `node --test plugins/dsh-mobile/tests/client.test.mjs`: 5/5 PASS после адресного исправления обычных fork-сессий и выбора моделей.
- `node --test plugins/dsh-mobile/tests/rc2.test.mjs`: 3/3 PASS. Использованы реальные `dsh-client-modules/lib/client.js` и `dsh-host-webserver/lib/index.js` из установленной DSH `0.1.1-rc.2`. Выполнена материализация собранного Web-плагина через фактический module loader, а также in-process регистрация и сопоставление маршрутов WebServer.
- Сумма целевых проверок по последним релевантным входам: **14 PASS / 0 FAIL**.
- Проверка Git: только новые файлы `plugins/dsh-mobile`; `git diff --check` для tracked изменений без замечаний. Generated `lib/*.js` подтверждены видимыми в `git status --untracked-files=all` благодаря локальному исключению игнорирования.

## Граница доказательств

Unit: клиентский React в подставной среде и синтетические проекты/сессии.
Integration: реальные установленные компоненты загрузчика и WebServer rc.2, запускаемые в памяти с тестовой композицией; без активного пользовательского Host, моделей, API-ключей и сетевых портов.
Live DSH / Android / браузерная геометрия 320–412: **NOT_RUN**; визуальный и живой PASS не заявляются.

Установленная DSH, активный GUI 4173, пользовательские настройки, credentials, сетевые маршруты и постоянные worktree не изменялись. Фоновые задания не запускались; штатный список DevSpace jobs показал только `TREE_SETTLED`, работающих деревьев нет.

## Эксплуатационные ограничения

- Host/Origin фильтр в rc.2 — не аутентификация пользователя. Плагин не публикует новый удалённый доступ.
- `localhost` на Android — это телефон, не Windows Host. Произвольного прокси нет; частные HTTP(S) ссылки открываются напрямую только при реально существующей маршрутизации.
- Файловый просмотр ограничен зарегистрированными Workspace roots, относительными каноническими путями и разрешёнными типами; HTML отрезан от Host origin через sandbox.
- Восстановление архива использует установленный, но не публичный контракт `WorkspaceRegistry.enqueueOperation/requireState/setState`; при обновлении DSH этот узкий участок нужно проверить повторно.
- Повторная отправка сообщений после неоднозначного обрыва не выполняется автоматически.
- Реальная установка профиля, отдельно разрешённый restart и приёмка на Android относятся к последующему этапу Worker/владельца.

## Адресная доработка и приёмка — REQ_20261029T015805Z_6300

**Статус: NEED_DECISION по полноте v6.** Доступные части доработаны без изменения ядра/профиля. Результаты предыдущего REQ выше относятся к его первоначальной проверке; текущее состояние ниже.

### Изменено после исходных 14 PASS

- `src/client.js`: строки чатов показывают **только фактически загруженный последний текст** из `session.getSnapshot()`, без объяснений «Нажмите, чтобы вернуть» / «Открыть переписку». Никакого чтения скрытой истории или придуманной строки. Создание сначала применяет model/effort/название, потом открывает чат. При обновлении существующего чата распаковывает **настоящий rc.2 ответ** `{selected: ModelSelection}`, а не ошибочно трактует envelope как саму selection. `/compact` сообщает об успехе только при `matched: true`.
- `src/mobile.css`: высота текстового поля поиска и двух select изменена с 42 до **44 CSS px** (по результату DOM-проверки на 320 px).
- `lib/client.js`: пересобран с актуальными JS/CSS.
- `README.md`: исправлена инструкция активации на **реальную** `dsh plugin --profile web add "link:C:/Users/Andrew/.dsh/plugins/dsh-mobile"` после публикации Worker; подтверждена исходниками установленной rc.2 `dsh/lib/bin.js`, `plugin-9h8shc4d.js`, `profile-boot-DG5t9aNs.js`. CLI автоматически согласует `dsh.profile.bundles` в выбранном профиле; глобальную DSH не переустанавливает. Команда **не исполнялась**.
- `tests/client.test.mjs`: реальная последняя строка и отсутствие поясняющих заглушек.
- `tests/rc2.test.mjs`: исполняемая проверка установленного `agentFor` на live/cold subagent ownership; доказательство Typert-командного пути.
- `tests/archive-rc2.test.mjs`: адресный интеграционный тест настоящих установленных `WorkspaceRegistry`, Host `domain/changed` callback и `WorkspaceManager.handleHostEnvelope` через синтетическое хранилище. Фактическая цепочка `restoreArchived → global.set → domain/changed → host/archived-sessions-changed → WorkspaceManager.getSnapshot` пройдена.
- `tests/browser/server.mjs`, `tests/browser/harness.html`, `tests/browser/harness.js`: частная синтетическая Web-страница, запускаемая исключительно для DOM-проверки **на настоящих React и ReactDOM из установленного browser bundle rc.2**. Не является Host и не читает пользовательский профиль. Реальные вызовы модели/перезапуска исключены.

### Ограничение владения дочерним агентом — доказано установленным rc.2

- `@deepseek-ai/dsh-api-remotes/lib/types/agent-lookup.js`: `hasApiRemoteSubagentOwner` проверяет `session.header.origin === 'subagent'`; `createApiRemoteAgentResolver/agentFor` возвращает `agent-busy` как для attached/live, так и для cold child.
- `@deepseek-ai/dsh-host-apiproxy/lib/index.js`: `sessions.models` и `sessions.selectModel` вызывают `agentFor(sessionId)`; результат `agent-busy` не разрешает смену модели/effort дочернего Agent.
- `@deepseek-ai/dsh-client-runtime/lib/client.js`: `Session.command` вызывает `this.remote.commands.execute(this.sessionId, line, [])`, которое идёт через Typert agent lookup. Для дочернего адресата это та же граница владения; маршрутизировать `/compact` в root нельзя.
- `@deepseek-ai/dsh-host-apiproxy/lib/types/api/subagents.d.ts`: parent-owned remote API ограничен `list/history/prompt/interrupt`, команд `models/selectModel/compact` нет.
- Установленный Host `sessions.selectModel` после обновления конкретного Agent **также** вызывает `defaults.saveDefaultModelSelection?.(selected)`. Безопасный плагин не обещает абсолютной независимости default модели.
- **Итог:** реальная модель/effort и `/compact` выбранного **continuable-child** остаются НЕ РЕАЛИЗОВАНЫ; их реализация требует нового, проверяющего parent ownership Host-контракта вне разрешённых файлов. Нельзя обходить `agent-busy`, подменять child root или отправлять slash-команду как обычный prompt. Нужны решение пользователя (отложить parity или отдельно разрешить Host API), не новый набор обходов.

### Новые проверки (не повторяются уже сохранённые неизменные PASS)

- `node --test tests/archive-rc2.test.mjs`: **1/1 PASS** — установленные классы и Host callback, синтетическое хранилище; не реальный Host.
- После релевантных клиентских и test-правок `node --test tests/client.test.mjs tests/rc2.test.mjs`: **9/9 PASS**. Ранее пройденные `tests/host.test.mjs`: **6/6 PASS**, границы серверной логики не менялись. Сумма действующих адресных проверок по релевантным входам: **16 PASS, 0 FAIL**.
- `node scripts/build.mjs` и `node --check lib/client.js`: **PASS** после правки CSS и командной квитанции; собранный клиент синхронизирован с исходниками.
- **VUDA Local, настоящий браузерный React + установленный rc.2 module loader, synthetic fixture, 320 CSS px:** подтверждены отображение чатов и последнего текста, создание с preset/папкой/model=beta/effort=high **до первого prompt**, динамический per-chat selectModel envelope, отправка/stream/stop/continue, `/compact` для root, ранняя история, `contextPressure=31%`, вопрос через `PendingWait.respond`, Task корень/ребёнок/внук, parent, readonly one-shot и continuable prompt с точным direct-parent адресом; архив/возврат, MD/HTML с sandbox iframe, отказ localhost URL, restart confirmation и `POST` fixture с `202=requested`. Это **DOM + действия** через инструменты MCP, без скриншотов и без реального пользовательского Host.
- Измерение 320 px **до** последней CSS-правки: переполнения элементов на экранах действий и чата не обнаружены, найдено `height:42px` у select (также поиск был 42px); исходный CSS исправлен на 44px. **Повторная 320 и проверка 412 после изменения — NOT_RUN**, поэтому геометрический PASS последней версии не заявляется.
- Последующие вызовы VUDA отказали: `page.evaluate: Target crashed`, затем навигация `net::ERR_CONNECTION_REFUSED` к синтетическому порту 38651. Отдельных Chrome/Playwright/CLI-подмен или снимков не запускалось.

### Фоновые задания и область

- Тестовый HTTP fixture запускался только на `127.0.0.1:38651`; токенов, user settings, чатов, реальных Agent и model calls не было. Первый собственный job `19b8d685-0b26-4040-a520-7fafcf5a5b7a` остановлен с `TREE_SETTLED`.
- Второй собственный job **`e4c59360-f9a8-4714-beb6-6c451153af1c`**: после сбоя DevSpace состояние `UNKNOWN`, `treeSettled=false`, `evidence=GENERATION_CENSUS_LOST`; адресный `execution='stop'` повторил `UNKNOWN`. Целевой TCP порт 38651 проверен: **NOT_LISTENING**. Не утверждать надёжного подтверждения завершения процесса по одному порту. Новый конфликтующий сервер не запускался.
- Изменения только в `plugins/dsh-mobile/`; установленная DSH, GUI4173, пользовательские настройки и сеть не менялись, Git commit/push/PR/merge запрещены и не выполнялись.
- **Осталось для окончательной приёмки на момент этого предыдущего REQ:** решение о Host-owned child settings/compact; браузерная геометрия 320/412 после CSS-правки при восстановленном MCP/job lifecycle; реальный Android/live Host не проверялись по пределу поручения.

## Завершающая ограниченная геометрическая проверка — REQ_20261029T034347Z_2354

**Результат этого этапа: DONE.** Этот раздел заменяет прежнюю отметку `NOT_RUN` о геометрии *после CSS 44px* в историческом отчёте выше. Работы по parent-owned моделям и `/compact` дочерних агентов не выполнялись: явным решением пользователя эти child controls исключены из scope (вариант «Завершить без этих действий у дочерних агентов (Рекомендуется)»); Host API не расширялся. Это текущее принятое ограничение, а не ожидающее решения.

### Измерения окончательной сборки через VUDA Local

- После проверки занятого порта и собственных процессов запущен прежний isolated synthetic fixture `plugins/dsh-mobile/tests/browser/server.mjs`, без реального Host, ключей, пользовательских переписок и model calls.
- VUDA Local MCP открыл `http://127.0.0.1:38651/?mobile=1`; подтверждены `window.__fixturesReady === true`, настоящий React из установленного rc.2 browser bundle и CSS с `height:44px`.
- Проведены **14 DOM-измерений**: на **320 и 412 CSS px** по семь экранов — `Чаты`, `Новый чат`, `Переписка с агентом` (включая composer), `Task`, `Вопрос агента`, `Результаты`, `Действия`.
- Через `getBoundingClientRect` измерено суммарно **115 видимых интерактивных элементов/целей** по этим 14 состояниям (повторяющиеся при навигации элементы учитываются в каждом состоянии). Для обеих ширин: **0 горизонтальных выходов** за границы мобильной оболочки, **0 недопустимо малых touch targets**. Критерий: высота **не меньше 44 CSS px** с допуском измерения 0,5 px; для маленьких radio/checkbox проверяется кликабельная обёртка `label`.
- Все измерения дали `errors: []`; `#error` стенда пуст, значения ширины оболочки равны 320/412. Зафиксирована таблица пройденных состояний: `320:list,new,chat,task,question,results,actions`, `412:list,new,chat,task,question,results,actions`.
- **Геометрия конечного CSS: PASS (DOM, 320/412).** Ни скриншотов, ни пиксельной визуальной оценки не выполнялось. Настоящий Android и действующий пользовательский Host не тестировались.

### Фоновые процессы и отсутствие зависимости от Temp

- Прежнее собственное управляемое задание `e4c59360-f9a8-4714-beb6-6c451153af1c` по-прежнему имеет у менеджера **`UNKNOWN`**, `treeSettled=false`, `GENERATION_CENSUS_LOST`. Это **не** объявлено подтверждённым штатным завершением задания.
- До нового запуска **и после** остановки: `Get-NetTCPConnection` показал `38651: NONE`, адресная проверка `Win32_Process` по точной команде `plugins/dsh-mobile/tests/browser/server.mjs` — **`OWN_FIXTURE_NODE_PROCESSES NONE`**. Эти отдельные факты исключили конфликт с прежним fixture, но не исправляют старую запись `UNKNOWN`.
- Новый собственный managed job: `202a42d2-43cc-4c50-b0a7-6abd18b2e78d`. После проверки выполнен адресный `execution=stop`; ответ **`TREE_SETTLED`, `treeSettled=true`, `exitCode=1`** (штатная остановка работающего тестового сервера, не результат теста). Новых работающих fixture Node процессов и слушателя порта нет. Чужие фоновые задания/браузеры не останавливались.
- Сборочные файлы, документация, тестовые HTML/JS, `REPORT.md` и работа самого fixture находятся в `C:/Users/Andrew/AppData/Local/DSH/worktrees/android-mobile-web-client-v6/plugins/dsh-mobile`; разрешённые статические библиотеки rc.2 читаются из `C:/Users/Andrew/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh`. Поиск ссылок на `AppData/Local/Temp`, прежнее `dsh-android-mobile-v6` и `/tmp/` в файлах плагина дал **NONE**. Нужные этой задаче исходники и собственный тестовый сервер **не зависят от прежнего Temp worktree**; состояние отдельного общего VUDA MCP-браузера не копировалось и не очищалось.
- На этом этапе изменён **только данный REPORT.md**. Исходники и CSS не требовали новой правки; прежние успешные unit/integration tests без изменённых входов повторно не запускались. Git commit/push/PR/merge, установка, изменение сети и перезапуск действующей DSH/GUI4173 не выполнялись.

**Итоговая граница:** child model/effort controls и child `/compact` исключены по явному решению пользователя; текущую DSH и Host API не меняли. Задача реализации завершена для принятого scope. Live Host/Android и установка остаются `NOT_RUN` и требуют отдельного разрешённого этапа.


