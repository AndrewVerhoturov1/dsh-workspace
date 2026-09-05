# Хэндoф: продолжение доработки управления ChatGPT через Codex Beta

## Цель

Продолжить первоначальную задачу по локальному управлению ChatGPT Desktop (`ChatGPT (Beta)`) через Windows UI Automation и PowerShell. Работа должна завершить безопасный транспорт QChat и подготовить feature branch с коммитом и Pull Request без слияния.

Главный инвариант:

> Один вызов QChat = одна новая подтверждённая беседа ChatGPT.

## Требования пользователя

- Добавить явную политику `-ChatPolicy Fresh` (в будущем допускается `Current`).
- Для `Fresh` никогда не использовать старую беседу как запасной путь.
- До ввода и отправки автоматически подтверждать новую беседу.
- Восстановление ввода выполнять в порядке `ValuePattern → ClipboardFallback`.
- Убрать тяжёлый `Save-MessageParentChain` из успешного пути; подробные дампы — только при ошибке/диагностике.
- Обновить навык `[SKILL.md](C:\Users\andre\.agents\skills\delegate-to-chatgpt\SKILL.md)`.
- Запустить старые регрессионные тесты и новые тесты Fresh/input/Luna.
- Создать/опубликовать feature branch, сделать коммит и PR, но не выполнять merge.
- В итоговом отчёте на русском указать причины, реализацию, файлы, тесты, количество Computer Use, SHA, ветку/PR, изменения рабочего дерева и готовность.
- Сохранить пользовательское изменение в `[settings.yaml](C:\Users\andre\.dsh\settings.yaml)`: `reasoningEffort: xhigh`. Не откатывать и не включать его в коммит, если это не будет отдельно разрешено.

## Текущее состояние репозитория

- Рабочий каталог: `C:\Users\andre\.dsh`
- Ветка: `qchat/fresh-conversation-input-recovery`
- Намеренно изменены:
  - `[chatgpt_chat.ps1](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_chat.ps1)`
  - `[chatgpt_bridge_test.ps1](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_bridge_test.ps1)`
  - `[SKILL.md](C:\Users\andre\.agents\skills\delegate-to-chatgpt\SKILL.md)`
- Предварительно существующее пользовательское изменение:
  - `[settings.yaml](C:\Users\andre\.dsh\settings.yaml)`
- Временные диагностические файлы, которые перед коммитом нужно удалить после проверки рабочего дерева:
  - `C:\Users\andre\.dsh\tmp_newchat_probe.ps1`
  - `C:\Users\andre\.dsh\tmp_newchat_probe_result.json`
  - `C:\Users\andre\.dsh\tmp_quick_probe.ps1`
- В `chatgpt-desktop-uia-bridge\logs` и `diagnostics` есть многочисленные неотслеживаемые диагностические артефакты. Не добавлять их в коммит; удалить только намеренные временные файлы после фиксации результатов.
- Отчёт `[chatgpt_bridge_report.md](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_bridge_report.md)` обновлять только после фактического финального прогона.

Перед дальнейшими действиями проверить `git status --short`, не перезаписывая и не очищая чужие изменения.

## Что уже реализовано в bridge

В `[chatgpt_chat.ps1](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_chat.ps1)` уже добавлены/изменены:

- параметры:
  - `[ValidateSet('Fresh','Current')] [Alias('ConversationPolicy')] [string]$ChatPolicy = 'Fresh'`
  - `-TestForceValuePatternFailure`
  - `-TestForceClipboardFallbackFailure`
- поля состояния/результата: `chatPolicy`, `baselineMessageCount`, `conversationRuntimeId`, `freshChatConfirmed`, `freshIdentityChanged`, `freshReason`, `inputMethod`, `inputAttemptCount`, `clipboardRestored`, `heavyDiagnostics`;
- функции нормализации и проверки текста composer;
- `ValuePattern`-очистка composer;
- `Invoke-ComposerClipboardFallback`;
- `Set-ComposerText` с обычными объектами composer, текущий вызов: `$inputResult = Set-ComposerText $w $composer $Prompt`;
- снимок состояния беседы и поиск/вызов штатной кнопки нового чата;
- повторное получение верхнего окна ChatGPT/Codex вместо доверия устаревшему дочернему UIA-элементу;
- строгий выбор маленькой кнопки `Новый чат|New chat`:
  - точное локализованное имя;
  - enabled/visible;
  - класс `sidebar-icon-button`;
  - размеры не более 80 пикселей;
  - непосредственный родитель класса `relative px-row-x`;
  - ровно один кандидат;
