# Универсальный PostmanDevspace — текущий технический контракт

Статус: **ветка реализации; новые три линии/универсальные inputs ещё не прошли живой GUI-приёмки и не установлены в DSH**. Канонический источник способностей: [POSTMAN_DEVSPACE_CAPABILITIES.md](POSTMAN_DEVSPACE_CAPABILITIES.md). Порядок работ и соразмерность: [TASK_CONTRACT](../docs/workflow/TASK_CONTRACT.md).

## 1. Один основной маршрут, три независимые линии

```text
Leader ─── Secretary (files/ledger; web results via Leader)
  ├─ laneId A → Luna A → ChatGPT A + DevSpace → REQ A → bell/text A → READY A
  ├─ laneId B → Luna B → ChatGPT B + DevSpace → REQ B → bell/text B → READY B
  └─ laneId C → Luna C → ChatGPT C + DevSpace → REQ C → bell/text C → READY C
```

- `postman_bridge({message:'@PostmanDevspace ...'})` выбирает свободную линию. `POSTMAN_BRIDGE_ACCEPTED` включает `bridgeJobId` и `laneId`. `lane_id` требуется только для адресного продолжения прежней Luna/ChatGPT-беседы.
- До трёх одновременных DevSpace REQ на одного Leader; четвёртый получает `POSTMAN_DEVSPACE_CAPACITY_REACHED` **до браузерного Send**. Legacy Bridge использует отдельные три слота. Одна линия сохраняет только один активный REQ, другая не блокируется её `UNKNOWN`.
- У каждой линии свой exact owner/childId/REQ/conversationRef, приватный binding, control queue и местный bell. Coordinator `followup` не является новым user turn и не даёт модели возможности самостоятельно вызвать `postman_send_current_turn`.
- Пересекающиеся writable folders/одна рабочая Git-ветка сериализованы; чтение и независимые папки параллельны. При неоднозначности — честный BUSY, не новая другая область.

## 2. Доступ и рабочие области

По умолчанию разрешены обычные реально доступные инструменты ChatGPT, включая веб-поиск, DevSpace Bash и работу с документами, **в пределах назначения**. Host не обещает capability, которого нет в текущем ChatGPT.

- Без prepared task context `@PostmanDevspace` создаёт branchless Host read/private-output binding **без Git push/worktree**. `WRITE_TEST` — совместимое название частной папки результата; `READ_ONLY` — явно выбранное ограничение, `WRITE_ISOLATED` — task worktree для изменения исходников.
- Для `dsh-workspace` source edits нужен обычный `postman_task_prepare()` со стабильной проверенной базой `origin/main` и отдельным worktree согласно `REPO_POLICY.md`. Worktree не создаётся для веб-исследования или частного результата.
- Для внешней папки Leader явно задаёт существующий canonical `workspace_root` и `workspace_access:read|write` для конкретного REQ. Host отвергает symlinks/junctions и write grant, пересекающий постоянный репозиторий. Никакого расширения доступа из prose ChatGPT. **DevSpace shell сам по себе не файловая песочница**: если требуются жёсткие ОС-ограничения, нужен enforceable sandbox, которого эта ветка не добавляет.
- Computer Use по умолчанию выключен для исполнителя. `computer_use_target` сейчас возвращает `COMPUTER_USE_TARGET_ENFORCEMENT_UNAVAILABLE`: нет доказанного target-scoped CU connector. Модель никогда не должна управлять через CU/GUI ChatGPT, DeepSeek Harness, Codex или саморазмножать агентов. Trusted Playwright Host Postman обслуживает только transport, не является CU исполнителя.

## 3. Файлы, исследование, изображения

- Leader использует `postman_input_files` и exact `--input-files-json <JSON>`. Host по закреплённым descriptors создает native image attachment либо безопасный ZIP входных файлов, передаёт в тот же ChatGPT. Это **транспорт входов**, не обязательный ZIP-результат. Ручные загрузки в ChatGPT не требуются. Не отправлять файлы в GitHub из-за транспорта без явного разрешения.
- Обязанность ChatGPT — решить задачу фактически доступными Web/DevSpace/tools, не имитировать MCP. Привязка к исходному REQ — immutable `POSTMAN_REQUEST_ID`. При SEND_UNKNOWN исходный Send нельзя повторять.
- Для веб-исследования с требуемыми ссылками/цитатами Leader явно просит **обычный текст без местного bell**: иначе bell может скрыть `assistantText`. Host возвращает текст в `source=text_fallback` (его `diagnostic=UNKNOWN` не означает проверку веб-вызова); источники можно независимо сверить и передать Secretary, а неподтверждённую активность `web.run` нельзя считать веб-PASS.
- Настоящий GPT Image output пока имеет отдельный недостающий путь сохранения через Host; native image **input** ещё не доказывает image **result**. Legacy `@PostmanImage` остаётся резервом до доказанной универсальной image-приёмки; `@Postman` и `@PostmanAsk` также сохранены.
- Git публикация/merge/preview запрещены лишь до отдельного предусмотренного разрешения; внешний ChatGPT не получает право GitHub writes от наличия Bash/credentials.

