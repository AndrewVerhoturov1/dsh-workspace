# Postman

id: postman
status: active
updated: 2026-10-20

## Цель и текущая модель

Основной исполнитель — Host-owned `@PostmanDevspace`: до трёх текущих исполнений с persistent Luna/ChatGPT lanes, native inputs, bell/text и адресным управлением. Luna сохраняет роль связистки и текущие инструменты. Готовый отчёт доступен независимо от её состояния.

Host исполняет явные команды, сохраняет факты и обслуживает действующий 15-минутный Stop → Continue. Leader выбирает маршрут, повтор, восстановление и приёмку. Автоматических цепочек новых REQ и классификаторов ошибок по тексту нет. Один вызов — одна попытка Send; история отправки/UNKNOWN сообщается, но не блокирует новую явную команду Leader.

Leader и Sol используют обязательный PTC, Worker/Secretary — direct tools без делегирования. У PTC обязателен `program`, `description` необязателен, `wait_for_event:true` выражает решение ждать без доказательств из истории. Отказ инструмента — данные, не повод автоматически аварийно завершить всю программу.

Host не готовит и не восстанавливает Git, не синхронизирует рабочий проект и не требует task context для запуска. Назначенный каталог либо cwd сессии подходит для обычной папки без origin/GitHub. Git-работу и временный worktree при изменении репозитория выполняет Worker по REPO_POLICY. Scope/read-only — инструкции; native rights, ownership, role restrictions, revoke и технические пределы сохраняются.

## Доставка и совместимость

`postman_bridge_status` и списки только наблюдают, без отправки/запуска Luna/отзыва прав. Существующий реестр хранит владельцев, REQ/job/child/lane, адрес беседы, результаты и факты отправки/отмены. Старые Git-поля — история. Выгрузка не повторяет команды; поздний результат остаётся у своего REQ. Сохранённая беседа и старая неопределённая запись сами по себе слот исполнения не занимают.

`@Postman`, `@PostmanAsk`, `@PostmanImage` остаются резервными Direct/Web маршрутами. Fresh one-shot Luna вызывает trusted current-turn transport без копирования текста в tool arguments. Trusted terminal из exact child scope — authority доставки, prose Luna не заменяет его. Транспортная публикация не управляет Git рабочего проекта. Public input staging требует отдельного разрешения.

Trusted ZIP grant принадлежит exact Leader/REQ и сохраняет ZIP/SHA. Отдельно авторизованный Worker вызывает `implementation_artifact_apply({requestId,worktree})` с явно выбранным каталогом. Host проверяет принадлежность/целостность, existing runner — фактическое применение. Host не требует опубликованного HEAD или подготовленного им дерева. PASS runner не означает разрешение на Git-публикацию или merge.

## Границы и проверка

Пользовательские файлы, журналы, REQ и старые результаты сохраняются. UNKNOWN/FAILED не становятся успехом; отозванные задания не получают права заново. Host самостоятельно не чистит, не сбрасывает и не перезаписывает пользовательские данные.

Unit/source PASS не является GUI/live PASS. Установка, переключение текущей сессии и новая живая приёмка выполняются отдельным согласованным этапом. Merge и stable preview требуют отдельных решений REPO_POLICY. Исторические возможности и пределы прежних проверок — `POSTMAN_DEVSPACE_CAPABILITIES.md` и `JOURNAL.md`.

## Основные источники

- `postman/POSTMAN_BRIDGE_FLOW.md`, `.agents/skills/postman-leader/SKILL.md` — управление и роли.
- `postman/POSTMAN_DEVSPACE_FLOW.md`, `postman/devspace/SKILL.md` — основной маршрут и исполнитель.
- `postman/POSTMAN_CURRENT_FLOW.md`, `postman/POSTMAN_ASK_FLOW.md`, Direct/Web README — резервные транспорты.
- `docs/web-postman-artifact-contract.md` — artifact transport, без автоматического применения.
- `system/implementation-package-workflow.md`, `system/implementation-package-authoring.md` — явная работа с implementation package.
- `docs/subprojects/ptc/PTC_CONTRACT.md` — PTC API и технические пределы.

Подпроект не переопределяет AGENTS, REPO_POLICY и полномочия ролей. При обычной разработке Postman без exact trigger транспорт не запускается.
