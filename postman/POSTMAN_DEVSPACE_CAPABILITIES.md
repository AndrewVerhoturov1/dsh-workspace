# PostmanDevspace — возможности и ограничения

Эта таблица хранит факты и пределы прежних проверок, а не действующие guards Host. Текущий контракт — [POSTMAN_DEVSPACE_FLOW.md](POSTMAN_DEVSPACE_FLOW.md): явные решения Leader, без Git-подготовки Host, автоматических восстановительных REQ и блокировок по старой неопределённости; готовый отчёт доступен независимо от Luna. Новая модель требует собственной приёмки после отдельной установки.


Обновлено: 24 октября 2026. Источник истины для действий Leader — реальные Host scopes и подтверждённый результат конкретного REQ. Эта таблица разделяет **живую проверку старой установки**, **текущие тесты ветки PR #433** и **проверки конкретного подключения ChatGPT/локального исполнителя**. Запись в main/публикация PR не доказывает, что active DSH Host уже загрузил новый код.

| Возможность | Статус | Доказательство / ограничение |
|---|---|---|
| Реальный DevSpace: read/private WRITE_TEST, bell → Luna → Leader | VERIFIED_LIVE_PREVIOUS | Живые Stage1/2/3 тесты 12–13.10, Host-связка, корректная identity; не доказывает availability в новой беседе |
| Branchless READ_ONLY | VERIFIED_LIVE_PREVIOUS | Прежний DSH Leader выполнил живой READ_ONLY запрос без Git task branch |
| WRITE_ISOLATED в подготовленном task worktree | VERIFIED_LIVE_PREVIOUS | Реальная запись test-файла через DevSpace; readback и Git status показали ровно один новый файл |
| Продолжаемая Luna и тот же ChatGPT чат | VERIFIED_LIVE_PREVIOUS | Два независимых REQ на прежней одной Luna/беседе, bell DONE для обоих |
| Три одновременные DevSpace линии и 4-й отказ | CODE_TEST_PASS_NO_GUI | PR #433, 3 разных laneId/Luna/REQ, четвёртый admission rejected; после настоящего Host deployment необходим GUI 4173 E2E |
| Повторный REQ к exact lane_id | CODE_TEST_PASS_NO_GUI | Пробный JS test: same child/conversation, отдельный новый REQ; не путать с новым ChatGPT-чатом |
| Native PNG/JPEG/WebP/GIF reference input в DevSpace | CODE_TEST_PASS_NO_GUI | Host pin+verified handoff, Playwright native upload. Legacy @PostmanImage ранее проверен вживую |
| Другие входные файлы, safe private ZIP input | CODE_TEST_PASS_NO_GUI | ZIP только как transport входов; не требовать ZIP результата ChatGPT |
| GPT Image output внутри универсального DevSpace | CODE_TEST_PASS_NO_GUI | Обнаружение одного изображения только в exact assistant turn, native source bytes, приватный PNG/JPEG/WebP, decoder+SHA; требуется живой GPT Image E2E |
| Веб-исследование ChatGPT DevSpace | PARTIAL_LIVE | В GUI подтверждена доставка `text_fallback` с двумя официальными URL и независимая проверка фактов; для получения текстовых ссылок не просить bell. Вызов `web.run` сообщён ChatGPT, но без отдельного trusted audit доказательство его запуска отсутствует |
| Secretary: доступные web_search/web_fetch | CODE_REQUIRES_PROVIDER | Роль допускает зарегистрированные инструменты; отсутствующий провайдер — диагностика и маршрут через Leader/DevSpace, без нового API |
| Secretary journal независим от Git task | CODE_TEST_PASS_NO_GUI | Host-private durable ledger теперь доступен до prepare; cold reopen test |
| External explicit workspace_root: read/write | CODE_TEST_PASS_NO_GUI | Exact Leader grant на существующий canonical путь; пересечение с постоянным repo запрещено, изолирующей ОС-песочницы DevSpace нет |
| Передача Computer Use allow/deny из Host | CODE_NOT_LIVE | Явное allow/deny в task, без Host списка приложений/target adapter; фактическая доступность зависит от ChatGPT |
| Computer Use: границы | USER_SCOPE_AND_PROVIDER | Пользовательская область, правила поставщика и права ОС; инструкция deny не выдаётся за аппаратную изоляцию |
| Leader steer после SEND_UNKNOWN | VERIFIED_LIVE_PREVIOUS | Host receipt SENT_CONFIRMED и точный bell того же REQ, без нового origin Send |
| Preempt/Stop активного DevSpace инструмента | CODE_NOT_LIVE | Распознанный Stop своего чата допускается при ACTIVE_TOOL/UNKNOWN; не доказывает остановку Bash; composer может ждать более 10s |
| Text fallback без местного bell | VERIFIED_LIVE_PREVIOUS | Результат `source=text_fallback`, diagnostic UNKNOWN, без выдуманного DONE |
| Cold bell → старая Luna → Leader после Host restart | VERIFIED_LIVE_PREVIOUS | Получено DONE в прежнем Host каналe, Leader получил terminal, blind resend не было |
| Legacy @Postman, @PostmanAsk, @PostmanImage | PRESERVED_FALLBACK | Оригинальные маршруты остаются рабочими, автопереключения после UNKNOWN нет |
| Worker Git commit/push/PR | PERMISSION_BOUND | Только отдельно разрешённый локальный task branch/worktree по REPO_POLICY.md |
| Sol backup | PERMISSION_BOUND | Только конкретный блокер возможности/доступности DevSpace, не default из-за сложности |

