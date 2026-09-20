# Agents Nods by Andrew — карта документов

Этот каталог содержит долговременный контекст подпроекта DSH Agent Orchestration.

## С чего начинать

Для обычной задачи по этому направлению:

1. прочитать repository-level правила (`AGENTS.md`, `REPO_POLICY.md` и нужный canonical workflow);
2. прочитать `SUBPROJECT.md`;
3. затем открыть только те документы из `documents/`, которые нужны текущей задаче.

Не нужно читать `Original Full Concept` для каждой задачи.

## Приоритет документов проекта

Если формулировки расходятся, использовать следующий порядок:

1. **Vision** — фундаментальные semantic invariants.
2. **Current MVP** — согласованная граница первого продукта.
3. **MVP Handoff** — контекст, ограничения и объяснение того, как MVP выводился из Vision.
4. **Architecture Boundaries** — короткая техническая памятка по инвариантам реализации.
5. **Implementation Roadmap / Acceptance Checklist** — рабочая разбивка и критерии готовности.
6. **Original Full Concept** — каталог идей и исследовательский материал, а не обязательный backlog.

## Документы

### Канонический контекст подпроекта

- `SUBPROJECT.md` — актуальная цель, текущий фокус, следующий шаг, границы и принятые решения.
- `JOURNAL.md` — только существенные этапы и решения.

### Исходные документы

- `documents/DSH_Agent_Orchestration_Vision_for_MVP.md`
- `documents/DSH_Agent_Orchestration_MVP_Handoff.md`
- `documents/DSH_Agent_Orchestration_MVP.md`
- `documents/DSH_Agent_Orchestration_Concept_Original_Full.md`

### Подготовленные документы

- `documents/DSH_Agent_Orchestration_Architecture_Boundaries.md`
- `documents/DSH_Agent_Orchestration_MVP_Acceptance_Checklist.md`
- `documents/DSH_Agent_Orchestration_Implementation_Roadmap.md`

## Ключевое правило

Не строить «mini-Orca» или отдельный agent engine внутри плагина. DSH исполняет отдельных агентов; плагин организует команду, связи, задачи, сообщения, run state и визуальное управление.
