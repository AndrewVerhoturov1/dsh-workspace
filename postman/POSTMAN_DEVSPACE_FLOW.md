# PostmanDevspace: этапы 2–4 — связь, инженерное исполнение, восстановление

## Отличие от этапа 1

Авторизованный Leader создаёт отдельную сохраняемую Luna (DSH subagents.startContinuable).
В своём task context она имеет один childId и историю последовательных REQ.
Пользовательские поручения адресуются исключительно через Host-owned postman_bridge.
Host запускает Direct, ведёт browser/CDP и читает принадлежащий запросу local bell.
Между обращениями Luna не обязана держать активный model turn; следующий REQ
отправляется в сохранённый ChatGPT conversationRef через штатный existing-chat Send.

## Полномочия и события

Coordinator followup к Luna не становится user message и не может вызвать
postman_send_current_turn: общий CurrentUserTurnStore не меняется.
Leader-only postman_devspace_control(action=steer|preempt|stop|status, bridge_job_id)
связан с текущим REQ и частным каналом. Steer ждёт IDLE; preempt — явный
Stop (до 10 секунд на реальное завершение), затем ровно одна попытка Send.
Если есть активная DevSpace-операция или UI-доказательства противоречивы,
Stop не нажимается, Host intent остаётся в очереди. Даже когда Stop не нужен
(чат уже IDLE), перед Send записывается durable UNKNOWN intent, запрещающий
повтор после сбоя. Stop браузера не доказывает остановку отдельной DevSpace Bash-команды.
QUEUED означает только принятое намерение. Отдельные sendState и stopState
позволяют различать SENT_CONFIRMED, SEND_UNKNOWN, PROVEN_NOT_SENT и Stop UI evidence.
Угроза двойного Send после UNKNOWN запрещает любой слепой повтор. Даже если первоначальный браузерный Send остался `UNKNOWN`, Host сначала ждёт private bell, затем только после доказательства exact conversation URL и immutable `POSTMAN_REQUEST_ID` в том же user turn может обработать **отдельный** Host-authorized controlId. Без proof — только ожидание bell. Завершённый ответ того же строго привязанного assistant turn допускается как `text_fallback` после короткого bell-first grace, никогда как DONE/PASS.

15-минутные напоминания разделяют с control один браузерный цикл;
подтверждённый bell отменяет дальнейшие действия. Отсутствие необязательного
result.md не препятствует передаче сведений о REQ. Поздний связанный bell
может повысить уже доставленный text fallback без нового REQ.

После окончания работы Leader вызывает postman_devspace_luna_close;
лишь затем безопасно закрывает task context. Старый Bridge artifact/Ask/Image
остаётся одноразовым и использует свои неизменённые инструменты.

## Этап 4: восстановление после рестарта Host

Если у Leader сохранено незавершённое обращение и появился настоящий местный bell, после перезапуска Host **не пересылает** ChatGPT исходный prompt. `postman_task_prepare` перепривязывает прежний Leader task context; Host сверяет owner/job/REQ/channel, подтверждает bell и существование той же продолжаемой Luna. Durable `coldBellRecovery=intent` записывается до native `followup`. Только после принятия события той же Luna возможно повышение pending/unknown в trusted terminal. Затем `POSTMAN_BRIDGE_READY` доставляется Leader с отдельным durable `coldReadyWake` и доступным `postman_bridge_status`. Повторный restart/status/prepare не вызывает новый REQ и не создаёт второй успех.

Если native followup недоказан, сохраняется `OUTCOME_UNKNOWN` и исходное событие. Нет автоматического повтора, обхода Luna или фальшивого DONE. После crash при неопределённом исходе Host оставляет intent на расследование, а не повторяет side effect. Уведомление исходного Leader запускается только после его перепривязки: при недоступной старой сессии Leader событие не передаётся чужому получателю.

## Этап 3: рабочие области и инженерный результат

`postman_task_prepare({read_only:true})` готовит Host-owned Leader context по проверенному repository identity **без** Git fetch, временной ветки и push. Такой контекст допускает только `@PostmanDevspace READ_ONLY`; legacy Bridge, Worker и restore отключены. Обычный `postman_task_prepare()` сохраняет старую безопасную ветку от `origin/main`. Режим `WRITE_ISOLATED` разрешён лишь по exact prepared worktree с проверкой чистоты перед первым внешним edit. Входные ограничения Host не означают техническую песочницу DevSpace shell: запрещены любые записи вне scope и самовольный Git publish; любой PR публикует отдельно уполномоченный местный Worker. Повторное задание может продолжить в dirty worktree по собственному зарегистрированному owner, не делать post-ZIP sync. Текущие возможности и отрицательные факты — в [карте](POSTMAN_DEVSPACE_CAPABILITIES.md). `WRITE_APPROVED_TARGET` пока требует отдельного утверждённого Host grant, поэтому не включён.

## Границы приёмки

Локальный unit PASS не доказывает возможности ChatGPT Web/DevSpace.
Требуется живой тест через DSH 4173: два REQ одной Luna, один conversation,
bell-first, text fallback, urgent/Stop с честными статусами и проверкой
родительской привязки. Действующий режим только READ_ONLY/WRITE_TEST;
исходники worktree менять пока нельзя; это отдельный этап 3.
