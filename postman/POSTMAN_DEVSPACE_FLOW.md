# PostmanDevspace: этап 2 — связистка и управление

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
Stop браузера не доказывает остановку отдельной DevSpace Bash-команды.
QUEUED означает только принятое намерение. Отдельные sendState и stopState
позволяют различать SENT_CONFIRMED, SEND_UNKNOWN, PROVEN_NOT_SENT и Stop UI evidence.
Угроза двойного Send после UNKNOWN запрещает любой слепой повтор.

15-минутные напоминания разделяют с control один браузерный цикл;
подтверждённый bell отменяет дальнейшие действия. Отсутствие необязательного
result.md не препятствует передаче сведений о REQ. Поздний связанный bell
может повысить уже доставленный text fallback без нового REQ.

После окончания работы Leader вызывает postman_devspace_luna_close;
лишь затем безопасно закрывает task context. Старый Bridge artifact/Ask/Image
остаётся одноразовым и использует свои неизменённые инструменты.

## Границы приёмки

Локальный unit PASS не доказывает возможности ChatGPT Web/DevSpace.
Требуется живой тест через DSH 4173: два REQ одной Luna, один conversation,
bell-first, text fallback, urgent/Stop с честными статусами и проверкой
родительской привязки. Действующий режим только READ_ONLY/WRITE_TEST;
исходники worktree менять пока нельзя; это отдельный этап 3.