### Orca и VUDA: проверка 19 октября 2026

| Маршрут | Статус | Доказательство / граница проверки |
|---|---|---|
| ChatGPT → DevSpace Bash → встроенный браузер Orca | TARGET_SESSION_PASS_REPORTED | Пользователь передал PASS из целевой ChatGPT-сессии: Orca 1.4.229, область `C:/Users/Andrew/.dsh`, DOM, click/hover/Enter с `isTrusted=true`, ввод и скриншот. Тот же сценарий независимо выполнен локальным исполнителем через DevSpace. Это не новая проверка штатной доставки Leader → Bridge |
| DevSpace Bash → `orca computer` → Windows-окно | VERIFIED_LOCAL_VIA_DEVSPACE | Orca 1.4.229, `orca-computer-use-windows` 1.0.0. Собственное временное WinForms-окно: дерево доступности, set-value с readback `verified`, результат click на снимке, Enter в прочитанном состоянии. Пользовательские приложения не изменялись; целевой ChatGPT этот сценарий ещё не повторял |
| DevSpace Bash → MCP-клиент → VUDA stdio | VERIFIED_LOCAL_MCP_VIA_DEVSPACE | Установленный VUDA 1.1.0 предъявил 29 инструментов одной страницей. Через MCP проверены navigate/click/hover/fill/press_key/evaluate/screenshot на тестовой HTTP-странице; click/hover/Enter дали `isTrusted=true`. Через соединитель DevSpace отдельно подтверждены MCP-навигация и чтение страницы. Это не отдельное VUDA-подключение в каталоге ChatGPT |
| Запуск закрытой Orca на целевом ПК | DOCUMENTED_NOT_LIVE_TESTED | Штатная команда `orca open --json` запускает Orca и ждёт runtime; команда подтверждена руководством/CLI help. Для проверки работающую пользовательскую Orca не закрывали |

В этих проверках весь `C:/Users/Andrew` возвращал `WRITER_BINDING_REQUIRED`, тогда как
назначенная узкая область `.dsh` допускала команды. Найдены пересекающиеся сохранённые
writer holds; их не удаляли. Этот факт не разрешает менять выданный Host writeRoot:
исполнитель использует область задания, а повторный отказ передаёт Leader.

