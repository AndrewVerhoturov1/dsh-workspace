---
name: delegate-to-chatgpt
description: Делегировать задачу обычному ChatGPT Quick Chat через готовый проверенный bridge. Skill обязателен только при отдельном управляющем токене QChat; без QChat не активируется автоматически.
---

# Delegate to ChatGPT

## Trigger

Единственный триггер — отдельное слово `QChat`, без учёта регистра. Практическое правило границ токена: `(?i)(?<![\p{L}\p{N}_])QChat(?![\p{L}\p{N}_])`. Оно может находиться в любом месте текущей инструкции:

- `QChat проверь этот план`
- `QChat: проверь этот план`
- `Используй QChat и верни только ...`

Не считать триггером часть более длинной строки: `MyQChatTool`, `QChatTest`, `notQChat`.

Правило строгое:

- если отдельный токен `QChat` присутствует, skill **обязателен**;
- если его нет, skill **не активировать самостоятельно** — не использовать сложность задачи, сомнение, низкую уверенность, слова «ChatGPT» или «Sol» как замену триггеру.

## Purpose

Skill передаёт reasoning-задачу в обычный ChatGPT Quick Chat через готовый transport bridge и возвращает локальному агенту только подтверждённый ответ. UI Automation — внутренняя деталь transport и не повторяется на уровне skill.

## Normal path

1. Найти отдельный токен `QChat` без учёта регистра.
2. Удалить управляющий токен и необязательные соседние разделители (`:`, `,`) из payload. Сохранить остальной текст без искусственного расширения.
3. Вызвать bridge явно в режиме новой ChatGPT Quick-беседы:

```powershell
$bridge = 'C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_chat.ps1'
$jsonText = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $bridge `
  -Mode Quick `
  -ChatPolicy Fresh `
  -Prompt $payload `
  -ReturnJson
$result = $jsonText | ConvertFrom-Json
```

Используется единственный рабочий bridge из [каталога](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge); основной transport не переписывать. Параметры `-Mode Quick`, `-ChatPolicy Fresh` и `-ReturnJson` обязательны и передаются явно.

## Conversation policy

Временная политика: каждый отдельный вызов `QChat` обязан создать новую пустую беседу ChatGPT. Bridge сначала подтверждает режим ChatGPT, открывает Quick-поверхность, затем использует штатную UIA-команду `Новый чат`, заново получает видимое окно и поверхность после bounded-ожидания, затем проверяет Fresh до ввода и Send. Сочетание клавиш само по себе не считается доказательством.

Инварианты:

- `QChat` не должен повторно использовать существующую беседу;
- если новая беседа не подтверждена (`FRESH_CHAT_NOT_CONFIRMED`), prompt не отправляется;
- запрещён переход к старой беседе как запасной путь;
- `baselineMessageCount` — только снимок состояния до действия и может быть ненулевым; `freshChatConfirmed` — `true` лишь после устойчивого пустого состояния, отсутствия старых якорей и подтверждённого UIA-вызова New Chat. `freshMessageCount` обязан быть `0`; изменение Runtime ID само по себе доказательством не является.

Нормальный порядок механизмов: bridge → внутреннее восстановление ввода до Send (`ValuePattern → ClipboardFallback`) → не более одного разрешённого безопасного повтора → диагностический осмотр Computer Use → честная ошибка.

## Prompt preparation

Для простого запроса отправлять payload почти напрямую. Если локальный агент собирает контекст, предпочтительный компактный формат:

```text
TASK
что нужно решить

CONTEXT
что известно

EVIDENCE
релевантный код, логи или факты

CONSTRAINTS
что нельзя менять

QUESTION
конкретный вопрос ChatGPT
```

Не добавлять нерелевантные логи и большие дампы только потому, что они доступны.

## Success handling

Разобрать JSON bridge. Успех есть только при одновременных условиях:

- `ok` имеет значение `true`;
- `response` не равен `null` и не является пустым;
- `extraction` имеет значение `copy`;
- `chatPolicy` имеет значение `fresh`, `freshChatConfirmed=true`, `freshMessageCount=0`, `chatModeConfirmed=true`, `freshTransitionObserved=true`.

При успехе использовать `response` как результат делегирования и не показывать технический JSON без явной просьбы. Ответ advisory: сверить его с локальными фактами, путями, командами и API; не выполнять разрушительные действия только по совету ChatGPT.

## Failure handling

Если `ok=false`, JSON не разобран, либо `response=null`, транзакция неуспешна: не придумывать ответ, не использовать старый ответ и не объявлять визуально найденный текст успешным результатом.

Коды `CHATGPT_MODE_NOT_CONFIRMED`, `FRESH_CHAT_NOT_CONFIRMED`, `INPUT_NOT_CONFIRMED`, `SUBMIT_NOT_CONFIRMED`, `USER_MESSAGE_NOT_CONFIRMED`, `COPY_BUTTON_AMBIGUOUS`, `COPY_ASSISTANT_PAIRING_ERROR`, `COPY_NOT_CONFIRMED`, `GENERATION_TIMEOUT`, `COMPOSER_NOT_FOUND`, `RESPONSE_NOT_FOUND` требуют честного отказа или предусмотренной диагностики; `response=null` означает, что подтверждённого ответа ChatGPT нет. При `INPUT_NOT_CONFIRMED` bridge обязан сначала сам завершить попытку `ValuePattern → ClipboardFallback`; первый неудачный readback не является причиной сразу обращаться к Computer Use.

### Retry policy

Не делать цепочки повторов. По умолчанию допускается максимум один повтор и только после восстановления состояния, если ошибка похожа на временную: например, `WINDOW_NOT_FOUND`, `COMPOSER_NOT_FOUND`, иногда `COPY_BUTTON_NOT_FOUND` или `GENERATION_TIMEOUT`.

Не повторять вслепую при неоднозначной или опасной транзакции: `SUBMIT_NOT_CONFIRMED`, `USER_MESSAGE_NOT_CONFIRMED`, `COPY_BUTTON_AMBIGUOUS`, `COPY_ASSISTANT_PAIRING_ERROR`. В этих случаях перейти к диагностике.

## Emergency Computer Use

Computer Use — только аварийный диагностический инструмент, не обычный способ общения с ChatGPT и не замена bridge.

- На успешном запросе: **0 действий Computer Use**.
- После отказа bridge: по умолчанию не более одного диагностического осмотра.
- Дополнительный осмотр допустим только для проверки конкретного состояния после исправления причины.
- Не использовать Computer Use из любопытства и не начинать с него.

Осмотр может проверить лишь фактическое состояние: правильное окно, режим ChatGPT, Quick Chat, composer, exact user message, отправку, генерацию, assistant и наличие Copy, а также причину расхождения. Если bridge не подтвердил транзакцию, нельзя прочитать ответ глазами и объявить его успехом. После диагностики либо безопасно устранить причину и повторить всю транзакцию по правилам, либо вернуть ошибку.

## Safety invariants

1. `QChat` присутствует как отдельный токен → skill обязателен.
2. `QChat` отсутствует → skill не активировать автоматически.
3. Успешный normal path → Computer Use не вызывается.
4. `ok=false` → не придумывать ответ и не брать старый.
5. `response=null` → подтверждённого ответа нет.
6. Computer Use → только диагностика.
7. Видимый через Computer Use ответ ≠ подтверждённый успех bridge.
8. Blind retry loops запрещены.
9. Не добавлять эвристические триггеры и не менять эту политику без отдельного решения.
