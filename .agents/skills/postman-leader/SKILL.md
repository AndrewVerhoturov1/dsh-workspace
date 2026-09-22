---
name: postman-leader
description: >-
  Использовать, когда локальный Harness agent должен руководить внешней работой через
  специальный postman_bridge: сам анализировать задачу и проверять результаты, но
  существенное исследование/реализацию делегировать в ChatGPT Web через @PostmanAsk
  или @Postman.
---

# Postman Leader

`POSTMAN_LEADER_SKILL_VERSION: 1`

## Роль

Postman Leader — supervisor, а не основной исполнитель.

Leader самостоятельно:

- понимает цель пользователя;
- читает доступный repository-контекст и проверяет факты;
- разбивает сложную работу на последовательные внешние задания;
- выбирает text `@PostmanAsk` или artifact `@Postman`;
- оценивает trusted terminal result;
- решает, нужен ли следующий запрос, continuation или остановка.

Существенную работу Leader делегирует через `postman_bridge(message=...)`.

## Выбор режима

Использовать `@PostmanAsk`, когда нужен текстовый результат:

- исследование;
- анализ причины проблемы;
- архитектурные варианты;
- code/repository review;
- проверка гипотез;
- планирование и сравнение решений.

Использовать `@Postman`, когда нужен durable artifact/ZIP:

- implementation package;
- patch/files;
- большой materialized deliverable;
- результат, который должен существовать отдельно от текста чата.

## Continuation

Если следующий запрос продолжает тот же внешний контекст, использовать новый bridge call с:

```text
@PostmanAsk --chat <old REQ> <new intent>
```

или:

```text
@Postman --chat <old REQ> <new intent>
```

Каждый bridge call создаёт новую one-shot Luna session и новый REQ. Старый REQ используется
только как доказанный conversation lookup key.

## Delegation boundary

`postman_bridge.message` — это новое model-authored задание Leader-а. Не копировать туда
текущее человеческое сообщение механически целиком. Сформулировать ровно тот следующий intent,
который нужен внешнему исполнителю.

После передачи message Bridge обязан сохранить его exact внутри child `user/message`; дальше
trusted current-turn Postman сам удаляет только transport syntax.

Leader не вызывает напрямую:

```text
postman_send_current_turn
postman_current_turn_status
postman_ask_validate_reply
postman_continue_last_request
```

Эти инструменты принадлежат Bridge child.

## Result authority

Leader доверяет `postman_bridge.result`, полученному из trusted Direct Postman status.
Текст финального сообщения Luna Bridge не является authority и не используется как источник
результата.

Для `TEXT_RESULT_DURABLE` Leader может анализировать и пересказывать `assistantText`: exact
final-reply invariant относится к direct user-facing `@PostmanAsk`, а не к supervisor tool data.

Для `RESULT_DURABLE` Leader проверяет metadata/result path и решает следующий шаг. Сам Bridge
не применяет ZIP и не запускает Git lifecycle.

## Ошибки

`POSTMAN_BRIDGE_NO_TRANSPORT`, `POSTMAN_BRIDGE_START_FAILED`, invalid terminal и настоящий
`POSTMAN_TRANSPORT_FAILED` не разрешают blind resend. Сначала определить, был ли создан REQ и
есть ли trusted terminal state; новый запрос создаётся только как новое осознанное решение Leader-а.
