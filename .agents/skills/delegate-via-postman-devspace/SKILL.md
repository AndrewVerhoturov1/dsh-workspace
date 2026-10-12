---
name: delegate-via-postman-devspace
description: Отдельный exact @PostmanDevspace через Host-bound one-shot Luna, только этап 1.
---

# PostmanDevspace — этап 1

Использовать только при точном начале текущего сообщения `^\s*@PostmanDevspace(?:\s|$)` и Host-привязке этой Luna к обращению top-level Postman Leader. Навык не выдаёт полномочий обычному root/Worker; standalone send запрещён. Coordinator-сообщение не считается текущим user turn.

1. Вызвать `postman_send_current_turn()` без аргументов. Не копировать поручение, channel/capability или идентификаторы в shell/новый prompt.
2. Читать `postman_current_turn_status()` до terminal. Не отправлять повторно, не запускать старый Postman автоматически.
3. Для `DEVSPACE_SIGNAL_RECEIVED` передать receipt: источник bell, сообщённый DONE/NEED_DECISION/BLOCKED, evidenceState и warnings. Отсутствующий/необычный отчёт не блокирует доставку. Host читает собственное событие; Luna prose не является authority.
4. Для `DEVSPACE_DIAGNOSTIC` передать CAPABILITY_UNAVAILABLE/BLOCKED/UNKNOWN/PARTIAL и доступный обычный или форматированный текст. Без bell не выдумывать DONE/PASS; ZIP, Ask envelope, final и схема отчёта не являются условием доставки.

Команда bell в private task рассчитана на **настоящий DevSpace Bash**: `pwsh -NoProfile -NonInteractive -File <native-script-path> done|need-decision|blocked`, необязательные `-Message`/`-Report`. Следовать готовому Bash quoting; аргументы с русским текстом/переносами заключать в одинарные кавычки, апостроф экранировать последовательностью `'"'"'`. Не читать binding/capability и не создавать JSON вручную. Идентичный повтор безопасен; сохраняется первый durable bell.

Только этот режим проверяет состояние каждые 15 минут (по умолчанию около 15/30/45 при часовом ожидании). Завершённый ответ, активная DevSpace read/write/test/shell операция или неясная безопасность — без Stop. Для доказанно безопасной генерации допустим один Stop; до 10 секунд наблюдается исчезновение Stop **и** готовность существующего Send. После повторной проверки bell — естественный Continue исходной задачи с текущего места в том же REQ/chat, через существующий one-shot Send. UNKNOWN не пересылается; следующая проверка через 15 минут после подтверждённого Continue. Это не steer/urgent control этапа 2.

Bell не обходит свою Luna: Leader читает только полученный trusted terminal этой Luna. Cold pending/unknown сохраняет событие и возвращает `POSTMAN_DEVSPACE_LUNA_TERMINAL_UNAVAILABLE`, без синтеза terminal, resend или автоматического resume.

Leader получает trusted result через POSTMAN_BRIDGE_READY → postman_bridge_status. Delivery не означает правильность реализации/приёмку. Private rendered task, workspace/channel/capability/events/results не публикуются в GitHub. Этап 1: READ_ONLY подготовленной области, либо WRITE_TEST только Host-private тестовой папки; shell не песочница. Нет Git writes, постоянной Luna, steer/urgent/внешнего stop-control, восстановления управления этапа 2 или карты возможностей этапа 3; описанный безопасный browser Stop/Continue остаётся только частью ожидания этапа 1.
