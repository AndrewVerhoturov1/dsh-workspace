# UI_REPORT — C-U complete hotseat interface and integration handoff

Request: REQ_20261014T080420Z_1512
Task workspace: C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA
App root: C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA/apps/carcassonne-3d
Write scope honored: src/ui/** and src/main.tsx only. No scene/game/package/lock/root edits; no Git operations.

## Delivered files and responsibilities

- src/main.tsx — mounts the actual UI App in React StrictMode, replacing the foundation banner.
- src/ui/App.tsx — top-level route transitions (/, /game, /tile-lab), catalog retrieval, start game and resume, immutable transitions, error handling, JSON import/export, localStorage auto-resume, restart confirmation, event relay; G runtime calls only.
- src/ui/SetupScreen.tsx — hotseat setup for exactly 2–5 participants, editable nonempty string seed default POSTMAN_TEST_0042, names, colors, all 5 heraldic symbols; input controls and validation.
- src/ui/GameScreen.tsx — live board driven by selectBoardView/getLegalPlacements/getLegalFollowerTargets, SceneCanvas, current tile 3D, rotation Q/E/R, phase actions, camera pose, mouse and fit instructions, scoreboard and finished-game view.
- src/ui/Controls.tsx — all allowed placement buttons at selected rotation and allowed follower targets, skip command. No legality computed by UI.
- src/ui/Scoreboard.tsx — current participant label/name/heraldry, scores, meeples remaining, bag/board/discard counts, engine GameEvent feed and correctly represented winner(s)/ties.
- src/ui/SaveLoad.tsx — accessible download/load file buttons, JSON file reading with size bound, per-file errors preserving the active game.
- src/ui/TileLab.tsx — complete catalog selection with ID/copies/start mark, text search, all 4 rotations, real shared 3D tile preview, region anchors/IDs/ports/shields/monastery/touchingCities, overlays, engine validateTileDef, neighbor selection and TilePairPreview2D for E/W seam with port ownership diagnostics; read-only.
- src/ui/Heraldry.tsx — original vector pictograms for lion/eagle/tower/sun/oak, with shape and text names beyond player color.
- src/ui/presentation.ts — presentation-only labels, ranking of already-computed scores, event text and keyboard-focus guard.
- src/ui/presentation.test.ts — 7 focused tests for rotations, symbols, ties, event feed, signed coordinates and player IDs.
- src/ui/styles.css — original parchment/oak/leather/iron palette and responsive layouts, desktop to narrow screens, HiDPI legibility, keyboard focus and reduced motion.
- src/ui/UI_REPORT.md — this report.

## Frozen APIs consumed

From game/index.ts (expected on completion of G): createGame, transition, getLegalPlacements, getLegalFollowerTargets, selectBoardView, getTileCatalog, validateTileDef, exportSave, restoreSave, rotateSide, rotateFieldPort.

From scene/index.ts (already real): SceneCanvas, TilePreview3D, TileArtworkPreview2D, TilePairPreview2D. GameScreen binds every SceneCanvasProps field: board, definitions, legalPlacements, followerTargets, selectedRotation, camera, onPlacementPick, onRegionPick, onHoverChange, onCameraChange, onRenderError.

Only transition(current, command) changes GameState in UI. On ok:false, the previous game object remains active and an error appears. The UI never computes scoring, legal targets, deck order or fake moves.

## Required DOM test hooks

- data-testid="start-game" — actual submit control.
- data-testid="rotate-right" — clockwise rotation.
- data-testid="legal-placement", data-placement-id="<unchanged engine id>" — legal placement buttons.
- data-testid="meeple-target", data-target-id="<unchanged engine id>" — legal follower buttons.
- data-testid="skip-meeple" — skip and advance via transition.
- data-testid="current-player" — name plus actual heraldic shape and text.
- data-testid="game-over" — engine-finished results, includes multiple winners on ties.
- data-testid="save-game" — JSON download.
- data-testid="load-game" — file picker.
- data-testid="resume-game" — replay-validated on-device resume.
- Additional: scene-container/scene-fit-board (scene owner), lab-definition, lab-rotation, tile-preview, confirm-restart.

## Save/load and keyboard details

Save and local auto-resume serialize using the engine's exportSave. Restore uses restoreSave and replaces the active game only on ok:true; invalid JSON/catalog/replay leaves previous GameState untouched. A new game requires a confirmation dialog when an active game exists. Event feed shows GameEvent items returned during the current live session; after a restored save it begins a new session feed, since GameState contains commands but not its previous events. Scores persist in the replayed GameState.

Q = counterclockwise, E or R = clockwise, never intercepted in text fields or with Ctrl/Alt/Meta. Scene owns OrbitControls and Fit Board button. Camera is UI-only state, never stored in GameState/save.

## Tests performed

- Targeted Vitest:
  cd apps/carcassonne-3d && ./node_modules/.bin/vitest run src/ui/presentation.test.ts --no-cache --configLoader runner --pool=threads --maxWorkers=1 --reporter=dot
  PASS: one file, 7/7 tests.
- Targeted TypeScript:
  cd apps/carcassonne-3d && ./node_modules/.bin/tsc --noEmit --pretty false
  BLOCKED EXPECTED: 11 missing named runtime exports in the type-only game/index.ts:
  createGame, exportSave, getTileCatalog, restoreSave, transition, getLegalFollowerTargets, getLegalPlacements, selectBoardView, rotateFieldPort, rotateSide, validateTileDef.
  No other TypeScript diagnostics remain in UI or scene files.
- No full Vite build, Playwright/browser/E2E, server startup or npm install performed as prohibited by task.

## Honest integration limits / action for G integrator

1. Implement the frozen runtime functions in src/game/** and re-export them from src/game/index.ts. No game shims/mocks were created here.
2. Run full tsc + build + game/UI/E2E in integration stage. Verify browser flows: 2/3/5 players, actual 72 tile catalog, all legal DOM selectors, tile/follower phases, scoring, final tie handling, save from meeple phase, invalid imports without state replacement, direct /tile-lab navigation and WebGL fallback.
3. Verify layout and GPU performance visually on desktop and mobile. Browser/Computer Use was not authorized in this request.

No extra dependencies, no official game imagery/assets, no test-mode shortcuts.