- `Confirm-ComposerPrompt` с требованием той же поверхности, живого элемента и двух стабильных точных readback;
- `Confirm-FreshConversation`, не использующий изменение Runtime ID как доказательство;
- передача `-TargetPid` в `Save-FailureDump` и сохранение цепочки родителей только на ошибке;
- детальная экстракция assistant только при `-VerboseLog`;
- типизированные `[object]$pattern = $null` для UIA pattern-переменных;
- безопасный вывод: stdout должен содержать ровно одну непустую JSON-строку.

Синтаксическая проверка PowerShell уже проходила: `PowerShell parse OK`.

## Ключевая нерешённая проблема Fresh

Прямой UIA-пробник доказал, что правильная маленькая кнопка нового чата работает:

- до вызова: примерно `elements=694, anchors=20, markers=0`;
- после вызова: примерно `elements=334, anchors=0, markers=0`;
- сохранённый дамп `after_header_new_chat.txt` содержит пустой маркер `Что у вас сегодня на повестке?`.

Однако bridge после того же действия иногда получает `anchors=0, markers=0, elements=334` и завершается ошибкой `EMPTY_SURFACE_MARKER_NOT_FOUND`. Это нельзя исправлять ослаблением проверки. Нужно выяснить расхождение времени/поверхности/повторного получения UIA-дерева и добавить ограниченное безопасное ожидание с повторным захватом именно видимого окна ChatGPT.

Безопасное правило остаётся обязательным:

- изменение Runtime ID, контейнера или числа элементов само по себе не доказывает новую беседу;
- при пустом baseline и отсутствии надёжного изменения наблюдаемого identity-токена Fresh может и должен безопасно отказать;
- при неподтверждённом Fresh нельзя вводить prompt и нельзя нажимать Send;
- при отказе результат должен иметь `response=null`.

Известный UIA-факт: широкая кнопка боковой панели `Новый чат` — навигационная и не должна выбираться. Нужна именно маленькая кнопка заголовка Recent-chat.

## Ключевая нерешённая проблема ввода

`ValuePattern.SetValue()` в текущем ChatGPT Desktop работает: точное значение устанавливается и читается обратно.

ClipboardFallback пока не доказан как рабочий путь. Были проверены и не помогли:

- `SendKeys`;
- `WScript.Shell.SendKeys`;
- `keybd_event`/`SendInput`;
- `WM_PASTE`;
- попытки фокусировки, несмотря на UIA `HasKeyboardFocus=true`.

Fallback должен оставаться строго подтверждаемым: очистить composer через ValuePattern, повторно получить composer, установить clipboard, выполнить вставку, затем проверить тот же surface и два стабильных точных readback. Если старое содержимое clipboard удалось прочитать — восстановить его; если не удалось, это должно быть явно отражено в результате/диагностике. Не объявлять fallback успешным по одному факту вызова клавиш.

## Состояние тестового скрипта

В `[chatgpt_bridge_test.ps1](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_bridge_test.ps1)` уже добавлены в `ValidateSet`:

- `FreshChatRegression`;
- `InputRecoveryValuePattern`;
- `InputRecoveryClipboardFailure`.

Также добавлены `-ChatPolicy`, передача политики и принудительных отказов в bridge, а `Parse-Bridge` требует ровно одну непустую JSON-строку.

Осталось:

- завершить конструкции случаев и policy-specific assertions;
- исправить/проверить JSONL-разбор в Windows PowerShell 5.1;
- завершить проверку compact Copy trace (`Confirmed=true` и `CopyRuntimeId`);
- переделать `CopyOldAssistantProtection`: основной вызов должен использовать `-ChatPolicy Current`, а тест должен явно подтвердить наличие старого baseline-маркера;
- проверить, что успешный Copy trace содержит одну компактную итоговую запись, а подробные записи появляются только в диагностическом режиме;
- добавить/завершить assertions для Fresh, ValuePattern failure и ClipboardFallback failure.

## Исторические результаты

На старом коммите `f7832c0aa51ef30e27f3f64ca39eae50d2c3132d` были результаты:

- CopyRegression: 7/7;
- QuickSmoke: 5/5;
- QuickStress: 20/20.

