# PostmanDevspace — возможности и ограничения

Обновлено: 13 октября 2026. Источник истины для действий Leader — реальные Host scopes и подтверждённый результат конкретного REQ. Эта таблица разделяет **живую проверку старой установки**, **текущие тесты ветки PR #433** и **ещё не подтверждённую доступность ChatGPT**. Запись в main/публикация PR не доказывает, что active DSH Host уже загрузил новый код.

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
| Secretary: внешние факты через PostmanDevspace, без собственного web_search/web_fetch | CODE_TEST_PASS_NO_GUI | Host запрещает Secretary отдельные web-инструменты; Leader получает exact Devspace terminal и передаёт факты в private ledger, помечая неподтверждённый веб-вызов |
| Secretary journal независим от Git task | CODE_TEST_PASS_NO_GUI | Host-private durable ledger теперь доступен до prepare; cold reopen test |
| External explicit workspace_root: read/write | CODE_TEST_PASS_NO_GUI | Exact Leader grant на существующий canonical путь; пересечение с постоянным repo запрещено, изолирующей ОС-песочницы DevSpace нет |
| Computer Use в другом приложении | ENFORCEMENT_UNAVAILABLE | Требуется target-scoped Host adapter; пока API отвечает `COMPUTER_USE_TARGET_ENFORCEMENT_UNAVAILABLE` |
| Computer Use для ChatGPT/DSH/Codex и самозапуск агентов | ALWAYS_FORBIDDEN | Не разрешается никакими доп. scope/поручениями; Host transport Playwright не есть исполнительское CU |
| Leader steer после SEND_UNKNOWN | VERIFIED_LIVE_PREVIOUS | Host receipt SENT_CONFIRMED и точный bell того же REQ, без нового origin Send |
| Ручной Leader Preempt/Stop активного DevSpace инструмента | TESTED_CODE_NOT_LIVE | Для ручных controls Unit tests предотвращают Stop активного/неизвестного инструмента; фактический живой GUI Stop ещё не проверен |
| Автоматическое напоминание DevSpace (Stop → готовность → Send) | CODE_TEST_PASS_NO_LIVE | Unit/state tests и изолированный headless Chromium с контролируемым временем: Stop даже при активном tool/неизвестном состоянии, только свой REQ, одно подтверждённое сообщение, без реальной доставки ChatGPT |
| Text fallback без местного bell | VERIFIED_LIVE_PREVIOUS | Результат `source=text_fallback`, diagnostic UNKNOWN, без выдуманного DONE |
| Cold bell → старая Luna → Leader после Host restart | VERIFIED_LIVE_PREVIOUS | Получено DONE в прежнем Host каналe, Leader получил terminal, blind resend не было |
| Legacy @Postman, @PostmanAsk, @PostmanImage | PRESERVED_FALLBACK | Оригинальные маршруты остаются рабочими, автопереключения после UNKNOWN нет |
| Worker Git commit/push/PR | PERMISSION_BOUND | Только отдельно разрешённый локальный task branch/worktree по REPO_POLICY.md |
| Sol backup | PERMISSION_BOUND | Только конкретный блокер возможности/доступности DevSpace, не default из-за сложности |

### Capacity и маршрутизация

- На одного Leader **в ветке PR #433**: максимум 3 независимые активные DevSpace операции, 3 ChatGPT-разговора и продолжаемые Luna. Каждому свой laneId/REQ/controls. Legacy Bridge держит отдельную ёмкость 3.
- В одной линии — только один активный REQ; возможны последовательные поручения в том же чате. Не пересылай неизменный prompt после SEND_UNKNOWN.
- **Один writer на пересекающуюся область**, но независимые readers/writers других каталогов не блокируют друг друга.
- Каждый новый ChatGPT-чат может иметь собственные лимиты и недоступные инструменты. Ни эта таблица, ни прошлые успешные тесты не гарантируют real-time availability, стоимость или quota.
- Основной маршрут для задач — `@PostmanDevspace`; legacy/Worker/Sol выбирает Leader только по конкретным ограничениям/пользовательскому запросу. Не создавай новый test framework или обязательного второго рецензента ради полноты отчёта.

### Дальнейшие условия общего PASS

1. Доказать новую GUI-установку Host `4173`, **три одновременно выполняемых обращения** с разными чатами, тот же lane continuation, 4-й admission refusal и owner-bound control.
2. Проверить в GUI реальный текст, native image input + **выход настоящего GPT Image**, сохранение изображения и локальную независимую проверку.
3. Подтвердить Secretary web+private ledger и восстановление после compact, branchless внешнюю папку с точным Leader grant, безопасный предельный CU отказ.
4. Повторить адресные old Bridge/Image/Worker регрессии; при неуспехе указать точный blocker, не заявлять PASS. `preview` не трогать без отдельного stable GO.
