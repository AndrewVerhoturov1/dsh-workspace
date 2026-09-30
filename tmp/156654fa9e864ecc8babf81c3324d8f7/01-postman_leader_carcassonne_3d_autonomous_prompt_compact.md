# AUTONOMOUS PROJECT BRIEF — 3D CARCASSONNE-STYLE HOTSEAT WEB GAME

## Роль и режим

Ты — **Postman Leader**. Полностью автономно доведи проект от текущего состояния репозитория до законченной, запускаемой и проверенной веб-игры.

Работай как technical lead: думай, декомпозируй, выбирай исполнителей, проверяй evidence и принимай решения. Локальное исполнение отдавай Worker, сложную implementation — Postman, исследование/review — PostmanAsk, визуальные assets — PostmanImage.

Пользователь **заранее утверждает весь маршрут работы в пределах этого brief**: task preparation, Worker, несколько Worker при безопасной параллельности, Bridge, Postman/PostmanAsk/PostmanImage, `--chat` continuation, trusted artifact apply, зависимости, тесты, browser/E2E, создание и изменение файлов проекта.

**Не останавливайся после фаз для повторного согласования.** Спрашивай пользователя только при настоящем blocker, который нельзя разумно решить внутри scope.

На Postman Bridge **нет искусственного лимита**. Используй столько вызовов, сколько реально нужно, но не трать их на локальные факты и мелкие исправления, которые способен сделать Worker.

---

# 1. Продуктовая цель

Создать внутри текущего workspace проект:

`apps/carcassonne-3d/`

или другой корректный путь по conventions репозитория.

Это должна быть красивая полноценная **3D web-версия базовой tile-placement игры в духе Carcassonne**:

- hotseat 2–5 игроков;
- один компьютер;
- полный игровой цикл;
- правильные базовые land tiles;
- rotation и placement;
- meeples;
- roads, cities, monasteries, fields;
- scoring и final scoring;
- scoreboard;
- save/load;
- deterministic seed;
- законченная партия от старта до game over;
- 3D tabletop с приятным physical feel.

Пользователь приложит изображение-референс. Прикладывай его к Bridge-запросам, где он реально полезен.

---

# 2. Visual direction

Визуально это физическая дорогая настольная игра на деревянном столе:

- oak;
- parchment;
- forged iron;
- leather;
- heraldry;
- manuscript ornament;
- warm medieval lighting;
- physical cardboard tiles;
- wooden meeples;
- мягкие тени;
- аккуратные анимации.

По настроению UI может напоминать Kingdom Come: Deliverance, но **не копируй конкретные assets, рамки, иконки, композиции или branding**.

То же относится к Carcassonne:

- не использовать официальный логотип;
- не копировать официальные изображения тайлов;
- artwork должен быть оригинальным;
- правила и игровая топология должны быть точными.

---

# 3. Критическое правило: логика тайла отдельно от artwork

Нельзя делать игровые тайлы просто набором AI-картинок.

Каждый tile type должен иметь machine-readable definition:

- unique ID;
- multiplicity;
- north/east/south/west edge types;
- internal city regions;
- road segments;
- field regions;
- monastery;
- shields/pennants;
- internal connections;
- rotation/symmetry metadata.

Архитектура:

```text
TileDefinition
→ logical topology
→ deterministic masks/layout
→ procedural/composited artwork
→ 3D tile material
```

Правило-критичные элементы должны стыковаться детерминированно:

- road anchors;
- road width;
- city edge profile;
- field seam;
- rotation.

Генеративные изображения разрешены для материалов, декоративных atlas, UI, backgrounds и деталей, которые **не определяют игровую connectivity**.

---

# 4. Tile Lab — обязательно

Создай dev/debug экран вроде `/tile-lab`.

Он должен показывать:

- все tile types;
- ID и multiplicity;
- 4 rotations;
- edge labels;
- city/road/field region IDs;
- monastery/shield data;
- logical overlays;
- adjacent pair preview;
- визуальную проверку seams.

Tile Lab входит в Definition of Done.

---

# 5. Rules engine

Игровая логика должна быть pure/deterministic и не зависеть от React/Three.js/DOM.

Предпочтительная структура:

```text
src/game/
  tiles/
  board/
  features/
  scoring/
  meeples/
  turn/
  save/
```

Нужна строгая модель connected features для:

- roads;
- cities;
- fields;
- monasteries;
- feature completion;
- merged features;
- meeple majority;
- ties;
- final scoring.

Используй graph/union-find/connected-components или другое хорошо обоснованное решение.

---

# 6. Turn flow

Формализуй игровой цикл:

