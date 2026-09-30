# PTC patterns for Postman Leader

Этот файл содержит небольшой набор рекомендуемых паттернов для `ptc_execute`.
Цель — уменьшать число полных model rounds: модель принимает решение, PTC выполняет
последовательную механику, модель получает итог.

## Главное правило

Один `ptc_execute` должен выполнять максимально полный законченный механический этап.

Не заканчивай PTC только потому, что завершился один вложенный `read`/`grep`.
Завершай batch, когда требуется:

- новое содержательное решение модели;
- ввод пользователя;
- внешний асинхронный результат (Worker report, Bridge READY и т.п.);
- отдельная граница риска/approval.

## `ptc.readAllText`

Используй для текстового файла, который действительно нужно получить целиком.

```js
const text = await ptc.readAllText({
  file_path: "docs/requirements.md"
})

return { text }
```

Helper сам продолжает `tools.read` через `offset` внутри одного `ptc_execute`.

По умолчанию действует `max_chars: 450000`. Это предохранитель helper-а, а не
замена общего PTC `maxOutputBytes`. Если файл больше, лучше обработать/отфильтровать
его внутри PTC и вернуть компактный результат.

`readAllText` предназначен для текстового анализа моделью, а не для побайтного
копирования файла: финальный перевод строки не гарантируется. Обычный `read`
может усечь слишком длинную строку; тогда helper откажется, не выдавая неполный текст за полный.

## `ptc.readMany`

Используй, когда заранее известны несколько конкретных файлов.

```js
const files = await ptc.readMany({
  files: [
    "package.json",
    "src/config.js",
    "src/runtime.js"
  ]
})

return { files }
```

MVP выполняет чтения последовательно.

## `ptc.grepMany`

Используй для нескольких заранее известных поисков.

```js
const matches = await ptc.grepMany({
  queries: [
    { pattern: "maxOutputBytes", path: "plugins/dsh-ptc/src/profiles.js" },
    { pattern: "maxWallMs", path: "plugins/dsh-ptc/src/profiles.js" }
  ]
})

return { matches }
```

MVP выполняет поиски последовательно и передаёт аргументы обычному `tools.grep`
без расширения полномочий.

## Плохо

```text
model
→ ptc_execute: read part 1
→ model
→ ptc_execute: read part 2
→ model
→ ptc_execute: read part 3
```

## Хорошо

```text
model
→ ptc_execute
    → read
    → read
    → read
    → обработка
    → компактный return
→ model
```

## Размер результата

Общий PTC `maxOutputBytes` — 512 KiB. Это потолок, а не целевой размер.

Если для решения достаточно 5 KiB, верни 5 KiB. Полный текст возвращай только
когда он действительно нужен следующему model round.

Helpers не дают новых прав. Они используют только уже доступные `tools.*`.
