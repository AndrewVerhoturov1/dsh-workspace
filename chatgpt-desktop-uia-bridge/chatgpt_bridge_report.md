# Отчёт о безопасном QChat через Windows UI Automation

## Итог

**READY** для проверенного режима `Current` и **PARTIALLY READY** для эксплуатации `Fresh` на текущей сборке ChatGPT Desktop/UIA. Свежий полный цикл Fresh→ValuePattern→Send→assistant→Copy подтверждён (`FreshChatRegression`, RunId `E67C0A87`, 1/1 PASS). Старые Copy/Quick регрессии также повторены в `Current` с компактным trace.

Важное ограничение: если приложение открыто в режиме Codex, сочетание `^%n` создаёт Codex-поверхность и Fresh закономерно отказывает. Bridge не переходит к старой беседе и возвращает `response=null`. После повторного захвата видимого окна и UIA-дерева проверка пустого маркера остаётся строгой.

Фактические безопасные проверки: `FreshChatRegression` — успешный цикл с `freshChatConfirmed=true`, `freshMessageCount=0`; `SubmitGateFailure` — отказ до Send; `InputRecoveryValuePattern` — безопасный отказ при неподтверждённом Fresh; `InputRecoveryClipboardFailure` — `inputMethod=ClipboardFallback`, `response=null` и `INPUT_NOT_CONFIRMED`.

При изменении UIA-дерева строгий отказ предпочтительнее возврата сомнительного текста.

## Что проверено

- Приложение: ChatGPT Desktop (`ChatGPT (Beta)`), PID во время проверки `18928`.
- Orca Computer Use: версия `1.4.188`, состояние `ready`, Windows UIA и действия доступны; фактически выполнено 11 вызовов Computer Use в этом продолжении (диагностика/восстановление окна/переключение режима/очистка composer, без отправки сообщения); один прежний диагностический вызов указан в хэндoфе отдельно.
- Кнопка: `ControlType.Button`, локализованное имя `Копировать`, `InvokePattern`, `IsEnabled=true`.
- `IsOffscreen` не используется как причина отказа: валидная кнопка может быть помечена offscreen во время виртуализации.
- Иконка Copy появляется отложенно. Реализовано bounded-ожидание до 5 секунд с опросом каждые 200 мс. После установки clipboard sentinel выполняется дополнительное ожидание до 2 секунд перед `InvokePattern`, потому что Chromium может перерисовать узел.
- Если во время ожидания Chromium заменяет UIA-узел assistant, assistant повторно связывается по exact submitted prompt. Поиск не расширяется до глобального списка кнопок.
- Clipboard-транзакция использует уникальный sentinel, опрос каждые 150 мс, проверку фактической замены буфера и условное восстановление старого буфера только если он ещё содержит sentinel либо полученный Copy-текст.

## Строгий submit gate

Assistant ищется только после двух подтверждений:

1. composer очищен;
2. exact текущий prompt найден в истории вне composer и не входит в baseline RuntimeId/text RuntimeId.

При нарушении возвращается `response=null`; assistant lookup и Copy не выполняются. Send выбирается на той же UIA-поверхности, что и composer, и вызывается через `InvokePattern`.

## Привязка assistant → Copy

Отдельного semantic message-container в текущем дереве нет: author anchors и action controls находятся под общим `thread-scroll-container`. Поэтому общий предок не считается доказательством принадлежности.

Используется ограниченная область:

```text
точный user anchor
  → первый assistant author anchor после него
  → до следующего user anchor либо до открытой границы последнего assistant
  → ровно одна enabled Copy-кнопка внутри этой области
```

Поиск не использует первую глобальную Copy-кнопку, старые assistant или соседний ответ. При нескольких кандидатах возвращается `COPY_BUTTON_AMBIGUOUS`; при отсутствии корректной привязки — ошибка и `response=null`.

После Invoke содержимое clipboard дополнительно сверяется с маркером body текущего assistant и проверяется на отсутствие submitted prompt. Повторяющиеся строки не удаляются.

## Regression: фактические результаты