```text
DRAW_TILE
→ PLACE_TILE
→ PLACE_MEEPLE_OR_SKIP
→ SCORE_COMPLETED_FEATURES
→ RETURN_MEEPLES
→ NEXT_PLAYER
```

После последнего тайла:

```text
FINAL_SCORING
→ GAME_OVER
```

UI не должен напрямую создавать недопустимые переходы.

---

# 7. Gameplay requirements

Реализовать корректно:

- placement только рядом с картой;
- хотя бы один общий edge;
- все соседние edges должны совпадать;
- tile rotation;
- legal/illegal placement feedback;
- невозможность наложения;
- корректное поведение, если drawn tile нельзя поставить;
- meeple placement только на legal region;
- запрет meeple на feature, уже связанную с существующим meeple;
- merge ранее независимых features;
- возврат meeples;
- majority/ties;
- roads scoring;
- cities scoring;
- shields/pennants;
- monasteries;
- fields/farmers;
- incomplete final scoring;
- winner/tie at endgame.

**Fields требуют особенно тщательной модели и тестов.**

---

# 8. Determinism и save/load

Игра должна поддерживать reproducible seed.

Например:

`POSTMAN_TEST_0042`

должен всегда давать тот же deck order.

Нужны:

- deterministic shuffle;
- воспроизводимость bug reports;
- save/load;
- versioned save schema;
- graceful handling повреждённого/несовместимого save.

Backend/cloud не нужен.

---

# 9. Hotseat UX

Перед игрой:

- 2–5 игроков;
- имя;
- цвет;
- простой герб/символ.

Во время игры:

- current player;
- scoreboard;
- meeples remaining;
- tiles remaining;
- current tile preview;
- rotate controls;
- legal cells highlight;
- ghost preview;
- place;
- meeple regions highlight;
- skip meeple;
- scoring feedback;
- next player.

---

# 10. 3D tabletop

Предпочтительный стек:

- TypeScript;
- React;
- Vite;
- Three.js;
- `@react-three/fiber`;
- `@react-three/drei`;
- Zustand;
- Vitest;
- fast-check;
- Playwright.

Можно использовать другие подходящие библиотеки при явном преимуществе.

Нужно:

- wooden table;
- tile slabs с толщиной и bevel;
- cardboard side material;
- 3D meeples;
- lighting;
- soft shadows;
- hover;
- smooth snap placement;
- rotate animation;
- camera orbit/pan/zoom;
- damping;
- fit board;
- разумные camera limits.

Физический engine не обязателен. Предпочтительнее deterministic snap с убедительной анимацией.

---

# 11. Visual assets

Можно использовать:

- PostmanImage;
- procedural SVG/Canvas;
- generated textures;
- CC0/public-domain/permissive assets;
- procedural geometry.

Если есть сторонние assets — документируй источник и license, например в `THIRD_PARTY_ASSETS.md`.

PostmanImage используй для **многоразовых** assets, а не случайных одноразовых картинок:

- parchment/wood/iron material sheet;
- ornamental atlas;
- decorative medieval texture atlas;
- background;
- key art material.

---

# 12. Worker strategy

Worker — основной локальный исполнитель.

Ему поручай:

- repository discovery;
- conventions;
- package manager;
- implementation artifact apply;
- install;
- build;
- tests;
- browser;
- Playwright;
- screenshots;
- diagnostics;
- performance evidence;
- небольшие очевидные локальные fixes.

Не управляй Worker микрокомандами. Давай автономные законченные задания.

Несколько Worker используй только для действительно независимой работы. Учитывай shared task worktree и не допускай пересекающихся параллельных writes.

---

# 13. Postman strategy

Используй:

### PostmanAsk
Для:

- формализации правил;
- tile/scoring review;
- архитектуры;
- внешней документации;
- независимого code/rules review;
- поиска edge cases.

### Postman
Для:

- foundation;
- rules engine;
- tile system;
- крупной multi-file implementation;
- 3D renderer;
- UI;
- complex fixes;
- visual polish.

### PostmanImage
Для действительно полезных visual assets.

При сложном defect после artifact apply:

1. собрать exact evidence;
2. paths/logs/tests/screenshots;
3. продолжить ту же доказанную conversation через `--chat`, если это лучший путь.

---

# 14. Предпочтительный autonomous flow

Не обязан следовать буквально, но охвати все этапы.

## Phase A — Discovery
Worker изучает repository, conventions, target path, package manager, test setup и implementation workflow.

## Phase B — Rules/Architecture
PostmanAsk получает формальную модель:
- базовых правил;
- tile topology;
- scoring;
- fields;
- tricky cases;
- architecture/test strategy.

## Phase C — Foundation
Postman создаёт первую крупную implementation:
- app scaffold;
- pure rules engine;
- tile manifest;
- rotations;
- placement;
- feature graph;
- scoring;
- deterministic seed;
- unit/property tests;
- Tile Lab skeleton;
- basic 3D scene.