Изменённый код после последних правок полностью не прогонялся. Эти результаты нельзя выдавать как текущую проверку.

## Обязательная последовательность продолжения

1. Прочитать `AGENTS.md`, проверить `git status --short` и текущий diff.
2. Прочитать только нужные участки двух PowerShell-скриптов и навыка; не переписывать их целиком без необходимости.
3. Сначала провести узкую неотправляющую диагностику Fresh с уже существующим UIA-пробником или минимальным чтением состояния. Не использовать координатные клики, DOM-внедрение, OCR, reverse engineering IPC, поиск бесед, память ChatGPT или дополнительные случайные действия Computer Use.
4. Исправить только наблюдение состояния: bounded polling, повторное получение верхнего окна и различение Quick-overlay/main Codex surface. Не ослаблять Fresh gates и не применять Runtime ID как proof.
5. Проверить интеграцию `Confirm-ComposerPrompt`, повторное получение composer после перерисовки и безопасный отказ при неоднозначности.
6. Закончить тестовые случаи и assertions.
7. Запустить parse checks и безопасные тесты: Fresh refusal/success where provable, forced ValuePattern failure, forced ClipboardFallback failure. Реальные Luna-тесты запускать только когда bridge надёжен и по правилам не отправлять в старую беседу.
8. Выполнить старые регрессии и зафиксировать свежие результаты.
9. Проверить stdout, trace, failure dumps и отсутствие тяжёлой диагностики на happy path.
10. Обновить `chatgpt_bridge_report.md` по фактическим результатам.
11. Удалить временные пробники и не добавлять посторонние логи.
12. Проверить diff так, чтобы пользовательское изменение `settings.yaml` осталось нетронутым и не попало в коммит.
13. Сделать коммит только намеренных файлов, опубликовать ветку и создать PR. Не выполнять merge.

## Ограничения и безопасность

- Windows PowerShell 5.1 и Windows UI Automation.
- stdout bridge — ровно одна JSON-строка; отладка не должна загрязнять stdout.
- Нельзя отправлять сообщение, если Fresh/input/user-message/assistant-Copy pairing не подтверждены.
- Нельзя брать старый assistant response при ошибке или `response=null`.
- Один разрешённый безопасный повтор допустим только после восстановления состояния; blind retry loops запрещены.
- Computer Use уже применялся **один раз диагностически** в прежней работе. Не использовать его casually; если потребуется — только для конкретной причины после отказа bridge и точно учитывать количество в отчёте.
- Никаких перезапусков серверов, если это не потребуется явно для проверки уже существующего GUI.
- Не использовать `file://` для браузерной проверки.

## Контрольная диагностика текущей DSH-сессии

На момент создания этого хэндoфа текущий маршрут DSH:

- provider: `codex`;
- model ID: `gpt-5.6-luna`;
- reasoning effort: `xhigh`;
- адаптер: установленный `dsh-codex-oauth` v0.1.6, класс `CodexAdapter`;
- внутренний pi-ai provider: `openai-codex`, API `openai-codex-responses`.

`resolveModelInfo` у реально загруженного `CodexAdapter` возвращает для Luna `inputModalities: ['text']`, хотя исходный pi-ai каталог модели содержит `text,image`; текущий адаптер сам ограничивает ввод текстом и отклоняет изображения. Это отдельный факт диагностики и не повод расширять объём первоначальной задачи.

Последнее изображение в текущей DSH-сессии не читалось. В более ранней диагностике bridge был один вызов Computer Use; изображение не преобразовывалось OCR в текст.

## Полезные навыки для следующего чата

- `computer-use` — только аварийная точечная диагностика UIA после отказа bridge.
- `testing` — для построения и анализа регрессионных прогонов.
- `delegate-to-chatgpt` — только если в пользовательской инструкции действительно присутствует отдельный токен `QChat`.
- `orca-cli`/`orchestration` не нужны для обычного продолжения этой локальной доработки, если пользователь отдельно не попросит координацию.

## Ожидаемый итог следующего чата

Вернуть пользователю честный отчёт на русском: что исправлено, что доказано тестами, какие ограничения остаются, точный SHA, имя ветки, ссылку на PR, состояние рабочего дерева, фактическое число Computer Use и статус готовности (`READY`, `PARTIALLY READY` или `NOT READY`). PR не сливать.