Текущие результаты: `CopyRegression` RunId `EC32C9DD` — 7/7 PASS в `Current`; `QuickSmoke` RunId `6BC4C586` — 5/5 PASS; `QuickStress` RunId `6BEF7C0E` — 20/20 PASS; `FreshChatRegression` RunId `E67C0A87` — 1/1 PASS с точным ответом; `InputRecoveryValuePattern` RunId `0F6E4FA1` — 1/1 PASS как безопасный отказ до ввода; `InputRecoveryClipboardFailure` RunId `42C996A9` — 1/1 PASS (`response=null`).

`CopyRegression` подтвердил compact Copy trace: в каждом успешном случае ровно одна итоговая JSONL-запись с `Confirmed=true` и `CopyRuntimeId`; `CopyOldAssistantProtection_Preflight` использовал `Current` и подтвердил старый baseline-маркер.

| Случай | Ожидаемо | Фактически | Результат |
|---|---:|---:|---|
| FreshChatRegression | `freshChatConfirmed=true`, точный Copy | `E67C0A87`, точный ответ, trace=1 | PASS |
| SubmitGateFailure | `response=null`, Send не вызывается | `response=null`, `SUBMIT_NOT_CONFIRMED` | PASS |
| InputRecoveryValuePattern | безопасный отказ при недоказанном Fresh | `response=null`, `FRESH_CHAT_NOT_CONFIRMED` | PASS |
| InputRecoveryClipboardFailure | `response=null`, fallback не подтверждён | `response=null`, `INPUT_NOT_CONFIRMED` | PASS |

Положительный Copy-path Fresh подтверждён одним полным прогоном; 7/7 Current дополнительно подтверждены в `CopyRegression`.

Хэши текущего финального прогона:

- `chatgpt_chat.ps1`: `DF693BA2FD2CB72A65123E13C201E59FC10403FB853B9115B659C4F648CE87A3`;
- `chatgpt_bridge_test.ps1`: `172865041BCC6885AE2CD71650B28FA8FB1AD0E64B48D0606B7257686103E60A`;
- `chatgpt_uia_dump.ps1`: `0229F164500B162D85B7A0EAD51DCE6D7B1613DABE755956740CB0CAE28D530B`.

Отдельно проверено: временное изменение `chatgpt_chat.ps1` вызвало ожидаемый `COPY_REGRESSION_GATE_STALE`; исходные байты затем восстановлены.

## QuickSmoke и QuickStress

`QuickSmoke` RunId `6BC4C586` — **5/5 PASS** в `Current`; все nonce уникальны, ответы точные, trace компактный.

`QuickStress` RunId `6BEF7C0E` — **20/20 PASS** в `Current`; `attempted=20`, `unattempted=0`, `stoppedOnFailure=false`, все trace компактные.

## Вопрос о Computer Use

Да, компьютерное управление работает. Orca успешно:

- получил UIA-снимок ChatGPT Desktop;
- восстановил окно;
- нашёл composer и кнопку Send/Copy;
- очистил composer безопасным UIA-действием;
- подтвердил доступность `InvokePattern` для штатного Copy.

Индексы Orca короткоживущие, поэтому после каждого изменения интерфейса берётся свежий снимок. Вызов `orca status --json` подтвердил `runtime.state=ready` и доступность Windows UIA.

## Изменённые файлы

- [chatgpt_chat.ps1](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_chat.ps1) — строгий Fresh/submit gate, bounded повторный захват UIA-поверхности, восстановление ввода и sentinel Copy.
- [chatgpt_bridge_test.ps1](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_bridge_test.ps1) — Fresh/Input suites, Current регрессии, JSONL и hash assertions.
- [chatgpt_uia_dump.ps1](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_uia_dump.ps1) — UIA-диагностика ChatGPT Desktop.
- [chatgpt_bridge_report.md](C:\Users\andre\.dsh\chatgpt-desktop-uia-bridge\chatgpt_bridge_report.md) — фактические доказательства и статус.

Полные prompt/response и частные изображения в репозиторий не добавляются.
