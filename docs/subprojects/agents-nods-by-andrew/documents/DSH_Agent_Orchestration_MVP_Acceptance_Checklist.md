# DSH Agent Orchestration — MVP Acceptance Checklist

## Назначение

Этот checklist определяет продуктовую готовность MVP. Он не является набором unit tests и не требует реализовывать отложенные подсистемы.

# A. Team Editor

- [ ] Agent Team Editor открывается отдельным большим окном/экраном.
- [ ] Canvas поддерживает создание и удаление AgentNode.
- [ ] Ноды можно перемещать.
- [ ] Есть pan, zoom и сетка/понятная canvas-навигация.
- [ ] Можно создавать и удалять поддерживаемые связи.
- [ ] Выбор ноды/связи открывает Inspector.

# B. AgentNode configuration

- [ ] Есть display name.
- [ ] Есть technical name.
- [ ] Есть стабильный internal id.
- [ ] Есть role/description.
- [ ] Есть model.
- [ ] Есть reasoning effort.
- [ ] Есть system prompt.
- [ ] Есть расширяемая настройка Capabilities, использующая реально поддерживаемые DSH возможности.

# C. DSH runtime integration

- [ ] Start создаёт отдельный TeamRun.
- [ ] Для каждого AgentNode в TeamRun существует реальный DSH Agent / Session binding.
- [ ] Один AgentRuntime сохраняет свою Session на протяжении Run.
- [ ] Новый TeamRun не переиспользует Sessions предыдущего запуска без явной причины.
- [ ] Open Chat открывает настоящий DSH Chat соответствующей Session.

# D. Authority and Communication

- [ ] У агента не более одного parent.
- [ ] Authority cycles запрещены Validate-ом.
- [ ] Authority и Communication хранятся/трактуются раздельно.
- [ ] Поддерживается настройка разрешённого направления общения.
- [ ] Agent-to-agent Message проходит через plugin layer и проверку разрешения.

# E. Messages

- [ ] Агент может отправить разрешённому агенту обычный Message без создания Task.
- [ ] Message хранит sender, recipient, body, timestamp/status минимум.
- [ ] Message доставляется в реальную DSH Session адресата.

# F. Tasks

- [ ] Manager может создать минимальную формальную Task.
- [ ] Task хранит creator, assignee, goal, status и result минимум.
- [ ] `Task` и `TaskAttempt` существуют отдельно в модели.
- [ ] Для MVP достаточно одного TaskAttempt на Task.
- [ ] Исполнитель может завершить Task с результатом.
- [ ] Completion связывается с правильной Task/Attempt.
- [ ] Результат возвращается manager-у.
- [ ] Оркестратор не выдаёт агенту следующую Task автоматически вместо manager-а.

# G. Entry Agent and DSH Chat

- [ ] В TeamDefinition можно выбрать ровно один Entry Agent.
- [ ] В новом DSH Chat есть действие `Use Agent Team` или эквивалент.
- [ ] Пользователь может выбрать сохранённую схему команды.
- [ ] Создаётся TeamRun выбранной схемы.
- [ ] Основной пользовательский Chat направлен Entry Agent этого Run.

# H. Validate

- [ ] Проверяется наличие Entry Agent.
- [ ] Проверяются authority cycles.
- [ ] Проверяется максимум один parent.
- [ ] Проверяются dangling/missing endpoints.
- [ ] Проверяются конфликтующие technical names.
- [ ] Проверяется базовая доступность обязательной agent configuration там, где это возможно через DSH.
- [ ] Blocking errors запрещают Start.

# I. Lifecycle

- [ ] Start работает для валидной сохранённой схемы.
- [ ] Pause перестаёт запускать новую работу и приводит Run к безопасному PAUSED состоянию.
- [ ] Resume продолжает тот же TeamRun.
- [ ] Stop завершает Run.
- [ ] Full Pause → Edit → Validate → Resume не требуется для MVP.

# J. Live status

- [ ] Canvas показывает минимум Not started / Idle / Running / Paused / Error / Stopped или их корректные DSH-эквиваленты.
- [ ] Runtime status не подменяется task/work status.
- [ ] При наличии Task на ноде можно понять, чем агент занят.

# K. Persistence

- [ ] TeamDefinition сохраняется и загружается.
- [ ] TeamLayout сохраняется отдельно от semantic definition.
- [ ] TeamRun существует отдельно от TeamDefinition.
- [ ] Run хранит AgentNode → DSH Session bindings.
- [ ] Run связан со своими Messages, Tasks и TaskAttempts.
- [ ] Критический orchestration state не существует только в prompt/context.

# L. End-to-end demo

MVP принят, если стабильно проходит сценарий:

1. создать Lead, Developer и Researcher;
2. настроить их;
3. задать authority/communication;
4. выбрать Lead Entry Agent;
5. Validate и Save;
6. открыть новый DSH Chat → Use Agent Team → выбрать схему;
7. получить отдельный TeamRun с реальными DSH Sessions;
8. написать Lead цель;
9. Lead создаёт Task для Developer и при необходимости Message для Researcher;
10. live status показывает работу;
11. Open Chat Developer открывает настоящий DSH Chat;
12. Developer завершает Task;
13. результат приходит Lead и сохраняется системой;
14. Pause / Resume / Stop работают;
15. сохранённую TeamDefinition можно использовать для нового независимого TeamRun.

# Не блокирует MVP

Отсутствие Task DAG, Decision/Approval, Artifact Store, semantic memory, dynamic graph editing, multiple attempts UI, advanced recovery, analytics и service nodes не считается недостатком MVP.
