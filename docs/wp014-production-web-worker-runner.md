# WP-014 — Production Web Worker Runner

## Причина

После WP-013 Runtime успешно публиковал intent-task и переходил в `WAITING`, но production `dsh-postman-harness` создавал `WebWorkerBridge` только при внешнем `webWorkerRunner`. В обычном Cordis profile runner отсутствовал, поэтому `WAITING` был терминальной точкой и выделенный Chrome Postman не запускался.

## Исправленная production-цепочка

```text
postman_async_send
→ task publication
→ TASK_CREATED
→ TASK_PUBLISHED
→ WAITING
→ JS WebWorkerBridge
→ production-web-worker-runner.js
→ production_web_worker.py
→ ensure dedicated headful Chrome/CDP :9222
→ existing WP-003..WP-007 Python pipeline
→ RESULT_DURABLE
→ Runtime READY
→ delivery to origin agent
```

Production runner не использует Playwright MCP из Harness profile. Он запускает/переиспользует системный Google Chrome через существующий `browser_bootstrap.py`, отдельный профиль `%LOCALAPPDATA%\\DSH\\Postman\\browser-profile` и CDP `127.0.0.1:9222`.

Task URL обязан быть immutable SHA-pinned `raw.githubusercontent.com` URL. Из него runner получает trusted `repository` и `baseCommit`; exact expected artifact filename выводится из REQ. Путь изменения ZIP ограничивается tracked top-level paths локального repository, а `settings.yaml`, `attachments` и `.git` запрещены.

Если pipeline завершается ошибкой в нормальном `WAITING`, bridge сохраняет компактный `WEB_WORKER_FAILED` result через Runtime READY и будит POSTMAN. Origin agent получает ошибку вместо бесконечного ожидания.

`user_intent` не расширяется transport-слоем. Initiator skill отдельно запрещает локальному агенту изучать реализацию и придумывать требования до `postman_async_send`.
