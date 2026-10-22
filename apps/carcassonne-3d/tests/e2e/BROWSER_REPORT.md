# Browser acceptance checkpoint — 2026-10-14

Status: **PARTIAL — browser functionality and TileLab anchors verified; managed server cannot persist across worker assignments; E2E remainder is separately owned.**

## Server availability and handoff

- App/worktree: `C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA/apps/carcassonne-3d`.
- During this assignment, `job_list` returned empty; HTTP check to 127.0.0.1:5188 was connection-refused. Prior IDs `pwsh-5` and `pwsh-6` both returned `unknown job` via `job_output`; their actual termination/exit code and elapsed lifetime are unavailable. We cannot attribute termination to turn-end versus timeout from this evidence.
- Started one authorized replacement `pwsh-6` via managed background job: `npm run dev -- --host 127.0.0.1 --port 5188 --strictPort` in the exact app directory. Output: Vite ready in 314ms, URL `http://127.0.0.1:5188/`; HTTP returned 200, 556 bytes, title `Carcassonne 3D`. Later `job_list` and `job_output(pwsh-6)` both showed no job / `unknown job`, and final URL probe was not repeated after that failure. Therefore server was ready when launched but its current liveness is not established; do not claim it remains alive. Available job tool does not expose an explicit longer lifetime parameter in this session.
- Chromium browser install was completed earlier by job `pwsh-4` with exit code 0. E2E worker owns tests 3/5/6; no suite was run in this task.

## Host-selected browser evidence

- After replacement server readiness, navigated Host-selected browser to exact `http://127.0.0.1:5188/game`. It returned the app setup page (fresh server, no in-memory game). Navigated to TileLab from setup.
- Two further complete game→TileLab→game cycles earlier in this acceptance preserved an active player turn and two WebGL contexts with zero console errors. The current/fresh server session was on setup after return from TileLab; it was not left in an active game because no later fresh game was started.
- Selected actual TileLab definitions D, L, O, P and inspected field descriptors from their visible UI. D/L: field-2 anchor `(0.220, -0.220)`, ports `N:R`, `S:L`, touching city `city-1`; other fields are nonadjacent. O/P: field-1 anchor `(0.220, -0.100)`, ports `E:L`, `S:R`, touching city `city-1`; other fields are nonadjacent. Selected P screenshot captured at `C:/Users/andre/.dsh/.playwright-mcp/carcassonne-tile-P-anchor-selected.png`; D selected screenshot at `C:/Users/andre/.dsh/.playwright-mcp/carcassonne-tile-D-anchor-check.png`.
- Existing screenshots from prior post-fix active-game checks: `C:/Users/andre/.dsh/.playwright-mcp/carcassonne-final-board.png`, `.../carcassonne-final-board-mobile.png`, `.../carcassonne-final-board-active.png`.
- Earlier verified main board WebGL2 at 1440×1000, 1280×720, and 390×844; DPR 1. Renderer was SwiftShader software, not physical GPU. Fit control and canvas drag/wheel were exercised. 2s RAF counter was 122 callbacks / 2011ms = 60.7 callbacks/sec; this is not GPU draw FPS. No GL draw-call frame counter, DPR 2 emulation, or physical-GPU check was performed.
- Prior real-game flow succeeded: 2/5-player starts, rotate, legal placement, meeple, next turn and save download; game→TileLab route stability observed. Save restoration/corrupt preservation and gameover are not confirmed here. Prior `npm run test:e2e -- --reporter=list` attempt timed out at 60 seconds: tests 1,2,4 reported PASS; test 3 FAIL without captured diagnostic; tests 5,6 had no captured outcome. Separate E2E worker owns remaining tests.

## Current limitation / next handoff

The Host-selected browser was left on working TileLab/setup session at `http://127.0.0.1:5188/` earlier, but server job ID is no longer known to the tool runtime and cannot be called confirmed running. If final user presentation needs an active game, Leader should start one managed server and immediately leave the Host-selected browser on an active game while the managed job is still live; the current background-job tool does not report configurable timeout/lifetime and past jobs disappeared across assignments. No source/config/tests/package/Git edits were made.