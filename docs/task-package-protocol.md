# Task Package Protocol

## Формат

Один файл задачи:

REQ_<timestamp>_<digits>.md

Файл содержит:
- request_id;
- автора создания;
- цель;
- техническое задание;
- ссылки на обязательные документы;
- repository;
- base commit;
- ожидаемый результат;
- проверки.

## Ответ внешнему агенту

Внешний Postman prompt содержит только:
1. первую строку `POSTMAN_REQUEST_ID: REQ_xxx`;
2. ссылку на общий skill repository;
3. ссылку на task-файл.

Пример первой строки:

```text
POSTMAN_REQUEST_ID: REQ_xxx
```

Полное техническое задание в prompt не копировать: оно находится только в task-файле.
