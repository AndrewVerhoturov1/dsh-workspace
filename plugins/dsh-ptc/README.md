# dsh-ptc — самостоятельное ядро

Этап 1: QuickJS/WASM в отдельном завершаемом процессе Node. Импорт не запускает процесс и не регистрирует инструмент. В репозитории этап 2 подключает его через локальную зависимость Postman-плагина для экспериментального Leader и exact Sol Worker с раздельными профилями; обычные Worker и Secretary PTC не получают. Пользовательский Harness этим изменением не обновляется.

Работа: `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm test` из каталога пакета. Поставка: `pnpm pack`, установка архива в отдельный временный проект и запуск оттуда. Node >=24.21.0 для проверенного режима `stripTypeScriptTypes`.

```js
import { createPtcRuntime, DEFAULT_LIMITS } from 'dsh-ptc'
const runtime = createPtcRuntime()
const profile = {schemaVersion:1,id:'example',revision:1,tools:['echo'],limits:{...DEFAULT_LIMITS}}
try {
  const result = await runtime.run({program:'return await tools.echo({n:2})',profile,bindings:{echo: async json => json}})
  console.log(result)
} finally { await runtime.dispose() }
```

Полный нормативный контракт и границы доверия: [PTC_CONTRACT.md](../../docs/subprojects/ptc/PTC_CONTRACT.md). Источник механизма обычного QuickJS Promise и обслуживания pending jobs — Lab в PR #215, commit `952b995f06ee7f8b66cec54ae842cad73e14d270`, файлы `quickjs-lab-runtime.js` / `quickjs-lab-worker.mjs` (MIT). Код адаптирован под отдельный процесс, фреймированный поток и профиль, а не перенесён целиком. Asyncify не применяется. Пакет использует `quickjs-emscripten@0.32.0` (MIT) с транзитивным WASM; его лицензии поставляет зависимость.