Orca CLI, VUDA и установленные библиотеки, вызываемые через Bash, не считаются отдельными
инструментами каталога ChatGPT. После изменения версии или подключения прежний PASS
не переносится автоматически; проверяются только затронутые операции. Рабочие правила
запуска и выбора маршрута находятся в [инструкциях исполнителя](devspace/SKILL.md#orca-и-vuda-на-целевом-пк).

### Повторная приёмка и исправление маршрута VUDA, 20 октября 2026

Отчёт настоящего ChatGPT по `REQ_20261019T183841Z_9367` подтвердил новые инструкции,
writer binding и Windows GUI (ввод/readback, click=1, Enter=1, снимок), но получил
квитанции Orca click/Enter без DOM-событий. Задание было прочитано после первых действий.
VUDA не запускался: проверялись PATH, npm global и каталоги, в которых пакета нет.
Это не отменяет старых отказов и не доказывает отсутствие установленного сервера.

| Проверка исправления | Статус | Доказательство / граница |
|---|---|---|
| Установленный VUDA и MCP SDK | VERIFIED_LOCAL_VIA_DEVSPACE | В npm exec cache найден полный VUDA 1.1.0 с SDK и dotenv; [локатор](devspace/vuda-runtime.mjs) обнаруживает их без установки и без фиксированного cache hash |
| Семь VUDA-действий через `withVudaClient` | VERIFIED_LOCAL_MCP_VIA_DEVSPACE | На исходной контрольной HTML-странице через DevSpace Bash выполнены navigate/click/hover/fill/press_key/evaluate/screenshot; 29 инструментов, 1 страница; click/hover/input/Enter trusted=true, счётчики 1/1/1/1, значение прочитано обратно, PNG просмотрен; собственные процессы завершены |
| Orca click/Enter с точным page id и свежими refs | VERIFIED_LOCAL_VIA_DEVSPACE | На той же HTML-странице оба действия дали trusted=true и изменили счётчики. Проверены refs с `@` и без него; причина исторического отказа не установлена. Не объявляется исправлением кода Orca |
| Первый текст Host требует чтения до DevSpace | CODE_TEST_PASS_NO_LIVE | Новый формат launch отдельно запрещает open_workspace/Bash/Orca/VUDA до чтения документов. Cold restore старых публикаций сохраняет прежний exact prompt; поведение целевого ChatGPT ещё требует новой приёмки |
| Новый маршрут VUDA в настоящем ChatGPT REQ | VISIBLE_NOT_TESTED | Локальная проверка через тот же соединитель не заменяет адресное поручение. Для него нужны опубликованный/применённый код, точные пути и разрешённые зависимости по [инструкции](devspace/VUDA.md) |

### VUDA Local через Secure MCP Tunnel, 20 октября 2026

Проверен отдельный маршрут внешнего ChatGPT: облачный плагин `VUDA Local` → официальный
OpenAI Secure MCP Tunnel (`tunnel-client` v0.0.16) → установленный VUDA 1.1.0 по stdio.
Местные агенты DSH продолжают использовать прямой местный VUDA MCP без туннеля.
Эта проверка выполнена пользователем из ChatGPT, не являлась новым Host-bound REQ
и не заменяет приёмку Leader → Bridge → ChatGPT → DevSpace → bell.

| Возможность | Статус | Доказательство / граница |
|---|---|---|
| Клиент, ключ и соединение OpenAI | VERIFIED_WORKING | Host подтвердил `process_running=true`, `healthy=true`, `ready=true`, успешный polling; ключ и его содержимое не являются материалом этого отчёта |
| Каталог VUDA в подключении ChatGPT | VERIFIED_WORKING | Обнаружены server `vuda`, версия 1.1.0, 29 инструментов; `tools_list.complete=true`, без пропущенных страниц. Это не проверка каждого инструмента |
| navigate/evaluate/hover/fill/click/press_key/screenshot | TARGET_SESSION_PASS_REPORTED | Пользователь передал отчёт ChatGPT по `VUDA-TUNNEL-20261020-A`: один сеанс, значение `VUDA tunnel OK`, исходные счётчики 0 → конечные 1/1/1/1; mouseenter/input/click/keydown имеют `trusted=true`, полученный из `event.isTrusted`. Host-журнал независимо подтверждает обращения и создание `screenshot://vuda-local-verified`; пиксели этого снимка Host отдельно не просматривал |
| Доставка ответов | VERIFIED_WORKING | Host: 37 принятых ответов, 0 окончательных ошибок доставки; в метриках 10 успешных `tools/call` и один внутренний ответ 409. Причина 409 по сохранённым info-журналам не установлена; нулевой общий счётчик ошибок не заявляется |
| Тестовый сервер / продолжение работы | VERIFIED_WORKING | Собственный временный HTTP-сервер остановлен по проверенному PID/команде; туннель оставлен работающим. Автозапуск после перезагрузки и постоянное хранение ключа не настроены |

Частные доказательства этой установки: `%LOCALAPPDATA%/DSH/integrations/vuda-tunnel/connection-evidence.json`
и `acceptance-evidence.json`; журнал клиента — `%USERPROFILE%/.local/state/tunnel-client/logs/vuda-local.log`.
Они не включаются в Git и не обещаются доступными внешнему ChatGPT без отдельного scope.
Имена namespace и схемы проверяются в текущем чате. Эта запись не отменяет прежние
BLOCKED/FAILED, не подтверждает исправление DevSpace Bash или всех действий Orca/Windows.

### Blender MCP — живая приёмка 24 октября 2026

Проверены прямой Blender MCP в целевом ChatGPT, а затем отдельно фоновый запуск и восстановление на Windows. Это **не доказывает** новое прохождение всей цепочки Leader → Bridge → bell, фактический logout/reboot или универсальную надёжность. Текущие имена и схемы инструментов проверяются в самом подключении; критерии и эксплуатация — в [BLENDER.md](devspace/BLENDER.md).

| Возможность | Статус | Доказательство / граница |
|---|---|---|
| Внешний ChatGPT → `mcp__Blender_Postman__` | TARGET_SESSION_PASS_REPORTED | В живом сеансе выданы реальные `get_scene_info`, `execute_blender_code`, `look`; отсутствие инструмента в другой беседе не заменяется SDK-проверкой |
| Чтение и изменение сцены | TARGET_SESSION_PASS_REPORTED | `get_scene_info` нашёл `MCP_TEST_ORANGE_SPHERE_20261024` в `(0, 0, 1.7)`; `execute_blender_code` переместил по X до `2.5`; повторное чтение подтвердило результат |
| Визуальная приёмка | TARGET_IMAGE_VIEWED_REPORTED | `look` (angles/front, solid) вернул фактический `ImageContent`, просмотренный внешним ChatGPT и Leader: куб слева, оранжевая сфера справа. Material preview мог быть серым; solid material color отобразил цвет |
| Установленная связка | SETUP_FACTS_REPORTED | `mcp-for-blender` 2.2.4, addon 1.8, protocol 15, Blender 5.2.3 LTS, isolated loopback raw TCP `9877`, OpenAI Secure MCP Tunnel / `tunnel-client` 0.0.16; порт addon **не HTTP MCP endpoint** |
| Путь `mcp.command` в Windows | DEV_PROXY_PASS_REPORTED | Parser клиента съедал неэкранированные обратные слеши; forward slashes либо корректное экранирование устранили отказ. На dev proxy подтверждены `initialize` и 14 tools; это не список гарантированных инструментов в каждой беседе |
| Защищённый ключ и фоновый запуск Windows | TARGET_WINDOWS_PASS_REPORTED | Однократный локальный скрытый ввод ключа; в частной папке только DPAPI CurrentUser ciphertext с ACL текущего пользователя и SYSTEM без наследования. Существующий профиль обслуживается `Run-BlenderTunnelBackground.ps1` через одно задание `BlenderMCP-Background-Tunnel`. Значения секретов не читали и не передавали в Git или ChatGPT |
| Планировщик: запуск и запрет дубликатов | TARGET_WINDOWS_PASS_REPORTED | Тот же Windows-пользователь, `InteractiveToken`/`Limited`, `Hidden`, `AtLogOn` и TimeTrigger каждую минуту без `Duration`, `IgnoreNew`, `ExecutionTimeLimit=PT0S`, разрешена работа от батареи. Ручной запуск задания проверен; реальный logout/reboot **не запускали** |
| Окна фонового туннеля | TARGET_WINDOWS_PASS_REPORTED | В сеансе пользователя на рабочем столе `Default` через `EnumWindows` подтверждено отсутствие видимых окон у связанных процессов. Старые собственные консоли скрыты без закрытия и потери буфера |
| Восстановление после сбоя | TARGET_WINDOWS_PASS_REPORTED | `RestartOnFailure=3/PT1M` наблюдательно не сработал даже в отдельной пробе без ключа при ненулевых выходах. Добавлен **штатный минутный триггер той же задачи**, без watchdog/службы. После одного контролируемого выхода клиента следующий триггер сам запустил **ровно один** клиент без `Start-ScheduledTask` и ввода ключа; `/healthz` и `/readyz` вернули HTTP 200. Не доказана неограниченная надёжность или автоматическое продление ключа |
| Прямой MCP после переключения | TARGET_SESSION_PASS_REPORTED | Внешний ChatGPT повторно получил `get_scene_info` и реальное изображение `look` уже на фоновом клиенте, без нового изменения сцены. После смены **только триггеров** подтверждён recovery; предыдущий MCP/оконный PASS сохраняется при неизменных соответствующих входах |

Границы безопасности Python и безопасные установочные инварианты без секретов — [BLENDER.md](devspace/BLENDER.md). Частные отчёты, изображения, профили, ключи, идентификаторы туннеля и процессов в Git не включаются.

### Capacity и маршрутизация

- На одного Leader **в ветке PR #433**: максимум 3 независимые активные DevSpace операции, 3 ChatGPT-разговора и продолжаемые Luna. Каждому свой laneId/REQ/controls. Legacy Bridge держит отдельную ёмкость 3.
- В одной линии — один активный REQ. Продолжение собственного разговора допускается после старого UNKNOWN/PROVEN_NOT_SENT; сначала наблюдение, затем отдельный REQ без слепого повтора файловых операций.
- **Конфликты writers решает Leader.** Host допускает новые задания и разрешённые действия в пересекающихся областях; native учёт процессов и UNKNOWN остаются доказательствами, а не блокировкой параллельной работы.
- Каждый новый ChatGPT-чат может иметь собственные лимиты и недоступные инструменты. Ни эта таблица, ни прошлые успешные тесты не гарантируют real-time availability, стоимость или quota.
- Основной маршрут для задач — `@PostmanDevspace`; legacy/Worker/Sol выбирает Leader только по конкретным ограничениям/пользовательскому запросу. Не создавай новый test framework или обязательного второго рецензента ради полноты отчёта.

### Дальнейшие условия общего PASS

1. Доказать новую GUI-установку Host `4173`, **три одновременно выполняемых обращения** с разными чатами, тот же lane continuation, 4-й admission refusal и owner-bound control.
2. Проверить в GUI реальный текст, native image input + **выход настоящего GPT Image**, сохранение изображения и локальную независимую проверку.
3. Подтвердить Secretary web+private ledger и восстановление после compact, branchless внешнюю папку с точным Leader grant, CU allow/deny и честную фактическую недоступность инструмента.
4. Повторить адресные old Bridge/Image/Worker регрессии; при неуспехе указать точный blocker, не заявлять PASS. `preview` не трогать без отдельного stable GO.
