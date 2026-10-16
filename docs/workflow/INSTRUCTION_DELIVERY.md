# Доставка правил агентам DSH

## Проверенное состояние и причины

Исследован установленный Harness 0.1.1-rc.2, действующие профили Web/headless и preset-композиции dsh-workspace. Начальный Git-снимок пользователя устарел: перед задачей main = preview = origin/main = origin/preview = 1df8b0eb75c21e74b11a20c57cf9699ce2bb6125 после PR #343. #334/#335 уже слиты; старая работа не использована и не удалялась.

Цепочка: пакет dsh-agent-instructions → agent/pre-step → user/message в Session → deriveMessages → request.messages адаптера модели. Обычные baselines: пользовательский DSH_HOME/AGENTS.md плюс инструкции от корня проекта до session cwd. Кандидаты по умолчанию AGENTS.md / CLAUDE.md и local-варианты. Дедупликация и byte budget действуют; Web maxBytes=65536. Markdown-ссылки не раскрываются. Вложенные инструкции обнаруживаются после успешного структурированного файлового инструмента и действуют только в обозначенном поддереве, а не как глобальная policy. Shell/Node-пути загрузчик не анализирует.

Каталог навыков: dsh-skill-filesystem читает frontmatter/описания; полный body даёт skills.get / skill tool. Наличие ссылки и наличие каталога не доказывают доставки полного документа. AGENTS.md другого независимого upstream checkout не становится инструкцией dsh-workspace. Существующий dsh-task-discipline уже добавлял шесть коротких критических правил в system prompt независимо от Postman. Его текст не расширен.

Наследование уже реализовано Harness: SubagentRuntime captureChildComposition + applyChildComposition сохраняют preset/composition; child Session имеет свой cwd, поверх общей композиции накладываются persona/tool filter. Continuable cold resume заново монтирует композицию. RuntimeContextProjection и dsh-agent-instructions восстанавливают удалённые compaction baselines. Механизмы не переписаны.

## A. Always-on

Неизменённый dsh-task-discipline/index.js: текущая задача, минимальное изменение, запрет незапрошенных слоёв/состояния/retry/fallback/dependency/validator/infrastructure, соседние проблемы только сообщать, соразмерные проверки без повторения достаточного PASS, остановка после acceptance. Это model guidance с гарантированной доставкой в стандартных Web/headless композициях, а не доказательство послушания LLM.

## B. Условная, детерминированная доставка

workspace-policy.js в существующем bundle использует system-prompt/assemble и сохранённые native tool/call события для определения затронутых путей. Tools/pre-execute не запрещает действия; tools.guard барьера доставки нет. Hint в inbox остаётся только для ещё не переданного нового контекста, а не каждого известного пути. Новый guard, служба или registry не добавляются.

- TASK_CONTRACT: coding-возможности write/edit/shell/PTC/artifact/Worker либо точная верхнеуровневая роль Postman Leader. Загружается до первого model request.
- REPO_POLICY: shell/PTC/task prepare/artifact либо точная роль Leader. Условие намеренно capability-based: классифицировать произвольный shell как Git/non-Git ненадёжно. Политика относится только к соответствующему репозиторию.
- postman-leader: canonical body через skills.get только для exact top-level Leader; inherited preset Worker не получает supervisor. Ошибка/отсутствие источника даёт WORKSPACE_INSTRUCTION_UNAVAILABLE в контексте; project-owned подмена не загружается.
- SUBPROJECT: существующие подпроекты postman, ptc, agents-nods-by-andrew. Учитываются cwd, структурированные file_path/path/workdir и сохранённые события. Первый доступ выполняется без отказа за недоставленный snapshot; следующий запрос получает актуальные инструкции. Скрытые shell/Node пути не классифицируются.
- Другие репозитории без этих документов не наследуют dsh-workspace TASK_CONTRACT/REPO_POLICY. Документы берутся из ближайшего проектного корня session cwd. Абсолютный доступ в другой worktree не переключает базу сессии автоматически; его собственные инструкции требуют явной сессии в том cwd или чтения.

Тексты включаются как именованные динамические context sections и восстанавливаются после compaction/restart. История Session и редкие first-touch hints сохраняют область; известный неизменный контекст не добавляет model turn и не будит ожидающего supervisor. Актуальный текст читается при сборке; устаревший snapshot не блокирует инструмент и не объявляется свежим.

## C. Runtime-invariants и границы

Отсутствующий/нечитаемый документ даёт честную WORKSPACE_INSTRUCTION_UNAVAILABLE в следующем контексте, а не WORKSPACE_POLICY_REQUIRED перед обычным инструментом. Повторная сборка заново пробует чтение. Это доставка инструкций; role/grant/защищённые данные по-прежнему проверяются отдельными runtime guards.

Уже имелись и не заменены: exact top-level Postman allowlist; trusted current user/message и одноразовое consume; точные REQ/owner/ZIP grants для artifact apply; Worker ownership, lifecycle, лимиты и target identity. Они проверяются программно, не по prose child. Не требуется новый policy framework.

Не превращены в runtime: «минимальная абстракция», семантический scope, достаточность проверки и stop после acceptance — требуют понимания задачи; синтаксический validator дал бы ложные запреты. REPO_POLICY не является запретом всех опасных shell-команд: при danger-full-access shell и native Node могут обойти ToolRuntime. Доставка документа не равна OS isolation. Явная просьба пользователя использовать Sol Worker достаточна для создания и последующих заданий в выбранном Sol-маршруте, без отдельного ask_user_question. Это model guidance; автоматическая Luna → Sol escalation запрещена, старый instruction-level confirmation gate не восстанавливается.

## Проверки фактического контекста

- workspace-policy.test.js: установленный SDK, реальный AgentLoop/LocalFileSystem/skill provider/Loader/AgentPresets/Jsonl/BasicCompactionEngine; инертный LlmAdapter проверяет реально переданные request.system и request.messages. Leader → continuable child, persona/preset/cwd, полные документы, отсутствие Leader skill у child; штатное compaction удаляет baseline и следующий request восстанавливает его. Отдельный второй Node-процесс cold-resume восстанавливает Leader, exact child и SUBPROJECT.
- ptc-worker-cold-resume.test.js расширен полными AGENTS/TASK_CONTRACT/REPO_POLICY и точной ролью skill в request: настоящие Postman Luna и Sol Worker, PTC QuickJS/ToolRuntime, отдельные процессы fresh/resumed, без живого LLM/transport.
- task-discipline.test.js: обе настоящие profile patch-композиции загружают bundle через Loader и доставляют документы обычному coding-agent без Postman.
- Non-blocking tests: первая запись выполняется, затем инструкции поступают модели; changed/deleted policy не запрещает shell; отсутствующий canonical skill диагностируется без project substitute. Прочие guards не изменены. Model-facing assertions не равны live eval послушания модели.

## Что ещё остаётся явным чтением

Ссылки внутри TASK_CONTRACT, REPO_POLICY, SUBPROJECT и skill не обходятся рекурсивно. Специализированные flow/authoring/merge/promotion документы и навыки не загружаются в каждый prompt: это процедурные детали применимой работы; критические Postman trust boundaries живут в Host. Анализ подпроекта без файлового доступа и скрытые shell/Node пути по-прежнему требуют явного чтения. Future coding presets, отключившие bundle/runtime context, не входят в гарантии стандартной композиции.

## Ввод в действующую установку

Правка публикуется task PR в main; merge, stable preview и установка активного Host — отдельные этапы. Тесты не меняют settings, credentials, browser state и постоянные worktree. Доступность GUI 4173 сама по себе не доказывает загрузки нового plugin.
