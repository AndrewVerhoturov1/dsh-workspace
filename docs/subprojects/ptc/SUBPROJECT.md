# ПТС-ядро

id: ptc
status: active
updated: 2026-10-02

## Цель

Безопасный программный вызов штатных Harness-инструментов с сохранением исходной личности и проверок прав. Этап 1 — самостоятельное изолированное ядро QuickJS; этап 2 — экспериментальный верхнеуровневый Postman Leader; этап 4 — исследовательский read-only ПТС его точным Worker. Живая проверка Leader этапа 3 проведена частично; полная cross-session isolation отдельно не подтверждена.

## Текущий фокус и следующий шаг

Общее ядро `plugins/dsh-ptc` сохранено; один обычный `ptc_execute` через `ToolRuntime` принадлежит точному живому top-level `postman-leader-ptc` (PTC-first профиль `postman-leader-supervisor` revision 6: Program-First через `ptc_execute`, runtime-injected canonical `ptc-discipline.js` v2, обязательный boundary и успешный external-event auto-yield) либо его exact Host-admitted текущему Worker (provisional в первом request, затем confirmed) (отдельный `postman-worker-mutation` revision 4: `read/glob/grep/web_fetch/web_search/write/edit`). Worker PTC-first технически обязателен: shared names guard отклоняет model-direct managed calls, nested calls сохраняют границы. Worker `gpt-6-luna` получает `reasoningEffort=max` в реальном request; `notify_parent` только для `NEEDS_LEADER_GUIDANCE:`, Bridge без изменений. Остальные coding tools остаются обычными, но внутри программы не доступны. Автоматические Worker-проверки проведены без модели; Stage 4 Worker live-приёмка была проведена отдельно и вскрыла ошибочную файловую базу. Этапы 4.5/5 расширяют Host-side границу: относительные `read/glob/grep/write/edit` Worker PTC привязаны к текущему task worktree, выход через абсолютный путь, `..` и junction отклоняется. Production `postman-leader` остаётся direct-mode без ПТС; production Workers и Bridge ПТС не получают. PTC-first batching сокращает model turns без расширения Leader supervisor authority. Skill v19 сохраняет routing и предварительный user approval; Worker report и Bridge READY остаются event-driven.

Leader limits: 300000 ms, 256 nested calls, 64 MiB QuickJS, 16 MiB aggregate bridge, concurrency 1; final output остаётся 512 KiB. Общий runtime допускает не более 10 процессов. Helpers: exact `expectStatus`, UTF-8 byte-aware чтение до 4 MiB на файл, совокупный бюджет `readMany`, последовательный `mapTextFiles` для compact evidence. Leader `external_event` + exact accepted Worker/interrupt/Bridge producer автоматически завершает turn независимо от `yield_on_success`; prepare alone не создаёт WAIT. `mapTextFiles` отвергает прямое сохранение полного исходного text; `readMany` остаётся raw reader. На каждый запуск — компактная `postman/ptc-run` диагностика через штатный Cordis logger (не session event), включая underbatchedCandidate и oversizedResultCandidate (>64 KiB); Jsonl/cold resume больше не встречает неизвестный тип. Двухпроцессный round-trip exact Worker и PTC/discipline/max в первом resumed request подтверждены. Provisional Worker уже в первом request может послать exact `NEEDS_LEADER_GUIDANCE:`, но не FYI. Новый этап сокращает model-round overhead, не расширяет authority и не меняет native Harness PTC. Проверяется автоматически через настоящий QuickJS/ToolRuntime и установленный Agent loop без живой модели; установка и live acceptance остаются отдельным этапом.

## Границы и решения

- Новая программа — новый процесс и QuickJS runtime; профили — данные, а не названия ролей. Нет наследования, второго реестра Worker, долгоживущей REPL или автоматического повтора. Общие пределы runtime действуют для трёх независимых Worker.
- Lab QuickJS на PR #215 пользователем подтверждён живым; это не означает, что каждый старый тест был live. Проверенный механизм обычного Promise перенесён выборочно; Asyncify с известной ошибкой очистки не применяется.
- Аудит `dsh-ptc-plus@0.3.2` завершён: Node-пути к файлам/процессам/окружению делают его недостаточной границей; изменение Plus не входит в текущую задачу.
- Будущий конструктор лидеров и субагентов — роли, навыки, инструменты, ограничения и сохранённые пресеты — отложен; этап 1 предоставляет лишь проверяемый профиль.

## Живые проверки и следующая граница

Для experimental Leader в установленной сборке подтверждены: точный namespace, отсутствие Node globals, настоящие `read/grep/get_goal`, `maxWallMs` и новый запуск после timeout, внешний пользовательский Stop и новый запуск после abort. Вызов `web_fetch` дошёл до штатного инструмента, но web provider отсутствовал. Stage 4 Worker live подтвердил namespace PASS, отсутствие Node globals и mutation/shell/privileged PTC functions, настоящий glob/read/grep PASS, continuable follow-up PASS, selective stop трёх Worker PASS и отсутствие PTC production Worker PASS. Одновременно `read("plugins/dsh-ptc/src/runtime.js")` прочёл `.dsh`/session cwd вместо task worktree — поэтому этап 5 был остановлен. Этап 4.5 исправляет этот Host-side дефект; его live-приёмка не проводилась, автоматическая cross-session проверка не заменяет live cross-session isolation. Отдельное разрешение потребуется до установки/загрузки ветки и модели. Этап 5 реализован и проверен автоматическими тестами без модели: `write/edit` внутри Worker PTC идут через тот же Host-side guard к штатному ToolRuntime с exact Worker Agent. Успешная mutation не откатывается при поздней ошибке; shell внутри PTC отсутствует. Stage 5A (защита от конкурентной враждебной перестановки namespace между ordinary Worker) отложен и не является prerequisite MVP. Live acceptance остаётся отдельным Stage 6; установка и приёмка моделью не проводились.

## Прочитать сначала

`AGENTS.md`, `REPO_POLICY.md`, этот файл, [PTC_CONTRACT.md](PTC_CONTRACT.md), [JOURNAL.md](JOURNAL.md), `plugins/dsh-ptc/README.md`.
