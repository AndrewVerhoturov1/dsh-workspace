# WP-012 Task Creation Bridge

Назначение:
создать связку между WP-010 и WP-011.

Поток:

User Intent
↓
Task Package
↓
Task File
↓
task_url
↓
Web Worker

Task File содержит только `user_intent` и явно подтверждённые пользователем требования.
Транспортные поля (`request_id`, `repository`, `base_commit`, `task_url`) хранятся отдельно.

Состояния Runtime:

```text
ACCEPTED → TASK_CREATED → TASK_PUBLISHED → WAITING → WEB_STARTING
```

Web Worker получает задачу только после `TASK_PUBLISHED`.
Локальный агент не проектирует решение — он только сохраняет подтверждённое намерение.
