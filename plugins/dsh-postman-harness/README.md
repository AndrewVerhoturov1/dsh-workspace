# DSH Postman Host

Минимальный Host для исполнения команд Leader, доставки результатов и механического таймера. Решения о маршруте, повторе, восстановлении и приёмке принимает Leader. Канонические потоки: [Bridge](../../postman/POSTMAN_BRIDGE_FLOW.md), [DevSpace](../../postman/POSTMAN_DEVSPACE_FLOW.md), резервные [Direct](../../postman/POSTMAN_CURRENT_FLOW.md)/[Ask](../../postman/POSTMAN_ASK_FLOW.md).

## Роли и PTC

Exact живой top-level `postman-leader` и совместимый `postman-leader-ptc` используют `postman-leader-supervisor` revision 10. Sol — `postman-sol-worker-engineering` revision 3. У Leader нет shell/write/edit/generic delegation; Sol не получает инструменты Leader. Ordinary Worker и Secretary работают direct/no PTC/no children. Права проверяются через штатный ToolRuntime с исходным Agent, parent token и rootCallId.

У `ptc_execute` обязателен только `program`; необязательны краткий `description`, `wait_for_event:boolean`, `language`. `wait_for_event:true` завершает ход по явному решению лидера. Host хранит режим в существующих данных сессии, адресный результат/событие или новое сообщение возобновляет работу. Не требуется подтверждать producer, перечислять статусы или доказывать ожидание по истории. Тихая диагностика отдельного model turn не создаёт.

Отказ вложенного инструмента возвращается как данные; ошибка ToolRuntime — `{isError:true,error,content?}`. Ошибка самой программы, отмена, отзыв и технический предел остаются execution failures. Effects предыдущих вызовов сохраняются; автоматического повтора нет. Helpers чтения/JSON и технические ограничения QuickJS остаются. Содержимое программы и файлов не логируется; оценки группировки/underbatching и автоматическое управление goal по повторным ошибкам отсутствуют. Полный контракт — [PTC_CONTRACT.md](../../docs/subprojects/ptc/PTC_CONTRACT.md).

## Worker, Secretary и рабочие каталоги

Leader: Secretary ×1, ordinary Worker ×2, Sol ×1. Sol: собственные ordinary Worker ×2. FAST route `codex/gpt-6-luna/low`, Sol `gpt-6.1-sol/xhigh`; FAST budget каждого assignment 8..100/default hard60/soft48. Переход между сессиями не создаёт общую model quota. Compact сохраняет ID/budget, fresh даёт новую сессию с сохранением аудита.

`postman_worker`, `postman_sol_worker`, `postman_secretary` принимают необязательный абсолютный `cwd`; по умолчанию родительский/текущий каталог. В продолжении сохраняется каталог ребёнка. Это база работы, а не граница доступа. Worker использует назначенный cwd в файловых и shell-вызовах, где он поддерживается.

Host не создаёт ветки/worktree, не синхронизирует и не восстанавливает Git, не требует закрытия прежнего контекста. Обычная папка без origin/GitHub пригодна для исследования и исполнения. Временное дерево при изменении репозитория и Git-публикацию готовит Worker по REPO_POLICY. Соответствующие старые Host task-инструменты удалены.

Lifecycle использует фактическое состояние native runtime. Качество и полнота отчёта не являются условием продолжения или освобождения фактически остановленного собственного ребёнка. Parent может адресно отменить своего работающего ребёнка; закрытие не означает PASS. Exact Sol cascade относится только к его собственным детям. Secretary ledger остаётся Host-private, вне Git и независимо от рабочего каталога.

## DevSpace и доставка

До трёх текущих DevSpace исполнений, каждый с exact lane/Luna/ChatGPT/REQ. Luna — persistent связистка с прежними инструментами; coordinator followup не является разрешением на model-authored Send. Новое поручение Leader с `lane_id` продолжает собственную беседу, включая прежний неопределённый исход. Сохранённая беседа сама по себе слот не занимает.

Host сохраняет адрес беседы при получении и ready bell/текст независимо от состояния Luna. Готовый результат доступен Leader до дополнительного разбора связисткой. Поздний bell обновляет только свой REQ. При выгрузке читаются существующие данные, а не переигрываются команды; отсутствие runtime handle не означает ни активную работу, ни отсутствие задания.

