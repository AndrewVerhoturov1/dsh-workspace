# E2E execution status

Scope: Playwright tests 3, 5, and 6 in `game.spec.ts` only. This records observed outcomes; it is not a full-suite rerun.

## Initial focused execution

With the existing app server at `http://127.0.0.1:5188`, the three requested tests were run together:

- Test 3 (download, corrupt import preservation, restore): failed at line 76. `innerText()` returned multiline text, while Playwright `toHaveText()` normalized the locator text to a single line. The observed player/turn content was the same; the assertion representation differed.
- Test 5 (complete a game by UI actions): failed at action 14 because the selected rotation had no legal placement buttons, although the UI reported other legal placements existed (`0 из 16`). Test had assumed the selected rotation always had an option.
- Test 6 (Tile Lab): **PASS**, all 24 definitions, four rotation controls, and adjacent-pair inspection were present.

## Narrow test-only corrections

`game.spec.ts` now normalizes whitespace in the expected current-player text for corrupt-import preservation. The full-game test cycles the visible rotate-right control at most four times until it finds a legal-placement button, then still clicks only an actual UI-provided legal choice. It retains the 142-action bound and uses a 180-second Playwright test timeout because a complete game entails many real UI actions.

## Re-run status

The initial subsequent focused runs were interrupted by the prior server becoming unavailable (`ERR_CONNECTION_REFUSED` at port 5188). In the current explicit ownership phase, one managed server was started with this exact tool invocation: `pwsh({ command: "npm run dev -- --host 127.0.0.1 --port 5188 --strictPort", description: "Start assigned Vite server", workdir: "C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA/apps/carcassonne-3d", run_in_background: true })`. Harness returned job ID `pwsh-10`; `job_output(wait=true, timeout_ms=10000)` showed Vite 8.3.4 ready in 269 ms at `http://127.0.0.1:5188/`, status running. This records the observed launch only; no durability guarantee is implied.

Against this server, the corrected test 3 passed (downloaded JSON, corrupt import retained the same turn/name/heraldry, valid saved JSON restored). The corrected test 5 passed: the full game completed using visible legal placements and follower/skip controls in 1.3 minutes, within the 142 accepted-action bound and 180-second test timeout. A final HTTP probe returned status 200. The combined focused command was `$env:CI='1'; npm run test:e2e -- --grep "downloads a save|finishes the real game"`; output: 2 passed, duration 1.4m. A preceding save-only verification also passed (1 test, 6.1s) after the final text-content snapshot adjustment. Initial test 6 PASS remains the only result for Tile Lab; it was not rerun. Tests 1, 2, and 4 were previously reported PASS and were not repeated. Managed server job `pwsh-10` was still listed as running at last check; no durability guarantee is implied. No production files were changed.
