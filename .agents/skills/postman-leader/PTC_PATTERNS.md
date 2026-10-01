# Postman PTC: краткая справка

Канонический runtime protocol — [ptc-discipline.js](../../../plugins/dsh-postman-harness/lib/ptc-discipline.js). Он автоматически приходит вместе с нашим `ptc_execute`; при расхождении этот файл — источник истины, а не эта справка. Native Harness PTC/Code Mode не затрагивается.

## Supervisor dispatch

После положенного approval одна программа может проверить goal, подготовить task, проверить точный статус через `ptc.expectStatus`, принять Worker и вернуть его ID. У вызова `boundary: "external_event", yield_on_success: true`: при подтверждённом успехе Leader turn заканчивается штатным concludeTurn. Worker report / Bridge READY возобновляют его; polling не нужен. Routing определяется SKILL.md.

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

Mapper делает механическое извлечение, не семантическое summarization. `readAllText` читает внутри PTC до 4 MiB UTF-8 на файл по умолчанию; `readMany` и `mapTextFiles` учитывают совокупные байты retained JSON (default 480 KiB). Явный `max_total_bytes` позволяет больше внутренних данных, но не расширяет final output: он по-прежнему ≤512 KiB. Используй `ptc.utf8Bytes`/`ptc.jsonBytes`, а не число JS characters.

Helpers идут через обычные доступные tools и сохраняют Worker worktree guard. Это строковый текст по линиям, не побайтная копия: финальный перевод строки не гарантируется. Усечённую ordinary read строку и неполное чтение helper не выдаёт за полный файл.
