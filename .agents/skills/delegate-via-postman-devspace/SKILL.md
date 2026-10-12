---
name: delegate-via-postman-devspace
description: Отдельный exact @PostmanDevspace через Host-bound one-shot Luna, только этап 1.
---

# PostmanDevspace — этап 1

Использовать только при точном начале текущего сообщения `^\s*@PostmanDevspace(?:\s|$)` и Host-привязке этой Luna к обращению top-level Postman Leader. Навык не выдаёт полномочий обычному root/Worker; standalone send запрещён. Coordinator-сообщение не считается текущим user turn.

1. Вызвать `postman_send_current_turn()` без аргументов. Не копировать поручение, channel/capability или идентификаторы в shell/новый prompt.
2. Читать `postman_current_turn_status()` до terminal. Не отправлять повторно, не запускать старый Postman автоматически.
3. Для `DEVSPACE_SIGNAL_RECEIVED` передать receipt: источник bell, сообщённый DONE/NEED_DECISION/BLOCKED, evidenceState и warnings. Отсутствующий/необычный отчёт не блокирует доставку. Host читает собственное событие; Luna prose не является authority.
4. Для `DEVSPACE_DIAGNOSTIC` передать CAPABILITY_UNAVAILABLE/BLOCKED и доступный текст. Не объявлять PASS и не домысливать MCP.

Leader получает trusted result через POSTMAN_BRIDGE_READY → postman_bridge_status. Delivery не означает правильность реализации/приёмку. Private rendered task, workspace/channel/capability/events/results не публикуются в GitHub. Этап 1: READ_ONLY подготовленной области, либо WRITE_TEST только Host-private тестовой папки; shell не песочница. Нет Git writes, постоянной Luna, steer/urgent/stop, восстановления управления этапа 2 или карты возможностей этапа 3.
