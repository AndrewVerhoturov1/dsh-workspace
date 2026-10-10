# Едва заметные полосы по шагам модели — DSH 0.1.1-rc.2

Адресная накладка на штатный `@deepseek-ai/dsh-client-ui-conversation` версии 0.1.1-rc.2. Исходная версия: [dsh-v0.1.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e), commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

## Изменение

Границы берутся из existing loaded `step/start.seq` и `llm/retry-started.seq`; scheduled/cancelled delay не создаёт попытку. Последняя граница перед anchorSeq определяет band0/1. Final LIGHT: band0 почти белая `#8E893E` (142,137,62) alpha `.02`; band1 `#268FAD` (38,143,173) alpha `.04`. DARK обе полосы `#9BA6B4` (155,166,180), alpha `.065 / .10`. Numeric `--dsh-request-band-alpha` сохраняет выбранные decimals; native body[data-ds-dark-theme] override повышенной specificity заменяет LIGHT band1 RGB на DARK для обеих полос. Настроек/легенд/номеров нет.

Штатные строки/keys не перегруппировываются. Absolute pseudo заполняет client-ширину chat scrollport (`100cqw` + existing sidepadding) и половины16px rowgap. Правый native scrollbar gutter остаётся БЕЗ paint. Только background-псевдоэлемент слева clip-path отступает на existing `--dsh-scrollbar-width` (8px для штатного WebKit scrollbar); contentpadding/cards/anchors/scrollWidth/position не меняются. Нет shadow/paint подscrollbar, нового scrollbar style или clipping интерактивных узлов. Current canonical Chromium с reserved8px gutter проверяется фактически; token не объявляется универсальной динамической шириной Firefox/overlay gutter. Для иных scrollbar режимов остаётся штатная CSS width convention, без JS observer/state. Sidebar/header/composer/pane не перекрашиваются.

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

Заменять только собранный `lib/client.js` (и соответствующий sourcemap) установленного пакета rc.2. До замены сохранить private backup прежних файлов вне репозитория; применять копией через отдельный staged-файл с rename, не изменять pnpm store/hardlink на месте. Host route /plugins читает artifact с диска на каждый запрос и отдаёт no-cache, поэтому сначала проверить текущий GUI после refresh без перезапуска. Автоматический HMR без действующего dev:web watcher не обещается. В текущем продолжении перезапуск Host не разрешён: при неисправном штатном GUI остановить live-доставку и передать blocker Leader. Другой server не запускать.

## Проверки

- Final CSS-only palette/symmetry: unchanged77 groupingtests PASS действуют, не повторялись; старый fulltsc remotes FAIL нерелевантен.
- Final `git apply --check --whitespace=error-all` на actual pristine rc.2 inputs PASS; private archive не Gitworktree, patch изготовлен `git diff --no-index`.
- Previous guttercoverage criterion ОТМЕНЁН пользователем, не blocker. Shadow/unsafe width enlargement удалены.
- Latestpalette browserbuild PASS (`pnpm exec tsdown --config .tmp-ui-bands.config.ts`), outputs client.js458.78kB/map756.06kB. Compiled clip/no-shadow/nativeDark specificity подтверждены.

Final delivery выполнена stagecopy/rename после fresh actual backup `C:/Users/Andrew/AppData/Local/Temp/dsh-ui-final-symmetry-backup-114d92956db641269db75702af660109/`; active client.js458780bytes/map756063bytes. Final actualGUI palette/theme/geometry acceptance PASS: candidate `client.js?rev=15209fee0ff4` HTTP200, существующий чат восстановлен,132anchors/76roots/composer, свежих consoleerrors/warnings нет. Stock Chromium reservedgutter8px: required paintleft=chatleft+8px, paintright=chatright-8px при unchanged clientWidth/scrollWidth992 и unchangedcolumnx402..1150 на1280viewport. FinalLIGHTtokens .02/.04 с olive/cyan RGB соответственно; DARK .065/.10sameRGB. OriginalDark восстановлена/SettingsзакрытEscape,dialogs0. LIGHT computed `.02` RGB14213762 и `.04` RGB38,143,173 —PASS; DARK exacttokens `.065/.10`, RGB155166180both (backgroundColor serialization .067/.1). Final realchat screenshots: `C:/Users/Andrew/.dsh/ui-bands-light-final-symmetric.png` и `C:/Users/Andrew/.dsh/ui-bands-dark-final-symmetric.png`, Settingsclosed. Host/innerclientWidth=scrollWidth992, columnx402..1150width748/padding32 unchanged, documentwidth1280 nooverflow; Actual pseudo clip-path `inset(0px 0px 0px 8px)` + transformedrect x280..1272 => visiblepaint x288..1272, hostouterx280..1280 => непокрашенные strips LEFT8px / RIGHT8px — PASS. Clip применён только pseudo, root/contentclip none, box-shadow none. Inlinepane недоступен и не требуется текущимactualUI; не blocker.

Publication/PR отдельное ownerрешение Leader; noHostrestart/newserver/Gitpublication/retarget/rebase/merge.