Worker применяет, собирает, тестирует и возвращает evidence.

## Phase D — Full Game
Postman доводит:
- полный playable hotseat;
- meeples;
- save/load;
- 3D board;
- camera;
- procedural tile visuals;
- UI;
- game over;
- Tile Lab.

Worker делает browser/E2E verification.

## Phase E — Art/Polish
Используй Postman/PostmanImage по текущей необходимости.

## Phase F — Final Audit
Проведи focused rules/UX/render audit, исправь реальные проблемы и повтори затронутые проверки.

Не останавливайся на scaffold/prototype.

---

# 15. Обязательные тесты

## Tile/data
Проверить:

- total tile count;
- multiplicities;
- unique IDs;
- valid topology;
- valid feature references;
- rotation;
- symmetry.

## Properties
Желательно через fast-check:

- rotate ×4 == original;
- все соседние placed edges compatible;
- tile не занимает две клетки;
- meeple count не отрицательный;
- save/load сохраняет эквивалентное состояние;
- scores finite;
- feature graph остаётся валидным.

## Scoring scenarios
Отдельные тесты для:

- roads;
- cities;
- shields;
- monasteries;
- merges;
- ties;
- incomplete endgame features;
- fields/farmers.

## Automated games
Создай headless legal player и прогони большое число seeded games.

Проверять:

- игра завершается;
- нет invalid state;
- нет crash;
- scoring конечен;
- meeples корректны;
- deck корректен.

## Playwright
Минимум:

- start game;
- rotate/place tile;
- reject illegal placement;
- place/skip meeple;
- scoring;
- next player;
- save/load;
- deterministic scenario;
- game over.

Также визуально проверить Tile Lab и несколько игровых состояний.

---

# 16. Performance и usability

Проверить:

- console errors;
- FPS;
- resize;
- high-DPI;
- texture sizes;
- явные memory/render проблемы;
- readable UI;
- current player различим не только цветом;
- основные controls понятны;
- camera не ломается.

Не заниматься преждевременной микроптимизацией.

---

# 17. Documentation

Минимум `README.md`:

- install;
- run;
- tests;
- controls;
- architecture summary;
- seed;
- Tile Lab;
- asset policy.

Дополнительные `ARCHITECTURE.md`, `TILE_SYSTEM.md`, `RULES_NOTES.md` добавляй только если они реально полезны.

---

# 18. Не входит в scope

Не делать без необходимости:

- backend;
- accounts;
- online multiplayer;
- matchmaking;
- mobile-first;
- monetization;
- Steam integration;
- VR;
- AI opponents;
- expansions;
- cloud save;
- сложный physics engine.

---

# 19. Definition of Done

Проект завершён только если:

### Gameplay
- приложение запускается;
- hotseat 2–5 игроков;
- полный deck;
- placement/rotation;
- meeples;
- scoring;
- fields;
- final scoring;
- complete game;
- save/load;
- deterministic seed.

### Tiles
- полный базовый manifest;
- правильные multiplicities;
- корректная topology;
- Tile Lab;
- хорошие visual seams.

### Visual
- 3D table;
- physical tiles;
- 3D meeples;
- camera;
- lighting/shadows;
- medieval UI;
- reference image заметно учтён;
- нет грубых placeholders в основной игре.

### Engineering
- build PASS;
- core unit tests PASS;
- scoring tests PASS;
- property/invariant tests PASS;
- browser smoke PASS;
- essential Playwright flows PASS;
- нет критических runtime errors.

---

# 20. Автономность и завершение

Не сообщай промежуточные status-only сообщения.

Не спрашивай разрешения на следующую фазу.

При локальной проблеме — диагностируй и решай.

При сложной implementation проблеме — используй Postman continuation.

При настоящем blocker сообщи только:

1. что заблокировано;
2. точную причину;
3. evidence;
4. возможные варианты;
5. какое решение пользователя действительно требуется.

После достижения Definition of Done сделай **один финальный focused audit**, исправь реальные проблемы и остановись. Не расширяй scope.

Финальный отчёт должен содержать:

- что создано;
- gameplay;
- 3D/visual;
- tile system;
- какие проверки реально запущены и их фактический результат;
- существенные Bridge/Postman вызовы и зачем они были нужны;
- точный путь проекта;
- реальные известные ограничения либо `нет`.

Главный цикл:

```text
understand
→ discover
→ architect
→ delegate
→ apply
→ verify
→ inspect evidence
→ fix
→ re-verify
→ finish
```

**Пользователь заранее разрешает автономно выполнить всю эту задачу от начала до конца в рамках данного brief.**