`postman_bridge_status`, `postman_bridge_list`, `postman_team_status` — наблюдение. Они не создают REQ, не запускают Luna и не отзывают права. Старые управляющие параметры status удалены. Адресные `postman_devspace_control` steer/preempt/stop и `postman_bridge_stop` сохраняются; после выгрузки проверяются сохранённый адрес и фактическая доступность управления.

Host не классифицирует текст ошибки и не создаёт цепочки восстановления. Каждый новый Send требует явной команды Leader; в одном вызове одна попытка Send. Предыдущий Send/UNKNOWN сообщается и не является veto следующей явной команды. Leader по результатам/истории/процессам выбирает продолжение и избегает повторного исполнения.

Механическое исключение — прежний таймер 15/30/45 минут: result-first → один распознанный Stop при необходимости → настоящее ожидание composer → продолжение. Максимум три подтверждённых напоминания, общий deadline прежний. UI Stop не доказывает остановку Bash; готовый результат имеет приоритет.

## Ограничения и информационные факты

Host отклоняет только обращение к чужому объекту, запрещённый роли инструмент/обход PTC, новое действие явно отозванного задания и превышение технического предела. Host сам не выполняет удаление, reset или перезапись пользовательских данных. Ошибки схемы/нативного инструмента остаются локальными результатами.

Scope/read-only и Computer Use — инструкции исполнителю; штатные права ОС/подключений не меняются. Writer binding сохраняет принадлежность собственной операции. Host не добавляет файловые fences, Git-условия или запрет из-за пересечения путей. Нет анализа текста shell-команды ради оценки её безопасности.

Предыдущий Send, возможный старый процесс, пересечение путей, отсутствие Git-метаданных, непроверенный отчёт и прежняя доставка — факты существующего ответа с источником. Они не требуют подтверждений, отдельной системы предупреждений или model wake. Лимиты описывают текущие исполнения; старая неопределённая запись сама по себе слот не удерживает.

## Резервные маршруты и вложения

Legacy `@Postman`, `@PostmanAsk`, `@PostmanImage` сохраняют Direct/Web transport и fresh one-shot Luna с transport-only allowlist. Exact child current message читается trusted no-argument `postman_send_current_turn()`. Authority результата — trusted terminal, а не prose ребёнка. Транспортная публикация REQ/RESULT не управляет рабочим Git-проектом.

`postman_input_files` закрепляет exact owner, файловый набор и отправку без Git-контекста. Native image/ZIP строится из private snapshots и проверяется по descriptor/hash; подмена не допускается. Public input staging требует отдельного разрешения. Text inline/file handoff и native image transport сохраняют свои внешние условия; обычный transport не применяет implementation ZIP.

## Implementation package

Trusted `RESULT_DURABLE` создаёт durable exact Leader/REQ grant с ZIP/SHA до освобождения Bridge. Отдельно назначенный Worker получает `artifactRequestId`, затем вызывает `implementation_artifact_apply({requestId,worktree})` с явным каталогом. Host проверяет owner/grant/hash, запускает existing `system/implementation_package_runner.py`; опубликованный HEAD и Host-prepared worktree не требуются. Runner сохраняет непосредственные проверки безопасности и совместимости применения.

При FAIL сохраняются diagnostic и пользовательские файлы, без Host reset/restore. Authoritative PASS runner при тех же входах не требует повторного запуска targeted tests. Применение, Git-публикация, merge и stable preview — разные решения по REPO_POLICY. Пакет не приносит своего runner или grant-механизма.

## Хранение, установка и проверка

Существующий реестр сохраняет exact owner/job/REQ/child/lane/conversation, Send/отмену и результаты. Исторические Git-поля читаются без миграции и не управляют допуском. Отозванные задания не получают права заново; старые UNKNOWN/FAILED не становятся success. Старые программы не replay-ятся.

`profiles/web/scripts/install-production.mjs` устанавливает plugin и необходимые native runtime patches; уже загруженные ESM этим не обновляются. Проверка изолированной установки не означает deployment. Активация и переключение действующей сессии — отдельный согласованный этап без автоматического прерывания активных заданий. `localDevelopment:true` пользователя сохраняется. Временные worktree и dirty файлы сохраняются по REPO_POLICY; stable preview требует отдельного GO.

Целевые suites запускаются из `plugins/dsh-postman-harness`, общий набор — `npm test`; PTC имеет собственный `pnpm test`. Проверяются отсутствие Git prerequisites, PTC error-as-data/ожидание, owner/role/revoke/limits, ready без Luna, cold result/control, явное продолжение UNKNOWN, поздний bell, timer и legacy/input/artifact. Synthetic source tests не являются live GUI acceptance.
