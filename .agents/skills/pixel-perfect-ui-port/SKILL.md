---
name: pixel-perfect-ui-port
description: Детерминированный перенос визуального интерфейса HTML-прототипа в существующую web-игру по одному компоненту через VUDA-наблюдение и Chromium verifier PASS/BLOCK с сохранением логики игры.
---

# Pixel Perfect UI Port v1

**Reference определяет внешний вид. Target сохраняет игровую логику, обработчики, состояние, сеть и архитектуру.** Не переносить страницу «на глаз» и не объявлять PASS по скриншотам или по VUDA `visual_comparison`.

## Порядок работы

1. Прочитай `references/rules.md` и `references/vuda.md`. Открой `example.config.json`, создай свой конфиг с reference/target HTTP(S) URL, явными selectors, viewports и components.
2. Проверь среду в каталоге навыка: `node scripts/doctor.mjs`, затем `node tests/self-test.mjs`. Если они не PASS, остановись и сообщи об ошибке среды; для установки на Windows см. `README.md` и `setup.ps1`. Доступность VUDA MCP и интеграцию Harness проверяй отдельно, не предполагай автоматически.
3. Через VUDA открой reference и target, найди визуальные области, выбери устойчивые selectors и составь очередь компонентов. Приоритет: `data-testid`/`data-qa`, `id`, role/ARIA, стабильный class. Отдельно зафиксируй исходное функционирование target и ошибки консоли до изменений. Не заменяй реальные click проверками через `evaluate()`.
4. Выбери **один** компонент очереди и viewport. Запусти `node scripts/check.mjs --config pixel-perfect.config.json --component upgrade-button --viewport desktop` (замени имя своей парой). Результаты: `artifacts/<viewport>/<component>/{reference,target}.json`, PNG, `report.json`, `diff.png` при одинаковых размерах PNG.
5. Если `BLOCK` — прочитай численные расхождения в `report.json` и `diff.png`; исправь **только внешний вид target**, устраняя первопричину, затем повтори check. Не использовать случайные offsets, масштабирование, маски, изменение reference, искусственное увеличение tolerance или автоматическое обновление baseline. Если исправление невозможно — зафиксируй blocker; к следующему компоненту без PASS или явно записанного blocker не переходи.
6. После `PASS` каждого компонента переходи к следующему. После визуальной работы **отдельно** проверь реальные игровые действия, navigation, click/hover/keyboard, необходимые hover/disabled/modal/selected/tooltip состояния через VUDA, и отсутствие **новых критических ошибок** относительно записанного baseline. Default state verifier не заменяет эту функциональную проверку.
7. В отчёте перечисли компоненты и viewports с результатом PASS/BLOCK, конкретные измерения, состояние настоящих взаимодействий, изменения ошибок консоли, пути к артефактам и оставшиеся блокеры. Не считать целую интеграцию v1 принятой без отдельного реального переноса компонента на игре.

## Порог принятия

`check.mjs`: `0` visual PASS, `1` visual BLOCK, `2` config/environment/runtime error. PASS требует одновременно geometry `x/y/width/height` с отклонением не более 0.5 CSS px, точного совпадения нормализованного утверждённого списка computed styles, **строго одинаковых размеров PNG** и `changedPixels === 0` при целочисленном допуске RGBA-каналов 0–2. Изображения не изменяют размер, а `pixelmatch`/перцепционные исключения не служат gate.

Захват использует Chromium, одинаковый viewport, 100% zoom, deviceScaleFactor 1, scroll (0,0), ждёт элемент, `document.fonts.ready`, `decode()` видимых изображений, отключает анимации только для контролируемого снимка и делает два кадра `requestAnimationFrame`. Выбирай внешний контейнер, если важны тени или overflow вне рамки элемента.

VUDA: только отдельное исследование/действия; подробности stateless/stateful и перечень инструментов — `references/vuda.md`. Исходная запись `mcp-vuda` добавлена в web profile, но без активации Host доступность VUDA и игровой trial **не подтверждены**. При missing/forbidden инструментах остановиться для маршрутизации, не обходить полномочия и не заменять обязательную функциональную приёмку через канонический Playwright.
