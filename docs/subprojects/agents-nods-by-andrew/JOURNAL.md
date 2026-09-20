# Журнал подпроекта Agents Nods by Andrew

## Правила

- Записывать только существенные решения и этапы.
- Не вести журнал каждого commit, теста или микрошагa.
- Каждая запись кратко отвечает: что изменилось, почему, результат.

## Записи

### 2026-09-20 — Зафиксирована продуктовая Vision

- **Что изменилось:** сформулированы фундаментальные продуктовые инварианты DSH Agent Orchestration и граница между DSH runtime и orchestration plugin.
- **Почему:** проекту нужен стабильный источник смысла, чтобы MVP не превратился в отдельный несовместимый прототип.
- **Результат:** `DSH_Agent_Orchestration_Vision_for_MVP.md` считается главным источником semantic invariants.

### 2026-09-20 — Согласована граница MVP

- **Что изменилось:** согласован конкретный MVP: node editor, AgentNode inspector, real DSH sessions, Open Chat, Authority/Communication, минимальные Messages/Tasks, Entry Agent, Use Agent Team, Validate, TeamRun, Start/Pause/Resume/Stop, live status и Save/Load.
- **Почему:** требовалось перевести широкую Vision в понятный первый продуктовый срез.
- **Результат:** создан `DSH_Agent_Orchestration_MVP.md`; сложные Task DAG, Decision/Approval, Artifact Store, dynamic graph mutation и другие продвинутые подсистемы отложены.

### 2026-09-20 — Подготовлен Subproject package

- **Что изменилось:** направление оформлено как долгоживущий подпроект `agents-nods-by-andrew`; собраны исходные документы, архитектурные границы, roadmap и acceptance checklist.
- **Почему:** работа будет продолжаться через несколько задач, веток, PR и чатов; контекст и принятые решения должны сохраняться независимо от конкретной task branch.
- **Результат:** готов documentation-only implementation package для механического внедрения локальным агентом.