## 4. Управление и доказательства

- `postman_devspace_control({bridge_job_id,action:'steer'|'preempt'|'stop'|'status',...})` адресует точный REQ и приватный канал. `QUEUED` лишь намерение, не Send/Stop proof. Для **ручных Leader controls** Browser Stop допускается только при безопасном состоянии генерации, не при активном или неизвестном DevSpace tool.
- **Автоматическое DevSpace-напоминание** на 15/30/45-й минутах сначала проверяет bell и завершённый ответ. Для доказанного своего REQ/чата и последнего user turn делает ровно одну сохранённую попытку собственного Stop независимо от THINKING/ACTIVE_TOOL/TEXT_STREAMING/UNKNOWN и наличия маркера thinking; исчезновение Stop и готовность пустого поля должны быть доказаны в ограниченном наблюдении. При отсутствии Stop и готовом поле допустима прямая отправка. Готовность Send проверяется после точного ввода. При неясности Stop/Send, смене чата или нарушении привязки исходного REQ — без слепого повтора, с сохранением причины. Stop в ChatGPT не доказывает прекращения внешнего Bash. Максимум три **подтверждённые** отправки, следующая назначается через 15 минут после подтверждённой предыдущей, общий deadline не продлевается.
- One-shot `controlId` ведётся до браузерного изменения; `SENT_CONFIRMED`, `SEND_UNKNOWN`, `STOP_UI_PROVEN` различаются. Никакого blind resend. Белл выигрывает у reminder, stop, неполного JSON/текста.
- `POSTMAN_BRIDGE_READY` сообщает, что доступен результат **своего** `postman_bridge_status({bridge_job_id})`. `DONE_REPORTED` ≠ `DELIVERED` ≠ `VERIFIED` ≠ `ACCEPTED`. Чатовый текст без bell передаётся как `text_fallback` (не инженерный PASS).
- Late bell/restart: Host связывает saved Leader/lane/REQ/childId, записывает durable delivery intent до попытки native Luna followup. Не доставлять чужой bell, не повторять ChatGPT запрос после рестарта. `OUTCOME_UNKNOWN` хранит доказательства до следующего точного решения.
- Закрытие `postman_devspace_luna_close({lane_id?})` разрешено только idle-линиям. Без lane_id закрывает все уже settled idle линии; после этого Leader безопасно закрывает task context.

## 5. Secretary и процесс

Secretary собирает локальные факты, принимает от Leader результаты внешнего поиска `@PostmanDevspace` с указанием степени подтверждения и ведёт одну короткую Host-private запись `postman_secretary_ledger`. Локальные `web_search`/`web_fetch` у Secretary не вызываются: поиск требует отдельного DeepSeek API, загрузчик страниц не настроен. Ledger читается до Git prepare и переживает compact; не создаёт Markdown, branch или worktree. Leader принимает решения, не ведёт хронику своим дорогим контекстом. Worker — краткая механика и разрешённая Git-публикация, Sol — резерв при конкретном DevSpace blocker. Legacy маршруты — только по выбору Leader, не автоматический повтор после `SEND_UNKNOWN`.

## 6. Приёмка и диагностика

Unit PASS не является GUI PASS. Перед установкой проверить 3 одновременные линии/4-й отказ, continuation, input grants, external root отказ/разрешение, CU target rejection, private ledger cold reload и старые Bridge/Ask/Image/Worker регрессии. После безопасной установки — live DSH 4173: три REQ/Chats, bell+text, same-lane continuation, scope, настоящий image result, recovery и Secretary web/compact.

**Производственная установка и `preview` не обновляются публикацией PR.** Squash в main — отдельное решение по `REPO_POLICY.md`, stable preview — отдельный человеческий GO.
