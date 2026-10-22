# Контракт приложения Carcassonne 3D

Статус: **runtime-реализация игрового движка, сцены и интерфейса существует**. Этот документ описывает действующие границы модулей и публичный API, а не прежний план C0. Контракт сохраняет чистый игровой движок, неизменяемые снимки состояния и передачу разрешённых действий из движка через UI/сцену.

## 1. Ответственность модулей

- `src/game/**` — каталог base72, чистая логика партии, правомерность ходов и целей, связность и очки, переходы состояния и replay-сохранения. Движок не импортирует React, DOM или Three.js.
- `src/scene/**` — визуализация предоставленного состояния/вариантов и обратная передача только предоставленных ID. Сцена не определяет легальность хода и не начисляет очки; камера — состояние UI, не игры.
- `src/ui/**` и `src/main.tsx` — настройки участников и seed, управление hot-seat игрой, показ событий/счёта, загрузка и выгрузка сохранения, read-only Tile Lab.
- Интеграционные файлы приложения описаны непосредственно в репозитории; репозиторий использует собственные npm-пакет и lock-файл.

## 2. Игровой API (`src/game/index.ts`)

Типы экспортируются без изменения из `src/game/types.ts`. Действующие runtime-функции:

```ts
export function createGame(input: CreateGameInput): GameState;
export function transition(state: GameState, command: GameCommand): TransitionResult;
export function getLegalPlacements(state: GameState): readonly PlacementOption[];
export function getLegalFollowerTargets(state: GameState): readonly FollowerTarget[];
export function selectBoardView(state: GameState): BoardView;
export function getTileCatalog(): TileCatalog;
export function validateTileDef(tile: TileDef): readonly TileValidationError[];
export function exportSave(state: GameState): string;
export function restoreSave(json: string): RestoreResult;
export function rotateSide(side: Side, rotation: Rotation): Side;
export function rotateFieldPort(port: FieldPort, rotation: Rotation): FieldPort;
export function toBoardAnchor(
  tile: Pick<PlacedTile, 'x' | 'z' | 'rotation'>,
  anchor: Anchor,
): { readonly x: number; readonly z: number };
```

`createGame` принимает непустую строку seed и от двух до пяти `PlayerSetup { name, color, heraldicSymbol }`. Игроки получают ID `p1`–`p5`; допустимые гербы: `lion`, `eagle`, `tower`, `sun`, `oak`. Ошибочная форма входных данных вызывает `TypeError`, число участников вне диапазона 2–5 — `RangeError`. Seed и последовательность принятых команд определяют партию.

Каталог `base72` содержит 72 физических экземпляра и стартовую плитку D в `(0,0)`, поворот `0`. В очереди разрешённых размещений представлены все законные повороты `0..3`, отсортированные по `z`, затем `x`, затем поворот; ID размещения `place:<x>,<z>:r<rotation>`. После размещения плитки разрешённые цели активной фазы имеют вид `region:<x>,<z>:<local-region-id>`.

`transition` — единственный механизм изменения `GameState`. При отказе возвращается исходный объект состояния; неверная команда не становится частью истории. Команды — `PLACE_TILE`, `PLACE_MEEPLE` и `SKIP_MEEPLE`. После размещения движок обрабатывает выбор фигурки/пропуск, завершённые объекты, следующий ход и очередь; после исчерпания доступных плиток выполняется итоговый подсчёт и состояние становится `finished`. Местные правила и описание базы каталогов изложены в `src/game/ENGINE_REPORT.md` и `RULES_NOTES.md`; полевые связи содержат реконструированную топологию и не заявляются как подтверждённая издателем машинная транскрипция.

## 3. Сцена и интерфейс

Сцена потребляет `SceneCanvasProps` и `TilePreview3DProps` из `src/scene/types.ts`; runtime-экспорты см. в `src/scene/index.ts`. Размещения и цели поступают из game selectors, а callbacks передают ID обратно UI. На осях `+x=восток`, `+z=юг` поворот плитки соответствует `rotation.y = -rotation * Math.PI / 2`. При недоступности WebGL предусмотрен 2D-режим; это не доказательство работоспособности 3D в каждой среде.

UI ведёт hot-seat игру на 2–5 человек, показывает законные действия, активного игрока и очки, поддерживает сохранение/загрузку и read-only лабораторию плиток. Камера и состояние предварительного просмотра не записываются в состояние игры.

## 4. Сохранение и проверка

Сохранение версии 1 содержит схему, идентификатор/версию каталога и digest, seed, настройки участников и последовательность команд. Восстановление создаёт партию заново и проигрывает команды через `transition`, не доверяя сериализованной доске, очкам или очереди. Ошибка загрузки не должна подменять текущую партию.

Текущее проверенное состояние и пределы приёмки перечислены в [ACCEPTANCE.md](ACCEPTANCE.md). Тестовые команды: `npm test`, `npm run check`, `npm run build`, `npm run test:e2e`; браузерная приёмка остаётся отдельным незавершённым этапом до её фактического выполнения.
