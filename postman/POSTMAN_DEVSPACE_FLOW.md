# Универсальный PostmanDevspace — текущий технический контракт

Статус: **ветка реализации; новые три линии/универсальные inputs ещё не прошли живой GUI-приёмки и не установлены в DSH**. Канонический источник способностей: [POSTMAN_DEVSPACE_CAPABILITIES.md](POSTMAN_DEVSPACE_CAPABILITIES.md). Порядок работ и соразмерность: [TASK_CONTRACT](../docs/workflow/TASK_CONTRACT.md).

## 1. Один основной маршрут, три независимые линии

```text
Leader ─── Secretary (files/ledger; available web_search/web_fetch)
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
- Для выбранного другого локального GitHub-проекта Leader вызывает `postman_task_prepare({project_path:'<абсолютный точный корень>'})` либо использует уже выбранный каталог сессии. Host проверяет Git root, фактический GitHub origin, основную ветку (не обязательно main), точный base SHA и закрепляет их в существующем durable registry. `read_only:true` никогда не создаёт ветку; обычный новый проект получает только локальные task branch/worktree без push. При отсутствии сети допускается только уже доказанная cached origin/HEAD+commit база; её нельзя считать актуальной удалённой базой. Пустой GitHub repo получает локальный пустой initial commit без файлов пользователя; удалённый bootstrap, push и PR выполняет только отдельно разрешённый Worker после проверки фактических refs. Legacy DSH/pinned REQ не переназначаются.
- Файлы транспорта, DevSpace-каналы, runner и управление остаются в установленном DSH, а не ищутся внутри выбранного проекта. Worktree может быть изменён только точным Host grant; AGENTS.md/REPO_POLICY.md проекта соблюдаются, когда присутствуют. При несоответствии identity/scope/remote — отказ до мутации, без автоматического fallback.
- Для внешней папки Leader явно задаёт существующий canonical `workspace_root` и `workspace_access:read|write` для конкретного REQ. Host отвергает symlinks/junctions и write grant, пересекающий постоянный репозиторий. Никакого расширения доступа из prose ChatGPT. **DevSpace shell сам по себе не файловая песочница**: если требуются жёсткие ОС-ограничения, нужен enforceable sandbox, которого эта ветка не добавляет.
- Leader явно передаёт `computer_use:allow|deny`, default deny. Задание содержит «Computer Use разрешён» или «Computer Use запрещён». При allow Host не ограничивает приложения и не требует `computer_use_target`/target adapter. Это инструкция модели, а не техническая гарантия контроля внешнего ChatGPT. Сохраняются пользовательская область, правила поставщика и права ОС; реальное отсутствие инструмента — `CAPABILITY_UNAVAILABLE`.

## 3. Файлы, исследование, изображения

- Leader использует `postman_input_files` и exact `--input-files-json <JSON>`. Host по закреплённым descriptors создает native image attachment либо безопасный ZIP входных файлов, передаёт в тот же ChatGPT. Это **транспорт входов**, не обязательный ZIP-результат. Ручные загрузки в ChatGPT не требуются. Не отправлять файлы в GitHub из-за транспорта без явного разрешения.
- ChatGPT решает задачу реально доступными Web/DevSpace/tools. Каждая отправка получает свой immutable `POSTMAN_REQUEST_ID`; прежние UNKNOWN/FAILED/PROVEN_NOT_SENT сохраняются. Перед восстановлением Host наблюдает прежний собственный чат: найденное сообщение/итог не дублируется, новое корректирующее продолжение проверяет уже выполненное.
- Для веб-исследования с требуемыми ссылками/цитатами Leader явно просит **обычный текст без местного bell**: иначе bell может скрыть `assistantText`. Host возвращает текст в `source=text_fallback` (его `diagnostic=UNKNOWN` не означает проверку веб-вызова); источники можно независимо сверить и передать Secretary, а неподтверждённую активность `web.run` нельзя считать веб-PASS.
- Настоящий GPT Image output пока имеет отдельный недостающий путь сохранения через Host; native image **input** ещё не доказывает image **result**. Legacy `@PostmanImage` остаётся резервом до доказанной универсальной image-приёмки; `@Postman` и `@PostmanAsk` также сохранены.
- Git публикация/merge/preview запрещены лишь до отдельного предусмотренного разрешения; внешний ChatGPT не получает право GitHub writes от наличия Bash/credentials.

## 4. Управление и доказательства

- `postman_devspace_control({bridge_job_id,action:'steer'|'preempt'|'stop'|'status',...})` адресует точный REQ и приватный канал. `QUEUED` — намерение, не Send/Stop proof. Распознанный Stop в собственном чате допускается по таймеру и явной команде при ACTIVE_TOOL/UNKNOWN. Это остановка генерации, а не доказательство завершения Bash/файлового writer.
- One-shot `controlId` ведётся до браузерного изменения; `SENT_CONFIRMED`, `SEND_UNKNOWN`, `STOP_UI_PROVEN` различаются. Никакого blind resend. Белл выигрывает у reminder, stop, неполного JSON/текста. Примерно 15/30/45 минут — действующая политика напоминаний для DevSpace.
- На 15/30/45 минутах Host нажимает распознанный Stop собственного чата, дожидается настоящей готовности composer и отправляет короткое продолжение с проверкой прогресса. Ожидание не прекращается через 10 секунд. `steer` ждёт готовности; `preempt`/`stop` допускаются при активном DevSpace. Повтор одного UI-клика без нового наблюдения запрещён; старый точный REQ не требуется как доказательство успеха при установленном owner/lane/Luna/URL.
- `POSTMAN_BRIDGE_READY` сообщает, что доступен результат **своего** `postman_bridge_status({bridge_job_id})`. `DONE_REPORTED` ≠ `DELIVERED` ≠ `VERIFIED` ≠ `ACCEPTED`. Чатовый текст без bell передаётся как `text_fallback` (не инженерный PASS).
- Late bell/restart: корреляция Leader/lane/REQ/childId сохраняется. Три автоматические попытки восстановления идут после первоначальной ошибки; каждая имеет durable attempt/новый job/REQ и observation. После success серия прекращается. После трёх неуспехов Leader выбирает ещё recovery, новую беседу/исполнителя или abandon. Подтверждённый прежний Send не повторяется при restart; поздний terminal обновляет только прежний REQ.
- Закрытие `postman_devspace_luna_close({lane_id?})` разрешено только idle-линиям. Без lane_id закрывает все уже settled idle линии; после этого Leader безопасно закрывает task context.

## 5. Secretary и процесс

Secretary собирает локальные факты, использует реально зарегистрированные `web_search`/`web_fetch`, принимает результаты DevSpace с указанием степени подтверждения и ведёт `postman_secretary_ledger`. Нет провайдера — честная диагностика и точный вопрос Leader; новых API/подписок не создаётся. Postman supervisor tools/PTC/subagents ему не разрешены. Ledger переживает compact/restart и не создаёт ветку. Worker — механика, Sol — резерв по решению Leader.

## 6. Приёмка и диагностика

Unit PASS не является GUI PASS. Для новой ветки проверяются continuation после transport_diagnostic/PROVEN_NOT_SENT и отсутствующего old anchor, foreign owner rejection, три recovery attempts/restart/late results, Stop при active tool, slow composer, архивирование UNKNOWN и capacity3. Дополнительно — input grants, Secretary available web, CU allow/deny и legacy Bridge/Ask/Image/Worker. Живое развёртывание и GUI требуют отдельного этапа.

**Производственная установка и `preview` не обновляются публикацией PR.** Squash в main — отдельное решение по `REPO_POLICY.md`, stable preview — отдельный человеческий GO.
