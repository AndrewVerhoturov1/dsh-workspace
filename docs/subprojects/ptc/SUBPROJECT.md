# ПТС-ядро

id: ptc
status: active
updated: 2026-09-30

## Цель

Безопасный программный вызов штатных Harness-инструментов с сохранением исходной личности и проверок прав. Этап 1 — самостоятельное изолированное ядро QuickJS; этап 2 — экспериментальный верхнеуровневый Postman Leader; этап 4 — исследовательский read-only ПТС его точным Worker. Живая проверка Leader этапа 3 проведена частично; полная cross-session isolation отдельно не подтверждена.

## Текущий фокус и следующий шаг

Общее ядро `plugins/dsh-ptc` сохранено; один обычный `ptc_execute` через `ToolRuntime` принадлежит точному живому top-level `postman-leader-ptc` (профиль `read/grep/get_goal/web_fetch`) либо его подтверждённому текущему Worker (отдельный `postman-worker-mutation` revision 2: `read/glob/grep/web_fetch/web_search/write/edit`). У Worker остальные coding tools остаются обычными, но внутри программы не доступны. Автоматические Worker-проверки проведены без модели; Stage 4 Worker live-приёмка была проведена отдельно и вскрыла ошибочную файловую базу. Этапы 4.5/5 расширяют Host-side границу: относительные `read/glob/grep/write/edit` Worker PTC привязаны к текущему task worktree, выход через абсолютный путь, `..` и junction отклоняется. Production Leader/Workers и Bridge ПТС не получают.

## Границы и решения

- Новая программа — новый процесс и QuickJS runtime; профили — данные, а не названия ролей. Нет наследования, второго реестра Worker, долгоживущей REPL или автоматического повтора. Общие пределы runtime действуют для трёх независимых Worker.
- Lab QuickJS на PR #215 пользователем подтверждён живым; это не означает, что каждый старый тест был live. Проверенный механизм обычного Promise перенесён выборочно; Asyncify с известной ошибкой очистки не применяется.
- Аудит `dsh-ptc-plus@0.3.2` завершён: Node-пути к файлам/процессам/окружению делают его недостаточной границей; изменение Plus не входит в текущую задачу.
- Будущий конструктор лидеров и субагентов — роли, навыки, инструменты, ограничения и сохранённые пресеты — отложен; этап 1 предоставляет лишь проверяемый профиль.

## Живые проверки и следующая граница

Для experimental Leader в установленной сборке подтверждены: точный namespace, отсутствие Node globals, настоящие `read/grep/get_goal`, `maxWallMs` и новый запуск после timeout, внешний пользовательский Stop и новый запуск после abort. Вызов `web_fetch` дошёл до штатного инструмента, но web provider отсутствовал. Stage 4 Worker live подтвердил namespace PASS, отсутствие Node globals и mutation/shell/privileged PTC functions, настоящий glob/read/grep PASS, continuable follow-up PASS, selective stop трёх Worker PASS и отсутствие PTC production Worker PASS. Одновременно `read("plugins/dsh-ptc/src/runtime.js")` прочёл `.dsh`/session cwd вместо task worktree — поэтому этап 5 был остановлен. Этап 4.5 исправляет этот Host-side дефект; его live-приёмка не проводилась, автоматическая cross-session проверка не заменяет live cross-session isolation. Отдельное разрешение потребуется до установки/загрузки ветки и модели. Этап 5 реализован и проверен автоматическими тестами без модели: `write/edit` внутри Worker PTC идут через тот же Host-side guard к штатному ToolRuntime с exact Worker Agent. Успешная mutation не откатывается при поздней ошибке; shell внутри PTC отсутствует. Stage 5A (защита от конкурентной враждебной перестановки namespace между ordinary Worker) отложен и не является prerequisite MVP. Live acceptance остаётся отдельным Stage 6; установка и приёмка моделью не проводились.

## Прочитать сначала

`AGENTS.md`, `REPO_POLICY.md`, этот файл, [PTC_CONTRACT.md](PTC_CONTRACT.md), [JOURNAL.md](JOURNAL.md), `plugins/dsh-ptc/README.md`.
