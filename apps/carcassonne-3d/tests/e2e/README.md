# Browser E2E harness

These tests use `@playwright/test` as a test runner and target an already-managed app URL. From `apps/carcassonne-3d`, run `npm run test:e2e` after the game engine is implemented and an app server is independently available. Set `CARCASSONNE_BASE_URL` to that exact server URL when it is not `http://127.0.0.1:5188`.

The Playwright runner is not the Harness-selected visible browser. This config deliberately has no `webServer`, so it does not start a replacement app/server. It also does not perform user-visible acceptance: that requires using the Host-selected browser tools and their exact product URL. Do not substitute another browser, profile, CDP connection, or server for that acceptance.

The suite exercises only actual UI actions and documented test IDs. It has no test mode, engine bypass, test-only production hook, or mocked game actions. Placement buttons are engine-produced legal choices; the UI intentionally offers no invalid placement command, so actual invalid-command rejection is an engine test, not this UI suite. Game-over is reached by repeatedly selecting the first currently legal UI action, with a 142-action bound.

The suite is authored for the expected completed game runtime. It is not run until that runtime is integrated and the separately managed app is available.
