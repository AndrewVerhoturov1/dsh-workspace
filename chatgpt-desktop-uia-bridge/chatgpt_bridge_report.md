# Отчёт о безопасном QChat через Windows UI Automation

## Итог

**READY** для `Current` и **READY FOR FRESH QCHAT** на текущей сборке ChatGPT Desktop/UIA. Fresh сначала подтверждает режим ChatGPT, затем открывает Quick и вызывает штатный New Chat через UIA. Полный положительный цикл проходит только при `freshTransitionObserved=true`, `freshChatConfirmed=true` и `freshMessageCount=0`.

Полный Fresh gate завершён: Fresh X5, FreshAfterOldConversation, FreshFromCodex, положительный ClipboardFallback и пять реальных запусков Luna прошли. При неоднозначности bridge возвращает `response=null`; визуальный ответ не считается успехом.

Фактические безопасные проверки: `FreshChatRegression` — успешный цикл с `freshChatConfirmed=true`, `freshMessageCount=0`; `SubmitGateFailure` — отказ до Send; `InputRecoveryValuePattern` — положительный `ClipboardFallback` с точным ответом; `InputRecoveryClipboardFailure` — `inputMethod=ClipboardFallback`, `response=null` и `INPUT_NOT_CONFIRMED`.

При изменении UIA-дерева строгий отказ предпочтительнее возврата сомнительного текста.

## Что проверено

- Приложение: ChatGPT Desktop (`ChatGPT (Beta)`), PID во время проверки `18928`.
- Orca Computer Use: версия `1.4.188`, состояние `ready`, Windows UIA и действия доступны. Вызовы Computer Use во время разработки/диагностики учитываются отдельно; успешный production-style transport через bridge не должен использовать Computer Use (цель: 0).
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

Финальный последовательный gate на текущих хэшах: `CopyRegression` RunId `22ACDA17` — 7/7 PASS; `QuickSmoke` RunId `40402BF5` — 5/5 PASS; `QuickStress` RunId `EF8C549A` — 20/20 PASS. Fresh/Input-проверки также завершены успешно: `FreshChatSmoke` `3DE7CCCA` — 5/5, `FreshAfterOldConversation` `63EB03D0`, `FreshFromCodex` `1C333262`, положительный `InputRecoveryValuePattern` `F745F90E` (`ClipboardFallback`, attempts=2), отрицательный `InputRecoveryClipboardFailure` `58A9F9B2` (`response=null`, `INPUT_NOT_CONFIRMED`).

`CopyRegression` подтвердил compact Copy trace: в каждом успешном случае ровно одна итоговая JSONL-запись с `Confirmed=true` и `CopyRuntimeId`; `CopyOldAssistantProtection_Preflight` использовал `Current` и подтвердил старый baseline-маркер.

| Suite | Ожидание | Результат |
|---|---|---|
| CopyRegression Current | 7/7 | PASS `22ACDA17` |
| QuickSmoke Current | 5/5 | PASS `40402BF5` |
| QuickStress Current | 20/20 | PASS `EF8C549A` |
| FreshChatRegression | 1/1 success | PASS `C8B9023F` |
| FreshSafeRefusal | `FRESH_CHAT_NOT_CONFIRMED` | PASS `1EA002B4` |
| InputRecoveryValuePattern | positive `ClipboardFallback` | PASS `F745F90E`, attempts=2 |
| InputRecoveryClipboardFailure | safe `INPUT_NOT_CONFIRMED` | PASS `58A9F9B2` |
| FreshChatSmoke | 5/5 separate chats | PASS `3DE7CCCA` (включая старый-dialog preflight) |
| FreshAfterOldConversation | PASS | PASS `63EB03D0` |
| FreshFromCodex | PASS | PASS `1C333262` |
| Luna real QChat | 5/5 | PASS (5/5 exact Fresh bridge responses) |
| Computer Use on successful Luna QChat | 0/5 | PASS (все 5 вызовов через bridge) |

Положительный Copy-path Fresh подтверждён X5, после старого диалога и из Codex; 7/7 Current дополнительно подтверждены в `CopyRegression` на том же наборе хэшей.

Хэши текущего финального прогона:

- `chatgpt_chat.ps1`: `D13200F60FBCC846DE5185415FD3626AE153A2A326C757CAB0925070AA9B66A1`;
- `chatgpt_bridge_test.ps1`: `CDB52FE7EB2518AD42204243FFC406799DE53441A69D9BE5E45DA664E959EECE`;
- `chatgpt_uia_dump.ps1`: `0229F164500B162D85B7A0EAD51DCE6D7B1613DABE755956740CB0CAE28D530B`.

Отдельно проверено: временное изменение `chatgpt_chat.ps1` вызвало ожидаемый `COPY_REGRESSION_GATE_STALE`; исходные байты затем восстановлены.

## QuickSmoke и QuickStress

`QuickSmoke` RunId `40402BF5` — **5/5 PASS** в `Current`; все nonce уникальны, ответы точные, trace компактный.

`QuickStress` RunId `EF8C549A` — **20/20 PASS** в `Current`; `attempted=20`, `unattempted=0`, `stoppedOnFailure=false`, все trace компактные.

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
