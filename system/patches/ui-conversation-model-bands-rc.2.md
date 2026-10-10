# Едва заметные полосы по шагам модели — DSH 0.1.1-rc.2

Адресная накладка на штатный `@deepseek-ai/dsh-client-ui-conversation` версии 0.1.1-rc.2. Исходная версия: [dsh-v0.1.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e), commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

## Изменение

Границы берутся из уже загруженных `step/start.seq` и `llm/retry-started.seq`. Начала retry выводятся из существующих matches при построении узла, без нового журнала и без назначенных, но отменённых ожиданий. Последняя граница перед anchorSeq определяет один из двух близких нейтральных оттенков (2% и 4% основного цвета текста).

Штатные строки и их keyed родители не перегруппировываются: добавляется только атрибут цвета существующей строки. Псевдоэлемент покрывает её и половины существующего 16px промежутка, не меняя геометрию, якоря, прокрутку или интерактивность. Reasoning/text и tool call/result остаются в своих штатных узлах. Чистые обновления содержимого не меняют селектор полосы.

Пока начало нужного шага отсутствует в загруженной истории, строка этого шага не заимствует цвет другого. После подгрузки полосы пересчитываются; абсолютная чётность до загрузки ранней истории не обещается. Полностью скрытые попытки и точный HTTP-start не визуализируются. Настроек, подписей, рамок, DOM-наблюдения и сетевого tracking нет.

## Воспроизведение

1. Получить чистый исходный архив указанного exact commit вне dsh-workspace. Полное upstream дерево и node_modules не коммитить.
2. Из его корня применить `git apply --check <dsh-workspace>/system/patches/ui-conversation-model-bands-rc.2.patch`, затем `git apply` тот же файл. Несовпадение версии/контекста — остановка, не force/fallback.
3. Node должен соответствовать upstream engine; packageManager — pnpm 11.7.0. Подготовить зависимости `pnpm install --filter @deepseek-ai/dsh-client-ui-conversation... --frozen-lockfile`.
4. Для единственного изменяемого browser artifact выбрать штатную browser-конфигурацию, не собирая Node-half и всю монорепу. В `packages/client/ui-conversation` private исходников создать временный файл `.tmp-ui-bands.config.ts`:

   ```ts
   import config from './tsdown.config.ts'
   export default config({ env: {} }).filter(item => item.name === '@deepseek-ai/dsh-client-ui-conversation/client')
   ```

   Из `packages/client/ui-conversation` запустить `pnpm exec tsdown --config .tmp-ui-bands.config.ts`. Используется штатный preset, его browser purity gate и CSS compilation, без новых build options. Полная `tsc -b`-группа требует generated remote declarations из root Host build и не является минимальной сборкой этого browser artifact. Временный config, upstream дерево и сборочные артефакты не переносить в dsh-workspace.
5. Узкие проверки: из source root `pnpm exec vitest run packages/client/ui-conversation/tests/conversation-node-definitions.client.spec.ts packages/client/ui-conversation/tests/chat-view.client.spec.tsx`. Не запускать установку профиля: install-production не является установщиком этой накладки.

## Доставка

Заменять только собранный `lib/client.js` (и соответствующий sourcemap) установленного пакета rc.2. До замены сохранить private backup прежних файлов вне репозитория; применять копией через отдельный staged-файл с rename, не изменять pnpm store/hardlink на месте. Host route /plugins читает artifact с диска на каждый запрос и отдаёт no-cache, поэтому сначала проверить текущий GUI после refresh без перезапуска. Автоматический HMR без действующего dev:web watcher не обещается. Если потребуется перезапуск DSH, его момент сначала согласует Leader с пользователем. Другой server не запускать.

## Проверки

Сборка выбранной штатной browser-конфигурации: PASS (`pnpm exec tsdown --config .tmp-ui-bands.config.ts`), выходы `lib/client.js` и `lib/client.js.map`. Полная TypeScript project graph: FAIL из-за отсутствующих generated upstream remote declarations; это не объявляется PASS и не исправляется соседней правкой. Целевые тесты: PASS, исходно 2 файла / 76 тестов; после добавления DOM-contract — изменённый chat-view: 55 тестов PASS, неизменённый assembler: 22 теста PASS. Проверены начатый retry против отменённой задержки, одна полоса шага, следующий шаг, частичная/повторно загруженная история, сохранение DOM-строки и её якорей при обновлении. `git apply --check` на точных pristine inputs: PASS. Первый candidate source-facing bundle загружен в текущем GUI: полосы 0/1 и два computed backgrounds подтверждены, однако появились `conversation service unavailable` / slot crash errors; приёмка НЕ PASS. Активный original `client.js` восстановлен из private backup, новый sourcemap удалён. После отката original artifact текущий GUI подтвердил те же `conversation service unavailable` / slot crash errors (original rev `cf4575517765`); baseline session не восстановил chat rows. Точная проверка source/original service injection не выявила candidate-only отличия. Итог стадии: BLOCKED на штатном состоянии conversation service, не общий PASS и не повод чинить соседний сервис. Candidate не оставлен активным. Для завершения требуется восстановить обычный GUI, затем повторно применить проверенный candidate и провести live acceptance; если нужен restart, сначала согласовать момент через Leader. Screenshot первого частично успешного candidate: `C:/Users/Andrew/.dsh/ui-bands-live-acceptance.png`. Это не доказательство полной приёмки. Публикация и PR — отдельный шаг Leader; merge не разрешён.
