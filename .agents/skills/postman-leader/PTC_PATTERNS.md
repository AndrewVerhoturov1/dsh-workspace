# Postman PTC: краткая справка

Канонический runtime protocol — [ptc-discipline.js](../../../plugins/dsh-postman-harness/lib/ptc-discipline.js). Он автоматически приходит вместе с нашим `ptc_execute`; при расхождении этот файл — источник истины, а не эта справка. Native Harness PTC/Code Mode не затрагивается.

## Supervisor dispatch

После положенного approval одна программа может проверить goal, подготовить task, проверить точный статус через `ptc.expectStatus(result, "postman_worker")` (либо prepare/interrupt/Bridge по имени видимого инструмента; точные успешные статусы принадлежат Host), принять Worker и вернуть его ID. У вызова `boundary: "external_event"`: exact accepted Worker/interrupt/Bridge producer и безопасный успех автоматически заканчивают Leader turn штатным concludeTurn; `yield_on_success` не требуется. Prepare alone не вызывает WAIT. Worker report / Bridge READY возобновляют его; polling не нужен. Routing определяется SKILL.md.

## Read large internally, return compact

```js
const evidence = await ptc.mapTextFiles(
  { files: ["docs/a.md", "docs/b.md"] },
  ({ file_path, text }) => ({
    file_path,
    headings: text.split("\n").filter(line => /^#{1,3} /.test(line))
  })
)
return { evidence }
```

Mapper делает механическое извлечение, не семантическое summarization. Полный исходный text, включая вложенные поля/массивы и большие строковые обёртки, отклоняется именно в `mapTextFiles`. `readMany` остаётся сырым reader внутри PTC; при реальной необходимости его данные можно вернуть модели в пределах штатного output. Читай один раз и анализируй локальную переменную несколькими способами; после write/edit или при необходимости внешней свежести перечитай. Helpers не кешируют файлы. `readAllText` допускает 4 MiB UTF-8 на файл; `readMany` и `mapTextFiles` default retained JSON 480 KiB, у `grepMany` отдельного byte limit нет. Явный `max_total_bytes` расширяет внутренний объём, не output: результат ≤512 KiB и сумма logs отдельно ≤512 KiB, как в исходном DEFAULT_LIMITS. Большие данные предпочтительно сокращать, но нужные результаты 40/80/150 KiB допустимы. Превышение штатного максимума даёт maxOutputBytes. Используй `ptc.utf8Bytes`/`ptc.jsonBytes`, а не число JS characters.

Helpers идут через обычные доступные tools и сохраняют Worker worktree guard. Это строковый текст по линиям, не побайтная копия: финальный перевод строки не гарантируется. Усечённую ordinary read строку и неполное чтение helper не выдаёт за полный файл. Формы: readAllText → string; readMany → Array<{file_path,text}>; mapTextFiles → Array<mapper JSON>; grepMany → Array<{query,result:{matches:Array}}>. Ordinary read/glob/grep — объекты lines/paths/matches, не массив целиком.

## Известный отказ остаётся внутри программы

`expectStatus` — только настоящий successful-path invariant. Multi-outcome lifecycle требует explicit exact branching, чтобы нормальный отказ не стал runtime-error:

```js
const close = await tools.postman_worker_stop({ workerSessionId, mode: 'close' })
if (close.status === 'POSTMAN_WORKER_STOPPED') {
  return { cleanupDeferred: false, status: close.status }
}
if (close.status === 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT') {
  return { cleanupDeferred: true, needsModelDecision: true, evidence: close }
}
return { needsModelDecision: true, reason: 'unexpected_status', evidence: close }
```

Неизвестный status по-прежнему останавливает механический этап. Новый helper не нужен.
