# Карта возможностей PostmanDevspace (13 октября 2026)

Эта таблица фиксирует возможности отдельно от текущей доступности и полномочий.
`DELIVERED` или ChatGPT-reported `DONE` не означает, что инженерная работа проверена.
Ориентировочная стоимость не указывается без замеров.

| Исполнитель / операция | Текущий статус | Условия / ограничения | Свидетельство |
|---|---|---|---|
| ChatGPT+DevSpace / чтение и тестовая запись | VERIFIED_AVAILABLE | Новый ChatGPT-чат с активным DevSpace, Host-bound REQ и private `writeRoot`; отсутствие shell sandbox | 12.10.2026: реальный Stage1 WRITE_TEST, локальный PNG/CSV/JSON, bell → Luna → Leader |
| ChatGPT+DevSpace / read-only без Git task branch | UNTESTED | `postman_task_prepare(read_only=true)`; запрещены изменения, legacy transport, Worker | 13.10.2026: точные registry/authorization/unit tests, ещё без GUI |
| ChatGPT+DevSpace / `WRITE_ISOLATED` в собственном worktree | UNTESTED | Начальный чистый Host task worktree, проверенный Git owner, никаких commit/push/PR от внешнего ChatGPT | 13.10.2026: mode/channel/scope/unit tests, ещё без GUI |
| ChatGPT+DevSpace / WRITE_APPROVED_TARGET | BLOCKED_BY_PERMISSION | Нет доверенно утверждённого внешнего target root и Host grant. Не считать обычный shell доступ разрешением | В этой задаче пользователь другой target root не назначал |
| Продолжаемая Luna / повторные REQ и тот же чат | AVAILABLE_CONDITIONAL | Один Leader owner, сохранённый conversationRef, cold/session proof; последствия Send UNKNOWN без повтора | 13.10.2026: 10 JS tests, первый GUI smoke до #428 blocked по toolFilter |
| Leader / steer, preempt, stop | AVAILABLE_CONDITIONAL | Только exact owned Bridge job, Host controlId, отдельный Stop/Send outcome; местный процесс после Stop неизвестен | 13.10.2026: 8 Python control tests; live ещё требуется |
| Classic @Postman / @PostmanAsk | AVAILABLE_CONDITIONAL | Отдельные one-shot Luna, ZIP/text, URL и Grant-контракты неизменны | Legacy unit suites; каждый отдельный live transport нужно проверять при изменениях |
| Classic @PostmanImage / native upload | VERIFIED_AVAILABLE | 1–7 PNG/JPEG/WebP/GIF; generation+ZIP ещё проверяется отдельным E2E | 12.10.2026: native image upload confirmed на реальном ChatGPT GUI после #426; 52/52 relevant tests |
| GPT Image / генеративное редактирование | AVAILABLE_CONDITIONAL | Нужна истинная GPT Image операция; программная Pillow-правка не доказательство | Пользователь ранее сообщил «Успешно», независимый engine proof в этой записи отсутствует |
| Secretary / оперативная память | AVAILABLE_CONDITIONAL | Только компактный durable ledger с reported/verified/accepted; не shell-изменение source | Postman Secretary native implementation |
| Worker / механическая проверка и Git-публикация | AVAILABLE_CONDITIONAL | Только в разрешённом task worktree, по REPO_POLICY; не обязательный дубль проверки | Ранее локально проверял пиксели/CSV и чистоту worktree; source PR workflow |
| Sol / сложная местная работа | AVAILABLE_CONDITIONAL | Явное решение Leader в рамках утверждённой задачи; расход не приравнивать к Luna | Native postman_sol_worker route, stage3 economics ещё не замерялись |

**Решение о маршруте:** сначала проверить назначенную возможность и полномочие;
если она не подтверждена, выполнить одну ограниченную пробу или передать blocker.
Запрет автоматической отправки второго REQ при `SEND_UNKNOWN` действует для всех маршрутов.
Для `dsh-workspace` изменения Git публикует уполномоченный местный Worker после
отдельного решения. Случайная доступность GitHub credentials из DevSpace не разрешает push.
