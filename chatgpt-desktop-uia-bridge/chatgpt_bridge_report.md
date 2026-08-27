# Отчёт о штатном Copy через Windows UI Automation

## Итог

**READY FOR QUICK MODE** on current ChatGPT Desktop/UIA build.

Все обязательные финальные gate пройдены на одном и том же коммите `f7832c0aa51ef30e27f3f64ca39eae50d2c3132d`; stale-gate также проверен отрицательным тестом.

Проверка не распространяется на все сценарии автоматизации: `NewChat` в этой итерации не тестируется, а при изменении интерфейса ChatGPT/Chromium требуется повторная проверка. При изменении UIA-дерева строгие ошибки предпочтительнее возврата сомнительного текста.

## Что проверено

- Приложение: ChatGPT Desktop (`ChatGPT (Beta)`), PID во время проверки `18928`.
- Orca Computer Use: версия `1.4.188`, состояние `ready`, Windows UIA и действия доступны.
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

## Regression: обязательные 7 случаев

Последний финальный запуск: `CopyRegression`, RunId `A56D1ADB`; результат **7/7 PASS**. Запуск привязан к коммиту `f7832c0aa51ef30e27f3f64ca39eae50d2c3132d` и хэшам текущих скриптов.

| Случай | Ожидаемо | Фактически | Результат |
|---|---:|---:|---|
| CopyOneLine | 12 | 12 | PASS |
| CopyTwoLines | 29 | 29 | PASS |
| CopyRepeated | 41 | 41 | PASS |
| CopyMarkdown | 42 | 42 | PASS |
| CopyLong | 103 | 103 | PASS |
| CopyOldAssistantProtection | 18 | 18 | PASS |
| SubmitGateFailure | `response=null` | `response=null` | PASS |

Во всех положительных случаях SHA-256 ожидаемого и фактического текста совпал, старый marker отсутствовал, а лишние элементы интерфейса (`Сообщение ChatGPT`, `ChatGPT сказал`, `Копировать`, feedback labels) в ответ не попали.

Файл результата: [CopyRegression_final_f7832c0_results.json](D:\DEEPSEEK\CopyRegression_final_f7832c0_results.json).

Хэши кода в этом результате:

- `chatgpt_chat.ps1`: `96e5d3690eaf56fa51d0e4337a4d29eb9d8e3219de38de32f290071145620ebe`;
- `chatgpt_bridge_test.ps1`: `0697a8ba03058237f527ee22691974d962d593ae4b058b5d18ef2f1ccf0bfa53`;
- `chatgpt_uia_dump.ps1`: `0229f164500b162d85b7a0ead51dce6d7b1613dabe755956740cb0cae28d530b`.

Отдельно проверено: временное изменение `chatgpt_chat.ps1` вызвало ожидаемый `COPY_REGRESSION_GATE_STALE`; исходные байты затем восстановлены.

## QuickSmoke

Quick разрешается только после полного `CopyRegression 7/7`. После финального gate выполнен контролируемый последовательный `QuickSmoke` из пяти случаев:

- RunId `9271108B`;
- результат: **5/5 PASS**;
- nonce каждого случая уникален и имеет формат `Q01_<RunId>` … `Q05_<RunId>`;
- каждый случай подтвердил exact совпадение длины и SHA-256, отсутствие старого marker и наличие Copy trace.

Файл результата: [QuickSmoke_final_f7832c0_results.json](D:\DEEPSEEK\QuickSmoke_final_f7832c0_results.json).

`QuickStress` выполнен после успешных Regression и QuickSmoke:

- RunId `9FA8DA2F`;
- результат: **20/20 PASS**;
- nonce каждого случая уникален и имеет формат `Q01_<RunId>` … `Q20_<RunId>`;
- `attempted=20`, `unattempted=0`, `stoppedOnFailure=false`.

Файл результата: [QuickStress_final_f7832c0_results.json](D:\DEEPSEEK\QuickStress_final_f7832c0_results.json).

Все три результата содержат одинаковые SHA-256 для трёх кодовых файлов и одинаковый `gitCommit` `f7832c0aa51ef30e27f3f64ca39eae50d2c3132d`.

## Вопрос о Computer Use

Да, компьютерное управление работает. Orca успешно:

- получил UIA-снимок ChatGPT Desktop;
- восстановил окно;
- нашёл composer и кнопку Send/Copy;
- очистил composer безопасным UIA-действием;
- подтвердил доступность `InvokePattern` для штатного Copy.

Индексы Orca короткоживущие, поэтому после каждого изменения интерфейса берётся свежий снимок. Вызов `orca status --json` подтвердил `runtime.state=ready` и доступность Windows UIA.

## Изменённые файлы

- [chatgpt_chat.ps1](D:\DEEPSEEK\chatgpt_chat.ps1) — строгий submit gate, bounded assistant→Copy pairing, ожидание отложенной иконки, sentinel clipboard transaction и диагностика.
- [chatgpt_bridge_test.ps1](D:\DEEPSEEK\chatgpt_bridge_test.ps1) — обязательная suite 7/7, строгий gate для Quick и проверка хэшей/лишних UI-текстов.
- [chatgpt_uia_dump.ps1](D:\DEEPSEEK\chatgpt_uia_dump.ps1) — корректный immediate `ParentRuntimeId` и выбор ChatGPT Desktop.
- [chatgpt_bridge_report.md](D:\DEEPSEEK\chatgpt_bridge_report.md) — итоговые доказательства и статус.

Полные prompt/response и частные изображения в репозиторий не добавляются.
