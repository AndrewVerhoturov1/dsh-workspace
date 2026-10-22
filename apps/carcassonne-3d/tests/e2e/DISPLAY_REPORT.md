# Display acceptance — 2026-10-14

Status: **PASS for the measured emulated display test; hardware scope limited to software SwiftShader.**

## Targeted Playwright result

- New targeted test: `tests/e2e/display.spec.ts`.
- Command from app cwd: `npx playwright test tests/e2e/display.spec.ts --reporter=list`.
- Actual output: `Running 1 test using 1 worker`; `ok 1 ... measure actual WebGL rendered cadence at DPR 2 during camera input (13.7s)`; `1 passed (14.8s)`; exit 0.
- Test sets Playwright context `deviceScaleFactor: 2`, starts the real UI game with seed `DISPLAY_METRICS_5188`, verifies WebGL context, measures CSS/backing buffer dimensions and renderer string, and instruments WebGL `drawArrays`, `drawElements` plus instanced variants to collect unique 16ms buckets containing draw calls while sending actual pointer drag, wheel and Fit Board inputs over two seconds. It attaches `display-measurement.json` to Playwright test info. The console output does not surface attachment JSON; no actual rendered-frame count/renderer/buffer values are available in captured terminal output, so this report does not invent them. Test assertions confirmed DPR 2, backing width and height exceed CSS dimensions, and at least one instrumented draw-call bucket occurred. This does not certify 60 FPS or physical GPU performance.

## Final user-visible session

- Managed server job `pwsh-17`, exact command `npm run dev -- --host 127.0.0.1 --port 5188 --strictPort`, exact app cwd. Job output: Vite v8.3.4 ready in 285ms at `http://127.0.0.1:5188/`, status running.
- Host-selected browser current tab navigated to `http://127.0.0.1:5188/`, started real two-player game with seed `POSTMAN_TEST_0042`. Current URL `http://127.0.0.1:5188/game`; title `Carcassonne 3D`; active state `ХОД 1 · ПЛИТКА / Игрок 1 / Герб: Лев`; both board (783×480) and preview (373×232 buffer) canvases visible with WebGL; no alert errors. Browser snapshot displayed the game layout/action/score regions. Screenshot: `C:/Users/andre/.dsh/.playwright-mcp/carcassonne-ready.png`.
- Final direct HTTP check returned 200 and title `Carcassonne 3D`. Server should remain alive while its managed job continues; no guarantee of survival beyond tool/assignment lifetime.

No source, package, config, or Git changes. E2E suite remainder remains owned by Worker3; earlier partial status is in `BROWSER_REPORT.md`.