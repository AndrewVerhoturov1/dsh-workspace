# ENGINE_REPORT — C-G rules engine

Request: REQ_20261014T082534Z_5443
Status: ENGINE_IMPLEMENTED; targeted tests and production build PASS; full unfiltered Vitest suite has an out-of-scope Playwright collection error.

Exact worktree: C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA
App root: C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA/apps/carcassonne-3d

Scope honored: persistent writes only in src/game/** and app-root RULES_NOTES.md. Existing game/types.ts, scene/**, ui/**, main.tsx, package.json, dependency lock and Git metadata were NOT changed. Temporary Vite build output inside src/game/.build-verification was removed after PASS.

## Source files / responsibilities

- src/game/index.ts — all frozen exports as real runtime functions; public types re-exported unchanged.
- src/game/geometry.ts — cardinal rotation, half-port reversal, world anchors, board/grid helpers.
- src/game/catalog/base72.ts — A–X, 72 physical copies including D start, ten weighted shields; city/road/field/monastery local regions, anchors, ports and touchingCities. See SOURCE UNCERTAINTY below.
- src/game/catalog.ts — immutable validated singleton catalog, canonical JSON ordering and 64-bit FNV-1a catalog digest; checks exact copy counts, IDs, shields and valid regions.
- src/game/validate.ts — structural diagnostics for IDs, counts, anchors, edge coverage, duplicate/missing half-ports, city links, shield counts and authentic structural symmetry.
- src/game/legal.ts — all legal neighboring positions and all four rotations, sorted z/x/r, exact placement IDs, identical matching borders; read-only.
- src/game/connectivity.ts — connected feature graph by per-tile local region; cities/roads share opposing sides; fields share mirrored L/R half-ports; monastery eight surrounding tiles, unique physical tiles/shields, local-to-global stable target mapping and completed city links.
- src/game/selectors.ts — selectBoardView, getLegalPlacements, getLegalFollowerTargets; occupied connected components prohibit new followers, only on last placed tile.
- src/game/scoring.ts — completed roads/cities/monasteries, return of ALL scoring followers, majority and tied majority, unique tile counting; incomplete final scoring, fields 3 per DISTINCT completed city per farm with tied winners and no farmer reclamation.
- src/game/reducer.ts — pure immutable createGame/transition; FNV-1a over seed UTF-16 code units, Mulberry32, Fisher–Yates, seven supply meeples per player, valid placement/target IDs only, auto-discard impossible draws without losing the turn, single terminal scoring, on-failure original object and zero events.
- src/game/invariant.ts — runtime integrity checking of tile IDs/counts, connected placed board and seams, meeple targets/counts, scoring availability, phase consistency.
- src/game/save.ts — versioned schema-1 export and strict replay-only restore, catalogVersion plus deterministic digest, size/shape/version/replay errors; never trust board/scores/queue inside saved JSON.
- src/game/engine.test.ts — eleven catalog/determinism/legal/invalid-command/save/replay/discard/property/full-game tests (includes 2- and 5-player complete games).
- src/game/scoring.test.ts — eleven scenarios for 2-tile-city 4 points, split-city merge/tie and shields, road crossings/loops, monastery 9 and incomplete, occupancy, farm deduplication/multiple farms, score majority and final rules.
- RULES_NOTES.md — absolute primary rulebook URLs, exact printed/PDF page numbers, edition choices, explicitly unverified reconstructed field topology.

## Frozen API and game behavior

Exports: createGame, transition, getLegalPlacements, getLegalFollowerTargets, selectBoardView, getTileCatalog, validateTileDef, exportSave, restoreSave, rotateSide, rotateFieldPort, toBoardAnchor.

- Up to 5 players, at least 2; names/nonempty UTF-16 string seeds/colors/symbols as frozen contract. Player ID p1–p5. D is tile-D-01 at (0,0) r0. 71 shuffled remainder, optional automatic discards.
- getLegalPlacements emits all legal r0/r1/r2/r3 positions, including symmetric duplicates, and sorts by z, then x, then r.
- Only transition modifies immutable game state. Invalid commands preserve reference identity, events=[] and history unchanged. Steps: PLACE_TILE → meeple phase → optional PLACE_MEEPLE/SKIP_MEEPLE → award completed features/reclaim eligible figures → draw next playable tile or final.
- MEEPLES_RETURNED includes losers in a just-scored majority battle as well as winning meeples. Farmers stay placed until game end.
- No React, DOM, Three.js, image assets, mocks, debug bypasses, forced endings or dependencies in src/game.

## Evidence / executed commands

1. Targeted game tests:
   cd apps/carcassonne-3d && ./node_modules/.bin/vitest run src/game/scoring.test.ts src/game/engine.test.ts --no-cache --configLoader runner --pool=threads --maxWorkers=1 --reporter=dot
   PASS — 21 before final discard scenario, then 22 after.
2. Complete unfiltered Vitest discovery:
   cd apps/carcassonne-3d && ./node_modules/.bin/vitest run --no-cache --configLoader runner --pool=threads --maxWorkers=1 --reporter=dot
   PARTIAL — 35 tests PASS in 4 files, but a fifth file tests/e2e/game.spec.ts is a Playwright test incorrectly collected by Vitest, error:
   "Playwright Test did not expect test() to be called here" at tests/e2e/game.spec.ts:33.
   This is a test-runner configuration issue OUTSIDE allowed game scope; no edits attempted.
3. Production build with output kept inside approved game subtree:
   cd apps/carcassonne-3d && npm run build -- --outDir src/game/.build-verification --configLoader runner
   PASS — npm run check (tsc --noEmit) passed and Vite 8.3.4 built 600 modules, including scene and UI, in 685ms. Vite emitted one nonfatal large-bundle warning: 1,270.13 kB JS, gzip 353.60 kB. First attempt was blocked by test-only TypeScript types; fixed and rerun successfully.
4. Final focused four-suite run (game + scene + UI), after final edits:
   cd apps/carcassonne-3d && ./node_modules/.bin/vitest run src/game/engine.test.ts src/game/scoring.test.ts src/scene/scene.test.ts src/ui/presentation.test.ts --no-cache --configLoader runner --pool=threads --maxWorkers=1 --reporter=dot
   PASS — 4 files, 35 / 35 tests; 2.52s. Expected third-party THREE_CJS_DEPRECATED warning, no failures.
5. Removed only the temporary build output src/game/.build-verification after confirming successful index.html. No server, npm installation, browser automation, Git writes or agent calls.

## SOURCE UNCERTAINTY / acceptance risks

- Exact 24 tile images, physical counts, D starting mark, 10 shields and gameplay/scoring rules were checked against original Big Box 2010 PDF and updated 2024 farmer supplement; see RULES_NOTES.md.
- Individual **field port groups, touchingCities and split feature boundaries** come from the Leader-supplied inferred topology, cross-checked against photographed physical tile faces. No independently authenticated machine-readable publisher half-port graph was available. This remains a genuine acceptance risk, especially for farm connections around roads and multi-city sides. Code MUST NOT be represented as a publisher-certified digital transcription.
- Runtime engine has broad unit and property coverage including three complete 72-instance seeded sessions, but no graphical/E2E browser runs were authorized; Playwright test runner needs separate integrator execution, and Vitest should exclude tests/e2e.
- Built JS size warning and 3D/GPU behavior are integration/scene concerns outside scope. No edits to other owners' files.
